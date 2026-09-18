/**
 * A small, closed token formatter.
 *
 * Deliberately not `Intl.DateTimeFormat` alone: that formats to a locale's
 * idea of a date, which is what you want for prose and exactly what you do not
 * want for a filename, a log prefix, or a key. This produces the characters
 * the pattern asks for and nothing else. Intl is used only to look up month and
 * weekday names when a non-English locale is requested, and those names are a
 * property of the runtime's CLDR data — the one place output can move between
 * environments, which the tool description says out loud.
 */
import {
  type CivilDateTime,
  MONTH_NAMES,
  MS_PER_SECOND,
  WEEKDAY_NAMES,
  dayOfYear,
  daysFromCivil,
  formatOffset,
  isoWeek,
  pad,
  quarterOfMonth,
  weekdayFromEpochDay,
} from "./civil";

/** Every token the formatter understands, longest first so matching is greedy. */
export const FORMAT_TOKENS: ReadonlyArray<{ token: string; means: string }> = Object.freeze([
  { token: "YYYY", means: "four-digit year" },
  { token: "YY", means: "two-digit year" },
  { token: "GGGG", means: "ISO week-numbering year" },
  { token: "MMMM", means: "month name" },
  { token: "MMM", means: "abbreviated month name" },
  { token: "MM", means: "two-digit month" },
  { token: "M", means: "month, no padding" },
  { token: "DDD", means: "three-digit day of year" },
  { token: "DD", means: "two-digit day of month" },
  { token: "D", means: "day of month, no padding" },
  { token: "dddd", means: "weekday name" },
  { token: "ddd", means: "abbreviated weekday name" },
  {
    token: "dd",
    means: "shortest weekday: two letters in en-US, the locale's narrow form elsewhere",
  },
  { token: "HH", means: "two-digit hour, 24-hour" },
  { token: "H", means: "hour, 24-hour, no padding" },
  { token: "hh", means: "two-digit hour, 12-hour" },
  { token: "h", means: "hour, 12-hour, no padding" },
  { token: "mm", means: "two-digit minute" },
  { token: "m", means: "minute, no padding" },
  { token: "ss", means: "two-digit second" },
  { token: "s", means: "second, no padding" },
  { token: "SSS", means: "milliseconds, three digits" },
  { token: "A", means: "AM or PM" },
  { token: "a", means: "am or pm" },
  { token: "ZZZ", means: "UTC offset as ISO 8601 writes it: Z at UTC, otherwise +HH:MM" },
  { token: "ZZ", means: "UTC offset, +HHMM" },
  { token: "Z", means: "UTC offset, +HH:MM" },
  { token: "zz", means: "timezone abbreviation, e.g. PDT (runtime CLDR data)" },
  { token: "WW", means: "two-digit ISO week number" },
  { token: "W", means: "ISO week number, no padding" },
  { token: "Q", means: "calendar quarter, 1-4" },
  { token: "X", means: "unix seconds" },
  { token: "x", means: "unix milliseconds" },
  { token: "[text]", means: "literal text, passed through unchanged" },
]);

const TOKEN_RE =
  /\[([^\]]*)\]|GGGG|YYYY|YY|MMMM|MMM|MM|M|DDD|DD|D|dddd|ddd|dd|HH|H|hh|h|mm|m|ss|s|SSS|A|a|ZZZ|ZZ|Z|zz|WW|W|Q|X|x/g;

const nameCache = new Map<string, string>();

function intlName(
  locale: string,
  kind: "month" | "weekday",
  width: "long" | "short" | "narrow",
  index: number,
): string {
  const key = `${locale}|${kind}|${width}|${index}`;
  const cached = nameCache.get(key);
  if (cached !== undefined) return cached;
  // 2021-01-03 is a Sunday, so weekday index maps straight onto the day.
  const sample = kind === "month" ? Date.UTC(2021, index, 15) : Date.UTC(2021, 0, 3 + index);
  const options: Intl.DateTimeFormatOptions =
    kind === "month" ? { month: width, timeZone: "UTC" } : { weekday: width, timeZone: "UTC" };
  let value: string;
  try {
    value = new Intl.DateTimeFormat(locale, options).format(sample);
  } catch {
    value = kind === "month" ? (MONTH_NAMES[index] ?? "") : (WEEKDAY_NAMES[index] ?? "");
  }
  nameCache.set(key, value);
  return value;
}

function monthName(month: number, width: "long" | "short", locale: string): string {
  if (locale === "en-US") {
    const full = MONTH_NAMES[month - 1] ?? "";
    return width === "long" ? full : full.slice(0, 3);
  }
  return intlName(locale, "month", width, month - 1);
}

function weekdayName(dow: number, width: "long" | "short" | "narrow", locale: string): string {
  if (locale === "en-US") {
    const full = WEEKDAY_NAMES[dow] ?? "";
    if (width === "long") return full;
    return width === "short" ? full.slice(0, 3) : full.slice(0, 2);
  }
  return intlName(locale, "weekday", width, dow);
}

export interface FormatContext {
  /** The wall clock to render. */
  wall: CivilDateTime;
  /** The offset that wall clock is at, in minutes. */
  offsetMinutes: number;
  /** The underlying instant, for the unix-timestamp tokens. */
  epochMs: number;
  /** Timezone abbreviation for the `zz` token; empty when unknown. */
  abbreviation: string;
  locale: string;
}

/** Render one wall clock through a token pattern. */
export function formatWallClock(pattern: string, ctx: FormatContext): string {
  const { wall, offsetMinutes, epochMs, locale } = ctx;
  const epochDay = daysFromCivil(wall.year, wall.month, wall.day);
  const dow = weekdayFromEpochDay(epochDay);
  const week = isoWeek(wall.year, wall.month, wall.day);
  const hour12 = wall.hour % 12 === 0 ? 12 : wall.hour % 12;

  return pattern.replace(TOKEN_RE, (match, literal: string | undefined) => {
    if (literal !== undefined) return literal;
    switch (match) {
      case "YYYY":
        return pad(wall.year, 4);
      case "YY":
        return pad(((wall.year % 100) + 100) % 100, 2);
      case "GGGG":
        return pad(week.weekYear, 4);
      case "MMMM":
        return monthName(wall.month, "long", locale);
      case "MMM":
        return monthName(wall.month, "short", locale);
      case "MM":
        return pad(wall.month, 2);
      case "M":
        return String(wall.month);
      case "DDD":
        return pad(dayOfYear(wall.year, wall.month, wall.day), 3);
      case "DD":
        return pad(wall.day, 2);
      case "D":
        return String(wall.day);
      case "dddd":
        return weekdayName(dow, "long", locale);
      case "ddd":
        return weekdayName(dow, "short", locale);
      case "dd":
        return weekdayName(dow, "narrow", locale);
      case "HH":
        return pad(wall.hour, 2);
      case "H":
        return String(wall.hour);
      case "hh":
        return pad(hour12, 2);
      case "h":
        return String(hour12);
      case "mm":
        return pad(wall.minute, 2);
      case "m":
        return String(wall.minute);
      case "ss":
        return pad(wall.second, 2);
      case "s":
        return String(wall.second);
      case "SSS":
        return pad(wall.millisecond, 3);
      case "A":
        return wall.hour < 12 ? "AM" : "PM";
      case "a":
        return wall.hour < 12 ? "am" : "pm";
      case "ZZZ":
        return formatOffset(offsetMinutes, "z");
      case "ZZ":
        return formatOffset(offsetMinutes, "basic");
      case "Z":
        return formatOffset(offsetMinutes, "extended");
      case "zz":
        return ctx.abbreviation;
      case "WW":
        return pad(week.week, 2);
      case "W":
        return String(week.week);
      case "Q":
        return String(quarterOfMonth(wall.month, 1));
      case "X":
        return String(Math.floor(epochMs / MS_PER_SECOND));
      case "x":
        return String(epochMs);
      default:
        return match;
    }
  });
}

/** Named patterns, so a caller does not have to remember the token spellings. */
export const NAMED_PATTERNS: Readonly<Record<string, string>> = Object.freeze({
  iso: "YYYY-MM-DDTHH:mm:ssZZZ",
  isoDate: "YYYY-MM-DD",
  isoTime: "HH:mm:ss",
  rfc2822: "ddd, DD MMM YYYY HH:mm:ss ZZ",
  compact: "YYYYMMDDTHHmmss",
  filename: "YYYY-MM-DD_HH-mm-ss",
  human: "dddd, D MMMM YYYY [at] HH:mm",
  logPrefix: "YYYY-MM-DD HH:mm:ss.SSS",
  usDate: "M/D/YYYY",
  euDate: "D/M/YYYY",
});
