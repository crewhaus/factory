/**
 * Service-level objectives, evaluated. Pure: no clock, no files, no network.
 *
 * Three objectives, because three is what an agent harness actually declares:
 *
 *   - `success_rate` — "at least 99% of runs succeed".
 *   - `latency_percentile` — "the 95th percentile stays under 2s".
 *   - `error_budget` — the same arithmetic as success_rate, asked the other
 *     way round: not "does it hold" but "how much room is left before it
 *     stops holding".
 *
 * The error budget is the part worth having. A 99% target over 1,000 runs
 * allows exactly 10 failures; knowing that 7 are spent is a different and far
 * more actionable fact than knowing the rate is currently 99.3%.
 *
 * WHAT THIS IS NOT. There is no time window, no burn-rate alerting over
 * multiple windows, and no rolling evaluation — all three need a clock, and
 * this is a pure function. The caller decides which events constitute the
 * window and passes the counts; `BudgetCheck`'s `elapsedFraction` is the same
 * arrangement for money.
 */
import { nearestRankPercentile } from "./counts";

export type SloObjective = "success_rate" | "latency_percentile" | "error_budget";

export type SloInput = {
  readonly objective: SloObjective;
  /** Total events in the window, for the two rate objectives. */
  readonly total?: number;
  /** Failures in the window. Supply this or `successes`, not both. */
  readonly failures?: number;
  readonly successes?: number;
  /**
   * The target, as a FRACTION: `0.99` for "99% of runs succeed", `0.001` for
   * "0.1% may fail" when `targetIs` is `max_error_rate`.
   */
  readonly target: number;
  readonly targetIs?: "min_success_rate" | "max_error_rate";
  /** Observed durations in ms, for `latency_percentile`. */
  readonly durationsMs?: readonly number[];
  /** Which percentile to take, 0–100. */
  readonly percentile?: number;
  /** The ceiling that percentile must stay under, in ms. */
  readonly thresholdMs?: number;
};

export type SloResult = {
  readonly objective: SloObjective;
  readonly holds: boolean;
  /** One line a human can read without re-deriving the arithmetic. */
  readonly verdict: string;
  readonly observations: number;
  readonly successRate?: number;
  readonly errorRate?: number;
  readonly targetSuccessRate?: number;
  readonly failures?: number;
  /** Failures the target permits over this many observations. */
  readonly errorsAllowed?: number;
  readonly errorBudgetRemaining?: number;
  /** Fraction of the error budget already spent; above 1 means the SLO broke. */
  readonly errorBudgetConsumed?: number;
  readonly percentile?: number;
  readonly percentileMethod?: "nearest-rank";
  readonly observedMs?: number;
  readonly thresholdMs?: number;
};

/** Round to six places — enough for a 99.9999% target, short of float noise. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** A readable refusal, or the resolved counts. */
type Counts =
  | { readonly ok: true; readonly total: number; readonly failures: number }
  | { readonly ok: false; readonly message: string };

function resolveCounts(input: SloInput): Counts {
  const total = input.total;
  if (total === undefined || total < 0 || !Number.isFinite(total)) {
    return {
      ok: false,
      message: `objective "${input.objective}" needs "total" — the number of observations in the window`,
    };
  }
  if (input.failures !== undefined && input.successes !== undefined) {
    if (input.failures + input.successes !== total) {
      return {
        ok: false,
        message: `failures (${input.failures}) + successes (${input.successes}) is ${input.failures + input.successes}, which is not total (${total}) — pass one of the two and let the other be derived`,
      };
    }
    return { ok: true, total, failures: input.failures };
  }
  if (input.failures !== undefined) {
    if (input.failures > total) {
      return { ok: false, message: `failures (${input.failures}) exceeds total (${total})` };
    }
    return { ok: true, total, failures: input.failures };
  }
  if (input.successes !== undefined) {
    if (input.successes > total) {
      return { ok: false, message: `successes (${input.successes}) exceeds total (${total})` };
    }
    return { ok: true, total, failures: total - input.successes };
  }
  return { ok: false, message: `objective "${input.objective}" needs "failures" or "successes"` };
}

/** The target expressed as a minimum success rate, whichever way it was given. */
function targetSuccessRate(input: SloInput): number {
  return input.targetIs === "max_error_rate" ? 1 - input.target : input.target;
}

/**
 * Evaluate one objective. Returns a readable string on a caller mistake rather
 * than throwing, in keeping with every other tool in this package.
 */
export function evaluateSlo(input: SloInput): SloResult | string {
  if (!Number.isFinite(input.target)) return 'target must be a fraction, e.g. 0.99 for "99%"';

  if (input.objective === "latency_percentile") {
    const durations = input.durationsMs ?? [];
    const percentile = input.percentile ?? 95;
    const thresholdMs = input.thresholdMs;
    if (thresholdMs === undefined) {
      return 'objective "latency_percentile" needs "thresholdMs" — the ceiling the percentile must stay under';
    }
    if (durations.length === 0) {
      return 'objective "latency_percentile" needs a non-empty "durationsMs" — there is no percentile of nothing';
    }
    if (percentile <= 0 || percentile > 100)
      return "percentile must be greater than 0 and at most 100";
    const sorted = [...durations].sort((a, b) => a - b);
    const observed = nearestRankPercentile(sorted, percentile) as number;
    const holds = observed <= thresholdMs;
    return {
      objective: "latency_percentile",
      holds,
      verdict: `p${percentile} is ${observed}ms against a ${thresholdMs}ms ceiling over ${sorted.length} observations — ${holds ? "within objective" : "over objective"}`,
      observations: sorted.length,
      percentile,
      percentileMethod: "nearest-rank",
      observedMs: observed,
      thresholdMs,
    };
  }

  const counts = resolveCounts(input);
  if (!counts.ok) return counts.message;
  const targetRate = targetSuccessRate(input);
  if (targetRate < 0 || targetRate > 1) {
    return `target resolves to a success rate of ${targetRate}, which is not a fraction between 0 and 1`;
  }

  // Zero observations: the objective is neither met nor broken, and saying
  // "100% success" over an empty window is the confidently wrong answer.
  if (counts.total === 0) {
    return {
      objective: input.objective,
      holds: true,
      verdict:
        "no observations in the window — nothing has broken the objective, and nothing has confirmed it either",
      observations: 0,
      targetSuccessRate: round6(targetRate),
      failures: 0,
    };
  }

  const successRate = (counts.total - counts.failures) / counts.total;
  const errorsAllowed = Math.floor(counts.total * (1 - targetRate));
  const budgetRemaining = errorsAllowed - counts.failures;
  const holds = counts.failures <= errorsAllowed;
  const consumed =
    errorsAllowed === 0
      ? counts.failures > 0
        ? Number.POSITIVE_INFINITY
        : 0
      : counts.failures / errorsAllowed;

  const verdict =
    input.objective === "error_budget"
      ? `${counts.failures} of ${errorsAllowed} permitted failures used over ${counts.total} observations — ${budgetRemaining >= 0 ? `${budgetRemaining} left` : `${-budgetRemaining} over budget`}`
      : `${round6(successRate * 100)}% success over ${counts.total} observations against a ${round6(targetRate * 100)}% target — ${holds ? "objective holds" : "objective broken"}`;

  return {
    objective: input.objective,
    holds,
    verdict,
    observations: counts.total,
    successRate: round6(successRate),
    errorRate: round6(1 - successRate),
    targetSuccessRate: round6(targetRate),
    failures: counts.failures,
    errorsAllowed,
    errorBudgetRemaining: budgetRemaining,
    errorBudgetConsumed: Number.isFinite(consumed) ? round6(consumed) : consumed,
  };
}
