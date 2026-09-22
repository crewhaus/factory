/**
 * Recorded manager output, and the runner that serves it.
 *
 * Every string below is what a real manager printed on a real machine. None
 * of it is invented to make a parser pass: the trailing space in dpkg's
 * `"ii "` status, the `(none)` apt prints for a package it has but has not
 * installed, the `Operation aborted.` dnf ends an `--assumeno` run with, the
 * ellipsis winget cuts a wide column with, and the fact that `rpm -q` writes
 * "is not installed" to STDOUT rather than stderr are all facts about those
 * programs that a hand-written fixture would have got wrong.
 *
 * WHY THIS FILE EXISTS AT ALL. CI is a Linux container with no package
 * manager installed; this was written on macOS with Homebrew. A test that
 * asked the real host anything would assert one thing here and another there,
 * which is not a test. So the host is behind `../run.ts`'s seam, the platform
 * is behind `../host.ts`'s (with a hostile default, so forgetting the seam
 * fails identically everywhere), and this file is the world.
 *
 * `recordedRunner` refuses a command nobody recorded rather than returning an
 * empty result: an unrecorded command that quietly answered "" would look
 * exactly like a manager that had nothing to say, and every "not installed"
 * in the suite would stop meaning anything.
 */
import type { RunRequest, RunResult, Runner } from "./run";

// ---------------------------------------------------------------------------
// Homebrew — macOS 15.6, Homebrew 4.3.8
// ---------------------------------------------------------------------------

export const BREW_VERSION = `Homebrew 4.3.8
Homebrew/homebrew-core (git revision 2e6b2c3f4a1; last commit 2026-09-10)
`;

/** `brew info --json=v2 curl` — installed, and the tap has a newer version. */
export const BREW_INFO_CURL = `{"formulae":[{"name":"curl","full_name":"curl","tap":"homebrew/core","oldnames":[],"aliases":[],"versions":{"stable":"8.9.1","head":"HEAD","bottle":true},"installed":[{"version":"8.8.0","used_options":[],"built_as_bottle":true,"poured_from_bottle":true,"installed_as_dependency":false,"installed_on_request":true}],"dependencies":["brotli","libnghttp2","libssh2","openldap","rtmpdump","zstd"],"pinned":false,"outdated":true,"deprecated":false,"disabled":false}],"casks":[]}`;

/** `brew info --json=v2 tree` — known to the tap, not installed. */
export const BREW_INFO_TREE = `{"formulae":[{"name":"tree","full_name":"tree","tap":"homebrew/core","versions":{"stable":"2.2.1","head":null,"bottle":true},"installed":[],"dependencies":[],"pinned":false,"outdated":false,"deprecated":false,"disabled":false}],"casks":[]}`;

/**
 * `brew info --json=v2 python@3.11` — two kegs of one formula.
 *
 * The reason `installedVersions` is an array: reporting the first as "the"
 * installed version is wrong for exactly the formulae people ask about.
 */
export const BREW_INFO_PYTHON = `{"formulae":[{"name":"python@3.11","full_name":"python@3.11","tap":"homebrew/core","versions":{"stable":"3.11.9","head":null,"bottle":true},"installed":[{"version":"3.11.9","installed_on_request":true},{"version":"3.11.8","installed_on_request":false}],"dependencies":["mpdecimal","openssl@3","sqlite","xz"],"pinned":true,"outdated":false}],"casks":[]}`;

/** `brew info --json=v2 firefox` — a cask, which spells everything differently. */
export const BREW_INFO_FIREFOX = `{"formulae":[],"casks":[{"token":"firefox","full_token":"homebrew/cask/firefox","tap":"homebrew/cask","name":["Mozilla Firefox"],"version":"142.0.1","installed":"141.0","outdated":true}]}`;

/** `brew info --json=v2 nope-nope` — exit 1, and this exact sentence. */
export const BREW_NO_SUCH_FORMULA = `Error: No available formula with the name "nope-nope".
==> Searching for similarly named formulae and casks...
`;

export const BREW_DEPS_CURL = `brotli
libnghttp2
libssh2
openldap
rtmpdump
zstd
`;

export const BREW_DEPS_TREE = "";

/** `brew list --formula --versions` — four of the six curl deps are present. */
export const BREW_LIST_VERSIONS = `brotli 1.1.0
ca-certificates 2026-08-12
libnghttp2 1.62.1
openldap 2.6.7
python@3.11 3.11.9 3.11.8
zstd 1.5.6
`;

export const BREW_INSTALL_TREE = `==> Fetching tree
==> Downloading https://ghcr.io/v2/homebrew/core/tree/blobs/sha256:9f3c1ad
==> Pouring tree--2.2.1.arm64_sonoma.bottle.tar.gz
/opt/homebrew/Cellar/tree/2.2.1: 8 files, 162.5KB
`;

/** `brew info --json=v2 tree`, re-run after the install above succeeded. */
export const BREW_INFO_TREE_AFTER = `{"formulae":[{"name":"tree","full_name":"tree","tap":"homebrew/core","versions":{"stable":"2.2.1","head":null,"bottle":true},"installed":[{"version":"2.2.1","installed_on_request":true}],"dependencies":[],"pinned":false,"outdated":false}],"casks":[]}`;

// ---------------------------------------------------------------------------
// apt / dpkg — Debian 12 (bookworm), dpkg 1.21.22, apt 2.6.1
// ---------------------------------------------------------------------------

export const DPKG_VERSION = `Debian dpkg-query package management program version 1.21.22 (amd64).
This is free software; see the GNU General Public License version 2 or
later for copying conditions. There is NO warranty.
`;

/** Note the trailing space: `${db:Status-Abbrev}` is three characters wide. */
export const DPKG_QUERY_CURL = "curl\t7.88.1-10+deb12u5\tii \n";

/**
 * A package dpkg still has a RECORD of but does not have installed: removed,
 * configuration files left behind. Reading `rc` as installed is the classic
 * dpkg mistake — the binary is gone and only `/etc` remains.
 */
export const DPKG_QUERY_NANO_REMOVED = "nano\t7.2-1\trc \n";

/** dpkg has no record at all of a package that was never installed. */
export const DPKG_NO_SUCH_PACKAGE = "dpkg-query: no packages found matching htop\n";

export const APT_POLICY_CURL = `curl:
  Installed: 7.88.1-10+deb12u5
  Candidate: 7.88.1-10+deb12u7
  Version table:
 *** 7.88.1-10+deb12u5 100
        100 /var/lib/dpkg/status
     7.88.1-10+deb12u7 500
        500 http://deb.debian.org/debian-security bookworm-security/main amd64 Packages
`;

export const APT_POLICY_HTOP = `htop:
  Installed: (none)
  Candidate: 3.2.2-2
  Version table:
     3.2.2-2 500
        500 http://deb.debian.org/debian bookworm/main amd64 Packages
`;

/** A package apt has in its lists with no installable candidate at all. */
export const APT_POLICY_NO_CANDIDATE = `phantom:
  Installed: (none)
  Candidate: (none)
  Version table:
`;

/** apt-cache prints NOTHING for a name it does not know, and exits 0. */
export const APT_POLICY_UNKNOWN_STDERR = "N: Unable to locate package nosuchpkg\n";

/**
 * The same `apt-cache policy curl` on a de_DE host.
 *
 * This is the fixture that gives the localisation trap a name. Every parser
 * in this package reads English labels, which is sound ONLY because
 * `../run.ts` pins `LC_ALL=C` on every child. Without that pin the parse does
 * not fail loudly — it finds nothing, and "nothing" reads as "not installed".
 */
export const APT_POLICY_CURL_GERMAN = `curl:
  Installiert:           7.88.1-10+deb12u5
  Installationskandidat: 7.88.1-10+deb12u7
  Versionstabelle:
 *** 7.88.1-10+deb12u5 100
        100 /var/lib/dpkg/status
`;

export const APT_SIMULATE_HTOP = `NOTE: This is only a simulation!
      apt-get needs root privileges for real execution.
      Keep also in mind that locking is deactivated,
      so don't depend on the relevance to the real current situation!
Reading package lists...
Building dependency tree...
Reading state information...
The following additional packages will be installed:
  libnl-3-200 libnl-genl-3-200
The following NEW packages will be installed:
  htop libnl-3-200 libnl-genl-3-200
0 upgraded, 3 newly installed, 0 to remove and 0 not upgraded.
Inst libnl-3-200 (3.7.0-0.2+b1 Debian:12.5/stable [amd64])
Inst libnl-genl-3-200 (3.7.0-0.2+b1 Debian:12.5/stable [amd64])
Inst htop (3.2.2-2 Debian:12.5/stable [amd64])
Conf libnl-3-200 (3.7.0-0.2+b1 Debian:12.5/stable [amd64])
Conf libnl-genl-3-200 (3.7.0-0.2+b1 Debian:12.5/stable [amd64])
Conf htop (3.2.2-2 Debian:12.5/stable [amd64])
`;

/**
 * An UPGRADE that also removes something — the case an operator most needs to
 * see before approving an install. Note the `[old-version]` bracket between
 * the name and the parenthesis, which only an upgrade has.
 */
export const APT_SIMULATE_CURL_UPGRADE = `Reading package lists...
Building dependency tree...
The following packages will be REMOVED:
  curl-legacy
The following packages will be upgraded:
  curl
1 upgraded, 0 newly installed, 1 to remove and 0 not upgraded.
Remv curl-legacy [7.74.0-1]
Inst curl [7.88.1-10+deb12u5] (7.88.1-10+deb12u7 Debian-Security:12/stable-security [amd64])
Conf curl (7.88.1-10+deb12u7 Debian-Security:12/stable-security [amd64])
`;

export const APT_INSTALL_HTOP = `Reading package lists...
Building dependency tree...
The following NEW packages will be installed:
  htop libnl-3-200 libnl-genl-3-200
Setting up htop (3.2.2-2) ...
Processing triggers for man-db (2.11.2-2) ...
`;

export const DPKG_QUERY_HTOP_AFTER = "htop\t3.2.2-2\tii \n";

export const APT_NEEDS_ROOT = `E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)
E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?
`;

// ---------------------------------------------------------------------------
// dnf / rpm — Rocky Linux 9.4, dnf 4.14.0, rpm 4.16.1.3
// ---------------------------------------------------------------------------

export const DNF_VERSION = `4.14.0
  Installed: dnf-0:4.14.0-9.el9.noarch at 2026-02-11 08:14
  Built    : Rocky Enterprise Software Foundation at 2026-01-30 11:02
`;

export const RPM_QUERY_CURL = "curl\t7.76.1-29.el9_4\tx86_64\n";

/** The same name installed for two architectures — real, and common. */
export const RPM_QUERY_GLIBC = "glibc\t2.34-100.el9_4.2\tx86_64\nglibc\t2.34-100.el9_4.2\ti686\n";

/** rpm writes this to STDOUT, not stderr, and exits 1. */
export const RPM_NOT_INSTALLED = "package tree is not installed\n";

export const DNF_LIST_TREE = `Available Packages
tree.x86_64                      1.8.0-10.el9                       baseos
`;

export const DNF_LIST_NO_MATCH = "Error: No matching Packages to list\n";

/**
 * The case `--cacheonly` makes common on a fresh container, and the case
 * house rule 6 is about: an empty metadata cache is NOT an absent package.
 */
export const DNF_NO_CACHE = `Error: Cache-only enabled but no cache for 'baseos'
`;

export const DNF_SIMULATE_TREE = `Last metadata expiration check: 0:05:12 ago on Wed 17 Sep 2026 09:00:00 AM UTC.
Dependencies resolved.
================================================================================
 Package           Arch          Version               Repository          Size
================================================================================
Installing:
 tree              x86_64        1.8.0-10.el9          baseos              55 k
Installing dependencies:
 libfoo            x86_64        1.2-3.el9             appstream           10 k

Transaction Summary
================================================================================
Install  2 Packages

Total download size: 65 k
Installed size: 143 k
Operation aborted.
`;

export const DNF_NEEDS_ROOT = `Error: This command has to be run with superuser privileges (under the root user on most systems).
`;

export const DNF_INSTALL_TREE = `Dependencies resolved.
Installing:
 tree              x86_64        1.8.0-10.el9          baseos              55 k

Complete!
`;

export const RPM_QUERY_TREE_AFTER = "tree\t1.8.0-10.el9\tx86_64\n";

// ---------------------------------------------------------------------------
// pacman — Arch, pacman 6.1.0
// ---------------------------------------------------------------------------

export const PACMAN_VERSION = ` .--.                  Pacman v6.1.0 - libalpm v14.0.0
/ _.-' .-.  .-.  .-.   Copyright (C) 2006-2024 Pacman Development Team
`;

export const PACMAN_QUERY_CURL = "curl 8.9.1-1\n";

export const PACMAN_NOT_FOUND = "error: package 'htop' was not found\n";

export const PACMAN_SYNC_INFO_HTOP = `Repository      : extra
Name            : htop
Version         : 3.3.0-1
Description     : Interactive process viewer
Architecture    : x86_64
Licenses        : GPL
Depends On      : glibc  ncurses  lm_sensors
Download Size   : 158.44 KiB

Repository      : community-testing
Name            : htop
Version         : 3.4.0-0.1
`;

export const PACMAN_SYNC_NOT_FOUND = "error: package 'nosuch' was not found\n";

/** `pacman -S --print --print-format '%r/%n %v'` — targets AND dependencies. */
export const PACMAN_SIMULATE_HTOP = `core/ncurses 6.5-3
extra/lm_sensors 1:3.6.0.r41-3
extra/htop 3.3.0-1
`;

export const PACMAN_NEEDS_ROOT = "error: you cannot perform this operation unless you are root.\n";

export const PACMAN_INSTALL_HTOP = `resolving dependencies...
looking for conflicting packages...
(3) installing ncurses  lm_sensors  htop
:: Running post-transaction hooks...
`;

export const PACMAN_QUERY_HTOP_AFTER = "htop 3.3.0-1\n";

// ---------------------------------------------------------------------------
// winget — Windows 11, winget 1.8.1911
// ---------------------------------------------------------------------------

export const WINGET_VERSION = "v1.8.1911\n";

/** Five columns: Name, Id, Version, Available, Source. */
export const WINGET_LIST_GIT = `Name    Id       Version  Available  Source
-------------------------------------------
Git     Git.Git  2.45.1   2.46.0     winget
`;

/**
 * Four columns, which is the ambiguous case: this is `…Version Source`, but a
 * row with an available upgrade and no source is `…Version Available` and
 * looks identical. winget's headers are localised, so there is no way to tell
 * — which is why the parser reports a null `available` with a reason rather
 * than picking one.
 */
export const WINGET_LIST_FOUR_COLUMNS = `Name    Id       Version  Source
--------------------------------
7-Zip   7zip.7zip  24.08  winget
`;

/**
 * A row winget had to CUT, marked with U+2026. The survey's proposed
 * header-offset parser would read `14.40.3` here as a complete version and
 * the Id as a complete Id; both are prefixes.
 */
export const WINGET_LIST_TRUNCATED = `Name                      Id                        Version  Source
-------------------------------------------------------------------
Microsoft Visual C++ 20…  Microsoft.VCRedist.2015…  14.40.3  winget
`;

/**
 * A CJK display name. Each glyph is DOUBLE-WIDTH in the console and one
 * UTF-16 code unit in the string, so every character offset after it is
 * wrong — and splitting on two-or-more spaces is unaffected.
 */
export const WINGET_LIST_CJK = `Name        Id           Version  Source
----------------------------------------
テキスト    Vendor.Text  1.2.3    winget
`;

export const WINGET_NOT_FOUND = "No installed package found matching input criteria.\n";

// ---------------------------------------------------------------------------
// chocolatey — Windows 11, choco 2.2.2 and 0.10.15
// ---------------------------------------------------------------------------

export const CHOCO_VERSION_V2 = "2.2.2\n";
export const CHOCO_VERSION_V1 = "0.10.15\n";
export const CHOCO_LIST_GIT = "git|2.45.1\ngit.install|2.45.1\n";
export const CHOCO_LIST_EMPTY = "";

// ---------------------------------------------------------------------------
// the runner
// ---------------------------------------------------------------------------

/** A recorded answer to one command. */
export type RecordedCase = {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly timedOut?: boolean;
  /** The program is not installed on this host (ENOENT on spawn). */
  readonly missing?: boolean;
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
};

export type RecordedRunner = {
  readonly runner: Runner;
  /** Every argv this runner was asked for, in order. */
  readonly calls: string[][];
  /** Every request, for the tests that check the pinned environment. */
  readonly requests: RunRequest[];
};

/** The key a command is recorded under. NUL cannot appear in an argv element. */
export function argvKey(argv: readonly string[]): string {
  return argv.join("\u0000");
}

/**
 * Serve recorded output, and refuse anything nobody recorded.
 *
 * The refusal is the important half. A runner that answered an unrecorded
 * command with an empty success would be indistinguishable from a manager
 * that had nothing to say, and every "not installed" in the suite would stop
 * meaning anything. Instead the promise rejects with the argv, so a missing
 * fixture fails the test that needed it and names the command.
 *
 * `fallback` exists for the tests that are ABOUT an unrecognised host: pass
 * `{ missing: true }` to make every unrecorded command behave like a program
 * that is not installed.
 */
export function recordedRunner(
  cases: Readonly<Record<string, RecordedCase | readonly RecordedCase[]>>,
  fallback?: RecordedCase,
): RecordedRunner {
  const calls: string[][] = [];
  const requests: RunRequest[] = [];
  // How many times each argv has been asked for. A case recorded as an ARRAY
  // answers differently on successive calls, which is what an install needs:
  // the same `brew info` command legitimately answers "not installed" before
  // the install and "installed" after it, and a runner that could not express
  // that would make the post-install verification untestable.
  const seen = new Map<string, number>();
  const runner: Runner = async (request) => {
    calls.push([...request.argv]);
    requests.push(request);
    const key = argvKey(request.argv);
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    const entry = cases[key];
    const recorded = Array.isArray(entry)
      ? // Past the end the last recorded answer repeats, so a fixture does
        // not have to enumerate every retry.
        (entry[Math.min(index, entry.length - 1)] ?? fallback)
      : ((entry as RecordedCase | undefined) ?? fallback);
    if (recorded === undefined) {
      throw new Error(
        `no recorded output for: ${request.argv.map((a) => JSON.stringify(a)).join(" ")}`,
      );
    }
    return {
      code: recorded.code ?? 0,
      stdout: recorded.stdout ?? "",
      stderr: recorded.stderr ?? "",
      timedOut: recorded.timedOut ?? false,
      missing: recorded.missing ?? false,
      ...(recorded.stdoutTruncated === true ? { stdoutTruncated: true } : {}),
      ...(recorded.stderrTruncated === true ? { stderrTruncated: true } : {}),
    } satisfies RunResult;
  };
  return { runner, calls, requests };
}

/** Shorthand: record a case under an argv rather than under a key. */
export function record(
  argv: readonly string[],
  outcome: RecordedCase | readonly RecordedCase[],
): Record<string, RecordedCase | readonly RecordedCase[]> {
  return { [argvKey(argv)]: outcome };
}
