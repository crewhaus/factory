/**
 * Calendar and elapsed-time arithmetic.
 *
 * The distinction that runs through this file: a day is not always 86,400,000
 * milliseconds and a month is not a fixed length. Calendar units (years,
 * months, weeks, days) are added to the *wall clock* in a zone, so "tomorrow at
 * 09:00" stays 09:00 across a DST change. Time units (hours and smaller) are
 * added to the *instant*, so "in 24 hours" is 24 actual hours even when that
 * lands on a different wall-clock hour. Mixing both in one call applies the
 * calendar part first.
 */
import {
  type CivilDateTime,
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  MS_PER_SECOND,
  civilFromDays,
  daysFromCivil,
  daysInMonth,
  epochMsFromCivilUTC,
  isRepresentableInstant,
  outOfRangeMessage,
  resolveWallClock,
  wallClockInZone,
  weekdayFromEpochDay,
  zoneOffsetMinutes,
} from "./civil";

export const CALENDAR_UNITS = ["years", "months", "weeks", "days"] as const;
export const TIME_UNITS = ["hours", "minutes", "seconds", "milliseconds"] as const;
export const ALL_UNITS = [...CALENDAR_UNITS, ...TIME_UNITS] as const;
export type Unit = (typeof ALL_UNITS)[number];

export type UnitAmounts = Partial<Record<Unit, number>>;

/** Milliseconds in each fixed-length unit. Years and months are absent on purpose. */
export const MS_PER_UNIT: Readonly<
  Record<"weeks" | "days" | "hours" | "minutes" | "seconds" | "milliseconds", number>
> = Object.freeze({
  weeks: MS_PER_DAY * 7,
  days: MS_PER_DAY,
  hours: MS_PER_HOUR,
  minutes: MS_PER_MINUTE,
  seconds: MS_PER_SECOND,
  milliseconds: 1,
});

/**
 * Add years and months to a wall clock, clamping to the end of the target
 * month.
 *
 * The clamp is the rule every calendar library has to choose and few state:
 * 2026-01-31 plus one month is 2026-02-28, not 2026-03-03. It follows that the
 * operation is not reversible — subtracting one month from 2026-02-28 gives
 * 2026-01-28 — and not associative, so adding 12 months once is not always the
 * same as adding one month twelve times. Add the largest unit in one step.
 */
export function addCalendarMonths(wall: CivilDateTime, months: number): CivilDateTime {
  const totalMonths = wall.year * 12 + (wall.month - 1) + months;
  const year = Math.floor(totalMonths / 12);
  const month = totalMonths - year * 12 + 1;
  const day = Math.min(wall.day, daysInMonth(year, month));
  return { ...wall, year, month, day };
}

/** Add whole days to a wall clock, leaving the time of day alone. */
export function addCalendarDays(wall: CivilDateTime, days: number): CivilDateTime {
  const civil = civilFromDays(daysFromCivil(wall.year, wall.month, wall.day) + days);
  return { ...wall, ...civil };
}

export interface AddResult {
  epochMs: number;
  offsetMinutes: number;
  notes: string[];
}

/**
 * Add a mixture of units to an instant, as seen from `timeZone`.
 *
 * Calendar units move the wall clock and are then re-resolved against the zone,
 * which is where a DST gap or repeat can show up; time units are added to the
 * resulting instant directly.
 */
export function addToInstant(epochMs: number, timeZone: string, amounts: UnitAmounts): AddResult {
  const notes: string[] = [];
  const years = amounts.years ?? 0;
  const months = amounts.months ?? 0;
  const weeks = amounts.weeks ?? 0;
  const days = amounts.days ?? 0;
  let current = epochMs;

  if (years !== 0 || months !== 0 || weeks !== 0 || days !== 0) {
    const wall = wallClockInZone(current, timeZone);
    let moved = wall;
    if (years !== 0 || months !== 0) {
      moved = addCalendarMonths(moved, years * 12 + months);
      const original = wallClockInZone(current, timeZone);
      if (moved.day !== original.day) {
        notes.push(
          `day clamped from ${original.day} to ${moved.day} because the target month is shorter`,
        );
      }
    }
    if (weeks !== 0 || days !== 0) moved = addCalendarDays(moved, weeks * 7 + days);
    // Check before the zone lookup: past the representable range `Intl` throws
    // a bare RangeError, and the caller deserves to hear which amount did it.
    if (!isRepresentableInstant(epochMsFromCivilUTC(moved))) {
      throw new RangeError(outOfRangeMessage("the result of this addition"));
    }
    const resolved = resolveWallClock(moved, timeZone);
    if (resolved.resolution === "ambiguous") {
      notes.push(
        "the resulting wall clock occurs twice (DST fall back); the earlier instant was used",
      );
    } else if (resolved.resolution === "nonexistent") {
      notes.push(
        "the resulting wall clock does not occur (DST spring forward); the instant just after the gap was used",
      );
    }
    current = resolved.epochMs;
  }

  const elapsed =
    (amounts.hours ?? 0) * MS_PER_HOUR +
    (amounts.minutes ?? 0) * MS_PER_MINUTE +
    (amounts.seconds ?? 0) * MS_PER_SECOND +
    (amounts.milliseconds ?? 0);
  current += elapsed;
  if (!isRepresentableInstant(current)) {
    throw new RangeError(outOfRangeMessage("the result of this addition"));
  }
  return { epochMs: current, offsetMinutes: zoneOffsetMinutes(current, timeZone), notes };
}

/**
 * Whole calendar months from `a` to `b` as wall clocks, truncated toward zero.
 *
 * Defined as the inverse of {@link addCalendarMonths}, clamp included: because
 * 31 January plus one month is 28 February, 31 January to 28 February counts as
 * one whole month, while 31 January to 27 February counts as none.
 */
export function diffCalendarMonths(a: CivilDateTime, b: CivilDateTime): number {
  const sign = compareWallClocks(a, b) <= 0 ? 1 : -1;
  const [from, to] = sign === 1 ? [a, b] : [b, a];
  let months = (to.year - from.year) * 12 + (to.month - from.month);
  if (months > 0 && compareWallClocks(addCalendarMonths(from, months), to) > 0) months -= 1;
  return months * sign;
}

/** Order two wall clocks: -1, 0 or 1. */
export function compareWallClocks(a: CivilDateTime, b: CivilDateTime): number {
  const av = epochMsFromCivilUTC(a);
  const bv = epochMsFromCivilUTC(b);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

export interface Breakdown {
  years: number;
  months: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  milliseconds: number;
}

/**
 * The calendar breakdown between two wall clocks: how many whole years, then
 * whole months, then whole days, and so on. Always non-negative; the caller
 * reports the direction separately.
 */
export function breakdownBetween(a: CivilDateTime, b: CivilDateTime): Breakdown {
  const [from, to] = compareWallClocks(a, b) <= 0 ? [a, b] : [b, a];
  const totalMonths = Math.abs(diffCalendarMonths(from, to));
  const afterMonths = addCalendarMonths(from, totalMonths);
  let remainder = epochMsFromCivilUTC(to) - epochMsFromCivilUTC(afterMonths);
  const days = Math.floor(remainder / MS_PER_DAY);
  remainder -= days * MS_PER_DAY;
  const hours = Math.floor(remainder / MS_PER_HOUR);
  remainder -= hours * MS_PER_HOUR;
  const minutes = Math.floor(remainder / MS_PER_MINUTE);
  remainder -= minutes * MS_PER_MINUTE;
  const seconds = Math.floor(remainder / MS_PER_SECOND);
  remainder -= seconds * MS_PER_SECOND;
  return {
    years: Math.floor(totalMonths / 12),
    months: totalMonths % 12,
    days,
    hours,
    minutes,
    seconds,
    milliseconds: remainder,
  };
}

/** Whole calendar days crossed between two wall clocks, ignoring the time of day. */
export function diffCalendarDays(a: CivilDateTime, b: CivilDateTime): number {
  return daysFromCivil(b.year, b.month, b.day) - daysFromCivil(a.year, a.month, a.day);
}

// ---------------------------------------------------------------------------
// Business days

export interface BusinessCalendar {
  /** Weekday numbers that are not worked, 0 = Sunday. */
  weekend: ReadonlySet<number>;
  /** Epoch day numbers that are holidays. */
  holidays: ReadonlySet<number>;
}

export function isBusinessDay(epochDay: number, calendar: BusinessCalendar): boolean {
  if (calendar.weekend.has(weekdayFromEpochDay(epochDay))) return false;
  return !calendar.holidays.has(epochDay);
}

/** The widest span the business-day walkers will scan, about 270 years. */
export const MAX_BUSINESS_DAY_SPAN = 100_000;

/**
 * Business days between two dates. Both endpoints are counted when
 * `endInclusive`, which matches the spreadsheet NETWORKDAYS convention; with it
 * off the range is half-open and counting Mon..Fri gives 4. The result is
 * negative when `endDay` precedes `startDay`.
 */
export function countBusinessDays(
  startDay: number,
  endDay: number,
  calendar: BusinessCalendar,
  endInclusive: boolean,
): number {
  const sign = endDay >= startDay ? 1 : -1;
  const from = Math.min(startDay, endDay);
  const to = Math.max(startDay, endDay);
  const last = endInclusive ? to : to - 1;
  if (last - from > MAX_BUSINESS_DAY_SPAN) {
    throw new RangeError(
      `span of ${last - from} days exceeds the ${MAX_BUSINESS_DAY_SPAN}-day limit`,
    );
  }
  let count = 0;
  for (let day = from; day <= last; day += 1) {
    if (isBusinessDay(day, calendar)) count += 1;
  }
  return count * sign;
}

export interface AddBusinessDaysResult {
  epochDay: number;
  /** Non-business days stepped over on the way. */
  skipped: number;
  startWasBusinessDay: boolean;
}

/**
 * Move `count` business days from `startDay`. A count of 0 does not move, so
 * the caller can ask "is this a working day" without a second call. The start
 * day is never counted; moving 1 business day from a Friday lands on Monday.
 */
export function addBusinessDays(
  startDay: number,
  count: number,
  calendar: BusinessCalendar,
): AddBusinessDaysResult {
  const startWasBusinessDay = isBusinessDay(startDay, calendar);
  if (count === 0) return { epochDay: startDay, skipped: 0, startWasBusinessDay };
  const step = count > 0 ? 1 : -1;
  let remaining = Math.abs(count);
  let day = startDay;
  let skipped = 0;
  let guard = 0;
  while (remaining > 0) {
    day += step;
    guard += 1;
    if (guard > MAX_BUSINESS_DAY_SPAN) {
      throw new RangeError(
        `walked ${MAX_BUSINESS_DAY_SPAN} days without finishing — is every weekday a non-working day?`,
      );
    }
    if (isBusinessDay(day, calendar)) remaining -= 1;
    else skipped += 1;
  }
  return { epochDay: day, skipped, startWasBusinessDay };
}

// ---------------------------------------------------------------------------
// Ranges

export interface RangeStep {
  unit: Unit;
  amount: number;
}

export interface RangeResult {
  instants: number[];
  truncated: boolean;
}

/**
 * Every instant from `start`, stepping by `step`, up to `end`.
 *
 * Each item is computed as `start + n * step`, not by adding one step to the
 * previous item. With calendar units that matters: anchoring on the start makes
 * a monthly range from 31 January run 31 Jan, 28 Feb, 31 Mar, where iterating
 * would clamp once and then stay on the 28th for good.
 *
 * Capped at `maxItems`; a step that fails to advance is rejected rather than
 * looped on.
 */
export function expandRange(
  start: number,
  end: number,
  step: RangeStep,
  timeZone: string,
  maxItems: number,
  endInclusive: boolean,
): RangeResult {
  if (step.amount === 0) throw new RangeError("step amount must not be zero");
  const forward = end >= start;
  if (forward !== step.amount > 0) {
    throw new RangeError(
      forward
        ? "end is after start, so the step amount must be positive"
        : "end is before start, so the step amount must be negative",
    );
  }
  const past = (value: number): boolean =>
    forward
      ? endInclusive
        ? value > end
        : value >= end
      : endInclusive
        ? value < end
        : value <= end;

  const instants: number[] = [];
  let index = 0;
  let current = start;
  while (instants.length < maxItems) {
    if (past(current)) return { instants, truncated: false };
    instants.push(current);
    index += 1;
    const next = addToInstant(start, timeZone, { [step.unit]: step.amount * index }).epochMs;
    if (next === current) throw new RangeError("step does not advance the clock");
    current = next;
  }
  return { instants, truncated: !past(current) };
}
