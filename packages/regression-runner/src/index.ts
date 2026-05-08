/**
 * Section 29 — `regression-runner`. Computes a diff between two
 * `eval-runner` outputs (`EvalRunSummary` shapes), surfacing pass-rate
 * delta, latency delta, sample-level pass→fail flips and fail→pass
 * recoveries, and a configurable score-shift threshold.
 *
 * `gate(prev, new, thresholds)` returns `"pass"` or `"fail"` — the
 * function `canary-controller` calls. Exits non-zero on regression so CI
 * can block merges.
 */
import { CrewhausError } from "@crewhaus/errors";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";

export class RegressionError extends CrewhausError {
  override readonly name = "RegressionError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type SampleFlip = {
  readonly sampleId: string;
  readonly prev: { readonly passed: boolean; readonly score: number };
  readonly next: { readonly passed: boolean; readonly score: number };
};

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
  /** Score-shift epsilon for inclusion in scoreShifts. Default: 0.1. */
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
  const epsilon = opts.scoreShiftEpsilon ?? 0.1;
  const prevById = new Map(prev.samples.map((s) => [s.sampleId, s]));
  const flipsRegress: SampleFlip[] = [];
  const flipsRecover: SampleFlip[] = [];
  const shifts: ScoreShift[] = [];
  let unchanged = 0;

  for (const cur of next.samples) {
    const before = prevById.get(cur.sampleId);
    if (!before) continue;
    if (before.grades.overall.passed && !cur.grades.overall.passed) {
      flipsRegress.push({
        sampleId: cur.sampleId,
        prev: { passed: true, score: before.grades.overall.score },
        next: { passed: false, score: cur.grades.overall.score },
      });
    } else if (!before.grades.overall.passed && cur.grades.overall.passed) {
      flipsRecover.push({
        sampleId: cur.sampleId,
        prev: { passed: false, score: before.grades.overall.score },
        next: { passed: true, score: cur.grades.overall.score },
      });
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
