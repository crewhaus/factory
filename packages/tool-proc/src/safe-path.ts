import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import * as path from "node:path";

/**
 * Workspace containment for every path a caller supplies — the working
 * directory a command runs in, and the file a wait watches.
 *
 * The algorithm is the one `@crewhaus/tool-fs` uses, reproduced here rather
 * than imported because this package does not depend on that one: resolve
 * lexically first (cheap, catches `..` and absolute escapes), then resolve
 * the real path of the deepest ancestor that EXISTS AS A NAME so an
 * in-workspace symlink pointing outside is caught too (CWE-59). A tool that
 * can be pointed at `/etc` is a defect, so this fails closed: anything it
 * cannot prove is inside the root is refused.
 *
 * It returns a result rather than throwing, because the tools report a
 * caller's mistake as a readable string instead of an exception.
 */
export type SafePath =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string };

/**
 * Is `candidate` the root itself, or something beneath it? Both arguments
 * must already be REAL paths — this is a string containment test, and it is
 * only sound once the symlinks are out of the way.
 */
export function isInsideRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/**
 * True when the NAME exists, whether or not it leads anywhere.
 *
 * `existsSync` follows symlinks, so it answers false for a link whose target
 * is missing — and a missing target is exactly the case that matters here: a
 * dangling link is still a door. A walk that probes with it strides straight
 * past the link, treats it as a plain missing leaf, pushes the name onto the
 * tail and re-appends it to the realpath'd parent, so containment is decided
 * on a path the link does not actually lead to. Probing with `lstat` — a
 * dangling link is a NAME that exists — keeps that name in the part of the
 * path that gets RESOLVED rather than in the "does not exist yet" tail that
 * is appended to the root verbatim.
 */
function nameExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where `target` would actually land, with every symlink on the way already
 * followed — including one whose own target does not exist yet.
 *
 * `realpathSync` gives up with ENOENT on a dangling link, which would leave
 * that link unresolved and let it stand in for a plain missing file. So the
 * deepest ancestor that exists as a name is resolved, a dangling one is
 * followed a hop by hand, and the components that do not exist are appended.
 * The result is the path an `open` would reach, which is the only path worth
 * checking containment against.
 *
 * Throws if the chain cannot be followed at all; `resolveSafe`'s catch turns
 * that into a refusal, so an unresolvable path fails closed.
 */
function resolveLocation(target: string, depth = 0): string {
  if (depth > 40) throw new Error(`symlink chain at "${target}" is too long to resolve`);
  let probe = target;
  const tail: string[] = [];
  while (!nameExists(probe)) {
    tail.unshift(path.basename(probe));
    const parent = path.dirname(probe);
    if (parent === probe) break; // reached the filesystem root
    probe = parent;
  }
  let probeReal: string;
  try {
    probeReal = realpathSync(probe);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // The name is there but `realpath` cannot finish it: a symlink with a
    // missing target. `readlinkSync` throws EINVAL on anything else, which
    // fails closed. Recursing (rather than returning the raw target) is what
    // resolves an absolute target such as /var/folders/... to its real
    // /private/var/... form, so a legitimate in-workspace dangling link is
    // not wrongly refused.
    const link = readlinkSync(probe);
    // A RELATIVE target resolves against the directory that actually CONTAINS
    // the link, which is not the link's lexical parent when that parent is
    // itself reached through a symlink. `<root>/dirlink/x -> ../y` with
    // `dirlink` pointing out of the root lands at `<elsewhere>/y`, but
    // measured from the lexical parent it reads as `<root>/y` and would be
    // admitted; the mirror case wrongly refuses an in-root link. So the
    // parent is made real first. An absolute target ignores the base.
    const base = realpathSync(path.dirname(probe));
    probeReal = resolveLocation(path.resolve(base, link), depth + 1);
  }
  return tail.length > 0 ? path.join(probeReal, ...tail) : probeReal;
}

/**
 * Re-check, at the moment of use, that a path resolved earlier still lives
 * inside the root.
 *
 * `resolveSafe` can only resolve the symlinks that exist when it is called.
 * A path that does not exist at all is admitted on the strength of its
 * parent, and a link planted or swapped AFTER that call was never seen. A
 * tool that polls a path for seconds or minutes — `WaitForFile` does exactly
 * that — would happily report on the target once somebody creates it outside
 * the root, so every poll asks again.
 *
 * (An outward DANGLING link is refused up front now, because `resolveSafe`
 * follows it by hand rather than mistaking it for a missing file. This
 * remains the guard for everything that only becomes a symlink later.)
 *
 * Returns `"absent"` when nothing is there yet (which is not an escape — it
 * is the condition `WaitForFile` may be waiting for), `"inside"` when the
 * real path is contained, and `"escaped"` when it is not.
 */
export function recheckContainment(
  target: string,
  root: string = process.cwd(),
): "inside" | "absent" | "escaped" {
  let rootReal: string;
  try {
    rootReal = realpathSync(path.resolve(root));
  } catch {
    return "escaped";
  }
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    // Nothing (or a dangling link) is there: there is no target to escape
    // to yet, and the caller reads this as "absent".
    return "absent";
  }
  return isInsideRoot(real, rootReal) ? "inside" : "escaped";
}

export function resolveSafe(toolName: string, rel: string, root: string = process.cwd()): SafePath {
  const refusal = (why: string): SafePath => ({
    ok: false,
    message: `[${toolName} error] refused path "${rel}": ${why}. Paths must stay inside the workspace root.`,
  });
  const rootResolved = path.resolve(root);
  const abs = path.resolve(rootResolved, rel);
  if (!isInsideRoot(abs, rootResolved)) {
    return refusal("it resolves outside the workspace root");
  }
  try {
    const rootReal = realpathSync(rootResolved);
    // The leaf may not exist yet (a wait can watch for a file's creation),
    // so `resolveLocation` walks up to the deepest ancestor that exists as a
    // NAME and re-appends the tail. "As a name" rather than "exists": a
    // symlink whose target is missing is still followed by whatever opens
    // this path later, so it is resolved here too.
    const real = resolveLocation(abs);
    if (!isInsideRoot(real, rootReal)) {
      return refusal("a symlink on it leads outside the workspace root");
    }
    return { ok: true, path: real };
  } catch {
    return refusal("it could not be resolved");
  }
}

/**
 * Containment for a directory that must already exist (a command's cwd).
 *
 * `existsSync` is the right probe HERE, unlike in the walk above: a cwd has
 * to be a directory the OS can actually chdir into, so a name that leads
 * nowhere is useless and following the link is exactly what is wanted.
 */
export function resolveSafeDir(toolName: string, rel: string, root?: string): SafePath {
  const resolved = resolveSafe(toolName, rel, root);
  if (!resolved.ok) return resolved;
  if (!existsSync(resolved.path)) {
    return { ok: false, message: `[${toolName} error] directory "${rel}" does not exist.` };
  }
  return resolved;
}
