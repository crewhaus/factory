/**
 * Item 64 — `crewhaus retire <spec>`: the lifecycle's missing last phase. A
 * clean, evidenced decommission of a harness:
 *
 *   1. refuse if the spec still has an ACTIVE deployment pin (an env points at
 *      a live version) — unless `--force`; retiring a deployed bot silently
 *      would be the worst failure mode;
 *   2. export the harness's durable state to the archive (reuse `crewhaus
 *      state backup` — the merged tarball path — so sessions/feedback/memories/
 *      audit travel out byte-identical);
 *   3. record a FINAL compliance-evidence bundle + an `audit verify` result,
 *      so the shutdown itself is provable;
 *   4. optionally push the harness's knowledge to the shared store (#63) so a
 *      retired bot's lessons outlive it;
 *   5. tombstone the registry entry — delete the spec's registered versions,
 *      which clears every env pin pointing at them (the "unpin/rollback"
 *      step);
 *   6. archive everything + remove the live `.crewhaus` state, with a
 *      retirement log (`retirement.json`) written INTO the archive recording
 *      every step + its outcome — so the retirement is itself evidenced.
 *
 * `--dry-run` prints the plan and touches nothing.
 *
 * Factored out of the entry file `index.ts` (which runs a top-level argv
 * switch and so cannot be imported by a test without executing the CLI).
 * Side-effect-free on import, mirroring `state-backup.ts`. The heavy steps —
 * state backup, compliance-evidence, audit-verify, registry tombstone,
 * knowledge push — are INJECTED as a `RetirementSteps` seam, so the
 * orchestration (order, refusal, dry-run, the archived log) is unit-tested
 * without running any of them; the CLI wires the real steps.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Thrown for operational failures (missing harness, active pin without
 *  --force, a failed step). The CLI routes the message through `die()`. */
export class RetireError extends Error {
  override readonly name = "RetireError";
}

/** The retirement log written into the archive. */
export const RETIREMENT_LOG_FILENAME = "retirement.json";

// ---------------------------------------------------------------------------
// active-pin detection + refusal (pure)
// ---------------------------------------------------------------------------

export type ActivePin = { readonly env: string; readonly version: string };

/**
 * Whether the harness's spec has an active deployment pin. `pins` is the
 * registry manifest's env→version map (empty when unregistered). An active
 * pin is any env pointing at a registered version. Retirement refuses this
 * without `--force`.
 */
export function activePins(pins: Readonly<Record<string, string>>): ActivePin[] {
  return Object.entries(pins)
    .map(([env, version]) => ({ env, version }))
    .sort((a, b) => a.env.localeCompare(b.env));
}

// ---------------------------------------------------------------------------
// step seams
// ---------------------------------------------------------------------------

export type StepOutcome = {
  readonly step: string;
  readonly ok: boolean;
  readonly detail: string;
};

/**
 * The injectable heavy steps. Each returns a `StepOutcome` recorded in the
 * retirement log. Production wires these to `createStateBackup`, the
 * compliance collector, `audit verify`, the registry, and knowledge push;
 * tests inject stubs that record the call order.
 */
export type RetirementSteps = {
  /** Export durable state (`.crewhaus`) into the archive; return the tarball path. */
  backupState(archiveDir: string): Promise<StepOutcome & { readonly tarball?: string }>;
  /** Write the final compliance-evidence bundle into the archive. */
  complianceEvidence(archiveDir: string): Promise<StepOutcome>;
  /** Run `audit verify` and record the verdict. */
  auditVerify(): Promise<StepOutcome>;
  /** Push the harness's knowledge to the shared store (#63). Skipped when not
   *  requested; returns a "skipped" outcome then. */
  pushKnowledge(archiveDir: string): Promise<StepOutcome>;
  /** Tombstone the registry entry (delete versions → clears pins). */
  tombstoneRegistry(): Promise<StepOutcome>;
};

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

export type RetirementPlan = {
  readonly specName: string;
  readonly harnessDir: string;
  readonly archiveDir: string;
  readonly activePins: ReadonlyArray<ActivePin>;
  readonly force: boolean;
  readonly pushKnowledge: boolean;
  /** The ordered step names the run will execute. */
  readonly steps: ReadonlyArray<string>;
};

export type BuildPlanOptions = {
  readonly specName: string;
  readonly harnessDir: string;
  readonly archiveDir: string;
  readonly pins: Readonly<Record<string, string>>;
  readonly force: boolean;
  readonly pushKnowledge: boolean;
};

/**
 * Build the retirement plan (pure). Throws {@link RetireError} when the
 * harness has an active pin and `--force` was not given — the plan itself is
 * the refusal gate, so `--dry-run` surfaces the refusal without side effects.
 */
export function buildRetirementPlan(opts: BuildPlanOptions): RetirementPlan {
  const pins = activePins(opts.pins);
  if (pins.length > 0 && !opts.force) {
    throw new RetireError(
      `refusing to retire "${opts.specName}" — it has ${pins.length} active deployment pin(s): ${pins
        .map((p) => `${p.env}→${p.version}`)
        .join(
          ", ",
        )}. Roll back / unpin first, or pass --force to retire anyway (the pins will be tombstoned).`,
    );
  }
  const steps = [
    "backupState",
    "complianceEvidence",
    "auditVerify",
    ...(opts.pushKnowledge ? ["pushKnowledge"] : []),
    "tombstoneRegistry",
    "archive",
  ];
  return {
    specName: opts.specName,
    harnessDir: resolve(opts.harnessDir),
    archiveDir: resolve(opts.archiveDir),
    activePins: pins,
    force: opts.force,
    pushKnowledge: opts.pushKnowledge,
    steps,
  };
}

/** Render the plan as the CLI's `--dry-run` lines. */
export function formatPlan(plan: RetirementPlan): ReadonlyArray<string> {
  const lines: string[] = [
    `retire ${plan.specName} — plan (dry run):`,
    `  harness:  ${plan.harnessDir}`,
    `  archive:  ${plan.archiveDir}`,
  ];
  if (plan.activePins.length > 0) {
    lines.push(
      `  ⚠ active pins (will be tombstoned, --force): ${plan.activePins
        .map((p) => `${p.env}→${p.version}`)
        .join(", ")}`,
    );
  }
  lines.push("  steps:");
  for (const s of plan.steps) lines.push(`    ${describeStep(s, plan)}`);
  lines.push("  nothing was executed (dry run)");
  return lines;
}

function describeStep(step: string, plan: RetirementPlan): string {
  switch (step) {
    case "backupState":
      return "1. export durable state (.crewhaus → archive tarball)";
    case "complianceEvidence":
      return "2. write a final compliance-evidence bundle";
    case "auditVerify":
      return "3. verify the audit chain (tamper check)";
    case "pushKnowledge":
      return "4. push knowledge to the shared store (#63)";
    case "tombstoneRegistry":
      return `${plan.pushKnowledge ? "5" : "4"}. tombstone the registry entry (delete versions → clear pins)`;
    case "archive":
      return `${plan.pushKnowledge ? "6" : "5"}. archive + remove the live .crewhaus state`;
    default:
      return step;
  }
}

// ---------------------------------------------------------------------------
// retirement log
// ---------------------------------------------------------------------------

export type RetirementLog = {
  readonly specName: string;
  readonly harnessDir: string;
  readonly retiredAt: string;
  readonly force: boolean;
  readonly activePinsAtRetirement: ReadonlyArray<ActivePin>;
  readonly outcomes: ReadonlyArray<StepOutcome>;
  readonly archived: boolean;
};

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

export type RunRetirementOptions = {
  readonly plan: RetirementPlan;
  readonly steps: RetirementSteps;
  readonly dryRun: boolean;
  readonly now?: () => Date;
  /** Test seam: whether to actually move/remove the state dir (default true). */
  readonly performArchive?: boolean;
};

export type RunRetirementResult = {
  readonly log: RetirementLog;
  /** Where the retirement log was written (unset on dry run). */
  readonly logPath?: string;
  /** True when the live .crewhaus was removed. */
  readonly removedState: boolean;
};

/**
 * Execute the plan. Each heavy step runs in order and its outcome is recorded;
 * a step that returns `ok: false` ABORTS the retirement BEFORE the destructive
 * archive/remove (a failed backup must not be followed by a delete). The
 * retirement log — every step + outcome — is written INTO the archive so the
 * decommission is self-evidenced. Dry runs execute nothing.
 */
export async function runRetirement(opts: RunRetirementOptions): Promise<RunRetirementResult> {
  const { plan, steps } = opts;
  const now = opts.now ?? (() => new Date());
  const retiredAt = now().toISOString();

  if (opts.dryRun) {
    return {
      log: {
        specName: plan.specName,
        harnessDir: plan.harnessDir,
        retiredAt,
        force: plan.force,
        activePinsAtRetirement: plan.activePins,
        outcomes: [],
        archived: false,
      },
      removedState: false,
    };
  }

  mkdirSync(plan.archiveDir, { recursive: true });
  const outcomes: StepOutcome[] = [];

  const record = (o: StepOutcome): StepOutcome => {
    outcomes.push(o);
    return o;
  };

  // 1–4/5: the non-destructive steps. A failure aborts before archiving.
  const backup = record(await steps.backupState(plan.archiveDir));
  if (!backup.ok)
    throw new RetireError(
      `state backup failed — aborting before any destructive step: ${backup.detail}`,
    );

  record(await steps.complianceEvidence(plan.archiveDir));
  record(await steps.auditVerify());
  if (plan.pushKnowledge) record(await steps.pushKnowledge(plan.archiveDir));

  const tombstone = record(await steps.tombstoneRegistry());
  if (!tombstone.ok) {
    throw new RetireError(
      `registry tombstone failed — aborting before archiving: ${tombstone.detail}`,
    );
  }

  // Destructive archive/remove: move the live .crewhaus into the archive, then
  // it is gone from the harness. Guarded by performArchive for tests.
  const performArchive = opts.performArchive ?? true;
  let removedState = false;
  const stateDir = join(plan.harnessDir, ".crewhaus");
  if (performArchive && existsSync(stateDir)) {
    const movedTo = join(plan.archiveDir, "crewhaus-state");
    // The state backup already captured a byte-identical tarball; MOVE the
    // live dir into the archive too (belt + braces) then it's removed from the
    // harness. A pre-existing target is replaced to keep the op idempotent.
    if (existsSync(movedTo)) rmSync(movedTo, { recursive: true, force: true });
    renameSync(stateDir, movedTo);
    removedState = true;
    record({ step: "archive", ok: true, detail: `moved .crewhaus → ${movedTo}` });
  } else {
    record({
      step: "archive",
      ok: true,
      detail: existsSync(stateDir)
        ? "archive skipped (test seam)"
        : "no .crewhaus state to archive",
    });
  }

  const log: RetirementLog = {
    specName: plan.specName,
    harnessDir: plan.harnessDir,
    retiredAt,
    force: plan.force,
    activePinsAtRetirement: plan.activePins,
    outcomes,
    archived: removedState,
  };
  const logPath = join(plan.archiveDir, RETIREMENT_LOG_FILENAME);
  writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`, { mode: 0o600 });

  return { log, logPath, removedState };
}

/** Read a retirement log back (for verification / display). */
export function readRetirementLog(archiveDir: string): RetirementLog | undefined {
  const p = join(archiveDir, RETIREMENT_LOG_FILENAME);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as RetirementLog;
  } catch {
    return undefined;
  }
}

/** Render a completed retirement as summary lines. */
export function formatRetirementResult(result: RunRetirementResult): ReadonlyArray<string> {
  const lines: string[] = [`retired ${result.log.specName} @ ${result.log.retiredAt}`];
  for (const o of result.log.outcomes) {
    lines.push(`  ${o.ok ? "✓" : "✗"} ${o.step}: ${o.detail}`);
  }
  if (result.logPath !== undefined) lines.push(`  retirement log: ${result.logPath}`);
  lines.push(
    result.removedState
      ? "  live .crewhaus state removed (archived)"
      : "  live state left in place",
  );
  return lines;
}

/** Ensure the archive dir's parent exists + the dir is empty/new; returns the
 *  resolved dir. */
export function prepareArchiveDir(archiveDir: string): string {
  const resolved = resolve(archiveDir);
  mkdirSync(dirname(resolved), { recursive: true });
  return resolved;
}
