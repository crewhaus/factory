/**
 * Loop contract 0.4 (Batch B) — CLI-side helpers for the eval-loop surfaces
 * `crewhaus eval` / `optimize` / `flywheel` share:
 *
 *   - `graderRegistryForCompiled` (G14): construct the DEFAULT grader
 *     registry exactly once per command when the parsed graders file carries
 *     a `type: registry` entry, so every eval pass a command runs (matrix
 *     cells, per-candidate fitness evals, before/after acceptance evals)
 *     resolves registry names against ONE registry instead of re-importing
 *     the packs and re-discovering `.crewhaus/graders` plugins per pass.
 *     `runEval` has its own identical fallback (same helper underneath), so
 *     vocabulary cannot diverge between the CLI wiring and the library path.
 *
 *   - `fitnessScore` (G56): the optimizer/flywheel fitness figure. Reads the
 *     partial-credit `partialScoreMean` when the runner emitted it (all new
 *     runs) and falls back to `passRate` (summaries persisted by older CLIs,
 *     stub summaries in tests). Partial credit gives the mutation search a
 *     gradient on datasets where whole-sample passes are rare: a candidate
 *     that moves 0.4-scoring answers to 0.7 now measures as progress even
 *     while the pass gate still fails them.
 *
 *   - `evalRunOutputLines` (G15/G54/G56/G47 + Wave 1 B13/C27/A12/A3): the
 *     `[eval]` stdout block — the classic summary line extended with
 *     `partial_score=` and the C27 95% CIs, plus the loop-quality metrics
 *     line, the pass@k/pass^k repeats line, the per-slice block (B13), one
 *     per-criterion line per judge grader (A12), the needs_human line (A3),
 *     the failure-taxonomy class tally, and one note per judge grader whose
 *     gate came from `.crewhaus/judge-calibration.json`. Wave 4 adds the C34
 *     flake block (samples whose repeat trials disagreed, plus what to do
 *     about them) and the C35 cost line (agent AND judge spend, priced
 *     through the injected matrix pricing seam). Every new segment is
 *     presence-gated, so a summary written by an older runner renders
 *     exactly the pre-0.4 block.
 *
 * Side-effect-free (the CLI entry file runs an argv switch on import), so
 * all of this is unit-testable without spawning a subprocess.
 */
import type { CompiledGrader } from "@crewhaus/eval-grader";
import { defaultGraderRegistry } from "@crewhaus/eval-runner";
import type {
  EvalAggregates,
  EvalRunSummary,
  GraderLookup,
  SampleResult,
} from "@crewhaus/eval-runner";

/**
 * G14 — the shared registry-construction rule: a graders file that resolves
 * at least one grader by registry name gets the default registry (six
 * specialty packs + `.crewhaus/graders` plugins); a file with none returns
 * `undefined` so the packs are never imported on the common path.
 */
export async function graderRegistryForCompiled(
  compiled: ReadonlyArray<CompiledGrader>,
): Promise<GraderLookup | undefined> {
  if (!compiled.some((g) => g.registrySpec !== undefined)) return undefined;
  return defaultGraderRegistry();
}

/** G56 — the fitness figure the optimize/flywheel search ranks candidates
 *  by: partial credit when the runner emitted it, pass rate otherwise. */
export function fitnessScore(aggregates: EvalAggregates): number {
  return aggregates.partialScoreMean ?? aggregates.passRate;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * The classic `[eval] runId=…` summary line, extended with the G56
 * `partial_score=` column when present (mean overall score over ALL samples,
 * errored ones scoring 0 — the stable-denominator partial-credit figure)
 * and the C27 closed-form 95% CIs (`pass_rate_ci95=[lo%,hi%]` /
 * `mean_score_ci95=[lo,hi]`) when the runner emitted them.
 */
export function formatEvalSummaryLine(summary: EvalRunSummary, retriedCount: number): string {
  const a = summary.aggregates;
  const partial =
    a.partialScoreMean !== undefined ? ` partial_score=${a.partialScoreMean.toFixed(3)}` : "";
  const passCI =
    a.passRateCI95 !== undefined
      ? ` pass_rate_ci95=[${pct(a.passRateCI95[0])},${pct(a.passRateCI95[1])}]`
      : "";
  const scoreCI =
    a.meanScoreCI95 !== undefined
      ? ` mean_score_ci95=[${a.meanScoreCI95[0].toFixed(3)},${a.meanScoreCI95[1].toFixed(3)}]`
      : "";
  return (
    `[eval] runId=${summary.runId} pass_rate=${pct(a.passRate)}${passCI} ` +
    `mean_score=${a.meanScore.toFixed(3)}${scoreCI}${partial} ` +
    `errors=${a.errorCount} ` +
    `tokens=${a.totalTokens.input}/${a.totalTokens.output}` +
    `${retriedCount > 0 ? ` (${retriedCount} retried)` : ""}`
  );
}

/**
 * G56 — the loop-quality aggregates line (tool-call accuracy, intervention
 * rate, the disjoint safety-violation buckets, per-model-call latency
 * percentiles). Undefined when the summary carries none of them (a
 * results.json persisted by an older CLI).
 */
export function formatLoopMetricsLine(a: EvalAggregates): string | undefined {
  const parts: string[] = [];
  if (a.toolCallAccuracy !== undefined) parts.push(`tool_accuracy=${pct(a.toolCallAccuracy)}`);
  if (a.interventionRate !== undefined) parts.push(`interventions=${pct(a.interventionRate)}`);
  if (a.safetyViolations !== undefined) {
    const v = a.safetyViolations;
    parts.push(
      `safety_violations=${v.total} ` +
        `(deny ${v.permissionDenials} / egress ${v.egressBlocks} / justify ${v.justificationRejections})`,
    );
  }
  if (a.p50ModelCallMs !== undefined) {
    const p95 = a.p95ModelCallMs !== undefined ? ` p95=${Math.round(a.p95ModelCallMs)}ms` : "";
    parts.push(`model_call p50=${Math.round(a.p50ModelCallMs)}ms${p95}`);
  }
  if (parts.length === 0) return undefined;
  return `[eval] loop: ${parts.join(" ")}`;
}

/**
 * G15 — the repeats line: pass@k (any of the k trials passed — the
 * optimistic capability metric) and pass^k (ALL k passed — tau-bench's
 * reliability metric), plus the all-trials token spend that makes the k×
 * real cost visible. Undefined when the run carried no trials.
 */
export function formatRepeatsLine(summary: EvalRunSummary): string | undefined {
  const a = summary.aggregates;
  if (a.passAtK === undefined && a.passHatK === undefined) return undefined;
  const k = summary.config.repeats ?? "k";
  const parts: string[] = [];
  if (a.passAtK !== undefined) parts.push(`pass@${k}=${pct(a.passAtK)}`);
  if (a.passHatK !== undefined) parts.push(`pass^${k}=${pct(a.passHatK)}`);
  if (a.totalTokensAllTrials !== undefined) {
    parts.push(
      `tokens_all_trials=${a.totalTokensAllTrials.input}/${a.totalTokensAllTrials.output}`,
    );
  }
  return `[eval] repeats=${k}: ${parts.join(" ")}`;
}

/**
 * B13 — the compact per-slice block: one line per slice key, each value's
 * pass rate + membership. Empty when the run sliced nothing (no metadata,
 * or a results.json persisted by a pre-B13 CLI).
 */
export function formatSliceLines(summary: EvalRunSummary): string[] {
  const slices = summary.slices;
  if (slices === undefined) return [];
  return Object.entries(slices).map(([key, byValue]) => {
    const parts = Object.entries(byValue).map(
      ([value, s]) => `${value} ${pct(s.passRate)} (n=${s.sampleCount})`,
    );
    return `[eval] slice ${key}: ${parts.join(" · ")}`;
  });
}

/**
 * A12 — one line per judge grader with per-criterion means (raw 1–5 scale),
 * so "which criterion regressed" is answerable from the run output alone.
 * Empty when no grade carried a criterion breakdown.
 */
export function formatCriterionLines(summary: EvalRunSummary): string[] {
  const means = summary.aggregates.criterionMeans;
  if (means === undefined) return [];
  return Object.entries(means).map(([grader, byCriterion]) => {
    const parts = Object.entries(byCriterion).map(
      ([criterion, mean]) => `${criterion}=${Number.isInteger(mean) ? mean : mean.toFixed(2)}`,
    );
    return `[eval] judge criteria ${grader}: ${parts.join(" ")}`;
  });
}

/**
 * A3 — the needs-human line: abstained samples (judge declined, nothing
 * else failed) are excluded from the pass-rate denominator and listed here
 * for `crewhaus rate` follow-up. Undefined when nothing abstained.
 */
export function formatNeedsHumanLine(summary: EvalRunSummary): string | undefined {
  const a = summary.aggregates;
  if (a.needsHuman === undefined || a.needsHuman === 0) return undefined;
  const ids = (a.needsHumanSampleIds ?? []).join(", ");
  return `[eval] needs_human=${a.needsHuman}: ${ids} — judge abstained; review with \`crewhaus rate\``;
}

/**
 * A2 — the needs-review line: samples whose judge-panel vote nearly split
 * (high normalized entropy). Their verdicts are REAL and still COUNT in the
 * pass rate — unlike the abstained needs-human bucket — but a near-coin-flip
 * vote deserves a human look, so the stdout story lists them beside the
 * needs_human/canary buckets. Undefined when nothing was flagged.
 */
export function formatNeedsReviewLine(summary: EvalRunSummary): string | undefined {
  const a = summary.aggregates;
  if (a.needsReview === undefined || a.needsReview === 0) return undefined;
  const ids = (a.needsReviewSampleIds ?? []).join(", ");
  return `[eval] needs_review=${a.needsReview}: ${ids} — panel vote split; verdicts still count`;
}

/**
 * B18 — the canary line: contamination-tripwire samples
 * (`metadata.source: canary`) are excluded from the pass-rate denominator
 * like needs_human and listed here. Undefined when the run carried none.
 */
export function formatCanaryLine(summary: EvalRunSummary): string | undefined {
  const a = summary.aggregates;
  if (a.canary === undefined || a.canary === 0) return undefined;
  const ids = (a.canarySampleIds ?? []).join(", ");
  return `[eval] canary=${a.canary}: ${ids} — contamination tripwires; excluded from pass rate`;
}

/**
 * G54 — tally of `SampleResult.failureClass` (the spec's `failure_taxonomy`
 * class the sample's final error matched), so a classified run says WHY its
 * errors errored without opening results.json. Undefined when no sample
 * carries a class (no taxonomy, or no matching error).
 */
export function formatFailureClassesLine(samples: ReadonlyArray<SampleResult>): string | undefined {
  const counts = new Map<string, number>();
  for (const s of samples) {
    if (s.failureClass !== undefined) {
      counts.set(s.failureClass, (counts.get(s.failureClass) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return undefined;
  const parts = [...counts.entries()]
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([cls, n]) => `${cls}=${n}`);
  return `[eval] failure classes: ${parts.join(" ")}`;
}

/**
 * C34 — the flake block: samples whose repeat trials DISAGREED, with each
 * one's trial pass rate, plus a suggestion line. Their verdicts are coin
 * flips, so the strict any-flip gate will keep re-failing on them for
 * reasons the agent did not cause — naming them is the whole point. Empty
 * when the run carried no trials or every sample was stable.
 */
export function formatFlakyLines(summary: EvalRunSummary): string[] {
  const a = summary.aggregates;
  if (a.flaky === undefined || a.flaky === 0) return [];
  const rateById = new Map(summary.samples.map((s) => [s.sampleId, s.trialPassRate] as const));
  const listed = (a.flakySampleIds ?? []).map((id) => {
    const rate = rateById.get(id);
    const k = summary.config.repeats;
    if (rate === undefined) return id;
    return k !== undefined
      ? `${id} (${Math.round(rate * k)}/${k})`
      : `${id} (${(rate * 100).toFixed(0)}%)`;
  });
  return [
    // "verdicts still count" mirrors the needs_review line deliberately: the
    // three buckets above this one each state their exclusion rule
    // (needs_human and canary are OUT of the pass-rate denominator), so a
    // reader who has just been told those rules would otherwise read "coin
    // flip" as "excluded". A flaky sample keeps its canonical verdict in
    // every figure — see aggregate.ts.
    `[eval] flaky=${a.flaky}/${summary.samples.length}: ${listed.join(", ")} — trials disagreed, so these verdicts are coin flips; verdicts still count`,
    `[eval] flaky: the strict gate cannot tell a coin flip from a regression — inspect with \`crewhaus eval-report export --runs ${summary.outDir} --format csv\`, then remove the nondeterminism (pin --seed, --replay-tools <dir>) or move the sample out of the gating dataset version`,
  ];
}

/** The pricing seam the cost line meters through — the SAME lookup that
 *  prices the `--models` matrix `est_$` column (USD micro-dollars, or
 *  `undefined` when the model has no pricing row). */
export type EvalCostPricingFn = (
  model: string,
  tokens: { readonly input: number; readonly output: number },
) => number | undefined;

const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`;

/**
 * C30 × C35 — one run's estimated spend, split by who spent it. THE single
 * source for both the printed `[eval] cost:` line and the number recorded in
 * run history / checked by `--max-cost-usd`: the figure a user is shown and
 * the figure the gate enforces must be the same number, or a judge-heavy run
 * prints `total=$4.10` and sails through `--max-cost-usd 2.00`.
 *
 * Every component is priced through the injected seam, never guessed.
 * `totalMicros` is deliberately defined ONLY when the whole run is priceable
 * (agent priced AND no judge model missing its pricing row) — a partial sum
 * would be an UNDERCOUNT, and gating on an undercount is the very failure
 * this type exists to prevent. An unpriceable total leaves the ceiling
 * unchecked with a loud warning instead (see `finishEvalRun`).
 */
export type EvalCostBreakdown = {
  /** Agent-model spend (all trials under `--repeats`), when priceable. */
  readonly agentMicros?: number;
  /** Judge/grader spend summed over `aggregates.judgeUsage.byModel`. */
  readonly judgeMicros?: number;
  /** Judge models with no pricing row — any at all makes the total unknown. */
  readonly judgeUnpricedModels: number;
  /** agent + judge, only when NOTHING in the run was unpriceable. */
  readonly totalMicros?: number;
};

/** Price one run's agent + judge spend through the injected seam. */
export function evalRunCost(
  summary: EvalRunSummary,
  pricing: EvalCostPricingFn,
): EvalCostBreakdown {
  const a = summary.aggregates;
  const agentTokens = a.totalTokensAllTrials ?? a.totalTokens;
  const agentMicros = pricing(summary.config.model, agentTokens);
  const judge = a.judgeUsage;
  let judgeMicros: number | undefined;
  let judgeUnpricedModels = 0;
  if (judge !== undefined) {
    for (const [model, u] of Object.entries(judge.byModel)) {
      const micros = pricing(model, { input: u.input, output: u.output });
      if (micros === undefined) {
        judgeUnpricedModels += 1;
        continue;
      }
      judgeMicros = (judgeMicros ?? 0) + micros;
    }
  }
  const totalMicros =
    agentMicros !== undefined && judgeUnpricedModels === 0
      ? agentMicros + (judgeMicros ?? 0)
      : undefined;
  return {
    ...(agentMicros !== undefined ? { agentMicros } : {}),
    ...(judgeMicros !== undefined ? { judgeMicros } : {}),
    judgeUnpricedModels,
    ...(totalMicros !== undefined ? { totalMicros } : {}),
  };
}

/**
 * C35 — the run's estimated cost, agent AND judge. Judge spend was
 * previously invisible (the judge wire discarded provider usage), which is
 * how a team can pay more for grading than for the agent and never see it.
 *
 * Every component is priced through the injected seam, never guessed: a
 * model with no pricing row renders `n/a`, and a run where NOTHING is
 * priceable prints no line at all rather than a misleading `$0.0000`.
 * Agent tokens use the all-trials totals when `--repeats` ran — the real
 * spend, not trial 1's.
 */
export function formatCostLine(
  summary: EvalRunSummary,
  pricing: EvalCostPricingFn,
): string | undefined {
  const a = summary.aggregates;
  const judge = a.judgeUsage;
  const {
    agentMicros,
    judgeMicros,
    judgeUnpricedModels: judgeUnpriced,
    totalMicros,
  } = evalRunCost(summary, pricing);
  if (agentMicros === undefined && judgeMicros === undefined) return undefined;

  const parts: string[] = [];
  parts.push(
    `agent=${agentMicros !== undefined ? usd(agentMicros) : `n/a (${summary.config.model} unpriced)`}`,
  );
  if (judge !== undefined) {
    const models = Object.keys(judge.byModel).length;
    const judgeText =
      judgeMicros !== undefined
        ? `${usd(judgeMicros)}${judgeUnpriced > 0 ? ` + ${judgeUnpriced} unpriced model(s)` : ""}`
        : "n/a (unpriced judge model)";
    parts.push(
      `judge=${judgeText} (${judge.calls} call(s), ${judge.tokens.input}/${judge.tokens.output} tokens across ${models} model(s))`,
    );
  }
  // The printed total is the SAME number `--max-cost-usd` gates on and run
  // history records (see `evalRunCost`), so it appears only when the run is
  // fully priceable — an undercounted "total" beside an unpriced model would
  // be the misleading figure, not the missing one.
  if (totalMicros !== undefined && judge !== undefined) {
    parts.push(`total=${usd(totalMicros)}`);
  }
  return `[eval] cost: ${parts.join(" ")}`;
}

/**
 * G47 — one note per `llm_judge` grader whose passing gate came from the
 * calibration file rather than a rubric-declared `passing_score`, so an
 * operator reading the run output knows the bar was the calibrated one.
 */
export function formatJudgeCalibrationLines(config: EvalRunSummary["config"]): string[] {
  const cal = config.judgeCalibration;
  if (cal === undefined || cal.applied.length === 0) return [];
  return cal.applied.map(
    (a) =>
      `[eval] judge calibration (${cal.path}): grader "${a.grader}" gated at ` +
      `min_score ${a.minScore} → passing ${a.passingScore.toFixed(2)}/5 (key "${a.specKey}")`,
  );
}

/** The full `[eval]` stdout block for one finished run, in print order. */
export function evalRunOutputLines(
  summary: EvalRunSummary,
  opts: {
    readonly retriedCount: number;
    /** C35 — when supplied, the block gains the estimated-cost line
     *  (agent + judge). Omitted ⇒ the pre-C35 block, byte-identical. */
    readonly pricing?: EvalCostPricingFn;
  },
): string[] {
  const lines = [formatEvalSummaryLine(summary, opts.retriedCount)];
  const loop = formatLoopMetricsLine(summary.aggregates);
  if (loop !== undefined) lines.push(loop);
  const repeats = formatRepeatsLine(summary);
  if (repeats !== undefined) lines.push(repeats);
  lines.push(...formatSliceLines(summary));
  lines.push(...formatCriterionLines(summary));
  const needsHuman = formatNeedsHumanLine(summary);
  if (needsHuman !== undefined) lines.push(needsHuman);
  const needsReview = formatNeedsReviewLine(summary);
  if (needsReview !== undefined) lines.push(needsReview);
  const canary = formatCanaryLine(summary);
  if (canary !== undefined) lines.push(canary);
  // C34 — measured instability, listed beside the other human-attention
  // buckets (needs_human / needs_review / canary).
  lines.push(...formatFlakyLines(summary));
  // C35 — what the run cost, agent + judge, when the caller wired pricing.
  if (opts.pricing !== undefined) {
    const cost = formatCostLine(summary, opts.pricing);
    if (cost !== undefined) lines.push(cost);
  }
  const failures = formatFailureClassesLine(summary.samples);
  if (failures !== undefined) lines.push(failures);
  lines.push(...formatJudgeCalibrationLines(summary.config));
  return lines;
}
