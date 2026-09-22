import { expect, test } from "bun:test";
/**
 * The parser halves, driven from `./fixtures.ts`.
 *
 * Nothing here asks the machine the suite is running on: CI is a Linux
 * container with no desktop, this was written on macOS, and a parser checked
 * against whatever the test host happens to answer is a parser checked
 * against nothing.
 *
 * It also holds the one guard that is about this package's SOURCE rather than
 * its behaviour — see `no source file in this package contains a raw control
 * byte`, which exists because that defect has now been introduced here twice.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CLIPBOARD_INFO_EMPTY_STDOUT,
  CLIPBOARD_INFO_IMAGE_STDOUT,
  IOREG_HIDIDLE_STDOUT,
  IOREG_ROOT_LOCKED_STDOUT,
  IOREG_ROOT_NO_LOCK_KEY_STDOUT,
  IOREG_ROOT_UNLOCKED_STDOUT,
  LOGINCTL_STDOUT,
  LPSTAT_NO_SCHEDULER_STDERR,
  LPSTAT_STDOUT,
  LP_REQUEST_ID_STDOUT,
  OSASCRIPT_NO_ACCESSIBILITY_STDERR,
  OSASCRIPT_NO_AUTOMATION_STDERR,
  WINDOWS_PRESENCE_STDOUT,
  WMCTRL_STDOUT,
  XCLIP_EMPTY_SELECTION_STDERR,
  XCLIP_NO_DISPLAY_STDERR,
  XCLIP_TEXT_STDOUT,
} from "./fixtures";
import { HEADLESS_ENV, linuxSession } from "./host";
import { classifyClipboardInfo, classifyClipboardRead } from "./lib/clipboard";
import {
  SAFE_DESTINATION,
  SAFE_PAGE_RANGES,
  UnregisteredScriptError,
  escapeXmlText,
  looksLikeFlag,
  osascriptArgv,
  osascriptPermissionReason,
  osascriptProgramText,
  powershellArgv,
  stripXmlIllegalChars,
} from "./lib/escape";
import { buildToastXml, classifyNotify } from "./lib/notify";
import { classifyTarget, uriScheme } from "./lib/open";
import { boundedSeconds, classifyLiveness } from "./lib/power";
import {
  parseIoregIdleSeconds,
  parseIoregLocked,
  parseLoginctl,
  parseWindowsPresence,
  parseXprintidleSeconds,
} from "./lib/presence";
import { classifyPrint, parseJobId, parseQueues } from "./lib/print";
import { parseWmctrl } from "./lib/windows";
import { assertArgv } from "./run";

const FAILED = { code: 1, stdout: "", stderr: "", timedOut: false, missing: false };

// ---------------------------------------------------------------------------
// the source guard
// ---------------------------------------------------------------------------

test("no source file in this package contains a raw control byte", () => {
  // House rule 13, as a check rather than as a habit. Both the interrupted
  // groundwork AND this session's first rewrite of ./lib/escape.ts shipped a
  // character class written with LITERAL 0x00/0x08/0x0B/0x0C/0x0E/0x1F/0x7F
  // bytes instead of `\u` escapes: `file(1)` called the source "data", grep
  // refused to search it, and — the part that actually breaks a build — bun
  // 1.3.11 on CI rejects such a class as "range out of order" while the
  // 1.3.14 used for development accepts it.
  const root = import.meta.dir;
  const offenders: string[] = [];
  let scanned = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      scanned += 1;
      const bytes = readFileSync(path);
      for (const byte of bytes) {
        // TAB, LF and CR are the legal ones in a source file.
        if (byte < 0x09 || byte === 0x0b || byte === 0x0c || (byte >= 0x0e && byte <= 0x1f)) {
          offenders.push(`${entry.name}: 0x${byte.toString(16).padStart(2, "0")}`);
          break;
        }
      }
    }
  };
  walk(root);
  console.log(`SOURCE_SCAN files=${scanned} offenders=${offenders.length} ${offenders.join(", ")}`);
  expect(offenders).toEqual([]);
  // The guard asserts its own hit count. A scanner that walked the wrong
  // directory would otherwise report a clean package forever — this repo has
  // shipped a vacuous drift guard twice for exactly that reason.
  expect(scanned).toBeGreaterThan(10);
});

// ---------------------------------------------------------------------------
// escape.ts
// ---------------------------------------------------------------------------

test("osascript argv keeps every caller value out of the compiled statements", () => {
  const script = { name: "forged", lines: ['display dialog "x"'], arity: 0 };
  // An unregistered script cannot be run at all: source in this package is a
  // frozen module constant, never assembled at call time.
  expect(() => osascriptArgv(script as never)).toThrow(UnregisteredScriptError);
});

test("the XML escaper neutralises a payload that would restructure the document", () => {
  const hostile = "</toast><toast launch=\"x\"><text>pwned</text></toast> & 'q'";
  const escaped = escapeXmlText(hostile);
  console.log(`ESCAPED ${escaped}`);
  for (const raw of ["<", ">", '"', "'"]) expect(escaped).not.toContain(raw);
  // `&` survives only as the head of an entity, never on its own.
  expect(/&(?!(amp|lt|gt|quot|apos);)/.test(escaped)).toBe(false);
  const doc = buildToastXml({ title: hostile, body: hostile, sound: false });
  expect(doc.xml.match(/<toast>/g)?.length).toBe(1);
  expect(doc.xml.endsWith("</toast>")).toBe(true);
});

test("characters XML cannot carry are dropped and the drop is reported", () => {
  const control = "a\u0000b\u0008c\u001Fd";
  const stripped = stripXmlIllegalChars(control);
  console.log(`STRIPPED ${JSON.stringify(stripped)}`);
  expect(stripped.text).toBe("abcd");
  expect(stripped.removed).toBe(3);
  // TAB, LF and CR are LEGAL in XML 1.0 and must survive.
  expect(stripXmlIllegalChars("a\tb\nc\rd")).toEqual({ text: "a\tb\nc\rd", removed: 0 });
  // A lone surrogate is not a character; LoadXml throws on one.
  expect(stripXmlIllegalChars("a\uD800b").removed).toBe(1);
  // ...and a well-formed pair is left alone.
  expect(stripXmlIllegalChars("a\uD83D\uDE00b")).toEqual({ text: "a\uD83D\uDE00b", removed: 0 });
  // A sanitized toast says so rather than quietly showing something else.
  const doc = buildToastXml({ title: "a\u0001b", body: "ok", sound: false });
  expect(doc.sanitized).toBe(true);
  expect(doc.removedChars).toBe(1);
});

test("an AppleScript permission failure is told apart from a broken script", () => {
  const accessibility = osascriptPermissionReason(OSASCRIPT_NO_ACCESSIBILITY_STDERR);
  const automation = osascriptPermissionReason(OSASCRIPT_NO_AUTOMATION_STDERR);
  console.log(`PERMISSION ${accessibility} | ${automation}`);
  // Two DIFFERENT grants in two DIFFERENT System Settings panes; telling a
  // user to open the wrong one is a support ticket.
  expect(accessibility).toMatch(/Accessibility/);
  expect(automation).toMatch(/Automation/);
  // A genuine script error is NOT a permission problem.
  expect(
    osascriptPermissionReason(
      "12:20: execution error: System Events got an error: Can't get window 1. (-1728)",
    ),
  ).toMatch(/Accessibility/);
  expect(osascriptPermissionReason("syntax error: Expected end of line. (-2741)")).toBeUndefined();
  expect(osascriptPermissionReason("")).toBeUndefined();
});

test("a powershell argv may only carry a registered script and its declared env", () => {
  const forged = { name: "forged", script: "Remove-Item C:\\", reads: [] };
  expect(() => powershellArgv(forged as never, {})).toThrow(UnregisteredScriptError);
});

test("argv hygiene refuses what execve could not carry, and every escalation", () => {
  expect(assertArgv([])).toMatch(/argv\[0\]/);
  expect(assertArgv(["sh", "-c", "id"])).toMatch(/never runs a shell/);
  expect(assertArgv(["/bin/bash", "-c", "id"])).toMatch(/never runs a shell/);
  expect(assertArgv(["xargs", "id"])).toMatch(/never runs a shell/);
  expect(assertArgv(["pbpaste", "a\u0000b"])).toMatch(/NUL/);
  // Rule 7, structurally: as argv[0] AND as any later element, because
  // `systemd-inhibit sudo …` is the same escalation one position over.
  expect(assertArgv(["sudo", "lp"])).toMatch(/never escalates/);
  expect(assertArgv(["systemd-inhibit", "--mode=block", "sudo", "sleep"])).toMatch(
    /never escalates/,
  );
  expect(assertArgv(["/usr/bin/pkexec", "x"])).toMatch(/never escalates/);
  // ...and the things this package legitimately runs are allowed through.
  for (const argv of [
    ["osascript", "-e", "on run argv"],
    ["powershell.exe", "-NoProfile", "-Command", "Get-Clipboard"],
    ["systemd-inhibit", "--mode=block", "sleep", "60"],
    ["kill", "-TERM", "4242"],
  ]) {
    expect({ argv: argv[0], refusal: assertArgv(argv) }).toEqual({
      argv: argv[0],
      refusal: undefined,
    });
  }
});

test("a value that a program would read as an option is recognised", () => {
  expect(looksLikeFlag("-rf")).toBe(true);
  expect(looksLikeFlag("--")).toBe(true);
  expect(looksLikeFlag("file.pdf")).toBe(false);
  expect(SAFE_DESTINATION.test("Canon_MX490_series")).toBe(true);
  expect(SAFE_DESTINATION.test("-d")).toBe(false);
  expect(SAFE_DESTINATION.test("a b")).toBe(false);
  expect(SAFE_DESTINATION.test("a/b")).toBe(false);
  expect(SAFE_PAGE_RANGES.test("1,3,5-9")).toBe(true);
  expect(SAFE_PAGE_RANGES.test("1-4")).toBe(true);
  expect(SAFE_PAGE_RANGES.test("-1")).toBe(false);
  expect(SAFE_PAGE_RANGES.test("1 2")).toBe(false);
});

// ---------------------------------------------------------------------------
// clipboard
// ---------------------------------------------------------------------------

test("the two xclip failures that look identical are told apart by stderr", () => {
  const noDisplay = classifyClipboardRead({ ...FAILED, stderr: XCLIP_NO_DISPLAY_STDERR });
  const empty = classifyClipboardRead({ ...FAILED, stderr: XCLIP_EMPTY_SELECTION_STDERR });
  const read = classifyClipboardRead({ ...FAILED, code: 0, stdout: XCLIP_TEXT_STDOUT });
  console.log(`XCLIP ${JSON.stringify({ noDisplay, empty, read })}`);
  // Same exit code, same empty stdout, opposite meanings.
  expect(noDisplay.outcome).toBe("unavailable");
  expect(empty.outcome).toBe("empty");
  expect(read.outcome).toBe("read");
});

test("the macOS flavour probe tells an empty pasteboard from an image on it", () => {
  expect(classifyClipboardInfo(CLIPBOARD_INFO_EMPTY_STDOUT)).toBe("empty");
  expect(classifyClipboardInfo(CLIPBOARD_INFO_IMAGE_STDOUT)).toBe("noTextFlavour");
});

test("a notifier with no session bus is unavailable, not a failed notification", () => {
  const noBus = classifyNotify({
    ...FAILED,
    stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY",
  });
  console.log(`NOTIFY_NOBUS ${JSON.stringify(noBus)}`);
  expect(noBus.outcome).toBe("unavailable");
  expect(classifyNotify({ ...FAILED, code: 0 }).outcome).toBe("dispatched");
  expect(classifyNotify({ ...FAILED, missing: true }).outcome).toBe("unavailable");
});

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

test("a Windows drive path is not mistaken for a URI scheme", () => {
  expect(uriScheme("https://example.com")).toBe("https");
  expect(uriScheme("MAILTO:a@b.c")).toBe("mailto");
  expect(uriScheme("ms-settings:privacy")).toBe("ms-settings");
  // `C:\Users\x` matches RFC 3986's scheme production exactly; treating it as
  // a `c:` URL would refuse every absolute Windows path with a baffling error.
  expect(uriScheme("C:\\Users\\bots\\a.pdf")).toBeUndefined();
  expect(uriScheme("C:/Users/bots/a.pdf")).toBeUndefined();
  expect(uriScheme("report.pdf")).toBeUndefined();
  expect(uriScheme("./a/b.txt")).toBeUndefined();
});

test("the scheme gate accepts three and names its refusals", () => {
  const all = ["https", "http", "mailto"] as const;
  expect(classifyTarget("https://example.com", all).ok).toBe(true);
  expect(classifyTarget("mailto:a@b.c", all).ok).toBe(true);
  for (const bad of ["file:///etc/passwd", "smb://h/s", "ms-settings:x", "javascript:alert(1)"]) {
    const out = classifyTarget(bad, all);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain(":");
  }
  // A URL this parser cannot make sense of never reaches the OS parser.
  expect(classifyTarget("https://", all).ok).toBe(false);
  // Control characters are refused before anything else looks at the value.
  expect(classifyTarget("https://example.com/\u0000x", all).ok).toBe(false);
  expect(classifyTarget("https://example.com/\nx", all).ok).toBe(false);
});

// ---------------------------------------------------------------------------
// printing
// ---------------------------------------------------------------------------

test("lpstat prose parses, including the indented continuation line", () => {
  const queues = parseQueues(LPSTAT_STDOUT, "");
  console.log(`QUEUES ${JSON.stringify(queues)}`);
  expect(queues.printers.map((p) => p.name)).toEqual(["Canon_MX490_series", "Canon_TS5300_series"]);
  // Two different sentence shapes, both kept as prose rather than forced into
  // an enum a future CUPS version would not fit.
  expect(queues.printers[0]?.state).toBe("is idle");
  expect(queues.printers[1]?.state).toMatch(/^now printing/);
  expect(queues.defaultPrinter).toBe("Canon_MX490_series");
  expect(queues.schedulerDown).toBe(false);
});

test("a scheduler that is down is not a host with no printers", () => {
  const down = parseQueues("", LPSTAT_NO_SCHEDULER_STDERR);
  console.log(`SCHEDULER ${JSON.stringify(down)}`);
  expect(down.schedulerDown).toBe(true);
  expect(down.printers).toEqual([]);
  // A genuinely empty CUPS install: no printers AND no scheduler complaint.
  const none = parseQueues("no system default destination\n", "");
  expect(none.schedulerDown).toBe(false);
  expect(none.printers).toEqual([]);
  expect(none.defaultPrinter).toBeNull();
});

test("the job id is pulled out of prose and degrades to null, never to a guess", () => {
  expect(parseJobId(LP_REQUEST_ID_STDOUT)).toBe("Canon_MX490_series-34");
  expect(parseJobId("queued\n")).toBeNull();
  expect(parseJobId("")).toBeNull();
  const queued = classifyPrint({ ...FAILED, code: 0, stdout: LP_REQUEST_ID_STDOUT });
  expect(queued.outcome).toBe("queued");
  // What was actually established: the QUEUE took it. Not that it printed.
  if (queued.outcome === "queued") expect(queued.note).toMatch(/whether it printed/);
});

// ---------------------------------------------------------------------------
// windows
// ---------------------------------------------------------------------------

test("wmctrl columns parse, and a title that repeats a column survives", () => {
  const windows = parseWmctrl(WMCTRL_STDOUT);
  console.log(`WMCTRL ${JSON.stringify(windows)}`);
  expect(windows.length).toBe(3);
  expect(windows[0]?.app).toBe("firefox");
  expect(windows[0]?.title).toBe("Mozilla Firefox");
  expect(windows[0]?.width).toBe(1280);
  expect(windows[0]?.pid).toBe(2841);
  // The second row's title STARTS with its own window id. A parser that
  // re-joined the split fields, or that searched for the title by content,
  // loses this one.
  expect(windows[1]?.title).toBe("0x04200005 build log");
  // A sticky window's desktop is -1, which is not an error.
  expect(windows[2]?.title).toBe("index.ts - factory");
  // wmctrl reports neither, and null is not false: "nothing has focus" is
  // never true of a running X session.
  expect(windows[0]?.focused).toBeNull();
  expect(windows[0]?.minimized).toBeNull();
});

// ---------------------------------------------------------------------------
// presence
// ---------------------------------------------------------------------------

test("macOS idle time is read as NANOSECONDS", () => {
  const seconds = parseIoregIdleSeconds(IOREG_HIDIDLE_STDOUT);
  console.log(`IDLE ${seconds}s from 3254341351000ns`);
  // The unit error this asserts against is silent: reading the same number as
  // milliseconds gives 3254 seconds' idleness as 3.2, and every host looks
  // permanently active.
  expect(seconds).toBe(3254);
  expect(parseIoregIdleSeconds('  "IOClass" = "IOHIDSystem"')).toBeNull();
  expect(parseIoregIdleSeconds("")).toBeNull();
  // Past 2^53 nanoseconds (about 104 days) a float divide starts to lie.
  expect(parseIoregIdleSeconds('"HIDIdleTime" = 99999999999999999')).toBe(99_999_999);
});

test("macOS lock state comes back unknown when the registry does not carry it", () => {
  expect(parseIoregLocked(IOREG_ROOT_LOCKED_STDOUT)).toBe(true);
  expect(parseIoregLocked(IOREG_ROOT_UNLOCKED_STDOUT)).toBe(false);
  // The key is absent on a macOS version this parser has not seen. Guessing
  // "unlocked" would claim every such machine has a human looking at it.
  expect(parseIoregLocked(IOREG_ROOT_NO_LOCK_KEY_STDOUT)).toBeNull();
  // The nested key has no spaces around its `=`; the top-level one does.
  expect(parseIoregLocked('"CGSSessionScreenIsLocked"=Yes')).toBe(true);
});

test("the Linux and Windows presence parsers keep null distinct from false", () => {
  expect(parseXprintidleSeconds("900000\n")).toBe(900);
  expect(parseXprintidleSeconds("")).toBeNull();
  expect(parseXprintidleSeconds("bash: xprintidle: command not found")).toBeNull();
  const loginctl = parseLoginctl(LOGINCTL_STDOUT);
  console.log(`LOGINCTL ${JSON.stringify(loginctl)}`);
  expect(loginctl).toEqual({ locked: false, type: "x11", active: true });
  // A session that reports no LockedHint at all is unknown, not unlocked.
  expect(parseLoginctl("Type=tty\n").locked).toBeNull();
  const windows = parseWindowsPresence(WINDOWS_PRESENCE_STDOUT);
  expect(windows).toEqual({ idleSeconds: 42, locked: false });
  // The script prints `idleMs=?` when Add-Type threw; the lock line survives.
  expect(parseWindowsPresence("idleMs=?\nlocked=yes\n")).toEqual({
    idleSeconds: null,
    locked: true,
  });
});

test("a session with no display is a session that could not be reached", () => {
  expect(linuxSession(HEADLESS_ENV).kind).toBe("none");
  expect(linuxSession({ ...HEADLESS_ENV, DISPLAY: ":0" }).kind).toBe("x11");
  expect(
    linuxSession({
      ...HEADLESS_ENV,
      WAYLAND_DISPLAY: "wayland-0",
      XDG_RUNTIME_DIR: "/run/user/1000",
    }).kind,
  ).toBe("wayland");
  // Recorded: wl-paste prints "XDG_RUNTIME_DIR is invalid or not set in the
  // environment" here, so the compositor really is unreachable.
  expect(linuxSession({ ...HEADLESS_ENV, WAYLAND_DISPLAY: "wayland-0" }).kind).toBe(
    "wayland-unreachable",
  );
  // An EMPTY DISPLAY is not a display. Treating "" as set is how a headless
  // host gets classified as X11 and then blocks until its deadline.
  expect(linuxSession({ ...HEADLESS_ENV, DISPLAY: undefined }).kind).toBe("none");
});

// ---------------------------------------------------------------------------
// power
// ---------------------------------------------------------------------------

test("a hold is bounded, and the bound is refused rather than clamped", () => {
  expect(boundedSeconds(30)).toEqual({ seconds: 1800 });
  expect(boundedSeconds(0.5)).toEqual({ seconds: 30 });
  // Refused, not silently clamped: a caller who asked for 20 hours has a
  // wrong belief about what is running, and clamping leaves it in place.
  expect(boundedSeconds(1200)).toHaveProperty("refusal");
  expect(boundedSeconds(0)).toHaveProperty("refusal");
  expect(boundedSeconds(Number.NaN)).toHaveProperty("refusal");
});

test("liveness keeps four answers apart, so a reused pid is never signalled", () => {
  const probe = (over: Record<string, unknown>) => ({
    code: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    missing: false,
    ...over,
  });
  expect(classifyLiveness("caffeinate", probe({ stdout: "caffeinate -i -m -t 1800\n" }))).toBe(
    "alive",
  );
  // A pid that now belongs to something else. `ps` answered, and the answer
  // is "not ours" — killing it would take out an unrelated process.
  expect(classifyLiveness("caffeinate", probe({ stdout: "/usr/sbin/cupsd -l\n" }))).toBe("reused");
  expect(classifyLiveness("caffeinate", probe({ code: 1 }))).toBe("gone");
  // `ps` exiting non-zero and COMPLAINING is not `ps` saying the pid is gone.
  // Recorded on macOS 26.6.2: `ps -o command= -p 999999` exits 1 with an
  // empty stdout and "ps: process id too large" on stderr. Reading that as
  // "gone" makes release clear the record for a holder that may be running.
  expect(
    classifyLiveness("caffeinate", probe({ code: 1, stderr: "ps: process id too large\n" })),
  ).toBe("unknown");
  // The probe could not run. NOT "gone" — the holder may be alive and merely
  // unreachable, and forgetting it strands an inhibitor until its deadline.
  expect(classifyLiveness("caffeinate", probe({ timedOut: true }))).toBe("unknown");
  expect(classifyLiveness("caffeinate", probe({ missing: true }))).toBe("unknown");
  expect(classifyLiveness("caffeinate", probe({ refused: true }))).toBe("unknown");
});
