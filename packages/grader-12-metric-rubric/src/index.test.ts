import { describe, expect, test } from "bun:test";
import type { Sample } from "@crewhaus/eval-dataset";
import type { GradeResult, RunResult } from "@crewhaus/eval-grader";
import { GraderRegistry } from "@crewhaus/grader-registry";
import {
  TWELVE_METRIC_SPECS,
  TWELVE_METRIC_THRESHOLDS,
  contextPrecision,
  contextRecall,
  contextRelevance,
  costPerQuery,
  costPerUsefulOutput,
  multiStepCoherence,
  p99LatencyMs,
  register12MetricRubric,
  retrievalLatencyP95,
  summarize12MetricRubric,
  toolExecutionSuccess,
  toolSelectionAccuracy,
} from "./index";

function emptyRun(overrides: Partial<RunResult> = {}): RunResult {
  return {
    agentOutput: "",
    events: [],
    transcript: [],
    toolCalls: [],
    turns: 1,
    latencyMs: 100,
    ...overrides,
  };
}

const sample: Sample = { id: "s1", input: "test query" } as Sample;

describe("toolExecutionSuccess", () => {
  test("passes with no tool calls", async () => {
    const r = await toolExecutionSuccess(sample, emptyRun());
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
  });

  test("computes fraction of non-error calls", async () => {
    const r = await toolExecutionSuccess(
      sample,
      emptyRun({
        toolCalls: [
          { toolName: "Bash", toolUseId: "1", isError: false },
          { toolName: "Bash", toolUseId: "2", isError: true },
          { toolName: "Bash", toolUseId: "3", isError: false },
        ],
      }),
    );
    expect(r.score).toBeCloseTo(2 / 3, 3);
    expect(r.passed).toBe(false); // 2/3 < 0.98
  });

  test("passes at threshold", async () => {
    const calls = Array.from({ length: 100 }, (_, i) => ({
      toolName: "X",
      toolUseId: `${i}`,
      isError: i < 2, // 2 errors / 100 = 0.98 success
    }));
    const r = await toolExecutionSuccess(sample, emptyRun({ toolCalls: calls }));
    expect(r.score).toBeCloseTo(0.98, 5);
    expect(r.passed).toBe(true);
  });
});

describe("multiStepCoherence", () => {
  test("scores 1.0 for ≤6 turns", async () => {
    const r = await multiStepCoherence(sample, emptyRun({ turns: 3 }));
    expect(r.score).toBe(1.0);
    expect(r.passed).toBe(true);
  });

  test("scores 0 for ≥13 turns", async () => {
    const r = await multiStepCoherence(sample, emptyRun({ turns: 15 }));
    expect(r.score).toBe(0);
    expect(r.passed).toBe(false);
  });

  test("scales linearly in 7-12 range", async () => {
    const r = await multiStepCoherence(sample, emptyRun({ turns: 9 }));
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(1);
  });
});

describe("p99LatencyMs", () => {
  test("passes well under threshold", async () => {
    const r = await p99LatencyMs(sample, emptyRun({ latencyMs: 1000 }));
    expect(r.passed).toBe(true);
  });

  test("fails over threshold", async () => {
    const r = await p99LatencyMs(sample, emptyRun({ latencyMs: 5000 }));
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
  });
});

describe("toolSelectionAccuracy", () => {
  test("requires Sample.expectedTool", async () => {
    const r = await toolSelectionAccuracy(sample, emptyRun());
    expect(r.passed).toBe(false);
    expect(r.rationale).toMatch(/expectedTool/);
  });

  test("passes when first tool matches", async () => {
    const s = { ...sample, expectedTool: "Bash" } as Sample;
    const r = await toolSelectionAccuracy(
      s,
      emptyRun({ toolCalls: [{ toolName: "Bash", toolUseId: "1", isError: false }] }),
    );
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
  });

  test("fails when wrong tool", async () => {
    const s = { ...sample, expectedTool: "Bash" } as Sample;
    const r = await toolSelectionAccuracy(
      s,
      emptyRun({ toolCalls: [{ toolName: "Grep", toolUseId: "1", isError: false }] }),
    );
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
  });
});

describe("contextRelevance / contextRecall / contextPrecision", () => {
  test("contextRelevance: 3/3 retrieved in ground truth → score 1.0", async () => {
    const s = {
      ...sample,
      retrievedChunks: ["a", "b", "c"],
      groundTruthChunks: ["a", "b", "c", "d"],
    } as Sample;
    const r = await contextRelevance(s, emptyRun());
    expect(r.score).toBe(1);
    expect(r.passed).toBe(true);
  });

  test("contextRelevance: 1/3 in ground truth → 0.33", async () => {
    const s = {
      ...sample,
      retrievedChunks: ["a", "x", "y"],
      groundTruthChunks: ["a", "b"],
    } as Sample;
    const r = await contextRelevance(s, emptyRun());
    expect(r.score).toBeCloseTo(1 / 3, 3);
    expect(r.passed).toBe(false);
  });

  test("contextRecall: found 2/2 → 1.0", async () => {
    const s = {
      ...sample,
      retrievedChunks: ["a", "b", "c"],
      groundTruthChunks: ["a", "b"],
    } as Sample;
    const r = await contextRecall(s, emptyRun());
    expect(r.score).toBe(1);
  });

  test("contextPrecision: MRR = 1/(rank+1)", async () => {
    const s = {
      ...sample,
      retrievedChunks: ["wrong", "alsowrong", "correct"],
      groundTruthChunks: ["correct"],
    } as Sample;
    const r = await contextPrecision(s, emptyRun());
    expect(r.score).toBeCloseTo(1 / 3, 3);
    expect(r.passed).toBe(false);
  });
});

describe("retrievalLatencyP95 / costPerQuery", () => {
  test("retrievalLatencyP95: passes under threshold", async () => {
    const s = { ...sample, retrievalLatencyMs: 100 } as Sample;
    const r = await retrievalLatencyP95(s, emptyRun());
    expect(r.passed).toBe(true);
  });

  test("costPerQuery: passes under threshold", async () => {
    const s = { ...sample, costUsd: 0.02 } as Sample;
    const r = await costPerQuery(s, emptyRun());
    expect(r.passed).toBe(true);
  });

  test("costPerQuery: fails over threshold", async () => {
    const s = { ...sample, costUsd: 0.5 } as Sample;
    const r = await costPerQuery(s, emptyRun());
    expect(r.passed).toBe(false);
  });
});

describe("register12MetricRubric", () => {
  test("registers all 12 metrics", () => {
    const reg = new GraderRegistry();
    const names = register12MetricRubric(reg);
    expect(names.length).toBe(12);
    for (const name of names) expect(reg.has(name)).toBe(true);
  });

  test("idempotent — re-registering doesn't throw", () => {
    const reg = new GraderRegistry();
    register12MetricRubric(reg);
    expect(() => register12MetricRubric(reg)).not.toThrow();
  });
});

describe("TWELVE_METRIC_SPECS", () => {
  test("has 12 entries", () => {
    expect(TWELVE_METRIC_SPECS.length).toBe(12);
  });

  test("4 retrieval + 3 generation + 3 agent + 2 production", () => {
    const counts: Record<string, number> = {};
    for (const s of TWELVE_METRIC_SPECS) {
      counts[s.category] = (counts[s.category] ?? 0) + 1;
    }
    expect(counts["retrieval"]).toBe(4);
    expect(counts["generation"]).toBe(3);
    expect(counts["agent"]).toBe(3);
    expect(counts["production"]).toBe(2);
  });

  test("thresholds match TDS paper", () => {
    expect(TWELVE_METRIC_THRESHOLDS.contextRelevance).toBe(0.85);
    expect(TWELVE_METRIC_THRESHOLDS.toolExecutionSuccess).toBe(0.98);
    expect(TWELVE_METRIC_THRESHOLDS.p99LatencyMs).toBe(3000);
    expect(TWELVE_METRIC_THRESHOLDS.costPerQueryUsd).toBe(0.05);
  });
});

describe("summarize12MetricRubric", () => {
  test("folds per-sample results into category roll-ups", () => {
    const r = (s: number, p: boolean): GradeResult => ({
      passed: p,
      score: s,
      rationale: "",
    });
    const summary = summarize12MetricRubric({
      "twelve.toolExecutionSuccess": [r(1, true), r(1, true), r(0.9, false)],
      "twelve.p99LatencyMs": [r(0.8, true), r(0.7, false)],
    });
    const tes = summary.metrics.find((m) => m.name === "twelve.toolExecutionSuccess");
    expect(tes?.count).toBe(3);
    expect(tes?.mean).toBeCloseTo((1 + 1 + 0.9) / 3, 5);
    expect(tes?.passFraction).toBeCloseTo(2 / 3, 5);
    expect(summary.byCategory.agent.length).toBeGreaterThan(0);
  });

  test("flags threshold breaches", () => {
    const r = (s: number, p: boolean): GradeResult => ({
      passed: p,
      score: s,
      rationale: "",
    });
    const summary = summarize12MetricRubric({
      "twelve.toolExecutionSuccess": [r(0.5, false), r(0.5, false)],
    });
    const tes = summary.metrics.find((m) => m.name === "twelve.toolExecutionSuccess");
    expect(tes?.thresholdBreach).toBe(true);
    expect(summary.breaches).toBeGreaterThan(0);
  });

  test("computes p99 from raw scores", () => {
    const r = (s: number): GradeResult => ({ passed: true, score: s, rationale: "" });
    const scores = Array.from({ length: 100 }, (_, i) => r((i + 1) / 100));
    const summary = summarize12MetricRubric({ "twelve.p99LatencyMs": scores });
    const p99 = summary.metrics.find((m) => m.name === "twelve.p99LatencyMs")?.p99 ?? 0;
    expect(p99).toBeGreaterThanOrEqual(0.95);
  });
});

describe("costPerUsefulOutput", () => {
  test("returns total / useful count", () => {
    const out = costPerUsefulOutput({
      totalCostUsd: 10,
      sampleCount: 20,
      perSampleMetricPassRates: [0.8, 0.9, 0.4, 0.6, 0.3], // 3 useful (≥0.5)
    });
    expect(out).toBeCloseTo(10 / 3, 5);
  });

  test("infinite when no sample is useful", () => {
    const out = costPerUsefulOutput({
      totalCostUsd: 10,
      sampleCount: 5,
      perSampleMetricPassRates: [0.1, 0.2, 0.0, 0.3, 0.4],
    });
    expect(out).toBe(Number.POSITIVE_INFINITY);
  });

  test("custom usefulness threshold", () => {
    const out = costPerUsefulOutput({
      totalCostUsd: 5,
      sampleCount: 10,
      perSampleMetricPassRates: [0.9, 0.86, 0.7],
      usefulnessThreshold: 0.85,
    });
    // 2 samples pass ≥0.85 (0.9 and 0.86)
    expect(out).toBeCloseTo(5 / 2, 5);
  });
});
