/**
 * The operator record and the supervisor: a harness its operator disabled is not started,
 * restarted or restarted after adoption, whatever build it runs, and a person's start or
 * stop is written down for the recovery that runs after a reboot.
 *
 * Every harness here carries a bundle that never reads `operator.json` (it only sleeps),
 * and the process ops are fakes, so a refusal can only be the supervisor's own.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
