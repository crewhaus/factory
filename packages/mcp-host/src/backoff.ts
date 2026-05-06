/**
 * Exponential reconnect backoff with ±10% jitter, capped at 30 s.
 *
 *   attempt 0 → ~1 s
 *   attempt 1 → ~2 s
 *   attempt 2 → ~4 s
 *   attempt 3 → ~8 s
 *   attempt 4 → ~16 s
 *   attempt 5+ → ~30 s (capped)
 *
 * Jitter is symmetric (±10%) to spread reconnects under correlated outages.
 */

const BASE_MS = 1000;
const MAX_MS = 30_000;
const JITTER_FRAC = 0.1;

export function nextBackoffMs(attempt: number, rng: () => number = Math.random): number {
  const safe = Math.max(0, Math.floor(attempt));
  const exp = Math.min(MAX_MS, BASE_MS * 2 ** safe);
  const jitter = exp * JITTER_FRAC * (rng() * 2 - 1);
  // Floor at 100ms so jitter can't push the delay too low (e.g. attempt 0
  // with a -10% jitter would otherwise hit 900ms — fine, but enforce a
  // minimum of 100ms regardless of attempt for reliable test scheduling).
  return Math.max(100, Math.floor(exp + jitter));
}
