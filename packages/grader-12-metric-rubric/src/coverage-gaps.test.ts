/**
 * Branch-coverage closure for index.ts — exercises the failure/edge paths the
 * happy-path suite in index.test.ts doesn't reach: missing-tool-call branches,
 * empty-chunk-set branches, the factuality graders' empty-run paths, the
 * registry skip-when-present branch, and the empty-input aggregator path
 * (percentile of [] and the count===0 ternaries in summarize12MetricRubric).
 *
 * Same conventions as index.test.ts: bun:test, a local emptyRun() builder, and
 * Sample literals cast through `as Sample` for the opt-in expectation fields.
 */
import { describe, expect, test } from "bun:test";
import type { Sample } from "@crewhaus/eval-dataset";
import type { GradeResult, Grader, RunResult } from "@crewhaus/eval-grader";
import { GraderRegistry } from "@crewhaus/grader-registry";
import {
  type RubricSummary,
  answerFaithfulness,
  answerRelevance,
  contextPrecision,
  contextRecall,
  contextRelevance,
  hallucinationRate,
  register12MetricRubric,
  summarize12MetricRubric,
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

describe("toolSelectionAccuracy — no tool calls but expectation present", () => {
  test("fails with 'made no tool calls' rationale when toolCalls is empty", async () => {
    const s = { ...sample, expectedTool: "Bash" } as Sample;
    const r = await toolSelectionAccuracy(s, emptyRun({ toolCalls: [] }));
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
    expect(r.rationale).toContain("agent made no tool calls");
    expect(r.rationale).toContain("Bash");
  });
});

describe("contextRelevance — empty retrieved set", () => {
  test("returns 'no chunks retrieved' when retrievedChunks is empty", async () => {
    const s = {
      ...sample,
      retrievedChunks: [],
      groundTruthChunks: ["a", "b"],
    } as Sample;
    const r = await contextRelevance(s, emptyRun());
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
    expect(r.rationale).toBe("no chunks retrieved");
  });
});

describe("contextRecall — empty ground truth", () => {
  test("is vacuously 1.0 when groundTruthChunks is empty", async () => {
    const s = {
      ...sample,
      retrievedChunks: ["a", "b"],
      groundTruthChunks: [],
    } as Sample;
    const r = await contextRecall(s, emptyRun());
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
    expect(r.rationale).toContain("vacuously");
  });
});

describe("contextPrecision — no ground-truth chunk in retrieved list", () => {
  test("scores 0 when none of the retrieved chunks are ground truth", async () => {
    const s = {
      ...sample,
      retrievedChunks: ["x", "y", "z"],
      groundTruthChunks: ["a"],
    } as Sample;
    const r = await contextPrecision(s, emptyRun());
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
    expect(r.rationale).toBe("no ground-truth chunk found in retrieved list");
  });
});

describe("factuality graders on an empty run", () => {
  test("answerFaithfulness: zero claims + zero evidence is a vacuous pass", async () => {
    const r = await answerFaithfulness(sample, emptyRun());
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
    expect(r.rationale).toContain("vacuous");
  });

  test("hallucinationRate: zero claims + zero evidence is a vacuous pass at rate 0", async () => {
    const r = await hallucinationRate(sample, emptyRun());
    expect(r.passed).toBe(true);
    expect(r.score).toBe(0);
    expect(r.rationale).toContain("vacuous");
  });

  test("answerRelevance: an empty answer covers none of the question", async () => {
    const r = await answerRelevance(sample, emptyRun());
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
  });
});

describe("register12MetricRubric — skips already-registered names", () => {
  test("does not overwrite a grader already present under a rubric name", () => {
    const reg = new GraderRegistry();
    const sentinel: Grader = async () => ({
      passed: true,
      score: 0.123,
      rationale: "pre-existing sentinel grader",
    });
    // Pre-register one of the 12 names so the `if (!registry.has(name))`
    // guard takes its false branch for that entry.
    reg.register("twelve.toolExecutionSuccess", sentinel);

    const names = register12MetricRubric(reg);
    expect(names).toContain("twelve.toolExecutionSuccess");
    // The sentinel must survive — register12MetricRubric must not clobber it.
    expect(reg.lookup("twelve.toolExecutionSuccess")).toBe(sentinel);
  });
});

describe("summarize12MetricRubric — empty input", () => {
  test("every metric is zeroed and no breaches/percentiles blow up", () => {
    const summary: RubricSummary = summarize12MetricRubric({});
    expect(summary.metrics.length).toBe(12);
    for (const m of summary.metrics) {
      expect(m.count).toBe(0);
      expect(m.mean).toBe(0);
      expect(m.passFraction).toBe(0);
      // percentile([]) must short-circuit to 0 rather than index NaN.
      expect(m.p50).toBe(0);
      expect(m.p95).toBe(0);
      expect(m.p99).toBe(0);
    }
    // higher-is-better metrics: mean 0 < threshold ⇒ breach; lower-is-better:
    // mean 0 ≤ threshold ⇒ no breach. So breaches == count of higher-is-better.
    const higherCount = summary.metrics.filter((m) => m.higherIsBetter).length;
    expect(summary.breaches).toBe(higherCount);
    expect(summary.overall).toBe(0);
  });
});
