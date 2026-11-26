/**
 * Path safety for a server that reads files on behalf of HTTP callers.
 *
 * Two independent layers, both mandatory:
 *
 *   1. Shape validation — every id that becomes a path segment must match
 *      its format regex (`hrn_…`, `sess_…`, `run_…`, {@link SAFE_SEGMENT_RE})
 *      BEFORE any filesystem work.
 *   2. Realpath containment — every resolved path must land inside the
 *      harness's registered directory AFTER symlink resolution. Shape checks
 *      stop `../` traversal; the realpath check additionally stops a symlink
 *      planted inside a harness tree from walking the read outside it.
 *
 * A path that does not exist yet, a link to nothing included, resolves only to
 * a place inside the root, so a save never creates or writes a file outside the
 * harness. Containment is decided by `relative()`, never by a string prefix.
 *
 * It moved here from `@crewhaus/hangar-server` (which still re-exports it,
 * for one release) together with run detail, which reads through it: a
 * second copy of realpath containment is how two readers drift apart.
 */
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/** One decoded path segment that may safely be joined onto a directory:
 *  non-empty, no separators, no NUL, not `.`/`..`. */
export function isSafePathSegment(segment: string): boolean {
  if (segment.length === 0 || segment.length > 512) return false;
  if (segment === "." || segment === "..") return false;
  if (segment.includes("/") || segment.includes("\\") || segment.includes("\0")) return false;
  return true;
}

function realOf(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** True when `child` equals `parent` or sits inside it, by `relative()`. Both
 *  arguments must already be real (symlink-resolved) absolute paths. */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Something is at `path` itself: a link counts, whether or not its target exists. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `candidate` (absolute, or relative to `rootDir`) and verify it
 * realpath-contains inside `rootDir`. Returns the resolved path to use, or
 * undefined when the root is unreadable, the candidate escapes it, or a
 * present part of it (a link to nothing, say) cannot be resolved.
 */
export function resolveContained(rootDir: string, candidate: string): string | undefined {
  const realRoot = realOf(rootDir);
  if (realRoot === undefined) return undefined;
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(rootDir, candidate);

  // Deepest present ancestor: realpath what is there, then re-append what
  // isn't (which must be clean of `..` — `resolve` already folded those,
  // but a folded `..` can only have moved the path UP, which the realpath
  // check below catches). A link to nothing is present and does not resolve.
  let existing = target;
  while (!present(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return undefined; // hit the fs root without a match
    existing = parent;
  }
  const realExisting = realOf(existing);
  if (realExisting === undefined) return undefined;
  const suffix = target.slice(existing.length);
  const mapped = realExisting + suffix;
  if (!within(realRoot, mapped)) return undefined;
  return target;
}

/**
 * Join validated segments under `rootDir` with the full containment check.
 * Any unsafe segment or containment failure yields undefined — callers
 * translate that into a 400/404, never into a read.
 */
export function resolveInside(rootDir: string, segments: readonly string[]): string | undefined {
  for (const s of segments) {
    if (!isSafePathSegment(s)) return undefined;
  }
  return resolveContained(rootDir, segments.join("/"));
}
