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
 * zone (net review of 0.7.1). Two spellings are accepted, each with a
 * mandatory zone:
 *
 * - ISO-8601 / RFC 3339: `2026-09-17T09:30:00Z`, `2026-09-17T18:30+09:00`,
 *   `2026-09-17T02:30:00.250-0700` (a space may stand for the `T`).
 * - RFC 5322 (an email Date header): `Thu, 17 Sep 2026 09:30:00 +0000`,
 *   `17 Sep 2026 09:30 GMT`. The weekday is optional and, as mail readers
 *   do, not checked against the date.
 *
 * Anything else is refused with the reason. Reading an offset-less time in
 * some other zone (the schedule's, say) is not done: it would be a guess
 * about what the caller meant.
 */

// The same grammar as tool-http's lib/http-date.ts reads a Retry-After date
// with a zone in. The packages do not depend on each other, and neither
// should grow a dependency for one small reader: change both together.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// Anchored, bounded and without nested quantifiers: each is linear. The
// input is also capped before either runs.
const ISO =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?([Zz]|[+-]\d{2}:?\d{2})$/;
const RFC5322 =
  /^(?:([A-Za-z]{3}),\s*)?(\d{1,2})[ -]([A-Za-z]{3})[ -](\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(GMT|UTC|UT|Z|[+-]\d{2}:?\d{2})$/i;
const MAX_LENGTH = 64;

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
  if (hour > 23 || minute > 59 || second > 60) return undefined;
  const midnight = new Date(Date.UTC(year, month, day));
  if (midnight.getUTCMonth() !== month || midnight.getUTCDate() !== day) return undefined;
  // A leap second (:60) names the same instant as the next minute's :00,
  // which is what Date.UTC gives for 60.
  const ms = fraction === undefined ? 0 : Math.floor(Number(`0.${fraction}`) * 1000);
  return Date.UTC(year, month, day, hour, minute, second, ms) - offset * 60_000;
}

/** The epoch milliseconds `text` names, or undefined when it is not one of the two spellings. */
export function readZonedInstant(text: string): number | undefined {
  const t = text.trim();
  if (t.length > MAX_LENGTH) return undefined;
  const iso = t.match(ISO);
  if (iso !== null) {
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
  const mail = t.match(RFC5322);
  if (mail !== null) {
    if (mail[1] !== undefined && !DAYS.includes(mail[1].toLowerCase())) return undefined;
    return instant(
      Number(mail[4]),
      MONTHS.indexOf((mail[3] as string).toLowerCase()),
      Number(mail[2]),
      Number(mail[5]),
      Number(mail[6]),
      Number(mail[7] ?? 0),
      undefined,
      mail[8] as string,
    );
  }
  return undefined;
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
  if (ms === undefined) {
    return {
      ok: false,
      message: `"${shown}" is not an instant with a UTC offset — write it as e.g. ${example} (ISO-8601) or Thu, 17 Sep 2026 09:30:00 +0000 (RFC 5322); a time without an offset means the host's local time, which differs between machines`,
    };
  }
  return { ok: true, ms };
}
