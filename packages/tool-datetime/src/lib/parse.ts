/**
 * Parsing date strings into instants, and saying so when the string does not
 * determine one.
 *
 * The supported grammar is deliberately closed and listed in `SUPPORTED_FORMATS`.
 * It does not fall back to `new Date(string)`: that parser is
 * implementation-defined for everything outside ISO 8601, differs between
 * engines, and silently guesses at `03/04/2026`. Guessing is the one thing a
 * deterministic tool must not do, so an ambiguous string comes back as an
 * ambiguity report with every interpretation spelled out.
 */
import {
  type CivilDateTime,
  MONTH_NAMES,
  MS_PER_MINUTE,
  civilFromDays,
  daysFromCivil,
  daysInMonth,
  epochMsFromCivilUTC,
  isRepresentableInstant,
  isoFromEpochMs,
  isoWeek,
  outOfRangeMessage,
  resolveWallClock,
  weekdayFromEpochDay,
} from "./civil";

/** Which of the three numeric fields is which, when the string cannot say. */
export type DateOrder = "MDY" | "DMY" | "YMD";

export const SUPPORTED_FORMATS: ReadonlyArray<string> = Object.freeze([
  "iso-extended: 2026-09-17, 2026-09-17T14:30, :SS, .sss, with Z / +HH:MM / +HHMM / +HH",
  "iso-basic: 20260917, 20260917T143000Z",
  "iso-ordinal: 2026-260",
  "iso-week: 2026-W38-4, 2026-W38",
  "ymd-slash: 2026/09/17 (year first, never ambiguous)",
  "numeric: 03/04/2026, 3-4-26, 03.04.2026 (needs dateOrder when both fields are <= 12)",
  "month-name: 17 Sep 2026, Sep 17 2026, September 17, 2026",
  "rfc2822: Thu, 17 Sep 2026 14:30:00 +0000 (also GMT / UTC / UT)",
]);

export interface ParseSuccess {
  ok: true;
  /** The instant, in epoch milliseconds. */
  epochMs: number;
  /** Normalized UTC ISO 8601 form of that instant. */
  iso: string;
  /** The UTC offset used, in minutes east of Greenwich. */
  offsetMinutes: number;
  /** Which grammar matched, by the labels in `SUPPORTED_FORMATS`. */
  format: string;
  /** The wall clock as written in the source string. */
  wall: CivilDateTime;
  hadTime: boolean;
  /** False when the offset came from `assumeTimeZone` rather than the string. */
  hadOffset: boolean;
  /** Set when the wall clock fell in a DST gap or repeat in the assumed zone. */
  wallClockResolution?: "ambiguous" | "nonexistent";
  notes: string[];
}

export interface ParseFailure {
  ok: false;
  error: string;
  /** Present when the string parses more than one way and no order was given. */
  ambiguous?: {
    reason: string;
    interpretations: { dateOrder: DateOrder; iso: string; date: string }[];
  };
}

export type ParseResult = ParseSuccess | ParseFailure;

export interface ParseOptions {
  /** Field order for bare numeric dates. Omitted means "report ambiguity". */
  dateOrder?: DateOrder;
  /** IANA zone applied when the string carries no offset. */
  assumeTimeZone: string;
  /** Two-digit years at or below this map to 2000s, above to 1900s. */
  twoDigitYearPivot: number;
}

const MONTH_LOOKUP: ReadonlyMap<string, number> = new Map(
  MONTH_NAMES.flatMap((name, index) => [
    [name.toLowerCase(), index + 1] as [string, number],
    [name.slice(0, 3).toLowerCase(), index + 1] as [string, number],
  ]),
);

/** `sept` is common in the wild and unambiguous; the rest are the 3-letter forms. */
const MONTH_ALIASES: ReadonlyMap<string, number> = new Map([["sept", 9]]);

function lookupMonth(name: string): number | undefined {
  const key = name.toLowerCase();
  return MONTH_LOOKUP.get(key) ?? MONTH_ALIASES.get(key);
}

interface TimeFields {
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  offsetMinutes?: number;
  /** 24:00 is legal ISO for end-of-day; it rolls into the next date. */
  rollsToNextDay: boolean;
  notes: string[];
}

const TIME_RE =
  /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?(?:[.,](\d{1,9}))?\s*(am|pm|AM|PM)?\s*(Z|z|UT|UTC|GMT|[+-]\d{2}:?\d{2}|[+-]\d{2})?$/;

function parseOffsetToken(token: string): number | undefined {
  if (token === "") return undefined;
  const upper = token.toUpperCase();
  if (upper === "Z" || upper === "UT" || upper === "UTC" || upper === "GMT") return 0;
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(token);
  if (m === null) return undefined;
  const sign = m[1] === "-" ? -1 : 1;
  const hours = Number(m[2]);
  const minutes = Number(m[3] ?? "0");
  if (hours > 23 || minutes > 59) return undefined;
  return sign * (hours * 60 + minutes);
}

function parseTime(raw: string): TimeFields | string {
  const text = raw.trim();
  if (text === "") {
    return { hour: 0, minute: 0, second: 0, millisecond: 0, rollsToNextDay: false, notes: [] };
  }
  // ISO basic time (`143000Z`) has no separators; rewrite it into the extended
  // form so one regex covers both. Only applied when there is no colon, so
  // `14:30` can never reach here.
  const normalized = text.includes(":")
    ? text
    : text.replace(
        /^(\d{2})(\d{2})(\d{2})?((?:[.,]\d+)?(?:\s*(?:Z|z|[+-]\d{2}:?\d{2}|[+-]\d{2}))?)$/,
        (_all, hh: string, mm: string, ss: string | undefined, rest: string) =>
          `${hh}:${mm}${ss === undefined ? "" : `:${ss}`}${rest}`,
      );
  const m = TIME_RE.exec(normalized);
  if (m === null) return `could not read "${text}" as a time of day`;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? "0");
  let second = Number(m[3] ?? "0");
  const fraction = m[4] ?? "";
  const meridiem = (m[5] ?? "").toLowerCase();
  const offsetToken = m[6] ?? "";
  const notes: string[] = [];

  if (meridiem !== "") {
    if (hour < 1 || hour > 12) return `${hour} is not a 12-hour clock hour`;
    if (meridiem === "am") hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  }
  let rollsToNextDay = false;
  if (hour === 24 && minute === 0 && second === 0 && fraction === "") {
    hour = 0;
    rollsToNextDay = true;
    notes.push("24:00 read as the start of the following day, per ISO 8601");
  }
  if (hour > 23) return `${hour} is not a valid hour`;
  if (minute > 59) return `${minute} is not a valid minute`;
  if (second === 60) {
    second = 59;
    notes.push("second 60 (a leap second) clamped to 59; this package has no leap-second table");
  }
  if (second > 59) return `${second} is not a valid second`;
  const millisecond = fraction === "" ? 0 : Number(fraction.slice(0, 3).padEnd(3, "0"));
  if (fraction.length > 3) notes.push("sub-millisecond precision truncated");

  let offsetMinutes: number | undefined;
  if (offsetToken !== "") {
    offsetMinutes = parseOffsetToken(offsetToken);
    if (offsetMinutes === undefined) return `could not read "${offsetToken}" as a UTC offset`;
  }
  return {
    hour,
    minute,
    second,
    millisecond,
    ...(offsetMinutes !== undefined ? { offsetMinutes } : {}),
    rollsToNextDay,
    notes,
  };
}

interface DateFields {
  year: number;
  month: number;
  day: number;
  format: string;
  notes: string[];
}

function expandTwoDigitYear(year: number, pivot: number): number {
  return year <= pivot ? 2000 + year : 1900 + year;
}

function validateDate(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12) return `month ${month} is out of range`;
  const limit = daysInMonth(year, month);
  if (day < 1 || day > limit) {
    return `${year}-${String(month).padStart(2, "0")} has ${limit} days, so day ${day} does not exist`;
  }
  return undefined;
}

const WEEKDAY_PREFIX_RE = /^(?:mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+/i;

/**
 * Split a string into its date half and its time half.
 *
 * A month-name date contains spaces of its own (`17 Sep 2026 14:30`), so
 * splitting at the first space would cut it in two. Those forms are matched as
 * a prefix first and everything after them is the time; only then does the
 * generic `T`-or-space split apply.
 */
function splitDateTime(text: string): { datePart: string; timePart: string } {
  const stripped = text.replace(WEEKDAY_PREFIX_RE, "");
  const dayFirst =
    /^(\d{1,2}(?:st|nd|rd|th)?[\s-]+[A-Za-z]{3,9}\.?[\s,-]+-?\d{1,6})(?![\d/.-])\s*(.*)$/.exec(
      stripped,
    );
  if (dayFirst !== null) {
    return { datePart: dayFirst[1] as string, timePart: (dayFirst[2] ?? "").trim() };
  }
  const monthFirst =
    /^([A-Za-z]{3,9}\.?[\s-]+\d{1,2}(?:st|nd|rd|th)?[\s,-]+-?\d{1,6})(?![\d/.-])\s*(.*)$/.exec(
      stripped,
    );
  if (monthFirst !== null) {
    return { datePart: monthFirst[1] as string, timePart: (monthFirst[2] ?? "").trim() };
  }
  // The generic separator, restricted to strings whose head could be a date —
  // otherwise the lowercase `t` ISO 8601 permits would split "not-a-date".
  const isoSplit = /^([-+\d./W]+)[Tt ](\S.*)$/.exec(stripped);
  if (isoSplit !== null) {
    return { datePart: isoSplit[1] as string, timePart: isoSplit[2] as string };
  }
  return { datePart: stripped, timePart: "" };
}

function parseDatePart(datePart: string, opts: ParseOptions): DateFields | ParseFailure {
  const notes: string[] = [];

  // ISO week date: 2026-W38-4 or 2026W384
  const week = /^(\d{4})-?W(\d{2})(?:-?([1-7]))?$/.exec(datePart);
  if (week !== null) {
    const weekYear = Number(week[1]);
    const weekNumber = Number(week[2]);
    const isoDow = Number(week[3] ?? "1");
    if (weekNumber < 1 || weekNumber > 53) {
      return { ok: false, error: `week ${weekNumber} is out of range (1-53)` };
    }
    const jan4 = daysFromCivil(weekYear, 1, 4);
    const jan4Dow = weekdayFromEpochDay(jan4) === 0 ? 7 : weekdayFromEpochDay(jan4);
    const week1Monday = jan4 - (jan4Dow - 1);
    const epochDay = week1Monday + (weekNumber - 1) * 7 + (isoDow - 1);
    const civil = civilFromDays(epochDay);
    // Most years have 52 ISO weeks, some have 53, and the arithmetic above
    // happily runs week 53 of a 52-week year into the next year's week 1. That
    // is a silently wrong answer of exactly the kind this parser exists to
    // refuse, so the date is read back and has to agree with what was asked.
    const actual = isoWeek(civil.year, civil.month, civil.day);
    if (actual.week !== weekNumber || actual.weekYear !== weekYear) {
      const weeksInYear = isoWeek(weekYear, 12, 28).week;
      return {
        ok: false,
        error: `${weekYear} has ${weeksInYear} ISO weeks, so week ${weekNumber} does not exist in it`,
      };
    }
    return { ...civil, format: "iso-week", notes };
  }

  // ISO ordinal date, extended form only: 2026-260. The basic form (2026260)
  // is deliberately absent — seven bare digits read too much like a truncated
  // 20260917, and guessing between them is what this parser exists not to do.
  const ordinal = /^(\d{4})-(\d{3})$/.exec(datePart);
  if (ordinal !== null) {
    const year = Number(ordinal[1]);
    const day = Number(ordinal[2]);
    const limit = daysInMonth(year, 2) === 29 ? 366 : 365;
    if (day < 1 || day > limit) {
      return {
        ok: false,
        error: `${year} has ${limit} days, so ordinal day ${day} does not exist`,
      };
    }
    const civil = civilFromDays(daysFromCivil(year, 1, 1) + day - 1);
    return { ...civil, format: "iso-ordinal", notes };
  }

  // ISO extended and the year-first slash variant.
  const iso = /^(-?\d{4,6})[-/](\d{1,2})[-/](\d{1,2})$/.exec(datePart);
  if (iso !== null) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    const bad = validateDate(year, month, day);
    if (bad !== undefined) return { ok: false, error: bad };
    return {
      year,
      month,
      day,
      format: datePart.includes("/") ? "ymd-slash" : "iso-extended",
      notes,
    };
  }

  // ISO basic: 20260917
  const basic = /^(\d{4})(\d{2})(\d{2})$/.exec(datePart);
  if (basic !== null) {
    const year = Number(basic[1]);
    const month = Number(basic[2]);
    const day = Number(basic[3]);
    const bad = validateDate(year, month, day);
    if (bad !== undefined) return { ok: false, error: bad };
    return { year, month, day, format: "iso-basic", notes };
  }

  // Month-name forms, either order, with an optional weekday prefix.
  const stripped = datePart.replace(WEEKDAY_PREFIX_RE, "");
  const dmy = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?[\s,-]+(-?\d{1,6})$/.exec(
    stripped,
  );
  if (dmy !== null) {
    const month = lookupMonth(dmy[2] as string);
    if (month === undefined) return { ok: false, error: `"${dmy[2]}" is not a month name` };
    const day = Number(dmy[1]);
    const rawYear = Number(dmy[3]);
    const year =
      (dmy[3] as string).replace("-", "").length <= 2
        ? expandTwoDigitYear(rawYear, opts.twoDigitYearPivot)
        : rawYear;
    const bad = validateDate(year, month, day);
    if (bad !== undefined) return { ok: false, error: bad };
    return { year, month, day, format: "month-name", notes };
  }
  const mdy = /^([A-Za-z]{3,9})\.?[\s-]+(\d{1,2})(?:st|nd|rd|th)?[\s,-]+(-?\d{1,6})$/.exec(
    stripped,
  );
  if (mdy !== null) {
    const month = lookupMonth(mdy[1] as string);
    if (month === undefined) return { ok: false, error: `"${mdy[1]}" is not a month name` };
    const day = Number(mdy[2]);
    const rawYear = Number(mdy[3]);
    const year =
      (mdy[3] as string).replace("-", "").length <= 2
        ? expandTwoDigitYear(rawYear, opts.twoDigitYearPivot)
        : rawYear;
    const bad = validateDate(year, month, day);
    if (bad !== undefined) return { ok: false, error: bad };
    return { year, month, day, format: "month-name", notes };
  }

  // Bare numeric: the interesting case, because it may not determine a date.
  const numeric = /^(\d{1,4})([/.-])(\d{1,2})\2(\d{1,4})$/.exec(datePart);
  if (numeric !== null) {
    const a = Number(numeric[1]);
    const b = Number(numeric[3]);
    const c = Number(numeric[4]);
    const cDigits = (numeric[4] as string).length;
    const candidates: { order: DateOrder; year: number; month: number; day: number }[] = [];
    const yearFromC = cDigits <= 2 ? expandTwoDigitYear(c, opts.twoDigitYearPivot) : c;
    if (validateDate(yearFromC, a, b) === undefined) {
      candidates.push({ order: "MDY", year: yearFromC, month: a, day: b });
    }
    if (validateDate(yearFromC, b, a) === undefined) {
      candidates.push({ order: "DMY", year: yearFromC, month: b, day: a });
    }
    if ((numeric[1] as string).length === 4 && validateDate(a, b, c) === undefined) {
      candidates.push({ order: "YMD", year: a, month: b, day: c });
    }
    if (candidates.length === 0) {
      return { ok: false, error: `"${datePart}" is not a valid date in any field order` };
    }
    const wanted = opts.dateOrder;
    if (wanted !== undefined) {
      const picked = candidates.find((x) => x.order === wanted);
      if (picked === undefined) {
        return {
          ok: false,
          error: `"${datePart}" is not a valid date under dateOrder ${wanted}; it is valid as ${candidates
            .map((x) => x.order)
            .join(" or ")}`,
        };
      }
      return { year: picked.year, month: picked.month, day: picked.day, format: "numeric", notes };
    }
    if (candidates.length > 1) {
      return {
        ok: false,
        error: `"${datePart}" is ambiguous — set dateOrder to choose`,
        ambiguous: {
          reason: "both leading fields are valid as a month, so the field order is not determined",
          interpretations: candidates.map((x) => ({
            dateOrder: x.order,
            date: `${String(x.year).padStart(4, "0")}-${String(x.month).padStart(2, "0")}-${String(x.day).padStart(2, "0")}`,
            iso: isoFromEpochMs(
              epochMsFromCivilUTC({
                year: x.year,
                month: x.month,
                day: x.day,
                hour: 0,
                minute: 0,
                second: 0,
                millisecond: 0,
              }),
              0,
            ),
          })),
        },
      };
    }
    const only = candidates[0] as { order: DateOrder; year: number; month: number; day: number };
    notes.push(`field order read as ${only.order}; the other orders give no valid date`);
    return { year: only.year, month: only.month, day: only.day, format: "numeric", notes };
  }

  return { ok: false, error: `"${datePart}" does not match any supported date format` };
}

function isFailure(value: DateFields | ParseFailure): value is ParseFailure {
  return (value as ParseFailure).ok === false;
}

/**
 * Parse one date string. Returns either an instant with the evidence for it,
 * or a failure that says what was wrong — never a guess.
 */
export function parseDateString(input: string, opts: ParseOptions): ParseResult {
  const text = input.trim();
  if (text === "") return { ok: false, error: "empty input" };

  // RFC 2822 keeps its offset after the time, separated by a space, so peel
  // that off before the generic split.
  const { datePart, timePart } = splitDateTime(text.replace(/\s+/g, " "));
  const date = parseDatePart(datePart, opts);
  if (isFailure(date)) return date;

  const time = parseTime(timePart);
  if (typeof time === "string") return { ok: false, error: time };

  let epochDay = daysFromCivil(date.year, date.month, date.day);
  if (time.rollsToNextDay) epochDay += 1;
  const rolled = civilFromDays(epochDay);
  const wall: CivilDateTime = {
    year: rolled.year,
    month: rolled.month,
    day: rolled.day,
    hour: time.hour,
    minute: time.minute,
    second: time.second,
    millisecond: time.millisecond,
  };
  const notes = [...date.notes, ...time.notes];

  // The grammar accepts six-digit years, which reach past what `Date` and
  // `Intl` can represent. Catch that here, where it is still a parse failure
  // with a readable reason, rather than letting a zone lookup throw later.
  if (!isRepresentableInstant(epochMsFromCivilUTC(wall))) {
    return { ok: false, error: outOfRangeMessage(`"${text}"`) };
  }

  if (time.offsetMinutes !== undefined) {
    const epochMs = epochMsFromCivilUTC(wall) - time.offsetMinutes * MS_PER_MINUTE;
    if (!isRepresentableInstant(epochMs)) {
      return { ok: false, error: outOfRangeMessage(`"${text}"`) };
    }
    return {
      ok: true,
      epochMs,
      iso: isoFromEpochMs(epochMs, 0),
      offsetMinutes: time.offsetMinutes,
      format: date.format,
      wall,
      hadTime: timePart !== "",
      hadOffset: true,
      notes,
    };
  }

  const resolved = resolveWallClock(wall, opts.assumeTimeZone);
  // The wall clock can be representable while the instant it denotes is not:
  // midnight at the very edge of the range, read in a zone east of Greenwich,
  // lands before the first instant a date can hold.
  if (!isRepresentableInstant(resolved.epochMs)) {
    return { ok: false, error: outOfRangeMessage(`"${text}" in ${opts.assumeTimeZone}`) };
  }
  if (resolved.resolution !== "unique") {
    notes.push(
      resolved.resolution === "ambiguous"
        ? `this wall clock occurs twice in ${opts.assumeTimeZone}; the earlier instant was used`
        : `this wall clock does not occur in ${opts.assumeTimeZone} (a DST gap); the instant just after the gap was used`,
    );
  }
  return {
    ok: true,
    epochMs: resolved.epochMs,
    iso: isoFromEpochMs(resolved.epochMs, 0),
    offsetMinutes: resolved.offsetMinutes,
    format: date.format,
    wall,
    hadTime: timePart !== "",
    hadOffset: false,
    ...(resolved.resolution !== "unique" ? { wallClockResolution: resolved.resolution } : {}),
    notes,
  };
}
