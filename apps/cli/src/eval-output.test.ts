/**
 * Loop contract 0.4 (Batch B) — unit tests for the shared eval-loop CLI
 * helpers (eval-output.ts): the G14 registry-construction rule, the G56
 * partial-credit fitness figure, and the `[eval]` stdout block. Every new
 * output segment must be PRESENCE-GATED: a summary persisted by an older
 * CLI renders exactly the pre-0.4 block.
 */
import { describe, expect, test } from "bun:test";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import type { EvalAggregates, EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import {
  evalRunOutputLines,
  fitnessScore,
  formatCriterionLines,
  formatEvalSummaryLine,
  formatFailureClassesLine,
  formatJudgeCalibrationLines,
  formatLoopMetricsLine,
  formatNeedsHumanLine,
  formatRepeatsLine,
  formatSliceLines,
  graderRegistryForCompiled,
} from "./eval-output";

function sample(id: string, overrides: Partial<SampleResult> = {}): SampleResult {
  return {
    sampleId: id,
    sessionId: `sess_${id.padEnd(16, "0")}`,
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:00:01Z",
    latencyMs: 100,
    turns: 1,
    tokens: { input: 10, output: 20 },
    model: "claude-opus-4-7",
    agentOutput: "hi",
    grades: {
      overall: { passed: true, score: 1, rationale: "ok" },
      perGrader: [{ name: "exact", passed: true, score: 1, rationale: "" }],
    },
    ...overrides,
  };
}

const LEGACY_AGGREGATES: EvalAggregates = {
  passRate: 0.5,
  meanScore: 0.75,
  p50Turns: 1,
  p95Turns: 1,
  p50LatencyMs: 100,
  p95LatencyMs: 100,
  totalTokens: { input: 100, output: 200 },
  errorCount: 1,
};

function summary(
  aggregates: EvalAggregates,
  overrides: Partial<EvalRunSummary> = {},
): EvalRunSummary {
  return {
    runId: "run_aaaa1111aaaa1111",
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:00:30Z",
    samples: [sample("q1")],
    aggregates,
    config: {
      specHash: "abc123",
      datasetName: "fixture",
      graderNames: ["exact"],
      model: "claude-opus-4-7",
      concurrency: 4,
    },
    outDir: "<tmp>",
    ...overrides,
  };
}

describe("fitnessScore (G56)", () => {
  test("reads partialScoreMean when present", () => {
    expect(fitnessScore({ ...LEGACY_AGGREGATES, partialScoreMean: 0.62 })).toBe(0.62);
  });

  test("falls back to passRate on legacy aggregates", () => {
    expect(fitnessScore(LEGACY_AGGREGATES)).toBe(0.5);
  });

  test("a genuine 0 partial score is used, not skipped", () => {
    expect(fitnessScore({ ...LEGACY_AGGREGATES, partialScoreMean: 0 })).toBe(0);
  });
});

describe("graderRegistryForCompiled (G14)", () => {
  test("returns undefined when no grader resolves by registry name", async () => {
    const { compiled } = parseGradersConfig("graders:\n  - name: exact\n    type: exact_match\n");
    expect(await graderRegistryForCompiled(compiled)).toBeUndefined();
  });

  test("constructs the default registry when a type: registry grader is present", async () => {
    const { compiled } = parseGradersConfig(
      "graders:\n  - name: rouge\n    type: registry\n    grader: nlg.rouge1\n",
    );
    const registry = await graderRegistryForCompiled(compiled);
    expect(registry).toBeDefined();
    // The six packs' vocabulary is registered — resolving a pack name works…
    expect(typeof registry?.lookup("nlg.rouge1")).toBe("function");
    expect(typeof registry?.lookup("continuity.reAskRate")).toBe("function");
    // …and the list() enrichment seam is available for lookup-failure messages.
    expect(registry?.list?.()).toContain("safety.piiLeak");
  });
});

describe("formatEvalSummaryLine", () => {
  test("legacy aggregates render the exact pre-0.4 line", () => {
    const line = formatEvalSummaryLine(summary(LEGACY_AGGREGATES), 0);
    expect(line).toBe(
      "[eval] runId=run_aaaa1111aaaa1111 pass_rate=50.0% mean_score=0.750 errors=1 tokens=100/200",
    );
  });

  test("partial_score appears when the runner emitted it; retried count appended", () => {
    const line = formatEvalSummaryLine(
      summary({ ...LEGACY_AGGREGATES, partialScoreMean: 0.625 }),
      2,
    );
    expect(line).toContain("mean_score=0.750 partial_score=0.625 errors=1");
    expect(line).toContain("(2 retried)");
  });

  test("C27: the 95% CIs ride directly behind their point estimates", () => {
    const line = formatEvalSummaryLine(
      summary({
        ...LEGACY_AGGREGATES,
        passRateCI95: [0.4902, 0.9433],
        meanScoreCI95: [0.61, 0.79],
      }),
      0,
    );
    expect(line).toContain("pass_rate=50.0% pass_rate_ci95=[49.0%,94.3%]");
    expect(line).toContain("mean_score=0.750 mean_score_ci95=[0.610,0.790]");
  });
});

describe("formatSliceLines (B13)", () => {
  test("empty when the summary carries no slices", () => {
    expect(formatSliceLines(summary(LEGACY_AGGREGATES))).toEqual([]);
  });

  test("one compact line per slice key", () => {
    const s = summary(LEGACY_AGGREGATES, {
      slices: {
        difficulty: {
          easy: { sampleCount: 4, passRate: 1, meanScore: 0.9 },
          hard: { sampleCount: 5, passRate: 0.4, meanScore: 0.3 },
        },
        language: { de: { sampleCount: 2, passRate: 0.5, meanScore: 0.5 } },
      },
    });
    expect(formatSliceLines(s)).toEqual([
      "[eval] slice difficulty: easy 100.0% (n=4) · hard 40.0% (n=5)",
      "[eval] slice language: de 50.0% (n=2)",
    ]);
  });
});

describe("formatCriterionLines (A12)", () => {
  test("empty without criterionMeans", () => {
    expect(formatCriterionLines(summary(LEGACY_AGGREGATES))).toEqual([]);
  });

  test("one line per judge grader; exact means render without decimals", () => {
    const s = summary({
      ...LEGACY_AGGREGATES,
      criterionMeans: {
        quality: { correctness: 4, tone: 4.333333 },
        safety: { harmlessness: 5 },
      },
    });
    expect(formatCriterionLines(s)).toEqual([
      "[eval] judge criteria quality: correctness=4 tone=4.33",
      "[eval] judge criteria safety: harmlessness=5",
    ]);
  });
});

describe("formatNeedsHumanLine (A3)", () => {
  test("undefined when nothing abstained", () => {
    expect(formatNeedsHumanLine(summary(LEGACY_AGGREGATES))).toBeUndefined();
    expect(formatNeedsHumanLine(summary({ ...LEGACY_AGGREGATES, needsHuman: 0 }))).toBeUndefined();
  });

  test("counts + id-lists the abstained samples for rate follow-up", () => {
    const line = formatNeedsHumanLine(
      summary({
        ...LEGACY_AGGREGATES,
        needsHuman: 2,
        needsHumanSampleIds: ["q3", "q7"],
      }),
    );
    expect(line).toBe(
      "[eval] needs_human=2: q3, q7 — judge abstained; review with `crewhaus rate`",
    );
  });
});

describe("formatLoopMetricsLine (G56)", () => {
  test("undefined on legacy aggregates", () => {
    expect(formatLoopMetricsLine(LEGACY_AGGREGATES)).toBeUndefined();
  });

  test("renders only the present fields", () => {
    expect(formatLoopMetricsLine({ ...LEGACY_AGGREGATES, interventionRate: 0.25 })).toBe(
      "[eval] loop: interventions=25.0%",
    );
  });

  test("full metrics line", () => {
    const line = formatLoopMetricsLine({
      ...LEGACY_AGGREGATES,
      toolCallAccuracy: 0.875,
      interventionRate: 0.1,
      safetyViolations: {
        permissionDenials: 2,
        egressBlocks: 1,
        justificationRejections: 0,
        total: 3,
      },
      p50ModelCallMs: 850.4,
      p95ModelCallMs: 2100.6,
    });
    expect(line).toBe(
      "[eval] loop: tool_accuracy=87.5% interventions=10.0% " +
        "safety_violations=3 (deny 2 / egress 1 / justify 0) model_call p50=850ms p95=2101ms",
    );
  });
});

describe("formatRepeatsLine (G15)", () => {
  test("undefined when the run carried no trials", () => {
    expect(formatRepeatsLine(summary(LEGACY_AGGREGATES))).toBeUndefined();
  });

  test("pass@k + pass^k + all-trials tokens, k from config.repeats", () => {
    const s = summary(
      {
        ...LEGACY_AGGREGATES,
        passAtK: 2 / 3,
        passHatK: 1 / 3,
        totalTokensAllTrials: { input: 300, output: 600 },
      },
      {
        config: {
          specHash: "abc123",
          datasetName: "fixture",
          graderNames: ["exact"],
          model: "claude-opus-4-7",
          concurrency: 4,
          repeats: 3,
        },
      },
    );
    expect(formatRepeatsLine(s)).toBe(
      "[eval] repeats=3: pass@3=66.7% pass^3=33.3% tokens_all_trials=300/600",
    );
  });
});

describe("formatFailureClassesLine (G54)", () => {
  test("undefined when no sample carries a class", () => {
    expect(formatFailureClassesLine([sample("q1")])).toBeUndefined();
  });

  test("tallies classes, sorted by name", () => {
    const line = formatFailureClassesLine([
      sample("q1", { failureClass: "timeout" }),
      sample("q2", { failureClass: "billing" }),
      sample("q3", { failureClass: "timeout" }),
      sample("q4"),
    ]);
    expect(line).toBe("[eval] failure classes: billing=1 timeout=2");
  });
});

describe("formatJudgeCalibrationLines (G47)", () => {
  test("empty without a calibration block", () => {
    expect(formatJudgeCalibrationLines(summary(LEGACY_AGGREGATES).config)).toEqual([]);
  });

  test("one note per applied grader", () => {
    const lines = formatJudgeCalibrationLines({
      specHash: "abc123",
      datasetName: "fixture",
      graderNames: ["quality"],
      model: "claude-opus-4-7",
      concurrency: 4,
      judgeCalibration: {
        path: ".crewhaus/judge-calibration.json",
        applied: [{ grader: "quality", specKey: "support-cli", minScore: 0.7, passingScore: 3.8 }],
      },
    });
    expect(lines).toEqual([
      '[eval] judge calibration (.crewhaus/judge-calibration.json): grader "quality" ' +
        'gated at min_score 0.7 → passing 3.80/5 (key "support-cli")',
    ]);
  });
});

describe("evalRunOutputLines — the full block", () => {
  test("legacy summary prints exactly one line", () => {
    expect(evalRunOutputLines(summary(LEGACY_AGGREGATES), { retriedCount: 0 })).toHaveLength(1);
  });

  test("a fully-loaded Batch B summary prints every section in order", () => {
    const s = summary(
      {
        ...LEGACY_AGGREGATES,
        partialScoreMean: 0.61,
        interventionRate: 0.5,
        passAtK: 1,
        passHatK: 0.5,
      },
      {
        samples: [sample("q1", { failureClass: "timeout", error: "deadline exceeded" })],
        config: {
          specHash: "abc123",
          datasetName: "fixture",
          graderNames: ["quality"],
          model: "claude-opus-4-7",
          concurrency: 4,
          repeats: 2,
          judgeCalibration: {
            path: ".crewhaus/judge-calibration.json",
            applied: [{ grader: "quality", specKey: "default", minScore: 0.5, passingScore: 3 }],
          },
        },
      },
    );
    const lines = evalRunOutputLines(s, { retriedCount: 1 });
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("partial_score=0.610");
    expect(lines[0]).toContain("(1 retried)");
    expect(lines[1]).toContain("[eval] loop: interventions=50.0%");
    expect(lines[2]).toContain("[eval] repeats=2: pass@2=100.0% pass^2=50.0%");
    expect(lines[3]).toBe("[eval] failure classes: timeout=1");
    expect(lines[4]).toContain("judge calibration");
  });

  test("Wave 1 sections slot between repeats and failure classes, in order", () => {
    const s = summary(
      {
        ...LEGACY_AGGREGATES,
        criterionMeans: { quality: { correctness: 4 } },
        needsHuman: 1,
        needsHumanSampleIds: ["q9"],
      },
      {
        samples: [sample("q1", { failureClass: "timeout", error: "deadline exceeded" })],
        slices: { difficulty: { hard: { sampleCount: 3, passRate: 1 / 3, meanScore: 0.4 } } },
      },
    );
    const lines = evalRunOutputLines(s, { retriedCount: 0 });
    expect(lines).toEqual([
      lines[0] as string, // summary line, asserted elsewhere
      "[eval] slice difficulty: hard 33.3% (n=3)",
      "[eval] judge criteria quality: correctness=4",
      "[eval] needs_human=1: q9 — judge abstained; review with `crewhaus rate`",
      "[eval] failure classes: timeout=1",
    ]);
  });
});
