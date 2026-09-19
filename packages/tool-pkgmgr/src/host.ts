/**
 * The two facts about the host that are not a command: which operating system
 * this is, and whether the process is already root.
 *
 * ── THE HOSTILE DEFAULT ────────────────────────────────────────────────────
 *
 * `hostPlatform()` does NOT simply fall back to `process.platform`. When a
 * runner has been injected — which is true in every test in this package and
 * false in production — the un-injected platform is `"other"`, a platform no
 * backend here supports.
 *
 * The reason is a bug this project has already paid for. A test in tool-hostfs
 * relied on the ambient `process.platform`, passed on the author's macOS, and
 * took a different branch on the Linux CI box; the suite went green locally
 * and red in CI, and the failure said nothing about which seam was missing.
 * Reading `process.platform` in a test is not a small sin that shows up as a
 * small failure — it is a test that asserts something different on every
 * machine it runs on.
 *
 * Tying the default to the RUNNER seam rather than sniffing an environment
 * variable is deliberate. A test that has installed a recorded runner has
 * already declared "I am not talking to this host"; if it then forgets to
 * declare which host it is pretending to be, it gets `"other"` and every
 * backend refuses, identically, on macOS and on Linux and on a maintainer's
 * Windows box. Production never injects a runner, so production reads the
 * real platform. There is no env sniffing, no `NODE_ENV`, and nothing that
 * behaves differently under `bun test` than under `crewhaus run`.
 *
 * ── ROOT ───────────────────────────────────────────────────────────────────
 *
 * `effectiveUid()` exists because `apt-get install` cannot run without root
 * and this package will not acquire root (house rule 7). It never escalates:
 * it reports what the process ALREADY has, so a harness running as root in a
 * container can install, and a harness running as a user gets a refusal that
 * names the command the operator would run themselves. There is no code path
 * here that runs `sudo`, `doas`, `runas` or `pkexec`, and no schema in this
 * package accepts a password — `no argv ever names an escalation program` in
 * index.test.ts asserts both over every recorded call.
 */
import { _runnerInstalled } from "./run";

/** The platform strings this package makes decisions about. */
export type HostPlatform = "darwin" | "linux" | "win32" | "other";

let platformOverride: HostPlatform | undefined;

/** Normalise `process.platform` into the cases that matter here. */
export function classifyPlatform(raw: string): HostPlatform {
  if (raw === "darwin" || raw === "linux" || raw === "win32") return raw;
  return "other";
}

export function hostPlatform(): HostPlatform {
  if (platformOverride !== undefined) return platformOverride;
  // See the header: a test that drives a recorded runner and forgets to say
  // which OS it is on gets a platform with no backend, everywhere.
  if (_runnerInstalled()) return "other";
  return classifyPlatform(process.platform);
}

/** Test seam: pretend to be another OS. */
export function _setPlatform(platform: HostPlatform | undefined): void {
  platformOverride = platform;
}

let uidOverride: number | undefined;

/**
 * The effective uid, or `undefined` where the concept does not exist.
 *
 * `process.geteuid` is absent on Windows. An unknown uid is reported as
 * unknown and never defaulted to 0 — guessing "we are root" is the one guess
 * here that ends with a manager being asked to modify the system.
 */
export function effectiveUid(): number | undefined {
  if (uidOverride !== undefined) return uidOverride;
  const get = process.geteuid;
  if (typeof get !== "function") return undefined;
  const uid = get.call(process);
  return Number.isInteger(uid) && uid >= 0 ? uid : undefined;
}

/** True only when the process is PROVABLY root. Unknown is not root. */
export function isRoot(): boolean {
  return effectiveUid() === 0;
}

/** Test seam: pretend to be (or not to be) root. */
export function _setUid(uid: number | undefined): void {
  uidOverride = uid;
}

/** Put both seams back to the real host. Called from `afterEach`. */
export function _resetHostSeams(): void {
  platformOverride = undefined;
  uidOverride = undefined;
}
