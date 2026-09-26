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
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
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

/**
 * The subdirectories of a git dir whose entries git reads by name. A link at
 * depth one inside them moves a whole ref namespace or object fan-out
 * directory out of the workspace just as a link at the top would.
 */
const SCANNED_SUBDIRS = ["refs", "objects", "info", "logs", "worktrees", "modules"] as const;
/** More entries than this in one scanned directory are not listed further. */
const MAX_SCANNED_ENTRIES = 4096;

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
 * Only the git dir's own entries and those of the directories git reads by
 * name are checked: a bounded scan, not a walk of every loose object.
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
  return undefined;
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
 * The first object directory `objects/info/alternates` borrows from outside
 * the root, or undefined. git reads objects from every directory listed there
 * (a `clone --shared` or `--reference`), so a line naming another
 * repository's object store makes its whole history readable by hash. A line
 * git would read but this cannot resolve is treated as leading out.
 */
export function alternateLeadingOut(commonDir: string, root: string): string | undefined {
  const objects = path.join(commonDir, "objects");
  const file = path.join(objects, "info", "alternates");
  let isEntry = false;
  try {
    lstatSync(file);
    isEntry = true;
  } catch {
    isEntry = false;
  }
  if (!isEntry) return undefined;
  const text = readSmallRegularFile(file);
  // Present but unreadable as a small regular file: git would still try it.
  if (text === undefined) return "objects/info/alternates";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    // git C-quotes a path that needs it; a quoted line is not resolved here.
    if (line.startsWith('"')) return "objects/info/alternates";
    const real = realOrUndefined(path.resolve(objects, line));
    if (real === undefined || !isInside(root, real)) return "objects/info/alternates";
  }
  return undefined;
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
