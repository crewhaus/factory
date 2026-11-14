/**
 * The operator record and the supervisor: a harness its operator disabled is not started,
 * restarted or restarted after adoption, whatever build it runs, and a person's start or
 * stop is written down for the recovery that runs after a reboot.
 *
 * Every harness here carries a bundle that never reads `operator.json` (it only sleeps),
 * and the process ops are fakes, so a refusal can only be the supervisor's own.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPrepareRunner } from "./prepare";
import { readRunfile } from "./runfiles";
import { buildSpawnPlan } from "./spawn-contracts";
import { type SupervisorOptions, createHarnessSupervisor } from "./supervisor";
import {
  type FakeClock,
  activateBuildForTest,
  createFakeClock,
  createFakeProcessOps,
} from "./testkit";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A bundle that never reads the operator record: it only sleeps. */
const SLEEPING_BUNDLE = "await new Promise((resolve) => setTimeout(resolve, 2 ** 31 - 1));\n";

function put(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

function harness(): string {
  const dir = mkdtempSync(join(tmpdir(), "chsup-operator-"));
  roots.push(dir);
  put(dir, "crewhaus.yaml", "name: demo\ntarget: channel\n");
  put(dir, "dist/daemon.ts", SLEEPING_BUNDLE);
  activateBuildForTest(dir, "dist/daemon.ts");
  return dir;
}

const OPERATOR = join(".crewhaus", "run", "control", "operator.json");

function operator(dir: string, body: Record<string, unknown>): void {
  put(dir, OPERATOR, `${JSON.stringify({ v: 1, rev: 1, desired: "running", ...body })}\n`);
}

const DISABLED = {
  deployment: { disabled: true, since: "2026-11-13T00:00:00.000Z", by: "prn_a", cmd: "cmd_x" },
};
const PAUSED = {
  intake: { paused: true, since: "2026-11-13T00:00:00.000Z", by: "prn_a", cmd: "cmd_y" },
};

type Recorded = {
  readonly desired: "running" | "stopped";
  readonly children: number;
  readonly signals: number;
  readonly drains: number;
};

function supervise(
  dir: string,
  options: {
    readonly clock?: FakeClock;
    readonly ops?: ReturnType<typeof createFakeProcessOps>;
    readonly ownerPid?: number;
    readonly recordAnswer?: boolean;
    readonly withRecord?: boolean;
    /** Runs inside the record write, as the write waits on the control lock. */
    readonly whileRecording?: (
      desired: "running" | "stopped",
      ops: ReturnType<typeof createFakeProcessOps>,
    ) => void;
  } = {},
) {
  const clock = options.clock ?? createFakeClock();
  const ops = options.ops ?? createFakeProcessOps({ now: clock.now });
  let plans = 0;
  let terminates = 0;
  let seq = 0;
  const drains = { count: 0 };
  const recorded: Recorded[] = [];
  const warnings: string[] = [];
  const recordDesired: SupervisorOptions["recordDesired"] = async (desired) => {
    const live = ops.children.find((child) => child.alive);
    recorded.push({
      desired,
      children: ops.children.length,
      signals: live?.signals.length ?? 0,
      drains: drains.count,
    });
    options.whileRecording?.(desired, ops);
    return { ok: options.recordAnswer ?? true };
  };
  const supervisor = createHarnessSupervisor({
    harnessDir: dir,
    target: "channel",
    ops: {
      ...ops,
      terminate: (pid) => {
        terminates += 1;
        ops.terminate(pid);
      },
    },
    clock,
    plan: () => {
      plans += 1;
      return buildSpawnPlan({
        harnessDir: dir,
        target: "channel",
        processEnv: {},
        ports: { port: 3000, controlPort: 3001 },
      });
    },
    managerVersion: "0.9.0-test",
    newRunId: () => `run_${String(++seq).padStart(16, "0")}`,
    warn: (line) => warnings.push(line),
    ...(options.ownerPid !== undefined ? { ownerPid: options.ownerPid } : {}),
    ...(options.withRecord === false ? {} : { recordDesired }),
  });
  return {
    clock,
    ops,
    supervisor,
    recorded,
    warnings,
    drains,
    plans: () => plans,
    terminates: () => terminates,
  };
}

describe("a disabled harness is not started", () => {
  test("start refuses, plans nothing and spawns nothing", async () => {
    const dir = harness();
    operator(dir, DISABLED);
    const h = supervise(dir);
    const result = await h.supervisor.start();
    expect(result).toMatchObject({
      ok: false,
      reason: "disabled",
      exitName: "disabled",
      cause: "disabled",
    });
    if (result.ok || result.reason !== "disabled") throw new Error("unreachable");
    expect(result.message).toContain("crewhaus daemon enable");
    expect(result.kept).toBeUndefined();
    expect(h.ops.children).toEqual([]);
    expect(h.plans()).toBe(0);
    expect(readRunfile(dir)).toBeUndefined();
    expect(h.recorded).toEqual([]);
  });

  test("a restart while the daemon runs is refused before the stop, and the daemon keeps running", async () => {
    const dir = harness();
    const h = supervise(dir);
    expect(await h.supervisor.start()).toMatchObject({ ok: true });
    const runfile = readFileSync(join(dir, ".crewhaus", "run", "daemon.json"), "utf8");
    operator(dir, DISABLED);
    const result = await h.supervisor.restart();
    expect(result).toMatchObject({
      ok: false,
      reason: "disabled",
      exitName: "disabled",
      kept: true,
    });
    expect(h.terminates()).toBe(0);
    expect(h.ops.last()?.signals).toEqual([]);
    expect(h.ops.last()?.alive).toBe(true);
    expect(h.ops.children).toHaveLength(1);
    expect(h.supervisor.snapshot().state).toBe("running");
    expect(readFileSync(join(dir, ".crewhaus", "run", "daemon.json"), "utf8")).toBe(runfile);
  });

  test("a restart of a daemon another manager started is refused after adoption, and it keeps running", async () => {
    const dir = harness();
    const clock = createFakeClock();
    const ops = createFakeProcessOps({ now: clock.now });
    const first = supervise(dir, { clock, ops, ownerPid: 1001 });
    expect(await first.supervisor.start()).toMatchObject({ ok: true });
    first.supervisor.close();
    operator(dir, DISABLED);
    const second = supervise(dir, { clock, ops, ownerPid: 1002 });
    const result = await second.supervisor.restart();
    expect(second.supervisor.snapshot().adopted).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      reason: "disabled",
      exitName: "disabled",
      kept: true,
    });
    expect(second.terminates()).toBe(0);
    expect(ops.children).toHaveLength(1);
    expect(ops.last()?.signals).toEqual([]);
    expect(ops.last()?.alive).toBe(true);
    second.supervisor.close();
  });

  test("a restart with no daemon running is refused by its start, with nothing kept", async () => {
    const dir = harness();
    operator(dir, DISABLED);
    const h = supervise(dir);
    const result = await h.supervisor.restart();
    expect(result).toMatchObject({ ok: false, reason: "disabled" });
    if (result.ok) throw new Error("unreachable");
    expect(result.kept).toBeUndefined();
    expect(h.ops.children).toEqual([]);
  });

  test("a pause alone refuses no start", async () => {
    const dir = harness();
    operator(dir, PAUSED);
    const h = supervise(dir);
    expect(await h.supervisor.start()).toMatchObject({ ok: true });
    expect(h.ops.children).toHaveLength(1);
  });

  test("a record that cannot be read refuses the start and names why", async () => {
    const dir = harness();
    put(dir, OPERATOR, "{ torn");
    const h = supervise(dir);
    const result = await h.supervisor.start();
    expect(result).toMatchObject({ ok: false, reason: "disabled", cause: "unreadable" });
    if (result.ok || result.reason !== "disabled") throw new Error("unreachable");
    expect(result.message).toContain("can't be read");
    expect(result.message).toContain("operator.json");
    expect(h.ops.children).toEqual([]);
  });

  test("a crash while disabled is not restarted, and no timer is left armed", async () => {
    const dir = harness();
    const h = supervise(dir);
    expect(await h.supervisor.start()).toMatchObject({ ok: true });
    operator(dir, DISABLED);
    h.ops.last()?.exit(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(h.supervisor.snapshot().state).toBe("crashed");
    h.clock.advance(60_000);
    await h.supervisor.idle();
    expect(h.ops.children).toHaveLength(1);
    expect(h.clock.pendingCount()).toBe(0);
    const snap = h.supervisor.snapshot();
    expect(snap.state).toBe("stopped");
    expect(snap.lastExit?.title).toBe("disabled by its operator; not restarted");
  });

  test("the same crash with the harness enabled is restarted", async () => {
    const dir = harness();
    const h = supervise(dir);
    expect(await h.supervisor.start()).toMatchObject({ ok: true });
    h.ops.last()?.exit(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    h.clock.advance(60_000);
    await h.supervisor.idle();
    expect(h.ops.children).toHaveLength(2);
  });
});

describe("what the operator asked for is recorded", () => {
  test("a person's start records running after the spawn; an automatic restart records nothing", async () => {
    const dir = harness();
    const h = supervise(dir);
    const started = await h.supervisor.start();
    expect(started).toMatchObject({ ok: true, desired: "recorded" });
    expect(h.recorded).toEqual([{ desired: "running", children: 1, signals: 0, drains: 0 }]);
    h.ops.last()?.exit(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    h.clock.advance(60_000);
    await h.supervisor.idle();
    expect(h.ops.children).toHaveLength(2);
    expect(h.recorded.map((r) => r.desired)).toEqual(["running"]);
  });

  test("a restart records running only", async () => {
    const dir = harness();
    const h = supervise(dir);
    await h.supervisor.start();
    h.recorded.length = 0;
    expect(await h.supervisor.restart()).toMatchObject({ ok: true, desired: "recorded" });
    expect(h.recorded.map((r) => r.desired)).toEqual(["running"]);
  });

  test("a stop records stopped before anything is signalled", async () => {
    const dir = harness();
    const h = supervise(dir);
    await h.supervisor.start();
    h.recorded.length = 0;
    expect(await h.supervisor.stop()).toMatchObject({ stopped: true, desired: "recorded" });
    expect(h.recorded).toEqual([{ desired: "stopped", children: 1, signals: 0, drains: 0 }]);
    expect(h.ops.last()?.signals).toEqual(["SIGTERM"]);
  });

  test("a drain records stopped before the control call", async () => {
    const dir = harness();
    const h = supervise(dir);
    await h.supervisor.start();
    h.recorded.length = 0;
    const result = await h.supervisor.drain(async () => {
      h.drains.count += 1;
      h.ops.last()?.exit(0);
    });
    expect(result).toMatchObject({ stopped: true, desired: "recorded" });
    expect(h.recorded).toEqual([{ desired: "stopped", children: 1, signals: 0, drains: 0 }]);
    expect(h.drains.count).toBe(1);
  });

  test("a drain whose control call fails stops by signal and records stopped once", async () => {
    const dir = harness();
    const h = supervise(dir);
    await h.supervisor.start();
    h.recorded.length = 0;
    const result = await h.supervisor.drain(async () => {
      throw new Error("no control port");
    });
    expect(result).toMatchObject({ stopped: true, desired: "recorded" });
    expect(h.ops.last()?.signals).toEqual(["SIGTERM"]);
    expect(h.recorded.map((r) => r.desired)).toEqual(["stopped"]);
  });

  test("a stop of a harness that is not running records stopped", async () => {
    const dir = harness();
    const h = supervise(dir);
    expect(await h.supervisor.stop()).toMatchObject({ stopped: true, desired: "recorded" });
    expect(h.recorded.map((r) => r.desired)).toEqual(["stopped"]);
  });

  test("a stop that reached no daemon records nothing", async () => {
    const dir = harness();
    const clock = createFakeClock();
    const ops = createFakeProcessOps({ now: clock.now });
    const first = supervise(dir, { clock, ops, ownerPid: 1001, withRecord: false });
    await first.supervisor.start();
    first.supervisor.close();
    const second = supervise(dir, { clock, ops, ownerPid: 1002 });
    const stop = await second.supervisor.stop();
    expect(stop).toMatchObject({ stopped: false, reason: "not-adopted" });
    expect(stop.desired).toBeUndefined();
    const drain = await second.supervisor.drain(async () => undefined);
    expect(drain).toMatchObject({ stopped: false, reason: "not-adopted" });
    expect(second.recorded).toEqual([]);
    expect(ops.last()?.signals).toEqual([]);
  });

  test("a daemon that exits while a stop's record is written stays stopped", async () => {
    const dir = harness();
    const h = supervise(dir, {
      whileRecording: (desired, ops) => {
        if (desired === "stopped") ops.last()?.exit(1);
      },
    });
    await h.supervisor.start();
    expect(await h.supervisor.stop()).toMatchObject({ stopped: true, desired: "recorded" });
    expect(h.supervisor.snapshot().state).toBe("stopped");
    expect(h.clock.pendingCount()).toBe(0);
    h.clock.advance(120_000);
    await h.supervisor.idle();
    expect(h.ops.children).toHaveLength(1);
    expect(h.supervisor.snapshot().state).toBe("stopped");
  });

  test("a daemon that exits while a drain's record is written stays stopped", async () => {
    const dir = harness();
    const h = supervise(dir, {
      whileRecording: (desired, ops) => {
        if (desired === "stopped") ops.last()?.exit(1);
      },
    });
    await h.supervisor.start();
    const result = await h.supervisor.drain(async () => {
      h.drains.count += 1;
    });
    expect(result).toMatchObject({ stopped: true, desired: "recorded" });
    expect(h.drains.count).toBe(0);
    expect(h.supervisor.snapshot().state).toBe("stopped");
    expect(h.clock.pendingCount()).toBe(0);
    h.clock.advance(120_000);
    await h.supervisor.idle();
    expect(h.ops.children).toHaveLength(1);
    expect(h.supervisor.snapshot().state).toBe("stopped");
  });

  test("a record that cannot be written never blocks the start, and says so once", async () => {
    const dir = harness();
    const h = supervise(dir, { recordAnswer: false });
    const started = await h.supervisor.start();
    expect(started).toMatchObject({ ok: true, desired: "not-recorded" });
    expect(h.ops.children).toHaveLength(1);
    expect(h.warnings.filter((line) => line.includes("operator record"))).toHaveLength(1);
    expect(await h.supervisor.stop()).toMatchObject({ stopped: true, desired: "not-recorded" });
  });

  test("without the seam, nothing is recorded and the answers carry no desired", async () => {
    const dir = harness();
    const h = supervise(dir, { withRecord: false });
    const started = await h.supervisor.start();
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("unreachable");
    expect(started.desired).toBeUndefined();
    expect((await h.supervisor.stop()).desired).toBeUndefined();
  });
});

describe("a disabled harness runs no compile, no hook and no daemon", () => {
  const SETTINGS = {
    manager: {
      autoCompile: true,
      hooks: { postCompile: "./patch.ts", preSpawn: ["bun", "run", "warm.ts"] },
    },
  };

  /** A supervisor whose prepare steps spawn through `prepOps`, each child exiting 0. */
  function prepared(
    dir: string,
    prepare?: SupervisorOptions["prepare"],
    onPrepSpawn?: (argv: readonly string[]) => void,
  ) {
    const clock = createFakeClock();
    const ops = createFakeProcessOps({ now: clock.now });
    const raw = createFakeProcessOps();
    const prepSpawns: string[][] = [];
    const prepOps = {
      ...raw,
      spawn: (request: Parameters<typeof raw.spawn>[0]) => {
        prepSpawns.push([...request.argv]);
        onPrepSpawn?.(request.argv);
        const spawned = raw.spawn(request);
        raw.last()?.exit(0);
        return spawned;
      },
    };
    const supervisor = createHarnessSupervisor({
      harnessDir: dir,
      target: "channel",
      ops,
      clock,
      plan: () =>
        buildSpawnPlan({
          harnessDir: dir,
          target: "channel",
          processEnv: {},
          ports: { port: 3000, controlPort: 3001 },
        }),
      managerVersion: "0.9.0-test",
      prepare:
        prepare ??
        (() =>
          createPrepareRunner({
            harnessDir: dir,
            target: "channel",
            ops: prepOps,
            env: {},
            crewhausBin: "/bin/crewhaus",
          })),
    });
    return { ops, prepOps, prepSpawns, supervisor };
  }

  test("autoCompile and hooks on, a stale build: start and restart run no compile and no hook", async () => {
    const dir = harness();
    put(dir, ".crewhaus/settings.json", JSON.stringify(SETTINGS));
    put(dir, "patch.ts", "// a hook\n");
    const h = prepared(dir);
    expect(await h.supervisor.start()).toMatchObject({ ok: true });
    const spawnsWhileEnabled = h.prepSpawns.length;
    expect(spawnsWhileEnabled).toBeGreaterThan(0);
    operator(dir, DISABLED);
    // The active build changes on disk, so an enabled start would compile it.
    put(dir, "dist/daemon.ts", "// changed by hand\n");
    const restarted = await h.supervisor.restart();
    expect(restarted).toMatchObject({ ok: false, reason: "disabled", kept: true });
    expect(h.prepSpawns).toHaveLength(spawnsWhileEnabled);
    expect(h.ops.children).toHaveLength(1);
    expect(h.ops.last()?.signals).toEqual([]);

    const cold = harness();
    put(cold, ".crewhaus/settings.json", JSON.stringify(SETTINGS));
    put(cold, "patch.ts", "// a hook\n");
    put(cold, "dist/daemon.ts", "// changed by hand\n");
    operator(cold, DISABLED);
    const c = prepared(cold);
    expect(await c.supervisor.start()).toMatchObject({ ok: false, reason: "disabled" });
    expect(c.prepSpawns).toEqual([]);
    expect(c.ops.children).toEqual([]);
    h.supervisor.close();
    c.supervisor.close();
  });

  test("a disable written while a start prepares refuses it before its preSpawn hook or any daemon", async () => {
    const dir = harness();
    const preSpawnCalls: string[] = [];
    const h = prepared(dir, () => ({
      prepare: async () => {
        operator(dir, DISABLED);
        return { ok: true, replan: false, notes: [] };
      },
      preSpawn: async () => {
        preSpawnCalls.push("preSpawn");
        return { ok: true, replan: false, notes: [] };
      },
      forecast: () => ({ compileMayRun: true, activeOnly: false }),
      configured: { compile: true, compileMode: "explicit", hooks: [] },
    }));
    const result = await h.supervisor.start();
    expect(result).toMatchObject({ ok: false, reason: "disabled", exitName: "disabled" });
    if (result.ok || result.reason !== "disabled") throw new Error("unreachable");
    expect(result.message).toContain("crewhaus daemon enable");
    expect(preSpawnCalls).toEqual([]);
    expect(h.ops.children).toEqual([]);
    expect(readRunfile(dir)).toBeUndefined();
    expect(h.supervisor.snapshot().state).toBe("stopped");
    // The start slot was released: once enabled, the next start runs.
    operator(dir, {});
    const h2 = prepared(dir);
    expect(await h2.supervisor.start()).toMatchObject({ ok: true });
    h.supervisor.close();
    h2.supervisor.close();
  });

  test("a disable written while a start compiles refuses it before its postCompile and preSpawn hooks", async () => {
    const dir = harness();
    put(dir, ".crewhaus/settings.json", JSON.stringify(SETTINGS));
    put(dir, "patch.ts", "// a hook\n");
    // The spec is newer than the bundle, so the explicit compile runs.
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, "crewhaus.yaml"), later, later);
    const h = prepared(
      dir,
      () =>
        createPrepareRunner({
          harnessDir: dir,
          target: "channel",
          ops: h.prepOps,
          env: {},
          crewhausBin: "/bin/crewhaus",
          compile: true,
        }),
      (argv) => {
        if (argv.includes("compile")) operator(dir, DISABLED);
      },
    );
    const result = await h.supervisor.start();
    expect(result).toMatchObject({ ok: false, reason: "disabled", exitName: "disabled" });
    // The compile ran (it was started while enabled); no hook and no daemon after it.
    expect(h.prepSpawns.length).toBe(1);
    expect(h.prepSpawns[0]).toContain("compile");
    expect(h.ops.children).toEqual([]);
    expect(h.supervisor.snapshot().state).toBe("stopped");
    h.supervisor.close();
  });
});
