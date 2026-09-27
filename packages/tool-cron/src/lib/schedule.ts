/**
 * Cron interpretation — borrowed, not rebuilt.
 *
 * `@crewhaus/tool-datetime` already owns a real five-field cron parser and
 * the wall-clock walker that goes with it, including the DST cases that make
 * a 02:30 nightly job run twice or not at all. A second parser here would be
 * a second set of those bugs, so this file is a thin bridge to that package's
 * `CronNext` and `CronDescribe`.
 *
 * It goes through the TOOLS rather than the parser functions because
 * tool-datetime's exports map publishes `src/index.ts` only; `parseCron` and
 * `describeCron` live behind it in `src/lib/cron.ts`. Reaching around a
 * package's exports map to import a private module would couple this package
 * to that one's internal layout, so the public surface is used and the JSON
 * it returns is read. The cost is one JSON round trip per expression, which
 * is nothing next to the process spawn that produced the expression.
 *
 * The grammar boundary is enforced here: ONLY `cron5` and `cron-macro`
 * schedules are ever handed to a cron parser. A launchd calendar dictionary
 * and a systemd `OnCalendar` string are different languages, and feeding
 * either one to a five-field parser produces a confident wrong answer rather
 * than an error — which is exactly the failure this package exists to avoid.
 */
import { cronDescribe, cronNext, dateParse } from "@crewhaus/tool-datetime";

export type CronReading = {
  readonly description?: string;
  /** UTC instants, in order. */
  readonly firings?: readonly string[];
  /** The parser's own words when the expression could not be read. */
  readonly error?: string;
  readonly warning?: string;
  /** Wall clocks that do not exist because the clocks sprang forward. */
  readonly skippedForDst?: readonly string[];
};

type CronNextPayload = {
  ok?: boolean;
  error?: string;
  description?: string;
  firings?: { utc?: string }[];
  skippedForDst?: string[];
  warning?: string;
  note?: string;
};

/**
 * Read a five-field expression (or a cron macro) in a stated zone.
 *
 * `after` is supplied by the caller — this never reads a clock, so the same
 * listing asked at the same reference instant answers identically.
 */
export async function readCronExpression(
  expression: string,
  options: { readonly timeZone: string; readonly after: string; readonly count: number },
): Promise<CronReading> {
  try {
    // `CronDescribe` first, always. It is the only one of the two that
    // reports cron's day-of-month / day-of-week rule — `0 0 1 * MON` fires on
    // the 1st AND every Monday, not on Mondays that fall on the 1st — and a
    // caller reading a schedule they did not write needs that warning more
    // than they need the next firing. Both calls are pure computation, so the
    // second one costs nothing next to the process spawn that produced the
    // expression in the first place.
    const described = await run(cronDescribe.execute, { expression, includeFields: false });
    if (described === undefined) {
      return { error: "the datetime tool answered with something other than JSON text" };
    }
    if (described.ok === false) {
      return { error: described.error ?? "the expression could not be parsed" };
    }
    const payload =
      options.count > 0
        ? ((await run(cronNext.execute, {
            expression,
            after: options.after,
            count: options.count,
            timeZone: options.timeZone,
          })) ?? described)
        : described;
    if (payload.ok === false) {
      return { error: payload.error ?? "the expression could not be walked" };
    }
    const warning = payload.warning ?? described.warning;
    const firings = (payload.firings ?? [])
      .map((firing) => firing.utc)
      .filter((utc): utc is string => typeof utc === "string")
      .map(normaliseInstant);
    return {
      ...(described.description !== undefined ? { description: described.description } : {}),
      ...(firings.length > 0 ? { firings } : {}),
      ...(warning !== undefined ? { warning } : {}),
      ...(payload.note !== undefined && warning === undefined ? { warning: payload.note } : {}),
      ...(payload.skippedForDst !== undefined && payload.skippedForDst.length > 0
        ? { skippedForDst: payload.skippedForDst }
        : {}),
    };
  } catch (err) {
    // A throw here would take out a whole listing over one bad line, and a
    // crontab full of other people's jobs is exactly where a bad line lives.
    return {
      error: `reading the expression failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export type ReferenceInstant =
  | { readonly ok: true; readonly epochMs: number; readonly notes: readonly string[] }
  | { readonly ok: false; readonly error: string };

/**
 * Read the caller's reference instant the way `CronNext` reads `after`.
 *
 * A string with a `Z` or a `±hh:mm` offset names one instant everywhere. A
 * string without one is read on the wall clock of `timeZone` — the same zone
 * the schedules are walked in, UTC unless the caller names another — and
 * NEVER on the host's own clock: `Date.parse` reads an offset-less date-time
 * as host-local time, so the same call used to answer differently on every
 * machine while the result claimed the zone the caller asked for.
 *
 * The grammar is tool-datetime's `DateParse`, reached through the tool for
 * the same reason as `CronNext` above; a bare numeric date it finds
 * ambiguous (03/04/2026) is refused with both readings, not guessed.
 */
export async function readReferenceInstant(
  text: string,
  timeZone: string,
): Promise<ReferenceInstant> {
  let raw: unknown;
  try {
    raw = await dateParse.execute({ text, assumeTimeZone: timeZone });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (typeof raw !== "string") {
    return { ok: false, error: "the datetime tool answered with something other than text" };
  }
  let parsed: {
    ok?: unknown;
    error?: unknown;
    epochMs?: unknown;
    notes?: unknown;
    ambiguous?: { interpretations?: { dateOrder?: unknown; date?: unknown }[] };
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    // A caller error comes back as a plain sentence; that sentence is the reason.
    return { ok: false, error: raw };
  }
  if (
    parsed.ok !== true ||
    typeof parsed.epochMs !== "number" ||
    !Number.isFinite(parsed.epochMs)
  ) {
    const readings = (parsed.ambiguous?.interpretations ?? [])
      .map((reading) => `${String(reading.dateOrder)} => ${String(reading.date)}`)
      .join(", ");
    const error =
      typeof parsed.error === "string" ? parsed.error : "it is not a date this tool can read";
    return { ok: false, error: readings === "" ? error : `${error}: ${readings}` };
  }
  const notes = Array.isArray(parsed.notes)
    ? parsed.notes.filter((note): note is string => typeof note === "string")
    : [];
  return { ok: true, epochMs: parsed.epochMs, notes };
}

/**
 * One spelling for one kind of value.
 *
 * tool-datetime prints a firing as `2026-09-19T02:30:00Z` and the systemd
 * reader prints `2026-09-19T02:30:00.000Z`; both are the same instant, and a
 * listing that carries both spellings makes a caller write two parsers. The
 * conversion is lossless, and a string that is not a date is passed through
 * rather than turned into `Invalid Date`.
 */
function normaliseInstant(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}

async function run(
  execute: (input: unknown) => Promise<unknown>,
  input: unknown,
): Promise<CronNextPayload | undefined> {
  const result = await execute(input);
  if (typeof result !== "string") return undefined;
  try {
    const parsed = JSON.parse(result) as CronNextPayload;
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    // The datetime tools answer a caller error as a plain sentence rather
    // than JSON; that sentence is the error worth reporting.
    return { ok: false, error: result };
  }
}
