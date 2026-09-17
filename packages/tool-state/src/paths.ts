/**
 * Path containment — the gate every caller-supplied path in this package
 * passes through before any syscall touches it.
 *
 * This started as `@crewhaus/tool-fsx`'s gate and refuses everything that one
 * refuses, for the same reason: a lexical check alone is fooled by a symlink
 * that lives inside the workspace and points outside it (CWE-59), so the real
 * path is checked too. The workspace root is `process.cwd()`, matching the
 * other file tools, so a harness that trusts one tool's boundary gets the same
 * boundary here — including for the state directory itself, which a caller may
 * name.
 *
 * Two cases this package's own layout forced, and where it is stricter:
 *
 *   - a DANGLING symlink is refused rather than treated as a free name. It
 *     "does not exist" to `existsSync`, and `open(…, "a")` would then follow
 *     it and create the file it points at, outside the workspace.
 *   - an INTERIOR path is re-checked against its real location
 *     (`resolveWithin`). Approving `stateDir` says nothing about `kv/cache`
 *     inside it, and a symlink there is the escape that actually works.
 */
import { lstatSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { CrewhausError } from "@crewhaus/errors";

/** Raised when a caller-supplied path resolves outside the workspace root. */
export class ToolPermissionError extends CrewhausError {
  override readonly name = "ToolPermissionError";
  readonly toolName: string;
  readonly path: string;

  constructor(toolName: string, attemptedPath: string) {
    super(
      "tool",
      `tool "${toolName}" rejected path "${attemptedPath}": resolved location escapes the workspace root`,
    );
    this.toolName = toolName;
    this.path = attemptedPath;
  }
}

/**
 * A validated path, in both forms the tools need.
 *
 * `real` has every in-workspace symlink already resolved and is what I/O
 * should use — operating on it closes most of the check-to-use window.
 * `abs` is the lexical resolution, which is what a tool must use when the
 * question is about the link ITSELF.
 */
export type SafePath = {
  readonly abs: string;
  readonly real: string;
  /** The path as the caller wrote it, for echoing back in results. */
  readonly given: string;
  /** Slash-separated path relative to the workspace root. */
  readonly rel: string;
};

/**
 * Does a name exist on disk, WITHOUT following a final symlink?
 *
 * `existsSync` follows, so it answers "no" for a dangling symlink — and a
 * caller that treats that as "a leaf I may create" then opens the link and
 * writes through it to wherever it points. `lstat` answers about the link
 * itself, which is what a containment check has to reason about.
 */
function existsNoFollow(abs: string): boolean {
  try {
    lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * The real path of `abs`, refused unless it lands inside `rootReal`.
 *
 * Shared by `resolveSafe` (root against the workspace) and `resolveWithin`
 * (an interior path against the state root). The deepest EXISTING ancestor is
 * realpath'd and the missing tail re-appended, so a leaf that does not exist
 * yet is allowed — but a DANGLING symlink is not: `lstat` sees the link, so
 * `realpathSync` is asked about it and fails, and the failure is a refusal.
 */
function realWithin(toolName: string, rootReal: string, abs: string, label: string): string {
  try {
    let probe = abs;
    const tail: string[] = [];
    while (!existsNoFollow(probe)) {
      tail.unshift(path.basename(probe));
      const parent = path.dirname(probe);
      if (parent === probe) break; // reached the filesystem root
      probe = parent;
    }
    const real = tail.length > 0 ? path.join(realpathSync(probe), ...tail) : realpathSync(probe);
    if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) {
      throw new ToolPermissionError(toolName, label);
    }
    return real;
  } catch (err) {
    if (err instanceof ToolPermissionError) throw err;
    throw new ToolPermissionError(toolName, label);
  }
}

/**
 * Check an already-lexically-contained path beneath an ALREADY-VALIDATED root,
 * and return its real location.
 *
 * This is the second half of containment, and the half a lexical check cannot
 * do: `state/kv/x` may itself be a symlink to `/etc`, in which case the
 * joined path is textually inside the root and the write still lands outside
 * it (CWE-59). Every interior path this package touches goes through here.
 */
export function resolveWithin(
  toolName: string,
  rootReal: string,
  abs: string,
  label: string,
): string {
  return realWithin(toolName, path.resolve(rootReal), abs, label);
}

/** The workspace root, resolved. Every path is contained within it. */
export function workspaceRoot(): string {
  return path.resolve(process.cwd());
}

/**
 * Resolve `rel` inside the workspace, or throw `ToolPermissionError`.
 *
 * The leaf is allowed not to exist — every tool here that creates something
 * needs to validate a destination before it is made — so the deepest
 * EXISTING ancestor is realpath'd and the missing tail re-appended. Any
 * failure other than that walk fails closed.
 */
export function resolveSafe(toolName: string, rel: string, root = workspaceRoot()): SafePath {
  const rootResolved = path.resolve(root);
  const abs = path.resolve(rootResolved, rel);
  // 1) Lexical containment — rejects `..` and absolute escapes. The trailing
  //    separator avoids the `/root` vs `/root-sibling` prefix pitfall.
  if (abs !== rootResolved && !abs.startsWith(`${rootResolved}${path.sep}`)) {
    throw new ToolPermissionError(toolName, rel);
  }
  // 2) Symlink-aware containment. The real path must land inside the real
  //    root, so an in-workspace symlink pointing at /etc is refused here.
  let rootReal: string;
  try {
    rootReal = realpathSync(rootResolved);
  } catch {
    throw new ToolPermissionError(toolName, rel);
  }
  const real = realWithin(toolName, rootReal, abs, rel);
  return {
    abs,
    real,
    given: rel,
    rel: toPosix(path.relative(rootResolved, abs)),
  };
}

/** A path relative to the workspace root, with `/` separators on every OS. */
export function toPosix(p: string): string {
  return path.sep === "/" ? p : p.split(path.sep).join("/");
}

/**
 * True when `candidate` is `parent` or lives underneath it. Both must already
 * be absolute. Used to keep an imported state entry inside the state root.
 */
export function isInside(parent: string, candidate: string): boolean {
  const p = path.resolve(parent);
  const c = path.resolve(candidate);
  return c === p || c.startsWith(`${p}${path.sep}`);
}

/**
 * Reject an imported entry name that would escape its destination: an
 * absolute path, a Windows drive prefix, a NUL, or any `..`, `.` or empty
 * segment. Backslashes are normalised first, so a Windows-flavoured escape is
 * caught on a POSIX machine too. Checked on the NAME, before anything is
 * written, because afterwards the damage is done.
 */
export function entryNameEscapes(name: string): boolean {
  const normalized = name.replace(/\\/g, "/");
  if (normalized.length === 0) return true;
  if (normalized.startsWith("/")) return true;
  if (/^[A-Za-z]:/.test(normalized)) return true;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a NUL truncates a path at the syscall boundary, so it may never reach one.
  if (/[\u0000]/.test(normalized)) return true;
  return normalized
    .split("/")
    .some((segment) => segment === ".." || segment === "." || segment === "");
}
