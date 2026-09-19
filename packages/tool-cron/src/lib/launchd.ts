/**
 * launchd, read the only way that is honest: from the definitions.
 *
 * `launchctl list` answers with what is LOADED — a pid, a last exit status
 * and a label — and on a Mac that is several hundred rows of Apple's own
 * agents, none of which a caller can manage. It does not say what any of them
 * is scheduled for; the schedule lives in the plist. So the listing here
 * starts from the plist files in the user's `LaunchAgents` directory (and,
 * when asked, the machine-wide ones), and `launchctl list` is folded in as
 * STATUS for the labels it knows.
 *
 * Two facts drive the shape of this file.
 *
 *   1. **A plist's file name is not its label.** On the machine this was
 *      written on, `~/Library/LaunchAgents/com.adobe.GC.Invoker-1.0.plist`
 *      declares `Label = com.adobe.GC.Scheduler-1.0`. Deriving a path from a
 *      label — or a label from a path — is a bug that surfaces as unloading
 *      the wrong job, so the mapping is always read out of the file.
 *   2. **`StartCalendarInterval` is not cron.** It is a dictionary, an
 *      omitted key means "every", and it may be an ARRAY of dictionaries
 *      meaning "all of these times" (Apple's own `com.apple.talagent` ships
 *      `[{Weekday:1,Hour:3},{Weekday:4,Hour:3}]`). Rendering it as a cron
 *      expression would be a translation between two grammars that do not
 *      agree — in particular cron fires when day-of-month OR day-of-week
 *      matches, and launchd's manual does not promise the same — so this
 *      package reports the dictionaries and says plainly that it did not
 *      compute a next firing from them.
 *
 * The plist is read through `plutil -convert json`, which ships with macOS.
 * The alternative was hand-parsing XML plists (and, for some agents, binary
 * ones) with no dependency allowed — a parser that would be wrong in ways
 * nobody would notice until it silently skipped a job.
 */
import { type JobEntry, type LaunchdCalendar, type Schedule, fingerprint } from "./entries";

export type LaunchctlRow = {
  readonly label: string;
  readonly pid?: number;
  readonly lastExitStatus?: number;
};

/**
 * `launchctl list` prints a three-column TAB-separated table under a
 * `PID\tStatus\tLabel` header, with `-` for "not running" and, in the status
 * column, either an exit status or a negative signal number.
 */
export function parseLaunchctlList(stdout: string): LaunchctlRow[] {
  const rows: LaunchctlRow[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    const cells = raw.split("\t");
    if (cells.length < 3) continue;
    const [pidCell, statusCell, ...labelCells] = cells;
    // The header row is the only one whose first cell is literally "PID".
    if (pidCell === "PID" && statusCell === "Status") continue;
    const label = labelCells.join("\t").trim();
    if (label === "") continue;
    rows.push({
      label,
      ...(numberOrDash(pidCell) !== undefined ? { pid: numberOrDash(pidCell) as number } : {}),
      ...(numberOrDash(statusCell) !== undefined
        ? { lastExitStatus: numberOrDash(statusCell) as number }
        : {}),
    });
  }
  return rows;
}

function numberOrDash(cell: string | undefined): number | undefined {
  if (cell === undefined) return undefined;
  const text = cell.trim();
  if (text === "" || text === "-") return undefined;
  const value = Number(text);
  return Number.isInteger(value) ? value : undefined;
}

export type LaunchdDefinition = {
  readonly label: string;
  readonly path: string;
  readonly scope: "user" | "system";
  readonly schedule: Schedule;
  readonly argv?: readonly string[];
  readonly disabled?: boolean;
  readonly raw: string;
};

export type PlistFailure = { readonly path: string; readonly reason: string };

/**
 * One plist, as `plutil -convert json -o -` prints it.
 *
 * Every failure is returned rather than thrown: a single unreadable plist in
 * a directory of twenty must not turn a listing into an error, but it must
 * also not vanish — a job the caller cannot see is a job they think is gone.
 */
export function parsePlistJson(
  path: string,
  scope: "user" | "system",
  jsonText: string,
): LaunchdDefinition | PlistFailure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return { path, reason: `plutil output is not JSON: ${(err as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { path, reason: "the plist's top level is not a dictionary" };
  }
  const dict = parsed as Record<string, unknown>;
  const label = dict["Label"];
  if (typeof label !== "string" || label.trim() === "") {
    return { path, reason: "no Label key — launchd will refuse this job too" };
  }

  const argv = programArgv(dict);
  return {
    label,
    path,
    scope,
    schedule: scheduleFromPlist(dict),
    ...(argv !== undefined ? { argv } : {}),
    ...(typeof dict["Disabled"] === "boolean" ? { disabled: dict["Disabled"] as boolean } : {}),
    raw: jsonText,
  };
}

function programArgv(dict: Record<string, unknown>): readonly string[] | undefined {
  const args = dict["ProgramArguments"];
  if (Array.isArray(args) && args.every((a) => typeof a === "string") && args.length > 0) {
    return args as string[];
  }
  const program = dict["Program"];
  if (typeof program === "string" && program !== "") return [program];
  return undefined;
}

function scheduleFromPlist(dict: Record<string, unknown>): Schedule {
  const calendar = dict["StartCalendarInterval"];
  if (calendar !== undefined) {
    const dicts = (Array.isArray(calendar) ? calendar : [calendar]).filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    );
    const normalised = dicts.map(toCalendar);
    if (normalised.length === 0) {
      return {
        grammar: "launchd-calendar",
        error: "StartCalendarInterval is present but is neither a dictionary nor a list of them",
      };
    }
    const bothDayAndWeekday = normalised.some(
      (cal) => cal.day !== undefined && cal.weekday !== undefined,
    );
    return {
      grammar: "launchd-calendar",
      expression: normalised.map(renderCalendar).join(" ; "),
      calendar: normalised,
      description: describeCalendar(normalised),
      note: bothDayAndWeekday
        ? "Day and Weekday are both set; launchd does not document this combination the way cron does (cron fires when EITHER matches), so treat the firing days as unverified"
        : "a launchd calendar is not a cron expression: an omitted key means every, and a list means all of these times",
    };
  }
  const interval = dict["StartInterval"];
  if (typeof interval === "number" && Number.isFinite(interval)) {
    return {
      grammar: "launchd-interval",
      expression: `StartInterval=${interval}`,
      intervalSeconds: interval,
      description: `every ${interval} seconds, counted from when the job was loaded`,
      note: "the interval restarts at load, so the firing times shift every time the agent is reloaded",
    };
  }
  const triggers = ["RunAtLoad", "KeepAlive", "WatchPaths", "QueueDirectories", "StartOnMount"]
    .filter((key) => dict[key] !== undefined)
    .sort();
  if (triggers.length > 0 || dict["LaunchEvents"] !== undefined) {
    const named = dict["LaunchEvents"] !== undefined ? [...triggers, "LaunchEvents"] : triggers;
    return {
      grammar: "launchd-event",
      expression: named.join(", "),
      description: `triggered by ${named.join(", ")}, not by a clock`,
    };
  }
  return { grammar: "none", description: "no schedule and no trigger in this definition" };
}

function toCalendar(dict: Record<string, unknown>): LaunchdCalendar {
  const pick = (key: string): number | undefined => {
    const value = dict[key];
    return typeof value === "number" && Number.isInteger(value) ? value : undefined;
  };
  return {
    ...(pick("Minute") !== undefined ? { minute: pick("Minute") as number } : {}),
    ...(pick("Hour") !== undefined ? { hour: pick("Hour") as number } : {}),
    ...(pick("Day") !== undefined ? { day: pick("Day") as number } : {}),
    ...(pick("Weekday") !== undefined ? { weekday: pick("Weekday") as number } : {}),
    ...(pick("Month") !== undefined ? { month: pick("Month") as number } : {}),
  };
}

function renderCalendar(cal: LaunchdCalendar): string {
  const parts: string[] = [];
  if (cal.month !== undefined) parts.push(`Month=${cal.month}`);
  if (cal.day !== undefined) parts.push(`Day=${cal.day}`);
  if (cal.weekday !== undefined) parts.push(`Weekday=${cal.weekday}`);
  if (cal.hour !== undefined) parts.push(`Hour=${cal.hour}`);
  if (cal.minute !== undefined) parts.push(`Minute=${cal.minute}`);
  return parts.length === 0 ? "{}" : parts.join(" ");
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Plain English for one or more calendar dictionaries.
 *
 * The wording keeps launchd's own defaulting visible: an omitted Minute means
 * every minute of the stated hour, which is a trap that has produced jobs
 * running sixty times a day, so it is said out loud rather than smoothed over.
 */
export function describeCalendar(cals: readonly LaunchdCalendar[]): string {
  return cals.map(describeOne).join("; and ");
}

function describeOne(cal: LaunchdCalendar): string {
  const time =
    cal.hour !== undefined && cal.minute !== undefined
      ? `at ${pad(cal.hour)}:${pad(cal.minute)}`
      : cal.hour !== undefined
        ? `every minute of the ${pad(cal.hour)}:00 hour`
        : cal.minute !== undefined
          ? `at ${pad(cal.minute)} minutes past every hour`
          : "every minute";
  const days: string[] = [];
  // launchd, like cron, accepts both 0 and 7 for Sunday.
  if (cal.weekday !== undefined)
    days.push(`on ${WEEKDAYS[cal.weekday % 7] ?? `weekday ${cal.weekday}`}`);
  if (cal.day !== undefined) days.push(`on day ${cal.day} of the month`);
  if (cal.month !== undefined) days.push(`in month ${cal.month}`);
  return days.length === 0 ? `${time} every day` : `${time} ${days.join(" and ")}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * The definitions and the loaded-state table, joined on the label.
 *
 * `statusKnown` is not a convenience flag. When `launchctl list` fails — no
 * bootstrap server in an ssh session, a timeout, a sandbox — there are no
 * rows, and a join against no rows says "not loaded" about EVERY agent on the
 * machine. That is a failed probe reported as a definite answer, and a caller
 * acts on it: it reads as "your agent is not running". So a failed status
 * read produces `state: "unknown"` and says which question went unanswered,
 * while an agent genuinely absent from a successful listing keeps saying
 * "not-loaded".
 */
export function launchdEntries(
  definitions: readonly LaunchdDefinition[],
  rows: readonly LaunchctlRow[],
  statusKnown = true,
): JobEntry[] {
  const status = new Map(rows.map((row) => [row.label, row]));
  return definitions.map((def) => {
    const row = status.get(def.label);
    const notes: string[] = [];
    if (!statusKnown) {
      notes.push(
        "launchctl list did not answer, so whether this agent is loaded or running could not be determined — the definition below is what is on disk",
      );
    } else if (row === undefined) {
      notes.push("not loaded right now — the definition is on disk but launchctl does not list it");
    }
    if (def.disabled === true) {
      notes.push("Disabled is set in the plist, so launchd will not run it until that is cleared");
    }
    return {
      source: "launchd" as const,
      // The label IS launchd's identifier: it is what `launchctl bootout`
      // takes, and it is read from the file rather than from the file's name.
      id: def.label,
      idKind: "launchd-label" as const,
      fingerprint: fingerprint(def.raw),
      schedule: def.schedule,
      ...(def.argv !== undefined ? { argv: def.argv, command: def.argv.join(" ") } : {}),
      definitionPath: def.path,
      scope: def.scope,
      enabled: def.disabled !== true,
      ...(row?.pid !== undefined ? { pid: row.pid } : {}),
      ...(row?.lastExitStatus !== undefined ? { lastExitStatus: row.lastExitStatus } : {}),
      state: !statusKnown
        ? "unknown"
        : row === undefined
          ? "not-loaded"
          : row.pid !== undefined
            ? "running"
            : "loaded",
      ...(notes.length > 0 ? { notes } : {}),
    };
  });
}
