/**
 * The one shape three schedulers are reported in — and, deliberately, the
 * places where it refuses to pretend they are the same thing.
 *
 * crontab, launchd and systemd are three different models. A crontab entry is
 * a LINE IN A FILE with no identity of its own; a launchd job is a LABEL
 * inside a plist that may be named something else entirely (on the machine
 * this was written on, `com.adobe.GC.Invoker-1.0.plist` declares the label
 * `com.adobe.GC.Scheduler-1.0`, so deriving one from the other is wrong); a
 * systemd timer is a UNIT that knows its own next elapse. Flattening those
 * into "id + schedule string" would lose exactly what a caller needs to act,
 * so every entry carries:
 *
 *   - `source`, always, because the next command a caller runs depends on it;
 *   - `id`, the scheduler's OWN identifier, in the scheduler's own spelling —
 *     the label, the unit name, the line number — because that identifier is
 *     what `CronDelete` needs and what the host will recognise;
 *   - `schedule.grammar`, because `30 2 * * *`, `{Hour=2,Minute=30}` and
 *     `*-*-* 02:30:00` are three languages and only the first is cron.
 *
 * A crontab line's `id` is its 1-based line number, which is not stable: it
 * moves when anything above it is added or removed. `fingerprint` is the
 * repair — a hash of the line's own bytes, so a delete can prove it is about
 * to remove the line it was shown rather than whatever now sits at that
 * position.
 */
import { createHash } from "node:crypto";

export type JobSource = "crontab" | "launchd" | "systemd";

/** Which language the schedule is written in. Never guessed, never mixed. */
export type ScheduleGrammar =
  /** Five fields: minute hour day-of-month month day-of-week. */
  | "cron5"
  /** `@daily`, `@hourly`, … — cron's macros, which expand to five fields. */
  | "cron-macro"
  /** `@reboot`: an event, not a time. Nothing can compute its next firing. */
  | "cron-reboot"
  /** launchd `StartCalendarInterval`: a dict (or a list of dicts), not cron. */
  | "launchd-calendar"
  /** launchd `StartInterval`: every N seconds from load. */
  | "launchd-interval"
  /** launchd `RunAtLoad`/`KeepAlive`/`WatchPaths`: triggered, not scheduled. */
  | "launchd-event"
  /** systemd `OnCalendar`: systemd.time(7) syntax, which is not cron. */
  | "systemd-oncalendar"
  /** systemd `OnBootSec`/`OnUnitActiveSec`: relative to an event. */
  | "systemd-monotonic"
  /** The definition carries no schedule at all. */
  | "none";

export type LaunchdCalendar = {
  readonly minute?: number;
  readonly hour?: number;
  readonly day?: number;
  readonly weekday?: number;
  readonly month?: number;
};

export type Schedule = {
  readonly grammar: ScheduleGrammar;
  /** The schedule exactly as the host stated it. Never re-rendered. */
  readonly expression?: string;
  /** launchd's calendar dicts, normalised to a list; a list means "all of these". */
  readonly calendar?: readonly LaunchdCalendar[];
  readonly intervalSeconds?: number;
  /** Plain English. For cron5/cron-macro this comes from `CronDescribe`. */
  readonly description?: string;
  /** Why a schedule could not be interpreted, in the interpreter's words. */
  readonly error?: string;
  readonly note?: string;
};

export type NextRun = {
  readonly at: string;
  /**
   * `computed` — this package asked `@crewhaus/tool-datetime` to walk the
   * expression. `reported` — the scheduler itself said so, which is always
   * the better answer and is why systemd's own `NextElapseUSecRealtime` is
   * echoed rather than recomputed.
   */
  readonly source: "computed" | "reported";
};

export type JobEntry = {
  readonly source: JobSource;
  /** The scheduler's own identifier, in its own spelling. */
  readonly id: string;
  readonly idKind: "crontab-line" | "launchd-label" | "systemd-unit";
  /** Hash of the bytes this entry was read from; see the header. */
  readonly fingerprint: string;
  readonly schedule: Schedule;
  /** What runs: the crontab command line, the launchd program, the unit it activates. */
  readonly command?: string;
  /**
   * launchd's `ProgramArguments`, kept as an array. `command` is the readable
   * join of it; the array is the truth, because an argument with a space in
   * it is indistinguishable from two arguments once they are joined.
   */
  readonly argv?: readonly string[];
  readonly enabled?: boolean;
  readonly definitionPath?: string;
  readonly nextRun?: NextRun;
  /** Further computed firings, when the caller asked for more than one. */
  readonly nextRuns?: readonly string[];
  readonly lastRun?: string;
  readonly lastExitStatus?: number;
  readonly pid?: number;
  readonly state?: string;
  readonly scope?: "user" | "system";
  readonly line?: number;
  readonly notes?: readonly string[];
};

/**
 * A short content hash. Twelve hex characters is 48 bits — plenty to catch a
 * line that changed under a caller, and short enough that returning one per
 * entry does not cost a paragraph of context.
 */
export function fingerprint(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

/** Deterministic order. `readdir` order is not an order, and neither is a Map's. */
export function byEntry(a: JobEntry, b: JobEntry): number {
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  if (a.line !== undefined && b.line !== undefined && a.line !== b.line) return a.line - b.line;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export type Selector = {
  readonly id?: string;
  readonly match?: string;
  readonly fingerprint?: string;
};

export type SelectionFailure = {
  readonly ok: false;
  readonly reason:
    | "no-selector"
    | "both-selectors"
    | "not-found"
    | "ambiguous"
    | "fingerprint-mismatch";
  readonly message: string;
  /** Populated on `ambiguous` so the caller can pick one by id. */
  readonly candidates?: readonly JobEntry[];
};

export type Selection = { readonly ok: true; readonly entries: readonly JobEntry[] };

/**
 * Pick the entries a destructive call is about, or refuse.
 *
 * The refusals are the feature. `match` is a substring, and a substring that
 * matched twice is not an instruction — deleting somebody's backup job
 * because a pattern also matched their log rotation is not recoverable from a
 * tool result, so more than one match is an error unless the caller said
 * `allowMultiple`. Zero matches is an error too: a delete that quietly did
 * nothing reads exactly like a delete that worked.
 */
export function selectEntries(
  entries: readonly JobEntry[],
  selector: Selector,
  allowMultiple: boolean,
): Selection | SelectionFailure {
  const hasId = selector.id !== undefined && selector.id !== "";
  const hasMatch = selector.match !== undefined && selector.match !== "";
  if (!hasId && !hasMatch) {
    return {
      ok: false,
      reason: "no-selector",
      message:
        "pass either id (exact, from CronList) or match (substring) — this tool never deletes everything it can see",
    };
  }
  if (hasId && hasMatch) {
    return {
      ok: false,
      reason: "both-selectors",
      message: "pass id or match, not both — two selectors means two different intentions",
    };
  }

  const matched = hasId
    ? entries.filter((entry) => entry.id === selector.id)
    : entries.filter((entry) => matchesSubstring(entry, selector.match as string));

  if (matched.length === 0) {
    // The hint is source-specific on purpose: "line numbers move" is true of
    // a crontab and meaningless for a label or a unit name, and a wrong hint
    // sends a caller looking in the wrong place.
    const hint = entries.some((entry) => entry.source === "crontab")
      ? " — list first; a crontab line number moves when a line above it is removed"
      : " — list first; the id is the label or unit name exactly as the scheduler spells it";
    return {
      ok: false,
      reason: "not-found",
      message: hasId
        ? `no entry with id ${JSON.stringify(selector.id)}${hint}`
        : `nothing matched ${JSON.stringify(selector.match)}`,
    };
  }
  if (matched.length > 1 && !allowMultiple) {
    return {
      ok: false,
      reason: "ambiguous",
      message: `${matched.length} entries match — pass allowMultiple: true to mean all of them, or select one by id`,
      candidates: matched,
    };
  }
  if (selector.fingerprint !== undefined) {
    const stale = matched.filter((entry) => entry.fingerprint !== selector.fingerprint);
    if (stale.length > 0 || matched.length !== 1) {
      return {
        ok: false,
        reason: "fingerprint-mismatch",
        message:
          matched.length === 1
            ? `the entry at ${JSON.stringify(matched[0]?.id)} now hashes to ${matched[0]?.fingerprint}, not ${selector.fingerprint} — it changed since it was listed, so nothing was deleted`
            : "fingerprint pins exactly one entry, but the selector matched more than one",
        candidates: matched,
      };
    }
  }
  return { ok: true, entries: matched };
}

/**
 * Case-insensitive substring over the fields a person would recognise the job
 * by. Not a regex: a caller-supplied regex is a denial-of-service surface and
 * a source of accidental over-matching, and neither is worth it for a
 * selector whose job is to be UNambiguous.
 */
function matchesSubstring(entry: JobEntry, needle: string): boolean {
  const hay = [entry.id, entry.command ?? "", entry.schedule.expression ?? ""]
    .join("\n")
    .toLowerCase();
  return hay.includes(needle.toLowerCase());
}
