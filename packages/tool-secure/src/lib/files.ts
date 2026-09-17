/**
 * The only filesystem access in this package, kept in one place so the
 * bounds are in one place too.
 *
 * Three properties hold for every read here:
 *
 *   1. CONTAINMENT. The caller's path has already been through
 *      `resolveSafe`; directories are walked without following symlinks, so
 *      a link inside the workspace cannot walk the scan out of it.
 *   2. BOUNDED MEMORY. A file's size is taken from its open descriptor and
 *      compared with the limit BEFORE any bytes are read. A limit applied
 *      after buffering is not a limit.
 *   3. BOUNDED WORK. The walk has an entry cap and a depth cap, and both are
 *      reported when they bite, so a truncated scan never looks complete.
 *   4. NO SILENT EXCLUSION. Everything the walk declines to open — a symlink,
 *      a dot-file, an excluded directory, a binary, an oversized file — is
 *      named in `skipped` with the reason. A scanner that drops `.env` and
 *      `node_modules/` and then reports `skipped: []` is claiming coverage it
 *      does not have, which is the only failure here that gets someone hurt.
 *
 * Determinism: entries are sorted with plain string comparison, so the same
 * tree produces the same listing and the same truncation point on any host.
 */
import {
  type Dirent,
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
import * as path from "node:path";
import { type SafePath, ToolPermissionError, toPosix } from "../paths";
import { compareStrings } from "./text";

/** Default per-file ceiling. Generous for source, refuses a database dump. */
export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
/** Hard ceiling a caller cannot raise past. */
export const MAX_FILE_BYTES_LIMIT = 16 * 1024 * 1024;
/** How much of a file is inspected for NUL bytes before calling it binary. */
const BINARY_PROBE_BYTES = 8192;

/** Directories skipped unless the caller names them explicitly. */
export const DEFAULT_SKIP_DIRS: ReadonlyArray<string> = [
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__",
];

/**
 * Why a path in the tree was not scanned.
 *
 * The first three are read failures. The last three are DELIBERATE
 * exclusions, and they are listed for the same reason the others are: a
 * secret scanner whose walk quietly drops `.env`, `node_modules/` and every
 * symlink, and then returns `skipped: []`, is telling the caller it covered
 * a tree it did not open.
 */
export type SkipReason =
  | "too-large"
  | "binary"
  | "unreadable"
  | "symlink"
  | "hidden"
  | "excluded-directory";

export type ScannedFile = {
  /** Slash-separated, relative to the scan root. */
  readonly rel: string;
  readonly abs: string;
  readonly bytes: number;
  readonly text: string;
};

export type SkippedFile = {
  readonly rel: string;
  readonly reason: SkipReason;
  readonly detail: string;
};

export type WalkLimits = {
  readonly maxFiles: number;
  readonly maxDepth: number;
  readonly maxFileBytes: number;
  readonly includeHidden: boolean;
  readonly skipDirs: ReadonlyArray<string>;
};

export const DEFAULT_WALK_LIMITS: WalkLimits = {
  maxFiles: 2000,
  maxDepth: 12,
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  includeHidden: false,
  skipDirs: DEFAULT_SKIP_DIRS,
};

/**
 * Open without following a final symlink. `resolveSafe` proved containment,
 * but the leaf could be swapped between the check and the open (CWE-367);
 * refusing to follow it closes that window.
 */
function openNoFollow(toolName: string, abs: string): number {
  try {
    return openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") {
      throw new ToolPermissionError(toolName, abs);
    }
    throw err;
  }
}

export type ReadOutcome =
  | { readonly ok: true; readonly text: string; readonly bytes: number }
  | { readonly ok: false; readonly reason: SkipReason; readonly detail: string };

/**
 * Read a file as UTF-8, refusing it when it is too large or not text.
 *
 * The size check happens against the open descriptor before a single byte is
 * buffered, which is what makes the limit a memory bound rather than a
 * post-hoc complaint.
 */
export function readTextBounded(toolName: string, abs: string, maxBytes: number): ReadOutcome {
  let fd: number;
  try {
    fd = openNoFollow(toolName, abs);
  } catch (err) {
    if (err instanceof ToolPermissionError) throw err;
    return { ok: false, reason: "unreadable", detail: (err as Error).message };
  }
  try {
    const { size } = fstatSync(fd);
    if (size > maxBytes) {
      return {
        ok: false,
        reason: "too-large",
        detail: `${size} bytes, over the ${maxBytes}-byte per-file limit`,
      };
    }
    const probeLength = Math.min(size, BINARY_PROBE_BYTES);
    const probe = Buffer.allocUnsafe(probeLength);
    if (probeLength > 0) readSync(fd, probe, 0, probeLength, 0);
    if (probe.includes(0)) {
      return { ok: false, reason: "binary", detail: "a NUL byte appears in the first 8 KiB" };
    }
    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, buffer, offset, size - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    return { ok: true, text: buffer.subarray(0, offset).toString("utf8"), bytes: offset };
  } catch (err) {
    return { ok: false, reason: "unreadable", detail: (err as Error).message };
  } finally {
    closeSync(fd);
  }
}

export type WalkOutcome = {
  readonly files: ReadonlyArray<ScannedFile>;
  readonly skipped: ReadonlyArray<SkippedFile>;
  /** True when the entry cap or the depth cap cut the walk short. */
  readonly truncated: boolean;
  readonly depthLimited: boolean;
};

/**
 * Collect the readable text files under `root`, depth-first in sorted order.
 *
 * Symlinks are named in `skipped` but never followed, for containment and to
 * make cycles impossible rather than merely unlikely. So are dot-entries and
 * the default-excluded directories: what was not opened is always said.
 */
export function walkTextFiles(
  toolName: string,
  root: SafePath,
  limits: WalkLimits = DEFAULT_WALK_LIMITS,
): WalkOutcome {
  const files: ScannedFile[] = [];
  const skipped: SkippedFile[] = [];
  let truncated = false;
  let depthLimited = false;
  const skipDirs = new Set(limits.skipDirs);

  const visit = (dir: string, rel: string, depth: number): void => {
    if (files.length >= limits.maxFiles) {
      truncated = true;
      return;
    }
    if (depth > limits.maxDepth) {
      depthLimited = true;
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      skipped.push({
        rel: rel === "" ? "." : rel,
        reason: "unreadable",
        detail: (err as Error).message,
      });
      return;
    }
    entries.sort((a, b) => compareStrings(a.name, b.name));
    for (const entry of entries) {
      if (files.length >= limits.maxFiles) {
        truncated = true;
        return;
      }
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const childAbs = path.join(dir, entry.name);
      if (!limits.includeHidden && entry.name.startsWith(".")) {
        skipped.push({
          rel: childRel,
          reason: "hidden",
          detail: "a dot-file or dot-directory; pass includeHidden to scan it",
        });
        continue;
      }
      if (entry.isSymbolicLink()) {
        // Never followed, for containment and to make cycles impossible —
        // but named, so the caller knows this path went unread.
        skipped.push({
          rel: childRel,
          reason: "symlink",
          detail: "a symbolic link; links are never followed, so its target was not scanned",
        });
        continue;
      }
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) {
          skipped.push({
            rel: childRel,
            reason: "excluded-directory",
            detail: `"${entry.name}" is excluded by default; nothing under it was scanned`,
          });
          continue;
        }
        visit(childAbs, childRel, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        skipped.push({
          rel: childRel,
          reason: "unreadable",
          detail: "not a regular file (socket, fifo or device); nothing was read from it",
        });
        continue;
      }
      const outcome = readTextBounded(toolName, childAbs, limits.maxFileBytes);
      if (!outcome.ok) {
        skipped.push({ rel: childRel, reason: outcome.reason, detail: outcome.detail });
        continue;
      }
      files.push({ rel: childRel, abs: childAbs, bytes: outcome.bytes, text: outcome.text });
    }
  };

  visit(root.real, "", 1);
  files.sort((a, b) => compareStrings(a.rel, b.rel));
  skipped.sort((a, b) => compareStrings(a.rel, b.rel) || compareStrings(a.reason, b.reason));
  return { files, skipped, truncated, depthLimited };
}

/** Relative, slash-separated label for a path inside the workspace. */
export function relLabel(safe: SafePath): string {
  return safe.rel === "" ? "." : toPosix(safe.rel);
}
