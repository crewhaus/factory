/**
 * Item 30 — sentinel drift detection tests. Seeds baseline/current
 * `LoadedRun`s and asserts the specHash + dataset-hash equality logic and the
 * provider-drift verdict.
 */
import { describe, expect, test } from "bun:test";
import type { LoadedRun } from "@crewhaus/eval-report";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import { evaluateSentinel } from "./eval-sentinel";

function sample(id: string, passed: boolean, score: number): SampleResult {
  return {
    sampleId: id,
    sessionId: `sess-${id}`,
    startedAt: "2026-07-02T00:00:00Z",
    endedAt: "2026-07-02T00:00:01Z",
    latencyMs: 100,
    turns: 1,
    tokens: { input: 10, output: 10 },
    model: "claude-sonnet-4-5",
    agentOutput: `out ${id}`,
    grades: {
      overall: { passed, score, rationale: passed ? "ok" : "no" },
      perGrader: [{ name: "g1", passed, score, rationale: passed ? "ok" : "no" }],
    },
  };
}

function loaded(
  specHash: string,
  samples: SampleResult[],
  configOverrides: Partial<EvalRunSummary["config"]> = {},
): LoadedRun {
  const passed = samples.filter((s) => s.grades.overall.passed).length;
  const summary: EvalRunSummary = {
    runId: `run_${Math.random().toString(16).slice(2)}`,
    startedAt: "2026-07-02T00:00:00Z",
    endedAt: "2026-07-02T00:00:01Z",
    samples,
    aggregates: {
      passRate: samples.length === 0 ? 0 : passed / samples.length,
      meanScore:
        samples.length === 0
          ? 0
          : samples.reduce((a, s) => a + s.grades.overall.score, 0) / samples.length,
      p50Turns: 1,
      p95Turns: 1,
      p50LatencyMs: 100,
      p95LatencyMs: 100,
      totalTokens: { input: 0, output: 0 },
      errorCount: 0,
    },
    config: {
      specHash,
      datasetName: "sentinel",
      graderNames: ["g1"],
      model: "claude-sonnet-4-5",
      concurrency: 1,
      ...configOverrides,
    },
    outDir: "/tmp/x",
  };
  return { summary, perSample: {} };
}

const HASH_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DS_HASH = "dddddddddddddddddddddddddddddddd";
const DS_HASH2 = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

describe("evaluateSentinel", () => {
  test("frozen spec+dataset, no flips ⇒ clean, no alert", () => {
    const baseline = loaded(HASH_A, [sample("s1", true, 1), sample("s2", true, 0.9)]);
    const current = loaded(HASH_A, [sample("s1", true, 1), sample("s2", true, 0.9)]);
    const r = evaluateSentinel({
      baseline,
      current,
      baselineDatasetHash: DS_HASH,
      currentDatasetHash: DS_HASH,
    });
    expect(r.verdict).toBe("clean");
    expect(r.alert).toBe(false);
  });

  test("frozen spec+dataset, a pass→fail flip ⇒ drift, alert", () => {
    const baseline = loaded(HASH_A, [sample("s1", true, 1), sample("s2", true, 0.9)]);
    // s2 regressed on identical inputs — provider drift.
    const current = loaded(HASH_A, [sample("s1", true, 1), sample("s2", false, 0.2)]);
    const r = evaluateSentinel({
      baseline,
      current,
      baselineDatasetHash: DS_HASH,
      currentDatasetHash: DS_HASH,
    });
    expect(r.verdict).toBe("drift");
    expect(r.alert).toBe(true);
    expect(r.reason).toContain("provider drift");
    expect(r.diff?.regressions.length).toBe(1);
  });

  test("frozen spec+dataset, a score shift beyond ε ⇒ drift, alert", () => {
    const baseline = loaded(HASH_A, [sample("s1", true, 0.95)]);
    // Still passing but the score moved 0.95 → 0.6 (> ε 0.1).
    const current = loaded(HASH_A, [sample("s1", true, 0.6)]);
    const r = evaluateSentinel({
      baseline,
      current,
      baselineDatasetHash: DS_HASH,
      currentDatasetHash: DS_HASH,
    });
    expect(r.verdict).toBe("drift");
    expect(r.alert).toBe(true);
    expect(r.diff?.scoreShifts.length).toBe(1);
  });

  test("frozen spec+dataset, only a recovery ⇒ clean (better is not a failure)", () => {
    const baseline = loaded(HASH_A, [sample("s1", false, 0.2)]);
    const current = loaded(HASH_A, [sample("s1", true, 1)]);
    const r = evaluateSentinel({
      baseline,
      current,
      baselineDatasetHash: DS_HASH,
      currentDatasetHash: DS_HASH,
    });
    expect(r.verdict).toBe("clean");
    expect(r.alert).toBe(false);
    expect(r.diff?.recoveries.length).toBe(1);
  });

  test("spec changed ⇒ not-comparable, alert (loud, not silently green)", () => {
    const baseline = loaded(HASH_A, [sample("s1", true, 1)]);
    const current = loaded(HASH_B, [sample("s1", false, 0)]);
    const r = evaluateSentinel({
      baseline,
      current,
      baselineDatasetHash: DS_HASH,
      currentDatasetHash: DS_HASH,
    });
    expect(r.verdict).toBe("not-comparable");
    expect(r.alert).toBe(true);
    expect(r.reason).toContain("spec changed");
  });

  test("dataset content changed ⇒ not-comparable, alert", () => {
    const baseline = loaded(HASH_A, [sample("s1", true, 1)]);
    const current = loaded(HASH_A, [sample("s1", true, 1)]);
    const r = evaluateSentinel({
      baseline,
      current,
      baselineDatasetHash: DS_HASH,
      currentDatasetHash: DS_HASH2,
    });
    expect(r.verdict).toBe("not-comparable");
    expect(r.alert).toBe(true);
    expect(r.reason).toContain("dataset changed");
  });

  test("equal hashes but a keyset mismatch ⇒ not-comparable, not a crash", () => {
    const baseline = loaded(HASH_A, [sample("s1", true, 1)]);
    // Different sample id — diffReports throws ReportError; sentinel catches it.
    const current = loaded(HASH_A, [sample("s2", true, 1)]);
    const r = evaluateSentinel({
      baseline,
      current,
      baselineDatasetHash: DS_HASH,
      currentDatasetHash: DS_HASH,
    });
    expect(r.verdict).toBe("not-comparable");
    expect(r.alert).toBe(true);
  });

  // F2 — a different judge model or an edited graders.yaml changes what
  // "pass" MEANS independent of the provider under test; neither ever
  // touches specHash or the dataset hash, so both must gate separately or a
  // judge/grader change silently reads as "provider drift".
  test("different judge model + a score shift ⇒ not-comparable (not drift)", () => {
    const baseline = loaded(HASH_A, [sample("s1", true, 0.95)], {
      judgeModel: "claude-sonnet-4-5",
      gradersHash: "g-hash-1",
    });
    // Score moved AND the judge model changed — must not read as drift.
    const current = loaded(HASH_A, [sample("s1", true, 0.6)], {
      judgeModel: "claude-opus-4-5",
      gradersHash: "g-hash-1",
    });
    const r = evaluateSentinel({
      baseline,
      current,
      baselineDatasetHash: DS_HASH,
      currentDatasetHash: DS_HASH,
    });
    expect(r.verdict).toBe("not-comparable");
    expect(r.alert).toBe(true);
    expect(r.reason).toContain("judge model changed");
  });

  test("different graders config ⇒ not-comparable", () => {
    const baseline = loaded(HASH_A, [sample("s1", true, 1)], {
      judgeModel: "claude-sonnet-4-5",
      gradersHash: "g-hash-1",
    });
    const current = loaded(HASH_A, [sample("s1", true, 1)], {
      judgeModel: "claude-sonnet-4-5",
      gradersHash: "g-hash-2",
    });
    const r = evaluateSentinel({
      baseline,
      current,
      baselineDatasetHash: DS_HASH,
      currentDatasetHash: DS_HASH,
    });
    expect(r.verdict).toBe("not-comparable");
    expect(r.alert).toBe(true);
    expect(r.reason).toContain("graders config changed");
  });

  test("baseline predates gradersHash (undefined vs recorded) ⇒ not-comparable", () => {
    // Baseline recorded before this CLI version added gradersHash — undefined
    // on one side, a real hash on the other, must not silently compare equal.
    const baseline = loaded(HASH_A, [sample("s1", true, 1)], {
      judgeModel: "claude-sonnet-4-5",
      // gradersHash intentionally omitted (undefined).
    });
    const current = loaded(HASH_A, [sample("s1", true, 1)], {
      judgeModel: "claude-sonnet-4-5",
      gradersHash: "g-hash-1",
    });
    const r = evaluateSentinel({
      baseline,
      current,
      baselineDatasetHash: DS_HASH,
      currentDatasetHash: DS_HASH,
    });
    expect(r.verdict).toBe("not-comparable");
    expect(r.alert).toBe(true);
    expect(r.reason).toContain("graders config changed");
  });

  test("judgeModel + gradersHash both equal, score shift ⇒ still drift", () => {
    const baseline = loaded(HASH_A, [sample("s1", true, 0.95)], {
      judgeModel: "claude-sonnet-4-5",
      gradersHash: "g-hash-1",
    });
    const current = loaded(HASH_A, [sample("s1", true, 0.6)], {
      judgeModel: "claude-sonnet-4-5",
      gradersHash: "g-hash-1",
    });
    const r = evaluateSentinel({
      baseline,
      current,
      baselineDatasetHash: DS_HASH,
      currentDatasetHash: DS_HASH,
    });
    expect(r.verdict).toBe("drift");
    expect(r.alert).toBe(true);
    expect(r.diff?.scoreShifts.length).toBe(1);
  });

  // NEW-HUNT-3 — a budget-aborted run records its unexecuted samples as
  // synthetic errors; with every hash equal those flips previously read as
  // PROVIDER drift. They must read as not-comparable (budget exhaustion is
  // systematic, not model behaviour).
  function markPartial(run: LoadedRun, completedSamples: number, totalSamples: number): LoadedRun {
    return {
      ...run,
      summary: {
        ...run.summary,
        partial: {
          reason: "budget_exhausted",
          completedSamples,
          totalSamples,
          spentUsd: 2.5,
          budgetUsd: 2,
        },
      },
    };
  }

  test("current run budget-partial, frozen hashes, aborted-sample flip ⇒ not-comparable, NOT drift", () => {
    const baseline = loaded(HASH_A, [sample("s1", true, 1), sample("s2", true, 1)]);
    // s2 never ran — the runner recorded it as an errored fail. Pre-fix
    // this exact shape produced verdict "drift".
    const current = markPartial(
      loaded(HASH_A, [sample("s1", true, 1), sample("s2", false, 0)]),
      1,
      2,
    );
    const r = evaluateSentinel({
      baseline,
      current,
      baselineDatasetHash: DS_HASH,
      currentDatasetHash: DS_HASH,
    });
    expect(r.verdict).toBe("not-comparable");
    expect(r.alert).toBe(true);
    expect(r.reason).toContain("budget exhausted after 1/2 samples");
    expect(r.reason).not.toContain("provider drift");
  });

  test("baseline run budget-partial ⇒ not-comparable (re-pin from a full run)", () => {
    const baseline = markPartial(
      loaded(HASH_A, [sample("s1", true, 1), sample("s2", false, 0)]),
      1,
      2,
    );
    const current = loaded(HASH_A, [sample("s1", true, 1), sample("s2", true, 1)]);
    const r = evaluateSentinel({
      baseline,
      current,
      baselineDatasetHash: DS_HASH,
      currentDatasetHash: DS_HASH,
    });
    expect(r.verdict).toBe("not-comparable");
    expect(r.alert).toBe(true);
    expect(r.reason).toContain("re-pin the baseline from a full run");
  });

  test("a changed instrument still wins over the partial marker (primary re-pin action first)", () => {
    const baseline = loaded(HASH_A, [sample("s1", true, 1)], { gradersHash: "g-hash-1" });
    const current = markPartial(
      loaded(HASH_A, [sample("s1", true, 1)], { gradersHash: "g-hash-2" }),
      0,
      1,
    );
    const r = evaluateSentinel({
      baseline,
      current,
      baselineDatasetHash: DS_HASH,
      currentDatasetHash: DS_HASH,
    });
    expect(r.verdict).toBe("not-comparable");
    expect(r.reason).toContain("graders config changed");
  });
});
