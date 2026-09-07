/**
 * 0.6.0 §6.1 (PR 12) — the leaderboard's REFUSALS.
 *
 * `bestModels` takes a raw argmax, so a one-point split on a dozen samples
 * reads as a winner. These tests pin the three ways the leaderboard declines
 * to say that — underpowered, non-significant, overlapping intervals — and the
 * one case where it does name a winner.
 */
import { describe, expect, test } from "bun:test";
import type { EvalAggregates, EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import {
  buildLeaderboard,
  formatLeaderboardLines,
  holmAdjust,
  intervalsOverlap,
  pairedDeltas,
  pairwiseTable,
  rowArm,
} from "./leaderboard";
import { type MatrixCell, buildMatrix } from "./matrix";

function sample(id: string, passed: boolean, score = passed ? 1 : 0): SampleResult {
  return {
    sampleId: id,
    sessionId: `s_${id}`,
    startedAt: "2026-09-01T00:00:00.000Z",
    endedAt: "2026-09-01T00:00:01.000Z",
    latencyMs: 100,
    turns: 1,
    tokens: { input: 10, output: 5 },
    model: "m",
    agentOutput: "out",
    grades: {
      overall: { passed, score, rationale: "r" },
      perGrader: [{ name: "g", passed, score, rationale: "r" }],
    },
  };
}

function aggregatesOf(
  samples: ReadonlyArray<SampleResult>,
  ci?: readonly [number, number],
): EvalAggregates {
  const passed = samples.filter((s) => s.grades.overall.passed).length;
  const passRate = samples.length === 0 ? 0 : passed / samples.length;
  const meanScore =
    samples.length === 0
      ? 0
      : samples.reduce((a, s) => a + s.grades.overall.score, 0) / samples.length;
  return {
    passRate,
    meanScore,
    p50Turns: 1,
    p95Turns: 1,
    p50LatencyMs: 100,
    p95LatencyMs: 120,
    totalTokens: { input: 10 * samples.length, output: 5 * samples.length },
    errorCount: 0,
    ...(ci !== undefined ? { passRateCI95: ci, meanScoreCI95: ci } : {}),
  };
}

function cellOf(
  model: string,
  samples: ReadonlyArray<SampleResult>,
  opts: {
    readonly armId?: string;
    readonly ci?: readonly [number, number];
    readonly gradersHash?: string;
    readonly judgeModel?: string;
  } = {},
): MatrixCell {
  const summary: EvalRunSummary = {
    runId: `run_${model}`,
    startedAt: "2026-09-01T00:00:00.000Z",
    endedAt: "2026-09-01T00:00:10.000Z",
    samples: [...samples],
    aggregates: aggregatesOf(samples, opts.ci),
    config: {
      specHash: "h",
      datasetName: "d",
      graderNames: ["g"],
      model,
      concurrency: 1,
      ...(opts.gradersHash !== undefined ? { gradersHash: opts.gradersHash } : {}),
      ...(opts.judgeModel !== undefined ? { judgeModel: opts.judgeModel } : {}),
    },
    outDir: `/tmp/${model}`,
  };
  return {
    model,
    ...(opts.armId !== undefined ? { armId: opts.armId } : {}),
    slug: model,
    outDir: `/tmp/${model}`,
    summary,
  };
}

/** N samples where the first `passes` pass. */
function run(n: number, passes: number): SampleResult[] {
  return Array.from({ length: n }, (_, i) => sample(`s${i}`, i < passes));
}

const board = (cells: MatrixCell[], minN?: number) =>
  buildLeaderboard(buildMatrix(cells, { now: () => new Date(0) }), cells, {
    seed: 29,
    ...(minN !== undefined ? { minN } : {}),
  });

describe("holmAdjust / intervalsOverlap", () => {
  test("Holm is monotone and never exceeds 1", () => {
    expect(holmAdjust([])).toEqual([]);
    expect(holmAdjust([0.01, 0.04, 0.5])).toEqual([0.03, 0.08, 0.5]);
    expect(holmAdjust([0.4, 0.5])).toEqual([0.8, 0.8]);
  });

  test("absent intervals never overlap (an unknown is not an overlap)", () => {
    expect(intervalsOverlap([0, 0.5], [0.4, 1])).toBe(true);
    expect(intervalsOverlap([0, 0.4], [0.5, 1])).toBe(false);
    expect(intervalsOverlap(undefined, [0.5, 1])).toBe(false);
  });
});

describe("buildLeaderboard", () => {
  test("REFUSES a winner when the top two intervals overlap", () => {
    // 40 pairs (over the floor) and a big, significant paired gap — but the
    // marginal intervals overlap, so the verdict is still a tie.
    const strong = cellOf("strong", run(40, 30), { armId: "strong", ci: [0.55, 0.9] });
    const fast = cellOf("fast", run(40, 18), { armId: "fast", ci: [0.3, 0.62] });
    const v = board([strong, fast]).verdict["passRate"];
    expect(v?.leader).toBe("strong");
    expect(v?.decision).toBe("tie");
    expect(v?.ciOverlap).toBe(true);
    expect(v?.reason).toContain("intervals overlap");
  });

  test("names a winner when the paired test clears Holm AND the intervals are disjoint", () => {
    const strong = cellOf("strong", run(40, 36), { armId: "strong", ci: [0.79, 0.97] });
    const fast = cellOf("fast", run(40, 12), { armId: "fast", ci: [0.18, 0.46] });
    const v = board([strong, fast]).verdict["passRate"];
    expect(v?.decision).toBe("winner");
    expect(v?.leader).toBe("strong");
    expect(v?.runnerUp).toBe("fast");
    expect(v?.holmP).toBeLessThan(0.05);
    expect(v?.ciOverlap).toBeUndefined();
  });

  test("UNDERPOWERED below the comparable-pair floor, whatever the gap", () => {
    const strong = cellOf("strong", run(12, 12), { armId: "strong", ci: [0.76, 1] });
    const fast = cellOf("fast", run(12, 0), { armId: "fast", ci: [0, 0.24] });
    const v = board([strong, fast]).verdict["passRate"];
    expect(v?.decision).toBe("underpowered");
    expect(v?.n).toBe(12);
    expect(v?.minN).toBe(30);
    expect(v?.reason).toContain("below the 30-pair floor");
    // --min-n is the documented override, and it changes the verdict.
    expect(board([strong, fast], 10).verdict["passRate"]?.decision).toBe("winner");
  });

  test("TIE when the paired test is not significant", () => {
    // Same pass COUNT, DIFFERENT samples: 20 sample-level flips each way, so
    // the paired deltas cancel and the permutation test sees nothing.
    const a = cellOf(
      "a",
      Array.from({ length: 40 }, (_, i) => sample(`s${i}`, i < 20)),
      { armId: "a", ci: [0.35, 0.65] },
    );
    const b = cellOf(
      "b",
      Array.from({ length: 40 }, (_, i) => sample(`s${i}`, i >= 20)),
      { armId: "b", ci: [0.35, 0.65] },
    );
    const v = board([a, b]).verdict["passRate"];
    expect(v?.decision).toBe("tie");
    expect(v?.reason).toContain("not significant");
  });

  test("a single comparable arm is underpowered, never a winner by default", () => {
    const v = board([cellOf("solo", run(40, 40), { armId: "solo" })]).verdict["passRate"];
    expect(v?.decision).toBe("underpowered");
    expect(v?.reason).toContain("only one comparable arm");
  });

  test("cells graded by a different instrument are EXCLUDED, not ranked", () => {
    const a = cellOf("a", run(40, 30), { armId: "a", gradersHash: "g1", ci: [0.6, 0.87] });
    const b = cellOf("b", run(40, 10), { armId: "b", gradersHash: "g1", ci: [0.14, 0.4] });
    const other = cellOf("c", run(40, 40), { armId: "c", gradersHash: "g2", ci: [0.91, 1] });
    const result = board([a, b, other]);
    expect(result.excluded.map((e) => e.armId)).toEqual(["c"]);
    expect(result.verdict["passRate"]?.leader).toBe("a");
    expect(formatLeaderboardLines(result).some((l) => l.includes("excluded c"))).toBe(true);
  });

  test("--pairwise lists every N-choose-2 comparison with Holm-adjusted p", () => {
    const cells = [
      cellOf("a", run(40, 34), { armId: "a" }),
      cellOf("b", run(40, 20), { armId: "b" }),
      cellOf("c", run(40, 6), { armId: "c" }),
    ];
    const result = board(cells);
    // 3 arms × 2 metrics = 3 pairs per metric.
    expect(result.comparisons.filter((c) => c.metric === "passRate")).toHaveLength(3);
    const table = pairwiseTable(result);
    expect(table.rows).toHaveLength(6);
    expect(table.header).toContain("holm_p");
    for (const c of result.comparisons) expect(c.holmP).toBeGreaterThanOrEqual(c.pValue);
  });

  test("pairedDeltas drops abstained pairs and rowArm falls back to the model", () => {
    const abstained = sample("s0", false);
    const withAbstain: SampleResult = {
      ...abstained,
      grades: { ...abstained.grades, overall: { ...abstained.grades.overall, abstained: true } },
    };
    const a = cellOf("a", [withAbstain, sample("s1", true)]);
    const b = cellOf("b", [sample("s0", true), sample("s1", false)]);
    expect(
      pairedDeltas(a.summary as EvalRunSummary, b.summary as EvalRunSummary, "passRate"),
    ).toEqual([1]);
    expect(rowArm({ model: "m" })).toBe("m");
    expect(rowArm({ model: "m", armId: "fast" })).toBe("fast");
  });
});
