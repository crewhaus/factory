/**
 * A scoped token for a supervisor's run: a service mints it through the API for
 * `<harness>/exec/run_<16 hex>`, it reads that run on the run routes, and nothing else.
 * On the v1 run stream, a token reaches only the stream of the run it names, with the act
 * the stream needs, and its stream is decided again on that run alone.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  loadAccessSnapshot,
  openAccess,
  openSignIn,
  verifyScopedToken,
} from "@crewhaus/access-control";
import { mintRunId } from "@crewhaus/control-contract";
import { makeSeal } from "@crewhaus/control-contract/http";
import { append, runsLedger } from "@crewhaus/control-records";
import { appendRunLedger, newRunId } from "@crewhaus/harness-supervisor";
import { type V1Home, v1Home } from "../__test__/v1-home";

const STAMP = "2026-11-11T00:00:00.000Z";

let home: V1Home;
let a: { id: string; dir: string };
let b: { id: string; dir: string };
let runA: string;
let runB: string;
let service: { secret: string; credential: string; principal: string };

function supervisorRun(dir: string): string {
  const runId = newRunId();
  appendRunLedger(dir, {
    runId,
    kind: "daemon",
    argv: ["crewhaus", "run"],
    startedAt: STAMP,
    logFile: `logs/${runId}.log`,
  });
  return runId;
}

async function mint(
  refs: readonly string[],
  secret = service.secret,
  acts: readonly string[] = ["run.result.read"],
) {
  const pair = await makeSeal();
  const res = await home.call("POST", "/api/v1/access/scoped-tokens", {
    body: { refs, acts, seal: pair.seal },
    secret,
  });
  return {
    res,
    token:
      res.status === 200
        ? await pair.open(res.body["issued"], "access.scopedTokens.mint")
        : undefined,
  };
}

beforeAll(async () => {
  home = await v1Home();
  a = await home.harness("alpha");
  b = await home.harness("bravo");
  runA = supervisorRun(a.dir);
  runB = supervisorRun(b.dir);
  service = await home.service("portal", [a.id, b.id], { contentRead: true });
}, 60_000);

afterAll(async () => {
  await home?.t.stop();
});

describe("a scoped token for a supervisor's run", () => {
  test("mints for <harness>/exec/<run>, verifies, and reads that run", async () => {
    const ref = `${a.id}/exec/${runA}`;
    const { res, token } = await mint([ref]);
    expect(res.status).toBe(200);
    if (token === undefined) throw new Error("no token");
    expect(token.startsWith("chx_")).toBe(true);
    const signIn = openSignIn(home.t.hangarRoot, { localActor: "local:test@host" });
    const read = loadAccessSnapshot(home.t.hangarRoot);
    const verified = await verifyScopedToken(
      token,
      read.state === "present" ? read.snapshot : undefined,
      await signIn.scopedKey(),
      Date.now(),
    );
    expect(verified.ok && verified.refs).toEqual([ref]);
    const run = await home.call("GET", `/api/h/${a.id}/runs/${runA}`, { secret: token });
    expect(run.status).toBe(200);
  });

  test("another harness's run is refused, scoped", async () => {
    const { token } = await mint([`${a.id}/exec/${runA}`]);
    const other = await home.call("GET", `/api/h/${b.id}/runs/${runB}`, {
      secret: token as string,
    });
    expect(other.status).toBe(403);
    expect(other.body["reason"]).toBe("scoped");
  });

  test("the run spelling of a supervisor's id, and an unknown run, are refused at mint", async () => {
    const wrong = await mint([`${a.id}/run/${runA}`]);
    expect(wrong.res.status).toBe(422);
    const details = (wrong.res.body["error"] as Record<string, unknown>)["details"] as Record<
      string,
      unknown
    >;
    expect(details["refs"]).toEqual([`${a.id}/run/${runA}`]);
    const unknown = await mint([`${a.id}/exec/run_ffffffffffffffff`]);
    expect(unknown.res.status).toBe(422);
    expect(
      (
        (unknown.res.body["error"] as Record<string, unknown>)["details"] as Record<string, unknown>
      )["refs"],
    ).toEqual([`${a.id}/exec/run_ffffffffffffffff`]);
  });

  test("a session cannot mint one", async () => {
    const res = await mint([`${a.id}/exec/${runA}`], home.session);
    expect(res.res.status).toBe(403);
    expect((res.res.body["error"] as Record<string, unknown>)["reason"]).toBe("service_only");
  });
});

// ---------------------------------------------------------------------------

/** A canonical run in a harness's run ledger: what a `run/` ref is minted for. */
function canonicalRun(dir: string, state = "running"): string {
  const id = mintRunId();
  const written = append(runsLedger(dir), { id, state, at: STAMP, trigger: { kind: "api" } });
  if (!written.ok) throw new Error(written.reason);
  return id;
}

type Opened = {
  readonly status: number;
  readonly type: string;
  readonly reason?: unknown;
  text(): string;
  until(predicate: (text: string) => boolean, ms?: number): Promise<boolean>;
  close(): void;
};

/** Open a v1 stream with a bearer, and read it as it arrives. */
async function stream(path: string, secret: string): Promise<Opened> {
  const controller = new AbortController();
  const res = await fetch(`${home.t.base}${path}`, {
    headers: { authorization: `Bearer ${secret}` },
    signal: controller.signal,
  });
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("text/event-stream")) {
    const body = (await res.json()) as { error?: { reason?: unknown } };
    return {
      status: res.status,
      type,
      reason: body.error?.reason,
      text: () => "",
      until: async () => false,
      close: () => undefined,
    };
  }
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  return {
    status: res.status,
    type,
    text: () => text,
    async until(predicate, ms = 3000) {
      const deadline = Date.now() + ms;
      while (!predicate(text)) {
        pending ??= reader.read();
        const timeout = new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), Math.max(1, deadline - Date.now())),
        );
        const got = await Promise.race([pending, timeout]);
        if (got === "timeout") return false;
        pending = undefined;
        if (got.done) return predicate(text);
        text += decoder.decode(got.value, { stream: true });
      }
      return true;
    },
    close: () => controller.abort(),
  };
}

const firstEvent = (text: string): string | undefined =>
  /^event: (.+)$/m.exec(text)?.[1] ?? undefined;

describe("a scoped token on the v1 run stream", () => {
  test("one minted for <harness>/run/<run> streams that run, first frame its row", async () => {
    const run = canonicalRun(a.dir);
    const { token } = await mint([`${a.id}/run/${run}`], service.secret, ["run.events.read"]);
    if (token === undefined) throw new Error("no token");
    const opened = await stream(`/api/v1/runs/${run}/events`, token);
    expect(opened.status).toBe(200);
    expect(opened.type).toContain("text/event-stream");
    expect(await opened.until((text) => text.includes("event: "))).toBe(true);
    expect(firstEvent(opened.text())).toBe("run.started");
    expect(opened.text()).toContain(`"run":"${run}"`);
    opened.close();
  });

  test("one minted for <harness>/exec/<run_16hex> streams that execution", async () => {
    const { token } = await mint([`${a.id}/exec/${runA}`], service.secret, ["run.events.read"]);
    if (token === undefined) throw new Error("no token");
    const opened = await stream(`/api/v1/runs/${runA}/events`, token);
    expect(opened.status).toBe(200);
    expect(await opened.until((text) => text.includes("event: "))).toBe(true);
    expect(firstEvent(opened.text())).toBe("run.started");
    opened.close();
  });

  test("a token for run A is refused run B's stream, in the same harness and in another", async () => {
    const runOne = canonicalRun(a.dir);
    const runTwo = canonicalRun(a.dir);
    const runThere = canonicalRun(b.dir);
    const { token } = await mint([`${a.id}/run/${runOne}`], service.secret, ["run.events.read"]);
    if (token === undefined) throw new Error("no token");
    for (const other of [runTwo, runThere, runB]) {
      const opened = await stream(`/api/v1/runs/${other}/events`, token);
      expect([other, opened.status, opened.reason]).toEqual([other, 403, "scoped"]);
    }
  });

  test("a token without run.events.read is refused the stream", async () => {
    const run = canonicalRun(a.dir);
    const { token } = await mint([`${a.id}/run/${run}`], service.secret, ["run.result.read"]);
    if (token === undefined) throw new Error("no token");
    const opened = await stream(`/api/v1/runs/${run}/events`, token);
    expect([opened.status, opened.reason]).toEqual([403, "scoped"]);
  });

  test("its open stream outlives an access change that does not touch it, and closes once its service loses the content permission", async () => {
    const run = canonicalRun(a.dir);
    const minter = await home.service("portal-2", [a.id], { contentRead: true });
    const { token } = await mint([`${a.id}/run/${run}`], minter.secret, ["run.events.read"]);
    if (token === undefined) throw new Error("no token");
    const opened = await stream(`/api/v1/runs/${run}/events`, token);
    expect(opened.status).toBe(200);
    expect(await opened.until((text) => text.includes("event: run.started"))).toBe(true);
    // Someone else is given access: the stream is decided again, on its own run, and stays.
    const access = openAccess(home.t.hangarRoot);
    const moved = await access.grant(
      { principal: home.owner },
      { member: "Una", create: true, role: "viewer", scope: "home" },
    );
    if (!moved.ok) throw new Error(moved.reason);
    home.t.server.checkSessions();
    expect(await opened.until((text) => text.includes("event: auth."), 300)).toBe(false);
    // Its service's token ends: the stream closes.
    const ended = await access.revoke({ principal: home.owner }, minter.credential);
    if (!ended.ok) throw new Error(ended.reason);
    home.t.server.checkSessions();
    expect(await opened.until((text) => text.includes("event: auth.revoked"))).toBe(true);
  });
});
