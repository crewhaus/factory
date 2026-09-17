/**
 * The civil-calendar core: proleptic Gregorian date arithmetic, IANA timezone
 * offsets, and ISO 8601 rendering.
 *
 * Nothing here reads the clock. Every function takes the instant it operates
 * on. `Date` appears only as a carrier for `Intl.DateTimeFormat`, which is how
 * we get IANA timezone data without a dependency; the date arithmetic itself
 * is done on integer day counts so it stays exact and engine-independent.
 */

/** A calendar date with no time and no zone. */
export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

/** A wall-clock reading with no zone attached. */
export interface CivilDateTime extends CivilDate {
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

/** The widest instant `Date` can represent, and so the widest we accept. */
export const MAX_EPOCH_MS = 8.64e15;

/** Instants outside year 1..9999 have no unambiguous ISO 8601 basic form. */
export const MIN_ISO_EPOCH_MS = -62_135_596_800_000; // 0001-01-01T00:00:00Z
export const MAX_ISO_EPOCH_MS = 253_402_300_799_999; // 9999-12-31T23:59:59.999Z

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

export const MONTH_NAMES: ReadonlyArray<string> = Object.freeze([
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]);

export const WEEKDAY_NAMES: ReadonlyArray<string> = Object.freeze([
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]);

/** Proleptic Gregorian leap rule — the one the ISO calendar uses for all years. */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const MONTH_LENGTHS: ReadonlyArray<number> = Object.freeze([
  31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
]);

/** Days in `month` (1..12) of `year`, February answering to the leap rule. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return MONTH_LENGTHS[month - 1] ?? 30;
}

/** Days in the year — 365, or 366 in a leap year. */
export function daysInYear(year: number): number {
  return isLeapYear(year) ? 366 : 365;
}

/**
 * Days since 1970-01-01 for a proleptic Gregorian date, by Howard Hinnant's
 * `days_from_civil`. Exact for any integer year; no `Date` involved, so the
 * two-digit-year quirk of `Date.UTC` cannot reach us.
 *
 * `era` is a FLOOR division. Hinnant writes it as `(y >= 0 ? y : y - 399) / 400`
 * because C++ integer division truncates toward zero and that shift turns
 * truncation into flooring. Transliterating that shift into JavaScript and then
 * wrapping it in `Math.floor` applies the correction twice and is off by one era
 * for most negative years, so the division is written directly as a floor here.
 */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400; // 0..399
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1; // 0..365
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; // 0..146096
  return era * 146_097 + doe - 719_468;
}

/** The inverse of {@link daysFromCivil}. `era` is a floor division, as above. */
export function civilFromDays(epochDay: number): CivilDate {
  const z = epochDay + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097; // 0..146096
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153); // 0..11, March-based
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { year: y + (month <= 2 ? 1 : 0), month, day };
}

/** 0 = Sunday .. 6 = Saturday, for a day count from {@link daysFromCivil}. */
export function weekdayFromEpochDay(epochDay: number): number {
  return ((epochDay % 7) + 11) % 7;
}

/** Ordinal day of the year, 1..365/366. */
export function dayOfYear(year: number, month: number, day: number): number {
  return daysFromCivil(year, month, day) - daysFromCivil(year, 1, 1) + 1;
}

/** The inverse: turn an ordinal day back into a calendar date. */
export function dateFromDayOfYear(year: number, ordinal: number): CivilDate {
  return civilFromDays(daysFromCivil(year, 1, 1) + ordinal - 1);
}

/**
 * ISO 8601 week number and week-numbering year. Weeks start Monday and week 1
 * is the one containing the first Thursday, so early January can belong to
 * week 52/53 of the previous year — which is why the week-year is returned
 * alongside and must be used with it.
 */
export function isoWeek(
  year: number,
  month: number,
  day: number,
): { week: number; weekYear: number } {
  const epochDay = daysFromCivil(year, month, day);
  // ISO weekday 1 (Mon) .. 7 (Sun).
  const isoDow = weekdayFromEpochDay(epochDay) === 0 ? 7 : weekdayFromEpochDay(epochDay);
  // The Thursday of this week decides which year the week belongs to.
  const thursday = epochDay + (4 - isoDow);
  const weekYear = civilFromDays(thursday).year;
  const firstThursdayWeekStart = (() => {
    const jan4 = daysFromCivil(weekYear, 1, 4);
    const jan4Dow = weekdayFromEpochDay(jan4) === 0 ? 7 : weekdayFromEpochDay(jan4);
    return jan4 - (jan4Dow - 1);
  })();
  const week = Math.floor((epochDay - (firstThursdayWeekStart + (isoDow - 1))) / 7) + 1;
  return { week, weekYear };
}

/**
 * Week number under a "week 1 contains January 1" scheme, with a configurable
 * first day of the week (0 = Sunday). This is the numbering most spreadsheets
 * use; it is NOT the ISO one and the two disagree most Januaries.
 */
export function simpleWeek(year: number, month: number, day: number, weekStartsOn: number): number {
  const jan1 = daysFromCivil(year, 1, 1);
  const epochDay = daysFromCivil(year, month, day);
  const jan1Offset = (weekdayFromEpochDay(jan1) - weekStartsOn + 7) % 7;
  return Math.floor((epochDay - jan1 + jan1Offset) / 7) + 1;
}

/** Calendar quarter 1..4 for a month, given the month the fiscal year starts in. */
export function quarterOfMonth(month: number, fiscalYearStartMonth: number): number {
  const shifted = (month - fiscalYearStartMonth + 12) % 12;
  return Math.floor(shifted / 3) + 1;
}

/** Epoch milliseconds for a wall clock read as if it were UTC. */
export function epochMsFromCivilUTC(dt: CivilDateTime): number {
  return (
    daysFromCivil(dt.year, dt.month, dt.day) * MS_PER_DAY +
    dt.hour * MS_PER_HOUR +
    dt.minute * MS_PER_MINUTE +
    dt.second * MS_PER_SECOND +
    dt.millisecond
  );
}

/** The inverse: split epoch milliseconds into UTC wall-clock components. */
export function civilFromEpochMsUTC(epochMs: number): CivilDateTime {
  const epochDay = Math.floor(epochMs / MS_PER_DAY);
  let rest = epochMs - epochDay * MS_PER_DAY;
  const date = civilFromDays(epochDay);
  const hour = Math.floor(rest / MS_PER_HOUR);
  rest -= hour * MS_PER_HOUR;
  const minute = Math.floor(rest / MS_PER_MINUTE);
  rest -= minute * MS_PER_MINUTE;
  const second = Math.floor(rest / MS_PER_SECOND);
  return { ...date, hour, minute, second, millisecond: rest - second * MS_PER_SECOND };
}

export function pad(value: number, width: number): string {
  const negative = value < 0;
  const digits = String(Math.abs(Math.trunc(value))).padStart(width, "0");
  return negative ? `-${digits}` : digits;
}

/** Render a UTC offset in minutes as `Z`, `+HH:MM` or `+HHMM`. */
export function formatOffset(offsetMinutes: number, style: "extended" | "basic" | "z"): string {
  if (offsetMinutes === 0 && style === "z") return "Z";
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const hh = pad(Math.floor(abs / 60), 2);
  const mm = pad(abs % 60, 2);
  return style === "basic" ? `${sign}${hh}${mm}` : `${sign}${hh}:${mm}`;
}

/**
 * ISO 8601 for an instant, rendered at a given UTC offset. `offsetMinutes` of
 * 0 renders with `Z`. Milliseconds are included only when non-zero unless
 * `alwaysMillis` is set, so round timestamps stay short.
 */
export function isoFromEpochMs(
  epochMs: number,
  offsetMinutes: number,
  alwaysMillis = false,
): string {
  const local = civilFromEpochMsUTC(epochMs + offsetMinutes * MS_PER_MINUTE);
  const date = `${pad(local.year, 4)}-${pad(local.month, 2)}-${pad(local.day, 2)}`;
  const time = `${pad(local.hour, 2)}:${pad(local.minute, 2)}:${pad(local.second, 2)}`;
  const ms = local.millisecond !== 0 || alwaysMillis ? `.${pad(local.millisecond, 3)}` : "";
  return `${date}T${time}${ms}${formatOffset(offsetMinutes, "z")}`;
}

/** `YYYY-MM-DD` for an instant at a given offset. */
export function isoDateFromEpochMs(epochMs: number, offsetMinutes: number): string {
  const local = civilFromEpochMsUTC(epochMs + offsetMinutes * MS_PER_MINUTE);
  return `${pad(local.year, 4)}-${pad(local.month, 2)}-${pad(local.day, 2)}`;
}

// ---------------------------------------------------------------------------
// IANA timezones, via Intl. This is the only part of the package that consults
// data outside itself, and that data is the platform's tzdb copy — deterministic
// for a given runtime, but it is a runtime fact, not a constant. Historical
// offsets before ~1970 and far-future ones depend on the tzdb version.

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached !== undefined) return cached;
  // The locale is pinned so output never depends on the host's default locale.
  const made = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    era: "short",
  });
  formatterCache.set(timeZone, made);
  return made;
}

/** True when the runtime's tzdb knows this IANA identifier (or `UTC`). */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    zoneFormatter(timeZone).format(0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The wall clock an IANA zone shows at a given instant.
 *
 * Milliseconds are carried over from the instant untouched, since no zone has
 * a sub-second offset in practice.
 */
export function wallClockInZone(epochMs: number, timeZone: string): CivilDateTime {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(epochMs));
  const get = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    return found === undefined ? 0 : Number(found.value);
  };
  const era = parts.find((p) => p.type === "era")?.value;
  const rawYear = get("year");
  // `en-US` renders year 0 and earlier as "1 BC"; map back to astronomical.
  const year = era === "BC" || era === "B" ? 1 - rawYear : rawYear;
  const ms = ((epochMs % MS_PER_SECOND) + MS_PER_SECOND) % MS_PER_SECOND;
  return {
    year,
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
    millisecond: ms,
  };
}

/**
 * The zone's UTC offset in whole minutes at an instant, positive east of
 * Greenwich. Historical offsets with seconds precision (local mean time before
 * standard zones) are rounded to the nearest minute.
 */
export function zoneOffsetMinutes(epochMs: number, timeZone: string): number {
  if (timeZone === "UTC") return 0;
  const wall = wallClockInZone(epochMs, timeZone);
  const asUtc = epochMsFromCivilUTC(wall);
  return Math.round((asUtc - epochMs) / MS_PER_MINUTE);
}

/** How a requested wall clock landed in a zone. */
export type WallClockResolution = "unique" | "ambiguous" | "nonexistent";

export interface ResolvedWallClock {
  epochMs: number;
  offsetMinutes: number;
  resolution: WallClockResolution;
  /** Every instant this wall clock maps to; two when ambiguous, none when skipped. */
  candidates: number[];
}

/**
 * Turn a wall clock in an IANA zone into an instant.
 *
 * DST makes this a relation, not a function: the hour repeated at a fall-back
 * transition maps to two instants, and the hour skipped at a spring-forward
 * transition maps to none. We report which case it is rather than silently
 * picking. When ambiguous we take the earlier instant (the pre-transition
 * offset); when nonexistent we take the instant the requested wall clock would
 * have had at the pre-transition offset, which lands just after the gap.
 */
export function resolveWallClock(wall: CivilDateTime, timeZone: string): ResolvedWallClock {
  const guess = epochMsFromCivilUTC(wall);
  if (timeZone === "UTC") {
    return { epochMs: guess, offsetMinutes: 0, resolution: "unique", candidates: [guess] };
  }
  // Offsets a day either side bracket any transition at this wall clock. The
  // probes are clamped into the representable range: at the very edge there is
  // no transition beyond it to find, and `Intl` throws on an unrepresentable
  // instant rather than saturating.
  const offsetAt = (ms: number): number =>
    zoneOffsetMinutes(Math.max(-MAX_EPOCH_MS, Math.min(MAX_EPOCH_MS, ms)), timeZone);
  const before = offsetAt(guess - MS_PER_DAY);
  const after = offsetAt(guess + MS_PER_DAY);
  const offsets = before === after ? [before] : [before, after];
  const valid: { epochMs: number; offsetMinutes: number }[] = [];
  for (const offset of offsets) {
    const candidate = guess - offset * MS_PER_MINUTE;
    if (Math.abs(candidate) > MAX_EPOCH_MS) continue;
    const actual = offsetAt(candidate);
    if (actual !== offset) continue;
    if (valid.some((v) => v.epochMs === candidate)) continue;
    valid.push({ epochMs: candidate, offsetMinutes: offset });
  }
  if (valid.length === 0) {
    const fallbackOffset = before;
    const epochMs = guess - fallbackOffset * MS_PER_MINUTE;
    return {
      epochMs,
      offsetMinutes: offsetAt(epochMs),
      resolution: "nonexistent",
      candidates: [],
    };
  }
  valid.sort((a, b) => a.epochMs - b.epochMs);
  const chosen = valid[0] as { epochMs: number; offsetMinutes: number };
  return {
    epochMs: chosen.epochMs,
    offsetMinutes: chosen.offsetMinutes,
    resolution: valid.length > 1 ? "ambiguous" : "unique",
    candidates: valid.map((v) => v.epochMs),
  };
}

/** The zone's short name at an instant (`PDT`, `GMT+5:30`), as the tzdb spells it. */
export function zoneAbbreviation(epochMs: number, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "short",
      year: "numeric",
    }).formatToParts(new Date(epochMs));
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/**
 * True when an instant can be represented at all. Beyond +/-8.64e15 ms `Date`
 * and `Intl` stop working, and `Intl.DateTimeFormat.formatToParts` throws a
 * bare `RangeError` rather than returning anything a caller could read — so
 * every instant is checked against this before it reaches a zone lookup.
 */
export function isRepresentableInstant(epochMs: number): boolean {
  return Number.isFinite(epochMs) && Math.abs(epochMs) <= MAX_EPOCH_MS;
}

/** The message every tool uses when an instant falls outside that range. */
export function outOfRangeMessage(label: string): string {
  return `${label} is outside the representable range (+/-8.64e15 ms, about year -271821 to 275760)`;
}

/** Guard for an instant on a path that reports failure by throwing. */
export function assertInRange(epochMs: number, label: string): void {
  if (!isRepresentableInstant(epochMs)) throw new RangeError(outOfRangeMessage(label));
}
