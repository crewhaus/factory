import { describe, expect, test } from "bun:test";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import { DEFAULT_SCORE_EPSILON, diffReports } from "./diff";
import { ReportError } from "./errors";
import type { LoadedRun } from "./load";

/** Same verdict on both sides, only the score moves — so the classification
 *  turns purely on the epsilon. */
function shifted(id: string, score: number): SampleResult {
  return {
    sampleId: id,
    sessionId: `sess_${id}`,
    startedAt: "2026-07-01T00:00:00.000Z",
    endedAt: "2026-07-01T00:00:01.000Z",
    latencyMs: 100,
    turns: 1,
    tokens: { input: 1, output: 1 },
    model: "claude-sonnet-4-5",
    agentOutput: "answer",
    grades: {
      overall: { passed: true, score, rationale: "ok" },
      perGrader: [{ name: "judge", passed: true, score, rationale: "ok" }],
    },
  };
}

function loaded(runId: string, samples: SampleResult[]): LoadedRun {
  const summary: EvalRunSummary = {
    runId,
    startedAt: "2026-07-01T00:00:00.000Z",
    endedAt: "2026-07-01T00:01:00.000Z",
    samples,
    aggregates: {
      passRate: 1,
      meanScore: samples.reduce((a, s) => a + s.grades.overall.score, 0) / samples.length,
      p50Turns: 1,
      p95Turns: 1,
      p50LatencyMs: 100,
      p95LatencyMs: 100,
      totalTokens: { input: 1, output: 1 },
      errorCount: 0,
    },
    config: {
      specHash: "spec1",
      datasetName: "smoke",
      graderNames: ["judge"],
      model: "claude-sonnet-4-5",
      concurrency: 1,
    },
    outDir: `/abs/${runId}`,
  };
  return { summary, perSample: {} };
}

describe("diffReports --epsilon (NEW-stats-1)", () => {
  // 0.08 is BELOW the shipped 0.1 default and ABOVE a 0.05 override.
  const prev = loaded("run_a", [shifted("s1", 0.5)]);
  const next = loaded("run_b", [shifted("s1", 0.58)]);

  test("the default is unchanged at 0.1 — a 0.08 move is still 'unchanged'", () => {
    expect(DEFAULT_SCORE_EPSILON).toBe(0.1);
    const { diff } = diffReports(prev, next);
    expect(diff.scoreShifts).toHaveLength(0);
    expect(diff.unchanged).toBe(1);
  });

  test("a tighter epsilon reports the same move as a score shift", () => {
    const { diff } = diffReports(prev, next, { epsilon: 0.05 });
    expect(diff.scoreShifts.map((s) => s.sampleId)).toEqual(["s1"]);
    expect(diff.unchanged).toBe(0);
  });

  test("a looser epsilon absorbs a move the default would have reported", () => {
    const far = loaded("run_c", [shifted("s1", 0.8)]);
    expect(diffReports(prev, far).diff.scoreShifts).toHaveLength(1);
    expect(diffReports(prev, far, { epsilon: 0.5 }).diff.scoreShifts).toHaveLength(0);
  });

  test("epsilon is a STRICT threshold — a move exactly equal to it is not a shift", () => {
    const exactly = loaded("run_d", [shifted("s1", 0.6)]);
    expect(diffReports(prev, exactly, { epsilon: 0.1 }).diff.scoreShifts).toHaveLength(0);
  });

  test("epsilon 0 reports every non-zero move", () => {
    const tiny = loaded("run_e", [shifted("s1", 0.5001)]);
    expect(diffReports(prev, tiny, { epsilon: 0 }).diff.scoreShifts).toHaveLength(1);
  });

  test("a flip is a flip at ANY epsilon — verdict changes are never absorbed", () => {
    const failed: SampleResult = {
      ...shifted("s1", 0.49),
      grades: {
        overall: { passed: false, score: 0.49, rationale: "wrong" },
        perGrader: [{ name: "judge", passed: false, score: 0.49, rationale: "wrong" }],
      },
    };
    const { diff } = diffReports(prev, loaded("run_f", [failed]), { epsilon: 10 });
    expect(diff.regressions.map((r) => r.sampleId)).toEqual(["s1"]);
  });

  test("a negative epsilon is refused rather than silently clamped", () => {
    expect(() => diffReports(prev, next, { epsilon: -1 })).toThrow(ReportError);
    expect(() => diffReports(prev, next, { epsilon: Number.NaN })).toThrow(/non-negative/);
  });
});
