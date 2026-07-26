/**
 * Section 29 — `regression-runner`. Computes a diff between two
 * `eval-runner` outputs (`EvalRunSummary` shapes), surfacing pass-rate
 * delta, latency delta, sample-level flips (regressions / recoveries), and
 * a configurable score-shift threshold.
 *
 * Loop contract 0.4 (Batch B, G15): flip detection compares per-sample
 * pass-RATES (`SampleResult.trialPassRate` from repeat trials, else the
 * 0/1 verdict — see {@link samplePassRate}), so a reliability drop between
 * repeated runs registers even when the canonical verdict is unchanged.
 * Single-trial runs keep the original boolean pass→fail semantics exactly.
 *
 * `gate(prev, new, thresholds)` returns `"pass"` or `"fail"` — the
 * function `canary-controller` calls. Exits non-zero on regression so CI
 * can block merges.
 */
import { CrewhausError } from "@crewhaus/errors";
import { DEFAULT_SCORE_EPSILON } from "@crewhaus/eval-runner";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";

export class RegressionError extends CrewhausError {
  override readonly name = "RegressionError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type SampleFlip = {
  readonly sampleId: string;
  readonly prev: { readonly passed: boolean; readonly score: number; readonly passRate?: number };
  readonly next: { readonly passed: boolean; readonly score: number; readonly passRate?: number };
};

/**
 * G15 — a sample's pass-RATE: its per-trial pass fraction when the run
 * carried repeat trials (`RunEvalOptions.repeats` > 1), else its single
 * verdict as 0/1. Flip detection compares THESE, not the booleans, so a
 * reliability drop (4/4 trials → 1/4 trials) registers as a regression
 * even though the canonical trial still passes. Single-trial runs reduce
 * to exactly the old boolean semantics.
 */
export function samplePassRate(s: SampleResult): number {
  return s.trialPassRate ?? (s.grades.overall.passed ? 1 : 0);
}

export type ScoreShift = {
  readonly sampleId: string;
  readonly prevScore: number;
  readonly nextScore: number;
  readonly delta: number;
};

export type RegressReport = {
  readonly passRateDelta: number;
  readonly meanScoreDelta: number;
  readonly p50LatencyDeltaMs: number;
  readonly p95LatencyDeltaMs: number;
  readonly regressions: ReadonlyArray<SampleFlip>;
  readonly recoveries: ReadonlyArray<SampleFlip>;
  readonly scoreShifts: ReadonlyArray<ScoreShift>;
  readonly unchanged: number;
};

export type GateThresholds = {
  /**
   * Maximum absolute regression in pass-rate (e.g. 0.05 = a 5-point drop
   * triggers fail). Default: 0.05.
   */
  readonly regressionThreshold?: number;
  /** Maximum absolute regression in p95 latency (ms). Default: 5000. */
  readonly latencyThreshold?: number;
  /**
   * Score-shift epsilon for inclusion in scoreShifts. Default:
   * {@link DEFAULT_SCORE_EPSILON} (0.1) — the SAME constant
   * `eval-report diff` (and its `--epsilon` flag) defaults to, so the diff a
   * human reads and the gate that blocks classify identically.
   */
  readonly scoreShiftEpsilon?: number;
};

export type GateVerdict = {
  readonly verdict: "pass" | "fail";
  readonly reason?: string;
  readonly report: RegressReport;
};

export function regress(
  prev: EvalRunSummary,
  next: EvalRunSummary,
  opts: GateThresholds = {},
): RegressReport {
  const epsilon = opts.scoreShiftEpsilon ?? DEFAULT_SCORE_EPSILON;
  const prevById = new Map(prev.samples.map((s) => [s.sampleId, s]));
  const flipsRegress: SampleFlip[] = [];
  const flipsRecover: SampleFlip[] = [];
  const shifts: ScoreShift[] = [];
  let unchanged = 0;

  for (const cur of next.samples) {
    const before = prevById.get(cur.sampleId);
    if (!before) continue;
    // G15 — flips compare per-sample pass-RATES, not single booleans: with
    // repeat trials on either side, any rate drop is a regression and any
    // rise a recovery (1.0 → 0.75 is a reliability regression the boolean
    // view can't see). Without trials the rates are exactly the 0/1
    // verdicts, so single-trial runs keep the pre-G15 flip semantics
    // byte-for-byte. The rate fields are attached only when a side actually
    // carried trial data, keeping single-trial reports unchanged.
    const hasTrialData = before.trialPassRate !== undefined || cur.trialPassRate !== undefined;
    const prevRate = samplePassRate(before);
    const nextRate = samplePassRate(cur);
    const flip = (): SampleFlip => ({
      sampleId: cur.sampleId,
      prev: {
        passed: before.grades.overall.passed,
        score: before.grades.overall.score,
        ...(hasTrialData ? { passRate: prevRate } : {}),
      },
      next: {
        passed: cur.grades.overall.passed,
        score: cur.grades.overall.score,
        ...(hasTrialData ? { passRate: nextRate } : {}),
      },
    });
    if (nextRate < prevRate) {
      flipsRegress.push(flip());
    } else if (nextRate > prevRate) {
      flipsRecover.push(flip());
    } else {
      unchanged++;
    }
    const delta = cur.grades.overall.score - before.grades.overall.score;
    if (Math.abs(delta) >= epsilon) {
      shifts.push({
        sampleId: cur.sampleId,
        prevScore: before.grades.overall.score,
        nextScore: cur.grades.overall.score,
        delta,
      });
    }
  }
  return {
    passRateDelta: next.aggregates.passRate - prev.aggregates.passRate,
    meanScoreDelta: next.aggregates.meanScore - prev.aggregates.meanScore,
    p50LatencyDeltaMs: next.aggregates.p50LatencyMs - prev.aggregates.p50LatencyMs,
    p95LatencyDeltaMs: next.aggregates.p95LatencyMs - prev.aggregates.p95LatencyMs,
    regressions: flipsRegress,
    recoveries: flipsRecover,
    scoreShifts: shifts,
    unchanged,
  };
}

export function gate(
  prev: EvalRunSummary,
  next: EvalRunSummary,
  opts: GateThresholds = {},
): GateVerdict {
  const regressionThreshold = opts.regressionThreshold ?? 0.05;
  const latencyThreshold = opts.latencyThreshold ?? 5000;
  const report = regress(prev, next, opts);

  if (-report.passRateDelta > regressionThreshold) {
    return {
      verdict: "fail",
      reason: `pass-rate dropped from ${prev.aggregates.passRate.toFixed(2)} to ${next.aggregates.passRate.toFixed(2)} (delta ${report.passRateDelta.toFixed(3)}, threshold -${regressionThreshold})`,
      report,
    };
  }
  if (report.p95LatencyDeltaMs > latencyThreshold) {
    return {
      verdict: "fail",
      reason: `p95 latency rose from ${prev.aggregates.p95LatencyMs}ms to ${next.aggregates.p95LatencyMs}ms (delta +${report.p95LatencyDeltaMs}ms, threshold +${latencyThreshold}ms)`,
      report,
    };
  }
  return { verdict: "pass", report };
}

export type SampleResultLike = SampleResult;
