/**
 * The inspector's read model: a pure fold, content free, whose rows `loadRun` reads as it
 * reads the ledger's.
 */
import { describe, expect, test } from "bun:test";
import type { ResumeItem } from "@crewhaus/control-records";
import { NOW, SESSION, runId } from "./__fixtures__/build";
import {
  childrenFromModel,
  emptyInspectModel,
  foldInspectModel,
  foldSummary,
  loadedRunFromText,
  rowsFromModel,
  runsOfWork,
} from "./index";

const WI = "wi_01jd0000000000000000000000";

function items(rows: ReadonlyArray<Readonly<Record<string, unknown>>>): ResumeItem[] {
  return rows.map((record, i) => ({
    kind: "line",
    source: "runs",
    seg: 1,
    off: i * 100,
    record: { ...record },
    after: { seg: 1, off: (i + 1) * 100, tail: "" },
  })) as unknown as ResumeItem[];
}

const [parent, child, other, later] = [runId(1), runId(2), runId(3), runId(4)];
const ROWS = [
  { id: parent, state: "queued", at: "2026-11-14T11:00:00.000Z", trigger: { kind: "api" } },
  {
    id: parent,
    state: "running",
    at: "2026-11-14T11:00:01.000Z",
    session: SESSION,
    sessionAt: 0,
    execution: "run_00000000000000c1",
    workItem: WI,
  },
  {
    id: child,
    state: "running",
    parent,
    session: SESSION,
    sessionAt: 900,
    trigger: { kind: "cli" },
  },
  {
    id: other,
    state: "queued",
    workItem: WI,
    trigger: { kind: "heartbeat", lane: "hb", synthetic: true },
  },
  { id: parent, state: "failed", at: "2026-11-14T11:00:09.000Z", failureClass: "billing" },
  { id: later, state: "running", continues: parent, input: "never kept", by: "prn_x" },
  { id: "not-a-run", state: "running" },
];

function folded() {
  return items(ROWS).reduce(foldInspectModel, emptyInspectModel());
}

describe("the inspect read model", () => {
  test("folding the same ledger from empty twice gives equal states", () => {
    expect(folded()).toEqual(folded());
    expect(JSON.stringify(folded())).not.toContain("never kept");
    expect(JSON.stringify(folded())).not.toContain("prn_x");
    expect(Object.keys(folded().runs)).toEqual([parent, child, other, later]);
  });

  test("each run's skeleton, its children and its work item's runs match the rows", () => {
    const model = folded();
    expect(model.runs[parent]).toEqual({
      state: "failed",
      startedAt: "2026-11-14T11:00:00.000Z",
      endedAt: "2026-11-14T11:00:09.000Z",
      session: SESSION,
      sessionAt: 0,
      execution: "run_00000000000000c1",
      workItem: WI,
      failureClass: "billing",
      trigger: "api",
    });
    expect(model.runs[other]).toMatchObject({ trigger: "heartbeat", lane: "hb", synthetic: true });
    expect(childrenFromModel(model, parent)).toEqual([child]);
    expect(model.children).toEqual({ [parent]: [child] });
    expect(model.byWork).toEqual({ [WI]: [parent, other] });
    expect(runsOfWork(model, WI, 1)).toEqual([other]);
    expect(model.bySession).toEqual({ [SESSION]: [parent, child] });
  });

  test("its rows read as the ledger's: the run, its session's runs, and the run that continues it", () => {
    const model = folded();
    const rows = rowsFromModel(model, parent);
    expect([...(rows?.keys() ?? [])].sort()).toEqual([parent, child, later].sort());
    expect(rowsFromModel(model, runId(9))).toBeUndefined();
    const loaded = loadedRunFromText("", {
      now: NOW,
      session: SESSION,
      run: parent,
      rows: [...(rows?.values() ?? [])].flat(),
    });
    if (!loaded.ok) throw new Error(loaded.message);
    const summary = foldSummary(loaded);
    expect(summary.status.value).toMatchObject({ state: "failed", failureClass: "billing" });
    expect(summary.execution.value).toEqual({ id: "run_00000000000000c1" });
  });
});
