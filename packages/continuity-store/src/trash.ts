/**
 * Trash-and-undo clearing (design §2.6): user-facing "clear" NEVER
 * hard-deletes. Files move to `.crewhaus/trash/<timestamp>/…` preserving their
 * path relative to the `.crewhaus` directory, so `restore(<timestamp>)` can
 * put every file back exactly where it came from. Trash purge is a janitor
 * concern (7-day window per the design), deliberately not implemented here.
 *
 * `moveToTrash` is exported as a reusable helper so other `.crewhaus` stores
 * (wiki-store, memory-store's clear verbs) can adopt the identical clearing
 * story later without re-deriving the layout.
 */
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { CrewhausError } from "@crewhaus/errors";

export class TrashError extends CrewhausError {
  override readonly name = "TrashError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export const TRASH_DIR_NAME = "trash";

/** `2026-07-13T19-04-12` (+ optional `-N` collision suffix) — filesystem-safe
 *  ISO seconds, matching the design's clearing transcript. */
const TRASH_TS_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d+)?$/;

export type MoveToTrashResult = {
  /** The snapshot directory everything moved into. */
  readonly trashDir: string;
  /** The snapshot timestamp — the `restore()` handle. */
  readonly ts: string;
  /** Paths that were moved, relative to the `.crewhaus` dir. */
  readonly moved: readonly string[];
};

export type TrashSnapshot = {
  readonly ts: string;
  /** Files inside the snapshot, relative to the `.crewhaus` dir. */
  readonly files: readonly string[];
};

export type RestoreResult = {
  readonly ts: string;
  /** Restored file paths, relative to the `.crewhaus` dir. */
  readonly restored: readonly string[];
};

function trashTimestamp(now: () => Date): string {
  return now().toISOString().slice(0, 19).replace(/:/g, "-");
}

function assertUnder(absPath: string, root: string, what: string): void {
  if (absPath !== root && !absPath.startsWith(`${root}/`)) {
    throw new TrashError(
      `${what} "${absPath}" is outside the .crewhaus dir "${root}" — refusing to trash it`,
    );
  }
}

async function walkFiles(dir: string, base: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw err;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(full, base)));
    } else {
      out.push(relative(base, full));
    }
  }
  return out;
}

/**
 * Move `paths` (files or whole directories) into a fresh trash snapshot under
 * `<crewhausDir>/trash/<ts>/`, preserving each path's location relative to
 * `crewhausDir`. Missing paths are skipped (clearing an empty store is a
 * no-op, not an error); paths outside `crewhausDir` — or inside the trash
 * itself — fail closed. The snapshot directory is only created when at least
 * one path actually moves.
 */
export async function moveToTrash(
  paths: readonly string[],
  crewhausDir: string,
  opts: { readonly now?: () => Date } = {},
): Promise<MoveToTrashResult> {
  const now = opts.now ?? (() => new Date());
  const root = resolve(crewhausDir);
  const trashRoot = join(root, TRASH_DIR_NAME);

  let ts = trashTimestamp(now);
  let trashDir = join(trashRoot, ts);
  for (let suffix = 2; existsSync(trashDir); suffix++) {
    ts = `${trashTimestamp(now)}-${suffix}`;
    trashDir = join(trashRoot, ts);
  }

  const moved: string[] = [];
  for (const path of paths) {
    const abs = resolve(path);
    assertUnder(abs, root, "path");
    if (abs === trashRoot || abs.startsWith(`${trashRoot}/`)) {
      throw new TrashError(`path "${abs}" is inside the trash — refusing to trash the trash`);
    }
    try {
      await lstat(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    const rel = relative(root, abs);
    const dest = join(trashDir, rel);
    await mkdir(dirname(dest), { recursive: true });
    await rename(abs, dest);
    moved.push(rel);
  }
  return { trashDir, ts, moved };
}

/** List every trash snapshot under `<crewhausDir>/trash/`, oldest first. */
export async function listTrash(crewhausDir: string): Promise<readonly TrashSnapshot[]> {
  const trashRoot = join(resolve(crewhausDir), TRASH_DIR_NAME);
  let entries: string[];
  try {
    entries = await readdir(trashRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const snapshots: TrashSnapshot[] = [];
  for (const entry of entries.filter((e) => TRASH_TS_REGEX.test(e)).sort()) {
    const snapshotDir = join(trashRoot, entry);
    snapshots.push({ ts: entry, files: await walkFiles(snapshotDir, snapshotDir) });
  }
  return snapshots;
}

/**
 * Move every file of snapshot `ts` back to its original location under
 * `crewhausDir`. Fail-closed: if ANY destination already exists the restore
 * throws before moving anything (a clear made after the snapshot must not be
 * silently clobbered). The emptied snapshot directory is removed afterwards.
 */
export async function restoreFromTrash(ts: string, crewhausDir: string): Promise<RestoreResult> {
  if (!TRASH_TS_REGEX.test(ts)) {
    throw new TrashError(`invalid trash timestamp "${ts}" — expected YYYY-MM-DDTHH-MM-SS`);
  }
  const root = resolve(crewhausDir);
  const trashRoot = join(root, TRASH_DIR_NAME);
  const trashDir = join(trashRoot, ts);
  if (!existsSync(trashDir)) {
    throw new TrashError(`no trash snapshot "${ts}" under ${trashRoot}`);
  }
  const files = await walkFiles(trashDir, trashDir);
  // Conflict pre-check before any move, so a failed restore changes nothing.
  for (const rel of files) {
    const dest = join(root, rel);
    if (existsSync(dest)) {
      throw new TrashError(
        `restore ${ts} would overwrite "${dest}" — move the current file aside first`,
      );
    }
  }
  const restored: string[] = [];
  for (const rel of files) {
    const dest = join(root, rel);
    await mkdir(dirname(dest), { recursive: true });
    await rename(join(trashDir, rel), dest);
    restored.push(rel);
  }
  await rm(trashDir, { recursive: true, force: true });
  return { ts, restored };
}
