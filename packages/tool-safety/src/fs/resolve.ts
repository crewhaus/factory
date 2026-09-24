import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import * as path from "node:path";
import {
  type SafeFsFailure,
  escapes,
  escapesAsWritten,
  fail,
  invalidPath,
  quote,
  unresolvable,
} from "./failure";

/**
 * Where a path PHYSICALLY lands, resolved the way the kernel resolves it.
 *
 * The containment resolver copied into the tool packages answers this for
 * the path the caller named. This one exists because the audit's defects are
 * about everything else: the leaf joined onto a contained directory, the
 * entries under it, a link copied to a new depth. Two properties matter:
 *
 *   - `..` after a symlink goes to the parent of the link's TARGET, not back
 *     to where the link sits. `path.resolve("a/b/y/..")` folds that text to
 *     `a/b`, but when `y -> ../..` the kernel lands two levels higher, and
 *     every further `..` climbs again (security-11#5). So the walk is one
 *     component at a time, from a directory already known to be physical.
 *   - A dangling link is still a door: `open(O_CREAT)` through
 *     `evil -> /outside/x` creates `/outside/x`. A missing component ends the
 *     probing, but a link that exists as a NAME is always followed.
 *
 * `overlay` lets a caller ask the question about entries that do not exist
 * yet: a copy plans a tree, and a link it is about to create must be judged
 * with the links it is about to create beside it.
 */

export type PlannedEntry = {
  readonly kind: "directory" | "file" | "symlink";
  /** For a symlink: its target text. */
  readonly text?: string;
};

/** Physical absolute path → what a planned operation will put there. */
export type Overlay = ReadonlyMap<string, PlannedEntry>;

/** Symlink hops before the walk gives up, as the kernel does (ELOOP). */
const MAX_HOPS = 40;

const SPLIT = path.sep === "/" ? "/" : /[\\/]/;

function components(p: string): string[] {
  return p.split(SPLIT).filter((c) => c !== "" && c !== ".");
}

function nameExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

class LinkLoop extends Error {
  readonly code = "ELOOP";
}

export type PhysicalOptions = {
  readonly overlay?: Overlay;
  /**
   * A lexical prefix whose physical form is already known (the realpath'd
   * root), so the walk starts there instead of at `/`. Correct because
   * `realpath(lexical) === physical`, and it saves a lstat per component
   * of the root on every call.
   */
  readonly known?: { readonly lexical: string; readonly physical: string };
};

/**
 * The physical location of absolute path `abs`. The result can end in
 * components that do not exist (they are appended as written). Throws the
 * underlying errno error for anything but a missing component, and an
 * `ELOOP` error for a chain longer than 40 hops: callers fail closed.
 */
export function physicalPath(abs: string, options: PhysicalOptions = {}): string {
  const known = options.known;
  if (known !== undefined && isWithin(known.lexical, abs)) {
    return walk(known.physical, components(abs.slice(known.lexical.length)), options.overlay);
  }
  const root = path.parse(abs).root;
  return walk(root, components(abs.slice(root.length)), options.overlay);
}

/**
 * Where relative path `rel` leads when followed from physical directory
 * `dirPhysical`: how the kernel reads a symlink's relative target, with
 * `..` applied AFTER each link, never folded as text first. The answer to
 * "where does this link point once it sits HERE" (security-11#2).
 */
export function physicalFrom(
  dirPhysical: string,
  rel: string,
  options: PhysicalOptions = {},
): string {
  if (path.isAbsolute(rel)) return physicalPath(rel, options);
  return walk(dirPhysical, components(rel), options.overlay);
}

function walk(start: string, initial: string[], overlay: Overlay | undefined): string {
  let cur = start;
  let pending = initial;
  let hops = 0;
  let missing = false;
  while (pending.length > 0) {
    const comp = pending.shift() as string;
    if (comp === "..") {
      cur = path.dirname(cur);
      // Climbing out of the missing region lands back on real directories,
      // whose own children must be probed again. A directory the plan is
      // about to create counts as real: a link planned inside it is followed
      // once it exists, so it must be followed here too.
      if (missing) missing = overlay?.has(cur) !== true && !nameExists(cur);
      continue;
    }
    const next = path.join(cur, comp);
    if (missing) {
      cur = next;
      continue;
    }
    let linkText: string | undefined;
    const planned = overlay?.get(next);
    if (planned !== undefined) {
      if (planned.kind === "symlink") linkText = planned.text ?? "";
    } else {
      try {
        if (lstatSync(next).isSymbolicLink()) linkText = readlinkSync(next);
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
        missing = true;
      }
    }
    if (linkText === undefined) {
      cur = next;
      continue;
    }
    hops += 1;
    if (hops > MAX_HOPS) throw new LinkLoop(`more than ${MAX_HOPS} symbolic links`);
    if (path.isAbsolute(linkText)) {
      const root = path.parse(linkText).root;
      cur = root;
      pending = [...components(linkText.slice(root.length)), ...pending];
    } else {
      // Relative to the directory that really holds the link: `cur`, which
      // is physical by construction.
      pending = [...components(linkText), ...pending];
    }
  }
  return cur;
}

/** True when `child` is `parent` or below it. Both absolute and normalised. */
export function isWithin(parent: string, child: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return child.startsWith(prefix);
}

/** A root prepared once: its lexical form and its realpath. */
export type Root = { readonly lexical: string; readonly physical: string };

export function prepareRoot(root: string, given: string): Root | SafeFsFailure {
  const lexical = path.resolve(root);
  try {
    return { lexical, physical: realpathSync(lexical) };
  } catch {
    return fail(
      "not-found",
      given,
      `the workspace root for ${quote(given)} does not exist or cannot be read`,
    );
  }
}

/**
 * A leaf (or a relative path) under a directory's `rel`, for handing back to
 * this module: `joinRel("", "package.json")` is `"package.json"`, where a
 * template string would give `"/package.json"`, an absolute path outside
 * the root. `rel` is "" for the root itself.
 */
export function joinRel(rel: string, leaf: string): string {
  return path.posix.join(rel === "" ? "." : rel, leaf);
}

/** Slash-separated on every OS. */
export function toPosix(p: string): string {
  return path.sep === "/" ? p : p.split(path.sep).join("/");
}

export type Contained = {
  readonly ok: true;
  /** The path as the caller gave it. */
  readonly given: string;
  /** Lexical absolute path: what the caller named, `..` folded as text. */
  readonly abs: string;
  /** Physical absolute path, inside the root's realpath. Do I/O on this. */
  readonly real: string;
  /** Slash-separated, relative to the root, lexical; "" for the root itself. */
  readonly rel: string;
};

export type ResolveOptions = {
  /**
   * Follow a symlink at the final component (default true). False resolves
   * the PARENT physically and keeps the leaf name, so `real` names the link
   * itself: what a stat of the link, a delete of the link, or a check that
   * refuses links needs.
   */
  readonly followLeaf?: boolean;
};

/**
 * The lexical absolute path, and the prefix of it whose physical form is
 * known. An absolute path may be spelled through the root's realpath
 * (`/private/var/…` for a root given as `/var/…`), which is the same place.
 */
function lexicalAbs(
  root: Root,
  given: string,
): { abs: string; base: string; known: PhysicalOptions["known"] } | SafeFsFailure {
  const bad = invalidPath(given);
  if (bad !== undefined) return bad;
  const abs = path.resolve(root.lexical, given);
  if (isWithin(root.lexical, abs)) return { abs, base: root.lexical, known: root };
  if (isWithin(root.physical, abs)) {
    return {
      abs,
      base: root.physical,
      known: { lexical: root.physical, physical: root.physical },
    };
  }
  return escapesAsWritten(given);
}

/** {@link resolveContained} against a root already prepared. */
export function resolveIn(
  root: Root,
  given: string,
  options: ResolveOptions = {},
): Contained | SafeFsFailure {
  const lex = lexicalAbs(root, given);
  if ("ok" in lex) return lex;
  const { abs, base, known } = lex;
  const followLeaf = options.followLeaf ?? true;
  let real: string;
  try {
    if (abs === base) {
      real = root.physical;
    } else if (followLeaf) {
      real = physicalPath(abs, { known });
    } else {
      real = path.join(physicalPath(path.dirname(abs), { known }), path.basename(abs));
    }
  } catch (err) {
    return unresolvable(given, err);
  }
  if (!isWithin(root.physical, real)) return escapes(given);
  return { ok: true, given, abs, real, rel: toPosix(path.relative(base, abs)) };
}

/**
 * Resolve `given` (relative to `root`, or absolute) to where it physically
 * lands, or refuse it with `escapes-root`. Symlinks anywhere on the way are
 * followed, dangling ones included, and the result must stay inside the
 * root's realpath. A missing tail is allowed, so a destination can be
 * checked before it is created.
 */
export function resolveContained(
  root: string,
  given: string,
  options: ResolveOptions = {},
): Contained | SafeFsFailure {
  const prepared = prepareRoot(root, given);
  if ("ok" in prepared) return prepared;
  return resolveIn(prepared, given, options);
}
