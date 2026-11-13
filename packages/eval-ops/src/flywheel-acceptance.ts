/**
 * The flywheel's acceptance bar: a candidate run is accepted only when the
 * strict run-history gate passes and its pass rate strictly improved. Used by
 * `crewhaus flywheel run` (re-exported from the CLI's flywheel module) and by
 * anything else that accepts a candidate the same way.
 */
import type { EvalRunSummary } from "@crewhaus/eval-runner";
import { gateRuns } from "./eval-history";

export type FlywheelVerdict = {
  readonly accepted: boolean;
  readonly reason: string;
  readonly passRateBefore: number;
  readonly passRateAfter: number;
  /** Sample-level pass→fail flips between the before and after runs. */
  readonly regressions: number;
  /** Sample-level fail→pass flips (what the accepted patch bought). */
  readonly recoveries: number;
};

/**
 * The flywheel's acceptance bar: BOTH conditions must hold —
 *   (a) the strict run-history gate passes (`gateRuns`: any pass-rate drop
 *       or sample-level pass→fail flip fails, even when recoveries cancel
 *       it out in the aggregates), and
 *   (b) pass_rate STRICTLY improved (a flat run passes the gate but is not
 *       worth a write-back/PR — taste over averages, per the demo).
 */
export function evaluateFlywheelAcceptance(
  before: EvalRunSummary,
  after: EvalRunSummary,
): FlywheelVerdict {
  const passRateBefore = before.aggregates.passRate;
  const passRateAfter = after.aggregates.passRate;
  const verdict = gateRuns(before, after);
  const base = {
    passRateBefore,
    passRateAfter,
    regressions: verdict.report.regressions.length,
    recoveries: verdict.report.recoveries.length,
  };
  // Fail closed on incomparable pass rates: a NaN/undefined rate (e.g. a
  // 0-sample run) satisfies neither `<=` nor `>`, so a strictly-up check
  // written as `after <= before → reject` would ACCEPT it. Reject
  // explicitly before any comparison runs.
  if (!Number.isFinite(passRateBefore) || !Number.isFinite(passRateAfter)) {
    return {
      accepted: false,
      reason:
        `pass_rate not comparable (before=${String(passRateBefore)}, ` +
        `after=${String(passRateAfter)}) — rejecting fail-closed`,
      ...base,
    };
  }
  if (verdict.verdict === "fail") {
    return { accepted: false, reason: verdict.reason ?? "regression gate failed", ...base };
  }
  // Fail-closed form: only a provable strict improvement accepts — any
  // non-ordered pair (including NaN, belt to the check above) rejects.
  if (!(passRateAfter > passRateBefore)) {
    return {
      accepted: false,
      reason:
        `pass_rate did not strictly improve (${formatPassRate(passRateBefore)} → ` +
        `${formatPassRate(passRateAfter)})`,
      ...base,
    };
  }
  return {
    accepted: true,
    reason: `pass_rate ${formatPassRate(passRateBefore)} → ${formatPassRate(passRateAfter)} with zero regressions`,
    ...base,
  };
}

export function formatPassRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}
