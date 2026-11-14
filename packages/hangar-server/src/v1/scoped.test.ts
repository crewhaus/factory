/**
 * A scoped token for a supervisor's run: a service mints it through the API for
 * `<harness>/exec/run_<16 hex>`, it reads that run on the run routes, and nothing else.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadAccessSnapshot, openSignIn, verifyScopedToken } from "@crewhaus/access-control";
import { makeSeal } from "@crewhaus/control-contract/http";
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

async function mint(refs: readonly string[], secret = service.secret) {
  const pair = await makeSeal();
  const res = await home.call("POST", "/api/v1/access/scoped-tokens", {
    body: { refs, acts: ["run.result.read"], seal: pair.seal },
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
