/**
 * The change lifecycle: every move the `change` machine allows applies, a move it
 * does not is refused and, written raw, folded as an anomaly; the effective state is
 * pure; and the watch after activation is read, then recorded only by a writer.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHANGE_STATES, type ChangeState, MACHINES, mintId } from "@crewhaus/control-contract";
import { type LedgerRecord, append, casAppend, deploymentsLedger } from "@crewhaus/control-records";
import { createChange, observeChanges } from "./adopt";
import { type CheckRunners, checkChange } from "./check";
import { deploymentViewOf, effectiveChangeState, watchOf } from "./lifecycle";
import { type ChangeRow, changesLedger, moveChange, readChange, readChanges } from "./store";
import { NOW, SPEC, allPass, fakeRunners, harness, removeTempDirs, run } from "./test-helpers";

afterAll(removeTempDirs);

const ACTOR = mintId("prn");

function rowIn(state: ChangeState, id = mintId("chg", { now: NOW })): ChangeRow {
  return {
    v: 1,
    id,
    state,
    at: new Date(NOW).toISOString(),
    kind: "spec",
    source: "manual",
    base: { revision: `sha256:${"a".repeat(64)}` },
    patchDigest: "b".repeat(64),
    contentRef: `.crewhaus/proposals/${id}`,
    touches: { surfaces: ["prompts"], protected: false, intent: false, security: false },
  };
}

/** The shortest legal path from an entry state to `to`. */
function pathTo(to: ChangeState): ChangeState[] {
  const machine = MACHINES.change;
  const queue: ChangeState[][] = (machine.entry as readonly ChangeState[]).map((e) => [e]);
  const seen = new Set<string>(machine.entry);
  while (queue.length > 0) {
    const path = queue.shift() as ChangeState[];
    const last = path[path.length - 1] as ChangeState;
    if (last === to) return path;
    for (const next of machine.transitions[last] as readonly ChangeState[]) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push([...path, next]);
    }
  }
  throw new Error(`no path to ${to}`);
}

/** A change moved, legally, to `state`. */
async function reach(
  dir: string,
  state: ChangeState,
  extra: Partial<ChangeRow> = {},
): Promise<string> {
  const id = mintId("chg", { now: NOW });
  const [entry, ...rest] = pathTo(state);
  await casAppend(changesLedger(dir), id, null, {
    ...rowIn(entry as ChangeState, id),
    ...extra,
  } as unknown as LedgerRecord);
  let from = entry as ChangeState;
  for (const next of rest) {
    const moved = await moveChange(dir, from, { ...rowIn(next, id), ...extra });
    if (!moved.ok) throw new Error(moved.reason);
    from = next;
  }
  return id;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

describe("the change machine", () => {
  const machine = MACHINES.change;

  test("is total over the states, with entry and terminal states as declared", () => {
    expect([...machine.states].sort()).toEqual([...CHANGE_STATES].sort());
    expect([...machine.entry]).toEqual(["proposed", "adopted"]);
    for (const state of machine.terminal) {
      expect(machine.transitions[state as ChangeState]).toEqual([]);
      expect(machine.recoveryOwner[state as ChangeState]).toBe("none");
    }
    expect(machine.recoveryOwner.checking).toBe("operator");
    expect(machine.recoveryOwner.adopted).toBe("operator");
  });

  test("every move the table allows applies through the compare-and-set", async () => {
    const dir = await harness();
    let moves = 0;
    for (const from of machine.states as readonly ChangeState[]) {
      for (const to of machine.transitions[from] as readonly ChangeState[]) {
        const id = await reach(dir, from);
        expect(readChange(dir, id)?.state).toBe(from);
        const moved = await moveChange(dir, from, { ...rowIn(to, id) });
        expect({ from, to, ok: moved.ok }).toEqual({ from, to, ok: true });
        moves++;
      }
    }
    expect(moves).toBe(
      Object.values(machine.transitions).reduce((n, to) => n + (to as readonly string[]).length, 0),
    );
  });

  test("a move the table does not allow is refused, and the change stays where it was", async () => {
    const dir = await harness();
    const refused: Array<[ChangeState, ChangeState]> = [
      ["proposed", "adopted"],
      ["proposed", "checked"],
      ["checking", "awaiting-decision"],
      ["checked", "adopted"],
      ["awaiting-decision", "kept"],
    ];
    for (const [from, to] of refused) {
      const id = await reach(dir, from);
      const moved = await moveChange(dir, from, rowIn(to, id));
      expect(moved.ok).toBe(false);
      if (!moved.ok) expect(moved.code).toBe("illegal");
      expect(readChange(dir, id)?.state).toBe(from);
    }
  });

  test("an illegal row written past the compare-and-set is folded as an anomaly, never dropped", async () => {
    const dir = await harness();
    const id = mintId("chg", { now: NOW });
    await casAppend(changesLedger(dir), id, null, rowIn("proposed", id) as unknown as LedgerRecord);
    append(changesLedger(dir), { ...rowIn("kept", id), gen: 2, claim: `gen/${id}/2` });
    const read = readChanges(dir);
    if (read.state !== "present") throw new Error(read.state);
    expect(read.rows.find((r) => r.id === id)?.state).toBe("proposed");
    expect(read.anomalies.some((a) => a.startsWith(id) && a.includes("proposed to kept"))).toBe(
      true,
    );
  });
});

describe("effectiveChangeState", () => {
  test("is pure: the same frozen inputs give the same answer and are not touched", () => {
    const awaiting = { ...rowIn("awaiting-decision"), decision: mintId("dec", { now: NOW }) };
    const adopted = {
      ...rowIn("adopted"),
      adoption: { specHash: `sha256:${"e".repeat(64)}`, revision: `sha256:${"e".repeat(64)}` },
    };
    const monitoring = { ...rowIn("monitoring"), until: new Date(NOW - 1).toISOString() };
    const rows = deepFreeze([awaiting, adopted, monitoring]);
    const deployments = deepFreeze([
      { id: mintId("dep", { now: NOW }), state: "active", specHash: adopted.adoption.specHash },
    ]);
    const decisions = deepFreeze([
      {
        id: awaiting.decision,
        kind: "change-adoption" as const,
        createdAt: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW + 1000).toISOString(),
        requiredClass: "maintainer" as const,
        subject: {
          chg: awaiting.id,
          patchDigest: "p",
          baseRevision: "r",
          evidenceDigest: "e",
        },
        bindingDigest: "b",
        proposedBy: ACTOR,
        state: "pending" as const,
      },
    ]);
    const a = effectiveChangeState(rows, deployments, decisions, NOW);
    const b = effectiveChangeState(rows, deployments, decisions, NOW);
    expect(a).toEqual(b);
    expect(a.map((e) => e.display)).toEqual([
      "ready to decide",
      "active, not yet recorded",
      "watch ended",
    ]);
    expect(a[1]?.activatedBy).toBe(deployments[0]?.id);
    expect(a[2]?.watchEnded).toBe(true);
  });
});

describe("the watch after activation", () => {
  test("a comparable run after activation that is worse than the base reads regressed", () => {
    const row = { ...rowIn("monitoring"), until: new Date(NOW + 3_600_000).toISOString() };
    const base = run("run_base", { a: "pass", b: "pass" });
    const worse = run("run_worse", { a: "pass", b: "fail" });
    const signal = watchOf(row, {
      base,
      runs: [
        { ts: new Date(NOW - 10).toISOString(), summary: base },
        { ts: new Date(NOW + 10).toISOString(), summary: worse },
      ],
      audit: [],
      activatedAt: new Date(NOW).toISOString(),
      now: NOW + 20,
    });
    expect(signal.signal).toBe("regressed");
    // A run from before activation does not count.
    expect(
      watchOf(row, {
        base,
        runs: [{ ts: new Date(NOW - 10).toISOString(), summary: worse }],
        audit: [],
        activatedAt: new Date(NOW).toISOString(),
        now: NOW + 20,
      }).signal,
    ).toBe("none");
  });

  test("an SLO rollback rung after activation is recorded as rolled back by sys:slo, by a writer", async () => {
    const dir = await harness();
    const created = await createChange({
      harnessDir: dir,
      kind: "spec",
      source: "manual",
      spec: "crewhaus.yaml",
      graders: "eval/graders.yaml",
      dataset: "registry:cases",
      baseText: SPEC,
      candidateText: SPEC.replace("Help the customer.", "Help the customer kindly."),
      actor: ACTOR,
      now: () => NOW,
      adopted: {},
    });
    if (!created.ok) throw new Error(created.reason);
    const specHash = created.row.adoption?.specHash as string;
    const dep = mintId("dep", { now: NOW });
    await casAppend(deploymentsLedger(dir), dep, null, {
      state: "prepared",
      artifact: { specHash },
    });
    await casAppend(deploymentsLedger(dir), dep, "prepared", {
      state: "active",
      artifact: { specHash },
      activatedAt: new Date(NOW).toISOString(),
    });
    const first = await observeChanges({ harnessDir: dir, now: () => NOW });
    expect(first.activated).toEqual([created.row.id]);
    expect(readChange(dir, created.row.id)?.state).toBe("monitoring");
    const second = await observeChanges({
      harnessDir: dir,
      now: () => NOW + 60_000,
      audit: [{ kind: "slo_mitigation", ts: NOW + 30_000, payload: { rung: "rollback" } }],
    });
    expect(second.rolledBack).toEqual([created.row.id]);
    const row = readChange(dir, created.row.id);
    expect(row?.state).toBe("rolled-back");
    expect(row?.actor).toBe("sys:slo");
    expect(row?.reason).toBe("slo-rollback");
  });

  test("a read past the watch's end says it ended and writes nothing; a writer records kept", async () => {
    const dir = await harness();
    const id = await reach(dir, "monitoring", { until: new Date(NOW).toISOString() });
    const file = join(dir, ".crewhaus", "run", "control", "changes.jsonl");
    const before = readFileSync(file);
    const read = readChanges(dir);
    if (read.state !== "present") throw new Error(read.state);
    const [e] = effectiveChangeState(read.rows, [], [], NOW + 1);
    expect(e?.display).toBe("watch ended");
    expect(readFileSync(file).equals(before)).toBe(true);
    const observed = await observeChanges({ harnessDir: dir, now: () => NOW + 1 });
    expect(observed.kept).toEqual([id]);
    expect(readChange(dir, id)?.state).toBe("kept");
  });
});

describe("deploymentViewOf", () => {
  test("reads the artifact's spec hash and ignores a record with no id", () => {
    expect(deploymentViewOf({ id: "dep_x", state: "active", artifact: { specHash: "h" } })).toEqual(
      {
        id: "dep_x",
        state: "active",
        specHash: "h",
      },
    );
    expect(deploymentViewOf({ state: "active" })).toBeUndefined();
  });
});

describe("a check that did not finish", () => {
  test("a writer that holds the lease moves an interrupted check to failed; without that, it stays", async () => {
    const dir = await harness();
    const id = await reach(dir, "checking");
    const left = await observeChanges({ harnessDir: dir, now: () => NOW });
    expect(left.failed).toEqual([]);
    expect(readChange(dir, id)?.state).toBe("checking");
    const moved = await observeChanges({
      harnessDir: dir,
      now: () => NOW,
      interruptedCheck: () => true,
    });
    expect(moved.failed).toEqual([id]);
    const row = readChange(dir, id);
    expect(row?.state).toBe("failed");
    expect(row?.actor).toBe("sys:reconcile");
  });

  test("a check this process is running is never taken for interrupted", async () => {
    const dir = await harness();
    const created = await createChange({
      harnessDir: dir,
      kind: "spec",
      source: "manual",
      spec: "crewhaus.yaml",
      graders: "eval/graders.yaml",
      dataset: "registry:cases",
      baseText: SPEC,
      candidateText: SPEC.replace("Help the customer.", "Help the customer kindly."),
      actor: ACTOR,
      now: () => NOW,
    });
    if (!created.ok) throw new Error(created.reason);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { runners } = fakeRunners((_l, a) => allPass(a));
    const slow: CheckRunners = {
      ...runners,
      evalSpec: async (args) => {
        started();
        await gate;
        return runners.evalSpec(args);
      },
    };
    const check = checkChange({
      harnessDir: dir,
      chg: created.row.id,
      runners: slow,
      actor: ACTOR,
      now: () => NOW,
    });
    await running;
    expect(readChange(dir, created.row.id)?.state).toBe("checking");
    const observed = await observeChanges({
      harnessDir: dir,
      now: () => NOW,
      interruptedCheck: () => true,
    });
    expect(observed.failed).toEqual([]);
    release();
    const done = await check;
    expect(done.ok).toBe(true);
  });

  test("an audit that cannot be read decides no watch", async () => {
    const dir = await harness();
    const id = await reach(dir, "monitoring", { until: new Date(NOW).toISOString() });
    const observed = await observeChanges({
      harnessDir: dir,
      now: () => NOW + 1,
      audit: "unreadable",
    });
    expect(observed.kept).toEqual([]);
    expect(readChange(dir, id)?.state).toBe("monitoring");
  });
});
