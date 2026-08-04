import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_CODES } from "@crewhaus/errors";
import { buildReport } from "@crewhaus/preflight";
import type { GateDecision } from "./gate";
import { createPortLedger } from "./ports";
import { readRunLedger, readRunfile, runLogPath, writeRunfile } from "./runfiles";
import { type SpawnPlan, buildSpawnPlan } from "./spawn-contracts";
import { createHarnessSupervisor } from "./supervisor";
import type { HarnessSupervisor, SupervisorEvent } from "./supervisor";
import {
  type FakeClock,
  type FakeProcessOps,
  createFakeClock,
  createFakeProcessOps,
} from "./testkit";
import { RUNFILE_VERSION } from "./types";

const roots: string[] = [];
function tempHarness(target: string, env = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "chsup-sv-"));
  roots.push(dir);
  writeFileSync(join(dir, "crewhaus.yaml"), `name: demo\ntarget: ${target}\n`);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", target === "channel" ? "daemon.ts" : "agent.ts"), "// bundle\n");
  if (env !== "") writeFileSync(join(dir, ".env"), env);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

const allowGate = async (): Promise<GateDecision> => ({
  allowed: true,
  report: buildReport([]),
  refused: [],
  unforceable: [],
  acknowledged: [],
});

type Harness = {
  dir: string;
  ops: FakeProcessOps;
  clock: FakeClock;
  supervisor: HarnessSupervisor;
  events: SupervisorEvent[];
  plan: () => SpawnPlan;
};

function setup(
  target: string,
  options: {
    gate?: () => Promise<GateDecision>;
    env?: string;
    maxRestarts?: number;
    ports?: ReturnType<typeof createPortLedger>;
  } = {},
): Harness {
  const dir = tempHarness(target, options.env ?? "");
  const clock = createFakeClock();
  const ops = createFakeProcessOps({ now: clock.now });
  const plan = (): SpawnPlan =>
    buildSpawnPlan({
      harnessDir: dir,
      target,
      processEnv: {},
      ...(target === "channel" ? { ports: { port: 3000, controlPort: 3001 } } : {}),
    });
  let seq = 0;
  const supervisor = createHarnessSupervisor({
    harnessDir: dir,
    target,
    ops,
    clock,
    plan,
    gate: options.gate ?? allowGate,
    managerVersion: "0.5.0-test",
    newRunId: () => `run_${String(++seq).padStart(16, "0")}`,
    ...(options.maxRestarts !== undefined ? { maxRestarts: options.maxRestarts } : {}),
    ...(options.ports !== undefined ? { ports: options.ports } : {}),
  });
  const events: SupervisorEvent[] = [];
  supervisor.subscribe((event) => events.push(event));
  return { dir, ops, clock, supervisor, events, plan };
}

describe("start", () => {
  test("a daemon start writes the runfile, opens the ledger, and runs detached to a log fd", async () => {
    const h = setup("channel");
    const result = await h.supervisor.start();
    expect(result.ok).toBe(true);
    expect(h.supervisor.snapshot().state).toBe("running");

    const child = h.ops.last();
    expect(child?.request.detached).toBe(true);
    expect(child?.request.stdio.mode).toBe("file");
    expect(child?.request.cwd).toBe(h.dir); // the harness ROOT, not dist/
    expect(child?.request.env["CREWHAUS_TRACE"]).toBe("json");
    expect(child?.request.env["CREWHAUS_COST_TRACKING"]).toBe("1");

    const runfile = readRunfile(h.dir);
    expect(runfile?.v).toBe(RUNFILE_VERSION);
    expect(runfile?.pid).toBe(child?.pid);
    expect(runfile?.pidStartTimeMs).toBe(h.clock.now());
    expect(runfile?.port).toBe(3000);
    expect(runfile?.controlPort).toBe(3001);
    expect(runfile?.managerVersion).toBe("0.5.0-test");

    const ledger = readRunLedger(h.dir);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.kind).toBe("daemon");
    expect(ledger[0]?.logFile).toBe(`logs/${ledger[0]?.runId}.log`);
  });

  test("an interactive run is attached (piped) and writes NO daemon runfile", async () => {
    const h = setup("cli");
    await h.supervisor.start();
    expect(h.ops.last()?.request.stdio.mode).toBe("pipe");
    expect(h.ops.last()?.request.detached).toBe(false);
    expect(readRunfile(h.dir)).toBeUndefined();
    expect(readRunLedger(h.dir)[0]?.kind).toBe("interactive");
  });

  test("a live runfile makes a second start a no-op, not a second daemon", async () => {
    const h = setup("channel");
    await h.supervisor.start();
    const second = await h.supervisor.start();
    expect(second.ok).toBe(false);
    expect(h.ops.children).toHaveLength(1);
  });

  test("a foreign live runfile also refuses (singleton across managers)", async () => {
    const h = setup("channel");
    h.ops.register(9999, h.clock.now(), "bun dist/daemon.ts");
    writeRunfile(h.dir, {
      v: RUNFILE_VERSION,
      pid: 9999,
      pidStartTimeMs: h.clock.now(),
      argvFingerprint: "whatever",
      entry: "daemon.ts",
      bundleDir: join(h.dir, "dist"),
      runId: "run_ffffffffffffffff",
      startedAt: "t",
      managerVersion: "0.5.0",
    });
    const result = await h.supervisor.start();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("already-running");
    expect(h.ops.children).toHaveLength(0);
  });

  test("a STALE runfile does not block a start", async () => {
    const h = setup("channel");
    writeRunfile(h.dir, {
      v: RUNFILE_VERSION,
      pid: 9999, // never registered → dead
      pidStartTimeMs: 1,
      argvFingerprint: "whatever",
      entry: "daemon.ts",
      bundleDir: join(h.dir, "dist"),
      runId: "run_ffffffffffffffff",
      startedAt: "t",
      managerVersion: "0.5.0",
    });
    expect((await h.supervisor.start()).ok).toBe(true);
  });

  test("preflight blocks the spawn and returns the typed report", async () => {
    const blocked: GateDecision = {
      allowed: false,
      report: buildReport([
        {
          id: "channels.slack",
          area: "channels",
          level: "blocking",
          message: "will not boot: SLACK_SIGNING_SECRET unset",
        },
      ]),
      refused: [
        {
          id: "channels.slack",
          area: "channels",
          level: "blocking",
          message: "will not boot: SLACK_SIGNING_SECRET unset",
        },
      ],
      unforceable: [],
      acknowledged: [],
    };
    const h = setup("channel", { gate: async () => blocked });
    const result = await h.supervisor.start();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("preflight-blocked");
    if (result.reason !== "preflight-blocked") throw new Error("unreachable");
    expect(result.gate.refused[0]?.message).toContain("SLACK_SIGNING_SECRET");
    expect(h.ops.children).toHaveLength(0);
    expect(h.supervisor.snapshot().state).toBe("stopped");
  });

  test("a plan that cannot be built refuses with the error, never a spawn", async () => {
    const dir = tempHarness("channel");
    rmSync(join(dir, "dist"), { recursive: true, force: true });
    const clock = createFakeClock();
    const ops = createFakeProcessOps({ now: clock.now });
    const supervisor = createHarnessSupervisor({
      harnessDir: dir,
      target: "channel",
      ops,
      clock,
      plan: () => buildSpawnPlan({ harnessDir: dir, target: "channel", processEnv: {} }),
    });
    const result = await supervisor.start();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("plan-failed");
    expect(ops.children).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the port ledger records the run's ports and releases them on exit", async () => {
    const ports = createPortLedger();
    const h = setup("channel", { ports });
    await h.supervisor.start();
    expect(ports.claims().map((c) => [c.port, c.role])).toEqual([
      [3000, "daemon"],
      [3001, "control"],
    ]);
    h.ops.last()?.exit(EXIT_CODES.spec);
    await tick();
    expect(ports.claims()).toEqual([]);
  });
});

describe("exit classification", () => {
  test("exit 31 (billing) is terminal and NEVER auto-restarts", async () => {
    const h = setup("channel");
    await h.supervisor.start();
    h.ops.last()?.exit(EXIT_CODES.billing);
    await tick();
    expect(h.supervisor.snapshot().state).toBe("terminal");
    expect(h.clock.pendingCount()).toBe(0); // no restart timer
    h.clock.advance(60_000);
    expect(h.ops.children).toHaveLength(1);
    const entry = readRunLedger(h.dir)[0];
    expect(entry?.exitCode).toBe(EXIT_CODES.billing);
    expect(entry?.failureClass).toBe("billing");
    // The runfile is cleared so the next manual start is not refused.
    expect(readRunfile(h.dir)).toBeUndefined();
  });

  test("exit 33 (budget) is terminal — a restart would re-arm the spend", async () => {
    const h = setup("channel");
    await h.supervisor.start();
    h.ops.last()?.exit(EXIT_CODES.crewhaus_budget);
    await tick();
    expect(h.supervisor.snapshot().state).toBe("terminal");
    h.clock.advance(60_000);
    expect(h.ops.children).toHaveLength(1);
    expect(h.supervisor.snapshot().lastExit?.failureClass).toBe("crewhaus_budget");
  });

  for (const code of [EXIT_CODES.spec, EXIT_CODES.config, EXIT_CODES.auth]) {
    test(`exit ${code} is terminal`, async () => {
      const h = setup("channel");
      await h.supervisor.start();
      h.ops.last()?.exit(code);
      await tick();
      expect(h.supervisor.snapshot().state).toBe("terminal");
      h.clock.advance(60_000);
      expect(h.ops.children).toHaveLength(1);
    });
  }

  test("exit 36 parks — not a failure", async () => {
    const h = setup("channel");
    await h.supervisor.start();
    h.ops.last()?.exit(EXIT_CODES.approval_pending);
    await tick();
    expect(h.supervisor.snapshot().state).toBe("parked");
    expect(h.supervisor.snapshot().lastExit?.failureClass).toBe("approval_pending");
    h.clock.advance(60_000);
    expect(h.ops.children).toHaveLength(1);
  });

  test("a one-shot job that finishes is stopped, not restarted", async () => {
    const h = setup("workflow");
    await h.supervisor.start();
    h.ops.last()?.exit(0);
    await tick();
    expect(h.supervisor.snapshot().state).toBe("stopped");
    h.clock.advance(60_000);
    expect(h.ops.children).toHaveLength(1);
    expect(readRunLedger(h.dir)[0]?.kind).toBe("job");
  });

  test("a daemon exiting 0 unasked is 'exited cleanly (unexpected)' and restarts", async () => {
    const h = setup("channel");
    await h.supervisor.start();
    h.ops.last()?.exit(0);
    await tick();
    expect(h.supervisor.snapshot().lastExit?.title).toBe("exited cleanly (unexpected)");
    expect(h.supervisor.snapshot().state).toBe("crashed");
    h.clock.advance(500);
    await tick();
    expect(h.ops.children).toHaveLength(2);
  });
});

describe("restart policy", () => {
  test("backoff follows 500 → 1000 → 2000 → 4000 → 8000 ms under a fake clock", async () => {
    const h = setup("channel");
    await h.supervisor.start();
    const delays = [500, 1_000, 2_000, 4_000, 8_000];
    for (let i = 0; i < delays.length; i++) {
      h.ops.last()?.exit(EXIT_CODES.tool);
      await tick();
      expect(h.supervisor.snapshot().state).toBe("crashed");
      const delay = delays[i] as number;
      // One tick short of the backoff: still no new child.
      h.clock.advance(delay - 1);
      await tick();
      expect(h.ops.children).toHaveLength(i + 1);
      h.clock.advance(1);
      await tick();
      expect(h.ops.children).toHaveLength(i + 2);
    }
  });

  test("five restarts in the window, then crash-looping (manual start only)", async () => {
    const h = setup("channel");
    await h.supervisor.start();
    for (let i = 0; i < 5; i++) {
      h.ops.last()?.exit(EXIT_CODES.tool);
      await tick();
      h.clock.advance(30_000);
      await tick();
    }
    expect(h.ops.children).toHaveLength(6);
    expect(h.supervisor.snapshot().restartsInWindow).toBe(5);

    // The sixth crash inside the window gives up.
    h.ops.last()?.exit(EXIT_CODES.tool);
    await tick();
    expect(h.supervisor.snapshot().state).toBe("crash-looping");
    expect(h.clock.pendingCount()).toBe(0);
    h.clock.advance(600_000);
    await tick();
    expect(h.ops.children).toHaveLength(6);

    // …but an operator can still start it by hand.
    const manual = await h.supervisor.start();
    expect(manual.ok).toBe(true);
    expect(h.supervisor.snapshot().state).toBe("running");
  });

  test("forensics ride along into crash-looping", async () => {
    const h = setup("channel", { maxRestarts: 1 });
    await h.supervisor.start();
    const first = h.ops.last();
    first?.writeLog(
      `boot\n${JSON.stringify({ kind: "run_failed", runId: "run_x", detail: "tool exploded" })}\nbye\n`,
    );
    h.clock.advance(250); // let the pump read it
    first?.exit(EXIT_CODES.tool);
    await tick();
    // The first crash already carries the structured failure + the tail.
    expect(h.supervisor.snapshot().forensics?.lastRunFailed?.["detail"]).toBe("tool exploded");
    expect(h.supervisor.snapshot().forensics?.tail).toContain("boot");

    h.clock.advance(500);
    await tick();
    const second = h.ops.last();
    second?.writeLog("second life, same crash\n");
    second?.exit(EXIT_CODES.tool);
    await tick();
    expect(h.supervisor.snapshot().state).toBe("crash-looping");
    const forensics = h.supervisor.snapshot().forensics;
    expect(forensics?.exitCode).toBe(EXIT_CODES.tool);
    expect(forensics?.tail).toContain("second life, same crash");
  });

  test("a crashed ONE-SHOT job is never restarted", async () => {
    const h = setup("workflow");
    await h.supervisor.start();
    h.ops.last()?.exit(EXIT_CODES.tool);
    await tick();
    expect(h.supervisor.snapshot().state).toBe("crashed");
    h.clock.advance(600_000);
    expect(h.ops.children).toHaveLength(1);
  });
});

describe("stop", () => {
  test("SIGTERM, clean exit, runfile cleared, and NO restart", async () => {
    const h = setup("channel");
    await h.supervisor.start();
    const stopped = await h.supervisor.stop();
    expect(stopped.forced).toBe(false);
    expect(h.ops.children[0]?.signals).toEqual(["SIGTERM"]);
    await tick();
    expect(h.supervisor.snapshot().state).toBe("stopped");
    expect(readRunfile(h.dir)).toBeUndefined();
    h.clock.advance(600_000);
    expect(h.ops.children).toHaveLength(1);
  });

  test("a child that ignores SIGTERM is SIGKILLed after the grace and recorded forced", async () => {
    const h = setup("channel");
    await h.supervisor.start();
    const child = h.ops.last();
    if (child === undefined) throw new Error("no child");
    child.ignoreTerm = true;
    const stopping = h.supervisor.stop();
    await tick();
    expect(child.signals).toEqual(["SIGTERM"]);
    h.clock.advance(15_000);
    const result = await stopping;
    expect(result.forced).toBe(true);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    await tick();
    expect(readRunLedger(h.dir)[0]?.forced).toBe(true);
  });

  test("an operator stop cancels a scheduled auto-restart", async () => {
    const h = setup("channel");
    await h.supervisor.start();
    h.ops.last()?.exit(EXIT_CODES.tool);
    await tick();
    expect(h.supervisor.snapshot().state).toBe("crashed");
    expect(h.supervisor.snapshot().nextRestartAtMs).toBeDefined();
    await h.supervisor.stop();
    h.clock.advance(600_000);
    await tick();
    expect(h.ops.children).toHaveLength(1);
    expect(h.supervisor.snapshot().state).toBe("stopped");
  });

  test("a manual start supersedes a pending auto-restart instead of racing it", async () => {
    const h = setup("channel");
    await h.supervisor.start();
    h.ops.last()?.exit(EXIT_CODES.tool);
    await tick();
    expect(await h.supervisor.start()).toMatchObject({ ok: true });
    h.clock.advance(600_000);
    await tick();
    expect(h.ops.children).toHaveLength(2);
  });

  test("stopping when nothing runs is a no-op that still clears a ghost runfile", async () => {
    const h = setup("channel");
    const result = await h.supervisor.stop();
    expect(result).toEqual({ stopped: true, forced: false });
    expect(h.supervisor.snapshot().state).toBe("stopped");
  });

  test("restart stops then starts a fresh run", async () => {
    const h = setup("channel");
    await h.supervisor.start();
    const first = h.supervisor.snapshot().runId;
    const result = await h.supervisor.restart();
    expect(result.ok).toBe(true);
    expect(h.supervisor.snapshot().runId).not.toBe(first);
    expect(h.ops.children).toHaveLength(2);
  });

  test("drain uses the control call, falling back to a signal stop on refusal", async () => {
    const h = setup("channel");
    await h.supervisor.start();
    const child = h.ops.last();
    const draining = h.supervisor.drain(async () => {
      expect(h.supervisor.snapshot().state).toBe("draining");
      child?.exit(0);
    });
    await draining;
    expect(child?.signals).toEqual([]); // no signal was needed
    await tick();
    expect(h.supervisor.snapshot().state).toBe("stopped");

    const h2 = setup("channel");
    await h2.supervisor.start();
    await h2.supervisor.drain(async () => {
      throw new Error("no control.v1 on a 0.4.x bundle");
    });
    expect(h2.ops.last()?.signals).toEqual(["SIGTERM"]);
  });
});

describe("output capture", () => {
  test("prose and events reach subscribers, scrubbed, and the session id is ledgered", async () => {
    const secret = ["sk", "fixture", "1111222233334444"].join("-");
    const h = setup("channel", { env: `ANTHROPIC_API_KEY=${secret}\n` });
    await h.supervisor.start();
    const child = h.ops.last();
    child?.writeLog(
      `boot with ${secret}\n${JSON.stringify({
        kind: "run_start",
        runId: "run_x",
        sessionId: "sess_0123456789abcdef",
      })}\n`,
    );
    h.clock.advance(250);
    const outputs = h.events.filter((e) => e.type === "output");
    expect(outputs).toHaveLength(1);
    const output = outputs[0];
    if (output?.type !== "output") throw new Error("unreachable");
    expect(output.prose).not.toContain(secret);
    expect(output.prose).toContain("«ANTHROPIC_API_KEY»");
    expect(output.events).toHaveLength(1);
    expect(h.supervisor.snapshot().sessionId).toBe("sess_0123456789abcdef");
    expect(readRunLedger(h.dir)[0]?.sessionId).toBe("sess_0123456789abcdef");
  });

  test("the pump keeps ticking while running and stops after the exit", async () => {
    const h = setup("channel");
    await h.supervisor.start();
    h.clock.advance(1_000);
    expect(h.clock.pendingCount()).toBe(1);
    h.ops.last()?.exit(EXIT_CODES.billing);
    await tick();
    expect(h.clock.pendingCount()).toBe(0);
  });

  test("the final flush captures the last line of a crashing run", async () => {
    const h = setup("channel");
    await h.supervisor.start();
    h.ops.last()?.writeLog("last words before the crash\n");
    h.ops.last()?.exit(EXIT_CODES.tool);
    await tick();
    const proseSeen = h.events
      .filter((e) => e.type === "output")
      .map((e) => (e.type === "output" ? e.prose : ""))
      .join("");
    expect(proseSeen).toContain("last words before the crash");
  });
});

describe("adopt", () => {
  test("adopts a live runfile and keeps supervising it", async () => {
    const h = setup("channel");
    await h.supervisor.start();
    const runfile = readRunfile(h.dir);
    const child = h.ops.last();
    if (runfile === undefined || child === undefined) throw new Error("no run");

    // A NEW manager over the same harness dir.
    const clock2 = createFakeClock(h.clock.now());
    const second = createHarnessSupervisor({
      harnessDir: h.dir,
      target: "channel",
      ops: h.ops,
      clock: clock2,
      plan: h.plan,
      gate: allowGate,
    });
    expect(await second.adopt()).toBe("adopted");
    expect(second.snapshot().state).toBe("running");
    expect(second.snapshot().pid).toBe(runfile.pid);
    expect(second.snapshot().adopted).toBe(true);

    // The pump tick is also its liveness poll.
    h.ops.unregister(runfile.pid);
    clock2.advance(250);
    await tick();
    expect(second.snapshot().state).not.toBe("running");
    expect(second.snapshot().lastExit?.title).toContain("exit code unknown");
    second.close();
  });

  test("a dead runfile adopts as lost with the tail attached", async () => {
    const h = setup("channel");
    await h.supervisor.start();
    const runfile = readRunfile(h.dir);
    if (runfile === undefined) throw new Error("no runfile");
    writeFileSync(runLogPath(h.dir, runfile.runId), "it died alone\n");
    h.ops.unregister(runfile.pid);

    const second = createHarnessSupervisor({
      harnessDir: h.dir,
      target: "channel",
      ops: h.ops,
      clock: createFakeClock(),
      plan: h.plan,
    });
    expect(await second.adopt()).toBe("lost");
    expect(second.snapshot().forensics?.tail).toEqual(["it died alone"]);
    expect(second.snapshot().state).toBe("crashed");
    second.close();
  });

  test("nothing to adopt reports none", async () => {
    const h = setup("channel");
    expect(await h.supervisor.adopt()).toBe("none");
  });

  test("a restart recovers the last exit from the ledger, flagged as ledger-derived", async () => {
    const h = setup("channel");
    await h.supervisor.start();
    const runfile = readRunfile(h.dir);
    const child = h.ops.last();
    if (runfile === undefined || child === undefined) throw new Error("no run");
    // The daemon dies out of funding while we are watching, so the ledger
    // records the exit and the runfile is cleared.
    child.exit(EXIT_CODES.billing);
    await tick();
    h.supervisor.close();

    // A NEW manager: nothing live to adopt, but the fleet failure board must
    // not go blank just because the console restarted.
    const second = createHarnessSupervisor({
      harnessDir: h.dir,
      target: "channel",
      ops: h.ops,
      clock: createFakeClock(),
      plan: h.plan,
      gate: allowGate,
    });
    expect(await second.adopt()).toBe("none");
    const snap = second.snapshot();
    expect(snap.state).toBe("stopped");
    expect(snap.lastExit?.exitCode).toBe(EXIT_CODES.billing);
    expect(snap.lastExit?.failureClass).toBe("billing");
    // Provenance is explicit — we did not watch this happen.
    expect(snap.lastExit?.fromLedger).toBe(true);
    expect(snap.lastExit?.endedAt).toBeTruthy();
    // And it is never treated as restartable on the strength of a ledger read.
    expect(snap.lastExit?.restartable).toBe(false);
    second.close();
  });
});

describe("close", () => {
  test("stops the timers without touching the child", async () => {
    const h = setup("channel");
    await h.supervisor.start();
    h.supervisor.close();
    expect(h.clock.pendingCount()).toBe(0);
    expect(h.ops.last()?.signals).toEqual([]);
    expect(h.ops.last()?.alive).toBe(true);
  });
});
