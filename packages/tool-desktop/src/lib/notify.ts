/**
 * DesktopNotify's backends.
 *
 * This is the tool the escaping rule was written for. On macOS the notifier
 * is a COMPILER: `osascript -e 'display notification "<body>"'` puts the
 * caller's body inside a string literal in a program, and one double quote in
 * it ends the literal and turns the rest into statements. On Windows the
 * payload is an XML DOCUMENT inside a PowerShell script, so `</toast>` and
 * `&` do the same job one layer over. Only Linux takes plain argv - and there
 * a summary beginning with `-` is still read as a flag.
 *
 * So: the AppleScript is four frozen constants that read `item N of argv`,
 * the toast XML is built and escaped in TypeScript and crosses to PowerShell
 * through the ENVIRONMENT, and every notify-send positional goes after `--`.
 * See ./escape.ts for why each of those is the shape it is.
 */
import type { SessionEnv } from "../host";
import { type HostPlatform, linuxDisplayEnv, linuxSession } from "../host";
import type { RunRequest } from "../run";
import {
  escapeXmlText,
  osascriptArgv,
  powershellArgv,
  registerAppleScript,
  registerPowerShellScript,
  stripXmlIllegalChars,
} from "./escape";
import { type Unavailable, unavailable, unsupportedPlatform } from "./outcome";

export type NotifyUrgency = "low" | "normal" | "critical";

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

/**
 * Four scripts rather than one built from flags.
 *
 * `display notification` has no runtime way to say "no subtitle" or "no
 * sound" - the clause is present in the source or it is not. Choosing between
 * four FROZEN constants keeps that decision out of string concatenation: a
 * boolean picks a script, it never edits one.
 *
 * The sound name is a fixed literal for the same reason. A caller-chosen
 * sound would have to be either an argv item (AppleScript cannot use a
 * variable in the `sound name` clause) or interpolated source, and the second
 * of those is the thing this package exists not to do.
 */
export const NOTIFY_PLAIN = registerAppleScript({
  name: "notify-plain",
  lines: ["display notification (item 2 of argv) with title (item 1 of argv)"],
  arity: 2,
});

export const NOTIFY_SUBTITLE = registerAppleScript({
  name: "notify-subtitle",
  lines: [
    "display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)",
  ],
  arity: 3,
});

export const NOTIFY_PLAIN_SOUND = registerAppleScript({
  name: "notify-plain-sound",
  lines: [
    'display notification (item 2 of argv) with title (item 1 of argv) sound name "Submarine"',
  ],
  arity: 2,
});

export const NOTIFY_SUBTITLE_SOUND = registerAppleScript({
  name: "notify-subtitle-sound",
  lines: [
    'display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv) sound name "Submarine"',
  ],
  arity: 3,
});

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/**
 * The AppUserModelID a toast is shown under.
 *
 * Windows refuses to display a toast from an unregistered AUMID, so this is
 * the shell's own PowerShell identity - the documented way to raise a toast
 * without installing a Start-menu shortcut first. It is a fixed literal and
 * never comes from a caller.
 */
export const WINDOWS_TOAST_APPID =
  "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

export const WINDOWS_TOAST_SCRIPT = registerPowerShellScript({
  name: "toast",
  script: [
    "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]",
    "$doc = New-Object Windows.Data.Xml.Dom.XmlDocument",
    "$doc.LoadXml($env:CREWHAUS_TOAST_XML)",
    "$toast = New-Object Windows.UI.Notifications.ToastNotification $doc",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:CREWHAUS_TOAST_APPID).Show($toast)",
  ].join("; "),
  reads: ["CREWHAUS_TOAST_XML", "CREWHAUS_TOAST_APPID"],
});

export type ToastDocument = {
  readonly xml: string;
  /**
   * True when characters XML 1.0 cannot carry at all were dropped. Reported
   * rather than silent: the operator asked for a particular message and got a
   * slightly different one.
   */
  readonly sanitized: boolean;
  readonly removedChars: number;
};

/**
 * Build the toast document, with every caller value escaped.
 *
 * The result crosses to PowerShell through the environment, so this escaping
 * is defence in depth rather than the only defence - but it is the part this
 * suite can prove, which is why it lives here and not in the script.
 */
export function buildToastXml(input: {
  readonly title: string;
  readonly body: string;
  readonly subtitle?: string;
  readonly sound: boolean;
}): ToastDocument {
  let removed = 0;
  const clean = (value: string): string => {
    const stripped = stripXmlIllegalChars(value);
    removed += stripped.removed;
    return escapeXmlText(stripped.text);
  };
  const lines = [clean(input.title), clean(input.body)];
  if (input.subtitle !== undefined) lines.push(clean(input.subtitle));
  const texts = lines.map((line) => `<text>${line}</text>`).join("");
  const audio = input.sound
    ? '<audio src="ms-winsoundevent:Notification.Default"/>'
    : '<audio silent="true"/>';
  return {
    xml: `<toast><visual><binding template="ToastGeneric">${texts}</binding></visual>${audio}</toast>`,
    sanitized: removed > 0,
    removedChars: removed,
  };
}

// ---------------------------------------------------------------------------
// the plan
// ---------------------------------------------------------------------------

export type NotifyPlan =
  | {
      readonly ok: true;
      readonly backend: string;
      readonly request: Omit<RunRequest, "timeoutMs">;
      readonly sanitized?: boolean;
    }
  | { readonly ok: false; readonly unavailable: Unavailable };

export function planNotify(
  platform: HostPlatform,
  env: SessionEnv,
  input: {
    readonly title: string;
    readonly body: string;
    readonly subtitle?: string;
    readonly urgency: NotifyUrgency;
    readonly sound: boolean;
    readonly expireMs?: number;
  },
): NotifyPlan {
  switch (platform) {
    case "darwin": {
      const hasSubtitle = input.subtitle !== undefined;
      const script = hasSubtitle
        ? input.sound
          ? NOTIFY_SUBTITLE_SOUND
          : NOTIFY_SUBTITLE
        : input.sound
          ? NOTIFY_PLAIN_SOUND
          : NOTIFY_PLAIN;
      const values = hasSubtitle
        ? [input.title, input.body, input.subtitle as string]
        : [input.title, input.body];
      return {
        ok: true,
        backend: "osascript display notification",
        request: { argv: osascriptArgv(script, values) },
      };
    }
    case "linux": {
      const session = linuxSession(env);
      if (session.kind === "none" || session.kind === "wayland-unreachable") {
        return { ok: false, unavailable: unavailable("session", session.reason) };
      }
      // `linuxDisplayEnv` forwards DBUS_SESSION_BUS_ADDRESS as well as the
      // display. That matters more here than anywhere else in the package: a
      // notification does not go to the display server, it goes to a D-Bus
      // service, and libnotify with no bus address either autolaunches a
      // private bus nobody is listening on (exit 0, nothing shown) or prints
      // "Cannot autolaunch D-Bus without X11 $DISPLAY".
      const displayEnv = linuxDisplayEnv(env);
      // Every option uses the `--option=value` form, so an option's value can
      // never be mistaken for the next option; every POSITIONAL goes after
      // `--`, so a summary of "-u" is a summary. Recorded on libnotify 0.8.1:
      // without `--`, `notify-send "-u" "body"` answers "Unknown urgency body
      // specified" - the summary became a flag and the body became its value.
      const argv = [
        "notify-send",
        "--app-name=crewhaus",
        `--urgency=${input.urgency}`,
        // Sent ONLY when the caller asked for one. libnotify's default is
        // NOTIFY_EXPIRES_DEFAULT (-1, "the daemon decides") while 0 is
        // NOTIFY_EXPIRES_NEVER — so passing 0 as a stand-in for "no
        // preference" pins the notification on screen until it is dismissed,
        // which is the opposite of what it reads like.
        ...(input.expireMs === undefined ? [] : [`--expire-time=${Math.trunc(input.expireMs)}`]),
        "--",
        input.title,
        // A subtitle has no place in the FreeDesktop notification spec, so it
        // is folded into the body rather than dropped silently.
        input.subtitle === undefined ? input.body : `${input.subtitle}\n${input.body}`,
      ];
      return { ok: true, backend: "notify-send", request: { argv, env: displayEnv } };
    }
    case "win32": {
      const doc = buildToastXml(input);
      const built = powershellArgv(WINDOWS_TOAST_SCRIPT, {
        CREWHAUS_TOAST_XML: doc.xml,
        CREWHAUS_TOAST_APPID: WINDOWS_TOAST_APPID,
      });
      return {
        ok: true,
        backend: "powershell ToastNotification",
        request: { argv: built.argv, env: built.env },
        ...(doc.sanitized ? { sanitized: true } : {}),
      };
    }
    default:
      return { ok: false, unavailable: unsupportedPlatform(platform, "notification") };
  }
}

/**
 * What came back from a notifier.
 *
 * `dispatched` is deliberately not called `shown`. Every one of these APIs
 * accepts a notification and returns; whether the operator SAW it depends on
 * Do Not Disturb, a Focus mode, a notification daemon's own filtering and
 * whether the screen is on. None of that is observable from here, so the tool
 * claims only what it did.
 */
export type NotifyOutcome =
  | { readonly outcome: "dispatched" }
  | Unavailable
  | { readonly outcome: "failed"; readonly reason: string };

/** Stderr that means there is no notification daemon to hand it to. */
const NO_DAEMON = [
  // Recorded, Debian 12 / libnotify 0.8.1, no DISPLAY.
  /Cannot autolaunch D-Bus without X11/i,
  /Failed to connect to (the )?(session )?bus/i,
  /Failed to connect to a Wayland server/i,
];

export function classifyNotify(result: {
  readonly code: number;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly missing: boolean;
  readonly refused?: boolean;
}): NotifyOutcome {
  if (result.refused === true) return { outcome: "failed", reason: result.stderr };
  if (result.missing) {
    return unavailable(
      "program",
      "the notifier for this platform is not installed on this host (on Linux that is notify-send, from libnotify-bin)",
    );
  }
  if (result.timedOut) {
    return {
      outcome: "failed",
      reason:
        "the notifier did not finish within its timeout and was killed - whether the notification was posted is unknown",
    };
  }
  if (result.code === 0) return { outcome: "dispatched" };
  for (const pattern of NO_DAEMON) {
    if (pattern.test(result.stderr)) {
      return unavailable(
        "session",
        `there is no notification daemon to post to: ${result.stderr.trim()}`,
      );
    }
  }
  return {
    outcome: "failed",
    reason: `the notifier exited ${result.code}: ${result.stderr.trim()}`,
  };
}
