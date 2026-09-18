/**
 * Time budgets.
 *
 * A model does not know what time it is, and a harness that asks one to
 * decide "do I still have time for the thorough path?" is paying a token
 * price for arithmetic. This does the arithmetic.
 *
 * The clock is an input, not a call. Every function here takes `nowMs`, so
 * the same inputs give the same answer in a test, in a replay and in a
 * production run; the tool wrapper is the one place that reads the real
 * clock, and even there the caller may override it.
 */

/** How much of the budget is left, as a label a branch can switch on. */
export const BUDGET_PHASES = ["ample", "tight", "critical", "expired"] as const;
export type BudgetPhase = (typeof BUDGET_PHASES)[number];

export type DeadlineInput = {
  readonly nowMs: number;
  /** An absolute end, as epoch ms. Supply this or `budgetMs`. */
  readonly deadlineMs?: number;
  /** A duration, measured from `startedAtMs` (default: now). */
  readonly budgetMs?: number;
  readonly startedAtMs?: number;
  /**
   * What one more unit of work is expected to cost. When it does not fit in
   * the remaining time, `fits` is false and the caller can skip it.
   */
  readonly stepCostMs?: number;
  /** Fraction remaining at or below which the phase becomes `tight`. */
  readonly tightAt?: number;
  /** ...and `critical`. Must be below `tightAt`. */
  readonly criticalAt?: number;
};

export type DeadlineReport = {
  readonly nowMs: number;
  readonly deadlineMs: number;
  readonly remainingMs: number;
  readonly elapsedMs: number;
  readonly totalMs: number;
  /** Remaining over total, clamped to 0..1. 0 when the budget was empty. */
  readonly fractionRemaining: number;
  readonly phase: BudgetPhase;
  readonly expired: boolean;
  /** Null when no `stepCostMs` was given. */
  readonly fits: boolean | null;
  /** How many more steps of `stepCostMs` fit. Null without a step cost. */
  readonly stepsRemaining: number | null;
  readonly deadline: string;
};

const DEFAULT_TIGHT = 0.5;
const DEFAULT_CRITICAL = 0.2;

export function checkDeadline(input: DeadlineInput): DeadlineReport {
  const tightAt = input.tightAt ?? DEFAULT_TIGHT;
  const criticalAt = input.criticalAt ?? DEFAULT_CRITICAL;
  if (criticalAt > tightAt) {
    throw new Error(`criticalAt (${criticalAt}) must not be above tightAt (${tightAt})`);
  }

  const startedAtMs = input.startedAtMs ?? input.nowMs;
  let deadlineMs: number;
  let totalMs: number;
  if (input.deadlineMs !== undefined) {
    deadlineMs = input.deadlineMs;
    totalMs = Math.max(0, deadlineMs - startedAtMs);
  } else if (input.budgetMs !== undefined) {
    totalMs = Math.max(0, input.budgetMs);
    deadlineMs = startedAtMs + totalMs;
  } else {
    throw new Error("give either deadlineMs or budgetMs");
  }

  const remainingMs = deadlineMs - input.nowMs;
  const elapsedMs = input.nowMs - startedAtMs;
  const expired = remainingMs <= 0;
  // A zero-length budget is spent by definition; dividing by it would give
  // NaN, which would then compare false against every threshold and read as
  // "ample" — the most dangerous possible answer.
  const fractionRemaining = totalMs === 0 ? 0 : Math.min(1, Math.max(0, remainingMs / totalMs));

  const phase: BudgetPhase = expired
    ? "expired"
    : fractionRemaining <= criticalAt
      ? "critical"
      : fractionRemaining <= tightAt
        ? "tight"
        : "ample";

  const stepCost = input.stepCostMs;
  const stepsRemaining =
    stepCost === undefined || stepCost <= 0
      ? null
      : Math.max(0, Math.floor(Math.max(0, remainingMs) / stepCost));

  return {
    nowMs: input.nowMs,
    deadlineMs,
    remainingMs,
    elapsedMs,
    totalMs,
    fractionRemaining,
    phase,
    expired,
    fits: stepCost === undefined ? null : !expired && remainingMs >= stepCost,
    stepsRemaining,
    deadline: new Date(deadlineMs).toISOString(),
  };
}
