/**
 * Parsing the numbers that bound a read: budgets and durations.
 *
 * `Math.max(0, Math.floor(NaN))` is NaN, and a loop guarded by
 * `filled < NaN + 1` never runs, so a budget computed as
 * `Number(config.maxBytes)` with the key unset read every file and stream as
 * empty and complete — a scanner reported "nothing found". A timeout of NaN
 * or Infinity reached `setTimeout`, which fires those at once, so the child
 * was killed on the spot. Each is a programming error: thrown, never obeyed.
 */

/** The longest delay `setTimeout` honours; a longer one fires immediately. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** A byte budget: a finite number >= 0, floored. */
export function byteBudget(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number >= 0, got ${String(value)}`);
  }
  return Math.floor(value);
}

/** An optional byte budget: `fallback` when undefined, otherwise as {@link byteBudget}. */
export function optionalByteBudget(name: string, value: unknown, fallback: number): number {
  return value === undefined ? fallback : byteBudget(name, value);
}

/**
 * A grace period in milliseconds: a finite number >= 0. One longer than
 * `setTimeout` can wait is clamped to that (about 24.8 days).
 */
export function graceMs(name: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number >= 0, got ${String(value)}`);
  }
  return Math.min(value, MAX_TIMER_MS);
}

/**
 * A deadline in milliseconds: a number > 0, or `Infinity` for none. The
 * result is the delay to arm a timer with, or undefined for no timer; a
 * finite value longer than `setTimeout` can wait means no timer too.
 */
export function deadlineMs(name: string, value: unknown): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
    throw new RangeError(`${name} must be a number > 0 (Infinity for none), got ${String(value)}`);
  }
  return value > MAX_TIMER_MS ? undefined : value;
}
