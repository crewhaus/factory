/**
 * Durations: ISO 8601 designators, the shorthand people actually type
 * (`2h30m`, `1d 4h`), clock form (`01:30:00`), and rendering back out.
 *
 * The honest part of this file is the years/months problem. An ISO duration may
 * say `P1M`, but a month has no fixed length, so `P1M` cannot be converted to
 * seconds without a date to anchor it to. We parse those components, keep them
 * separate, and mark the result `exact: false` rather than quietly pretending a
 * month is 30 days. Anchoring is what `DateAdd` is for.
 */

export interface Duration {
  years: number;
  months: number;
  weeks: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  milliseconds: number;
  negative: boolean;
}

export const ZERO_DURATION: Duration = Object.freeze({
  years: 0,
  months: 0,
  weeks: 0,
  days: 0,
  hours: 0,
  minutes: 0,
  seconds: 0,
  milliseconds: 0,
  negative: false,
});

/** Milliseconds per unit, for the units that have a fixed length. */
const FIXED_MS = {
  weeks: 604_800_000,
  days: 86_400_000,
  hours: 3_600_000,
  minutes: 60_000,
  seconds: 1000,
  milliseconds: 1,
} as const;

/**
 * Every spelling the human parser accepts, mapped to its unit. `m` on its own
 * is minutes, not months — the overwhelmingly common intent in `2h30m`; months
 * must be written `mo` or longer.
 */
const UNIT_ALIASES: ReadonlyMap<string, keyof Omit<Duration, "negative">> = new Map([
  ["y", "years"],
  ["yr", "years"],
  ["yrs", "years"],
  ["year", "years"],
  ["years", "years"],
  ["mo", "months"],
  ["mos", "months"],
  ["mon", "months"],
  ["mth", "months"],
  ["mths", "months"],
  ["month", "months"],
  ["months", "months"],
  ["w", "weeks"],
  ["wk", "weeks"],
  ["wks", "weeks"],
  ["week", "weeks"],
  ["weeks", "weeks"],
  ["d", "days"],
  ["day", "days"],
  ["days", "days"],
  ["h", "hours"],
  ["hr", "hours"],
  ["hrs", "hours"],
  ["hour", "hours"],
  ["hours", "hours"],
  ["m", "minutes"],
  ["min", "minutes"],
  ["mins", "minutes"],
  ["minute", "minutes"],
  ["minutes", "minutes"],
  ["s", "seconds"],
  ["sec", "seconds"],
  ["secs", "seconds"],
  ["second", "seconds"],
  ["seconds", "seconds"],
  ["ms", "milliseconds"],
  ["msec", "milliseconds"],
  ["msecs", "milliseconds"],
  ["millisecond", "milliseconds"],
  ["milliseconds", "milliseconds"],
]);

export interface DurationParseResult {
  ok: true;
  duration: Duration;
  /** Total milliseconds of the fixed-length part; unsigned years/months excluded. */
  totalMilliseconds: number;
  /** False when years or months are present, since those have no fixed length. */
  exact: boolean;
  format: "iso" | "clock" | "human";
  notes: string[];
}

export interface DurationParseFailure {
  ok: false;
  error: string;
}

const ISO_RE =
  /^([+-])?P(?:(\d+(?:[.,]\d+)?)Y)?(?:(\d+(?:[.,]\d+)?)M)?(?:(\d+(?:[.,]\d+)?)W)?(?:(\d+(?:[.,]\d+)?)D)?(?:T(?:(\d+(?:[.,]\d+)?)H)?(?:(\d+(?:[.,]\d+)?)M)?(?:(\d+(?:[.,]\d+)?)S)?)?$/;

const CLOCK_RE = /^([+-])?(\d+):([0-5]?\d)(?::([0-5]?\d)(?:[.,](\d{1,9}))?)?$/;

function num(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 0;
  return Number(raw.replace(",", "."));
}

/**
 * Parse a duration written as ISO 8601, clock form, or human shorthand.
 *
 * Fractional components are accepted on any field, not only the smallest as ISO
 * 8601 requires, because real inputs say `PT1.5H`. A fraction on years or
 * months is rejected: there is no length to take a fraction of.
 */
export function parseDuration(input: string): DurationParseResult | DurationParseFailure {
  const text = input.trim();
  if (text === "") return { ok: false, error: "empty input" };
  const notes: string[] = [];

  const iso = ISO_RE.exec(text);
  if (iso !== null && /\d/.test(text)) {
    const years = num(iso[2]);
    const months = num(iso[3]);
    if (!Number.isInteger(years) || !Number.isInteger(months)) {
      return {
        ok: false,
        error: "fractional years or months have no fixed length; use days or hours",
      };
    }
    const duration: Duration = {
      years,
      months,
      weeks: num(iso[4]),
      days: num(iso[5]),
      hours: num(iso[6]),
      minutes: num(iso[7]),
      seconds: num(iso[8]),
      milliseconds: 0,
      negative: iso[1] === "-",
    };
    return finish(duration, "iso", notes);
  }

  // Clock form: groups are (sign)(hours)(minutes)(seconds)(fraction).
  const clock = CLOCK_RE.exec(text);
  if (clock !== null) {
    const fraction = clock[5] ?? "";
    const duration: Duration = {
      ...ZERO_DURATION,
      hours: Number(clock[2]),
      minutes: Number(clock[3]),
      seconds: clock[4] === undefined ? 0 : Number(clock[4]),
      milliseconds: fraction === "" ? 0 : Number(fraction.slice(0, 3).padEnd(3, "0")),
      negative: clock[1] === "-",
    };
    notes.push("read as clock form H:MM[:SS]");
    return finish(duration, "clock", notes);
  }

  // Human shorthand: a run of <number><unit> pairs, whitespace optional.
  const pairRe = /(-?\d+(?:\.\d+)?)\s*([A-Za-z]+)/g;
  const duration: Duration = { ...ZERO_DURATION };
  let matched = 0;
  let match: RegExpExecArray | null = pairRe.exec(text);
  const seen = new Set<string>();
  while (match !== null) {
    const alias = (match[2] ?? "").toLowerCase();
    const unit = UNIT_ALIASES.get(alias);
    if (unit === undefined) {
      return {
        ok: false,
        error: `"${match[2]}" is not a duration unit — use y, mo, w, d, h, m, s or ms (and note that bare "m" means minutes)`,
      };
    }
    if (seen.has(unit)) return { ok: false, error: `${unit} given more than once` };
    seen.add(unit);
    duration[unit] += Number(match[1]);
    matched += 1;
    match = pairRe.exec(text);
  }
  if (matched === 0) return { ok: false, error: `could not read "${text}" as a duration` };
  // Whatever the pairs did not consume has to be filler — whitespace, a comma,
  // a plus sign, or the word "and". Anything else is refused rather than
  // dropped: a parser that quietly ignores what it cannot read turns "5m!!!"
  // into a five-minute timeout and says nothing about the rest.
  const leftover = text
    .replace(pairRe, " ")
    .replace(/\band\b/gi, " ")
    .replace(/[\s,+]+/g, "");
  if (leftover !== "") {
    return {
      ok: false,
      error: `could not read "${leftover}" in "${text}" — only numbers, units and filler ("and", a comma) are allowed`,
    };
  }
  if (duration.years < 0 || duration.months < 0) {
    duration.negative = true;
    duration.years = Math.abs(duration.years);
    duration.months = Math.abs(duration.months);
  }
  // A leading minus on the first component makes the whole duration negative.
  if (/^\s*-/.test(text)) {
    duration.negative = true;
    for (const key of Object.keys(FIXED_MS) as (keyof typeof FIXED_MS)[]) {
      duration[key] = Math.abs(duration[key]);
    }
  }
  return finish(duration, "human", notes);
}

function finish(
  duration: Duration,
  format: "iso" | "clock" | "human",
  notes: string[],
): DurationParseResult {
  const totalMilliseconds =
    duration.weeks * FIXED_MS.weeks +
    duration.days * FIXED_MS.days +
    duration.hours * FIXED_MS.hours +
    duration.minutes * FIXED_MS.minutes +
    duration.seconds * FIXED_MS.seconds +
    duration.milliseconds;
  const exact = duration.years === 0 && duration.months === 0;
  if (!exact) {
    notes.push(
      "years and months have no fixed length, so totalMilliseconds covers only the weeks-and-smaller part; anchor them with DateAdd",
    );
  }
  return {
    ok: true,
    duration,
    totalMilliseconds: Math.round(duration.negative ? -totalMilliseconds : totalMilliseconds),
    exact,
    format,
    notes,
  };
}

export type DurationStyle = "iso" | "short" | "long" | "clock" | "compact";

const LONG_NAMES: Readonly<Record<string, [string, string]>> = Object.freeze({
  weeks: ["week", "weeks"],
  days: ["day", "days"],
  hours: ["hour", "hours"],
  minutes: ["minute", "minutes"],
  seconds: ["second", "seconds"],
  milliseconds: ["millisecond", "milliseconds"],
});

const SHORT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  weeks: "w",
  days: "d",
  hours: "h",
  minutes: "m",
  seconds: "s",
  milliseconds: "ms",
});

export type FixedUnit = keyof typeof FIXED_MS;

const ORDER: ReadonlyArray<FixedUnit> = Object.freeze([
  "weeks",
  "days",
  "hours",
  "minutes",
  "seconds",
  "milliseconds",
]);

/**
 * Split a millisecond count into fixed-length units, biggest first, starting no
 * larger than `largestUnit`. Weeks are opt-in via `largestUnit` because "3w 2d"
 * reads worse than "23d" in most reports.
 */
export function decompose(
  totalMilliseconds: number,
  largestUnit: FixedUnit,
): Record<FixedUnit, number> {
  const out: Record<FixedUnit, number> = {
    weeks: 0,
    days: 0,
    hours: 0,
    minutes: 0,
    seconds: 0,
    milliseconds: 0,
  };
  let rest = Math.abs(Math.round(totalMilliseconds));
  let started = false;
  for (const unit of ORDER) {
    if (unit === largestUnit) started = true;
    if (!started) continue;
    const size = FIXED_MS[unit];
    out[unit] = Math.floor(rest / size);
    rest -= out[unit] * size;
  }
  return out;
}

/**
 * Render a millisecond count as text. `maxUnits` keeps the output to the
 * leading components, so 90,061,000 ms at `maxUnits: 2` is "1d 1h" rather than
 * "1d 1h 1m 1s"; the remainder is dropped, not rounded into the last unit.
 */
export function formatDuration(
  totalMilliseconds: number,
  style: DurationStyle,
  largestUnit: FixedUnit,
  maxUnits: number,
): string {
  const negative = totalMilliseconds < 0;
  const abs = Math.abs(Math.round(totalMilliseconds));
  const parts = decompose(abs, largestUnit);
  const sign = negative ? "-" : "";

  if (style === "clock") {
    const totalSeconds = Math.floor(abs / 1000);
    const days =
      largestUnit === "days" || largestUnit === "weeks" ? Math.floor(totalSeconds / 86_400) : 0;
    const rest = totalSeconds - days * 86_400;
    const hh = String(Math.floor(rest / 3600)).padStart(2, "0");
    const mm = String(Math.floor((rest % 3600) / 60)).padStart(2, "0");
    const ss = String(rest % 60).padStart(2, "0");
    return `${sign}${days > 0 ? `${days}:` : ""}${hh}:${mm}:${ss}`;
  }

  if (style === "iso") {
    if (abs === 0) return "PT0S";
    const dayPart = `${parts.weeks > 0 ? `${parts.weeks * 7 + parts.days}D` : parts.days > 0 ? `${parts.days}D` : ""}`;
    const secondsWithMs =
      parts.milliseconds > 0
        ? `${parts.seconds + parts.milliseconds / 1000}S`
        : parts.seconds > 0
          ? `${parts.seconds}S`
          : "";
    const timePart = [
      parts.hours > 0 ? `${parts.hours}H` : "",
      parts.minutes > 0 ? `${parts.minutes}M` : "",
      secondsWithMs,
    ].join("");
    return `${sign}P${dayPart}${timePart === "" ? "" : `T${timePart}`}`;
  }

  const shown: string[] = [];
  for (const unit of ORDER) {
    if (shown.length >= maxUnits) break;
    const value = parts[unit];
    if (value === 0 && shown.length === 0) continue;
    if (value === 0) continue;
    if (style === "long") {
      const names = LONG_NAMES[unit] ?? ["", ""];
      shown.push(`${value} ${value === 1 ? names[0] : names[1]}`);
    } else {
      shown.push(`${value}${SHORT_NAMES[unit] ?? ""}`);
    }
  }
  if (shown.length === 0) {
    return style === "long" ? "0 seconds" : "0s";
  }
  const joiner = style === "compact" ? "" : " ";
  return sign + shown.join(joiner);
}
