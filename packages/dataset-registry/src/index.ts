/**
 * Section 29 — `dataset-registry`. Wraps §16 `eval-dataset` loaders with
 * versioning + split-aware metadata so prompt-optimizer can train on
 * `train` and evaluate on `dev` without ever leaking into `test`.
 *
 * Layout (file-backed):
 *   <root>/<name>/<version>.json
 *
 * Each dataset file carries:
 *   {
 *     name, version,
 *     splits: { train: Sample[], dev: Sample[], test?: Sample[], holdout?: Sample[] },
 *     sampleHashes: { <split>: string[] },
 *     createdAt
 *   }
 *
 * Split-leak guard: `get(name, version, "test")` throws unless the caller
 * passes `{ allowTestSplit: true }`, and `get(name, version, "holdout")`
 * unless it passes `{ allowHoldout: true }`. This is a deliberate friction
 * point — the test split must not be touched until a release tag, and the
 * holdout is read only by a promotion check or a holdout release.
 *
 * Held-out use ledger: every read of a `test` or `holdout` split through
 * `get` appends one line to `<root>/<name>/<version>.uses.jsonl` before the
 * first sample is yielded (see {@link recordHeldOutUse}), so a held-out
 * split is only hidden while every read of it is counted.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import type { Sample } from "@crewhaus/eval-dataset";

export class DatasetRegistryError extends CrewhausError {
  override readonly name = "DatasetRegistryError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/**
 * `holdout` is the promotion-only split: never on a bare ref, never read by
 * an optimizer or an agent tool, and read only by a change's promotion check
 * or `crewhaus datasets release --split holdout` (each read leaves a use
 * line, see {@link recordHeldOutUse}).
 */
export type DatasetSplit = "train" | "dev" | "test" | "holdout";

/** The two splits whose every read is counted in the use ledger. */
export type HeldOutSplit = "test" | "holdout";

/**
 * NEW-HUNT-9 — one sanctioned consumption of a version's held-out test split
 * (`crewhaus datasets release`). Appended onto the record AFTER the release
 * eval ran; the entry count is the version's "burn count" — a holdout is only
 * hidden while its peeks are counted.
 */
export type ReleaseEntry = {
  /** The released version (redundant with the record's own — kept so the
   *  entry is self-describing when it travels alone in reports). */
  readonly version: string;
  /** The eval run that consumed `#test` (run-history `runId`). */
  readonly runId: string;
  /** ISO-8601 timestamp of the release eval. */
  readonly ts: string;
  /** The release run's pass rate over the test split. */
  readonly passRate: number;
};

export type DatasetRecord = {
  readonly name: string;
  readonly version: string;
  readonly splits: {
    readonly train: ReadonlyArray<Sample>;
    readonly dev: ReadonlyArray<Sample>;
    readonly test?: ReadonlyArray<Sample>;
    /** The promotion-only split; absent on every record without one. */
    readonly holdout?: ReadonlyArray<Sample>;
  };
  readonly sampleHashes: {
    readonly [K in DatasetSplit]?: ReadonlyArray<string>;
  };
  readonly createdAt: string;
  /**
   * NEW-HUNT-9 — test-split release history (see {@link ReleaseEntry}).
   * Additive: absent on records written before the field existed and on
   * versions whose test split was never released.
   */
  readonly releases?: ReadonlyArray<ReleaseEntry>;
};

/** Why a held-out split was read. `bundle` is reserved for a `target: eval`
 *  bundle that names itself; a bundle's read is recorded `unattributed`. */
export type HeldOutPurpose =
  | "release"
  | "eval"
  | "canary"
  | "promotion"
  | "bundle"
  | "unattributed";

/** Which surface read a held-out split. */
export type HeldOutVia = "cli" | "home" | "bundle" | "library";

export const HELD_OUT_PURPOSES: ReadonlyArray<HeldOutPurpose> = [
  "release",
  "eval",
  "canary",
  "promotion",
  "bundle",
  "unattributed",
];

export const HELD_OUT_VIAS: ReadonlyArray<HeldOutVia> = ["cli", "home", "bundle", "library"];

/** What a reader says about one read of a held-out split. */
export type HeldOutUseInput = {
  readonly purpose: HeldOutPurpose;
  readonly via: HeldOutVia;
  /** The eval run that read it, when the reader knows it. */
  readonly runId?: string;
  /** The change record (`chg_…`) whose check read it. */
  readonly change?: string;
};

export type GetOptions = {
  /** Required when split === "test". */
  readonly allowTestSplit?: boolean;
  /** Required when split === "holdout". */
  readonly allowHoldout?: boolean;
  /** What the use line records for a `test` or `holdout` read. Absent: the
   *  read is recorded `unattributed`, via `library`. */
  readonly use?: HeldOutUseInput;
};

export type PutOptions = {
  /**
   * NEW-registry-1 — versions are immutable by convention: `put` onto an
   * EXISTING version throws unless this is explicitly true. Every CLI
   * promotion path auto-bumps (`nextVersion`), so nothing legitimate
   * overwrites; a library caller that truly means to replace a version says
   * so here.
   */
  readonly allowOverwrite?: boolean;
};

export interface DatasetRegistry {
  put(
    record: Omit<DatasetRecord, "sampleHashes" | "createdAt">,
    opts?: PutOptions,
  ): Promise<DatasetRecord>;
  get(name: string, version: string, split: DatasetSplit, opts?: GetOptions): AsyncIterable<Sample>;
  /** Read the full record (without split-leak guarding — caller already passed an allow flag).
   *  Inspection, not consumption: it records no use. */
  getRecord(name: string, version: string): Promise<DatasetRecord>;
  /**
   * Append one held-out use line for `name@version` (see
   * {@link recordHeldOutUse}). Optional: a registry that cannot record a use
   * leaves it out, and a caller that must record one refuses the read.
   */
  recordUse?(name: string, version: string, split: HeldOutSplit, use: HeldOutUseInput): void;
  list(name: string): Promise<ReadonlyArray<string>>;
  listDatasets(): Promise<ReadonlyArray<string>>;
}

const NAME_REGEX = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const VERSION_REGEX = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

function ensureSafe(name: string, regex: RegExp, kind: string): void {
  if (!regex.test(name)) {
    throw new DatasetRegistryError(`invalid ${kind} "${name}"`);
  }
}

/**
 * Throw the registry's own {@link DatasetRegistryError} unless `name` is a
 * dataset name its grammar accepts. For a caller that must check a name
 * BEFORE it resolves `<root>/<name>` on disk (a containment check), without
 * copying the grammar.
 */
export function assertDatasetName(name: string): void {
  ensureSafe(name, NAME_REGEX, "dataset name");
}

/** {@link assertDatasetName} for a version string. */
export function assertDatasetVersion(version: string): void {
  ensureSafe(version, VERSION_REGEX, "version");
}

const O_NOFOLLOW = (fsConstants as Record<string, number | undefined>)["O_NOFOLLOW"] ?? 0;

/**
 * Rewrite an existing record file in place, never through a symbolic link at
 * its name: `O_NOFOLLOW` fails with ELOOP there instead of writing wherever
 * the link points.
 */
function rewriteNoFollow(path: string, data: string, what: string): void {
  let fd: number;
  try {
    fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | O_NOFOLLOW,
      0o600,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") {
      throw new DatasetRegistryError(
        `${what} is a symbolic link — a record is written only to a regular file, never through a link`,
        err,
      );
    }
    throw err;
  }
  try {
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/**
 * Content hash of a single Sample — the per-sample provenance identity folded
 * into a record's `sampleHashes` (and, via `overallDatasetHash`, the run-index
 * datasetHash). Exported additively so callers that reconcile against stored
 * samples (e.g. the CLI `dataset refresh-goldens`) can line their hashes up
 * with what `put` recorded, instead of re-deriving a divergent sha.
 */
export function hashSample(s: Sample): string {
  return createHash("sha256").update(JSON.stringify(s)).digest("hex").slice(0, 16);
}

/** Canonical split order — every content digest visits splits in this order
 *  so neither caller array order nor record key order can change a hash. */
const SPLIT_ORDER: ReadonlyArray<DatasetSplit> = ["train", "dev", "test", "holdout"];

/**
 * One stable sha256 over the per-sample content hashes of the selected
 * splits. Split names are folded in as domain separators (train vs dev with
 * identical samples still hash apart) and splits are visited in canonical
 * order, so neither the caller's array order nor record key order can change
 * the digest. Feeds `RunIndexEntry.datasetHash` for registry-backed datasets —
 * the registry analogue of eval-report's `hashDatasetFile`.
 *
 * Lives here (rather than in the CLI, where it was born) because BOTH run
 * launchers need it: `crewhaus eval --dataset registry:<ref>` and the
 * standalone `target: eval` bundle, which resolves its dataset straight out
 * of this registry. One digest function → one dataset identity in the run
 * history, whichever surface launched the run.
 */
export function overallDatasetHash(
  record: DatasetRecord,
  splits: ReadonlyArray<DatasetSplit>,
): string {
  const wanted = new Set(splits);
  const h = createHash("sha256");
  // TOLERANT OF AN ABSENT `splits`, DELIBERATELY NOT OF ABSENT HASHES —
  // the two cases mean different things and must not be collapsed.
  //
  //   no `splits` at all  — a bare/pre-registry record. There are no samples,
  //                         so the empty digest IS its honest identity.
  //   `splits` but no `sampleHashes` — the record HAS samples and has lost
  //                         their hashes. Hashing it as if empty would let
  //                         two different datasets compare equal, and the
  //                         regression-union guard relies on this throw to
  //                         notice a corrupt suite record and fall back to
  //                         the materialized primary instead of silently
  //                         running a 0-sample eval.
  const recordSplits = record.splits ?? {};
  for (const s of SPLIT_ORDER) {
    if (!wanted.has(s) || recordSplits[s] === undefined) continue;
    h.update(`${s}:${(record.sampleHashes[s] ?? []).join(",")}\n`);
  }
  return h.digest("hex");
}

/**
 * NEW-registry-1 — one stored-vs-recomputed hash divergence found by
 * {@link verifySplitHashes}. `sampleId`/`actualHash` are absent when the
 * stored hash list is LONGER than the split (a hash with no sample);
 * `storedHash` is absent when the split outgrew the stored list.
 */
export type HashMismatch = {
  readonly split: DatasetSplit;
  /** Position in the split's sample array (or stored hash list). */
  readonly index: number;
  readonly sampleId?: string;
  readonly storedHash?: string;
  readonly actualHash?: string;
};

/**
 * Recompute every present split's per-sample content hashes and compare them
 * against what the record STORED at `put` time. The stored hashes are what
 * `overallDatasetHash` folds into the run-history datasetHash, so a mismatch
 * means the version's eval identity has silently diverged from its content
 * (hand-edited `<version>.json`, corruption) — the strict gate would compare
 * different data under the same lineage. Empty result = the record is intact.
 * Pure and offline; `crewhaus datasets verify` is the CLI face.
 */
export function verifySplitHashes(record: DatasetRecord): HashMismatch[] {
  const mismatches: HashMismatch[] = [];
  // `splits` and `sampleHashes` are REQUIRED by the type but optional in
  // reality: records are `JSON.parse`d off disk and cast, and the record this
  // function exists to catch — hand-written, hand-edited, pre-registry — is
  // exactly the one that may carry neither. Guarding only the inner index
  // turns "this file is missing its hashes" into a crash in every caller that
  // verifies a whole registry.
  const splits = record.splits ?? {};
  const sampleHashes = record.sampleHashes ?? {};
  for (const split of SPLIT_ORDER) {
    const samples = splits[split];
    if (samples === undefined) continue;
    const stored = sampleHashes[split] ?? [];
    const n = Math.max(samples.length, stored.length);
    for (let i = 0; i < n; i++) {
      const sample = samples[i];
      const storedHash = stored[i];
      const actualHash = sample === undefined ? undefined : hashSample(sample);
      if (storedHash === actualHash) continue;
      mismatches.push({
        split,
        index: i,
        ...(sample !== undefined ? { sampleId: sample.id } : {}),
        ...(storedHash !== undefined ? { storedHash } : {}),
        ...(actualHash !== undefined ? { actualHash } : {}),
      });
    }
  }
  return mismatches;
}

export type AppendReleaseEntryOptions = {
  /** The file-backed registry root (e.g. `.crewhaus/datasets`). */
  readonly rootDir: string;
  readonly name: string;
  readonly version: string;
  readonly entry: ReleaseEntry;
};

/**
 * NEW-HUNT-9 — append one test-split release entry onto an existing record's
 * `releases` history, in place. Deliberately NOT `put`: the record's samples,
 * hashes, and `createdAt` stay byte-identical (a release consumes the version,
 * it does not re-author it), so the version's content identity — and every
 * run-index entry keyed on it — is untouched. File-backed only, like the
 * layout this package documents; standalone (not an interface method) so the
 * `DatasetRegistry` contract stays additive, mirroring {@link latestVersion}.
 */
export function appendReleaseEntry(opts: AppendReleaseEntryOptions): DatasetRecord {
  ensureSafe(opts.name, NAME_REGEX, "dataset name");
  ensureSafe(opts.version, VERSION_REGEX, "version");
  const path = join(opts.rootDir, opts.name, `${opts.version}.json`);
  if (!existsSync(path)) {
    throw new DatasetRegistryError(`dataset "${opts.name}@${opts.version}" not found at ${path}`);
  }
  const record = JSON.parse(readFileSync(path, "utf8")) as DatasetRecord;
  const updated: DatasetRecord = {
    ...record,
    releases: [...(record.releases ?? []), opts.entry],
  };
  rewriteNoFollow(
    path,
    JSON.stringify(updated, null, 2),
    `the record for "${opts.name}@${opts.version}"`,
  );
  return updated;
}

// -------- the held-out use ledger --------

/** One line of `<version>.uses.jsonl`: content-free, under 4 KiB. */
export type HeldOutUse = {
  readonly v: 1;
  /** ISO-8601 time of the read. */
  readonly at: string;
  readonly split: HeldOutSplit;
  readonly purpose: HeldOutPurpose;
  readonly via: HeldOutVia;
  readonly runId?: string;
  readonly change?: string;
};

export type RecordHeldOutUseOptions = HeldOutUseInput & {
  /** The file-backed registry root (e.g. `.crewhaus/datasets`). */
  readonly rootDir: string;
  readonly name: string;
  readonly version: string;
  readonly split: HeldOutSplit;
  /** ISO-8601 time to record; default now. */
  readonly at?: string;
};

/** The longest use line {@link recordHeldOutUse} writes, newline included. */
export const HELD_OUT_USE_MAX_BYTES = 4096;

/** The use ledger beside a version: `<root>/<name>/<version>.uses.jsonl`. */
export function heldOutUsesPath(rootDir: string, name: string, version: string): string {
  ensureSafe(name, NAME_REGEX, "dataset name");
  ensureSafe(version, VERSION_REGEX, "version");
  return join(rootDir, name, `${version}.uses.jsonl`);
}

const O_NONBLOCK = (fsConstants as Record<string, number | undefined>)["O_NONBLOCK"] ?? 0;

function isHeldOutSplit(s: unknown): s is HeldOutSplit {
  return s === "test" || s === "holdout";
}

/**
 * Append one use line for a read of `name@version`'s `test` or `holdout`
 * split. One `O_APPEND` write of a line under {@link HELD_OUT_USE_MAX_BYTES},
 * so concurrent readers each leave their own whole line; created `0600`;
 * never written through a symbolic link or into anything but a regular file
 * at the leaf (refused with a {@link DatasetRegistryError}). The name and the
 * version are checked against the registry grammar before the path is built.
 * Standalone, like {@link appendReleaseEntry}: the record itself is untouched.
 */
export function recordHeldOutUse(opts: RecordHeldOutUseOptions): HeldOutUse {
  const path = heldOutUsesPath(opts.rootDir, opts.name, opts.version);
  if (!isHeldOutSplit(opts.split)) {
    throw new DatasetRegistryError(
      `a use line records a test or holdout read, not "${String(opts.split)}"`,
    );
  }
  if (!HELD_OUT_PURPOSES.includes(opts.purpose)) {
    throw new DatasetRegistryError(`unknown held-out use purpose "${String(opts.purpose)}"`);
  }
  if (!HELD_OUT_VIAS.includes(opts.via)) {
    throw new DatasetRegistryError(`unknown held-out use surface "${String(opts.via)}"`);
  }
  const use: HeldOutUse = {
    v: 1,
    at: opts.at ?? new Date().toISOString(),
    split: opts.split,
    purpose: opts.purpose,
    via: opts.via,
    ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
    ...(opts.change !== undefined ? { change: opts.change } : {}),
  };
  const line = `${JSON.stringify(use)}\n`;
  if (Buffer.byteLength(line, "utf8") > HELD_OUT_USE_MAX_BYTES) {
    throw new DatasetRegistryError(
      `a held-out use line for "${opts.name}@${opts.version}" must stay under ${HELD_OUT_USE_MAX_BYTES} bytes`,
    );
  }
  const what = `the use ledger for "${opts.name}@${opts.version}"`;
  // O_NOFOLLOW is 0 on Windows: look at the leaf first everywhere, and let
  // O_NOFOLLOW close the gap between the look and the open where it exists.
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (existing !== undefined && !existing.isFile()) {
    throw new DatasetRegistryError(
      `${what} is not a regular file — a use is written only to a regular file, never through a link`,
    );
  }
  let fd: number;
  try {
    fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | O_NOFOLLOW | O_NONBLOCK,
      0o600,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENXIO") {
      throw new DatasetRegistryError(
        `${what} is not a regular file — a use is written only to a regular file, never through a link`,
        err,
      );
    }
    throw new DatasetRegistryError(
      `could not record a held-out use in ${what}: ${(err as Error).message}`,
      err,
    );
  }
  try {
    if (!fstatSync(fd).isFile()) {
      throw new DatasetRegistryError(
        `${what} is not a regular file — a use is written only to a regular file, never through a link`,
      );
    }
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
  return use;
}

/** The most use lines {@link readHeldOutUses} reads. */
export const HELD_OUT_USES_READ_CAP = 10_000;

export type HeldOutUsesReport = {
  /** True when the version has a use ledger. */
  readonly present: boolean;
  /** Well-formed use lines, in file order (oldest first). */
  readonly uses: ReadonlyArray<HeldOutUse>;
  /** `releases[]` entries on the record that no test-split use line names
   *  by `runId`: each counts once as a release use of the test split. */
  readonly legacyReleases: ReadonlyArray<ReleaseEntry>;
  /** Lines that were not a well-formed use (a torn last line, a hand edit). */
  readonly skipped: number;
  /** True when the ledger holds more than {@link HELD_OUT_USES_READ_CAP} lines. */
  readonly truncated: boolean;
  /** Why the ledger could not be read, when it could not. */
  readonly note?: string;
};

function parseHeldOutUse(line: string): HeldOutUse | undefined {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (o["v"] !== 1 || typeof o["at"] !== "string" || !isHeldOutSplit(o["split"])) return undefined;
  if (!HELD_OUT_PURPOSES.includes(o["purpose"] as HeldOutPurpose)) return undefined;
  if (!HELD_OUT_VIAS.includes(o["via"] as HeldOutVia)) return undefined;
  if (o["runId"] !== undefined && typeof o["runId"] !== "string") return undefined;
  if (o["change"] !== undefined && typeof o["change"] !== "string") return undefined;
  return {
    v: 1,
    at: o["at"],
    split: o["split"],
    purpose: o["purpose"] as HeldOutPurpose,
    via: o["via"] as HeldOutVia,
    ...(typeof o["runId"] === "string" ? { runId: o["runId"] } : {}),
    ...(typeof o["change"] === "string" ? { change: o["change"] } : {}),
  };
}

/**
 * Read a version's use ledger. A read: no lock and no write, a torn or
 * foreign line is counted in `skipped` (never thrown), at most
 * {@link HELD_OUT_USES_READ_CAP} lines are read and more is reported as
 * `truncated`, and a ledger that is a link or not a regular file is reported
 * in `note`, never followed. The record's legacy `releases[]` entries are
 * returned when no test-split use line names their run.
 */
export function readHeldOutUses(rootDir: string, name: string, version: string): HeldOutUsesReport {
  const path = heldOutUsesPath(rootDir, name, version);
  const recordPath = join(rootDir, name, `${version}.json`);
  let releases: ReadonlyArray<ReleaseEntry> = [];
  try {
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as Partial<DatasetRecord>;
    if (Array.isArray(record.releases)) {
      releases = record.releases.filter(
        (r): r is ReleaseEntry =>
          r !== null && typeof r === "object" && typeof (r as ReleaseEntry).runId === "string",
      );
    }
  } catch {
    // An absent or torn record carries no legacy releases.
  }
  let text = "";
  let present = false;
  let note: string | undefined;
  let st: ReturnType<typeof lstatSync> | undefined;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      note = `the use ledger could not be read: ${(err as Error).message}`;
    }
  }
  if (st !== undefined) {
    present = true;
    if (!st.isFile()) {
      note = "the use ledger is not a regular file — not read";
    } else {
      try {
        const fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
        try {
          text = readFileSync(fd, "utf8");
        } finally {
          closeSync(fd);
        }
      } catch (err) {
        note = `the use ledger could not be read: ${(err as Error).message}`;
      }
    }
  }
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const truncated = lines.length > HELD_OUT_USES_READ_CAP;
  const uses: HeldOutUse[] = [];
  let skipped = 0;
  for (const line of lines.slice(0, HELD_OUT_USES_READ_CAP)) {
    if (line.trim() === "") continue;
    const use = parseHeldOutUse(line);
    if (use === undefined) skipped++;
    else uses.push(use);
  }
  const testRuns = new Set(
    uses.filter((u) => u.split === "test" && u.runId !== undefined).map((u) => u.runId),
  );
  const legacyReleases = releases.filter((r) => !testRuns.has(r.runId));
  return {
    present,
    uses,
    legacyReleases,
    skipped,
    truncated,
    ...(note !== undefined ? { note } : {}),
  };
}

/**
 * How many times a split was read for `purpose` (every purpose when absent).
 * Legacy `releases[]` entries count as test-split release uses.
 */
export function countHeldOutUses(
  report: HeldOutUsesReport,
  split: HeldOutSplit,
  purpose?: HeldOutPurpose,
): number {
  const lines = report.uses.filter(
    (u) => u.split === split && (purpose === undefined || u.purpose === purpose),
  ).length;
  const legacy =
    split === "test" && (purpose === undefined || purpose === "release")
      ? report.legacyReleases.length
      : 0;
  return lines + legacy;
}

export type FileBackedRegistryOptions = {
  /** Default: `.crewhaus/datasets`. */
  readonly rootDir: string;
};

export function createFileBackedRegistry(opts: FileBackedRegistryOptions): DatasetRegistry {
  const rootDir = opts.rootDir;

  function datasetDir(name: string): string {
    ensureSafe(name, NAME_REGEX, "dataset name");
    return join(rootDir, name);
  }
  function recordPath(name: string, version: string): string {
    ensureSafe(version, VERSION_REGEX, "version");
    return join(datasetDir(name), `${version}.json`);
  }

  return {
    async put(record, putOpts: PutOptions = {}): Promise<DatasetRecord> {
      ensureSafe(record.name, NAME_REGEX, "dataset name");
      ensureSafe(record.version, VERSION_REGEX, "version");
      const path = recordPath(record.name, record.version);
      // NEW-registry-1 — versions are immutable by convention. Every CLI
      // promotion path auto-bumps, so an existing file here means a caller
      // is about to silently rewrite history (and orphan every run-index
      // entry keyed on the old content) unless it explicitly opted in.
      if (existsSync(path) && putOpts.allowOverwrite !== true) {
        throw new DatasetRegistryError(
          `version "${record.version}" of dataset "${record.name}" already exists at ${path} — versions are immutable; write a new version (nextVersion) or pass allowOverwrite: true if you truly mean to replace it`,
        );
      }
      // B22 — the synthetic-never-gold invariant, enforced at the registry
      // boundary: a `metadata.source: synthetic` sample carrying an
      // expected_output would let generated data silently become the gold
      // standard. A human-verified gold belongs under
      // `source: synthetic_human_verified`.
      for (const split of SPLIT_ORDER) {
        for (const s of record.splits[split] ?? []) {
          if (s.metadata?.["source"] === "synthetic" && s.expected_output !== undefined) {
            throw new DatasetRegistryError(
              `sample "${s.id}" (${split}) is tagged metadata.source: synthetic but carries expected_output — synthetic samples never define the gold standard; set source to "synthetic_human_verified" if a human verified this gold`,
            );
          }
        }
      }
      const sampleHashes: { [K in DatasetSplit]?: string[] } = {
        train: record.splits.train.map(hashSample),
        dev: record.splits.dev.map(hashSample),
      };
      if (record.splits.test) {
        sampleHashes.test = record.splits.test.map(hashSample);
      }
      if (record.splits.holdout) {
        sampleHashes.holdout = record.splits.holdout.map(hashSample);
      }
      const full: DatasetRecord = {
        ...record,
        sampleHashes,
        createdAt: new Date().toISOString(),
      };
      mkdirSync(datasetDir(record.name), { recursive: true });
      const data = JSON.stringify(full, null, 2);
      if (putOpts.allowOverwrite === true) {
        rewriteNoFollow(path, data, `the record for "${record.name}@${record.version}"`);
        return full;
      }
      // A new version is created EXCLUSIVELY (O_CREAT|O_EXCL): anything
      // already at the name — a version written since the check above, or a
      // symbolic link planted there, dangling or not — fails the write instead
      // of being followed, which would create the link's target (0.7.1).
      try {
        writeFileSync(path, data, { mode: 0o600, flag: "wx" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          throw new DatasetRegistryError(
            `version "${record.version}" of dataset "${record.name}" already exists (something is already at its name) — versions are immutable; write a new version (nextVersion) or pass allowOverwrite: true if you truly mean to replace it`,
          );
        }
        throw err;
      }
      return full;
    },

    async *get(
      name: string,
      version: string,
      split: DatasetSplit,
      getOpts: GetOptions = {},
    ): AsyncIterable<Sample> {
      if (split === "test" && getOpts.allowTestSplit !== true) {
        throw new DatasetRegistryError(
          `test split locked for "${name}@${version}"; pass allowTestSplit: true to override (only do this at release-tag time)`,
        );
      }
      if (split === "holdout" && getOpts.allowHoldout !== true) {
        throw new DatasetRegistryError(
          `holdout split locked for "${name}@${version}"; pass allowHoldout: true to override (only a promotion check or a holdout release reads it)`,
        );
      }
      const p = recordPath(name, version);
      if (!existsSync(p)) {
        throw new DatasetRegistryError(`dataset "${name}@${version}" not found at ${p}`);
      }
      const record = JSON.parse(readFileSync(p, "utf8")) as DatasetRecord;
      const samples = record.splits[split];
      if (!samples) {
        throw new DatasetRegistryError(`split "${split}" not present in "${name}@${version}"`);
      }
      // Every held-out read is counted, before the first sample leaves.
      if (split === "test" || split === "holdout") {
        recordHeldOutUse({
          rootDir,
          name,
          version,
          split,
          ...(getOpts.use ?? { purpose: "unattributed", via: "library" }),
        });
      }
      for (const s of samples) yield s;
    },

    async getRecord(name, version): Promise<DatasetRecord> {
      const p = recordPath(name, version);
      if (!existsSync(p)) {
        throw new DatasetRegistryError(`dataset "${name}@${version}" not found at ${p}`);
      }
      return JSON.parse(readFileSync(p, "utf8")) as DatasetRecord;
    },

    recordUse(name, version, split, use): void {
      recordHeldOutUse({ rootDir, name, version, split, ...use });
    },

    async list(name): Promise<ReadonlyArray<string>> {
      const dir = datasetDir(name);
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5))
        .sort();
    },

    async listDatasets(): Promise<ReadonlyArray<string>> {
      if (!existsSync(rootDir)) return [];
      return readdirSync(rootDir).filter((d) => !d.startsWith(".") && !d.startsWith("_"));
    },
  };
}

/**
 * Natural-order version comparator: digit runs compare numerically, other
 * runs lexicographically — so `v2 < v10` and `1.0.2 < 1.0.10` (a plain string
 * sort gets both wrong). Digit runs compare by stripped length then digits,
 * never through `Number()`, so arbitrarily long versions can't lose precision.
 */
export function compareVersions(a: string, b: string): number {
  const at = a.match(/\d+|\D+/g) ?? [];
  const bt = b.match(/\d+|\D+/g) ?? [];
  const len = Math.min(at.length, bt.length);
  for (let i = 0; i < len; i++) {
    const x = at[i] as string;
    const y = bt[i] as string;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const xs = x.replace(/^0+(?=\d)/, "");
      const ys = y.replace(/^0+(?=\d)/, "");
      if (xs.length !== ys.length) return xs.length < ys.length ? -1 : 1;
      if (xs !== ys) return xs < ys ? -1 : 1;
    } else if (xNum !== yNum) {
      // A digit run sorts before a non-digit run ("v1" < "vfinal").
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  if (at.length !== bt.length) return at.length < bt.length ? -1 : 1;
  // Equal token streams — fall back to the raw strings (leading zeros).
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The newest version of `name` under {@link compareVersions} ordering, or
 * undefined when the dataset has no versions. Standalone (registry passed in)
 * rather than an interface method so it stays additive — it works with any
 * `DatasetRegistry` implementation, present or future.
 */
export async function latestVersion(
  registry: DatasetRegistry,
  name: string,
): Promise<string | undefined> {
  const versions = await registry.list(name);
  if (versions.length === 0) return undefined;
  return [...versions].sort(compareVersions)[versions.length - 1];
}
