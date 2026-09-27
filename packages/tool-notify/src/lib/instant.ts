/**
 * An instant the caller supplies, read the same way on every machine.
 *
 * Every clock value in this package is an argument, so that the same
 * question gets the same answer wherever it is asked. `new Date(text)` broke
 * that for one spelling: an ISO-8601 date-time with no offset
 * (`2026-09-17T23:30:00`) is read by ECMAScript as the HOST's local time, and
 * a date alone as UTC midnight. The same QuietHours question was inside the
 * window under UTC and outside it under Asia/Tokyo, and the same EmailCompose
 * call wrote a different Date header and Message-ID.
 *
 * So an instant must say where it is, and the WHOLE string is read by a
 * grammar here, never handed to `Date.parse`. Checking only that the text
 * ended in something offset-shaped was not enough: JavaScriptCore's legacy
 * parser reads `Sep 17 2026-23:30` as 23:30 host time and the trailing
 * `-23:30` as noise, so it passed the check and still moved with the host
 * zone (net review of 0.7.1). Two families are accepted, each with a
 * mandatory zone:
 *
 * - ISO-8601 / RFC 3339: `2026-09-17T09:30:00Z`, `2026-09-17T18:30+09:00`,
 *   `2026-09-17T02:30:00.250-0700` (a space may stand for the `T`),
 *   `T24:00:00`, the end of the day, and a six-digit signed year
 *   (`+002026-…`).
 * - Written dates, as an email Date header and JavaScript print them:
 *   `Thu, 17 Sep 2026 09:30:00 +0000`, `17 Sep 2026 09:30 GMT`,
 *   `Thursday, 17 September 2026 09:30:00 GMT`, `Sep 17, 2026 09:30:00 UTC`,
 *   and `Date.prototype.toString()`'s `Thu Sep 17 2026 09:30:00 GMT+0900
 *   (Japan Standard Time)`. Day and month names may be short or long. The
 *   weekday is optional and, as mail readers do, not checked against the
 *   date.
 *
 * A zone is `Z`, `UT`, `UTC`, `GMT`, a numeric offset (`+09:00`, `-0700`,
 * `GMT+0900`), or one of the US zones RFC 5322 §4.3 defines with a fixed
 * offset (EST, EDT, CST, CDT, MST, MDT, PST, PDT). 0.7.0's `new Date(text)`
 * read every one of these the same way on every host, so refusing them
 * broke calls that were never host-dependent (net regression review). Any
 * other abbreviation (`CET`, `IST`) names different zones in different
 * places, and is refused.
 *
 * Anything else is refused with the reason. Reading an offset-less time in
 * some other zone (the schedule's, say) is not done: it would be a guess
 * about what the caller meant.
 */

// The same grammar as tool-http's lib/http-date.ts reads a Retry-After date
// with a zone in. The packages do not depend on each other, and neither
// should grow a dependency for one small reader: change both together.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const LONG_MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const LONG_DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Minutes east of UTC for each zone name read here (RFC 5322 §3.3 and §4.3). */
const NAMED_ZONES: ReadonlyMap<string, number> = new Map([
  ["Z", 0],
  ["UT", 0],
  ["UTC", 0],
  ["GMT", 0],
  ["EST", -300],
  ["EDT", -240],
  ["CST", -360],
  ["CDT", -300],
  ["MST", -420],
  ["MDT", -360],
  ["PST", -480],
  ["PDT", -420],
]);

// Anchored, bounded and without nested quantifiers: each is linear. The
// input is also capped before either runs.
const ISO =
  /^((?:[+-]\d{2})?\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?([Zz]|[+-]\d{2}:?\d{2})$/;
/**
 * A written date: optional weekday, then day-first (`17 Sep 2026`,
 * `17-Sep-2026`) or month-first (`Sep 17, 2026`, `Sep 17 2026`), a time,
 * a zone, and an optional parenthesised zone name after it.
 */
const WRITTEN =
  /^(?:([A-Za-z]{3,9}),?\s+)?(?:(\d{1,2})[ -]([A-Za-z]{3,9})\.?[ -](\d{4})|([A-Za-z]{3,9})\.?\s(\d{1,2}),?\s(\d{4}))\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*((?:GMT|UTC)?[+-]\d{2}:?\d{2}|UTC|UT|GMT|Z|[ECMP][SD]T)(?:\s+\([^()]{0,64}\))?$/i;
const MAX_LENGTH = 128;

/** Minutes east of UTC for a zone {@link ISO} or {@link WRITTEN} matched; undefined when out of range. */
function offsetMinutes(zone: string): number | undefined {
  const upper = zone.toUpperCase();
  const named = NAMED_ZONES.get(upper);
  if (named !== undefined) return named;
  const numeric = upper.startsWith("GMT") || upper.startsWith("UTC") ? upper.slice(3) : upper;
  const sign = numeric[0] === "-" ? -1 : 1;
  const digits = numeric.slice(1).replace(":", "");
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2, 4));
  if (hours > 23 || minutes > 59) return undefined;
  return sign * (hours * 60 + minutes);
}

/** A month's index from its short or long English name, or -1. */
function monthIndex(name: string): number {
  const lower = name.toLowerCase();
  return lower.length === 3 ? MONTHS.indexOf(lower) : LONG_MONTHS.indexOf(lower);
}

/** The instant, or undefined when a field is out of range (31 Nov, 25:00). */
function instant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  fraction: string | undefined,
  zone: string,
): number | undefined {
  const offset = offsetMinutes(zone);
  if (offset === undefined || month < 0 || month > 11) return undefined;
  // 24:00:00 is ISO-8601's end of the day, the next day's 00:00.
  const endOfDay = hour === 24 && minute === 0 && second === 0 && !/[1-9]/.test(fraction ?? "");
  if ((hour > 23 && !endOfDay) || minute > 59 || second > 60) return undefined;
  const midnight = utc(year, month, day, 0, 0, 0, 0);
  const check = new Date(midnight);
  if (check.getUTCMonth() !== month || check.getUTCDate() !== day) return undefined;
  // A leap second (:60) names the same instant as the next minute's :00,
  // which is what the arithmetic gives for 60.
  const ms = fraction === undefined ? 0 : Math.floor(Number(`0.${fraction}`) * 1000);
  return utc(year, month, day, hour, minute, second, ms) - offset * 60_000;
}

/**
 * `Date.UTC` without its one surprise: it reads a year from 0 to 99 as
 * 1900 plus that, so `0026-01-01T00:00:00Z` became 1926.
 */
function utc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month, day);
  return d.getTime() + ((hour * 60 + minute) * 60 + second) * 1000 + ms;
}

/** The epoch milliseconds `text` names, or undefined when it is not one of the spellings above. */
export function readZonedInstant(text: string): number | undefined {
  const t = text.trim();
  if (t.length > MAX_LENGTH) return undefined;
  const iso = t.match(ISO);
  if (iso !== null) {
    // ECMAScript's rule: year zero has one spelling, 0000, not -000000.
    if (iso[1] === "-000000") return undefined;
    return instant(
      Number(iso[1]),
      Number(iso[2]) - 1,
      Number(iso[3]),
      Number(iso[4]),
      Number(iso[5]),
      Number(iso[6] ?? 0),
      iso[7],
      iso[8] as string,
    );
  }
  const w = t.match(WRITTEN);
  if (w !== null) {
    const weekday = w[1]?.toLowerCase();
    if (weekday !== undefined && !DAYS.includes(weekday) && !LONG_DAYS.includes(weekday)) {
      return undefined;
    }
    const dayFirst = w[2] !== undefined;
    return instant(
      Number(dayFirst ? w[4] : w[7]),
      monthIndex((dayFirst ? w[3] : w[5]) as string),
      Number(dayFirst ? w[2] : w[6]),
      Number(w[8]),
      Number(w[9]),
      Number(w[10] ?? 0),
      undefined,
      w[11] as string,
    );
  }
  return undefined;
}

/**
 * Whether `text` carries something that names a zone: a numeric offset after
 * a digit or a space, a `Z` after a digit, `GMT`/`UTC`/`UT`, or a trailing
 * abbreviation. Only for wording a refusal; linear, on capped input.
 */
function namesAZone(text: string): boolean {
  const t = text.slice(0, 200);
  return (
    /[\d\s][+-]\d{2}:?\d{2}\b/.test(t) ||
    /\d[Zz]$/.test(t) ||
    /\b(?:GMT|UTC|UT)\b/i.test(t) ||
    /\b[A-Z]{3,5}(?:\s*\([^()]*\))?$/.test(t)
  );
}

export type ParsedInstant =
  | { readonly ok: true; readonly ms: number }
  | { readonly ok: false; readonly message: string };

/**
 * The epoch milliseconds `text` names, or a refusal that quotes it (clipped)
 * and gives an example. `example` is the spelling the message suggests.
 */
export function parseOffsetInstant(text: string, example = "2026-09-17T09:30:00Z"): ParsedInstant {
  const trimmed = text.trim();
  const shown = trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
  const ms = readZonedInstant(trimmed);
  if (ms !== undefined) return { ok: true, ms };
  const spellings = `write it as e.g. ${example} (ISO-8601) or Thu, 17 Sep 2026 09:30:00 +0000 (RFC 5322)`;
  return {
    ok: false,
    message: namesAZone(trimmed)
      ? `"${shown}" is not an instant in a spelling this tool reads, or one of its fields is out of range — ${spellings}. A zone must be Z, UT, UTC, GMT, a numeric offset, or one of the US zones RFC 5322 defines (EST, EDT, CST, CDT, MST, MDT, PST, PDT); other abbreviations name different zones in different places`
      : `"${shown}" is not an instant with a UTC offset — ${spellings}; a time without an offset means the host's local time, which differs between machines`,
  };
}
