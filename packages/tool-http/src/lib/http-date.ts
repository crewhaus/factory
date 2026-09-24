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
 * An ISO-8601 date-time that carries its own UTC offset (`Z` or `±hh:mm`).
 * Not an HTTP-date, but unambiguous, and `Date.parse` read it correctly on
 * 0.7.0, so a server that sends one keeps working. Without the offset it is
 * refused like any other zone-less time.
 */
const ISO_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

export function parseIsoInstantWithOffset(text: string): number | undefined {
  const t = text.trim();
  if (!ISO_WITH_OFFSET.test(t)) return undefined;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? undefined : ms;
}
