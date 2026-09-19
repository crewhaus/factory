/**
 * The seams, and the hostile default behind them.
 *
 * Every tool in this package reaches the operator's real desktop. That makes
 * the machine the code runs on part of the answer twice over: the platform
 * decides which backend exists at all (`pbpaste` is macOS-only, `wmctrl` is
 * X11-only, `Out-Printer` is Windows-only), and the *session* decides whether
 * that backend can do anything (an X11 clipboard with no `$DISPLAY` is not a
 * slow clipboard, it is no clipboard).
 *
 * So the platform, the session environment, the clock and the child processes
 * are all injected, and the suite never learns anything about the box it runs
 * on except through a fixture somebody captured and pasted into `./fixtures`.
 *
 * ── THE HOSTILE DEFAULT ────────────────────────────────────────────────────
 *
 * `hostPlatform()` does not fall back to `process.platform`. It answers
 * `"unsupported"` — a platform no backend in this package serves, on every
 * machine, identically — whenever EITHER of two things is true:
 *
 *   1. A RUNNER IS INSTALLED. This is `@crewhaus/tool-pkgmgr`'s rule, and the
 *      primary guard. A test that has installed a recorded runner has already
 *      declared "I am not talking to this host"; if it then forgets to
 *      declare which host it is pretending to be, every backend refuses
 *      identically rather than taking the author's branch on macOS and a
 *      different one on a two-core Linux CI box.
 *   2. THE REAL-HOST GATE IS SHUT (`run.ts`'s `_realHostAllowed`, false under
 *      `bun test`). The belt under the braces, for a test that never
 *      installed the seam at all. See `run.ts` for why this package is
 *      stricter than tool-pkgmgr about that case.
 *
 * That bug is not hypothetical: it cost this project a CI round in
 * `tool-hostfs`, where one test relied on the ambient `process.platform`,
 * passed on macOS and took a different branch on Linux. The cure is to make
 * the ambient answer useless rather than to remember not to use it.
 *
 * `integration.test.ts` — the single test allowed near the real host — says so
 * out loud by calling `_allowRealHost(true)`, and puts it back. It also
 * asserts that the un-injected path then DOES read the real platform, so the
 * guard above is provably a test-only condition rather than a package that
 * refuses everywhere.
 */
import { _realHostAllowed, _runnerInstalled } from "./run";

// ---------------------------------------------------------------------------
// platform
// ---------------------------------------------------------------------------

/**
 * The platforms this package makes decisions about.
 *
 * `"unsupported"` is a real member, not a placeholder: it is what every tool
 * here returns `unavailable` for, and it is what an un-injected seam answers
 * under test. Keeping it in the union means the exhaustive switch in each
 * backend selector has to handle it, so a new tool cannot forget.
 */
export type HostPlatform = "darwin" | "linux" | "win32" | "unsupported";

let platformOverride: HostPlatform | undefined;

function classifyPlatform(raw: string): HostPlatform {
  if (raw === "darwin" || raw === "linux" || raw === "win32") return raw;
  return "unsupported";
}

/** What `process.platform` actually says. Only the smoke test asks. */
export function realHostPlatform(): HostPlatform {
  return classifyPlatform(process.platform);
}

export function hostPlatform(): HostPlatform {
  if (platformOverride !== undefined) return platformOverride;
  if (_runnerInstalled()) return "unsupported";
  return _realHostAllowed() ? classifyPlatform(process.platform) : "unsupported";
}

/** Test seam: pretend to be another OS. */
export function _setPlatform(platform: HostPlatform | undefined): void {
  platformOverride = platform;
}

// ---------------------------------------------------------------------------
// the session environment
// ---------------------------------------------------------------------------

/**
 * The parts of the environment that decide whether a desktop is reachable.
 *
 * These are not configuration, they are *facts about the session*, and every
 * one of them changes a tool's answer from "here it is" to "there is nothing
 * to ask". Reading `process.env` directly inside a tool would mean a test's
 * answer depended on whether the developer happened to be in an SSH session.
 */
export type SessionEnv = {
  /** X11 display. Absent ⇒ `xclip`/`wmctrl` cannot connect at all. */
  readonly DISPLAY: string | undefined;
  /** Wayland socket name. */
  readonly WAYLAND_DISPLAY: string | undefined;
  /** `wl-paste` refuses without it even when WAYLAND_DISPLAY is set. */
  readonly XDG_RUNTIME_DIR: string | undefined;
  /** "x11" | "wayland" | "tty" on a logind session. */
  readonly XDG_SESSION_TYPE: string | undefined;
  /**
   * The session bus `notify-send` posts to.
   *
   * Not in the first draft of this file, and its absence was a real gap: a
   * notification does not go to the display server, it goes to a D-Bus
   * service. With `DISPLAY` forwarded and this one dropped, libnotify falls
   * back to autolaunching a bus — which on a headless box prints "Cannot
   * autolaunch D-Bus without X11 $DISPLAY" and on a desktop box can start a
   * SECOND private bus that no notification daemon is listening on, so the
   * call succeeds and nothing is ever shown.
   */
  readonly DBUS_SESSION_BUS_ADDRESS: string | undefined;
  /** Set by sshd ⇒ this is a remote shell, not the console. */
  readonly SSH_CONNECTION: string | undefined;
  readonly SSH_TTY: string | undefined;
};

const SESSION_KEYS = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  "DBUS_SESSION_BUS_ADDRESS",
  "SSH_CONNECTION",
  "SSH_TTY",
] as const;

/** An environment with no desktop in it — the hostile default under test. */
export const HEADLESS_ENV: SessionEnv = Object.freeze({
  DISPLAY: undefined,
  WAYLAND_DISPLAY: undefined,
  XDG_RUNTIME_DIR: undefined,
  XDG_SESSION_TYPE: undefined,
  DBUS_SESSION_BUS_ADDRESS: undefined,
  SSH_CONNECTION: undefined,
  SSH_TTY: undefined,
});

let envOverride: SessionEnv | undefined;

export function sessionEnv(): SessionEnv {
  if (envOverride !== undefined) return envOverride;
  if (_runnerInstalled() || !_realHostAllowed()) return HEADLESS_ENV;
  const read = (key: string): string | undefined => {
    const value = process.env[key];
    // An EMPTY `DISPLAY` is not a display. Treating `""` as set is how a
    // headless host gets classified as an X11 session and then blocks on a
    // clipboard read until its deadline.
    return value === undefined || value === "" ? undefined : value;
  };
  const out: Record<string, string | undefined> = {};
  for (const key of SESSION_KEYS) out[key] = read(key);
  return out as unknown as SessionEnv;
}

export function _setSessionEnv(env: SessionEnv | undefined): void {
  envOverride = env;
}

/** True when this process is talking to a machine over ssh, not sitting at it. */
export function isRemoteShell(env: SessionEnv = sessionEnv()): boolean {
  return env.SSH_CONNECTION !== undefined || env.SSH_TTY !== undefined;
}

/**
 * Is there a graphical session a Linux backend could talk to, and which kind?
 *
 * Four answers, never two. "I could not tell" is not "there is no desktop":
 * a Wayland session whose `XDG_RUNTIME_DIR` is unset really has no reachable
 * compositor (recorded: `wl-paste` prints "XDG_RUNTIME_DIR is invalid or not
 * set in the environment"), but a session with neither variable set may
 * simply be a service manager that scrubbed the environment.
 */
export type LinuxSession =
  | { readonly kind: "x11"; readonly display: string }
  | { readonly kind: "wayland"; readonly display: string; readonly runtimeDir: string }
  | { readonly kind: "wayland-unreachable"; readonly reason: string }
  | { readonly kind: "none"; readonly reason: string };

export function linuxSession(env: SessionEnv = sessionEnv()): LinuxSession {
  if (env.WAYLAND_DISPLAY !== undefined) {
    if (env.XDG_RUNTIME_DIR === undefined) {
      return {
        kind: "wayland-unreachable",
        reason:
          "WAYLAND_DISPLAY is set but XDG_RUNTIME_DIR is not, so the compositor socket cannot be located",
      };
    }
    return {
      kind: "wayland",
      display: env.WAYLAND_DISPLAY,
      runtimeDir: env.XDG_RUNTIME_DIR,
    };
  }
  if (env.DISPLAY !== undefined) return { kind: "x11", display: env.DISPLAY };
  return {
    kind: "none",
    reason:
      "neither DISPLAY nor WAYLAND_DISPLAY is set in this process's environment, so there is no graphical session to reach",
  };
}

/**
 * The session variables a Linux desktop backend needs, forwarded explicitly.
 *
 * Explicitly, because `childEnv` copies nothing from `process.env` — and
 * because an X11 client with no `DISPLAY` does not fail fast, it fails after
 * a connection attempt or, on some builds, blocks until the deadline.
 */
export function linuxDisplayEnv(env: SessionEnv): Record<string, string> {
  const out: Record<string, string> = {};
  if (env.DISPLAY !== undefined) out["DISPLAY"] = env.DISPLAY;
  if (env.WAYLAND_DISPLAY !== undefined) out["WAYLAND_DISPLAY"] = env.WAYLAND_DISPLAY;
  if (env.XDG_RUNTIME_DIR !== undefined) out["XDG_RUNTIME_DIR"] = env.XDG_RUNTIME_DIR;
  if (env.DBUS_SESSION_BUS_ADDRESS !== undefined) {
    out["DBUS_SESSION_BUS_ADDRESS"] = env.DBUS_SESSION_BUS_ADDRESS;
  }
  return out;
}

// ---------------------------------------------------------------------------
// clock
// ---------------------------------------------------------------------------

export type Clock = () => number;

let clockOverride: Clock | undefined;

/**
 * Epoch milliseconds.
 *
 * `PowerAssertion` writes a deadline into a state file and reports when an
 * assertion expires, so its whole contract is clock arithmetic. Reading
 * `Date.now()` inside the tool would make every assertion about an expiry a
 * race with the wall clock (house rule: never assert wall-clock timing —
 * inject the clock instead).
 */
export function now(): number {
  return clockOverride === undefined ? Date.now() : clockOverride();
}

export function _setClock(clock: Clock | undefined): void {
  clockOverride = clock;
}

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

/** Put every seam in this file back. Called from `afterEach`. */
export function _resetHostSeams(): void {
  platformOverride = undefined;
  envOverride = undefined;
  clockOverride = undefined;
}
