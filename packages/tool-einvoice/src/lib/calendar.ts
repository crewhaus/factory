/**
 * The two settlement calendars the payment formats need.
 *
 * A file with a settlement date the system does not settle on is not rejected
 * — it is held, and then it settles on a day nobody planned for. That is worse
 * than a rejection, so `PaymentFileBuild` refuses such a date by default and
 * names the calendar it used, or moves it forward and reports BOTH dates when
 * the caller asks for that explicitly.
 *
 * ## What these calendars are, exactly
 *
 * - TARGET2 closes on Saturday, Sunday, 1 January, Good Friday, Easter
 *   Monday, 1 May, 25 December and 26 December. That is the whole list: the
 *   national bank holidays of the twenty-odd SEPA countries are NOT in it, and
 *   a bank closed for one of those will still hold the file.
 * - The US Federal Reserve closes on Saturday, Sunday and eleven federal
 *   holidays, with the observance rule that a holiday falling on a Sunday is
 *   taken on the Monday and one falling on a Saturday is NOT taken on the
 *   Friday — the Fed's rule, which differs from the federal-employee one and
 *   is the one that matters for ACH settlement.
 *
 * Everything here is arithmetic on a date string. No clock is read anywhere in
 * this package: a payment file whose bytes depend on when it was built cannot
 * be diffed against the one you sent.
 */

export const CALENDARS = ["target2", "usfed"] as const;
export type Calendar = (typeof CALENDARS)[number];

export class CalendarError extends Error {
  override readonly name = "CalendarError";
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A date as UTC milliseconds, refusing anything that is not a real calendar date. */
export function parseIsoDate(text: string, label: string): number {
  const match = ISO_DATE.exec(text.trim());
  if (match === null) {
    throw new CalendarError(`${label} ("${text}") is not a date written as YYYY-MM-DD`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    throw new CalendarError(`${label} ("${text}") is not a real calendar date`);
  }
  return ms;
}

export function formatIsoDate(ms: number): string {
  const date = new Date(ms);
  const y = date.getUTCFullYear().toString().padStart(4, "0");
  const m = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = date.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const DAY_MS = 86_400_000;

/**
 * Easter Sunday in the Gregorian calendar, by the anonymous computus.
 *
 * Good Friday and Easter Monday are TARGET2 closing days and they move, so
 * there is no table to look them up in — this is the table.
 */
export function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/** Why TARGET2 is closed on this date, or `null` when it is open. */
export function target2Closure(ms: number): string | null {
  const date = new Date(ms);
  const weekday = date.getUTCDay();
  if (weekday === 0) return "a Sunday";
  if (weekday === 6) return "a Saturday";
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  if (month === 1 && day === 1) return "New Year's Day";
  if (month === 5 && day === 1) return "Labour Day (1 May)";
  if (month === 12 && day === 25) return "Christmas Day";
  if (month === 12 && day === 26) return "26 December";
  const easter = easterSunday(year);
  const easterMs = Date.UTC(year, easter.month - 1, easter.day);
  if (ms === easterMs - 2 * DAY_MS) return "Good Friday";
  if (ms === easterMs + DAY_MS) return "Easter Monday";
  return null;
}

/** The nth `weekday` of `month`, as UTC milliseconds. `weekday` is 0=Sunday. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  const first = Date.UTC(year, month - 1, 1);
  const shift = (weekday - new Date(first).getUTCDay() + 7) % 7;
  return first + (shift + (n - 1) * 7) * DAY_MS;
}

/** The last `weekday` of `month`, as UTC milliseconds. */
function lastWeekday(year: number, month: number, weekday: number): number {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = Date.UTC(year, month - 1, lastDay);
  const shift = (new Date(last).getUTCDay() - weekday + 7) % 7;
  return last - shift * DAY_MS;
}

/**
 * Fixed-date federal holidays. The Fed observes one falling on a SUNDAY on the
 * following Monday and does NOT close the Friday before one falling on a
 * Saturday — the federal-employee rule does the opposite, and using it here
 * would close a day the ACH network is open.
 */
const FIXED_US_HOLIDAYS: ReadonlyArray<{
  month: number;
  day: number;
  name: string;
  from?: number;
}> = Object.freeze([
  { month: 1, day: 1, name: "New Year's Day" },
  { month: 6, day: 19, name: "Juneteenth National Independence Day", from: 2021 },
  { month: 7, day: 4, name: "Independence Day" },
  { month: 11, day: 11, name: "Veterans Day" },
  { month: 12, day: 25, name: "Christmas Day" },
]);

/** Why the Federal Reserve is closed on this date, or `null` when it is open. */
export function usFedClosure(ms: number): string | null {
  const date = new Date(ms);
  const weekday = date.getUTCDay();
  if (weekday === 0) return "a Sunday";
  if (weekday === 6) return "a Saturday";
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();

  for (const holiday of FIXED_US_HOLIDAYS) {
    if (holiday.from !== undefined && year < holiday.from) continue;
    if (month === holiday.month && day === holiday.day) return holiday.name;
    if (weekday === 1) {
      const yesterday = new Date(ms - DAY_MS);
      if (
        yesterday.getUTCDay() === 0 &&
        yesterday.getUTCMonth() + 1 === holiday.month &&
        yesterday.getUTCDate() === holiday.day &&
        yesterday.getUTCFullYear() >= (holiday.from ?? 0)
      ) {
        return `${holiday.name} (observed)`;
      }
    }
  }

  if (ms === nthWeekday(year, 1, 1, 3)) return "Birthday of Martin Luther King, Jr.";
  if (ms === nthWeekday(year, 2, 1, 3)) return "Washington's Birthday";
  if (ms === lastWeekday(year, 5, 1)) return "Memorial Day";
  if (ms === nthWeekday(year, 9, 1, 1)) return "Labor Day";
  if (ms === nthWeekday(year, 10, 1, 2)) return "Columbus Day";
  if (ms === nthWeekday(year, 11, 4, 4)) return "Thanksgiving Day";
  return null;
}

export function closureReason(calendar: Calendar, ms: number): string | null {
  return calendar === "target2" ? target2Closure(ms) : usFedClosure(ms);
}

/**
 * The first settlement day on or after `ms`.
 *
 * Bounded at 30 days: an unbounded walk over a calendar with a bug in it spins
 * forever, and a loop that cannot terminate is worse than a wrong date because
 * nothing reports it.
 */
export function nextOpenDay(calendar: Calendar, ms: number): number {
  let cursor = ms;
  for (let i = 0; i < 30; i++) {
    if (closureReason(calendar, cursor) === null) return cursor;
    cursor += DAY_MS;
  }
  throw new CalendarError(
    `no ${calendar} settlement day found within 30 days of ${formatIsoDate(ms)}; this is a defect in the calendar, not in the date`,
  );
}
