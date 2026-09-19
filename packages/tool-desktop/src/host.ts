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
 * THE HOSTILE DEFAULT — the point of this file.
 *
 * `hostPlatform()` does not fall back to `process.platform`. Under `bun test`
 * (which sets `NODE_ENV=test`) an un-injected platform reads `"unsupported"`:
 * a platform no backend in this package serves, on every machine, identically.
 * `runHostCommand` refuses the same way. A test that forgets to set the seam
 * therefore fails on macOS exactly as it fails on a two-core Linux CI box,
 * instead of quietly taking the author's branch and a different one in CI.
 *
 * That bug is not hypothetical: it cost this project a CI round in
 * `tool-hostfs`, where one test relied on the ambient `process.platform`,
 * passed on macOS and took a different branch on Linux. The cure is to make
 * the ambient answer useless rather than to remember not to use it.
 *
 * The single integration smoke test that is *allowed* to touch the real host
 * says so out loud by calling `_allowRealHost(true)`, and puts it back.
 */

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

/**
 * Whether an un-injected seam may consult the real machine.
 *
 * False under `bun test`. Bun sets `NODE_ENV=test` for its own runner
 * (verified on bun 1.3.14), which is the only signal available without a
 * shared setup file — and a setup file is exactly the thing a new test file
 * forgets to import.
 */
let realHostAllowed = process.env["NODE_ENV"] !== "test";

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
  return realHostAllowed ? classifyPlatform(process.platform) : "unsupported";
}

/** Test seam: pretend to be another OS. */
export function _setPlatform(platform: HostPlatform | undefined): void {
  platformOverride = platform;
}

/**
 * Opt in to (or out of) the real machine for an un-injected seam.
 *
 * Exactly one test in this package calls it with `true`, and restores it in
 * the same `finally`. Everything else drives a fixture.
 */
export function _allowRealHost(allowed: boolean): void {
  realHostAllowed = allowed;
}

export function _realHostAllowed(): boolean {
  return realHostAllowed;
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
  /** Set by sshd ⇒ this is a remote shell, not the console. */
  readonly SSH_CONNECTION: string | undefined;
  readonly SSH_TTY: string | undefined;
};

const SESSION_KEYS = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  "SSH_CONNECTION",
  "SSH_TTY",
] as const;

/** An environment with no desktop in it — the hostile default under test. */
export const HEADLESS_ENV: SessionEnv = Object.freeze({
  DISPLAY: undefined,
  WAYLAND_DISPLAY: undefined,
  XDG_RUNTIME_DIR: undefined,
  XDG_SESSION_TYPE: undefined,
  SSH_CONNECTION: undefined,
  SSH_TTY: undefined,
});

let envOverride: SessionEnv | undefined;

export function sessionEnv(): SessionEnv {
  if (envOverride !== undefined) return envOverride;
  if (!realHostAllowed) return HEADLESS_ENV;
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

/**
 * Is there a graphical session a Linux backend could talk to, and which kind?
 *
 * Three answers, never two. "I could not tell" is not "there is no desktop":
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

// ---------------------------------------------------------------------------
// clock
// ---------------------------------------------------------------------------

export type Clock = () => number;

let clockOverride: Clock | undefined;

/**
 * Epoch milliseconds.
 *
 * `PowerAssertion` writes a deadline into a state file and reports when an
 * assertion expires, so its whole contract is a clock arithmetic. Reading
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
  realHostAllowed = process.env["NODE_ENV"] !== "test";
}
