import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { rename, unlink } from "node:fs/promises";
import * as path from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { renderEditDiff } from "./diff";

/**
 * Built-in filesystem tools, sandboxed to the process's current working
 * directory. Every path argument is resolved relative to `process.cwd()` and
 * rejected if it escapes outside via `..`, absolute prefixes, or symlinks
 * whose real target lies outside the root.
 *
 * Layer R4 (built-in tools). Pairs with the `target-cli` codegen contract,
 * which imports each lowercase variable (`read`, `write`, ...) by name.
 */

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

function resolveSafe(toolName: string, rel: string, root: string = process.cwd()): string {
  const rootResolved = path.resolve(root);
  const abs = path.resolve(rootResolved, rel);
  // 1) Lexical containment — fast path; rejects `..` and absolute escapes.
  //    The trailing `path.sep` avoids the `/root` vs `/root-sibling` pitfall.
  if (abs !== rootResolved && !abs.startsWith(`${rootResolved}${path.sep}`)) {
    throw new ToolPermissionError(toolName, rel);
  }
  // 2) Symlink-aware containment (CWE-59). The lexical check above is fooled
  //    by an in-root symlink that points outside the workspace, so re-check
  //    the REAL path. The leaf may not exist yet (Write/Edit create it), so
  //    resolve the deepest existing ancestor and re-append the missing tail.
  //    Fails closed if realpath errors for any reason other than the walk.
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
    if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) {
      throw new ToolPermissionError(toolName, rel);
    }
  } catch (err) {
    if (err instanceof ToolPermissionError) throw err;
    throw new ToolPermissionError(toolName, rel);
  }
  // Return the validated REAL path, not the lexical one: I/O on the realpath
  // (with any in-root symlinks already resolved) plus an O_NOFOLLOW open at the
  // read site closes the check-to-use TOCTOU (CWE-367) — a leaf swapped to a
  // symlink after this returns is rejected at open, while a legitimate in-root
  // symlink (resolved here to its real target) still reads fine.
  return real;
}

/**
 * Read a resolveSafe-validated file with O_NOFOLLOW. If the final path
 * component was swapped to a symlink after the containment check, the open
 * fails (ELOOP) and we reject rather than follow it out of the workspace.
 * (Residual: an intermediate-directory swap needs openat-style resolution,
 * which node does not expose — a much harder attack on a much smaller window.)
 */
function readFileNoFollow(toolName: string, absPath: string): Buffer {
  let fd: number;
  try {
    fd = openSync(absPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") {
      throw new ToolPermissionError(toolName, absPath);
    }
    throw err;
  }
  try {
    const { size } = fstatSync(fd);
    const buf = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const n = readSync(fd, buf, offset, size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return offset === size ? buf : buf.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

function rejectTraversalPattern(toolName: string, pattern: string): void {
  if (pattern.includes("..") || path.isAbsolute(pattern)) {
    throw new ToolPermissionError(toolName, pattern);
  }
}

/**
 * Directory names that hold vendored or generated files rather than the user's
 * project. Compiling a bundle into the workspace (`crewhaus compile -o <dir>
 * --check` runs `bun install`) drops thousands of dependency files next to a
 * handful of real source files: without this list a `**\/*.ts` Glob returns
 * mostly vendored code and Grep spends its byte/time budget on it before it
 * ever reaches the project.
 *
 * Skipped by default, never forbidden: naming the directory in the Glob
 * pattern — or pointing Grep's `path` at it — opts back in, the same way
 * ripgrep still searches an explicitly-named ignored path.
 */
export const DEFAULT_IGNORED_DIRS: readonly string[] = ["node_modules", "__pycache__"];

/** The default-ignored dirs the caller did NOT name, i.e. the ones to skip. */
function activeIgnoredDirs(mentionedIn: string): readonly string[] {
  return DEFAULT_IGNORED_DIRS.filter((dir) => !mentionedIn.includes(dir));
}

/**
 * The first ignored directory name on `rel`'s path, or undefined when the
 * entry is not under one. `rel` comes from Bun.Glob, which uses the platform
 * separator, so split on both.
 */
function ignoredSegmentOf(rel: string, ignored: readonly string[]): string | undefined {
  if (ignored.length === 0) return undefined;
  for (const seg of rel.split(/[\\/]/)) {
    if (ignored.includes(seg)) return seg;
  }
  return undefined;
}

/** "[Glob: 12 file(s) under node_modules/ hidden — …]", or "" when nothing was skipped. */
function hiddenNote(toolName: string, skipped: number, dirs: ReadonlySet<string>): string {
  if (skipped === 0) return "";
  const names = [...dirs]
    .sort()
    .map((d) => `${d}/`)
    .join(", ");
  const how = toolName === "Glob" ? "name the directory in the pattern" : "pass it as `path`";
  return `\n[${toolName}: ${skipped} file(s) under ${names} hidden — ${how} to include them]`;
}

const readSchema = z.object({ path: z.string() });
export const read: RegisteredTool = buildTool({
  name: "Read",
  description: "Read the contents of a file inside the workspace as UTF-8 text.",
  inputSchema: readSchema,
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const abs = resolveSafe("Read", input.path);
    return readFileNoFollow("Read", abs).toString("utf8");
  },
});

const writeSchema = z.object({ path: z.string(), content: z.string() });
export const write: RegisteredTool = buildTool({
  name: "Write",
  description:
    "Atomically write UTF-8 text to a file inside the workspace (replaces existing content).",
  inputSchema: writeSchema,
  destructive: true,
  execute: async (input) => {
    const abs = resolveSafe("Write", input.path);
    const tmp = `${abs}.tmp.${randomBytes(6).toString("hex")}`;
    try {
      await Bun.write(tmp, input.content);
      await rename(tmp, abs);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    return `wrote ${input.content.length} bytes to ${input.path}`;
  },
});

const editSchema = z.object({
  path: z.string(),
  oldString: z.string(),
  newString: z.string(),
});
export const edit: RegisteredTool = buildTool({
  name: "Edit",
  description:
    "Replace the unique occurrence of oldString with newString in a workspace file. Errors when oldString matches zero or multiple times.",
  inputSchema: editSchema,
  destructive: true,
  execute: async (input) => {
    const abs = resolveSafe("Edit", input.path);
    const original = readFileNoFollow("Edit", abs).toString("utf8");
    const occurrences = original.split(input.oldString).length - 1;
    if (occurrences === 0) {
      throw new Error(`oldString not found in "${input.path}"`);
    }
    if (occurrences > 1) {
      throw new Error(
        `oldString matches ${occurrences} times in "${input.path}" — provide more surrounding context to make it unique`,
      );
    }
    const next = original.replace(input.oldString, input.newString);
    const tmp = `${abs}.tmp.${randomBytes(6).toString("hex")}`;
    try {
      await Bun.write(tmp, next);
      await rename(tmp, abs);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    // M3.3 — return a unified-diff style hunk so the CLI (and the model
    // on subsequent turns) can see exactly what changed. The header
    // line "edited <path>" stays first for backward compatibility with
    // tests + tool-result parsers; the diff body follows.
    const diff = renderEditDiff({
      path: input.path,
      original,
      oldString: input.oldString,
      newString: input.newString,
    });
    return diff.length > 0 ? `edited ${input.path}\n${diff}` : `edited ${input.path}`;
  },
});

const globSchema = z.object({ pattern: z.string() });
export const glob: RegisteredTool = buildTool({
  name: "Glob",
  description:
    "List files inside the workspace matching a glob pattern (e.g. **/*.ts). Vendored directories (node_modules, __pycache__) are skipped unless the pattern names them. Returns newline-joined relative paths.",
  inputSchema: globSchema,
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    rejectTraversalPattern("Glob", input.pattern);
    const cwd = process.cwd();
    const ignored = activeIgnoredDirs(input.pattern);
    const matcher = new Bun.Glob(input.pattern);
    const matches: string[] = [];
    const hiddenDirs = new Set<string>();
    let hidden = 0;
    for await (const rel of matcher.scan({ cwd, onlyFiles: true })) {
      const skippedBy = ignoredSegmentOf(rel, ignored);
      if (skippedBy !== undefined) {
        hidden++;
        hiddenDirs.add(skippedBy);
        continue;
      }
      matches.push(rel);
    }
    matches.sort();
    const body = matches.length === 0 ? "no matches" : matches.join("\n");
    return body + hiddenNote("Glob", hidden, hiddenDirs);
  },
});

const grepSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
});

// ReDoS bounds. The Grep pattern is model-supplied and model output is
// attacker-steerable, so a catastrophic-backtracking pattern run over the
// workspace could pin a CPU core. We bound it three ways:
//  1. reject nested-quantifier (star-height >= 2) patterns up front — the
//     shape behind exponential backtracking, which no input cap can save;
//  2. skip over-long lines so a "safe" (linear/polynomial) pattern can't be
//     fed a pathological input length;
//  3. a wall-clock deadline + a scanned-bytes cap bound the aggregate work.
const GREP_MAX_LINE_LENGTH = 10_000;
const GREP_MAX_PATTERN_LENGTH = 1_000;
const GREP_DEADLINE_MS = 2_000;
const GREP_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * True if the pattern nests one unbounded/large quantifier inside another
 * (star-height >= 2, e.g. `(a+)+`, `(a*)*`, `(.*a)+`, `((\d+)x)*`). That is
 * the structural cause of exponential backtracking. Heuristic, not a full
 * analysis — alternation-overlap ReDoS is only partly covered, which is why
 * the line/scan caps exist as a backstop.
 */
export function hasNestedQuantifier(pattern: string): boolean {
  // Per group-nesting level, did the body so far contain a quantifier?
  const quantInGroup: boolean[] = [false];
  const isBigQuant = (s: string, at: number): boolean => {
    const c = s[at];
    if (c === "*" || c === "+") return true;
    if (c === "{") {
      // `{n}` is fixed (safe-ish); `{n,}` / `{n,m}` with a high bound recurses.
      const close = s.indexOf("}", at);
      if (close === -1) return false;
      const inner = s.slice(at + 1, close);
      if (inner.includes(",")) return true;
      const n = Number.parseInt(inner, 10);
      return Number.isFinite(n) && n > 8;
    }
    return false;
  };
  let i = 0;
  let escaped = false;
  let inClass = false;
  while (i < pattern.length) {
    const c = pattern[i] as string;
    if (escaped) {
      escaped = false;
      i++;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      i++;
      continue;
    }
    if (c === "[") {
      inClass = true;
      i++;
      continue;
    }
    if (c === "(") {
      quantInGroup.push(false);
      i++;
      continue;
    }
    if (c === ")") {
      const innerHadQuant = quantInGroup.pop() ?? false;
      const groupQuantified = isBigQuant(pattern, i + 1);
      // A quantified group whose body already had a quantifier ⇒ star-height ≥ 2.
      if (innerHadQuant && groupQuantified) return true;
      // The parent's body contains a quantifier if this group's body did (at
      // any depth) OR this group is itself quantified — so a redundantly-nested
      // `((a+))+` is still caught.
      if (innerHadQuant || groupQuantified) {
        quantInGroup[quantInGroup.length - 1] = true;
      }
      i++;
      continue;
    }
    if (isBigQuant(pattern, i)) {
      quantInGroup[quantInGroup.length - 1] = true;
    }
    i++;
  }
  return false;
}

export const grep: RegisteredTool = buildTool({
  name: "Grep",
  description:
    "Search for a regex pattern across files in the workspace (or a subdirectory). Vendored directories (node_modules, __pycache__) are skipped unless `path` points inside one. Returns lines as path:lineNo:match.",
  inputSchema: grepSchema,
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const root = process.cwd();
    let baseAbs = root;
    let baseRel = "";
    if (input.path !== undefined && input.path !== "") {
      baseAbs = resolveSafe("Grep", input.path, root);
      baseRel = path.relative(root, baseAbs);
    }
    if (input.pattern.length > GREP_MAX_PATTERN_LENGTH) {
      throw new Error(`invalid regex pattern: too long (max ${GREP_MAX_PATTERN_LENGTH} chars)`);
    }
    if (hasNestedQuantifier(input.pattern)) {
      throw new Error(
        "invalid regex pattern: nested quantifiers (e.g. (a+)+) risk catastrophic backtracking — rewrite without a repetition inside a repeated group",
      );
    }
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`invalid regex pattern: ${msg}`);
    }

    const deadline = Date.now() + GREP_DEADLINE_MS;
    let scannedBytes = 0;
    let truncated = false;
    // Pointing `path` at (or inside) a vendored directory opts into searching
    // it; otherwise its contents are skipped before they cost a read.
    const ignored = activeIgnoredDirs(input.path ?? "");
    const matcher = new Bun.Glob("**/*");
    const hits: string[] = [];
    const hiddenDirs = new Set<string>();
    let hidden = 0;
    outer: for await (const rel of matcher.scan({ cwd: baseAbs, onlyFiles: true })) {
      const skippedBy = ignoredSegmentOf(rel, ignored);
      if (skippedBy !== undefined) {
        hidden++;
        hiddenDirs.add(skippedBy);
        continue;
      }
      const fileAbs = path.join(baseAbs, rel);
      const display = baseRel === "" ? rel : path.join(baseRel, rel);
      let text: string;
      try {
        // O_NOFOLLOW: skip (don't follow) any symlinked entry the glob surfaced.
        text = readFileNoFollow("Grep", fileAbs).toString("utf8");
      } catch {
        continue;
      }
      scannedBytes += text.length;
      if (scannedBytes > GREP_MAX_TOTAL_BYTES) {
        truncated = true;
        break;
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        // Check the deadline between lines — bounds aggregate work even though
        // it can't interrupt a single `.test()` (which the pattern guard +
        // line cap keep cheap).
        if ((i & 0x3ff) === 0 && Date.now() > deadline) {
          truncated = true;
          break outer;
        }
        const line = lines[i] ?? "";
        if (line.length > GREP_MAX_LINE_LENGTH) continue;
        if (regex.test(line)) {
          hits.push(`${display}:${i + 1}:${line}`);
        }
      }
    }
    const note = truncated ? "\n[grep: scan stopped early — workspace too large or slow]" : "";
    return (
      (hits.length === 0 ? "no matches" : hits.join("\n")) +
      note +
      hiddenNote("Grep", hidden, hiddenDirs)
    );
  },
});

export const allFsTools: ReadonlyArray<RegisteredTool> = [read, write, edit, glob, grep];
