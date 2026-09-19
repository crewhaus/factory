/**
 * The library halves: the name gate, the parsers, the manager table and the
 * runner's own rules.
 *
 * Nothing here spawns anything or reads the host. Every parser is fed a string
 * recorded from a real manager (`./fixtures`), and every name is fed to the
 * gate that decides whether it may become an argv element.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  APT_POLICY_CURL,
  APT_POLICY_CURL_GERMAN,
  APT_POLICY_HTOP,
  APT_POLICY_NO_CANDIDATE,
  APT_SIMULATE_CURL_UPGRADE,
  APT_SIMULATE_HTOP,
  BREW_INFO_CURL,
  BREW_INFO_FIREFOX,
  BREW_INFO_PYTHON,
  BREW_INFO_TREE,
  BREW_LIST_VERSIONS,
  CHOCO_LIST_GIT,
  CHOCO_VERSION_V1,
  CHOCO_VERSION_V2,
  DNF_LIST_TREE,
  DNF_SIMULATE_TREE,
  DPKG_QUERY_CURL,
  DPKG_QUERY_NANO_REMOVED,
  PACMAN_QUERY_CURL,
  PACMAN_SIMULATE_HTOP,
  PACMAN_SYNC_INFO_HTOP,
  RPM_NOT_INSTALLED,
  RPM_QUERY_GLIBC,
  WINGET_LIST_CJK,
  WINGET_LIST_FOUR_COLUMNS,
  WINGET_LIST_GIT,
  WINGET_LIST_TRUNCATED,
} from "./fixtures";
import { _resetHostSeams, _setPlatform, _setUid, hostPlatform, isRoot } from "./host";
import {
  ALL_PKGMGR_COMMANDS,
  MANAGERS,
  MANAGER_IDS,
  PKGMGR_COMMANDS,
  buildOperand,
  managersForPlatform,
  withOperand,
} from "./lib/managers";
import { checkPackageName, checkVersionSyntax } from "./lib/names";
import {
  dpkgStatusIsInstalled,
  parseAptCachePolicy,
  parseAptSimulate,
  parseBrewInfoJson,
  parseBrewListVersions,
  parseChocoList,
  parseChocoMajorVersion,
  parseDnfList,
  parseDnfTransaction,
  parseDpkgQuery,
  parsePacmanInfo,
  parsePacmanQuery,
  parsePacmanSimulate,
  parseRpmQuery,
  parseWingetList,
} from "./lib/parse";
import { Unknowns, commandFailureReason, firstLine } from "./lib/unknown";
import { ToolPermissionError, resolveSafe } from "./paths";
import { _setRunner, assertArgv, buildEnv, capText } from "./run";

afterEach(() => {
  _resetHostSeams();
  _setRunner(undefined);
});

// ---------------------------------------------------------------------------
// the name gate — the security boundary
// ---------------------------------------------------------------------------

/**
 * The hostile values, one per line, each named for what it would break if the
 * value were ever interpolated into program text rather than passed as one
 * argv element.
 */
const HOSTILE_NAMES: ReadonlyArray<readonly [label: string, value: string]> = [
  ["a double quote", 'curl"; rm -rf /; echo "'],
  ["a backslash", "curl\\bad"],
  ["a newline", "curl\ninstall evil"],
  ["a command substitution", "$(id)"],
  ["a backtick", "`id`"],
  ["a closing toast element", "</toast>"],
  ["an ampersand", "curl&&whoami"],
  ["a leading dash", "-y"],
  ["a long-form flag", "--force"],
  ["a NUL byte", "curl\u0000extra"],
  ["a semicolon", "curl;id"],
  ["a pipe", "curl|id"],
  ["a dollar-brace expansion", "${PATH}"],
  ["a single quote", "curl'"],
  ["a space", "curl install"],
  ["a tab", "curl\tinstall"],
  ["a carriage return", "curl\rinstall"],
  ["a bare hyphen (stdin to many tools)", "-"],
  ["a relative path escape", "../../etc/passwd"],
  ["an absolute path", "/etc/passwd"],
  ["a control character", "curl\u0007"],
];

describe("checkPackageName", () => {
  test("refuses every hostile value on every manager", () => {
    for (const manager of MANAGER_IDS) {
      for (const [label, value] of HOSTILE_NAMES) {
        const refusal = checkPackageName(manager, value);
        expect(refusal, `${manager} accepted ${label}: ${JSON.stringify(value)}`).toBeString();
      }
    }
  });

  test("a leading dash is refused for being a FLAG, not for its characters", () => {
    // The message matters: "-y" is a perfectly ordinary string, and a caller
    // needs to know it was refused because a manager would read it as an
    // option rather than because of some charset rule.
    for (const manager of MANAGER_IDS) {
      expect(checkPackageName(manager, "-y")).toContain("FLAG");
    }
  });

  test("a NUL byte is refused by name, because execve would truncate it", () => {
    expect(checkPackageName("apt", "curl\u0000rm")).toContain("NUL");
  });

  test("accepts the ordinary names each manager actually uses", () => {
    expect(checkPackageName("homebrew", "curl")).toBeUndefined();
    expect(checkPackageName("homebrew", "python@3.11")).toBeUndefined();
    expect(checkPackageName("homebrew", "homebrew/cask/firefox")).toBeUndefined();
    expect(checkPackageName("apt", "libc6")).toBeUndefined();
    expect(checkPackageName("apt", "libc6:i386")).toBeUndefined();
    expect(checkPackageName("apt", "g++")).toBeUndefined();
    expect(checkPackageName("dnf", "kernel-5.14.0-427.el9")).toBeUndefined();
    expect(checkPackageName("pacman", "extra/htop")).toBeUndefined();
    expect(checkPackageName("winget", "Microsoft.VisualStudioCode")).toBeUndefined();
    expect(checkPackageName("choco", "git.install")).toBeUndefined();
  });

  test("refuses an apt name with upper case, which Debian policy forbids", () => {
    expect(checkPackageName("apt", "Curl")).toContain("not a valid apt package name");
    // …and accepts it for Homebrew, where a tap's user segment may carry it.
    expect(checkPackageName("homebrew", "Homebrew/core/curl")).toBeUndefined();
  });

  test("refuses a winget DISPLAY name rather than guessing it meant an Id", () => {
    // "Visual Studio Code" is what a person would type and is not what
    // `--exact` matches on; answering about the wrong app is worse than
    // refusing.
    expect(checkPackageName("winget", "Visual Studio Code")).toContain("whitespace");
  });

  test("refuses a name past the length limit", () => {
    expect(checkPackageName("apt", "a".repeat(201))).toContain("over the 200-character limit");
  });
});

describe("checkVersionSyntax", () => {
  test("accepts a Debian version", () => {
    expect(checkVersionSyntax("7.88.1-10+deb12u5")).toBeUndefined();
    expect(checkVersionSyntax("1:2.39.5-1")).toBeUndefined();
    expect(checkVersionSyntax("1.0~rc1-1")).toBeUndefined();
  });

  test("refuses a version containing '=', which would change which package apt reads", () => {
    // `name=1=2` is not `name` at version `1=2`.
    expect(checkVersionSyntax("1=2")).toContain("not a Debian version string");
  });

  test("refuses hostile version strings", () => {
    for (const [, value] of HOSTILE_NAMES) {
      expect(checkVersionSyntax(value)).toBeString();
    }
  });
});

// ---------------------------------------------------------------------------
// the manager table
// ---------------------------------------------------------------------------

describe("the manager table", () => {
  test("every recorded command is a literal argv with no caller value in it", () => {
    for (const argv of ALL_PKGMGR_COMMANDS) {
      expect(Array.isArray(argv)).toBe(true);
      expect(argv.length).toBeGreaterThan(0);
      for (const element of argv) expect(typeof element).toBe("string");
      expect(Object.isFrozen(argv)).toBe(true);
    }
  });

  test("no command anywhere in the table names a privilege-escalation program", () => {
    // House rule 7, asserted over the table rather than over one call path, so
    // a command added later cannot slip one in.
    const forbidden = /^(sudo|doas|runas|pkexec|gsudo|su)(\.exe)?$/i;
    for (const argv of ALL_PKGMGR_COMMANDS) {
      for (const element of argv) {
        expect(forbidden.test(element), `"${element}" is an escalation program`).toBe(false);
      }
    }
  });

  test("no command anywhere in the table is a shell", () => {
    const shells = /^(sh|bash|zsh|cmd|cmd\.exe|powershell|powershell\.exe|pwsh)$/i;
    for (const argv of ALL_PKGMGR_COMMANDS) {
      expect(shells.test(argv[0] ?? "")).toBe(false);
    }
  });

  test("Homebrew is the one manager whose install needs no root", () => {
    const brew = MANAGERS.homebrew.install;
    expect(brew.supported && brew.needsRoot).toBe(false);
    for (const id of ["apt", "dnf", "pacman"] as const) {
      const install = MANAGERS[id].install;
      expect(install.supported && install.needsRoot).toBe(true);
    }
    for (const id of ["winget", "choco"] as const) {
      expect(MANAGERS[id].install.supported).toBe(false);
    }
  });

  test("apt is the one manager that can express a version pin", () => {
    expect(MANAGERS.apt.versionPin.supported).toBe(true);
    for (const id of ["homebrew", "dnf", "pacman", "winget", "choco"] as const) {
      const pin = MANAGERS[id].versionPin;
      expect(pin.supported).toBe(false);
      // The refusal has to explain itself; "unsupported" is not an answer a
      // caller can act on.
      expect(pin.supported === false ? pin.reason.length : 0).toBeGreaterThan(40);
    }
  });

  test("a platform with no backend probes nothing", () => {
    expect(managersForPlatform("other")).toEqual([]);
    expect(managersForPlatform("darwin")).toEqual(["homebrew"]);
    // Homebrew last on Linux: on a Debian box the answer an operator means is
    // dpkg's, even when Linuxbrew is also installed.
    expect(managersForPlatform("linux")).toEqual(["apt", "dnf", "pacman", "homebrew"]);
    expect(managersForPlatform("win32")).toEqual(["winget", "choco"]);
  });

  test("buildOperand joins a version only where the manager has a grammar for it", () => {
    expect(buildOperand("apt", "curl", "7.88.1-10")).toBe("curl=7.88.1-10");
    expect(buildOperand("apt", "curl")).toBe("curl");
    // Every other manager is refused upstream; the join stays the bare name so
    // a future caller gets a name rather than an invented spec.
    expect(buildOperand("dnf", "tree", "1.8.0")).toBe("tree");
  });

  test("withOperand adds '--' exactly once, and only where the manager takes it", () => {
    // The apt prefix already carries `--` as part of the frozen constant.
    const apt = withOperand(MANAGERS.apt, PKGMGR_COMMANDS.aptInstall, "curl");
    expect(apt.filter((a) => a === "--")).toHaveLength(1);
    expect(apt[apt.length - 1]).toBe("curl");
    // Homebrew's parser has not been recorded, so no `--` is claimed for it.
    const brew = withOperand(MANAGERS.homebrew, PKGMGR_COMMANDS.brewInstall, "tree");
    expect(brew).toEqual(["brew", "install", "--formula", "tree"]);
  });
});

// ---------------------------------------------------------------------------
// the runner's rules
// ---------------------------------------------------------------------------

describe("assertArgv", () => {
  test("refuses an empty program, a NUL byte, and an interpreter", () => {
    expect(assertArgv([])).toContain("argv[0]");
    expect(assertArgv(["   "])).toContain("argv[0]");
    expect(assertArgv(["brew", "info", "cu\u0000rl"])).toContain("NUL");
    // The moment argv[0] is a shell, the careful argv array becomes one string
    // again and every escaping guarantee in this package evaporates.
    expect(assertArgv(["sh", "-c", "brew install curl"])).toContain("never runs a shell");
    expect(assertArgv(["/bin/bash", "-c", "x"])).toContain("never runs a shell");
    expect(assertArgv(["C:\\Windows\\System32\\cmd.exe", "/c", "x"])).toContain(
      "never runs a shell",
    );
  });

  test("accepts an ordinary manager command", () => {
    expect(assertArgv(["apt-get", "install", "-y", "--", "curl"])).toBeUndefined();
  });
});

describe("buildEnv", () => {
  test("pins the locale and the timezone, whatever the harness has", () => {
    const env = buildEnv({}, { PATH: "/usr/bin", LC_ALL: "de_DE.UTF-8", TZ: "Europe/Berlin" });
    expect(env["LC_ALL"]).toBe("C");
    expect(env["LANG"]).toBe("C");
    expect(env["TZ"]).toBe("UTC");
  });

  test("forwards nothing else, so a harness secret never reaches a manager", () => {
    const env = buildEnv({}, { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-secret", HOME: "/home/a" });
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(Object.values(env)).not.toContain("sk-secret");
    expect(env["HOME"]).toBe("/home/a");
  });

  test("falls back to a usable PATH when the harness has none", () => {
    expect(buildEnv({}, {})["PATH"]).toContain("/usr/bin");
  });

  test("the manager's own non-interactive switches are applied", () => {
    const env = buildEnv({ DEBIAN_FRONTEND: "noninteractive" }, { PATH: "/usr/bin" });
    expect(env["DEBIAN_FRONTEND"]).toBe("noninteractive");
  });
});

describe("capText", () => {
  test("says when it cut, because a cut listing looks like a complete short one", () => {
    expect(capText("abcdef", 3)).toEqual({ text: "abc", truncated: true });
    expect(capText("ab", 3)).toEqual({ text: "ab", truncated: false });
  });
});

// ---------------------------------------------------------------------------
// the hostile platform default
// ---------------------------------------------------------------------------

describe("the platform seam", () => {
  test("is 'other' whenever a runner is injected and no platform was declared", () => {
    // House rule 4, made structural. A test that drives recorded output has
    // declared it is not talking to this host; if it then forgets to say WHICH
    // host it is pretending to be, it gets a platform no backend supports —
    // identically on macOS, on Linux and on Windows. The tool-hostfs bug this
    // prevents passed on the author's Mac and took a different branch in CI.
    _setRunner(async () => ({
      code: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      missing: false,
    }));
    expect(hostPlatform()).toBe("other");
  });

  test("is the real platform when nothing is injected", () => {
    // Production never injects a runner, so production reads the real host.
    expect(["darwin", "linux", "win32", "other"]).toContain(hostPlatform());
  });

  test("an explicit platform always wins", () => {
    _setPlatform("win32");
    expect(hostPlatform()).toBe("win32");
  });
});

describe("the root seam", () => {
  test("unknown is not root", () => {
    // A uid that could not be read must never be defaulted to 0: guessing "we
    // are root" is the one guess that ends with a manager modifying a machine.
    _setUid(undefined);
    expect(typeof isRoot()).toBe("boolean");
    _setUid(1000);
    expect(isRoot()).toBe(false);
    _setUid(0);
    expect(isRoot()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parsers — Homebrew
// ---------------------------------------------------------------------------

describe("parseBrewInfoJson", () => {
  test("reads an installed formula with a newer version in the tap", () => {
    const info = parseBrewInfoJson(BREW_INFO_CURL);
    expect(info?.formula?.installedVersions).toEqual(["8.8.0"]);
    expect(info?.formula?.stableVersion).toBe("8.9.1");
    expect(info?.formula?.outdated).toBe(true);
    expect(info?.formula?.dependencies).toContain("libssh2");
  });

  test("keeps every keg of a formula rather than picking one", () => {
    const info = parseBrewInfoJson(BREW_INFO_PYTHON);
    expect(info?.formula?.installedVersions).toEqual(["3.11.9", "3.11.8"]);
    expect(info?.formula?.pinned).toBe(true);
  });

  test("normalises a cask, which spells every field differently", () => {
    const info = parseBrewInfoJson(BREW_INFO_FIREFOX);
    expect(info?.formula).toBeUndefined();
    expect(info?.cask?.kind).toBe("cask");
    expect(info?.cask?.installedVersions).toEqual(["141.0"]);
    expect(info?.cask?.stableVersion).toBe("142.0.1");
  });

  test("a known-but-absent formula has an empty installed list, not a missing one", () => {
    expect(parseBrewInfoJson(BREW_INFO_TREE)?.formula?.installedVersions).toEqual([]);
  });

  test("returns undefined for output that is not a v2 document", () => {
    // What a FAILED brew prints. Reading it as "no such package" is the
    // mistake; the caller turns undefined into an unknown with a reason.
    expect(parseBrewInfoJson("Error: No available formula")).toBeUndefined();
    expect(parseBrewInfoJson("")).toBeUndefined();
    expect(parseBrewInfoJson('{"something":1}')).toBeUndefined();
    // An empty but well-formed document IS an answer, and is not undefined.
    expect(parseBrewInfoJson('{"formulae":[],"casks":[]}')).toEqual({});
  });
});

test("parseBrewListVersions keeps every kegged version", () => {
  const list = parseBrewListVersions(BREW_LIST_VERSIONS);
  expect(list.get("brotli")).toEqual(["1.1.0"]);
  expect(list.get("python@3.11")).toEqual(["3.11.9", "3.11.8"]);
  expect(list.has("libssh2")).toBe(false);
});

// ---------------------------------------------------------------------------
// parsers — apt / dpkg
// ---------------------------------------------------------------------------

describe("dpkg", () => {
  test("reads the tab-separated row including the three-character status", () => {
    const rows = parseDpkgQuery(DPKG_QUERY_CURL);
    expect(rows).toEqual([{ name: "curl", version: "7.88.1-10+deb12u5", statusAbbrev: "ii" }]);
    expect(dpkgStatusIsInstalled("ii")).toBe(true);
  });

  test("'rc' is NOT installed — the classic dpkg mistake", () => {
    // The binary is gone and only /etc remains. A tool that reports this as
    // installed sends a caller looking for a program that is not there.
    const rows = parseDpkgQuery(DPKG_QUERY_NANO_REMOVED);
    expect(rows[0]?.statusAbbrev).toBe("rc");
    expect(dpkgStatusIsInstalled("rc")).toBe(false);
    expect(dpkgStatusIsInstalled("un")).toBe(false);
    expect(dpkgStatusIsInstalled("iU")).toBe(true);
  });
});

describe("parseAptCachePolicy", () => {
  test("reads Installed and Candidate, and turns '(none)' into null", () => {
    expect(parseAptCachePolicy(APT_POLICY_CURL)).toEqual({
      installed: "7.88.1-10+deb12u5",
      candidate: "7.88.1-10+deb12u7",
    });
    expect(parseAptCachePolicy(APT_POLICY_HTOP)).toEqual({
      installed: null,
      candidate: "3.2.2-2",
    });
    expect(parseAptCachePolicy(APT_POLICY_NO_CANDIDATE)).toEqual({
      installed: null,
      candidate: null,
    });
  });

  test("returns undefined for an empty document, which is not two nulls", () => {
    // "apt has never heard of this" and "apt has it and it is not installed"
    // are different answers and must not collapse into one.
    expect(parseAptCachePolicy("")).toBeUndefined();
  });

  test("finds nothing in localised output — which is why LC_ALL=C is pinned", () => {
    // This is the failure mode the pinned environment in run.ts exists to
    // prevent, captured so it has a name. The parse does not throw; it finds
    // nothing, and "nothing" would read as "not installed" if the caller did
    // not treat undefined as unknown.
    expect(parseAptCachePolicy(APT_POLICY_CURL_GERMAN)).toBeUndefined();
  });
});

describe("parseAptSimulate", () => {
  test("lists every package apt would add, and drops the Conf duplicates", () => {
    const changes = parseAptSimulate(APT_SIMULATE_HTOP);
    expect(changes.map((c) => c.name)).toEqual(["libnl-3-200", "libnl-genl-3-200", "htop"]);
    expect(changes.every((c) => c.action === "install")).toBe(true);
    expect(changes[2]).toEqual({ action: "install", name: "htop", version: "3.2.2-2" });
  });

  test("reads an upgrade's NEW version, not the bracketed old one, and keeps removals", () => {
    const changes = parseAptSimulate(APT_SIMULATE_CURL_UPGRADE);
    const curl = changes.find((c) => c.name === "curl");
    expect(curl?.version).toBe("7.88.1-10+deb12u7");
    const removal = changes.find((c) => c.action === "remove");
    expect(removal).toEqual({ action: "remove", name: "curl-legacy", version: "7.74.0-1" });
  });
});

// ---------------------------------------------------------------------------
// parsers — dnf / rpm
// ---------------------------------------------------------------------------

describe("rpm and dnf", () => {
  test("rpm reports one row per installed architecture", () => {
    const rows = parseRpmQuery(RPM_QUERY_GLIBC);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.arch)).toEqual(["x86_64", "i686"]);
  });

  test("rpm's not-installed sentence is filtered out of the rows", () => {
    // rpm writes it to STDOUT, not stderr, so it arrives mixed in with data.
    expect(parseRpmQuery(RPM_NOT_INSTALLED)).toEqual([]);
  });

  test("dnf list skips its header by SHAPE, not by its English text", () => {
    // dnf5 renamed the header; a parser keyed on the words would have broken.
    expect(parseDnfList(DNF_LIST_TREE)).toEqual([
      { name: "tree", arch: "x86_64", version: "1.8.0-10.el9", repo: "baseos" },
    ]);
  });

  test("dnf's transaction table yields the package AND its dependencies", () => {
    const rows = parseDnfTransaction(DNF_SIMULATE_TREE);
    expect(rows.map((r) => r.name)).toEqual(["tree", "libfoo"]);
    expect(rows[1]?.repo).toBe("appstream");
  });

  test("the transaction parser stops at the summary rather than reading its rows", () => {
    expect(parseDnfTransaction(DNF_SIMULATE_TREE).some((r) => r.name === "Install")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parsers — pacman
// ---------------------------------------------------------------------------

describe("pacman", () => {
  test("reads `name version` from -Q", () => {
    expect(parsePacmanQuery(PACMAN_QUERY_CURL)).toEqual([{ name: "curl", version: "8.9.1-1" }]);
  });

  test("-Si reads only the FIRST block, so two repositories do not merge", () => {
    // Merging them would report community-testing's version against extra's
    // repository — a version that is not installable from where it claims.
    const fields = parsePacmanInfo(PACMAN_SYNC_INFO_HTOP);
    expect(fields.get("Version")).toBe("3.3.0-1");
    expect(fields.get("Repository")).toBe("extra");
  });

  test("-Si folds an indented continuation into its key", () => {
    const fields = parsePacmanInfo("Description     : one\n                  two\n");
    expect(fields.get("Description")).toBe("one two");
  });

  test("--print lists every target with its version, dependencies included", () => {
    const targets = parsePacmanSimulate(PACMAN_SIMULATE_HTOP);
    expect(targets.map((t) => t.name)).toEqual(["ncurses", "lm_sensors", "htop"]);
    expect(targets[1]?.version).toBe("1:3.6.0.r41-3");
    expect(targets[0]?.repo).toBe("core");
  });
});

// ---------------------------------------------------------------------------
// parsers — winget and chocolatey
// ---------------------------------------------------------------------------

describe("parseWingetList", () => {
  test("splits a five-column row on padding and reads both versions", () => {
    const rows = parseWingetList(WINGET_LIST_GIT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "Git.Git", version: "2.45.1", available: "2.46.0" });
  });

  test("a truncated row yields NO version, with the reason", () => {
    // The survey's header-offset parser would have returned "14.40.3" here as
    // if it were the whole version. A wrong version is worse than no version.
    const rows = parseWingetList(WINGET_LIST_TRUNCATED);
    expect(rows[0]?.version).toBeNull();
    expect(rows[0]?.unparsedReason).toContain("ellipsis");
  });

  test("a four-column row reports the version but refuses to name the fourth column", () => {
    const rows = parseWingetList(WINGET_LIST_FOUR_COLUMNS);
    expect(rows[0]?.version).toBe("24.08");
    expect(rows[0]?.available).toBeNull();
    expect(rows[0]?.unparsedReason).toContain("four columns");
  });

  test("a CJK display name does not shift the columns", () => {
    // Each glyph is double-width in the console and one code unit in the
    // string, so every character offset after it is wrong — and splitting on
    // runs of two spaces is unaffected. This is the case the offset approach
    // gets silently wrong.
    const rows = parseWingetList(WINGET_LIST_CJK);
    expect(rows[0]).toMatchObject({ name: "テキスト", id: "Vendor.Text", version: "1.2.3" });
  });

  test("skips the header and the rule under it", () => {
    expect(parseWingetList(WINGET_LIST_GIT).map((r) => r.name)).toEqual(["Git"]);
  });
});

describe("chocolatey", () => {
  test("reads the pipe-separated machine-readable form", () => {
    expect(parseChocoList(CHOCO_LIST_GIT)).toEqual([
      { name: "git", version: "2.45.1" },
      { name: "git.install", version: "2.45.1" },
    ]);
  });

  test("reads the major version, which decides which list flags are legal", () => {
    expect(parseChocoMajorVersion(CHOCO_VERSION_V2)).toBe(2);
    expect(parseChocoMajorVersion(CHOCO_VERSION_V1)).toBe(0);
    expect(parseChocoMajorVersion("not a version")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// the unknown vocabulary
// ---------------------------------------------------------------------------

describe("Unknowns", () => {
  test("keeps the first, most specific reason for a field", () => {
    const unknowns = new Unknowns();
    unknowns.add("status", "dpkg-query", "the command is not installed on this host");
    unknowns.add("status", "apt", "section unavailable");
    expect(unknowns.list()[0]?.reason).toContain("not installed on this host");
  });

  test("sorts by field, so two identical calls return identical bytes", () => {
    const unknowns = new Unknowns();
    unknowns.add("status", "a", "x");
    unknowns.add("available.version", "b", "y");
    expect(unknowns.list().map((u) => u.field)).toEqual(["available.version", "status"]);
  });
});

describe("commandFailureReason", () => {
  test("keeps 'not installed', 'timed out' and 'ran and failed' apart", () => {
    const base = { code: 1, stderr: "", timedOut: false, missing: false };
    expect(commandFailureReason({ ...base, missing: true })).toContain("not installed on this host");
    expect(commandFailureReason({ ...base, timedOut: true })).toContain("within its timeout");
    expect(commandFailureReason({ ...base, stderr: "E: broken\n" })).toContain("E: broken");
  });
});

test("firstLine caps a manager's forty-line usage message", () => {
  expect(firstLine(`${"x".repeat(400)}\nsecond`)).toHaveLength(200);
  expect(firstLine("\n\n  real line  \n")).toBe("real line");
});

// ---------------------------------------------------------------------------
// the containment gate (house rule 14)
// ---------------------------------------------------------------------------

describe("paths", () => {
  test("the shared containment gate refuses an escape", () => {
    // Neither tool in this package takes a path — `no schema accepts a path`
    // in index.test.ts asserts that — so this gate currently guards nothing.
    // It is here, verbatim from tool-pkg, so that the first input that DOES
    // take a path has a correct gate to pass through rather than a new one
    // written in a hurry.
    expect(() => resolveSafe("PackageQuery", "../../etc/passwd")).toThrow(ToolPermissionError);
    expect(() => resolveSafe("PackageQuery", "/etc/passwd")).toThrow(ToolPermissionError);
  });
});
