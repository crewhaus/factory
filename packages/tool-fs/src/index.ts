import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { rename, unlink } from "node:fs/promises";
import * as path from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  type RegexRejectCode,
  describeRegexOutcome,
  openRegexSession,
  screenUserRegex,
} from "@crewhaus/tool-safety/regex";
import { readFileBoundedSync } from "@crewhaus/tool-safety/streams";
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

/**
 * True when the NAME exists, whether or not it leads anywhere.
 *
 * `existsSync` follows symlinks, so it answers false for a link whose target
 * is missing — and a missing target is exactly the case that matters here: a
 * dangling link is still a door. Probing with `lstat` keeps that name in the
 * part of the path that gets RESOLVED rather than in the "does not exist
 * yet" tail that is appended to the root verbatim.
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
 * The result is the path an `open` would create, which is the only path
 * worth checking containment against.
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
    // fails closed. A relative target resolves against the link's directory.
    // Recursing (rather than returning the raw target) is what resolves an
    // absolute target such as /var/folders/... to its real /private/var/...
    // form, so a legitimate in-workspace dangling link is not wrongly refused.
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
  //    resolve the deepest ancestor that EXISTS AS A NAME and re-append the
  //    missing tail. "Exists as a name" rather than "exists": a symlink whose
  //    target is not there yet is still followed by `open(…, "w")`, so it is
  //    resolved here too rather than treated as a plain missing leaf.
  //    Fails closed if realpath errors for any reason other than the walk.
  let real: string;
  try {
    const rootReal = realpathSync(rootResolved);
    real = resolveLocation(abs);
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
  operativeArgs: [{ field: "path", kind: "path" }],
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
  operativeArgs: [{ field: "path", kind: "path" }],
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
  operativeArgs: [{ field: "path", kind: "path" }],
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
  // The pattern is a path with wildcards in it; resolving it as a path is
  // what keeps `src/../**` from passing a `Glob(src/**)` rule.
  operativeArgs: [{ field: "pattern", kind: "path" }],
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

// The Grep pattern is model-supplied, and model output is attacker-steerable.
// A synchronous RegExp call cannot be interrupted: no timer fires and no
// abort is seen while it runs, so a catastrophic pattern froze every session
// in the process. Worse, JavaScriptCore stops a runaway match after a fixed
// backtracking budget and answers "no match", indistinguishable from a real
// one: `(\w|\d)*!|NEEDLE` over 64-character hex lines returned a bare "no
// matches" after 6 s with NEEDLE on line 5, and the deadline, read only
// every 1024 lines, let one file run for minutes (security-6#6). So:
//  1. the pattern is screened up front (tool-safety's `screenUserRegex`,
//     which refuses nested quantifiers AND overlapping alternation, plus
//     this package's older nested-quantifier check, which is stricter about
//     bounded repeats such as `(.*a){10}`);
//  2. the match runs in tool-safety's regex worker, one `testEach` per file,
//     under the call's deadline and abort signal: at the deadline the worker
//     is terminated and the caller's thread is free;
//  3. an answer the engine gave up on (a slow "no match") is UNDETERMINED,
//     and so is a line too long to run: the result lists what it could not
//     search and never says a bare "no matches" when anything went unsearched.
const GREP_MAX_LINE_LENGTH = 10_000;
const GREP_MAX_PATTERN_LENGTH = 1_000;
const GREP_DEADLINE_MS = 2_000;
const GREP_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** Examples of unsearched lines named in the note; the rest are counted. */
const GREP_UNSEARCHED_EXAMPLES = 5;

type GrepLimits = {
  readonly deadlineMs: number;
  readonly giveUpMs: number | undefined;
  readonly now: () => number;
};
const GREP_DEFAULT_LIMITS: GrepLimits = {
  deadlineMs: GREP_DEADLINE_MS,
  giveUpMs: undefined,
  now: () => Date.now(),
};
let grepLimits: GrepLimits = GREP_DEFAULT_LIMITS;

/**
 * Test seam: the deadline, the regex worker's give-up threshold (a no-match
 * slower than this is undetermined; 0 makes every no-match undetermined, to
 * exercise that path without a pathological pattern) and the clock. Pass
 * `undefined` to restore.
 */
export function _setGrepLimitsForTest(limits: Partial<GrepLimits> | undefined): void {
  grepLimits = { ...GREP_DEFAULT_LIMITS, ...limits };
}

const REJECTION_LABELS: Partial<Record<RegexRejectCode, string>> = {
  "nested-quantifier": "nested quantifiers",
  "overlapping-alternation": "overlapping alternation",
  "invalid-syntax": "invalid syntax",
  "pattern-too-long": "too long",
  unanalysable: "too complex to check",
};

/**
 * Refuse a pattern that could backtrack catastrophically, with the reason.
 * Throws the tool's usual "invalid regex pattern" error.
 */
function screenGrepPattern(pattern: string): void {
  if (pattern.length > GREP_MAX_PATTERN_LENGTH) {
    throw new Error(`invalid regex pattern: too long (max ${GREP_MAX_PATTERN_LENGTH} chars)`);
  }
  const screened = screenUserRegex(pattern, "", { maxPatternChars: GREP_MAX_PATTERN_LENGTH });
  if (!screened.ok) {
    const label = REJECTION_LABELS[screened.code] ?? screened.code;
    throw new Error(`invalid regex pattern: ${label} — ${screened.reason}`);
  }
  if (hasNestedQuantifier(pattern)) {
    throw new Error(
      "invalid regex pattern: nested quantifiers (e.g. (a+)+) risk catastrophic backtracking — rewrite without a repetition inside a repeated group",
    );
  }
}

/**
 * True if the pattern nests one unbounded/large quantifier inside another
 * (star-height >= 2, e.g. `(a+)+`, `(a*)*`, `(.*a)+`, `((\d+)x)*`), or
 * repeats an alternation whose branches can match the same text
 * (`(\w|\d)*`, `(a|ab)*`). Both are shapes behind exponential
 * backtracking. The alternation half, and the precise nested-quantifier
 * analysis, are tool-safety's `screenUserRegex`; the structural check below
 * is the older, stricter one about bounded repeats, kept so no pattern this
 * refused before is accepted now.
 */
export function hasNestedQuantifier(pattern: string): boolean {
  const screened = screenUserRegex(pattern, "", { maxPatternChars: Number.MAX_SAFE_INTEGER });
  if (
    !screened.ok &&
    (screened.code === "nested-quantifier" || screened.code === "overlapping-alternation")
  ) {
    return true;
  }
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

/** What a Grep call could not search, for the note that says so. */
type Unsearched = {
  /** Lines the engine gave up on: they may or may not match. */
  gaveUp: number;
  /** Lines longer than GREP_MAX_LINE_LENGTH, not run at all. */
  tooLong: number;
  /** Files that could not be read (not symlinks, which are skipped by design). */
  unreadable: number;
  /** A few `path:line` examples of undetermined lines. */
  examples: string[];
  /** Why the scan stopped before the end, when it did. */
  stopped: string | undefined;
};

function unsearchedNote(u: Unsearched): string {
  const parts: string[] = [];
  if (u.gaveUp > 0) {
    const shown = u.examples.slice(0, GREP_UNSEARCHED_EXAMPLES).join(", ");
    parts.push(
      `\n[grep: ${u.gaveUp} line(s) could not be evaluated — the regex engine gave up on them (${shown}${u.gaveUp > GREP_UNSEARCHED_EXAMPLES ? ", …" : ""}), so they may or may not match; simplify the pattern]`,
    );
  }
  if (u.tooLong > 0) {
    parts.push(
      `\n[grep: ${u.tooLong} line(s) longer than ${GREP_MAX_LINE_LENGTH} characters were not searched]`,
    );
  }
  if (u.unreadable > 0) {
    parts.push(`\n[grep: ${u.unreadable} file(s) could not be read and were not searched]`);
  }
  if (u.stopped !== undefined) parts.push(`\n[grep: scan stopped early — ${u.stopped}]`);
  return parts.join("");
}

export const grep: RegisteredTool = buildTool({
  name: "Grep",
  description:
    "Search for a regex pattern across files in the workspace (or a subdirectory). Vendored directories (node_modules, __pycache__) are skipped unless `path` points inside one. Returns lines as path:lineNo:match, and names any lines it could not search.",
  inputSchema: grepSchema,
  readOnly: true,
  concurrencySafe: true,
  // Both fields are operative: a `Grep(src/**)` allow needs `path` in src/
  // AND the regex to match, so a regex cannot carry an out-of-scope path;
  // a `Grep(*password*)` deny fires on the regex alone. Leaving `path` out
  // searches the whole workspace, so a rule reads it as ".".
  operativeArgs: [
    { field: "pattern", kind: "text" },
    { field: "path", kind: "path", default: "." },
  ],
  execute: async (input, ctx) => {
    const root = process.cwd();
    let baseAbs = root;
    let baseRel = "";
    if (input.path !== undefined && input.path !== "") {
      baseAbs = resolveSafe("Grep", input.path, root);
      baseRel = path.relative(root, baseAbs);
    }
    screenGrepPattern(input.pattern);

    const limits = grepLimits;
    const deadline = limits.now() + limits.deadlineMs;
    let scannedBytes = 0;
    const unsearched: Unsearched = {
      gaveUp: 0,
      tooLong: 0,
      unreadable: 0,
      examples: [],
      stopped: undefined,
    };
    // Pointing `path` at (or inside) a vendored directory opts into searching
    // it; otherwise its contents are skipped before they cost a read.
    const ignored = activeIgnoredDirs(input.path ?? "");
    const matcher = new Bun.Glob("**/*");
    const hits: string[] = [];
    const hiddenDirs = new Set<string>();
    let hidden = 0;
    const session = openRegexSession();
    try {
      for await (const rel of matcher.scan({ cwd: baseAbs, onlyFiles: true })) {
        const skippedBy = ignoredSegmentOf(rel, ignored);
        if (skippedBy !== undefined) {
          hidden++;
          hiddenDirs.add(skippedBy);
          continue;
        }
        const remainingMs = deadline - limits.now();
        if (remainingMs <= 0) {
          unsearched.stopped = `the ${limits.deadlineMs} ms deadline passed; files after this point were not searched`;
          break;
        }
        const fileAbs = path.join(baseAbs, rel);
        const display = baseRel === "" ? rel : path.join(baseRel, rel);
        // Bounded by what is left of the byte budget, never following a
        // link, and refusing a FIFO before it is opened (it would block).
        const budget = GREP_MAX_TOTAL_BYTES - scannedBytes;
        const read = readFileBoundedSync(fileAbs, { maxBytes: budget, followSymlinks: false });
        if (!read.ok) {
          // A symlinked entry is skipped by design; anything else is a file
          // this call did not search, and says so.
          if (read.code !== "symlink-refused") unsearched.unreadable++;
          continue;
        }
        if (read.truncated) {
          unsearched.stopped = `the ${GREP_MAX_TOTAL_BYTES / (1024 * 1024)} MiB scan budget ran out at ${display}; it and the files after it were not searched`;
          break;
        }
        scannedBytes += read.bytes.length;
        const lines = read.text.split("\n");
        const outcome = await session.run({
          op: "testEach",
          pattern: input.pattern,
          inputs: lines,
          onGiveUp: "skip",
          maxItemChars: GREP_MAX_LINE_LENGTH,
          maxMatches: lines.length,
          deadlineMs: remainingMs,
          ...(limits.giveUpMs !== undefined ? { giveUpMs: limits.giveUpMs } : {}),
          ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
          ...(ctx?.runContext?.sessionId !== undefined
            ? { runawayKey: ctx.runContext.sessionId }
            : {}),
        });
        const answered = outcome.status === "ok" ? outcome.result : undefined;
        const partial =
          answered ??
          (outcome.status === "timeout" || outcome.status === "gave-up"
            ? outcome.partial
            : undefined);
        for (const index of partial?.matched ?? []) {
          hits.push(`${display}:${index + 1}:${lines[index] ?? ""}`);
        }
        for (const index of partial?.undetermined ?? []) {
          if ((lines[index] ?? "").length > GREP_MAX_LINE_LENGTH) {
            unsearched.tooLong++;
          } else {
            unsearched.gaveUp++;
            if (unsearched.examples.length < GREP_UNSEARCHED_EXAMPLES) {
              unsearched.examples.push(`${display}:${index + 1}`);
            }
          }
        }
        if (answered !== undefined) continue;
        // Anything else ends the scan: the deadline, an abort, a worker that
        // could not run. The rest of this file and every file after it were
        // not searched, and the note says so.
        unsearched.stopped =
          outcome.status === "timeout"
            ? `the ${limits.deadlineMs} ms deadline passed while searching ${display}; the rest of it and the files after it were not searched`
            : `${describeRegexOutcome(outcome)} (at ${display}); it and the files after it were not searched`;
        break;
      }
    } finally {
      session.close();
    }
    const incomplete =
      unsearched.gaveUp > 0 ||
      unsearched.tooLong > 0 ||
      unsearched.unreadable > 0 ||
      unsearched.stopped !== undefined;
    const body =
      hits.length > 0
        ? hits.join("\n")
        : incomplete
          ? "no matches in the lines searched"
          : "no matches";
    return body + unsearchedNote(unsearched) + hiddenNote("Grep", hidden, hiddenDirs);
  },
});

export const allFsTools: ReadonlyArray<RegisteredTool> = [read, write, edit, glob, grep];
