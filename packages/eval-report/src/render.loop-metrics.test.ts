/**
 * Loop contract 0.4 (Batch B) — eval-report renders the new G15/G56/G47
 * surfaces: pass@k / pass^k / loop-metric aggregate cards, the per-sample
 * Trials / Tool acc / Interv. / Safety columns, the per-trial drill table,
 * the judge-calibration note, and rate-aware diff rows — all guarded so a
 * results.json written by an older CLI renders exactly as before.
 */
import { describe, expect, test } from "bun:test";
import type { EvalRunSummary, SampleResult, TrialResult } from "@crewhaus/eval-runner";
import { diffReports } from "./diff";
import type { LoadedRun } from "./load";
import { renderReport } from "./render";

function baseSample(id: string, passed: boolean, score: number): SampleResult {
  return {
    sampleId: id,
    sessionId: `sess_${id.padEnd(16, "0")}`,
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:00:01Z",
    latencyMs: 100,
    turns: 1,
    tokens: { input: 10, output: 20 },
    model: "claude-opus-4-7",
    agentOutput: passed ? "correct" : "wrong",
    grades: {
      overall: { passed, score, rationale: passed ? "ok" : "wrong answer" },
      perGrader: [{ name: "exact", passed, score, rationale: "" }],
    },
  };
}

function trials(passes: number, k: number): { trials: TrialResult[]; trialPassRate: number } {
  return {
    trialPassRate: passes / k,
    trials: Array.from({ length: k }, (_, i) => ({
      trial: i + 1,
      sessionId: `sess_t${i + 1}`,
      passed: i < passes,
      score: i < passes ? 1 : 0,
      rationale: i < passes ? "ok" : "fail",
      latencyMs: 100,
      tokens: { input: 10, output: 20 },
      ...(i >= passes ? { error: "provider blew up" } : {}),
    })),
  };
}

function baseSummary(samples: SampleResult[]): EvalRunSummary {
  return {
    runId: "run_aaaa1111aaaa1111",
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:00:30Z",
    samples,
    aggregates: {
      passRate: samples.filter((s) => s.grades.overall.passed).length / samples.length,
      meanScore: 0.5,
      p50Turns: 1,
      p95Turns: 1,
      p50LatencyMs: 100,
      p95LatencyMs: 100,
      totalTokens: { input: 10, output: 20 },
      errorCount: 0,
    },
    config: {
      specHash: "abc123",
      datasetName: "fixture",
      graderNames: ["exact"],
      model: "claude-opus-4-7",
      concurrency: 4,
    },
    outDir: "<tmp>",
  };
}

function loaded(summary: EvalRunSummary): LoadedRun {
  return { summary, perSample: {} };
}

describe("renderReport — loop-contract columns (G15/G56/G47)", () => {
  test("legacy summaries (no new fields) render without the new columns", () => {
    const out = renderReport(loaded(baseSummary([baseSample("s1", true, 1)])));
    expect(out.html).not.toContain("<th>Trials</th>");
    expect(out.html).not.toContain("<th>Tool acc</th>");
    expect(out.html).not.toContain("pass^");
    expect(out.html).not.toContain("Intervention rate");
    expect(out.html).not.toContain("Judge calibration");
  });

  test("a repeated run renders pass@k / pass^k cards, Trials column, drill table", () => {
    const s1: SampleResult = { ...baseSample("s1", true, 1), ...trials(3, 4) };
    const s2: SampleResult = { ...baseSample("s2", true, 1), ...trials(4, 4) };
    const summary = baseSummary([s1, s2]);
    const withK: EvalRunSummary = {
      ...summary,
      aggregates: {
        ...summary.aggregates,
        passAtK: 1,
        passHatK: 0.5,
        totalTokensAllTrials: { input: 80, output: 160 },
      },
      config: { ...summary.config, repeats: 4 },
    };
    const out = renderReport(loaded(withK));
    expect(out.html).toContain("pass@4");
    expect(out.html).toContain("pass^4");
    expect(out.html).toContain("50.0%");
    expect(out.html).toContain("Tokens (all trials)");
    expect(out.html).toContain("repeats 4");
    expect(out.html).toContain("<th>Trials</th>");
    expect(out.html).toContain(">3/4<");
    expect(out.html).toContain(">4/4<");
    // Drill-down per-trial table with the trial error surfaced.
    expect(out.html).toContain("Trials (3/4 passed)");
    expect(out.html).toContain("provider blew up");
  });

  test("G56 metrics render as cards + per-sample columns", () => {
    const s1: SampleResult = {
      ...baseSample("s1", true, 1),
      metrics: {
        toolCallAccuracy: 0.5,
        interventions: 2,
        safetyViolations: {
          permissionDenials: 1,
          egressBlocks: 1,
          justificationRejections: 0,
          total: 2,
        },
        modelCallLatenciesMs: [100, 300],
      },
    };
    const summary = baseSummary([s1]);
    const withMetrics: EvalRunSummary = {
      ...summary,
      aggregates: {
        ...summary.aggregates,
        partialScoreMean: 0.42,
        interventionRate: 1,
        safetyViolations: {
          permissionDenials: 1,
          egressBlocks: 1,
          justificationRejections: 0,
          total: 2,
        },
        p50ModelCallMs: 200,
        p95ModelCallMs: 290,
        toolCallAccuracy: 0.5,
      },
    };
    const out = renderReport(loaded(withMetrics));
    expect(out.html).toContain("Partial score");
    expect(out.html).toContain("0.420");
    expect(out.html).toContain("Tool accuracy");
    expect(out.html).toContain("Intervention rate");
    expect(out.html).toContain("Safety violations");
    expect(out.html).toContain("p50 model call");
    expect(out.html).toContain("<th>Tool acc</th>");
    expect(out.html).toContain("<th>Interv.</th>");
    expect(out.html).toContain("<th>Safety</th>");
    // Drill metrics line spells out the disjoint safety buckets.
    expect(out.html).toContain("deny 1 · egress 1 · justification 0");
  });

  test("the judge-calibration application renders as a note (G47)", () => {
    const summary = baseSummary([baseSample("s1", true, 1)]);
    const withCal: EvalRunSummary = {
      ...summary,
      config: {
        ...summary.config,
        judgeCalibration: {
          path: "/x/.crewhaus/judge-calibration.json",
          applied: [{ grader: "judge_a", specKey: "my-spec", minScore: 0.62, passingScore: 3.48 }],
        },
      },
    };
    const out = renderReport(loaded(withCal));
    expect(out.html).toContain("Judge calibration applied");
    expect(out.html).toContain("judge_a gated at min-score 0.62 (my-spec)");
  });
});

describe("diffReports — rate-aware flips (G15)", () => {
  test("a reliability drop is a regression with trial rates on both sides", () => {
    const prev = loaded(baseSummary([{ ...baseSample("s1", true, 1), ...trials(4, 4) }]));
    const next = loaded(baseSummary([{ ...baseSample("s1", true, 1), ...trials(1, 4) }]));
    const { diff, html } = diffReports(prev, next);
    expect(diff.regressions).toHaveLength(1);
    expect(diff.regressions[0]?.prev.passRate).toBeCloseTo(1);
    expect(diff.regressions[0]?.next.passRate).toBeCloseTo(0.25);
    expect(html).toContain("100% of trials");
    expect(html).toContain("25% of trials");
  });

  test("single-trial diffs keep boolean flips and no passRate fields", () => {
    const prev = loaded(baseSummary([baseSample("s1", true, 1)]));
    const next = loaded(baseSummary([baseSample("s1", false, 0)]));
    const { diff } = diffReports(prev, next);
    expect(diff.regressions).toHaveLength(1);
    expect("passRate" in (diff.regressions[0]?.prev ?? {})).toBe(false);
  });
});
