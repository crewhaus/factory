/**
 * The read models: the operator state a harness is shown in, folds that a pass at a time
 * agree with one fold from the start, a pass that writes only what moved, the fleet's
 * change log, a rebuild once a ledger no longer fits its cursor, and nudges.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { mintRunId } from "@crewhaus/control-contract";
import {
  type Heartbeat,
  type OperatorRead,
  _setRollBytesForTest,
  append,
  controlPaths,
  decisionsLedger,
  deploymentsLedger,
  fleetChangesLedger,
  readFleetState,
  resume,
  runsLedger,
  writeHeartbeat,
} from "@crewhaus/control-records";
import { approvalsLedger } from "@crewhaus/session-store";
import {
  COMMAND_STATE_EVENTS,
  DECISION_STATE_EVENTS,
  DEPLOYMENT_STATE_EVENTS,
  MACHINE_STATE_EVENTS,
  RUN_STATE_EVENTS,
} from "./event-map";
import {
  CORE_PROJECTIONS,
  FLEET_SEGMENTS_KEPT,
  OVERVIEW_PROJECTION,
  type OverviewState,
  RUNS_PROJECTION,
  type RunsState,
  directFold,
  harnessesOfRun,
  nudge,
  nudgeFromReceipt,
  operatorMoveOf,
  operatorStateOf,
  projectOnce,
  readModel,
  readProjection,
  servedOverview,
} from "./projector";
import { IDENTITY, fakeProbe, removeTempDirs, tempDir } from "./test-helpers";
import { wireControl } from "./wire";

afterAll(removeTempDirs);
afterEach(() => _setRollBytesForTest(undefined));

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const AT = new Date(NOW - 1000).toISOString();

/** The beat in the item-4 example: the daemon could not read its operator record. */
const UNREADABLE_BEAT: Heartbeat = {
  v: 1,
  pid: 4242,
  at: AT,
  operatorRev: null,
  paused: true,
  disabled: false,
  operatorUnreadable: true,
  activeRuns: null,
  runLedger: true,
};

const PRESENT_OPEN: OperatorRead = {
  state: "present",
  record: { v: 1, rev: 1, intake: null, deployment: null, desired: "running" },
};

describe("operatorStateOf", () => {
  test("a beat that could not read its operator record is unreadable, whatever else it says", () => {
    for (const operator of [{ state: "absent" } as const, PRESENT_OPEN, undefined]) {
      expect(operatorStateOf(UNREADABLE_BEAT, operator)).toBe("unreadable");
    }
  });

  test("the same beat with the record read is what it says, not unreadable", () => {
    expect(
      operatorStateOf({ ...UNREADABLE_BEAT, operatorUnreadable: false }, { state: "absent" }),
    ).toBe("paused");
  });

  test("an unreadable beat is never enabled, for any pause, rev or record", () => {
    for (const paused of [true, false]) {
      for (const operatorRev of [null, 1]) {
        for (const operator of [{ state: "absent" } as const, PRESENT_OPEN, undefined]) {
          const beat = { ...UNREADABLE_BEAT, paused, operatorRev, disabled: false };
          expect([paused, operatorRev, operator?.state, operatorStateOf(beat, operator)]).toEqual([
            paused,
            operatorRev,
            operator?.state,
            "unreadable",
          ]);
        }
      }
    }
  });

  test("the record decides when it is there; with none, the beat, else enabled; nothing read is unknown", () => {
    expect(operatorStateOf(undefined, { state: "unreadable", reason: "torn" })).toBe("unreadable");
    const record = (paused: boolean, disabled: boolean): OperatorRead => ({
      state: "present",
      record: {
        v: 1,
        rev: 2,
        intake: { paused },
        deployment: { disabled },
        desired: "running",
      },
    });
    expect(operatorStateOf(undefined, record(true, true))).toBe("disabled");
    expect(operatorStateOf(undefined, record(true, false))).toBe("paused");
    expect(operatorStateOf(undefined, record(false, false))).toBe("enabled");
    const quiet = { ...UNREADABLE_BEAT, operatorUnreadable: false, paused: false };
    expect(operatorStateOf({ ...quiet, disabled: true }, { state: "absent" })).toBe("disabled");
    expect(operatorStateOf(quiet, { state: "absent" })).toBe("enabled");
    expect(operatorStateOf(undefined, { state: "absent" })).toBe("enabled");
    expect(operatorStateOf(undefined, undefined)).toBe("unknown");
  });

  test("only moves among disabled, paused and enabled are harness events", () => {
    expect(operatorMoveOf("enabled", "paused")).toBe("harness.paused");
    expect(operatorMoveOf("paused", "enabled")).toBe("harness.resumed");
    expect(operatorMoveOf("paused", "disabled")).toBe("harness.disabled");
    expect(operatorMoveOf("disabled", "paused")).toBe("harness.enabled");
    expect(operatorMoveOf("enabled", "unreadable")).toBeUndefined();
    expect(operatorMoveOf("unknown", "enabled")).toBeUndefined();
    expect(operatorMoveOf("paused", "paused")).toBeUndefined();
  });
});

describe("the state-to-event tables", () => {
  test("every state of every machine names an event of the taxonomy", async () => {
    const { MACHINES, isEventType } = await import("@crewhaus/control-contract");
    for (const [machine, table] of Object.entries(MACHINE_STATE_EVENTS)) {
      const states = MACHINES[machine as keyof typeof MACHINES].states as readonly string[];
      expect([machine, Object.keys(table).sort()]).toEqual([machine, [...states].sort()]);
      for (const type of Object.values(table)) expect(isEventType(type)).toBe(true);
    }
    expect(RUN_STATE_EVENTS.running).toBe("run.started");
    expect(COMMAND_STATE_EVENTS.running).toBe("command.started");
    expect(DECISION_STATE_EVENTS.denied).toBe("decision.decided");
    expect(DEPLOYMENT_STATE_EVENTS.active).toBe("deployment.activated");
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let n = 0;
function harness(): { id: string; dir: string } {
  n += 1;
  const dir = tempDir("projector-harness-");
  mkdirSync(join(dir, ".crewhaus", "sessions"), { recursive: true });
  mkdirSync(join(dir, controlPaths(dir).controlDir), { recursive: true });
  return { id: `hrn_${String(n).padStart(16, "0")}`, dir };
}

function run(dir: string, id: string, state: string, more: Record<string, unknown> = {}): void {
  const written = append(runsLedger(dir), { id, state, at: AT, trigger: { kind: "api" }, ...more });
  if (!written.ok) throw new Error(written.reason);
}

function park(dir: string, decision: string, event = "park"): void {
  const ledger = approvalsLedger(join(dir, ".crewhaus", "sessions"));
  const written = append(ledger, { v: 1, at: AT, event, decision, sessionId: "sess_1" });
  if (!written.ok) throw new Error(written.reason);
}

function deploy(dir: string, id: string, state: string, more: Record<string, unknown> = {}): void {
  const written = append(deploymentsLedger(dir), { id, state, at: AT, ...more });
  if (!written.ok) throw new Error(written.reason);
}

function pause(dir: string, paused: boolean): void {
  writeFileSync(
    join(dir, controlPaths(dir).operatorFile),
    JSON.stringify({ v: 1, rev: 1, intake: { paused }, deployment: null, desired: "running" }),
  );
}

function fleetLines(root: string): Record<string, unknown>[] {
  return resume({ runs: fleetChangesLedger(root) }, undefined, {
    maxLines: 10_000,
    maxBytes: 1 << 24,
  }).items.flatMap((item) => (item.kind === "line" ? [item.record] : []));
}

/** Every file under a directory, with its bytes. */
function treeBytes(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string): void => {
    if (!existsSync(at)) return;
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.set(path, readFileSync(path, "latin1"));
    }
  };
  walk(dir);
  return out;
}

// ---------------------------------------------------------------------------

describe("the core folds", () => {
  test("a pass at a time agrees with one fold from the start, for every core projection", async () => {
    const root = tempDir();
    const h = harness();
    const a = mintRunId();
    const b = mintRunId();
    run(h.dir, a, "queued");
    park(h.dir, "appr_0000000000000001");
    await projectOnce({ hangarRoot: root, harnesses: [h], now: NOW });
    run(h.dir, a, "running", { execution: "run_00000000000000aa" });
    run(h.dir, b, "running");
    deploy(h.dir, "dep_00000000000000000000000001", "prepared", { artifact: { specHash: "s1" } });
    deploy(h.dir, "dep_00000000000000000000000001", "active", { activatedAt: AT });
    append(decisionsLedger(h.dir), { id: "dec_00000000000000000000000001", state: "pending" });
    await projectOnce({ hangarRoot: root, harnesses: [h], now: NOW });
    run(h.dir, a, "succeeded");
    park(h.dir, "appr_0000000000000001", "decide");
    park(h.dir, "appr_0000000000000002");
    await projectOnce({ hangarRoot: root, harnesses: [h], now: NOW });
    for (const projection of CORE_PROJECTIONS) {
      const saved = readProjection(root, h.id, projection.name);
      if (saved.state !== "present") throw new Error(`${projection.name}: ${saved.state}`);
      expect([projection.name, saved.file.state]).toEqual([
        projection.name,
        directFold(projection, h.dir, NOW).state,
      ]);
    }
    const overview = readProjection<OverviewState>(root, h.id, "overview");
    if (overview.state !== "present") throw new Error("no overview");
    expect(servedOverview(overview.file.state)).toEqual({
      activeDeployment: "dep_00000000000000000000000001",
      deployedSpecHash: "s1",
      runCounts: { succeeded: 1, running: 1 },
      lastRun: { id: a, state: "succeeded", at: AT },
      openDecisions: 2,
      operatorState: "enabled",
    });
    const runs = readProjection<RunsState>(root, h.id, "runs");
    if (runs.state !== "present") throw new Error("no runs");
    expect(runs.file.state.rows[a]).toMatchObject({ id: a, state: "succeeded" });
    expect("gen" in (runs.file.state.rows[a] ?? {})).toBe(false);
    expect(harnessesOfRun(root, a)).toEqual([h.id]);
  });

  test("a read folds what lies past the saved cursor, in memory, and writes nothing", async () => {
    const root = tempDir();
    const h = harness();
    const id = mintRunId();
    run(h.dir, id, "running");
    await projectOnce({ hangarRoot: root, harnesses: [h], now: NOW });
    run(h.dir, id, "cancelled");
    const before = treeBytes(root);
    const model = readModel(root, h.id, h.dir, RUNS_PROJECTION, NOW);
    expect(model).toMatchObject({ freshness: "projection", stale: false });
    expect(model.state.rows[id]?.["state"]).toBe("cancelled");
    expect(treeBytes(root)).toEqual(before);
    rmSync(join(root, "cache"), { recursive: true });
    const direct = readModel(root, h.id, h.dir, RUNS_PROJECTION, NOW);
    expect(direct.freshness).toBe("direct-fold");
    expect(direct.state).toEqual(model.state);
    expect(existsSync(join(root, "cache"))).toBe(false);
  });
});

describe("a pass", () => {
  test("an unchanged second pass writes no projection and appends no fleet line", async () => {
    const root = tempDir();
    const h = harness();
    run(h.dir, mintRunId(), "running");
    const first = await projectOnce({ hangarRoot: root, harnesses: [h], now: NOW });
    expect(first.written.sort()).toEqual([`${h.id}/overview`, `${h.id}/runs`]);
    expect(first.appended).toBe(0);
    const before = treeBytes(join(root, "cache"));
    const second = await projectOnce({ hangarRoot: root, harnesses: [h], now: NOW + 1000 });
    expect(second).toMatchObject({ written: [], appended: 0, failed: [] });
    expect(treeBytes(join(root, "cache"))).toEqual(before);
  });

  test("each change a pass observes is one fleet line, with a dense seq", async () => {
    const root = tempDir();
    const h = harness();
    const id = mintRunId();
    await projectOnce({ hangarRoot: root, harnesses: [h], now: NOW });
    expect(fleetLines(root)).toEqual([]);
    run(h.dir, id, "running");
    pause(h.dir, true);
    park(h.dir, "appr_0000000000000009");
    deploy(h.dir, "dep_00000000000000000000000002", "prepared");
    deploy(h.dir, "dep_00000000000000000000000002", "active", { activatedAt: AT });
    writeHeartbeat(h.dir, { ...UNREADABLE_BEAT, operatorUnreadable: false, at: AT });
    const report = await projectOnce({ hangarRoot: root, harnesses: [h], now: NOW });
    const lines = fleetLines(root);
    expect(report.appended).toBe(lines.length);
    expect(lines.map((line) => line["type"]).sort()).toEqual(
      [
        "decision.opened",
        "deployment.activated",
        "harness.heartbeat",
        "harness.paused",
        "run.started",
      ].sort(),
    );
    expect(lines.map((line) => line["seq"])).toEqual(lines.map((_, i) => i + 1));
    expect(lines.find((line) => line["type"] === "run.started")).toMatchObject({
      harness: h.id,
      run: id,
      payload: { state: "running" },
      sensitivity: "internal",
    });
    expect(lines.find((line) => line["type"] === "harness.paused")?.["payload"]).toEqual({
      operatorState: "paused",
    });
    // Contact turns stale with time alone: one line, and only once.
    await projectOnce({ hangarRoot: root, harnesses: [h], now: NOW + 60_000 });
    await projectOnce({ hangarRoot: root, harnesses: [h], now: NOW + 70_000 });
    expect(fleetLines(root).filter((l) => l["type"] === "harness.heartbeat")).toHaveLength(2);
    pause(h.dir, false);
    park(h.dir, "appr_0000000000000009", "decide");
    await projectOnce({ hangarRoot: root, harnesses: [h], now: NOW + 70_000 });
    expect(
      fleetLines(root)
        .slice(-2)
        .map((l) => l["type"])
        .sort(),
    ).toEqual(["decision.decided", "harness.resumed"]);
  });

  test("an operator record that cannot be read is shown as unreadable, and logs no harness move", async () => {
    const root = tempDir();
    const h = harness();
    await projectOnce({ hangarRoot: root, harnesses: [h], now: NOW });
    writeFileSync(join(h.dir, controlPaths(h.dir).operatorFile), "torn");
    await projectOnce({ hangarRoot: root, harnesses: [h], now: NOW });
    const overview = readProjection<OverviewState>(root, h.id, "overview");
    expect(overview.state === "present" && overview.file.state.operatorState).toBe("unreadable");
    expect(fleetLines(root)).toEqual([]);
  });

  test("a ledger that no longer fits its cursor rebuilds its projections from the start", async () => {
    const root = tempDir();
    const h = harness();
    const id = mintRunId();
    run(h.dir, id, "running");
    await projectOnce({ hangarRoot: root, harnesses: [h], now: NOW });
    // The run ledger is replaced under the saved cursor.
    const seg = join(h.dir, controlPaths(h.dir).runsDir, "000001.jsonl");
    const other = mintRunId();
    writeFileSync(seg, `${JSON.stringify({ id: other, state: "queued", at: AT })}\n`);
    const report = await projectOnce({ hangarRoot: root, harnesses: [h], now: NOW });
    expect(report.rebuilt.sort()).toEqual([`${h.id}/overview`, `${h.id}/runs`]);
    const runs = readProjection<RunsState>(root, h.id, "runs");
    expect(runs.state === "present" && Object.keys(runs.file.state.rows)).toEqual([other]);
  });

  test("nudged harnesses go first, in this process and from a marker, each taken once", async () => {
    const root = tempDir();
    const [a, b, c] = [harness(), harness(), harness()];
    const all = [a, b, c] as const;
    nudge("overview", c.id);
    nudgeFromReceipt(root, `${b.id}/run/${mintRunId()}`, () => undefined);
    const first = await projectOnce({ hangarRoot: root, harnesses: all, now: NOW });
    expect(first.order.slice(0, 2).sort()).toEqual([b.id, c.id].sort());
    expect(first.order[2]).toBe(a.id);
    const second = await projectOnce({ hangarRoot: root, harnesses: all, now: NOW });
    expect(second.order).toEqual([a.id, b.id, c.id]);
  });

  test("the fleet log keeps its newest segments", async () => {
    _setRollBytesForTest(1);
    const root = tempDir();
    const h = harness();
    await projectOnce({ hangarRoot: root, harnesses: [h], now: NOW });
    for (let i = 0; i < FLEET_SEGMENTS_KEPT + 3; i++) {
      run(h.dir, mintRunId(), "running");
      await projectOnce({ hangarRoot: root, harnesses: [h], now: NOW });
    }
    const dir = join(root, "cache", "index", "fleet-changes");
    const segs = readdirSync(dir).filter((name) => /^\d{6}\.jsonl$/.test(name));
    expect(segs).toHaveLength(FLEET_SEGMENTS_KEPT);
    expect(readFleetState(root)).toMatchObject({
      state: "present",
      fleet: { seq: FLEET_SEGMENTS_KEPT + 3 },
    });
  });

  test("projection files are 0600 and a GET-like read creates none", async () => {
    const root = tempDir();
    const h = harness();
    directFold(OVERVIEW_PROJECTION, h.dir, NOW);
    readModel(root, h.id, h.dir, OVERVIEW_PROJECTION, NOW);
    expect(existsSync(join(root, "cache"))).toBe(false);
    await projectOnce({ hangarRoot: root, harnesses: [h], now: NOW });
    const file = join(root, "cache", "index", h.id, "overview.json");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("the CLI's command path tells Home", () => {
  test("a receipt written to a harness's ledger in direct mode leaves a nudge for it", async () => {
    const root = tempDir();
    const h = harness();
    const control = wireControl(
      {
        hangarRoot: root,
        supervisorFor: () => undefined,
        drainRequest: () => async () => undefined,
        identity: IDENTITY,
        probe: fakeProbe(),
      },
      { mode: "direct" },
    );
    const answer = await control.commands.submit(
      {
        kind: "controls.pause",
        target: `home/harness/${h.id}`,
        ledger: { harness: h.dir },
        via: "cli",
      },
      async () => ({ settle: { state: "succeeded" }, value: undefined }),
    );
    expect(answer.ok).toBe(true);
    expect(existsSync(join(root, "cache", "index", "overview", `nudge-${h.id}`))).toBe(true);
    const order = await projectOnce({
      hangarRoot: root,
      harnesses: [harness(), h],
      now: NOW,
    });
    expect(order.order[0]).toBe(h.id);
  });

  test("with no Home on the machine there is no one to tell: nothing is written or said", () => {
    const root = join(tempDir(), "no-home-here");
    const warned: string[] = [];
    nudgeFromReceipt(root, "home/harness/hrn_0123456789abcdef", (m) => warned.push(m));
    expect(warned).toEqual([]);
    expect(existsSync(root)).toBe(false);
  });

  test("a marker that cannot be written is warned about, and nothing throws", () => {
    const root = tempDir();
    writeFileSync(join(root, "cache"), "not a directory");
    const warned: string[] = [];
    nudgeFromReceipt(root, "home/harness/hrn_0123456789abcdef", (m) => warned.push(m));
    expect(warned).toHaveLength(1);
    nudgeFromReceipt(root, "home/cmd/cmd_x", (m) => warned.push(m));
    expect(warned).toHaveLength(1);
  });
});
