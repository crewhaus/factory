/**
 * Path containment — the gate every caller-supplied path in this package
 * passes through before any syscall touches it.
 *
 * Copied from `@crewhaus/tool-fsx` (which took it from `@crewhaus/tool-fs`)
 * so every package that touches the filesystem enforces the SAME boundary:
 * a lexical check alone is fooled by a symlink that lives inside the
 * workspace and points outside it (CWE-59), so the real path is checked too.
 * The workspace root is `process.cwd()`, matching tool-fs, so a manager
 * harness that trusts one tool's boundary gets the same boundary here.
 *
 * The archive helpers of the original are dropped — nothing in this package
 * extracts an archive.
 */
import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { CrewhausError } from "@crewhaus/errors";

/**
 * How much of a caller-supplied path is echoed back in a message.
 *
 * The refusal goes into a model's context, so a caller cannot be allowed to
 * spend that context by passing a megabyte of path, and cannot be allowed to
 * smuggle control characters (a NUL, an ANSI escape, a newline that forges a
 * second line of output) through a string a human or a model then reads.
 */
const MAX_ECHOED_PATH_CHARS = 200;

/** A caller-supplied path, safe to put in a message: bounded and printable. */
export function renderPath(given: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: neutralising control characters is the point
  const printable = given.replace(/[\u0000-\u001f\u007f]/g, "\uFFFD");
  return printable.length > MAX_ECHOED_PATH_CHARS
    ? `${printable.slice(0, MAX_ECHOED_PATH_CHARS)}…`
    : printable;
}

/** Raised when a caller-supplied path resolves outside the workspace root. */
export class ToolPermissionError extends CrewhausError {
  override readonly name = "ToolPermissionError";
  readonly toolName: string;
  readonly path: string;

  constructor(toolName: string, attemptedPath: string) {
    super(
      "tool",
      `tool "${toolName}" rejected path "${renderPath(attemptedPath)}": resolved location escapes the workspace root`,
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
export function resolveSafe(toolName: string, rel: string, root = workspaceRoot()): SafePath {
  // A NUL truncates the path at the syscall boundary, so `a\0/../../etc` can
  // resolve differently in the check than in the open. Refused at the gate
  // rather than left to fail later as "unreadable".
  if (rel.includes("\u0000")) throw new ToolPermissionError(toolName, rel);
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
    let probe = abs;
    const tail: string[] = [];
    while (!existsSync(probe)) {
      tail.unshift(path.basename(probe));
      const parent = path.dirname(probe);
      if (parent === probe) break; // reached the filesystem root
      probe = parent;
    }
    real = tail.length > 0 ? path.join(realpathSync(probe), ...tail) : realpathSync(probe);
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
 * be absolute. Used to keep a discovery walk inside the root it was given.
 */
export function isInside(parent: string, candidate: string): boolean {
  const p = path.resolve(parent);
  const c = path.resolve(candidate);
  return c === p || c.startsWith(`${p}${path.sep}`);
}
