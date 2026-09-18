/**
 * Budget arithmetic. Pure: no clock, no files, no network.
 *
 * Money is integer micro-USD throughout, the unit the runtime's own cost
 * records carry. Percentages are returned in BASIS POINTS as an integer
 * alongside the float, because "is 79.999999% over the 80% threshold" is a
 * question a float answers differently on different sums of the same numbers,
 * and a threshold crossing is a decision somebody acts on.
 */

export type BudgetThreshold = {
  /** Percent of the budget, 0–100. `80` means "warn at 80%". */
  readonly percent: number;
  readonly label?: string;
};

export type ThresholdVerdict = {
  readonly percent: number;
  readonly label?: string;
  readonly crossed: boolean;
  /** Micro-USD still available before this threshold; negative once crossed. */
  readonly headroomUsdMicros: number;
};

export type BudgetCheckResult = {
  readonly spentUsdMicros: number;
  readonly budgetUsdMicros: number;
  /** Never negative: an overspend shows as `overUsdMicros`, not as negative remaining. */
  readonly remainingUsdMicros: number;
  readonly overUsdMicros: number;
  readonly usedBasisPoints: number;
  readonly usedPercent: number;
  readonly exhausted: boolean;
  /** The highest crossed threshold, when any was. */
  readonly highestCrossed?: ThresholdVerdict;
  readonly thresholds: readonly ThresholdVerdict[];
  /** Present only when the caller supplied `elapsedFraction`. */
  readonly projection?: BudgetProjection;
};

export type BudgetProjection = {
  /** The caller's own statement of how far through the period it is, 0–1. */
  readonly elapsedFraction: number;
  /** Spend at this burn rate for the whole period. */
  readonly projectedUsdMicros: number;
  readonly projectedOverBudget: boolean;
  /**
   * Fraction of the period the budget lasts at this rate, 0–1, or `null` when
   * nothing has been spent and the answer is "indefinitely".
   */
  readonly budgetLastsFraction: number | null;
};

/** Basis points of `part` in `whole`, rounded to the nearest integer. */
function basisPoints(part: number, whole: number): number {
  if (whole <= 0) return part > 0 ? Number.POSITIVE_INFINITY : 0;
  return Math.round((part * 10_000) / whole);
}

/**
 * Where a budget stands.
 *
 * A zero or negative budget is a real case — a harness configured to spend
 * nothing — and it is reported as fully exhausted the moment anything is
 * spent, rather than dividing by zero. `usedBasisPoints` is `Infinity` there,
 * which serialises as `null` in JSON, so the caller sees a missing number
 * rather than a fabricated one.
 *
 * A threshold is crossed when spend is at or above it, not strictly above: a
 * budget exactly at 100% is spent.
 */
export function budgetCheck(
  spentUsdMicros: number,
  budgetUsdMicros: number,
  thresholds: readonly BudgetThreshold[] = [],
  elapsedFraction?: number,
): BudgetCheckResult {
  const spent = Math.max(0, spentUsdMicros);
  const budget = budgetUsdMicros;
  const remaining = Math.max(0, budget - spent);
  const over = Math.max(0, spent - budget);
  const bp = basisPoints(spent, budget);

  const verdicts: ThresholdVerdict[] = [...thresholds]
    .sort((a, b) => a.percent - b.percent)
    .map((t) => {
      const limit = Math.round((budget * t.percent) / 100);
      return {
        percent: t.percent,
        ...(t.label !== undefined ? { label: t.label } : {}),
        crossed: spent >= limit && (limit > 0 || spent > 0),
        headroomUsdMicros: limit - spent,
      };
    });
  const crossed = verdicts.filter((v) => v.crossed);
  const highest = crossed[crossed.length - 1];

  const projection =
    elapsedFraction === undefined ? undefined : project(spent, budget, elapsedFraction);

  return {
    spentUsdMicros: spent,
    budgetUsdMicros: budget,
    remainingUsdMicros: remaining,
    overUsdMicros: over,
    usedBasisPoints: bp,
    usedPercent: Number.isFinite(bp) ? Math.round(bp) / 100 : bp,
    exhausted: spent >= budget && (budget > 0 || spent > 0),
    ...(highest !== undefined ? { highestCrossed: highest } : {}),
    thresholds: verdicts,
    ...(projection !== undefined ? { projection } : {}),
  };
}

/**
 * Straight-line projection from the caller's own statement of elapsed time.
 *
 * It does NOT read a clock — "how far through the period are we" is an input,
 * because a tool that answered it from `Date.now()` would return a different
 * result for the same log every time it ran.
 */
function project(spent: number, budget: number, elapsedFraction: number): BudgetProjection {
  const fraction = Math.min(1, Math.max(0, elapsedFraction));
  if (fraction === 0) {
    return {
      elapsedFraction: fraction,
      projectedUsdMicros: 0,
      projectedOverBudget: false,
      budgetLastsFraction: null,
    };
  }
  const projected = Math.round(spent / fraction);
  return {
    elapsedFraction: fraction,
    projectedUsdMicros: projected,
    projectedOverBudget: projected > budget,
    budgetLastsFraction:
      spent === 0 ? null : Math.min(1, Math.round((budget / (spent / fraction)) * 10_000) / 10_000),
  };
}
