/**
 * The two tools, driven the way the runtime drives them — with the host
 * replaced.
 *
 * Every command goes through the injected runner and answers from a recorded
 * fixture; every file operation goes through the injected filesystem; the
 * clock is fixed. Nothing here reads this machine's schedule, and nothing
 * here writes to it: the one test in this package that touches the real host
 * lives in `integration.test.ts`, is read-only, and asserts shape only.
 *
 * The containment tests are the exception that proves the rule — they use a
 * REAL temporary directory, because the resolver they exercise (copied
 * verbatim from `@crewhaus/tool-pkg`) resolves symlinks against the real
 * filesystem, and a fake would have tested nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CRONTAB_EVERY_SHAPE,
  CRONTAB_WITH_BANNER,
  LINUX_CRONTAB_BAD_LINE_STDERR,
  LINUX_CRONTAB_L,
  LINUX_CRONTAB_NONE_STDERR,
  LINUX_DISABLE_MISSING_STDERR,
  LINUX_LIST_UNITS_TIMERS,
  LINUX_SHOW_MULTI_ONCALENDAR,
  LINUX_SHOW_TWO_TIMERS,
  LINUX_SYSTEMCTL_NOT_BOOTED_STDERR,
  MACOS_BOOTOUT_MISSING_STDERR,
  MACOS_CRONTAB_NONE_STDERR,
  MACOS_LAUNCHCTL_LIST,
  MACOS_PLIST_CALENDAR_DICT,
  MACOS_PLIST_INTERVAL,
  MACOS_PLUTIL_ERROR_STDERR,
} from "./__fixtures__/host-output";
import { _setClock, _setFs, _setRunner, cronDelete, cronList, defaultSources } from "./index";
import type { HostCommand, HostResult } from "./lib/run";

// ---------------------------------------------------------------------------
// the fake host
// ---------------------------------------------------------------------------

type Reply = Partial<Omit<HostResult, "argv">>;
type Handler = (argv: readonly string[], stdin: string | undefined) => Reply | undefined;

let calls: string[][] = [];

function installRunner(handler: Handler): void {
  _setRunner(async (cmd: HostCommand) => {
    calls.push([...cmd.argv]);
    const reply = handler(cmd.argv, cmd.stdin) ?? {};
    return {
      argv: cmd.argv,
      exitCode: reply.exitCode ?? 0,
      stdout: reply.stdout ?? "",
      stderr: reply.stderr ?? "",
      timedOut: reply.timedOut ?? false,
      // Forwarded, not dropped: a fixture that says "this stream was cut" has
      // to reach the reader, or the truncation tests test nothing.
      ...(reply.stdoutTruncated === true ? { stdoutTruncated: true } : {}),
      ...(reply.stderrTruncated === true ? { stderrTruncated: true } : {}),
      ...(reply.abandoned === true ? { abandoned: true } : {}),
      ...(reply.spawnError !== undefined ? { spawnError: reply.spawnError } : {}),
    };
  });
}

type FakeFs = {
  readonly written: { path: string; text: string; mode: number }[];
  readonly renamed: { from: string; to: string }[];
  readonly unlinked: string[];
  readonly removedDirs: string[];
};

let fsLog: FakeFs;

function installFs(options: {
  home: string;
  dirs?: Record<string, string[]>;
  /** Directories that exist and cannot be listed — an EACCES, in other words. */
  unreadableDirs?: Record<string, string>;
}): void {
  const log: FakeFs = { written: [], renamed: [], unlinked: [], removedDirs: [] };
  fsLog = log;
  let counter = 0;
  _setFs({
    homedir: () => options.home,
    tmpdir: () => "/tmp",
    readdir: (dir) => {
      const refused = options.unreadableDirs?.[dir];
      if (refused !== undefined) return { kind: "error", reason: refused };
      const names = options.dirs?.[dir];
      return names === undefined ? { kind: "missing" } : { kind: "names", names };
    },
    mkdtemp: (prefix) => `/tmp/${prefix}${++counter}`,
    writeFile: (path, text, mode) => {
      log.written.push({ path, text, mode });
    },
    rename: (from, to) => {
      log.renamed.push({ from, to });
    },
    unlink: (path) => {
      log.unlinked.push(path);
    },
    removeDir: (path) => {
      log.removedDirs.push(path);
    },
  });
}

const FIXED_NOW = Date.parse("2026-09-18T12:00:00Z");

beforeEach(() => {
  calls = [];
  _setClock(() => FIXED_NOW);
  installFs({ home: "/home/alice" });
});

afterEach(() => {
  // A seam left installed leaks into the next file in the same bun process.
  _setRunner(undefined);
  _setFs(undefined);
  _setClock(undefined);
});

/** The shapes the two tools return, so the assertions below read as documentation. */
type Schedule = {
  grammar: string;
  expression?: string;
  description?: string;
  error?: string;
  note?: string;
  calendar?: { hour?: number; minute?: number; weekday?: number }[];
};

type Entry = {
  source: string;
  id: string;
  idKind: string;
  fingerprint: string;
  command?: string;
  scope?: string;
  definitionPath?: string;
  state?: string;
  notes?: string[];
  schedule: Schedule;
  nextRun?: { at: string; source: string };
  nextRuns?: string[];
};

type ListOut = {
  ok: boolean;
  platform: string;
  now: string;
  timeZone: string;
  sources: {
    source: string;
    available: boolean;
    reason?: string;
    entries: number;
    directories?: string[];
    skipped?: { path: string; reason: string }[];
    notes?: string[];
  }[];
  entries: Entry[];
  unparsedLines?: { line: number; source: string; text: string; reason: string }[];
  notes?: string[];
};

type DeleteOut = {
  ok: boolean;
  dryRun?: boolean;
  deleted: boolean;
  reason?: string;
  error?: string;
  detail?: string;
  note?: string;
  verified?: boolean;
  selected?: Entry[];
  candidates?: Entry[];
  removedLines?: { line: number; text: string }[];
  keptOrphanComments?: { line: number; text: string }[];
  commands?: string[][];
  warnings?: string[];
  ran?: { argv: string[]; exitCode: number; ok: boolean; stderr?: string }[];
  removedFiles?: string[];
};

async function list(input: Record<string, unknown>): Promise<ListOut> {
  const result = await cronList.execute(input);
  if (typeof result !== "string") throw new Error("expected text");
  return JSON.parse(result) as ListOut;
}

async function remove(input: Record<string, unknown>): Promise<DeleteOut> {
  const result = await cronDelete.execute(input);
  if (typeof result !== "string") throw new Error("expected text");
  return JSON.parse(result) as DeleteOut;
}

function crontabHost(text: string, options: { onInstall?: Reply; second?: string } = {}): Handler {
  let listCount = 0;
  return (argv) => {
    if (argv[0] !== "crontab") return { exitCode: 127, spawnError: "ENOENT" };
    if (argv[1] === "-l") {
      listCount += 1;
      const body = listCount > 1 && options.second !== undefined ? options.second : text;
      if (body === "") return { exitCode: 1, stderr: LINUX_CRONTAB_NONE_STDERR };
      return { stdout: body };
    }
    return options.onInstall ?? {};
  };
}

// ---------------------------------------------------------------------------
// CronList
// ---------------------------------------------------------------------------

describe("CronList over a crontab", () => {
  test("every entry names its source, its own id and its grammar", async () => {
    installRunner(crontabHost(LINUX_CRONTAB_L));
    const out = await list({ sources: ["crontab"] });
    expect(out["ok"]).toBe(true);
    expect(out["entries"].length).toBe(2);
    expect(out["entries"][0]).toMatchObject({
      source: "crontab",
      id: "line:3",
      idKind: "crontab-line",
    });
    expect(out["entries"][0].schedule.grammar).toBe("cron5");
  });

  test("the schedule is described and walked by tool-datetime, not by this package", async () => {
    installRunner(crontabHost("30 2 * * * /usr/local/bin/backup.sh\n"));
    const out = await list({ sources: ["crontab"], nextRuns: 2, timeZone: "UTC" });
    const entry = out["entries"][0];
    expect(entry.schedule.description).toContain("02:30");
    expect(entry.nextRun).toEqual({ at: "2026-09-19T02:30:00.000Z", source: "computed" });
    expect(entry.nextRuns).toEqual(["2026-09-19T02:30:00.000Z", "2026-09-20T02:30:00.000Z"]);
  });

  test("the stated timezone is the one the walk uses", async () => {
    installRunner(crontabHost("30 2 * * * /usr/local/bin/backup.sh\n"));
    const utc = await list({ sources: ["crontab"], timeZone: "UTC" });
    const tokyo = await list({ sources: ["crontab"], timeZone: "Asia/Tokyo" });
    expect(utc["entries"][0].nextRun.at).toBe("2026-09-19T02:30:00.000Z");
    // 02:30 Tokyo on the 19th is 17:30 UTC on the 18th.
    expect(tokyo["entries"][0].nextRun.at).toBe("2026-09-18T17:30:00.000Z");
  });

  test("nextRuns: 0 still describes the schedule but walks nothing", async () => {
    installRunner(crontabHost("30 2 * * * /bin/true\n"));
    const out = await list({ sources: ["crontab"], nextRuns: 0 });
    expect(out["entries"][0].schedule.description).toBeDefined();
    expect(out["entries"][0].nextRun).toBeUndefined();
  });

  test("an expression the cron parser rejects reports the parser's own words", async () => {
    installRunner(crontabHost("not a crontab line at all\n"));
    const out = await list({ sources: ["crontab"] });
    expect(out["entries"][0].schedule.error).toContain("not a number or a name");
    expect(out["entries"][0].nextRun).toBeUndefined();
  });

  test("@reboot is reported as an event with no firing time", async () => {
    installRunner(crontabHost("@reboot /usr/local/bin/warm.sh\n"));
    const out = await list({ sources: ["crontab"] });
    expect(out["entries"][0].schedule.grammar).toBe("cron-reboot");
    expect(out["entries"][0].nextRun).toBeUndefined();
    expect(out["entries"][0].schedule.note).toContain("no next firing");
  });

  test("a six-field expression carries its warning all the way out", async () => {
    installRunner(crontabHost(CRONTAB_EVERY_SHAPE));
    const out = await list({ sources: ["crontab"] });
    const quartz = out["entries"].find((entry: Entry) => entry.command === "?");
    expect(quartz.notes.some((note: string) => note.includes("six-field"))).toBe(true);
  });

  test("the day-of-month / day-of-week OR rule is surfaced as a warning", async () => {
    installRunner(crontabHost("0 0 1 * MON /bin/true\n"));
    const out = await list({ sources: ["crontab"] });
    expect(out["entries"][0].notes.join(" ")).toContain("EITHER");
  });

  test("lines that are not jobs are returned separately, not silently dropped", async () => {
    installRunner(crontabHost("@daily\n"));
    const out = await list({ sources: ["crontab"] });
    expect(out["entries"].length).toBe(0);
    expect(out["unparsedLines"][0]).toMatchObject({ line: 1, source: "crontab" });
  });

  test("a user with no crontab is an answer, not a failure", async () => {
    installRunner(() => ({ exitCode: 1, stderr: MACOS_CRONTAB_NONE_STDERR }));
    const out = await list({ sources: ["crontab"] });
    expect(out["sources"][0]).toMatchObject({ source: "crontab", available: true, entries: 0 });
  });

  test("a host with no crontab program says exactly that", async () => {
    installRunner(() => ({ exitCode: -1, spawnError: "No such file or directory" }));
    const out = await list({ sources: ["crontab"] });
    expect(out["sources"][0]).toMatchObject({ available: false });
    expect(out["sources"][0].reason).toContain("not installed");
  });

  test("a hung crontab is reported as a DEADLINE, not as a generic failure", async () => {
    // Rule: a failure a timeout could also satisfy has to name the reason.
    installRunner(() => ({ exitCode: -1, timedOut: true }));
    const out = await list({ sources: ["crontab"], timeoutMs: 250 });
    expect(out["sources"][0].reason).toContain("did not finish within 250ms");
  });

  test("the listing is capped and says so", async () => {
    const many = Array.from({ length: 12 }, (_, i) => `${i} 3 * * * /bin/job${i}`).join("\n");
    installRunner(crontabHost(`${many}\n`));
    const out = await list({ sources: ["crontab"], maxEntries: 5, nextRuns: 0 });
    expect(out["entries"].length).toBe(5);
    expect(out["notes"].join(" ")).toContain("raise maxEntries");
  });

  test("two identical calls at the same instant produce identical bytes", async () => {
    installRunner(crontabHost(CRONTAB_EVERY_SHAPE));
    const first = await cronList.execute({ sources: ["crontab"], nextRuns: 3 });
    const second = await cronList.execute({ sources: ["crontab"], nextRuns: 3 });
    expect(first).toBe(second);
  });

  test("a bad timezone and a bad reference instant are refused by name", async () => {
    installRunner(crontabHost(LINUX_CRONTAB_L));
    expect(await cronList.execute({ sources: ["crontab"], timeZone: "Mars/Olympus" })).toContain(
      "not an IANA timezone",
    );
    expect(await cronList.execute({ sources: ["crontab"], now: "half past tuesday" })).toContain(
      "could not read 'now'",
    );
  });

  test("no command is ever a shell string", async () => {
    installRunner(crontabHost(LINUX_CRONTAB_L));
    await list({ sources: ["crontab"] });
    for (const argv of calls) {
      expect(argv.length).toBeGreaterThan(1);
      expect(argv[0]).not.toContain(" ");
      expect(argv).not.toContain("-c");
      expect(["sh", "bash", "zsh", "cmd.exe"]).not.toContain(argv[0] as string);
    }
  });
});

describe("CronList over launchd", () => {
  const plists: Record<string, string> = {
    "/home/alice/Library/LaunchAgents/com.example.gc.invoker-1.0.plist": MACOS_PLIST_CALENDAR_DICT,
    "/home/alice/Library/LaunchAgents/broken.plist": "",
    "/Library/LaunchAgents/updater.plist": MACOS_PLIST_INTERVAL,
  };

  function launchdHost(): Handler {
    return (argv) => {
      if (argv[0] === "launchctl") return { stdout: MACOS_LAUNCHCTL_LIST };
      if (argv[0] === "plutil") {
        const path = argv[argv.length - 1] as string;
        const body = plists[path];
        if (body === undefined || body === "") {
          return { exitCode: 1, stderr: MACOS_PLUTIL_ERROR_STDERR };
        }
        return { stdout: body };
      }
      return { exitCode: 127, spawnError: "ENOENT" };
    };
  }

  beforeEach(() => {
    installFs({
      home: "/home/alice",
      dirs: {
        "/home/alice/Library/LaunchAgents": [
          "broken.plist",
          "com.example.gc.invoker-1.0.plist",
          "notes.txt",
        ],
        "/Library/LaunchAgents": ["updater.plist"],
      },
    });
  });

  test("the id is the LABEL from inside the plist, not the file name", async () => {
    installRunner(launchdHost());
    const out = await list({ sources: ["launchd"] });
    const entry = out["entries"].find((item: Entry) => item.source === "launchd");
    expect(entry.id).toBe("com.example.gc.scheduler");
    expect(entry.definitionPath).toBe(
      "/home/alice/Library/LaunchAgents/com.example.gc.invoker-1.0.plist",
    );
  });

  test("a launchd calendar keeps launchd's grammar and gets no cron walk", async () => {
    installRunner(launchdHost());
    const out = await list({ sources: ["launchd"] });
    const entry = out["entries"][0];
    expect(entry.schedule.grammar).toBe("launchd-calendar");
    expect(entry.schedule.calendar).toEqual([{ hour: 8, minute: 31 }]);
    expect(entry.nextRun).toBeUndefined();
  });

  test("an unreadable plist is reported, with the reason, not skipped silently", async () => {
    installRunner(launchdHost());
    const out = await list({ sources: ["launchd"] });
    const report = out["sources"][0];
    expect(report.skipped[0].path).toBe("/home/alice/Library/LaunchAgents/broken.plist");
    expect(report.skipped[0].reason).toContain("Property List error");
  });

  test("only .plist files are read, and the scanned directories are reported", async () => {
    installRunner(launchdHost());
    const out = await list({ sources: ["launchd"] });
    expect(out["sources"][0].directories).toEqual(["/home/alice/Library/LaunchAgents"]);
    expect(calls.filter((argv) => argv[0] === "plutil").length).toBe(2);
  });

  test("systemScope adds the machine-wide directories", async () => {
    installRunner(launchdHost());
    const out = await list({ sources: ["launchd"], systemScope: true });
    expect(out["sources"][0].directories).toContain("/Library/LaunchAgents");
    const updater = out["entries"].find((item: Entry) => item.id === "com.example.updater");
    expect(updater.scope).toBe("system");
    expect(updater.schedule.grammar).toBe("launchd-interval");
  });

  test("labels loaded from directories this tool does not scan are counted, not listed", async () => {
    installRunner(launchdHost());
    const out = await list({ sources: ["launchd"] });
    expect(out["entries"].every((item: Entry) => item.id !== "com.apple.Finder")).toBe(true);
    expect(out["sources"][0].notes.join(" ")).toContain("outside the scanned directories");
  });

  test("a host with no plutil is unavailable rather than empty", async () => {
    installRunner((argv) =>
      argv[0] === "launchctl"
        ? { stdout: MACOS_LAUNCHCTL_LIST }
        : { exitCode: -1, spawnError: "ENOENT" },
    );
    const out = await list({ sources: ["launchd"] });
    expect(out["sources"][0]).toMatchObject({ available: false });
    expect(out["sources"][0].reason).toContain("plutil");
  });

  test("a host with no launchctl says it is not a launchd machine", async () => {
    installRunner(() => ({ exitCode: -1, spawnError: "ENOENT" }));
    const out = await list({ sources: ["launchd"] });
    expect(out["sources"][0].reason).toContain("not a launchd machine");
  });

  test("plutil is called with -- before the path", async () => {
    installRunner(launchdHost());
    await list({ sources: ["launchd"] });
    const plutil = calls.find((argv) => argv[0] === "plutil") as string[];
    expect(plutil.slice(0, 5)).toEqual(["plutil", "-convert", "json", "-o", "-"]);
    expect(plutil[5]).toBe("--");
  });
});

describe("CronList over systemd", () => {
  function systemdHost(show: string): Handler {
    return (argv) => {
      if (argv[0] !== "systemctl") return { exitCode: 127, spawnError: "ENOENT" };
      if (argv.includes("list-units")) return { stdout: LINUX_LIST_UNITS_TIMERS };
      if (argv.includes("show")) return { stdout: show };
      return {};
    };
  }

  test("the unit name is the id and systemd's own next elapse is passed through", async () => {
    installRunner(systemdHost(LINUX_SHOW_MULTI_ONCALENDAR));
    const out = await list({ sources: ["systemd"] });
    expect(out["entries"][0]).toMatchObject({
      source: "systemd",
      id: "backup.timer",
      idKind: "systemd-unit",
    });
    expect(out["entries"][0].nextRun.source).toBe("reported");
    expect(out["entries"][0].schedule.grammar).toBe("systemd-oncalendar");
  });

  test("an OnCalendar expression is never handed to the cron parser", async () => {
    installRunner(systemdHost(LINUX_SHOW_MULTI_ONCALENDAR));
    const out = await list({ sources: ["systemd"] });
    // A five-field parser would have rejected "*-*-* 02:30:00" and put an
    // error here; the expression is reported as systemd wrote it instead.
    expect(out["entries"][0].schedule.error).toBeUndefined();
    expect(out["entries"][0].schedule.expression).toContain("*-*-* 02:30:00");
  });

  test("the user scope is read with --user and the properties are asked for by name", async () => {
    installRunner(systemdHost(LINUX_SHOW_TWO_TIMERS));
    await list({ sources: ["systemd"] });
    const listUnits = calls.find((argv) => argv.includes("list-units")) as string[];
    expect(listUnits.slice(0, 3)).toEqual(["systemctl", "--user", "list-units"]);
    const show = calls.find((argv) => argv.includes("show")) as string[];
    expect(show.some((arg) => arg.startsWith("--property=Id,"))).toBe(true);
    expect(show).toContain("--");
  });

  test("systemScope reads the system scope too, without --user", async () => {
    installRunner(systemdHost(LINUX_SHOW_TWO_TIMERS));
    const out = await list({ sources: ["systemd"], systemScope: true });
    const scopes = new Set(out["entries"].map((entry: Entry) => entry.scope));
    expect(scopes).toEqual(new Set(["user", "system"]));
    expect(calls.some((argv) => argv[1] === "list-units")).toBe(true);
  });

  test("a machine that is not booted with systemd says so in systemd's words", async () => {
    installRunner(() => ({ exitCode: 1, stderr: LINUX_SYSTEMCTL_NOT_BOOTED_STDERR }));
    const out = await list({ sources: ["systemd"] });
    expect(out["sources"][0]).toMatchObject({ available: false });
    expect(out["sources"][0].reason).toContain("not this machine's init system");
  });

  test("no timers is available-and-empty, not unavailable", async () => {
    installRunner((argv) => (argv.includes("list-units") ? { stdout: "" } : {}));
    const out = await list({ sources: ["systemd"] });
    expect(out["sources"][0]).toMatchObject({ available: true, entries: 0 });
  });
});

describe("CronList platform defaults", () => {
  test("each platform gets the schedulers it actually has", () => {
    expect(defaultSources("darwin")).toEqual(["crontab", "launchd"]);
    expect(defaultSources("linux")).toEqual(["crontab", "systemd"]);
    expect(defaultSources("freebsd")).toEqual(["crontab", "systemd"]);
    expect(defaultSources("win32")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CronDelete
// ---------------------------------------------------------------------------

describe("CronDelete on a crontab", () => {
  test("a dry run reports the exact line and changes nothing", async () => {
    installRunner(crontabHost(CRONTAB_EVERY_SHAPE));
    const out = await remove({ source: "crontab", id: "line:7", dryRun: true });
    expect(out).toMatchObject({ ok: true, dryRun: true, deleted: false });
    expect(out["removedLines"]).toEqual([
      { line: 7, text: "*/15 9-17 * * 1-5 /usr/local/bin/poll.sh" },
    ]);
    expect(fsLog.written).toEqual([]);
    expect(calls.some((argv) => argv[1] === "--")).toBe(false);
  });

  test("the dry run and the real call plan the same removal", async () => {
    installRunner(crontabHost(CRONTAB_EVERY_SHAPE));
    const dry = await remove({ source: "crontab", id: "line:7", dryRun: true });
    calls = [];
    const real = await remove({ source: "crontab", id: "line:7" });
    expect(real["removedLines"]).toEqual(dry["removedLines"]);
    expect(real["selected"]).toEqual(dry["selected"]);
    expect(real["deleted"]).toBe(true);
  });

  test("the rewrite goes through a temp file and a rename, at mode 0600", async () => {
    installRunner(crontabHost(CRONTAB_EVERY_SHAPE));
    await remove({ source: "crontab", id: "line:7" });
    expect(fsLog.written.length).toBe(1);
    expect(fsLog.written[0]?.mode).toBe(0o600);
    expect(fsLog.written[0]?.path.endsWith("crontab.partial")).toBe(true);
    expect(fsLog.renamed[0]?.to.endsWith("/crontab")).toBe(true);
    // crontab reads the renamed name, never the partial one.
    const install = calls.find((argv) => argv[1] === "--") as string[];
    expect(install[2]).toBe(fsLog.renamed[0]?.to);
    expect(fsLog.removedDirs.length).toBe(1);
  });

  test("the text handed to crontab is the original minus one line, newline-terminated", async () => {
    installRunner(crontabHost(CRONTAB_EVERY_SHAPE));
    await remove({ source: "crontab", id: "line:7" });
    const written = fsLog.written[0]?.text as string;
    expect(written).toBe(
      CRONTAB_EVERY_SHAPE.split("\n")
        .filter((line) => !line.includes("poll.sh"))
        .join("\n"),
    );
    expect(written.endsWith("\n")).toBe(true);
    expect(written.endsWith("\n\n")).toBe(false);
  });

  test("a crontab edited between the read and the write is REFUSED", async () => {
    // The race this tool cannot lock away: re-read, compare, refuse.
    installRunner(
      crontabHost(CRONTAB_EVERY_SHAPE, { second: `${CRONTAB_EVERY_SHAPE}0 5 * * * /bin/new\n` }),
    );
    const out = await remove({ source: "crontab", id: "line:7" });
    expect(out).toMatchObject({ ok: false, deleted: false });
    expect(out["error"]).toContain("changed between being listed and being rewritten");
    expect(fsLog.written).toEqual([]);
    expect(calls.some((argv) => argv[1] === "--")).toBe(false);
  });

  test("a crontab that refuses the new file leaves the schedule alone and says why", async () => {
    installRunner(
      crontabHost(CRONTAB_EVERY_SHAPE, {
        onInstall: { exitCode: 1, stderr: LINUX_CRONTAB_BAD_LINE_STDERR },
      }),
    );
    const out = await remove({ source: "crontab", id: "line:7" });
    expect(out).toMatchObject({ ok: false, deleted: false });
    expect(out["error"]).toContain("exit 1");
    expect(out["detail"]).toContain("bad command");
    // The temp directory still goes, failure or not.
    expect(fsLog.removedDirs.length).toBe(1);
  });

  test("the install is verified by reading the crontab back", async () => {
    let installed = "";
    installRunner((argv) => {
      if (argv[1] === "-l") return { stdout: installed === "" ? CRONTAB_EVERY_SHAPE : installed };
      installed = fsLog.written[0]?.text ?? "";
      return {};
    });
    const out = await remove({ source: "crontab", id: "line:7" });
    expect(out["verified"]).toBe(true);
  });

  test("an install that silently changed the jobs is reported as unverified", async () => {
    let installed = "";
    installRunner((argv) => {
      if (argv[1] === "-l") {
        return {
          stdout: installed === "" ? CRONTAB_EVERY_SHAPE : "0 9 * * * /bin/something-else\n",
        };
      }
      installed = "done";
      return {};
    });
    const out = await remove({ source: "crontab", id: "line:7" });
    expect(out["verified"]).toBe(false);
    expect(out["note"]).toContain("check it by hand");
  });

  test("a comment above the removed job is kept, and the caller is told", async () => {
    installRunner(crontabHost(CRONTAB_EVERY_SHAPE));
    const out = await remove({ source: "crontab", id: "line:6", dryRun: true });
    expect(out["keptOrphanComments"]).toEqual([{ line: 5, text: "# nightly database dump" }]);
    expect(out["warnings"].join(" ")).toContain("KEPT");
  });

  test("a selector matching two jobs refuses and shows both", async () => {
    installRunner(crontabHost("0 1 * * * /bin/backup a\n0 2 * * * /bin/backup b\n"));
    const out = await remove({ source: "crontab", match: "/bin/backup" });
    expect(out).toMatchObject({ ok: false, deleted: false, reason: "ambiguous" });
    expect(out["candidates"].length).toBe(2);
    expect(fsLog.written).toEqual([]);
  });

  test("allowMultiple is what makes a two-line delete possible", async () => {
    installRunner(crontabHost("0 1 * * * /bin/backup a\n0 2 * * * /bin/backup b\n"));
    const out = await remove({ source: "crontab", match: "/bin/backup", allowMultiple: true });
    expect(out["deleted"]).toBe(true);
    expect(out["removedLines"].length).toBe(2);
    expect(fsLog.written[0]?.text).toBe("");
  });

  test("a stale fingerprint refuses before anything is written", async () => {
    installRunner(crontabHost(CRONTAB_EVERY_SHAPE));
    const out = await remove({
      source: "crontab",
      id: "line:7",
      fingerprint: "deadbeefcafe",
    });
    expect(out).toMatchObject({ ok: false, reason: "fingerprint-mismatch" });
    expect(fsLog.written).toEqual([]);
  });

  test("the fingerprint CronList handed out is the one that works", async () => {
    installRunner(crontabHost(CRONTAB_EVERY_SHAPE));
    const listed = await list({ sources: ["crontab"], nextRuns: 0 });
    const target = listed["entries"].find((entry: Entry) => entry.id === "line:7");
    const out = await remove({
      source: "crontab",
      id: "line:7",
      fingerprint: target.fingerprint,
      dryRun: true,
    });
    expect(out["ok"]).toBe(true);
  });

  test("no selector at all is refused", async () => {
    installRunner(crontabHost(CRONTAB_EVERY_SHAPE));
    const out = await remove({ source: "crontab" });
    expect(out).toMatchObject({ ok: false, reason: "no-selector" });
  });

  test("an unreadable scheduler is refused before any selection happens", async () => {
    installRunner(() => ({ exitCode: -1, spawnError: "ENOENT" }));
    const out = await remove({ source: "crontab", id: "line:1" });
    expect(out["error"]).toContain("not readable here");
  });
});

describe("CronDelete on launchd", () => {
  const uid = process.getuid?.() ?? 0;

  function launchdHost(extra: Handler = () => undefined): Handler {
    return (argv, stdin) => {
      const override = extra(argv, stdin);
      if (override !== undefined) return override;
      if (argv[0] === "launchctl") return { stdout: MACOS_LAUNCHCTL_LIST };
      if (argv[0] === "plutil") return { stdout: MACOS_PLIST_CALENDAR_DICT };
      return { exitCode: 127, spawnError: "ENOENT" };
    };
  }

  beforeEach(() => {
    installFs({
      home: "/home/alice",
      dirs: { "/home/alice/Library/LaunchAgents": ["com.example.gc.invoker-1.0.plist"] },
    });
  });

  test("a dry run shows the bootout it would run and warns that the job returns", async () => {
    installRunner(launchdHost());
    const out = await remove({ source: "launchd", id: "com.example.gc.scheduler", dryRun: true });
    expect(out["commands"]).toEqual([
      ["launchctl", "bootout", `gui/${uid}/com.example.gc.scheduler`],
    ]);
    expect(out["warnings"].join(" ")).toContain("loads it again at next login");
    expect(calls.some((argv) => argv[1] === "bootout")).toBe(false);
  });

  test("a job that was not loaded is not a failure", async () => {
    installRunner(
      launchdHost((argv) =>
        argv[1] === "bootout" ? { exitCode: 3, stderr: MACOS_BOOTOUT_MISSING_STDERR } : undefined,
      ),
    );
    const out = await remove({ source: "launchd", id: "com.example.gc.scheduler" });
    expect(out).toMatchObject({ ok: true, deleted: true });
    expect(out["ran"][0].exitCode).toBe(3);
  });

  test("a bootout that really failed stops everything after it", async () => {
    installRunner(
      launchdHost((argv) =>
        argv[1] === "bootout"
          ? { exitCode: 1, stderr: "Boot-out failed: 5: Input/output error" }
          : undefined,
      ),
    );
    const out = await remove({
      source: "launchd",
      id: "com.example.gc.scheduler",
      removeDefinition: true,
    });
    expect(out).toMatchObject({ ok: false, deleted: false });
    expect(out["error"]).toContain("failed (exit 1)");
    expect(fsLog.unlinked).toEqual([]);
  });

  test("removeDefinition deletes the plist, and only then", async () => {
    // A real directory, because the containment resolver resolves symlinks
    // against the real filesystem.
    const home = mkdtempSync(join(tmpdir(), "crewhaus-cron-home-"));
    try {
      const agents = join(home, "Library", "LaunchAgents");
      mkdirSync(agents, { recursive: true });
      writeFileSync(join(agents, "gc.plist"), "{}");
      installFs({ home, dirs: { [agents]: ["gc.plist"] } });
      installRunner(launchdHost());
      const out = await remove({
        source: "launchd",
        id: "com.example.gc.scheduler",
        removeDefinition: true,
      });
      expect(out["deleted"]).toBe(true);
      // The unlink targets the REAL path (symlinks already resolved), which
      // is what closes the window between the containment check and the
      // syscall — on macOS /var is itself a link to /private/var, so the
      // expectation is realpath'd too.
      expect(fsLog.unlinked).toEqual([join(realpathSync(agents), "gc.plist")]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a plist that is a symlink out of the agents directory is NOT deleted", async () => {
    const home = mkdtempSync(join(tmpdir(), "crewhaus-cron-home-"));
    const outside = mkdtempSync(join(tmpdir(), "crewhaus-cron-outside-"));
    try {
      const agents = join(home, "Library", "LaunchAgents");
      mkdirSync(agents, { recursive: true });
      writeFileSync(join(outside, "precious"), "not yours");
      symlinkSync(join(outside, "precious"), join(agents, "gc.plist"));
      installFs({ home, dirs: { [agents]: ["gc.plist"] } });
      installRunner(launchdHost());
      const out = await remove({
        source: "launchd",
        id: "com.example.gc.scheduler",
        removeDefinition: true,
      });
      expect(out).toMatchObject({ ok: false, deleted: false });
      expect(out["error"]).toContain("escapes");
      expect(fsLog.unlinked).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a plist that is a symlink to a SIBLING removes the link, not the sibling", async () => {
    // The near-miss of the test above. The link resolves INSIDE the managed
    // directory, so containment is satisfied and the delete goes ahead —
    // and unlinking the resolved target would delete another agent's
    // definition, leave the selected one's link behind, and report a path
    // that still exists.
    const home = mkdtempSync(join(tmpdir(), "crewhaus-cron-home-"));
    try {
      const agents = join(home, "Library", "LaunchAgents");
      mkdirSync(agents, { recursive: true });
      writeFileSync(join(agents, "other-job.plist"), '{"Label":"com.example.other"}');
      symlinkSync(join(agents, "other-job.plist"), join(agents, "gc.plist"));
      installFs({ home, dirs: { [agents]: ["gc.plist"] } });
      installRunner(launchdHost());
      const out = await remove({
        source: "launchd",
        id: "com.example.gc.scheduler",
        removeDefinition: true,
      });
      expect(out["deleted"]).toBe(true);
      const real = realpathSync(agents);
      expect(fsLog.unlinked).toEqual([join(real, "gc.plist")]);
      expect(fsLog.unlinked).not.toContain(join(real, "other-job.plist"));
      expect(out["removedFiles"]).toEqual([join(real, "gc.plist")]);
      expect(out["warnings"]?.join(" ")).toContain("was a symlink");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a machine-wide agent is refused rather than attempted with root", async () => {
    installFs({
      home: "/home/alice",
      dirs: { "/Library/LaunchAgents": ["updater.plist"] },
    });
    installRunner((argv) =>
      argv[0] === "launchctl"
        ? { stdout: MACOS_LAUNCHCTL_LIST }
        : argv[0] === "plutil"
          ? { stdout: MACOS_PLIST_INTERVAL }
          : { exitCode: 127, spawnError: "ENOENT" },
    );
    const out = await remove({ source: "launchd", id: "com.example.updater", dryRun: true });
    expect(out["error"]).toContain("needs root");
  });
});

describe("a label is data, not syntax", () => {
  function hostWithLabel(label: string): Handler {
    const plist = JSON.stringify({
      Label: label,
      StartCalendarInterval: { Hour: 3 },
      ProgramArguments: ["/usr/local/bin/thing"],
    });
    return (argv) => {
      if (argv[0] === "launchctl") return { stdout: MACOS_LAUNCHCTL_LIST };
      if (argv[0] === "plutil") return { stdout: plist };
      return { exitCode: 127, spawnError: "ENOENT" };
    };
  }

  beforeEach(() => {
    installFs({
      home: "/home/alice",
      dirs: { "/home/alice/Library/LaunchAgents": ["thing.plist"] },
    });
  });

  test("a label containing a slash is refused, because it would re-target the domain", async () => {
    // `launchctl bootout gui/501/<label>` is a PATH into launchd's domain
    // tree. A label with a slash in it addresses a different domain than the
    // one that was listed.
    installRunner(hostWithLabel("com.example/../../system/com.apple.something"));
    const out = await remove({
      source: "launchd",
      id: "com.example/../../system/com.apple.something",
      dryRun: true,
    });
    expect(out["error"]).toContain("refusing a launchd label containing");
    expect(calls.some((argv) => argv[1] === "bootout")).toBe(false);
  });

  test("a label that would be read as a flag is refused", async () => {
    installRunner(hostWithLabel("-w"));
    const out = await remove({ source: "launchd", id: "-w", dryRun: true });
    expect(out["error"]).toContain("starts with");
  });

  test("CronList still LISTS such a label — it is only the delete that refuses", async () => {
    installRunner(hostWithLabel("com.example/evil"));
    const out = await list({ sources: ["launchd"] });
    expect(out["entries"][0]?.id).toBe("com.example/evil");
  });
});

describe("CronDelete and the crond banner", () => {
  test("the banner is dropped from what gets installed, and the drop is reported", async () => {
    installRunner(crontabHost(CRONTAB_WITH_BANNER));
    const out = await remove({ source: "crontab", match: "nightly.sh", dryRun: true });
    expect(out["warnings"]?.join(" ")).toContain("banner");
    const real = await remove({ source: "crontab", match: "nightly.sh" });
    expect(real["deleted"]).toBe(true);
    // Only the banner and the job go; the user's own comment stays.
    expect(fsLog.written[0]?.text).toBe("# my own comment\n");
  });

  test("a job can be selected by its schedule as well as its command", async () => {
    installRunner(crontabHost(CRONTAB_EVERY_SHAPE));
    const out = await remove({ source: "crontab", match: "*/15 9-17", dryRun: true });
    expect(out["removedLines"]?.[0]?.line).toBe(7);
  });
});

describe("CronList over more than one scheduler", () => {
  test("both sources are read and the entries come back in a stable order", async () => {
    installRunner((argv) => {
      if (argv[0] === "crontab") return { stdout: LINUX_CRONTAB_L };
      if (argv[0] === "launchctl") return { stdout: MACOS_LAUNCHCTL_LIST };
      if (argv[0] === "plutil") return { stdout: MACOS_PLIST_CALENDAR_DICT };
      return { exitCode: 127, spawnError: "ENOENT" };
    });
    installFs({
      home: "/home/alice",
      dirs: { "/home/alice/Library/LaunchAgents": ["gc.plist"] },
    });
    const out = await list({ sources: ["launchd", "crontab"], nextRuns: 0 });
    expect(out["sources"].map((report) => report.source)).toEqual(["crontab", "launchd"]);
    expect(out["entries"].map((entry) => entry.source)).toEqual(["crontab", "crontab", "launchd"]);
  });
});

// ---------------------------------------------------------------------------
// a probe that did not answer is not an answer
// ---------------------------------------------------------------------------

describe("what the tools say when a probe FAILED", () => {
  test("a crontab listing cut off at the output cap is not a crontab", async () => {
    // The cap is a prefix, and a prefix of a crontab parses perfectly: the
    // tail is simply missing and the last surviving line is cut mid-command.
    // Reported as a listing, it reads as "these are your jobs".
    installRunner((argv) =>
      argv[1] === "-l"
        ? { stdout: "0 3 * * * /usr/local/bin/a.sh\n30 4 * * * /usr/lo", stdoutTruncated: true }
        : {},
    );
    const out = await list({ sources: ["crontab"], nextRuns: 0 });
    expect(out["sources"][0]?.available).toBe(false);
    expect(out["sources"][0]?.reason).toContain("PREFIX");
    expect(out["entries"]).toEqual([]);
  });

  test("a delete REFUSES to rewrite a crontab it only half read", async () => {
    // The consequence if it did not: the rewrite installs the prefix, and
    // every job past the cap is deleted without ever being mentioned.
    installRunner((argv) =>
      argv[1] === "-l"
        ? { stdout: "0 3 * * * /usr/local/bin/a.sh\n30 4 * * * /usr/lo", stdoutTruncated: true }
        : {},
    );
    const out = await remove({ source: "crontab", id: "line:1" });
    expect(out).toMatchObject({ ok: false, deleted: false });
    expect(out["error"]).toContain("not readable here");
    expect(fsLog.written).toEqual([]);
    expect(calls.some((argv) => argv[0] === "crontab" && argv[1] !== "-l")).toBe(false);
  });

  test("launchctl failing makes the loaded state unknown, not false", async () => {
    installFs({ home: "/home/alice", dirs: { "/home/alice/Library/LaunchAgents": ["gc.plist"] } });
    installRunner((argv) =>
      argv[0] === "launchctl"
        ? { exitCode: 1, stderr: "Could not connect to the bootstrap server\n" }
        : argv[0] === "plutil"
          ? { stdout: MACOS_PLIST_CALENDAR_DICT }
          : { exitCode: 127, spawnError: "ENOENT" },
    );
    const out = await list({ sources: ["launchd"], nextRuns: 0 });
    const entry = out["entries"][0];
    expect(entry?.state).toBe("unknown");
    expect(entry?.notes?.some((note) => note.includes("could not be determined"))).toBe(true);
    expect(entry?.notes?.some((note) => note.includes("not loaded right now"))).toBe(false);
  });

  test("an agents directory that cannot be LISTED is not an empty one", async () => {
    // A LaunchAgents directory refusing EACCES looks exactly like one that is
    // not there. Answering "no agents" on the strength of that is the shape
    // of mistake this whole file exists to catch.
    installFs({
      home: "/home/alice",
      unreadableDirs: { "/home/alice/Library/LaunchAgents": "EACCES" },
    });
    installRunner((argv) =>
      argv[0] === "launchctl" ? { stdout: MACOS_LAUNCHCTL_LIST } : { exitCode: 127 },
    );
    const out = await list({ sources: ["launchd"], nextRuns: 0 });
    expect(out["sources"][0]?.available).toBe(false);
    expect(out["sources"][0]?.reason).toContain("EACCES");
    expect(out["sources"][0]?.skipped?.[0]?.path).toBe("/home/alice/Library/LaunchAgents");
  });

  test("a delete refuses when the directory it would select from is unreadable", async () => {
    installFs({
      home: "/home/alice",
      unreadableDirs: { "/home/alice/Library/LaunchAgents": "EACCES" },
    });
    installRunner((argv) =>
      argv[0] === "launchctl" ? { stdout: MACOS_LAUNCHCTL_LIST } : { exitCode: 127 },
    );
    const out = await remove({ source: "launchd", id: "com.example.gc.scheduler" });
    // NOT "no such entry": the entry may be right there, unread.
    expect(out).toMatchObject({ ok: false, deleted: false });
    expect(out["error"]).toContain("not readable here");
    expect(out["reason"]).not.toBe("not-found");
  });

  test("one unreadable directory does not hide the ones that read fine", async () => {
    installFs({
      home: "/home/alice",
      dirs: { "/home/alice/Library/LaunchAgents": ["gc.plist"] },
      unreadableDirs: { "/Library/LaunchAgents": "EACCES" },
    });
    installRunner((argv) =>
      argv[0] === "launchctl"
        ? { stdout: MACOS_LAUNCHCTL_LIST }
        : argv[0] === "plutil"
          ? { stdout: MACOS_PLIST_CALENDAR_DICT }
          : { exitCode: 127 },
    );
    const out = await list({ sources: ["launchd"], systemScope: true, nextRuns: 0 });
    expect(out["sources"][0]?.available).toBe(true);
    expect(out["entries"].length).toBe(1);
    expect(out["sources"][0]?.skipped?.some((skip) => skip.path === "/Library/LaunchAgents")).toBe(
      true,
    );
  });

  test("a systemctl killed at its deadline is reported as slow, not as absent", async () => {
    installRunner(() => ({ exitCode: 143, timedOut: true }));
    const out = await list({ sources: ["systemd"], nextRuns: 0, timeoutMs: 400 });
    expect(out["sources"][0]?.available).toBe(false);
    // "systemctl exited 143" reads like a broken systemd. Name the deadline.
    expect(out["sources"][0]?.reason).toContain("did not finish within 400ms");
  });

  test("an install whose read-back cannot be done says UNVERIFIED, not mismatched", async () => {
    let reads = 0;
    installRunner((argv) => {
      if (argv[1] === "-l") {
        reads += 1;
        // The third read is the verification, after the install.
        if (reads >= 3) return { exitCode: 1, stderr: "crontab: permission denied\n" };
        return { stdout: CRONTAB_EVERY_SHAPE };
      }
      return {};
    });
    const out = await remove({ source: "crontab", id: "line:6" });
    expect(out["deleted"]).toBe(true);
    expect(out["verified"]).toBe(false);
    expect(out["verification"]).toBe("unreadable");
    // The old wording claimed a comparison that never happened.
    expect(out["note"]).toContain("UNVERIFIED");
    expect(out["note"]).not.toContain("did not produce the same set");
  });

  test("a half-finished multi-step delete does not report that nothing happened", async () => {
    installFs({
      home: "/home/alice",
      dirs: { "/home/alice/Library/LaunchAgents": ["one.plist", "two.plist"] },
    });
    let plists = 0;
    installRunner((argv) => {
      if (argv[0] === "launchctl" && argv[1] === "list") return { stdout: MACOS_LAUNCHCTL_LIST };
      if (argv[0] === "plutil") {
        plists += 1;
        return {
          stdout: JSON.stringify({
            Label: plists === 1 ? "com.example.batch.one" : "com.example.batch.two",
            StartCalendarInterval: { Hour: 3 },
            ProgramArguments: ["/usr/local/bin/batch"],
          }),
        };
      }
      // The FIRST bootout succeeds; the second one fails.
      if (argv[1] === "bootout") {
        return argv[2]?.endsWith("two") === true
          ? { exitCode: 1, stderr: "Boot-out failed: 5: Input/output error" }
          : {};
      }
      return {};
    });
    const out = await remove({
      source: "launchd",
      match: "com.example.batch",
      allowMultiple: true,
    });
    expect(out["ok"]).toBe(false);
    // The first agent really was unloaded. "deleted: false" alone is a claim
    // the machine contradicts.
    expect(out["partial"]).toBe(true);
    expect(out["completed"]).toEqual(["unload com.example.batch.one"]);
    expect(out["error"]).toContain("HAD already taken effect");
  });

  test("a systemd fingerprint from CronList still works after the timer has fired", async () => {
    // The round trip the tool documents: list, then delete pinned to the
    // fingerprint you were shown. If the hash covered the runtime state, the
    // delete would refuse with "it changed since it was listed" for every
    // timer that fired in between — a false statement about the definition.
    const listed = LINUX_SHOW_MULTI_ONCALENDAR;
    const fired = listed
      .replace("LastTriggerUSec=", "LastTriggerUSec=Fri 2026-09-18 02:30:00 UTC")
      .replace(
        "NextElapseUSecRealtime=Sat 2026-09-19 02:30:00 UTC",
        "NextElapseUSecRealtime=Sun 2026-09-20 02:30:00 UTC",
      );
    const host =
      (show: string): Handler =>
      (argv) => {
        if (argv[0] !== "systemctl") return { exitCode: 127, spawnError: "ENOENT" };
        if (argv.includes("list-units")) return { stdout: LINUX_LIST_UNITS_TIMERS };
        if (argv.includes("show")) return { stdout: show };
        return {};
      };
    installRunner(host(listed));
    const shown = (await list({ sources: ["systemd"], nextRuns: 0 })).entries[0];
    installRunner(host(fired));
    const out = await remove({
      source: "systemd",
      id: "backup.timer",
      fingerprint: shown?.fingerprint as string,
      dryRun: true,
    });
    expect(out["reason"]).not.toBe("fingerprint-mismatch");
    expect(out["ok"]).toBe(true);
  });
});

describe("CronDelete on systemd", () => {
  function systemdHost(extra: Handler = () => undefined): Handler {
    return (argv, stdin) => {
      const override = extra(argv, stdin);
      if (override !== undefined) return override;
      if (argv[0] !== "systemctl") return { exitCode: 127, spawnError: "ENOENT" };
      if (argv.includes("list-units")) return { stdout: LINUX_LIST_UNITS_TIMERS };
      if (argv.includes("show")) return { stdout: LINUX_SHOW_MULTI_ONCALENDAR };
      return {};
    };
  }

  test("the disable is a --user disable --now with an option terminator", async () => {
    installRunner(systemdHost());
    const out = await remove({ source: "systemd", id: "backup.timer", dryRun: true });
    expect(out["commands"]).toEqual([
      ["systemctl", "--user", "disable", "--now", "--", "backup.timer"],
    ]);
  });

  test("without removeDefinition the unit file is left alone, and that is said", async () => {
    installRunner(systemdHost());
    const out = await remove({ source: "systemd", id: "backup.timer" });
    expect(out["deleted"]).toBe(true);
    expect(out["warnings"].join(" ")).toContain("unit file stays");
    expect(fsLog.unlinked).toEqual([]);
  });

  test("a unit file outside the user's own directory is not this tool's to delete", async () => {
    // The fixture's FragmentPath is /etc/systemd/system/backup.timer.
    installRunner(systemdHost());
    const out = await remove({ source: "systemd", id: "backup.timer", removeDefinition: true });
    expect(out["error"]).toContain("is not this tool's to delete");
    expect(calls.some((argv) => argv.includes("disable"))).toBe(false);
  });

  test("a failed disable is reported with systemd's own message", async () => {
    installRunner(
      systemdHost((argv) =>
        argv.includes("disable")
          ? { exitCode: 1, stderr: LINUX_DISABLE_MISSING_STDERR }
          : undefined,
      ),
    );
    const out = await remove({ source: "systemd", id: "backup.timer" });
    expect(out).toMatchObject({ ok: false, deleted: false });
    expect(out["ran"][0].stderr).toContain("does not exist");
  });

  test("a timeout on the delete names the deadline rather than a bare failure", async () => {
    installRunner(
      systemdHost((argv) =>
        argv.includes("disable") ? { exitCode: -1, timedOut: true } : undefined,
      ),
    );
    const out = await remove({ source: "systemd", id: "backup.timer", timeoutMs: 300 });
    // The DEADLINE, with its value: "exit -1" or a bare "failed" would also
    // be satisfied by a command that ran and refused.
    expect(out["detail"]).toContain("did not finish within 300ms");
  });
});
