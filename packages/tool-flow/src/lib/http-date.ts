/**
 * HTTP-dates (RFC 9110 §5.6.7), read as the instants they name.
 *
 * `Date.parse` is not an HTTP-date reader. It accepts anything a browser
 * ever did, and reads a string with no zone as the HOST's local time: an
 * asctime date (which the RFC defines as GMT), a zone-less RFC 1123 date or
 * an offset-less ISO-8601 string meant 10:00 UTC on one machine and 01:00
 * UTC on another, so ErrorClassify's wait for the same header differed by
 * the operator's timezone. This reads exactly the three forms the RFC
 * defines, all of which are GMT by definition, builds the instant from
 * its UTC fields, and answers undefined for anything else — never a guess.
 * Two unambiguous non-HTTP forms that 0.7.0 read correctly are read too,
 * each only with its zone written: an RFC 5322 date-time and an ISO-8601
 * instant with an offset.
 */

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

/**
 * The epoch milliseconds of a UTC calendar time, or undefined when any field
 * is out of range. The year is used as written: `Date.UTC` maps 0-99 to
 * 1900-1999, which read `Sat, 26 Sep 0026 …` as 1926.
 */
function utcInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms = 0,
): number | undefined {
  if (month < 0 || month > 11 || day < 1 || hour > 23 || minute > 59 || second > 60) {
    return undefined;
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  // Refuse a day the month does not have (31 Nov, 30 Feb), rather than
  // rolling over into the next month as Date does.
  if (date.getUTCMonth() !== month || date.getUTCDate() !== day) return undefined;
  // A leap second is legal on the wire; it names the same instant as :59
  // plus one second, which is what adding 60 seconds gives.
  return date.getTime() + ((hour * 60 + minute) * 60 + second) * 1000 + ms;
}

function instant(
  year: number,
  monthName: string,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | undefined {
  return utcInstant(year, MONTHS.indexOf(monthName.toLowerCase()), day, hour, minute, second);
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
 * RFC 5322 date-time: optional weekday, a one- or two-digit day, a
 * four-digit year, optional seconds, and a zone that is WRITTEN — GMT, UT,
 * UTC, Z, `±hhmm`, or one of the eight North American names RFC 5322 gives
 * fixed offsets. Mail libraries write these (`… 07:28:00 -0000`, `… +0200`),
 * and `Date.parse` read them correctly on 0.7.0 on every host, because the
 * zone is in the text. Military one-letter zones are refused: RFC 5322 says
 * their signs were botched in practice and to treat them as unknown.
 */
const RFC5322_DATE =
  /^(?:([A-Za-z]{3}),\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+(GMT|UTC|UT|Z|[+-]\d{4}|[ECMP][SD]T)$/i;

/** RFC 5322's named zones, as offsets in minutes east of UTC. */
const NAMED_ZONES: ReadonlyMap<string, number> = new Map([
  ["gmt", 0],
  ["utc", 0],
  ["ut", 0],
  ["z", 0],
  ["est", -300],
  ["edt", -240],
  ["cst", -360],
  ["cdt", -300],
  ["mst", -420],
  ["mdt", -360],
  ["pst", -480],
  ["pdt", -420],
]);

/** The epoch milliseconds an RFC 5322 date-time with a written zone names, or undefined. */
export function parseRfc5322WithZone(text: string): number | undefined {
  const m = RFC5322_DATE.exec(text.trim());
  if (m === null) return undefined;
  if (m[1] !== undefined && !DAY_NAMES.includes(m[1].toLowerCase())) return undefined;
  const zone = (m[8] as string).toLowerCase();
  let offsetMinutes: number;
  if (zone.startsWith("+") || zone.startsWith("-")) {
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(3, 5));
    if (hours > 23 || minutes > 59) return undefined;
    offsetMinutes = (zone.startsWith("-") ? -1 : 1) * (hours * 60 + minutes);
  } else {
    const named = NAMED_ZONES.get(zone);
    if (named === undefined) return undefined;
    offsetMinutes = named;
  }
  const ms = instant(
    Number(m[4]),
    m[3] as string,
    Number(m[2]),
    Number(m[5]),
    Number(m[6]),
    Number(m[7] ?? "0"),
  );
  return ms === undefined ? undefined : ms - offsetMinutes * 60_000;
}

/**
 * An ISO-8601 / RFC 3339 date-time that carries its own UTC offset (`Z`,
 * `±hh:mm` or `±hhmm`), with `T` or a single space between date and time
 * (RFC 3339 §5.6 allows the space; Python's `str(datetime)` writes it). Not
 * an HTTP-date, but unambiguous, and `Date.parse` read it correctly on
 * 0.7.0, so a server that sends one keeps working. Without the offset it is
 * refused like any other zone-less time.
 *
 * The fields are checked here, not by `Date.parse`, which rolls an
 * impossible day over (`2026-02-30` became 2 March). Fractional seconds past
 * the millisecond are dropped, as `Date.parse` drops them.
 */
const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})$/i;

export function parseIsoInstantWithOffset(text: string): number | undefined {
  const m = ISO_WITH_OFFSET.exec(text.trim());
  if (m === null) return undefined;
  const zone = (m[8] as string).toUpperCase();
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    const hours = Number(digits.slice(0, 2));
    const minutes = Number(digits.slice(2, 4));
    if (hours > 23 || minutes > 59) return undefined;
    offsetMinutes = (zone.startsWith("-") ? -1 : 1) * (hours * 60 + minutes);
  }
  const ms = utcInstant(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? "0"),
    Number(`${m[7] ?? ""}000`.slice(0, 3)),
  );
  return ms === undefined ? undefined : ms - offsetMinutes * 60_000;
}
