/**
 * Recorded output, and where each line came from.
 *
 * Nothing in this package's suite asks the machine it runs on. CI is a Linux
 * container with no desktop at all, this was written on macOS, and a parser
 * checked against whatever the test host happens to answer is a parser
 * checked against nothing. So every classifier is fed from here.
 *
 * Each constant says whether it was RECORDED (somebody ran the command and
 * pasted the bytes) or DOCUMENTED (written from the program's source or
 * manual because nobody here has that platform). The distinction is kept
 * deliberately: a documented fixture proves the parser handles the shape it
 * was told about, and claims nothing more.
 */

// ---------------------------------------------------------------------------
// clipboard — Linux, RECORDED on Debian 12 / xclip 0.13
// ---------------------------------------------------------------------------

/** No X server at all. Exit 1, empty stdout. */
export const XCLIP_NO_DISPLAY_STDERR = "Error: Can't open display: (null)\n";

/**
 * A reachable display with nothing on the selection. Exit 1, empty stdout —
 * the SAME exit code and the SAME empty stdout as the line above, and the
 * opposite meaning. This pair is why `classifyClipboardRead` reads stderr.
 */
export const XCLIP_EMPTY_SELECTION_STDERR = "Error: target STRING not available\n";

/** The happy path. */
export const XCLIP_TEXT_STDOUT = "ssh-rsa AAAAB3NzaC1yc2EA... deploy@example\n";

// ---------------------------------------------------------------------------
// clipboard — macOS, RECORDED on macOS 26.6.2
// ---------------------------------------------------------------------------

/** `clipboard info` against an EMPTY pasteboard: empty stdout, exit 0. */
export const CLIPBOARD_INFO_EMPTY_STDOUT = "";

/**
 * `clipboard info` with a screenshot on the pasteboard: flavour names and
 * byte counts, and no content. This is what tells "empty" from "there is
 * something here pbpaste cannot give you".
 */
export const CLIPBOARD_INFO_IMAGE_STDOUT =
  "«class PNGf», 284913, «class 8BPS», 1049928, TIFF picture, 1063968";

// ---------------------------------------------------------------------------
// notifications — Linux, RECORDED on Debian 12 / libnotify 0.8.1
// ---------------------------------------------------------------------------

export const NOTIFY_SEND_NO_BUS_STDERR = "Cannot autolaunch D-Bus without X11 $DISPLAY\n";

/**
 * The argument-injection this package's `--` exists to prevent: with the
 * summary passed as a bare positional, `-u` was consumed as the urgency flag
 * and the body became its argument.
 */
export const NOTIFY_SEND_FLAG_INJECTION_STDERR = "Unknown urgency body specified\n";

// ---------------------------------------------------------------------------
// AppleScript — RECORDED on macOS 26.6.2 with Accessibility NOT granted
// ---------------------------------------------------------------------------

export const OSASCRIPT_NO_ACCESSIBILITY_STDERR =
  "44:87: execution error: System Events got an error: osascript is not allowed assistive access. (-25211)\n";

/** The OTHER grant, in a different System Settings pane. */
export const OSASCRIPT_NO_AUTOMATION_STDERR =
  "48:52: execution error: Not authorized to send Apple events to System Events. (-1743)\n";

// ---------------------------------------------------------------------------
// windows — DOCUMENTED (wmctrl 1.07 output format)
// ---------------------------------------------------------------------------

/**
 * `wmctrl -l -G -p -x`. Nine fixed columns then a title with spaces in it;
 * the second row's title repeats a column's text on purpose, because a parser
 * that re-joins the split fields gets that one wrong.
 */
export const WMCTRL_STDOUT = [
  "0x03c00003  0 2841   64   27   1280 800  Navigator.firefox     buildbox  Mozilla Firefox",
  "0x04200005  0 3120   0    0    2560 1440 gnome-terminal-server.Gnome-terminal  buildbox  0x04200005 build log",
  "0x05000007 -1 4001   200  180  900  600  code.Code             buildbox  index.ts - factory",
].join("\n");

// ---------------------------------------------------------------------------
// presence — RECORDED on macOS 26.6.2, screen locked, ~54 minutes idle
// ---------------------------------------------------------------------------

/**
 * `ioreg -r -c IOHIDSystem -d 1`. NANOSECONDS: 3_254_341_351_000 ns is 3254
 * seconds. Reading it as milliseconds would report 3254 seconds of idleness
 * as three, and make a locked machine look freshly used.
 *
 * The `-r` matters as much as the unit. `ioreg -c IOHIDSystem -d 1` — the
 * form the survey sketch gave — prints this key NOWHERE on this OS version,
 * because without `-r` the depth is measured from the root.
 */
export const IOREG_HIDIDLE_STDOUT = [
  "+-o IOHIDSystem  <class IOHIDSystem, id 0x1000005b6, registered, matched, active>",
  "  | {",
  '  |   "IOClass" = "IOHIDSystem"',
  '  |   "HIDIdleTime" = 3254341351000',
  '  |   "IOProviderClass" = "IOResources"',
  "  | }",
].join("\n");

/** The same machine, `ioreg -n Root -d1`, with the screen locked. */
export const IOREG_ROOT_LOCKED_STDOUT = [
  '      "IOConsoleLocked" = Yes',
  '      "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionIDKey"=257,"CGSSessionScreenIsLocked"=Yes,"kCGSSessionUserIDKey"=506})',
].join("\n");

/** An unlocked console, same keys. */
export const IOREG_ROOT_UNLOCKED_STDOUT = [
  '      "IOConsoleLocked" = No',
  '      "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"CGSSessionScreenIsLocked"=No})',
].join("\n");

/** A macOS version that reports lock state somewhere this parser cannot see. */
export const IOREG_ROOT_NO_LOCK_KEY_STDOUT = '      "IORegistryPlanes" = {"IOService"="IOService"}';

/** DOCUMENTED: `loginctl show-session self -p LockedHint -p Type -p Active`. */
export const LOGINCTL_STDOUT = "LockedHint=no\nType=x11\nActive=yes\n";

/** DOCUMENTED: the Windows presence script's two lines. */
export const WINDOWS_PRESENCE_STDOUT = "idleMs=42000\nlocked=no\n";

// ---------------------------------------------------------------------------
// printing — RECORDED on macOS 26.6.2, CUPS 2.4
// ---------------------------------------------------------------------------

/**
 * `lpstat -p -d`, verbatim. Two printers in two DIFFERENT sentence shapes,
 * an INDENTED continuation line that belongs to the row above it, and the
 * default-destination line.
 */
export const LPSTAT_STDOUT = [
  "printer Canon_MX490_series is idle.  enabled since Sun Jul 26 10:59:45 2026",
  "printer Canon_TS5300_series now printing Canon_TS5300_series-33.  enabled since Sat Sep 12 00:00:20 2026",
  "\tLooking for printer.",
  "system default destination: Canon_MX490_series",
].join("\n");

/**
 * A host whose scheduler is down. It lists NOTHING, which reads exactly like
 * a host with no printers — the rule-6 case this fixture exists for.
 */
export const LPSTAT_NO_SCHEDULER_STDERR = "lpstat: Scheduler is not running.\n";

/** DOCUMENTED: `lp` answers with prose and the job id is inside it. */
export const LP_REQUEST_ID_STDOUT = "request id is Canon_MX490_series-34 (1 file(s))\n";

// ---------------------------------------------------------------------------
// power — DOCUMENTED (`ps -o command= -p <pid>`)
// ---------------------------------------------------------------------------

export const PS_CAFFEINATE_STDOUT = "caffeinate -i -m -t 1800\n";
/** The same pid, now owned by something else entirely. */
export const PS_REUSED_PID_STDOUT = "/usr/sbin/cupsd -l\n";
