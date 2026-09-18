/**
 * A real 5-field cron parser, and a next-firing walker that works on wall
 * clocks in an IANA zone — because that is what cron does, and it is the reason
 * a nightly 02:30 job runs twice or not at all on DST weekends.
 *
 * ## Supported
 * Five fields: `minute hour day-of-month month day-of-week`.
 * Per field: `*`, a number, `a-b`, a comma list, `*&#47;n`, `a-b/n` and `a/n`.
 * Names: `JAN`..`DEC` and `SUN`..`SAT`, case-insensitive, usable in ranges.
 * `?` is accepted in day-of-month and day-of-week, means the same as `*`, and
 * has to be the whole field.
 * Day-of-week accepts both `0` and `7` for Sunday.
 * A reversed range (`FRI-MON`, `11-2`) wraps around the end of the field —
 * see the note at the wrap itself for which dialects agree.
 * Macros: `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight`,
 * `@hourly`.
 *
 * ## Not supported, and rejected rather than ignored
 * A seconds field or a year field (6- and 7-field forms), Quartz's `L`, `W`,
 * `#` and `LW`, Jenkins's `H`, and `@reboot` — which is an event, not a time.
 *
 * ## Day-of-month and day-of-week together
 * When both are restricted, a day matches if *either* matches. That is Vixie
 * cron's rule and it surprises people: `0 0 1 * MON` fires on the 1st **and**
 * every Monday, not on Mondays that fall on the 1st.
 */
import {
  type CivilDateTime,
  MONTH_NAMES,
  MS_PER_MINUTE,
  WEEKDAY_NAMES,
  daysFromCivil,
  daysInMonth,
  epochMsFromCivilUTC,
  isRepresentableInstant,
  resolveWallClock,
  wallClockInZone,
  weekdayFromEpochDay,
} from "./civil";

export interface CronFields {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  domRestricted: boolean;
  dowRestricted: boolean;
  normalized: string;
}

export interface CronParseFailure {
  ok: false;
  error: string;
}

export type CronParseResult = { ok: true; fields: CronFields } | CronParseFailure;

const MACROS: Readonly<Record<string, string>> = Object.freeze({
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
});

const MONTH_TOKENS: ReadonlyMap<string, number> = new Map(
  MONTH_NAMES.map((name, i) => [name.slice(0, 3).toUpperCase(), i + 1]),
);
const DOW_TOKENS: ReadonlyMap<string, number> = new Map(
  WEEKDAY_NAMES.map((name, i) => [name.slice(0, 3).toUpperCase(), i]),
);

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: ReadonlyMap<string, number>;
  allowQuestionMark: boolean;
}

const FIELD_SPECS: ReadonlyArray<FieldSpec> = Object.freeze([
  { name: "minute", min: 0, max: 59, allowQuestionMark: false },
  { name: "hour", min: 0, max: 23, allowQuestionMark: false },
  { name: "day-of-month", min: 1, max: 31, allowQuestionMark: true },
  { name: "month", min: 1, max: 12, names: MONTH_TOKENS, allowQuestionMark: false },
  { name: "day-of-week", min: 0, max: 7, names: DOW_TOKENS, allowQuestionMark: true },
]);

function resolveToken(token: string, spec: FieldSpec): number | string {
  const upper = token.toUpperCase();
  const named = spec.names?.get(upper);
  if (named !== undefined) return named;
  // Dialect extensions are named in the error rather than reported as generic
  // junk. The month and weekday names are looked up first, so `JUL` and `WED`
  // never reach this even though they contain an L and a W.
  if (/[LW#]/.test(upper)) {
    return `"${token}" uses Quartz's L, W or # in the ${spec.name} field — this parser implements standard cron only`;
  }
  if (upper === "H") {
    return `"${token}" is Jenkins's H, which picks a different value per job and so is not deterministic — this parser implements standard cron only`;
  }
  if (!/^\d+$/.test(token)) return `"${token}" is not a number or a name in the ${spec.name} field`;
  const value = Number(token);
  if (value < spec.min || value > spec.max) {
    return `${value} is outside ${spec.min}-${spec.max} in the ${spec.name} field`;
  }
  return value;
}

/** Expand one field into the sorted set of values it matches. */
function parseField(
  raw: string,
  spec: FieldSpec,
): { values: number[]; restricted: boolean } | string {
  if (raw === "?") {
    if (!spec.allowQuestionMark) return `"?" is only allowed in day-of-month and day-of-week`;
    return { values: range(spec.min, spec.max), restricted: false };
  }
  if (raw === "*") return { values: range(spec.min, spec.max), restricted: false };
  // `?` means "no specific value" and is only meaningful as a whole field.
  // Allowing it inside a list or a step (`?/5`, `1,?`) would let it through in
  // fields where the bare form is refused, and would leave the day-of-month /
  // day-of-week OR rule keyed on a field that is not really restricted.
  if (raw.includes("?")) {
    return spec.allowQuestionMark
      ? `"?" has to be the whole ${spec.name} field, not part of "${raw}"`
      : `"?" is only allowed in day-of-month and day-of-week`;
  }
  const values = new Set<number>();
  for (const item of raw.split(",")) {
    if (item === "") return `empty item in the ${spec.name} field`;
    const [body, stepRaw, ...extra] = item.split("/");
    if (extra.length > 0) return `"${item}" has more than one step in the ${spec.name} field`;
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw) || Number(stepRaw) === 0) {
        return `"${stepRaw}" is not a positive step in the ${spec.name} field`;
      }
      step = Number(stepRaw);
    }
    let from: number;
    let to: number;
    if (body === "*") {
      from = spec.min;
      to = spec.max;
    } else if ((body ?? "").includes("-")) {
      const [lowRaw, highRaw, ...rest] = (body ?? "").split("-");
      if (rest.length > 0) return `"${item}" is not a valid range in the ${spec.name} field`;
      const low = resolveToken(lowRaw ?? "", spec);
      const high = resolveToken(highRaw ?? "", spec);
      if (typeof low === "string") return low;
      if (typeof high === "string") return high;
      from = low;
      to = high;
    } else {
      const single = resolveToken(body ?? "", spec);
      if (typeof single === "string") return single;
      from = single;
      // `5/10` means "from 5, every 10, to the end of the field" — the Quartz
      // spelling, widely used; a bare `5` is just itself.
      to = stepRaw === undefined ? single : spec.max;
    }
    if (from > to) {
      // A wrapping range like FRI-MON is the one cron dialects disagree on.
      // Vixie cron and cronie do NOT wrap: their range loop simply sets no
      // bits, so the field silently matches nothing. Quartz, croniter and most
      // JavaScript parsers wrap. We wrap, because a schedule that matches
      // nothing is never what the author meant; a field that genuinely matches
      // nothing is still reported as an error by `parseCron`.
      for (let v = from; v <= spec.max; v += 1) values.add(v);
      for (let v = spec.min; v <= to; v += 1) values.add(v);
      if (step !== 1) return `a wrapping range cannot take a step (${item})`;
    } else {
      for (let v = from; v <= to; v += step) values.add(v);
    }
  }
  return { values: [...values].sort((a, b) => a - b), restricted: true };
}

function range(min: number, max: number): number[] {
  const out: number[] = [];
  for (let v = min; v <= max; v += 1) out.push(v);
  return out;
}

/** Parse a cron expression into the value sets each field matches. */
export function parseCron(expression: string): CronParseResult {
  const trimmed = expression.trim();
  if (trimmed === "") return { ok: false, error: "empty cron expression" };
  if (trimmed.toLowerCase() === "@reboot") {
    return {
      ok: false,
      error: "@reboot is an event, not a schedule, so it has no next firing time",
    };
  }
  const expanded = MACROS[trimmed.toLowerCase()] ?? trimmed;
  if (expanded.startsWith("@")) {
    return {
      ok: false,
      error: `unknown macro "${trimmed}" — supported: ${Object.keys(MACROS).join(", ")}`,
    };
  }
  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) {
    return {
      ok: false,
      error:
        parts.length === 6 || parts.length === 7
          ? `${parts.length} fields given; this parser implements the 5-field form only (no seconds or year field)`
          : `${parts.length} fields given; expected 5: minute hour day-of-month month day-of-week`,
    };
  }
  const parsed: { values: number[]; restricted: boolean }[] = [];
  for (let i = 0; i < 5; i += 1) {
    const spec = FIELD_SPECS[i] as FieldSpec;
    const result = parseField(parts[i] as string, spec);
    if (typeof result === "string") return { ok: false, error: result };
    if (result.values.length === 0) {
      return { ok: false, error: `the ${spec.name} field matches nothing` };
    }
    parsed.push(result);
  }
  const dow = parsed[4] as { values: number[]; restricted: boolean };
  // 7 and 0 both mean Sunday; fold so day matching has one representation.
  const daysOfWeek = [...new Set(dow.values.map((v) => (v === 7 ? 0 : v)))].sort((a, b) => a - b);
  return {
    ok: true,
    fields: {
      minutes: (parsed[0] as { values: number[] }).values,
      hours: (parsed[1] as { values: number[] }).values,
      daysOfMonth: (parsed[2] as { values: number[] }).values,
      months: (parsed[3] as { values: number[] }).values,
      daysOfWeek,
      domRestricted: (parsed[2] as { restricted: boolean }).restricted,
      dowRestricted: dow.restricted,
      normalized: expanded,
    },
  };
}

function dayMatches(fields: CronFields, year: number, month: number, day: number): boolean {
  const dowMatch = fields.daysOfWeek.includes(weekdayFromEpochDay(daysFromCivil(year, month, day)));
  const domMatch = fields.daysOfMonth.includes(day);
  if (fields.domRestricted && fields.dowRestricted) return domMatch || dowMatch;
  if (fields.domRestricted) return domMatch;
  if (fields.dowRestricted) return dowMatch;
  return true;
}

function nextAtLeast(values: ReadonlyArray<number>, from: number): number | undefined {
  for (const v of values) if (v >= from) return v;
  return undefined;
}

export interface CronFiring {
  epochMs: number;
  /** The wall clock in the requested zone that this firing corresponds to. */
  wall: CivilDateTime;
  /** Set when DST made the wall clock repeat; the firing is emitted once. */
  note?: string;
}

export interface CronNextResult {
  firings: CronFiring[];
  /** Wall clocks skipped because DST removed them from the calendar. */
  skippedForDst: string[];
  /** True when the horizon was reached before `count` firings were found. */
  exhausted: boolean;
}

/** How far ahead the walker will look before giving up on a schedule. */
export const CRON_HORIZON_YEARS = 8;

/**
 * The next `count` firing times at or after `afterEpochMs` (exclusive), on the
 * wall clock of `timeZone`.
 *
 * DST: a firing whose wall clock does not exist (spring forward) is skipped and
 * reported; a wall clock that occurs twice (fall back) fires once, at the first
 * occurrence. Schedules that can never fire — `0 0 30 2 *` — exhaust the
 * horizon and say so rather than looping.
 */
export function cronNext(
  fields: CronFields,
  afterEpochMs: number,
  timeZone: string,
  count: number,
): CronNextResult {
  const firings: CronFiring[] = [];
  const skippedForDst: string[] = [];
  const start = wallClockInZone(afterEpochMs, timeZone);
  const limitYear = start.year + CRON_HORIZON_YEARS;
  let year = start.year;
  let month = start.month;
  let day = start.day;
  let hour = start.hour;
  let minute = start.minute + 1;
  if (minute > 59) {
    minute = 0;
    hour += 1;
  }
  if (hour > 23) {
    hour = 0;
    ({ year, month, day } = addOneDay(year, month, day));
  }

  let guard = 0;
  while (firings.length < count) {
    guard += 1;
    if (guard > 200_000 || year > limitYear) {
      return { firings, skippedForDst, exhausted: true };
    }
    if (!fields.months.includes(month)) {
      const nextMonth = nextAtLeast(fields.months, month + 1);
      if (nextMonth === undefined) {
        year += 1;
        month = fields.months[0] as number;
      } else {
        month = nextMonth;
      }
      day = 1;
      hour = 0;
      minute = 0;
      continue;
    }
    if (day > daysInMonth(year, month) || !dayMatches(fields, year, month, day)) {
      if (day > daysInMonth(year, month)) {
        ({ year, month, day } = addOneDay(year, month, daysInMonth(year, month)));
      } else {
        ({ year, month, day } = addOneDay(year, month, day));
      }
      hour = 0;
      minute = 0;
      continue;
    }
    const nextHour = nextAtLeast(fields.hours, hour);
    if (nextHour === undefined) {
      ({ year, month, day } = addOneDay(year, month, day));
      hour = 0;
      minute = 0;
      continue;
    }
    if (nextHour !== hour) {
      hour = nextHour;
      minute = 0;
    }
    const nextMinute = nextAtLeast(fields.minutes, minute);
    if (nextMinute === undefined) {
      hour += 1;
      minute = 0;
      if (hour > 23) {
        ({ year, month, day } = addOneDay(year, month, day));
        hour = 0;
      }
      continue;
    }
    minute = nextMinute;

    const wall: CivilDateTime = { year, month, day, hour, minute, second: 0, millisecond: 0 };
    // A reference time at the far edge of the range can walk off it within the
    // horizon. Stop there: the schedule has no representable next firing.
    if (!isRepresentableInstant(epochMsFromCivilUTC(wall))) {
      return { firings, skippedForDst, exhausted: true };
    }
    const resolved = resolveWallClock(wall, timeZone);
    if (!isRepresentableInstant(resolved.epochMs)) {
      return { firings, skippedForDst, exhausted: true };
    }
    if (resolved.resolution === "nonexistent") {
      skippedForDst.push(
        `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      );
    } else if (resolved.epochMs > afterEpochMs) {
      firings.push({
        epochMs: resolved.epochMs,
        wall,
        ...(resolved.resolution === "ambiguous"
          ? {
              note: "this wall clock occurs twice (DST fall back); fired once, at the first occurrence",
            }
          : {}),
      });
    }
    minute += 1;
    if (minute > 59) {
      minute = 0;
      hour += 1;
      if (hour > 23) {
        hour = 0;
        ({ year, month, day } = addOneDay(year, month, day));
      }
    }
  }
  return { firings, skippedForDst, exhausted: false };
}

function addOneDay(
  year: number,
  month: number,
  day: number,
): { year: number; month: number; day: number } {
  if (day < daysInMonth(year, month)) return { year, month, day: day + 1 };
  if (month === 12) return { year: year + 1, month: 1, day: 1 };
  return { year, month: month + 1, day: 1 };
}

/** Milliseconds a firing sits on, for callers that want a minute-aligned value. */
export function firingMinuteAligned(epochMs: number): number {
  return Math.floor(epochMs / MS_PER_MINUTE) * MS_PER_MINUTE;
}

// ---------------------------------------------------------------------------
// Rendering a schedule as English

function isStepSet(values: ReadonlyArray<number>, min: number, max: number): number | undefined {
  if (values.length < 3) return undefined;
  const first = values[0];
  if (first !== min) return undefined;
  const step = (values[1] as number) - (first as number);
  if (step <= 1) return undefined;
  for (let i = 1; i < values.length; i += 1) {
    if ((values[i] as number) - (values[i - 1] as number) !== step) return undefined;
  }
  const last = values[values.length - 1] as number;
  return last + step > max ? step : undefined;
}

function joinList(items: ReadonlyArray<string>): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0] as string;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function twoDigit(n: number): string {
  return String(n).padStart(2, "0");
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const suffix = ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
}

/**
 * Render a parsed schedule in English. The phrasing is deliberately literal —
 * it is meant to be checked against the expression, not to read like prose.
 */
export function describeCron(fields: CronFields): string {
  const everyMinute = fields.minutes.length === 60;
  const everyHour = fields.hours.length === 24;
  const minuteStep = isStepSet(fields.minutes, 0, 59);
  const hourStep = isStepSet(fields.hours, 0, 23);
  let time: string;

  if (everyMinute && everyHour) {
    time = "Every minute";
  } else if (fields.minutes.length === 1 && fields.hours.length === 1) {
    time = `At ${twoDigit(fields.hours[0] as number)}:${twoDigit(fields.minutes[0] as number)}`;
  } else {
    const minutePart = everyMinute
      ? "Every minute"
      : minuteStep !== undefined
        ? `Every ${minuteStep} minutes`
        : fields.minutes.length === 1
          ? `At ${ordinal(fields.minutes[0] as number)} minute`
          : `At minutes ${joinList(fields.minutes.map(String))}`;
    time = `${minutePart} past ${hourPhrase(fields.hours, hourStep)}`;
  }

  const clauses: string[] = [];
  if (fields.dowRestricted) {
    const names = fields.daysOfWeek.map((d) => WEEKDAY_NAMES[d] ?? String(d));
    clauses.push(
      isContiguous(fields.daysOfWeek)
        ? `on ${names[0]} through ${names[names.length - 1]}`
        : `on ${joinList(names)}`,
    );
  }
  if (fields.domRestricted) {
    const domStep = isStepSet(fields.daysOfMonth, 1, 31);
    clauses.push(
      domStep !== undefined
        ? `every ${domStep} days of the month`
        : `on the ${joinList(fields.daysOfMonth.map(ordinal))} of the month`,
    );
  }
  if (fields.domRestricted && fields.dowRestricted) {
    clauses.push("(either condition is enough — cron ORs day-of-month with day-of-week)");
  }
  if (fields.months.length !== 12) {
    clauses.push(`in ${joinList(fields.months.map((m) => MONTH_NAMES[m - 1] ?? String(m)))}`);
  }
  return clauses.length === 0 ? `${time}, every day` : `${time}, ${clauses.join(", ")}`;
}

function isContiguous(values: ReadonlyArray<number>): boolean {
  for (let i = 1; i < values.length; i += 1) {
    if ((values[i] as number) - (values[i - 1] as number) !== 1) return false;
  }
  return values.length > 1;
}

function hourPhrase(hours: ReadonlyArray<number>, step: number | undefined): string {
  if (hours.length === 24) return "every hour";
  if (step !== undefined) return `every ${step} hours`;
  if (hours.length === 1) return `hour ${twoDigit(hours[0] as number)}`;
  if (isContiguous(hours)) {
    return `every hour from ${twoDigit(hours[0] as number)} through ${twoDigit(hours[hours.length - 1] as number)}`;
  }
  return `hours ${joinList(hours.map(twoDigit))}`;
}
