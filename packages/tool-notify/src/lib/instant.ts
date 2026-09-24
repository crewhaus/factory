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
 * So an instant must say where it is: it ends in `Z` or a `±hh:mm` / `±hhmm`
 * offset, or it is refused with the reason. This is the rule tool-flow's
 * `parseInstant` and the other clock-free packages apply; every string it
 * accepts parses to the same epoch milliseconds under any host zone.
 * Reading an offset-less time in some other zone (the schedule's, say) is
 * not done: it would be a guess about what the caller meant.
 */

const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

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
  if (!HAS_OFFSET.test(trimmed)) {
    return {
      ok: false,
      message: `"${shown}" is not an instant with a UTC offset — write it as e.g. ${example}; a time without an offset means the host's local time, which differs between machines`,
    };
  }
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    return {
      ok: false,
      message: `"${shown}" is not an instant this tool can read — use ISO-8601 with an offset, e.g. ${example}`,
    };
  }
  return { ok: true, ms };
}
