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
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { CrewhausError } from "@crewhaus/errors";

/**
 * The longest path this resolves, in UTF-16 code units; a longer one is
 * refused before it is walked. Nothing that long can be opened or created:
 * PATH_MAX is 1,024 bytes on macOS and 4,096 on Linux, Windows stops at
 * 32,767 UTF-16 units, and a path's UTF-8 form is never shorter than its
 * UTF-16 one. The limit is twice that because the part of a path that exists
 * is itself under PATH_MAX, so the part that does not is over PATH_MAX on its
 * own: no spelling of the place reaches it, not even one through a symlink
 * that shortens the part that exists.
 */
export const MAX_PATH_CHARS =
  2 * (process.platform === "darwin" ? 1_024 : process.platform === "win32" ? 32_767 : 4_096);

/** A path as a refusal quotes it: whole, unless it is past {@link MAX_PATH_CHARS}. */
function shownPath(given: string): string {
  return given.length > MAX_PATH_CHARS ? `${given.slice(0, 64)}…` : given;
}

/** Why a path past {@link MAX_PATH_CHARS} is refused: its length and the limit. */
function tooLong(abs: string): string {
  return `it is ${abs.length} characters once resolved, over the ${MAX_PATH_CHARS}-character limit: no path that long can be opened or created`;
}

/**
 * Raised when a caller-supplied path resolves outside the workspace root, or
 * is longer than any path can be.
 */
export class ToolPermissionError extends CrewhausError {
  override readonly name = "ToolPermissionError";
  readonly toolName: string;
  readonly path: string;
  /**
   * Why, when it is not that the location escapes the workspace root: a path
   * longer than any path can be. A caller that rewords the refusal says this.
   */
  readonly reason: string | undefined;

  constructor(toolName: string, attemptedPath: string, reason?: string) {
    super(
      "tool",
      reason === undefined
        ? `tool "${toolName}" rejected path "${attemptedPath}": resolved location escapes the workspace root`
        : `tool "${toolName}" rejected path "${shownPath(attemptedPath)}": ${reason}`,
    );
    this.toolName = toolName;
    this.path = attemptedPath;
    this.reason = reason;
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
function nameExists(abs: string): boolean {
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
    const real = resolveLocation(abs);
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

/**
 * Where `target` would actually land, with every symlink on the way already
 * followed — including one whose own target does not exist yet.
 *
 * `realpathSync` gives up with ENOENT on a dangling link. Treating that as a
 * failure would refuse a perfectly ordinary link to a file this harness is
 * about to create, so the dangling hop is followed by hand instead and the
 * result re-checked for containment.
 */
function resolveLocation(target: string, depth = 0): string {
  if (depth > 40) throw new Error(`symlink chain at "${target}" is too long to resolve`);
  const { probe, tail } = deepestName(target);
  let probeReal: string;
  try {
    probeReal = realpathSync(probe);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // The name is there but `realpath` cannot finish it: a symlink with a
    // missing target. `readlinkSync` throws EINVAL on anything else, which
    // fails closed.
    const link = readlinkSync(probe);
    // A RELATIVE target resolves against the directory that actually CONTAINS
    // the link, which is not the link's lexical parent when that parent is
    // itself reached through a symlink. `<root>/dirlink/x -> ../y` with
    // `dirlink` pointing out of the root really lands at `<elsewhere>/y`, but
    // measured from the lexical parent it reads as `<root>/y` — an in-root
    // path the caller's path does not lead to. So the parent is made real
    // first. An absolute target ignores the base.
    const base = realpathSync(path.dirname(probe));
    probeReal = resolveLocation(path.resolve(base, link), depth + 1);
  }
  // One string, not one argument per name: Bun's `path.join` keeps only
  // (argument count mod 65,536) of its arguments.
  return tail.length > 0 ? path.join(probeReal, tail) : probeReal;
}

/**
 * `target`, an absolute path, split where its deepest prefix that exists as
 * a NAME ends: that prefix, and the names below it, which do not exist, as
 * one string ("" when `target` itself exists). This is `path.dirname` and
 * `path.basename` worked by index on `target` itself: handing them each
 * shorter prefix in turn copied the rest of the path once per missing name,
 * the square of a count the caller picks.
 */
function deepestName(target: string): { readonly probe: string; readonly tail: string } {
  const top = path.parse(target).root.length;
  const isSep = (i: number): boolean => target[i] === "/" || target[i] === path.sep;
  let probe = target;
  let start = target.length;
  let stop = -1;
  while (!nameExists(probe)) {
    // `path.basename(probe)` is `target.slice(start, end)`, and
    // `path.dirname(probe)` is `target.slice(0, up)`.
    let end = probe.length;
    while (end > top && isSep(end - 1)) end--;
    if (stop < 0) stop = end;
    start = end;
    while (start > top && !isSep(start - 1)) start--;
    const up = start > top ? start - 1 : top;
    if (up === probe.length) break; // reached the filesystem root
    probe = target.slice(0, up);
  }
  return { probe, tail: stop < 0 ? "" : target.slice(start, stop) };
}

export function resolveSafe(toolName: string, rel: string, root = workspaceRoot()): SafePath {
  const rootResolved = path.resolve(root);
  const abs = path.resolve(rootResolved, rel);
  // 1) Lexical containment — rejects `..` and absolute escapes. The trailing
  //    separator avoids the `/root` vs `/root-sibling` prefix pitfall.
  if (abs !== rootResolved && !abs.startsWith(`${rootResolved}${path.sep}`)) {
    throw new ToolPermissionError(toolName, rel);
  }
  // Longer than any path can be: refused before the walk below reads it.
  if (abs.length > MAX_PATH_CHARS) throw new ToolPermissionError(toolName, rel, tooLong(abs));
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
