/**
 * @crewhaus/tool-fsx — the filesystem work that is not read, write or edit.
 *
 * `@crewhaus/tool-fs` covers a file's contents. This package covers
 * everything around them: what a path IS (`Stat`, `FileHash`), what a tree
 * contains (`Tree`, `FindFiles`, `DiskUsage`), moving bytes about
 * (`CopyPath`, `MovePath`, `RemovePath`, `SplitFile`, `ConcatFiles`),
 * archives, and two file formats a harness edits constantly and a model
 * should not have to hand-parse (markdown front matter, Jupyter notebooks).
 *
 * Three properties hold across the package:
 *
 *   1. CONTAINMENT. Every caller-supplied path goes through `resolveSafe`,
 *      which refuses anything resolving outside `process.cwd()`, including
 *      via a symlink inside the workspace. Archive extraction additionally
 *      refuses members whose names would escape the destination.
 *   2. DETERMINISM. The same call against the same tree returns the same
 *      bytes: listings are sorted with plain string comparison, time bounds
 *      come from the caller rather than the clock, and nothing samples a
 *      random source except the temp suffix of an atomic write.
 *   3. SAFETY FLAGS THAT MEAN SOMETHING. Reads are `readOnly` +
 *      `concurrencySafe`; anything that writes is `destructive` and not
 *      concurrency-safe; the two tools that spawn `tar`/`zip` declare
 *      `scope: "external"` and `ioCapability: "process"`.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  type Dirent,
  closeSync,
  copyFileSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from "node:fs";
import * as path from "node:path";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import {
  type ArchiveEntry,
  type ArchiveFormat,
  ArchiveFormatError,
  detectArchiveFormat,
  readArchiveEntries,
} from "./lib/archive-format";
import {
  type TreeNode,
  formatBytes,
  formatModeOctal,
  formatModeSymbolic,
  isoFromMs,
  parseInstant,
  renderTree,
} from "./lib/format";
import {
  type FrontmatterData,
  FrontmatterError,
  type FrontmatterValue,
  parseFrontmatter,
  renderDocument,
  serializeFrontmatter,
  splitFrontmatter,
} from "./lib/frontmatter";
import { matchGlob } from "./lib/glob";
import {
  NotebookError,
  applyNotebookEdit,
  cellSource,
  parseNotebook,
  serializeNotebook,
  summarizeOutputs,
} from "./lib/notebook";
import {
  type SafePath,
  ToolPermissionError,
  archiveEntryEscapes,
  isInside,
  resolveSafe,
  workspaceRoot,
} from "./paths";
import {
  DEFAULT_PROCESS_TIMEOUT_MS,
  MAX_PROCESS_TIMEOUT_MS,
  describeFailure,
  runProcess,
} from "./proc";
import { type WalkNode, type WalkOptions, compareStrings, rollUpSizes, walkTree } from "./walk";

/** Compact JSON — the reader is a model, and every byte is context. */
const json = (value: unknown): string => JSON.stringify(value);

/** Whole-file reads (notebooks, front matter) refuse anything larger. */
const MAX_WHOLE_FILE_BYTES = 32 * 1024 * 1024;
/** An archive is parsed in memory, and a gzip member is expanded there too. */
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
/** Chunk size for every streaming read; bounded memory regardless of file size. */
const CHUNK_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/**
 * Open a validated path with `O_NOFOLLOW`. `resolveSafe` already proved the
 * path is inside the workspace, but the leaf could be swapped for a symlink
 * afterwards (CWE-367); refusing to follow it at open closes that window.
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

/** Feed a file to `onChunk` in fixed-size pieces, never holding it all at once. */
function streamFile(fd: number, onChunk: (chunk: Buffer, length: number) => void): number {
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let position = 0;
  for (;;) {
    const read = readSync(fd, buffer, 0, CHUNK_BYTES, position);
    if (read <= 0) break;
    onChunk(buffer, read);
    position += read;
  }
  return position;
}

/** Hash a file without loading it: fixed-size chunks into the digest. */
function hashFile(
  toolName: string,
  abs: string,
  algorithm: string,
): { hex: string; bytes: number } {
  const hasher = createHash(algorithm);
  const fd = openNoFollow(toolName, abs);
  try {
    const bytes = streamFile(fd, (chunk, length) => {
      hasher.update(chunk.subarray(0, length));
    });
    return { hex: hasher.digest("hex"), bytes };
  } finally {
    closeSync(fd);
  }
}

/** Read a whole file, refusing anything over `limit`. */
function readWholeFile(toolName: string, abs: string, limit: number): Buffer {
  const fd = openNoFollow(toolName, abs);
  try {
    const { size } = fstatSync(fd);
    if (size > limit) {
      throw new Error(
        `"${abs}" is ${formatBytes(size)}, over this tool's ${formatBytes(limit)} limit`,
      );
    }
    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, buffer, offset, size - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    return offset === size ? buffer : buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

/** Replace a file's contents atomically: write a sibling, then rename over it. */
function writeAtomic(abs: string, contents: string | Uint8Array): void {
  const tmp = `${abs}.tmp.${randomBytes(6).toString("hex")}`;
  try {
    const fd = openSync(tmp, "w", 0o600);
    try {
      const bytes =
        typeof contents === "string" ? Buffer.from(contents, "utf8") : Buffer.from(contents);
      let written = 0;
      while (written < bytes.length) {
        written += writeSync(fd, bytes, written, bytes.length - written);
      }
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, abs);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing to clean up.
    }
    throw err;
  }
}

type Existing = { kind: "file" | "dir" | "symlink" | "other"; size: number; mtimeMs: number };

/** lstat without throwing: undefined when the path is not there. */
function peek(abs: string): Existing | undefined {
  try {
    const stat = lstatSync(abs);
    const kind = stat.isSymbolicLink()
      ? "symlink"
      : stat.isDirectory()
        ? "dir"
        : stat.isFile()
          ? "file"
          : "other";
    return { kind, size: stat.isFile() ? stat.size : 0, mtimeMs: Math.floor(stat.mtimeMs) };
  } catch {
    return undefined;
  }
}

/** Walk options for an exhaustive internal walk (copy, remove, disk usage). */
function exhaustiveWalk(maxEntries: number): WalkOptions {
  return {
    maxDepth: 64,
    maxEntries,
    respectGitignore: false,
    includeHidden: true,
    exclude: [],
  };
}

/** The shared schema fragment for the listing tools. */
const listingFields = {
  respectGitignore: z
    .boolean()
    .optional()
    .describe("apply .gitignore rules found in the walked tree (default true)"),
  includeHidden: z.boolean().optional().describe("include dot-files and dot-directories"),
  exclude: z
    .array(z.string().min(1))
    .max(100)
    .optional()
    .describe("glob patterns; an entry matching one by name or relative path is skipped"),
};

// ---------------------------------------------------------------------------
// inspecting a path
// ---------------------------------------------------------------------------

export const stat: RegisteredTool = buildTool({
  name: "Stat",
  description:
    "Report what a path is: type, size, mtime, permissions, link count, symlink target and a sha256 of its contents. Use it before a conditional write — re-Stat later and a changed hash means somebody else touched the file.",
  inputSchema: z.object({
    path: z.string().min(1),
    hash: z
      .boolean()
      .optional()
      .describe("compute the sha256 of a regular file (default true, skipped above 256 MiB)"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const target = resolveSafe("Stat", input.path);
    // lstat on the LEXICAL path, so a symlink is reported as itself rather
    // than silently described as whatever it points at.
    const info = peek(target.abs);
    if (info === undefined) {
      return json({ path: target.rel, exists: false });
    }
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(target.abs);
    } catch {
      // Removed between the two calls; report it gone rather than throwing.
      return json({ path: target.rel, exists: false });
    }
    const base: Record<string, unknown> = {
      path: target.rel,
      exists: true,
      type: info.kind,
      size: stats.size,
      sizeHuman: formatBytes(stats.size),
      mtime: isoFromMs(stats.mtimeMs),
      ctime: isoFromMs(stats.ctimeMs),
      mode: formatModeOctal(stats.mode),
      permissions: formatModeSymbolic(stats.mode),
      links: stats.nlink,
    };
    if (info.kind === "symlink") {
      const linkText = readlinkSync(target.abs);
      const resolved = path.resolve(path.dirname(target.abs), linkText);
      base["linkTarget"] = linkText;
      // Ask the containment guard rather than comparing strings: the
      // workspace root and the link may spell the same place differently
      // when a parent directory is itself a symlink (as /tmp is on macOS).
      base["linkTargetInsideWorkspace"] = ((): boolean => {
        try {
          // Compare REAL paths: the root and the link can spell the same
          // place differently when a parent is itself a symlink, as the
          // per-user temp directory is on macOS.
          const parent = realpathSync(path.dirname(resolved));
          return isInside(
            realpathSync(workspaceRoot()),
            path.join(parent, path.basename(resolved)),
          );
        } catch {
          return false;
        }
      })();
      base["linkBroken"] = !existsSync(target.abs);
      return json(base);
    }
    if (info.kind === "file" && input.hash !== false) {
      if (stats.size > 256 * 1024 * 1024) {
        base["sha256"] = null;
        base["sha256Note"] = "skipped: file is over 256 MiB — call FileHash explicitly to hash it";
      } else {
        base["sha256"] = hashFile("Stat", target.real, "sha256").hex;
      }
    }
    return json(base);
  },
});

export const fileHash: RegisteredTool = buildTool({
  name: "FileHash",
  description:
    "Hash a file with sha256, sha1 or md5, reading it in fixed-size chunks so size does not matter. Use it to compare two files without reading either into context, or to record a checksum a later run can re-check.",
  inputSchema: z.object({
    path: z.string().min(1),
    algorithm: z.enum(["sha256", "sha1", "md5"]).optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const target = resolveSafe("FileHash", input.path);
    const info = peek(target.abs);
    if (info === undefined) return `no such file: ${target.rel}`;
    if (info.kind !== "file") return `${target.rel} is a ${info.kind}, not a regular file`;
    const algorithm = input.algorithm ?? "sha256";
    const result = hashFile("FileHash", target.real, algorithm);
    return json({ path: target.rel, algorithm, hash: result.hex, bytes: result.bytes });
  },
});

// ---------------------------------------------------------------------------
// listing a tree
// ---------------------------------------------------------------------------

function toTreeNodes(nodes: ReadonlyArray<WalkNode>, showSizes: boolean): TreeNode[] {
  return nodes.map((node) => {
    const elided =
      node.depthLimited === true
        ? "…(depth limit)"
        : node.droppedChildren !== undefined
          ? `…(${node.droppedChildren} more)`
          : undefined;
    return {
      name: node.name,
      kind: node.kind === "other" ? "file" : node.kind,
      ...(showSizes && node.kind === "file" ? { size: node.size } : {}),
      ...(node.children !== undefined ? { children: toTreeNodes(node.children, showSizes) } : {}),
      ...(elided !== undefined ? { elided } : {}),
    };
  });
}

export const tree: RegisteredTool = buildTool({
  name: "Tree",
  description:
    "Draw a directory as an indented tree, depth-capped, entry-capped and sorted. Use it to learn a project's shape in one call instead of a dozen listings, with .gitignore applied so vendored and build output stay out of the way.",
  inputSchema: z.object({
    path: z.string().optional().describe("directory to draw; defaults to the workspace root"),
    maxDepth: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("levels of entries to show, as `tree -L` counts them (default 3)"),
    maxEntries: z.number().int().min(1).max(20_000).optional().describe("hard cap (default 500)"),
    sizes: z.boolean().optional().describe("show each file's size (default true)"),
    ...listingFields,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const target = resolveSafe("Tree", input.path ?? ".");
    const info = peek(target.abs);
    if (info === undefined) return `no such directory: ${target.rel === "" ? "." : target.rel}`;
    if (info.kind !== "dir") return `${target.rel} is a ${info.kind}, not a directory`;

    const result = walkTree(target.real, {
      maxDepth: input.maxDepth ?? 3,
      maxEntries: input.maxEntries ?? 500,
      respectGitignore: input.respectGitignore ?? true,
      includeHidden: input.includeHidden ?? false,
      exclude: input.exclude ?? [],
    });
    const files = result.entries.filter((e) => e.kind === "file").length;
    const directories = result.entries.filter((e) => e.kind === "dir").length;
    const label = target.rel === "" ? "." : target.rel;
    const body = renderTree(
      `${label}/`,
      toTreeNodes(result.root.children ?? [], input.sizes !== false),
    );
    const footer = `\n\n${directories} director${directories === 1 ? "y" : "ies"}, ${files} file${files === 1 ? "" : "s"}${
      result.truncated ? " (listing cut short by a depth or entry cap)" : ""
    }`;
    // Plain text rather than JSON: a tree is read by eye, and escaping every
    // newline into a JSON string would double its size for no one's benefit.
    return body + footer;
  },
});

export const diskUsage: RegisteredTool = buildTool({
  name: "DiskUsage",
  description:
    "Total the apparent size of every directory in a tree and list them largest-first. Use it to find what is actually taking the space before deleting anything.",
  inputSchema: z.object({
    path: z.string().optional(),
    maxDepth: z.number().int().min(0).max(20).optional().describe("how deep to REPORT (default 2)"),
    top: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("how many directories to list (default 20)"),
    maxEntries: z
      .number()
      .int()
      .min(1)
      .max(500_000)
      .optional()
      .describe("cap on entries visited while totalling (default 100000)"),
    ...listingFields,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const target = resolveSafe("DiskUsage", input.path ?? ".");
    const info = peek(target.abs);
    if (info === undefined) return `no such directory: ${target.rel === "" ? "." : target.rel}`;
    if (info.kind !== "dir") return `${target.rel} is a ${info.kind}, not a directory`;

    // The walk must be exhaustive for the totals to be true; `maxDepth` only
    // controls how much of the result is REPORTED.
    const result = walkTree(target.real, {
      maxDepth: 64,
      maxEntries: input.maxEntries ?? 100_000,
      respectGitignore: input.respectGitignore ?? true,
      includeHidden: input.includeHidden ?? true,
      exclude: input.exclude ?? [],
    });
    const totals = rollUpSizes(result.root);
    const reportDepth = input.maxDepth ?? 2;
    const rows = [...totals.entries()]
      .filter(([rel]) => rel !== "" && rel.split("/").length <= reportDepth)
      .map(([rel, value]) => ({
        path: rel,
        bytes: value.bytes,
        size: formatBytes(value.bytes),
        files: value.files,
      }))
      // Largest first; ties broken by path so the order never wobbles.
      .sort((a, b) => b.bytes - a.bytes || compareStrings(a.path, b.path))
      .slice(0, input.top ?? 20);
    const root = totals.get("") ?? { bytes: 0, files: 0 };
    return json({
      root: target.rel === "" ? "." : target.rel,
      totalBytes: root.bytes,
      totalSize: formatBytes(root.bytes),
      files: root.files,
      truncated: result.truncated,
      directories: rows,
    });
  },
});

export const findFiles: RegisteredTool = buildTool({
  name: "FindFiles",
  description:
    "Find entries by name glob, size range, modification window and type, sorted by path. Use it when Glob's name matching is not enough — time and size bounds come from you as ISO strings and byte counts, never from the clock.",
  inputSchema: z.object({
    path: z.string().optional().describe("directory to search; defaults to the workspace root"),
    name: z
      .string()
      .optional()
      .describe(
        "glob; matched against the basename, or against the relative path when it contains /",
      ),
    type: z.enum(["file", "dir", "symlink", "any"]).optional().describe("default 'file'"),
    minSize: z.number().int().min(0).optional().describe("bytes, inclusive"),
    maxSize: z.number().int().min(0).optional().describe("bytes, inclusive"),
    modifiedAfter: z.string().optional().describe("ISO-8601 instant, inclusive lower bound"),
    modifiedBefore: z.string().optional().describe("ISO-8601 instant, inclusive upper bound"),
    maxDepth: z.number().int().min(1).max(64).optional().describe("default 20"),
    limit: z.number().int().min(1).max(5000).optional().describe("default 200"),
    maxEntries: z
      .number()
      .int()
      .min(1)
      .max(500_000)
      .optional()
      .describe("entries visited (default 50000)"),
    ...listingFields,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const target = resolveSafe("FindFiles", input.path ?? ".");
    const info = peek(target.abs);
    if (info === undefined) return `no such directory: ${target.rel === "" ? "." : target.rel}`;
    if (info.kind !== "dir") return `${target.rel} is a ${info.kind}, not a directory`;

    let after: number | undefined;
    let before: number | undefined;
    if (input.modifiedAfter !== undefined) {
      after = parseInstant(input.modifiedAfter);
      if (after === undefined)
        return `modifiedAfter is not a date I can read: ${input.modifiedAfter}`;
    }
    if (input.modifiedBefore !== undefined) {
      before = parseInstant(input.modifiedBefore);
      if (before === undefined)
        return `modifiedBefore is not a date I can read: ${input.modifiedBefore}`;
    }
    if (after !== undefined && before !== undefined && after > before) {
      return "modifiedAfter is later than modifiedBefore, so nothing could match";
    }

    const result = walkTree(target.real, {
      maxDepth: input.maxDepth ?? 20,
      maxEntries: input.maxEntries ?? 50_000,
      respectGitignore: input.respectGitignore ?? true,
      includeHidden: input.includeHidden ?? false,
      exclude: input.exclude ?? [],
    });

    const wantType = input.type ?? "file";
    const namePattern = input.name;
    const matches = result.entries.filter((entry) => {
      if (wantType !== "any" && entry.kind !== wantType) return false;
      if (namePattern !== undefined) {
        const subject = namePattern.includes("/") ? entry.rel : entry.name;
        if (!matchGlob(namePattern, subject)) return false;
      }
      if (input.minSize !== undefined && entry.size < input.minSize) return false;
      if (input.maxSize !== undefined && entry.size > input.maxSize) return false;
      if (after !== undefined && entry.mtimeMs < after) return false;
      if (before !== undefined && entry.mtimeMs > before) return false;
      return true;
    });
    const limit = input.limit ?? 200;
    const shown = [...matches].sort((a, b) => compareStrings(a.rel, b.rel)).slice(0, limit);
    return json({
      root: target.rel === "" ? "." : target.rel,
      count: matches.length,
      truncated: matches.length > shown.length || result.truncated,
      matches: shown.map((entry) => ({
        path: entry.rel,
        type: entry.kind,
        size: entry.size,
        mtime: isoFromMs(entry.mtimeMs),
      })),
    });
  },
});

// ---------------------------------------------------------------------------
// reading part of a file
// ---------------------------------------------------------------------------

export const readLines: RegisteredTool = buildTool({
  name: "ReadLines",
  description:
    "Return a numbered line range from a file, reading only as far as the range needs. Use it to look at one region of a large log or data file without pulling the whole thing into context.",
  inputSchema: z.object({
    path: z.string().min(1),
    start: z.number().int().min(1).optional().describe("first line, 1-based (default 1)"),
    end: z.number().int().min(1).optional().describe("last line, inclusive"),
    maxLines: z
      .number()
      .int()
      .min(1)
      .max(20_000)
      .optional()
      .describe("cap on lines returned (default 500)"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const target = resolveSafe("ReadLines", input.path);
    const info = peek(target.abs);
    if (info === undefined) return `no such file: ${target.rel}`;
    if (info.kind !== "file") return `${target.rel} is a ${info.kind}, not a regular file`;

    const start = input.start ?? 1;
    const maxLines = input.maxLines ?? 500;
    const end = Math.min(input.end ?? start + maxLines - 1, start + maxLines - 1);
    if (end < start) return `end (${end}) is before start (${start})`;

    const fd = openNoFollow("ReadLines", target.real);
    const lines: string[] = [];
    let lineNo = 0;
    let carry = "";
    let reachedEnd = false;
    try {
      const decoder = new TextDecoder("utf-8");
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      let position = 0;
      for (;;) {
        const read = readSync(fd, buffer, 0, CHUNK_BYTES, position);
        if (read <= 0) break;
        position += read;
        // `stream: true` keeps a multi-byte character split across a chunk
        // boundary intact instead of decoding it into replacement characters.
        carry += decoder.decode(buffer.subarray(0, read), { stream: true });
        let cut = carry.indexOf("\n");
        while (cut !== -1) {
          lineNo += 1;
          const line = carry.slice(0, cut);
          carry = carry.slice(cut + 1);
          if (lineNo >= start && lineNo <= end) lines.push(line);
          if (lineNo >= end) {
            reachedEnd = true;
            break;
          }
          cut = carry.indexOf("\n");
        }
        if (reachedEnd) break;
      }
      if (!reachedEnd) {
        carry += decoder.decode();
        if (carry !== "") {
          lineNo += 1;
          if (lineNo >= start && lineNo <= end) lines.push(carry);
        }
      }
    } finally {
      closeSync(fd);
    }
    return json({
      path: target.rel,
      start,
      end: start + lines.length - 1,
      requestedEnd: end,
      lines,
      returned: lines.length,
      // True when the file ran out before the requested end — the caller
      // knows there is nothing more to ask for.
      endOfFile: !reachedEnd,
    });
  },
});

export const tailFile: RegisteredTool = buildTool({
  name: "TailFile",
  description:
    "Return the last N lines of a file, read backwards from the end. Use it on a log whose interesting part is always at the bottom, where reading forwards would cost the whole file.",
  inputSchema: z.object({
    path: z.string().min(1),
    lines: z.number().int().min(1).max(5000).optional().describe("how many lines (default 50)"),
    maxBytes: z
      .number()
      .int()
      .min(1024)
      .max(64 * 1024 * 1024)
      .optional()
      .describe("how far back to scan before giving up (default 1 MiB)"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const target = resolveSafe("TailFile", input.path);
    const info = peek(target.abs);
    if (info === undefined) return `no such file: ${target.rel}`;
    if (info.kind !== "file") return `${target.rel} is a ${info.kind}, not a regular file`;

    const wanted = input.lines ?? 50;
    const scanLimit = input.maxBytes ?? 1024 * 1024;
    const fd = openNoFollow("TailFile", target.real);
    let text: string;
    let scanned = 0;
    let hitStart = false;
    try {
      const size = fstatSync(fd).size;
      const pieces: Buffer[] = [];
      let position = size;
      let newlines = 0;
      while (position > 0 && scanned < scanLimit && newlines <= wanted) {
        const length = Math.min(CHUNK_BYTES, position, scanLimit - scanned);
        position -= length;
        const buffer = Buffer.allocUnsafe(length);
        const read = readSync(fd, buffer, 0, length, position);
        pieces.unshift(buffer.subarray(0, read));
        scanned += read;
        for (let i = 0; i < read; i++) {
          if (buffer[i] === 0x0a) newlines += 1;
        }
      }
      hitStart = position === 0;
      // Concatenate the raw bytes and decode ONCE, so a multi-byte character
      // straddling two backwards reads is not mangled.
      text = Buffer.concat(pieces).toString("utf8");
    } finally {
      closeSync(fd);
    }

    const withoutFinalNewline = text.endsWith("\n") ? text.slice(0, -1) : text;
    const all = withoutFinalNewline === "" ? [] : withoutFinalNewline.split("\n");
    // The first line of a partial scan is very likely cut in half; drop it.
    const usable = hitStart ? all : all.slice(1);
    const lines = usable.slice(Math.max(0, usable.length - wanted));
    return json({
      path: target.rel,
      lines,
      returned: lines.length,
      bytesScanned: scanned,
      wholeFileScanned: hitStart,
    });
  },
});

// ---------------------------------------------------------------------------
// creating paths
// ---------------------------------------------------------------------------

export const makeDirectory: RegisteredTool = buildTool({
  name: "MakeDirectory",
  description:
    "Create a directory inside the workspace, with its parents when asked. Use it before writing output rather than discovering the parent is missing when the write fails.",
  inputSchema: z.object({
    path: z.string().min(1),
    parents: z.boolean().optional().describe("create missing parent directories (default true)"),
  }),
  destructive: true,
  execute: async (input) => {
    const target = resolveSafe("MakeDirectory", input.path);
    const existing = peek(target.abs);
    if (existing !== undefined) {
      if (existing.kind === "dir") return json({ path: target.rel, created: false, existed: true });
      return `${target.rel} already exists and is a ${existing.kind}, not a directory`;
    }
    try {
      mkdirSync(target.abs, { recursive: input.parents !== false });
    } catch (err) {
      return `could not create ${target.rel}: ${(err as Error).message}`;
    }
    return json({ path: target.rel, created: true, existed: false });
  },
});

export const touchFile: RegisteredTool = buildTool({
  name: "TouchFile",
  description:
    "Create an empty file if it is missing, and set its timestamps when you supply one. Use it to make a marker or placeholder file; with no `mtime` an existing file is left exactly as it is, because bumping it from the clock would make this call's result differ every run.",
  inputSchema: z.object({
    path: z.string().min(1),
    mtime: z
      .string()
      .optional()
      .describe("ISO-8601 instant to set as the access and modification time"),
    parents: z.boolean().optional().describe("create missing parent directories (default false)"),
  }),
  destructive: true,
  execute: async (input) => {
    const target = resolveSafe("TouchFile", input.path);
    let when: number | undefined;
    if (input.mtime !== undefined) {
      when = parseInstant(input.mtime);
      if (when === undefined) return `mtime is not a date I can read: ${input.mtime}`;
    }
    const existing = peek(target.abs);
    if (existing !== undefined && existing.kind !== "file") {
      return `${target.rel} already exists and is a ${existing.kind}, not a regular file`;
    }
    if (input.parents === true) {
      mkdirSync(path.dirname(target.abs), { recursive: true });
    }
    let created = false;
    if (existing === undefined) {
      try {
        closeSync(openSync(target.abs, "a"));
        created = true;
      } catch (err) {
        return `could not create ${target.rel}: ${(err as Error).message}`;
      }
    }
    if (when !== undefined) {
      const seconds = when / 1000;
      utimesSync(target.abs, seconds, seconds);
    }
    return json({
      path: target.rel,
      created,
      timestampsSet: when !== undefined,
      ...(when !== undefined ? { mtime: isoFromMs(when) } : {}),
    });
  },
});

const TEMP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const tempDir: RegisteredTool = buildTool({
  name: "TempDir",
  description:
    "Create a scratch directory inside the workspace under a name you choose, and report its path. Use it as somewhere to stage intermediate files; the name comes from you rather than a random suffix so the same call twice gives the same directory instead of littering.",
  inputSchema: z.object({
    name: z
      .string()
      .min(1)
      .max(64)
      .describe("directory name; letters, digits, dot, dash and underscore only"),
    base: z.string().optional().describe("parent directory inside the workspace (default '.tmp')"),
    clear: z.boolean().optional().describe("empty the directory first if it already exists"),
  }),
  destructive: true,
  execute: async (input) => {
    if (!TEMP_NAME.test(input.name)) {
      return `"${input.name}" is not a usable directory name — letters, digits, '.', '-' and '_' only, and it may not start with a dot`;
    }
    const base = input.base ?? ".tmp";
    const target = resolveSafe("TempDir", path.join(base, input.name));
    const existing = peek(target.abs);
    if (existing !== undefined && existing.kind !== "dir") {
      return `${target.rel} already exists and is a ${existing.kind}, not a directory`;
    }
    let cleared = false;
    if (existing !== undefined && input.clear === true) {
      rmSync(target.abs, { recursive: true, force: true });
      cleared = true;
    }
    mkdirSync(target.abs, { recursive: true });
    return json({
      path: target.rel,
      created: existing === undefined || cleared,
      existed: existing !== undefined,
      cleared,
    });
  },
});

// ---------------------------------------------------------------------------
// moving bytes about
// ---------------------------------------------------------------------------

type PlanEntry = {
  readonly rel: string;
  readonly kind: WalkNode["kind"];
  readonly size: number;
  readonly sourceAbs: string;
  readonly destAbs: string;
};

type CopyPlan = {
  readonly entries: PlanEntry[];
  readonly bytes: number;
  readonly truncated: boolean;
  /** Destination paths that already exist and would be replaced. */
  readonly conflicts: string[];
};

/**
 * Enumerate exactly what a copy or move would touch, before touching any of
 * it. Having the plan first is what makes `dryRun` truthful and what lets an
 * overwrite conflict be refused before half the tree has been written.
 */
function buildPlan(source: SafePath, destination: SafePath, maxEntries: number): CopyPlan | string {
  const info = peek(source.abs);
  if (info === undefined) return `no such path: ${source.rel}`;
  const entries: PlanEntry[] = [];
  let bytes = 0;
  let truncated = false;

  if (info.kind === "dir") {
    const walked = walkTree(source.real, exhaustiveWalk(maxEntries));
    truncated = walked.truncated;
    entries.push({
      rel: "",
      kind: "dir",
      size: 0,
      sourceAbs: source.abs,
      destAbs: destination.abs,
    });
    for (const node of walked.entries) {
      const destAbs = path.join(destination.abs, ...node.rel.split("/"));
      // Belt and braces: a walked relative path can never contain `..`, but
      // the destination is caller-supplied, so re-assert containment.
      if (!isInside(destination.abs, destAbs)) {
        return `refusing to write outside the destination: ${node.rel}`;
      }
      entries.push({
        rel: node.rel,
        kind: node.kind,
        size: node.size,
        sourceAbs: node.abs,
        destAbs,
      });
      bytes += node.kind === "file" ? node.size : 0;
    }
  } else {
    entries.push({
      rel: "",
      kind: info.kind,
      size: info.size,
      sourceAbs: source.abs,
      destAbs: destination.abs,
    });
    bytes = info.size;
  }

  const conflicts = entries
    .filter((entry) => entry.kind !== "dir" && peek(entry.destAbs) !== undefined)
    .map((entry) => path.relative(workspaceRoot(), entry.destAbs))
    .sort(compareStrings);
  return { entries, bytes, truncated, conflicts };
}

function applyPlan(plan: CopyPlan): void {
  for (const entry of plan.entries) {
    if (entry.kind === "dir") {
      mkdirSync(entry.destAbs, { recursive: true });
      continue;
    }
    mkdirSync(path.dirname(entry.destAbs), { recursive: true });
    const existing = peek(entry.destAbs);
    if (existing !== undefined) {
      rmSync(entry.destAbs, { recursive: true, force: true });
    }
    if (entry.kind === "symlink") {
      // Copy the LINK, not what it points at. Dereferencing here would let a
      // link that points outside the workspace pull outside content in.
      symlinkSync(readlinkSync(entry.sourceAbs), entry.destAbs);
      continue;
    }
    copyFileSync(entry.sourceAbs, entry.destAbs);
  }
}

const copyMoveSchema = {
  source: z.string().min(1),
  destination: z.string().min(1),
  overwrite: z.boolean().optional().describe("replace files that already exist at the destination"),
  dryRun: z.boolean().optional().describe("report what would happen and change nothing"),
  maxEntries: z
    .number()
    .int()
    .min(1)
    .max(500_000)
    .optional()
    .describe("cap on entries touched (default 50000)"),
};

export const copyPath: RegisteredTool = buildTool({
  name: "CopyPath",
  description:
    "Copy a file or a whole directory inside the workspace, refusing to overwrite unless told to. Use `dryRun` first on anything large — it lists every path that would be written and every one that already exists.",
  inputSchema: z.object(copyMoveSchema),
  destructive: true,
  execute: async (input) => {
    const source = resolveSafe("CopyPath", input.source);
    const destination = resolveSafe("CopyPath", input.destination);
    if (isInside(source.abs, destination.abs) && source.abs !== destination.abs) {
      return `refusing to copy ${source.rel} into itself (${destination.rel})`;
    }
    if (source.abs === destination.abs) return "source and destination are the same path";
    const plan = buildPlan(source, destination, input.maxEntries ?? 50_000);
    if (typeof plan === "string") return plan;
    if (plan.truncated) {
      return `${source.rel} has more entries than the cap allows — raise maxEntries or copy a subdirectory at a time`;
    }
    if (plan.conflicts.length > 0 && input.overwrite !== true) {
      return json({
        copied: false,
        reason: "destination exists",
        conflicts: plan.conflicts.slice(0, 50),
        conflictCount: plan.conflicts.length,
        hint: "pass overwrite: true to replace them",
      });
    }
    const summary = {
      source: source.rel,
      destination: destination.rel,
      files: plan.entries.filter((e) => e.kind === "file").length,
      directories: plan.entries.filter((e) => e.kind === "dir").length,
      symlinks: plan.entries.filter((e) => e.kind === "symlink").length,
      bytes: plan.bytes,
      size: formatBytes(plan.bytes),
      overwrites: plan.conflicts.length,
    };
    if (input.dryRun === true) {
      return json({
        ...summary,
        dryRun: true,
        copied: false,
        wouldOverwrite: plan.conflicts.slice(0, 50),
      });
    }
    applyPlan(plan);
    return json({ ...summary, dryRun: false, copied: true });
  },
});

export const movePath: RegisteredTool = buildTool({
  name: "MovePath",
  description:
    "Move or rename a file or directory inside the workspace, refusing to overwrite unless told to. Use `dryRun` to see what would be replaced before anything is gone.",
  inputSchema: z.object(copyMoveSchema),
  destructive: true,
  execute: async (input) => {
    const source = resolveSafe("MovePath", input.source);
    const destination = resolveSafe("MovePath", input.destination);
    if (source.abs === destination.abs) return "source and destination are the same path";
    if (isInside(source.abs, destination.abs)) {
      return `refusing to move ${source.rel} into itself (${destination.rel})`;
    }
    const existing = peek(source.abs);
    if (existing === undefined) return `no such path: ${source.rel}`;
    const destExisting = peek(destination.abs);
    if (destExisting !== undefined && input.overwrite !== true) {
      return json({
        moved: false,
        reason: "destination exists",
        destination: destination.rel,
        destinationType: destExisting.kind,
        hint: "pass overwrite: true to replace it",
      });
    }
    if (input.dryRun === true) {
      return json({
        source: source.rel,
        destination: destination.rel,
        dryRun: true,
        moved: false,
        wouldOverwrite: destExisting !== undefined,
      });
    }
    mkdirSync(path.dirname(destination.abs), { recursive: true });
    if (destExisting !== undefined) rmSync(destination.abs, { recursive: true, force: true });
    try {
      renameSync(source.abs, destination.abs);
    } catch (err) {
      // A workspace can straddle mount points (a bind-mounted cache, a
      // container volume), and rename(2) cannot cross one. Fall back to
      // copy-then-delete, which is what `mv` does in the same situation.
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") {
        return `could not move ${source.rel}: ${(err as Error).message}`;
      }
      const plan = buildPlan(source, destination, input.maxEntries ?? 50_000);
      if (typeof plan === "string") return plan;
      if (plan.truncated) {
        // The copy half of copy-then-delete would be partial, and the delete
        // half would then destroy the only complete copy. Stop before either.
        return `${source.rel} has more entries than the cap allows, and this move has to cross a filesystem boundary — raise maxEntries, or move subdirectories one at a time`;
      }
      applyPlan(plan);
      rmSync(source.abs, { recursive: true, force: true });
    }
    return json({
      source: source.rel,
      destination: destination.rel,
      dryRun: false,
      moved: true,
      overwrote: destExisting !== undefined,
    });
  },
});

export const removePath: RegisteredTool = buildTool({
  name: "RemovePath",
  description:
    "Delete a file, a symlink or (with `recursive`) a directory inside the workspace. Use `dryRun` first: it counts exactly what would go and returns the same summary the real call would, without deleting anything.",
  inputSchema: z.object({
    path: z.string().min(1),
    recursive: z.boolean().optional().describe("required to delete a directory that has contents"),
    dryRun: z.boolean().optional(),
    missingOk: z.boolean().optional().describe("succeed quietly when the path is not there"),
    maxEntries: z.number().int().min(1).max(500_000).optional(),
  }),
  destructive: true,
  execute: async (input) => {
    const target = resolveSafe("RemovePath", input.path);
    if (target.abs === workspaceRoot()) return "refusing to delete the workspace root";
    const existing = peek(target.abs);
    if (existing === undefined) {
      if (input.missingOk === true) {
        return json({ path: target.rel, removed: false, existed: false });
      }
      return `no such path: ${target.rel}`;
    }

    let files = 0;
    let directories = 0;
    let bytes = 0;
    if (existing.kind === "dir") {
      const walked = walkTree(target.real, exhaustiveWalk(input.maxEntries ?? 200_000));
      if (walked.truncated) {
        return `${target.rel} holds more entries than the cap allows — raise maxEntries, or delete subdirectories first`;
      }
      if (walked.entries.length > 0 && input.recursive !== true) {
        return `${target.rel} is a directory with ${walked.entries.length} entr${walked.entries.length === 1 ? "y" : "ies"} — pass recursive: true to delete it`;
      }
      directories = 1;
      for (const node of walked.entries) {
        if (node.kind === "dir") directories += 1;
        else {
          files += 1;
          bytes += node.size;
        }
      }
    } else {
      files = 1;
      bytes = existing.size;
    }

    const summary = {
      path: target.rel,
      type: existing.kind,
      files,
      directories,
      bytes,
      size: formatBytes(bytes),
    };
    if (input.dryRun === true) return json({ ...summary, dryRun: true, removed: false });
    // `rmSync` on a symlink removes the link itself, which is what we want:
    // following it would delete something outside the workspace.
    rmSync(target.abs, { recursive: existing.kind === "dir", force: false });
    return json({ ...summary, dryRun: false, removed: true });
  },
});

// ---------------------------------------------------------------------------
// splitting and joining
// ---------------------------------------------------------------------------

function partName(prefix: string, index: number): string {
  return `${prefix}${String(index).padStart(4, "0")}`;
}

export const splitFile: RegisteredTool = buildTool({
  name: "SplitFile",
  description:
    "Split a file into numbered parts by byte size or by line count, streaming rather than loading it. Use it to get a file under a size limit, or to hand a huge log to something that processes one chunk at a time.",
  inputSchema: z
    .object({
      path: z.string().min(1),
      maxBytes: z.number().int().min(1).optional().describe("part size in bytes"),
      maxLines: z.number().int().min(1).optional().describe("part size in lines"),
      outputDir: z.string().optional().describe("where the parts go (default: beside the source)"),
      prefix: z
        .string()
        .optional()
        .describe("part name prefix (default: the source name plus '.part')"),
      overwrite: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      maxParts: z.number().int().min(1).max(10_000).optional().describe("default 1000"),
    })
    .refine((value) => (value.maxBytes === undefined) !== (value.maxLines === undefined), {
      message: "set exactly one of maxBytes or maxLines",
    }),
  destructive: true,
  execute: async (input) => {
    const target = resolveSafe("SplitFile", input.path);
    const info = peek(target.abs);
    if (info === undefined) return `no such file: ${target.rel}`;
    if (info.kind !== "file") return `${target.rel} is a ${info.kind}, not a regular file`;

    const outDir = resolveSafe("SplitFile", input.outputDir ?? (path.dirname(target.rel) || "."));
    const outDirInfo = peek(outDir.abs);
    if (outDirInfo !== undefined && outDirInfo.kind !== "dir") {
      return `${outDir.rel} is a ${outDirInfo.kind}, not a directory`;
    }
    const prefix = input.prefix ?? `${path.basename(target.abs)}.part`;
    if (prefix.includes("/") || prefix.includes(path.sep) || prefix.includes("..")) {
      return "prefix must be a plain name, not a path";
    }
    const maxParts = input.maxParts ?? 1000;

    // Plan first so an existing part can be refused before anything is written.
    const planned: { name: string; bytes: number; lines?: number }[] = [];
    const fd = openNoFollow("SplitFile", target.real);
    try {
      if (input.maxBytes !== undefined) {
        const size = fstatSync(fd).size;
        const count = Math.max(1, Math.ceil(size / input.maxBytes));
        if (count > maxParts) {
          return `splitting ${target.rel} at ${input.maxBytes} bytes would make ${count} parts, over the ${maxParts} cap`;
        }
        for (let i = 0; i < count; i++) {
          const bytes = Math.min(input.maxBytes, size - i * input.maxBytes);
          planned.push({ name: partName(prefix, i + 1), bytes });
        }
      } else {
        // Line mode counts RAW BYTES, scanning for 0x0A directly rather than
        // decoding to text first. Decoding would turn any byte sequence that
        // is not valid UTF-8 into a replacement character of a different
        // length, and the write pass below copies byte counts — so a single
        // stray byte would shift every part boundary after it.
        const perPart = input.maxLines as number;
        const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
        let position = 0;
        let lines = 0;
        let partBytes = 0;
        let pendingBytes = 0;
        for (;;) {
          const read = readSync(fd, buffer, 0, CHUNK_BYTES, position);
          if (read <= 0) break;
          position += read;
          for (let i = 0; i < read; i++) {
            pendingBytes += 1;
            if (buffer[i] !== 0x0a) continue;
            lines += 1;
            partBytes += pendingBytes;
            pendingBytes = 0;
            if (lines >= perPart) {
              planned.push({ name: partName(prefix, planned.length + 1), bytes: partBytes, lines });
              partBytes = 0;
              lines = 0;
            }
          }
        }
        // A trailing line with no newline still counts.
        if (pendingBytes > 0) {
          lines += 1;
          partBytes += pendingBytes;
        }
        if (lines > 0) {
          planned.push({ name: partName(prefix, planned.length + 1), bytes: partBytes, lines });
        }
        if (planned.length > maxParts) {
          return `splitting ${target.rel} at ${perPart} lines would make ${planned.length} parts, over the ${maxParts} cap`;
        }
      }
    } finally {
      closeSync(fd);
    }

    const parts = planned.map((part) => ({
      ...part,
      abs: path.join(outDir.abs, part.name),
      rel: path.posix.join(outDir.rel === "" ? "." : outDir.rel, part.name),
    }));
    const conflicts = parts.filter((part) => peek(part.abs) !== undefined).map((part) => part.rel);
    if (conflicts.length > 0 && input.overwrite !== true) {
      return json({
        split: false,
        reason: "part files already exist",
        conflicts: conflicts.slice(0, 20),
        hint: "pass overwrite: true to replace them",
      });
    }
    const summary = {
      path: target.rel,
      parts: parts.map((part) => ({
        path: part.rel,
        bytes: part.bytes,
        ...(part.lines !== undefined ? { lines: part.lines } : {}),
      })),
      count: parts.length,
    };
    if (input.dryRun === true) return json({ ...summary, dryRun: true, split: false });

    mkdirSync(outDir.abs, { recursive: true });
    const source = openNoFollow("SplitFile", target.real);
    try {
      let position = 0;
      for (const part of parts) {
        const out = openSync(part.abs, "w");
        try {
          let remaining = part.bytes;
          const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, Math.max(remaining, 1)));
          while (remaining > 0) {
            const read = readSync(source, buffer, 0, Math.min(buffer.length, remaining), position);
            if (read <= 0) break;
            let written = 0;
            while (written < read) written += writeSync(out, buffer, written, read - written);
            position += read;
            remaining -= read;
          }
        } finally {
          closeSync(out);
        }
      }
    } finally {
      closeSync(source);
    }
    return json({ ...summary, dryRun: false, split: true });
  },
});

export const concatFiles: RegisteredTool = buildTool({
  name: "ConcatFiles",
  description:
    "Join files, in the order you give them, into one output file, streaming rather than buffering. Use it to reassemble SplitFile parts or to merge shards back into a single artifact.",
  inputSchema: z.object({
    paths: z.array(z.string().min(1)).min(1).max(5000),
    destination: z.string().min(1),
    separator: z
      .string()
      .max(4096)
      .optional()
      .describe("text inserted between files, e.g. a newline"),
    overwrite: z.boolean().optional(),
    dryRun: z.boolean().optional(),
  }),
  destructive: true,
  execute: async (input) => {
    const destination = resolveSafe("ConcatFiles", input.destination);
    const sources: SafePath[] = [];
    for (const raw of input.paths) {
      const source = resolveSafe("ConcatFiles", raw);
      const info = peek(source.abs);
      if (info === undefined) return `no such file: ${source.rel}`;
      if (info.kind !== "file") return `${source.rel} is a ${info.kind}, not a regular file`;
      if (source.abs === destination.abs) return "the destination is also one of the sources";
      sources.push(source);
    }
    const separator = input.separator ?? "";
    const bytes =
      sources.reduce((total, source) => total + (peek(source.abs)?.size ?? 0), 0) +
      Buffer.byteLength(separator, "utf8") * Math.max(0, sources.length - 1);
    const existing = peek(destination.abs);
    if (existing !== undefined && existing.kind !== "file") {
      // Without this, `overwrite: true` onto a directory reaches `openSync`
      // and throws EISDIR out of the tool instead of answering the caller.
      return `${destination.rel} is a ${existing.kind}, not a regular file`;
    }
    if (existing !== undefined && input.overwrite !== true) {
      return json({
        concatenated: false,
        reason: "destination exists",
        destination: destination.rel,
        hint: "pass overwrite: true to replace it",
      });
    }
    const summary = {
      destination: destination.rel,
      sources: sources.map((source) => source.rel),
      bytes,
      size: formatBytes(bytes),
    };
    if (input.dryRun === true) return json({ ...summary, dryRun: true, concatenated: false });

    mkdirSync(path.dirname(destination.abs), { recursive: true });
    const separatorBytes = Buffer.from(separator, "utf8");
    const out = openSync(destination.abs, "w");
    try {
      for (const [index, source] of sources.entries()) {
        if (index > 0 && separatorBytes.length > 0) {
          let written = 0;
          while (written < separatorBytes.length) {
            written += writeSync(out, separatorBytes, written, separatorBytes.length - written);
          }
        }
        const fd = openNoFollow("ConcatFiles", source.real);
        try {
          streamFile(fd, (chunk, length) => {
            let written = 0;
            while (written < length) written += writeSync(out, chunk, written, length - written);
          });
        } finally {
          closeSync(fd);
        }
      }
    } finally {
      closeSync(out);
    }
    return json({ ...summary, dryRun: false, concatenated: true });
  },
});

// ---------------------------------------------------------------------------
// archives
// ---------------------------------------------------------------------------

const ARCHIVE_FORMATS = ["tar", "tar.gz", "zip"] as const;

function formatFromName(name: string): ArchiveFormat | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
  if (lower.endsWith(".tar")) return "tar";
  return undefined;
}

/** Read an archive's entry list in-process. Returns a message on failure. */
function inspectArchive(
  toolName: string,
  target: SafePath,
): { format: ArchiveFormat; entries: ArchiveEntry[] } | string {
  const info = peek(target.abs);
  if (info === undefined) return `no such file: ${target.rel}`;
  if (info.kind !== "file") return `${target.rel} is a ${info.kind}, not an archive file`;
  let bytes: Buffer;
  try {
    bytes = readWholeFile(toolName, target.real, MAX_ARCHIVE_BYTES);
  } catch (err) {
    return (err as Error).message;
  }
  const format = detectArchiveFormat(bytes, target.abs);
  if (format === undefined) {
    return `${target.rel} is not a tar, tar.gz or zip archive as far as its bytes and name say`;
  }
  try {
    return { format, entries: readArchiveEntries(bytes, format, MAX_ARCHIVE_BYTES) };
  } catch (err) {
    if (err instanceof ArchiveFormatError) return `${target.rel}: ${err.message}`;
    return `${target.rel}: could not be read as ${format} — ${(err as Error).message}`;
  }
}

export const archiveList: RegisteredTool = buildTool({
  name: "ArchiveList",
  description:
    "List a tar, tar.gz or zip archive's members with their sizes and kinds, and flag any whose path would escape a destination. Use it before extracting anything you did not build yourself — the entry names come from the archive's own index, read in this process, not from another program's printed listing.",
  inputSchema: z.object({
    path: z.string().min(1),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20_000)
      .optional()
      .describe("members to return (default 500)"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const target = resolveSafe("ArchiveList", input.path);
    const read = inspectArchive("ArchiveList", target);
    if (typeof read === "string") return read;
    const sorted = [...read.entries].sort((a, b) => compareStrings(a.name, b.name));
    const unsafe = sorted.filter((entry) => archiveEntryEscapes(entry.name)).map((e) => e.name);
    const limit = input.limit ?? 500;
    return json({
      path: target.rel,
      format: read.format,
      count: sorted.length,
      truncated: sorted.length > limit,
      unsafeEntries: unsafe.slice(0, 50),
      entries: sorted.slice(0, limit).map((entry) => ({
        name: entry.name,
        kind: entry.kind,
        size: entry.size,
        ...(entry.linkTarget !== undefined ? { linkTarget: entry.linkTarget } : {}),
      })),
    });
  },
});

const timeoutField = z
  .number()
  .int()
  .min(1000)
  .max(MAX_PROCESS_TIMEOUT_MS)
  .optional()
  .describe(`milliseconds before the archiver is killed (default ${DEFAULT_PROCESS_TIMEOUT_MS})`);

export const archiveCreate: RegisteredTool = buildTool({
  name: "ArchiveCreate",
  description:
    "Pack a file or directory into a tar, tar.gz or zip archive, then read the result back to report what it contains. Use it to bundle build output or a working directory; the format comes from the output name unless you say otherwise.",
  inputSchema: z.object({
    source: z.string().min(1),
    output: z.string().min(1).describe("archive path; its extension picks the format"),
    format: z.enum(ARCHIVE_FORMATS).optional(),
    overwrite: z.boolean().optional(),
    timeout: timeoutField,
  }),
  // Shells out to `tar` or `zip`, so it crosses a process boundary and says so.
  destructive: true,
  scope: "external",
  ioCapability: "process",
  execute: async (input, ctx) => {
    const source = resolveSafe("ArchiveCreate", input.source);
    const output = resolveSafe("ArchiveCreate", input.output);
    const info = peek(source.abs);
    if (info === undefined) return `no such path: ${source.rel}`;
    const format = input.format ?? formatFromName(output.abs);
    if (format === undefined) {
      return `cannot tell the archive format from "${output.rel}" — end it in .tar, .tar.gz, .tgz or .zip, or pass format`;
    }
    if (info.kind === "dir" && isInside(source.abs, output.abs)) {
      return `the archive would be written inside the directory being archived (${output.rel}) — put it somewhere else`;
    }
    const outputInfo = peek(output.abs);
    if (outputInfo !== undefined && outputInfo.kind !== "file") {
      // `rmSync(..., { force: true })` below is non-recursive, so a directory
      // here would throw out of the tool instead of answering the caller.
      return `${output.rel} is a ${outputInfo.kind}, not an archive file this tool may replace`;
    }
    if (outputInfo !== undefined && input.overwrite !== true) {
      return json({
        created: false,
        reason: "output exists",
        output: output.rel,
        hint: "pass overwrite: true to replace it",
      });
    }
    mkdirSync(path.dirname(output.abs), { recursive: true });
    if (peek(output.abs) !== undefined) rmSync(output.abs, { force: true });

    const parent = path.dirname(source.abs);
    const name = path.basename(source.abs);
    // `--` ends the option list. Nothing here is a shell string — every
    // argument is an argv element — but `name` is the basename of a
    // caller-supplied path, and a directory called `-x` or `-FS` is an
    // OPTION to both `tar` and `zip`, not a member to pack. Without the
    // separator `zip -r -X out.zip -x` fails as a malformed exclude, and a
    // better-chosen name would have changed what the archiver did.
    const argv =
      format === "zip"
        ? // -X drops the extra attribute blocks (uid/gid, resource forks), which
          // are host state rather than content; -r recurses; -q stays quiet.
          ["zip", "-q", "-r", "-X", output.abs, "--", name]
        : format === "tar.gz"
          ? ["tar", "-c", "-z", "-f", output.abs, "-C", parent, "--", name]
          : ["tar", "-c", "-f", output.abs, "-C", parent, "--", name];
    const result = await runProcess(argv, {
      cwd: format === "zip" ? parent : workspaceRoot(),
      timeoutMs: input.timeout ?? DEFAULT_PROCESS_TIMEOUT_MS,
      ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    if (result.code !== 0 || result.missing) {
      return `could not create ${output.rel}: ${describeFailure(argv, result)}`;
    }
    const read = inspectArchive("ArchiveCreate", resolveSafe("ArchiveCreate", output.rel));
    const size = peek(output.abs)?.size ?? 0;
    return json({
      created: true,
      output: output.rel,
      format,
      bytes: size,
      size: formatBytes(size),
      entries: typeof read === "string" ? null : read.entries.length,
      ...(typeof read === "string" ? { verifyNote: read } : {}),
    });
  },
});

/** The staging directory an extraction lands in before anything is accepted. */
const STAGING_NAME = ".crewhaus-extract";

/** How many staged entries the post-extraction scan will look at. */
const STAGING_SCAN_BUDGET = 500_000;

type StagingScan = {
  /** Every symlink under the staged root whose target resolves outside it. */
  readonly escaping: string[];
  /**
   * True when some part of the staged tree was NOT inspected — the budget ran
   * out, a directory would not open, or a link would not read. The caller
   * must treat this as a failure: "we did not look" is not "nothing is there".
   */
  readonly incomplete: boolean;
};

/**
 * Inspect every entry of a just-extracted tree for a symlink aimed out of it.
 *
 * This deliberately does NOT use `walkTree`. That walker is built for the
 * listing tools and skips `.git` unconditionally and stops at depth 64 —
 * reasonable when the question is "what is in this project", fatal when the
 * question is "did anything hostile land here". An archive member called
 * `pkg/.git/pwn -> /etc/passwd` is invisible to it, so the link is accepted
 * and planted inside the workspace. A plain readdir walk skips nothing.
 *
 * It is iterative rather than recursive so a pathologically deep archive
 * cannot overflow the stack half-way through the check, and it never
 * descends THROUGH a symlink, so there are no cycles to terminate.
 */
function scanStagedTree(root: string, budget = STAGING_SCAN_BUDGET): StagingScan {
  const escaping: string[] = [];
  let incomplete = false;
  let remaining = budget;
  const stack: Array<{ abs: string; rel: string }> = [{ abs: root, rel: "" }];
  while (stack.length > 0) {
    const dir = stack.pop() as { abs: string; rel: string };
    let dirents: Dirent[];
    try {
      dirents = readdirSync(dir.abs, { withFileTypes: true });
    } catch {
      incomplete = true;
      continue;
    }
    for (const dirent of dirents) {
      if (remaining <= 0) {
        incomplete = true;
        break;
      }
      remaining -= 1;
      const abs = path.join(dir.abs, dirent.name);
      const rel = dir.rel === "" ? dirent.name : `${dir.rel}/${dirent.name}`;
      if (dirent.isSymbolicLink()) {
        let target: string;
        try {
          target = readlinkSync(abs);
        } catch {
          incomplete = true;
          continue;
        }
        if (!isInside(root, path.resolve(dir.abs, target))) escaping.push(`${rel} -> ${target}`);
        continue;
      }
      if (dirent.isDirectory()) stack.push({ abs, rel });
    }
  }
  return { escaping: escaping.sort(compareStrings), incomplete };
}

export const archiveExtract: RegisteredTool = buildTool({
  name: "ArchiveExtract",
  description:
    "Extract a tar, tar.gz or zip archive into a destination inside the workspace, refusing any member that would escape it. Use `dryRun` to see the member list and the verdict first; extraction happens into a staging directory and is only accepted once nothing has escaped.",
  inputSchema: z.object({
    archive: z.string().min(1),
    destination: z.string().min(1),
    overwrite: z.boolean().optional().describe("replace top-level entries that already exist"),
    dryRun: z.boolean().optional(),
    maxEntries: z.number().int().min(1).max(200_000).optional().describe("default 20000"),
    timeout: timeoutField,
  }),
  destructive: true,
  scope: "external",
  ioCapability: "process",
  execute: async (input, ctx) => {
    const archive = resolveSafe("ArchiveExtract", input.archive);
    const destination = resolveSafe("ArchiveExtract", input.destination);
    const destinationInfo = peek(destination.abs);
    if (destinationInfo !== undefined && destinationInfo.kind !== "dir") {
      return `${destination.rel} is a ${destinationInfo.kind}, not a directory to extract into`;
    }
    const read = inspectArchive("ArchiveExtract", archive);
    if (typeof read === "string") return read;
    const { format, entries } = read;
    const maxEntries = input.maxEntries ?? 20_000;
    if (entries.length > maxEntries) {
      return `${archive.rel} holds ${entries.length} members, over the ${maxEntries} cap`;
    }

    // ZIP-SLIP GATE. Every member name is checked against the destination
    // BEFORE the extractor runs, using the archive's own index rather than a
    // printed listing. A member with a `..` segment, an absolute path or a
    // drive prefix is refused, and so is a symlink member whose recorded
    // target points out of the destination.
    const refusals: string[] = [];
    for (const entry of entries) {
      if (archiveEntryEscapes(entry.name)) {
        refusals.push(`${entry.name} (path escapes the destination)`);
        continue;
      }
      const landing = path.resolve(destination.abs, entry.name);
      if (!isInside(destination.abs, landing)) {
        refusals.push(`${entry.name} (resolves outside the destination)`);
        continue;
      }
      if ((entry.name.split("/")[0] ?? "") === STAGING_NAME) {
        // The staging directory lives at `<destination>/<STAGING_NAME>`, so a
        // member of that name would be promoted onto the directory it is
        // being promoted out of — which fails mid-loop and takes the rest of
        // the extraction down with it.
        refusals.push(
          `${entry.name} (collides with the staging directory this tool extracts into)`,
        );
        continue;
      }
      if (entry.kind === "symlink" || entry.kind === "hardlink") {
        if (entry.linkTarget === undefined || entry.linkTarget === "") {
          // An unreadable target is refused rather than waved through: a
          // link this gate cannot evaluate is precisely what a crafted
          // archive would present to get past it.
          refusals.push(`${entry.name} (a link whose target this archive does not state)`);
          continue;
        }
        const linkTarget = path.resolve(path.dirname(landing), entry.linkTarget);
        if (!isInside(destination.abs, linkTarget)) {
          refusals.push(`${entry.name} -> ${entry.linkTarget} (link points outside)`);
        }
      }
    }
    if (refusals.length > 0) {
      return json({
        extracted: false,
        reason: "unsafe archive",
        archive: archive.rel,
        detail:
          "one or more members would be written outside the destination; nothing was extracted",
        refused: refusals.slice(0, 50),
        refusedCount: refusals.length,
      });
    }

    const topLevel = [
      ...new Set(entries.map((entry) => (entry.name.split("/")[0] ?? "").replace(/\/$/, ""))),
    ]
      .filter((name) => name !== "" && name !== ".")
      .sort(compareStrings);
    const conflicts = topLevel.filter(
      (name) => peek(path.join(destination.abs, name)) !== undefined,
    );

    const summary = {
      archive: archive.rel,
      destination: destination.rel,
      format,
      members: entries.length,
      topLevel,
    };
    if (input.dryRun === true) {
      return json({ ...summary, dryRun: true, extracted: false, wouldOverwrite: conflicts });
    }
    if (conflicts.length > 0 && input.overwrite !== true) {
      return json({
        ...summary,
        extracted: false,
        reason: "destination entries exist",
        conflicts,
        hint: "pass overwrite: true to replace them",
      });
    }

    mkdirSync(destination.abs, { recursive: true });
    const staging = path.join(destination.abs, STAGING_NAME);
    if (peek(staging) !== undefined) {
      return `${path.posix.join(destination.rel === "" ? "." : destination.rel, STAGING_NAME)} already exists — remove it, it is left over from an interrupted extraction`;
    }
    mkdirSync(staging);

    const argv =
      format === "zip"
        ? ["unzip", "-qq", "-o", archive.abs, "-d", staging]
        : format === "tar.gz"
          ? ["tar", "-x", "-z", "-f", archive.abs, "-C", staging]
          : ["tar", "-x", "-f", archive.abs, "-C", staging];
    const result = await runProcess(argv, {
      cwd: workspaceRoot(),
      timeoutMs: input.timeout ?? DEFAULT_PROCESS_TIMEOUT_MS,
      ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    if (result.code !== 0 || result.missing) {
      rmSync(staging, { recursive: true, force: true });
      return `could not extract ${archive.rel}: ${describeFailure(argv, result)}`;
    }

    // Second gate, after the extractor has had its say: a link that ended up
    // pointing out of the staging tree means something got past the name
    // check, so nothing is accepted. An INCOMPLETE scan is refused on the
    // same terms — a gate that could not read part of the tree has not
    // cleared it.
    const scan = scanStagedTree(staging);
    if (scan.escaping.length > 0 || scan.incomplete) {
      rmSync(staging, { recursive: true, force: true });
      return json({
        extracted: false,
        reason: "unsafe archive",
        archive: archive.rel,
        detail:
          scan.escaping.length > 0
            ? "the extracted tree contains symlinks pointing outside it; it was discarded"
            : "the extracted tree could not be fully checked for escaping symlinks; it was discarded",
        refused: scan.escaping.slice(0, 50),
      });
    }

    const moved: string[] = [];
    try {
      for (const name of readdirSorted(staging)) {
        const from = path.join(staging, name);
        const to = path.join(destination.abs, name);
        if (peek(to) !== undefined) rmSync(to, { recursive: true, force: true });
        renameSync(from, to);
        moved.push(name);
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    return json({ ...summary, dryRun: false, extracted: true, entries: moved });
  },
});

/**
 * A directory's children, sorted with plain string comparison.
 *
 * A plain readdir, not `walkTree`: the walker omits `.git`, so promoting a
 * staged extraction with it would silently drop a `.git` directory the
 * archive contained — reporting `extracted: true` while deleting the member
 * along with the staging directory.
 */
function readdirSorted(dir: string): string[] {
  return readdirSync(dir).sort(compareStrings);
}

// ---------------------------------------------------------------------------
// markdown front matter
// ---------------------------------------------------------------------------

const FRONTMATTER_SUBSET =
  "The YAML subset is deliberate: top-level keys only, whose values are strings, numbers, booleans, null or a flat list of those. Anything else (nested maps, block scalars, anchors) is refused rather than guessed at.";

export const frontmatterRead: RegisteredTool = buildTool({
  name: "FrontmatterRead",
  description: `Read the YAML front matter from a markdown file and return it as structured data. Use it to get a document's tags, title or status without reading the document. ${FRONTMATTER_SUBSET}`,
  inputSchema: z.object({
    path: z.string().min(1),
    includeBody: z.boolean().optional().describe("also return the document body"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const target = resolveSafe("FrontmatterRead", input.path);
    const info = peek(target.abs);
    if (info === undefined) return `no such file: ${target.rel}`;
    if (info.kind !== "file") return `${target.rel} is a ${info.kind}, not a regular file`;
    let text: string;
    try {
      text = readWholeFile("FrontmatterRead", target.real, MAX_WHOLE_FILE_BYTES).toString("utf8");
    } catch (err) {
      return (err as Error).message;
    }
    const split = splitFrontmatter(text);
    if (!split.found) {
      return json({ path: target.rel, hasFrontmatter: false, bodyChars: text.length });
    }
    let data: FrontmatterData;
    try {
      data = parseFrontmatter(split.yaml);
    } catch (err) {
      if (err instanceof FrontmatterError) return `${target.rel}: ${err.message}`;
      throw err;
    }
    return json({
      path: target.rel,
      hasFrontmatter: true,
      keys: Object.keys(data).sort(),
      data,
      bodyChars: split.body.length,
      ...(input.includeBody === true ? { body: split.body } : {}),
    });
  },
});

const frontmatterScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const frontmatterWrite: RegisteredTool = buildTool({
  name: "FrontmatterWrite",
  description: `Set or remove keys in a markdown file's YAML front matter, leaving the body untouched. Use it to update a document's status or tags without rewriting the file by hand; existing keys keep their position and new ones are appended in sorted order. ${FRONTMATTER_SUBSET}`,
  inputSchema: z.object({
    path: z.string().min(1),
    data: z
      .record(z.union([frontmatterScalar, z.array(frontmatterScalar).max(1000)]))
      .describe("keys to set"),
    removeKeys: z.array(z.string().min(1)).max(200).optional(),
    merge: z
      .boolean()
      .optional()
      .describe("keep existing keys (default true); false replaces the block"),
    dryRun: z.boolean().optional(),
  }),
  destructive: true,
  execute: async (input) => {
    const target = resolveSafe("FrontmatterWrite", input.path);
    const info = peek(target.abs);
    if (info !== undefined && info.kind !== "file") {
      return `${target.rel} is a ${info.kind}, not a regular file`;
    }
    let text = "";
    if (info !== undefined) {
      try {
        text = readWholeFile("FrontmatterWrite", target.real, MAX_WHOLE_FILE_BYTES).toString(
          "utf8",
        );
      } catch (err) {
        return (err as Error).message;
      }
    }
    const split = splitFrontmatter(text);
    let existing: FrontmatterData = {};
    let keyOrder: string[] = [];
    if (split.found) {
      try {
        existing = parseFrontmatter(split.yaml);
      } catch (err) {
        if (err instanceof FrontmatterError) {
          return `${target.rel}: ${err.message} — fix or remove the front matter before writing to it`;
        }
        throw err;
      }
      keyOrder = Object.keys(existing);
    }
    const merged: FrontmatterData =
      input.merge === false ? {} : ({ ...existing } as FrontmatterData);
    for (const [key, value] of Object.entries(input.data)) {
      merged[key] = value as FrontmatterValue;
    }
    for (const key of input.removeKeys ?? []) delete merged[key];

    let yaml: string;
    try {
      yaml = serializeFrontmatter(merged, keyOrder);
    } catch (err) {
      if (err instanceof FrontmatterError) return `${target.rel}: ${err.message}`;
      throw err;
    }
    const next = renderDocument(yaml, split.body, split.eol);
    const summary = {
      path: target.rel,
      keys: Object.keys(merged).sort(),
      frontmatter: yaml,
      changed: next !== text,
    };
    if (input.dryRun === true) return json({ ...summary, dryRun: true, written: false });
    if (next === text) return json({ ...summary, dryRun: false, written: false });
    mkdirSync(path.dirname(target.abs), { recursive: true });
    writeAtomic(target.abs, next);
    return json({ ...summary, dryRun: false, written: true });
  },
});

// ---------------------------------------------------------------------------
// Jupyter notebooks
// ---------------------------------------------------------------------------

export const notebookRead: RegisteredTool = buildTool({
  name: "NotebookRead",
  description:
    "Read a Jupyter .ipynb file as a list of cells with their sources and, optionally, their outputs. Use it instead of reading the raw JSON: images and other binary outputs are reported by type and size rather than pasted in as base64.",
  inputSchema: z.object({
    path: z.string().min(1),
    startCell: z.number().int().min(0).optional(),
    maxCells: z.number().int().min(1).max(1000).optional().describe("default 50"),
    cellType: z
      .enum(["code", "markdown", "raw"])
      .optional()
      .describe("return only cells of this type"),
    includeOutputs: z.boolean().optional().describe("default true"),
    maxOutputChars: z
      .number()
      .int()
      .min(0)
      .max(100_000)
      .optional()
      .describe("per output (default 2000)"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const target = resolveSafe("NotebookRead", input.path);
    const info = peek(target.abs);
    if (info === undefined) return `no such file: ${target.rel}`;
    if (info.kind !== "file") return `${target.rel} is a ${info.kind}, not a regular file`;
    let notebook: ReturnType<typeof parseNotebook>;
    try {
      const text = readWholeFile("NotebookRead", target.real, MAX_WHOLE_FILE_BYTES).toString(
        "utf8",
      );
      notebook = parseNotebook(text);
    } catch (err) {
      if (err instanceof NotebookError) return `${target.rel}: ${err.message}`;
      return (err as Error).message;
    }
    const start = input.startCell ?? 0;
    const maxCells = input.maxCells ?? 50;
    const maxOutputChars = input.maxOutputChars ?? 2000;
    const selected = notebook.cells
      .map((cell, index) => ({ cell, index }))
      .filter(
        ({ cell, index }) =>
          index >= start && (input.cellType === undefined || cell.cell_type === input.cellType),
      )
      .slice(0, maxCells);
    return json({
      path: target.rel,
      nbformat: notebook.nbformat ?? null,
      totalCells: notebook.cells.length,
      returned: selected.length,
      truncated: start + selected.length < notebook.cells.length,
      cells: selected.map(({ cell, index }) => ({
        index,
        type: cell.cell_type,
        source: cellSource(cell),
        ...(input.includeOutputs !== false && Array.isArray(cell.outputs) && cell.outputs.length > 0
          ? { outputs: summarizeOutputs(cell.outputs, maxOutputChars) }
          : {}),
      })),
    });
  },
});

export const notebookEdit: RegisteredTool = buildTool({
  name: "NotebookEdit",
  description:
    "Replace, insert or delete one cell in a Jupyter .ipynb file, rewriting it the way Jupyter would. Use it rather than editing the JSON by hand; replacing a code cell's source also clears its stale outputs and execution count.",
  inputSchema: z.object({
    path: z.string().min(1),
    mode: z.enum(["replace", "insert", "delete"]),
    index: z
      .number()
      .int()
      .min(0)
      .describe("0-based cell index; for insert, the position to insert at"),
    source: z.string().optional().describe("new cell source; required for replace and insert"),
    cellType: z
      .enum(["code", "markdown", "raw"])
      .optional()
      .describe("for insert (default 'code')"),
    dryRun: z.boolean().optional(),
  }),
  destructive: true,
  execute: async (input) => {
    const target = resolveSafe("NotebookEdit", input.path);
    const info = peek(target.abs);
    if (info === undefined) return `no such file: ${target.rel}`;
    if (info.kind !== "file") return `${target.rel} is a ${info.kind}, not a regular file`;
    if (input.mode !== "delete" && input.source === undefined) {
      return `mode "${input.mode}" needs a source`;
    }
    let notebook: ReturnType<typeof parseNotebook>;
    let original: string;
    try {
      original = readWholeFile("NotebookEdit", target.real, MAX_WHOLE_FILE_BYTES).toString("utf8");
      notebook = parseNotebook(original);
    } catch (err) {
      if (err instanceof NotebookError) return `${target.rel}: ${err.message}`;
      return (err as Error).message;
    }
    let updated: ReturnType<typeof applyNotebookEdit>;
    try {
      updated = applyNotebookEdit(
        notebook,
        input.mode === "delete"
          ? { mode: "delete", index: input.index }
          : input.mode === "replace"
            ? { mode: "replace", index: input.index, source: input.source as string }
            : {
                mode: "insert",
                index: input.index,
                cellType: input.cellType ?? "code",
                source: input.source as string,
              },
      );
    } catch (err) {
      if (err instanceof NotebookError) return `${target.rel}: ${err.message}`;
      throw err;
    }
    const next = serializeNotebook(updated);
    const summary = {
      path: target.rel,
      mode: input.mode,
      index: input.index,
      totalCells: updated.cells.length,
      changed: next !== original,
    };
    if (input.dryRun === true) return json({ ...summary, dryRun: true, written: false });
    writeAtomic(target.abs, next);
    return json({ ...summary, dryRun: false, written: true });
  },
});

/**
 * Every tool this package registers, in the order a catalog should list them.
 */
export const FSX_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  archiveCreate,
  archiveExtract,
  archiveList,
  concatFiles,
  copyPath,
  diskUsage,
  fileHash,
  findFiles,
  frontmatterRead,
  frontmatterWrite,
  makeDirectory,
  movePath,
  notebookEdit,
  notebookRead,
  readLines,
  removePath,
  splitFile,
  stat,
  tailFile,
  tempDir,
  tree,
  touchFile,
]);

export { ToolPermissionError } from "./paths";
