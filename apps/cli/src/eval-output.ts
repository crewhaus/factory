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
 *   - `evalRunOutputLines` (G15/G54/G56/G47): the `[eval]` stdout block —
 *     the classic summary line extended with `partial_score=`, plus the
 *     loop-quality metrics line, the pass@k/pass^k repeats line, the
 *     failure-taxonomy class tally, and one note per judge grader whose
 *     gate came from `.crewhaus/judge-calibration.json`. Every new segment
 *     is presence-gated, so a summary written by an older runner renders
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
 * errored ones scoring 0 — the stable-denominator partial-credit figure).
 */
export function formatEvalSummaryLine(summary: EvalRunSummary, retriedCount: number): string {
  const a = summary.aggregates;
  const partial =
    a.partialScoreMean !== undefined ? ` partial_score=${a.partialScoreMean.toFixed(3)}` : "";
  return (
    `[eval] runId=${summary.runId} pass_rate=${pct(a.passRate)} ` +
    `mean_score=${a.meanScore.toFixed(3)}${partial} ` +
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
  opts: { readonly retriedCount: number },
): string[] {
  const lines = [formatEvalSummaryLine(summary, opts.retriedCount)];
  const loop = formatLoopMetricsLine(summary.aggregates);
  if (loop !== undefined) lines.push(loop);
  const repeats = formatRepeatsLine(summary);
  if (repeats !== undefined) lines.push(repeats);
  const failures = formatFailureClassesLine(summary.samples);
  if (failures !== undefined) lines.push(failures);
  lines.push(...formatJudgeCalibrationLines(summary.config));
  return lines;
}
