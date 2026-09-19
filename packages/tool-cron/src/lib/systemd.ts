/**
 * systemd timers, read through the two commands whose output is a grammar
 * rather than a table.
 *
 * `systemctl list-timers` is the command a person uses, and it is the wrong
 * one to parse: its columns are `NEXT LEFT LAST PASSED UNIT ACTIVATES`, four
 * of which contain spaces ("Thu 2026-09-18 02:00:00 UTC", "1h 20min left"),
 * so splitting it is a guess that breaks on a timer that has never run. This
 * file uses `list-units --type=timer` to enumerate and `systemctl show` to
 * read each one: `show` prints `Key=Value`, one per line, which is the only
 * machine-readable surface systemd guarantees across versions.
 *
 * Two things this package deliberately does NOT do with a systemd timer:
 *
 *   1. **It does not translate `OnCalendar` into cron.** systemd.time(7) has
 *      timezone suffixes, `~` for the last days of a month, sub-second
 *      precision and expressions like `Mon *-*-1..7 02:00:00` that no cron
 *      field can hold. The expression is reported verbatim, labelled
 *      `systemd-oncalendar`, and left alone.
 *   2. **It does not compute the next firing.** systemd already did, exactly,
 *      with the host's own timezone and its own DST rules, and publishes it
 *      as `NextElapseUSecRealtime`. A second answer computed here could only
 *      ever be a worse one, so the reported value is passed through and
 *      marked `reported`.
 */
import { type JobEntry, type NextRun, type Schedule, fingerprint } from "./entries";

/**
 * One line of `systemctl list-units --type=timer`: the unit name is the first
 * column, possibly behind the status bullet systemd prints for a unit that is
 * not healthy.
 */
export function parseTimerUnitNames(stdout: string): string[] {
  const names: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    // A legend footer ("3 loaded units listed.") and the hint paragraph after
    // it are prose, not units; they never contain a `.timer` first token.
    const first = line.replace(/^[^\w/.]+\s*/, "").split(/\s+/)[0];
    if (first === undefined || !first.endsWith(".timer")) continue;
    names.push(first);
  }
  // Sorted and de-duplicated: `list-units` order is systemd's, and a listing
  // whose order changes between calls is not a listing a caller can diff.
  return [...new Set(names)].sort();
}

/** The properties `systemctl show` is asked for, in one place. */
export const SHOW_PROPERTIES = [
  "Id",
  "Description",
  "FragmentPath",
  "UnitFileState",
  "ActiveState",
  "NextElapseUSecRealtime",
  "NextElapseUSecMonotonic",
  "LastTriggerUSec",
  "TimersCalendar",
  "TimersMonotonic",
  "Unit",
] as const;

export type ShowBlock = Readonly<Record<string, string>>;

/**
 * `systemctl show -- a.timer b.timer` prints one `Key=Value` block per unit,
 * separated by a blank line. Two things about that output are easy to get
 * wrong, and both were found by running the real command rather than by
 * writing a fixture from memory:
 *
 *   - A value may itself contain `=`, so only the FIRST one separates.
 *   - **A key can repeat.** A timer with two `OnCalendar=` lines prints two
 *     separate `TimersCalendar={ … }` lines, not one line with two braces.
 *     Last-one-wins would silently drop half of a timer's schedule, so
 *     repeats are accumulated and separated by a newline; every reader below
 *     scans the whole accumulated value.
 */
export function parseShowBlocks(stdout: string): ShowBlock[] {
  const blocks: ShowBlock[] = [];
  let current: Record<string, string> = {};
  let seen = false;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === "") {
      if (seen) blocks.push(current);
      current = {};
      seen = false;
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    const existing = current[key];
    current[key] = existing === undefined ? value : `${existing}\n${value}`;
    seen = true;
  }
  if (seen) blocks.push(current);
  return blocks;
}

/**
 * `%a %Y-%m-%d %H:%M:%S %Z` — how systemd 257 prints a timestamp property.
 * Older systemd printed the raw microseconds instead, so both are read.
 */
const PRETTY_TIMESTAMP =
  /^[A-Za-z]{2,4} (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d+)? ([A-Za-z]{1,6}|[+-]\d{4})$/;

export type SystemdTime = {
  /** UTC ISO instant, when one could be derived without guessing. */
  readonly at?: string;
  /** systemd's own text, kept whenever it could not be converted. */
  readonly raw?: string;
  readonly note?: string;
};

/**
 * Read a systemd timestamp property.
 *
 * The name says USec and an older systemd really did print microseconds, but
 * systemd 257 prints "Sat 2026-09-19 02:30:00 UTC" — checked, not assumed.
 * A parser that only handled the integer form would return "no next run" for
 * every timer on a modern host, which reads as "nothing is scheduled".
 *
 * "Never" is the empty string on systemd 257 and `0` on older ones;
 * "infinity" is UINT64_MAX. All three are rejected before a Date is built,
 * because each of them otherwise becomes a real-looking wrong answer (1970,
 * or a year nobody has heard of).
 */
export function parseSystemdTime(value: string | undefined): SystemdTime {
  if (value === undefined) return {};
  const text = value.trim();
  if (text === "" || text === "0" || text === "n/a" || text === "-") return {};

  if (/^\d+$/.test(text)) {
    const usec = Number(text);
    const ms = Math.floor(usec / 1000);
    // Year 2100, in ms. Above it the value is systemd's infinity sentinel.
    if (!Number.isFinite(ms) || ms <= 0 || ms > 4_102_444_800_000) return { raw: text };
    return { at: new Date(ms).toISOString() };
  }

  const matched = text.match(PRETTY_TIMESTAMP);
  if (matched === null) return { raw: text };
  const zone = matched[7] ?? "";
  if (zone !== "UTC" && zone !== "GMT" && zone !== "Z") {
    // This package pins TZ=UTC for every child it runs, so a different zone
    // here means the host overrode it. Converting would mean knowing that
    // abbreviation's offset, and abbreviations are ambiguous (CST is three
    // different zones), so the text is passed through instead of guessed at.
    return {
      raw: text,
      note: `systemd printed this in ${zone}, not UTC, so it is passed through unconverted`,
    };
  }
  const ms = Date.UTC(
    Number(matched[1]),
    Number(matched[2]) - 1,
    Number(matched[3]),
    Number(matched[4]),
    Number(matched[5]),
    Number(matched[6]),
  );
  return Number.isFinite(ms) ? { at: new Date(ms).toISOString() } : { raw: text };
}

/** `TimersCalendar={ OnCalendar=*-*-* 02:00:00 ; next_elapse=… }`, possibly repeated. */
export function onCalendarExpressions(value: string | undefined): string[] {
  if (value === undefined) return [];
  const found: string[] = [];
  for (const group of value.matchAll(/\{([^}]*)\}/g)) {
    const body = group[1] ?? "";
    const matched = body.match(/OnCalendar=([^;}]*)/);
    const expression = matched?.[1]?.trim() ?? "";
    if (expression !== "") found.push(expression);
  }
  return found;
}

/** `TimersMonotonic={ OnBootUSec=900000000 ; next_elapse=… }`. */
export function monotonicExpressions(value: string | undefined): string[] {
  if (value === undefined) return [];
  const found: string[] = [];
  for (const group of value.matchAll(/\{([^}]*)\}/g)) {
    const body = group[1] ?? "";
    const matched = body.match(/(On[A-Za-z]*USec)=([^;}]*)/);
    const key = matched?.[1];
    if (key === undefined) continue;
    const amount = matched?.[2]?.trim() ?? "";
    found.push([key, amount].join("="));
  }
  return found;
}

function scheduleFrom(block: ShowBlock): Schedule {
  const calendar = onCalendarExpressions(block["TimersCalendar"]);
  if (calendar.length > 0) {
    return {
      grammar: "systemd-oncalendar",
      expression: calendar.join(" ; "),
      note:
        calendar.length > 1
          ? "several OnCalendar= expressions: the timer fires at the union of them"
          : "systemd.time(7) syntax, not cron — this package reports it as written and does not translate it",
    };
  }
  const monotonic = monotonicExpressions(block["TimersMonotonic"]);
  if (monotonic.length > 0) {
    return {
      grammar: "systemd-monotonic",
      expression: monotonic.join(" ; "),
      note: "relative to boot or to the unit's last activation, so there is no fixed wall-clock time",
    };
  }
  return {
    grammar: "none",
    error: "the unit reports neither TimersCalendar nor TimersMonotonic",
  };
}

/**
 * The properties a timer's IDENTITY is made of, in a fixed order.
 *
 * The fingerprint exists so a destructive call can prove it is about to
 * remove the thing it was shown. Hashing the whole `show` block defeats that:
 * `NextElapseUSecRealtime` moves every time the timer fires, `LastTriggerUSec`
 * with it, and `ActiveState` flips while the service runs — so the hash of a
 * timer NOBODY TOUCHED is different a minute later, and `CronDelete` refuses
 * with "it changed since it was listed", which is a false statement about the
 * definition. Key ORDER matters too: a block is a map built from systemctl's
 * output order, and `JSON.stringify` over it makes the hash depend on that
 * order rather than on the content.
 */
const IDENTITY_PROPERTIES = [
  "Id",
  "Unit",
  "FragmentPath",
  "Description",
  "TimersCalendar",
  "TimersMonotonic",
] as const;

/** Only the parts of a `TimersCalendar=` line that describe the SCHEDULE. */
function identityText(block: ShowBlock): string {
  return IDENTITY_PROPERTIES.map((key) => {
    const value = block[key] ?? "";
    // `TimersCalendar={ OnCalendar=… ; next_elapse=… }` carries a computed
    // firing time inside the same line as the expression; it moves for the
    // same reason the timestamps do, so it is cut out here.
    return `${key}=${value.replace(/\s*;\s*next_elapse=[^;}]*/g, "")}`;
  }).join("\n");
}

/**
 * How `UnitFileState` answers "will this start on its own?" — and when it
 * does not answer at all.
 *
 * A boolean here was wrong in both directions. `static` means the unit has no
 * [Install] section, so it can be neither enabled nor disabled and is pulled
 * in by something else — `enabled: false` next to `ActiveState=active` is a
 * contradiction the caller has to resolve. `enabled-runtime` is enabled right
 * now and gone after a reboot. An EMPTY value (a transient unit, or one
 * systemd has no file for) is not an answer at all. Only the four states that
 * really are yes-or-no produce a boolean; everything else reports the raw
 * word and leaves `enabled` off.
 */
export function enablement(fileState: string | undefined): {
  enabled?: boolean;
  note?: string;
} {
  const text = (fileState ?? "").trim();
  if (text === "") {
    return {
      note: "systemd reported no UnitFileState, so whether this unit starts on its own could not be determined",
    };
  }
  if (text === "enabled") return { enabled: true };
  if (text === "enabled-runtime") {
    return {
      enabled: true,
      note: "UnitFileState=enabled-runtime: enabled only until the next boot",
    };
  }
  if (text === "disabled" || text === "masked" || text === "masked-runtime") {
    return { enabled: false, note: `UnitFileState=${text}` };
  }
  return {
    note: `UnitFileState=${text}: this unit has no enable/disable switch of its own (it is pulled in by another unit), so "enabled" is not a yes-or-no question for it`,
  };
}

export function systemdEntries(blocks: readonly ShowBlock[], scope: "user" | "system"): JobEntry[] {
  const entries: JobEntry[] = [];
  for (const block of blocks) {
    const id = block["Id"];
    if (id === undefined || !id.endsWith(".timer")) continue;
    const next = parseSystemdTime(block["NextElapseUSecRealtime"]);
    const nextRun: NextRun | undefined =
      next.at === undefined ? undefined : { at: next.at, source: "reported" };
    const last = parseSystemdTime(block["LastTriggerUSec"]);
    const notes: string[] = [];
    if (next.note !== undefined) notes.push(`next elapse: ${next.note}`);
    if (next.raw !== undefined) notes.push(`systemd reports the next elapse as ${next.raw}`);
    if (last.note !== undefined) notes.push(`last trigger: ${last.note}`);
    if (next.at === undefined) {
      // systemd 257 prints this as a DURATION ("6d 18h 50min 33.481175s"),
      // not a number, so anything non-empty other than 0 means the timer's
      // next elapse is measured from boot rather than from a wall clock.
      const mono = (block["NextElapseUSecMonotonic"] ?? "").trim();
      if (mono !== "" && mono !== "0") {
        notes.push(
          `the next elapse is monotonic (${mono} from boot), so systemd reports no wall-clock time for it`,
        );
      }
    }
    const state = block["ActiveState"];
    const enabledState = enablement(block["UnitFileState"]);
    if (enabledState.note !== undefined) notes.push(enabledState.note);
    entries.push({
      source: "systemd",
      // The unit name is systemd's identifier and what every systemctl
      // subcommand takes. It is echoed exactly as systemd spelled it.
      id,
      idKind: "systemd-unit",
      // The DEFINITION's hash, not the snapshot's — see IDENTITY_PROPERTIES.
      fingerprint: fingerprint(identityText(block)),
      schedule: scheduleFrom(block),
      ...(block["Unit"] !== undefined && block["Unit"] !== ""
        ? { command: `activates ${block["Unit"]}` }
        : {}),
      ...(block["FragmentPath"] !== undefined && block["FragmentPath"] !== ""
        ? { definitionPath: block["FragmentPath"] }
        : {}),
      ...(nextRun !== undefined ? { nextRun } : {}),
      ...(last.at !== undefined ? { lastRun: last.at } : {}),
      // `enabled` is about the unit FILE (will it start at boot), which is a
      // different question from ActiveState (is it running now). Both are
      // reported because a delete acts on the first and a caller usually
      // looks at the second — and `enabled` is omitted entirely for the unit
      // file states that are not a yes or a no (see `enablement`).
      ...(enabledState.enabled !== undefined ? { enabled: enabledState.enabled } : {}),
      ...(state !== undefined && state !== "" ? { state } : {}),
      scope,
      ...(notes.length > 0 ? { notes } : {}),
    });
  }
  return entries;
}

/**
 * Why `systemctl` could not answer, in systemd's own words where it gave any.
 *
 * The cases are genuinely different next moves for a caller, and collapsing
 * them into "systemd unavailable" is what makes a host with a broken user bus
 * look like a host with no timers.
 */
export function systemctlUnavailableReason(stderr: string, exitCode: number): string | undefined {
  const text = stderr.trim();
  if (/has not been booted with systemd/i.test(text)) {
    return "systemd is installed but is not this machine's init system (the usual case inside a container)";
  }
  // Real wording, captured on Debian 13: "Failed to connect to user scope bus
  // via local transport: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not
  // defined". An earlier version of this matched "Failed to connect to bus"
  // and missed every one of them, which is exactly the failure a hand-written
  // fixture would have hidden.
  if (/Failed to connect to .*bus/i.test(text) || /No medium found/i.test(text)) {
    return `systemctl could not reach the bus — ${firstLine(text)}`;
  }
  if (exitCode !== 0) {
    return firstLine(text) === "" ? `systemctl exited ${exitCode}` : firstLine(text);
  }
  return undefined;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/)[0]?.trim() ?? "";
}
