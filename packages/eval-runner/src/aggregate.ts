import type { EvalAggregates, SafetyViolationCounts, SampleResult } from "./types";

export function quantile(sorted: ReadonlyArray<number>, q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] ?? 0;
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo] ?? 0;
  const fract = idx - lo;
  return (sorted[lo] ?? 0) * (1 - fract) + (sorted[hi] ?? 0) * fract;
}

const ZERO_SAFETY: SafetyViolationCounts = {
  permissionDenials: 0,
  egressBlocks: 0,
  justificationRejections: 0,
  total: 0,
};

/**
 * Retry honesty (RunEvalOptions.retryErrors): a retried sample appears in
 * `samples` exactly ONCE — the retry REPLACED the errored first attempt —
 * so passRate's denominator still counts each dataset sample once. A retry
 * that passes counts as a normal pass; a retry that errors again lands in
 * `errorCount` (and, like every errored sample, drags passRate down while
 * staying out of meanScore/latency/token aggregates). The discarded first
 * attempt is counted nowhere, by design: it was infra noise, not a result.
 *
 * Trials honesty (G15, RunEvalOptions.repeats): every pre-existing field is
 * computed over the CANONICAL results only (each sample's trial 1), so a
 * `repeats: 4` run stays directly comparable with a single-trial run on
 * passRate/meanScore/latency/tokens. The trials feed exactly three additive
 * fields — `passAtK` (any trial passed), `passHatK` (ALL trials passed —
 * tau-bench's pass^k: with k i.i.d. trials per sample, the mean over
 * samples of [all k pass] estimates the probability that k consecutive
 * runs all succeed) and `totalTokensAllTrials` (the real k× spend). An
 * errored trial counts as a failed trial: a crash is not a pass.
 *
 * G56 metrics are computed from the canonical samples' `metrics` blocks
 * (absent on results persisted by older CLIs — treated as no data, never a
 * crash): `partialScoreMean` averages overall.score over ALL samples
 * (errored ones score 0; stable denominator, unlike ok-only `meanScore`),
 * `interventionRate` is the fraction of samples with ≥ 1 resolved ask,
 * `safetyViolations` sums the per-sample disjoint counts, the model-call
 * percentiles pool every individual `model_response` duration, and
 * `toolCallAccuracy` averages coverage over the samples that declare
 * `expected_tools` (absent when none do).
 */
export function aggregate(samples: ReadonlyArray<SampleResult>): EvalAggregates {
  const ok = samples.filter((s) => s.error === undefined);
  const total = samples.length;
  const passed = ok.filter((s) => s.grades.overall.passed).length;
  const meanScore =
    ok.length === 0 ? 0 : ok.reduce((sum, s) => sum + s.grades.overall.score, 0) / ok.length;
  const turnsSorted = ok.map((s) => s.turns).sort((a, b) => a - b);
  const latSorted = ok.map((s) => s.latencyMs).sort((a, b) => a - b);
  const totalTokens = ok.reduce(
    (acc, s) => ({
      input: acc.input + s.tokens.input,
      output: acc.output + s.tokens.output,
    }),
    { input: 0, output: 0 },
  );

  // G56 — loop-quality metrics over the canonical samples.
  const partialScoreMean =
    total === 0 ? 0 : samples.reduce((sum, s) => sum + s.grades.overall.score, 0) / total;
  const intervened = samples.filter((s) => (s.metrics?.interventions ?? 0) > 0).length;
  const interventionRate = total === 0 ? 0 : intervened / total;
  const safetyViolations = samples.reduce<SafetyViolationCounts>((acc, s) => {
    const v = s.metrics?.safetyViolations;
    if (v === undefined) return acc;
    return {
      permissionDenials: acc.permissionDenials + v.permissionDenials,
      egressBlocks: acc.egressBlocks + v.egressBlocks,
      justificationRejections: acc.justificationRejections + v.justificationRejections,
      total: acc.total + v.total,
    };
  }, ZERO_SAFETY);
  const modelCallSorted = samples
    .flatMap((s) => s.metrics?.modelCallLatenciesMs ?? [])
    .sort((a, b) => a - b);
  const covered = samples
    .map((s) => s.metrics?.toolCallAccuracy)
    .filter((v): v is number => v !== undefined);
  const toolCallAccuracy =
    covered.length === 0 ? undefined : covered.reduce((a, b) => a + b, 0) / covered.length;

  // G15 — pass@k / pass^k, present only when the run carried trials.
  const hasTrials = samples.some((s) => s.trials !== undefined && s.trials.length > 0);
  let passAtK: number | undefined;
  let passHatK: number | undefined;
  let totalTokensAllTrials: { input: number; output: number } | undefined;
  if (hasTrials && total > 0) {
    const anyPass = (s: SampleResult): boolean =>
      s.trials !== undefined && s.trials.length > 0
        ? s.trials.some((t) => t.passed)
        : s.grades.overall.passed;
    const allPass = (s: SampleResult): boolean =>
      s.trials !== undefined && s.trials.length > 0
        ? s.trials.every((t) => t.passed)
        : s.grades.overall.passed;
    passAtK = samples.filter(anyPass).length / total;
    passHatK = samples.filter(allPass).length / total;
    totalTokensAllTrials = samples.reduce(
      (acc, s) => {
        const perSample =
          s.trials !== undefined && s.trials.length > 0
            ? s.trials.reduce(
                (a, t) => ({ input: a.input + t.tokens.input, output: a.output + t.tokens.output }),
                { input: 0, output: 0 },
              )
            : s.tokens;
        return { input: acc.input + perSample.input, output: acc.output + perSample.output };
      },
      { input: 0, output: 0 },
    );
  }

  return {
    passRate: total === 0 ? 0 : passed / total,
    meanScore,
    p50Turns: quantile(turnsSorted, 0.5),
    p95Turns: quantile(turnsSorted, 0.95),
    p50LatencyMs: quantile(latSorted, 0.5),
    p95LatencyMs: quantile(latSorted, 0.95),
    totalTokens,
    errorCount: samples.length - ok.length,
    partialScoreMean,
    interventionRate,
    safetyViolations,
    p50ModelCallMs: quantile(modelCallSorted, 0.5),
    p95ModelCallMs: quantile(modelCallSorted, 0.95),
    ...(toolCallAccuracy !== undefined ? { toolCallAccuracy } : {}),
    ...(passAtK !== undefined ? { passAtK } : {}),
    ...(passHatK !== undefined ? { passHatK } : {}),
    ...(totalTokensAllTrials !== undefined ? { totalTokensAllTrials } : {}),
  };
}
