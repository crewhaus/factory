import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";

/**
 * Workspace containment for every path a caller supplies — the working
 * directory a command runs in, and the file a wait watches.
 *
 * The algorithm is the one `@crewhaus/tool-fs` uses, reproduced here rather
 * than imported because this package does not depend on that one: resolve
 * lexically first (cheap, catches `..` and absolute escapes), then resolve
 * the deepest EXISTING ancestor's real path so an in-workspace symlink
 * pointing outside is caught too (CWE-59). A tool that can be pointed at
 * `/etc` is a defect, so this fails closed: anything it cannot prove is
 * inside the root is refused.
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
 * Re-check, at the moment of use, that a path resolved earlier still lives
 * inside the root.
 *
 * `resolveSafe` can only resolve the symlinks that exist when it is called,
 * so a path whose leaf is a DANGLING symlink (or one that does not exist at
 * all) is admitted on the strength of its parent. A tool that then polls that
 * path for seconds or minutes — `WaitForFile` does exactly that — would
 * happily report on the target once somebody creates it outside the root, and
 * a symlink swapped in mid-wait escapes the same way. So every poll asks
 * again.
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
    // so walk up to the deepest existing ancestor and re-append the tail.
    let probe = abs;
    const tail: string[] = [];
    while (!existsSync(probe)) {
      tail.unshift(path.basename(probe));
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const real = tail.length > 0 ? path.join(realpathSync(probe), ...tail) : realpathSync(probe);
    if (!isInsideRoot(real, rootReal)) {
      return refusal("a symlink on it leads outside the workspace root");
    }
    return { ok: true, path: real };
  } catch {
    return refusal("it could not be resolved");
  }
}

/** Containment for a directory that must already exist (a command's cwd). */
export function resolveSafeDir(toolName: string, rel: string, root?: string): SafePath {
  const resolved = resolveSafe(toolName, rel, root);
  if (!resolved.ok) return resolved;
  if (!existsSync(resolved.path)) {
    return { ok: false, message: `[${toolName} error] directory "${rel}" does not exist.` };
  }
  return resolved;
}
