/**
 * Backoff schedules for Retry.
 *
 * Deliberately jitter-free: jitter is randomness, and a tool whose waits
 * differ run to run is a tool whose transcript cannot be replayed. The
 * caller declares the schedule up front and gets exactly that schedule.
 */

export type BackoffPolicy =
  | { readonly kind: "fixed"; readonly delayMs: number }
  | {
      readonly kind: "exponential";
      readonly baseMs: number;
      readonly factor?: number;
      readonly maxDelayMs?: number;
    };

/**
 * The delay to wait BEFORE a 1-based attempt number. Attempt 1 never waits;
 * attempt 2 waits `baseMs`, attempt 3 `baseMs * factor`, and so on.
 */
export function backoffDelayMs(policy: BackoffPolicy, attempt: number): number {
  if (attempt <= 1) return 0;
  if (policy.kind === "fixed") return Math.max(0, Math.round(policy.delayMs));
  const factor = policy.factor ?? 2;
  const raw = policy.baseMs * factor ** (attempt - 2);
  const capped = policy.maxDelayMs === undefined ? raw : Math.min(raw, policy.maxDelayMs);
  return Math.max(0, Math.round(Number.isFinite(capped) ? capped : (policy.maxDelayMs ?? raw)));
}

/** The whole schedule for `maxAttempts` attempts, including the leading 0. */
export function backoffSchedule(policy: BackoffPolicy, maxAttempts: number): number[] {
  const out: number[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    out.push(backoffDelayMs(policy, attempt));
  }
  return out;
}

/** What the whole schedule costs in waiting alone — useful to reject a plan
 *  that could not finish inside the caller's overall deadline. */
export function totalBackoffMs(policy: BackoffPolicy, maxAttempts: number): number {
  return backoffSchedule(policy, maxAttempts).reduce((a, b) => a + b, 0);
}
