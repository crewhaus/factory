/**
 * The parsers, driven entirely from recorded host output.
 *
 * Nothing in this file spawns anything or touches the machine's schedulers:
 * every input is a string literal captured from a real crontab, a real
 * `launchctl list`, a real `plutil` conversion or a real `systemctl show`
 * (see `./__fixtures__/host-output`). That is the point — CI is Linux, this
 * was written on macOS, and a test that asked the host what it had scheduled
 * would assert something different on each.
 */
import { describe, expect, test } from "bun:test";
import {
  CRONTAB_EVERY_SHAPE,
  CRONTAB_WITH_BANNER,
  LINUX_CRONTAB_L,
  LINUX_DISABLE_MISSING_STDERR,
  LINUX_LIST_UNITS_TIMERS,
  LINUX_SHOW_MONOTONIC_AND_INACTIVE,
  LINUX_SHOW_MULTI_ONCALENDAR,
  LINUX_SHOW_OLD_USEC_FORM,
  LINUX_SHOW_TWO_TIMERS,
  LINUX_SYSTEMCTL_NOT_BOOTED_STDERR,
  LINUX_SYSTEMCTL_NO_BUS_ENV_STDERR,
  LINUX_SYSTEMCTL_NO_BUS_FILE_STDERR,
  MACOS_LAUNCHCTL_LIST,
  MACOS_PLIST_CALENDAR_ARRAY,
  MACOS_PLIST_CALENDAR_DICT,
  MACOS_PLIST_CALENDAR_WEEKDAY,
  MACOS_PLIST_INTERVAL,
  MACOS_PLIST_KEEPALIVE,
  MACOS_PLIST_USER_DISABLED,
} from "./__fixtures__/host-output";
import { crontabEntries, parseCrontab, planRemoval, splitPercent } from "./lib/crontab";
import { type JobEntry, byEntry, fingerprint, selectEntries } from "./lib/entries";
import {
  type LaunchdDefinition,
  describeCalendar,
  launchdEntries,
  parseLaunchctlList,
  parsePlistJson,
} from "./lib/launchd";
import { buildEnv, checkArgument } from "./lib/run";
import {
  enablement,
  monotonicExpressions,
  onCalendarExpressions,
  parseShowBlocks,
  parseSystemdTime,
  parseTimerUnitNames,
  systemctlUnavailableReason,
  systemdEntries,
} from "./lib/systemd";

// ---------------------------------------------------------------------------
// crontab
// ---------------------------------------------------------------------------

describe("crontab parsing", () => {
  const parsed = parseCrontab(CRONTAB_EVERY_SHAPE);
  const at = (line: number) => parsed.lines[line - 1];

  test("every line keeps its 1-based number, blank lines included", () => {
    expect(parsed.lines.map((line) => line.line)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);
    expect(at(4)?.kind).toBe("blank");
  });

  test("environment assignments are recognised, not read as jobs", () => {
    const assignments = parsed.lines.filter((line) => line.kind === "assignment");
    expect(assignments.map((line) => (line.kind === "assignment" ? line.name : ""))).toEqual([
      "SHELL",
      "PATH",
      "MAILTO",
    ]);
    const mailto = at(3);
    expect(mailto?.kind === "assignment" ? mailto.value : "").toBe("ops@example.com");
  });

  test("a five-field job splits into schedule and command", () => {
    const job = at(6);
    expect(job?.kind).toBe("job");
    expect(job?.kind === "job" ? job.expression : "").toBe("30 2 * * *");
    expect(job?.kind === "job" ? job.command : "").toBe("/usr/local/bin/backup.sh --full");
    expect(job?.kind === "job" ? job.grammar : "").toBe("cron5");
  });

  test("a macro is a macro and @reboot is an event, not a time", () => {
    const daily = at(8);
    const reboot = at(9);
    expect(daily?.kind === "job" ? daily.grammar : "").toBe("cron-macro");
    expect(reboot?.kind === "job" ? reboot.grammar : "").toBe("cron-reboot");
    expect(reboot?.kind === "job" ? reboot.expression : "").toBe("@reboot");
  });

  test("cronie's leading - is stripped from the schedule and reported", () => {
    const quiet = at(10);
    expect(quiet?.kind === "job" ? quiet.expression : "").toBe("0 4 * * 0");
    expect(quiet?.kind === "job" ? quiet.logSuppressed : undefined).toBe(true);
  });

  test("an unescaped % ends the command and the rest becomes stdin", () => {
    const mail = at(11);
    expect(mail?.kind === "job" ? mail.command : "").toBe("/usr/bin/mail-report");
    expect(mail?.kind === "job" ? mail.stdin : "").toBe(
      "subject: nightly\nbody line one\nbody line two",
    );
  });

  test("an escaped \\% stays inside the command", () => {
    const printf = at(12);
    expect(printf?.kind === "job" ? printf.command : "").toBe("/usr/bin/printf 'done 100\\% ok'");
    expect(printf?.kind === "job" ? printf.stdin : undefined).toBeUndefined();
  });

  test("splitPercent handles a command with no percent at all", () => {
    expect(splitPercent("/bin/true")).toEqual({ command: "/bin/true" });
  });

  test("a six-field expression pasted into a user crontab is FLAGGED, not accepted quietly", () => {
    // `0 0 12 * * ?` is Quartz (seconds first). A five-field read of it
    // succeeds — schedule `0 0 12 * *`, command `?` — which is the silent
    // wrong answer this note exists to prevent.
    const quartz = at(13);
    expect(quartz?.kind === "job" ? quartz.expression : "").toBe("0 0 12 * *");
    expect(quartz?.kind === "job" ? quartz.command : "").toBe("?");
    const notes = quartz?.kind === "job" ? (quartz.notes ?? []) : [];
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain("six-field scheduler");
  });

  test("a line with too few fields is unparsed, with a reason", () => {
    const short = parseCrontab("* * * *\n").lines[0];
    expect(short?.kind).toBe("unparsed");
    expect(short?.kind === "unparsed" ? short.reason : "").toContain("five schedule fields");
  });

  test("a macro with nothing after it is unparsed", () => {
    const bare = parseCrontab("@daily\n").lines[0];
    expect(bare?.kind).toBe("unparsed");
    expect(bare?.kind === "unparsed" ? bare.reason : "").toContain("nothing to run");
  });

  test("an unknown @macro is refused by name rather than guessed at", () => {
    const weird = parseCrontab("@fortnightly /bin/true\n").lines[0];
    expect(weird?.kind === "unparsed" ? weird.reason : "").toContain("@fortnightly");
  });

  test("a comment is a comment even when it looks like a job", () => {
    const commented = parseCrontab("#30 2 * * * /bin/true\n").lines[0];
    expect(commented?.kind).toBe("comment");
  });

  test("the trailing newline is a terminator, not a blank line", () => {
    expect(parseCrontab("0 3 * * * /bin/true\n").lines.length).toBe(1);
    expect(parseCrontab("0 3 * * * /bin/true").missingTrailingNewline).toBe(true);
    expect(parseCrontab("0 3 * * * /bin/true\n").missingTrailingNewline).toBe(false);
  });

  test("a CRLF listing is recognised as one", () => {
    const crlf = parseCrontab("MAILTO=a@b\r\n0 3 * * * /bin/true\r\n");
    expect(crlf.lineEnding).toBe("\r\n");
    expect(crlf.lines.length).toBe(2);
  });

  test("the crond banner is detected, and an ordinary comment is not", () => {
    expect(parseCrontab(CRONTAB_WITH_BANNER).bannerLines).toBe(3);
    expect(parseCrontab(CRONTAB_EVERY_SHAPE).bannerLines).toBe(0);
    expect(parseCrontab("# my own notes\n0 3 * * * /bin/true\n").bannerLines).toBe(0);
  });

  test("a real Debian listing round-trips into entries", () => {
    const entries = crontabEntries(parseCrontab(LINUX_CRONTAB_L));
    expect(entries.map((entry) => entry.id)).toEqual(["line:3", "line:4"]);
    expect(entries[0]?.command).toBe("/usr/local/bin/sync.sh");
    expect(entries[1]?.schedule.grammar).toBe("cron-macro");
  });
});

describe("crontab entries", () => {
  const entries = crontabEntries(parseCrontab(CRONTAB_EVERY_SHAPE));

  test("each entry names its source and carries the scheduler's own handle", () => {
    for (const entry of entries) {
      expect(entry.source).toBe("crontab");
      expect(entry.idKind).toBe("crontab-line");
      expect(entry.id).toBe(`line:${entry.line}`);
    }
  });

  test("a fingerprint is stable for the same bytes and different for others", () => {
    expect(fingerprint("0 3 * * * /bin/true")).toBe(fingerprint("0 3 * * * /bin/true"));
    expect(fingerprint("0 3 * * * /bin/true")).not.toBe(fingerprint("0 4 * * * /bin/true"));
    expect(fingerprint("x").length).toBe(12);
  });

  test("the stdin split and the cronie dash are surfaced as notes", () => {
    const mail = entries.find((entry) => entry.id === "line:11");
    const quiet = entries.find((entry) => entry.id === "line:10");
    expect(mail?.notes?.some((note) => note.includes("stdin"))).toBe(true);
    expect(quiet?.notes?.some((note) => note.includes("do not log"))).toBe(true);
  });

  test("@reboot carries the reason it has no next firing", () => {
    const reboot = entries.find((entry) => entry.schedule.grammar === "cron-reboot");
    expect(reboot?.schedule.note).toContain("no next firing");
  });
});

describe("crontab removal planning", () => {
  const parsed = parseCrontab(CRONTAB_EVERY_SHAPE);

  test("removing one line leaves every other byte alone", () => {
    const plan = planRemoval(parsed, [7]);
    expect(plan.removed).toEqual([{ line: 7, text: "*/15 9-17 * * 1-5 /usr/local/bin/poll.sh" }]);
    const before = CRONTAB_EVERY_SHAPE.split("\n");
    const after = plan.nextText.split("\n");
    // Same bytes, one line shorter, and the assignments and comment survive.
    expect(after.length).toBe(before.length - 1);
    expect(plan.nextText).toContain("MAILTO=ops@example.com");
    expect(plan.nextText).toContain("# nightly database dump");
    expect(plan.nextText).not.toContain("/usr/local/bin/poll.sh");
  });

  test("a stray CRLF line does not re-terminate the lines around it", () => {
    // The corruption this guards: joining every kept line with one file-wide
    // ending appends a `\r` to commands that never had one, and cron then
    // runs `/usr/local/bin/a.sh\r`, which is not a program. Only the CRLF
    // line may keep its CRLF.
    const mixed =
      "MAILTO=ops@example.com\r\n0 3 * * * /usr/local/bin/a.sh\n30 4 * * * /usr/local/bin/b.sh\n0 5 * * * /usr/local/bin/c.sh\n";
    const plan = planRemoval(parseCrontab(mixed), [3]);
    expect(plan.nextText).toBe(
      "MAILTO=ops@example.com\r\n0 3 * * * /usr/local/bin/a.sh\n0 5 * * * /usr/local/bin/c.sh\n",
    );
    expect(plan.nextText).not.toContain("a.sh\r");
    expect(parseCrontab(mixed).mixedLineEndings).toBe(true);
  });

  test("a CRLF line's command does not carry the carriage return", () => {
    // Greedy line splitting hands back "…/bin/true\r" as the command; the
    // `\r` belongs to the terminator, not to the job.
    const crlf = crontabEntries(parseCrontab("0 3 * * * /bin/true\r\n"));
    expect(crlf[0]?.command).toBe("/bin/true");
  });

  test("an all-CRLF file round-trips as CRLF", () => {
    const crlf = "MAILTO=a@b\r\n0 3 * * * /bin/a\r\n30 4 * * * /bin/b\r\n";
    const plan = planRemoval(parseCrontab(crlf), [3]);
    expect(plan.nextText).toBe("MAILTO=a@b\r\n0 3 * * * /bin/a\r\n");
  });

  test("a last line with no terminator still gets exactly one", () => {
    const plan = planRemoval(parseCrontab("0 3 * * * /bin/a\n30 4 * * * /bin/b"), [1]);
    expect(plan.nextText).toBe("30 4 * * * /bin/b\n");
  });

  test("the result ends in exactly one newline", () => {
    // Debian's crontab REFUSES a file with no trailing newline
    // ("new crontab file is missing newline before EOF, can't install."),
    // and two newlines would grow the file by a blank line on every edit.
    const plan = planRemoval(parsed, [7]);
    expect(plan.nextText.endsWith("\n")).toBe(true);
    expect(plan.nextText.endsWith("\n\n")).toBe(false);
  });

  test("removing the only line produces empty text, not a lone newline", () => {
    const single = parseCrontab("0 3 * * * /bin/true\n");
    expect(planRemoval(single, [1]).nextText).toBe("");
  });

  test("removing nothing returns the input unchanged", () => {
    expect(planRemoval(parsed, []).nextText).toBe(CRONTAB_EVERY_SHAPE);
  });

  test("a comment above a removed job is KEPT and reported", () => {
    const plan = planRemoval(parsed, [6]);
    expect(plan.orphanComments).toEqual([{ line: 5, text: "# nightly database dump" }]);
    expect(plan.nextText).toContain("# nightly database dump");
  });

  test("the crond banner is dropped on rewrite and the drop is reported", () => {
    const banner = parseCrontab(CRONTAB_WITH_BANNER);
    const plan = planRemoval(banner, []);
    expect(plan.bannerDropped).toBe(3);
    expect(plan.nextText).not.toContain("DO NOT EDIT THIS FILE");
    // The user's own comment is not a banner line and survives.
    expect(plan.nextText).toContain("# my own comment");
  });

  test("a CRLF crontab is rewritten with CRLF", () => {
    const crlf = parseCrontab("MAILTO=a@b\r\n0 3 * * * /bin/true\r\n0 4 * * * /bin/false\r\n");
    const plan = planRemoval(crlf, [3]);
    expect(plan.nextText).toBe("MAILTO=a@b\r\n0 3 * * * /bin/true\r\n");
  });

  test("removing several lines at once keeps the rest in order", () => {
    const plan = planRemoval(parsed, [6, 8, 13]);
    expect(plan.removed.map((line) => line.line)).toEqual([6, 8, 13]);
    expect(plan.nextText).toContain("@reboot /usr/local/bin/warm-cache.sh");
    expect(plan.nextText).not.toContain("rotate.sh");
  });
});

// ---------------------------------------------------------------------------
// launchd
// ---------------------------------------------------------------------------

describe("launchctl list", () => {
  const rows = parseLaunchctlList(MACOS_LAUNCHCTL_LIST);

  test("the header is skipped and every row is read", () => {
    expect(rows.length).toBe(6);
    expect(rows.map((row) => row.label)).toContain("com.example.gc.scheduler");
  });

  test("a dash means absent, not zero", () => {
    const idle = rows.find((row) => row.label === "com.apple.SafariHistoryServiceAgent");
    expect(idle?.pid).toBeUndefined();
    expect(idle?.lastExitStatus).toBe(0);
  });

  test("a running job keeps its pid", () => {
    expect(rows.find((row) => row.label === "com.apple.Finder")?.pid).toBe(675);
  });

  test("a negative status is a signal number and is preserved", () => {
    expect(rows.find((row) => row.label === "com.apple.cloudphotod")?.lastExitStatus).toBe(-9);
  });

  test("junk lines and an empty listing are handled", () => {
    expect(parseLaunchctlList("")).toEqual([]);
    expect(parseLaunchctlList("PID\tStatus\tLabel\n")).toEqual([]);
    expect(parseLaunchctlList("nonsense without tabs\n")).toEqual([]);
  });
});

describe("plists", () => {
  test("the LABEL comes from inside the file, never from its name", () => {
    // The real file this was captured from is named
    // `com.adobe.GC.Invoker-1.0.plist` and declares `…Scheduler-1.0`.
    const def = parsePlistJson(
      "/Users/alice/Library/LaunchAgents/com.example.gc.invoker-1.0.plist",
      "user",
      MACOS_PLIST_CALENDAR_DICT,
    );
    expect("label" in def ? def.label : "").toBe("com.example.gc.scheduler");
  });

  test("a calendar dictionary is reported as launchd's grammar, not as cron", () => {
    const def = parsePlistJson("/x/a.plist", "user", MACOS_PLIST_CALENDAR_DICT);
    const schedule = "schedule" in def ? def.schedule : undefined;
    expect(schedule?.grammar).toBe("launchd-calendar");
    expect(schedule?.expression).toBe("Hour=8 Minute=31");
    expect(schedule?.description).toBe("at 08:31 every day");
    expect(schedule?.note).toContain("not a cron expression");
  });

  test("a calendar ARRAY means all of these times", () => {
    const def = parsePlistJson("/x/talagent.plist", "system", MACOS_PLIST_CALENDAR_ARRAY);
    const schedule = "schedule" in def ? def.schedule : undefined;
    expect(schedule?.calendar?.length).toBe(2);
    expect(schedule?.expression).toBe("Weekday=1 Hour=3 ; Weekday=4 Hour=3");
    // No Minute key, so launchd runs it EVERY minute of that hour — the
    // defaulting trap, stated rather than smoothed over.
    expect(schedule?.description).toBe(
      "every minute of the 03:00 hour on Monday; and every minute of the 03:00 hour on Thursday",
    );
  });

  test("a weekday calendar names the day", () => {
    const def = parsePlistJson("/x/pk.plist", "system", MACOS_PLIST_CALENDAR_WEEKDAY);
    expect(("schedule" in def ? def.schedule.description : "") ?? "").toContain("Saturday");
  });

  test("an omitted Minute means EVERY minute of that hour, and says so", () => {
    expect(describeCalendar([{ hour: 12 }])).toBe("every minute of the 12:00 hour every day");
    expect(describeCalendar([{ minute: 0 }])).toBe("at 00 minutes past every hour every day");
    expect(describeCalendar([{}])).toBe("every minute every day");
  });

  test("Day and Weekday together are flagged as undefined behaviour", () => {
    const def = parsePlistJson(
      "/x/both.plist",
      "user",
      JSON.stringify({ Label: "com.example.both", StartCalendarInterval: { Day: 1, Weekday: 1 } }),
    );
    expect(("schedule" in def ? def.schedule.note : "") ?? "").toContain("does not document");
  });

  test("StartInterval is an interval, not a calendar", () => {
    const def = parsePlistJson("/x/upd.plist", "system", MACOS_PLIST_INTERVAL);
    const schedule = "schedule" in def ? def.schedule : undefined;
    expect(schedule?.grammar).toBe("launchd-interval");
    expect(schedule?.intervalSeconds).toBe(3600);
    expect(schedule?.note).toContain("restarts at load");
  });

  test("a KeepAlive agent has no schedule and is not pretended to have one", () => {
    const def = parsePlistJson("/x/brew.plist", "user", MACOS_PLIST_KEEPALIVE);
    const schedule = "schedule" in def ? def.schedule : undefined;
    expect(schedule?.grammar).toBe("launchd-event");
    expect(schedule?.expression).toContain("KeepAlive");
    expect(schedule?.expression).toContain("RunAtLoad");
  });

  test("a definition with no schedule keys at all is reported as none", () => {
    const def = parsePlistJson("/x/n.plist", "user", JSON.stringify({ Label: "com.example.n" }));
    expect(("schedule" in def ? def.schedule.grammar : "") ?? "").toBe("none");
  });

  test("Program alone is read when ProgramArguments is absent", () => {
    const def = parsePlistJson("/x/p.plist", "user", MACOS_PLIST_CALENDAR_WEEKDAY);
    expect("argv" in def ? def.argv : undefined).toEqual(["/usr/libexec/pkreporter"]);
  });

  test("an unreadable plist is a reported failure, never a silent skip", () => {
    const notJson = parsePlistJson("/x/bad.plist", "user", "not a plist at all");
    expect("reason" in notJson ? notJson.reason : "").toContain("not JSON");
    const noLabel = parsePlistJson("/x/nolabel.plist", "user", JSON.stringify({ Hour: 3 }));
    expect("reason" in noLabel ? noLabel.reason : "").toContain("no Label");
    const array = parsePlistJson("/x/arr.plist", "user", "[1,2,3]");
    expect("reason" in array ? array.reason : "").toContain("not a dictionary");
  });
});

describe("launchd entries", () => {
  const definitions = [
    parsePlistJson("/Users/alice/Library/LaunchAgents/gc.plist", "user", MACOS_PLIST_CALENDAR_DICT),
    parsePlistJson(
      "/Users/alice/Library/LaunchAgents/relay.plist",
      "user",
      MACOS_PLIST_USER_DISABLED,
    ),
    parsePlistJson("/Library/LaunchAgents/upd.plist", "system", MACOS_PLIST_INTERVAL),
  ].filter((def): def is LaunchdDefinition => "label" in def);
  const entries = launchdEntries(definitions, parseLaunchctlList(MACOS_LAUNCHCTL_LIST));

  test("the label is the id and the plist path is reported separately", () => {
    const gc = entries.find((entry) => entry.id === "com.example.gc.scheduler");
    expect(gc?.idKind).toBe("launchd-label");
    expect(gc?.definitionPath).toBe("/Users/alice/Library/LaunchAgents/gc.plist");
  });

  test("status from launchctl is joined on the label", () => {
    const relay = entries.find((entry) => entry.id === "com.example.relay");
    expect(relay?.lastExitStatus).toBe(78);
    expect(relay?.state).toBe("loaded");
  });

  test("a FAILED status read says unknown, not 'not loaded'", () => {
    // `launchctl list` failing produces no rows, and a join against no rows
    // reads as "none of these agents is loaded" — a definite answer built out
    // of a probe that did not answer. A caller acts on it.
    const blind = launchdEntries(definitions, [], false);
    for (const entry of blind) {
      expect(entry.state).toBe("unknown");
      expect(entry.notes?.some((note) => note.includes("could not be determined"))).toBe(true);
      expect(entry.notes?.some((note) => note.includes("not loaded right now"))).toBe(false);
    }
  });

  test("a definition nothing has loaded says so", () => {
    const updater = entries.find((entry) => entry.id === "com.example.updater");
    expect(updater?.state).toBe("not-loaded");
    expect(updater?.notes?.some((note) => note.includes("not loaded"))).toBe(true);
  });

  test("Disabled in the plist turns into enabled:false with the reason", () => {
    const relay = entries.find((entry) => entry.id === "com.example.relay");
    expect(relay?.enabled).toBe(false);
    expect(relay?.notes?.some((note) => note.includes("Disabled"))).toBe(true);
  });

  test("a system-scope definition is marked as one", () => {
    expect(entries.find((entry) => entry.id === "com.example.updater")?.scope).toBe("system");
  });
});

// ---------------------------------------------------------------------------
// systemd
// ---------------------------------------------------------------------------

describe("systemd unit listing", () => {
  test("every timer name is read, sorted and de-duplicated", () => {
    const names = parseTimerUnitNames(LINUX_LIST_UNITS_TIMERS);
    expect(names.length).toBe(7);
    expect(names[0]).toBe("apt-daily-upgrade.timer");
    expect([...names]).toEqual([...names].sort());
  });

  test("the status bullet systemd prints for an unhealthy unit is stripped", () => {
    expect(parseTimerUnitNames("● broken.timer loaded failed failed Broken\n")).toEqual([
      "broken.timer",
    ]);
  });

  test("prose lines are not units", () => {
    expect(
      parseTimerUnitNames("7 timers listed.\nPass --all to see loaded but inactive.\n"),
    ).toEqual([]);
  });
});

describe("systemctl show", () => {
  test("blocks are split on the blank line", () => {
    const blocks = parseShowBlocks(LINUX_SHOW_TWO_TIMERS);
    expect(blocks.length).toBe(2);
    expect(blocks[0]?.["Id"]).toBe("apt-daily.timer");
    expect(blocks[1]?.["Id"]).toBe("dpkg-db-backup.timer");
  });

  test("a value containing = is not split twice", () => {
    const blocks = parseShowBlocks("Id=x.timer\nEnvironment=A=1 B=2\n");
    expect(blocks[0]?.["Environment"]).toBe("A=1 B=2");
  });

  test("a REPEATED property keeps every occurrence", () => {
    // A timer with two OnCalendar= lines prints two TimersCalendar= lines.
    // Last-one-wins would drop half the schedule.
    const blocks = parseShowBlocks(LINUX_SHOW_MULTI_ONCALENDAR);
    expect(onCalendarExpressions(blocks[0]?.["TimersCalendar"])).toEqual([
      "Mon *-*-* 09:00:00",
      "*-*-* 02:30:00",
    ]);
  });

  test("monotonic timer entries are read the same way", () => {
    const blocks = parseShowBlocks(LINUX_SHOW_MONOTONIC_AND_INACTIVE);
    expect(monotonicExpressions(blocks[0]?.["TimersMonotonic"])).toEqual([
      "OnUnitActiveUSec=1d",
      "OnBootUSec=15min",
    ]);
  });

  test("an absent property is absent, not empty", () => {
    expect(onCalendarExpressions(undefined)).toEqual([]);
    expect(monotonicExpressions(undefined)).toEqual([]);
  });
});

describe("systemd timestamps", () => {
  test("systemd 257's pretty UTC form is converted", () => {
    expect(parseSystemdTime("Sat 2026-09-19 02:30:00 UTC").at).toBe("2026-09-19T02:30:00.000Z");
  });

  test("the pre-250 microsecond form is converted too", () => {
    expect(parseSystemdTime("1789790400000000").at).toBe("2026-09-19T04:00:00.000Z");
  });

  test("never is never, in both spellings", () => {
    expect(parseSystemdTime("").at).toBeUndefined();
    expect(parseSystemdTime("0").at).toBeUndefined();
    expect(parseSystemdTime(undefined).at).toBeUndefined();
  });

  test("infinity and a duration are passed through as text, not turned into 1970", () => {
    expect(parseSystemdTime("infinity")).toEqual({ raw: "infinity" });
    expect(parseSystemdTime("6d 18h 50min 33.481175s")).toEqual({
      raw: "6d 18h 50min 33.481175s",
    });
  });

  test("a non-UTC zone is reported rather than guessed at", () => {
    const read = parseSystemdTime("Sat 2026-09-19 03:44:13 EDT");
    expect(read.at).toBeUndefined();
    expect(read.raw).toBe("Sat 2026-09-19 03:44:13 EDT");
    expect(read.note).toContain("EDT");
  });
});

describe("systemd entries", () => {
  const entries = systemdEntries(parseShowBlocks(LINUX_SHOW_MULTI_ONCALENDAR), "user");

  test("the unit name is the id and the source is named", () => {
    expect(entries.length).toBe(1);
    expect(entries[0]?.id).toBe("backup.timer");
    expect(entries[0]?.idKind).toBe("systemd-unit");
    expect(entries[0]?.source).toBe("systemd");
  });

  test("both OnCalendar expressions survive into the schedule", () => {
    expect(entries[0]?.schedule.grammar).toBe("systemd-oncalendar");
    expect(entries[0]?.schedule.expression).toBe("Mon *-*-* 09:00:00 ; *-*-* 02:30:00");
    expect(entries[0]?.schedule.note).toContain("union");
  });

  test("the next run is systemd's own, marked as reported rather than computed", () => {
    expect(entries[0]?.nextRun).toEqual({ at: "2026-09-19T02:30:00.000Z", source: "reported" });
  });

  test("a timer that has never fired reports no last run", () => {
    expect(entries[0]?.lastRun).toBeUndefined();
  });

  test("enabled reflects the unit FILE state, and the active state is separate", () => {
    expect(entries[0]?.enabled).toBe(true);
    expect(entries[0]?.state).toBe("active");
    expect(entries[0]?.definitionPath).toBe("/etc/systemd/system/backup.timer");
    expect(entries[0]?.command).toBe("activates backup.service");
  });

  test("a monotonic timer says the next elapse is measured from boot", () => {
    const mono = systemdEntries(parseShowBlocks(LINUX_SHOW_MONOTONIC_AND_INACTIVE), "system");
    const clean = mono.find((entry) => entry.id === "systemd-tmpfiles-clean.timer");
    expect(clean?.schedule.grammar).toBe("systemd-monotonic");
    expect(clean?.nextRun).toBeUndefined();
    expect(clean?.notes?.some((note) => note.includes("monotonic"))).toBe(true);
    // UnitFileState=static is not a no. This unit is ACTIVE in the same
    // captured block, and answering `enabled: false` next to that is a
    // contradiction a caller has to resolve; `enabled` is left off instead
    // and the raw word is reported.
    expect(clean?.enabled).toBeUndefined();
    expect(clean?.state).toBe("active");
    expect(clean?.notes?.some((note) => note.includes("UnitFileState=static"))).toBe(true);
  });

  test("an inactive timer whose next elapse is (null) reports no next run", () => {
    const entries = systemdEntries(parseShowBlocks(LINUX_SHOW_MONOTONIC_AND_INACTIVE), "system");
    const fstrim = entries.find((entry) => entry.id === "fstrim.timer");
    expect(fstrim?.state).toBe("inactive");
    expect(fstrim?.nextRun).toBeUndefined();
    expect(fstrim?.schedule.expression).toBe("Mon *-*-* 00:00:00");
  });

  test("the older microsecond form produces both a next and a last run", () => {
    const legacy = systemdEntries(parseShowBlocks(LINUX_SHOW_OLD_USEC_FORM), "system")[0];
    expect(legacy?.nextRun?.at).toBe("2026-09-19T04:00:00.000Z");
    expect(legacy?.lastRun).toBe("2026-09-18T04:00:00.000Z");
  });

  test("the fingerprint survives the timer firing", () => {
    // The fingerprint is a caller's proof that the thing they are deleting is
    // the thing they were shown. Hashing the whole `show` block makes it move
    // every time the timer fires — `CronDelete` then refuses a correct delete
    // with "it changed since it was listed", which is false: the definition
    // did not change, only the clock did.
    const fired = LINUX_SHOW_MULTI_ONCALENDAR.replace(
      "LastTriggerUSec=",
      "LastTriggerUSec=Fri 2026-09-18 02:30:00 UTC",
    )
      .replace(
        "NextElapseUSecRealtime=Sat 2026-09-19 02:30:00 UTC",
        "NextElapseUSecRealtime=Sun 2026-09-20 02:30:00 UTC",
      )
      .replace("next_elapse=Sat 2026-09-19 02:30:00 UTC", "next_elapse=Sun 2026-09-20 02:30:00 UTC")
      .replace("ActiveState=active", "ActiveState=activating");
    const after = systemdEntries(parseShowBlocks(fired), "user");
    expect(after[0]?.fingerprint).toBe(entries[0]?.fingerprint as string);
    // …and a real edit to the schedule still moves it.
    const rescheduled = systemdEntries(
      parseShowBlocks(LINUX_SHOW_MULTI_ONCALENDAR.replace("*-*-* 02:30:00", "*-*-* 04:30:00")),
      "user",
    );
    expect(rescheduled[0]?.fingerprint).not.toBe(entries[0]?.fingerprint as string);
  });

  test("the fingerprint does not depend on the order systemctl printed the properties", () => {
    // A `show` block is a map built from the host's output order. Hashing
    // `JSON.stringify` of it hashes that order as well as the content.
    const reordered = parseShowBlocks(LINUX_SHOW_MULTI_ONCALENDAR)
      .map((block) =>
        Object.fromEntries(Object.entries(block).sort(([a], [b]) => (a < b ? 1 : -1))),
      )
      .map((block) => block as Record<string, string>);
    expect(systemdEntries(reordered, "user")[0]?.fingerprint).toBe(
      entries[0]?.fingerprint as string,
    );
  });

  test("UnitFileState answers enabled only when it is a yes or a no", () => {
    expect(enablement("enabled").enabled).toBe(true);
    expect(enablement("enabled-runtime").enabled).toBe(true);
    expect(enablement("enabled-runtime").note).toContain("until the next boot");
    expect(enablement("disabled").enabled).toBe(false);
    expect(enablement("masked").enabled).toBe(false);
    // `static` has no [Install] section at all, and an EMPTY value is systemd
    // declining to answer. Both became a definite `false` before.
    expect(enablement("static").enabled).toBeUndefined();
    expect(enablement("static").note).toContain("UnitFileState=static");
    expect(enablement("").enabled).toBeUndefined();
    expect(enablement("").note).toContain("could not be determined");
    expect(enablement(undefined).enabled).toBeUndefined();
  });

  test("a unit systemd reports no file state for does not claim to be disabled", () => {
    const transient = systemdEntries(
      parseShowBlocks(
        LINUX_SHOW_MULTI_ONCALENDAR.replace("UnitFileState=enabled", "UnitFileState="),
      ),
      "user",
    );
    expect(transient[0]?.enabled).toBeUndefined();
    expect(transient[0]?.notes?.some((note) => note.includes("could not be determined"))).toBe(
      true,
    );
  });

  test("a block that is not a timer is skipped", () => {
    expect(systemdEntries(parseShowBlocks("Id=sshd.service\n"), "system")).toEqual([]);
  });
});

describe("why systemctl could not answer", () => {
  test("not booted with systemd is its own answer", () => {
    expect(systemctlUnavailableReason(LINUX_SYSTEMCTL_NOT_BOOTED_STDERR, 1)).toContain(
      "not this machine's init system",
    );
  });

  test("both real user-bus failures are recognised", () => {
    // The wording is "Failed to connect to USER SCOPE bus…" — a pattern
    // matching "Failed to connect to bus" misses every one of them.
    expect(systemctlUnavailableReason(LINUX_SYSTEMCTL_NO_BUS_ENV_STDERR, 1)).toContain(
      "could not reach the bus",
    );
    expect(systemctlUnavailableReason(LINUX_SYSTEMCTL_NO_BUS_FILE_STDERR, 1)).toContain(
      "could not reach the bus",
    );
  });

  test("any other non-zero exit is reported in systemd's own words", () => {
    expect(systemctlUnavailableReason(LINUX_DISABLE_MISSING_STDERR, 1)).toBe(
      "Failed to disable unit: Unit nosuch.timer does not exist",
    );
    expect(systemctlUnavailableReason("", 4)).toBe("systemctl exited 4");
  });

  test("a clean run is not a failure", () => {
    expect(systemctlUnavailableReason("", 0)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// selection, ordering and argument safety
// ---------------------------------------------------------------------------

function entry(id: string, command: string, source: JobEntry["source"] = "crontab"): JobEntry {
  return {
    source,
    id,
    idKind: "crontab-line",
    fingerprint: fingerprint(`${id}|${command}`),
    schedule: { grammar: "cron5", expression: "0 3 * * *" },
    command,
  };
}

describe("selecting what to delete", () => {
  const entries = [
    entry("line:3", "/usr/local/bin/backup.sh --full"),
    entry("line:4", "/usr/local/bin/backup.sh --incremental"),
    entry("line:5", "/usr/local/bin/rotate.sh"),
  ];

  test("no selector is refused rather than treated as all", () => {
    const result = selectEntries(entries, {}, false);
    expect(result.ok).toBe(false);
    expect(!result.ok ? result.reason : "").toBe("no-selector");
  });

  test("two selectors are refused as two intentions", () => {
    const result = selectEntries(entries, { id: "line:3", match: "rotate" }, false);
    expect(!result.ok ? result.reason : "").toBe("both-selectors");
  });

  test("an exact id selects exactly one", () => {
    const result = selectEntries(entries, { id: "line:4" }, false);
    expect(result.ok && result.entries.length).toBe(1);
    expect(result.ok && result.entries[0]?.id).toBe("line:4");
  });

  test("an id that is not there says so, and mentions that line numbers move", () => {
    const result = selectEntries(entries, { id: "line:99" }, false);
    expect(!result.ok ? result.reason : "").toBe("not-found");
    expect(!result.ok ? result.message : "").toContain("moves");
  });

  test("a substring that matches twice REFUSES and lists both", () => {
    // The whole point of the tool's ambiguity rule: deleting somebody's
    // second backup job because a pattern matched twice is not recoverable.
    const result = selectEntries(entries, { match: "backup.sh" }, false);
    expect(!result.ok ? result.reason : "").toBe("ambiguous");
    expect(!result.ok ? (result.candidates?.length ?? 0) : 0).toBe(2);
  });

  test("allowMultiple is what turns that into an instruction", () => {
    const result = selectEntries(entries, { match: "backup.sh" }, true);
    expect(result.ok && result.entries.length).toBe(2);
  });

  test("matching is case-insensitive and covers the command", () => {
    const result = selectEntries(entries, { match: "ROTATE" }, false);
    expect(result.ok && result.entries[0]?.id).toBe("line:5");
  });

  test("nothing matched is an error, not a quiet success", () => {
    const result = selectEntries(entries, { match: "nothing-like-this" }, false);
    expect(!result.ok ? result.reason : "").toBe("not-found");
  });

  test("a stale fingerprint refuses and names both hashes", () => {
    const result = selectEntries(entries, { id: "line:3", fingerprint: "000000000000" }, false);
    expect(!result.ok ? result.reason : "").toBe("fingerprint-mismatch");
    expect(!result.ok ? result.message : "").toContain("000000000000");
    expect(!result.ok ? result.message : "").toContain("nothing was deleted");
  });

  test("a matching fingerprint lets the delete through", () => {
    const target = entries[0] as JobEntry;
    const result = selectEntries(
      entries,
      { id: target.id, fingerprint: target.fingerprint },
      false,
    );
    expect(result.ok).toBe(true);
  });

  test("a fingerprint cannot pin a multi-entry selection", () => {
    const result = selectEntries(entries, { match: "backup.sh", fingerprint: "abc123" }, true);
    expect(!result.ok ? result.reason : "").toBe("fingerprint-mismatch");
  });
});

describe("ordering and argument safety", () => {
  test("entries sort by source, then line, then id", () => {
    const unsorted: JobEntry[] = [
      { ...entry("line:9", "b"), line: 9 },
      { ...entry("com.example.a", "a", "launchd"), idKind: "launchd-label" },
      { ...entry("line:2", "c"), line: 2 },
    ];
    expect([...unsorted].sort(byEntry).map((item) => item.id)).toEqual([
      "line:2",
      "line:9",
      "com.example.a",
    ]);
  });

  test("an argument that would be read as a flag is refused", () => {
    // This repo has already shipped `gitBranchCreate({name:"-D"})` running
    // `git branch -D victim`; the same shape is refused here.
    expect(checkArgument("a label", "-D")).toContain("starts with");
    expect(checkArgument("a label", "--force")).toContain("starts with");
  });

  test("NUL, newlines and emptiness are refused", () => {
    expect(checkArgument("a unit name", "a\0b")).toContain("NUL");
    expect(checkArgument("a unit name", "a\nb")).toContain("newline");
    expect(checkArgument("a unit name", "")).toContain("empty");
  });

  test("an ordinary label or unit name passes", () => {
    expect(checkArgument("a label", "com.example.backup")).toBeUndefined();
    expect(checkArgument("a unit name", "backup.timer")).toBeUndefined();
  });

  test("the child environment is pinned to C and UTC and forwards only what is needed", () => {
    // systemd prints timestamps in the caller's zone — captured: TZ=America/
    // New_York turns "07:44:13 UTC" into "03:44:13 EDT" — so the zone is
    // pinned rather than inherited.
    const env = buildEnv({ PATH: "/usr/bin", HOME: "/home/alice", AWS_SECRET_KEY: "leak-me" });
    expect(env["TZ"]).toBe("UTC");
    expect(env["LC_ALL"]).toBe("C");
    expect(env["AWS_SECRET_KEY"]).toBeUndefined();
    expect(env["HOME"]).toBe("/home/alice");
    expect(env["SYSTEMD_PAGER"]).toBe("");
  });

  test("a missing PATH falls back rather than leaving the child with none", () => {
    expect(buildEnv({}).PATH).toContain("/usr/bin");
  });

  test("the user bus variables are forwarded, or systemctl --user cannot work", () => {
    const env = buildEnv({ XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:x" });
    expect(env["XDG_RUNTIME_DIR"]).toBe("/run/user/1000");
    expect(env["DBUS_SESSION_BUS_ADDRESS"]).toBe("unix:x");
  });
});
