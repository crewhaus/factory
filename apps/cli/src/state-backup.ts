/**
 * Item 69 — `crewhaus state backup|restore`: snapshot and transport the
 * cwd-local `.crewhaus/` state directory.
 *
 * A harness's entire accumulated state — sessions, feedback, memories,
 * datasets, spec registry, optimize runs, durable-state sqlite — lives in
 * `.crewhaus/` next to wherever the harness runs. That locality is a feature
 * (the standalone-harness convention) until the box dies, or until feedback
 * captured on a DEPLOYED bot needs to travel back to the dev machine before
 * `crewhaus distill` can learn from it. `backup` packs the dir into a
 * gzipped tarball with a manifest; `restore` unpacks it — full replace
 * (`--force`, existing state moved aside, never deleted) or additive merges
 * (`--merge feedback|all`).
 *
 * Like `feedback.ts` / `justification-gate.ts`, this module has NO
 * import-time side effects (the entry file `index.ts` runs a top-level argv
 * switch and so cannot be imported by a test without executing the CLI).
 * The exported functions do touch the filesystem and spawn the system `tar`
 * binary: Bun (1.3.x) ships gzip (`Bun.gzipSync`) but no tar API and the
 * repo takes no archive dependency, so the ubiquitous system `tar` (bsdtar
 * on macOS/Windows, GNU tar on Linux) does the packing/unpacking via
 * `Bun.spawn` argv arrays (no shell). Backup NEVER modifies a source file:
 * every archived file is staged as an exact byte copy — which is what makes
 * the round-trip byte-identical, so a hash-chained `.crewhaus/audit` dir
 * still passes `@crewhaus/audit-log`'s `verify()` after backup → restore.
 *
 * SQLITE SAFETY: a live `@crewhaus/durable-state` writer (WAL journaling)
 * can tear a naive byte copy — the main db file alone is missing whatever
 * sits in `-wal`. Any file carrying the SQLite magic header is therefore
 * snapshotted through `bun:sqlite`: open read-only, `db.serialize()` (the
 * sqlite serialize API — a consistent point-in-time image with WAL frames
 * folded in), and the snapshot bytes are archived in place of the raw file;
 * its `-wal`/`-shm`/`-journal` sidecars are dropped as folded. When a
 * snapshot fails (corrupt file, exclusive lock) the raw bytes are copied
 * instead and the manifest records `sqliteConsistent: false` so the
 * operator knows the copy may be torn.
 *
 * Deliberately OUT OF SCOPE: S3/R2 upload (sync the tarball with your own
 * tooling — `aws s3 cp`, rclone, …) and a scheduled-cron template (a
 * `templates/` convention is landing on another branch).
 */
import { Database } from "bun:sqlite";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type FeedbackRecord, extractFeedbackRecords, mergeFeedback } from "./feedback";

/** Manifest file name at the archive root (NOT restored into `.crewhaus`). */
export const MANIFEST_FILENAME = "backup-manifest.json";

/** First 16 bytes of every SQLite main database file: "SQLite format 3\\0"
 *  (spelled as code points so the source carries no literal NUL). */
const SQLITE_MAGIC_BYTES = new Uint8Array([
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
]);

/** Sidecar suffixes a live sqlite writer leaves next to the main db file. */
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

/** Thrown for every operational failure (missing dir, tar failure, bad
 *  archive). The CLI entry file catches it and routes the message through
 *  `die()`; tests assert on `.message` without the process exiting. The
 *  `name` stays a plain string so `StateRestoreRefusedError` can narrow it. */
export class StateBackupError extends Error {
  override readonly name: string = "StateBackupError";
}

/** Thrown when `restore` (without --force/--merge) would overwrite an
 *  existing non-empty `.crewhaus`. Carries a preformatted message listing
 *  what is there and how to proceed. */
export class StateRestoreRefusedError extends StateBackupError {
  override readonly name = "StateRestoreRefusedError";
  constructor(
    readonly stateDir: string,
    entries: ReadonlyArray<{ name: string; kind: "dir" | "file"; files: number }>,
  ) {
    const listing = entries
      .map((e) => (e.kind === "dir" ? `${e.name}/ (${e.files} file(s))` : e.name))
      .join(", ");
    super(
      [
        `refusing to overwrite existing non-empty ${stateDir}`,
        `  contains: ${listing}`,
        "  rerun with --force to replace it (the current dir is moved aside to " +
          ".crewhaus.bak-<ts>, never deleted), or --merge feedback|all to fold " +
          "the archive into it",
      ].join("\n"),
    );
  }
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export type SubdirStat = { files: number; bytes: number };

export type BackupManifest = {
  schemaVersion: 1;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** Absolute path of the `.crewhaus` dir that was archived. */
  sourceDir: string;
  /** CLI version that produced the backup. */
  crewhausVersion: string;
  totals: SubdirStat;
  /** Per-top-level-subdir file counts + byte sizes; "." = state-dir root files. */
  subdirs: Record<string, SubdirStat>;
  /** false when any sqlite file could not be snapshotted consistently and was
   *  byte-copied raw instead (a live writer may have torn the copy). */
  sqliteConsistent: boolean;
  sqlite: {
    /** rel paths archived as a consistent read-only `serialize()` snapshot. */
    snapshotted: string[];
    /** rel paths byte-copied raw because the snapshot failed. */
    copiedRaw: string[];
    /** `-wal`/`-shm`/`-journal` sidecars omitted because their main db was
     *  snapshotted (the snapshot folds WAL content in). */
    foldedSidecars: string[];
  };
};

/** One file as it lands in the archive (post-snapshot sizes). */
export type ArchivedFile = { relPath: string; bytes: number };

/** Pure manifest assembly from the archived file list + backup metadata. */
export function buildManifest(
  files: ReadonlyArray<ArchivedFile>,
  meta: {
    createdAt: string;
    sourceDir: string;
    crewhausVersion: string;
    sqliteConsistent: boolean;
    sqlite: BackupManifest["sqlite"];
  },
): BackupManifest {
  const subdirs: Record<string, SubdirStat> = {};
  let totalFiles = 0;
  let totalBytes = 0;
  for (const f of files) {
    const slash = f.relPath.indexOf("/");
    const top = slash === -1 ? "." : f.relPath.slice(0, slash);
    const stat = subdirs[top] ?? { files: 0, bytes: 0 };
    stat.files += 1;
    stat.bytes += f.bytes;
    subdirs[top] = stat;
    totalFiles += 1;
    totalBytes += f.bytes;
  }
  return {
    schemaVersion: 1,
    createdAt: meta.createdAt,
    sourceDir: meta.sourceDir,
    crewhausVersion: meta.crewhausVersion,
    totals: { files: totalFiles, bytes: totalBytes },
    subdirs,
    sqliteConsistent: meta.sqliteConsistent,
    sqlite: meta.sqlite,
  };
}

/** Narrow a parsed JSON value to a BackupManifest (tolerant structural check —
 *  a hand-made or future-versioned manifest should degrade to a warning, not
 *  a crash). */
export function isBackupManifest(value: unknown): value is BackupManifest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["schemaVersion"] === 1 &&
    typeof v["createdAt"] === "string" &&
    typeof v["sourceDir"] === "string" &&
    typeof v["crewhausVersion"] === "string" &&
    typeof v["totals"] === "object" &&
    v["totals"] !== null &&
    typeof v["subdirs"] === "object" &&
    v["subdirs"] !== null
  );
}

// ---------------------------------------------------------------------------
// Pure helpers — names, exclude globs, sqlite detection, merge planning
// ---------------------------------------------------------------------------

/** Collapse a harness name / dir basename to a filename-safe label. */
export function sanitizeBackupLabel(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "state" : cleaned;
}

/** Default tarball name: `crewhaus-state-<label>-<ISO date>.tar.gz`. */
export function defaultBackupFileName(label: string, now: Date): string {
  return `crewhaus-state-${sanitizeBackupLabel(label)}-${now.toISOString().slice(0, 10)}.tar.gz`;
}

/** Split a comma-separated `--exclude` value into trimmed non-empty globs. */
export function parseExcludeGlobs(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((g) => g.trim())
    .filter((g) => g !== "");
}

/**
 * Whether a state-dir-relative path (always "/"-separated) matches any
 * exclude glob. A glob is matched against the full relative path; a bare
 * pattern (no "/") additionally matches any single path segment, mirroring
 * tar's basename `--exclude` ergonomics — so `sessions` drops the whole
 * subdir and `*.sqlite` drops sqlite files anywhere in the tree.
 */
export function isExcluded(relPath: string, globs: ReadonlyArray<string>): boolean {
  for (const g of globs) {
    const glob = new Bun.Glob(g);
    if (glob.match(relPath)) return true;
    if (!g.includes("/") && relPath.split("/").some((segment) => glob.match(segment))) {
      return true;
    }
  }
  return false;
}

/** Whether `bytes` starts with the 16-byte SQLite main-db magic header. */
export function isSqliteHeader(bytes: Uint8Array): boolean {
  if (bytes.length < SQLITE_MAGIC_BYTES.length) return false;
  for (let i = 0; i < SQLITE_MAGIC_BYTES.length; i++) {
    if (bytes[i] !== SQLITE_MAGIC_BYTES[i]) return false;
  }
  return true;
}

/** For a `-wal`/`-shm`/`-journal` sidecar path, the main db path it belongs
 *  to; undefined for everything else. */
export function sqliteSidecarBase(relPath: string): string | undefined {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    if (relPath.endsWith(suffix)) return relPath.slice(0, -suffix.length);
  }
  return undefined;
}

export type AdditiveMergePlan = {
  /** Archive files absent locally — safe to copy in. */
  copy: string[];
  /** Archive files that already exist locally — skipped, never overwritten. */
  skip: string[];
};

/** Plan a `--merge all` additive copy: only files that don't exist locally
 *  are copied; existing local files always win. Pure via the injected
 *  existence predicate. */
export function planAdditiveMerge(
  archiveFiles: ReadonlyArray<string>,
  existsLocally: (relPath: string) => boolean,
): AdditiveMergePlan {
  const copy: string[] = [];
  const skip: string[] = [];
  for (const f of archiveFiles) {
    (existsLocally(f) ? skip : copy).push(f);
  }
  return { copy, skip };
}

export type FeedbackMergePlan = {
  /** Folded records to append to the local feedback store. */
  toImport: FeedbackRecord[];
  /** Archived (session, turn) keys with no local record at all. */
  added: number;
  /** Keys where folding the archive in changed the local fold. */
  updated: number;
  /** Archived keys already fully represented locally — deduped away. */
  unchanged: number;
};

function feedbackKey(r: FeedbackRecord): string {
  return `${r.sessionId}#${r.turnNumber}`;
}

/** Key-order-insensitive record identity, so a re-folded record that carries
 *  exactly the local information counts as unchanged. */
function canonicalRecord(r: FeedbackRecord): string {
  const rec = r as unknown as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(rec).sort()) sorted[k] = rec[k];
  return JSON.stringify(sorted);
}

/**
 * Plan a `--merge feedback` fold using the exact dedupe semantics `crewhaus
 * distill` applies: `mergeFeedback` collapses records to one per
 * (sessionId, turnNumber), newest field wins, and a later comment-only
 * record never erases an earlier rating. Local and archived records are
 * each folded first, then each archived fold is folded AGAINST the local
 * fold for its key — imported only when the archive actually contributes
 * something (new key, or a fold that differs from the local one). Running
 * the same merge twice is therefore a no-op.
 */
export function planFeedbackMerge(
  local: ReadonlyArray<FeedbackRecord>,
  archived: ReadonlyArray<FeedbackRecord>,
): FeedbackMergePlan {
  const localByKey = new Map<string, FeedbackRecord>();
  for (const r of mergeFeedback(local)) localByKey.set(feedbackKey(r), r);

  const toImport: FeedbackRecord[] = [];
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const a of mergeFeedback(archived)) {
    const l = localByKey.get(feedbackKey(a));
    if (l === undefined) {
      toImport.push(a);
      added += 1;
      continue;
    }
    const folded = mergeFeedback([l, a])[0] as FeedbackRecord;
    if (canonicalRecord(folded) === canonicalRecord(l)) {
      unchanged += 1;
    } else {
      toImport.push(folded);
      updated += 1;
    }
  }
  return { toImport, added, updated, unchanged };
}

// ---------------------------------------------------------------------------
// Filesystem walking + tar
// ---------------------------------------------------------------------------

type WalkResult = {
  /** Regular files, "/"-separated paths relative to the walk root, sorted. */
  files: string[];
  /** Directories (including empty ones), same convention. */
  dirs: string[];
  /** Symlinks encountered (skipped by backup — see createStateBackup). */
  symlinks: string[];
};

function walkFiles(root: string): WalkResult {
  const files: string[] = [];
  const dirs: string[] = [];
  const symlinks: string[] = [];
  const visit = (rel: string): void => {
    const abs = rel === "" ? root : join(root, rel);
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        symlinks.push(childRel);
      } else if (entry.isDirectory()) {
        dirs.push(childRel);
        visit(childRel);
      } else if (entry.isFile()) {
        files.push(childRel);
      }
    }
  };
  visit("");
  files.sort();
  dirs.sort();
  symlinks.sort();
  return { files, dirs, symlinks };
}

/** Run the system `tar` binary (argv array — no shell). Throws
 *  StateBackupError with tar's stderr on a non-zero exit. */
async function runTar(args: ReadonlyArray<string>): Promise<string> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["tar", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    const detail = (err as Error).message;
    throw new StateBackupError(
      `could not spawn the system \`tar\` binary (${detail}) — crewhaus state backup/restore needs tar on PATH`,
    );
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new StateBackupError(`tar ${args[0]} failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}

/** Read the first 16 bytes of a file and test the SQLite magic. */
function fileHasSqliteHeader(absPath: string): boolean {
  const buf = new Uint8Array(SQLITE_MAGIC_BYTES.length);
  let fd: number;
  try {
    fd = openSync(absPath, "r");
  } catch {
    return false;
  }
  try {
    const n = readSync(fd, buf, 0, buf.length, 0);
    return n === buf.length && isSqliteHeader(buf);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// backup
// ---------------------------------------------------------------------------

export type BackupOptions = {
  /** The `.crewhaus` directory to archive. */
  stateDir: string;
  /** Absolute output tarball path. */
  outFile: string;
  excludeGlobs?: ReadonlyArray<string>;
  /** Stamped into the manifest. */
  crewhausVersion: string;
  /** Test seam: clock. */
  now?: () => Date;
};

export type BackupResult = {
  manifest: BackupManifest;
  outFile: string;
  /** Files dropped by --exclude. */
  excluded: string[];
  /** Non-fatal warnings (skipped symlinks, raw-copied sqlite files). */
  warnings: string[];
};

/**
 * Archive `stateDir` to a gzipped tarball. Every regular file is staged as
 * an exact byte copy (sqlite files as a consistent read-only snapshot — see
 * the file header), a manifest is written at the archive root, and the
 * system `tar` packs the staging dir. Source files are never modified.
 */
export async function createStateBackup(opts: BackupOptions): Promise<BackupResult> {
  const stateDir = resolve(opts.stateDir);
  if (!existsSync(stateDir) || !statSync(stateDir).isDirectory()) {
    throw new StateBackupError(`no state directory at ${stateDir} — nothing to back up`);
  }
  const globs = opts.excludeGlobs ?? [];
  const warnings: string[] = [];
  const { files, dirs, symlinks } = walkFiles(stateDir);
  for (const s of symlinks) {
    warnings.push(`skipped symlink ${s} (backups archive regular files only)`);
  }

  const excluded: string[] = [];
  const kept: string[] = [];
  for (const f of files) {
    (isExcluded(f, globs) ? excluded : kept).push(f);
  }

  const outFile = resolve(opts.outFile);
  mkdirSync(dirname(outFile), { recursive: true });

  const staging = mkdtempSync(join(tmpdir(), "crewhaus-state-backup-"));
  try {
    // Preserve the directory shape (including empty dirs) so a restore
    // reproduces the layout, not just the files.
    for (const d of dirs) {
      if (!isExcluded(d, globs)) mkdirSync(join(staging, d), { recursive: true });
    }

    // SQLITE SAFETY — snapshot every magic-headed file via a read-only
    // serialize; fall back to a raw byte copy (recorded in the manifest)
    // when the snapshot fails.
    const snapshotted: string[] = [];
    const copiedRaw: string[] = [];
    const foldedSidecars = new Set<string>();
    let sqliteConsistent = true;
    const keptSet = new Set(kept);
    for (const rel of kept) {
      if (!fileHasSqliteHeader(join(stateDir, rel))) continue;
      try {
        const db = new Database(join(stateDir, rel), { readonly: true });
        let snapshot: Uint8Array;
        try {
          snapshot = db.serialize();
        } finally {
          db.close();
        }
        mkdirSync(dirname(join(staging, rel)), { recursive: true });
        writeFileSync(join(staging, rel), snapshot);
        snapshotted.push(rel);
        // The snapshot folds WAL frames in; archiving the sidecars alongside
        // it would restore a db whose WAL disagrees with its main file.
        for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
          const sidecar = `${rel}${suffix}`;
          if (keptSet.has(sidecar)) foldedSidecars.add(sidecar);
        }
      } catch (err) {
        sqliteConsistent = false;
        copiedRaw.push(rel);
        const detail = (err as Error).message;
        warnings.push(
          `could not snapshot sqlite file ${rel} (${detail}) — copied raw bytes instead; the copy may be inconsistent if a writer was active (manifest records sqliteConsistent: false)`,
        );
      }
    }

    const snapshottedSet = new Set(snapshotted);
    const archived: ArchivedFile[] = [];
    for (const rel of kept) {
      if (foldedSidecars.has(rel)) continue;
      const dst = join(staging, rel);
      if (!snapshottedSet.has(rel)) {
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(join(stateDir, rel), dst);
      }
      archived.push({ relPath: rel, bytes: statSync(dst).size });
    }

    const manifest = buildManifest(archived, {
      createdAt: (opts.now?.() ?? new Date()).toISOString(),
      sourceDir: stateDir,
      crewhausVersion: opts.crewhausVersion,
      sqliteConsistent,
      sqlite: {
        snapshotted,
        copiedRaw,
        foldedSidecars: [...foldedSidecars].sort(),
      },
    });
    writeFileSync(join(staging, MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`);

    await runTar(["-czf", outFile, "-C", staging, "."]);
    return { manifest, outFile, excluded, warnings };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

export type StateDirEntry = { name: string; kind: "dir" | "file"; files: number };

export type StateDirInspection =
  | { state: "absent" }
  | { state: "empty" }
  | { state: "occupied"; entries: StateDirEntry[] };

/** What (if anything) currently occupies the target `.crewhaus` dir. */
export function inspectStateDir(stateDir: string): StateDirInspection {
  if (!existsSync(stateDir)) return { state: "absent" };
  const top = readdirSync(stateDir, { withFileTypes: true });
  if (top.length === 0) return { state: "empty" };
  const entries: StateDirEntry[] = top
    .map((e): StateDirEntry => {
      if (!e.isDirectory()) return { name: e.name, kind: "file", files: 1 };
      return { name: e.name, kind: "dir", files: walkFiles(join(stateDir, e.name)).files.length };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { state: "occupied", entries };
}

function assertArchiveExists(archiveFile: string): void {
  if (!existsSync(archiveFile)) {
    throw new StateBackupError(`archive not found at ${archiveFile}`);
  }
}

/** Extract `archiveFile` into a fresh temp dir under `parentDir` and return
 *  the temp path (caller cleans up). */
async function extractToTemp(archiveFile: string, parentDir: string): Promise<string> {
  mkdirSync(parentDir, { recursive: true });
  const temp = mkdtempSync(join(parentDir, ".crewhaus.extract-"));
  try {
    await runTar(["-xzf", archiveFile, "-C", temp]);
  } catch (err) {
    rmSync(temp, { recursive: true, force: true });
    throw err;
  }
  return temp;
}

function readExtractedManifest(
  extractedDir: string,
  warnings: string[],
): BackupManifest | undefined {
  const p = join(extractedDir, MANIFEST_FILENAME);
  if (!existsSync(p)) {
    warnings.push(
      `archive carries no ${MANIFEST_FILENAME} — not created by \`crewhaus state backup\`?`,
    );
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, "utf-8"));
    if (isBackupManifest(parsed)) return parsed;
    warnings.push(`archive's ${MANIFEST_FILENAME} has an unrecognized shape — ignored`);
  } catch {
    warnings.push(`archive's ${MANIFEST_FILENAME} is not valid JSON — ignored`);
  }
  return undefined;
}

/** Collision-safe `.crewhaus.bak-<ts>` sibling path. */
function bakPath(stateDir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let candidate = `${stateDir}.bak-${stamp}`;
  let n = 2;
  while (existsSync(candidate)) {
    candidate = `${stateDir}.bak-${stamp}-${n}`;
    n += 1;
  }
  return candidate;
}

export type RestoreOptions = {
  archiveFile: string;
  /** Directory that receives the `.crewhaus` dir (default: cwd — resolved by
   *  the caller). */
  intoDir: string;
  /** Full replace: move an existing non-empty `.crewhaus` aside to
   *  `.crewhaus.bak-<ts>` (never deleted) before restoring. */
  force: boolean;
};

export type RestoreResult = {
  stateDir: string;
  /** Where the pre-existing state dir went (only set when one was moved). */
  movedAsideTo?: string;
  manifest?: BackupManifest;
  filesRestored: number;
  warnings: string[];
};

/**
 * Full restore of a backup into `<intoDir>/.crewhaus`. Refuses (throws
 * `StateRestoreRefusedError`) when the target is non-empty and `force` is
 * not set. Extraction happens in a sibling temp dir which is renamed into
 * place, so a half-extracted archive can never corrupt existing state, and
 * restored file bytes are exactly the archived bytes (tar preserves them;
 * nothing is rewritten).
 */
export async function restoreStateArchive(opts: RestoreOptions): Promise<RestoreResult> {
  const archiveFile = resolve(opts.archiveFile);
  assertArchiveExists(archiveFile);
  const stateDir = join(resolve(opts.intoDir), ".crewhaus");
  const inspection = inspectStateDir(stateDir);
  if (inspection.state === "occupied" && !opts.force) {
    throw new StateRestoreRefusedError(stateDir, inspection.entries);
  }

  const warnings: string[] = [];
  // Sibling temp dir (same filesystem as the target) so the final move is a
  // plain rename.
  const temp = await extractToTemp(archiveFile, dirname(stateDir));
  try {
    const manifest = readExtractedManifest(temp, warnings);
    // The manifest describes the backup; it is not state. Drop our extracted
    // copy so the restored `.crewhaus` contains exactly the archived state
    // (provenance stays inside the tarball).
    rmSync(join(temp, MANIFEST_FILENAME), { force: true });

    let movedAsideTo: string | undefined;
    if (inspection.state === "empty") {
      rmdirSync(stateDir); // empty — nothing to preserve
    } else if (inspection.state === "occupied") {
      movedAsideTo = bakPath(stateDir);
      renameSync(stateDir, movedAsideTo);
    }
    renameSync(temp, stateDir);

    return {
      stateDir,
      ...(movedAsideTo !== undefined ? { movedAsideTo } : {}),
      ...(manifest !== undefined ? { manifest } : {}),
      filesRestored: walkFiles(stateDir).files.length,
      warnings,
    };
  } finally {
    // No-op after the successful rename; cleans up on any earlier failure.
    rmSync(temp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// --merge feedback | --merge all
// ---------------------------------------------------------------------------

/** Parse a JSONL blob into objects, skipping blank/malformed lines (mirrors
 *  the entry file's tolerant reader — one corrupt line must not abort a
 *  merge). */
function parseJsonlObjects(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // tolerated
    }
  }
  return out;
}

/**
 * Every FeedbackRecord a state dir carries, read exactly the way `crewhaus
 * distill` reads them: `user_feedback` event-log lines in
 * `sessions/*.jsonl` PLUS bare records in `feedback/*.jsonl` (the web-UI
 * host sink). `extractFeedbackRecords` accepts both encodings and validates
 * each record.
 */
function collectFeedbackRecords(stateDir: string): FeedbackRecord[] {
  const objects: unknown[] = [];
  for (const sub of ["sessions", "feedback"]) {
    const dir = join(stateDir, sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      objects.push(...parseJsonlObjects(readFileSync(join(dir, f), "utf-8")));
    }
  }
  return extractFeedbackRecords(objects);
}

export type MergeFeedbackOptions = {
  archiveFile: string;
  intoDir: string;
  /** Test seam: clock (names the imported jsonl file). */
  now?: () => Date;
};

export type MergeFeedbackResult = FeedbackMergePlan & {
  /** Distinct feedback records found in the archive (pre-fold). */
  archivedRecords: number;
  /** The `feedback/*.jsonl` file the imports were appended to (unset when
   *  the archive contributed nothing new). */
  wroteFile?: string;
};

/**
 * `--merge feedback`: fold ONLY the archive's feedback records into the
 * local store. Imported folds land as bare records in a new
 * `feedback/restored-<ts>.jsonl` — the exact sink `crewhaus distill`
 * already reads — so local session transcripts are never rewritten and the
 * next distill sees local + imported records merged by `mergeFeedback`.
 */
export async function mergeFeedbackFromArchive(
  opts: MergeFeedbackOptions,
): Promise<MergeFeedbackResult> {
  const archiveFile = resolve(opts.archiveFile);
  assertArchiveExists(archiveFile);
  const stateDir = join(resolve(opts.intoDir), ".crewhaus");

  const temp = await extractToTemp(archiveFile, tmpdir());
  try {
    const archived = collectFeedbackRecords(temp);
    if (archived.length === 0) {
      throw new StateBackupError(
        "archive carries no feedback records — nothing to merge " +
          "(looked at sessions/*.jsonl user_feedback events and feedback/*.jsonl)",
      );
    }
    const plan = planFeedbackMerge(collectFeedbackRecords(stateDir), archived);

    let wroteFile: string | undefined;
    if (plan.toImport.length > 0) {
      const feedbackDir = join(stateDir, "feedback");
      mkdirSync(feedbackDir, { recursive: true });
      const stamp = (opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
      wroteFile = join(feedbackDir, `restored-${stamp}.jsonl`);
      let n = 2;
      while (existsSync(wroteFile)) {
        wroteFile = join(feedbackDir, `restored-${stamp}-${n}.jsonl`);
        n += 1;
      }
      writeFileSync(wroteFile, `${plan.toImport.map((r) => JSON.stringify(r)).join("\n")}\n`, {
        mode: 0o600,
      });
    }
    return {
      ...plan,
      archivedRecords: archived.length,
      ...(wroteFile !== undefined ? { wroteFile } : {}),
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export type MergeAllOptions = { archiveFile: string; intoDir: string };

export type MergeAllResult = {
  stateDir: string;
  /** Archive files copied in (absent locally). */
  copied: string[];
  /** Archive files skipped (already exist locally — local always wins). */
  skipped: string[];
};

/**
 * `--merge all`: per-subdir additive copy. Only archive files that do NOT
 * exist locally are written; an existing local file is never overwritten
 * (the skips are reported). The archive manifest is metadata, not state,
 * and is never copied.
 */
export async function mergeAllFromArchive(opts: MergeAllOptions): Promise<MergeAllResult> {
  const archiveFile = resolve(opts.archiveFile);
  assertArchiveExists(archiveFile);
  const stateDir = join(resolve(opts.intoDir), ".crewhaus");

  const temp = await extractToTemp(archiveFile, tmpdir());
  try {
    const archiveFiles = walkFiles(temp).files.filter((f) => f !== MANIFEST_FILENAME);
    const plan = planAdditiveMerge(archiveFiles, (rel) => existsSync(join(stateDir, rel)));
    for (const rel of plan.copy) {
      const dst = join(stateDir, rel);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(join(temp, rel), dst);
    }
    return { stateDir, copied: plan.copy, skipped: plan.skip };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
