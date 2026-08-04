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
 * The containment check resolves the deepest EXISTING ancestor of the target
 * (so probing a not-yet-created file still validates) and requires the
 * not-yet-existing suffix to be separator- and dot-dot-free.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

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

/** True when `child` equals `parent` or sits strictly inside it. Both
 *  arguments must already be real (symlink-resolved) absolute paths. */
function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Resolve `candidate` (absolute, or relative to `rootDir`) and verify it
 * realpath-contains inside `rootDir`. Returns the resolved path to use, or
 * undefined when the root is unreadable or the candidate escapes it.
 */
export function resolveContained(rootDir: string, candidate: string): string | undefined {
  const realRoot = realOf(rootDir);
  if (realRoot === undefined) return undefined;
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(rootDir, candidate);

  // Deepest existing ancestor: realpath what exists, then re-append what
  // doesn't (which must be clean of `..` — `resolve` already folded those,
  // but a folded `..` can only have moved the path UP, which the realpath
  // check below catches).
  let existing = target;
  while (!existsSync(existing)) {
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
