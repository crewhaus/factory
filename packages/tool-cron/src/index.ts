import { basename, dirname, join } from "node:path";
/**
 * `@crewhaus/tool-cron` — what this machine is going to run, and removing one
 * of those jobs without touching the rest.
 *
 * Two tools. `CronList` reads the schedulers the host actually has: the
 * user's crontab everywhere, launchd agents on macOS, systemd timers on Linux.
 * `CronDelete` removes exactly one of the entries `CronList` showed.
 *
 * FOUR PROPERTIES HOLD ACROSS BOTH.
 *
 * 1. **Three schedulers, three shapes, one report — and the seams between
 *    them stay visible.** Every entry names its `source` and carries that
 *    scheduler's OWN identifier: a crontab line number, a launchd label, a
 *    systemd unit name. Every schedule names its `grammar`, because
 *    `30 2 * * *`, `{Hour=2, Minute=30}` and `*-*-* 02:30:00` are three
 *    different languages. Flattening them would produce a listing that reads
 *    well and cannot be acted on.
 * 2. **Cron is parsed once, in `@crewhaus/tool-datetime`.** `CronNext` and
 *    `CronDescribe` already own the five-field grammar and the DST walk, so
 *    this package asks them (see `./lib/schedule`) and never guesses. A
 *    launchd calendar dictionary and a systemd `OnCalendar` string are NOT
 *    fed to a cron parser — a five-field parser given a six-field expression
 *    does not fail, it answers wrongly, which is the whole reason the grammar
 *    is stated on every entry.
 * 3. **There is no shell.** Every command is an argv ARRAY. Nothing is
 *    interpolated into a command line, no value reaches a command as syntax,
 *    every identifier is checked before it becomes an argument (a label
 *    starting with `-` is a flag; this repo has already shipped a
 *    `git branch -D` of that kind), and `--` is used where the program takes
 *    it — verified on macOS and on Debian, not assumed.
 * 4. **The destructive tool refuses more than it does.** `CronDelete`
 *    declares `destructive: true`, offers a `dryRun` that runs the same
 *    selection and the same plan and simply does not execute it, refuses a
 *    selector that matches more than one entry unless the caller said
 *    `allowMultiple`, refuses a crontab whose bytes changed between the read
 *    and the write, and returns the removed text verbatim so it can be put
 *    back.
 *
 * The seams are `_setRunner` (every child process), `_setFs` (the two places
 * a file is read or written) and `_setClock` (the reference instant for a
 * next-firing walk). The whole suite drives them: no test asks the real host
 * what it has scheduled, because the answer differs on every machine and CI
 * is not the machine this was written on.
 */
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { type ParsedCrontab, crontabEntries, parseCrontab, planRemoval } from "./lib/crontab";
import { type JobEntry, type JobSource, byEntry, selectEntries } from "./lib/entries";
import { fs, _setClock, _setFs, currentUid, now } from "./lib/host";
import {
  type LaunchdDefinition,
  type PlistFailure,
  launchdEntries,
  parseLaunchctlList,
  parsePlistJson,
} from "./lib/launchd";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  type HostResult,
  _setRunner,
  checkArgument,
  isMissingProgram,
  runHost,
  unreadableReason,
} from "./lib/run";
import { readCronExpression } from "./lib/schedule";
import {
  SHOW_PROPERTIES,
  type ShowBlock,
  parseShowBlocks,
  parseTimerUnitNames,
  systemctlUnavailableReason,
  systemdEntries,
} from "./lib/systemd";
import { isInside, resolveSafe } from "./paths";

export { _setRunner, _setFs, _setClock };
export type { JobEntry, JobSource };

/** Compact JSON — the reader is a model, and every byte is context. */
const json = (value: unknown): string => JSON.stringify(value);

const MAX_TIMEOUT_MS = 120_000;
/** Plists read per directory. A LaunchAgents folder with more is pathological. */
const MAX_PLISTS_PER_DIR = 200;
/** Timer units read per scope, for the same reason. */
const MAX_UNITS = 200;
const DEFAULT_MAX_ENTRIES = 500;

const SOURCES = ["crontab", "launchd", "systemd"] as const;

/**
 * Which schedulers to read when the caller does not say.
 *
 * Asking for a scheduler the host does not have is not an error — the reader
 * reports it unavailable with the reason — so this is a default, not a gate.
 * Windows is empty on purpose: Task Scheduler is a fourth model with its own
 * localised, CSV-quoted output, and a half-built reader for it would be worse
 * than an honest absence.
 */
export function defaultSources(platform: NodeJS.Platform): JobSource[] {
  if (platform === "darwin") return ["crontab", "launchd"];
  if (platform === "win32") return [];
  return ["crontab", "systemd"];
}

type SourceReport = {
  readonly source: JobSource;
  readonly available: boolean;
  readonly reason?: string;
  readonly entries: number;
  readonly directories?: readonly string[];
  readonly skipped?: readonly { readonly path: string; readonly reason: string }[];
  readonly notes?: readonly string[];
};

type SourceRead = {
  readonly report: SourceReport;
  readonly entries: readonly JobEntry[];
};

// ---------------------------------------------------------------------------
// crontab
// ---------------------------------------------------------------------------

type CrontabRead = SourceRead & {
  /** The listing's exact bytes; the delete path compares against them. */
  readonly text?: string;
  readonly parsed?: ParsedCrontab;
};

async function readCrontab(timeoutMs: number): Promise<CrontabRead> {
  const result = await runHost({ argv: ["crontab", "-l"], timeoutMs });
  if (isMissingProgram(result)) {
    return {
      entries: [],
      report: {
        source: "crontab",
        available: false,
        reason: "crontab is not installed on this host",
        entries: 0,
      },
    };
  }
  // A killed, abandoned or TRUNCATED read is not a crontab. The truncation
  // case is the dangerous one: a prefix of a crontab parses perfectly, and
  // `CronDelete` would then rewrite the file from it — installing a schedule
  // with everything past the cap silently deleted and the last surviving line
  // cut in half.
  const unreadable = unreadableReason(result, "crontab -l", timeoutMs);
  if (unreadable !== undefined) {
    return {
      entries: [],
      report: { source: "crontab", available: false, reason: unreadable, entries: 0 },
    };
  }
  if (result.exitCode !== 0) {
    // "no crontab for <user>" is not a failure: it is the answer, and it is
    // reported on stderr with a non-zero status by every implementation
    // checked (macOS 15, Debian 13). Treating it as an error would make a
    // host with nothing scheduled indistinguishable from a broken one.
    if (/no crontab for/i.test(result.stderr)) {
      return {
        text: "",
        parsed: parseCrontab(""),
        entries: [],
        report: {
          source: "crontab",
          available: true,
          entries: 0,
          notes: ["this user has no crontab"],
        },
      };
    }
    return {
      entries: [],
      report: {
        source: "crontab",
        available: false,
        reason: firstLine(result.stderr) || `crontab -l exited ${result.exitCode}`,
        entries: 0,
      },
    };
  }

  const parsed = parseCrontab(result.stdout);
  const entries = crontabEntries(parsed);
  const notes: string[] = [];
  const unparsed = parsed.lines.filter((line) => line.kind === "unparsed");
  if (unparsed.length > 0) {
    notes.push(
      `${unparsed.length} line(s) could not be read as a job and are reported in unparsedLines; they are preserved untouched by any delete`,
    );
  }
  if (parsed.mixedLineEndings) {
    notes.push(
      "this crontab mixes LF and CRLF line endings; each line keeps its own on a rewrite, because re-terminating a line appends a carriage return to a command that did not have one",
    );
  }
  if (parsed.missingTrailingNewline) {
    notes.push(
      "the listing has no final newline; a rewrite adds exactly one, because crond refuses a file without it",
    );
  }
  if (parsed.bannerLines > 0) {
    notes.push(
      "this listing starts with a crond-generated 'DO NOT EDIT THIS FILE' banner; a rewrite drops it so the next install does not stack a second copy",
    );
  }
  notes.push(
    "this is the user crontab, where fields 1-5 are the schedule; /etc/crontab and /etc/cron.d have a sixth user field and are not read by this tool",
  );
  return {
    text: result.stdout,
    parsed,
    entries,
    report: { source: "crontab", available: true, entries: entries.length, notes },
  };
}

// ---------------------------------------------------------------------------
// launchd
// ---------------------------------------------------------------------------

type AgentRoot = { readonly path: string; readonly scope: "user" | "system" };

/**
 * Where launchd definitions a caller can manage actually live.
 *
 * Derived from the home directory, never from input: a tool that accepted a
 * directory would be a tool that could be pointed at `/etc`. `/System/...`
 * is deliberately absent — those are Apple's, they are protected by SIP, and
 * listing two hundred of them would bury the five that belong to the user.
 */
function agentRoots(homedir: string, systemScope: boolean): AgentRoot[] {
  const roots: AgentRoot[] = [{ path: `${homedir}/Library/LaunchAgents`, scope: "user" }];
  if (systemScope) {
    roots.push({ path: "/Library/LaunchAgents", scope: "system" });
    roots.push({ path: "/Library/LaunchDaemons", scope: "system" });
  }
  return roots;
}

async function readLaunchd(options: {
  readonly systemScope: boolean;
  readonly timeoutMs: number;
}): Promise<SourceRead> {
  const listed = await runHost({ argv: ["launchctl", "list"], timeoutMs: options.timeoutMs });
  if (isMissingProgram(listed)) {
    return {
      entries: [],
      report: {
        source: "launchd",
        available: false,
        reason: "launchctl is not on this host, so this is not a launchd machine",
        entries: 0,
      },
    };
  }
  // "Did launchctl answer?" is a separate question from "what did it say",
  // and the join below needs the first one: no rows because nothing is loaded
  // and no rows because the command failed are opposite facts about the host.
  const listFailure =
    unreadableReason(listed, "launchctl list", options.timeoutMs) ??
    (listed.exitCode === 0
      ? undefined
      : `launchctl list exited ${listed.exitCode} (${firstLine(listed.stderr) || "no message"})`);
  const statusKnown = listFailure === undefined;
  const rows = statusKnown ? parseLaunchctlList(listed.stdout) : [];
  const notes: string[] = [];
  if (!statusKnown) {
    notes.push(
      `${listFailure}, so loaded/running state could not be read for any agent; the definitions below are still what is on disk`,
    );
  }

  const roots = agentRoots(fs().homedir(), options.systemScope);
  const definitions: LaunchdDefinition[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const scanned: string[] = [];
  let unreadableDirs = 0;
  for (const root of roots) {
    const listing = fs().readdir(root.path);
    if (listing.kind === "missing") continue;
    if (listing.kind === "error") {
      // NOT a silent skip. A LaunchAgents directory that cannot be listed
      // looks exactly like one that is not there, and reporting the second
      // when the first happened tells a caller "you have no agents" on the
      // strength of a permission error.
      unreadableDirs += 1;
      skipped.push({
        path: root.path,
        reason: `the directory could not be listed (${listing.reason}), so any definitions in it are NOT in this listing`,
      });
      continue;
    }
    const names = listing.names;
    scanned.push(root.path);
    // Sorted: readdir order is the filesystem's, and a listing whose order
    // changes between calls cannot be diffed.
    const plists = names.filter((name) => name.endsWith(".plist")).sort();
    const capped = plists.slice(0, MAX_PLISTS_PER_DIR);
    if (plists.length > capped.length) {
      notes.push(
        `${root.path} holds ${plists.length} plists; only the first ${capped.length} were read`,
      );
    }
    for (const name of capped) {
      const path = `${root.path}/${name}`;
      // `plutil` is macOS's own reader and handles the XML and binary forms
      // alike. `--` keeps a file called `-something` from being read as a
      // flag, and it is accepted by the plutil that ships with macOS.
      const converted = await runHost({
        argv: ["plutil", "-convert", "json", "-o", "-", "--", path],
        timeoutMs: options.timeoutMs,
      });
      if (isMissingProgram(converted)) {
        return {
          entries: [],
          report: {
            source: "launchd",
            available: false,
            reason: "plutil is not on this host, so plists cannot be read",
            entries: 0,
          },
        };
      }
      const plistUnreadable = unreadableReason(converted, "plutil", options.timeoutMs);
      if (plistUnreadable !== undefined || converted.exitCode !== 0) {
        skipped.push({
          path,
          reason:
            plistUnreadable ??
            (firstLine(converted.stderr) || `plutil exited ${converted.exitCode}`),
        });
        continue;
      }
      const parsed = parsePlistJson(path, root.scope, converted.stdout);
      if (isPlistFailure(parsed)) skipped.push(parsed);
      else definitions.push(parsed);
    }
  }

  // A definition can be loaded under a label whose plist lives somewhere this
  // tool does not scan (Apple's own, mostly). Those are counted, not listed:
  // the caller cannot act on them, and two hundred rows of them would bury
  // the ones they can.
  const known = new Set(definitions.map((def) => def.label));
  const unscanned = rows.filter((row) => !known.has(row.label)).length;
  if (unscanned > 0) {
    notes.push(
      `${unscanned} other label(s) are loaded whose definitions live outside the scanned directories (Apple's own agents, mostly); they are not listed because they are not manageable from here`,
    );
  }

  const entries = launchdEntries(definitions, rows, statusKnown);
  // Nothing could be listed and something refused to be: this is not an empty
  // machine, it is an unread one, and `CronDelete` must refuse rather than
  // report "no such entry".
  if (scanned.length === 0 && unreadableDirs > 0) {
    return {
      entries: [],
      report: {
        source: "launchd",
        available: false,
        reason: `none of the launchd agent directories could be listed (${skipped.map((skip) => `${skip.path}: ${skip.reason}`).join("; ")})`,
        entries: 0,
        skipped,
      },
    };
  }
  return {
    entries,
    report: {
      source: "launchd",
      available: true,
      entries: entries.length,
      directories: scanned,
      ...(skipped.length > 0 ? { skipped } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    },
  };
}

function isPlistFailure(value: LaunchdDefinition | PlistFailure): value is PlistFailure {
  return (value as PlistFailure).reason !== undefined;
}

// ---------------------------------------------------------------------------
// systemd
// ---------------------------------------------------------------------------

function systemctlArgv(scope: "user" | "system", rest: readonly string[]): string[] {
  return scope === "user" ? ["systemctl", "--user", ...rest] : ["systemctl", ...rest];
}

async function readSystemdScope(scope: "user" | "system", timeoutMs: number): Promise<SourceRead> {
  const listed = await runHost({
    argv: systemctlArgv(scope, [
      "list-units",
      "--type=timer",
      "--all",
      "--no-legend",
      "--no-pager",
      "--plain",
    ]),
    timeoutMs,
  });
  if (isMissingProgram(listed)) {
    return {
      entries: [],
      report: {
        source: "systemd",
        available: false,
        reason: "systemctl is not on this host",
        entries: 0,
      },
    };
  }
  // The deadline first: a killed `systemctl` exits non-zero with nothing on
  // stderr, and "systemctl exited 143" reads like a broken systemd rather
  // than a slow one (house rule: name the timeout).
  const unavailable =
    unreadableReason(
      listed,
      `systemctl ${scope === "user" ? "--user " : ""}list-units`,
      timeoutMs,
    ) ?? systemctlUnavailableReason(listed.stderr, listed.exitCode);
  if (unavailable !== undefined) {
    return {
      entries: [],
      report: { source: "systemd", available: false, reason: unavailable, entries: 0 },
    };
  }

  const names = parseTimerUnitNames(listed.stdout);
  const notes: string[] = [];
  const capped = names.slice(0, MAX_UNITS);
  if (names.length > capped.length) {
    notes.push(`${names.length} timers present; only the first ${capped.length} were read`);
  }
  if (capped.length === 0) {
    return {
      entries: [],
      report: {
        source: "systemd",
        available: true,
        entries: 0,
        notes: [`no timer units in the ${scope} scope`],
      },
    };
  }

  // One `show` for every unit at once. Each name is checked first: they come
  // from systemd's own listing, but a name that began with `-` would be read
  // as a flag, and `--` is what stops that for the rest.
  const rejected: { path: string; reason: string }[] = [];
  const safe = capped.filter((name) => {
    const problem = checkArgument("a unit name", name);
    if (problem !== undefined) rejected.push({ path: name, reason: problem });
    return problem === undefined;
  });
  if (safe.length === 0) {
    return {
      entries: [],
      report: {
        source: "systemd",
        available: true,
        entries: 0,
        ...(rejected.length > 0 ? { skipped: rejected } : {}),
      },
    };
  }
  const shown = await runHost({
    argv: systemctlArgv(scope, [
      "show",
      "--no-pager",
      `--property=${SHOW_PROPERTIES.join(",")}`,
      "--",
      ...safe,
    ]),
    timeoutMs,
  });
  const showUnreadable = unreadableReason(shown, "systemctl show", timeoutMs);
  if (showUnreadable !== undefined || shown.exitCode !== 0) {
    return {
      entries: [],
      report: {
        source: "systemd",
        available: false,
        reason:
          showUnreadable ?? (firstLine(shown.stderr) || `systemctl show exited ${shown.exitCode}`),
        entries: 0,
      },
    };
  }
  const blocks: ShowBlock[] = parseShowBlocks(shown.stdout);
  const entries = systemdEntries(blocks, scope);
  return {
    entries,
    report: {
      source: "systemd",
      available: true,
      entries: entries.length,
      ...(rejected.length > 0 ? { skipped: rejected } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    },
  };
}

async function readSystemd(options: {
  readonly systemScope: boolean;
  readonly timeoutMs: number;
}): Promise<SourceRead> {
  const user = await readSystemdScope("user", options.timeoutMs);
  if (!options.systemScope) return user;
  const system = await readSystemdScope("system", options.timeoutMs);
  const notes = [...(user.report.notes ?? []), ...(system.report.notes ?? [])];
  // Each scope can fail for its own reason — a user bus that is not running
  // is a different problem from a machine with no systemd — so a failure in
  // one is a NOTE when the other worked, and only the total failure of both
  // makes the source unavailable. Reporting one scope's reason next to
  // `available: true` would read as if the whole source had failed.
  if (!system.report.available && system.report.reason !== undefined) {
    notes.push(`system scope: ${system.report.reason}`);
  }
  if (!user.report.available && user.report.reason !== undefined) {
    notes.push(`user scope: ${user.report.reason}`);
  }
  const available = user.report.available || system.report.available;
  return {
    entries: [...user.entries, ...system.entries],
    report: {
      source: "systemd",
      available,
      ...(available ? {} : { reason: user.report.reason }),
      entries: user.entries.length + system.entries.length,
      ...(notes.length > 0 ? { notes } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// reading a source
// ---------------------------------------------------------------------------

async function readSource(
  source: JobSource,
  options: { readonly systemScope: boolean; readonly timeoutMs: number },
): Promise<CrontabRead> {
  if (source === "crontab") return readCrontab(options.timeoutMs);
  if (source === "launchd") return readLaunchd(options);
  return readSystemd(options);
}

// ---------------------------------------------------------------------------
// schedule annotation
// ---------------------------------------------------------------------------

/**
 * Fill in the description and the next firings for the entries whose grammar
 * really is cron. Everything else keeps the description its own scheduler
 * gave it — systemd's reported next elapse is better than anything computable
 * here, and a launchd calendar is not a cron expression at all.
 */
async function annotate(
  entries: readonly JobEntry[],
  options: { readonly timeZone: string; readonly after: string; readonly nextRuns: number },
): Promise<JobEntry[]> {
  const out: JobEntry[] = [];
  for (const entry of entries) {
    const grammar = entry.schedule.grammar;
    if (
      (grammar !== "cron5" && grammar !== "cron-macro") ||
      entry.schedule.expression === undefined
    ) {
      out.push(entry);
      continue;
    }
    const reading = await readCronExpression(entry.schedule.expression, {
      timeZone: options.timeZone,
      after: options.after,
      count: options.nextRuns,
    });
    const notes = [...(entry.notes ?? [])];
    if (reading.warning !== undefined) notes.push(reading.warning);
    if (reading.skippedForDst !== undefined) {
      notes.push(
        `these wall clocks do not exist on a spring-forward day, so the job does not run then: ${reading.skippedForDst.join(", ")}`,
      );
    }
    const firstFiring = reading.firings?.[0];
    out.push({
      ...entry,
      schedule: {
        ...entry.schedule,
        ...(reading.description !== undefined ? { description: reading.description } : {}),
        ...(reading.error !== undefined ? { error: reading.error } : {}),
      },
      ...(firstFiring !== undefined
        ? { nextRun: { at: firstFiring, source: "computed" as const } }
        : {}),
      ...(reading.firings !== undefined && reading.firings.length > 1
        ? { nextRuns: reading.firings }
        : {}),
      ...(notes.length > 0 ? { notes } : {}),
    });
  }
  return out;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/)[0]?.trim() ?? "";
}

function zoneError(zone: string): string | undefined {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return undefined;
  } catch {
    return `${JSON.stringify(zone)} is not an IANA timezone this runtime knows`;
  }
}

// ---------------------------------------------------------------------------
// CronList
// ---------------------------------------------------------------------------

const sourcesField = z
  .array(z.enum(SOURCES))
  .min(1)
  .max(3)
  .optional()
  .describe(
    "which schedulers to read; defaults to the ones this platform has (crontab + launchd on macOS, crontab + systemd elsewhere)",
  );

const timeoutField = z
  .number()
  .int()
  .min(100)
  .max(MAX_TIMEOUT_MS)
  .optional()
  .describe(`milliseconds allowed per command (default ${DEFAULT_COMMAND_TIMEOUT_MS})`);

export const cronList: RegisteredTool = buildTool({
  name: "CronList",
  description:
    "List what this host has scheduled: the user's crontab, launchd agents on macOS, systemd timers on Linux. Every entry says which scheduler it came from, keeps that scheduler's own identifier (line number, label, unit name) and states which schedule grammar it is written in, so a caller can tell a five-field cron expression from a launchd calendar dictionary or a systemd OnCalendar string. Next firings are computed only for real cron expressions, and systemd's own reported next elapse is passed through rather than recomputed.",
  inputSchema: z.object({
    sources: sourcesField,
    systemScope: z
      .boolean()
      .optional()
      .describe(
        "also read machine-wide definitions (/Library/LaunchAgents and LaunchDaemons, systemd's system scope) — these usually need root to change",
      ),
    nextRuns: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe("firings to compute per cron entry; 0 skips the walk entirely (default 1)"),
    timeZone: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "IANA zone the cron schedules are read in; defaults to UTC. cron actually fires on the host's local wall clock, so pass that zone to get the times the host will use",
      ),
    now: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("reference instant for the next-firing walk; defaults to the current time"),
    maxEntries: z.number().int().min(1).max(5_000).optional(),
    timeoutMs: timeoutField,
  }),
  readOnly: true,
  concurrencySafe: true,
  // Reading a scheduler means spawning `crontab`, `launchctl` or `systemctl`.
  scope: "external",
  ioCapability: "process",
  execute: async (input) => {
    const timeZone = input.timeZone ?? "UTC";
    const badZone = zoneError(timeZone);
    if (badZone !== undefined) return `[CronList error] ${badZone}`;
    const nowMs = input.now === undefined ? now() : Date.parse(input.now);
    if (!Number.isFinite(nowMs)) {
      return `[CronList error] could not read 'now': ${JSON.stringify(input.now)} is not a date this tool can parse`;
    }
    const after = new Date(nowMs).toISOString();
    const timeoutMs = input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const requested = input.sources ?? defaultSources(process.platform);
    const nextRuns = input.nextRuns ?? 1;
    const maxEntries = input.maxEntries ?? DEFAULT_MAX_ENTRIES;

    const reports: SourceReport[] = [];
    let collected: JobEntry[] = [];
    const notes: string[] = [];
    if (requested.length === 0) {
      notes.push(
        `no scheduler reader exists for platform ${process.platform} — Windows Task Scheduler is not read by this package`,
      );
    }
    const unparsedLines: { source: "crontab"; line: number; text: string; reason: string }[] = [];
    for (const source of [...new Set(requested)].sort()) {
      const read = await readSource(source, { systemScope: input.systemScope === true, timeoutMs });
      reports.push(read.report);
      collected = [...collected, ...read.entries];
      for (const line of read.parsed?.lines ?? []) {
        if (line.kind === "unparsed") {
          unparsedLines.push({
            source: "crontab",
            line: line.line,
            text: line.text,
            reason: line.reason,
          });
        }
      }
    }

    const sorted = [...collected].sort(byEntry);
    const capped = sorted.slice(0, maxEntries);
    if (sorted.length > capped.length) {
      notes.push(`${sorted.length} entries found; ${capped.length} returned (raise maxEntries)`);
    }
    const entries = await annotate(capped, { timeZone, after, nextRuns });

    return json({
      ok: true,
      platform: process.platform,
      now: after,
      timeZone,
      timeZoneNote:
        "cron fires on the host's local wall clock; the times here are computed in the zone above and returned in UTC",
      sources: reports,
      count: entries.length,
      entries,
      ...(unparsedLines.length > 0 ? { unparsedLines } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    });
  },
});

// ---------------------------------------------------------------------------
// CronDelete
// ---------------------------------------------------------------------------

type PlannedCommand = {
  readonly argv: readonly string[];
  readonly purpose: string;
  /** Exit codes that mean "already in the desired state", not failure. */
  readonly tolerate?: readonly number[];
};

type PlannedUnlink = { readonly path: string; readonly purpose: string };

type Plan = {
  readonly entries: readonly JobEntry[];
  readonly commands: readonly PlannedCommand[];
  readonly unlinks: readonly PlannedUnlink[];
  readonly warnings: readonly string[];
  readonly crontab?: {
    readonly before: string;
    readonly nextText: string;
    readonly removed: readonly { readonly line: number; readonly text: string }[];
    readonly orphanComments: readonly { readonly line: number; readonly text: string }[];
    readonly bannerDropped: number;
  };
};

/**
 * One plan, built once, used twice.
 *
 * `dryRun` reports this object and stops; a real delete reports this object
 * and then executes it. There is no second preview path that could drift from
 * what the tool actually does — which is the only way a dry run is worth
 * anything on a destructive tool.
 */
function planDeletion(
  source: JobSource,
  chosen: readonly JobEntry[],
  context: {
    readonly crontabText?: string;
    readonly parsed?: ParsedCrontab;
    readonly removeDefinition: boolean;
    readonly uid?: number;
    readonly homedir: string;
  },
): Plan | { readonly error: string } {
  const warnings: string[] = [];
  if (source === "crontab") {
    if (context.parsed === undefined || context.crontabText === undefined) {
      return { error: "the crontab could not be read, so nothing can be removed from it" };
    }
    const lines = chosen.map((entry) => entry.line).filter((n): n is number => n !== undefined);
    const removal = planRemoval(context.parsed, lines);
    if (removal.orphanComments.length > 0) {
      warnings.push(
        `${removal.orphanComments.length} comment line(s) sat directly above a removed job and are KEPT — delete them yourself if they were labels`,
      );
    }
    if (removal.bannerDropped > 0) {
      warnings.push(
        `${removal.bannerDropped} crond-generated banner line(s) will not be written back, so the next install does not stack a second copy`,
      );
    }
    return {
      entries: chosen,
      commands: [],
      unlinks: [],
      warnings,
      crontab: {
        before: context.crontabText,
        nextText: removal.nextText,
        removed: removal.removed,
        orphanComments: removal.orphanComments,
        bannerDropped: removal.bannerDropped,
      },
    };
  }

  if (source === "launchd") {
    if (context.uid === undefined) {
      return { error: "this platform has no uid, so a launchd domain target cannot be built" };
    }
    const commands: PlannedCommand[] = [];
    const unlinks: PlannedUnlink[] = [];
    for (const entry of chosen) {
      const problem = checkArgument("a launchd label", entry.id);
      if (problem !== undefined) return { error: `refusing to act on this entry: ${problem}` };
      if (entry.id.includes("/")) {
        // `gui/501/label` is a PATH into launchd's domain tree; a label with a
        // slash in it would address a different domain than the one listed.
        return { error: `refusing a launchd label containing "/": ${JSON.stringify(entry.id)}` };
      }
      if (entry.scope === "system") {
        return {
          error: `${entry.id} is a machine-wide launchd job (${entry.definitionPath ?? "unknown path"}); removing it needs root, which this tool will not ask for`,
        };
      }
      commands.push({
        argv: ["launchctl", "bootout", `gui/${context.uid}/${entry.id}`],
        purpose: `unload ${entry.id}`,
        // 3 is launchd's "No such process": the job is not loaded, which is
        // the state this command was trying to reach.
        tolerate: [3],
      });
      if (context.removeDefinition) {
        if (entry.definitionPath === undefined) {
          return {
            error: `${entry.id} has no known plist path, so its definition cannot be removed`,
          };
        }
        unlinks.push({
          path: entry.definitionPath,
          purpose: `remove the definition of ${entry.id}`,
        });
      } else {
        warnings.push(
          `${entry.id} is only unloaded: its plist stays at ${entry.definitionPath ?? "its directory"} and launchd loads it again at next login — pass removeDefinition to delete the file`,
        );
      }
    }
    return { entries: chosen, commands, unlinks, warnings };
  }

  const commands: PlannedCommand[] = [];
  const unlinks: PlannedUnlink[] = [];
  for (const entry of chosen) {
    const problem = checkArgument("a unit name", entry.id);
    if (problem !== undefined) return { error: `refusing to act on this entry: ${problem}` };
    if (entry.scope === "system") {
      return {
        error: `${entry.id} is a system-scope timer; disabling it needs root, which this tool will not ask for`,
      };
    }
    commands.push({
      argv: ["systemctl", "--user", "disable", "--now", "--", entry.id],
      purpose: `stop ${entry.id} and remove its enablement symlink`,
    });
    if (context.removeDefinition) {
      const path = entry.definitionPath;
      const unitRoot = `${context.homedir}/.config/systemd/user`;
      if (path === undefined) {
        return { error: `${entry.id} has no FragmentPath, so its unit file cannot be removed` };
      }
      if (!isInside(unitRoot, path)) {
        return {
          error: `${entry.id} is defined at ${path}, which is outside ${unitRoot}; a package-owned unit file is not this tool's to delete`,
        };
      }
      unlinks.push({ path, purpose: `remove the unit file for ${entry.id}` });
    } else {
      warnings.push(
        `${entry.id} is disabled and stopped, but its unit file stays at ${entry.definitionPath ?? "its directory"} — pass removeDefinition to delete it`,
      );
    }
  }
  if (context.removeDefinition && unlinks.length > 0) {
    commands.push({
      argv: ["systemctl", "--user", "daemon-reload"],
      purpose: "make systemd forget the removed unit files",
    });
  }
  return { entries: chosen, commands, unlinks, warnings };
}

/** A compact echo of an entry — enough to recognise it, not a second listing. */
function echoEntry(entry: JobEntry): Record<string, unknown> {
  return {
    source: entry.source,
    id: entry.id,
    fingerprint: entry.fingerprint,
    grammar: entry.schedule.grammar,
    ...(entry.schedule.expression !== undefined ? { expression: entry.schedule.expression } : {}),
    ...(entry.command !== undefined ? { command: entry.command } : {}),
    ...(entry.definitionPath !== undefined ? { definitionPath: entry.definitionPath } : {}),
  };
}

async function installCrontab(
  nextText: string,
  before: string,
  timeoutMs: number,
): Promise<
  | {
      readonly ok: true;
      readonly commands: readonly string[][];
      readonly verified: boolean;
      readonly verification: "matched" | "mismatch" | "unreadable";
      readonly note?: string;
    }
  | { readonly ok: false; readonly reason: string; readonly detail?: string }
> {
  // THE RACE. Between the listing this plan was built from and this write,
  // the user may have run `crontab -e`. Re-reading and comparing is what
  // turns "silently overwrote their edit" into a refusal. It is not a lock —
  // nothing portable is — so the window is narrowed to the few milliseconds
  // between this read and the install, and the result says so.
  const fresh = await runHost({ argv: ["crontab", "-l"], timeoutMs });
  const freshUnreadable = unreadableReason(fresh, "crontab -l", timeoutMs);
  const freshText =
    freshUnreadable !== undefined
      ? undefined
      : fresh.exitCode === 0
        ? fresh.stdout
        : /no crontab for/i.test(fresh.stderr)
          ? ""
          : undefined;
  if (freshText === undefined) {
    return {
      ok: false,
      reason: "re-reading the crontab before the write failed, so nothing was written",
      // Why it failed, not just that it did: a deadline and a permission
      // error send a caller to different places.
      detail: freshUnreadable ?? firstLine(fresh.stderr) ?? `crontab -l exited ${fresh.exitCode}`,
    };
  }
  if (freshText !== before) {
    return {
      ok: false,
      reason:
        "the crontab changed between being listed and being rewritten — somebody else is editing it, so nothing was written",
    };
  }

  const dir = fs().mkdtemp("crewhaus-cron-");
  try {
    const staging = `${dir}/crontab.partial`;
    const final = `${dir}/crontab`;
    // Write, then rename. `crontab(1)` opens the path it is given; if it
    // opened the file while it was still being written it would install a
    // truncated schedule. A rename inside one private directory is atomic, so
    // the name handed to crontab either does not exist or is complete. 0600
    // in a 0700 mkdtemp directory keeps another user from swapping it in the
    // window between the rename and the read.
    fs().writeFile(staging, nextText, 0o600);
    fs().rename(staging, final);
    // `--` is accepted by the crontab on macOS and on Debian (both checked);
    // the path is one this tool generated and is absolute either way.
    const installed = await runHost({ argv: ["crontab", "--", final], timeoutMs });
    const installFailed = unreadableReason(installed, "crontab <file>", timeoutMs);
    if (installFailed !== undefined) {
      // A killed install is the one case where this tool cannot say whether
      // the schedule changed: crontab(1) may have finished its write before
      // the signal landed. Saying "unchanged" here would be a guess.
      return {
        ok: false,
        reason: `the install could not be completed: ${installFailed}`,
        detail: "the crontab may or may not have been replaced — read it back before trying again",
      };
    }
    if (installed.exitCode !== 0) {
      return {
        ok: false,
        reason: `crontab refused the new file (exit ${installed.exitCode}), so the schedule is unchanged`,
        detail: firstLine(installed.stderr),
      };
    }
    // Verify by reading it back. A crond that rewrites what it was given —
    // adding a banner, say — still has to agree about the JOBS.
    const after = await runHost({ argv: ["crontab", "-l"], timeoutMs });
    const afterUnreadable = unreadableReason(after, "crontab -l", timeoutMs);
    const afterText =
      afterUnreadable !== undefined
        ? undefined
        : after.exitCode === 0
          ? after.stdout
          : /no crontab for/i.test(after.stderr)
            ? ""
            : undefined;
    // Three outcomes, not two. "The read-back disagreed" and "the read-back
    // could not be done" are different things to tell a caller, and reporting
    // the second as the first is a definite claim about a comparison that
    // never happened.
    const verification: "matched" | "mismatch" | "unreadable" =
      afterText === undefined
        ? "unreadable"
        : sameJobs(parseCrontab(afterText), parseCrontab(nextText))
          ? "matched"
          : "mismatch";
    return {
      ok: true,
      commands: [["crontab", "--", final]],
      verified: verification === "matched",
      verification,
      ...(verification === "mismatch"
        ? {
            note: "the crontab was installed but reading it back did not produce the same set of jobs — check it by hand",
          }
        : {}),
      ...(verification === "unreadable"
        ? {
            note: `the crontab was installed, but reading it back to check was not possible (${afterUnreadable ?? firstLine(after.stderr) ?? `crontab -l exited ${after.exitCode}`}), so the install is UNVERIFIED rather than known-wrong`,
          }
        : {}),
    };
  } finally {
    // The temp file holds a copy of the user's schedule; it does not outlive
    // the call even when the install failed.
    fs().removeDir(dir);
  }
}

function sameJobs(a: ParsedCrontab, b: ParsedCrontab): boolean {
  const jobs = (parsed: ParsedCrontab): string[] =>
    parsed.lines
      .filter((line) => line.kind === "job")
      .map((line) => line.text.trim())
      .sort();
  const left = jobs(a);
  const right = jobs(b);
  return left.length === right.length && left.every((text, index) => text === right[index]);
}

export const cronDelete: RegisteredTool = buildTool({
  name: "CronDelete",
  description:
    "Remove one scheduled job from this host's scheduler: a line from the user's crontab, a launchd agent, or a systemd user timer. DESTRUCTIVE — run it with dryRun first, which reports the exact entries, commands and removed text through the same code path the real delete uses. It refuses when the selector matches more than one entry (unless allowMultiple is set), when the entry changed since it was listed, and when the crontab was edited between being read and being rewritten. The removed text comes back verbatim so it can be reinstalled.",
  inputSchema: z.object({
    source: z
      .enum(SOURCES)
      .describe("which scheduler the entry lives in — this tool never guesses across schedulers"),
    id: z
      .string()
      .min(1)
      .max(400)
      .optional()
      .describe(
        "the entry's own identifier as CronList returned it: 'line:12' for a crontab line, the label for launchd, the unit name for systemd",
      ),
    match: z
      .string()
      .min(1)
      .max(400)
      .optional()
      .describe(
        "case-insensitive substring of the id, the command or the schedule; refuses when it matches more than one entry",
      ),
    fingerprint: z
      .string()
      .min(4)
      .max(64)
      .optional()
      .describe(
        "the fingerprint CronList returned for this entry; when given, the delete refuses if the entry has changed since",
      ),
    allowMultiple: z
      .boolean()
      .optional()
      .describe("required to delete more than one entry with a single selector"),
    removeDefinition: z
      .boolean()
      .optional()
      .describe(
        "for launchd and systemd: also delete the plist or unit file, not just unload/disable the job. Without it the job comes back at next login or boot",
      ),
    dryRun: z
      .boolean()
      .optional()
      .describe("report exactly what would be removed and run, and change nothing"),
    timeoutMs: timeoutField,
  }),
  destructive: true,
  concurrencySafe: false,
  scope: "external",
  ioCapability: "process",
  requireJustification: true,
  execute: async (input) => {
    const timeoutMs = input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    // Only the user's own definitions are selectable. Reading the system
    // scope here as well would make `backup.timer` ambiguous between the two
    // scopes for a name that exists in both — and an ambiguous destructive
    // selector is exactly what this tool refuses. The system scope is read
    // only when nothing matched, to answer "it exists, but not for you"
    // instead of "no such entry", which sends a caller hunting for a typo.
    const read = await readSource(input.source, { systemScope: false, timeoutMs });
    if (!read.report.available) {
      return json({
        ok: false,
        deleted: false,
        error: `the ${input.source} scheduler is not readable here: ${read.report.reason ?? "unknown reason"}`,
      });
    }

    const selection = selectEntries(
      read.entries,
      {
        ...(input.id !== undefined ? { id: input.id } : {}),
        ...(input.match !== undefined ? { match: input.match } : {}),
        ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
      },
      input.allowMultiple === true,
    );
    if (!selection.ok) {
      if (selection.reason === "not-found" && input.source !== "crontab") {
        const wide = await readSource(input.source, { systemScope: true, timeoutMs });
        const elsewhere = selectEntries(
          wide.entries.filter((entry) => entry.scope === "system"),
          {
            ...(input.id !== undefined ? { id: input.id } : {}),
            ...(input.match !== undefined ? { match: input.match } : {}),
          },
          true,
        );
        if (elsewhere.ok) {
          return json({
            ok: false,
            deleted: false,
            reason: "system-scope",
            error: `${elsewhere.entries.map((entry) => entry.id).join(", ")} is a machine-wide ${input.source} definition; removing it needs root, which this tool will not ask for`,
            candidates: elsewhere.entries.map(echoEntry),
          });
        }
      }
      return json({
        ok: false,
        deleted: false,
        reason: selection.reason,
        error: selection.message,
        ...(selection.candidates !== undefined
          ? { candidates: selection.candidates.map(echoEntry) }
          : {}),
      });
    }

    const plan = planDeletion(input.source, selection.entries, {
      ...(read.text !== undefined ? { crontabText: read.text } : {}),
      ...(read.parsed !== undefined ? { parsed: read.parsed } : {}),
      removeDefinition: input.removeDefinition === true,
      ...(currentUid() !== undefined ? { uid: currentUid() as number } : {}),
      homedir: fs().homedir(),
    });
    if ("error" in plan) {
      return json({ ok: false, deleted: false, error: plan.error });
    }

    const wouldRun = plan.commands.map((command) => command.argv);
    const summary = {
      source: input.source,
      selected: plan.entries.map(echoEntry),
      ...(plan.crontab !== undefined
        ? {
            removedLines: plan.crontab.removed,
            keptOrphanComments: plan.crontab.orphanComments,
            resultingBytes: plan.crontab.nextText.length,
          }
        : {}),
      ...(wouldRun.length > 0 ? { commands: wouldRun } : {}),
      ...(plan.unlinks.length > 0 ? { files: plan.unlinks } : {}),
      ...(plan.warnings.length > 0 ? { warnings: plan.warnings } : {}),
    };

    if (input.dryRun === true) {
      return json({
        ok: true,
        dryRun: true,
        deleted: false,
        ...summary,
        note: "nothing was changed; this is the same plan the real call executes",
      });
    }

    const ran: { argv: readonly string[]; exitCode: number; ok: boolean; stderr?: string }[] = [];
    /**
     * What has already taken effect on the host.
     *
     * A multi-step delete that fails halfway is not a delete that did
     * nothing: the first `launchctl bootout` really did unload that agent.
     * Reporting a bare `deleted: false` there is a definite claim the machine
     * contradicts, and a caller who believes it retries or walks away
     * thinking their job is untouched.
     */
    const completed: string[] = [];
    for (const command of plan.commands) {
      const result = await runHost({ argv: command.argv, timeoutMs });
      const tolerated = command.tolerate?.includes(result.exitCode) === true;
      const ok = result.exitCode === 0 || tolerated;
      ran.push({
        argv: command.argv,
        exitCode: result.exitCode,
        ok,
        ...(result.stderr.trim() === "" ? {} : { stderr: firstLine(result.stderr) }),
      });
      if (!ok) {
        return json({
          ok: false,
          deleted: false,
          ...summary,
          ran,
          ...(completed.length > 0 ? { partial: true, completed } : {}),
          error:
            completed.length === 0
              ? `${command.purpose} failed (exit ${result.exitCode}); nothing was changed`
              : `${command.purpose} failed (exit ${result.exitCode}); nothing further was attempted, but ${completed.length} earlier step(s) HAD already taken effect: ${completed.join("; ")}`,
          ...(describeSpawn(result, timeoutMs) !== undefined
            ? { detail: describeSpawn(result, timeoutMs) }
            : {}),
        });
      }
      completed.push(command.purpose);
    }

    const removedFiles: string[] = [];
    const warnedAboutLinks: string[] = [];
    for (const unlink of plan.unlinks) {
      // Containment, with the resolver copied verbatim from tool-pkg: the
      // path came from a directory this tool scanned, and this proves the
      // thing about to be deleted is still inside that directory — a symlink
      // in LaunchAgents pointing at ~/.ssh is refused here rather than
      // followed.
      const root = containingRoot(unlink.path, input.source === "launchd");
      if (root === undefined) {
        return json({
          ok: false,
          deleted: false,
          ...summary,
          ran,
          error: `${unlink.path} is not inside a directory this tool manages, so it was not deleted`,
        });
      }
      try {
        // Containment first: `resolveSafe` follows the symlinks and refuses a
        // definition that resolves outside the managed directory.
        const safe = resolveSafe("CronDelete", unlink.path, root);
        // Then delete the NAME, not what it points at. `safe.real` is the
        // resolved TARGET, and unlinking that for a plist that is a symlink
        // to a sibling would delete ANOTHER job's definition and leave the
        // selected one's link in place — a file the caller never named, and a
        // `removedFiles` entry that still exists. tool-pkg's resolver says
        // the same thing: `real` is for reading, `abs` is for acting on the
        // link itself. So the CONTAINING DIRECTORY is resolved (that is what
        // closes the check-to-use window) and only the final component stays
        // lexical — and it is resolved from `abs`, because `dirname(real)`
        // for a link into a subdirectory names neither the link nor its
        // target.
        const parent = resolveSafe("CronDelete", dirname(safe.abs), root);
        const victim = join(parent.real, basename(safe.abs));
        fs().unlink(victim);
        removedFiles.push(victim);
        if (victim !== safe.real) {
          warnedAboutLinks.push(
            `${unlink.path} was a symlink: the link was removed and its target (${safe.real}) was left alone`,
          );
        }
      } catch (err) {
        return json({
          ok: false,
          deleted: false,
          ...summary,
          ran,
          // A file already gone is an effect on the host, exactly like a
          // command that already ran: neither may be reported as nothing.
          ...(completed.length > 0 || removedFiles.length > 0
            ? {
                partial: true,
                completed: [...completed, ...removedFiles.map((f) => `removed ${f}`)],
              }
            : {}),
          removedFiles,
          error: `${unlink.purpose} failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    if (plan.crontab !== undefined) {
      const installed = await installCrontab(plan.crontab.nextText, plan.crontab.before, timeoutMs);
      if (!installed.ok) {
        return json({
          ok: false,
          deleted: false,
          ...summary,
          error: installed.reason,
          ...(installed.detail !== undefined ? { detail: installed.detail } : {}),
        });
      }
      return json({
        ok: true,
        dryRun: false,
        deleted: true,
        ...summary,
        // What actually ran, so a transcript shows the install rather than
        // just its outcome.
        ran: installed.commands.map((argv) => ({ argv, exitCode: 0, ok: true })),
        verified: installed.verified,
        verification: installed.verification,
        ...(installed.note !== undefined ? { note: installed.note } : {}),
      });
    }

    return json({
      ok: true,
      dryRun: false,
      deleted: true,
      ...summary,
      ran,
      ...(removedFiles.length > 0 ? { removedFiles } : {}),
      ...(warnedAboutLinks.length > 0 ? { warnings: [...plan.warnings, ...warnedAboutLinks] } : {}),
    });
  },
});

function describeSpawn(result: HostResult, timeoutMs: number): string | undefined {
  // Rule: a failure a timeout could also explain has to name the timeout, so
  // it is reported as itself — with the deadline it missed — rather than as
  // "exit -1".
  return unreadableReason(result, "the command", timeoutMs);
}

/** The managed directory a path must be inside for this tool to delete it. */
function containingRoot(path: string, launchd: boolean): string | undefined {
  const home = fs().homedir();
  const roots = launchd ? [`${home}/Library/LaunchAgents`] : [`${home}/.config/systemd/user`];
  return roots.find((root) => isInside(root, path));
}

/** Every tool this package registers, in the order a catalog should list them. */
export const CRON_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([cronDelete, cronList]);
