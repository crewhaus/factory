/**
 * Which repository git is really working on, and whether it lies inside the
 * workspace (C071).
 *
 * Containing the `cwd` a caller names is not enough, because git does not
 * work on the directory it is started in: it works on the repository it
 * DISCOVERS from there. Three layouts send it outside a contained `cwd`:
 *
 *  - a workspace nested inside a larger checkout: git climbs to the enclosing
 *    repository, so a stash or a switch rewrites files above the workspace;
 *  - a `.git` FILE (`gitdir: /elsewhere/.git`), which an ordinary write can
 *    plant, so a read shows another repository's files and a write adds refs
 *    to it;
 *  - a `.git` directory whose config sets `core.worktree` to a directory
 *    outside, or whose object store is borrowed (`objects/info/alternates`)
 *    or linked in from outside.
 *
 * So `git-run`'s openRepo asks git for the three places it will use (the
 * working tree's top level, the git dir and the common dir), and this module
 * decides whether they are the workspace's. The rule:
 *
 *  1. The top level must be inside the workspace root, always.
 *  2. A git dir and common dir both inside the root are the workspace's own,
 *     provided nothing in them is a link leading out and the object store
 *     borrows from nothing outside.
 *  3. A git dir OUTSIDE the root is accepted only when git's own bookkeeping,
 *     written in that outside directory where a write inside the workspace
 *     cannot reach, ties it to this top level: a linked worktree's `gitdir`
 *     back-pointer, or a submodule's `core.worktree`. A file planted inside
 *     the workspace cannot forge either.
 *
 * Everything else is refused. `git init --separate-git-dir` leaves neither
 * tie, so it is refused too (it is indistinguishable from a planted `.git`
 * file); setting `core.worktree` in that repository's config is the way to
 * make such a checkout usable.
 */
import { type Dirent, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import * as path from "node:path";

/** True when `p` (already real) is `root` or below it. */
export function isInside(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

/** realpath, or undefined when it cannot be resolved (missing, dangling, a loop). */
export function realOrUndefined(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/** True when `p` (already a real path, so not itself a link) is a directory. */
function isDirectorySync(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The subdirectories of a git dir whose entries git reads by name. A link at
 * depth one inside them moves a whole ref namespace or object fan-out
 * directory out of the workspace just as a link at the top would.
 */
const SCANNED_SUBDIRS = ["refs", "objects", "info", "logs", "worktrees", "modules"] as const;
/** More entries than this in one scanned directory are not listed further. */
const MAX_SCANNED_ENTRIES = 4096;

/**
 * git reads by name every ref (at any depth, `refs/remotes/<remote>/<branch>`)
 * and every object it addresses by hash — a pack or info file under
 * `objects/`, AND a loose object at `objects/<fanout>/<rest>`. A link at
 * depth one is caught by the {@link SCANNED_SUBDIRS} scan, but one deeper is
 * not: `refs/remotes/v` as a directory link, `objects/pack/<name>.{idx,pack}`
 * as a file link, or `objects/ab/cdef…` as a loose-object file link, hands
 * git another repository's refs or objects while the git dir stays inside the
 * workspace. So `refs/` and the WHOLE of `objects/` are walked for a link
 * leading out — the loose fan-out included, since a fresh un-gc'd repository
 * keeps every object loose and git reads it. git writes no symlink into
 * either tree, so a legitimate repository has none.
 *
 * The walk descends through directory symlinks that stay inside the workspace
 * too (`refs/remotes -> ws/stage` whose own `ws/stage/v` leads out), with a
 * realpath-keyed cycle guard, so an outward link one level below an
 * inside-staying link is not missed. It stays bounded by
 * {@link MAX_DEEP_SCAN_ENTRIES} and {@link MAX_DEEP_SCAN_DEPTH}: iterating a
 * directory entry costs no syscall (its kind comes from the directory read),
 * so only real symlinks are `realpath`'d and a clean repository's loose
 * objects — plain files — are counted but never stat'd. A link hidden past
 * the budget is not sought, exactly as git relies on `gc.auto` (6700 loose
 * objects by default) to keep the loose set far below it.
 */
const DEEP_SCAN: ReadonlyArray<{ readonly sub: string; readonly recursive: boolean }> = [
  { sub: "refs", recursive: true },
  { sub: "objects", recursive: true },
];
/** Total entries a deep scan reads before it stops (a link past it is not sought). */
const MAX_DEEP_SCAN_ENTRIES = 50_000;
/** Deepest a deep scan descends (a ref namespace is shallow in practice). */
const MAX_DEEP_SCAN_DEPTH = 64;

/**
 * Entries of a git dir that may lead outside the workspace, because none of
 * them holds or redirects the repository's history, config, index or logs:
 *
 *   - `hooks`: symlinking it to a shared directory was the standard way to
 *     share hooks before `core.hooksPath`. A hook is a program either way;
 *     where it lives adds nothing, and a read runs none.
 *   - `lfs`: git-lfs's object cache, commonly moved to another disk.
 *   - `description`: gitweb's one-line label.
 *   - `info/exclude`, `info/attributes`: ignore and attribute patterns. The
 *     drivers an attribute selects are still the checked config's.
 *
 * Everything else (objects, refs, packed-refs, HEAD, config, the index,
 * logs, rr-cache, worktrees, modules …) still refuses the repository when
 * it leads out.
 */
const MAY_LEAD_OUT: ReadonlySet<string> = new Set([
  "hooks",
  "lfs",
  "description",
  "info/exclude",
  "info/attributes",
]);

/**
 * The first entry of an in-workspace git dir that is a link leading outside
 * the root (or nowhere), as a path relative to that git dir; undefined when
 * there is none.
 *
 * git never creates a symlink inside a git dir, so one there was put there by
 * hand, and a link at `objects` or `refs/heads` hands git another
 * repository's history while the git dir itself sits inside the workspace.
 * The entries in {@link MAY_LEAD_OUT} (hooks, lfs …) hold no history and
 * are allowed to.
 * The git dir's own entries and those of the directories git reads by name
 * are checked at depth one; `refs/` and the whole of `objects/` are walked
 * deeper (a link at `refs/remotes/v`, `objects/pack/*.pack` or a loose object
 * `objects/ab/cdef…` leaks the same way a top-level one does), descending
 * through inside-staying directory symlinks so an outward link below one is
 * not missed. It stays a bounded scan.
 */
export function linkLeadingOut(gitDir: string, root: string): string | undefined {
  const check = (abs: string, rel: string): string | undefined => {
    if (MAY_LEAD_OUT.has(rel)) return undefined;
    let isLink = false;
    try {
      isLink = lstatSync(abs).isSymbolicLink();
    } catch {
      return undefined;
    }
    if (!isLink) return undefined;
    const real = realOrUndefined(abs);
    return real === undefined || !isInside(root, real) ? rel : undefined;
  };
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir).slice(0, MAX_SCANNED_ENTRIES);
    } catch {
      return [];
    }
  };
  for (const name of list(gitDir)) {
    const hit = check(path.join(gitDir, name), name);
    if (hit !== undefined) return hit;
  }
  for (const sub of SCANNED_SUBDIRS) {
    const dir = path.join(gitDir, sub);
    for (const name of list(dir)) {
      const hit = check(path.join(dir, name), `${sub}/${name}`);
      if (hit !== undefined) return hit;
    }
  }
  for (const { sub, recursive } of DEEP_SCAN) {
    const hit = deepLinkLeadingOut(path.join(gitDir, sub), sub, root, recursive);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * The first link leading out (or nowhere) under `dir`, as a path relative to
 * the git dir, or undefined.
 *
 * A symlink that leaves the workspace (or dangles) is a hit. A symlink that
 * stays inside is NOT the end of it: when it points at a directory, git still
 * reads through it by appending path components, so the walk descends into it
 * (`refs/remotes -> ws/stage`, whose own `ws/stage/v` leads out, is caught),
 * with a `realpath`-keyed cycle guard so a link pointing at an ancestor does
 * not loop. A real subdirectory is descended into when `recursive`.
 *
 * The entry's kind comes from the directory read (no per-entry `lstat`), so a
 * clean repository's loose objects — plain files — cost only iteration, and
 * only a real symlink is `realpath`'d. Bounded by {@link MAX_DEEP_SCAN_ENTRIES}
 * entries and {@link MAX_DEEP_SCAN_DEPTH}: a link hidden past the budget is not
 * sought.
 */
function deepLinkLeadingOut(
  dir: string,
  relPrefix: string,
  root: string,
  recursive: boolean,
): string | undefined {
  let budget = MAX_DEEP_SCAN_ENTRIES;
  const seen = new Set<string>();
  const walk = (abs: string, rel: string, depth: number): string | undefined => {
    // Cycle guard: never re-enter a directory (reached by any path) twice.
    const key = realOrUndefined(abs);
    if (key !== undefined) {
      if (seen.has(key)) return undefined;
      seen.add(key);
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const ent of entries) {
      if (budget-- <= 0) return undefined;
      const childAbs = path.join(abs, ent.name);
      const childRel = `${rel}/${ent.name}`;
      let isLink = ent.isSymbolicLink();
      let isDir = ent.isDirectory();
      // A filesystem that reports no d_type (DT_UNKNOWN) leaves every kind
      // false; resolve those explicitly rather than skip them.
      if (!isLink && !isDir && !ent.isFile()) {
        try {
          const st = lstatSync(childAbs);
          isLink = st.isSymbolicLink();
          isDir = st.isDirectory();
        } catch {
          continue;
        }
      }
      if (isLink) {
        const real = realOrUndefined(childAbs);
        if (real === undefined || !isInside(root, real)) return childRel;
        // The link stays inside, but if it points at a directory git reads
        // THROUGH it (refs/remotes -> ws/stage, ws/stage/v -> outside), so
        // descend into what it names when recursive.
        if (recursive && depth + 1 < MAX_DEEP_SCAN_DEPTH && isDirectorySync(real)) {
          const hit = walk(childAbs, childRel, depth + 1);
          if (hit !== undefined) return hit;
        }
        continue;
      }
      if (isDir && recursive && depth + 1 < MAX_DEEP_SCAN_DEPTH) {
        const hit = walk(childAbs, childRel, depth + 1);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  };
  return walk(dir, relPrefix, 0);
}

/** Largest bookkeeping file (gitdir, alternates) this module reads. */
const MAX_BOOKKEEPING_BYTES = 64 * 1024;

/** A small regular file's text, or undefined (missing, a link, a FIFO, too big). */
function readSmallRegularFile(abs: string): string | undefined {
  try {
    const st = lstatSync(abs);
    if (!st.isFile() || st.size > MAX_BOOKKEEPING_BYTES) return undefined;
    return readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * git follows alternates transitively: the objects dir listed in one
 * `info/alternates` is itself an object store whose own `info/alternates` git
 * then reads, up to a depth of {@link MAX_ALTERNATE_DEPTH}. An in-workspace
 * alternate whose own alternates name another repository's object store makes
 * that store's whole history readable by hash, so every object directory in
 * the chain must be inside the root — not only the first level a
 * `clone --shared`/`--reference` writes.
 */
const MAX_ALTERNATE_DEPTH = 5;

/**
 * The object directories `<objectsDir>/info/alternates` names, resolved
 * against `objectsDir` as git resolves them, or `"unreadable"` when git would
 * read the file but this cannot (present but not a small regular file, or a
 * C-quoted line): that is treated as leading out.
 */
function listAlternates(objectsDir: string): string[] | "unreadable" {
  const file = path.join(objectsDir, "info", "alternates");
  try {
    lstatSync(file);
  } catch {
    return [];
  }
  const text = readSmallRegularFile(file);
  if (text === undefined) return "unreadable";
  const dirs: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    // git C-quotes a path that needs it; a quoted line is not resolved here.
    if (line.startsWith('"')) return "unreadable";
    dirs.push(path.resolve(objectsDir, line));
  }
  return dirs;
}

/**
 * The `info/alternates` file whose entry the repository's object store
 * borrows from outside the root, as a path relative to `root`, following the
 * alternates chain as git does (depth {@link MAX_ALTERNATE_DEPTH}), or
 * undefined. `alternateLeadingOut` used to check only the first
 * `info/alternates`, so an in-workspace alternate whose OWN alternates named
 * the victim went unseen; git read the victim's objects all the same (C071
 * bypass). It also always blamed the repository's own `objects/info/alternates`
 * even when the outward entry sat in a deeper store's file — so the refusal
 * now names the file that actually holds it (e.g. `mid/info/alternates`).
 */
export function alternateLeadingOut(commonDir: string, root: string): string | undefined {
  const start = path.join(commonDir, "objects");
  const seen = new Set<string>();
  const alternatesRel = (objectsDir: string): string => {
    const file = path.join(objectsDir, "info", "alternates");
    const rel = path.relative(root, file);
    // A store outside the root cannot be made relative sensibly; name the
    // repository's own file, which is where the chain that reaches it starts.
    return rel === "" || rel.startsWith("..") ? "objects/info/alternates" : rel;
  };
  const walk = (objectsDir: string, depth: number): string | undefined => {
    const key = realOrUndefined(objectsDir) ?? objectsDir;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const alts = listAlternates(objectsDir);
    if (alts === "unreadable") return alternatesRel(objectsDir);
    for (const alt of alts) {
      const real = realOrUndefined(alt);
      if (real === undefined || !isInside(root, real)) return alternatesRel(objectsDir);
      // git stops following past its depth limit, so a store reachable only
      // beyond it is never read: there is nothing more to check there.
      if (depth + 1 <= MAX_ALTERNATE_DEPTH) {
        const hit = walk(real, depth + 1);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  };
  return walk(start, 0);
}

/**
 * True when the git dir OUTSIDE the root is a linked worktree's, tied to
 * `top` by the `gitdir` back-pointer git writes in it, and laid out as git
 * lays one out (`<common>/worktrees/<name>`), so a `commondir` redirect in
 * that directory cannot point the check at one repository and git at another.
 */
export function isWorktreeOf(gitDir: string, commonDir: string, top: string): boolean {
  if (path.dirname(gitDir) !== path.join(commonDir, "worktrees")) return false;
  const text = readSmallRegularFile(path.join(gitDir, "gitdir"));
  if (text === undefined) return false;
  const pointer = text.trim();
  if (pointer === "") return false;
  // git 2.48+ may write the pointer relative to the git dir.
  const dotGit = path.resolve(gitDir, pointer);
  return realOrUndefined(path.dirname(dotGit)) === top;
}
