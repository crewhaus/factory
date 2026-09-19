/**
 * Reading the things a spec-maintenance tool has to read: the spec file
 * itself, a directory of session JSONLs, an audit directory.
 *
 * Two rules run through all of it.
 *
 * CONTAINMENT. Every caller-supplied path goes through `resolveSafe` before a
 * syscall sees it, and refusals echo the path the caller wrote - truncated and
 * stripped of control characters - never the node error, which carries an
 * absolute path the caller never supplied.
 *
 * AN UNREADABLE THING IS NOT AN EMPTY THING. Every read returns a `Loaded<T>`
 * carrying WHY it failed, and every caller that carries on regardless has to
 * put the reason in its result. A session file that could not be read and a
 * session file with no findings are different answers; a directory that does
 * not exist and a directory holding no logs are different answers. This
 * package has one job - telling a maintainer what to change - and "nothing to
 * change", arrived at by failing to look, is the worst answer it could give.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { type SafePath, ToolPermissionError, resolveSafe, toPosix } from "../paths";

/**
 * Why a load failed, when the caller has to branch on it.
 *
 * Kept as a field rather than sniffed out of the message so a reworded
 * message can never silently turn a refusal into a carry-on.
 */
export type LoadFailure = "refused" | "missing" | "too-large" | "not-a-file" | "bad-input";

export type Loaded<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string; readonly code: LoadFailure };

/** Longest caller path echoed back in a refusal. */
const MAX_ECHOED_PATH_CHARS = 200;

/**
 * A caller-supplied path, safe to put in a result string.
 *
 * Control characters are neutralised because a refusal is read by a human in
 * a terminal and by a model in a transcript, and a raw ESC or CR in either is
 * a lie about what the tool did.
 */
export function renderPath(given: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: neutralising control characters is the point
  const printable = given.replace(/[\u0000-\u001f\u007f]/g, "\uFFFD");
  return printable.length > MAX_ECHOED_PATH_CHARS
    ? `${printable.slice(0, MAX_ECHOED_PATH_CHARS)}...`
    : printable;
}

/** A spec is YAML a human maintains; anything past this is not one. */
export const MAX_SPEC_BYTES = 4 * 1024 * 1024;
/** One session transcript. Past this, mine a narrower directory. */
export const MAX_LOG_BYTES = 64 * 1024 * 1024;

/** Resolve a caller path inside the workspace, or say why it cannot be used. */
export function resolveInput(toolName: string, rel: string): Loaded<SafePath> {
  // A NUL in a path is refused before any syscall sees it: node throws a
  // TypeError on it, and that error's text is not a refusal a caller can act
  // on. `resolveSafe` would also refuse it, but only after `path.resolve`.
  if (rel.includes("\u0000")) {
    return {
      ok: false,
      message: `"${renderPath(rel)}" carries a NUL byte and is not a usable path`,
      code: "refused",
    };
  }
  try {
    return { ok: true, value: resolveSafe(toolName, rel) };
  } catch (err) {
    if (err instanceof ToolPermissionError) {
      return { ok: false, message: err.message, code: "refused" };
    }
    throw err;
  }
}

/** Read a contained file as UTF-8, refusing anything over `maxBytes`. */
export function readContained(toolName: string, rel: string, maxBytes: number): Loaded<string> {
  const shown = renderPath(rel);
  const safe = resolveInput(toolName, rel);
  if (!safe.ok) return safe;
  let size: number;
  try {
    const stat = statSync(safe.value.real);
    if (!stat.isFile()) {
      return { ok: false, message: `"${shown}" is not a file`, code: "not-a-file" };
    }
    size = stat.size;
  } catch {
    return { ok: false, message: `"${shown}" does not exist or is unreadable`, code: "missing" };
  }
  // The cap is applied to the SIZE ON DISK, before a byte is read, so the
  // refusal costs no memory. A cap applied after the read would not be one.
  if (size > maxBytes) {
    return {
      ok: false,
      message: `"${shown}" is ${size} bytes, over the ${maxBytes} limit for this tool`,
      code: "too-large",
    };
  }
  try {
    return { ok: true, value: readFileSync(safe.value.real, "utf8") };
  } catch {
    // The node error text carries the ABSOLUTE path, which is workspace
    // layout the caller did not supply and does not need.
    return { ok: false, message: `"${shown}" could not be read`, code: "missing" };
  }
}

/** The `spec` / `path` pair the spec tools take. */
export const specSourceFields = {
  spec: z.string().optional().describe("the spec YAML text, inline"),
  path: z
    .string()
    .optional()
    .describe(
      "path to the spec file instead, relative to the working directory - the only form a write can use",
    ),
};

export const specSourceSchema = z.object(specSourceFields);
export type SpecSource = z.infer<typeof specSourceSchema>;

/** Exactly one of `spec` / `path`, read and size-checked. */
export function loadSpecText(toolName: string, source: SpecSource): Loaded<string> {
  if (source.spec !== undefined && source.path !== undefined) {
    return {
      ok: false,
      message: 'pass either "spec" or "path", not both',
      code: "bad-input",
    };
  }
  if (source.spec !== undefined) {
    if (Buffer.byteLength(source.spec, "utf8") > MAX_SPEC_BYTES) {
      return {
        ok: false,
        message: `the inline spec is over the ${MAX_SPEC_BYTES} byte limit`,
        code: "too-large",
      };
    }
    return { ok: true, value: source.spec };
  }
  if (source.path !== undefined) {
    return readContained(toolName, source.path, MAX_SPEC_BYTES);
  }
  return {
    ok: false,
    message: 'pass the spec as "spec" (YAML text) or "path" (a file)',
    code: "bad-input",
  };
}

/**
 * Write a contained file, reporting the bytes that landed.
 *
 * The path is re-resolved here rather than reusing whatever was resolved at
 * read time: the boundary has to hold at the moment of the syscall.
 */
export function writeContained(toolName: string, rel: string, content: string): Loaded<number> {
  const safe = resolveInput(toolName, rel);
  if (!safe.ok) return safe;
  try {
    writeFileSync(safe.value.real, content);
    return { ok: true, value: Buffer.byteLength(content, "utf8") };
  } catch (err) {
    // The node message carries an absolute path; only its first line, which
    // names the errno, is worth echoing.
    return {
      ok: false,
      message: `"${renderPath(rel)}" could not be written (${(err as Error).message.split("\n")[0]})`,
      code: "missing",
    };
  }
}

/** One JSONL file that was read, or the reason it was not. */
export type JsonlFile = {
  readonly name: string;
  readonly lines: ReadonlyArray<unknown>;
  /**
   * Non-blank lines `parse` could not turn into a value at all. Mining skips
   * them; the result says how many. Named for what it MEASURES: `parse` keeps
   * any JSON value, so a line holding a bare `3` is counted as read here and
   * skipped later by the context builder - calling this "not JSON objects"
   * would claim a precision the difference does not have.
   */
  readonly malformed: number;
};

export type JsonlDirectory = {
  /** The directory as the caller gave it, for echoing back. */
  readonly dir: string;
  readonly files: ReadonlyArray<JsonlFile>;
  /**
   * Files that exist but could not be read, each with the reason. NOT merged
   * into `files` with zero lines: a log that was too large to read says
   * nothing about the harness, and must not be counted as a log that did.
   */
  readonly unreadable: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
  /**
   * Set when the directory itself could not be listed - it does not exist, is
   * not a directory, or escapes the workspace. `files` is then empty for a
   * reason that is NOT "the harness has no sessions".
   */
  readonly unavailable?: string;
  /**
   * Set when the directory WAS listed but the pass stopped early (maxFiles or
   * maxTotalBytes). Deliberately NOT folded into `unavailable`: "there was
   * nothing to read" and "I read part of it" are different answers, and a
   * caller that is entitled to ignore the first - an absent optional
   * directory - is never entitled to ignore the second. Conflating them is
   * how a partial mining pass gets reported as a complete one.
   */
  readonly truncated?: string;
};

/**
 * Read every `*.jsonl` in a directory, in sorted name order so the same
 * directory always mines the same way (never `readdir` order, which is not
 * defined). `parse` is the package's own JSONL reader - this function does
 * not implement one.
 */
export function readJsonlDirectory(
  toolName: string,
  dirRel: string,
  parse: (text: string) => unknown[],
  maxBytesPerFile: number,
  maxFiles: number,
  maxTotalBytes: number = Number.POSITIVE_INFINITY,
): JsonlDirectory {
  const shown = renderPath(dirRel);
  const safe = resolveInput(toolName, dirRel);
  if (!safe.ok) return { dir: shown, files: [], unreadable: [], unavailable: safe.message };
  try {
    if (!statSync(safe.value.real).isDirectory()) {
      return {
        dir: shown,
        files: [],
        unreadable: [],
        unavailable: `"${shown}" is not a directory`,
      };
    }
  } catch {
    return {
      dir: shown,
      files: [],
      unreadable: [],
      unavailable: `"${shown}" does not exist or is unreadable`,
    };
  }
  let names: string[];
  try {
    names = readdirSync(safe.value.real)
      .filter((n) => n.endsWith(".jsonl"))
      // Plain code-unit order, never `localeCompare`: the ICU collation is
      // locale-dependent, and a listing that changes with $LANG is not a
      // deterministic one.
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch {
    return { dir: shown, files: [], unreadable: [], unavailable: `"${shown}" could not be listed` };
  }

  const files: JsonlFile[] = [];
  const unreadable: Array<{ name: string; reason: string }> = [];
  let truncated: string | undefined;
  let totalBytes = 0;
  for (const name of names) {
    if (files.length + unreadable.length >= maxFiles) {
      truncated = `only the first ${maxFiles} of ${names.length} .jsonl files were read (maxFiles)`;
      break;
    }
    // A per-file cap alone bounds nothing: a thousand files under it still
    // read a thousand times the cap. The whole pass gets a budget, and
    // stopping early is reported rather than presented as the whole directory.
    if (totalBytes >= maxTotalBytes) {
      truncated = `stopped after ${files.length} of ${names.length} .jsonl files and ${totalBytes} bytes (maxTotalBytes)`;
      break;
    }
    const rel = toPosix(path.join(dirRel, name));
    const read = readContained(toolName, rel, maxBytesPerFile);
    if (!read.ok) {
      unreadable.push({ name, reason: read.message });
      continue;
    }
    totalBytes += Buffer.byteLength(read.value, "utf8");
    const lines = parse(read.value);
    // `parse` drops blank and malformed lines silently, which is right for
    // mining and wrong for reporting: the count is recovered by comparing
    // against the non-blank line count, so a corrupt log is visible.
    const nonBlank = read.value.split("\n").filter((l) => l.trim() !== "").length;
    files.push({ name, lines, malformed: Math.max(0, nonBlank - lines.length) });
  }
  return {
    dir: shown,
    files,
    unreadable,
    ...(truncated !== undefined ? { truncated } : {}),
  };
}

/** Compact JSON - the reader is a model, and every byte is context. */
export function json(value: unknown): string {
  return JSON.stringify(value);
}

/** Plain code-unit ordering, for every sort in this package. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
