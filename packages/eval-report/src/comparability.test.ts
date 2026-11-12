import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import { type CaseDigests, comparability, readCaseDigests } from "./comparability";
import type { BaselineEntry, RunIndexEntry } from "./history";
import { runState, staleness } from "./run-state";

const TMP: string[] = [];
afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});

function s(
  id: string,
  passed: boolean,
  overall: Partial<SampleResult["grades"]["overall"]> = {},
  perGrader?: SampleResult["grades"]["perGrader"],
  extra: Partial<SampleResult> = {},
): SampleResult {
  return {
    sampleId: id,
    sessionId: "sess_0000000000000000",
    startedAt: "t",
    endedAt: "t",
    latencyMs: 1,
    turns: 1,
    tokens: { input: 0, output: 0 },
    model: "m",
    agentOutput: "x",
    grades: {
      overall: { passed, score: passed ? 1 : 0, rationale: "", ...overall },
      perGrader: perGrader ?? [{ name: "g", passed, score: passed ? 1 : 0, rationale: "" }],
    },
    ...extra,
  };
}
const notMeasured = (id: string) =>
  s(id, false, { status: "not_measured", statusReason: "no_proof_bundle" });

function summary(
  samples: SampleResult[],
  config: Partial<EvalRunSummary["config"]> = {},
  extra: Partial<EvalRunSummary> = {},
): EvalRunSummary {
  return {
    runId: "run_x",
    startedAt: "t",
    endedAt: "t",
    samples,
    aggregates: {
      passRate: 1,
      meanScore: 1,
      p50Turns: 1,
      p95Turns: 1,
      p50LatencyMs: 1,
      p95LatencyMs: 1,
      totalTokens: { input: 0, output: 0 },
      errorCount: 0,
    },
    config: {
      specHash: "s",
      datasetName: "d",
      graderNames: [],
      model: "m",
      concurrency: 1,
      ...config,
    },
    outDir: "/x",
    ...extra,
  };
}

const pin = (datasetHash = "h1"): BaselineEntry => ({
  specName: "spec",
  datasetName: "d",
  runId: "run_base",
  outDir: "/base",
  datasetHash,
  ts: "t",
});
const entry = (datasetHash = "h1"): RunIndexEntry => ({
  runId: "run_new",
  specName: "spec",
  specHash: "s",
  datasetName: "d",
  datasetHash,
  passRate: 1,
  meanScore: 1,
  sampleCount: 1,
  ts: "t",
  outDir: "/new",
});
const cases = (digests: Record<string, string>): CaseDigests => ({ version: 1, digests });

describe("comparability — each rule, in order", () => {
  const base = summary([s("a", true), s("b", true)]);

  test("partial comes first", () => {
    const run = summary(
      [s("a", true), s("b", false)],
      {},
      {
        partial: {
          reason: "budget_exhausted",
          completedSamples: 1,
          totalSamples: 2,
          spentUsd: 1,
          budgetUsd: 1,
        },
      },
    );
    expect(comparability({ pin: pin() }, { entry: entry(), summary: run })).toMatchObject({
      comparable: false,
      rule: "partial",
    });
  });

  test("a run that measured nothing — every case not measured, or errored", () => {
    for (const samples of [
      [notMeasured("a"), notMeasured("b")],
      [s("a", false, {}, undefined, { error: "x" })],
    ]) {
      const result = comparability(
        { pin: pin(), summary: base },
        { entry: entry(), summary: summary(samples) },
      );
      expect(result).toMatchObject({ comparable: false, rule: "nothing_measured" });
    }
  });

  test("an unreadable baseline", () => {
    expect(
      comparability({ pin: pin() }, { entry: entry(), summary: summary([s("a", true)]) }),
    ).toMatchObject({ comparable: false, rule: "baseline_unreadable" });
  });

  test("a changed instrument lists its changes; an unverified field alone does not", () => {
    const result = comparability(
      { pin: pin(), summary: summary(base.samples, { gradersHash: "g1" }) },
      { entry: entry(), summary: summary(base.samples, { gradersHash: "g2" }) },
    );
    expect(result).toMatchObject({
      comparable: false,
      rule: "instrument",
      changes: [{ field: "gradersHash", from: "g1", to: "g2" }],
    });
    const oneSided = comparability(
      { pin: pin(), summary: summary(base.samples) },
      { entry: entry(), summary: summary(base.samples, { gradersHash: "g2" }) },
    );
    expect(oneSided.comparable).toBe(true);
    if (oneSided.comparable) expect(oneSided.notes.join(" ")).toContain("gradersHash");
  });

  test("baseline cases missing from the run", () => {
    expect(
      comparability(
        { pin: pin(), summary: base },
        { entry: entry(), summary: summary([s("a", true), s("c", true)]) },
      ),
    ).toMatchObject({ comparable: false, rule: "cases_removed", ids: ["b"] });
  });

  test("a changed dataset without both cases.json, or with a changed shared case", () => {
    const run = summary([s("a", true), s("b", true)]);
    expect(
      comparability({ pin: pin("h1"), summary: base }, { entry: entry("h2"), summary: run }),
    ).toMatchObject({ comparable: false, rule: "cases_changed" });
    expect(
      comparability(
        { pin: pin("h1"), summary: base, cases: cases({ a: "1", b: "2" }) },
        { entry: entry("h2"), summary: run, cases: cases({ a: "1", b: "2*" }) },
      ),
    ).toMatchObject({ comparable: false, rule: "cases_changed", ids: ["b"] });
  });

  test("growth: comparable on the shared cases, the new ones listed", () => {
    const result = comparability(
      { pin: pin("h1"), summary: base, cases: cases({ a: "1", b: "2" }) },
      {
        entry: entry("h2"),
        summary: summary([s("a", true), s("b", true), s("c", false)]),
        cases: cases({ a: "1", b: "2", c: "3" }),
      },
    );
    expect(result).toEqual({
      comparable: true,
      shared: ["a", "b"],
      added: ["c"],
      lostMeasurement: [],
      notes: [],
    });
  });

  test("a case the baseline measured and this run did not is lost measurement", () => {
    const result = comparability(
      { pin: pin(), summary: base },
      { entry: entry(), summary: summary([s("a", true), notMeasured("b")]) },
    );
    expect(result).toMatchObject({ comparable: true, lostMeasurement: ["b"] });
  });

  test("a baseline whose provability grade carried only the rationale prefix measured nothing to lose", () => {
    const rationale = "no proof bundle (is provability: declared?) — nothing graded";
    const legacy = summary([
      s("a", true),
      s("b", false, { rationale: `[p: ✗] ${rationale}` }, [
        { name: "p", passed: false, score: 0, rationale },
      ]),
    ]);
    const result = comparability(
      { pin: pin(), summary: legacy },
      { entry: entry(), summary: summary([s("a", true), notMeasured("b")]) },
    );
    expect(result).toMatchObject({ comparable: true, lostMeasurement: [] });
  });

  test("the same dataset and the same cases: comparable, nothing added", () => {
    expect(
      comparability(
        { pin: pin(), summary: base },
        { entry: entry(), summary: summary([s("a", true), s("b", false)]) },
      ),
    ).toEqual({ comparable: true, shared: ["a", "b"], added: [], lostMeasurement: [], notes: [] });
  });
});

describe("runState and staleness", () => {
  test("complete, partial and not measured", () => {
    expect(runState(summary([s("a", true), notMeasured("b")]))).toEqual({
      state: "complete",
      measured: 1,
      total: 2,
    });
    expect(runState(summary([notMeasured("b")])).state).toBe("not_measured");
    expect(runState(summary([s("a", false, {}, undefined, { error: "x" })])).state).toBe(
      "not_measured",
    );
    expect(
      runState(
        summary(
          [s("a", true)],
          { toolRecording: { mode: "replay", dir: "r" } },
          {
            resumed: { runDir: "r", resumedAt: "t", reusedSamples: 1, ranSamples: 0 },
          },
        ),
      ),
    ).toEqual({ state: "complete", measured: 1, total: 1, resumed: true, replayed: true });
  });

  test("staleness names only what the caller knows to have moved", () => {
    const run = { specHash: "s1", datasetHash: "d1" };
    expect(staleness(run, {})).toEqual([]);
    expect(staleness(run, { specHash: "s1", deployedSpecHash: "s1", datasetHash: "d1" })).toEqual(
      [],
    );
    expect(staleness(run, { specHash: "s2", deployedSpecHash: "s0", datasetHash: "d2" })).toEqual([
      "spec_changed",
      "not_deployed_revision",
      "cases_changed",
    ]);
  });
});

describe("readCaseDigests", () => {
  const dir = (): string => {
    const d = mkdtempSync(join(tmpdir(), "crewhaus-cases-"));
    TMP.push(d);
    return d;
  };

  test("absent, malformed or another format reads as undefined; a well-formed file reads back", () => {
    const d = dir();
    expect(readCaseDigests(d)).toBeUndefined();
    for (const body of [
      "{not json",
      "[]",
      '{"version":2,"digests":{}}',
      '{"version":1,"digests":{"a":1}}',
    ]) {
      writeFileSync(join(d, "cases.json"), body);
      expect({ body, read: readCaseDigests(d) }).toEqual({ body, read: undefined });
    }
    writeFileSync(join(d, "cases.json"), '{"version":1,"digests":{"a":"x"}}');
    expect(readCaseDigests(d)).toEqual({ version: 1, digests: { a: "x" } });
    // A directory where the file belongs is not one.
    const other = dir();
    mkdirSync(join(other, "cases.json"));
    expect(readCaseDigests(other)).toBeUndefined();
  });
});
