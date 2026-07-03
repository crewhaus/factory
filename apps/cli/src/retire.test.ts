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
  type RetirementSteps,
  type StepOutcome,
  activePins,
  buildRetirementPlan,
  formatPlan,
  formatRetirementResult,
  readRetirementLog,
  runRetirement,
} from "./retire";

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
    });
    const { steps, calls } = stubSteps();
    const result = await runRetirement({
      plan,
      steps,
      dryRun: false,
      now: () => new Date("2026-07-02T00:00:00Z"),
    });

    // order: backup → compliance → audit → knowledge → tombstone
    expect(calls).toEqual([
      "backupState",
      "complianceEvidence",
      "auditVerify",
      "pushKnowledge",
      "tombstoneRegistry",
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

  test("the retirement log is durably written BEFORE the destructive move (crash-safety)", async () => {
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
  });
});
