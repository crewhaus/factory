/**
 * Pillar 2 canonical eval rubric — the 12-metric framework from Towards
 * Data Science's "Building an Evaluation Harness for Production AI Agents:
 * A 12-Metric Framework From 100+ Deployments" (2026-05). Surfaces a named
 * grader bundle and the industry-validated thresholds the paper documents.
 *
 *   Retrieval (4):  Context Relevance >0.85, Context Recall >0.90,
 *                   Context Precision (MRR) >0.80, Retrieval Latency <200ms p95
 *   Generation (3): Answer Faithfulness >0.95, Answer Relevance >0.90,
 *                   Hallucination Rate <2%
 *   Agent (3):      Tool Selection Accuracy >0.92, Tool Execution Success >0.98,
 *                   Multi-Step Coherence >0.85
 *   Production (2): Cost per Query <$0.05, P99 Latency <3s
 *
 * The rubric ships as a function `register12MetricRubric(registry)` that
 * installs each metric under its canonical name (`twelve.contextRelevance`,
 * `twelve.toolExecutionSuccess`, etc.). Some metrics are directly
 * computable from `RunResult` (tool execution success, multi-step
 * coherence, p99 latency). Some require dataset extensions (context
 * relevance/recall/precision need ground-truth retrieved chunks; tool
 * selection accuracy needs an `expectedTool` field on the Sample). For
 * the latter, this package ships stubs that return `passed: false` with a
 * rationale describing the missing field — they fail loudly rather than
 * silently passing, so authors see what they need to wire.
 *
 * Cross-sample roll-ups (p50/p95/p99 latency, costPerUsefulOutput) are
 * not graders — they're aggregators that fold a `ReadonlyArray<GradeResult>`
 * into a category-roll-up summary. See `summarize12MetricRubric` below.
 *
 * Catalog layer: R-eval. Recipes: demos/recipes/12-eval-harness.md and
 * demos/recipes/34-building-custom-graders.md.
 */
import type { Sample } from "@crewhaus/eval-dataset";
import type { GradeResult, Grader, RunResult } from "@crewhaus/eval-grader";
import type { GraderRegistry } from "@crewhaus/grader-registry";

/**
 * Industry-validated thresholds from the TDS paper. Exported so eval-judge
 * and eval-report can render them next to observed scores without
 * duplicating the numbers.
 */
export const TWELVE_METRIC_THRESHOLDS = Object.freeze({
  // Retrieval — 4 metrics
  contextRelevance: 0.85,
  contextRecall: 0.9,
  contextPrecision: 0.8, // MRR floor
  retrievalLatencyP95Ms: 200,
  // Generation — 3 metrics
  answerFaithfulness: 0.95,
  answerRelevance: 0.9,
  hallucinationRate: 0.02, // upper-bound, not lower
  // Agent — 3 metrics
  toolSelectionAccuracy: 0.92,
  toolExecutionSuccess: 0.98,
  multiStepCoherence: 0.85,
  // Production — 2 metrics
  costPerQueryUsd: 0.05, // upper-bound
  p99LatencyMs: 3000, // upper-bound
});

export type TwelveMetricCategory = "retrieval" | "generation" | "agent" | "production";

/**
 * Metric metadata — name, category, threshold, and whether higher-is-better
 * (most metrics) or lower-is-better (hallucination rate, cost, latency).
 */
export type TwelveMetricSpec = {
  readonly name: string;
  readonly category: TwelveMetricCategory;
  readonly threshold: number;
  /** True for ≥-threshold; false for ≤-threshold (latency, cost, hallucination). */
  readonly higherIsBetter: boolean;
};

export const TWELVE_METRIC_SPECS: ReadonlyArray<TwelveMetricSpec> = Object.freeze([
  { name: "twelve.contextRelevance", category: "retrieval", threshold: 0.85, higherIsBetter: true },
  { name: "twelve.contextRecall", category: "retrieval", threshold: 0.9, higherIsBetter: true },
  { name: "twelve.contextPrecision", category: "retrieval", threshold: 0.8, higherIsBetter: true },
  {
    name: "twelve.retrievalLatencyP95Ms",
    category: "retrieval",
    threshold: 200,
    higherIsBetter: false,
  },
  {
    name: "twelve.answerFaithfulness",
    category: "generation",
    threshold: 0.95,
    higherIsBetter: true,
  },
  { name: "twelve.answerRelevance", category: "generation", threshold: 0.9, higherIsBetter: true },
  {
    name: "twelve.hallucinationRate",
    category: "generation",
    threshold: 0.02,
    higherIsBetter: false,
  },
  {
    name: "twelve.toolSelectionAccuracy",
    category: "agent",
    threshold: 0.92,
    higherIsBetter: true,
  },
  { name: "twelve.toolExecutionSuccess", category: "agent", threshold: 0.98, higherIsBetter: true },
  { name: "twelve.multiStepCoherence", category: "agent", threshold: 0.85, higherIsBetter: true },
  {
    name: "twelve.costPerQueryUsd",
    category: "production",
    threshold: 0.05,
    higherIsBetter: false,
  },
  { name: "twelve.p99LatencyMs", category: "production", threshold: 3000, higherIsBetter: false },
]);

// ─── Directly-computable graders ──────────────────────────────────────────

/**
 * Tool Execution Success — fraction of tool calls that returned without
 * isError=true. Threshold: ≥0.98 means systematic argument-construction is
 * solid.
 */
export const toolExecutionSuccess: Grader = async (_sample, run) => {
  if (run.toolCalls.length === 0) {
    return {
      passed: true,
      score: 1,
      rationale: "no tool calls in this run (vacuously 100% success)",
    };
  }
  const ok = run.toolCalls.filter((tc) => !tc.isError).length;
  const score = ok / run.toolCalls.length;
  return {
    passed: score >= TWELVE_METRIC_THRESHOLDS.toolExecutionSuccess,
    score,
    rationale: `${ok}/${run.toolCalls.length} tool calls succeeded (threshold ≥${TWELVE_METRIC_THRESHOLDS.toolExecutionSuccess})`,
  };
};

/**
 * Multi-Step Coherence — proxy: agent finished within an expected turn
 * count without producing tool-call loops. The TDS paper's coherence
 * metric is LLM-judged; this is a structural proxy that doesn't need
 * an LLM and catches the egregious failures (agent thrashing across
 * 12+ turns, forgetting prior results) deterministically.
 *
 * Threshold maps as: a run with ≤6 turns scores 1.0; 7–12 scales linearly
 * to 0.5; 13+ scores 0. Threshold-pass: score ≥0.85 = ≤7 turns.
 */
export const multiStepCoherence: Grader = async (_sample, run) => {
  const turns = run.turns;
  let score: number;
  if (turns <= 6) score = 1.0;
  else if (turns >= 13) score = 0;
  else score = 1.0 - (turns - 6) / 14;
  return {
    passed: score >= TWELVE_METRIC_THRESHOLDS.multiStepCoherence,
    score,
    rationale: `${turns} turns → coherence proxy ${score.toFixed(2)} (threshold ≥${TWELVE_METRIC_THRESHOLDS.multiStepCoherence}; LLM-judge variant available via 'twelve.multiStepCoherence.llm' when wired)`,
  };
};

/**
 * P99 Latency — per-sample reading of `run.latencyMs` against the upper
 * bound. Cross-sample p99 roll-up lives in `summarize12MetricRubric`.
 */
export const p99LatencyMs: Grader = async (_sample, run) => {
  const ms = run.latencyMs;
  const pass = ms <= TWELVE_METRIC_THRESHOLDS.p99LatencyMs;
  // Score is linear in remaining headroom relative to threshold; ≤ ½
  // threshold scores 1.0, exactly threshold scores 0.5, ≥ 2× threshold
  // scores 0.
  const ratio = ms / TWELVE_METRIC_THRESHOLDS.p99LatencyMs;
  const score = Math.max(0, Math.min(1, 1.0 - (ratio - 0.5)));
  return {
    passed: pass,
    score,
    rationale: `${ms.toFixed(0)} ms (upper-bound ≤${TWELVE_METRIC_THRESHOLDS.p99LatencyMs} ms)`,
  };
};

// ─── Sample-extension-dependent stubs ─────────────────────────────────────

/**
 * The TDS framework expects Sample to carry retrieval ground truth and
 * the expected first-tool-call. CrewHaus's Sample doesn't enforce those
 * fields, so the rubric ships these as opt-in: an author who fills out the
 * `expectedTool` / `groundTruthChunks` keys gets a real verdict; an author
 * who leaves them out gets a fail with a clear "supply this field" message.
 */

type SampleWithExpectations = Sample & {
  readonly expectedTool?: string;
  readonly groundTruthChunks?: ReadonlyArray<string>;
  readonly retrievedChunks?: ReadonlyArray<string>;
  readonly retrievalLatencyMs?: number;
  readonly costUsd?: number;
};

function missingField(field: string, metric: string): GradeResult {
  return {
    passed: false,
    score: 0,
    rationale: `${metric} requires Sample.${field}; supply it in your dataset to get a real verdict (see demos/recipes/12-eval-harness.md)`,
  };
}

/**
 * Tool Selection Accuracy — did the agent's first tool call match the
 * expected tool for this query? Binary per sample; folded to mean across
 * samples by the aggregator.
 */
export const toolSelectionAccuracy: Grader = async (sample, run) => {
  const expected = (sample as SampleWithExpectations).expectedTool;
  if (expected === undefined) return missingField("expectedTool", "twelve.toolSelectionAccuracy");
  const first = run.toolCalls[0];
  if (first === undefined) {
    return {
      passed: false,
      score: 0,
      rationale: `expected first tool "${expected}", agent made no tool calls`,
    };
  }
  const matched = first.toolName === expected;
  return {
    passed: matched,
    score: matched ? 1 : 0,
    rationale: matched
      ? `first tool call was "${expected}" (correct)`
      : `expected "${expected}", got "${first.toolName}"`,
  };
};

/**
 * Context Relevance — fraction of retrieved chunks that are in the
 * sample's ground-truth set. Binary-set version of the TDS LLM-judge
 * scoring (the paper's metric averages an LLM 0–1 relevance score per
 * chunk; that requires a judge model and is a v0.3 follow-up — until
 * then, set-overlap is the deterministic substitute that catches the
 * common "retriever returned the wrong chunks" failure).
 */
export const contextRelevance: Grader = async (sample, _run) => {
  const ext = sample as SampleWithExpectations;
  if (ext.retrievedChunks === undefined)
    return missingField("retrievedChunks", "twelve.contextRelevance");
  if (ext.groundTruthChunks === undefined)
    return missingField("groundTruthChunks", "twelve.contextRelevance");
  if (ext.retrievedChunks.length === 0) {
    return { passed: false, score: 0, rationale: "no chunks retrieved" };
  }
  const gtSet = new Set(ext.groundTruthChunks);
  const relevant = ext.retrievedChunks.filter((c) => gtSet.has(c)).length;
  const score = relevant / ext.retrievedChunks.length;
  return {
    passed: score >= TWELVE_METRIC_THRESHOLDS.contextRelevance,
    score,
    rationale: `${relevant}/${ext.retrievedChunks.length} retrieved chunks in ground truth (set-overlap proxy; LLM-judge variant ≥v0.3)`,
  };
};

/**
 * Context Recall — fraction of ground-truth chunks retrieved.
 */
export const contextRecall: Grader = async (sample, _run) => {
  const ext = sample as SampleWithExpectations;
  if (ext.retrievedChunks === undefined)
    return missingField("retrievedChunks", "twelve.contextRecall");
  if (ext.groundTruthChunks === undefined)
    return missingField("groundTruthChunks", "twelve.contextRecall");
  if (ext.groundTruthChunks.length === 0) {
    return { passed: true, score: 1, rationale: "ground truth empty (vacuously 100% recall)" };
  }
  const rSet = new Set(ext.retrievedChunks);
  const found = ext.groundTruthChunks.filter((c) => rSet.has(c)).length;
  const score = found / ext.groundTruthChunks.length;
  return {
    passed: score >= TWELVE_METRIC_THRESHOLDS.contextRecall,
    score,
    rationale: `${found}/${ext.groundTruthChunks.length} ground-truth chunks retrieved`,
  };
};

/**
 * Context Precision — Mean Reciprocal Rank of the first ground-truth chunk
 * in the retrieved-chunks list. Approximates the TDS paper's MRR metric.
 */
export const contextPrecision: Grader = async (sample, _run) => {
  const ext = sample as SampleWithExpectations;
  if (ext.retrievedChunks === undefined)
    return missingField("retrievedChunks", "twelve.contextPrecision");
  if (ext.groundTruthChunks === undefined)
    return missingField("groundTruthChunks", "twelve.contextPrecision");
  const gtSet = new Set(ext.groundTruthChunks);
  const rank = ext.retrievedChunks.findIndex((c) => gtSet.has(c));
  if (rank === -1) {
    return { passed: false, score: 0, rationale: "no ground-truth chunk found in retrieved list" };
  }
  const score = 1 / (rank + 1);
  return {
    passed: score >= TWELVE_METRIC_THRESHOLDS.contextPrecision,
    score,
    rationale: `first ground-truth chunk at rank ${rank + 1} (MRR = ${score.toFixed(3)})`,
  };
};

/**
 * Retrieval Latency — sample-level reading against the p95 threshold.
 * Cross-sample p95 lives in the aggregator.
 */
export const retrievalLatencyP95: Grader = async (sample, _run) => {
  const ext = sample as SampleWithExpectations;
  if (ext.retrievalLatencyMs === undefined)
    return missingField("retrievalLatencyMs", "twelve.retrievalLatencyP95Ms");
  const ms = ext.retrievalLatencyMs;
  const pass = ms <= TWELVE_METRIC_THRESHOLDS.retrievalLatencyP95Ms;
  return {
    passed: pass,
    score: pass ? 1 - ms / (TWELVE_METRIC_THRESHOLDS.retrievalLatencyP95Ms * 2) : 0,
    rationale: `${ms} ms (upper-bound p95 ≤${TWELVE_METRIC_THRESHOLDS.retrievalLatencyP95Ms} ms)`,
  };
};

/**
 * Cost per Query — per-sample reading against the USD-cents threshold.
 */
export const costPerQuery: Grader = async (sample, _run) => {
  const ext = sample as SampleWithExpectations;
  if (ext.costUsd === undefined) return missingField("costUsd", "twelve.costPerQueryUsd");
  const usd = ext.costUsd;
  const pass = usd <= TWELVE_METRIC_THRESHOLDS.costPerQueryUsd;
  return {
    passed: pass,
    score: pass ? 1 - usd / (TWELVE_METRIC_THRESHOLDS.costPerQueryUsd * 2) : 0,
    rationale: `$${usd.toFixed(4)} (upper-bound ≤$${TWELVE_METRIC_THRESHOLDS.costPerQueryUsd})`,
  };
};

// ─── LLM-judge-dependent stubs ────────────────────────────────────────────

/**
 * Answer Faithfulness, Answer Relevance, Hallucination Rate require an
 * LLM-as-judge to extract atomic claims (faithfulness) or paraphrased
 * questions (relevance) or fact-check against context (hallucination).
 *
 * The TDS paper's recommendation is GPT-4 for high-stakes, Claude Sonnet
 * for cost-sensitive, Llama 3 70B for self-hosted. CrewHaus's eval-judge
 * supplies the model via `eval-runner`'s judge-model config; this package
 * exposes the metric *names* and threshold constants, but the actual
 * judge implementations live in `grader-semantic-similarity` and
 * `grader-safety-classifiers` and get wired via `register12MetricRubric`
 * when those graders are available.
 */
const llmJudgeStub =
  (metric: string): Grader =>
  async () => ({
    passed: false,
    score: 0,
    rationale: `${metric} requires an LLM-judge grader; install grader-semantic-similarity + grader-safety-classifiers and pass --rubric=12-metric to wire them through eval-judge`,
  });

export const answerFaithfulness: Grader = llmJudgeStub("twelve.answerFaithfulness");
export const answerRelevance: Grader = llmJudgeStub("twelve.answerRelevance");
export const hallucinationRate: Grader = llmJudgeStub("twelve.hallucinationRate");

// ─── Registry installer ───────────────────────────────────────────────────

/**
 * Register all 12 metrics with a `GraderRegistry`. The directly-computable
 * graders work out of the box; the stubs return rationales that explain
 * which Sample fields or which adjacent packages must be wired to get a
 * real verdict.
 *
 * Returns the names registered, for confirmation in `eval-judge`.
 */
export function register12MetricRubric(registry: GraderRegistry): ReadonlyArray<string> {
  const entries: ReadonlyArray<readonly [string, Grader]> = [
    ["twelve.contextRelevance", contextRelevance],
    ["twelve.contextRecall", contextRecall],
    ["twelve.contextPrecision", contextPrecision],
    ["twelve.retrievalLatencyP95Ms", retrievalLatencyP95],
    ["twelve.answerFaithfulness", answerFaithfulness],
    ["twelve.answerRelevance", answerRelevance],
    ["twelve.hallucinationRate", hallucinationRate],
    ["twelve.toolSelectionAccuracy", toolSelectionAccuracy],
    ["twelve.toolExecutionSuccess", toolExecutionSuccess],
    ["twelve.multiStepCoherence", multiStepCoherence],
    ["twelve.costPerQueryUsd", costPerQuery],
    ["twelve.p99LatencyMs", p99LatencyMs],
  ];
  for (const [name, grader] of entries) {
    if (!registry.has(name)) registry.register(name, grader);
  }
  return entries.map(([n]) => n);
}

// ─── Cross-sample roll-up ─────────────────────────────────────────────────

/**
 * Per-metric summary across the full eval-set. `passed` is the fraction of
 * samples that passed the threshold; `mean` is the average score; `count`
 * is the sample count. Percentile fields are populated only for latency
 * and cost — they're meaningless for the {0, 1} accuracy metrics.
 */
export type MetricSummary = {
  readonly name: string;
  readonly category: TwelveMetricCategory;
  readonly threshold: number;
  readonly higherIsBetter: boolean;
  readonly count: number;
  readonly mean: number;
  readonly passFraction: number;
  readonly thresholdBreach: boolean;
  /** p50/p95/p99 of the raw scores. Only meaningful for continuous metrics
   *  (latency, cost); for {0, 1} accuracy metrics these match the mean. */
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
};

export type RubricSummary = {
  readonly metrics: ReadonlyArray<MetricSummary>;
  readonly byCategory: Readonly<Record<TwelveMetricCategory, ReadonlyArray<MetricSummary>>>;
  /** Number of metrics whose mean breached the threshold. */
  readonly breaches: number;
  /** Overall pass rate (mean of metric.passFraction). */
  readonly overall: number;
};

function percentile(values: ReadonlyArray<number>, p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx] ?? 0;
}

/**
 * Fold per-sample `GradeResult`s keyed by metric name into a `RubricSummary`.
 * `byMetric` is the structure produced by `eval-runner` when running with
 * `--rubric 12-metric`: outer key = metric name, value = ordered list of
 * per-sample results.
 */
export function summarize12MetricRubric(
  byMetric: Readonly<Record<string, ReadonlyArray<GradeResult>>>,
): RubricSummary {
  const metrics: MetricSummary[] = [];
  const byCategory: Record<TwelveMetricCategory, MetricSummary[]> = {
    retrieval: [],
    generation: [],
    agent: [],
    production: [],
  };
  for (const spec of TWELVE_METRIC_SPECS) {
    const results = byMetric[spec.name] ?? [];
    const count = results.length;
    const scores = results.map((r) => r.score);
    const mean = count === 0 ? 0 : scores.reduce((a, b) => a + b, 0) / count;
    const passed = results.filter((r) => r.passed).length;
    const passFraction = count === 0 ? 0 : passed / count;
    const thresholdBreach = spec.higherIsBetter ? mean < spec.threshold : mean > spec.threshold;
    const summary: MetricSummary = {
      name: spec.name,
      category: spec.category,
      threshold: spec.threshold,
      higherIsBetter: spec.higherIsBetter,
      count,
      mean,
      passFraction,
      thresholdBreach,
      p50: percentile(scores, 0.5),
      p95: percentile(scores, 0.95),
      p99: percentile(scores, 0.99),
    };
    metrics.push(summary);
    byCategory[spec.category].push(summary);
  }
  const breaches = metrics.filter((m) => m.thresholdBreach).length;
  const overall = metrics.reduce((acc, m) => acc + m.passFraction, 0) / metrics.length;
  return {
    metrics,
    byCategory: {
      retrieval: byCategory.retrieval,
      generation: byCategory.generation,
      agent: byCategory.agent,
      production: byCategory.production,
    },
    breaches,
    overall,
  };
}

/**
 * Cost per Useful Output — `costPerUsefulOutput = totalCost / (passedResults)`.
 * "Useful" = a sample whose threshold-pass count exceeds the supplied
 * pass-quota (defaults to 0.5, i.e. ≥6 of 12 metrics pass). The TDS paper's
 * key insight: $0.05/query that produces garbage is more expensive than
 * $0.50/query that solves the problem.
 */
export function costPerUsefulOutput(opts: {
  readonly totalCostUsd: number;
  readonly sampleCount: number;
  readonly perSampleMetricPassRates: ReadonlyArray<number>;
  readonly usefulnessThreshold?: number;
}): number {
  const t = opts.usefulnessThreshold ?? 0.5;
  const useful = opts.perSampleMetricPassRates.filter((r) => r >= t).length;
  if (useful === 0) return Number.POSITIVE_INFINITY;
  return opts.totalCostUsd / useful;
}
