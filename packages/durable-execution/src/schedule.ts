/**
 * Loop contract 0.4 (Batch F, temporal contract / G84 schedule half) — the
 * runtime the daemon-able bundles (channel / batch) arm their `schedule:`
 * wake loop with. The compiler lowers `schedule:` into an `IrSchedule`
 * (cron OR interval, durations already normalized to ms); the emitters embed
 * the numeric-literal {@link WakeSchedule} and hand `armSchedule` the wake
 * callback, so all of the cron arithmetic lives HERE — one tested place —
 * instead of duplicated across two emitted daemon templates.
 *
 * `WakeSchedule` is the IR's `IrSchedule` MINUS `instructions` (the synthetic
 * wake prompt is the emitter's concern, threaded into `onWake`): the schedule
 * runtime only decides *when* to fire, never *what* to run. That keeps this
 * package free of any `@crewhaus/ir` dependency.
 *
 * The cron parser is a pragmatic 5-/6-field matcher: `*`, `?`, numeric,
 * lists (`a,b`), ranges (`a-b`), and steps (`* /n`, `a/n`, `a-b/n`), plus
 * month/weekday names, evaluated in an IANA timezone (default UTC). The
 * Quartz-style extensions (`L`, `W`, `#`) are not interpreted — a field
 * containing one is treated as a wildcard so the daemon never crashes on a
 * cron it cannot fully model; the spec's own `schedule.cron` regex is the
 * syntactic gate.
 */

/** IR's `IrSchedule` without `instructions` — the "when", never the "what". */
export type WakeSchedule =
  | {
      readonly kind: "cron";
      /** A 5- or 6-field cron expression (6-field is second-first, Quartz). */
      readonly cron: string;
      /** IANA tz the cron evaluates in; absent → UTC. */
      readonly timezone?: string;
      /** Random +/- delay per wake, in ms. Absent → fire exactly on time. */
      readonly jitterMs?: number;
    }
  | {
      readonly kind: "interval";
      readonly everyMs: number;
      readonly jitterMs?: number;
    };

const MONTH_NAMES: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const DOW_NAMES: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/** A parsed cron field: `"*"` matches anything, otherwise a value set. */
type FieldMatch = "*" | ReadonlySet<number>;

function fieldMatches(field: FieldMatch, n: number): boolean {
  return field === "*" || field.has(n);
}

/**
 * Parse one cron field into a {@link FieldMatch}. Unrecognised tokens (the
 * `L`/`W`/`#` Quartz extensions) collapse the whole field to `"*"` — a
 * fail-open the daemon can survive rather than a throw that would kill the
 * scheduler.
 */
function parseField(
  field: string,
  min: number,
  max: number,
  names?: Readonly<Record<string, number>>,
): FieldMatch {
  const trimmed = field.trim();
  if (trimmed === "*" || trimmed === "?") return "*";
  if (/[LW#]/i.test(trimmed)) return "*";

  const out = new Set<number>();
  const tok = (t: string): number => {
    const named = names?.[t.toLowerCase()];
    return named !== undefined ? named : Number.parseInt(t, 10);
  };

  for (const part of trimmed.split(",")) {
    const slash = part.indexOf("/");
    const rangeText = slash >= 0 ? part.slice(0, slash) : part;
    const step = slash >= 0 ? Math.max(1, Number.parseInt(part.slice(slash + 1), 10) || 1) : 1;

    let lo: number;
    let hi: number;
    if (rangeText === "*" || rangeText === "?" || rangeText === "") {
      lo = min;
      hi = max;
    } else if (rangeText.includes("-")) {
      const [a, b] = rangeText.split("-");
      lo = tok(a ?? "");
      hi = tok(b ?? "");
    } else {
      lo = tok(rangeText);
      // `a/n` (a bare start with a step) means "a, a+n, a+2n, … up to max".
      hi = slash >= 0 ? max : lo;
    }
    if (Number.isNaN(lo) || Number.isNaN(hi)) return "*";
    for (let v = lo; v <= hi; v += step) {
      if (v >= min && v <= max) out.add(v);
    }
  }
  return out.size === 0 ? "*" : out;
}

type WallClock = {
  readonly minute: number;
  readonly hour: number;
  readonly dom: number;
  readonly month: number;
  readonly dow: number;
};

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Wall-clock fields of `date` in `timezone` (UTC when absent). */
function wallClock(date: Date, timezone?: string): WallClock {
  if (timezone === undefined) {
    return {
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      dom: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      dow: date.getUTCDay(),
    };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const hour24 = Number.parseInt(get("hour"), 10);
  return {
    minute: Number.parseInt(get("minute"), 10),
    // Intl with hour12:false yields "24" for midnight in some ICU builds.
    hour: hour24 === 24 ? 0 : hour24,
    dom: Number.parseInt(get("day"), 10),
    month: Number.parseInt(get("month"), 10),
    dow: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
}

const MINUTE_MS = 60_000;
const CRON_SEARCH_MINUTES = 366 * 24 * 60; // give up after a year without a match

/**
 * The next `Date` strictly after `from` at which `cron` fires, evaluated in
 * `timezone` (UTC when absent). Minute-granularity search; a 6-field cron's
 * leading seconds field picks the smallest matching second inside the
 * matched minute. Standard day-of-month / day-of-week rule: when BOTH are
 * restricted the match is their UNION; when one is `*` the other decides.
 */
export function nextCronMatch(cron: string, from: Date, timezone?: string): Date {
  const fields = cron.trim().split(/\s+/);
  const [secR, minR, hourR, domR, monR, dowR] = fields.length >= 6 ? fields : ["0", ...fields];

  const secSet = parseField(secR ?? "0", 0, 59);
  const minSet = parseField(minR ?? "*", 0, 59);
  const hourSet = parseField(hourR ?? "*", 0, 23);
  const domSet = parseField(domR ?? "*", 1, 31);
  const monSet = parseField(monR ?? "*", 1, 12, MONTH_NAMES);
  const dowRaw = parseField(dowR ?? "*", 0, 7, DOW_NAMES);
  // Normalize Sunday: cron accepts both 0 and 7.
  const dowSet: FieldMatch =
    dowRaw === "*" ? "*" : new Set([...dowRaw].map((d) => (d === 7 ? 0 : d)));

  const domRestricted = domSet !== "*";
  const dowRestricted = dowSet !== "*";

  // Search minute-by-minute from the CURRENT minute (so a 6-field cron whose
  // matching second is still ahead inside `from`'s own minute is found), and
  // accept only a whole timestamp STRICTLY after `from`.
  const fromMs = from.getTime();
  let t = new Date(Math.floor(fromMs / MINUTE_MS) * MINUTE_MS);
  for (let i = 0; i <= CRON_SEARCH_MINUTES; i++) {
    const wc = wallClock(t, timezone);
    const domOk = fieldMatches(domSet, wc.dom);
    const dowOk = fieldMatches(dowSet, wc.dow);
    const dayOk = domRestricted && dowRestricted ? domOk || dowOk : domRestricted ? domOk : dowOk;
    if (
      dayOk &&
      fieldMatches(minSet, wc.minute) &&
      fieldMatches(hourSet, wc.hour) &&
      fieldMatches(monSet, wc.month)
    ) {
      for (let s = 0; s <= 59; s++) {
        if (!fieldMatches(secSet, s)) continue;
        const candidate = t.getTime() + s * 1000;
        if (candidate > fromMs) return new Date(candidate);
      }
    }
    t = new Date(t.getTime() + MINUTE_MS);
  }
  throw new Error(`cron "${cron}" produced no wake within a year`);
}

/**
 * Milliseconds to wait from `fromMs` before the next wake. Jitter (when
 * declared) adds a uniform `+/- jitterMs` offset drawn from `rand`
 * (`Math.random` by default); the result never goes negative.
 */
export function nextWakeDelayMs(
  schedule: WakeSchedule,
  fromMs: number,
  rand: () => number = Math.random,
): number {
  const base =
    schedule.kind === "interval"
      ? schedule.everyMs
      : nextCronMatch(schedule.cron, new Date(fromMs), schedule.timezone).getTime() - fromMs;
  const jitter =
    schedule.jitterMs !== undefined && schedule.jitterMs > 0
      ? (rand() * 2 - 1) * schedule.jitterMs
      : 0;
  return Math.max(0, Math.round(base + jitter));
}

export interface ArmScheduleHandlers {
  /** Runs on every wake; awaited so overlapping ticks can't stack. */
  readonly onWake: () => void | Promise<void>;
  /** A thrown `onWake` lands here instead of crashing the scheduler. */
  readonly onError?: (err: unknown) => void;
  readonly now?: () => number;
  readonly rand?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface ArmedSchedule {
  /** Stop the loop and clear any pending timer. Idempotent. */
  cancel(): void;
}

/**
 * Arm a self-rescheduling wake loop for `schedule`. Each tick computes its
 * OWN next delay (so cron drift and per-wake jitter stay correct across a
 * long-lived daemon) and re-arms only AFTER `onWake` resolves, so a slow tick
 * can never overlap itself. All timing seams (`now`/`rand`/`setTimer`) are
 * injectable for deterministic tests. Returns a cancel handle the daemon's
 * shutdown path calls.
 */
export function armSchedule(schedule: WakeSchedule, handlers: ArmScheduleHandlers): ArmedSchedule {
  const now = handlers.now ?? Date.now;
  const rand = handlers.rand ?? Math.random;
  const setTimer = handlers.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    handlers.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let cancelled = false;
  let handle: unknown;

  const scheduleNext = (): void => {
    if (cancelled) return;
    const delay = nextWakeDelayMs(schedule, now(), rand);
    handle = setTimer(() => {
      if (cancelled) return;
      void (async () => {
        try {
          await handlers.onWake();
        } catch (err) {
          handlers.onError?.(err);
        }
        scheduleNext();
      })();
    }, delay);
  };

  scheduleNext();
  return {
    cancel(): void {
      cancelled = true;
      if (handle !== undefined) clearTimer(handle);
    },
  };
}
