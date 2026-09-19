/**
 * What an install WOULD do — resolved once, by one function, for both the dry
 * run and the real thing.
 *
 * House rule 9 exists because a preview that re-derives the answer separately
 * eventually describes something the real call does not do; TrashPath drifted
 * exactly that way and predicted a destination the real call never used. The
 * defence here is structural rather than disciplinary: `resolveInstallPlan`
 * is the ONLY code that decides what gets installed, `dryRun` does not change
 * which commands run to resolve it, and the single `if` that separates the
 * two paths is in `../index.ts` AFTER this returns — it decides whether the
 * install command runs, and nothing else.
 *
 * The cost is one extra command on the real path: a real install resolves its
 * plan first, exactly as a dry run does. That is the point. The result then
 * reports what it EXPECTED to install next to what it did, and a caller can
 * see the difference rather than trust that there was none.
 *
 * ── WHAT "TRANSITIVE ADDITIONS" ACTUALLY COSTS, PER MANAGER ───────────────
 *
 * The catalogue implies every manager can preview a transaction. Four can,
 * and they differ:
 *
 *   apt      `apt-get install -s` resolves the whole transaction WITHOUT
 *            root and prints every package with its version, including
 *            removals. This is the complete answer.
 *   pacman   `pacman -S --print --print-format` prints every target with its
 *            version, dependencies included, without root. Also complete.
 *   dnf      `dnf install --assumeno` prints the transaction table and then
 *            declines — but dnf may refuse before resolving anything when it
 *            is not root. Both outcomes are reported for what they are.
 *   brew     has no dry run for `install` at all. The additions are derived
 *            from `brew deps` minus `brew list --versions`, which is the same
 *            resolution the real install performs, and the derivation is
 *            named in the result as `brew-deps` rather than passed off as a
 *            manager-provided plan.
 */
import { MANAGERS, type ManagerId, PKGMGR_COMMANDS, withOperand } from "./managers";
import {
  aptSaysNeedsRoot,
  dnfSaysNeedsRoot,
  pacmanSaysNeedsRoot,
  parseAptSimulate,
  parseBrewDeps,
  parseBrewListVersions,
  parseDnfTransaction,
  parsePacmanSimulate,
} from "./parse";
import { type PackageFacts, type RunContext, run } from "./query";
import { type Unknowns, commandFailureReason, firstLine } from "./unknown";

export type PlannedPackage = {
  readonly name: string;
  readonly version: string | null;
  /** Present when the manager said which repository it comes from. */
  readonly source?: string | null;
};

export type PlanSource = "apt-simulate" | "pacman-print" | "dnf-assumeno" | "brew-deps";

export type InstallPlan = {
  readonly manager: ManagerId;
  readonly name: string;
  /** Exactly what would be appended to the manager's argv. */
  readonly operand: string;
  /** The version the caller pinned, when the manager can express one. */
  readonly requestedVersion: string | null;
  /**
   * What the call would do. `none` means the requested state already holds —
   * the one case where the honest answer is to run nothing at all.
   */
  readonly action: "install" | "upgrade" | "reinstall" | "none";
  /**
   * Versions ALREADY on disk. This is the field that makes `destructive:true`
   * meaningful: an install can replace a working version, and an operator
   * approving one should see the version they are about to lose.
   */
  readonly currentVersions: readonly string[] | null;
  /** The version the plan expects to end up with, where it could be read. */
  readonly targetVersion: string | null;
  /**
   * Packages the manager would add BESIDES the named one — the transitive
   * closure, where the manager will tell us. `null` means it would not.
   */
  readonly additions: readonly PlannedPackage[] | null;
  /** Packages the manager would REMOVE. apt is the only one that says. */
  readonly removals: readonly PlannedPackage[] | null;
  readonly planSource: PlanSource | null;
  /** Why `additions` is null, when it is. */
  readonly planUnavailableReason?: string;
  readonly notes: readonly string[];
};

/**
 * Decide what the install would do, and ask the manager what else it would
 * drag in.
 *
 * `facts` comes from `queryPackage` — the same function `PackageQuery` calls,
 * so the installed-version this plan reports and the one a caller can read
 * for themselves are produced by one code path, not two.
 */
export async function resolveInstallPlan(
  ctx: RunContext,
  manager: ManagerId,
  name: string,
  operand: string,
  requestedVersion: string | null,
  facts: PackageFacts,
  unknowns: Unknowns,
): Promise<InstallPlan> {
  const notes: string[] = [];
  const current = facts.installedVersions;

  let action: InstallPlan["action"];
  if (facts.status === "unknown") {
    // Could not determine is not "not installed": the plan says `install`
    // because that is what the command would do, and the unknown travels with
    // it so nobody reads the missing current version as "there was none".
    action = "install";
    notes.push(
      "whether this package is already installed could not be determined, so this plan cannot say whether the install would replace a working version",
    );
  } else if (facts.status === "not-installed" || current === null || current.length === 0) {
    action = "install";
  } else if (requestedVersion !== null && current.includes(requestedVersion)) {
    action = "none";
  } else if (requestedVersion !== null) {
    action = "upgrade";
    notes.push(
      `version ${requestedVersion} was requested and ${current.join(", ")} is installed; the manager decides whether that is an upgrade or a downgrade`,
    );
  } else if (facts.outdated === true) {
    action = "upgrade";
  } else if (facts.available?.version !== undefined && facts.available.version !== null) {
    action = current.includes(facts.available.version) ? "none" : "upgrade";
  } else {
    // Installed, and nothing said a newer version exists. `reinstall` rather
    // than `none`: the manager may still do work, and claiming "nothing would
    // happen" without evidence is the guess this package does not make.
    action = "reinstall";
    notes.push(
      "this package is installed and no available version could be read, so whether the command would change anything is not known",
    );
  }

  const targetVersion = requestedVersion ?? facts.available?.version ?? null;
  if (targetVersion === null) {
    unknowns.add(
      "plan.targetVersion",
      MANAGERS[manager].label,
      "the version this install would land on could not be read from the local index",
    );
  }

  const closure = await resolveClosure(ctx, manager, operand, unknowns);
  if (closure.reason !== undefined) {
    unknowns.add("plan.additions", closure.probe, closure.reason);
  }

  return {
    manager,
    name,
    operand,
    requestedVersion,
    action,
    currentVersions: current,
    targetVersion,
    additions: closure.additions,
    removals: closure.removals,
    planSource: closure.source,
    ...(closure.reason !== undefined ? { planUnavailableReason: closure.reason } : {}),
    notes: [...notes, ...closure.notes],
  };
}

type Closure = {
  readonly additions: PlannedPackage[] | null;
  readonly removals: PlannedPackage[] | null;
  readonly source: PlanSource | null;
  readonly probe: string;
  readonly reason?: string;
  readonly notes: string[];
};

async function resolveClosure(
  ctx: RunContext,
  manager: ManagerId,
  operand: string,
  unknowns: Unknowns,
): Promise<Closure> {
  switch (manager) {
    case "apt":
      return closureApt(ctx, operand);
    case "pacman":
      return closurePacman(ctx, operand);
    case "dnf":
      return closureDnf(ctx, operand);
    case "homebrew":
      return closureBrew(ctx, operand, unknowns);
    // Neither is ever reached: `../index.ts` refuses an install through these
    // two before a plan is resolved. Kept total so the switch has no default.
    case "winget":
    case "choco":
      return {
        additions: null,
        removals: null,
        source: null,
        probe: "not probed",
        reason: MANAGERS[manager].install.supported
          ? "not probed"
          : MANAGERS[manager].install.reason,
        notes: [],
      };
  }
}

async function closureApt(ctx: RunContext, operand: string): Promise<Closure> {
  const argv = withOperand(MANAGERS.apt, PKGMGR_COMMANDS.aptSimulate, operand);
  const probe = argv.join(" ");
  const result = await run(ctx, "apt", argv);
  if (result.missing || result.timedOut) {
    return {
      additions: null,
      removals: null,
      source: null,
      probe,
      reason: commandFailureReason(result),
      notes: [],
    };
  }
  if (result.stdoutTruncated === true) {
    // A truncated simulation parses perfectly and is simply MISSING packages.
    // Reporting the prefix as the plan is how an operator approves a
    // transaction they have not seen.
    return {
      additions: null,
      removals: null,
      source: null,
      probe,
      reason:
        "apt's simulation output was cut at this package's capture ceiling, so the transaction it describes is incomplete and was not used",
      notes: [],
    };
  }
  if (result.code !== 0) {
    return {
      additions: null,
      removals: null,
      source: null,
      probe,
      reason: aptSaysNeedsRoot(`${result.stdout}\n${result.stderr}`)
        ? "apt refused to simulate without root, which is unusual — `apt-get install -s` normally needs none"
        : `${commandFailureReason(result)} (${firstLine(result.stderr) || firstLine(result.stdout)})`,
      notes: [],
    };
  }
  const changes = parseAptSimulate(result.stdout);
  if (changes.length === 0) {
    return {
      additions: [],
      removals: [],
      source: "apt-simulate",
      probe,
      notes: ["apt's simulation lists no package changes, so the requested state already holds"],
    };
  }
  const installs = changes.filter((c) => c.action === "install");
  const removals = changes.filter((c) => c.action === "remove");
  const notes: string[] = [];
  if (removals.length > 0) {
    notes.push(
      `this transaction REMOVES ${removals.length} package(s) — an install that removes something is the case worth reading before approving`,
    );
  }
  return {
    additions: installs.map((c) => ({ name: c.name, version: c.version })),
    removals: removals.map((c) => ({ name: c.name, version: c.version })),
    source: "apt-simulate",
    probe,
    notes,
  };
}

async function closurePacman(ctx: RunContext, operand: string): Promise<Closure> {
  const argv = withOperand(MANAGERS.pacman, PKGMGR_COMMANDS.pacmanSimulate, operand);
  const probe = argv.join(" ");
  const result = await run(ctx, "pacman", argv);
  if (result.missing || result.timedOut || result.stdoutTruncated === true) {
    return {
      additions: null,
      removals: null,
      source: null,
      probe,
      reason:
        result.stdoutTruncated === true
          ? "pacman's target list was cut at this package's capture ceiling, so it is incomplete and was not used"
          : commandFailureReason(result),
      notes: [],
    };
  }
  if (result.code !== 0) {
    return {
      additions: null,
      removals: null,
      source: null,
      probe,
      reason: pacmanSaysNeedsRoot(result.stderr)
        ? "pacman refused to print its targets without root, which is unusual — `pacman -S --print` normally needs none"
        : `${commandFailureReason(result)}`,
      notes: [],
    };
  }
  const targets = parsePacmanSimulate(result.stdout);
  return {
    additions: targets.map((t) => ({ name: t.name, version: t.version, source: t.repo })),
    removals: [],
    source: "pacman-print",
    probe,
    notes:
      targets.length === 0
        ? ["pacman printed no targets, so the requested state already holds"]
        : [
            "pacman's target list includes the named package itself as well as every dependency it would pull in",
          ],
  };
}

async function closureDnf(ctx: RunContext, operand: string): Promise<Closure> {
  const argv = withOperand(MANAGERS.dnf, PKGMGR_COMMANDS.dnfSimulate, operand);
  const probe = argv.join(" ");
  const result = await run(ctx, "dnf", argv);
  const combined = `${result.stdout}\n${result.stderr}`;
  if (result.missing || result.timedOut || result.stdoutTruncated === true) {
    return {
      additions: null,
      removals: null,
      source: null,
      probe,
      reason:
        result.stdoutTruncated === true
          ? "dnf's transaction table was cut at this package's capture ceiling, so it is incomplete and was not used"
          : commandFailureReason(result),
      notes: [],
    };
  }
  const rows = parseDnfTransaction(result.stdout);
  if (rows.length > 0) {
    // `--assumeno` exits non-zero BY DESIGN after printing the table it then
    // declines, so a non-zero exit here is the success case and the table is
    // read before the exit code is consulted.
    return {
      additions: rows.map((r) => ({ name: r.name, version: r.version, source: r.repo })),
      removals: [],
      source: "dnf-assumeno",
      probe,
      notes: [
        "dnf resolved this transaction and then declined it, which is what --assumeno does; nothing was installed",
      ],
    };
  }
  if (dnfSaysNeedsRoot(combined)) {
    return {
      additions: null,
      removals: null,
      source: null,
      probe,
      reason:
        "dnf refused to resolve the transaction without root, so what it would install could not be determined — this tool does not acquire root",
      notes: [],
    };
  }
  return {
    additions: null,
    removals: null,
    source: null,
    probe,
    reason: `dnf printed no transaction table this parser could read (${firstLine(combined) || "empty output"})`,
    notes: [],
  };
}

/**
 * Homebrew has no dry run, so the closure is DERIVED — and the result says so.
 *
 * `brew deps --formula <name>` prints the transitive runtime dependencies,
 * and `brew list --formula --versions` prints what is already on disk. The
 * additions are the difference. That is the same resolution `brew install`
 * performs, but it is an inference rather than a manager-issued plan, which
 * is why `planSource` is `brew-deps` and not something that sounds official.
 *
 * Two honest gaps, both stated in the notes rather than hidden: build-time
 * dependencies are not listed (they are not installed for a bottle, which is
 * the normal case, but are for a source build), and a dependency's own
 * version is not resolved here.
 */
async function closureBrew(ctx: RunContext, operand: string, unknowns: Unknowns): Promise<Closure> {
  const depsArgv = withOperand(MANAGERS.homebrew, PKGMGR_COMMANDS.brewDeps, operand);
  const depsProbe = depsArgv.join(" ");
  const deps = await run(ctx, "homebrew", depsArgv);
  if (deps.missing || deps.timedOut || deps.code !== 0 || deps.stdoutTruncated === true) {
    return {
      additions: null,
      removals: null,
      source: null,
      probe: depsProbe,
      reason:
        deps.stdoutTruncated === true
          ? "brew's dependency list was cut at this package's capture ceiling"
          : commandFailureReason(deps),
      notes: [],
    };
  }
  const wanted = parseBrewDeps(deps.stdout);

  const listArgv = [...PKGMGR_COMMANDS.brewListVersions];
  const listProbe = listArgv.join(" ");
  const list = await run(ctx, "homebrew", listArgv);
  if (list.missing || list.timedOut || list.code !== 0 || list.stdoutTruncated === true) {
    // The dependency list is known and the installed set is not, so the
    // ADDITIONS cannot be computed — reporting every dependency as an
    // addition would overstate the change, which is the wrong direction to
    // be wrong in when an operator is approving it.
    unknowns.add("plan.additions", listProbe, commandFailureReason(list));
    return {
      additions: null,
      removals: null,
      source: null,
      probe: listProbe,
      reason: `brew's dependency list was read but the installed formulae could not be: ${commandFailureReason(list)}`,
      notes: [],
    };
  }
  const installed = parseBrewListVersions(list.stdout);
  const additions = wanted
    .filter((dep) => !installed.has(dep))
    .map((dep) => ({ name: dep, version: null }));
  return {
    additions,
    removals: [],
    source: "brew-deps",
    probe: depsProbe,
    notes: [
      "Homebrew has no dry run for install; these additions are `brew deps` minus what `brew list --versions` reports installed, and their versions are not resolved",
      "build-time dependencies are not listed — a bottle does not install them, a source build does",
    ],
  };
}
