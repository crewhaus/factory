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
import * as path from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import { resolveContained } from "@crewhaus/tool-safety/fs";

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
 * The leaf is allowed not to exist. Where the path really lands is
 * tool-safety's `resolveContained`: one component at a time, the way the
 * kernel walks it, dangling links followed, and `..` inside a link's target
 * climbing from where the previous link really led. The copy that lived
 * here resolved a dangling link's target as TEXT (the C068 resolver
 * defect). Any failure fails closed.
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
  const resolved = resolveContained(rootResolved, abs);
  if (!resolved.ok) throw new ToolPermissionError(toolName, rel);
  const real = resolved.real;
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
