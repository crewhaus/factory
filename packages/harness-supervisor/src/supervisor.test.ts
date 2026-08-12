import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_CODES } from "@crewhaus/errors";
import { buildReport } from "@crewhaus/preflight";
import type { GateDecision } from "./gate";
import { createPortLedger } from "./ports";
import type { PrepareOutcome, PrepareRunner } from "./prepare";
import type { ProcessOps } from "./process-ops";
import {
  acquireStartLock,
  appendRunLedger,
  patchRunLedger,
  readRunLedger,
  readRunfile,
  readStartLock,
  runCursorPath,
  runDir,
  runEventsPath,
  runLogPath,
  writeRunfile,
} from "./runfiles";
import { type SpawnPlan, buildSpawnPlan } from "./spawn-contracts";
import { createHarnessSupervisor } from "./supervisor";
import type { HarnessSupervisor, SupervisorEvent } from "./supervisor";
import {
  type FakeClock,
  type FakeProcessOps,
  createFakeClock,
  createFakeProcessOps,
} from "./testkit";
import { replayRunEvents } from "./trace-pump";
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

type SetupOptions = {
  gate?: () => Promise<GateDecision>;
  env?: string;
  maxRestarts?: number;
  ports?: ReturnType<typeof createPortLedger>;
  /** Override the ports the PLAN stamps (0 = kernel-assigned control port). */
  planPorts?: { port?: number; gatewayPort?: number; controlPort?: number };
  /** Wrap the fake ops — for injecting spawn failures or spying on signals. */
  wrapOps?: (ops: FakeProcessOps) => ProcessOps;
  /** The manager pid recorded in the start lock. */
  ownerPid?: number;
  newRunId?: () => string;
  /** The prepare seams (compile-if-stale + operator hooks). */
  prepare?: () => PrepareRunner;
};

function setup(target: string, options: SetupOptions = {}): Harness {
  const dir = tempHarness(target, options.env ?? "");
  const clock = createFakeClock();
  const ops = createFakeProcessOps({ now: clock.now });
  const planPorts =
    options.planPorts ?? (target === "channel" ? { port: 3000, controlPort: 3001 } : undefined);
  const plan = (): SpawnPlan =>
    buildSpawnPlan({
      harnessDir: dir,
      target,
      processEnv: {},
      ...(planPorts !== undefined ? { ports: planPorts } : {}),
    });
  let seq = 0;
  const supervisor = createHarnessSupervisor({
    harnessDir: dir,
    target,
    ops: options.wrapOps === undefined ? ops : options.wrapOps(ops),
    clock,
    plan,
    gate: options.gate ?? allowGate,
    managerVersion: "0.5.0-test",
    newRunId: options.newRunId ?? (() => `run_${String(++seq).padStart(16, "0")}`),
    ...(options.maxRestarts !== undefined ? { maxRestarts: options.maxRestarts } : {}),
    ...(options.ports !== undefined ? { ports: options.ports } : {}),
    ...(options.ownerPid !== undefined ? { ownerPid: options.ownerPid } : {}),
    ...(options.prepare !== undefined ? { prepare: options.prepare } : {}),
  });
  const events: SupervisorEvent[] = [];
  supervisor.subscribe((event) => events.push(event));
  return { dir, ops, clock, supervisor, events, plan };
}

/** A runfile for a daemon "started by the other head" — a live pid this
 *  supervisor never spawned and has never adopted. */
function foreignDaemon(h: Harness, pid: number, runId = "run_ffffffffffffffff"): void {
  h.ops.register(pid, h.clock.now(), "bun dist/daemon.ts");
  writeRunfile(h.dir, {
    v: RUNFILE_VERSION,
    pid,
    pidStartTimeMs: h.clock.now(),
    argvFingerprint: "foreign",
    entry: "daemon.ts",
    bundleDir: join(h.dir, "dist"),
    runId,
    startedAt: new Date(h.clock.now()).toISOString(),
    managerVersion: "0.5.0",
  });
  appendRunLedger(h.dir, {
    runId,
    kind: "daemon",
    argv: ["bun", "dist/daemon.ts"],
    startedAt: new Date(h.clock.now()).toISOString(),
    logFile: `logs/${runId}.log`,
  });
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

  test("a refused prepare step stops the start — nothing is spawned, no runfile", async () => {
    const refuse = async (): Promise<PrepareOutcome> => ({
      ok: false,
      refusal: { stage: "postCompile", message: "patch.ts exited 3", exitCode: 3, output: ["no"] },
    });
    const h = setup("channel", {
      prepare: () => ({
        prepare: refuse,
        preSpawn: async () => ({ ok: true, replan: false, notes: [] }),
        configured: { compile: false, hooks: ["postCompile"] },
      }),
    });
    const result = await h.supervisor.start();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("prepare-refused");
    expect(h.ops.children).toHaveLength(0);
    expect(readRunfile(h.dir)).toBeUndefined();
    // The slot is free again: a refused prep must not wedge the harness shut.
    expect(readStartLock(h.dir)).toBeUndefined();
    expect(h.supervisor.snapshot().state).toBe("stopped");
  });

  test("a refused preSpawn hook stops the start AFTER preflight passed", async () => {
    const gateCalls: number[] = [];
    const h = setup("channel", {
      gate: async () => {
        gateCalls.push(1);
        return allowGate();
      },
      prepare: () => ({
        prepare: async () => ({ ok: true, replan: false, notes: [] }),
        preSpawn: async () => ({
          ok: false,
          refusal: { stage: "preSpawn", message: "warm.ts exited 1", output: [] },
        }),
        configured: { compile: false, hooks: ["preSpawn"] },
      }),
    });
    const result = await h.supervisor.start();
    expect(result.ok).toBe(false);
    // Preflight DID run: preSpawn is the last gate, not a replacement.
    expect(gateCalls).toHaveLength(1);
    expect(h.ops.children).toHaveLength(0);
  });

  test("prepare runs BEFORE preflight, so preflight sees the fresh bundle", async () => {
    const order: string[] = [];
    const h = setup("channel", {
      gate: async () => {
        order.push("gate");
        return allowGate();
      },
      prepare: () => ({
        prepare: async () => {
          order.push("prepare");
          return { ok: true, replan: false, notes: ["recompiled dist/"] };
        },
        preSpawn: async () => {
          order.push("preSpawn");
          return { ok: true, replan: false, notes: [] };
        },
        configured: { compile: true, hooks: ["preSpawn"] },
      }),
    });
    const result = await h.supervisor.start();
    expect(order).toEqual(["prepare", "gate", "preSpawn"]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.prepared).toEqual(["recompiled dist/"]);
  });

  test("`replan` rebuilds the plan, so the spawn launches the RECOMPILED entry", async () => {
    // The whole point of the recompile: without the rebuild the spawn uses
    // the entry resolved before the compile — silent staleness one level
    // down from the one `--compile` exists to end.
    const dir = tempHarness("channel");
    const clock = createFakeClock();
    const ops = createFakeProcessOps({ now: clock.now });
    let planCalls = 0;
    const supervisor = createHarnessSupervisor({
      harnessDir: dir,
      target: "channel",
      ops,
      clock,
      gate: allowGate,
      plan: () => {
        planCalls += 1;
        return buildSpawnPlan({
          harnessDir: dir,
          target: "channel",
          processEnv: { PLAN_CALL: String(planCalls) },
        });
      },
      prepare: () => ({
        prepare: async () => ({ ok: true, replan: true, notes: [] }),
        preSpawn: async () => ({ ok: true, replan: false, notes: [] }),
        configured: { compile: true, hooks: [] },
      }),
    });
    try {
      await supervisor.start();
      expect(planCalls).toBe(2);
      expect(ops.last()?.request.env["PLAN_CALL"]).toBe("2");
    } finally {
      supervisor.close();
    }
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

describe("the start lock", () => {
  test("two managers racing through preflight spawn ONE daemon, not two", async () => {
    // The runfile is written AFTER the spawn, so it could never cover the
    // window that matters — the whole preflight run sat inside it. Two
    // managers both read "no runfile", both passed preflight, and both
    // spawned a channel daemon on the same credentials.
    const dir = tempHarness("channel");
    const clock = createFakeClock();
    const ops = createFakeProcessOps({ now: clock.now });
    ops.register(1001, clock.now(), "manager-a");
    ops.register(1002, clock.now(), "manager-b");
    const plan = (): SpawnPlan =>
      buildSpawnPlan({ harnessDir: dir, target: "channel", processEnv: {} });

    let releaseGate: (() => void) | undefined;
    const slowGate = async (): Promise<GateDecision> => {
      await new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      return allowGate();
    };
    const managerA = createHarnessSupervisor({
      harnessDir: dir,
      target: "channel",
      ops,
      clock,
      plan,
      gate: slowGate,
      ownerPid: 1001,
    });
    const managerB = createHarnessSupervisor({
      harnessDir: dir,
      target: "channel",
      ops,
      clock,
      plan,
      gate: allowGate,
      ownerPid: 1002,
    });

    const startingA = managerA.start();
    await tick(); // A is now inside preflight, holding the lock
    expect(readStartLock(dir)?.pid).toBe(1001);

    const resultB = await managerB.start();
    expect(resultB.ok).toBe(false);
    if (resultB.ok) throw new Error("unreachable");
    expect(resultB.reason).toBe("already-running");

    releaseGate?.();
    expect((await startingA).ok).toBe(true);
    expect(ops.children).toHaveLength(1);
    // The claim is handed over to the runfile, never left behind.
    expect(readStartLock(dir)).toBeUndefined();
    managerA.close();
    managerB.close();
  });

  test("an abandoned lock is broken, never a permanent wedge", async () => {
    const h = setup("channel", { ownerPid: 1001 });
    h.ops.register(1001, h.clock.now(), "manager-a");
    // A manager that was killed mid-preflight left its claim behind.
    expect(acquireStartLock(h.dir, { pid: 4_040_404, at: h.clock.now() })).toBe(true);
    expect((await h.supervisor.start()).ok).toBe(true);
    expect(h.ops.children).toHaveLength(1);
  });

  test("the lock is released on the preflight-blocked path too", async () => {
    const blocked: GateDecision = {
      allowed: false,
      report: buildReport([]),
      refused: [],
      unforceable: [],
      acknowledged: [],
    };
    const h = setup("channel", { gate: async () => blocked });
    await h.supervisor.start();
    expect(readStartLock(h.dir)).toBeUndefined();
    // …and the next start is not refused by the corpse of the last one.
    const h2 = setup("channel");
    expect((await h2.supervisor.start()).ok).toBe(true);
  });
});

describe("a start that cannot launch", () => {
  test("a throwing spawn returns a typed failure instead of wedging in `starting`", async () => {
    let failing = true;
    const h = setup("channel", {
      wrapOps: (ops) => ({
        ...ops,
        spawn: (request) => {
          if (failing) throw new Error("EMFILE: too many open files");
          return ops.spawn(request);
        },
      }),
    });
    const result = await h.supervisor.start();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("plan-failed");
    if (result.reason !== "plan-failed") throw new Error("unreachable");
    expect(result.stage).toBe("spawn");
    expect(result.error.message).toContain("EMFILE");
    // NOT wedged: `starting` used to stick, and the entry guard then refused
    // every later start with `already-running` until the manager restarted.
    expect(h.supervisor.snapshot().state).not.toBe("starting");
    expect(readStartLock(h.dir)).toBeUndefined();

    failing = false;
    const second = await h.supervisor.start();
    expect(second.ok).toBe(true);
    expect(h.ops.children).toHaveLength(1);
  });

  test("a throw AFTER the spawn kills the orphan rather than leaving it unobserved", async () => {
    const h = setup("channel");
    // Make the run ledger un-appendable (stands in for ENOSPC/EMFILE): the
    // child is already spawned when this throws, and it used to be left with
    // no exit handler at all — its exit was never observed and `stop()`
    // awaited an event that could never fire.
    mkdirSync(join(runDir(h.dir), "runs.jsonl"), { recursive: true });
    const result = await h.supervisor.start();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("plan-failed");
    expect(h.ops.children).toHaveLength(1);
    expect(h.ops.last()?.signals).toContain("SIGKILL");
    expect(h.ops.last()?.alive).toBe(false);
    expect(h.supervisor.snapshot().state).toBe("crashed");
    expect(h.supervisor.snapshot().pid).toBeUndefined();
    // No lock and no runfile left behind for the next start to trip over.
    expect(readStartLock(h.dir)).toBeUndefined();
    expect(readRunfile(h.dir)).toBeUndefined();
    // And a stop resolves rather than hanging on an exit that never comes.
    expect(await h.supervisor.stop()).toMatchObject({ stopped: true });
  });

  test("an automatic restart that throws is caught, not left to unhandledRejection", async () => {
    let mints = 0;
    const h = setup("channel", {
      newRunId: () => {
        mints += 1;
        if (mints > 1) throw new Error("the id minter exploded");
        return "run_00000000000000a1";
      },
    });
    await h.supervisor.start();
    h.ops.last()?.exit(EXIT_CODES.tool);
    await tick();
    expect(h.supervisor.snapshot().state).toBe("crashed");
    // The auto-restart runs on a TIMER — outside every caller's try/catch.
    h.clock.advance(500);
    await tick();
    await h.supervisor.idle();
    expect(h.supervisor.snapshot().lastExit?.title).toContain("automatic restart failed");
    expect(h.supervisor.snapshot().state).toBe("crashed");
    // And the supervisor is not wedged: the entry guard reads `starting` as
    // "already-running", so a state we enter must be one we can leave.
    expect(h.supervisor.snapshot().state).not.toBe("starting");
    expect(readStartLock(h.dir)).toBeUndefined();
  });
});

describe("a daemon this manager did not start", () => {
  test("stop() says so instead of deleting a LIVE daemon's lock", async () => {
    const h = setup("channel");
    foreignDaemon(h, 9911);
    // The console never adopted it, so it holds no pid…
    expect(h.supervisor.snapshot().pid).toBeUndefined();
    // The operator presses Start first; it is correctly refused — but that
    // refusal is what used to arm the cleanup path with a daemon plan.
    const refused = await h.supervisor.start();
    expect(refused.ok).toBe(false);
    expect(h.ops.children).toHaveLength(0);

    const result = await h.supervisor.stop();
    // …and stop must not claim it stopped something.
    expect(result.stopped).toBe(false);
    expect(result.reason).toBe("not-adopted");
    expect(result.runfile?.pid).toBe(9911);
    // The singleton lock survives, so the next start is still refused
    // instead of sailing through and spawning a second daemon.
    expect(readRunfile(h.dir)?.pid).toBe(9911);
    expect(h.ops.isAlive(9911)).toBe(true);
    const start = await h.supervisor.start();
    expect(start.ok).toBe(false);
    expect(h.ops.children).toHaveLength(0);
  });

  test("restart() adopts and signals it — it never spawns a duplicate beside it", async () => {
    const terminated: number[] = [];
    const h = setup("channel", {
      wrapOps: (ops) => ({
        ...ops,
        terminate: (pid) => {
          terminated.push(pid);
          ops.terminate(pid);
        },
      }),
    });
    foreignDaemon(h, 9911);
    const restarting = h.supervisor.restart();
    await tick();
    expect(terminated).toEqual([9911]);
    // The daemon obeys the signal; the pump tick is its liveness poll.
    h.ops.unregister(9911);
    h.clock.advance(250);
    await tick();
    const result = await restarting;
    expect(result.ok).toBe(true);
    // Exactly ONE new daemon, and the old one is gone — not two live
    // channel daemons consuming the same webhook stream.
    expect(h.ops.children).toHaveLength(1);
    expect(h.ops.isAlive(9911)).toBe(false);
    expect(readRunfile(h.dir)?.pid).toBe(h.ops.last()?.pid);
  });

  test("drain() reports not-adopted rather than a graceful drain it never did", async () => {
    const h = setup("channel");
    foreignDaemon(h, 9911);
    let called = false;
    const result = await h.supervisor.drain(async () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(result).toMatchObject({ stopped: false, reason: "not-adopted" });
    expect(readRunfile(h.dir)?.pid).toBe(9911);
  });

  test("adoptIfRunfile adopts a late-arriving daemon and is a no-op otherwise", async () => {
    const h = setup("channel");
    // Nothing on disk: the cheap path, and it must not disturb any state.
    expect(await h.supervisor.adoptIfRunfile()).toBe("none");
    expect(h.supervisor.snapshot().state).toBe("stopped");

    foreignDaemon(h, 9911);
    expect(await h.supervisor.adoptIfRunfile()).toBe("adopted");
    expect(h.supervisor.snapshot().pid).toBe(9911);
    expect(h.supervisor.snapshot().adopted).toBe(true);
    // Already holding it: no second adoption, no second pump.
    expect(await h.supervisor.adoptIfRunfile()).toBe("none");
    expect(h.supervisor.snapshot().pid).toBe(9911);
  });
});

describe("an adopted run", () => {
  test("a clean stop clears the runfile, so it never reads back as a crash", async () => {
    const h = setup("channel");
    foreignDaemon(h, 9911, "run_00000000000000ff");
    expect(await h.supervisor.adopt()).toBe("adopted");

    const stopping = h.supervisor.stop();
    await tick();
    h.ops.unregister(9911); // it obeyed the SIGTERM
    h.clock.advance(250);
    await tick();
    await stopping;

    expect(h.supervisor.snapshot().state).toBe("stopped");
    // The runfile used to SURVIVE a deliberate stop, because cleanup was
    // gated on a plan an adopted run never has.
    expect(readRunfile(h.dir)).toBeUndefined();
    const ledger = readRunLedger(h.dir);
    expect(ledger[0]?.endedAt).toBeTruthy();
    expect(ledger[0]?.failureClass).toBeUndefined();

    // The next manager over the same harness sees a harness that was STOPPED
    // — not a crash, and it does not stamp `interrupted` over a clean row.
    const second = createHarnessSupervisor({
      harnessDir: h.dir,
      target: "channel",
      ops: h.ops,
      clock: createFakeClock(h.clock.now()),
      plan: h.plan,
      gate: allowGate,
    });
    expect(await second.adopt()).toBe("none");
    expect(second.snapshot().state).toBe("stopped");
    expect(readRunLedger(h.dir)[0]?.failureClass).toBeUndefined();
    second.close();
  });

  test("its ports come from the runfile so the snapshot is not blank", async () => {
    const h = setup("channel");
    h.ops.register(9911, h.clock.now(), "bun dist/daemon.ts");
    writeRunfile(h.dir, {
      v: RUNFILE_VERSION,
      pid: 9911,
      pidStartTimeMs: h.clock.now(),
      argvFingerprint: "foreign",
      port: 3000,
      controlPort: 41234,
      entry: "daemon.ts",
      bundleDir: join(h.dir, "dist"),
      runId: "run_00000000000000ff",
      startedAt: "t",
      managerVersion: "0.5.0",
    });
    expect(await h.supervisor.adopt()).toBe("adopted");
    expect(h.supervisor.snapshot().ports).toEqual({ port: 3000, controlPort: 41234 });
    expect(h.supervisor.snapshot().controlPort).toBe(41234);
  });
});

describe("the control.v1 announcement", () => {
  test("the announced port is recorded in the runfile, for BOTH heads", async () => {
    // The plan asks for a kernel-assigned port, so the runfile starts at 0 —
    // "not known yet". The daemon announces the real one on stdout, and that
    // line is the only place it exists. Capturing it here (not in the
    // console) is what lets `crewhaus daemon wake/drain` reach a daemon a
    // shell started.
    const h = setup("channel", { planPorts: { port: 3000, controlPort: 0 } });
    await h.supervisor.start();
    expect(readRunfile(h.dir)?.controlPort).toBe(0);
    expect(h.supervisor.snapshot().controlPort).toBeUndefined();

    h.ops
      .last()
      ?.writeLog(
        "booting\n[control] crewhaus.control.v1 listening on http://127.0.0.1:41234 (token: .crewhaus/run/control-token)\n",
      );
    h.clock.advance(250);
    expect(readRunfile(h.dir)?.controlPort).toBe(41234);
    expect(h.supervisor.snapshot().controlPort).toBe(41234);

    // It does not survive the run it belongs to.
    h.ops.last()?.exit(EXIT_CODES.billing);
    await tick();
    expect(h.supervisor.snapshot().controlPort).toBeUndefined();
  });
});

describe("markOperatorStop", () => {
  test("the next exit reads as a clean stop, with no restart scheduled", async () => {
    const h = setup("channel");
    await h.supervisor.start();
    // The caller drained the daemon over control.v1; it will exit on its own.
    h.supervisor.markOperatorStop();
    h.supervisor.markOperatorStop(); // idempotent
    h.ops.last()?.exit(0);
    await tick();
    expect(h.supervisor.snapshot().lastExit?.title).toBe("stopped by the operator");
    expect(h.supervisor.snapshot().state).toBe("stopped");
    h.clock.advance(600_000);
    await tick();
    expect(h.ops.children).toHaveLength(1);
    expect(readRunfile(h.dir)).toBeUndefined();
  });

  test("a successful start consumes the mark rather than carrying it forward", async () => {
    const h = setup("channel");
    h.supervisor.markOperatorStop();
    await h.supervisor.start();
    h.ops.last()?.exit(EXIT_CODES.tool);
    await tick();
    // A real crash after the start is still a crash.
    expect(h.supervisor.snapshot().state).toBe("crashed");
    expect(h.supervisor.snapshot().lastExit?.disposition).toBe("crash");
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

describe("an adopted run's exit code is recovered, not discarded", () => {
  test("a billing exit stays TERMINAL after a manager restart instead of auto-restarting", async () => {
    const h = setup("channel");
    const runId = "run_00000000000000b1";
    foreignDaemon(h, 9931, runId);
    // Exactly what a manager that died mid-run leaves behind: the log, the
    // events the PREVIOUS manager's pump already extracted from it, and the
    // cursor covering both. This run_failed line is the evidence a pid-polled
    // exit used to throw away.
    const logText = `starting up\n${JSON.stringify({
      kind: "run_failed",
      class: "billing",
      exitCode: EXIT_CODES.billing,
      remediation: "add credits, then rerun.",
    })}\n`;
    const eventsText = `${JSON.stringify({
      kind: "run_failed",
      class: "billing",
      exitCode: EXIT_CODES.billing,
      remediation: "add credits, then rerun.",
    })}\n`;
    writeFileSync(runLogPath(h.dir, runId), logText);
    writeFileSync(runEventsPath(h.dir, runId), eventsText);
    writeFileSync(
      runCursorPath(h.dir, runId),
      JSON.stringify({
        logOffset: Buffer.byteLength(logText),
        eventsBytes: Buffer.byteLength(eventsText),
      }),
    );
    expect(await h.supervisor.adopt()).toBe("adopted");
    expect(replayRunEvents(runEventsPath(h.dir, runId)).length).toBe(1);

    h.ops.unregister(9931); // died while we were only polling its pid
    h.clock.advance(250);
    await tick();

    const snap = h.supervisor.snapshot();
    expect(snap.lastExit?.disposition).toBe("terminal");
    expect(snap.lastExit?.failureClass).toBe("billing");
    expect(snap.lastExit?.restartable).toBe(false);
    // The whole point: no restart was scheduled, and none happens.
    expect(snap.state).toBe("terminal");
    expect(snap.nextRestartAtMs).toBeUndefined();
    h.clock.advance(60_000);
    await tick();
    expect(h.supervisor.snapshot().state).toBe("terminal");
    // The remediation the daemon supplied is still in front of the operator.
    expect(h.supervisor.snapshot().forensics?.lastRunFailed?.["remediation"]).toBe(
      "add credits, then rerun.",
    );
  });

  test("with genuinely no evidence it still says the code is unknown", async () => {
    const h = setup("channel");
    foreignDaemon(h, 9932, "run_00000000000000b2");
    expect(await h.supervisor.adopt()).toBe("adopted");
    h.ops.unregister(9932);
    h.clock.advance(250);
    await tick();
    expect(h.supervisor.snapshot().lastExit?.title).toContain("exit code unknown");
  });
});

describe("the ledger-derived lastExit", () => {
  test("fires for an INTERRUPTED row, which carries no exit code at all", async () => {
    const h = setup("channel");
    const runId = "run_00000000000000c1";
    appendRunLedger(h.dir, {
      runId,
      kind: "daemon",
      argv: ["bun", "dist/daemon.ts"],
      startedAt: new Date(h.clock.now() - 5_000).toISOString(),
      logFile: `logs/${runId}.log`,
    });
    // Exactly what the stale-runfile path writes: an ending, a failure
    // class, and NO exitCode.
    patchRunLedger(h.dir, {
      runId,
      endedAt: new Date(h.clock.now()).toISOString(),
      failureClass: "interrupted",
    });

    expect(await h.supervisor.adopt()).toBe("none");
    const snap = h.supervisor.snapshot();
    // Used to be undefined — the failure board was blank in exactly the
    // case this fold exists for.
    expect(snap.lastExit).toBeDefined();
    expect(snap.lastExit?.fromLedger).toBe(true);
    expect(snap.lastExit?.title).toContain("interrupted");
    expect(snap.lastExit?.restartable).toBe(false);
  });
});

describe("the rolling restart window", () => {
  test("a MANUAL start clears it; an automatic restart does not", async () => {
    const h = setup("channel");
    expect((await h.supervisor.start()).ok).toBe(true);

    // Crash it enough times to exhaust the window.
    for (let i = 0; i < 5; i += 1) {
      h.ops.last()?.exit(1);
      await tick();
      h.clock.advance(60_000); // past the longest backoff
      await tick();
      // Each automatic restart must LEAVE the count climbing.
      expect(h.supervisor.snapshot().restartsInWindow).toBe(i + 1);
    }
    h.ops.last()?.exit(1);
    await tick();
    expect(h.supervisor.snapshot().state).toBe("crash-looping");

    // The operator intervenes. That is the one signal the loop may be over.
    expect((await h.supervisor.start()).ok).toBe(true);
    expect(h.supervisor.snapshot().restartsInWindow).toBe(0);
    // …so the next crash gets the full backoff ladder again rather than
    // dropping straight back into crash-looping.
    h.ops.last()?.exit(1);
    await tick();
    expect(h.supervisor.snapshot().state).toBe("crashed");
    expect(h.supervisor.snapshot().restartsInWindow).toBe(1);
  });
});

describe("the scrubber survives adoption", () => {
  test("a process-env secret stays scrubbed after a manager restart, on disk too", async () => {
    const dir = tempHarness("channel", "HARNESS_ONLY_TOKEN=harness-side-value-1234567890\n");
    // Lives ONLY in the manager's environment — never in the harness .env.
    // This is the common case for a manager-launched daemon, and it is what
    // used to stop being scrubbed the moment a manager restarted.
    const SECRET = ["PROC", "SIDE", "FIXTURE", "VALUE", "0987654321"].join("-");
    const clock = createFakeClock();
    const ops = createFakeProcessOps({ now: clock.now });
    const first = createHarnessSupervisor({
      harnessDir: dir,
      target: "channel",
      ops,
      clock,
      plan: () =>
        buildSpawnPlan({
          harnessDir: dir,
          target: "channel",
          processEnv: { SECRET_IN_PROCESSENV: SECRET },
        }),
      gate: allowGate,
      newRunId: () => "run_00000000000000d1",
    });
    expect((await first.start()).ok).toBe(true);
    ops
      .last()
      ?.writeLog(
        `${JSON.stringify({ kind: "tool_result", runId: "run_00000000000000d1", value: SECRET })}\n`,
      );
    first.pumpNow();

    const runId = "run_00000000000000d1";
    // Spawned run: scrubbed, and the runfile records the NAMES (never values).
    expect(readFileSync(runEventsPath(dir, runId), "utf8")).not.toContain(SECRET);
    const runfile = readRunfile(dir);
    expect(runfile?.scrubKeys).toContain("SECRET_IN_PROCESSENV");
    expect(JSON.stringify(runfile)).not.toContain(SECRET);
    first.close();

    // The manager restarts. Same machine, so the value is in ITS env too.
    process.env["SECRET_IN_PROCESSENV"] = SECRET;
    try {
      const second = createHarnessSupervisor({
        harnessDir: dir,
        target: "channel",
        ops,
        clock: createFakeClock(clock.now()),
        plan: () => buildSpawnPlan({ harnessDir: dir, target: "channel", processEnv: {} }),
        gate: allowGate,
      });
      expect(await second.adopt()).toBe("adopted");
      const seen: string[] = [];
      second.subscribe((event) => {
        if (event.type === "output") seen.push(event.prose, JSON.stringify(event.events));
      });
      ops
        .last()
        ?.writeLog(
          `${JSON.stringify({ kind: "tool_result", runId: "run_00000000000000d1", value: SECRET })}\nbye\n`,
        );
      second.pumpNow();

      // The live feed is still clean …
      expect(seen.join("")).not.toContain(SECRET);
      expect(seen.join("")).toContain("«SECRET_IN_PROCESSENV»");
      // … and so is the DURABLE events file, which is the part that used to
      // persist the credential in cleartext.
      expect(readFileSync(runEventsPath(dir, runId), "utf8")).not.toContain(SECRET);
      second.close();
    } finally {
      process.env["SECRET_IN_PROCESSENV"] = undefined;
    }
  });
});

// ---------------------------------------------------------------------------
// liveChild() — the enumeration seam manager shutdown decides fates with
// ---------------------------------------------------------------------------

describe("liveChild", () => {
  test("nothing is running, so there is nothing to shut down", async () => {
    const h = setup("channel");
    expect(h.supervisor.liveChild()).toBeUndefined();
    // …and it stays undefined once the run has ended.
    await h.supervisor.start();
    h.ops.last()?.exit(0);
    await tick();
    expect(h.supervisor.liveChild()).toBeUndefined();
  });

  test("a spawned daemon reports itself detached and re-adoptable", async () => {
    const h = setup("channel");
    await h.supervisor.start();
    const child = h.supervisor.liveChild();
    expect(child).toMatchObject({
      harnessDir: h.dir,
      target: "channel",
      kind: "daemon",
      state: "running",
      detached: true,
      reAdoptable: true,
      adopted: false,
    });
    expect(child?.pid).toBe(h.ops.last()?.pid as number);
    expect(child?.runId).toBe(h.supervisor.snapshot().runId as string);
  });

  test("an ATTACHED interactive run is neither detached nor re-adoptable", async () => {
    const h = setup("cli");
    await h.supervisor.start();
    expect(h.supervisor.liveChild()).toMatchObject({
      kind: "interactive",
      detached: false,
      reAdoptable: false,
    });
  });

  test("an ADOPTED daemon is detached and re-adoptable even with no plan of ours", async () => {
    const h = setup("channel");
    foreignDaemon(h, 9_100);
    expect(await h.supervisor.adopt()).toBe("adopted");
    expect(h.supervisor.liveChild()).toMatchObject({
      kind: "daemon",
      pid: 9_100,
      adopted: true,
      // No `currentPlan` exists for an adopted run; a runfile only ever
      // describes a detached daemon, so this is a fact, not a guess.
      detached: true,
      reAdoptable: true,
    });
  });

  test("a daemon whose runfile went missing is no longer re-adoptable", async () => {
    const h = setup("channel");
    await h.supervisor.start();
    expect(h.supervisor.liveChild()?.reAdoptable).toBe(true);
    // Nothing can find this daemon again — leaving it up at shutdown would
    // orphan it, so the fate has to flip.
    rmSync(join(runDir(h.dir), "daemon.json"));
    expect(h.supervisor.liveChild()?.reAdoptable).toBe(false);
  });

  test("reading it never signals, never adopts, and never writes", async () => {
    const h = setup("channel");
    await h.supervisor.start();
    const before = readRunfile(h.dir);
    for (let i = 0; i < 3; i += 1) h.supervisor.liveChild();
    expect(h.ops.last()?.signals).toEqual([]);
    expect(readRunfile(h.dir)).toEqual(before);
  });
});
