/**
 * Reading an instant the caller supplied.
 *
 * Nothing in this package reads a clock, and — just as importantly — nothing
 * here reads the machine's time zone. `Date.parse` is deliberately NOT used:
 * ECMAScript says a date-time string with no offset ("2026-09-17T00:00:00") is
 * local time, so the same input would mean different instants on a laptop in
 * Los Angeles and a runner in UTC, and every id and expiry derived from it
 * would differ. `Date.parse` is also free to accept whatever else it likes
 * ("Sep 17 2026"), which makes the accepted grammar a property of the engine
 * rather than of this package.
 *
 * So the grammar is spelled out here and parsed by hand:
 *
 *   - `YYYY-MM-DD`
 *   - `YYYY-MM-DDTHH:MM[:SS[.fff]][Z|±HH:MM|±HHMM]` (a space may stand in for
 *     the `T`)
 *   - a run of digits, read as a number in `numberUnit`
 *
 * **An instant with no offset is read as UTC**, never as local time. Say `Z`
 * or an explicit offset when the input really is zoned.
 */

/** The ECMAScript time range: ±100,000,000 days around the epoch. */
const MAX_TIME_MILLIS = 8.64e15;

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|z|[+-]\d{2}:?\d{2})?)?$/;

/** `Z`, `+05:30`, `-0800` -> minutes to subtract to reach UTC. */
function offsetMinutes(offset: string | undefined): number {
  if (offset === undefined || offset === "Z" || offset === "z") return 0;
  const sign = offset.startsWith("-") ? -1 : 1;
  const digits = offset.slice(1).replace(":", "");
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
}

/**
 * Accepts an ISO-8601 instant (`2026-09-17T12:00:00Z`) or a number. A number
 * is interpreted in `numberUnit`, because the two conventions in play — epoch
 * milliseconds for ULID, epoch seconds for JWT — differ by a factor of a
 * thousand and guessing between them is how a token appears to expire in 1970.
 */
export function instantToMillis(value: string | number, numberUnit: "ms" | "s"): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${value} is not a finite instant`);
    const millis = numberUnit === "s" ? Math.round(value * 1000) : Math.round(value);
    if (Math.abs(millis) > MAX_TIME_MILLIS) {
      throw new Error(`${value} is outside the range of instants a date can represent`);
    }
    return millis;
  }
  const trimmed = value.trim();
  if (/^-?\d+$/.test(trimmed)) {
    return instantToMillis(Number(trimmed), numberUnit);
  }
  const match = ISO_INSTANT.exec(trimmed);
  if (!match) {
    throw new Error(
      `"${value}" is not an ISO-8601 instant or a numeric timestamp — expected YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS[.fff][Z|±HH:MM]`,
    );
  }
  const [, year, month, day, hour = "00", minute = "00", second = "00", fraction = "", offset] =
    match as unknown as string[];
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const mi = Number(minute);
  const s = Number(second);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) {
    throw new Error(`"${value}" has a field outside its range (month, day, hour, minute, second)`);
  }
  // `new Date(0)` plus the UTC setters, rather than `Date.UTC`, because
  // `Date.UTC` maps a two-digit year onto 19xx and "0026-01-01" is a real
  // ISO date.
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, s, Number(`${fraction}000`.slice(0, 3)));
  // A rolled-over date — 2026-02-31 becoming March 3rd — is a typo, not an
  // instant, so it is refused rather than silently moved.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    throw new Error(`"${value}" is not a real calendar date`);
  }
  return date.getTime() - offsetMinutes(offset) * 60_000;
}

/**
 * Render epoch milliseconds as an ISO instant, or `undefined` when the value
 * is outside the range a date can represent. Every caller in this package
 * formats through here, because `new Date(x).toISOString()` throws a bare
 * `RangeError` on an out-of-range number and a tool should answer in a
 * sentence rather than in an exception.
 */
export function isoFromMillis(millis: number): string | undefined {
  if (!Number.isFinite(millis) || Math.abs(millis) > MAX_TIME_MILLIS) return undefined;
  return new Date(millis).toISOString();
}
