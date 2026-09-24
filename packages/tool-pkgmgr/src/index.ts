/**
 * `@crewhaus/tool-pkgmgr` — asking the SYSTEM package manager what is on this
 * machine, and installing from it when that can be done honestly.
 *
 * Two tools. `PackageQuery` reads: is this package installed, at what
 * version, and what does the manager's already-downloaded index say is
 * available. `PackageInstall` writes, and spends most of its code deciding
 * not to.
 *
 * FIVE PROPERTIES HOLD ACROSS BOTH.
 *
 * 1. **THE SCOPE IS NARROWER THAN THE CATALOGUE IMPLIES, AND SAYS SO.**
 *    Reading works on six managers: Homebrew, apt/dpkg, dnf/rpm, pacman,
 *    winget and chocolatey. Installing works on ONE of them unattended —
 *    Homebrew, which needs no root and is designed for a user-owned prefix.
 *    apt, dnf and pacman need root, so this package installs through them
 *    only when the process it is already running in IS root, and otherwise
 *    refuses and prints the command the operator would run. winget and
 *    chocolatey are not installed through at all, because both end in an
 *    elevation prompt. A narrow tool that says what it did is worth more than
 *    a broad one that guesses.
 *
 * 2. **NO PRIVILEGE ESCALATION, EVER.** Nothing here runs `sudo`, `doas`,
 *    `runas` or `pkexec`, nothing raises a UAC prompt, and no schema in this
 *    package accepts a password. `no argv ever names an escalation program`
 *    in index.test.ts asserts that over every recorded call and over both
 *    schemas, the way tool-onchain asserts that no schema accepts a private
 *    key. Being root and BECOMING root are different things: this package
 *    will use what the process already has and will never ask for more.
 *
 * 3. **ARGV IS AN ARRAY, AND ALMOST ALL OF IT IS A CONSTANT.** There is no
 *    shell here — no `sh -c`, no `cmd /c`, no interpolated command line. Every
 *    command is a frozen literal in `./lib/managers.ts`, and the only value
 *    appended to one is a package name that `./lib/names.ts` has accepted. A
 *    name beginning with `-` is a FLAG, not a package, so it is refused before
 *    an argv exists rather than defended with a `--` that two of these six
 *    managers do not document.
 *
 * 4. **A DESTRUCTIVE TOOL RESOLVES ITS PLAN THE SAME WAY EVERY TIME.**
 *    `PackageInstall` declares `destructive: true` because an install can
 *    replace a working version, and it reports the version it would replace.
 *    `dryRun` does not take a different path: the plan is resolved by the same
 *    function either way, and `dryRun` only decides whether the install
 *    command afterwards runs.
 *
 * 5. **"COULD NOT DETERMINE" IS NOT "NO".** A manager that is not on this
 *    host, a probe that timed out, an empty dnf metadata cache, a winget row
 *    whose columns could not be split — every one is `unknown` with a named
 *    reason, never `not-installed`. A caller that reads "not installed" will
 *    install something, and installing because a probe timed out is how a
 *    tool breaks a machine.
 *
 * The seams are `_setRunner` (every child process), `_setPlatform` and
 * `_setUid`. The whole suite drives them: CI is a Linux container with no
 * package manager at all, development is macOS, and a parser checked against
 * whatever the test host happens to answer is a parser checked against
 * nothing. The un-injected platform is deliberately hostile — see `./host.ts`.
 */
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { hostPlatform, isRoot } from "./host";
import {
  MANAGERS,
  MANAGER_IDS,
  type ManagerId,
  PKGMGR_COMMANDS,
  buildOperand,
  withOperand,
} from "./lib/managers";
import { MAX_NAME_LENGTH, checkPackageName, checkVersionSyntax } from "./lib/names";
import { type InstallPlan, resolveInstallPlan } from "./lib/plan";
import {
  type PackageFacts,
  type Probe,
  type RunContext,
  detectManager,
  newContext,
  queryPackage,
  run,
} from "./lib/query";
import { Unknowns, commandFailureReason, firstLine } from "./lib/unknown";
import { DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS } from "./run";

export { _setRunner, type Runner, type RunRequest, type RunResult } from "./run";
export { _setPlatform, _setUid, _resetHostSeams, type HostPlatform } from "./host";
export { ToolPermissionError } from "./paths";
export type { PackageFacts, InstallPlan, ManagerId };

/** Compact JSON — the reader is a model, and every byte is context. */
const json = (value: unknown): string => JSON.stringify(value);

const managerSchema = z
  .enum(MANAGER_IDS as unknown as [ManagerId, ...ManagerId[]])
  .optional()
  .describe(
    "which package manager to use; omitted means detect it from the platform (macOS: Homebrew; Linux: apt, then dnf, then pacman, then Linuxbrew; Windows: winget, then chocolatey)",
  );

const nameSchema = z
  .string()
  .min(1)
  .max(MAX_NAME_LENGTH)
  .describe(
    "the package name as the manager spells it — a formula or cask for Homebrew, a binary package for apt, an rpm name or full NEVRA for dnf, a package Id for winget",
  );

const timeoutSchema = z
  .number()
  .int()
  .min(100)
  .max(MAX_COMMAND_TIMEOUT_MS)
  .optional()
  .describe(
    `milliseconds any single manager command may take before it is SIGTERMed (default ${DEFAULT_COMMAND_TIMEOUT_MS})`,
  );

/**
 * The probe trail, trimmed for a result.
 *
 * The argv is included verbatim and on purpose: a caller reading "unknown"
 * needs to see what was actually asked, and it is the evidence behind the
 * claim that nothing here builds a command out of anything but a constant and
 * a validated name.
 */
function probeJson(probes: readonly Probe[]): unknown[] {
  return probes.map((p) => ({
    argv: p.argv,
    exitCode: p.exitCode,
    ...(p.missing === true ? { notInstalled: true } : {}),
    ...(p.timedOut === true ? { timedOut: true } : {}),
  }));
}

function factsJson(facts: PackageFacts): Record<string, unknown> {
  return {
    manager: facts.manager,
    name: facts.name,
    status: facts.status,
    installedVersions: facts.installedVersions,
    knownToManager: facts.knownToManager,
    available: facts.available,
    ...(facts.kind !== undefined ? { kind: facts.kind } : {}),
    ...(facts.pinned !== undefined ? { pinned: facts.pinned } : {}),
    ...(facts.outdated !== undefined ? { outdated: facts.outdated } : {}),
    ...(facts.notes.length > 0 ? { notes: facts.notes } : {}),
  };
}

// ---------------------------------------------------------------------------
// PackageQuery
// ---------------------------------------------------------------------------

export const packageQuery: RegisteredTool = buildTool({
  name: "PackageQuery",
  operativeArgs: [{ field: "name", kind: "id" }],
  description:
    'Ask the system package manager whether a package is installed, at what version, and what its already-downloaded index says is available. Supports Homebrew, apt/dpkg, dnf/rpm, pacman, winget and chocolatey, detecting the manager from the platform unless you name one; a host with none of them is reported as unknown rather than guessed at. It makes NO network call: every answer comes from a local index, which is why winget and chocolatey report installed state only — their available version lives on a remote source. Nothing is ever defaulted: a manager that is not on this host, a probe that timed out, an empty dnf metadata cache or a winget row whose columns could not be split all come back as status "unknown" with the reason and the exact command that was run, never as "not installed". Read-only: it runs only query commands and changes nothing.',
  inputSchema: z.object({
    name: nameSchema,
    manager: managerSchema,
    includeAvailable: z
      .boolean()
      .optional()
      .describe(
        "also read what the local index offers, not just what is installed (default true; ignored for winget and chocolatey, whose available version is a network query)",
      ),
    timeoutMs: timeoutSchema,
  }),
  readOnly: true,
  concurrencySafe: true,
  scope: "external",
  ioCapability: "process",
  execute: async (input, context) => {
    const platform = hostPlatform();
    const ctx = newContext(input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, context?.signal);
    const unknowns = new Unknowns();
    const includeAvailable = input.includeAvailable ?? true;

    const detection = await detectManager(ctx, platform, input.manager);
    if (detection.kind === "unknown") {
      // Rule 5: a host with no package manager — which is what CI is — gets a
      // typed answer naming what was looked for, not a crash and not a false.
      return json({
        tool: "PackageQuery",
        platform,
        manager: null,
        status: "unknown",
        available: false,
        reason: detection.reason,
        managersProbed: detection.tried,
        probes: probeJson(ctx.probes),
      });
    }

    const manager = detection.manager;
    const nameRefusal = checkPackageName(manager, input.name);
    if (nameRefusal !== undefined) {
      return json({
        tool: "PackageQuery",
        platform,
        manager,
        status: "refused",
        reason: nameRefusal,
        // Nothing was spawned with this name; the only probes are the
        // manager detection ones above.
        probes: probeJson(ctx.probes),
      });
    }

    const facts = await queryPackage(ctx, manager, input.name, unknowns, includeAvailable);
    return json({
      tool: "PackageQuery",
      platform,
      ...factsJson(facts),
      availableSource: MANAGERS[manager].availableSource,
      ...(MANAGERS[manager].availableReason !== undefined
        ? { availableNotProbedBecause: MANAGERS[manager].availableReason }
        : {}),
      ...(unknowns.size > 0 ? { unknown: unknowns.list() } : {}),
      probes: probeJson(ctx.probes),
    });
  },
});

// ---------------------------------------------------------------------------
// PackageInstall
// ---------------------------------------------------------------------------

/**
 * A refusal, in the one shape every one of them uses.
 *
 * `operatorCommand` is the point of the refusal rather than an apology for
 * it: this package will not acquire privilege, so the useful thing it can do
 * is hand back the exact line a human would type.
 */
function refusal(fields: {
  readonly platform: string;
  readonly manager: ManagerId | null;
  readonly reason: string;
  readonly operatorCommand?: string;
  readonly probes: readonly Probe[];
  readonly plan?: InstallPlan;
  readonly dryRun: boolean;
}): string {
  return json({
    tool: "PackageInstall",
    platform: fields.platform,
    manager: fields.manager,
    dryRun: fields.dryRun,
    status: "refused",
    installed: false,
    reason: fields.reason,
    ...(fields.operatorCommand !== undefined
      ? {
          operatorCommand: fields.operatorCommand,
          operatorCommandNote:
            "this tool does not run that command and does not acquire the privilege it needs; run it yourself if you want this change",
        }
      : {}),
    ...(fields.plan !== undefined ? { plan: fields.plan } : {}),
    probes: probeJson(fields.probes),
  });
}

export const packageInstall: RegisteredTool = buildTool({
  name: "PackageInstall",
  operativeArgs: [{ field: "name", kind: "id" }],
  description:
    "Install a package through the system package manager, or report exactly what installing it would do. DESTRUCTIVE: an install can replace a version that is already working, so the plan names the versions currently on disk before anything runs. Pass dryRun to get that plan and install nothing — it is resolved by the same code the real install uses, and includes the transitive packages the manager says it would add (complete from apt and pacman, resolved-then-declined from dnf, derived from `brew deps` for Homebrew, which has no dry run). THIS TOOL NEVER ACQUIRES PRIVILEGE. It runs no sudo, doas, runas or pkexec and raises no UAC prompt. Homebrew needs no root and is the case that genuinely works unattended; apt, dnf and pacman need root, so they work only when this process is ALREADY root and are otherwise refused with the exact command an operator would run themselves; winget and chocolatey installs are refused outright, because both end in an elevation prompt. A version can only be pinned where the manager can express one — apt can, and every other manager here is refused with the reason rather than quietly installing latest. A package name beginning with '-' is refused, because a manager would read it as a flag.",
  inputSchema: z.object({
    name: nameSchema,
    manager: managerSchema,
    version: z
      .string()
      .min(1)
      .optional()
      .describe(
        "an exact version to install. Only apt can express one (name=version); Homebrew, dnf, pacman, winget and chocolatey are refused with the reason rather than installing latest",
      ),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        "resolve and report the plan, and install nothing (default false). The plan is produced by the same code the real install runs",
      ),
    timeoutMs: timeoutSchema,
  }),
  destructive: true,
  requireJustification: true,
  scope: "external",
  ioCapability: "process",
  execute: async (input, context) => {
    const platform = hostPlatform();
    const dryRun = input.dryRun === true;
    const ctx: RunContext = newContext(
      input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      context?.signal,
    );
    const unknowns = new Unknowns();

    const detection = await detectManager(ctx, platform, input.manager);
    if (detection.kind === "unknown") {
      return json({
        tool: "PackageInstall",
        platform,
        manager: null,
        dryRun,
        status: "unavailable",
        installed: false,
        reason: detection.reason,
        managersProbed: detection.tried,
        probes: probeJson(ctx.probes),
      });
    }
    const manager = detection.manager;
    const spec = MANAGERS[manager];

    // ---- refusals, in the order that gives the most useful message --------

    const nameRefusal = checkPackageName(manager, input.name);
    if (nameRefusal !== undefined) {
      return refusal({ platform, manager, reason: nameRefusal, probes: ctx.probes, dryRun });
    }

    if (!spec.install.supported) {
      return refusal({
        platform,
        manager,
        reason: spec.install.reason,
        operatorCommand: spec.operatorCommand(input.name),
        probes: ctx.probes,
        dryRun,
      });
    }

    let requestedVersion: string | null = null;
    if (input.version !== undefined) {
      if (!spec.versionPin.supported) {
        // Refusing rather than installing latest is the whole point: a caller
        // who asked for 1.2.3 and silently got 2.0.0 has been lied to by a
        // tool they will trust again.
        return refusal({
          platform,
          manager,
          reason: `${spec.label} cannot express an exact version: ${spec.versionPin.reason}`,
          operatorCommand: spec.operatorCommand(input.name),
          probes: ctx.probes,
          dryRun,
        });
      }
      const versionRefusal = checkVersionSyntax(input.version);
      if (versionRefusal !== undefined) {
        return refusal({ platform, manager, reason: versionRefusal, probes: ctx.probes, dryRun });
      }
      requestedVersion = input.version;
    }

    const operand = buildOperand(manager, input.name, requestedVersion ?? undefined);

    // ---- resolution: the same code for both paths -------------------------

    const facts = await queryPackage(ctx, manager, input.name, unknowns, true);
    const plan = await resolveInstallPlan(
      ctx,
      manager,
      input.name,
      operand,
      requestedVersion,
      facts,
      unknowns,
    );

    if (dryRun) {
      return json({
        tool: "PackageInstall",
        platform,
        manager,
        dryRun: true,
        status: "would-install",
        installed: false,
        plan,
        before: factsJson(facts),
        // Stated on the dry run too, so a caller learns BEFORE it tries that
        // the real call would be refused on this host.
        ...(spec.install.needsRoot && !isRoot()
          ? {
              wouldBeRefused: true,
              wouldBeRefusedReason: `${spec.label} needs root to install and this process is not root; this tool does not acquire privilege`,
              operatorCommand: spec.operatorCommand(operand),
            }
          : {}),
        ...(unknowns.size > 0 ? { unknown: unknowns.list() } : {}),
        probes: probeJson(ctx.probes),
      });
    }

    // ---- the privilege gate ----------------------------------------------

    if (spec.install.needsRoot && !isRoot()) {
      return refusal({
        platform,
        manager,
        reason: `${spec.label} needs root to install a package, and this tool does not acquire privilege — it runs no sudo, doas, runas or pkexec, and takes no password`,
        operatorCommand: spec.operatorCommand(operand),
        plan,
        probes: ctx.probes,
        dryRun: false,
      });
    }

    if (plan.action === "none") {
      // Nothing to do, and saying so beats running an install to find out.
      return json({
        tool: "PackageInstall",
        platform,
        manager,
        dryRun: false,
        status: "already-installed",
        installed: false,
        plan,
        before: factsJson(facts),
        ...(unknowns.size > 0 ? { unknown: unknowns.list() } : {}),
        probes: probeJson(ctx.probes),
      });
    }

    // ---- the one line that differs from the dry run ------------------------

    const installArgv = installCommand(manager, operand);
    const result = await run(ctx, manager, installArgv);

    if (result.missing || result.timedOut) {
      return json({
        tool: "PackageInstall",
        platform,
        manager,
        dryRun: false,
        // An install that timed out may have done PART of its work, which is
        // neither "installed" nor "not installed". The verification below is
        // what turns that into a fact.
        status: "unknown",
        installed: false,
        reason: commandFailureReason(result),
        plan,
        probes: probeJson(ctx.probes),
      });
    }

    const failedRoot =
      result.code !== 0 && /you (are not|must be) root|permission denied/i.test(result.stderr);
    const after = await queryPackage(ctx, manager, input.name, unknowns, true);
    const installed =
      after.status === "installed" &&
      (facts.status !== "installed" ||
        JSON.stringify(after.installedVersions) !== JSON.stringify(facts.installedVersions));

    return json({
      tool: "PackageInstall",
      platform,
      manager,
      dryRun: false,
      status:
        result.code === 0
          ? after.status === "installed"
            ? "installed"
            : "unknown"
          : failedRoot
            ? "refused"
            : "failed",
      installed: result.code === 0 && after.status === "installed",
      // Stated separately from `installed`: a reinstall of the same version
      // leaves the machine changed in ways the version does not show, and a
      // caller deciding whether to restart something needs the difference.
      versionChanged: installed,
      exitCode: result.code,
      ...(result.code !== 0
        ? { reason: firstLine(result.stderr) || firstLine(result.stdout) }
        : {}),
      plan,
      before: factsJson(facts),
      after: factsJson(after),
      ...(after.status === "unknown"
        ? {
            verificationNote:
              "the install command's exit code was read, but re-querying the manager afterwards did not confirm the result, so what is on disk now is not known from this call",
          }
        : {}),
      ...(unknowns.size > 0 ? { unknown: unknowns.list() } : {}),
      probes: probeJson(ctx.probes),
    });
  },
});

/**
 * The install argv for a manager.
 *
 * A separate function so the test that asserts no argv names an escalation
 * program can enumerate every one of them, including the ones only reached
 * when the process is already root.
 */
export function installCommand(manager: ManagerId, operand: string): string[] {
  const spec = MANAGERS[manager];
  switch (manager) {
    case "homebrew":
      return withOperand(spec, PKGMGR_COMMANDS.brewInstall, operand);
    case "apt":
      return withOperand(spec, PKGMGR_COMMANDS.aptInstall, operand);
    case "dnf":
      return withOperand(spec, PKGMGR_COMMANDS.dnfInstall, operand);
    case "pacman":
      return withOperand(spec, PKGMGR_COMMANDS.pacmanInstall, operand);
    // Unreachable: both are refused above before a plan exists. The throw is
    // the guarantee — a future edit that removes the refusal fails loudly
    // here instead of quietly starting an elevated installer.
    case "winget":
    case "choco":
      throw new Error(`${spec.label} installs are refused by this package and have no argv`);
  }
}

export const PKGMGR_TOOLS: readonly RegisteredTool[] = Object.freeze([
  packageQuery,
  packageInstall,
]);
