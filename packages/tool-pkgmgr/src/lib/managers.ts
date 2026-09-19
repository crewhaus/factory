/**
 * The six managers, what each one can actually do, and every argv this
 * package is allowed to run.
 *
 * ── ARGV IS A TABLE OF CONSTANTS ──────────────────────────────────────────
 *
 * `tool-host` established the rule and it is kept here: every command is a
 * frozen constant, and the ONLY value this package appends to one is a
 * package name (or a `name=version` operand) that `../lib/names.ts` has
 * already accepted. Nothing read out of one command's output is ever fed into
 * another command's argv — a dependency name parsed from `apt-get -s` output
 * is reported, never re-spawned. `argv is a constant plus the validated
 * operand` in index.test.ts asserts that over every recorded call, including
 * the adversarial ones.
 *
 * ── THE SCOPE IS NARROWER THAN THE CATALOGUE IMPLIES, ON PURPOSE ──────────
 *
 * Reading is broad: all six managers answer "is this installed, at what
 * version", and four of them also answer "what does the local index say is
 * available" without touching the network.
 *
 * WRITING is narrow, and the table says why per manager rather than pretending
 * otherwise. Homebrew on macOS is the case that genuinely works unattended —
 * it needs no root, it is designed for a writable prefix owned by the user,
 * and `NONINTERACTIVE=1` is its own documented switch for exactly this. The
 * three Linux managers need root, so this package installs through them only
 * when the process it is already running in IS root, and otherwise refuses
 * with the command an operator would run. The two Windows managers are not
 * installed through at all, because both end in an elevation prompt this
 * package will not raise.
 */
import type { HostPlatform } from "../host";
import type { ManagerId } from "./names";

export type { ManagerId };

export const MANAGER_IDS: readonly ManagerId[] = Object.freeze([
  "homebrew",
  "apt",
  "dnf",
  "pacman",
  "winget",
  "choco",
] as const);

/**
 * Every command this package may run, as literals.
 *
 * Flag notes that matter to the parsers downstream:
 *
 *   - `brew info --json=v2` is the ONE brew call that answers both halves of
 *     a query: `installed[]` for what is on disk and `versions.stable` for
 *     what the tap has. It also covers casks in the same document, so a name
 *     does not have to be classified before it is looked up.
 *   - `dpkg-query -W -f=...` is named-field output, not a table. The fields
 *     are `${db:Status-Abbrev}` rather than `${Status}` because the abbrev is
 *     three fixed characters (`ii `, `un `, `rc `) that mean the same thing in
 *     every locale, while `${Status}` is three English words.
 *   - `apt-cache policy` IS localised, which is why `LC_ALL=C` is pinned in
 *     `../run.ts`. Without that pin the `Installed:`/`Candidate:` labels come
 *     back in the operator's language and the parser silently finds nothing —
 *     the single most common way a package-manager parser fails in the field.
 *   - `rpm -q --queryformat` rather than `dnf list --installed`: rpm reads the
 *     local database, needs no repository metadata, and its format string is
 *     not localised. `dnf` is only asked what is AVAILABLE.
 *   - `dnf --cacheonly` so the query cannot reach the network. The cost is
 *     that a host with no cached metadata answers "no matching packages",
 *     which is indistinguishable from "not in the repos" — so the parser
 *     looks for dnf's own "no cache" complaint and reports unknown instead of
 *     "not available". "Could not determine" is not "no" (house rule 6).
 *   - `pacman -S --print --print-format '%r/%n %v'` is pacman's dry run. It
 *     prints every target INCLUDING dependencies, with versions, and needs no
 *     root — the best dry run of the six.
 *   - `winget list --exact --query` with `--disable-interactivity` and
 *     `--accept-source-agreements`: without those two, winget can sit waiting
 *     for a keypress or for an agreement to be accepted, which on a pipe is a
 *     command that never exits.
 *   - `choco list --limit-output` is chocolatey's documented machine-readable
 *     mode: `name|version`, one per line, no headers, no colour. The v1/v2
 *     split is real — `--local-only` was removed in Chocolatey 2.0 — so the
 *     version is probed first and the right form is chosen.
 */
export const PKGMGR_COMMANDS = Object.freeze({
  brewVersion: Object.freeze(["brew", "--version"]),
  brewInfoJson: Object.freeze(["brew", "info", "--json=v2"]),
  brewListVersions: Object.freeze(["brew", "list", "--formula", "--versions"]),
  brewDeps: Object.freeze(["brew", "deps", "--formula"]),
  brewInstall: Object.freeze(["brew", "install", "--formula"]),

  dpkgVersion: Object.freeze(["dpkg-query", "--version"]),
  dpkgQuery: Object.freeze([
    "dpkg-query",
    "-W",
    "-f=${binary:Package}\t${Version}\t${db:Status-Abbrev}\n",
    "--",
  ]),
  aptCachePolicy: Object.freeze(["apt-cache", "policy", "--"]),
  aptSimulate: Object.freeze(["apt-get", "install", "-s", "-y", "--"]),
  aptInstall: Object.freeze(["apt-get", "install", "-y", "--"]),

  dnfVersion: Object.freeze(["dnf", "--version"]),
  rpmQuery: Object.freeze(["rpm", "-q", "--queryformat", "%{NAME}\t%{EVR}\t%{ARCH}\n", "--"]),
  dnfListAvailable: Object.freeze([
    "dnf",
    "--cacheonly",
    "--quiet",
    "list",
    "--available",
    "--",
  ]),
  dnfSimulate: Object.freeze(["dnf", "install", "--assumeno", "--"]),
  dnfInstall: Object.freeze(["dnf", "install", "-y", "--"]),

  pacmanVersion: Object.freeze(["pacman", "--version"]),
  pacmanQuery: Object.freeze(["pacman", "-Q", "--"]),
  pacmanSyncInfo: Object.freeze(["pacman", "-Si", "--"]),
  pacmanSimulate: Object.freeze(["pacman", "-S", "--print", "--print-format", "%r/%n %v", "--"]),
  pacmanInstall: Object.freeze(["pacman", "-S", "--noconfirm", "--"]),

  wingetVersion: Object.freeze(["winget", "--version"]),
  wingetList: Object.freeze([
    "winget",
    "list",
    "--exact",
    "--disable-interactivity",
    "--accept-source-agreements",
    "--query",
  ]),

  chocoVersion: Object.freeze(["choco", "--version"]),
  /** Chocolatey 2.x: `choco list` is local by default. */
  chocoListV2: Object.freeze(["choco", "list", "--exact", "--limit-output"]),
  /** Chocolatey 1.x and 0.x: `list` searches the remote unless told otherwise. */
  chocoListV1: Object.freeze(["choco", "list", "--local-only", "--exact", "--limit-output"]),
});

/** Flat view of the table, for the test that proves no argv is built. */
export const ALL_PKGMGR_COMMANDS: ReadonlyArray<ReadonlyArray<string>> = Object.freeze(
  Object.values(PKGMGR_COMMANDS),
);

/**
 * The environment each manager needs on top of the pinned base in `../run.ts`.
 *
 * Every entry here exists to stop the manager doing something this package
 * does not do: reach the network, write analytics, colour its output, or ask
 * a question on a pipe that nothing will ever answer.
 */
export const MANAGER_ENV: Readonly<Record<ManagerId, Readonly<Record<string, string>>>> =
  Object.freeze({
    homebrew: Object.freeze({
      // `brew info` will otherwise `git fetch` the taps first: a network call
      // this package does not make, and a multi-second stall inside a query
      // that is supposed to read a local checkout.
      HOMEBREW_NO_AUTO_UPDATE: "1",
      HOMEBREW_NO_ANALYTICS: "1",
      HOMEBREW_NO_ENV_HINTS: "1",
      HOMEBREW_NO_COLOR: "1",
      // Homebrew's own switch for "there is no human here". Without it a
      // formula with a caveat or a prompt blocks on stdin.
      NONINTERACTIVE: "1",
    }),
    apt: Object.freeze({
      // Without this, a package with a debconf question opens a dialog on a
      // terminal that is not there and apt waits for it forever.
      DEBIAN_FRONTEND: "noninteractive",
      APT_LISTCHANGES_FRONTEND: "none",
    }),
    dnf: Object.freeze({}),
    pacman: Object.freeze({}),
    winget: Object.freeze({}),
    choco: Object.freeze({}),
  });

export type InstallSupport =
  | { readonly supported: true; readonly needsRoot: boolean }
  | { readonly supported: false; readonly reason: string };

export type VersionPinSupport =
  | { readonly supported: true; readonly form: string }
  | { readonly supported: false; readonly reason: string };

export type ManagerSpec = {
  readonly id: ManagerId;
  readonly label: string;
  /** Platforms this manager is looked for on, in detection order. */
  readonly platforms: readonly HostPlatform[];
  /** The `--version` probe that decides whether it is installed. */
  readonly detect: readonly string[];
  /** Whether "what is available" can be answered without the network. */
  readonly availableSource: "local-index" | "network-only";
  /** Why the network-only ones are not asked. */
  readonly availableReason?: string;
  readonly install: InstallSupport;
  readonly versionPin: VersionPinSupport;
  /**
   * Whether `--` is appended before the operand.
   *
   * Documented per manager rather than assumed. It is defence in depth only:
   * a leading dash is refused in `names.ts` before this matters, precisely
   * because the four `false` entries below cannot be defended this way.
   */
  readonly doubleDash: boolean;
  /** The command the operator runs themselves when this package refuses. */
  readonly operatorCommand: (operand: string) => string;
};

export const MANAGERS: Readonly<Record<ManagerId, ManagerSpec>> = Object.freeze({
  homebrew: {
    id: "homebrew",
    label: "Homebrew",
    // Linuxbrew is real, and is looked for after the distro managers.
    platforms: ["darwin", "linux"],
    detect: PKGMGR_COMMANDS.brewVersion,
    availableSource: "local-index",
    install: { supported: true, needsRoot: false },
    versionPin: {
      supported: false,
      reason:
        "Homebrew installs whatever version the tap currently has and has no flag to select another; the only pin is a versioned formula, which is a different NAME (node@20, python@3.11) rather than a version",
    },
    // Homebrew's parser is Ruby's OptionParser wrapped in Homebrew::CLI, and
    // this package has not recorded its `--` behaviour, so it is not relied on.
    doubleDash: false,
    operatorCommand: (operand) => `brew install --formula ${operand}`,
  },
  apt: {
    id: "apt",
    label: "apt/dpkg",
    platforms: ["linux"],
    detect: PKGMGR_COMMANDS.dpkgVersion,
    availableSource: "local-index",
    install: { supported: true, needsRoot: true },
    versionPin: {
      supported: true,
      form: "name=version",
    },
    doubleDash: true,
    operatorCommand: (operand) => `sudo apt-get install -y -- ${operand}`,
  },
  dnf: {
    id: "dnf",
    label: "dnf/rpm",
    platforms: ["linux"],
    detect: PKGMGR_COMMANDS.dnfVersion,
    availableSource: "local-index",
    install: { supported: true, needsRoot: true },
    versionPin: {
      supported: false,
      reason:
        "dnf's versioned spec is name-version-release, and joining a name to a version cannot be done unambiguously when the name itself contains a dash — which most rpm names do; pass the full NEVRA (kernel-5.14.0-427.el9) as the package NAME instead, which is exact",
    },
    doubleDash: true,
    operatorCommand: (operand) => `sudo dnf install -y -- ${operand}`,
  },
  pacman: {
    id: "pacman",
    label: "pacman",
    platforms: ["linux"],
    detect: PKGMGR_COMMANDS.pacmanVersion,
    availableSource: "local-index",
    install: { supported: true, needsRoot: true },
    versionPin: {
      supported: false,
      reason:
        "pacman has no version selection: the sync database holds exactly one version per package and there is no flag to ask for another",
    },
    doubleDash: true,
    operatorCommand: (operand) => `sudo pacman -S --noconfirm -- ${operand}`,
  },
  winget: {
    id: "winget",
    label: "winget",
    platforms: ["win32"],
    detect: PKGMGR_COMMANDS.wingetVersion,
    availableSource: "network-only",
    availableReason:
      "winget resolves an available version by querying its source over the network, and this tool makes no network call — only the local install state is read",
    install: {
      supported: false,
      reason:
        "a winget install runs the package's own installer, which raises a UAC elevation prompt for any machine-scope package; this tool does not raise one and will not start an installer whose end it cannot see",
    },
    versionPin: {
      supported: false,
      reason: "winget installs are not performed by this tool at all, so there is nothing to pin",
    },
    // winget's parser does not document `--` as an end-of-options marker.
    doubleDash: false,
    operatorCommand: (operand) =>
      `winget install --exact --id ${operand} --accept-package-agreements --accept-source-agreements`,
  },
  choco: {
    id: "choco",
    label: "Chocolatey",
    platforms: ["win32"],
    detect: PKGMGR_COMMANDS.chocoVersion,
    availableSource: "network-only",
    availableReason:
      "chocolatey resolves an available version with `choco search`, which queries the remote feed; this tool makes no network call — only the local install state is read",
    install: {
      supported: false,
      reason:
        "chocolatey installs to a machine-wide location and must be run from an elevated shell, and its packages execute arbitrary PowerShell with those rights; this tool does not elevate",
    },
    versionPin: {
      supported: false,
      reason: "chocolatey installs are not performed by this tool at all, so there is nothing to pin",
    },
    doubleDash: false,
    operatorCommand: (operand) => `choco install ${operand} -y`,
  },
});

/**
 * Which managers to look for, in order, on a platform.
 *
 * Homebrew comes LAST on Linux: a Linuxbrew installation sits alongside the
 * distro's manager rather than replacing it, and on a Debian box the answer
 * to "is curl installed" that an operator means is dpkg's.
 *
 * `"other"` is empty, and that is what the hostile default in `../host.ts`
 * produces for any test that forgets to declare a platform — every backend
 * refuses, identically, on every machine.
 */
export function managersForPlatform(platform: HostPlatform): readonly ManagerId[] {
  switch (platform) {
    case "darwin":
      return ["homebrew"];
    case "linux":
      return ["apt", "dnf", "pacman", "homebrew"];
    case "win32":
      return ["winget", "choco"];
    case "other":
      return [];
  }
}

/**
 * Build the operand a manager receives for a name (optionally version-pinned).
 *
 * Kept in one place because it is the ONLY value this package ever appends to
 * an argv, and the join is manager-specific: `name=version` is apt's grammar
 * and nobody else's.
 */
export function buildOperand(manager: ManagerId, name: string, version?: string): string {
  if (version === undefined) return name;
  if (manager === "apt") return `${name}=${version}`;
  // Unreachable through the tools: `checkVersionPin` refuses a version for
  // every other manager before this is called. Kept total rather than
  // throwing, so a future caller gets the name rather than an exception.
  return name;
}

/** Append the operand to a frozen prefix, with `--` where the manager takes it. */
export function withOperand(
  spec: ManagerSpec,
  prefix: readonly string[],
  operand: string,
): string[] {
  // The prefixes that end in `--` already carry it (it is part of the frozen
  // constant so the test can see it), so it is never added twice.
  const endsWithDoubleDash = prefix[prefix.length - 1] === "--";
  if (spec.doubleDash && !endsWithDoubleDash) return [...prefix, "--", operand];
  return [...prefix, operand];
}
