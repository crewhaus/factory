/**
 * Quiet hours: may this notification go out now, and if not, when?
 *
 * The rule this file exists to enforce is that a harness does not wake
 * somebody at 03:00 for something that will read identically at 09:00. The
 * rule it exists to NOT break is determinism: nothing here reads the clock.
 * `now` is an argument, always, so the same question asked twice gets the
 * same answer and a test can ask about a Sunday in a timezone nobody is in.
 *
 * Timezones come from `Intl`, which every runtime this ships on carries with
 * the full IANA database. That means real DST behaviour rather than a fixed
 * offset: a window of 22:00–07:00 in `America/New_York` is nine hours in
 * November and eight on the spring-forward night, which is what the person
 * asleep experiences.
 */

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

const WEEKDAYS: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export type QuietWindow = {
  /** Days the window STARTS on. Omitted means every day. */
  readonly days?: readonly Weekday[];
  /** `HH:MM`, 24-hour, in the schedule's timezone. */
  readonly start: string;
  /** `HH:MM`. Earlier than `start` means the window wraps past midnight. */
  readonly end: string;
};

export type QuietSchedule = {
  /** IANA name, e.g. `Europe/Berlin`. */
  readonly timezone: string;
  readonly quietWindows: readonly QuietWindow[];
  /** `YYYY-MM-DD` dates that are quiet all day, in the schedule's timezone. */
  readonly blackoutDates?: readonly string[];
};

export type QuietDecision = {
  readonly allowed: boolean;
  readonly reason: string;
  /** The instant the next non-quiet moment begins, ISO-8601 UTC. */
  readonly nextAllowed?: string;
  /** Local wall-clock time of `now` in the schedule's timezone. */
  readonly localTime: string;
  readonly localDate: string;
  readonly localWeekday: Weekday;
};

export type QuietError = { readonly error: string };

const CLOCK = /^([0-9]{1,2}):([0-9]{2})$/;

/** Minutes past local midnight, or `null` when `text` is not `HH:MM`. */
export function parseClock(text: string): number | null {
  const match = text.trim().match(CLOCK);
  if (match === null) return null;
  const hours = Number.parseInt(match[1] as string, 10);
  const minutes = Number.parseInt(match[2] as string, 10);
  if (hours > 24 || minutes > 59) return null;
  if (hours === 24 && minutes !== 0) return null;
  return hours * 60 + minutes;
}

type Zoned = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
};

/** A cached formatter per timezone — building one per call is the slow path. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall-clock reading of an instant in a timezone. */
function zonedParts(instant: number, timeZone: string): Zoned {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const get = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    return found === undefined ? 0 : Number.parseInt(found.value, 10);
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** The zone's UTC offset, in milliseconds, at a given instant. */
function offsetAt(instant: number, timeZone: string): number {
  const z = zonedParts(instant, timeZone);
  return Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second) - instant;
}

/**
 * The instant at which a zone reads a given wall clock.
 *
 * Two passes, which is the standard way to invert a zone lookup: guess with
 * the offset at the naive instant, then correct with the offset at the
 * guess. A wall time that a DST jump skipped entirely has no instant; the
 * second pass lands on the moment the clock jumped, which is the earliest
 * real time at or after the requested one, and that is the right answer for
 * "when may I send".
 */
function instantFor(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  minutesOfDay: number,
): number {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0) + minutesOfDay * 60_000;
  let instant = naive - offsetAt(naive, timeZone);
  instant = naive - offsetAt(instant, timeZone);
  return instant;
}

function weekdayOf(z: Zoned): Weekday {
  const index = new Date(Date.UTC(z.year, z.month - 1, z.day)).getUTCDay();
  return WEEKDAYS[index] as Weekday;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function isoDate(z: Zoned): string {
  return `${pad(z.year, 4)}-${pad(z.month, 2)}-${pad(z.day, 2)}`;
}

/** Validate a schedule up front, so a bad window is one error and not silence. */
export function validateSchedule(schedule: QuietSchedule): string | null {
  try {
    formatterFor(schedule.timezone);
  } catch {
    return `"${schedule.timezone}" is not a timezone this runtime knows — use an IANA name such as Europe/Berlin`;
  }
  if (schedule.quietWindows.length === 0 && (schedule.blackoutDates ?? []).length === 0) {
    return "the schedule has no quiet windows and no blackout dates, so it would never block anything — omit it instead";
  }
  for (const window of schedule.quietWindows) {
    if (parseClock(window.start) === null) {
      return `quiet window start "${window.start}" is not HH:MM`;
    }
    if (parseClock(window.end) === null) {
      return `quiet window end "${window.end}" is not HH:MM`;
    }
    if (parseClock(window.start) === parseClock(window.end)) {
      return `quiet window "${window.start}"–"${window.end}" is empty; use 00:00–24:00 for a whole day`;
    }
    for (const day of window.days ?? []) {
      if (!WEEKDAYS.includes(day)) return `"${day}" is not a weekday name (mon…sun)`;
    }
  }
  for (const date of schedule.blackoutDates ?? []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return `blackout date "${date}" is not YYYY-MM-DD`;
    }
  }
  return null;
}

/** Is `instant` inside a quiet window or a blackout date? */
function isQuiet(schedule: QuietSchedule, instant: number): boolean {
  const z = zonedParts(instant, schedule.timezone);
  const date = isoDate(z);
  if ((schedule.blackoutDates ?? []).includes(date)) return true;

  const minutes = z.hour * 60 + z.minute;
  const today = weekdayOf(z);
  const yesterday = WEEKDAYS[(WEEKDAYS.indexOf(today) + 6) % 7] as Weekday;

  for (const window of schedule.quietWindows) {
    const start = parseClock(window.start);
    const end = parseClock(window.end);
    if (start === null || end === null) continue;
    const days = window.days;
    const startsToday = days === undefined || days.includes(today);
    const startedYesterday = days === undefined || days.includes(yesterday);
    if (start < end) {
      if (startsToday && minutes >= start && minutes < end) return true;
    } else {
      // Wraps past midnight: the tail belongs to the day the window started.
      if (startsToday && minutes >= start) return true;
      if (startedYesterday && minutes < end) return true;
    }
  }
  return false;
}

/** Days ahead searched for the next allowed moment before giving up. */
const SEARCH_DAYS = 9;

/**
 * Decide whether a notification may be sent at `nowMs`, and when it may next
 * be.
 *
 * The search is exact rather than sampled: quiet can only end at a window's
 * end, or at local midnight when a blackout date rolls over, so those are
 * the only instants examined. Nine days of them is enough to escape any
 * weekly schedule; a schedule that blacks out more than nine consecutive
 * days is reported as such rather than answered with a guess.
 */
export function quietDecision(schedule: QuietSchedule, nowMs: number): QuietDecision | QuietError {
  const invalid = validateSchedule(schedule);
  if (invalid !== null) return { error: invalid };

  const z = zonedParts(nowMs, schedule.timezone);
  const local = {
    localTime: `${pad(z.hour, 2)}:${pad(z.minute, 2)}`,
    localDate: isoDate(z),
    localWeekday: weekdayOf(z),
  };

  if (!isQuiet(schedule, nowMs)) {
    return { allowed: true, reason: "not inside any quiet window", ...local };
  }

  const candidates = new Set<number>();
  for (let offset = 0; offset <= SEARCH_DAYS; offset++) {
    const dayStart = new Date(Date.UTC(z.year, z.month - 1, z.day + offset));
    const year = dayStart.getUTCFullYear();
    const month = dayStart.getUTCMonth() + 1;
    const day = dayStart.getUTCDate();
    candidates.add(instantFor(schedule.timezone, year, month, day, 0));
    for (const window of schedule.quietWindows) {
      const end = parseClock(window.end);
      if (end === null) continue;
      candidates.add(instantFor(schedule.timezone, year, month, day, end));
    }
  }

  const next = [...candidates]
    .filter((instant) => instant > nowMs)
    .sort((a, b) => a - b)
    .find((instant) => !isQuiet(schedule, instant));

  if (next === undefined) {
    return {
      allowed: false,
      reason: `inside a quiet window, and no allowed moment was found within ${SEARCH_DAYS} days — check the schedule, which may block continuously`,
      ...local,
    };
  }
  return {
    allowed: false,
    reason: "inside a quiet window",
    nextAllowed: new Date(next).toISOString(),
    ...local,
  };
}
