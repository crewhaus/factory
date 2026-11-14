/**
 * Item 64 — `crewhaus retire <spec>`: the lifecycle's missing last phase. A
 * clean, evidenced decommission of a harness:
 *
 *   1. refuse if the spec still has an ACTIVE deployment pin (an env points at
 *      a live version) — unless `--force`; retiring a deployed bot silently
 *      would be the worst failure mode — and refuse while its daemon runs,
 *      unless `--stop`, which stops it first;
 *   1a. end what the harness could still do (#507, #513): stop it (`--stop`) and
 *      disable it, cancel its queued runs, expire its open approvals, revoke its
 *      standing rules, and run each area's revoker for the connections it
 *      holds. A failure here aborts before anything is archived, and the harness
 *      stays disabled;
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
 *      every step + its outcome — so the retirement is itself evidenced;
 *   7. record `harness.retired` in Home's lifecycle record, and mark the
 *      harness's registry row archived.
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
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
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
  // The control steps: supplied by a host whose plan has `control` (the CLI). A plan
  // that lists one whose seam is missing is refused before anything runs.
  /** Stop the daemon (only with `--stop`), then disable the harness. */
  stopAndDisable?(): Promise<StepOutcome>;
  /** Cancel every queued run, taking each run's claim first. */
  cancelQueuedRuns?(): Promise<StepOutcome>;
  /** Expire every pending approval and unspent grant. */
  expireDecisions?(): Promise<StepOutcome>;
  /** Revoke every active standing rule. */
  revokeStandingRules?(): Promise<StepOutcome>;
  /** Run each registered area revoker. A failure here is waved through only by
   *  `forceUnverified`, as the audit gate is. */
  revokeConnections?(): Promise<StepOutcome>;
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
  /** Disable the harness again in its live directory. After the archive, which moved its
   *  operator record away with the rest of its state. */
  keepDisabled?(): Promise<StepOutcome>;
  /** Append `harness.retired` to Home's lifecycle record. After the archive. */
  recordLifecycle?(): Promise<StepOutcome>;
  /** Mark the harness's Home registry row archived. After the archive. */
  archiveRegistryRow?(): Promise<StepOutcome>;
};

/** One thing an area's revoker will end, as the plan lists it. */
export type RetirePlanItem = {
  readonly kind: string;
  /** `manual`: a person does it by hand, where it was issued. */
  readonly status: "planned" | "manual";
  readonly note?: string;
};

/** The steps that end what a harness could still do, run before anything is archived. */
export const PRE_ARCHIVE_STEPS = [
  "stopAndDisable",
  "cancelQueuedRuns",
  "expireDecisions",
  "revokeStandingRules",
  "revokeConnections",
] as const;

/** The steps that keep the harness disabled and record the retirement once the state is
 *  archived. */
export const POST_ARCHIVE_STEPS = [
  "keepDisabled",
  "recordLifecycle",
  "archiveRegistryRow",
] as const;

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
  /** The control steps, when the host runs them: whether `--stop` was given, and what
   *  each registered revoker will end. */
  readonly control?: {
    readonly stop: boolean;
    readonly revokerItems: ReadonlyArray<RetirePlanItem>;
  };
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
  /**
   * The control steps, for a host that runs them (`crewhaus retire`): they end what the
   * harness could still do before the backup, and record the retirement after the
   * archive. Without it the plan is the backup, evidence and archive alone.
   */
  readonly control?: {
    /** Whether the harness's daemon is running now. */
    readonly daemonLive: boolean;
    /** `--stop`: stop a running daemon first. */
    readonly stop: boolean;
    /** What each registered revoker will end (`RetireRevoker.plan`). */
    readonly revokerItems: ReadonlyArray<RetirePlanItem>;
  };
};

/**
 * Build the retirement plan (pure). Throws {@link RetireError} when the
 * harness's daemon is running and `--stop` was not given, or when it has an
 * active pin and `--force` was not given — the plan itself is the refusal
 * gate, so `--dry-run` surfaces the refusal without side effects.
 */
export function buildRetirementPlan(opts: BuildPlanOptions): RetirementPlan {
  const control = opts.control;
  if (control?.daemonLive && !control.stop) {
    throw new RetireError(
      `${opts.specName}'s daemon is running. Stop it first, or run \`crewhaus retire --stop\` to stop and disable it.`,
    );
  }
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
    ...(control !== undefined ? PRE_ARCHIVE_STEPS : []),
    "backupState",
    "complianceEvidence",
    "auditVerify",
    ...(opts.pushKnowledge ? ["pushKnowledge"] : []),
    "tombstoneRegistry",
    "archive",
    ...(control !== undefined ? POST_ARCHIVE_STEPS : []),
  ];
  return {
    specName: opts.specName,
    harnessDir: resolve(opts.harnessDir),
    archiveDir: resolve(opts.archiveDir),
    activePins: pins,
    force: opts.force,
    pushKnowledge: opts.pushKnowledge,
    ...(control !== undefined
      ? { control: { stop: control.stop, revokerItems: [...control.revokerItems] } }
      : {}),
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
  plan.steps.forEach((s, i) => {
    lines.push(`    ${i + 1}. ${describeStep(s, plan)}`);
  });
  const items = plan.control?.revokerItems;
  if (items !== undefined && items.length === 0) {
    lines.push(
      "  Connections: none are registered here. Revoke this harness's channel and service credentials where they were issued.",
    );
  } else if (items !== undefined) {
    lines.push("  connections:");
    for (const item of items) {
      const note = item.note !== undefined ? ` — ${item.note}` : "";
      lines.push(
        `    - ${item.kind}${note}${item.status === "manual" ? " (do this by hand)" : ""}`,
      );
    }
  }
  lines.push("  nothing was executed (dry run)");
  return lines;
}

function describeStep(step: string, plan: RetirementPlan): string {
  switch (step) {
    case "stopAndDisable":
      return plan.control?.stop === true
        ? "stop the daemon, then disable the harness so nothing starts it"
        : "disable the harness so nothing starts it";
    case "cancelQueuedRuns":
      return "cancel its queued runs";
    case "expireDecisions":
      return "expire its open approvals and unspent grants";
    case "revokeStandingRules":
      return "revoke its standing rules";
    case "revokeConnections":
      return "revoke the connections each area holds for it";
    case "backupState":
      return "export durable state (.crewhaus → archive tarball)";
    case "complianceEvidence":
      return "write a final compliance-evidence bundle";
    case "auditVerify":
      return "verify the audit chain (tamper check)";
    case "pushKnowledge":
      return "push knowledge to the shared store (#63)";
    case "tombstoneRegistry":
      return "tombstone the registry entry (delete versions → clear pins)";
    case "archive":
      return "archive + remove the live .crewhaus state";
    case "keepDisabled":
      return "keep the harness disabled where it lives, now that its state is archived";
    case "recordLifecycle":
      return "record the retirement in Home's lifecycle record";
    case "archiveRegistryRow":
      return "mark the harness archived in Home's registry";
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
  /** F4 — proceed with the destructive move EVEN IF `auditVerify` reports
   *  tamper or `complianceEvidence` failed. Distinct from `--force`
   *  (`plan.force`, which only overrides the active-pin refusal). Default
   *  false: a provably-tampered audit chain ABORTS the retire, state intact. */
  readonly forceUnverified?: boolean;
};

export type RunRetirementResult = {
  readonly log: RetirementLog;
  /** Where the retirement log was written (unset on dry run). */
  readonly logPath?: string;
  /** True when the live .crewhaus was removed. */
  readonly removedState: boolean;
};

/**
 * Execute the plan. Each heavy step runs in order and its outcome is recorded.
 * A step that returns `ok: false` ABORTS the retirement BEFORE the destructive
 * archive/remove (a failed backup, tombstone, and — per F4 — a failed
 * compliance-evidence bundle or a tamper-reporting `auditVerify` all abort;
 * the audit/compliance gate is overridable only with `forceUnverified`). The
 * retirement log — every step + outcome — is written+fsynced INTO the archive
 * BEFORE the destructive move (and rewritten after) so a crash mid-remove
 * still leaves the evidence and the decommission is self-evidenced. Dry runs
 * execute nothing.
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

  // Every control step the plan lists has its seam, or nothing runs.
  const missing = [...PRE_ARCHIVE_STEPS, ...POST_ARCHIVE_STEPS].filter(
    (name) => plan.steps.includes(name) && steps[name] === undefined,
  );
  if (missing.length > 0) {
    throw new RetireError(
      `the plan lists ${missing.join(", ")}, which this host does not supply; nothing was done`,
    );
  }

  mkdirSync(plan.archiveDir, { recursive: true });
  const outcomes: StepOutcome[] = [];

  const record = (o: StepOutcome): StepOutcome => {
    outcomes.push(o);
    return o;
  };

  const forceUnverified = opts.forceUnverified ?? false;

  // End what the harness could still do, before anything is archived. A failure aborts
  // like a failed backup, and the harness stays disabled for a person to look at.
  for (const name of PRE_ARCHIVE_STEPS) {
    const run = steps[name];
    if (!plan.steps.includes(name) || run === undefined) continue;
    const outcome = record(await run());
    if (outcome.ok) continue;
    if (name === "revokeConnections" && forceUnverified) continue;
    writeLogDurably(join(plan.archiveDir, RETIREMENT_LOG_FILENAME), {
      specName: plan.specName,
      harnessDir: plan.harnessDir,
      retiredAt,
      force: plan.force,
      activePinsAtRetirement: plan.activePins,
      outcomes,
      archived: false,
    });
    const disabled = outcomes.some((o) => o.step === "stopAndDisable" && o.ok);
    throw new RetireError(
      `${name} failed — aborting before any destructive step: ${outcome.detail}.${
        disabled ? " The harness stays disabled; `crewhaus daemon enable` allows starts again." : ""
      }${name === "revokeConnections" ? " Pass --force-unverified to retire anyway." : ""}`,
    );
  }

  // 1–4/5: the non-destructive steps. A failure aborts before archiving.
  const backup = record(await steps.backupState(plan.archiveDir));
  if (!backup.ok)
    throw new RetireError(
      `state backup failed — aborting before any destructive step: ${backup.detail}`,
    );

  // F4 — the compliance-evidence bundle and the audit-verify verdict GATE the
  // destructive step: a provably-tampered audit chain (or a failed evidence
  // bundle) must ABORT the retire so the `.crewhaus` state is left intact for
  // investigation, NOT moved+removed. `--force-unverified` is the explicit
  // override (distinct from `--force`, which only overrides the active-pin
  // refusal). The log is written into the archive before we bail, so the
  // refusal is itself evidenced.
  const compliance = record(await steps.complianceEvidence(plan.archiveDir));
  const audit = record(await steps.auditVerify());
  if (plan.pushKnowledge) record(await steps.pushKnowledge(plan.archiveDir));

  const tamperReasons: string[] = [];
  if (!audit.ok) tamperReasons.push(`audit verify reported tamper: ${audit.detail}`);
  if (!compliance.ok) tamperReasons.push(`compliance evidence failed: ${compliance.detail}`);
  if (tamperReasons.length > 0 && !forceUnverified) {
    // Persist the aborted-run log into the archive so the refusal is evidenced,
    // then abort BEFORE tombstone/archive — the live state stays put.
    const abortedLog: RetirementLog = {
      specName: plan.specName,
      harnessDir: plan.harnessDir,
      retiredAt,
      force: plan.force,
      activePinsAtRetirement: plan.activePins,
      outcomes,
      archived: false,
    };
    writeLogDurably(join(plan.archiveDir, RETIREMENT_LOG_FILENAME), abortedLog);
    throw new RetireError(
      `aborting retire before any destructive step — ${tamperReasons.join("; ")}. The live .crewhaus state was left intact. Pass --force-unverified to retire anyway.`,
    );
  }

  const tombstone = record(await steps.tombstoneRegistry());
  if (!tombstone.ok) {
    throw new RetireError(
      `registry tombstone failed — aborting before archiving: ${tombstone.detail}`,
    );
  }

  // F4 — write + fsync the retirement log into the archive BEFORE the
  // destructive move, so a crash mid-remove still leaves the evidence beside
  // the backup that already exists pre-destruction. The `archive` outcome is
  // appended after the move and the log is rewritten to capture it.
  const logPath = join(plan.archiveDir, RETIREMENT_LOG_FILENAME);
  const preMoveLog: RetirementLog = {
    specName: plan.specName,
    harnessDir: plan.harnessDir,
    retiredAt,
    force: plan.force,
    activePinsAtRetirement: plan.activePins,
    outcomes,
    archived: false,
  };
  writeLogDurably(logPath, preMoveLog);

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

  // The state is archived: disable the harness again where it lives (the archive took its
  // operator record), then record the retirement where Home keeps it. A failure here is
  // logged, never undone: the harness is already retired.
  for (const name of POST_ARCHIVE_STEPS) {
    const run = steps[name];
    if (plan.steps.includes(name) && run !== undefined) record(await run());
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
  // Rewrite the log now that the `archive` outcome is known (the pre-move write
  // above is the crash-safety copy; this is the final, complete record).
  writeLogDurably(logPath, log);

  return { log, logPath, removedState };
}

/** Write a retirement log and fsync it to disk before returning, so a crash
 *  immediately after cannot lose the evidence. */
function writeLogDurably(logPath: string, log: RetirementLog): void {
  const body = `${JSON.stringify(log, null, 2)}\n`;
  const fd = openSync(logPath, "w", 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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
