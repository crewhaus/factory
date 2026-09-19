/**
 * `UserPresence` — is there a human at this machine, and should a workflow
 * interrupt them.
 *
 * THIS IS THE TOOL RULE 6 WAS WRITTEN FOR. Every field here has a tempting
 * fallback that inverts the tool's purpose:
 *
 *   - "no idle signal, assume active" tells a workflow the operator is at the
 *     keyboard when the truth is that nothing could be asked.
 *   - "the probe failed, so idle" tells it the opposite, and a workflow that
 *     acts on `idle: true` does things unattended.
 *   - "screen-lock has no CLI, so not locked" claims the screen is unlocked
 *     on every machine in the world.
 *
 * So every field is `number | null` or `boolean | null`, `null` always
 * carries an entry in `unknown` naming the probe and the reason, and the
 * derived `idle` boolean is `null` whenever `idleSeconds` is.
 *
 * ── WHAT EACH PLATFORM CAN ACTUALLY ANSWER ────────────────────────────────
 *
 * macOS     Idle comes out of an `ioreg` text dump, in NANOSECONDS. The unit
 *           is the trap: reading it as milliseconds makes every host look
 *           permanently active, and nothing about the number's shape gives
 *           that away. The incantation matters too — the survey sketch's
 *           `ioreg -c IOHIDSystem -d 1` prints NOTHING on macOS 26.6.2
 *           (verified); `-r` is required, because `-d 1` without it bounds
 *           the depth from the root rather than from the matched object:
 *
 *             $ ioreg -c IOHIDSystem -d 1 | grep HIDIdleTime      # empty
 *             $ ioreg -r -c IOHIDSystem -d 1 | grep HIDIdleTime
 *                   "HIDIdleTime" = 3254341351000
 *
 *           Lock state has no supported CLI, and the framework call
 *           (CGSessionCopyCurrentDictionary) is a C API. But the same
 *           registry carries it, recorded on the same machine with the screen
 *           locked:
 *
 *             $ ioreg -n Root -d1
 *                   "IOConsoleLocked" = Yes
 *                   "IOConsoleUsers" = ({...,"CGSSessionScreenIsLocked"=Yes,...})
 *
 *           Both keys are read, `IOConsoleLocked` first. A dump with neither
 *           is reported as unknown rather than as unlocked.
 * Linux     `xprintidle` is the only idle source and is usually NOT
 *           installed; under Wayland there is no idle query at all. Lock
 *           state comes from logind's `LockedHint`, which is a HINT — it is
 *           set by a screen locker that bothers to call `SetLockedHint`, and
 *           a locker that does not leaves it `no` on a locked screen. It is
 *           reported with that caveat attached rather than as a fact.
 * Windows   `GetLastInputInfo` through a registered PowerShell script, and
 *           the presence of `LogonUI` as the lock signal — that process runs
 *           only while the lock or login screen is up.
 *
 * And over all of it: an SSH session. Idle time on a machine you are talking
 * to over a wire says nothing about whether a person is sitting at it, so a
 * remote shell reports `sessionKind: "ssh"` and does not pretend otherwise.
 */
import { type HostPlatform, type SessionEnv, isRemoteShell, linuxSession } from "../host";
import type { RunRequest } from "../run";
import { powershellArgv, registerPowerShellScript } from "./escape";

export type SessionKind = "console" | "ssh" | "headless" | "unknown";

/** The C# `GetLastInputInfo` shim, as one fixed string no caller value touches. */
const WINDOWS_IDLE_SOURCE = [
  "using System;using System.Runtime.InteropServices;",
  "public class CHIdle{",
  '[DllImport("user32.dll")]static extern bool GetLastInputInfo(ref LASTINPUTINFO p);',
  "[StructLayout(LayoutKind.Sequential)]struct LASTINPUTINFO{public uint cbSize;public uint dwTime;}",
  "public static long Ms(){LASTINPUTINFO i=new LASTINPUTINFO();i.cbSize=(uint)Marshal.SizeOf(i);",
  "if(!GetLastInputInfo(ref i))return -1;return (long)((uint)Environment.TickCount - i.dwTime);}}",
].join("");

export const WINDOWS_PRESENCE = registerPowerShellScript({
  name: "presence",
  // DOCUMENTED, NOT RECORDED. Two facts on two lines: idle milliseconds from
  // GetLastInputInfo, then whether LogonUI is running. Both are printed with
  // a `key=value` prefix so a partial answer is still parseable — an idle
  // probe that throws prints `idleMs=?` and leaves the lock line intact,
  // rather than taking the whole result down with it.
  script: [
    `$src = '${WINDOWS_IDLE_SOURCE}'`,
    "try { Add-Type -TypeDefinition $src -ErrorAction Stop; [Console]::Out.WriteLine('idleMs=' + [CHIdle]::Ms()) } catch { [Console]::Out.WriteLine('idleMs=?') }",
    "$lock = @(Get-Process -Name LogonUI -ErrorAction SilentlyContinue).Count",
    "[Console]::Out.WriteLine('locked=' + $(if ($lock -gt 0) { 'yes' } else { 'no' }))",
  ].join("; "),
  reads: [],
});

/** One probe this tool might run. Each is independently allowed to fail. */
export type PresenceProbe = {
  readonly field: "idleSeconds" | "screenLocked";
  readonly request: Omit<RunRequest, "timeoutMs">;
};

/**
 * Which probes to run, plus the fields this platform cannot probe at all.
 *
 * A platform with no probe for a field is not an error — it is a field that
 * comes back `null` with its reason, which is the whole contract here.
 */
export function planPresence(
  platform: HostPlatform,
  env: SessionEnv,
): { readonly probes: readonly PresenceProbe[]; readonly notes: ReadonlyArray<[string, string]> } {
  const notes: Array<[string, string]> = [];
  switch (platform) {
    case "darwin":
      return {
        probes: [
          // `-r` is load-bearing; see the header.
          {
            field: "idleSeconds",
            request: { argv: ["ioreg", "-r", "-c", "IOHIDSystem", "-d", "1"] },
          },
          { field: "screenLocked", request: { argv: ["ioreg", "-n", "Root", "-d1"] } },
        ],
        notes,
      };
    case "linux": {
      const session = linuxSession(env);
      const probes: PresenceProbe[] = [];
      if (session.kind === "x11") {
        probes.push({
          field: "idleSeconds",
          request: { argv: ["xprintidle"], env: { DISPLAY: session.display } },
        });
      } else {
        notes.push([
          "idleSeconds",
          session.kind === "wayland"
            ? "this is a Wayland session, and Wayland exposes no idle-time query to a client — there is no program to install that would answer this"
            : session.reason,
        ]);
      }
      probes.push({
        field: "screenLocked",
        request: {
          argv: [
            "loginctl",
            "show-session",
            "self",
            "-p",
            "LockedHint",
            "-p",
            "Type",
            "-p",
            "Active",
          ],
        },
      });
      return { probes, notes };
    }
    case "win32":
      return {
        probes: [
          { field: "idleSeconds", request: { argv: powershellArgv(WINDOWS_PRESENCE, {}).argv } },
        ],
        notes,
      };
    default:
      return {
        probes: [],
        notes: [
          ["idleSeconds", `this package has no presence backend for platform "${platform}"`],
          ["screenLocked", `this package has no presence backend for platform "${platform}"`],
        ],
      };
  }
}

/**
 * Parse `HIDIdleTime` out of an ioreg dump.
 *
 * NANOSECONDS. Recorded: `"HIDIdleTime" = 3254341351000` is 3254 seconds —
 * about 54 minutes, which is what the machine had been idle for. Reading it
 * as milliseconds would have reported 3254 SECONDS as 3.2 seconds and made a
 * locked, untouched machine look freshly used.
 *
 * The value passes 2^53 on a host idle for more than about 104 days, so it is
 * divided as a BigInt. A float round there is only seconds of error, but it
 * is error with no reason to exist.
 */
export function parseIoregIdleSeconds(stdout: string): number | null {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(stdout);
  if (match?.[1] === undefined) return null;
  try {
    return Number(BigInt(match[1]) / 1_000_000_000n);
  } catch {
    return null;
  }
}

/**
 * Parse macOS lock state out of an `ioreg -n Root -d1` dump.
 *
 * `null` when neither key is present — that is a macOS version this parser
 * has not seen, and guessing "unlocked" for it would claim every such machine
 * has a human looking at it.
 */
export function parseIoregLocked(stdout: string): boolean | null {
  // Recorded shape: `"IOConsoleLocked" = Yes`. The nested key inside
  // IOConsoleUsers has NO spaces around the `=`, so both are matched.
  const direct = /"IOConsoleLocked"\s*=\s*(Yes|No|true|false)/i.exec(stdout);
  if (direct?.[1] !== undefined) return /^(yes|true)$/i.test(direct[1]);
  const session = /"CGSSessionScreenIsLocked"\s*=\s*(Yes|No|true|false)/i.exec(stdout);
  if (session?.[1] !== undefined) return /^(yes|true)$/i.test(session[1]);
  return null;
}

/** `xprintidle` prints milliseconds and nothing else. */
export function parseXprintidleSeconds(stdout: string): number | null {
  const trimmed = stdout.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Math.floor(Number(trimmed) / 1000);
}

/** Parse `loginctl show-session -p …` key=value output. */
export function parseLoginctl(stdout: string): {
  readonly locked: boolean | null;
  readonly type: string | null;
  readonly active: boolean | null;
} {
  const read = (key: string): string | null => {
    const match = new RegExp(`^${key}=(.*)$`, "m").exec(stdout);
    return match?.[1]?.trim() ?? null;
  };
  const hint = read("LockedHint");
  const active = read("Active");
  return {
    locked: hint === null ? null : /^(yes|true)$/i.test(hint),
    type: read("Type"),
    active: active === null ? null : /^(yes|true)$/i.test(active),
  };
}

/** Parse the two lines the Windows script prints. */
export function parseWindowsPresence(stdout: string): {
  readonly idleSeconds: number | null;
  readonly locked: boolean | null;
} {
  const idle = /^idleMs=(\d+)$/m.exec(stdout);
  const locked = /^locked=(yes|no)$/m.exec(stdout);
  return {
    idleSeconds: idle?.[1] === undefined ? null : Math.floor(Number(idle[1]) / 1000),
    locked: locked?.[1] === undefined ? null : locked[1] === "yes",
  };
}

/**
 * What kind of session this is.
 *
 * `ssh` wins over everything: a forwarded `DISPLAY` on an ssh connection is
 * still a wire, and the idle time it would report belongs to the machine at
 * the far end rather than to the person typing.
 */
export function sessionKind(platform: HostPlatform, env: SessionEnv): SessionKind {
  if (isRemoteShell(env)) return "ssh";
  switch (platform) {
    case "darwin":
    case "win32":
      return "console";
    case "linux": {
      const session = linuxSession(env);
      return session.kind === "x11" || session.kind === "wayland" ? "console" : "headless";
    }
    default:
      return "unknown";
  }
}
