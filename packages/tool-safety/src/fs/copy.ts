import {
  constants,
  type Stats,
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readlinkSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import * as path from "node:path";
import { type FileKind, fileKind } from "../streams/file";
import {
  type SafeFsFailure,
  escapes,
  fail,
  fromErrno,
  isSymlink,
  quote,
  requireLimit,
  unresolvable,
} from "./failure";
import {
  type PlannedEntry,
  isWithin,
  physicalFrom,
  physicalPath,
  prepareRoot,
  toPosix,
} from "./resolve";
import { walkPhysical } from "./walk";
import {
  type CheckedDir,
  EXCLUSIVE,
  PRESERVED_MODE_BITS,
  checkDir,
  dirUnchanged,
  ensureDirIn,
  lexicalIn,
  replaceInto,
  tempName,
  unlinkIfSame,
  writeAll,
} from "./write";

/**
 * Copying a file or a tree inside a root without writing outside it.
 *
 * What CopyPath got wrong (flag-truth-6#0, security-11#0, security-11#2):
 *   - only the destination ROOT was contained; each file was then written
 *     at `join(dest, rel)` with `mkdir -p` + `copyFile`, which follow a
 *     symlinked directory already sitting under the destination;
 *   - links were recreated with their raw text at a new depth, so
 *     `a/b/up -> ../..`, inside the workspace where it was, pointed outside
 *     it once copied one level higher.
 *
 * Here the whole copy is PLANNED before anything is written: every source
 * entry is `lstat`ed and never followed, every destination path is checked
 * (any existing link on it is refused, whatever it points at), and each
 * link to be created is resolved from its NEW location, the way the kernel
 * will — `..` after each hop, with the links planned beside it taken into
 * account — and refused if it would lead outside the destination root.
 * Then files are created with `O_EXCL|O_NOFOLLOW`, replacements go through
 * a temp and a rename, and every created link is checked again at the end.
 */

export type CopySymlinkPolicy = "refuse" | "skip" | "copy-contained";

export type CopyOptions = {
  /**
   * Links in the source: `refuse` fails the copy, `skip` leaves them out
   * (listed in `skipped`), `copy-contained` recreates each one with the same
   * text when, from its new location, it still resolves inside the
   * destination root, and fails the copy otherwise. Links are never
   * dereferenced: their targets' contents are never copied.
   */
  readonly symlinks: CopySymlinkPolicy;
  /** FIFOs, sockets and devices: fail the copy (default) or skip them. */
  readonly specials?: "refuse" | "skip";
  /** Replace existing regular files. Directories are merged into either way. */
  readonly overwrite?: boolean;
  /** Create the destination's missing parent directories, each contained. */
  readonly createParents?: boolean;
  /** Most entries under the source. More fails the copy; it is never partial. */
  readonly maxEntries: number;
  /** Most bytes of file content. More fails the copy before anything is written. */
  readonly maxBytes?: number;
  /** Plan and check everything, write nothing. */
  readonly dryRun?: boolean;
};

export type CopyEntry = {
  /** Relative to the copied top; "" for the top itself. */
  readonly rel: string;
  readonly kind: "directory" | "file" | "symlink";
  readonly bytes: number;
  /** Destination, relative to the destination root. */
  readonly destination: string;
  /** An existing regular file is replaced. */
  readonly replaces: boolean;
};

export type CopySkip = {
  /** Source path, relative to the source root. */
  readonly path: string;
  readonly kind: FileKind;
};

export type CopyResult =
  | {
      readonly ok: true;
      readonly dryRun: boolean;
      /** Everything written (or, for a dry run, that would be), in order. */
      readonly entries: readonly CopyEntry[];
      readonly files: number;
      readonly directories: number;
      readonly symlinks: number;
      readonly bytes: number;
      /** Destination paths of regular files replaced. */
      readonly replaced: readonly string[];
      readonly skipped: readonly CopySkip[];
    }
  | SafeFsFailure;

type Planned = {
  readonly rel: string;
  readonly kind: "directory" | "file" | "symlink";
  readonly srcReal: string;
  readonly srcPath: string;
  readonly stats: Stats;
  readonly text?: string;
  readonly destReal: string;
  readonly destPath: string;
  replaces: boolean;
};

const O_NOFOLLOW = (constants as Record<string, number | undefined>)["O_NOFOLLOW"] ?? 0;
const O_NONBLOCK = (constants as Record<string, number | undefined>)["O_NONBLOCK"] ?? 0;
const COPY_CHUNK = 1024 * 1024;

function joinRel(a: string, b: string): string {
  if (a === "") return b;
  return b === "" ? a : `${a}/${b}`;
}

/** `p` and each existing ancestor of it, up to and including `stop`. */
function lineage(p: string, stop: string): Stats[] {
  const out: Stats[] = [];
  let cur = p;
  for (;;) {
    try {
      out.push(lstatSync(cur));
    } catch {
      // not there (yet): its ancestors still count
    }
    if (cur === stop || !isWithin(stop, cur)) return out;
    const up = path.dirname(cur);
    if (up === cur) return out;
    cur = up;
  }
}

/**
 * Whether the destination lies inside the source or the source inside the
 * destination. Compared by identity as well as by spelling: on a
 * case-insensitive volume `Src/copy` is inside `src`, and the spellings
 * alone do not say so.
 */
function overlaps(
  srcTop: string,
  srcStats: Stats,
  srcRoot: string,
  dstTop: string,
  dstRoot: string,
): boolean {
  if (isWithin(srcTop, dstTop) || isWithin(dstTop, srcTop)) return true;
  const same = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;
  if (lineage(dstTop, dstRoot).some((st) => same(st, srcStats))) return true;
  let dstStats: Stats;
  try {
    dstStats = lstatSync(dstTop);
  } catch {
    return false;
  }
  return lineage(srcTop, srcRoot).some((st) => same(st, dstStats));
}

function nothingCopied(failure: SafeFsFailure): SafeFsFailure {
  return { ...failure, reason: `${failure.reason}; nothing was copied` };
}

function afterProgress(failure: SafeFsFailure, done: number, total: number): SafeFsFailure {
  return {
    ...failure,
    reason: `${failure.reason} (${done} of ${total} entries had already been copied)`,
  };
}

let beforeEntry: ((destination: string) => void) | undefined;

/**
 * Test seam: runs before each planned entry is written, with its
 * destination path, so a test can change the tree between the plan and the
 * write. Pass `undefined` to restore.
 */
export function _setBeforeCopyEntryForTest(fn: ((destination: string) => void) | undefined): void {
  beforeEntry = fn;
}

/**
 * Copy `src` (inside `srcRoot`) to `dst` (inside `dstRoot`). A directory is
 * copied with everything under it and merged into an existing directory at
 * `dst`; a file or link is copied to exactly `dst`.
 */
export function copyTreeSafe(
  srcRoot: string,
  src: string,
  dstRoot: string,
  dst: string,
  options: CopyOptions,
): CopyResult {
  requireLimit("maxEntries", options.maxEntries, true);
  requireLimit("maxBytes", options.maxBytes, false);
  // --- the source, its own leaf never followed ------------------------------
  const sRoot = prepareRoot(srcRoot, src);
  if ("ok" in sRoot) return sRoot;
  const sLex = lexicalIn(sRoot, src);
  if ("ok" in sLex) return sLex;
  let srcTop: string;
  try {
    srcTop =
      sLex.abs === sLex.base
        ? sRoot.physical
        : path.join(
            physicalPath(path.dirname(sLex.abs), { known: sLex.known }),
            path.basename(sLex.abs),
          );
  } catch (err) {
    return unresolvable(src, err);
  }
  if (!isWithin(sRoot.physical, srcTop)) return escapes(src);
  let topStats: Stats;
  try {
    topStats = lstatSync(srcTop);
  } catch (err) {
    return fromErrno(src, err, "copied");
  }
  const srcRel = toPosix(path.relative(sLex.base, sLex.abs));

  // --- the destination -------------------------------------------------------
  const dRoot = prepareRoot(dstRoot, dst);
  if ("ok" in dRoot) return dRoot;
  const dLex = lexicalIn(dRoot, dst);
  if ("ok" in dLex) return dLex;
  if (dLex.abs === dLex.base) {
    return fail(
      "invalid-path",
      dst,
      `${quote(dst)} names the workspace root; copy to a path below it`,
    );
  }
  const dstRel = toPosix(path.relative(dLex.base, dLex.abs));
  let dstDir: string;
  try {
    dstDir = physicalPath(path.dirname(dLex.abs), { known: dLex.known });
  } catch (err) {
    return unresolvable(dst, err);
  }
  if (!isWithin(dRoot.physical, dstDir)) return escapes(dst, "its directory");
  try {
    if (!lstatSync(dstDir).isDirectory()) {
      return fail("not-directory", dst, `the parent of ${quote(dst)} is not a directory`);
    }
  } catch (err) {
    if ((err as { code?: unknown }).code !== "ENOENT") return fromErrno(dst, err, "written");
    if (options.createParents !== true) {
      return fail(
        "parent-missing",
        dst,
        `the directory ${quote(dst)} would go in does not exist; pass createParents or create it first`,
      );
    }
  }
  const dstTop = path.join(dstDir, path.basename(dLex.abs));
  if (overlaps(srcTop, topStats, sRoot.physical, dstTop, dRoot.physical)) {
    return fail(
      "overlaps-source",
      dst,
      `${quote(dst)} and ${quote(src)} overlap: they are the same entry, or one is inside the other; nothing was copied`,
    );
  }

  // --- plan every entry, touching nothing -----------------------------------
  const planned: Planned[] = [];
  const skipped: CopySkip[] = [];
  const overlay = new Map<string, PlannedEntry>();
  let bytes = 0;
  const consider = (rel: string, srcReal: string, stats: Stats): SafeFsFailure | undefined => {
    const kind = fileKind(stats);
    const srcPath = joinRel(srcRel, rel);
    const destReal = rel === "" ? dstTop : path.join(dstTop, ...rel.split("/"));
    const destPath = joinRel(dstRel, rel);
    const base = { rel, srcReal, srcPath, stats, destReal, destPath, replaces: false };
    if (kind === "symlink") {
      if (options.symlinks === "refuse") {
        return nothingCopied(isSymlink(srcPath, "links are not copied here"));
      }
      if (options.symlinks === "skip") {
        skipped.push({ path: srcPath, kind });
        return undefined;
      }
      let text: string;
      try {
        text = readlinkSync(srcReal);
      } catch (err) {
        return nothingCopied(fromErrno(srcPath, err, "read"));
      }
      planned.push({ ...base, kind: "symlink", text });
      overlay.set(destReal, { kind: "symlink", text });
      return undefined;
    }
    if (kind === "directory") {
      planned.push({ ...base, kind: "directory" });
      overlay.set(destReal, { kind: "directory" });
      return undefined;
    }
    if (kind === "file") {
      bytes += stats.size;
      if (options.maxBytes !== undefined && bytes > options.maxBytes) {
        return fail(
          "too-large",
          src,
          `${quote(src)} holds more than ${options.maxBytes} bytes; nothing was copied`,
        );
      }
      planned.push({ ...base, kind: "file" });
      overlay.set(destReal, { kind: "file" });
      return undefined;
    }
    if (options.specials === "skip") {
      skipped.push({ path: srcPath, kind });
      return undefined;
    }
    return fail(
      "not-regular-file",
      srcPath,
      `${quote(srcPath)} is a ${kind}; only files, directories and links are copied, so nothing was copied`,
      { kind },
    );
  };
  const refusedTop = consider("", srcTop, topStats);
  if (refusedTop !== undefined) return refusedTop;
  if (topStats.isDirectory()) {
    const walked = walkPhysical(sRoot.physical, srcTop, topStats, srcRel, {
      maxEntries: options.maxEntries,
      maxDepth: Number.MAX_SAFE_INTEGER,
      maxVisited: options.maxEntries + 1,
    });
    const unreadable = walked.unreadable[0];
    if (unreadable !== undefined) {
      const at = joinRel(srcRel, unreadable.rel);
      return fail(
        unreadable.reason === "permission-denied"
          ? "permission-denied"
          : unreadable.reason === "changed"
            ? "changed"
            : "io-error",
        at,
        `${quote(at)} could not be listed (${unreadable.reason}); nothing was copied`,
      );
    }
    if (walked.truncatedBy !== undefined) {
      return fail(
        "too-large",
        src,
        `${quote(src)} has more than ${options.maxEntries} entries; nothing was copied`,
      );
    }
    for (const w of walked.entries) {
      const refused = consider(w.entry.rel, w.entry.real, w.stats);
      if (refused !== undefined) return refused;
    }
  }

  // --- check every destination path -----------------------------------------
  const replaced: string[] = [];
  for (const p of planned) {
    let st: Stats | undefined;
    try {
      st = lstatSync(p.destReal);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code !== "ENOENT") return nothingCopied(fromErrno(p.destPath, err, "written"));
    }
    if (st === undefined) continue;
    if (st.isSymbolicLink()) {
      return nothingCopied(
        isSymlink(p.destPath, "a copy does not write through or over an existing link"),
      );
    }
    const existing = fileKind(st);
    if (p.kind === "directory") {
      if (existing !== "directory") {
        return fail(
          "not-directory",
          p.destPath,
          `${quote(p.destPath)} exists as a ${existing}, where the copy needs a directory; nothing was copied`,
          { kind: existing },
        );
      }
      continue;
    }
    if (existing !== "file") {
      return fail(
        "exists",
        p.destPath,
        `${quote(p.destPath)} exists as a ${existing}, which a copied ${p.kind} does not replace; nothing was copied`,
        { kind: existing },
      );
    }
    p.replaces = true;
    replaced.push(p.destPath);
  }

  // --- every link, judged from where it will be ------------------------------
  for (const p of planned) {
    if (p.kind !== "symlink") continue;
    let target: string;
    try {
      target = physicalFrom(path.dirname(p.destReal), p.text ?? "", { overlay });
    } catch (err) {
      return nothingCopied(unresolvable(p.srcPath, err));
    }
    if (!isWithin(dRoot.physical, target)) {
      return fail(
        "escapes-root",
        p.srcPath,
        `${quote(p.srcPath)} is a symbolic link that would lead outside the workspace once copied to ${quote(p.destPath)}; nothing was copied`,
      );
    }
  }

  if (replaced.length > 0 && options.overwrite !== true) {
    return fail(
      "exists",
      dst,
      `${replaced.length} destination file${replaced.length === 1 ? "" : "s"} already exist under ${quote(dst)}; pass overwrite to replace ${replaced.length === 1 ? "it" : "them"}. Nothing was copied`,
      { conflicts: replaced },
    );
  }

  const summary = (dryRun: boolean): CopyResult => ({
    ok: true,
    dryRun,
    entries: planned.map((p) => ({
      rel: p.rel,
      kind: p.kind,
      bytes: p.kind === "file" ? p.stats.size : 0,
      destination: p.destPath,
      replaces: p.replaces,
    })),
    files: planned.filter((p) => p.kind === "file").length,
    directories: planned.filter((p) => p.kind === "directory").length,
    symlinks: planned.filter((p) => p.kind === "symlink").length,
    bytes,
    replaced,
    skipped,
  });
  if (options.dryRun === true) return summary(true);

  // --- write -------------------------------------------------------------------
  if (options.createParents === true) {
    const ensured = ensureDirIn(dRoot, dst, { ...dLex, abs: path.dirname(dLex.abs) }, {});
    if (!ensured.ok) return nothingCopied(ensured);
    if (ensured.real !== dstDir) {
      return fail(
        "changed",
        dst,
        `the directory of ${quote(dst)} changed while it was being created; nothing was copied`,
      );
    }
  }
  const topDir = checkDir(dstDir);
  if (topDir === undefined) {
    return fail(
      "changed",
      dst,
      `the directory of ${quote(dst)} changed before the copy began; nothing was copied`,
    );
  }
  // Every directory an entry is written into, as it was checked or made.
  // The plan is depth-first, so a directory is always made before anything
  // inside it.
  const dirs = new Map<string, CheckedDir>([[dstDir, topDir]]);
  const madeDirs: Array<{ dir: CheckedDir; mode: number }> = [];
  const links: Array<{ p: Planned; made: Stats }> = [];
  for (let i = 0; i < planned.length; i++) {
    const p = planned[i] as Planned;
    beforeEntry?.(p.destPath);
    const parent = dirs.get(path.dirname(p.destReal));
    const failed =
      parent === undefined
        ? fail(
            "changed",
            p.destPath,
            `the directory of ${quote(p.destPath)} changed during the copy`,
          )
        : p.kind === "directory"
          ? makeDir(p, parent, dirs, madeDirs)
          : p.kind === "file"
            ? copyFile(p, parent)
            : makeLink(p, parent, links);
    if (failed !== undefined) return afterProgress(failed, i, planned.length);
  }
  // A link created early can change what a later one resolves to, and the
  // tree can change under the copy: check the links against the real tree.
  for (const { p, made } of links) {
    let target: string | undefined;
    try {
      target = physicalPath(p.destReal);
    } catch {
      target = undefined;
    }
    if (target === undefined || !isWithin(dRoot.physical, target)) {
      unlinkIfSame(p.destReal, made);
      return fail(
        "changed",
        p.destPath,
        `${quote(p.destPath)} would have led outside the workspace after the copy, so it was removed`,
      );
    }
  }
  // Directories were made writable by their owner so their contents could
  // be written; give each the source's permissions now, innermost first.
  for (const { dir, mode } of madeDirs.reverse()) {
    try {
      const now = lstatSync(dir.real);
      if (now.isDirectory() && now.dev === dir.dev && now.ino === dir.ino)
        chmodSync(dir.real, mode);
    } catch {
      // gone or unreadable: nothing to restore
    }
  }
  return summary(false);
}

/**
 * Make (or merge into) one planned directory. It is created with its owner's
 * rwx bits added, so a read-only source directory still receives its
 * contents; its own bits are restored once the copy is done.
 */
function makeDir(
  p: Planned,
  parent: CheckedDir,
  dirs: Map<string, CheckedDir>,
  madeDirs: Array<{ dir: CheckedDir; mode: number }>,
): SafeFsFailure | undefined {
  const sourceMode = p.stats.mode & 0o777;
  let made = false;
  try {
    mkdirSync(p.destReal, { mode: sourceMode | 0o700 });
    made = true;
  } catch (err) {
    if ((err as { code?: unknown }).code !== "EEXIST") return fromErrno(p.destPath, err, "created");
  }
  // Merged into, or just made: either way it must be a real directory (not
  // a link swapped in meanwhile), in the directory that was checked.
  const dir = checkDir(p.destReal);
  if (dir === undefined || !dirUnchanged(parent)) {
    if (made && dir !== undefined) rmdirIfSame(dir);
    return fail("changed", p.destPath, `${quote(p.destPath)} changed during the copy`);
  }
  dirs.set(p.destReal, dir);
  if (made) {
    let created: number;
    try {
      created = lstatSync(p.destReal).mode & 0o777;
    } catch {
      created = sourceMode | 0o700;
    }
    // The owner bits the source lacks come off again; the umask stays applied.
    const mode = created & ~(0o700 & ~sourceMode);
    if (mode !== created) madeDirs.push({ dir, mode });
  }
  return undefined;
}

function rmdirIfSame(dir: CheckedDir): void {
  try {
    const now = lstatSync(dir.real);
    if (now.isDirectory() && now.dev === dir.dev && now.ino === dir.ino) rmdirSync(dir.real);
  } catch {
    // not ours any more, or not empty: leave it
  }
}

function makeLink(
  p: Planned,
  parent: CheckedDir,
  links: Array<{ p: Planned; made: Stats }>,
): SafeFsFailure | undefined {
  if (p.replaces) {
    try {
      if (!dirUnchanged(parent) || !lstatSync(p.destReal).isFile()) {
        return fail("changed", p.destPath, `${quote(p.destPath)} changed during the copy`);
      }
      unlinkSync(p.destReal);
    } catch (err) {
      return fromErrno(p.destPath, err, "replaced");
    }
  }
  let made: Stats;
  try {
    symlinkSync(p.text ?? "", p.destReal);
    made = lstatSync(p.destReal);
  } catch (err) {
    if ((err as { code?: unknown }).code === "EEXIST") {
      return fail("changed", p.destPath, `${quote(p.destPath)} appeared during the copy`);
    }
    return fromErrno(p.destPath, err, "created");
  }
  if (!dirUnchanged(parent)) {
    unlinkIfSame(p.destReal, made);
    return fail(
      "changed",
      p.destPath,
      `the directory of ${quote(p.destPath)} changed during the copy`,
    );
  }
  links.push({ p, made });
  return undefined;
}

function copyFile(p: Planned, parent: CheckedDir): SafeFsFailure | undefined {
  let srcFd: number;
  try {
    srcFd = openSync(p.srcReal, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    return fromErrno(p.srcPath, err, "read");
  }
  let destFd: number | undefined;
  let writing: string | undefined;
  let made: Stats | undefined;
  try {
    const now = fstatSync(srcFd);
    if (!now.isFile() || now.dev !== p.stats.dev || now.ino !== p.stats.ino) {
      return fail("changed", p.srcPath, `${quote(p.srcPath)} was replaced during the copy`);
    }
    let mode: number | undefined;
    if (p.replaces) {
      const existing = lstatSync(p.destReal);
      if (!existing.isFile()) {
        return fail("changed", p.destPath, `${quote(p.destPath)} changed during the copy`);
      }
      // As `cp` does, a replaced file keeps its own permission bits.
      mode = existing.mode & PRESERVED_MODE_BITS;
      writing = path.join(path.dirname(p.destReal), tempName(path.basename(p.destReal)));
      try {
        destFd = openSync(writing, EXCLUSIVE, 0o600);
      } catch (err) {
        writing = undefined;
        return fromErrno(p.destPath, err, "written");
      }
    } else {
      writing = p.destReal;
      try {
        destFd = openSync(writing, EXCLUSIVE, p.stats.mode & 0o777);
      } catch (err) {
        writing = undefined;
        const code = (err as { code?: unknown }).code;
        if (code === "EEXIST" || code === "ELOOP") {
          return fail("changed", p.destPath, `${quote(p.destPath)} appeared during the copy`);
        }
        return fromErrno(p.destPath, err, "created");
      }
    }
    made = fstatSync(destFd);
    if (!dirUnchanged(parent)) {
      return fail(
        "changed",
        p.destPath,
        `the directory of ${quote(p.destPath)} changed during the copy`,
      );
    }
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(COPY_CHUNK, p.stats.size + 1)));
    let total = 0;
    for (;;) {
      const n = readSync(srcFd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      total += n;
      if (total > p.stats.size) {
        return fail("changed", p.srcPath, `${quote(p.srcPath)} grew during the copy`);
      }
      writeAll(destFd, buffer.subarray(0, n));
    }
    if (total !== p.stats.size) {
      return fail("changed", p.srcPath, `${quote(p.srcPath)} shrank during the copy`);
    }
    if (mode !== undefined) fchmodSync(destFd, mode);
    closeSync(destFd);
    destFd = undefined;
    if (p.replaces) {
      const placed = replaceInto(p.destPath, writing, p.destReal);
      if (placed !== undefined) return placed;
    }
    writing = undefined;
    return undefined;
  } catch (err) {
    return fromErrno(p.destPath, err, "written");
  } finally {
    closeSync(srcFd);
    if (destFd !== undefined) {
      try {
        closeSync(destFd);
      } catch {
        // already closed
      }
    }
    // Anything left half-written — a new file or a temp — is removed, but
    // only while the name still leads to the file this call created.
    if (writing !== undefined && made !== undefined) unlinkIfSame(writing, made);
  }
}
