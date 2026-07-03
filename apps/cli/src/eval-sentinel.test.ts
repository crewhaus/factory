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

function loaded(specHash: string, samples: SampleResult[]): LoadedRun {
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
});
