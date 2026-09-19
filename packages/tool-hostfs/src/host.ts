/**
 * The seams. Everything in this package that would otherwise read the real
 * machine goes through one of the functions here, and every one of them can
 * be replaced from a test.
 *
 * The reason is not tidiness. These three tools read a HOST: the platform
 * they run on decides which code path even exists (the FreeDesktop trash is
 * Linux-only; `mdfind` is macOS-only), and the answers differ between the
 * machine this was written on (macOS) and the machine CI runs on (Linux).
 * A test that asked the real host a question would pass here and either fail
 * on CI or — much worse — pass there while asserting something different.
 * So the platform, the clock, the environment, the device numbers, the file
 * stats and the child processes are all injected, and the test suite never
 * learns anything about the box it is running on except through a fixture
 * somebody captured and pasted in.
 *
 * `_resetHostSeams()` puts every one of them back; the suites call it in
 * `afterEach` so one test's fake platform cannot leak into the next.
 */
import { type BigIntStats, lstatSync } from "node:fs";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// platform
// ---------------------------------------------------------------------------

/** The platform strings this package makes decisions about. */
export type HostPlatform = "darwin" | "linux" | "win32" | "other";

let platformOverride: HostPlatform | undefined;

/** Normalise `process.platform` into the three cases that matter here. */
function classifyPlatform(raw: string): HostPlatform {
  if (raw === "darwin" || raw === "linux" || raw === "win32") return raw;
  return "other";
}

export function hostPlatform(): HostPlatform {
  return platformOverride ?? classifyPlatform(process.platform);
}

/** Test seam: pretend to be another OS. */
export function _setPlatform(platform: HostPlatform | undefined): void {
  platformOverride = platform;
}

// ---------------------------------------------------------------------------
// clock
// ---------------------------------------------------------------------------

export type Clock = () => number;

let clockOverride: Clock | undefined;

/**
 * Epoch milliseconds.
 *
 * Two callers need this and both would otherwise be untestable: the trash
 * writes a `DeletionDate` into a file whose bytes a test asserts, and the
 * watcher stamps every event so the coalescing window can be reasoned about
 * without measuring a stopwatch (house rule: never assert wall-clock timing).
 */
export function now(): number {
  return clockOverride === undefined ? Date.now() : clockOverride();
}

export function _setClock(clock: Clock | undefined): void {
  clockOverride = clock;
}

let monotonicOverride: Clock | undefined;

/**
 * Milliseconds on a clock that only ever moves forward.
 *
 * The watcher measures its settle windows and its deadline with this, NOT
 * with `now()`. Two reasons, and the first one is a bug waiting to happen on
 * a real machine: a wall clock steps when NTP corrects it and when a laptop
 * wakes up, and a step backwards while a window is open means the window
 * never closes — the tool sits there until its deadline reporting nothing.
 * The second is that the two clocks are wanted for different things at once:
 * `TrashPath` needs a FIXED wall clock in a test (it writes a timestamp into
 * a file whose bytes are asserted) while `WatchPath` in the same test needs
 * time to pass. One seam could not serve both, and freezing the shared one is
 * how this file first made a twenty-millisecond fold take fifteen seconds.
 */
export function monotonicNow(): number {
  return monotonicOverride === undefined ? performance.now() : monotonicOverride();
}

export function _setMonotonicClock(clock: Clock | undefined): void {
  monotonicOverride = clock;
}

// ---------------------------------------------------------------------------
// environment and identity
// ---------------------------------------------------------------------------

/**
 * The parts of the host's identity the FreeDesktop trash spec is written in
 * terms of: `$XDG_DATA_HOME` (defaulting to `$HOME/.local/share`) and the
 * numeric uid that names a top-directory trash.
 */
export type HostIdentity = {
  readonly home: string | undefined;
  readonly xdgDataHome: string | undefined;
  readonly uid: number | undefined;
};

let identityOverride: HostIdentity | undefined;

export function hostIdentity(): HostIdentity {
  if (identityOverride !== undefined) return identityOverride;
  // `process.getuid` does not exist on Windows, which is one of the platforms
  // this package refuses — reading it unguarded would throw before the
  // refusal could be returned.
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const home = process.env["HOME"] ?? os.homedir();
  return {
    home: home === "" ? undefined : home,
    xdgDataHome: process.env["XDG_DATA_HOME"] === "" ? undefined : process.env["XDG_DATA_HOME"],
    uid,
  };
}

export function _setIdentity(identity: HostIdentity | undefined): void {
  identityOverride = identity;
}

/** `PATH` for a child process, with a floor so a stripped harness env still spawns. */
export const FALLBACK_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

// ---------------------------------------------------------------------------
// filesystem facts
// ---------------------------------------------------------------------------

/**
 * What this package needs to know about a path, and nothing else.
 *
 * `device` is the whole reason this is a seam. The FreeDesktop trash spec's
 * central rule is that a trash directory must be on the SAME filesystem as
 * the file — a rule you cannot exercise on a developer's laptop without
 * mounting a second filesystem, and cannot exercise in CI at all. Injecting
 * the device number lets the cross-device path be tested properly instead of
 * being the one branch nobody ever runs until it corrupts something.
 */
export type PathFacts = {
  readonly exists: boolean;
  readonly device: number;
  readonly isDirectory: boolean;
  readonly isSymlink: boolean;
  readonly mode: number;
  readonly mtimeMs: number;
  /**
   * An opaque token that changes whenever the path does: modification time
   * and inode-change time, at NANOSECOND resolution.
   *
   * Both halves are needed. A `chmod`, a rename or an extended-attribute
   * write moves ctime and leaves mtime alone, so mtime alone would call those
   * "nothing happened". And the resolution has to be nanoseconds: on APFS a
   * chmod a few microseconds after the write lands in the same MILLISECOND,
   * so the millisecond-resolution fields are equal and the change is
   * invisible — measured on macOS 15.6 while writing this. A filesystem with
   * a coarser clock (HFS+ stores whole seconds) gives a coarser token, and
   * the blind spot grows accordingly.
   */
  readonly changeStamp: string;
  readonly sizeBytes: number;
};

export type PathProbe = (absolutePath: string) => PathFacts | undefined;

let probeOverride: PathProbe | undefined;

/**
 * `lstat`, never `stat`.
 *
 * A symlink is trashed as the LINK, and the device that matters for the
 * same-filesystem rule is the link's own, not its target's. Following it here
 * would mean deciding a local link's fate by where a USB stick is mounted —
 * and, for the watcher, classifying an event by a file the caller never named.
 */
export function probePath(absolutePath: string): PathFacts | undefined {
  if (probeOverride !== undefined) return probeOverride(absolutePath);
  let stats: BigIntStats | undefined;
  try {
    // bigint mode: `dev` is a 64-bit value, and a device comparison that is
    // off by a float rounding is a cross-device move that the same-filesystem
    // rule exists to prevent.
    stats = lstatSync(absolutePath, { bigint: true, throwIfNoEntry: false });
  } catch {
    // A path whose PARENT is unreadable throws EACCES rather than returning
    // undefined; an unprobeable path is treated as absent, which every caller
    // here turns into a refusal rather than a guess.
    return undefined;
  }
  if (stats === undefined) return undefined;
  return {
    exists: true,
    device: Number(stats.dev),
    isDirectory: stats.isDirectory(),
    isSymlink: stats.isSymbolicLink(),
    mode: Number(stats.mode),
    mtimeMs: Number(stats.mtimeMs),
    changeStamp: `${stats.mtimeNs}:${stats.ctimeNs}`,
    sizeBytes: Number(stats.size),
  };
}

export function _setPathProbe(probe: PathProbe | undefined): void {
  probeOverride = probe;
}

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

/** Put every seam back to the real host. Called from `afterEach`. */
export function _resetHostSeams(): void {
  platformOverride = undefined;
  clockOverride = undefined;
  monotonicOverride = undefined;
  identityOverride = undefined;
  probeOverride = undefined;
}
