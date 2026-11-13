import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RETIREMENT_LOG_FILENAME,
  RetireError,
  type RetirePlanItem,
  type RetirementSteps,
  type StepOutcome,
  activePins,
  buildRetirementPlan,
  formatPlan,
  formatRetirementResult,
  readRetirementLog,
  runRetirement,
} from "./retire";

/**
 * A test that needs a write or a listing to be REFUSED by a directory's mode
 * cannot run as root, which the mode does not stop (a container's CI user,
 * `docker run --user 0`). It is skipped there rather than failing.
 */
const canTestUnwritable = (process.getuid?.() ?? 0) !== 0;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "crewhaus-retire-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A step-seam stub that records call order + lets a step be forced to fail. */
function stubSteps(
  opts: {
    failBackup?: boolean;
    failTombstone?: boolean;
    failAudit?: boolean;
    failCompliance?: boolean;
    failPre?: "cancelQueuedRuns" | "revokeConnections";
  } = {},
): {
  steps: RetirementSteps;
  calls: string[];
} {
  const calls: string[] = [];
  const ok = (step: string, detail = "ok"): StepOutcome => {
    calls.push(step);
    return { step, ok: true, detail };
  };
  const fail = (step: string, detail: string): StepOutcome => {
    calls.push(step);
    return { step, ok: false, detail };
  };
  const steps: RetirementSteps = {
    stopAndDisable: async () => ok("stopAndDisable"),
    cancelQueuedRuns: async () =>
      opts.failPre === "cancelQueuedRuns"
        ? fail("cancelQueuedRuns", "a run is already running")
        : ok("cancelQueuedRuns"),
    expireDecisions: async () => ok("expireDecisions"),
    revokeStandingRules: async () => ok("revokeStandingRules"),
    revokeConnections: async () =>
      opts.failPre === "revokeConnections"
        ? fail("revokeConnections", "a revoker failed")
        : ok("revokeConnections"),
    recordLifecycle: async () => ok("recordLifecycle"),
    archiveRegistryRow: async () => ok("archiveRegistryRow"),
    backupState: async () =>
      opts.failBackup === true
        ? fail("backupState", "disk full")
        : { ...ok("backupState"), tarball: "state.tar.gz" },
    complianceEvidence: async () =>
      opts.failCompliance === true
        ? fail("complianceEvidence", "collector error")
        : ok("complianceEvidence"),
    auditVerify: async () =>
      opts.failAudit === true ? fail("auditVerify", "chain break at seq 12") : ok("auditVerify"),
    pushKnowledge: async () => ok("pushKnowledge"),
    tombstoneRegistry: async () =>
      opts.failTombstone === true
        ? fail("tombstoneRegistry", "registry locked")
        : ok("tombstoneRegistry"),
  };
  return { steps, calls };
}

describe("activePins", () => {
  test("sorted env→version list", () => {
    expect(activePins({ prod: "v3", staging: "v2" })).toEqual([
      { env: "prod", version: "v3" },
      { env: "staging", version: "v2" },
    ]);
  });
  test("empty for no pins", () => {
    expect(activePins({})).toEqual([]);
  });
});

describe("buildRetirementPlan", () => {
  test("refuses an active pin without --force", () => {
    expect(() =>
      buildRetirementPlan({
        specName: "concierge",
        harnessDir: root,
        archiveDir: join(root, "archive"),
        pins: { prod: "v3" },
        force: false,
        pushKnowledge: false,
      }),
    ).toThrow(RetireError);
  });

  test("allows an active pin with --force and lists tombstone", () => {
    const plan = buildRetirementPlan({
      specName: "concierge",
      harnessDir: root,
      archiveDir: join(root, "archive"),
      pins: { prod: "v3" },
      force: true,
      pushKnowledge: false,
    });
    expect(plan.activePins).toHaveLength(1);
    expect(plan.steps).toContain("tombstoneRegistry");
    expect(formatPlan(plan).join("\n")).toContain("active pins");
  });

  test("includes pushKnowledge step only when requested", () => {
    const withoutPush = buildRetirementPlan({
      specName: "c",
      harnessDir: root,
      archiveDir: join(root, "a"),
      pins: {},
      force: false,
      pushKnowledge: false,
    });
    expect(withoutPush.steps).not.toContain("pushKnowledge");
    const withPush = buildRetirementPlan({
      specName: "c",
      harnessDir: root,
      archiveDir: join(root, "a"),
      pins: {},
      force: false,
      pushKnowledge: true,
    });
    expect(withPush.steps).toContain("pushKnowledge");
  });
});

describe("runRetirement — dry run", () => {
  test("executes no steps and removes nothing", async () => {
    mkdirSync(join(root, ".crewhaus"), { recursive: true });
    const plan = buildRetirementPlan({
      specName: "c",
      harnessDir: root,
      archiveDir: join(root, "archive"),
      pins: {},
      force: false,
      pushKnowledge: false,
    });
    const { steps, calls } = stubSteps();
    const result = await runRetirement({ plan, steps, dryRun: true });
    expect(calls).toEqual([]);
    expect(result.removedState).toBe(false);
    expect(existsSync(join(root, ".crewhaus"))).toBe(true);
  });
});

describe("runRetirement — real", () => {
  test("runs steps in order, writes the log, archives + removes state", async () => {
    const stateDir = join(root, ".crewhaus");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "marker"), "x");
    const archiveDir = join(root, "archive");
    const plan = buildRetirementPlan({
      specName: "concierge",
      harnessDir: root,
      archiveDir,
      pins: {},
      force: false,
      pushKnowledge: true,
      control: { daemonLive: false, stop: false, revokerItems: [] },
    });
    const { steps, calls } = stubSteps();
    const result = await runRetirement({
      plan,
      steps,
      dryRun: false,
      now: () => new Date("2026-07-02T00:00:00Z"),
    });

    // order: end what it could do → backup → compliance → audit → knowledge → tombstone
    // → (archive) → record the retirement
    expect(calls).toEqual([
      "stopAndDisable",
      "cancelQueuedRuns",
      "expireDecisions",
      "revokeStandingRules",
      "revokeConnections",
      "backupState",
      "complianceEvidence",
      "auditVerify",
      "pushKnowledge",
      "tombstoneRegistry",
      "recordLifecycle",
      "archiveRegistryRow",
    ]);
    expect(plan.steps).toEqual([
      "stopAndDisable",
      "cancelQueuedRuns",
      "expireDecisions",
      "revokeStandingRules",
      "revokeConnections",
      "backupState",
      "complianceEvidence",
      "auditVerify",
      "pushKnowledge",
      "tombstoneRegistry",
      "archive",
      "recordLifecycle",
      "archiveRegistryRow",
    ]);
    // state moved into the archive + removed from the harness
    expect(result.removedState).toBe(true);
    expect(existsSync(stateDir)).toBe(false);
    expect(existsSync(join(archiveDir, "crewhaus-state", "marker"))).toBe(true);
    // retirement log evidenced into the archive
    const log = readRetirementLog(archiveDir);
    expect(log?.specName).toBe("concierge");
    expect(log?.archived).toBe(true);
    expect(log?.outcomes.map((o) => o.step)).toContain("archive");
    const logged = log?.outcomes.map((o) => o.step) ?? [];
    expect(logged.indexOf("archive")).toBeGreaterThan(-1);
    expect(logged.indexOf("recordLifecycle")).toBeGreaterThan(logged.indexOf("archive"));
    expect(existsSync(join(archiveDir, RETIREMENT_LOG_FILENAME))).toBe(true);
    expect(formatRetirementResult(result).join("\n")).toContain("retired concierge");
  });

  test("aborts BEFORE archiving when the backup fails", async () => {
    const stateDir = join(root, ".crewhaus");
    mkdirSync(stateDir, { recursive: true });
    const plan = buildRetirementPlan({
      specName: "c",
      harnessDir: root,
      archiveDir: join(root, "archive"),
      pins: {},
      force: false,
      pushKnowledge: false,
    });
    const { steps } = stubSteps({ failBackup: true });
    await expect(runRetirement({ plan, steps, dryRun: false })).rejects.toThrow(RetireError);
    // state NOT removed — the destructive step never ran
    expect(existsSync(stateDir)).toBe(true);
  });

  test("aborts BEFORE archiving when the registry tombstone fails", async () => {
    const stateDir = join(root, ".crewhaus");
    mkdirSync(stateDir, { recursive: true });
    const plan = buildRetirementPlan({
      specName: "c",
      harnessDir: root,
      archiveDir: join(root, "archive"),
      pins: {},
      force: false,
      pushKnowledge: false,
    });
    const { steps } = stubSteps({ failTombstone: true });
    await expect(runRetirement({ plan, steps, dryRun: false })).rejects.toThrow(RetireError);
    expect(existsSync(stateDir)).toBe(true);
  });

  test("performArchive:false leaves state in place (test seam)", async () => {
    const stateDir = join(root, ".crewhaus");
    mkdirSync(stateDir, { recursive: true });
    const plan = buildRetirementPlan({
      specName: "c",
      harnessDir: root,
      archiveDir: join(root, "archive"),
      pins: {},
      force: false,
      pushKnowledge: false,
    });
    const { steps } = stubSteps();
    const result = await runRetirement({ plan, steps, dryRun: false, performArchive: false });
    expect(result.removedState).toBe(false);
    expect(existsSync(stateDir)).toBe(true);
    // log still written
    expect(readRetirementLog(join(root, "archive"))).not.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // F4 — a tamper-reporting auditVerify / failed compliance ABORTS before the
  // destructive move, and the retirement log is written BEFORE the move.
  // -------------------------------------------------------------------------
  test("aborts (state intact) when auditVerify reports tamper", async () => {
    const stateDir = join(root, ".crewhaus");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "marker"), "x");
    const archiveDir = join(root, "archive");
    const plan = buildRetirementPlan({
      specName: "c",
      harnessDir: root,
      archiveDir,
      pins: {},
      force: false,
      pushKnowledge: false,
    });
    const { steps, calls } = stubSteps({ failAudit: true });
    await expect(runRetirement({ plan, steps, dryRun: false })).rejects.toThrow(RetireError);
    // The destructive tombstone/archive steps NEVER ran.
    expect(calls).not.toContain("tombstoneRegistry");
    // State left intact for investigation.
    expect(existsSync(join(stateDir, "marker"))).toBe(true);
    // The aborted-run log is still evidenced in the archive.
    const log = readRetirementLog(archiveDir);
    expect(log?.archived).toBe(false);
    expect(log?.outcomes.some((o) => o.step === "auditVerify" && !o.ok)).toBe(true);
  });

  test("aborts (state intact) when the compliance bundle fails", async () => {
    const stateDir = join(root, ".crewhaus");
    mkdirSync(stateDir, { recursive: true });
    const plan = buildRetirementPlan({
      specName: "c",
      harnessDir: root,
      archiveDir: join(root, "archive"),
      pins: {},
      force: false,
      pushKnowledge: false,
    });
    const { steps, calls } = stubSteps({ failCompliance: true });
    await expect(runRetirement({ plan, steps, dryRun: false })).rejects.toThrow(RetireError);
    expect(calls).not.toContain("tombstoneRegistry");
    expect(existsSync(stateDir)).toBe(true);
  });

  test("--force-unverified proceeds past a tamper finding and still removes state", async () => {
    const stateDir = join(root, ".crewhaus");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "marker"), "x");
    const archiveDir = join(root, "archive");
    const plan = buildRetirementPlan({
      specName: "c",
      harnessDir: root,
      archiveDir,
      pins: {},
      force: false,
      pushKnowledge: false,
    });
    const { steps, calls } = stubSteps({ failAudit: true });
    const result = await runRetirement({
      plan,
      steps,
      dryRun: false,
      forceUnverified: true,
    });
    expect(calls).toContain("tombstoneRegistry");
    expect(result.removedState).toBe(true);
    expect(existsSync(stateDir)).toBe(false);
  });

  test.if(canTestUnwritable)(
    "the retirement log is durably written BEFORE the destructive move (crash-safety)",
    async () => {
      // Force the destructive rename to THROW (a read-only archive dir), then
      // assert the log already exists on disk — proving it was fsynced before the
      // move, so a crash mid-remove still leaves the evidence.
      const stateDir = join(root, ".crewhaus");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, "marker"), "x");
      const archiveDir = join(root, "archive");
      mkdirSync(archiveDir, { recursive: true });
      const plan = buildRetirementPlan({
        specName: "c",
        harnessDir: root,
        archiveDir,
        pins: {},
        force: false,
        pushKnowledge: false,
      });
      const { steps } = stubSteps();
      // Make the HARNESS dir read-only so renameSync (which must remove the source
      // .crewhaus from its parent) throws — but the ARCHIVE dir stays writable so
      // the pre-move log write still lands. This isolates "log written before the
      // move" from "move succeeded".
      chmodSync(root, 0o500);
      try {
        await expect(runRetirement({ plan, steps, dryRun: false })).rejects.toThrow();
      } finally {
        chmodSync(root, 0o700);
      }
      // The pre-move durable write landed the log despite the failed move.
      expect(existsSync(join(archiveDir, RETIREMENT_LOG_FILENAME))).toBe(true);
      // And the state was NOT lost — the rename never completed.
      expect(existsSync(join(stateDir, "marker"))).toBe(true);
    },
  );
});

describe("a retire that ends what the harness could still do", () => {
  type Control = { daemonLive?: boolean; stop?: boolean; revokerItems?: RetirePlanItem[] };
  const options = (over: Control = {}) => ({
    specName: "concierge",
    harnessDir: root,
    archiveDir: join(root, "archive"),
    pins: {},
    force: false,
    pushKnowledge: false,
    control: { daemonLive: false, stop: false, revokerItems: [], ...over },
  });

  test("a running daemon without --stop is refused before any step, dry run too", async () => {
    mkdirSync(join(root, ".crewhaus"), { recursive: true });
    const { calls } = stubSteps();
    expect(() => buildRetirementPlan(options({ daemonLive: true }))).toThrow(
      "Stop it first, or run `crewhaus retire --stop`",
    );
    expect(calls).toEqual([]);
    expect(existsSync(join(root, "archive"))).toBe(false);
    // With --stop the plan is made, and it stops before it disables.
    const plan = buildRetirementPlan(options({ daemonLive: true, stop: true }));
    expect(plan.steps[0]).toBe("stopAndDisable");
    expect(formatPlan(plan).join("\n")).toContain("stop the daemon, then disable the harness");
  });

  test("a dry run lists every step and each revoker item, a manual one marked", async () => {
    const plan = buildRetirementPlan(
      options({
        revokerItems: [
          { kind: "delegation rules", status: "planned", note: "2 rules" },
          { kind: "slack token", status: "manual" },
        ],
      }),
    );
    const { steps, calls } = stubSteps();
    await runRetirement({ plan, steps, dryRun: true });
    expect(calls).toEqual([]);
    const text = formatPlan(plan).join("\n");
    for (const step of plan.steps) expect(text).toContain(`${plan.steps.indexOf(step) + 1}. `);
    expect(text).toContain("cancel its queued runs");
    expect(text).toContain("revoke its standing rules");
    expect(text).toContain("Home's lifecycle record");
    expect(text).toContain("delegation rules — 2 rules");
    expect(text).toContain("slack token (do this by hand)");
    expect(text).not.toContain("none are registered here");
    const bare = formatPlan(buildRetirementPlan(options())).join("\n");
    expect(bare).toContain("Connections: none are registered here.");
  });

  test("a failed pre-step aborts before the archive and leaves the state; the line names enable", async () => {
    const stateDir = join(root, ".crewhaus");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "marker"), "x");
    const plan = buildRetirementPlan(options());
    const { steps, calls } = stubSteps({ failPre: "cancelQueuedRuns" });
    const run = runRetirement({ plan, steps, dryRun: false });
    await expect(run).rejects.toThrow(RetireError);
    await expect(run).rejects.toThrow("crewhaus daemon enable");
    expect(calls).toEqual(["stopAndDisable", "cancelQueuedRuns"]);
    expect(existsSync(join(stateDir, "marker"))).toBe(true);
    expect(readRetirementLog(join(root, "archive"))?.archived).toBe(false);
  });

  test("a failed revoker aborts, and --force-unverified lets it through", async () => {
    const stateDir = join(root, ".crewhaus");
    mkdirSync(stateDir, { recursive: true });
    const refused = stubSteps({ failPre: "revokeConnections" });
    await expect(
      runRetirement({ plan: buildRetirementPlan(options()), steps: refused.steps, dryRun: false }),
    ).rejects.toThrow("--force-unverified");
    expect(refused.calls).not.toContain("backupState");
    expect(existsSync(stateDir)).toBe(true);

    const forced = stubSteps({ failPre: "revokeConnections" });
    const result = await runRetirement({
      plan: buildRetirementPlan(options()),
      steps: forced.steps,
      dryRun: false,
      forceUnverified: true,
    });
    expect(result.removedState).toBe(true);
    expect(forced.calls).toContain("archiveRegistryRow");
  });
});

describe("a host that runs no control steps", () => {
  test("its plan is the backup, evidence and archive alone, and runs as before", async () => {
    mkdirSync(join(root, ".crewhaus"), { recursive: true });
    const plan = buildRetirementPlan({
      specName: "c",
      harnessDir: root,
      archiveDir: join(root, "archive"),
      pins: {},
      force: false,
      pushKnowledge: false,
    });
    expect(plan.steps).toEqual([
      "backupState",
      "complianceEvidence",
      "auditVerify",
      "tombstoneRegistry",
      "archive",
    ]);
    expect(formatPlan(plan).join("\n")).not.toContain("Connections");
    const { steps, calls } = stubSteps();
    const { stopAndDisable: _a, recordLifecycle: _b, ...legacy } = steps;
    await runRetirement({ plan, steps: legacy, dryRun: false });
    expect(calls).toEqual([
      "backupState",
      "complianceEvidence",
      "auditVerify",
      "tombstoneRegistry",
    ]);
  });

  test("a plan with control steps and a host without them is refused before anything", async () => {
    const plan = buildRetirementPlan({
      specName: "c",
      harnessDir: root,
      archiveDir: join(root, "archive"),
      pins: {},
      force: false,
      pushKnowledge: false,
      control: { daemonLive: false, stop: false, revokerItems: [] },
    });
    const { steps, calls } = stubSteps();
    const { stopAndDisable: _gone, ...partial } = steps;
    await expect(runRetirement({ plan, steps: partial, dryRun: false })).rejects.toThrow(
      "stopAndDisable",
    );
    expect(calls).toEqual([]);
    expect(existsSync(join(root, "archive"))).toBe(false);
  });
});
