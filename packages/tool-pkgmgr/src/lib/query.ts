/**
 * Asking a manager about one package — the code both tools share.
 *
 * `PackageQuery` returns what this produces. `PackageInstall` calls exactly
 * the same function to resolve what it would install, and again afterwards to
 * report what it actually installed. That is not a convenience: house rule 9
 * says a dry run must run the SAME selection code as the real path, and the
 * only way to guarantee it is for there to be one path.
 *
 * ── THREE-VALUED, ALWAYS ──────────────────────────────────────────────────
 *
 * `status` is `"installed"`, `"not-installed"` or `"unknown"`, and the third
 * one is never collapsed into the second. A manager that is not on this host,
 * a command that hit its deadline, output that did not parse, a cache that
 * was empty — every one of those is `"unknown"` with a reason, because a
 * caller that reads "not installed" will install something, and installing
 * because a probe timed out is how a tool breaks a machine.
 *
 * `knownToManager` is separate from `status` for the same reason: "apt has
 * never heard of `curl-x`" and "apt has `curl` and it is not installed" are
 * different answers, and only the second one means an install would work.
 */
import type { HostPlatform } from "../host";
import { DEFAULT_COMMAND_TIMEOUT_MS, type RunResult, runHostCommand } from "../run";
import {
  MANAGERS,
  MANAGER_ENV,
  type ManagerId,
  PKGMGR_COMMANDS,
  managersForPlatform,
  withOperand,
} from "./managers";
import {
  type BrewEntry,
  WINGET_NO_PACKAGES_FOUND,
  aptSaysNoSuchPackage,
  brewSaysNoSuchPackage,
  dnfSaysNoCache,
  dnfSaysNoMatch,
  dpkgSaysNoSuchPackage,
  dpkgStatusIsInstalled,
  pacmanSaysNoSuchPackage,
  parseAptCachePolicy,
  parseBrewInfoJson,
  parseChocoList,
  parseChocoMajorVersion,
  parseDnfList,
  parseDpkgQuery,
  parsePacmanInfo,
  parsePacmanQuery,
  parseRpmQuery,
  parseWingetList,
  rpmSaysNotInstalled,
} from "./parse";
import { type Unknowns, commandFailureReason, firstLine } from "./unknown";

/** One command this package ran, kept so a result can show its own evidence. */
export type Probe = {
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly ok: boolean;
  /** Present when the program itself is not on this host. */
  readonly missing?: boolean;
  readonly timedOut?: boolean;
};

export type RunContext = {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Filled in as commands run, in order. */
  readonly probes: Probe[];
};

export function newContext(
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  signal?: AbortSignal,
): RunContext {
  return { timeoutMs, ...(signal !== undefined ? { signal } : {}), probes: [] };
}

/** Run one command and record it. The only entry point to `../run.ts` here. */
export async function run(
  ctx: RunContext,
  manager: ManagerId,
  argv: readonly string[],
): Promise<RunResult> {
  const result = await runHostCommand({
    argv,
    timeoutMs: ctx.timeoutMs,
    env: MANAGER_ENV[manager],
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  });
  ctx.probes.push({
    argv,
    exitCode: result.code,
    ok: result.code === 0 && !result.timedOut && !result.missing,
    ...(result.missing ? { missing: true } : {}),
    ...(result.timedOut ? { timedOut: true } : {}),
  });
  return result;
}

/**
 * A stream that hit the capture ceiling is not an answer.
 *
 * A truncated `apt-get -s` or `brew list` parses perfectly and is simply
 * MISSING packages, so the tail that did not arrive would be read as "not
 * there". Every reader below checks this before it believes a parse.
 */
function truncated(result: RunResult): boolean {
  return result.stdoutTruncated === true || result.stderrTruncated === true;
}

// ---------------------------------------------------------------------------
// which manager
// ---------------------------------------------------------------------------

export type Detection =
  | {
      readonly kind: "found";
      readonly manager: ManagerId;
      /** Managers looked for before this one, and not found. */
      readonly tried: readonly ManagerId[];
    }
  | {
      readonly kind: "unknown";
      readonly tried: readonly ManagerId[];
      readonly reason: string;
    };

/**
 * Find the system package manager, or say that there is none.
 *
 * A caller may name one, in which case only that one is probed and an absence
 * is reported against it by name. Otherwise the platform's list is walked in
 * order (see `managersForPlatform`) and the first one that answers its
 * `--version` probe wins.
 *
 * On a platform with no entry — which includes the hostile `"other"` default
 * a test gets when it forgets to declare a platform — nothing is probed and
 * the answer is `unknown`. That is also the honest answer on a host with no
 * package manager at all, which is what CI is: an unrecognised manager is
 * reported as unknown rather than guessed at.
 */
export async function detectManager(
  ctx: RunContext,
  platform: HostPlatform,
  requested?: ManagerId,
): Promise<Detection> {
  const candidates = requested !== undefined ? [requested] : managersForPlatform(platform);
  if (candidates.length === 0) {
    return {
      kind: "unknown",
      tried: [],
      reason:
        platform === "other"
          ? "this host reports a platform this package has no backend for, so no package manager was probed"
          : `no package manager is known for platform "${platform}"`,
    };
  }
  // A caller-named manager is probed even when the platform table does not
  // list it: Homebrew on Linux is real, and a container can carry a manager
  // its platform does not usually have. The probe decides, not the table.
  const tried: ManagerId[] = [];
  for (const id of candidates) {
    const result = await run(ctx, id, MANAGERS[id].detect);
    tried.push(id);
    if (result.code === 0 && !result.timedOut && !result.missing) {
      return { kind: "found", manager: id, tried };
    }
  }
  const names = tried.map((id) => MANAGERS[id].label).join(", ");
  return {
    kind: "unknown",
    tried,
    reason:
      requested !== undefined
        ? `${MANAGERS[requested].label} did not answer its --version probe on this host`
        : `none of the package managers this package supports answered a --version probe on this ${platform} host (tried ${names})`,
  };
}

// ---------------------------------------------------------------------------
// the query itself
// ---------------------------------------------------------------------------

export type Availability = {
  /** The version the local index offers, or null when it could not be read. */
  readonly version: string | null;
  /** Which tap/repository/source it came from, or null. */
  readonly source: string | null;
};

export type PackageFacts = {
  readonly manager: ManagerId;
  readonly name: string;
  readonly status: "installed" | "not-installed" | "unknown";
  /**
   * Versions on disk. An ARRAY because Homebrew legitimately keeps several
   * kegs of one formula, and reporting the first as "the" version would be
   * wrong for exactly the formulae people ask about. `null` means could not
   * determine, which is not the same as `[]`.
   */
  readonly installedVersions: readonly string[] | null;
  /**
   * Whether the manager has a record of this name at all. `null` when that
   * could not be determined either.
   */
  readonly knownToManager: boolean | null;
  readonly available: Availability | null;
  /** Homebrew only: a pinned formula will not be upgraded. */
  readonly pinned?: boolean;
  /** The manager's own word for "there is a newer version", where it has one. */
  readonly outdated?: boolean;
  readonly kind?: "formula" | "cask";
  readonly notes: readonly string[];
};

/**
 * Ask one manager about one name.
 *
 * `name` must already have passed `checkPackageName`; this function appends it
 * to a frozen argv prefix and never inspects it again.
 */
export async function queryPackage(
  ctx: RunContext,
  manager: ManagerId,
  name: string,
  unknowns: Unknowns,
  includeAvailable: boolean,
): Promise<PackageFacts> {
  switch (manager) {
    case "homebrew":
      return queryHomebrew(ctx, name, unknowns, includeAvailable);
    case "apt":
      return queryApt(ctx, name, unknowns, includeAvailable);
    case "dnf":
      return queryDnf(ctx, name, unknowns, includeAvailable);
    case "pacman":
      return queryPacman(ctx, name, unknowns, includeAvailable);
    case "winget":
      return queryWinget(ctx, name, unknowns, includeAvailable);
    case "choco":
      return queryChoco(ctx, name, unknowns, includeAvailable);
  }
}

/** The shape every branch below returns when it has nothing at all. */
function unknownFacts(manager: ManagerId, name: string, notes: string[] = []): PackageFacts {
  return {
    manager,
    name,
    status: "unknown",
    installedVersions: null,
    knownToManager: null,
    available: null,
    notes,
  };
}

// ---- Homebrew -------------------------------------------------------------

async function queryHomebrew(
  ctx: RunContext,
  name: string,
  unknowns: Unknowns,
  includeAvailable: boolean,
): Promise<PackageFacts> {
  const spec = MANAGERS.homebrew;
  const argv = withOperand(spec, PKGMGR_COMMANDS.brewInfoJson, name);
  const result = await run(ctx, "homebrew", argv);
  const probe = argv.join(" ");

  if (result.missing || result.timedOut || truncated(result)) {
    const reason = truncated(result)
      ? "brew's output was cut at this package's capture ceiling, so the document is incomplete and was not parsed"
      : commandFailureReason(result);
    unknowns.add("status", probe, reason);
    unknowns.add("available.version", probe, reason);
    return unknownFacts("homebrew", name);
  }

  if (result.code !== 0) {
    if (brewSaysNoSuchPackage(result.stderr)) {
      // Homebrew's own not-found sentence — the only thing that turns a
      // non-zero exit into "there is no such package".
      return {
        manager: "homebrew",
        name,
        status: "not-installed",
        installedVersions: [],
        knownToManager: false,
        available: null,
        notes: ["Homebrew has no formula or cask with this name in the taps on this host"],
      };
    }
    const reason = commandFailureReason(result);
    unknowns.add("status", probe, reason);
    unknowns.add("available.version", probe, reason);
    return unknownFacts("homebrew", name);
  }

  const info = parseBrewInfoJson(result.stdout);
  if (info === undefined) {
    const reason = `brew exited 0 but did not print a --json=v2 document (${firstLine(result.stdout) || "empty output"})`;
    unknowns.add("status", probe, reason);
    unknowns.add("available.version", probe, reason);
    return unknownFacts("homebrew", name);
  }
  const entry: BrewEntry | undefined = info.formula ?? info.cask;
  if (entry === undefined) {
    return {
      manager: "homebrew",
      name,
      status: "not-installed",
      installedVersions: [],
      knownToManager: false,
      available: null,
      notes: ["brew returned an empty formula and cask list for this name"],
    };
  }
  const notes: string[] = [];
  if (info.formula !== undefined && info.cask !== undefined) {
    notes.push(
      "this name matches both a formula and a cask; the formula is reported, and the cask is a different package",
    );
  }
  if (!includeAvailable) {
    unknowns.add("available.version", probe, "the caller asked for installed state only");
  } else if (entry.stableVersion === null) {
    unknowns.add(
      "available.version",
      probe,
      "brew's document has no stable version for this name (a HEAD-only formula, or a cask without a version)",
    );
  }
  return {
    manager: "homebrew",
    name,
    status: entry.installedVersions.length > 0 ? "installed" : "not-installed",
    installedVersions: [...entry.installedVersions],
    knownToManager: true,
    available:
      includeAvailable && entry.stableVersion !== null
        ? { version: entry.stableVersion, source: entry.tap }
        : null,
    pinned: entry.pinned,
    outdated: entry.outdated,
    kind: entry.kind,
    notes,
  };
}

// ---- apt / dpkg -----------------------------------------------------------

async function queryApt(
  ctx: RunContext,
  name: string,
  unknowns: Unknowns,
  includeAvailable: boolean,
): Promise<PackageFacts> {
  const spec = MANAGERS.apt;
  const dpkgArgv = withOperand(spec, PKGMGR_COMMANDS.dpkgQuery, name);
  const dpkg = await run(ctx, "apt", dpkgArgv);
  const dpkgProbe = dpkgArgv.join(" ");

  let status: PackageFacts["status"] = "unknown";
  let installedVersions: string[] | null = null;
  let knownToManager: boolean | null = null;
  const notes: string[] = [];

  if (dpkg.missing || dpkg.timedOut || truncated(dpkg)) {
    unknowns.add(
      "status",
      dpkgProbe,
      truncated(dpkg)
        ? "dpkg-query's output was cut at this package's capture ceiling"
        : commandFailureReason(dpkg),
    );
  } else if (dpkg.code === 0) {
    const rows = parseDpkgQuery(dpkg.stdout);
    // `-W <name>` can match several binary packages when the name carries an
    // architecture qualifier; the exact name wins, and anything else is a
    // note rather than a silent pick.
    const exact = rows.find((r) => r.name === name || `${r.name}:`.startsWith(`${name}:`));
    const row = exact ?? rows[0];
    if (row === undefined) {
      unknowns.add("status", dpkgProbe, "dpkg-query exited 0 but printed no rows");
    } else {
      if (rows.length > 1) {
        notes.push(
          `dpkg knows ${rows.length} binary packages matching this name; the one reported is "${row.name}"`,
        );
      }
      knownToManager = true;
      if (dpkgStatusIsInstalled(row.statusAbbrev)) {
        status = "installed";
        installedVersions = [row.version];
      } else {
        status = "not-installed";
        installedVersions = [];
        if (row.statusAbbrev.startsWith("r")) {
          notes.push(
            `dpkg status is "${row.statusAbbrev}": the package was removed but its configuration files are still on disk, which is not the same as installed`,
          );
        }
      }
    }
  } else if (dpkgSaysNoSuchPackage(dpkg.stderr)) {
    // dpkg has no record. That is not yet "not known to apt": a package that
    // has never been installed is absent from dpkg's database and still very
    // much available, which the policy call below decides.
    status = "not-installed";
    installedVersions = [];
  } else {
    unknowns.add("status", dpkgProbe, commandFailureReason(dpkg));
  }

  let available: Availability | null = null;
  if (!includeAvailable) {
    unknowns.add(
      "available.version",
      "apt-cache policy",
      "the caller asked for installed state only",
    );
  } else {
    const policyArgv = withOperand(spec, PKGMGR_COMMANDS.aptCachePolicy, name);
    const policy = await run(ctx, "apt", policyArgv);
    const policyProbe = policyArgv.join(" ");
    if (policy.missing || policy.timedOut || truncated(policy)) {
      unknowns.add("available.version", policyProbe, commandFailureReason(policy));
    } else if (policy.code !== 0 && !aptSaysNoSuchPackage(policy.stderr)) {
      unknowns.add("available.version", policyProbe, commandFailureReason(policy));
    } else {
      const parsed = parseAptCachePolicy(policy.stdout);
      if (parsed === undefined) {
        if (policy.stdout.trim() === "" || aptSaysNoSuchPackage(policy.stderr)) {
          // apt-cache prints nothing at all for a name it does not know.
          if (knownToManager === null) knownToManager = false;
          available = null;
          notes.push("apt has no record of this package in its downloaded package lists");
        } else {
          unknowns.add(
            "available.version",
            policyProbe,
            "apt-cache policy printed neither an Installed nor a Candidate label — either its output is not English despite the pinned C locale, or the format has changed",
          );
        }
      } else {
        knownToManager = true;
        available = parsed.candidate === null ? null : { version: parsed.candidate, source: "apt" };
        if (parsed.candidate === null) {
          unknowns.add(
            "available.version",
            policyProbe,
            "apt has this package in its lists but no installation candidate, so no version can be installed from the configured sources",
          );
        }
        // The two probes can disagree: a package held back, or a dpkg
        // database read between an apt operation's two halves. Saying so is
        // better than picking one.
        if (
          status === "installed" &&
          installedVersions?.[0] !== undefined &&
          parsed.installed !== null &&
          parsed.installed !== installedVersions[0]
        ) {
          notes.push(
            `dpkg reports ${installedVersions[0]} installed and apt-cache reports ${parsed.installed}; the dpkg answer is the one on disk`,
          );
        }
      }
    }
  }

  return {
    manager: "apt",
    name,
    status,
    installedVersions,
    knownToManager,
    available,
    notes,
  };
}

// ---- dnf / rpm ------------------------------------------------------------

async function queryDnf(
  ctx: RunContext,
  name: string,
  unknowns: Unknowns,
  includeAvailable: boolean,
): Promise<PackageFacts> {
  const spec = MANAGERS.dnf;
  const rpmArgv = withOperand(spec, PKGMGR_COMMANDS.rpmQuery, name);
  const rpm = await run(ctx, "dnf", rpmArgv);
  const rpmProbe = rpmArgv.join(" ");

  let status: PackageFacts["status"] = "unknown";
  let installedVersions: string[] | null = null;
  let knownToManager: boolean | null = null;
  const notes: string[] = [];

  if (rpm.missing || rpm.timedOut || truncated(rpm)) {
    unknowns.add("status", rpmProbe, commandFailureReason(rpm));
  } else if (rpm.code === 0) {
    const rows = parseRpmQuery(rpm.stdout);
    if (rows.length === 0) {
      unknowns.add("status", rpmProbe, "rpm exited 0 but printed no rows this parser could read");
    } else {
      status = "installed";
      knownToManager = true;
      // Several rows means the same name installed for several
      // architectures — a real and common state on x86_64 with i686 libs.
      installedVersions = rows.map((r) => r.evr);
      if (rows.length > 1) {
        notes.push(
          `rpm reports ${rows.length} installed packages with this name (architectures: ${rows.map((r) => r.arch).join(", ")})`,
        );
      }
    }
  } else if (rpmSaysNotInstalled(rpm.stdout)) {
    status = "not-installed";
    installedVersions = [];
  } else {
    unknowns.add("status", rpmProbe, commandFailureReason(rpm));
  }

  let available: Availability | null = null;
  if (!includeAvailable) {
    unknowns.add("available.version", "dnf list", "the caller asked for installed state only");
  } else {
    const listArgv = withOperand(spec, PKGMGR_COMMANDS.dnfListAvailable, name);
    const list = await run(ctx, "dnf", listArgv);
    const listProbe = listArgv.join(" ");
    const combined = `${list.stdout}\n${list.stderr}`;
    if (list.missing || list.timedOut || truncated(list)) {
      unknowns.add("available.version", listProbe, commandFailureReason(list));
    } else if (dnfSaysNoCache(combined)) {
      // The case `--cacheonly` makes common, and the case rule 6 is about:
      // an empty metadata cache is not an absent package.
      unknowns.add(
        "available.version",
        listProbe,
        "dnf's repository metadata is not cached on this host and this tool does not fetch it, so what is available could not be determined — run `dnf makecache` to populate it",
      );
    } else {
      const rows = parseDnfList(list.stdout);
      const row = rows[0];
      if (row !== undefined) {
        knownToManager = true;
        available = { version: row.version, source: row.repo };
        if (rows.length > 1) {
          notes.push(
            `dnf lists ${rows.length} available builds of this name (architectures: ${rows.map((r) => r.arch).join(", ")}); the first is reported`,
          );
        }
      } else if (dnfSaysNoMatch(combined)) {
        if (knownToManager === null) knownToManager = false;
        notes.push("dnf's enabled repositories have no package with this name");
      } else {
        unknowns.add(
          "available.version",
          listProbe,
          `dnf exited ${list.code} and printed no row this parser could read (${firstLine(combined) || "empty output"})`,
        );
      }
    }
  }

  return { manager: "dnf", name, status, installedVersions, knownToManager, available, notes };
}

// ---- pacman ---------------------------------------------------------------

async function queryPacman(
  ctx: RunContext,
  name: string,
  unknowns: Unknowns,
  includeAvailable: boolean,
): Promise<PackageFacts> {
  const spec = MANAGERS.pacman;
  const queryArgv = withOperand(spec, PKGMGR_COMMANDS.pacmanQuery, name);
  const query = await run(ctx, "pacman", queryArgv);
  const queryProbe = queryArgv.join(" ");

  let status: PackageFacts["status"] = "unknown";
  let installedVersions: string[] | null = null;
  let knownToManager: boolean | null = null;
  const notes: string[] = [];

  if (query.missing || query.timedOut || truncated(query)) {
    unknowns.add("status", queryProbe, commandFailureReason(query));
  } else if (query.code === 0) {
    const rows = parsePacmanQuery(query.stdout);
    const row = rows[0];
    if (row === undefined) {
      unknowns.add("status", queryProbe, "pacman exited 0 but printed no `name version` row");
    } else {
      status = "installed";
      knownToManager = true;
      installedVersions = [row.version];
    }
  } else if (pacmanSaysNoSuchPackage(query.stderr)) {
    status = "not-installed";
    installedVersions = [];
  } else {
    unknowns.add("status", queryProbe, commandFailureReason(query));
  }

  let available: Availability | null = null;
  if (!includeAvailable) {
    unknowns.add("available.version", "pacman -Si", "the caller asked for installed state only");
  } else {
    const infoArgv = withOperand(spec, PKGMGR_COMMANDS.pacmanSyncInfo, name);
    const info = await run(ctx, "pacman", infoArgv);
    const infoProbe = infoArgv.join(" ");
    if (info.missing || info.timedOut || truncated(info)) {
      unknowns.add("available.version", infoProbe, commandFailureReason(info));
    } else if (info.code === 0) {
      const fields = parsePacmanInfo(info.stdout);
      const version = fields.get("Version");
      const repo = fields.get("Repository") ?? null;
      if (version === undefined) {
        unknowns.add(
          "available.version",
          infoProbe,
          "pacman -Si printed a block with no Version field — either its output is not English despite the pinned C locale, or the format has changed",
        );
      } else {
        knownToManager = true;
        available = { version, source: repo };
      }
    } else if (pacmanSaysNoSuchPackage(info.stderr)) {
      if (knownToManager === null) knownToManager = false;
      notes.push("pacman's sync databases have no package with this name");
    } else {
      unknowns.add("available.version", infoProbe, commandFailureReason(info));
    }
  }

  return { manager: "pacman", name, status, installedVersions, knownToManager, available, notes };
}

// ---- winget ---------------------------------------------------------------

async function queryWinget(
  ctx: RunContext,
  name: string,
  unknowns: Unknowns,
  _includeAvailable: boolean,
): Promise<PackageFacts> {
  const spec = MANAGERS.winget;
  const argv = withOperand(spec, PKGMGR_COMMANDS.wingetList, name);
  const result = await run(ctx, "winget", argv);
  const probe = argv.join(" ");

  // winget's available version comes only from its source, over the network,
  // and this package makes no network call. Said once, always.
  unknowns.add("available.version", "not probed", spec.availableReason ?? "not probed");

  if (result.missing || result.timedOut || truncated(result)) {
    unknowns.add("status", probe, commandFailureReason(result));
    return unknownFacts("winget", name);
  }
  if (result.code === WINGET_NO_PACKAGES_FOUND) {
    // The one part of winget's answer that is neither localised nor
    // column-aligned: its documented "no installed package matched" code.
    return {
      manager: "winget",
      name,
      status: "not-installed",
      installedVersions: [],
      knownToManager: null,
      available: null,
      notes: [
        "winget reported no installed package with this Id; whether its source has one was not asked, because that is a network query",
      ],
    };
  }
  if (result.code !== 0) {
    unknowns.add("status", probe, commandFailureReason(result));
    return unknownFacts("winget", name);
  }
  const rows = parseWingetList(result.stdout);
  const row = rows[0];
  if (row === undefined) {
    unknowns.add(
      "status",
      probe,
      "winget exited 0 but printed no row this parser could split on column padding, so whether the package is installed could not be determined",
    );
    return unknownFacts("winget", name);
  }
  const notes: string[] = [];
  if (rows.length > 1) {
    notes.push(`winget listed ${rows.length} matching packages; the first is reported`);
  }
  if (row.unparsedReason !== undefined) {
    unknowns.add("installedVersions", probe, row.unparsedReason);
    notes.push(`winget's row for "${row.id}" could not be split safely`);
  }
  return {
    manager: "winget",
    name,
    status: "installed",
    installedVersions: row.version === null ? null : [row.version],
    knownToManager: true,
    available: null,
    notes,
  };
}

// ---- chocolatey -----------------------------------------------------------

async function queryChoco(
  ctx: RunContext,
  name: string,
  unknowns: Unknowns,
  _includeAvailable: boolean,
): Promise<PackageFacts> {
  const spec = MANAGERS.choco;
  unknowns.add("available.version", "not probed", spec.availableReason ?? "not probed");

  const versionResult = await run(ctx, "choco", PKGMGR_COMMANDS.chocoVersion);
  const versionProbe = PKGMGR_COMMANDS.chocoVersion.join(" ");
  if (versionResult.missing || versionResult.timedOut) {
    unknowns.add("status", versionProbe, commandFailureReason(versionResult));
    return unknownFacts("choco", name);
  }
  const major = parseChocoMajorVersion(versionResult.stdout);
  if (major === undefined) {
    // Not a nicety: `--local-only` was removed in Chocolatey 2.0, and on v1
    // `choco list` without it searches the REMOTE feed. Guessing would answer
    // "installed, 8.7.1" for a package that is not installed at all.
    unknowns.add(
      "status",
      versionProbe,
      "chocolatey's version could not be read, and which `choco list` flags are legal depends on it (--local-only was removed in 2.0, and without it a v1 `choco list` searches the remote feed instead of the machine)",
    );
    return unknownFacts("choco", name);
  }
  const prefix = major >= 2 ? PKGMGR_COMMANDS.chocoListV2 : PKGMGR_COMMANDS.chocoListV1;
  const argv = withOperand(spec, prefix, name);
  const result = await run(ctx, "choco", argv);
  const probe = argv.join(" ");
  if (result.missing || result.timedOut || truncated(result)) {
    unknowns.add("status", probe, commandFailureReason(result));
    return unknownFacts("choco", name);
  }
  if (result.code !== 0) {
    unknowns.add("status", probe, commandFailureReason(result));
    return unknownFacts("choco", name);
  }
  const rows = parseChocoList(result.stdout);
  // Chocolatey ids are case-insensitive, and `--exact` matches them that way.
  const row = rows.find((r) => r.name.toLowerCase() === name.toLowerCase());
  if (row === undefined) {
    return {
      manager: "choco",
      name,
      status: "not-installed",
      installedVersions: [],
      knownToManager: null,
      available: null,
      notes: [
        `chocolatey ${major >= 2 ? "2.x" : "1.x"} listed no installed package with this id; whether its feed has one was not asked, because that is a network query`,
      ],
    };
  }
  return {
    manager: "choco",
    name,
    status: "installed",
    installedVersions: [row.version],
    knownToManager: true,
    available: null,
    notes: [],
  };
}
