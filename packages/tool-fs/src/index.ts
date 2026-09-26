import { closeSync } from "node:fs";
import * as path from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  type SafeFsFailure,
  openForReadFd,
  resolveContained,
  writeFileSafe,
} from "@crewhaus/tool-safety/fs";
import {
  type RegexRejectCode,
  describeRegexOutcome,
  openRegexSession,
  screenUserRegex,
} from "@crewhaus/tool-safety/regex";
import { readFileBoundedSync, readOpenedFileSync } from "@crewhaus/tool-safety/streams";
import { z } from "zod";
import { renderEditDiff } from "./diff";
import { requiredLiterals } from "./literals";
import { BASE_LINE_CAP, REFUSED_CHAIN, lineCapForChain, repeatChainLength } from "./repeat-chain";

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
  //    where the path PHYSICALLY lands: tool-safety's resolveContained walks
  //    it one component at a time as the kernel does, following dangling
  //    links too (`open(…, "w")` through one creates its target), with `..`
  //    in a link's target climbing from where the link really led. The copy
  //    that lived here folded a dangling link's target as text, so
  //    `evil -> a/y/../x` with `a/y -> ..` read as inside while the kernel
  //    lands one level above the workspace (C068). Fails closed.
  const resolved = resolveContained(rootResolved, abs);
  if (!resolved.ok) throw new ToolPermissionError(toolName, rel);
  const real = resolved.real;
  // Read, Write and Edit then do their I/O through tool-safety, which
  // resolves the caller's path again, physically, and checks the open
  // descriptor (reads) or the directory it wrote into (writes), so a leaf or
  // directory swapped after this check is refused there. This check stays
  // first so an escape is the same ToolPermissionError it always was.
  return real;
}

/**
 * The most bytes Read and Edit take in. A file is held whole in memory (as
 * bytes, then as a string twice its size), so 0.7.0's uncapped read let one
 * call on a multi-gigabyte log or a sparse file exhaust the process. The cap
 * matches Grep's per-call budget. A tool result over 10 KB is already stored
 * on disk and previewed by the runtime, so the cap is about memory, not about
 * the model's context.
 */
export const READ_MAX_BYTES = 64 * 1024 * 1024;
let readMaxBytes = READ_MAX_BYTES;

/** Test seam: a smaller Read/Edit cap, so the limit is exercised without a 64 MiB file. `undefined` restores. */
export function _setReadMaxBytesForTest(bytes: number | undefined): void {
  readMaxBytes = bytes ?? READ_MAX_BYTES;
}

/**
 * Turn a tool-safety refusal into this package's error. An escape stays the
 * `ToolPermissionError` every caller already matches on; anything else keeps
 * the helper's reason, which names the caller's path and never where a link
 * led.
 */
function fsError(toolName: string, given: string, failure: SafeFsFailure): Error {
  if (failure.code === "escapes-root") return new ToolPermissionError(toolName, given);
  return new CrewhausError("tool", `${toolName}: ${failure.reason}`);
}

const BOM_KEEPING_DECODER = new TextDecoder("utf-8", { ignoreBOM: true });

const READ_TOO_LARGE_HINT =
  "read part of it with a line-range tool (ReadLines, TailFile) if you have one, or search it with Grep";

/** `size` undefined: the file grew past the cap while it was being read. */
function tooLarge(toolName: string, given: string, size: number | undefined): Error {
  const what =
    size === undefined
      ? `grew past the ${readMaxBytes}-byte limit while it was read`
      : `is ${size} bytes, over the ${readMaxBytes}-byte limit`;
  return new CrewhausError(
    "tool",
    `${toolName}: ${JSON.stringify(given)} ${what}; ${READ_TOO_LARGE_HINT}`,
  );
}

/**
 * Read a workspace file whole, as UTF-8, through tool-safety's contained
 * open: the path is resolved physically and must land in the workspace, a
 * FIFO, socket or device is refused BEFORE it is opened (opening a FIFO
 * blocks the event loop until a writer appears, and no timeout or abort
 * reaches a blocked open), and a leaf or directory swapped for a link out of
 * the workspace is refused on the descriptor. A file over the cap is refused
 * from its size before a byte is read; one that grows past it mid-read is
 * refused too, never returned cut short.
 */
function readWorkspaceText(toolName: string, given: string): string {
  const opened = openForReadFd(process.cwd(), given);
  if (!opened.ok) throw fsError(toolName, given, opened);
  try {
    if (opened.stats.size > readMaxBytes) throw tooLarge(toolName, given, opened.stats.size);
    const r = readOpenedFileSync(
      { ok: true, fd: opened.fd, stats: opened.stats },
      { maxBytes: readMaxBytes },
    );
    if (!r.ok) {
      throw new CrewhausError("tool", `${toolName}: ${JSON.stringify(given)} could not be read`);
    }
    if (r.truncated) throw tooLarge(toolName, given, undefined);
    // Decoded here, keeping a leading byte-order mark, not taken from
    // `r.text`: tool-safety decodes with TextDecoder's default, which drops
    // the BOM. Read then showed text the file does not start with, and Edit
    // wrote the file back without it, changing bytes nobody asked it to
    // touch (a Windows .cs or .csproj, a CSV meant for Excel), while its
    // diff showed line 1 as unchanged. 0.7.0 kept it.
    return BOM_KEEPING_DECODER.decode(r.bytes);
  } finally {
    closeSync(opened.fd);
  }
}

/**
 * Replace `given`'s content atomically, keeping its permission bits.
 *
 * tool-safety's writeFileSafe writes a temp created with O_EXCL|O_NOFOLLOW
 * under a random name beside the file (at 0600 until it is complete) and
 * renames it into place. 0.7.0 staged through `Bun.write`, which created the
 * temp at 0644 and never restored the old mode: an edited script lost its
 * execute bit and a 0600 `.env` became world-readable. A link at the leaf
 * that stays inside the workspace is written through (the link stays a
 * link), as before; one that leads out is refused.
 */
function writeWorkspaceText(
  toolName: string,
  given: string,
  content: string,
  createParents: boolean,
): void {
  const w = writeFileSafe(process.cwd(), given, content, {
    overwrite: true,
    createParents,
    leafSymlink: "follow-contained",
  });
  if (!w.ok) throw fsError(toolName, given, w);
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
    resolveSafe("Read", input.path);
    return readWorkspaceText("Read", input.path);
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
    resolveSafe("Write", input.path);
    writeWorkspaceText("Write", input.path, input.content, true);
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
    resolveSafe("Edit", input.path);
    const original = readWorkspaceText("Edit", input.path);
    const occurrences = original.split(input.oldString).length - 1;
    if (occurrences === 0) {
      throw new Error(`oldString not found in "${input.path}"`);
    }
    if (occurrences > 1) {
      throw new Error(
        `oldString matches ${occurrences} times in "${input.path}" — provide more surrounding context to make it unique`,
      );
    }
    // Spliced by index, never `original.replace(oldString, newString)`: a
    // string replacement expands `$$`, `$&`, `` $` `` and `$'` in newString,
    // so a Makefile's `$$` or JS's "\\$&" was written as something else
    // while the diff below showed the text the caller asked for.
    const at = original.indexOf(input.oldString);
    const next =
      original.slice(0, at) + input.newString + original.slice(at + input.oldString.length);
    writeWorkspaceText("Edit", input.path, next, false);
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
//  2. the match runs in tool-safety's regex worker, under the call's deadline
//     and abort signal: at the deadline the worker is terminated and the
//     caller's thread is free. Lines go to the worker in batches of up to
//     GREP_BATCH_CHARS, gathered across files and split inside a big one, so
//     neither a thousand small files nor one lockfile over the worker's
//     input limit changes what is searched (one call per file cost a round
//     trip each, and a file over the limit ended the whole scan). A line
//     without any of the literals every match must contain (`./literals`)
//     is a definite miss and never goes to the worker, which keeps a search
//     for a word as fast as 0.7.0's;
//  3. one match attempt cannot be interrupted, so the longest line a pattern
//     runs on is chosen from how many of its repeats can split the same text
//     (`./repeat-chain`), which bounds how long an abandoned worker keeps a
//     core busy; a pattern with too many is refused;
//  4. an answer the engine gave up on (a slow "no match") is UNDETERMINED,
//     and so is a line too long to run: the result lists what it could not
//     search and never says a bare "no matches" when anything went unsearched.
const GREP_MAX_LINE_LENGTH = BASE_LINE_CAP;
const GREP_MAX_PATTERN_LENGTH = 1_000;
const GREP_DEADLINE_MS = 2_000;
const GREP_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/**
 * Characters (plus one per line) sent to the regex worker in one batch: its
 * own default input limit, passed explicitly so the two cannot drift apart.
 */
const GREP_BATCH_CHARS = 1_000_000;
/** Examples of unsearched lines named in the note; the rest are counted. */
const GREP_UNSEARCHED_EXAMPLES = 5;

type GrepLimits = {
  readonly deadlineMs: number;
  readonly giveUpMs: number | undefined;
  readonly now: () => number;
  /** Characters (plus one per line) gathered before a batch goes to the worker. */
  readonly batchChars: number;
  /** The input limit the worker is told; equal to `batchChars` except in a test. */
  readonly workerInputChars: number;
};
const GREP_DEFAULT_LIMITS: GrepLimits = {
  deadlineMs: GREP_DEADLINE_MS,
  giveUpMs: undefined,
  now: () => Date.now(),
  batchChars: GREP_BATCH_CHARS,
  workerInputChars: GREP_BATCH_CHARS,
};
let grepLimits: GrepLimits = GREP_DEFAULT_LIMITS;

/**
 * Test seam: the deadline, the regex worker's give-up threshold (a no-match
 * slower than this is undetermined; 0 makes every no-match undetermined, to
 * exercise that path without a pathological pattern), the clock, and the
 * batch size and worker input limit (set apart only to exercise a refusal
 * that cannot otherwise happen). Pass `undefined` to restore.
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
 * Refuse a pattern that could backtrack catastrophically, with the reason,
 * and say how long a line the rest may run on. Throws the tool's usual
 * "invalid regex pattern" error.
 */
function screenGrepPattern(pattern: string): { lineCap: number; chain: number } {
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
  const chain = repeatChainLength(pattern);
  if (chain >= REFUSED_CHAIN) {
    throw new Error(
      `invalid regex pattern: stacked repeats — ${chain} repeats (such as \\w* or .*) can split the same text one after another, which backtracks for minutes on an ordinary line; put something between them that they cannot both match, or use a negated class such as [^,]*`,
    );
  }
  return { lineCap: lineCapForChain(chain), chain };
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
  /** Lines longer than the pattern's line cap, not run at all. */
  tooLong: number;
  /** Files that could not be read (not symlinks, which are skipped by design). */
  unreadable: number;
  /** Lines the worker refused to take, and why (it should never happen: see GREP_BATCH_CHARS). */
  refused: { lines: number; reason: string } | undefined;
  /** A few `path:line` examples of undetermined lines. */
  examples: string[];
  /** Why the scan stopped before the end, when it did. */
  stopped: string | undefined;
};

function unsearchedNote(u: Unsearched, lineCap: number, chain: number): string {
  const parts: string[] = [];
  if (u.gaveUp > 0) {
    const shown = u.examples.slice(0, GREP_UNSEARCHED_EXAMPLES).join(", ");
    parts.push(
      `\n[grep: ${u.gaveUp} line(s) could not be evaluated — the regex engine gave up on them (${shown}${u.gaveUp > GREP_UNSEARCHED_EXAMPLES ? ", …" : ""}), so they may or may not match; simplify the pattern]`,
    );
  }
  if (u.tooLong > 0) {
    const why =
      lineCap < GREP_MAX_LINE_LENGTH
        ? ` — this pattern has ${chain} repeats that can split the same text one after another, which is too slow to run on longer lines; put something between them that they cannot both match to search up to ${GREP_MAX_LINE_LENGTH}`
        : "";
    parts.push(
      `\n[grep: ${u.tooLong} line(s) longer than ${lineCap} characters were not searched${why}]`,
    );
  }
  if (u.unreadable > 0) {
    parts.push(`\n[grep: ${u.unreadable} file(s) could not be read and were not searched]`);
  }
  if (u.refused !== undefined) {
    parts.push(`\n[grep: ${u.refused.lines} line(s) were not searched: ${u.refused.reason}]`);
  }
  if (u.stopped !== undefined) parts.push(`\n[grep: scan stopped early — ${u.stopped}]`);
  return parts.join("");
}

/** Lines waiting to go to the regex worker, and where each came from. */
type GrepBatch = {
  inputs: string[];
  /** Per input: its index in `files`. */
  fileOf: number[];
  /** Per input: its 1-based line number. */
  lineOf: number[];
  files: string[];
  /** Characters plus one per input, as the worker counts them. */
  chars: number;
};

function emptyBatch(): GrepBatch {
  return { inputs: [], fileOf: [], lineOf: [], files: [], chars: 0 };
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
    const { lineCap, chain } = screenGrepPattern(input.pattern);
    const literals = requiredLiterals(input.pattern);

    const limits = grepLimits;
    const deadline = limits.now() + limits.deadlineMs;
    let scannedBytes = 0;
    const unsearched: Unsearched = {
      gaveUp: 0,
      tooLong: 0,
      unreadable: 0,
      refused: undefined,
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
    let batch = emptyBatch();
    const where = (b: GrepBatch, index: number): string =>
      `${b.files[b.fileOf[index] as number]}:${b.lineOf[index]}`;

    /**
     * Run the pending lines. True to keep scanning; false when the scan must
     * stop (the deadline, an abort, a worker that cannot run), with
     * `unsearched.stopped` saying why and from where.
     */
    const flush = async (): Promise<boolean> => {
      const b = batch;
      batch = emptyBatch();
      if (b.inputs.length === 0) return true;
      const remainingMs = deadline - limits.now();
      if (remainingMs <= 0) {
        unsearched.stopped = `the ${limits.deadlineMs} ms deadline passed before ${where(b, 0)} was searched; it and everything after it were not searched`;
        return false;
      }
      const outcome = await session.run({
        op: "testEach",
        pattern: input.pattern,
        inputs: b.inputs,
        onGiveUp: "skip",
        maxItemChars: lineCap,
        maxInputChars: limits.workerInputChars,
        maxMatches: b.inputs.length,
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
        hits.push(`${where(b, index)}:${b.inputs[index] ?? ""}`);
      }
      for (const index of partial?.undetermined ?? []) {
        unsearched.gaveUp++;
        if (unsearched.examples.length < GREP_UNSEARCHED_EXAMPLES) {
          unsearched.examples.push(where(b, index));
        }
      }
      if (answered !== undefined) return true;
      if (outcome.status === "input-too-large") {
        // Cannot happen while GREP_BATCH_CHARS and the line cap are what the
        // worker is told; if it ever does, these lines are named as
        // unsearched and the scan goes on, rather than ending at them.
        unsearched.refused = {
          lines: (unsearched.refused?.lines ?? 0) + b.inputs.length,
          reason: outcome.reason,
        };
        return true;
      }
      // Anything else ends the scan: the deadline, an abort, a worker that
      // could not run. The lines not answered and every file after them
      // were not searched, and the note says so.
      const first =
        outcome.status === "timeout"
          ? (outcome.completed ?? outcome.partial?.scanned ?? 0)
          : outcome.status === "gave-up"
            ? (outcome.partial?.scanned ?? 0)
            : 0;
      const from = where(b, Math.min(first, b.inputs.length - 1));
      unsearched.stopped =
        outcome.status === "timeout"
          ? `the ${limits.deadlineMs} ms deadline passed while searching ${from}; it and everything after it were not searched`
          : `${describeRegexOutcome(outcome)} (at ${from}); it and everything after it were not searched`;
      return false;
    };

    try {
      scan: for await (const rel of matcher.scan({ cwd: baseAbs, onlyFiles: true })) {
        const skippedBy = ignoredSegmentOf(rel, ignored);
        if (skippedBy !== undefined) {
          hidden++;
          hiddenDirs.add(skippedBy);
          continue;
        }
        const display = baseRel === "" ? rel : path.join(baseRel, rel);
        if (deadline - limits.now() <= 0) {
          // Lines read but not yet searched are named by flush(), which
          // finds the deadline passed; with none pending, this file is.
          if (await flush()) {
            unsearched.stopped = `the ${limits.deadlineMs} ms deadline passed; ${display} and the files after it were not searched`;
          }
          break;
        }
        const fileAbs = path.join(baseAbs, rel);
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
          if (await flush()) {
            unsearched.stopped = `the ${GREP_MAX_TOTAL_BYTES / (1024 * 1024)} MiB scan budget ran out at ${display}; it and the files after it were not searched`;
          }
          break;
        }
        scannedBytes += read.bytes.length;
        const lines = read.text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] as string;
          // A line holding none of the pattern's required literals cannot
          // match: a definite answer, however long the line, with no worker.
          if (literals !== undefined && !literals.some((l) => line.includes(l))) continue;
          if (line.length > lineCap) {
            unsearched.tooLong++;
            continue;
          }
          if (batch.chars + line.length + 1 > limits.batchChars && !(await flush())) break scan;
          if (batch.files[batch.files.length - 1] !== display) batch.files.push(display);
          batch.inputs.push(line);
          batch.fileOf.push(batch.files.length - 1);
          batch.lineOf.push(i + 1);
          batch.chars += line.length + 1;
        }
      }
      if (unsearched.stopped === undefined) await flush();
    } finally {
      session.close();
    }
    const incomplete =
      unsearched.gaveUp > 0 ||
      unsearched.tooLong > 0 ||
      unsearched.unreadable > 0 ||
      unsearched.refused !== undefined ||
      unsearched.stopped !== undefined;
    const body =
      hits.length > 0
        ? hits.join("\n")
        : incomplete
          ? "no matches in the lines searched"
          : "no matches";
    return (
      body + unsearchedNote(unsearched, lineCap, chain) + hiddenNote("Grep", hidden, hiddenDirs)
    );
  },
});

export const allFsTools: ReadonlyArray<RegisteredTool> = [read, write, edit, glob, grep];
