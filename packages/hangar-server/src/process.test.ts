/**
 * The M2 process layer, driven through the HTTP surface with a fake
 * `ProcessOps` + fake clock. Nothing here spawns a real daemon: the
 * supervisor's own suite already proves signals, OS start times, and
 * fd-redirected stdout against real fixture scripts, and a manager suite
 * that re-proved them would be the slowest, flakiest thing in the repo.
 *
 * What this file is for is the WIRING the supervisor cannot test for us:
 * that the gate's refusal reaches the client typed, that the daemon's boot
 * announcement becomes a recorded control port, that a drain marks the
 * imminent exit-0 as an operator stop, and that the live SSE feed carries
 * what the console renders.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HangarHarnessEntry, openHangarRegistry } from "@crewhaus/harness-registry";
import { makeFixtureHarness } from "./fixture";
import {
  JobArgumentError,
  type ProcessLayer,
  createProcessLayer,
  defaultJobRunner,
  jobArgv,
} from "./process";
import {
  type TestServer,
  bootTestServer,
  createTestClock,
  createTestProcessOps,
  startStubControlPlane,
} from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");

/** Never a realistic-shaped literal in a fixture: built from parts. */
const STUB_TOKEN = ["c0ntrol", "test", "bearer", "0123456789abcdef"].join("-");

async function register(t: TestServer, dir: string): Promise<string> {
  const res = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
  return (res.body["entry"] as { id: string }).id;
}

function daemonHarness(t: TestServer, name: string): string {
  return makeFixtureHarness(join(t.harnessesRoot, name), {
    specName: name,
    target: "channel",
    controlToken: STUB_TOKEN,
    bundle: { entry: "daemon.ts" },
  });
}

/**
 * THE OTHER HEAD: a second process layer over the same fake OS, the same
 * fake clock, and the same registry file — which is exactly what a terminal
 * `crewhaus daemon start` (or a launchd unit) is to a console that is
 * already running. Its daemon is a real, live, runfile-holding process that
 * the server's own layer has never seen.
 */
function terminalManager(t: TestServer): ProcessLayer {
  return createProcessLayer({
    registry: openHangarRegistry({
      root: t.registryRoot,
      env: { CREWHAUS_WATCHME_ROOT: join(t.workspace, "watchme") },
      now: () => NOW,
      onWarn: () => {},
    }),
    env: { CREWHAUS_WATCHME_ROOT: join(t.workspace, "watchme") },
    now: () => NOW,
    onWarn: () => {},
    hangarRoot: t.hangarRoot,
    managerVersion: "terminal",
    ...(t.ops !== undefined ? { ops: t.ops } : {}),
    ...(t.clock !== undefined ? { clock: t.clock } : {}),
    noPreflight: true,
    runJob: () => new Promise<{ exitCode?: number }>(() => {}),
  });
}

/** The registry row the terminal manager supervises, read from the same
 *  `harnesses.json` the server just wrote. */
function entryFor(t: TestServer, id: string): HangarHarnessEntry {
  const reg = openHangarRegistry({
    root: t.registryRoot,
    env: { CREWHAUS_WATCHME_ROOT: join(t.workspace, "watchme") },
    now: () => NOW,
    onWarn: () => {},
  });
  const entry = reg.get(id);
  if (entry === undefined) throw new Error(`no registry entry for ${id}`);
  return entry;
}

/** Start a daemon the way the OTHER head does, then let that manager go:
 *  `close()` releases its timers and subscriptions and deliberately leaves
 *  the child alone — a detached daemon outliving the process that spawned it
 *  is the whole point of the runfile. */
async function startFromTerminal(t: TestServer, id: string): Promise<number> {
  const terminal = terminalManager(t);
  try {
    const started = await terminal.get(entryFor(t, id)).supervisor.start();
    expect(started).toMatchObject({ ok: true });
    return t.ops?.last()?.pid as number;
  } finally {
    terminal.close();
  }
}

/** The daemon states its kernel-assigned control port on stdout — the only
 *  place it is ever stated — and the pump hands the manager that line. */
function announceControlPort(t: TestServer, port: number): void {
  t.ops
    ?.last()
    ?.writeLog(
      `[control] crewhaus.control.v1 listening on http://127.0.0.1:${port} (token: .crewhaus/run/control-token)\n`,
    );
  t.clock?.advance(300); // one pump tick
}

/**
 * Settle a request that is waiting on the FAKE clock. An adopted run's exit
 * is noticed on a pump tick — this manager never held its exit promise — so
 * a stop of an adopted daemon needs time to move before it can answer.
 */
async function settleWithClock<T>(t: TestServer, pending: Promise<T>): Promise<T> {
  let settled = false;
  const done = pending.finally(() => {
    settled = true;
  });
  for (let i = 0; i < 200 && !settled; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    t.clock?.advance(300);
  }
  return done;
}

type RunFeed = {
  /** Everything received so far. */
  text(): string;
  /** Read until the predicate holds (or the stream ends). */
  until(predicate: (text: string) => boolean): Promise<void>;
  close(): Promise<void>;
};

/** Open a run's SSE feed and read it incrementally. */
async function openRunFeed(t: TestServer, id: string, runId: string): Promise<RunFeed> {
  const res = await t.fetchRaw(`/api/h/${id}/runs/${runId}/events`, {
    headers: { authorization: `Bearer ${t.token}` },
  });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let seen = "";
  return {
    text: () => seen,
    until: async (predicate) => {
      while (!predicate(seen)) {
        const { value, done } = await reader.read();
        if (done) return;
        seen += decoder.decode(value, { stream: true });
      }
    },
    close: () => reader.cancel(),
  };
}

describe("process control", () => {
  test("start writes a runfile, stop clears it, and the ledger records both", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = daemonHarness(t, "proc-lifecycle");
      const id = await register(t, dir);

      const started = await t.api(`/api/h/${id}/proc/start`, { method: "POST", body: "{}" });
      expect(started.status).toBe(200);
      const runId = started.body["runId"] as string;
      expect(runId).toMatch(/^run_[0-9a-f]{16}$/);
      // The runfile IS the singleton lock — a daemon start must write one.
      const runfile = JSON.parse(
        readFileSync(join(dir, ".crewhaus", "run", "daemon.json"), "utf8"),
      );
      expect(runfile.runId).toBe(runId);

      // A second start is refused by the lock, not turned into a second child.
      const again = await t.api(`/api/h/${id}/proc/start`, { method: "POST", body: "{}" });
      expect(again.status).toBe(409);
      expect(again.body["reason"]).toBe("already-running");
      expect(t.ops?.children.length).toBe(1);

      const stopped = await t.api(`/api/h/${id}/proc/stop`, { method: "POST", body: "{}" });
      expect(stopped.body["stopped"]).toBe(true);
      expect(t.ops?.last()?.signals).toEqual(["SIGTERM"]);

      const runs = await t.api(`/api/h/${id}/runs`);
      const rows = runs.body["runs"] as Array<{ runId: string; endedAt?: string }>;
      expect(rows[0]?.runId).toBe(runId);
      expect(typeof rows[0]?.endedAt).toBe("string");
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("the daemon's control-plane announcement becomes a recorded control port", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = daemonHarness(t, "proc-controlport");
      const id = await register(t, dir);
      await t.api(`/api/h/${id}/proc/start`, { method: "POST", body: "{}" });

      // The manager stamps CREWHAUS_CONTROL_PORT=0, so the KERNEL picks the
      // port and this stdout line is the only place it is ever stated.
      expect(t.ops?.last()?.request.env["CREWHAUS_CONTROL_PORT"]).toBe("0");
      // …and the token is never in argv, where every process could read it.
      expect(t.ops?.last()?.request.argv.join(" ")).not.toContain("CONTROL_TOKEN");
      expect(t.ops?.last()?.request.env["CREWHAUS_CONTROL_TOKEN"]).toBeUndefined();

      t.ops
        ?.last()
        ?.writeLog(
          "[control] crewhaus.control.v1 listening on http://127.0.0.1:41234 (token: .crewhaus/run/control-token)\n",
        );
      t.clock?.advance(300); // one pump tick

      const proc = await t.api(`/api/h/${id}/proc`);
      expect((proc.body["control"] as { port: number }).port).toBe(41234);
      // Recorded in the runfile too, so a manager restart adopts wake/drain
      // instead of silently losing them.
      const runfile = JSON.parse(
        readFileSync(join(dir, ".crewhaus", "run", "daemon.json"), "utf8"),
      );
      expect(runfile.controlPort).toBe(41234);
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("a drain with no control plane degrades to the signal path and says so", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = daemonHarness(t, "proc-drain");
      const id = await register(t, dir);
      await t.api(`/api/h/${id}/proc/start`, { method: "POST", body: "{}" });

      const drained = await t.api(`/api/h/${id}/proc/drain`, { method: "POST", body: "{}" });
      expect(drained.body["stopped"]).toBe(true);
      // Honest: control.v1 was unreachable, so this was SIGTERM, not a drain.
      expect(drained.body["viaSignal"]).toBe(true);
      expect(t.ops?.last()?.signals).toEqual(["SIGTERM"]);
      const proc = await t.api(`/api/h/${id}/proc`);
      expect(proc.body["state"]).toBe("stopped");
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("the live SSE feed carries state/output frames and always terminates with done", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = daemonHarness(t, "proc-sse");
      const id = await register(t, dir);
      const started = await t.api(`/api/h/${id}/proc/start`, { method: "POST", body: "{}" });
      const runId = started.body["runId"] as string;

      const res = await t.fetchRaw(`/api/h/${id}/runs/${runId}/events`, {
        headers: { authorization: `Bearer ${t.token}` },
      });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let seen = "";
      const pump = async (until: (s: string) => boolean): Promise<void> => {
        while (!until(seen)) {
          const { value, done } = await reader.read();
          if (done) return;
          seen += decoder.decode(value, { stream: true });
        }
      };
      await pump((s) => s.includes("event: replay"));

      t.ops?.last()?.writeLog("hello from the daemon\n");
      t.clock?.advance(300);
      await pump((s) => s.includes("event: output"));
      expect(seen).toContain("hello from the daemon");

      // The exit closes the stream with a terminal frame — that is what lets
      // a client tell "finished" from "the connection dropped".
      t.ops?.last()?.exit(0, null);
      await pump((s) => s.includes("event: done"));
      expect(seen).toContain("event: exit");
      expect(seen).toContain("event: done");
      await reader.cancel();
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("a preflight refusal answers 409 with the acknowledgeable/unforceable split", async () => {
    // A Slack channel bot with no credentials: the compiled daemon's own
    // boot gate exits 2 on exactly this set, so "start anyway" must NOT be
    // offered for it.
    const t = bootTestServer({ now: () => NOW, preflight: true, env: {} });
    try {
      const dir = makeFixtureHarness(join(t.harnessesRoot, "proc-preflight"), {
        specName: "proc-preflight",
        target: "channel",
        // A spec that COMPILES — otherwise the refusal would be a spec lint,
        // not the channel-secret boot gate this test is about.
        noSpec: true,
        bundle: { entry: "daemon.ts" },
      });
      writeFileSync(
        join(dir, "crewhaus.yaml"),
        [
          "name: proc-preflight",
          "target: channel",
          "agent:",
          "  model: anthropic/claude-sonnet-4",
          "  instructions: |",
          "    You are a fixture.",
          "routing:",
          "  sessionKey: channel",
          "channels:",
          "  slack:",
          "    botToken: $PREFLIGHT_SLACK_BOT_TOKEN",
          "    signingSecret: $PREFLIGHT_SLACK_SIGNING_SECRET",
          "",
        ].join("\n"),
      );
      const id = await register(t, dir);

      const refused = await t.api(`/api/h/${id}/proc/start`, { method: "POST", body: "{}" });
      expect(refused.status).toBe(409);
      expect(refused.body["reason"]).toBe("preflight-blocked");
      const items = refused.body["refused"] as Array<{ area: string; acknowledgeable: boolean }>;
      expect(items.length).toBeGreaterThan(0);
      const channelItems = items.filter((i) => i.area === "channels");
      expect(channelItems.length).toBeGreaterThan(0);
      expect(channelItems.every((i) => i.acknowledgeable === false)).toBe(true);
      expect((refused.body["unforceable"] as string[]).length).toBeGreaterThan(0);
      // Nothing was spawned — the refusal replaced the spawn, not followed it.
      expect(t.ops?.children.length ?? 0).toBe(0);

      // …and `force` cannot clear it either.
      const forced = await t.api(`/api/h/${id}/proc/start`, {
        method: "POST",
        body: JSON.stringify({ force: true }),
      });
      expect(forced.status).toBe(409);
      expect((forced.body["unforceable"] as string[]).length).toBeGreaterThan(0);
      expect(t.ops?.children.length ?? 0).toBe(0);
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("a daemon this manager did not start is adopted on the next request", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = daemonHarness(t, "proc-foreign");
      const id = await register(t, dir);
      // Boot adoption has already run and had nothing to adopt …
      await t.server.ready;
      // … and ONLY NOW does the other head start the daemon.
      const pid = await startFromTerminal(t, id);
      expect(t.ops?.isAlive(pid)).toBe(true);

      // The console must not report `stopped` over a live runfile: every
      // button it paints is decided by this payload.
      const proc = await t.api(`/api/h/${id}/proc`);
      expect(proc.body["state"]).toBe("running");
      expect(proc.body["adopted"]).toBe(true);
      expect(proc.body["pid"]).toBe(pid);

      // …and Stop must SIGNAL the daemon rather than answer 200 having done
      // nothing at all.
      const stopped = await settleWithClock(
        t,
        t.api(`/api/h/${id}/proc/stop`, { method: "POST", body: "{}" }),
      );
      expect(stopped.status).toBe(200);
      expect(stopped.body["stopped"]).toBe(true);
      expect(t.ops?.last()?.signals).toEqual(["SIGTERM"]);
      expect(t.ops?.isAlive(pid)).toBe(false);
      // The lock is released — not left for the next start to trip over.
      expect(existsSync(join(dir, ".crewhaus", "run", "daemon.json"))).toBe(false);
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("a stop that could not adopt the live daemon answers 409, never a false success", async () => {
    const t = bootTestServer({
      now: () => NOW,
      // Adoption itself fails (an unreadable run dir, a pid this user may
      // not signal). The honest answer is "I reached nothing" — the answer
      // that let a Restart delete a live daemon's lock is "stopped: true".
      wrapProcessLayer: (layer) => ({
        ...layer,
        get: (entry) => {
          const handle = layer.get(entry);
          return {
            ...handle,
            supervisor: {
              ...handle.supervisor,
              adoptIfRunfile: () => Promise.reject(new Error("simulated: EACCES on the run dir")),
            },
          };
        },
      }),
    });
    try {
      const dir = daemonHarness(t, "proc-unadoptable");
      const id = await register(t, dir);
      const pid = await startFromTerminal(t, id);

      const stopped = await t.api(`/api/h/${id}/proc/stop`, { method: "POST", body: "{}" });
      expect(stopped.status).toBe(409);
      expect(stopped.body["reason"]).toBe("not-adopted");
      expect((stopped.body["runfile"] as { pid: number }).pid).toBe(pid);

      const drained = await t.api(`/api/h/${id}/proc/drain`, { method: "POST", body: "{}" });
      expect(drained.status).toBe(409);
      expect(drained.body["reason"]).toBe("not-adopted");

      // Nothing was signalled and the lock is intact: the daemon is exactly
      // as it was, which is what the 409 claims.
      expect(t.ops?.last()?.signals).toEqual([]);
      expect(t.ops?.isAlive(pid)).toBe(true);
      expect(existsSync(join(dir, ".crewhaus", "run", "daemon.json"))).toBe(true);
      // The refused drain did NOT latch the flag that disables every process
      // verb in the console — only an exit clears that, and none is coming.
      expect((await t.api(`/api/h/${id}/proc`)).body["draining"]).toBe(false);
      // The adoption failure was reported, not swallowed.
      expect(t.warnings.some((w) => w.includes("adopt failed"))).toBe(true);
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("a control-plane drain is an operator stop — the daemon is not restarted underneath it", async () => {
    const stub = startStubControlPlane(STUB_TOKEN);
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = daemonHarness(t, "ctl-drain-restart");
      const id = await register(t, dir);
      await t.api(`/api/h/${id}/proc/start`, { method: "POST", body: "{}" });
      announceControlPort(t, stub.port);
      expect((await t.api(`/api/h/${id}/proc`)).body["control"]).toMatchObject({ port: stub.port });

      const drained = await t.api(`/api/h/${id}/control/drain`, { method: "POST", body: "{}" });
      expect(drained.body["ok"]).toBe(true);

      // The drain contract: the daemon answers 202, finishes in flight work,
      // and exits 0 ON ITS OWN. An unflagged exit 0 from a long-running
      // shape reads as "exited cleanly (unexpected)" — restartable — so this
      // is the exit that used to resurrect what the operator just shut down.
      t.ops?.last()?.exit(0, null);
      await t.api(`/api/h/${id}/proc`); // flush the exit handler
      t.clock?.advance(60_000); // …and run any backoff timer it armed

      const proc = await t.api(`/api/h/${id}/proc`);
      expect(proc.body["state"]).toBe("stopped");
      expect(proc.body["nextRestartAtMs"]).toBe(null);
      expect(proc.body["lastExit"]).toMatchObject({
        title: "stopped by the operator",
        restartable: false,
      });
      expect(t.ops?.children.length).toBe(1);
    } finally {
      await t.stop();
      await stub.stop();
    }
  }, 20_000);

  test("a REFUSED control drain leaves the process verbs alone", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = daemonHarness(t, "ctl-drain-refused");
      const id = await register(t, dir);
      await t.api(`/api/h/${id}/proc/start`, { method: "POST", body: "{}" });

      // No control port ⇒ `no_control_port`, an EXPECTED refusal. The daemon
      // was told nothing, so it is not draining and must not be marked so:
      // the flag is only ever cleared by an exit that is not coming.
      const refused = await t.api(`/api/h/${id}/control/drain`, { method: "POST", body: "{}" });
      expect(refused.body["ok"]).toBe(false);
      expect(refused.body["code"]).toBe("no_control_port");

      const proc = await t.api(`/api/h/${id}/proc`);
      expect(proc.body["state"]).toBe("running");
      expect(proc.body["draining"]).toBe(false);
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("the live feed follows a DRAINING run instead of reporting it finished", async () => {
    const stub = startStubControlPlane(STUB_TOKEN);
    const t = bootTestServer({ now: () => NOW });
    // The drain is deliberately left in flight; keep a handle so a failing
    // assertion cannot leave it unsettled and drown the real failure in a
    // connection-reset from the teardown.
    let draining: Promise<unknown> = Promise.resolve();
    try {
      const dir = daemonHarness(t, "proc-draining-feed");
      const id = await register(t, dir);
      const started = await t.api(`/api/h/${id}/proc/start`, { method: "POST", body: "{}" });
      const runId = started.body["runId"] as string;
      announceControlPort(t, stub.port);

      // Drain, but do NOT await it: the supervisor sits in `draining` until
      // the daemon exits, and that window — up to the whole stop grace — is
      // exactly when an operator clicks "watch the live run".
      draining = t.api(`/api/h/${id}/proc/drain`, { method: "POST", body: "{}" }).catch(() => ({
        status: 0,
        body: {},
      }));
      await t.api(`/api/h/${id}/proc`); // let the route reach supervisor.drain()
      expect((await t.api(`/api/h/${id}/proc`)).body["state"]).toBe("draining");

      const feed = await openRunFeed(t, id, runId);
      await feed.until((s) => s.includes("event: replay"));
      // The bug: `live: false` sends replay and `done` in the same breath,
      // so the operator sees history and "stream closed" while the daemon is
      // still shutting down in front of them.
      expect(feed.text()).not.toContain("event: done");

      t.ops?.last()?.writeLog("draining: flushing in-flight turns\n");
      t.clock?.advance(300);
      await feed.until((s) => s.includes("event: output"));
      expect(feed.text()).toContain("flushing in-flight turns");

      t.ops?.last()?.exit(0, null);
      await feed.until((s) => s.includes("event: done"));
      expect(feed.text()).toContain("event: exit");
      await feed.close();
      expect(((await draining) as { body: Record<string, unknown> }).body["stopped"]).toBe(true);
    } finally {
      // Settle any in-flight drain before the socket goes away.
      t.ops?.last()?.exit(0, null);
      await draining;
      await t.stop();
      await stub.stop();
    }
  }, 20_000);

  test("a quiet live feed keeps its socket alive with heartbeat comment frames", async () => {
    // Bun severs an idle socket after 10 s by default, and a `heartbeat:
    // every 60s` daemon is silent for a minute at a time — the exact shape
    // this console exists to watch. The stream must speak even when the
    // daemon does not.
    const t = bootTestServer({ now: () => NOW, sseHeartbeatMs: 25 });
    try {
      const dir = daemonHarness(t, "proc-quiet-feed");
      const id = await register(t, dir);
      const started = await t.api(`/api/h/${id}/proc/start`, { method: "POST", body: "{}" });
      const runId = started.body["runId"] as string;

      const feed = await openRunFeed(t, id, runId);
      // Not one byte of daemon output — only the keep-alive can arrive.
      await feed.until((s) => s.includes(": ping"));
      // A comment frame, so it never reaches the client's `onmessage`.
      expect(feed.text()).not.toContain("event: ping");
      await feed.close();

      // And the socket's own ceiling is raised above Bun's 10 s default, or
      // the ping would never get a chance to fire.
      expect(t.server.idleTimeoutSeconds).toBeGreaterThan(60);
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("a harness with no bundle answers plan-failed with the remedy the UI turns into a button", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = makeFixtureHarness(join(t.harnessesRoot, "proc-nobundle"), {
        specName: "proc-nobundle",
        target: "channel",
      });
      const id = await register(t, dir);
      const failed = await t.api(`/api/h/${id}/proc/start`, { method: "POST", body: "{}" });
      expect(failed.status).toBe(409);
      expect(failed.body["reason"]).toBe("plan-failed");
      expect(failed.body["remedy"]).toBe("compile");

      const proc = await t.api(`/api/h/${id}/proc`);
      expect((proc.body["bundle"] as { present: boolean }).present).toBe(false);
      expect((proc.body["launch"] as { error: { remedy: string } }).error.remedy).toBe("compile");
    } finally {
      await t.stop();
    }
  }, 20_000);
});

describe("job argv", () => {
  test("each M2 job kind maps to a fixed command line", () => {
    expect(jobArgv("doctor")).toEqual(["doctor"]);
    expect(jobArgv("compile")).toEqual(["compile", "crewhaus.yaml", "-o", "dist"]);
    expect(jobArgv("dream-run")).toEqual(["dream", "run", "crewhaus.yaml"]);
    expect(jobArgv("eval", { dataset: "smoke", graders: "graders.yaml" })).toEqual([
      "eval",
      "crewhaus.yaml",
      "--dataset",
      "smoke",
      "--graders",
      "graders.yaml",
    ]);
  });

  test("an HTTP body can never append a flag or escape the harness", () => {
    // This is the boundary where a request turns into a command line — the
    // one place a mistake becomes an injection.
    for (const bad of ["--write-back", "../../etc/passwd", "/abs/path", "a b", "a;b", ""]) {
      expect(() => jobArgv("eval", { dataset: bad })).toThrow(JobArgumentError);
    }
  });
});

describe("a console-submitted job is cancellable (the seam, not just the ledger)", () => {
  test("the default job runner hands its child to the queue", async () => {
    // The queue can only signal a child the RUNNER handed it. Without the
    // `ctx.register` call the queue knows a job is "running" and holds
    // nothing: cancel() answers false and manager shutdown marks the ledger
    // row while the process keeps going — the orphan M4 exists to stop,
    // reintroduced through the console path.
    //
    // Tested against the REAL runner rather than through the server, whose
    // testkit injects a never-settling stub in its place.
    const clock = createTestClock(NOW);
    const ops = createTestProcessOps(() => clock.now());
    const dir = makeFixtureHarness(join(mkdtempSync(join(tmpdir(), "hangar-jobrun-")), "h"), {
      specName: "jobbed",
    });
    const runner = defaultJobRunner(ops, () => "/bin/crewhaus");

    const registered: Array<{ terminate: (signal: string) => void }> = [];
    const job = {
      jobId: "job_00000000000000a1",
      harnessDir: dir,
      kind: "doctor",
      argv: ["doctor"],
      mutating: false,
      state: "running",
      enqueuedAt: new Date(NOW).toISOString(),
    } as Parameters<typeof runner>[0];

    void runner(job, {
      register: (child) => registered.push(child as never),
      isCancelled: () => false,
    } as Parameters<typeof runner>[1]);
    await Promise.resolve();

    expect(ops.children.filter((c) => c.alive).length).toBe(1);
    expect(registered.length).toBe(1);

    // …and the thing it registered actually reaches the process.
    const pid = (ops.last() as NonNullable<ReturnType<typeof ops.last>>).pid;
    (registered[0] as { terminate: (s: string) => void }).terminate("SIGKILL");
    expect(ops.children.find((c) => c.pid === pid)?.alive).toBe(false);
  });
});
