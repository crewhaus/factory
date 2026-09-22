/**
 * Moving a path into the OS trash, and refusing to do anything else.
 *
 * THE POINT OF THIS FILE IS THE MOVE. A trash that deletes is worse than no
 * trash at all, because the caller chose it believing the file could come
 * back. So the only operations here are `mkdir`, an exclusive create of a
 * `.trashinfo` record, and `rename`. There is no `unlink` and no `rm` on any
 * path a caller named — the single `unlinkSync` in this package removes a
 * `.trashinfo` file THIS call just created when the move that follows it
 * failed, it is fenced behind `removeClaimedInfoFile`'s assertions, and a
 * test asserts that it is the only one.
 *
 * THE SAME-FILESYSTEM RULE IS NOT OPTIONAL. `rename` cannot cross a
 * filesystem, and the specification's answer is not "copy instead" — it is a
 * second trash directory at the top of the other filesystem. A copy would
 * break hard links, change the inode, double the disk usage of a large tree
 * and, if it failed halfway, leave a half-written copy next to an original
 * that a caller has been told is in the trash. So: the device is compared
 * before anything moves, a top-directory trash is used when it can be
 * validated, and when it cannot the call is REFUSED with the reason. The
 * reference implementation does the same thing — `gio trash` on a second
 * filesystem refuses (recorded in `../fixtures.ts`).
 *
 * Everything here is planned first and applied second. The plan is what
 * `dryRun` reports, and `apply` walks the same plan, so a preview cannot
 * describe one thing while the real call does another.
 */
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { type PathFacts, hostIdentity, now, probePath } from "../host";
import {
  candidateNames,
  checkTopdirTrash,
  formatDeletionDate,
  homeTrashDir,
  infoPathFor,
  renderTrashInfo,
  sharedTopdirTrash,
  userTopdirTrash,
} from "./trashspec";

export type TrashEntryKind = "file" | "directory" | "symlink";

export type PlannedEntry = {
  readonly given: string;
  readonly abs: string;
  readonly rel: string;
  readonly status: "ready" | "refused";
  readonly reason?: string;
  readonly kind?: TrashEntryKind;
  readonly sizeBytes?: number;
  /** The trash directory chosen for this entry. */
  readonly trashDir?: string;
  /** Set when the entry goes to a top-directory trash rather than the home one. */
  readonly topdir?: string;
  /** The name it would take inside `files/`; a prediction until the claim succeeds. */
  readonly storedName?: string;
  readonly filesPath?: string;
  readonly infoPath?: string;
  readonly infoBytes?: string;
};

export type TrashPlan = {
  readonly entries: readonly PlannedEntry[];
  /** A refusal that applies to the whole call, e.g. an unsupported platform. */
  readonly refusal?: string;
};

export type AppliedEntry = PlannedEntry & {
  readonly trashed: boolean;
  /** The name actually taken, which can differ from the prediction under a race. */
  readonly storedAs?: string;
};

export type PlanInput = {
  /** Already contained by `../paths.ts`: `abs` is the link itself, `rel` is for display. */
  readonly given: string;
  readonly abs: string;
  readonly rel: string;
};

/**
 * Where a path's trash lives, or why it has none.
 *
 * The order is the specification's: the home trash when the file is on the
 * same filesystem, then `$topdir/.Trash/$uid` if that directory passes the
 * sticky-bit and symlink checks, then `$topdir/.Trash-$uid`.
 */
export type TrashLocation =
  | { readonly ok: true; readonly trashDir: string; readonly topdir?: string }
  | { readonly ok: false; readonly reason: string };

export function resolveTrashLocation(
  targetAbs: string,
  identity: { home: string | undefined; xdgDataHome: string | undefined; uid: number | undefined },
): TrashLocation {
  const home = homeTrashDir(identity);
  if (home === undefined) {
    return {
      ok: false,
      reason: "neither $XDG_DATA_HOME nor $HOME is set, so there is no home trash to move it to",
    };
  }
  const targetDevice = deviceOf(path.dirname(targetAbs));
  if (targetDevice === undefined) {
    return { ok: false, reason: "the directory it lives in could not be read" };
  }
  const homeDevice = deviceOf(home);
  if (homeDevice !== undefined && homeDevice === targetDevice) {
    return { ok: true, trashDir: home };
  }

  // Different filesystem: the spec's top-directory trash, or nothing.
  if (identity.uid === undefined) {
    return {
      ok: false,
      reason:
        "it is on a different filesystem from the home trash, and this platform has no uid to name a top-directory trash with",
    };
  }
  const topdir = findTopdir(path.dirname(targetAbs), targetDevice);
  if (topdir === undefined) {
    return {
      ok: false,
      reason:
        "it is on a different filesystem from the home trash and its mount point was not found",
    };
  }
  const shared = sharedTopdirTrash(topdir, identity.uid);
  const sharedParent = path.dirname(shared);
  const parentFacts = probePath(sharedParent);
  const check = checkTopdirTrash({
    exists: parentFacts?.exists ?? false,
    isDirectory: parentFacts?.isDirectory ?? false,
    isSymlink: parentFacts?.isSymlink ?? false,
    mode: parentFacts?.mode ?? 0,
  });
  if (check.usable) return { ok: true, trashDir: shared, topdir };

  // `$topdir/.Trash-$uid` may be created by this call, but only if the top
  // directory is writable — which is discovered by trying, not guessed at.
  const fallback = userTopdirTrash(topdir, identity.uid);
  const fallbackFacts = probePath(fallback);
  if (fallbackFacts?.isSymlink === true) {
    return {
      ok: false,
      reason: `${fallback} is a symbolic link, and a trash directory that is a link could point anywhere`,
    };
  }
  return { ok: true, trashDir: fallback, topdir };
}

/** The device a path is on, falling back to its nearest existing ancestor. */
function deviceOf(target: string): number | undefined {
  let probe = target;
  for (let hops = 0; hops < 64; hops += 1) {
    const facts = probePath(probe);
    if (facts !== undefined) return facts.device;
    const parent = path.dirname(probe);
    if (parent === probe) return undefined;
    probe = parent;
  }
  return undefined;
}

/**
 * Walk up until the device number changes: the last path still on `device`
 * is the mount point, which is what the spec calls the top directory.
 */
export function findTopdir(start: string, device: number): string | undefined {
  let current = start;
  for (let hops = 0; hops < 256; hops += 1) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    const facts = probePath(parent);
    if (facts === undefined || facts.device !== device) return current;
    current = parent;
  }
  return current;
}

/**
 * The move itself, behind a seam.
 *
 * Not for convenience: the EXDEV branch below cannot be reached on a machine
 * with one filesystem, and it is the branch that decides whether a failed
 * cross-device move leaves a deleted file or an intact one. A test injects a
 * renamer that raises EXDEV; everything else — including every test that
 * actually moves a file — uses the real `rename`.
 */
export type Renamer = (from: string, to: string) => void;

let renamerOverride: Renamer | undefined;

export function _setRenamer(renamer: Renamer | undefined): void {
  renamerOverride = renamer;
}

function rename(from: string, to: string): void {
  if (renamerOverride !== undefined) {
    renamerOverride(from, to);
    return;
  }
  renameSync(from, to);
}

export type PlanOptions = {
  /** Where the workspace root is, so the root itself cannot be trashed. */
  readonly workspaceRoot: string;
};

/**
 * Turn resolved inputs into a plan, refusing every case it cannot do
 * correctly.
 *
 * Ambiguity is refused rather than resolved: two spellings of the same path,
 * or a path nested inside another path in the same call, would each "succeed"
 * while one of them silently did nothing, and a caller reading `trashed: 2`
 * would believe two things moved.
 */
export function planTrash(inputs: readonly PlanInput[], options: PlanOptions): TrashPlan {
  const identity = hostIdentity();
  const entries: PlannedEntry[] = [];
  const seen = new Map<string, string>();
  /**
   * Info-file paths already promised to an earlier entry in THIS plan.
   *
   * The real call claims names one at a time with `O_EXCL`, so two files
   * called `notes.txt` from different directories become `notes.txt` and
   * `notes.2.txt`. A prediction that asked only the filesystem — which holds
   * neither of them yet — promised BOTH of them `files/notes.txt`, so the dry
   * run described a destination the real call does not use and implied an
   * overwrite that never happens. A preview that can drift from the real call
   * is the one thing `dryRun` may not be.
   */
  const claimedInPlan = new Set<string>();
  const deletionDate = formatDeletionDate(now(), new Date(now()).getTimezoneOffset());

  for (const input of inputs) {
    const duplicate = seen.get(input.abs);
    if (duplicate !== undefined) {
      entries.push({
        ...input,
        status: "refused",
        reason: `the same path is listed twice ("${duplicate}" and "${input.given}") — refusing rather than reporting one move as two`,
      });
      continue;
    }
    seen.set(input.abs, input.given);

    const nested = inputs.find(
      (other) => other !== input && isUnder(input.abs, other.abs) && other.abs !== input.abs,
    );
    if (nested !== undefined) {
      entries.push({
        ...input,
        status: "refused",
        reason: `it is inside "${nested.given}", which this same call also trashes — refusing rather than guessing which move the caller meant`,
      });
      continue;
    }

    if (input.abs === options.workspaceRoot) {
      entries.push({ ...input, status: "refused", reason: "it is the workspace root" });
      continue;
    }

    const facts = probePath(input.abs);
    if (facts === undefined) {
      entries.push({ ...input, status: "refused", reason: "no such path" });
      continue;
    }

    const parentFacts = probePath(path.dirname(input.abs));
    if (parentFacts !== undefined && parentFacts.device !== facts.device && !facts.isSymlink) {
      // A mount point cannot be renamed anywhere, and trashing one would mean
      // trashing whatever is mounted there rather than the directory named.
      entries.push({ ...input, status: "refused", reason: "it is a mount point" });
      continue;
    }

    const location = resolveTrashLocation(input.abs, identity);
    if (!location.ok) {
      entries.push({ ...input, status: "refused", reason: location.reason });
      continue;
    }

    if (isUnder(input.abs, location.trashDir)) {
      entries.push({
        ...input,
        status: "refused",
        reason: "it is already inside the trash",
      });
      continue;
    }

    if (isUnder(location.trashDir, input.abs)) {
      // Trashing a directory that CONTAINS the trash would try to move a
      // directory into itself. `rename` refuses with EINVAL, but by then the
      // trash directories have been created inside the doomed tree; refusing
      // here says what is wrong instead of reporting an errno.
      entries.push({
        ...input,
        status: "refused",
        reason: `it contains the trash directory (${location.trashDir}), so moving it into the trash would move it into itself`,
      });
      continue;
    }

    const basename = path.basename(input.abs);
    const predicted = predictName(location.trashDir, basename, claimedInPlan);
    if (predicted === undefined) {
      entries.push({
        ...input,
        status: "refused",
        reason: "the trash already holds too many files with this name",
      });
      continue;
    }

    claimedInPlan.add(path.join(location.trashDir, "info", `${predicted}.trashinfo`));
    entries.push({
      ...input,
      status: "ready",
      kind: facts.isSymlink ? "symlink" : facts.isDirectory ? "directory" : "file",
      sizeBytes: facts.sizeBytes,
      trashDir: location.trashDir,
      ...(location.topdir !== undefined ? { topdir: location.topdir } : {}),
      storedName: predicted,
      filesPath: path.join(location.trashDir, "files", predicted),
      infoPath: path.join(location.trashDir, "info", `${predicted}.trashinfo`),
      infoBytes: renderTrashInfo({
        originalPath: infoPathFor(input.abs, location.topdir),
        deletionDate,
      }),
    });
  }

  return { entries };
}

/**
 * The first candidate name whose info file does not already exist AND has not
 * already been promised to an earlier entry in the same plan.
 *
 * `claimedInPlan` is the half the filesystem cannot answer: the earlier entry
 * has not been applied yet, so nothing is on disk to collide with, and without
 * it the prediction for the second of two same-named files is wrong.
 */
function predictName(
  trashDir: string,
  basename: string,
  claimedInPlan: ReadonlySet<string>,
): string | undefined {
  for (const candidate of candidateNames(basename)) {
    const info = path.join(trashDir, "info", `${candidate}.trashinfo`);
    const files = path.join(trashDir, "files", candidate);
    if (claimedInPlan.has(info)) continue;
    if (probePath(info) === undefined && probePath(files) === undefined) return candidate;
  }
  return undefined;
}

function isUnder(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

/**
 * Carry out one planned entry.
 *
 * The order is the specification's, and it is the order that makes a crash
 * survivable: claim the name by creating the info file with `O_EXCL` FIRST,
 * then move the file. A crash between the two leaves an info file with no
 * file — which every desktop trash treats as a stale entry — whereas the
 * other order leaves a file in the trash that nothing can restore, because
 * nothing records where it came from.
 */
export function applyEntry(entry: PlannedEntry): AppliedEntry {
  if (entry.status !== "ready") return { ...entry, trashed: false };
  const trashDir = entry.trashDir as string;
  const infoDir = path.join(trashDir, "info");
  const filesDir = path.join(trashDir, "files");
  try {
    // 0700 is the spec's mode: a trash is private, and a world-readable one
    // leaks the names of everything a user ever deleted.
    mkdirSync(infoDir, { recursive: true, mode: 0o700 });
    mkdirSync(filesDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return { ...entry, status: "refused", trashed: false, reason: describe(err) };
  }

  const basename = path.basename(entry.abs);
  let claimedInfo: string | undefined;
  let claimedName: string | undefined;
  for (const candidate of candidateNames(basename)) {
    const infoPath = path.join(infoDir, `${candidate}.trashinfo`);
    try {
      // `wx` is O_CREAT|O_EXCL: the claim is atomic, so two processes
      // trashing the same name cannot both win and overwrite one another.
      writeFileSync(infoPath, entry.infoBytes as string, { flag: "wx", mode: 0o600 });
      claimedInfo = infoPath;
      claimedName = candidate;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      return { ...entry, status: "refused", trashed: false, reason: describe(err) };
    }
  }
  if (claimedInfo === undefined || claimedName === undefined) {
    return {
      ...entry,
      status: "refused",
      trashed: false,
      reason: "the trash already holds too many files with this name",
    };
  }

  const destination = path.join(filesDir, claimedName);
  try {
    rename(entry.abs, destination);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    removeClaimedInfoFile(claimedInfo, trashDir);
    if (code === "EXDEV") {
      return {
        ...entry,
        status: "refused",
        trashed: false,
        reason:
          "it turned out to be on a different filesystem from its trash, and a trash is a move, never a copy — nothing was deleted",
      };
    }
    return { ...entry, status: "refused", trashed: false, reason: describe(err) };
  }

  return {
    ...entry,
    trashed: true,
    storedAs: claimedName,
    filesPath: destination,
    infoPath: claimedInfo,
  };
}

/**
 * The ONLY deletion in this package, and the reason it is allowed.
 *
 * When the move fails after the name has been claimed, the `.trashinfo`
 * record this call just wrote points at a file that is not in the trash. Left
 * behind it is a broken entry in the user's trash forever. Removing it is
 * safe only because of the three assertions below: the path must be the info
 * file inside the trash directory this call chose, and it must carry the
 * `.trashinfo` suffix. Nothing a caller named can satisfy that, which is what
 * makes it impossible for this tool to delete a caller's file by accident.
 */
export function removeClaimedInfoFile(infoPath: string, trashDir: string): boolean {
  const infoDir = path.join(trashDir, "info");
  if (!infoPath.endsWith(".trashinfo")) return false;
  if (path.dirname(infoPath) !== infoDir) return false;
  if (path.basename(infoPath) === ".trashinfo") return false;
  try {
    unlinkSync(infoPath);
    return true;
  } catch {
    // A best-effort tidy-up: a stale info file is a cosmetic problem, and
    // failing the whole call over it would turn a recoverable outcome into a
    // confusing one.
    return false;
  }
}

function describe(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  const message = err instanceof Error ? err.message : String(err);
  return code === undefined ? message : `${code}: ${message}`;
}

export type { PathFacts };
