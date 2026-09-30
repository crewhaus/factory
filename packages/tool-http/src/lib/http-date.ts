/**
 * HTTP-dates (RFC 9110 §5.6.7), read as the instants they name.
 *
 * `Date.parse` is not an HTTP-date reader. It accepts anything a browser
 * ever did, and reads a string with no zone as the HOST's local time: an
 * asctime date (which the RFC defines as GMT), a zone-less RFC 1123 date or
 * an offset-less ISO-8601 string meant 10:00 UTC on one machine and 01:00
 * UTC on another, so HttpRequest's wait for the same header differed by
 * the operator's timezone. This reads exactly the three forms the RFC
 * defines, all of which are GMT by definition, builds the instant with
 * `Date.UTC`, and answers undefined for anything else — never a guess.
 */

// The same grammar as @crewhaus/tool-flow's lib/http-date.ts, which reads
// ErrorClassify's Retry-After. tool-http does not depend on tool-flow, and
// neither should grow a dependency for one small reader; change both together.

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const LONG_DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Bounded, anchored, and with no nested quantifiers: each is linear.
/** IMF-fixdate: `Sun, 06 Nov 1994 08:49:37 GMT`. */
const IMF_FIXDATE = /^([A-Za-z]{3}), (\d{2}) ([A-Za-z]{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/i;
/** rfc850-date (obsolete): `Sunday, 06-Nov-94 08:49:37 GMT`. */
const RFC850_DATE = /^([A-Za-z]{6,9}), (\d{2})-([A-Za-z]{3})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/i;
/** asctime-date (obsolete): `Sun Nov  6 08:49:37 1994`, GMT with no zone written. */
const ASCTIME_DATE = /^([A-Za-z]{3}) ([A-Za-z]{3}) ( \d|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/i;

function instant(
  year: number,
  monthName: string,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | undefined {
  const month = MONTHS.indexOf(monthName.toLowerCase());
  if (month < 0 || hour > 23 || minute > 59 || second > 60) return undefined;
  // A leap second is legal on the wire; it names the same instant as :59
  // plus one second, which is what Date.UTC gives for 60.
  const ms = Date.UTC(year, month, day, hour, minute, second);
  const check = new Date(Date.UTC(year, month, day));
  // Refuse a day the month does not have (31 Nov), rather than rolling over.
  if (check.getUTCMonth() !== month || check.getUTCDate() !== day) return undefined;
  return ms;
}

/**
 * The epoch milliseconds an HTTP-date names, or undefined when `text` is not
 * one of the RFC 9110 forms.
 *
 * An rfc850-date has a two-digit year; per the RFC it is read as the most
 * recent year with those digits that is not more than 50 years after
 * `nowMs`. Without `nowMs` its century is unknown, so it answers undefined
 * rather than guessing one. Names are matched without regard to case; the
 * weekday is checked to be a weekday but not against the date, as
 * recipients commonly do.
 */
export function parseHttpDate(text: string, nowMs?: number): number | undefined {
  const t = text.trim();
  let m = IMF_FIXDATE.exec(t);
  if (m !== null) {
    if (!DAY_NAMES.includes((m[1] as string).toLowerCase())) return undefined;
    return instant(
      Number(m[4]),
      m[3] as string,
      Number(m[2]),
      Number(m[5]),
      Number(m[6]),
      Number(m[7]),
    );
  }
  m = RFC850_DATE.exec(t);
  if (m !== null) {
    if (!LONG_DAY_NAMES.includes((m[1] as string).toLowerCase())) return undefined;
    if (nowMs === undefined || !Number.isFinite(nowMs)) return undefined;
    const nowYear = new Date(nowMs).getUTCFullYear();
    const yy = Number(m[4]);
    let year = nowYear - (nowYear % 100) + yy;
    if (year > nowYear + 50) year -= 100;
    return instant(year, m[3] as string, Number(m[2]), Number(m[5]), Number(m[6]), Number(m[7]));
  }
  m = ASCTIME_DATE.exec(t);
  if (m !== null) {
    if (!DAY_NAMES.includes((m[1] as string).toLowerCase())) return undefined;
    return instant(
      Number(m[7]),
      m[2] as string,
      Number((m[3] as string).trim()),
      Number(m[4]),
      Number(m[5]),
      Number(m[6]),
    );
  }
  return undefined;
}

/**
 * A date-time that names its own zone, read by a grammar for the WHOLE
 * string and built from its fields — never handed to `Date.parse`, whose
 * legacy fallback reads `Sep 17 2026-23:30` as host time with the trailing
 * `-23:30` as noise. Two families, each with a mandatory zone:
 *
 * - ISO-8601 / RFC 3339: `2026-10-21T07:28:00Z`, `…+09:00`, `…-0700`,
 *   fractions, a space for the `T`, `T24:00:00` and a six-digit signed
 *   year. Not an HTTP-date, but unambiguous, and 0.7.0 read it, so a server
 *   that sends one keeps working.
 * - Written dates, which servers send in place of a strict IMF-fixdate:
 *   `Wed, 21 Oct 2026 07:28:00 +0000`, `… UTC`, `21 Oct 2026 7:28:00 GMT`,
 *   `Wed, 21-Oct-2026 07:28:00 GMT`, long day and month names,
 *   `Oct 21, 2026 07:28:00 UTC`, and JavaScript's `Wed Oct 21 2026
 *   16:28:00 GMT+0900 (Japan Standard Time)`. The weekday is optional and,
 *   as recipients do, not checked against the date.
 *
 * A zone is `Z`, `UT`, `UTC`, `GMT`, a numeric offset (`GMT+0900` too), or
 * one of the US zones RFC 5322 §4.3 defines with a fixed offset (EST, EDT,
 * CST, CDT, MST, MDT, PST, PDT). 0.7.0 read every one of these the same way
 * on every host (net regression review). Any other abbreviation (`CET`,
 * `IST`) names different zones in different places, and a date with no
 * zone is host-local to `Date.parse`: both are undefined.
 */

// The same grammar as tool-notify's lib/instant.ts. The packages do not
// depend on each other, and neither should grow a dependency for one small
// reader: change both together.

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
const MAX_ZONED_LENGTH = 128;

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

/**
 * `Date.UTC` without its one surprise: it reads a year from 0 to 99 as
 * 1900 plus that.
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

function zonedInstant(
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
  const check = new Date(utc(year, month, day, 0, 0, 0, 0));
  if (check.getUTCMonth() !== month || check.getUTCDate() !== day) return undefined;
  const ms = fraction === undefined ? 0 : Math.floor(Number(`0.${fraction}`) * 1000);
  return utc(year, month, day, hour, minute, second, ms) - offset * 60_000;
}

/** An ISO-8601 date-time with its offset, as epoch milliseconds; see above. */
export function parseIsoInstantWithOffset(text: string): number | undefined {
  const t = text.trim();
  if (t.length > MAX_ZONED_LENGTH) return undefined;
  const m = t.match(ISO);
  if (m === null) return undefined;
  // ECMAScript's rule: year zero has one spelling, 0000, not -000000.
  if (m[1] === "-000000") return undefined;
  return zonedInstant(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? 0),
    m[7],
    m[8] as string,
  );
}

/** A written date-time with its zone, as epoch milliseconds; see above. */
export function parseZonedMailDate(text: string): number | undefined {
  const t = text.trim();
  if (t.length > MAX_ZONED_LENGTH) return undefined;
  const w = t.match(WRITTEN);
  if (w === null) return undefined;
  const weekday = w[1]?.toLowerCase();
  if (weekday !== undefined && !DAY_NAMES.includes(weekday) && !LONG_DAY_NAMES.includes(weekday)) {
    return undefined;
  }
  const dayFirst = w[2] !== undefined;
  return zonedInstant(
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
