import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import {
  type CaseDigests,
  comparability,
  measuredInBaseline,
  protectedChanges,
  readCaseDigests,
} from "./comparability";
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
      s("b", false, { rationale: `[provability.claimCoverage: ✗] ${rationale}` }, [
        { name: "provability.claimCoverage", passed: false, score: 0, rationale },
      ]),
    ]);
    const result = comparability(
      { pin: pin(), summary: legacy },
      { entry: entry(), summary: summary([s("a", true), notMeasured("b")]) },
    );
    expect(result).toMatchObject({ comparable: true, lostMeasurement: [] });
  });

  test("a baseline judge whose rationale starts with a proof prefix measured its case", () => {
    const rationale = "no proof bundle (is provability: declared?) — the judge wrote this";
    const judged = summary([
      s("a", true),
      s("b", false, { rationale }, [{ name: "quality_judge", passed: false, score: 0, rationale }]),
    ]);
    const result = comparability(
      { pin: pin(), summary: judged },
      { entry: entry(), summary: summary([s("a", true), notMeasured("b")]) },
    );
    expect(result).toMatchObject({ comparable: true, lostMeasurement: ["b"] });
    expect(measuredInBaseline(judged.samples[1] as SampleResult)).toBe(true);
  });

  test("a baseline case decided by its enforced grader, beside a skipped and an observing one, was measured", () => {
    const decided = s("b", true, {}, [
      { name: "has", passed: true, score: 1, rationale: "" },
      {
        name: "exact",
        passed: false,
        score: 0,
        rationale: "outside criterion json-only's cases",
        status: "skipped",
        statusReason: "out_of_scope",
      },
      { name: "watch", passed: false, score: 0, rationale: "", status: "observing" },
    ]);
    expect(measuredInBaseline(decided)).toBe(true);
    const lostRun = summary([
      s("a", true),
      s("b", false, { status: "not_measured", statusReason: "no_judge_credentials" }),
    ]);
    expect(
      comparability(
        { pin: pin(), summary: summary([s("a", true), decided]) },
        { entry: entry(), summary: lostRun },
      ),
    ).toMatchObject({ comparable: true, lostMeasurement: ["b"] });
    // A per-grader grade that is not measured still leaves the case unmeasured.
    const unmeasured = s("c", true, {}, [
      { name: "has", passed: true, score: 1, rationale: "" },
      { name: "judge", passed: false, score: 0, rationale: "", status: "not_measured" },
    ]);
    expect(measuredInBaseline(unmeasured)).toBe(false);
  });

  test("a graders file's own name for a provability grader is read like the six, when passed", () => {
    const rationale = "the gate could not verify this answer (x)";
    const sample = s("b", false, { rationale: "[cov: ✗]" }, [
      { name: "cov", passed: false, score: 0, rationale },
    ]);
    expect(measuredInBaseline(sample, { provabilityGraderNames: new Set(["cov"]) })).toBe(false);
    expect(measuredInBaseline(sample)).toBe(true);
    const base2 = summary([s("a", true), sample]);
    const run2 = summary([s("a", true), notMeasured("b")]);
    expect(
      comparability(
        { pin: pin(), summary: base2 },
        { entry: entry(), summary: run2 },
        {
          provabilityGraderNames: new Set(["cov"]),
        },
      ),
    ).toMatchObject({ comparable: true, lostMeasurement: [] });
    expect(
      comparability({ pin: pin(), summary: base2 }, { entry: entry(), summary: run2 }),
    ).toMatchObject({ comparable: true, lostMeasurement: ["b"] });
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
  test("a regrade or a preview of another run says so; a live run does not", () => {
    expect(
      runState(summary([s("a", true)], { purpose: "regrade", regradeOf: "run_src" })).regraded,
    ).toBe(true);
    expect(runState(summary([s("a", true)], { purpose: "preview" })).regraded).toBe(true);
    expect("regraded" in runState(summary([s("a", true)]))).toBe(false);
  });

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

describe("protectedChanges", () => {
  const record = (id: string, digest: string, extra: Record<string, unknown> = {}) => ({
    id,
    digest,
    mode: "enforce" as const,
    graders: [],
    ...extra,
  });
  const withMeta = (id: string, family: string) =>
    s(id, true, {}, undefined, { metadata: { family } });

  test("a protected criterion that changed or went is named", () => {
    const base = summary([withMeta("a", "csv")], {
      criteria: [
        record("kept", "d1", { protected: true }),
        record("moved", "d2", { protected: true }),
        record("gone", "d3", { protected: true }),
        record("open", "d5"),
      ],
    });
    const run = summary([withMeta("a", "csv")], {
      criteria: [record("kept", "d1"), record("moved", "d2x"), record("open", "zz")],
    });
    expect(protectedChanges(base, run)).toEqual([
      "protected criterion moved changed",
      "protected criterion gone is gone",
    ]);
  });

  test("a case inside a protected criterion's scope that is gone is named; one outside is not", () => {
    const criteria = [
      record("scoped", "d4", { protected: true, scope: { metadata: { family: ["json"] } } }),
    ];
    const base = summary([withMeta("a", "csv"), withMeta("b", "json"), withMeta("c", "csv")], {
      criteria,
    });
    expect(protectedChanges(base, summary([withMeta("b", "json")], { criteria }))).toEqual([]);
    expect(protectedChanges(base, summary([withMeta("a", "csv")], { criteria }))).toEqual([
      "cases inside protected criterion scoped's scope are gone: b",
    ]);
  });

  test("nothing protected, nothing named", () => {
    const base = summary([withMeta("a", "csv")], { criteria: [record("open", "d5")] });
    expect(protectedChanges(base, summary([], { criteria: [] }))).toEqual([]);
    expect(protectedChanges(summary([withMeta("a", "csv")]), summary([]))).toEqual([]);
  });
});
