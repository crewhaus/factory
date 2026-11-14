/**
 * The receipts middleware, through the HTTP surface: a refused request writes nothing, an
 * accepted one writes one receipt whose state follows the handler's answer, and the answer
 * keeps everything it had and gains the receipt.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { commandReceipt } from "@crewhaus/control-contract/schemas";
import { type LedgerRecord, append, foldStates } from "@crewhaus/control-records";
import { commandsLedgerOf, wireControl, workspaceCommandsLedger } from "@crewhaus/control-service";
import type { HangarHarnessEntry } from "@crewhaus/harness-registry";
import { makeFixtureHarness } from "./fixture";
import { json } from "./http";
import type { ProcessLayer } from "./process";
import { COMMAND_HEADER, codeForStatus, createReceipts, settleForStatus } from "./receipts";
import { ROUTE_BY_KEY } from "./route-table";
import { startHangarServer } from "./server";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const servers: TestServer[] = [];
afterEach(async () => {
  for (const t of servers.splice(0)) await t.stop();
});

function boot(options: Parameters<typeof bootTestServer>[0] = {}): TestServer {
  const t = bootTestServer({ now: () => NOW, ...options });
  servers.push(t);
  return t;
}

async function register(t: TestServer, dir: string): Promise<string> {
  const res = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
  return (res.body["entry"] as { id: string }).id;
}

function daemonHarness(t: TestServer, name = "rx"): string {
  return makeFixtureHarness(join(t.harnessesRoot, name), {
    specName: name,
    target: "channel",
    bundle: { entry: "daemon.ts" },
  });
}

function receiptsIn(root: string, home = false): LedgerRecord[] {
  const fold = foldStates(home ? workspaceCommandsLedger(root) : commandsLedgerOf(root));
  if (!fold.ok) return [];
  return [...fold.objects.values()].map((object) => object.record);
}

const post = (t: TestServer, path: string, body: string | undefined, headers = {}) =>
  t.fetchRaw(path, {
    method: "POST",
    headers: { authorization: `Bearer ${t.token}`, ...headers },
    ...(body !== undefined ? { body } : {}),
  });

describe("a refused request writes nothing", () => {
  test("no token, read-only mode, an unknown id, a bad body, a bad key", async () => {
    const t = boot();
    const dir = daemonHarness(t);
    const id = await register(t, dir);
    const homeBefore = receiptsIn(t.hangarRoot, true).length;
    const stop = `/api/h/${id}/proc/stop`;

    expect((await t.fetchRaw(stop, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await post(t, "/api/h/hrn_ffffffffffffffff/proc/stop", "{}")).status).toBe(404);
    expect((await post(t, "/api/h/not-an-id/proc/stop", "{}")).status).toBe(400);
    const badJson = await post(t, stop, "{not json");
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toEqual({ error: "invalid JSON body" });
    const notObject = await post(t, stop, "[1,2]");
    expect(notObject.status).toBe(400);
    expect(await notObject.json()).toEqual({ error: "body must be a JSON object" });
    const badKey = await post(t, stop, "{}", { "Idempotency-Key": "has space" });
    expect(badKey.status).toBe(400);
    expect(((await badKey.json()) as { code: string }).code).toBe("invalid");
    expect((await post(t, "/api/nowhere", "{}")).status).toBe(404);

    await t.api("/api/read-only", { method: "PUT", body: JSON.stringify({ enabled: true }) });
    const readOnlyHome = receiptsIn(t.hangarRoot, true).length;
    expect((await post(t, stop, "{}")).status).toBe(403);
    await t.api("/api/read-only", { method: "PUT", body: JSON.stringify({ enabled: false }) });

    expect(receiptsIn(dir)).toEqual([]);
    // Turning read-only on and off are themselves Home's commands, and only they.
    expect(receiptsIn(t.hangarRoot, true).length).toBe(homeBefore + 2);
    expect(readOnlyHome).toBe(homeBefore + 1);
  });

  test("a malformed body on a route whose handler never reads one: 400, and nothing is signalled", async () => {
    const t = boot();
    const dir = daemonHarness(t);
    const id = await register(t, dir);
    expect((await t.api(`/api/h/${id}/proc/start`, { method: "POST", body: "{}" })).status).toBe(
      200,
    );
    const child = t.ops?.last();
    expect(child).toBeDefined();
    const before = receiptsIn(dir).length;
    expect((await post(t, `/api/h/${id}/proc/stop`, "{oops")).status).toBe(400);
    expect(child?.signals).toEqual([]);
    expect(receiptsIn(dir).length).toBe(before);
  });

  test("a key used for another request is refused 422, and the effect does not run again", async () => {
    const t = boot();
    const dir = daemonHarness(t);
    const id = await register(t, dir);
    const start = (body: unknown) =>
      post(t, `/api/h/${id}/proc/start`, JSON.stringify(body), { "Idempotency-Key": "start-1" });
    const first = await start({});
    expect(first.status).toBe(200);
    const replay = await start({});
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    const replayed = (await replay.json()) as { receipt: { id: string; state: string } };
    expect(replayed.receipt.id).toBe(
      ((await first.json()) as { receipt: { id: string } }).receipt.id,
    );
    expect(t.ops?.children).toHaveLength(1);
    const reused = await start({ force: true });
    expect(reused.status).toBe(422);
    expect(((await reused.json()) as { code: string }).code).toBe("idempotency_key_reused");
    expect(t.ops?.children).toHaveLength(1);
    expect(receiptsIn(dir)).toHaveLength(1);
  });
});

describe("a key is bound to the whole request, path and query included", () => {
  test("one key on two different paths: the second is refused 422 and its handler never runs", async () => {
    const hangarRoot = mkdtempSync(join(tmpdir(), "receipts-params-"));
    const harnessDir = mkdtempSync(join(tmpdir(), "receipts-params-h-"));
    try {
      const control = wireControl(
        {
          hangarRoot,
          harnessDirOf: () => harnessDir,
          supervisorFor: () => undefined,
          drainRequest: () => async () => undefined,
          identity: { username: "sam", hostname: "laptop" },
          probe: { isAlive: () => true, startTimeMs: () => undefined },
          onWarn: () => undefined,
        },
        { mode: "server" },
      );
      const id = "hrn_0123456789abcdef";
      const withReceipt = createReceipts({
        control,
        harness: (asked) =>
          asked === id
            ? ({ id, dir: harnessDir, missingSince: null } as unknown as HangarHarnessEntry)
            : undefined,
        scrubFor: () => (text) => text,
        onWarn: () => undefined,
      });
      const ran: string[] = [];
      const send = (path: string, segments: string[], method = "DELETE") =>
        withReceipt(
          new Request(`http://127.0.0.1${path}`, {
            method,
            headers: { "Idempotency-Key": "k-1" },
          }),
          segments,
          async () => {
            ran.push(path);
            return json({ ok: true });
          },
        );

      const first = await send(`/api/h/${id}/env/OPENAI_KEY`, [
        "api",
        "h",
        id,
        "env",
        "OPENAI_KEY",
      ]);
      expect(first.status).toBe(200);
      // The same request again is a replay: answered, not run.
      const again = await send(`/api/h/${id}/env/OPENAI_KEY`, [
        "api",
        "h",
        id,
        "env",
        "OPENAI_KEY",
      ]);
      expect(again.headers.get("Idempotent-Replayed")).toBe("true");
      const other = await send(`/api/h/${id}/env/SLACK_TOKEN`, [
        "api",
        "h",
        id,
        "env",
        "SLACK_TOKEN",
      ]);
      expect(other.status).toBe(422);
      expect(((await other.json()) as { code: string }).code).toBe("idempotency_key_reused");
      expect(ran).toEqual([`/api/h/${id}/env/OPENAI_KEY`]);
      expect(receiptsIn(harnessDir)).toHaveLength(1);

      // A route with no harness id at all: the group's name and verb tell two requests apart.
      const group = (name: string, query = "") =>
        send(
          `/api/registry/groups/${name}/proc/start${query}`,
          ["api", "registry", "groups", name, "proc", "start"],
          "POST",
        );
      expect((await group("alpha")).status).toBe(200);
      expect(receiptsIn(hangarRoot, true)).toHaveLength(1);
      expect((await group("beta")).status).toBe(422);
      // And so does the query.
      expect((await group("alpha", "?only=a")).status).toBe(422);
      expect(ran).toHaveLength(2);
    } finally {
      rmSync(hangarRoot, { recursive: true, force: true });
      rmSync(harnessDir, { recursive: true, force: true });
    }
  });
});

describe("an accepted request writes one receipt", () => {
  test("an empty body on stop is a stop: one receipt, and the answer keeps its fields", async () => {
    const t = boot();
    const dir = daemonHarness(t);
    const id = await register(t, dir);
    const res = await post(t, `/api/h/${id}/proc/stop`, undefined);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["stopped"]).toBeDefined();
    const receipt = body["receipt"] as Record<string, unknown>;
    expect(receipt["kind"]).toBe("controls.stop");
    expect(receipt["via"]).toBe("home");
    expect(receipt["target"]).toBe(`home/harness/${id}`);
    expect(receipt["state"]).toBe("succeeded");
    expect(commandReceipt.safeParse(receipt).success).toBe(true);
    expect(receipt["claim"]).toBeUndefined();
    const rows = receiptsIn(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["id"]).toBe(receipt["id"]);
  });

  test("a job route answered 2xx stays accepted until its job settles", async () => {
    let finish: (answer: { exitCode?: number }) => void = () => undefined;
    const t = boot({
      runJob: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const dir = daemonHarness(t);
    const id = await register(t, dir);
    const res = await t.api(`/api/h/${id}/jobs`, {
      method: "POST",
      body: JSON.stringify({ kind: "doctor" }),
    });
    expect(res.status).toBe(202);
    const receipt = res.body["receipt"] as { id: string; state: string; effects: unknown[] };
    expect(receipt.state).toBe("accepted");
    expect(receipt.effects).toEqual([{ kind: "job", status: "unknown" }]);
    const job = res.body["job"] as { jobId: string; commandId: string; by: string };
    expect(job.commandId).toBe(receipt.id);
    expect(job.by).toMatch(/^local:#[0-9a-f]{64}$/);
    await t.server.controlService.jobs.idle();
    expect(t.server.controlService.commands.get({ harness: dir }, receipt.id)?.state).toBe(
      "running",
    );
    finish({ exitCode: 0 });
    await t.server.processes.jobs.idle();
    await Bun.sleep(0);
    await t.server.controlService.jobs.idle();
    const settled = t.server.controlService.commands.get({ harness: dir }, receipt.id);
    expect(settled?.state).toBe("succeeded");
    expect(settled?.effects).toEqual([{ kind: "job", ref: job.jobId, status: "done" }]);
  });

  test("a handler's HttpError(409) is a rejected receipt and a 409 that carries it", async () => {
    const t = boot();
    await t.api("/api/registry/groups", {
      method: "POST",
      body: JSON.stringify({ name: "empty" }),
    });
    const res = await t.api("/api/registry/groups/empty/proc/start", {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(409);
    expect(res.body["error"]).toBe('group "empty" has no members');
    const receipt = res.body["receipt"] as {
      state: string;
      outcome: { code: string; message: string };
    };
    expect(receipt.state).toBe("rejected");
    expect(receipt.outcome.code).toBe("conflict");
    // The outcome's words are fixed, never the handler's.
    expect(receipt.outcome.message).not.toContain("empty");
  });

  test("any other throw is unknown and a 500", async () => {
    const t = boot({
      wrapProcessLayer: (layer: ProcessLayer): ProcessLayer => ({
        ...layer,
        get: () => {
          throw new Error("the layer broke");
        },
      }),
    });
    const dir = daemonHarness(t);
    const id = await register(t, dir);
    const res = await t.api(`/api/h/${id}/proc/start`, { method: "POST", body: "{}" });
    expect(res.status).toBe(500);
    expect(res.body["error"]).toBe("internal error");
    expect((res.body["receipt"] as { state: string }).state).toBe("unknown");
    expect(t.warnings.some((w) => w.includes("the layer broke"))).toBe(true);
  });

  test("a harness whose directory is gone writes to Home's ledger, naming the harness", async () => {
    const t = boot();
    const dir = daemonHarness(t, "gone");
    const id = await register(t, dir);
    rmSync(dir, { recursive: true, force: true });
    const res = await t.api(`/api/h/${id}/proc/stop`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    expect(existsSync(dir)).toBe(false);
    const home = receiptsIn(t.hangarRoot, true).filter((row) => row["kind"] === "controls.stop");
    expect(home).toHaveLength(1);
    expect(home[0]?.["target"]).toBe(`home/harness/${id}`);
    expect(home[0]?.["state"]).toBe("rejected");
  });

  test("a JSON answer carries the receipt in its body, not a header", async () => {
    const t = boot();
    const res = await post(t, "/api/scan", "{}");
    expect(res.headers.get(COMMAND_HEADER)).toBeNull();
    expect(((await res.json()) as { receipt: { kind: string } }).receipt.kind).toBe("legacy.scan");
  });

  test("an answer that is not a JSON object keeps its body and carries the receipt id in a header", async () => {
    const hangarRoot = mkdtempSync(join(tmpdir(), "receipts-direct-"));
    try {
      const control = wireControl(
        {
          hangarRoot,
          supervisorFor: () => undefined,
          drainRequest: () => async () => undefined,
          identity: { username: "sam", hostname: "laptop" },
          probe: { isAlive: () => true, startTimeMs: () => undefined },
          onWarn: () => undefined,
        },
        { mode: "server" },
      );
      const withReceipt = createReceipts({
        control,
        harness: () => undefined,
        scrubFor: () => (text) => text,
        onWarn: () => undefined,
      });
      const req = new Request("http://127.0.0.1/api/scan", { method: "POST", body: "{}" });
      for (const answer of [
        () => new Response("plain words", { headers: { "content-type": "text/plain" } }),
        () => json([1, 2, 3]),
      ]) {
        const res = await withReceipt(req, ["api", "scan"], async () => answer());
        const id = res.headers.get(COMMAND_HEADER);
        expect(id).toMatch(/^cmd_/);
        expect(control.commands.get("workspace", id as string)?.state).toBe("succeeded");
        expect(await res.text()).toMatch(/^(plain words|\[1,2,3\]\n)$/);
      }
    } finally {
      rmSync(hangarRoot, { recursive: true, force: true });
    }
  });
});

describe("how an answer settles a receipt", () => {
  const row = (key: string) => {
    const found = ROUTE_BY_KEY.get(key);
    if (found === undefined) throw new Error(key);
    return found;
  };

  test("by status", () => {
    expect(settleForStatus(row("setPin"), 200)?.state).toBe("succeeded");
    expect(settleForStatus(row("groupProc"), 207)?.state).toBe("failed");
    expect(settleForStatus(row("setPin"), 400)?.state).toBe("rejected");
    expect(settleForStatus(row("specEdit"), 501)?.outcome?.code).toBe("unsupported");
    expect(settleForStatus(row("specEdit"), 503)?.outcome?.code).toBe("unavailable");
    expect(settleForStatus(row("procStart"), 500)?.state).toBe("unknown");
    // Safe to repeat: a 500 is a failure, not an unknown.
    expect(settleForStatus(row("setPin"), 500)?.state).toBe("failed");
    expect(settleForStatus(row("procStop"), 502)?.state).toBe("failed");
  });

  test("a job route that queued a job is left for the job; one that queued none settles", () => {
    expect(settleForStatus(row("evalLaunch"), 202, { jobsQueued: 1 })).toBeUndefined();
    expect(settleForStatus(row("evalLaunch"), 202, { jobsQueued: 0 })?.state).toBe("succeeded");
    expect(settleForStatus(row("evalLaunch"), 409, { jobsQueued: 1 })?.state).toBe("rejected");
  });

  test("an inline route that queued a job is left for the job too", () => {
    expect(row("setPin").dispatch).toBe("inline");
    expect(settleForStatus(row("setPin"), 200, { jobsQueued: 1 })).toBeUndefined();
    expect(row("watchmePublish").dispatch).toBe("job");
  });

  test("a group walk's effects are its members", () => {
    const settle = settleForStatus(row("groupProc"), 200, {
      jobsQueued: 0,
      body: {
        result: {
          members: [
            { id: "hrn_0123456789abcdef", ok: true, skipped: false },
            { id: "hrn_0123456789abcde0", ok: false, skipped: false },
            { id: "hrn_0123456789abcde1", ok: false, skipped: true },
          ],
        },
      },
    });
    expect(settle?.effects?.map((e) => e.status)).toEqual(["done", "failed", "skipped"]);
    expect(settle?.effects?.[0]?.ref).toBe("home/harness/hrn_0123456789abcdef");
  });

  test("the code for each status", () => {
    expect([400, 401, 403, 404, 405, 409, 412, 422, 429, 501, 503, 500].map(codeForStatus)).toEqual(
      [
        "invalid",
        "unauthenticated",
        "forbidden",
        "not_found",
        "invalid",
        "conflict",
        "precondition_failed",
        "invalid",
        "rate_limited",
        "unsupported",
        "unavailable",
        "internal",
      ],
    );
  });
});

describe("Home's boot", () => {
  test("command recovery runs after the process layer's boot, and its counts join ready", async () => {
    const order: string[] = [];
    let openBoot: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      openBoot = resolve;
    });
    const t = boot({
      wrapProcessLayer: (layer: ProcessLayer): ProcessLayer => ({
        ...layer,
        get: (entry) => {
          order.push("get");
          return layer.get(entry);
        },
        boot: async () => {
          order.push("boot-start");
          await held;
          const booted = await layer.boot();
          order.push("boot-end");
          return booted;
        },
      }),
    });
    const dir = daemonHarness(t, "orphan");
    await register(t, dir);
    // A stop whose process died after writing its receipt: it started before the machine
    // last booted, so no probe is asked whether its pid is alive.
    const booted = Date.now() - uptime() * 1000;
    const answer = append(commandsLedgerOf(dir), {
      id: "cmd_01m76e6f05hp514w9j4v3qymkt",
      v: 1,
      kind: "controls.stop",
      target: "home/cmd/cmd_01m76e6f05hp514w9j4v3qymkt",
      actor: `local:#${"a".repeat(64)}`,
      via: "cli",
      fingerprint: "f".repeat(64),
      state: "accepted",
      acceptedAt: new Date(Date.now() - 1000).toISOString(),
      executor: {
        pid: 2_147_483_646,
        startedAt: new Date(booted - 60_000).toISOString(),
        host: hostname(),
        head: "cli",
      },
      effects: [],
      retry: { retryable: true, safety: "idempotent" },
    });
    expect(answer.ok).toBe(true);
    await Bun.sleep(5);
    expect(order).toEqual(["boot-start"]);
    openBoot();
    const ready = await t.server.ready;
    expect(order).toEqual(["boot-start", "boot-end", "get"]);
    expect(ready.commands).toEqual({ redispatched: 1, reconciled: 0, unknown: 0 });
    expect(
      t.server.controlService.commands.get({ harness: dir }, "cmd_01m76e6f05hp514w9j4v3qymkt")
        ?.state,
    ).toBe("succeeded");
  });
});

describe("command recovery's reach", () => {
  test("outside a request it reads no harness; at boot it reads every one under its own name", async () => {
    const t = boot();
    const dir = daemonHarness(t, "orphan");
    await register(t, dir);
    await t.server.ready;
    // A stop whose process died after writing its receipt, as in the boot test above.
    const id = "cmd_01m76e6f05hp514w9j4v3qymku";
    const booted = Date.now() - uptime() * 1000;
    const answer = append(commandsLedgerOf(dir), {
      id,
      v: 1,
      kind: "controls.stop",
      target: `home/cmd/${id}`,
      actor: `local:#${"a".repeat(64)}`,
      via: "cli",
      fingerprint: "f".repeat(64),
      state: "accepted",
      acceptedAt: new Date(Date.now() - 1000).toISOString(),
      executor: {
        pid: 2_147_483_646,
        startedAt: new Date(booted - 60_000).toISOString(),
        host: hostname(),
        head: "cli",
      },
      effects: [],
      retry: { retryable: true, safety: "idempotent" },
    });
    expect(answer.ok).toBe(true);

    // Called from here, outside any request and any named background work: no harness is
    // visible to it, so it touches no harness's ledger.
    const outside = await t.server.controlService.commands.recover("all");
    expect(outside.redispatched).toBe(0);
    expect(t.server.controlService.commands.get({ harness: dir }, id)?.state).toBe("accepted");

    // A fresh boot over the same Home runs recovery under its own name, which reads them all.
    await t.server.stop();
    const again = startHangarServer({
      port: 0,
      root: t.hangarRoot,
      registryRoot: t.registryRoot,
      env: { CREWHAUS_WATCHME_ROOT: join(t.workspace, "watchme") },
      onWarn: () => undefined,
    });
    try {
      const ready = await again.ready;
      expect(ready.commands.redispatched).toBe(1);
      expect(again.controlService.commands.get({ harness: dir }, id)?.state).toBe("succeeded");
    } finally {
      await again.stop();
    }
  });
});
