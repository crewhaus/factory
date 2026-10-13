/**
 * Walking a directory, bounded.
 *
 * Every tool here that looks at more than one file comes through this, so one
 * set of limits holds everywhere: a file ceiling, a depth ceiling, a per-file
 * byte ceiling, and a skip list that keeps `node_modules` and build output
 * from turning "scan src" into "scan the universe".
 *
 * Symlinked directories are not followed. Containment is already enforced on
 * the root by `./run`, and following a link from inside the tree is exactly
 * how a walk leaves it (or loops forever); a caller who wants the target
 * scanned can point a tool at it directly.
 */
import { readdirSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import { openForReadSync } from "@crewhaus/tool-safety/fs";
import { workspaceRoot } from "./paths";

/** Directories skipped unless the caller names them explicitly. */
export const DEFAULT_IGNORES: readonly string[] = [
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".venv",
  ".worktrees",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
  "venv",
];

/** Source extensions the code-intelligence tools understand. */
export const SOURCE_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

/** Largest single file any tool here reads into memory. */
export const MAX_FILE_BYTES = 2_000_000;
/** Largest number of files one call will visit. */
export const DEFAULT_MAX_FILES = 5_000;

export type WalkOptions = {
  readonly root: string;
  /** Lowercase extensions, with the dot. Empty means every file. */
  readonly extensions?: readonly string[];
  readonly ignore?: readonly string[];
  readonly maxFiles?: number;
  readonly maxDepth?: number;
  readonly includeHidden?: boolean;
};

export type WalkResult = {
  /** Slash-separated paths relative to `root`, sorted. */
  readonly files: readonly string[];
  /** True when the file ceiling stopped the walk early. */
  readonly truncated: boolean;
};

/** Every matching file under `root`, sorted, bounded. */
export function walkFiles(options: WalkOptions): WalkResult {
  const ignore = new Set(options.ignore ?? DEFAULT_IGNORES);
  const extensions = options.extensions ?? [];
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = options.maxDepth ?? 24;
  const files: string[] = [];
  let truncated = false;

  const visit = (dir: string, rel: string, depth: number): void => {
    if (truncated || depth > maxDepth) return;
    // Structural, not `Dirent[]`: the node typings make `Dirent` generic over
    // the encoding and the inferred parameter differs between versions.
    type Entry = {
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
      isSymbolicLink(): boolean;
    };
    let entries: Entry[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Entry[];
    } catch {
      return; // unreadable directory: skipped, not fatal
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (truncated) return;
      const name = entry.name;
      // Dotfiles and dot-directories are skipped unless asked for: they are
      // caches, editor state and VCS internals far more often than sources.
      if (!(options.includeHidden ?? false) && name.startsWith(".")) continue;
      if (ignore.has(name)) continue;
      if (entry.isSymbolicLink()) continue;
      const child = path.join(dir, name);
      const childRel = rel === "" ? name : `${rel}/${name}`;
      if (entry.isDirectory()) {
        visit(child, childRel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (extensions.length > 0) {
        const ext = path.extname(name).toLowerCase();
        if (!extensions.includes(ext)) continue;
      }
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      files.push(childRel);
    }
  };

  visit(options.root, "", 0);
  return { files: files.sort(), truncated };
}

/** A file a tool looked for and did not read, with the reason, for its result. */
export type SkippedFile = {
  /** Slash-separated, relative to the workspace root. */
  readonly file: string;
  readonly reason: string;
};

/**
 * Read a text file, or `undefined` when it is missing, too large, not text,
 * or not a file this package may read.
 *
 * This is the package's one read, so it is where containment of the LEAF
 * lives (C072). The tools contain the directory a caller names, then look
 * for fixed names in it — package.json, requirements.txt, a lockfile, a
 * coverage report — and a planted `requirements.txt -> ~/.aws/credentials`
 * sits exactly there. So the read goes through @crewhaus/tool-safety's
 * `openForReadSync`: the whole path is resolved physically and must land in
 * the workspace (a link to another file INSIDE it is still followed), a
 * FIFO or device is refused before it is opened (a FIFO named
 * requirements.txt used to block the process for good), and never more than
 * `maxBytes` plus one byte is read.
 *
 * "Not text" is decided by a NUL byte in the first kilobyte, the same cheap
 * test `grep` uses: a scanner handed a binary blob produces nonsense matches,
 * and a caller is better told the file was skipped.
 *
 * Pass `skipped` to learn why an existing file was not read: a tool that
 * reports "no manifest" when one was refused would be answering a different
 * question. A missing file is never listed.
 */
export function readTextFile(
  abs: string,
  maxBytes = MAX_FILE_BYTES,
  skipped?: SkippedFile[],
): string | undefined {
  const r = readLeaf(abs, maxBytes);
  if (r.ok) return r.text;
  if (r.reason !== undefined && skipped !== undefined) {
    skipped.push({ file: workspaceRel(abs), reason: r.reason });
  }
  return undefined;
}

/** `abs` relative to the workspace root, slash-separated, for a result. */
function workspaceRel(abs: string): string {
  let root = workspaceRoot();
  try {
    root = realpathSync(root);
  } catch {
    // The lexical root is the best name available.
  }
  const rel = path.relative(root, abs);
  return (rel === "" ? "." : rel).split(path.sep).join("/");
}

type LeafRead = { ok: true; text: string } | { ok: false; reason?: string };

function readLeaf(abs: string, maxBytes: number): LeafRead {
  const r = openForReadSync(workspaceRoot(), abs, { maxBytes });
  if (!r.ok) {
    switch (r.code) {
      case "not-found":
        return { ok: false };
      case "escapes-root":
        return {
          ok: false,
          reason: "it resolves outside the workspace (a link leading out); not read",
        };
      case "not-regular-file":
        return {
          ok: false,
          reason: `it is a ${r.kind ?? "special file"}, not a regular file; not read`,
        };
      default:
        return { ok: false, reason: `it could not be read (${r.code})` };
    }
  }
  if (r.truncated) return { ok: false, reason: `it is larger than ${maxBytes} bytes; not read` };
  if (r.bytes.subarray(0, Math.min(1024, r.bytes.length)).includes(0)) {
    return { ok: false, reason: "it is not a text file; not read" };
  }
  return { ok: true, text: r.text };
}

/** True when a path exists and is a file. */
export function fileExists(abs: string): boolean {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}
