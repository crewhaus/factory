/**
 * @crewhaus/tool-datetime — deterministic date and time tools.
 *
 * The rule that shapes this whole package: **nothing here reads the clock.**
 * There is no `Date.now()`, no `new Date()` without an argument, no implicit
 * "today". Every tool that needs a reference time takes it as an input field,
 * so the same call always produces the same bytes and a harness can replay,
 * cache and test its own scheduling logic.
 *
 * That is a constraint with teeth — `BusinessDays`, `CronNext` and
 * `RecurrenceExpand` all want a "now" and all make the caller supply one — and
 * it is the whole point. A tool that quietly consults the system clock cannot
 * be cached, cannot be replayed, and turns every eval into a flake.
 *
 * Timezone data comes from the runtime's `Intl` implementation, which is the
 * one input that is not a constant: it is the platform's tzdb copy. Offsets for
 * recent and near-future dates are stable across any current runtime; very old
 * or very distant ones can move with a tzdb update. Each tool that depends on
 * it says so.
 */
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import {
  ALL_UNITS,
  type Unit,
  type UnitAmounts,
  addBusinessDays,
  addToInstant,
  breakdownBetween,
  countBusinessDays,
  diffCalendarDays,
  diffCalendarMonths,
  expandRange,
} from "./lib/arithmetic";
import {
  type CivilDateTime,
  MONTH_NAMES,
  MS_PER_DAY,
  MS_PER_MINUTE,
  MS_PER_SECOND,
  WEEKDAY_NAMES,
  civilFromDays,
  dateFromDayOfYear,
  dayOfYear as dayOfYearFn,
  daysFromCivil,
  daysInMonth,
  daysInYear,
  formatOffset,
  isLeapYear as isLeapYearFn,
  isValidTimeZone,
  isoDateFromEpochMs,
  isoFromEpochMs,
  isoWeek,
  quarterOfMonth,
  simpleWeek,
  wallClockInZone,
  weekdayFromEpochDay,
  zoneAbbreviation,
  zoneOffsetMinutes,
} from "./lib/civil";
import { CRON_HORIZON_YEARS, cronNext as cronNextFn, describeCron, parseCron } from "./lib/cron";
import { type DurationStyle, type FixedUnit, formatDuration, parseDuration } from "./lib/duration";
import { FORMAT_TOKENS, NAMED_PATTERNS, formatWallClock } from "./lib/format";
import { SUPPORTED_FORMATS, parseDateString } from "./lib/parse";
import { MAX_OCCURRENCES, expandRecurrence, parseRRule } from "./lib/recurrence";

/** Compact JSON — no indentation, since the reader is a model, not a person. */
const json = (value: unknown): string => JSON.stringify(value);

/** The longest date-ish string any tool will look at. */
const MAX_TEXT = 200;

const zoneField = z
  .string()
  .max(64)
  .optional()
  .describe("IANA timezone, e.g. 'America/New_York'; defaults to UTC");

const dateOrderField = z
  .enum(["MDY", "DMY", "YMD"])
  .optional()
  .describe("field order for bare numeric dates like 03/04/2026");

function zoneError(timeZone: string): string | undefined {
  if (isValidTimeZone(timeZone)) return undefined;
  return `"${timeZone}" is not an IANA timezone this runtime knows — try 'UTC', 'America/New_York' or 'Europe/Berlin'`;
}

interface ReadInstant {
  epochMs: number;
  offsetMinutes: number;
  notes: string[];
}

/**
 * Read one instant from a caller-supplied string. Every tool funnels through
 * this so the accepted grammar, and the error when it does not match, are the
 * same everywhere.
 */
function readInstant(
  text: string,
  assumeTimeZone: string,
  dateOrder?: "MDY" | "DMY" | "YMD",
): ReadInstant | string {
  const parsed = parseDateString(text, {
    ...(dateOrder !== undefined ? { dateOrder } : {}),
    assumeTimeZone,
    twoDigitYearPivot: 68,
  });
  if (!parsed.ok) {
    if (parsed.ambiguous !== undefined) {
      return `${parsed.error}: ${parsed.ambiguous.interpretations.map((i) => `${i.dateOrder} => ${i.date}`).join(", ")}`;
    }
    return parsed.error;
  }
  return { epochMs: parsed.epochMs, offsetMinutes: parsed.offsetMinutes, notes: parsed.notes };
}

/** The standard component block returned wherever a tool describes an instant. */
function describeInstant(epochMs: number, timeZone: string): Record<string, unknown> {
  const offset = zoneOffsetMinutes(epochMs, timeZone);
  const wall = wallClockInZone(epochMs, timeZone);
  const epochDay = daysFromCivil(wall.year, wall.month, wall.day);
  const week = isoWeek(wall.year, wall.month, wall.day);
  return {
    utc: isoFromEpochMs(epochMs, 0),
    local: isoFromEpochMs(epochMs, offset),
    timeZone,
    offsetMinutes: offset,
    offset: formatOffset(offset, "extended"),
    abbreviation: zoneAbbreviation(epochMs, timeZone),
    epochMs,
    epochSeconds: Math.floor(epochMs / MS_PER_SECOND),
    year: wall.year,
    month: wall.month,
    day: wall.day,
    hour: wall.hour,
    minute: wall.minute,
    second: wall.second,
    millisecond: wall.millisecond,
    weekday: WEEKDAY_NAMES[weekdayFromEpochDay(epochDay)] ?? "",
    weekdayNumber: weekdayFromEpochDay(epochDay),
    dayOfYear: dayOfYearFn(wall.year, wall.month, wall.day),
    isoWeek: week.week,
    isoWeekYear: week.weekYear,
    quarter: quarterOfMonth(wall.month, 1),
  };
}

// ---------------------------------------------------------------------------

export const dateParse: RegisteredTool = buildTool({
  name: "DateParse",
  description:
    "Parse a date string into a normalized UTC instant plus its calendar components, reporting ambiguity instead of guessing at it. Use to turn a scraped, typed or logged date into something the rest of the harness can compute on, and to find out when a string like 03/04/2026 does not determine a date at all.",
  inputSchema: z.object({
    text: z.string().min(1).max(MAX_TEXT).describe("the date string to read"),
    dateOrder: dateOrderField,
    assumeTimeZone: zoneField.describe(
      "IANA timezone applied when the string carries no UTC offset; defaults to UTC",
    ),
    twoDigitYearPivot: z
      .number()
      .int()
      .min(0)
      .max(99)
      .optional()
      .describe("two-digit years at or below this map to 2000s, above to 1900s; defaults to 68"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const timeZone = input.assumeTimeZone ?? "UTC";
    const badZone = zoneError(timeZone);
    if (badZone !== undefined) return badZone;
    const parsed = parseDateString(input.text, {
      ...(input.dateOrder !== undefined ? { dateOrder: input.dateOrder } : {}),
      assumeTimeZone: timeZone,
      twoDigitYearPivot: input.twoDigitYearPivot ?? 68,
    });
    if (!parsed.ok) {
      return json({
        ok: false,
        error: parsed.error,
        ...(parsed.ambiguous !== undefined ? { ambiguous: parsed.ambiguous } : {}),
        supportedFormats: SUPPORTED_FORMATS,
      });
    }
    return json({
      ok: true,
      format: parsed.format,
      hadTime: parsed.hadTime,
      hadOffset: parsed.hadOffset,
      ...(parsed.wallClockResolution !== undefined
        ? { wallClockResolution: parsed.wallClockResolution }
        : {}),
      ...describeInstant(parsed.epochMs, timeZone),
      ...(parsed.notes.length > 0 ? { notes: parsed.notes } : {}),
    });
  },
});

export const dateFormat: RegisteredTool = buildTool({
  name: "DateFormat",
  description:
    "Render an instant through a token pattern (YYYY, MM, DD, HH, mm, ss, month and weekday names) in a chosen IANA timezone. Use for log prefixes, filenames, report headers and anything else where the exact characters matter more than a locale's preferences.",
  inputSchema: z.object({
    instant: z.string().min(1).max(MAX_TEXT).describe("the instant to render, as a date string"),
    pattern: z
      .string()
      .max(200)
      .optional()
      .describe("token pattern; text in [square brackets] passes through literally"),
    preset: z
      .enum(
        Object.keys(NAMED_PATTERNS) as [
          keyof typeof NAMED_PATTERNS,
          ...(keyof typeof NAMED_PATTERNS)[],
        ],
      )
      .optional()
      .describe("a named pattern instead of writing one; wins over `pattern`"),
    timeZone: zoneField,
    locale: z
      .string()
      .max(35)
      .optional()
      .describe(
        "BCP 47 tag for month and weekday names; defaults to en-US. Non-English names come from the runtime's CLDR data",
      ),
    listTokens: z.boolean().optional().describe("return the token reference instead of a date"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    if (input.listTokens === true) {
      return json({ tokens: FORMAT_TOKENS, presets: NAMED_PATTERNS });
    }
    const timeZone = input.timeZone ?? "UTC";
    const badZone = zoneError(timeZone);
    if (badZone !== undefined) return badZone;
    const instant = readInstant(input.instant, timeZone);
    if (typeof instant === "string") return `could not read instant: ${instant}`;
    const pattern =
      input.preset !== undefined
        ? NAMED_PATTERNS[input.preset]
        : (input.pattern ?? NAMED_PATTERNS["iso"]);
    if (pattern === undefined) return "no pattern resolved";
    const offsetMinutes = zoneOffsetMinutes(instant.epochMs, timeZone);
    return formatWallClock(pattern, {
      wall: wallClockInZone(instant.epochMs, timeZone),
      offsetMinutes,
      epochMs: instant.epochMs,
      abbreviation: zoneAbbreviation(instant.epochMs, timeZone),
      locale: input.locale ?? "en-US",
    });
  },
});

export const dateConvertTimezone: RegisteredTool = buildTool({
  name: "DateConvertTimezone",
  description:
    "Move an instant between IANA timezones, reporting the UTC offset and abbreviation that applied at that moment rather than today's. Use to answer what time a deploy window, a meeting or a log line lands at somewhere else, including across a DST boundary.",
  inputSchema: z.object({
    instant: z.string().min(1).max(MAX_TEXT),
    toTimeZone: z.string().min(1).max(64).describe("IANA timezone to convert into"),
    fromTimeZone: zoneField.describe(
      "IANA timezone the instant is written in, used only when it carries no UTC offset; defaults to UTC",
    ),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const from = input.fromTimeZone ?? "UTC";
    for (const zone of [from, input.toTimeZone]) {
      const bad = zoneError(zone);
      if (bad !== undefined) return bad;
    }
    const instant = readInstant(input.instant, from);
    if (typeof instant === "string") return `could not read instant: ${instant}`;
    const fromOffset = zoneOffsetMinutes(instant.epochMs, from);
    const toOffset = zoneOffsetMinutes(instant.epochMs, input.toTimeZone);
    return json({
      utc: isoFromEpochMs(instant.epochMs, 0),
      from: {
        timeZone: from,
        local: isoFromEpochMs(instant.epochMs, fromOffset),
        offset: formatOffset(fromOffset, "extended"),
        offsetMinutes: fromOffset,
        abbreviation: zoneAbbreviation(instant.epochMs, from),
      },
      to: {
        timeZone: input.toTimeZone,
        local: isoFromEpochMs(instant.epochMs, toOffset),
        offset: formatOffset(toOffset, "extended"),
        offsetMinutes: toOffset,
        abbreviation: zoneAbbreviation(instant.epochMs, input.toTimeZone),
      },
      differenceMinutes: toOffset - fromOffset,
      differenceHours: (toOffset - fromOffset) / 60,
      note: "offsets are the ones in force at this instant, from the runtime's tzdb copy",
    });
  },
});

const amountField = z.number().int().min(-1_000_000).max(1_000_000).optional();

export const dateAdd: RegisteredTool = buildTool({
  name: "DateAdd",
  description:
    "Add or subtract years, months, weeks, days, hours, minutes, seconds and milliseconds from an instant, clamping to the end of a short month and saying when it did. Use for deadlines, retention windows, retry backoffs and 'same time next month' scheduling, where Jan 31 + 1 month must land on Feb 28 rather than March 3.",
  inputSchema: z.object({
    instant: z.string().min(1).max(MAX_TEXT),
    years: amountField,
    months: amountField,
    weeks: amountField,
    days: amountField,
    hours: amountField,
    minutes: amountField,
    seconds: amountField,
    milliseconds: amountField,
    timeZone: zoneField.describe(
      "zone whose wall clock the calendar units move in; hours and smaller are added to the instant itself. Defaults to UTC",
    ),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const timeZone = input.timeZone ?? "UTC";
    const badZone = zoneError(timeZone);
    if (badZone !== undefined) return badZone;
    const instant = readInstant(input.instant, timeZone);
    if (typeof instant === "string") return `could not read instant: ${instant}`;
    const amounts: UnitAmounts = {};
    for (const unit of ALL_UNITS) {
      const value = input[unit];
      if (typeof value === "number" && value !== 0) amounts[unit] = value;
    }
    if (Object.keys(amounts).length === 0) {
      return json({
        ...describeInstant(instant.epochMs, timeZone),
        note: "no amounts given, so the instant is unchanged",
      });
    }
    try {
      const result = addToInstant(instant.epochMs, timeZone, amounts);
      return json({
        ...describeInstant(result.epochMs, timeZone),
        from: isoFromEpochMs(instant.epochMs, 0),
        applied: amounts,
        elapsedMilliseconds: result.epochMs - instant.epochMs,
        ...(result.notes.length > 0 ? { notes: result.notes } : {}),
        rule: "calendar units are applied first, largest to smallest, clamping to the last day of a shorter month; hours and smaller are then added to the instant",
      });
    } catch (err) {
      // An amount inside the schema's bounds can still land outside what a
      // date can represent; that is the caller's mistake to read, not a crash.
      return (err as Error).message;
    }
  },
});

export const dateDiff: RegisteredTool = buildTool({
  name: "DateDiff",
  description:
    "Measure the distance between two instants in a chosen unit, plus a full years/months/days/hours breakdown. Use for SLA age, time-to-resolution, retention checks and 'how long until', where the difference between elapsed hours and calendar days actually matters.",
  inputSchema: z.object({
    from: z.string().min(1).max(MAX_TEXT),
    to: z.string().min(1).max(MAX_TEXT),
    unit: z
      .enum(["years", "months", "weeks", "days", "hours", "minutes", "seconds", "milliseconds"])
      .optional()
      .describe("unit for the headline number; defaults to days"),
    calendar: z
      .boolean()
      .optional()
      .describe(
        "count whole calendar boundaries crossed in the timezone rather than elapsed time; only affects days and weeks",
      ),
    absolute: z.boolean().optional().describe("drop the sign"),
    timeZone: zoneField,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const timeZone = input.timeZone ?? "UTC";
    const badZone = zoneError(timeZone);
    if (badZone !== undefined) return badZone;
    const from = readInstant(input.from, timeZone);
    if (typeof from === "string") return `could not read 'from': ${from}`;
    const to = readInstant(input.to, timeZone);
    if (typeof to === "string") return `could not read 'to': ${to}`;

    const unit: Unit = input.unit ?? "days";
    const elapsed = to.epochMs - from.epochMs;
    const fromWall = wallClockInZone(from.epochMs, timeZone);
    const toWall = wallClockInZone(to.epochMs, timeZone);

    let value: number;
    if (unit === "years") {
      value = Math.trunc(diffCalendarMonths(fromWall, toWall) / 12);
    } else if (unit === "months") {
      value = diffCalendarMonths(fromWall, toWall);
    } else if (input.calendar === true && (unit === "days" || unit === "weeks")) {
      const calendarDays = diffCalendarDays(fromWall, toWall);
      value = unit === "days" ? calendarDays : Math.trunc(calendarDays / 7);
    } else {
      const divisor =
        unit === "weeks"
          ? MS_PER_DAY * 7
          : unit === "days"
            ? MS_PER_DAY
            : unit === "hours"
              ? 3_600_000
              : unit === "minutes"
                ? MS_PER_MINUTE
                : unit === "seconds"
                  ? MS_PER_SECOND
                  : 1;
      value = Math.trunc(elapsed / divisor);
    }

    const breakdown = breakdownBetween(fromWall, toWall);
    return json({
      value: input.absolute === true ? Math.abs(value) : value,
      unit,
      direction: elapsed === 0 ? "same" : elapsed > 0 ? "to is later" : "to is earlier",
      totalMilliseconds: input.absolute === true ? Math.abs(elapsed) : elapsed,
      totalSeconds:
        input.absolute === true
          ? Math.abs(Math.trunc(elapsed / MS_PER_SECOND))
          : Math.trunc(elapsed / MS_PER_SECOND),
      calendarDays: diffCalendarDays(fromWall, toWall),
      breakdown,
      from: isoFromEpochMs(from.epochMs, 0),
      to: isoFromEpochMs(to.epochMs, 0),
      timeZone,
      note: "whole units, truncated toward zero; calendar units are counted on the wall clock in timeZone",
    });
  },
});

export const durationParse: RegisteredTool = buildTool({
  name: "DurationParse",
  description:
    "Read an ISO 8601 duration (P3DT4H), a shorthand string (2h30m, 1d 4h), or clock form (01:30:00) into milliseconds and components. Use to turn a config value, a CLI flag or a human-written timeout into a number, keeping years and months separate because they have no fixed length.",
  inputSchema: z.object({
    text: z.string().min(1).max(MAX_TEXT).describe("the duration to read"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const parsed = parseDuration(input.text);
    if (!parsed.ok) {
      return json({
        ok: false,
        error: parsed.error,
        accepts: [
          "ISO 8601: P1Y2M3DT4H5M6S",
          "shorthand: 2h30m, 1d 4h, 90 minutes",
          "clock: 01:30:00",
        ],
      });
    }
    const totalSeconds = parsed.totalMilliseconds / 1000;
    return json({
      ok: true,
      format: parsed.format,
      components: parsed.duration,
      totalMilliseconds: parsed.totalMilliseconds,
      totalSeconds,
      totalMinutes: totalSeconds / 60,
      totalHours: totalSeconds / 3600,
      exact: parsed.exact,
      iso: formatDuration(parsed.totalMilliseconds, "iso", "days", 6),
      human: formatDuration(parsed.totalMilliseconds, "short", "days", 6),
      ...(parsed.notes.length > 0 ? { notes: parsed.notes } : {}),
    });
  },
});

export const durationFormat: RegisteredTool = buildTool({
  name: "DurationFormat",
  description:
    "Render a length of time as human text, ISO 8601, or a HH:MM:SS clock, trimmed to the leading units. Use for durations in reports, status posts and alerts, so '5,415,000 ms' reaches a reader as '1h 30m'.",
  inputSchema: z
    .object({
      milliseconds: z.number().optional(),
      seconds: z.number().optional(),
      duration: z
        .string()
        .max(MAX_TEXT)
        .optional()
        .describe("a duration string to re-render, in any form DurationParse accepts"),
      style: z
        .enum(["iso", "short", "long", "clock", "compact"])
        .optional()
        .describe("short '1h 30m', long '1 hour 30 minutes', compact '1h30m'; defaults to short"),
      largestUnit: z
        .enum(["weeks", "days", "hours", "minutes", "seconds", "milliseconds"])
        .optional()
        .describe("biggest unit to use; defaults to days, so weeks are opt-in"),
      maxUnits: z
        .number()
        .int()
        .min(1)
        .max(6)
        .optional()
        .describe("how many components to show before truncating; defaults to 2"),
    })
    .refine(
      (v) => v.milliseconds !== undefined || v.seconds !== undefined || v.duration !== undefined,
      {
        message: "set milliseconds, seconds or duration",
      },
    ),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    let ms: number;
    if (input.milliseconds !== undefined) ms = input.milliseconds;
    else if (input.seconds !== undefined) ms = input.seconds * 1000;
    else {
      const parsed = parseDuration(input.duration as string);
      if (!parsed.ok) return `could not read duration: ${parsed.error}`;
      if (!parsed.exact) {
        return "this duration contains years or months, which have no fixed length — anchor it with DateAdd first";
      }
      ms = parsed.totalMilliseconds;
    }
    if (!Number.isFinite(ms)) return "duration is not a finite number of milliseconds";
    if (Math.abs(ms) > 3.15e13) {
      return "duration exceeds 1000 years — this formatter has no fixed-length unit above weeks";
    }
    return formatDuration(
      ms,
      (input.style ?? "short") as DurationStyle,
      (input.largestUnit ?? "days") as FixedUnit,
      input.maxUnits ?? 2,
    );
  },
});

const WEEKEND_PRESETS: Readonly<Record<string, number[]>> = Object.freeze({
  "sat-sun": [6, 0],
  "fri-sat": [5, 6],
  "thu-fri": [4, 5],
  "sun-only": [0],
  "fri-only": [5],
  none: [],
});

export const businessDays: RegisteredTool = buildTool({
  name: "BusinessDays",
  description:
    "Count business days between two dates, or move a number of business days from one, against an explicit weekend definition and holiday list. Use for SLA due dates, payment terms and escalation windows; the holiday list is an input because no tool can know your calendar.",
  inputSchema: z.object({
    mode: z.enum(["count", "add"]).describe("'count' between two dates, 'add' to move from one"),
    start: z.string().min(1).max(MAX_TEXT),
    end: z.string().min(1).max(MAX_TEXT).optional().describe("required when mode is 'count'"),
    days: z
      .number()
      .int()
      .min(-10_000)
      .max(10_000)
      .optional()
      .describe("business days to move, negative to go back; required when mode is 'add'"),
    weekend: z
      .union([
        z.enum(["sat-sun", "fri-sat", "thu-fri", "sun-only", "fri-only", "none"]),
        z.array(z.number().int().min(0).max(6)).max(7),
      ])
      .optional()
      .describe("weekend preset, or weekday numbers with 0 = Sunday; defaults to sat-sun"),
    holidays: z
      .array(z.string().max(MAX_TEXT))
      .max(2000)
      .optional()
      .describe("dates that are not worked, in any format DateParse accepts"),
    endInclusive: z
      .boolean()
      .optional()
      .describe("count both endpoints, as spreadsheets do; defaults to true"),
    timeZone: zoneField.describe("zone used to read the calendar date out of an instant"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const timeZone = input.timeZone ?? "UTC";
    const badZone = zoneError(timeZone);
    if (badZone !== undefined) return badZone;
    const toDay = (text: string): number | string => {
      const instant = readInstant(text, timeZone);
      if (typeof instant === "string") return instant;
      const wall = wallClockInZone(instant.epochMs, timeZone);
      return daysFromCivil(wall.year, wall.month, wall.day);
    };

    const startDay = toDay(input.start);
    if (typeof startDay === "string") return `could not read 'start': ${startDay}`;

    const weekendList =
      input.weekend === undefined
        ? WEEKEND_PRESETS["sat-sun"]
        : typeof input.weekend === "string"
          ? WEEKEND_PRESETS[input.weekend]
          : input.weekend;
    const weekend = new Set(weekendList ?? [6, 0]);
    if (weekend.size === 7)
      return "every weekday is marked as weekend, so there are no business days";

    const holidays = new Set<number>();
    const holidayDates: string[] = [];
    for (const text of input.holidays ?? []) {
      const day = toDay(text);
      if (typeof day === "string") return `could not read holiday "${text}": ${day}`;
      holidays.add(day);
      holidayDates.push(isoDateFromEpochMs(day * MS_PER_DAY, 0));
    }
    const calendar = { weekend, holidays };

    try {
      if (input.mode === "count") {
        if (input.end === undefined) return "mode 'count' needs an 'end' date";
        const endDay = toDay(input.end);
        if (typeof endDay === "string") return `could not read 'end': ${endDay}`;
        const inclusive = input.endInclusive ?? true;
        const count = countBusinessDays(startDay, endDay, calendar, inclusive);
        const holidaysInRange = [...holidays].filter(
          (d) => d >= Math.min(startDay, endDay) && d <= Math.max(startDay, endDay),
        ).length;
        return json({
          mode: "count",
          businessDays: count,
          calendarDays: endDay - startDay + (inclusive ? Math.sign(endDay - startDay || 1) : 0),
          start: isoDateFromEpochMs(startDay * MS_PER_DAY, 0),
          end: isoDateFromEpochMs(endDay * MS_PER_DAY, 0),
          endInclusive: inclusive,
          weekend: [...weekend].sort((a, b) => a - b),
          holidaysConsidered: holidayDates.length,
          holidaysInRange,
        });
      }
      if (input.days === undefined) return "mode 'add' needs a 'days' amount";
      const moved = addBusinessDays(startDay, input.days, calendar);
      return json({
        mode: "add",
        result: isoDateFromEpochMs(moved.epochDay * MS_PER_DAY, 0),
        weekday: WEEKDAY_NAMES[weekdayFromEpochDay(moved.epochDay)] ?? "",
        start: isoDateFromEpochMs(startDay * MS_PER_DAY, 0),
        startWasBusinessDay: moved.startWasBusinessDay,
        businessDaysMoved: input.days,
        calendarDaysMoved: moved.epochDay - startDay,
        nonBusinessDaysSkipped: moved.skipped,
        weekend: [...weekend].sort((a, b) => a - b),
        note: "the start day is never counted; moving 1 business day from a Friday lands on Monday",
      });
    } catch (err) {
      return (err as Error).message;
    }
  },
});

export const dateRange: RegisteredTool = buildTool({
  name: "DateRange",
  description:
    "Expand a start and end into the list of instants between them at a fixed step, capped so a wide range cannot flood a context window. Use to build report buckets, backfill windows, or the x-axis of a time series without a loop in a model's head.",
  inputSchema: z.object({
    start: z.string().min(1).max(MAX_TEXT),
    end: z.string().min(1).max(MAX_TEXT),
    stepUnit: z
      .enum(["years", "months", "weeks", "days", "hours", "minutes", "seconds"])
      .optional()
      .describe("defaults to days"),
    stepAmount: z
      .number()
      .int()
      .min(-1000)
      .max(1000)
      .optional()
      .describe("defaults to 1; negative walks backwards, which requires end before start"),
    max: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .optional()
      .describe("cap on items returned; defaults to 366"),
    endInclusive: z
      .boolean()
      .optional()
      .describe("include the end instant itself; defaults to true"),
    format: z
      .enum(["date", "instant", "local"])
      .optional()
      .describe("'date' gives YYYY-MM-DD, 'instant' UTC ISO, 'local' ISO with the zone offset"),
    timeZone: zoneField,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const timeZone = input.timeZone ?? "UTC";
    const badZone = zoneError(timeZone);
    if (badZone !== undefined) return badZone;
    const start = readInstant(input.start, timeZone);
    if (typeof start === "string") return `could not read 'start': ${start}`;
    const end = readInstant(input.end, timeZone);
    if (typeof end === "string") return `could not read 'end': ${end}`;
    const max = input.max ?? 366;
    try {
      const result = expandRange(
        start.epochMs,
        end.epochMs,
        { unit: (input.stepUnit ?? "days") as Unit, amount: input.stepAmount ?? 1 },
        timeZone,
        max,
        input.endInclusive ?? true,
      );
      const format = input.format ?? "date";
      const items = result.instants.map((ms) =>
        format === "date"
          ? isoDateFromEpochMs(ms, zoneOffsetMinutes(ms, timeZone))
          : format === "local"
            ? isoFromEpochMs(ms, zoneOffsetMinutes(ms, timeZone))
            : isoFromEpochMs(ms, 0),
      );
      return json({
        count: items.length,
        truncated: result.truncated,
        ...(result.truncated
          ? { note: `stopped at the cap of ${max}; raise 'max' or narrow the range` }
          : {}),
        step: `${input.stepAmount ?? 1} ${input.stepUnit ?? "days"}`,
        timeZone,
        items,
      });
    } catch (err) {
      return (err as Error).message;
    }
  },
});

export const cronNext: RegisteredTool = buildTool({
  name: "CronNext",
  description:
    "Give the next firing times of a 5-field cron expression from a reference time you supply, on the wall clock of an IANA timezone. Use to preview a schedule change before shipping it, to explain to an operator when a job will actually run, and to see which firings a DST weekend skips or repeats.",
  inputSchema: z.object({
    expression: z.string().min(1).max(200).describe("5-field cron, or a macro like @daily"),
    after: z
      .string()
      .min(1)
      .max(MAX_TEXT)
      .describe("the reference instant to search forward from — this tool never reads the clock"),
    count: z.number().int().min(1).max(100).optional().describe("firings to return; defaults to 5"),
    timeZone: zoneField.describe("zone whose wall clock the schedule runs on; defaults to UTC"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const timeZone = input.timeZone ?? "UTC";
    const badZone = zoneError(timeZone);
    if (badZone !== undefined) return badZone;
    const parsed = parseCron(input.expression);
    if (!parsed.ok) return json({ ok: false, error: parsed.error });
    const after = readInstant(input.after, timeZone);
    if (typeof after === "string") return `could not read 'after': ${after}`;
    const result = cronNextFn(parsed.fields, after.epochMs, timeZone, input.count ?? 5);
    return json({
      ok: true,
      expression: parsed.fields.normalized,
      description: describeCron(parsed.fields),
      after: isoFromEpochMs(after.epochMs, 0),
      timeZone,
      count: result.firings.length,
      firings: result.firings.map((f) => ({
        utc: isoFromEpochMs(f.epochMs, 0),
        local: isoFromEpochMs(f.epochMs, zoneOffsetMinutes(f.epochMs, timeZone)),
        ...(f.note !== undefined ? { note: f.note } : {}),
      })),
      ...(result.skippedForDst.length > 0
        ? {
            skippedForDst: result.skippedForDst,
            skippedNote:
              "these wall clocks do not exist because the clocks sprang forward, so the job does not run",
          }
        : {}),
      ...(result.exhausted
        ? {
            exhausted: true,
            note: `no further firing within ${CRON_HORIZON_YEARS} years — check the day-of-month and month fields (0 0 30 2 * can never fire)`,
          }
        : {}),
    });
  },
});

export const cronDescribe: RegisteredTool = buildTool({
  name: "CronDescribe",
  description:
    "Turn a 5-field cron expression into a literal English sentence, with the parsed value set for each field. Use in code review, runbooks and change descriptions, where '*/15 9-17 * * 1-5' needs to be readable before anyone approves it.",
  inputSchema: z.object({
    expression: z.string().min(1).max(200),
    includeFields: z
      .boolean()
      .optional()
      .describe("also return the expanded value set for each field; defaults to true"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const parsed = parseCron(input.expression);
    if (!parsed.ok) return json({ ok: false, error: parsed.error });
    const fields = parsed.fields;
    return json({
      ok: true,
      expression: fields.normalized,
      description: describeCron(fields),
      ...(input.includeFields === false
        ? {}
        : {
            fields: {
              minutes: fields.minutes,
              hours: fields.hours,
              daysOfMonth: fields.domRestricted ? fields.daysOfMonth : "every",
              months: fields.months.map((m) => MONTH_NAMES[m - 1] ?? String(m)),
              daysOfWeek: fields.dowRestricted
                ? fields.daysOfWeek.map((d) => WEEKDAY_NAMES[d] ?? String(d))
                : "every",
            },
          }),
      ...(fields.domRestricted && fields.dowRestricted
        ? {
            warning:
              "day-of-month and day-of-week are both restricted, so cron fires when EITHER matches, not both",
          }
        : {}),
    });
  },
});

export const recurrenceExpand: RegisteredTool = buildTool({
  name: "RecurrenceExpand",
  description:
    "Expand a supported subset of an iCalendar RRULE (FREQ, INTERVAL, COUNT, UNTIL and plain BYDAY) from a start instant you supply. Use to list upcoming occurrences of a recurring event; any RRULE part outside the subset is rejected by name rather than silently ignored, so a wrong answer is never returned quietly.",
  inputSchema: z.object({
    rule: z.string().min(1).max(300).describe("an RRULE, with or without the 'RRULE:' prefix"),
    start: z
      .string()
      .min(1)
      .max(MAX_TEXT)
      .describe(
        "DTSTART — the first candidate occurrence, and the time of day every occurrence keeps",
      ),
    limit: z.number().int().min(1).max(MAX_OCCURRENCES).optional().describe("defaults to 25"),
    format: z.enum(["date", "instant", "local"]).optional(),
    timeZone: zoneField.describe("zone the rule's wall clock runs on; defaults to UTC"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const timeZone = input.timeZone ?? "UTC";
    const badZone = zoneError(timeZone);
    if (badZone !== undefined) return badZone;
    const parsed = parseRRule(input.rule);
    if (!parsed.ok) {
      return json({
        ok: false,
        error: parsed.error,
        supported: "FREQ (DAILY|WEEKLY|MONTHLY|YEARLY), INTERVAL, COUNT, UNTIL, plain BYDAY",
      });
    }
    const start = readInstant(input.start, timeZone);
    if (typeof start === "string") return `could not read 'start': ${start}`;
    const result = expandRecurrence(start.epochMs, timeZone, parsed.parts, input.limit ?? 25);
    const format = input.format ?? "instant";
    return json({
      ok: true,
      rule: parsed.parts,
      start: isoFromEpochMs(start.epochMs, 0),
      timeZone,
      count: result.instants.length,
      truncated: result.truncated,
      occurrences: result.instants.map((ms) =>
        format === "date"
          ? isoDateFromEpochMs(ms, zoneOffsetMinutes(ms, timeZone))
          : format === "local"
            ? isoFromEpochMs(ms, zoneOffsetMinutes(ms, timeZone))
            : isoFromEpochMs(ms, 0),
      ),
      ...(result.skippedInvalidDates.length > 0
        ? { skippedInvalidDates: result.skippedInvalidDates }
        : {}),
      ...(result.notes.length > 0 ? { notes: result.notes } : {}),
    });
  },
});

export const weekOfYear: RegisteredTool = buildTool({
  name: "WeekOfYear",
  description:
    "Give the ISO-8601 week number and week-numbering year for a date, with the week's start and end, and the spreadsheet-style numbering alongside for comparison. Use for weekly reporting buckets and sprint labels, where early January belongs to week 52 of the previous year and using the wrong year silently misfiles a row.",
  inputSchema: z.object({
    date: z.string().min(1).max(MAX_TEXT),
    weekStartsOn: z
      .number()
      .int()
      .min(0)
      .max(6)
      .optional()
      .describe("first day of the week for the simple scheme, 0 = Sunday; defaults to 1 (Monday)"),
    timeZone: zoneField,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const timeZone = input.timeZone ?? "UTC";
    const badZone = zoneError(timeZone);
    if (badZone !== undefined) return badZone;
    const instant = readInstant(input.date, timeZone);
    if (typeof instant === "string") return `could not read 'date': ${instant}`;
    const wall = wallClockInZone(instant.epochMs, timeZone);
    const week = isoWeek(wall.year, wall.month, wall.day);
    const epochDay = daysFromCivil(wall.year, wall.month, wall.day);
    const isoDow = weekdayFromEpochDay(epochDay) === 0 ? 7 : weekdayFromEpochDay(epochDay);
    const weekStart = epochDay - (isoDow - 1);
    const startsOn = input.weekStartsOn ?? 1;
    // 53-week ISO years are the ones that start on Thursday, or on Wednesday in a leap year.
    const lastWeek = isoWeek(week.weekYear, 12, 28).week;
    return json({
      date: isoDateFromEpochMs(epochDay * MS_PER_DAY, 0),
      isoWeek: week.week,
      isoWeekYear: week.weekYear,
      isoLabel: `${week.weekYear}-W${String(week.week).padStart(2, "0")}`,
      isoWeekday: isoDow,
      weekdayName: WEEKDAY_NAMES[weekdayFromEpochDay(epochDay)] ?? "",
      weekStart: isoDateFromEpochMs(weekStart * MS_PER_DAY, 0),
      weekEnd: isoDateFromEpochMs((weekStart + 6) * MS_PER_DAY, 0),
      weeksInIsoYear: lastWeek,
      simpleWeek: simpleWeek(wall.year, wall.month, wall.day, startsOn),
      simpleWeekStartsOn: WEEKDAY_NAMES[startsOn] ?? "",
      note: "ISO weeks start Monday and week 1 holds the first Thursday, so isoWeek must always be used with isoWeekYear",
    });
  },
});

export const dayOfYear: RegisteredTool = buildTool({
  name: "DayOfYear",
  description:
    "Convert between a date and its ordinal day of the year, in either direction, with the days elapsed and remaining. Use for julian-style keys, year-progress metrics and partitioned file names, and to turn '2026-260' back into a calendar date.",
  inputSchema: z
    .object({
      date: z.string().min(1).max(MAX_TEXT).optional().describe("a date, to get its ordinal"),
      year: z
        .number()
        .int()
        .min(1)
        .max(9999)
        .optional()
        .describe("with 'ordinal', to get the date"),
      ordinal: z.number().int().min(1).max(366).optional().describe("day of the year, 1-366"),
      timeZone: zoneField,
    })
    .refine((v) => v.date !== undefined || (v.year !== undefined && v.ordinal !== undefined), {
      message: "give either 'date', or both 'year' and 'ordinal'",
    }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const timeZone = input.timeZone ?? "UTC";
    const badZone = zoneError(timeZone);
    if (badZone !== undefined) return badZone;
    let year: number;
    let month: number;
    let day: number;
    if (input.date !== undefined) {
      const instant = readInstant(input.date, timeZone);
      if (typeof instant === "string") return `could not read 'date': ${instant}`;
      const wall = wallClockInZone(instant.epochMs, timeZone);
      year = wall.year;
      month = wall.month;
      day = wall.day;
    } else {
      year = input.year as number;
      const ordinal = input.ordinal as number;
      const limit = daysInYear(year);
      if (ordinal > limit) {
        return `${year} has ${limit} days, so ordinal day ${ordinal} does not exist`;
      }
      const civil = dateFromDayOfYear(year, ordinal);
      month = civil.month;
      day = civil.day;
    }
    const ordinal = dayOfYearFn(year, month, day);
    const total = daysInYear(year);
    const epochDay = daysFromCivil(year, month, day);
    return json({
      date: isoDateFromEpochMs(epochDay * MS_PER_DAY, 0),
      year,
      dayOfYear: ordinal,
      ordinalDate: `${year}-${String(ordinal).padStart(3, "0")}`,
      daysInYear: total,
      daysRemaining: total - ordinal,
      fractionElapsed: Number((ordinal / total).toFixed(6)),
      weekday: WEEKDAY_NAMES[weekdayFromEpochDay(epochDay)] ?? "",
      isLeapYear: isLeapYearFn(year),
    });
  },
});

export const isLeapYear: RegisteredTool = buildTool({
  name: "IsLeapYear",
  description:
    "Say whether a year is a leap year under the proleptic Gregorian rule, with the length of the year, February, and the nearest leap years either side. Use when validating a 29 February date, sizing a year-long window, or explaining why 1900 was not a leap year but 2000 was.",
  inputSchema: z
    .object({
      year: z.number().int().min(1).max(9999).optional(),
      date: z
        .string()
        .min(1)
        .max(MAX_TEXT)
        .optional()
        .describe("a date, if you have one rather than a year"),
      timeZone: zoneField,
    })
    .refine((v) => v.year !== undefined || v.date !== undefined, {
      message: "give either 'year' or 'date'",
    }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const timeZone = input.timeZone ?? "UTC";
    const badZone = zoneError(timeZone);
    if (badZone !== undefined) return badZone;
    let year: number;
    if (input.year !== undefined) year = input.year;
    else {
      const instant = readInstant(input.date as string, timeZone);
      if (typeof instant === "string") return `could not read 'date': ${instant}`;
      year = wallClockInZone(instant.epochMs, timeZone).year;
    }
    const leap = isLeapYearFn(year);
    let next = year + 1;
    while (!isLeapYearFn(next)) next += 1;
    let previous = year - 1;
    while (previous > 0 && !isLeapYearFn(previous)) previous -= 1;
    return json({
      year,
      isLeapYear: leap,
      daysInYear: daysInYear(year),
      daysInFebruary: daysInMonth(year, 2),
      nextLeapYear: next,
      previousLeapYear: previous > 0 ? previous : null,
      rule: "divisible by 4, except centuries, except those divisible by 400 — so 1900 was not a leap year and 2000 was",
    });
  },
});

export const quarterOf: RegisteredTool = buildTool({
  name: "QuarterOf",
  description:
    "Give the quarter a date falls in, with its start and end dates, under a calendar or a shifted fiscal year. Use for financial reporting buckets and quarterly rollups, where a fiscal year starting in February makes Q1 run February to April.",
  inputSchema: z.object({
    date: z.string().min(1).max(MAX_TEXT),
    fiscalYearStartMonth: z
      .number()
      .int()
      .min(1)
      .max(12)
      .optional()
      .describe("month the fiscal year begins; 1 (January) means calendar quarters"),
    timeZone: zoneField,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const timeZone = input.timeZone ?? "UTC";
    const badZone = zoneError(timeZone);
    if (badZone !== undefined) return badZone;
    const instant = readInstant(input.date, timeZone);
    if (typeof instant === "string") return `could not read 'date': ${instant}`;
    const wall = wallClockInZone(instant.epochMs, timeZone);
    const fyStart = input.fiscalYearStartMonth ?? 1;
    const quarter = quarterOfMonth(wall.month, fyStart);
    // The quarter's first month, as an absolute month index, then back to a date.
    const monthsIn = (wall.month - fyStart + 12) % 12;
    const startMonthIndex = wall.year * 12 + (wall.month - 1) - (monthsIn % 3);
    const startYear = Math.floor(startMonthIndex / 12);
    const startMonth = startMonthIndex - startYear * 12 + 1;
    const endMonthIndex = startMonthIndex + 2;
    const endYear = Math.floor(endMonthIndex / 12);
    const endMonth = endMonthIndex - endYear * 12 + 1;
    const startDay = daysFromCivil(startYear, startMonth, 1);
    const endDay = daysFromCivil(endYear, endMonth, daysInMonth(endYear, endMonth));
    const fiscalYear =
      fyStart === 1 ? wall.year : wall.month >= fyStart ? wall.year + 1 : wall.year;
    const today = daysFromCivil(wall.year, wall.month, wall.day);
    return json({
      date: isoDateFromEpochMs(today * MS_PER_DAY, 0),
      quarter,
      label: fyStart === 1 ? `${wall.year}-Q${quarter}` : `FY${fiscalYear}-Q${quarter}`,
      fiscalYear: fyStart === 1 ? wall.year : fiscalYear,
      fiscalYearStartMonth: fyStart,
      quarterStart: isoDateFromEpochMs(startDay * MS_PER_DAY, 0),
      quarterEnd: isoDateFromEpochMs(endDay * MS_PER_DAY, 0),
      daysInQuarter: endDay - startDay + 1,
      dayOfQuarter: today - startDay + 1,
      months: [startMonth, (startMonth % 12) + 1, ((startMonth + 1) % 12) + 1].map(
        (m) => MONTH_NAMES[m - 1] ?? String(m),
      ),
      ...(fyStart === 1
        ? {}
        : { note: "fiscalYear is the year the fiscal year ends in, the common convention" }),
    });
  },
});

export const timestampConvert: RegisteredTool = buildTool({
  name: "TimestampConvert",
  description:
    "Convert between unix timestamps (seconds, milliseconds, microseconds, nanoseconds) and ISO 8601, detecting the input unit by magnitude when asked to. Use when a log, an API or a database column hands you a bare number and the difference between seconds and milliseconds is a factor of a thousand years.",
  inputSchema: z.object({
    value: z
      .union([z.string().max(MAX_TEXT), z.number()])
      .describe("a unix timestamp, or a date string when converting the other way"),
    from: z
      .enum(["auto", "seconds", "millis", "micros", "nanos", "iso"])
      .optional()
      .describe("unit of the input; 'auto' guesses from magnitude and reports the guess"),
    timeZone: zoneField.describe("zone for the local rendering in the result"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const timeZone = input.timeZone ?? "UTC";
    const badZone = zoneError(timeZone);
    if (badZone !== undefined) return badZone;
    const raw = typeof input.value === "number" ? String(input.value) : input.value.trim();
    let from = input.from ?? "auto";
    let epochMs: number;
    const notes: string[] = [];

    const numeric = /^[+-]?\d+(\.\d+)?$/.test(raw);
    if (from === "auto") {
      if (!numeric) {
        from = "iso";
      } else {
        const magnitude = Math.abs(Number(raw));
        // Thresholds pinned to digit count, which is how a human tells these
        // apart too: 10 digits is seconds until the year 2286.
        if (magnitude >= 1e17) {
          from = "nanos";
        } else if (magnitude >= 1e14) {
          from = "micros";
        } else if (magnitude >= 1e11) {
          from = "millis";
        } else {
          from = "seconds";
        }
        notes.push(`unit guessed as ${from} from a magnitude of ${magnitude}`);
      }
    }

    if (from === "iso") {
      const instant = readInstant(raw, timeZone);
      if (typeof instant === "string") return `could not read '${raw}' as a date: ${instant}`;
      epochMs = instant.epochMs;
    } else {
      if (!numeric) return `'${raw}' is not a number, so it cannot be read as ${from}`;
      const value = Number(raw);
      const divisor =
        from === "seconds" ? 1 / 1000 : from === "millis" ? 1 : from === "micros" ? 1000 : 1e6;
      epochMs = from === "seconds" ? value * 1000 : value / divisor;
      if (!Number.isFinite(epochMs) || Math.abs(epochMs) > 8.64e15) {
        return `${raw} as ${from} is outside the representable date range`;
      }
      if (from === "micros" || from === "nanos") {
        notes.push(`sub-millisecond precision dropped when converting from ${from}`);
      }
      epochMs = Math.floor(epochMs);
    }

    const offset = zoneOffsetMinutes(epochMs, timeZone);
    const imprecise = (["micros", "nanos"] as const).filter(
      (unit) => Math.abs(epochMs * (unit === "micros" ? 1000 : 1e6)) > Number.MAX_SAFE_INTEGER,
    );
    return json({
      detectedUnit: from,
      iso: isoFromEpochMs(epochMs, 0),
      local: isoFromEpochMs(epochMs, offset),
      timeZone,
      seconds: Math.floor(epochMs / 1000),
      millis: epochMs,
      micros: epochMs * 1000,
      nanos: epochMs * 1e6,
      ...(imprecise.length > 0
        ? {
            precisionNote: `${imprecise.join(" and ")} exceed JavaScript's exact-integer range at this magnitude and are approximate`,
          }
        : {}),
      ...(notes.length > 0 ? { notes } : {}),
    });
  },
});

/** Every tool this package registers, in the order a catalog should list them. */
export const DATETIME_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  businessDays,
  cronDescribe,
  cronNext,
  dateAdd,
  dateConvertTimezone,
  dateDiff,
  dateFormat,
  dateParse,
  dateRange,
  dayOfYear,
  durationFormat,
  durationParse,
  isLeapYear,
  quarterOf,
  recurrenceExpand,
  timestampConvert,
  weekOfYear,
]);

export type { CivilDateTime };
