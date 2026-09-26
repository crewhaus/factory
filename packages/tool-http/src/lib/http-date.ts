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
 * string and built with `Date.UTC` — never handed to `Date.parse`, whose
 * legacy fallback reads `Sep 17 2026-23:30` as host time with the trailing
 * `-23:30` as noise. Two spellings, each with a mandatory zone:
 *
 * - ISO-8601 / RFC 3339: `2026-10-21T07:28:00Z`, `…+09:00`, `…-0700`,
 *   fractions, and a space for the `T`. Not an HTTP-date, but unambiguous,
 *   and 0.7.0 read it, so a server that sends one keeps working.
 * - RFC 5322 / a lenient RFC 1123: `Wed, 21 Oct 2026 07:28:00 +0000`,
 *   `… UTC`, `21 Oct 2026 7:28:00 GMT`, `Wed, 21-Oct-2026 07:28:00 GMT`.
 *   Servers send these in place of a strict IMF-fixdate. 0.7.0 read them,
 *   and none is host-local. The weekday is optional and, as recipients
 *   do, not checked against the date.
 *
 * A date with no zone, or a zone other than GMT, UT, UTC, Z or a numeric
 * offset (`PST` is ambiguous), is still undefined.
 */

// The same grammar as tool-notify's lib/instant.ts. The packages do not
// depend on each other, and neither should grow a dependency for one small
// reader: change both together.

// Anchored, bounded and without nested quantifiers: each is linear. The
// input is also capped before either runs.
const ISO =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?([Zz]|[+-]\d{2}:?\d{2})$/;
const RFC5322 =
  /^(?:([A-Za-z]{3}),\s*)?(\d{1,2})[ -]([A-Za-z]{3})[ -](\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(GMT|UTC|UT|Z|[+-]\d{2}:?\d{2})$/i;
const MAX_ZONED_LENGTH = 64;

/** Minutes east of UTC for `Z`, a zone name that means UTC, or `±hh[:]mm`; undefined when out of range. */
function offsetMinutes(zone: string): number | undefined {
  const upper = zone.toUpperCase();
  if (upper === "Z" || upper === "GMT" || upper === "UT" || upper === "UTC") return 0;
  const sign = zone[0] === "-" ? -1 : 1;
  const digits = zone.slice(1).replace(":", "");
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2, 4));
  if (hours > 23 || minutes > 59) return undefined;
  return sign * (hours * 60 + minutes);
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
  if (hour > 23 || minute > 59 || second > 60) return undefined;
  const midnight = new Date(Date.UTC(year, month, day));
  if (midnight.getUTCMonth() !== month || midnight.getUTCDate() !== day) return undefined;
  const ms = fraction === undefined ? 0 : Math.floor(Number(`0.${fraction}`) * 1000);
  return Date.UTC(year, month, day, hour, minute, second, ms) - offset * 60_000;
}

/** An ISO-8601 date-time with its offset, as epoch milliseconds; see above. */
export function parseIsoInstantWithOffset(text: string): number | undefined {
  const t = text.trim();
  if (t.length > MAX_ZONED_LENGTH) return undefined;
  const m = t.match(ISO);
  if (m === null) return undefined;
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

/** An RFC 5322 date-time with its zone, as epoch milliseconds; see above. */
export function parseZonedMailDate(text: string): number | undefined {
  const t = text.trim();
  if (t.length > MAX_ZONED_LENGTH) return undefined;
  const m = t.match(RFC5322);
  if (m === null) return undefined;
  if (m[1] !== undefined && !DAY_NAMES.includes(m[1].toLowerCase())) return undefined;
  return zonedInstant(
    Number(m[4]),
    MONTHS.indexOf((m[3] as string).toLowerCase()),
    Number(m[2]),
    Number(m[5]),
    Number(m[6]),
    Number(m[7] ?? 0),
    undefined,
    m[8] as string,
  );
}
