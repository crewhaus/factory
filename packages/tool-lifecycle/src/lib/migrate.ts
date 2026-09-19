/**
 * `StoreMigrate`'s half: what a harness's store version IS, what the
 * migration path actually carries, and what it leaves behind.
 *
 * The copy itself is `@crewhaus/harness-lifecycle`'s `runRetentionExport` —
 * the same enumerate-and-copy code the retention export verb uses, which
 * copies session and audit files VERBATIM (an audit day file has to keep its
 * exact bytes or the hash chain over it stops verifying). Nothing about
 * selection or copying is re-implemented here.
 *
 * What is here is the part that makes a migration honest rather than a hope:
 *
 *   - THE STORE VERSION. Read, reported, and never quietly changed. This
 *     build can move a store; it cannot rewrite records into a new shape,
 *     because the memory-entry 1→2 transform lives in `apps/cli`
 *     (`migrateMemories`) and reaching it needs packages this one does not
 *     depend on. A version-changing migration is REFUSED by name instead of
 *     being silently performed as a copy, which would leave a caller
 *     believing their store was upgraded.
 *   - WHAT IS NOT CARRIED. The export path covers `.crewhaus/sessions` and
 *     `.crewhaus/audit`. Memories, prompts, graders, the registry and the
 *     policy files are NOT part of it. A migration that reports success while
 *     leaving them behind is exactly the half-migration that puts a store in
 *     neither shape, so everything under `.crewhaus` that the copy does not
 *     carry is enumerated and returned.
 *   - THE RECEIPT. Every file that was copied, with its sha256, written to
 *     the destination. A re-run reads it back, so "already migrated" and
 *     "migrated just now" are distinguishable, and an interrupted run can be
 *     resumed by running it again.
 */
import { lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { type Loaded, fail, renderPath } from "./result";

/**
 * The two directories under `.crewhaus` that ARE the harness's record store:
 * the pair `runRetentionExport` carries, and the same pair
 * `openHarnessRecordStore` enumerates and a sweep deletes from. Mirrored here
 * because `@crewhaus/harness-lifecycle` keeps the relpaths private.
 */
export const COVERED_STORE_DIRS = ["sessions", "audit"] as const;

export const RECEIPT_FILENAME = "store-migration.json";

/**
 * The file `runRetentionExport` writes into its output directory on every
 * REAL run, on top of the copies themselves.
 *
 * Mirrored here (the package does not export the name) because it is a
 * destination this tool writes but does not copy: leaving it out of the
 * written set made the conflict check miss it, so a destination that already
 * held a `manifest.json` — a previous `crewhaus retention export`, say — had
 * it overwritten without `overwrite` being asked for and without the preview
 * ever naming it. `index.test.ts` pins the coupling: a real migration must
 * produce this file at this name.
 */
export const EXPORT_MANIFEST_FILENAME = "manifest.json";

export const RECORD_SHAPE_MIGRATION_UNAVAILABLE =
  "a version-changing migration rewrites every record, and the record transforms live in apps/cli " +
  "(migrateMemories, over @crewhaus/memory-store + @crewhaus/migration-engine) which " +
  "@crewhaus/tool-lifecycle does not depend on. This tool moves a store between roots at the " +
  "version it already has; it will not claim to have upgraded one.";

// ---------------------------------------------------------------------------
// store version
// ---------------------------------------------------------------------------

export type StoreVersion =
  | { readonly state: "known"; readonly memoriesSchemaVersion: number }
  /** No `.crewhaus/meta.json`: nothing has stamped a version here yet. */
  | { readonly state: "unstamped" }
  | { readonly state: "unknown"; readonly reason: string };

/**
 * Read `<harnessDir>/.crewhaus/meta.json`, the file `crewhaus migrate
 * memories` stamps (`{ memories: { schemaVersion, migratedAt } }`).
 *
 * An unreadable or malformed meta file is `unknown`, never version 1: a
 * migration that guesses the version it is migrating FROM is a migration that
 * rewrites records twice.
 */
export function readStoreVersion(harnessDirAbs: string): StoreVersion {
  const metaPath = path.join(harnessDirAbs, ".crewhaus", "meta.json");
  let raw: string;
  try {
    raw = readFileSync(metaPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: "unstamped" };
    return {
      state: "unknown",
      reason: `.crewhaus/meta.json could not be read (${code ?? "unknown error"})`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      state: "unknown",
      reason: `.crewhaus/meta.json is not valid JSON (${(err as Error).message})`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { state: "unknown", reason: ".crewhaus/meta.json is not a JSON object" };
  }
  const memories = (parsed as Record<string, unknown>)["memories"];
  if (memories === undefined) return { state: "unstamped" };
  if (typeof memories !== "object" || memories === null || Array.isArray(memories)) {
    return {
      state: "unknown",
      reason: '.crewhaus/meta.json has a "memories" field that is not an object',
    };
  }
  const version = (memories as Record<string, unknown>)["schemaVersion"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return {
      state: "unknown",
      reason: `.crewhaus/meta.json has memories.schemaVersion ${JSON.stringify(version)}, which is not a positive integer`,
    };
  }
  return { state: "known", memoriesSchemaVersion: version };
}

// ---------------------------------------------------------------------------
// what the copy does not carry
// ---------------------------------------------------------------------------

export type Uncovered = { readonly entry: string; readonly reason: string };

/**
 * Everything directly under `.crewhaus` that the export path does not copy.
 *
 * Returned so the result can name it. A caller who migrates a store and is
 * told only "42 sessions, 3 audit days" will believe the memories came too.
 */
export function uncoveredStateEntries(harnessDirAbs: string): Loaded<Uncovered[]> {
  const stateDir = path.join(harnessDirAbs, ".crewhaus");
  let names: string[];
  try {
    names = readdirSync(stateDir).sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: true, value: [] };
    return fail("unreadable", `.crewhaus could not be listed (${code ?? "unknown error"})`);
  }
  const covered = new Set<string>(COVERED_STORE_DIRS);
  return {
    ok: true,
    value: names
      .filter((n) => !covered.has(n))
      .map((n) => ({
        entry: `.crewhaus/${n}`,
        reason:
          "not part of the store export path (@crewhaus/harness-lifecycle carries .crewhaus/sessions and .crewhaus/audit only)",
      })),
  };
}

// ---------------------------------------------------------------------------
// destination
// ---------------------------------------------------------------------------

export type MigrationReceiptFile = {
  readonly rel: string;
  readonly bytes: number;
  readonly sha256: string;
};

export type MigrationReceipt = {
  readonly writtenAt: string;
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly storeVersion: StoreVersion;
  readonly since?: string;
  readonly sessions: ReadonlyArray<string>;
  readonly auditDays: ReadonlyArray<string>;
  readonly chainTailCopied: boolean;
  readonly files: ReadonlyArray<MigrationReceiptFile>;
  readonly verified: boolean;
};

export type DestinationState = {
  readonly exists: boolean;
  /** Files already present that a migration would write over. */
  readonly conflicts: ReadonlyArray<string>;
  readonly receipt?: MigrationReceipt;
  /** Set when a receipt is present but could not be trusted. */
  readonly receiptProblem?: string;
};

/**
 * What is already at the destination, and whether a previous migration put it
 * there. A receipt naming a DIFFERENT source is the case that matters: two
 * harnesses' stores merged into one directory cannot be told apart
 * afterwards, and the audit chains cannot both be valid.
 */
export function inspectDestination(
  destAbs: string,
  plannedRelPaths: ReadonlyArray<string>,
): Loaded<DestinationState> {
  let exists = true;
  try {
    if (!statSync(destAbs).isDirectory()) {
      return fail("not-a-directory", `"${renderPath(destAbs)}" exists and is not a directory`);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") exists = false;
    else
      return fail("unreadable", `the destination could not be read (${code ?? "unknown error"})`);
  }

  const conflicts: string[] = [];
  if (exists) {
    for (const rel of plannedRelPaths) {
      try {
        // lstat, not stat: the question is whether the NAME is taken, not
        // whether it leads anywhere. `stat` follows a symlink and reports a
        // DANGLING one as absent — so a link left at a destination path read
        // as "nothing here", `overwrite` was never asked for, and the copy
        // went through the link to whatever it pointed at.
        lstatSync(path.join(destAbs, ...rel.split("/")));
        conflicts.push(rel);
      } catch (err) {
        // ENOENT is the normal case: nothing is there. Anything else means
        // the entry could not be identified, which is not the same as absent
        // and still counts as "something is in the way".
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") conflicts.push(rel);
      }
    }
  }

  const receiptPath = path.join(destAbs, RECEIPT_FILENAME);
  let receiptRaw: string | undefined;
  try {
    receiptRaw = readFileSync(receiptPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return {
        ok: true,
        value: {
          exists,
          conflicts,
          receiptProblem: `a ${RECEIPT_FILENAME} is present but could not be read (${code ?? "unknown error"})`,
        },
      };
    }
  }
  if (receiptRaw === undefined) return { ok: true, value: { exists, conflicts } };
  try {
    const parsed = JSON.parse(receiptRaw) as MigrationReceipt;
    if (typeof parsed?.sourceRoot !== "string") {
      return {
        ok: true,
        value: {
          exists,
          conflicts,
          receiptProblem: `${RECEIPT_FILENAME} does not name a source root`,
        },
      };
    }
    return { ok: true, value: { exists, conflicts, receipt: parsed } };
  } catch (err) {
    return {
      ok: true,
      value: {
        exists,
        conflicts,
        receiptProblem: `${RECEIPT_FILENAME} is not valid JSON (${(err as Error).message})`,
      },
    };
  }
}

/** The destination-relative paths a migration of this selection would write. */
export function plannedPaths(opts: {
  readonly sessions: ReadonlyArray<string>;
  readonly auditDays: ReadonlyArray<string>;
  readonly chainTail: boolean;
  /** Session ids that have a sibling event log at the source. */
  readonly withEventLog: ReadonlySet<string>;
}): string[] {
  const rels: string[] = [];
  for (const id of opts.sessions) {
    rels.push(`sessions/${id}.json`);
    if (opts.withEventLog.has(id)) rels.push(`sessions/${id}.jsonl`);
  }
  for (const day of opts.auditDays) rels.push(`audit/${day}.jsonl`);
  if (opts.chainTail) rels.push("audit/_chain-tail.json");
  return rels;
}

/**
 * Every destination-relative path a REAL migration writes: the copies, plus
 * the export's own `manifest.json` and this tool's receipt.
 *
 * Distinct from {@link plannedPaths} on purpose. `plannedPaths` is the set
 * that is copied from a source and can therefore be hashed on both sides;
 * this is the set that is WRITTEN, which is what the conflict check and the
 * containment check have to be asked about. Reporting the first as the second
 * is how a destination file nobody copied gets destroyed quietly.
 */
export function writtenPaths(plannedRelPaths: ReadonlyArray<string>): string[] {
  return [...plannedRelPaths, EXPORT_MANIFEST_FILENAME, RECEIPT_FILENAME];
}

export function writeReceipt(destAbs: string, receipt: MigrationReceipt): Loaded<string> {
  const p = path.join(destAbs, RECEIPT_FILENAME);
  try {
    writeFileSync(p, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    return { ok: true, value: p };
  } catch (err) {
    return fail(
      "unreadable",
      `the migration receipt could not be written: ${(err as Error).message}`,
    );
  }
}
