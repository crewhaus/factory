/**
 * Retry timing, as pure arithmetic.
 *
 * Two rules, both deliberate:
 *
 *   1. No jitter. Jitter needs randomness, and unseeded randomness makes a
 *      run unreproducible. A harness that needs spread across many agents
 *      should stagger them itself, where the seed is visible.
 *   2. `Retry-After` wins over the backoff curve when the server sent one.
 *      A server that names a wait knows something the client does not, and
 *      ignoring it is how a rate limit turns into a ban.
 */

/** Exponential backoff: `base * 2^attempt`, clamped. `attempt` is 0-based. */
export function backoffDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  if (attempt < 0) return 0;
  const raw = baseMs * 2 ** Math.min(attempt, 30);
  return Math.min(maxMs, Math.max(0, Math.round(raw)));
}

/**
 * `Retry-After` in milliseconds: either delta-seconds, or an HTTP-date
 * measured against `nowMs`. `null` when the header is absent or unparseable,
 * and never negative — a date already in the past means "retry now".
 */
export function parseRetryAfterMs(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

/**
 * How long to wait before the next attempt, given the response's
 * `Retry-After` and the backoff curve, clamped to what the deadline allows.
 * Returns `null` when there is no time left to wait — the caller should stop
 * rather than sleep past its own deadline.
 */
export function nextDelayMs(opts: {
  readonly attempt: number;
  readonly baseMs: number;
  readonly maxMs: number;
  readonly retryAfter: string | null;
  readonly nowMs: number;
  readonly remainingMs: number;
}): number | null {
  const fromHeader = parseRetryAfterMs(opts.retryAfter, opts.nowMs);
  const delay = fromHeader ?? backoffDelayMs(opts.attempt, opts.baseMs, opts.maxMs);
  // Leave a sliver for the request itself; a wait that consumes the whole
  // remaining budget guarantees the retry times out instead of running.
  if (delay >= opts.remainingMs) return null;
  return delay;
}
