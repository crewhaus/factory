/**
 * An RRULE subset, expanded from an explicit start.
 *
 * RFC 5545 recurrence is a large specification and most of it is rarely used.
 * Implementing a slice of it and pretending to implement the rest is the worst
 * outcome — a calendar that is quietly wrong — so this parser accepts exactly
 * the parts listed below and *rejects* every other part by name rather than
 * ignoring it.
 *
 * ## Supported
 * - `FREQ` = `DAILY` | `WEEKLY` | `MONTHLY` | `YEARLY`
 * - `INTERVAL` (default 1)
 * - `COUNT`
 * - `UNTIL` (inclusive; a UTC instant or a plain date)
 * - `BYDAY` with plain weekday codes (`MO,TU,...`), for `DAILY` and `WEEKLY`,
 *   and for `MONTHLY` where it means every such weekday in the month
 *
 * ## Rejected, with an error naming the part
 * Positional `BYDAY` (`2MO`, `-1FR`), `BYMONTH`, `BYMONTHDAY`, `BYYEARDAY`,
 * `BYWEEKNO`, `BYHOUR`, `BYMINUTE`, `BYSECOND`, `BYSETPOS`, `WKST`,
 * `FREQ=HOURLY|MINUTELY|SECONDLY`, and `BYDAY` combined with `FREQ=YEARLY`.
 *
 * ## Two rules worth knowing
 * - The week starts Monday. `WKST` is not supported, so a `WEEKLY` rule with
 *   `INTERVAL` above 1 counts weeks from the Monday of the start's week.
 * - A `MONTHLY` or `YEARLY` occurrence that would land on a date that does not
 *   exist is **skipped**, per RFC 5545 — a rule starting on the 31st fires 7
 *   times a year, not 12. This is the opposite of `DateAdd`, which clamps.
 */
import {
  type CivilDateTime,
  civilFromDays,
  daysFromCivil,
  daysInMonth,
  epochMsFromCivilUTC,
  isRepresentableInstant,
  resolveWallClock,
  wallClockInZone,
  weekdayFromEpochDay,
} from "./civil";

export type Frequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export interface RRuleParts {
  freq: Frequency;
  interval: number;
  count?: number;
  /** Inclusive upper bound, as an instant. */
  untilEpochMs?: number;
  /** Weekday numbers, 0 = Sunday, sorted. */
  byDay?: number[];
}

export interface RRuleParseFailure {
  ok: false;
  error: string;
}

export type RRuleParseResult = { ok: true; parts: RRuleParts } | RRuleParseFailure;

const WEEKDAY_CODES: ReadonlyMap<string, number> = new Map([
  ["SU", 0],
  ["MO", 1],
  ["TU", 2],
  ["WE", 3],
  ["TH", 4],
  ["FR", 5],
  ["SA", 6],
]);

const UNSUPPORTED_PARTS: ReadonlyArray<string> = Object.freeze([
  "BYMONTH",
  "BYMONTHDAY",
  "BYYEARDAY",
  "BYWEEKNO",
  "BYHOUR",
  "BYMINUTE",
  "BYSECOND",
  "BYSETPOS",
  "WKST",
  "RSCALE",
  "SKIP",
]);

/** Parse `UNTIL`, which RFC 5545 writes in ISO basic form. */
function parseUntil(raw: string): number | string {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(raw.trim());
  if (m === null) {
    return `UNTIL must be a basic-form date or UTC date-time (20261231 or 20261231T235959Z), got "${raw}"`;
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return `UNTIL "${raw}" is not a real date`;
  }
  // RFC 5545 §3.3.10: a date-time UNTIL "MUST be specified as a date with UTC
  // time", so the trailing Z is required rather than assumed. Reading a
  // floating local time as if it were UTC would shift the end of the series by
  // the caller's offset without saying so.
  if (m[4] !== undefined && m[7] === undefined) {
    return `UNTIL "${raw}" has a time but no trailing Z — RFC 5545 requires a date-time UNTIL to be in UTC (20261231T235959Z)`;
  }
  const hour = Number(m[4] ?? "23");
  const minute = Number(m[5] ?? "59");
  const second = Number(m[6] ?? "59");
  if (hour > 23 || minute > 59 || second > 59) return `UNTIL "${raw}" has an impossible time`;
  return (
    daysFromCivil(year, month, day) * 86_400_000 +
    hour * 3_600_000 +
    minute * 60_000 +
    second * 1000 +
    (m[4] === undefined ? 999 : 0)
  );
}

/** Parse an RRULE string, with or without the `RRULE:` prefix. */
export function parseRRule(input: string): RRuleParseResult {
  const text = input.trim().replace(/^RRULE:/i, "");
  if (text === "") return { ok: false, error: "empty RRULE" };
  const parts: Record<string, string> = {};
  for (const chunk of text.split(";")) {
    if (chunk === "") continue;
    const eq = chunk.indexOf("=");
    if (eq === -1) return { ok: false, error: `"${chunk}" is not a NAME=VALUE pair` };
    parts[chunk.slice(0, eq).trim().toUpperCase()] = chunk.slice(eq + 1).trim();
  }
  const present = Object.keys(parts);
  const unsupported = present.filter((k) => UNSUPPORTED_PARTS.includes(k));
  if (unsupported.length > 0) {
    return {
      ok: false,
      error: `${unsupported.join(", ")} ${unsupported.length === 1 ? "is" : "are"} not supported by this expander — supported parts are FREQ, INTERVAL, COUNT, UNTIL and plain BYDAY`,
    };
  }
  const unknown = present.filter(
    (k) => !["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY"].includes(k),
  );
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `unknown RRULE part${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    };
  }

  const freqRaw = (parts["FREQ"] ?? "").toUpperCase();
  if (freqRaw === "HOURLY" || freqRaw === "MINUTELY" || freqRaw === "SECONDLY") {
    return {
      ok: false,
      error: `FREQ=${freqRaw} is not supported — use DateRange for sub-daily steps`,
    };
  }
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freqRaw)) {
    return { ok: false, error: "FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY" };
  }
  const freq = freqRaw as Frequency;

  let interval = 1;
  if (parts["INTERVAL"] !== undefined) {
    if (!/^\d+$/.test(parts["INTERVAL"]) || Number(parts["INTERVAL"]) === 0) {
      return {
        ok: false,
        error: `INTERVAL must be a positive integer, got "${parts["INTERVAL"]}"`,
      };
    }
    interval = Number(parts["INTERVAL"]);
  }

  let count: number | undefined;
  if (parts["COUNT"] !== undefined) {
    if (!/^\d+$/.test(parts["COUNT"]) || Number(parts["COUNT"]) === 0) {
      return { ok: false, error: `COUNT must be a positive integer, got "${parts["COUNT"]}"` };
    }
    count = Number(parts["COUNT"]);
  }

  let untilEpochMs: number | undefined;
  if (parts["UNTIL"] !== undefined) {
    if (count !== undefined) return { ok: false, error: "COUNT and UNTIL must not both be set" };
    const parsed = parseUntil(parts["UNTIL"]);
    if (typeof parsed === "string") return { ok: false, error: parsed };
    untilEpochMs = parsed;
  }

  let byDay: number[] | undefined;
  if (parts["BYDAY"] !== undefined) {
    if (freq === "YEARLY") {
      return {
        ok: false,
        error:
          "BYDAY with FREQ=YEARLY is not supported — it needs BYMONTH or BYSETPOS to be useful, and neither is implemented",
      };
    }
    const codes = parts["BYDAY"].split(",").map((c) => c.trim().toUpperCase());
    const days: number[] = [];
    for (const code of codes) {
      if (/^[+-]?\d/.test(code)) {
        return {
          ok: false,
          error: `positional BYDAY ("${code}", meaning the nth weekday of the period) is not supported`,
        };
      }
      const day = WEEKDAY_CODES.get(code);
      if (day === undefined) return { ok: false, error: `"${code}" is not a weekday code` };
      days.push(day);
    }
    if (days.length === 0) return { ok: false, error: "BYDAY is empty" };
    byDay = [...new Set(days)].sort((a, b) => a - b);
  }

  return {
    ok: true,
    parts: {
      freq,
      interval,
      ...(count !== undefined ? { count } : {}),
      ...(untilEpochMs !== undefined ? { untilEpochMs } : {}),
      ...(byDay !== undefined ? { byDay } : {}),
    },
  };
}

export interface ExpandResult {
  instants: number[];
  /** True when `limit` cut the series short, rather than COUNT or UNTIL ending it. */
  truncated: boolean;
  /** Dates the rule named that do not exist (a 31st in a 30-day month). */
  skippedInvalidDates: string[];
  notes: string[];
}

/** The most occurrences the expander will ever produce in one call. */
export const MAX_OCCURRENCES = 1000;

/**
 * Expand a rule from an explicit start instant. The start is always the first
 * occurrence when it satisfies the rule, as RFC 5545 requires; with `BYDAY` it
 * is included only if its weekday is listed.
 */
export function expandRecurrence(
  startEpochMs: number,
  timeZone: string,
  parts: RRuleParts,
  limit: number,
): ExpandResult {
  const countCap = parts.count ?? Number.POSITIVE_INFINITY;
  const cap = Math.min(limit, countCap, MAX_OCCURRENCES);
  // Walk one occurrence past the cap so `truncated` can distinguish "the series
  // ends here" from "the caller's limit cut it". Without the extra probe a rule
  // whose COUNT/UNTIL happens to land exactly on `limit` reports truncated.
  const probe = cap + 1;
  const start = wallClockInZone(startEpochMs, timeZone);
  const time = {
    hour: start.hour,
    minute: start.minute,
    second: start.second,
    millisecond: start.millisecond,
  };
  const instants: number[] = [];
  const skippedInvalidDates: string[] = [];
  const notes: string[] = [];
  let truncated = false;
  // How much of the other two arrays belongs to the capped window. The probe
  // occurrence walks past it and can record a skipped date or a DST note of its
  // own, which must not leak into a result the caller never sees.
  let skipsAtCap = -1;
  let notesAtCap = -1;

  const emit = (year: number, month: number, day: number): "ok" | "past-until" => {
    const wall: CivilDateTime = { year, month, day, ...time };
    // A large INTERVAL walks out of the representable range long before the
    // period guard trips. Stop the series there rather than letting the zone
    // lookup throw, and say why the list is shorter than asked for.
    if (!isRepresentableInstant(epochMsFromCivilUTC(wall))) {
      notes.push(
        `the series was cut at ${year}: later occurrences fall outside the representable range (+/-8.64e15 ms)`,
      );
      return "past-until";
    }
    const resolved = resolveWallClock(wall, timeZone);
    if (resolved.resolution === "nonexistent") {
      notes.push(
        `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} has no such wall clock in ${timeZone} (DST gap); the instant just after the gap was used`,
      );
    }
    if (parts.untilEpochMs !== undefined && resolved.epochMs > parts.untilEpochMs)
      return "past-until";
    if (resolved.epochMs < startEpochMs) return "ok";
    instants.push(resolved.epochMs);
    if (instants.length === cap) {
      skipsAtCap = skippedInvalidDates.length;
      notesAtCap = notes.length;
    }
    return "ok";
  };

  const startDay = daysFromCivil(start.year, start.month, start.day);

  if (parts.freq === "DAILY") {
    let day = startDay;
    let periods = 0;
    while (instants.length < probe && periods < MAX_OCCURRENCES * 8) {
      const civil = civilFromDays(day);
      const matches = parts.byDay === undefined || parts.byDay.includes(weekdayFromEpochDay(day));
      if (matches && emit(civil.year, civil.month, civil.day) === "past-until") break;
      day += parts.interval;
      periods += 1;
    }
  } else if (parts.freq === "WEEKLY") {
    // Weeks run Monday..Sunday; walk week starts, then the days inside each.
    const isoDow = weekdayFromEpochDay(startDay) === 0 ? 7 : weekdayFromEpochDay(startDay);
    let weekStart = startDay - (isoDow - 1);
    const days = parts.byDay ?? [weekdayFromEpochDay(startDay)];
    let periods = 0;
    outer: while (instants.length < probe && periods < MAX_OCCURRENCES * 8) {
      for (let offset = 0; offset < 7; offset += 1) {
        const day = weekStart + offset;
        if (!days.includes(weekdayFromEpochDay(day))) continue;
        if (day < startDay) continue;
        const civil = civilFromDays(day);
        if (emit(civil.year, civil.month, civil.day) === "past-until") break outer;
        if (instants.length >= probe) break outer;
      }
      weekStart += 7 * parts.interval;
      periods += 1;
    }
  } else if (parts.freq === "MONTHLY") {
    let monthIndex = start.year * 12 + (start.month - 1);
    let periods = 0;
    outer: while (instants.length < probe && periods < MAX_OCCURRENCES * 8) {
      const year = Math.floor(monthIndex / 12);
      const month = monthIndex - year * 12 + 1;
      if (parts.byDay === undefined) {
        if (start.day > daysInMonth(year, month)) {
          skippedInvalidDates.push(`${year}-${String(month).padStart(2, "0")}-${start.day}`);
        } else if (emit(year, month, start.day) === "past-until") {
          break;
        }
      } else {
        const last = daysInMonth(year, month);
        for (let day = 1; day <= last; day += 1) {
          if (!parts.byDay.includes(weekdayFromEpochDay(daysFromCivil(year, month, day)))) continue;
          if (daysFromCivil(year, month, day) < startDay) continue;
          if (emit(year, month, day) === "past-until") break outer;
          if (instants.length >= probe) break outer;
        }
      }
      monthIndex += parts.interval;
      periods += 1;
    }
  } else {
    let year = start.year;
    let periods = 0;
    while (instants.length < probe && periods < MAX_OCCURRENCES * 8) {
      if (start.day > daysInMonth(year, start.month)) {
        skippedInvalidDates.push(`${year}-${String(start.month).padStart(2, "0")}-${start.day}`);
      } else if (emit(year, start.month, start.day) === "past-until") {
        break;
      }
      year += parts.interval;
      periods += 1;
    }
  }

  // The probe occurrence proves a next one exists; drop it and report the cut.
  // A COUNT that equals the cap is the rule ending, not the limit biting.
  if (instants.length > cap) {
    truncated = cap < countCap;
    instants.length = cap;
    if (skipsAtCap >= 0) skippedInvalidDates.length = skipsAtCap;
    if (notesAtCap >= 0) notes.length = notesAtCap;
  }
  if (skippedInvalidDates.length > 0) {
    notes.push(
      `${skippedInvalidDates.length} occurrence(s) skipped because the date does not exist in that month, per RFC 5545 (DateAdd would clamp instead)`,
    );
  }
  return { instants, truncated, skippedInvalidDates, notes };
}
