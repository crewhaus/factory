/**
 * Path containment — the gate every caller-supplied path in this package
 * passes through before any syscall touches it.
 *
 * The approach is the one `@crewhaus/tool-fs` uses, and for the same reasons:
 * a lexical check alone is fooled by a symlink that lives inside the
 * workspace and points outside it (CWE-59), so the real path is checked too.
 * The workspace root is `process.cwd()`, matching tool-fs, so a harness that
 * trusts one tool's boundary gets the same boundary here.
 */
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { CrewhausError } from "@crewhaus/errors";

/**
 * A caller path as it is safe to echo back: control characters — a NUL in
 * particular, which a path can carry and a downstream reader can choke on —
 * become `?`. The refusal still names what was asked for.
 */
export function describePath(given: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: keeping them out of the message is the point.
  return given.replace(/[\u0000-\u001f\u007f]/g, "?");
}

/** Raised when a caller-supplied path resolves outside the workspace root. */
export class ToolPermissionError extends CrewhausError {
  override readonly name = "ToolPermissionError";
  readonly toolName: string;
  readonly path: string;

  constructor(toolName: string, attemptedPath: string) {
    super(
      "tool",
      `tool "${toolName}" rejected path "${describePath(attemptedPath)}": resolved location escapes the workspace root`,
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
 * question is about the link ITSELF (`Stat` reporting a symlink target,
 * `RemovePath` deleting a link rather than its destination).
 */
export type SafePath = {
  readonly abs: string;
  readonly real: string;
  /** The path as the caller wrote it, for echoing back in results. */
  readonly given: string;
  /** Slash-separated path relative to the workspace root. */
  readonly rel: string;
};

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
 * True when the NAME exists, whether or not it leads anywhere.
 *
 * `existsSync` FOLLOWS symlinks, so it answers false for a link whose target
 * is missing — and that is exactly the case that matters: a dangling link is
 * still a door, because `open(…, "w")` through `evil -> /outside/x` CREATES
 * `/outside/x`. Probing with `lstat` keeps the link's name in the part of the
 * path that gets resolved, rather than in the "does not exist yet" tail that
 * is re-appended to the root verbatim and so passes the containment check.
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
 * deepest ancestor that exists as a NAME is resolved, a dangling one is
 * followed a hop by hand, and the components that do not exist are appended.
 * The result is the path an `open` would create, which is the only path worth
 * checking containment against.
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
  return tail.length > 0 ? path.join(probeReal, ...tail) : probeReal;
}

export function resolveSafe(toolName: string, rel: string, root = workspaceRoot()): SafePath {
  const rootResolved = path.resolve(root);
  const abs = path.resolve(rootResolved, rel);
  // 1) Lexical containment — rejects `..` and absolute escapes. The trailing
  //    separator avoids the `/root` vs `/root-sibling` prefix pitfall.
  if (abs !== rootResolved && !abs.startsWith(`${rootResolved}${path.sep}`)) {
    throw new ToolPermissionError(toolName, rel);
  }
  let real: string;
  try {
    const rootReal = realpathSync(rootResolved);
    real = resolveLocation(abs);
    // 2) Symlink-aware containment. The real path must land inside the real
    //    root, so an in-workspace symlink pointing at /etc is refused here.
    if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) {
      throw new ToolPermissionError(toolName, rel);
    }
  } catch (err) {
    if (err instanceof ToolPermissionError) throw err;
    throw new ToolPermissionError(toolName, rel);
  }
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
 * be absolute. Used to keep an archive entry, or a symlink inside an
 * extracted tree, from reaching outside its destination.
 */
export function isInside(parent: string, candidate: string): boolean {
  const p = path.resolve(parent);
  const c = path.resolve(candidate);
  return c === p || c.startsWith(`${p}${path.sep}`);
}

/**
 * Reject an archive member name that would escape its destination: an
 * absolute path, a Windows drive prefix, or any `..` segment. Checked on the
 * NAME, before extraction, because after extraction the damage is done.
 */
export function archiveEntryEscapes(name: string): boolean {
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return true;
  if (/^[A-Za-z]:/.test(normalized)) return true;
  return normalized.split("/").some((segment) => segment === "..");
}
