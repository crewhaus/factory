/**
 * Wave 4, cluster T — the two new `[eval]` stdout segments:
 *   C34 the flake block (which samples' trials disagreed, and what to do),
 *   C35 the cost line (agent AND judge spend, through the injected pricing
 *       seam — never a guessed price).
 */
import { describe, expect, test } from "bun:test";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import {
  type EvalCostPricingFn,
  evalRunCost,
  evalRunOutputLines,
  formatCostLine,
  formatFlakyLines,
} from "./eval-output";

function sample(overrides: Partial<SampleResult> & { sampleId: string }): SampleResult {
  return {
    sessionId: `sess-${overrides.sampleId}`,
    startedAt: "2026-07-01T00:00:00.000Z",
    endedAt: "2026-07-01T00:00:01.000Z",
    latencyMs: 1000,
    turns: 1,
    tokens: { input: 100, output: 50 },
    model: "claude-opus-4-7",
    agentOutput: "answer",
    grades: { overall: { passed: true, score: 1, rationale: "ok" }, perGrader: [] },
    ...overrides,
  };
}

function summary(overrides: Partial<EvalRunSummary> = {}): EvalRunSummary {
  return {
    runId: "run_abc",
    startedAt: "2026-07-01T00:00:00.000Z",
    endedAt: "2026-07-01T00:01:00.000Z",
    samples: [sample({ sampleId: "s1" })],
    aggregates: {
      passRate: 1,
      meanScore: 1,
      p50Turns: 1,
      p95Turns: 1,
      p50LatencyMs: 1000,
      p95LatencyMs: 1000,
      totalTokens: { input: 1000, output: 500 },
      errorCount: 0,
    },
    config: {
      specHash: "spec1",
      datasetName: "smoke",
      graderNames: ["m"],
      model: "claude-opus-4-7",
      concurrency: 4,
    },
    outDir: "/abs/evals/run_abc",
    ...overrides,
  };
}

/** $1 per 1k input tokens, $2 per 1k output — in micro-dollars. */
const flatPricing: EvalCostPricingFn = (_model, t) => t.input * 1000 + t.output * 2000;
const nothingPriced: EvalCostPricingFn = () => undefined;

describe("C34 — formatFlakyLines", () => {
  const flakySummary = summary({
    samples: [
      sample({ sampleId: "s1", trialPassRate: 2 / 3, flaky: true }),
      sample({ sampleId: "s2", trialPassRate: 1 / 3, flaky: true }),
      sample({ sampleId: "s3", trialPassRate: 1 }),
    ],
    aggregates: {
      ...summary().aggregates,
      flaky: 2,
      flakySampleIds: ["s2", "s1"],
    },
    config: { ...summary().config, repeats: 3 },
  });

  test("names each flaky sample with its trial tally out of k", () => {
    const [line] = formatFlakyLines(flakySummary);
    expect(line).toContain("[eval] flaky=2/3:");
    expect(line).toContain("s2 (1/3)");
    expect(line).toContain("s1 (2/3)");
    expect(line).toContain("coin flips");
    // The exclusion semantics are stated, like every other attention bucket:
    // needs_human/canary say "excluded", needs_review and flaky say the
    // verdicts still count. Without this a reader infers exclusion.
    expect(line).toContain("verdicts still count");
  });

  test("the suggestion line points at real, runnable follow-ups", () => {
    const [, suggestion] = formatFlakyLines(flakySummary);
    expect(suggestion).toContain("crewhaus eval-report export --runs /abs/evals/run_abc");
    expect(suggestion).toContain("--replay-tools");
    expect(suggestion).toContain("gating dataset version");
  });

  test("a stable (or single-trial) run prints nothing at all", () => {
    expect(formatFlakyLines(summary())).toEqual([]);
    expect(
      formatFlakyLines(summary({ aggregates: { ...summary().aggregates, flaky: 0 } })),
    ).toEqual([]);
  });

  test("falls back to a percentage when the run did not record repeats", () => {
    const noK = summary({
      samples: [sample({ sampleId: "s1", trialPassRate: 0.5 })],
      aggregates: { ...summary().aggregates, flaky: 1, flakySampleIds: ["s1"] },
    });
    expect(formatFlakyLines(noK)[0]).toContain("s1 (50%)");
  });
});

describe("C35 — formatCostLine", () => {
  test("prices agent tokens through the injected seam", () => {
    const line = formatCostLine(summary(), flatPricing);
    // 1000 in × $0.001 + 500 out × $0.002 = $2.0000
    expect(line).toBe("[eval] cost: agent=$2.0000");
  });

  test("adds the judge component and a total when judge spend was metered", () => {
    const withJudge = summary({
      aggregates: {
        ...summary().aggregates,
        judgeUsage: {
          calls: 4,
          tokens: { input: 400, output: 100 },
          byModel: { "claude-sonnet-4-5": { calls: 4, input: 400, output: 100 } },
        },
      },
    });
    const line = formatCostLine(withJudge, flatPricing) ?? "";
    expect(line).toContain("agent=$2.0000");
    expect(line).toContain("judge=$0.6000");
    expect(line).toContain("(4 call(s), 400/100 tokens across 1 model(s))");
    expect(line).toContain("total=$2.6000");
  });

  test("sums a multi-model judge panel", () => {
    const panel = summary({
      aggregates: {
        ...summary().aggregates,
        judgeUsage: {
          calls: 2,
          tokens: { input: 200, output: 100 },
          byModel: {
            "judge-a": { calls: 1, input: 100, output: 50 },
            "judge-b": { calls: 1, input: 100, output: 50 },
          },
        },
      },
    });
    expect(formatCostLine(panel, flatPricing)).toContain("judge=$0.4000");
  });

  test("all-trials tokens are used when the run repeated (the REAL spend)", () => {
    const repeated = summary({
      aggregates: {
        ...summary().aggregates,
        totalTokensAllTrials: { input: 3000, output: 1500 },
      },
    });
    expect(formatCostLine(repeated, flatPricing)).toBe("[eval] cost: agent=$6.0000");
  });

  test("an unpriced model renders n/a — never a fabricated $0.0000", () => {
    const line = formatCostLine(summary(), nothingPriced);
    expect(line).toBeUndefined();
  });

  test("a priced agent + unpriced judge model says which half is unknown", () => {
    const agentOnly: EvalCostPricingFn = (model, t) =>
      model === "claude-opus-4-7" ? t.input * 1000 : undefined;
    const withJudge = summary({
      aggregates: {
        ...summary().aggregates,
        judgeUsage: {
          calls: 1,
          tokens: { input: 10, output: 5 },
          byModel: { "local/mystery": { calls: 1, input: 10, output: 5 } },
        },
      },
    });
    const line = formatCostLine(withJudge, agentOnly) ?? "";
    expect(line).toContain("agent=$1.0000");
    expect(line).toContain("judge=n/a (unpriced judge model)");
    expect(line).not.toContain("total=");
  });

  test("a PARTLY priced judge panel prints no total (an undercount is worse)", () => {
    const oneUnpriced: EvalCostPricingFn = (model, t) =>
      model === "local/mystery" ? undefined : t.input * 1000 + t.output * 2000;
    const withPanel = summary({
      aggregates: {
        ...summary().aggregates,
        judgeUsage: {
          calls: 2,
          tokens: { input: 20, output: 10 },
          byModel: {
            "claude-haiku-4-5": { calls: 1, input: 10, output: 5 },
            "local/mystery": { calls: 1, input: 10, output: 5 },
          },
        },
      },
    });
    const line = formatCostLine(withPanel, oneUnpriced) ?? "";
    expect(line).toContain("1 unpriced model(s)");
    // The gate cannot check this run either (see evalRunCost), so the line
    // must not print a "total" the gate does not have.
    expect(line).not.toContain("total=");
    expect(evalRunCost(withPanel, oneUnpriced).totalMicros).toBeUndefined();
  });
});

describe("C30 × C35 — evalRunCost is the one number printed AND gated", () => {
  const judgeHeavy = summary({
    aggregates: {
      ...summary().aggregates,
      judgeUsage: {
        calls: 3,
        tokens: { input: 2000, output: 1000 },
        byModel: { "claude-haiku-4-5": { calls: 3, input: 2000, output: 1000 } },
      },
    },
  });

  test("the total the line prints is exactly the total the gate would read", () => {
    const cost = evalRunCost(judgeHeavy, flatPricing);
    expect(cost.agentMicros).toBe(1000 * 1000 + 500 * 2000); // $2.0000
    expect(cost.judgeMicros).toBe(2000 * 1000 + 1000 * 2000); // $4.0000
    expect(cost.totalMicros).toBe(6_000_000); // $6.0000
    // …and the printed line says the same $6.0000, so `--max-cost-usd 3`
    // cannot pass a run the user was told cost six dollars.
    expect(formatCostLine(judgeHeavy, flatPricing)).toContain("total=$6.0000");
  });

  test("no judge usage at all ⇒ the total is just the agent half", () => {
    const cost = evalRunCost(summary(), flatPricing);
    expect(cost.judgeMicros).toBeUndefined();
    expect(cost.totalMicros).toBe(cost.agentMicros);
    // The pre-C35 one-component line is unchanged (no `total=` segment).
    expect(formatCostLine(summary(), flatPricing)).not.toContain("total=");
  });

  test("an unpriced AGENT model leaves the total unknown, not zero", () => {
    const judgeOnly: EvalCostPricingFn = (model, t) =>
      model === "claude-opus-4-7" ? undefined : t.input * 1000;
    const cost = evalRunCost(judgeHeavy, judgeOnly);
    expect(cost.judgeMicros).toBe(2_000_000);
    expect(cost.totalMicros).toBeUndefined();
  });
});

describe("evalRunOutputLines integration", () => {
  test("omitting the pricing seam keeps the pre-C35 block", () => {
    const lines = evalRunOutputLines(summary(), { retriedCount: 0 });
    expect(lines.some((l) => l.startsWith("[eval] cost:"))).toBe(false);
  });

  test("with pricing, the cost line rides after the human-attention buckets", () => {
    const lines = evalRunOutputLines(summary(), { retriedCount: 0, pricing: flatPricing });
    expect(lines.some((l) => l.startsWith("[eval] cost: agent=$2.0000"))).toBe(true);
  });

  test("the flake block appears in the block when the run measured instability", () => {
    const flakySummary = summary({
      samples: [sample({ sampleId: "s1", trialPassRate: 0.5, flaky: true })],
      aggregates: { ...summary().aggregates, flaky: 1, flakySampleIds: ["s1"] },
      config: { ...summary().config, repeats: 2 },
    });
    const lines = evalRunOutputLines(flakySummary, { retriedCount: 0 });
    expect(lines.filter((l) => l.startsWith("[eval] flaky"))).toHaveLength(2);
  });
});
