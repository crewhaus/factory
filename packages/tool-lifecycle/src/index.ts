/**
 * @crewhaus/tool-lifecycle — the back half of a harness's life, as
 * deterministic tools: retirement, store migration, retention enforcement and
 * knowledge sync.
 *
 * These four are the operations that are irreversible when they are wrong. A
 * retirement moves a harness's durable state out and removes the live copy. A
 * retention sweep deletes sessions on an age rule. A store migration writes
 * one store's contents into another root. A knowledge push copies a harness's
 * memories into a store other harnesses read. None of them can be undone by
 * running them again with a better flag.
 *
 * Five properties hold across the package.
 *
 *   1. THE REAL LIBRARY. Every rule these tools enforce belongs to
 *      `@crewhaus/harness-lifecycle` — the retirement plan and its
 *      active-pin refusal, the retention age rule and its pins, windows and
 *      audit-chain exclusion, the shared-knowledge validation and the
 *      credential redaction. This package contributes the schema, the
 *      containment, the refusals and the result shape. It does not contain a
 *      second copy of any of those rules, which is the whole reason they were
 *      lifted out of `apps/cli` in the first place.
 *   2. DRY RUN IS THE DEFAULT, AND IT IS THE SAME CODE. `dryRun` defaults to
 *      TRUE on all four tools: an irreversible operation should take an
 *      explicit `dryRun: false` to happen. The preview is produced by calling
 *      the same library function with its own dry-run flag, so the selection
 *      being previewed is the selection the real call acts on, not a parallel
 *      preview beside it. Where the two runs can still disagree — the library
 *      re-enumerates, and a store can change between the calls — the
 *      difference is computed and REPORTED rather than hidden.
 *   3. A REFUSAL WHEN THE SELECTOR IS TOO WIDE. An age rule that selects
 *      every session in the store, a purge cutoff in the future, a record
 *      whose timestamp is epoch zero, a migration into a directory that
 *      already holds someone else's store, a retirement into an archive that
 *      already holds one: each is refused by name, with what it would have
 *      taken.
 *   4. COULD NOT DETERMINE IS NOT NO. A directory that could not be listed is
 *      never reported as empty, an unreadable registry manifest is never
 *      reported as "no pins", an unverifiable archive is never reported as
 *      verified, and a step this build cannot perform reports that it did not
 *      perform it rather than returning success.
 *   5. WHAT THIS BUILD CANNOT DO, IT SAYS. Three things the CLI does around
 *      these operations need packages this one does not depend on: verifying
 *      the audit chain, collecting a compliance-evidence bundle, and
 *      rewriting records into a new store version. Each is named where it
 *      would have happened, with the tool or command that does it, and the
 *      operations that depend on it are refused rather than approximated.
 */

import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import {
  AUDIT_CHAIN_EXCLUSION_REASON,
  InvalidRetentionDateError,
  KNOWLEDGE_MARKER_RELPATH,
  RETENTION_CONFIG_RELPATH,
  RETIREMENT_LOG_FILENAME,
  RetentionConfigError,
  type RetentionEnforcementReport,
  RetireError,
  SHARED_DIR_DEFAULT,
  applyPull,
  applyPush,
  buildRetirementPlan,
  formatPlan,
  fragmentContentHash,
  harnessOptedIn,
  openHarnessRecordStore,
  parseRetentionDate,
  planPull,
  planPush,
  readHarnessGraders,
  readHarnessMemories,
  readHarnessPrompts,
  runRetentionExport,
  runRetentionPurge,
  runRetentionSweep,
  runRetirement,
} from "@crewhaus/harness-lifecycle";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import {
  NO_PII_PASS_REASON,
  PULLED_MEMORIES_RELPATH,
  SHARED_MANIFEST_RELPATH,
  SHARED_MEMORIES_RELPATH,
  auditHarnessMemoryFiles,
  auditSharedFragments,
  auditSharedMemories,
  harnessMemoryHashes,
  landedSharedGraderHashes,
  makeRedactor,
  pulledFragmentRelPath,
  sharedFragmentRelPath,
} from "./lib/knowledge";
import {
  COVERED_STORE_DIRS,
  EXPORT_MANIFEST_FILENAME,
  type MigrationReceiptFile,
  RECEIPT_FILENAME,
  RECORD_SHAPE_MIGRATION_UNAVAILABLE,
  inspectDestination,
  plannedPaths,
  readStoreVersion,
  uncoveredStateEntries,
  writeReceipt,
  writtenPaths,
} from "./lib/migrate";
import {
  type Loaded,
  contain,
  containExistingDir,
  containWritePaths,
  fail,
  iso,
  json,
  overlaps,
  refusal,
  renderPath,
  sample,
} from "./lib/result";
import { breadthRefusal, summarizeSelection } from "./lib/retention";
import {
  ARCHIVED_STATE_DIRNAME,
  AUDIT_VERIFY_UNAVAILABLE,
  COMPLIANCE_EVIDENCE_UNAVAILABLE,
  DEFAULT_REGISTRY_RELDIR,
  STATE_MANIFEST_FILENAME,
  STATE_RELDIR,
  buildRetireSteps,
  readRegistryPins,
  recordSteps,
  specNameIsSafe,
} from "./lib/retire";
import { type Tree, hashFile, verifyAgainst, walkTree } from "./lib/tree";

// ---------------------------------------------------------------------------
// shared plumbing
// ---------------------------------------------------------------------------

/**
 * Budgets for fingerprinting a harness's `.crewhaus` before it is archived.
 *
 * Hashing is the slow part of a retirement, and it runs on the preview too
 * (the preview has to be able to say "this will refuse, one of these files
 * cannot be read"). A tree past these budgets is refused rather than hashed,
 * and the caller can raise them for the call that really means it.
 */
const DEFAULT_MAX_STATE_FILES = 50_000;
const DEFAULT_MAX_STATE_BYTES = 512 * 1024 * 1024;

/** Default ceiling on artifacts moved by one knowledge sync. */
const DEFAULT_MAX_ARTIFACTS = 500;

/** Longest harness label accepted as push provenance. */
const MAX_HARNESS_LABEL = 100;

const dryRunField = z
  .boolean()
  .optional()
  .describe(
    "report what WOULD happen and change nothing. Defaults to TRUE: this tool takes an explicit dryRun:false to act.",
  );

/** Directory entries, distinguishing absent from unlistable. */
function listDir(abs: string): Loaded<string[]> {
  try {
    return { ok: true, value: readdirSync(abs).sort() };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { ok: true, value: [] }
      : {
          ok: false,
          code: "unreadable",
          reason: `"${renderPath(abs)}" could not be listed (${code ?? "unknown error"})`,
        };
  }
}

function isDirectory(abs: string): boolean {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

/**
 * What the state directory's NAME actually is, keeping the three answers
 * apart.
 *
 * `absent` is the only one a retirement may carry on past as "there is
 * nothing to archive". A `.crewhaus` that is a regular file, a fifo, or a
 * name that cannot be stat'd at all is NOT an absent one — and it used to be
 * reported as one, because a boolean `isDirectory()` that swallows its errors
 * answers "no" to "could you tell?" and "no" to "is there anything here?"
 * with the same word. The retirement then moved the thing it had just
 * reported did not exist.
 */
function probeStateDir(abs: string): Loaded<"directory" | "absent"> {
  let stat: ReturnType<typeof lstatSync>;
  try {
    // lstat: the NAME itself, not what it leads to.
    stat = lstatSync(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { ok: true, value: "absent" }
      : fail("unreadable", `${STATE_RELDIR} could not be read (${code ?? "unknown error"})`);
  }
  if (stat.isSymbolicLink()) {
    // `renameSync` moves the LINK: the data would stay exactly where it is —
    // possibly outside the workspace this tool is contained to — while the
    // harness loses its only pointer to it, and a verification that followed
    // the link into the archive would happily pass. The harness would read as
    // retired and nothing would have been archived.
    return fail(
      "refused",
      `${STATE_RELDIR} is a symlink — archiving it would move the link and leave the data where it is. Retire the directory the link points at, or replace the link with the real directory.`,
    );
  }
  if (!stat.isDirectory()) {
    return fail(
      "not-a-directory",
      `${STATE_RELDIR} exists but is not a directory — refusing to retire a harness whose state directory cannot be fingerprinted. An entry that could not be identified is not an absent one, and the archive step would move it anyway.`,
    );
  }
  return { ok: true, value: "directory" };
}

// ---------------------------------------------------------------------------
// HarnessRetire
// ---------------------------------------------------------------------------

export const harnessRetire: RegisteredTool = buildTool({
  name: "HarnessRetire",
  description:
    "Decommission a harness: fingerprint its durable state, archive it, and remove the live copy, with a retirement log written into the archive recording every step and its outcome. The orchestration, the ordering and the refusal on an active deployment pin are @crewhaus/harness-lifecycle's own. It REFUSES when the spec still has an environment pinned to a registered version, when the registry manifest cannot be read (an unreadable manifest is never treated as 'no pins'), when the archive directory already holds an archived state (the library replaces it, which would destroy the earlier harness's archive), and when the archive directory overlaps the state directory it is archiving. Two steps the CLI performs are NOT performed here and are reported as not performed: verifying the audit chain (run the AuditVerify tool first) and collecting a compliance-evidence bundle. Because of that a real run needs acceptUnverified:true. dryRun defaults to true and touches nothing; the preview fingerprints the state so it can tell you in advance about files it will not be able to read.",
  inputSchema: z.object({
    spec: z
      .string()
      .min(1)
      .describe(
        "the registered spec name, used to find the registry entry and to label the archive",
      ),
    archiveDir: z
      .string()
      .min(1)
      .describe(
        "where to archive the harness's state, inside the workspace and outside its state directory",
      ),
    dir: z.string().optional().describe("the harness directory (default: the working directory)"),
    registryDir: z
      .string()
      .optional()
      .describe(`the file-backed spec registry root (default: <dir>/${DEFAULT_REGISTRY_RELDIR})`),
    dryRun: dryRunField,
    acceptUnverified: z
      .boolean()
      .optional()
      .describe(
        "proceed even though this build verified neither the audit chain nor the compliance evidence. Required for a real run.",
      ),
    overwriteArchive: z
      .boolean()
      .optional()
      .describe(
        "allow an archive directory that is not empty (its archived state may be replaced)",
      ),
    maxStateFiles: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        `refuse a state tree with more files than this (default ${DEFAULT_MAX_STATE_FILES})`,
      ),
    maxStateBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`refuse a state tree bigger than this (default ${DEFAULT_MAX_STATE_BYTES})`),
  }),
  destructive: true,
  requireJustification: true,
  execute: async (input) => {
    const tool = "HarnessRetire";
    const dryRun = input.dryRun ?? true;

    if (!specNameIsSafe(input.spec)) {
      return refusal(
        tool,
        "bad-input",
        `"${renderPath(input.spec)}" is not a spec name — it looks like a path`,
      );
    }
    const dirRel = input.dir ?? ".";
    const harness = containExistingDir(tool, dirRel);
    if (!harness.ok) return refusal(tool, harness.code, harness.reason);
    const archive = contain(tool, input.archiveDir);
    if (!archive.ok) return refusal(tool, archive.code, archive.reason);
    const registry = contain(tool, input.registryDir ?? path.join(dirRel, DEFAULT_REGISTRY_RELDIR));
    if (!registry.ok) return refusal(tool, registry.code, registry.reason);

    const stateDir = path.join(harness.value.real, STATE_RELDIR);
    if (overlaps(archive.value.real, stateDir)) {
      return refusal(
        tool,
        "refused",
        `the archive directory and the state directory ${STATE_RELDIR} overlap — archiving a directory into itself would destroy it`,
      );
    }

    // The registry fact FIRST: the plan's refusal is built on it, and an
    // unreadable manifest must stop the call rather than read as "no pins".
    const pinState = readRegistryPins(registry.value.real, input.spec);
    if (pinState.state === "unknown") {
      return refusal(
        tool,
        "unreadable",
        `${pinState.reason} — refusing to retire a harness whose deployment pins cannot be read. An unreadable manifest is not an unpinned one.`,
      );
    }
    const pins = pinState.state === "known" ? pinState.pins : {};

    let plan: ReturnType<typeof buildRetirementPlan>;
    try {
      plan = buildRetirementPlan({
        specName: input.spec,
        harnessDir: harness.value.real,
        archiveDir: archive.value.real,
        pins,
        // Never forced: with @crewhaus/spec-registry out of reach this tool
        // cannot tombstone the pins it would be overriding, so "retire anyway"
        // would leave environments pointing at state that no longer exists.
        force: false,
        pushKnowledge: false,
      });
    } catch (err) {
      if (err instanceof RetireError) {
        return refusal(tool, "refused", err.message, { pins });
      }
      throw err;
    }

    const archiveEntries = listDir(archive.value.real);
    if (!archiveEntries.ok) return refusal(tool, archiveEntries.code, archiveEntries.reason);
    if (archiveEntries.value.length > 0 && input.overwriteArchive !== true) {
      return refusal(
        tool,
        "refused",
        `the archive directory is not empty (${archiveEntries.value.length} entry(ies)) and @crewhaus/harness-lifecycle REPLACES an existing ${ARCHIVED_STATE_DIRNAME} directory inside it — retiring into this directory could destroy an earlier harness's archive. Pick an empty directory, or pass overwriteArchive.`,
        { entries: sample(archiveEntries.value, 20) },
      );
    }

    // Contain what the retirement writes into the archive. `contain` proved
    // the archive directory is inside the workspace; with overwriteArchive a
    // caller can point it at a directory that already holds entries, and a
    // symlink named like one of these would send the retirement log or the
    // fingerprint manifest out of the workspace — the two files that are the
    // whole evidence of the decommission.
    const archiveEscapes = containWritePaths(tool, archive.value, [
      STATE_MANIFEST_FILENAME,
      RETIREMENT_LOG_FILENAME,
      ARCHIVED_STATE_DIRNAME,
    ]);
    if (archiveEscapes !== undefined) {
      return refusal(tool, archiveEscapes.code, archiveEscapes.reason);
    }

    // What `.crewhaus` IS, before anything is concluded from its absence.
    const stateKind = probeStateDir(stateDir);
    if (!stateKind.ok) return refusal(tool, stateKind.code, stateKind.reason);

    // Fingerprint the live state. Done identically on the preview and the real
    // run: it is the selection, and it is also what makes the archive
    // checkable afterwards.
    let stateTree: Tree | undefined;
    if (stateKind.value === "directory") {
      const walked = walkTree(stateDir, {
        maxFiles: input.maxStateFiles ?? DEFAULT_MAX_STATE_FILES,
        maxBytes: input.maxStateBytes ?? DEFAULT_MAX_STATE_BYTES,
        hash: true,
      });
      if (!walked.ok) return refusal(tool, walked.code, walked.reason);
      stateTree = walked.value;
    }

    const stateReport =
      stateTree === undefined
        ? { present: false }
        : {
            present: true,
            files: stateTree.fileCount,
            bytes: stateTree.totalBytes,
            oldestMtime: iso(stateTree.oldestMtimeMs),
            newestMtime: iso(stateTree.newestMtimeMs),
            fingerprintComplete: stateTree.complete,
            ...(stateTree.unreadable.length > 0
              ? { unreadable: sample(stateTree.unreadable, 10) }
              : {}),
          };
    const notPerformed = [
      { step: "auditVerify", reason: AUDIT_VERIFY_UNAVAILABLE },
      { step: "complianceEvidence", reason: COMPLIANCE_EVIDENCE_UNAVAILABLE },
    ];
    const registryReport = {
      state: pinState.state,
      ...(pinState.state === "known"
        ? { pins, versions: pinState.versions.length, versionNames: sample(pinState.versions, 20) }
        : {}),
    };

    if (dryRun) {
      return json({
        tool,
        status: "preview",
        dryRun: true,
        spec: input.spec,
        harnessDir: harness.value.rel === "" ? "." : harness.value.rel,
        archiveDir: archive.value.rel,
        plan: formatPlan(plan),
        steps: plan.steps,
        registry: registryReport,
        state: stateReport,
        notPerformed,
        wouldNeed: input.acceptUnverified === true ? [] : ["acceptUnverified"],
        nothingWasTouched: true,
      });
    }

    if (input.acceptUnverified !== true) {
      return refusal(
        tool,
        "refused",
        `a real retirement needs acceptUnverified:true, because this build performed neither of two checks the CLI performs. ${AUDIT_VERIFY_UNAVAILABLE} ${COMPLIANCE_EVIDENCE_UNAVAILABLE}`,
        { notPerformed },
      );
    }

    const { steps, recorded } = recordSteps(
      buildRetireSteps({
        stateTree,
        harnessDir: harness.value.real,
        pinState,
        now: () => new Date(),
      }),
    );
    try {
      const result = await runRetirement({
        plan,
        steps,
        dryRun: false,
        // The audit/compliance gate is being overridden KNOWINGLY: the two
        // steps reported that they did not run, which is not the same as
        // reporting tamper. `acceptUnverified` above is the caller saying so.
        forceUnverified: true,
      });

      const archivedStateDir = path.join(archive.value.real, ARCHIVED_STATE_DIRNAME);
      let verification: Record<string, unknown>;
      if (!result.removedState) {
        verification = {
          performed: false,
          reason: "no live state was moved, so there is nothing to verify",
        };
      } else if (stateTree === undefined) {
        verification = { performed: false, reason: "no fingerprint was taken before the move" };
      } else if (!isDirectory(archivedStateDir)) {
        // The library moved the state somewhere this tool did not expect. Say
        // that; do not report an unverified archive as a verified one.
        verification = {
          performed: false,
          reason: `the archived state was not found at <archiveDir>/${ARCHIVED_STATE_DIRNAME}, so the archive could not be checked against the fingerprint`,
        };
      } else {
        const verified = verifyAgainst(archivedStateDir, stateTree.entries, stateTree.complete);
        verification = {
          performed: true,
          ok: verified.ok,
          checked: verified.checked,
          verified: verified.verified,
          ...(verified.mismatched.length > 0
            ? { mismatched: sample(verified.mismatched, 10) }
            : {}),
        };
      }

      return json({
        tool,
        status: "applied",
        dryRun: false,
        spec: input.spec,
        harnessDir: harness.value.rel === "" ? "." : harness.value.rel,
        archiveDir: archive.value.rel,
        retiredAt: result.log.retiredAt,
        removedState: result.removedState,
        ...(result.logPath !== undefined ? { retirementLog: result.logPath } : {}),
        outcomes: result.log.outcomes,
        notPerformed,
        state: stateReport,
        verification,
        followUps: [
          pinState.state === "absent"
            ? "no registry entry existed for this spec"
            : "the registry entry was NOT tombstoned by this tool — delete the registered versions with the CLI",
          "knowledge was not pushed — run the KnowledgeSync tool before retiring if the harness's lessons should outlive it",
        ],
      });
    } catch (err) {
      // The library aborts BEFORE the destructive move on any failed step, so
      // a failure here means the live state is still in place.
      const stillThere = isDirectory(stateDir);
      // THIS run's outcomes, recorded as the steps returned them. Reading them
      // back out of the archive's retirement.json instead would be reading a
      // file an earlier run may have written — the outcomes of somebody else's
      // retirement, reported as this one's.
      return json({
        tool,
        status: err instanceof RetireError ? "refused" : "failed",
        dryRun: false,
        spec: input.spec,
        reason: (err as Error).message,
        liveStateIntact: stillThere,
        outcomes: recorded,
        notPerformed,
      });
    }
  },
});

// ---------------------------------------------------------------------------
// StoreMigrate
// ---------------------------------------------------------------------------

export const storeMigrate: RegisteredTool = buildTool({
  name: "StoreMigrate",
  description:
    "Migrate a harness's durable store to another store root: sessions and audit day files copied VERBATIM by @crewhaus/harness-lifecycle's own export path, every copied file then re-hashed at the destination, and a store-migration.json receipt written recording each file with its sha256. The source is not modified (beyond the audit evidence record the export appends), so the rollback is the source itself and re-running is safe: a second run reports what was already there. It REFUSES a destination that overlaps a live store, a destination already holding a receipt from a DIFFERENT source, and an overwrite of existing files unless overwrite is set. It also refuses a version-CHANGING migration outright rather than quietly copying records unchanged: the record transforms live in apps/cli, not here. What the export path does not carry — memories, prompts, graders, the registry, the policy files — is listed under notMigrated instead of being left silent. dryRun defaults to true.",
  inputSchema: z.object({
    to: z.string().min(1).describe("the destination store root, inside the workspace"),
    dir: z.string().optional().describe("the harness directory (default: the working directory)"),
    since: z
      .string()
      .optional()
      .describe("only records at or after this ISO date/datetime (audit is included by whole day)"),
    targetVersion: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "the store schema version to migrate TO; a version different from the source's is refused",
      ),
    dryRun: dryRunField,
    overwrite: z
      .boolean()
      .optional()
      .describe("allow writing over files that already exist at the destination"),
  }),
  destructive: true,
  requireJustification: true,
  execute: async (input) => {
    const tool = "StoreMigrate";
    const dryRun = input.dryRun ?? true;
    const harness = containExistingDir(tool, input.dir ?? ".");
    if (!harness.ok) return refusal(tool, harness.code, harness.reason);
    const dest = contain(tool, input.to);
    if (!dest.ok) return refusal(tool, dest.code, dest.reason);

    // Parse first, then act on the PARSED value: the library gets the epoch
    // ms, and the result echoes back the timestamp that was actually used,
    // never the caller's string as though it were the cutoff.
    let sinceMs: number | undefined;
    if (input.since !== undefined) {
      try {
        sinceMs = parseRetentionDate("since", input.since);
      } catch (err) {
        if (err instanceof InvalidRetentionDateError) {
          return refusal(tool, "bad-input", err.message);
        }
        throw err;
      }
    }

    const version = readStoreVersion(harness.value.real);
    if (version.state === "unknown") {
      return refusal(
        tool,
        "unreadable",
        `${version.reason} — refusing to migrate a store whose version cannot be read`,
      );
    }
    if (input.targetVersion !== undefined) {
      const sourceVersion = version.state === "known" ? version.memoriesSchemaVersion : undefined;
      if (sourceVersion === undefined) {
        return refusal(
          tool,
          "refused",
          `targetVersion ${input.targetVersion} was requested but the source store carries no version stamp (.crewhaus/meta.json), so there is no FROM version to migrate from. ${RECORD_SHAPE_MIGRATION_UNAVAILABLE}`,
        );
      }
      if (sourceVersion !== input.targetVersion) {
        return refusal(
          tool,
          "refused",
          `the source store is at version ${sourceVersion} and targetVersion ${input.targetVersion} was requested. ${RECORD_SHAPE_MIGRATION_UNAVAILABLE}`,
          { sourceVersion, targetVersion: input.targetVersion },
        );
      }
    }

    // The inventory tells us which sessions have a sibling event log, which is
    // what the destination paths depend on.
    let inventory: Awaited<ReturnType<typeof openHarnessRecordStore>>;
    try {
      inventory = await openHarnessRecordStore({ rootDir: harness.value.real, dryRun: true });
    } catch (err) {
      return refusal(
        tool,
        "unreadable",
        `the harness store could not be enumerated: ${(err as Error).message}`,
      );
    }
    const withEventLog = new Set(
      inventory.sessions.filter((s) => s.eventLogPath !== undefined).map((s) => s.sessionId),
    );
    const sourcePathFor = new Map<string, string>();
    for (const s of inventory.sessions) {
      sourcePathFor.set(`sessions/${s.sessionId}.json`, s.jsonPath);
      if (s.eventLogPath !== undefined) {
        sourcePathFor.set(`sessions/${s.sessionId}.jsonl`, s.eventLogPath);
      }
    }
    for (const a of inventory.auditDays) sourcePathFor.set(`audit/${a.day}.jsonl`, a.path);
    sourcePathFor.set(
      "audit/_chain-tail.json",
      path.join(harness.value.real, ".crewhaus", "audit", "_chain-tail.json"),
    );

    // The preview: the library's own dry run, which is the same enumeration
    // the real export performs.
    let preview: Awaited<ReturnType<typeof runRetentionExport>>;
    try {
      preview = await runRetentionExport({
        rootDir: harness.value.real,
        outDir: dest.value.real,
        ...(sinceMs !== undefined ? { since: sinceMs } : {}),
        dryRun: true,
      });
    } catch (err) {
      if (err instanceof RetentionConfigError) return refusal(tool, "refused", err.message);
      return refusal(tool, "unreadable", `the store could not be read: ${(err as Error).message}`);
    }

    const planned = plannedPaths({
      sessions: preview.sessions,
      auditDays: preview.auditDays,
      chainTail: preview.chainTailCopied,
      withEventLog,
    });
    // Everything the run WRITES, which is more than what it copies: the
    // export path drops its own manifest.json beside the copies and this tool
    // adds a receipt. Asking the conflict check only about the copies is how
    // a destination's manifest.json got overwritten with no `overwrite` and
    // no mention of it in the preview.
    const written = writtenPaths(planned);
    // Contain the write paths, not just the directory. `contain` above proved
    // `to` is inside the workspace; it proved nothing about a symlink sitting
    // at <to>/sessions/<id>.json, which copyFile would follow straight out of
    // the workspace — and a DANGLING one does not even register as a
    // conflict. Checked on the preview too, so the refusal is visible before
    // the run that would have written through it.
    const escaping = containWritePaths(tool, dest.value, written);
    if (escaping !== undefined) return refusal(tool, escaping.code, escaping.reason);
    const destState = inspectDestination(dest.value.real, written);
    if (!destState.ok) return refusal(tool, destState.code, destState.reason);
    const previousReceipt = destState.value.receipt;
    if (previousReceipt !== undefined && previousReceipt.sourceRoot !== harness.value.real) {
      return refusal(
        tool,
        "refused",
        `the destination already holds a ${RECEIPT_FILENAME} from a DIFFERENT store (${renderPath(previousReceipt.sourceRoot)}). Merging two harnesses' stores into one root cannot be undone, and their audit chains cannot both verify.`,
      );
    }
    if (destState.value.receiptProblem !== undefined && input.overwrite !== true) {
      return refusal(
        tool,
        "refused",
        `${destState.value.receiptProblem} — refusing to migrate into a destination whose previous migration cannot be identified. Pass overwrite if it is really yours.`,
      );
    }
    if (destState.value.conflicts.length > 0 && input.overwrite !== true) {
      return refusal(
        tool,
        "refused",
        `${destState.value.conflicts.length} file(s) at the destination would be written over. Pass overwrite to replace them.`,
        { conflicts: sample(destState.value.conflicts, 20) },
      );
    }

    const uncovered = uncoveredStateEntries(harness.value.real);
    const notMigrated = uncovered.ok
      ? uncovered.value
      : [{ entry: ".crewhaus", reason: uncovered.reason }];
    const partial = sinceMs !== undefined;
    const chainNote = preview.chainTailCopied
      ? "the audit chain-tail anchor is included, so the destination audit set is independently verifiable"
      : `the audit chain-tail anchor is NOT included${partial ? " (a since-filtered export starts mid-chain by construction)" : ""}, so the destination audit set will not verify on its own`;

    const common = {
      tool,
      harnessDir: harness.value.rel === "" ? "." : harness.value.rel,
      destination: dest.value.rel,
      storeVersion: version,
      ...(sinceMs !== undefined ? { since: iso(sinceMs) } : {}),
      chainTail: { copied: preview.chainTailCopied, note: chainNote },
      notMigrated,
      ...(preview.skipped.length > 0 ? { skipped: sample([...preview.skipped], 20) } : {}),
      ...(previousReceipt !== undefined
        ? {
            previousMigration: {
              at: previousReceipt.writtenAt,
              verified: previousReceipt.verified,
            },
          }
        : {}),
    };

    if (dryRun) {
      return json({
        ...common,
        status: "preview",
        dryRun: true,
        wouldMigrate: {
          sessions: preview.sessions.length,
          auditDays: preview.auditDays.length,
          files: planned.length,
        },
        wouldWrite: sample(written, 20),
        conflicts: sample([...destState.value.conflicts], 20),
        nothingWasTouched: true,
      });
    }

    // Fingerprint the sources BEFORE the copy. Hashing them afterwards would
    // compare against a store the export has already appended its own audit
    // evidence record to, and would report today's audit file as a mismatch
    // when nothing went wrong.
    const before = new Map<string, string>();
    const unhashable: Array<{ rel: string; reason: string }> = [];
    for (const rel of planned) {
      const src = sourcePathFor.get(rel);
      if (src === undefined) {
        unhashable.push({ rel, reason: "no source path for this planned file" });
        continue;
      }
      const digest = hashFile(src);
      if (digest.ok) before.set(rel, digest.value);
      else unhashable.push({ rel, reason: digest.reason });
    }

    let applied: Awaited<ReturnType<typeof runRetentionExport>>;
    try {
      applied = await runRetentionExport({
        rootDir: harness.value.real,
        outDir: dest.value.real,
        ...(sinceMs !== undefined ? { since: sinceMs } : {}),
        dryRun: false,
      });
    } catch (err) {
      if (err instanceof RetentionConfigError) return refusal(tool, "refused", err.message);
      return json({
        ...common,
        status: "failed",
        dryRun: false,
        reason: `the migration failed part-way: ${(err as Error).message}`,
        sourceIntact: true,
        note: "the source store was not modified, so it is still the whole store; re-run to resume",
      });
    }

    const appliedPaths = plannedPaths({
      sessions: applied.sessions,
      auditDays: applied.auditDays,
      chainTail: applied.chainTailCopied,
      withEventLog,
    });
    const files: MigrationReceiptFile[] = [];
    const mismatched: Array<{ rel: string; problem: string; detail: string }> = [];
    for (const rel of appliedPaths) {
      const abs = path.join(dest.value.real, ...rel.split("/"));
      const digest = hashFile(abs);
      if (!digest.ok) {
        mismatched.push({ rel, problem: "missing", detail: digest.reason });
        continue;
      }
      const expected = before.get(rel);
      if (expected === undefined) {
        mismatched.push({
          rel,
          problem: "unverifiable",
          detail:
            "the source was not fingerprinted before the copy, so this file cannot be verified",
        });
        continue;
      }
      if (expected !== digest.value) {
        mismatched.push({
          rel,
          problem: "sha256",
          detail: "the destination bytes differ from the source's",
        });
        continue;
      }
      let bytes = 0;
      try {
        bytes = statSync(abs).size;
      } catch {
        // Size is decoration next to the digest that already matched.
      }
      files.push({ rel, bytes, sha256: digest.value });
    }

    const previewedSet = new Set(planned);
    const appliedSet = new Set(appliedPaths);
    const divergence = {
      onlyPreviewed: planned.filter((p) => !appliedSet.has(p)),
      onlyApplied: appliedPaths.filter((p) => !previewedSet.has(p)),
    };

    const receiptWrite = writeReceipt(dest.value.real, {
      writtenAt: new Date().toISOString(),
      sourceRoot: harness.value.real,
      destinationRoot: dest.value.real,
      storeVersion: version,
      ...(sinceMs !== undefined ? { since: iso(sinceMs) as string } : {}),
      sessions: applied.sessions,
      auditDays: applied.auditDays,
      chainTailCopied: applied.chainTailCopied,
      files,
      verified: mismatched.length === 0 && unhashable.length === 0,
    });

    return json({
      ...common,
      status: "applied",
      dryRun: false,
      migrated: {
        sessions: applied.sessions.length,
        auditDays: applied.auditDays.length,
        // What LANDED, not what verified. `files` holds only the entries
        // whose destination digest matched, so reporting its length as the
        // file count under-reported a partly-failed migration — which is the
        // number someone cleaning one up acts on. The two are reported
        // separately, and `verified` says whether they agree.
        files: appliedPaths.length,
        filesVerified: files.length,
      },
      verified: mismatched.length === 0 && unhashable.length === 0,
      ...(mismatched.length > 0 ? { mismatched: sample(mismatched, 20) } : {}),
      ...(unhashable.length > 0 ? { unverifiable: sample(unhashable, 20) } : {}),
      ...(divergence.onlyPreviewed.length > 0 || divergence.onlyApplied.length > 0
        ? { divergedFromPreview: divergence }
        : {}),
      ...(applied.evidence !== undefined ? { evidence: applied.evidence } : {}),
      receipt: receiptWrite.ok ? receiptWrite.value : undefined,
      ...(receiptWrite.ok ? {} : { receiptProblem: receiptWrite.reason }),
      sourceIntact: true,
      rollback:
        "the source store was not deleted — it is still the authoritative copy until you remove it yourself",
    });
  },
});

// ---------------------------------------------------------------------------
// RetentionEnforce
// ---------------------------------------------------------------------------

export const retentionEnforce: RegisteredTool = buildTool({
  name: "RetentionEnforce",
  description:
    "Run a retention sweep or purge over a harness's stores: delete sessions past the age rule in .crewhaus/retention.json, honouring its pins and audit windows, and append a retention_enforcement record to the audit chain on a real run. The age rule, the pins, the windows and the audit-chain exclusion are all @crewhaus/harness-lifecycle's. dryRun defaults to true and reports the selection by COUNT and by the oldest and newest timestamps in it, so a misconfigured window is visible before it runs rather than after. It REFUSES a selection that covers every session in the store (unless allowDeleteAll says that is the intent), a purge cutoff in the future, a selection over maxDeletions, and — with no override at all — a selection containing a record whose timestamp is at or before 1971, because a timestamp that low is a broken clock rather than data that old and every age rule reads it as infinitely old. Audit data is never deleted. A store that cannot be enumerated is reported as unreadable, never as empty.",
  inputSchema: z.object({
    action: z
      .enum(["sweep", "purge"])
      .describe(
        "sweep: the scheduled TTL pass. purge: the same rules restricted to records before a cutoff.",
      ),
    dir: z.string().optional().describe("the harness directory (default: the working directory)"),
    before: z
      .string()
      .optional()
      .describe("purge only — an ISO date/datetime; only records older than this are candidates"),
    dryRun: dryRunField,
    allowDeleteAll: z
      .boolean()
      .optional()
      .describe("confirm that deleting every session in the store is the intent"),
    maxDeletions: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("refuse if the selection is larger than this"),
  }),
  destructive: true,
  requireJustification: true,
  execute: async (input) => {
    const tool = "RetentionEnforce";
    const dryRun = input.dryRun ?? true;
    const harness = containExistingDir(tool, input.dir ?? ".");
    if (!harness.ok) return refusal(tool, harness.code, harness.reason);
    const rootDir = harness.value.real;

    // The store directories this sweep deletes from, contained. `dir` being
    // inside the workspace says nothing about `.crewhaus/sessions` being a
    // symlink out of it: readdir follows the link, session-store unlinks
    // inside the link's target, and a sweep run against a harness in the
    // workspace deleted files that were never in it. There is no flag for
    // this — an irreversible delete outside the boundary is not something a
    // caller can opt into here.
    const storeEscapes = containWritePaths(
      tool,
      harness.value,
      COVERED_STORE_DIRS.map((d) => `${STATE_RELDIR}/${d}`),
    );
    if (storeEscapes !== undefined) return refusal(tool, storeEscapes.code, storeEscapes.reason);

    if (input.before !== undefined && input.action !== "purge") {
      return refusal(
        tool,
        "bad-input",
        '"before" is a purge cutoff; a sweep has no cutoff. Use action:"purge" or drop it.',
      );
    }
    let beforeMs: number | undefined;
    if (input.before !== undefined) {
      try {
        beforeMs = parseRetentionDate("before", input.before);
      } catch (err) {
        if (err instanceof InvalidRetentionDateError)
          return refusal(tool, "bad-input", err.message);
        throw err;
      }
    }

    // One clock reading for both passes, so the preview and the real run
    // evaluate the age rule against the same instant.
    const nowMs = Date.now();
    const now = () => nowMs;

    let inventory: Awaited<ReturnType<typeof openHarnessRecordStore>>;
    try {
      inventory = await openHarnessRecordStore({ rootDir, dryRun: true });
    } catch (err) {
      // Unreadable is not empty: a sweep must not proceed on a store it could
      // not enumerate.
      return refusal(
        tool,
        "unreadable",
        `the harness store could not be enumerated, so nothing was deleted: ${(err as Error).message}`,
      );
    }

    const runPass = async (isDry: boolean): Promise<RetentionEnforcementReport> =>
      input.action === "purge"
        ? await runRetentionPurge({
            rootDir,
            ...(beforeMs !== undefined ? { before: beforeMs } : {}),
            dryRun: isDry,
            now,
          })
        : await runRetentionSweep({ rootDir, dryRun: isDry, now });

    let preview: RetentionEnforcementReport;
    try {
      preview = await runPass(true);
    } catch (err) {
      if (err instanceof RetentionConfigError) {
        return refusal(
          tool,
          "refused",
          `${err.message} — an enforcer that half-understands its policy must not guess, so nothing was deleted`,
        );
      }
      return refusal(
        tool,
        "unreadable",
        `the retention pass could not be planned: ${(err as Error).message}`,
      );
    }

    const selection = summarizeSelection(preview, inventory.sessions);
    const policy = {
      configPath: RETENTION_CONFIG_RELPATH,
      fromFile: preview.config.fromFile,
      sessionMaxAgeDays: preview.config.sessionMaxAgeDays,
      pins: preview.config.pins.length,
      cutoff: iso(beforeMs),
      evaluatedAt: new Date(nowMs).toISOString(),
    };
    const kept = {
      pinned: sample([...preview.keptPinned], 20),
      withinRetention: sample([...preview.keptWithinRetention], 20),
      auditWindow: sample([...preview.keptAuditWindow], 20),
      outsideCutoff: sample([...preview.keptOutsideCutoff], 20),
      auditChain: {
        dayFiles: preview.keptAuditChain.length,
        reason: AUDIT_CHAIN_EXCLUSION_REASON,
      },
    };
    const selectionReport = {
      count: selection.count,
      ofSessionsInStore: selection.sessionsInStore,
      oldest: iso(selection.oldestMs),
      newest: iso(selection.newestMs),
      ids: sample(
        selection.records.map((r) => r.id),
        50,
      ),
      ...(selection.unknownTimestamp.length > 0
        ? { timestampUnknown: sample(selection.unknownTimestamp, 20) }
        : {}),
    };
    const common = {
      tool,
      action: input.action,
      harnessDir: harness.value.rel === "" ? "." : harness.value.rel,
      policy,
      selection: selectionReport,
      kept,
      ...(preview.skipped.length > 0 ? { skipped: sample([...preview.skipped], 20) } : {}),
      ...(preview.activeAuditWindows.length > 0
        ? { activeAuditWindows: preview.activeAuditWindows }
        : {}),
    };

    const refused = breadthRefusal(selection, {
      allowDeleteAll: input.allowDeleteAll === true,
      ...(input.maxDeletions !== undefined ? { maxDeletions: input.maxDeletions } : {}),
      ...(beforeMs !== undefined ? { cutoffMs: beforeMs } : {}),
      nowMs,
    });
    if (refused !== undefined) {
      return json({
        ...common,
        status: "refused",
        code: refused.code,
        reason: refused.reason,
        deleted: 0,
      });
    }

    if (dryRun) {
      return json({
        ...common,
        status: "preview",
        dryRun: true,
        wouldDelete: selection.count,
        nothingWasTouched: true,
      });
    }

    let appliedReport: RetentionEnforcementReport;
    try {
      appliedReport = await runPass(false);
    } catch (err) {
      return json({
        ...common,
        status: "failed",
        dryRun: false,
        reason: `the enforcement pass failed: ${(err as Error).message}`,
        deleted: 0,
      });
    }

    // The library re-enumerates on the real pass, so the two selections can
    // genuinely differ (a session written or removed in between). Report the
    // difference instead of presenting the preview as what happened.
    const previewedIds = new Set(preview.deleted.map((d) => d.id));
    const appliedIds = appliedReport.deleted.map((d) => d.id);
    const divergence = {
      onlyPreviewed: [...previewedIds].filter((id) => !appliedIds.includes(id)),
      onlyApplied: appliedIds.filter((id) => !previewedIds.has(id)),
    };

    return json({
      ...common,
      status: "applied",
      dryRun: false,
      deleted: appliedReport.deleted.length,
      deletedIds: sample(appliedIds, 50),
      ...(divergence.onlyPreviewed.length > 0 || divergence.onlyApplied.length > 0
        ? { divergedFromPreview: divergence }
        : {}),
      evidence: appliedReport.evidence ?? null,
      ...(appliedReport.evidence === undefined
        ? {
            evidenceNote:
              "no retention_enforcement record was appended: this harness has no audit store, and one was not fabricated to log that nothing happened",
          }
        : {}),
    });
  },
});

// ---------------------------------------------------------------------------
// KnowledgeSync
// ---------------------------------------------------------------------------

export const knowledgeSync: RegisteredTool = buildTool({
  name: "KnowledgeSync",
  description:
    "Push a harness's memories, grader and prompt fragments into a shared knowledge store, or pull the store's into the harness. Deduped by content hash and redacted by @crewhaus/harness-lifecycle, which drops any artifact still carrying a credential-shaped token after masking. A push requires the harness to have opted in (a .crewhaus/knowledge.json marker) and requires allowWithoutPiiRedaction, because @crewhaus/pii-redactor is not a dependency here: credential masking runs, but names, emails and phone numbers are NOT removed. Shared records that failed validation — a forged content hash, an oversized body — are COUNTED and reported rather than silently skipped, because a poisoned shared store is untrusted input, and a sync that moves more than maxArtifacts is refused. The text of artifacts dropped for still looking secret is never echoed back. dryRun defaults to true.",
  inputSchema: z.object({
    direction: z
      .enum(["push", "pull"])
      .describe("push: harness → shared store. pull: shared store → harness."),
    dir: z.string().optional().describe("the harness directory (default: the working directory)"),
    sharedDir: z
      .string()
      .optional()
      .describe(`the shared knowledge store (default: ${SHARED_DIR_DEFAULT})`),
    harness: z
      .string()
      .optional()
      .describe("the label recorded as push provenance (default: the harness directory's name)"),
    dryRun: dryRunField,
    maxArtifacts: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`refuse a sync moving more artifacts than this (default ${DEFAULT_MAX_ARTIFACTS})`),
    allowWithoutPiiRedaction: z
      .boolean()
      .optional()
      .describe("push although the PII pass of the redactor is not available in this build"),
  }),
  destructive: true,
  requireJustification: true,
  execute: async (input) => {
    const tool = "KnowledgeSync";
    const dryRun = input.dryRun ?? true;
    const maxArtifacts = input.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS;
    const harnessDir = containExistingDir(tool, input.dir ?? ".");
    if (!harnessDir.ok) return refusal(tool, harnessDir.code, harnessDir.reason);
    const shared = contain(tool, input.sharedDir ?? SHARED_DIR_DEFAULT);
    if (!shared.ok) return refusal(tool, shared.code, shared.reason);

    const stateDir = path.join(harnessDir.value.real, STATE_RELDIR);
    if (overlaps(shared.value.real, stateDir)) {
      return refusal(
        tool,
        "refused",
        `the shared store and the harness's ${STATE_RELDIR} overlap — a store inside the harness it syncs with would re-ingest its own pushes`,
      );
    }

    const label = input.harness ?? path.basename(harnessDir.value.real);
    // A label is written into the shared store's provenance and read back by
    // every harness that pulls: no control characters, and a bound.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
    if (label.length === 0 || label.length > MAX_HARNESS_LABEL || CONTROL_CHARS.test(label)) {
      return refusal(
        tool,
        "bad-input",
        `"${renderPath(label)}" is not a usable harness label — it is empty, over ${MAX_HARNESS_LABEL} characters, or carries control characters`,
      );
    }

    const sharedMemories = auditSharedMemories(shared.value.real);
    if (!sharedMemories.ok) return refusal(tool, sharedMemories.code, sharedMemories.reason);
    const sharedGraders = auditSharedFragments(shared.value.real, "grader");
    if (!sharedGraders.ok) return refusal(tool, sharedGraders.code, sharedGraders.reason);
    const sharedPrompts = auditSharedFragments(shared.value.real, "prompt");
    if (!sharedPrompts.ok) return refusal(tool, sharedPrompts.code, sharedPrompts.reason);
    const sharedFragments = [...sharedGraders.value.fragments, ...sharedPrompts.value.fragments];
    const rejectedShared = [
      ...sharedMemories.value.rejected,
      ...sharedGraders.value.rejected,
      ...sharedPrompts.value.rejected,
    ];

    // Harness-side reads. Each can throw on an unreadable file, and that is a
    // failure with a reason, not an empty harness.
    let harnessMemories: ReturnType<typeof readHarnessMemories>;
    let harnessGraders: ReturnType<typeof readHarnessGraders>;
    let harnessPrompts: ReturnType<typeof readHarnessPrompts>;
    try {
      harnessMemories = readHarnessMemories(harnessDir.value.real);
      harnessGraders = readHarnessGraders(harnessDir.value.real);
      harnessPrompts = readHarnessPrompts(harnessDir.value.real);
    } catch (err) {
      return refusal(
        tool,
        "unreadable",
        `the harness's knowledge could not be read: ${(err as Error).message}`,
      );
    }
    const memoryFiles = auditHarnessMemoryFiles(harnessDir.value.real);
    if (!memoryFiles.ok) return refusal(tool, memoryFiles.code, memoryFiles.reason);

    const harnessReport = {
      memories: harnessMemories.length,
      memoryFiles: memoryFiles.value.files,
      memoryLines: memoryFiles.value.linesSeen,
      ...(memoryFiles.value.linesSeen > harnessMemories.length
        ? {
            linesNotParsedAsMemories: memoryFiles.value.linesSeen - harnessMemories.length,
          }
        : {}),
      graders: harnessGraders === undefined ? 0 : 1,
      prompts: harnessPrompts.length,
    };
    const sharedReport = {
      memories: sharedMemories.value.memories.length,
      fragments: sharedFragments.length,
      ...(rejectedShared.length > 0 ? { rejected: sample(rejectedShared, 20) } : {}),
    };
    const common = {
      tool,
      direction: input.direction,
      harnessDir: harnessDir.value.rel === "" ? "." : harnessDir.value.rel,
      sharedDir: shared.value.rel,
      harness: harnessReport,
      shared: sharedReport,
    };

    if (input.direction === "push") {
      if (!harnessOptedIn(harnessDir.value.real)) {
        return refusal(
          tool,
          "refused",
          `this harness has not opted into knowledge sharing — ${KNOWLEDGE_MARKER_RELPATH} is absent or does not say { "share": true }`,
          common,
        );
      }
      if (input.allowWithoutPiiRedaction !== true) {
        return refusal(tool, "refused", NO_PII_PASS_REASON, common);
      }
      const plan = await planPush({
        harness: label,
        memories: harnessMemories,
        graders: harnessGraders,
        prompts: harnessPrompts,
        existingMemoryHashes: new Set(sharedMemories.value.memories.map((m) => m.contentHash)),
        existingFragmentHashes: new Set(sharedFragments.map((f) => f.contentHash)),
        redact: makeRedactor(),
        now: () => new Date(),
      });
      const total = plan.memories.length + plan.fragments.length;
      const planReport = {
        memories: plan.memories.length,
        fragments: plan.fragments.length,
        duplicates: plan.skippedDuplicates,
        // COUNT ONLY. The library's own report prints a 60-character preview
        // of each dropped memory; those are the artifacts that still looked
        // like a credential, so echoing them here would publish the secret
        // into the caller's transcript.
        droppedForSecrets: plan.droppedSecrets.length,
        redaction: {
          credentialMasking: "applied",
          piiPass: "not performed",
          reason: NO_PII_PASS_REASON,
        },
      };
      // Contain what the push WRITES. `contain` proved the shared directory
      // is inside the workspace; it proved nothing about `memories.jsonl`
      // INSIDE it being a symlink out — and a shared store is untrusted input
      // by this tool's own description, so a link planted there would have
      // appended the harness's memories to whatever it pointed at. Checked on
      // the preview too, so the refusal shows before the run that would write.
      const pushWrites = [
        ...(plan.memories.length > 0 ? [SHARED_MEMORIES_RELPATH] : []),
        SHARED_MANIFEST_RELPATH,
        ...plan.fragments.map(sharedFragmentRelPath),
      ];
      const pushEscapes = containWritePaths(tool, shared.value, pushWrites);
      if (pushEscapes !== undefined) {
        return refusal(tool, pushEscapes.code, pushEscapes.reason, { ...common, plan: planReport });
      }
      if (total > maxArtifacts) {
        return json({
          ...common,
          status: "refused",
          code: "refused",
          reason: `refusing: this push would move ${total} artifact(s), over the maxArtifacts limit of ${maxArtifacts}.`,
          plan: planReport,
        });
      }
      if (dryRun) {
        return json({
          ...common,
          status: "preview",
          dryRun: true,
          plan: planReport,
          nothingWasTouched: true,
        });
      }
      try {
        applyPush(shared.value.real, plan, () => new Date());
      } catch (err) {
        return json({
          ...common,
          status: "failed",
          dryRun: false,
          reason: `the push failed part-way: ${(err as Error).message}`,
          plan: planReport,
        });
      }
      // Verify by re-reading the shared store through the same validator: an
      // artifact that did not land, or landed unreadable, is reported.
      const after = auditSharedMemories(shared.value.real);
      const landedHashes = after.ok
        ? new Set(after.value.memories.map((m) => m.contentHash))
        : new Set<string>();
      const missing = after.ok
        ? plan.memories.filter((m) => !landedHashes.has(m.contentHash)).map((m) => m.contentHash)
        : [];
      const fragmentsMissing = plan.fragments.filter(
        (f) => !existsSync(path.join(shared.value.real, ...sharedFragmentRelPath(f).split("/"))),
      );
      return json({
        ...common,
        status: "applied",
        dryRun: false,
        pushed: { memories: plan.memories.length, fragments: plan.fragments.length },
        plan: planReport,
        verified: after.ok && missing.length === 0 && fragmentsMissing.length === 0,
        ...(after.ok
          ? {}
          : {
              verificationProblem: `the shared store could not be re-read to verify the push: ${after.reason}`,
            }),
        ...(missing.length > 0 ? { memoriesMissingAfterPush: sample(missing, 20) } : {}),
        ...(fragmentsMissing.length > 0
          ? {
              fragmentsMissingAfterPush: sample(
                fragmentsMissing.map((f) => f.filename),
                20,
              ),
            }
          : {}),
      });
    }

    // pull
    const localMemoryHashes = harnessMemoryHashes(harnessMemories);
    // A grader fragment a previous pull landed is written to
    // `graders.shared-<hash>.yaml`, which `readHarnessGraders` deliberately
    // does not look at — so without this every pull counted it as new and
    // reported pulling it again. Unreadable is a refusal, not an empty set:
    // guessing "not present" here is what makes a duplicate look new.
    const landedGraders = landedSharedGraderHashes(harnessDir.value.real);
    if (!landedGraders.ok) return refusal(tool, landedGraders.code, landedGraders.reason);
    const harnessFragmentHashes = new Set([
      ...[
        ...(harnessGraders === undefined ? [] : [harnessGraders.contents]),
        ...harnessPrompts.map((p) => p.contents),
      ].map((contents) => fragmentContentHash(contents)),
      ...landedGraders.value,
    ]);
    const plan = planPull({
      sharedMemories: sharedMemories.value.memories,
      sharedFragments,
      harnessMemoryHashes: localMemoryHashes,
      harnessFragmentHashes,
    });
    const total = plan.memories.length + plan.fragments.length;
    const planReport = {
      memories: plan.memories.length,
      fragments: plan.fragments.length,
      duplicates: plan.skippedDuplicates,
    };
    // Contain what the pull WRITES, for the same reason the push does: the
    // harness directory being inside the workspace says nothing about
    // `.crewhaus/prompts` being a symlink pointing out of it.
    const pullWrites = [
      ...(plan.memories.length > 0 ? [PULLED_MEMORIES_RELPATH] : []),
      ...plan.fragments.map(pulledFragmentRelPath),
    ];
    const pullEscapes = containWritePaths(tool, harnessDir.value, pullWrites);
    if (pullEscapes !== undefined) {
      return refusal(tool, pullEscapes.code, pullEscapes.reason, { ...common, plan: planReport });
    }
    if (total > maxArtifacts) {
      return json({
        ...common,
        status: "refused",
        code: "refused",
        reason: `refusing: this pull would bring in ${total} artifact(s) from an untrusted shared store, over the maxArtifacts limit of ${maxArtifacts}.`,
        plan: planReport,
      });
    }
    if (dryRun) {
      return json({
        ...common,
        status: "preview",
        dryRun: true,
        plan: planReport,
        nothingWasTouched: true,
      });
    }
    try {
      applyPull(harnessDir.value.real, plan, () => new Date());
    } catch (err) {
      return json({
        ...common,
        status: "failed",
        dryRun: false,
        reason: `the pull failed part-way: ${(err as Error).message}`,
        plan: planReport,
      });
    }
    let landed: Set<string>;
    try {
      landed = harnessMemoryHashes(readHarnessMemories(harnessDir.value.real));
    } catch (err) {
      return json({
        ...common,
        status: "applied",
        dryRun: false,
        pulled: planReport,
        verified: false,
        verificationProblem: `the harness memories could not be re-read to verify the pull: ${(err as Error).message}`,
      });
    }
    const missing = plan.memories
      .filter((m) => !landed.has(m.contentHash))
      .map((m) => m.contentHash);
    // Fragments are verified too, as the push verifies its own. Checking only
    // the memories and calling the whole pull `verified` would be a partial
    // check reported as a total one.
    const fragmentsMissing = plan.fragments
      .map((f) => pulledFragmentRelPath(f))
      .filter((rel) => !existsSync(path.join(harnessDir.value.real, ...rel.split("/"))));
    return json({
      ...common,
      status: "applied",
      dryRun: false,
      pulled: planReport,
      verified: missing.length === 0 && fragmentsMissing.length === 0,
      ...(missing.length > 0 ? { memoriesMissingAfterPull: sample(missing, 20) } : {}),
      ...(fragmentsMissing.length > 0
        ? { fragmentsMissingAfterPull: sample(fragmentsMissing, 20) }
        : {}),
    });
  },
});

/** Every tool this package registers, in the order a catalog should list them. */
export const LIFECYCLE_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  harnessRetire,
  knowledgeSync,
  retentionEnforce,
  storeMigrate,
]);
