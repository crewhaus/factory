/**
 * Time, injected.
 *
 * A signature is a function of the instant it was made, so `Date.now()` in
 * the middle of this package would make every assertion about a URL a
 * statement about the second the test ran. The seam moves that decision to
 * the edge: tests either pass `signedAt` explicitly or drive `_setClock`, and
 * no test here asserts a wall-clock duration.
 *
 * The tool's own `signedAt` field exists for the same reason a caller needs:
 * re-minting yesterday's URL to reproduce a support report is impossible if
 * the timestamp is whatever the process thinks now is.
 */
export type Clock = { now(): number };

const realClock: Clock = { now: () => Date.now() };

let clock: Clock = realClock;

/** Test seam — `_setClock(undefined)` restores the real clock. */
export function _setClock(next: Clock | undefined): void {
  clock = next ?? realClock;
}

export function nowMs(): number {
  return clock.now();
}

/**
 * Read an instant from input: epoch milliseconds, or ISO-8601 WITH an offset.
 *
 * An offset-less string is refused rather than read as local time. Per
 * ECMAScript, `2026-01-01T00:00:00` means local time, so the same input would
 * sign at two different instants on a laptop and on a CI box in UTC — and the
 * only symptom would be a URL that is already expired, or not yet valid, on
 * one of them.
 */
export function parseInstant(value: string | number, field: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${field} is not a finite epoch-millisecond value`);
    }
    return value;
  }
  const text = value.trim();
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    throw new Error(
      `${field} ("${text}") has no UTC offset — write it as e.g. 2026-01-01T00:00:00Z, because an offset-less string means local time and would sign at a different instant on another machine`,
    );
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) {
    throw new Error(`${field} ("${text}") is not a valid ISO-8601 instant`);
  }
  return parsed;
}
