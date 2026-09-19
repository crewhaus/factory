/**
 * Contained reads, and the accounting that goes with them.
 *
 * Every filesystem answer in this package comes back as a {@link Loaded}: a
 * value, or a REASON it could not be produced. That shape is the whole point.
 * The failure this repository keeps re-committing is the one where an
 * unreadable thing is reported as an empty one — a failed sub-call as a zero
 * balance, a truncated listing as a complete one — and a return type that
 * cannot say "I could not tell" is how that happens. So nothing here returns
 * `[]` on an error, and nothing swallows a torn line without counting it.
 *
 * What this module does NOT do is parse the eval history.
 * `@crewhaus/eval-report` owns `index.jsonl` and `baselines.json` — including
 * the supersede-collapse rule a resumed run depends on — and re-deriving any
 * of it here is exactly the second implementation the extraction existed to
 * prevent. This module contains the path, bounds the bytes, counts the lines
 * the shared reader silently skipped, and hands the real reader a directory.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { type SafePath, ToolPermissionError, resolveSafe, toPosix } from "../paths";

/**
 * Why a read failed. Kept as a FIELD rather than sniffed out of the message,
 * so rewording a message can never turn a refusal into a carry-on.
 *
 * `missing` is the only code a caller may treat as "carry on and say so";
 * every other one is a refusal that must reach the result.
 */
export type FailureCode =
  | "refused"
  | "missing"
  | "not-a-file"
  | "not-a-directory"
  | "too-large"
  | "unreadable"
  | "malformed"
  | "bad-input";

export type Loaded<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: FailureCode; readonly message: string };

export function fail<T>(code: FailureCode, message: string): Loaded<T> {
  return { ok: false, code, message };
}

/**
 * How much of a caller-supplied path is echoed back in a message.
 *
 * The refusal lands in a model's context, so a caller cannot be allowed to
 * spend that context with a megabyte of path, and cannot be allowed to smuggle
 * control characters — a NUL, an ANSI escape, a newline that forges a second
 * line of output — through a string a human or a model then reads.
 */
const MAX_ECHOED_PATH_CHARS = 200;

/** A caller-supplied string, safe to put in a message: bounded and printable. */
export function renderPath(given: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: neutralising control characters is the point
  const printable = given.replace(/[\u0000-\u001f\u007f-\u009f]/g, "�");
  return printable.length > MAX_ECHOED_PATH_CHARS
    ? `${printable.slice(0, MAX_ECHOED_PATH_CHARS)}...`
    : printable;
}

/**
 * Contain a caller-supplied path.
 *
 * A NUL is refused HERE, before `resolveSafe` sees it: a NUL truncates a path
 * at the syscall boundary, so one string can resolve one way in the check and
 * another way in the open. That is "parse, then act on the PARSED value"
 * applied to a path — the check and the syscall must see the same bytes.
 */
export function contain(toolName: string, rel: string): Loaded<SafePath> {
  if (rel.includes("\u0000")) {
    return fail("refused", `"${renderPath(rel)}" contains a NUL byte and was not resolved`);
  }
  try {
    return { ok: true, value: resolveSafe(toolName, rel) };
  } catch (err) {
    if (err instanceof ToolPermissionError) return fail("refused", err.message);
    throw err;
  }
}

/** Resolve a directory argument, or say why it cannot be used. */
export function containedDir(toolName: string, rel: string): Loaded<SafePath> {
  const safe = contain(toolName, rel);
  if (!safe.ok) return safe;
  try {
    if (!statSync(safe.value.real).isDirectory()) {
      return fail("not-a-directory", `"${renderPath(rel)}" is not a directory`);
    }
  } catch {
    return fail("missing", `"${renderPath(rel)}" does not exist or is unreadable`);
  }
  return safe;
}

export type ReadFile = { readonly safe: SafePath; readonly text: string; readonly bytes: number };

/**
 * Read a contained file as UTF-8, refusing anything over `maxBytes`.
 *
 * The cap is applied to the SIZE ON DISK, before a byte is read, so the
 * refusal costs no memory. A cap applied after the read would not be a cap.
 */
export function readContained(toolName: string, rel: string, maxBytes: number): Loaded<ReadFile> {
  const safe = contain(toolName, rel);
  if (!safe.ok) return safe;
  return readResolved(safe.value, rel, maxBytes);
}

/** The half of {@link readContained} that runs once a path is already safe. */
export function readResolved(safe: SafePath, shownAs: string, maxBytes: number): Loaded<ReadFile> {
  const shown = renderPath(shownAs);
  let bytes: number;
  try {
    const stat = statSync(safe.real);
    if (!stat.isFile()) return fail("not-a-file", `"${shown}" is not a file`);
    bytes = stat.size;
  } catch {
    return fail("missing", `"${shown}" does not exist or is unreadable`);
  }
  if (bytes > maxBytes) {
    return fail(
      "too-large",
      `"${shown}" is ${bytes} bytes, over this tool's ${maxBytes}-byte limit — raise maxBytes or narrow the query`,
    );
  }
  try {
    return { ok: true, value: { safe, text: readFileSync(safe.real, "utf8"), bytes } };
  } catch {
    // The node error text carries the ABSOLUTE path, which is workspace layout
    // the caller did not supply and does not need.
    return fail("unreadable", `"${shown}" could not be read`);
  }
}

/** A JSONL read: the objects, and an honest account of what was not one. */
export type JsonlRead = {
  /** Objects, in file order. */
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  /** 1-based line numbers of non-blank lines that did not parse as JSON. */
  readonly malformedLines: ReadonlyArray<number>;
  /**
   * Lines that parsed but were not JSON OBJECTS (a bare number, a string, an
   * array). Counted separately because a reader that casts every parsed line
   * to its row type carries these along as empty rows and counts them in a
   * denominator.
   */
  readonly nonObjectLines: ReadonlyArray<number>;
  /** True when `maxRows` cut the read short — the rows are a PREFIX of the
   *  file, and a caller must not report them as the whole of it. */
  readonly truncated: boolean;
  /** Non-blank lines seen, truncated ones included. */
  readonly lines: number;
};

/**
 * Parse JSONL into objects, counting everything that was not one.
 *
 * Used for session logs and dataset files — never for the eval run index,
 * which `@crewhaus/eval-report` owns.
 */
export function parseJsonlObjects(text: string, maxRows: number): JsonlRead {
  const rows: Array<Record<string, unknown>> = [];
  const malformedLines: number[] = [];
  const nonObjectLines: number[] = [];
  let lines = 0;
  let truncated = false;
  const split = text.split("\n");
  for (let i = 0; i < split.length; i += 1) {
    const line = (split[i] as string).trim();
    if (line === "") continue;
    lines += 1;
    if (rows.length >= maxRows) {
      truncated = true;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLines.push(i + 1);
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      nonObjectLines.push(i + 1);
      continue;
    }
    rows.push(parsed as Record<string, unknown>);
  }
  return { rows, malformedLines, nonObjectLines, truncated, lines };
}

/** Non-blank lines in a text — the denominator a skipping parser never reports. */
export function countNonBlankLines(text: string): number {
  let n = 0;
  for (const line of text.split("\n")) if (line.trim() !== "") n += 1;
  return n;
}

/** Plain string ordering — never `localeCompare`, whose result depends on the
 *  host's locale and would make a listing machine-dependent. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export type DirListing = {
  readonly names: ReadonlyArray<string>;
  /** Names whose mtime could not be read, so their recency is unknown. */
  readonly unstatable: ReadonlyArray<string>;
  /**
   * Set when the directory itself could not be LISTED (it was removed, or
   * readdir was denied, between the containment check and this call).
   *
   * Without this the caller sees the same empty `names` an empty directory
   * produces, and every fraction computed downstream is then over zero
   * sessions while the report says "none found". An unreadable directory and
   * an empty one are different answers.
   */
  readonly listingFailed?: string;
};

/**
 * List a directory's `*.jsonl` files, most-recently-modified first.
 *
 * Recency is mtime — the ordering `crewhaus eval coverage` itself uses — with
 * the NAME as the tiebreak so two files written in the same millisecond still
 * order deterministically. `readdirSync` order is not an ordering and is never
 * relied on. A file that cannot be stat'ed is still listed (so it is still
 * read) and NAMED, because "I could not tell how recent this is" is not "this
 * is the oldest".
 *
 * `.events.jsonl` sidecars are excluded: they are trace sidecars beside a
 * session log, not session logs, and counting them would inflate the session
 * denominator every coverage fraction is computed against.
 */
export function listJsonlByRecency(dir: string): DirListing {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl") && !n.endsWith(".events.jsonl"));
  } catch (err) {
    // NOT `{ names: [] }`. That is the empty-directory answer, and returning it
    // here would turn "I could not list this" into "there is nothing here".
    return {
      names: [],
      unstatable: [],
      listingFailed: `the directory could not be listed (${
        (err as NodeJS.ErrnoException).code ?? "unknown error"
      })`,
    };
  }
  const unstatable: string[] = [];
  const keyed = names.map((name) => {
    try {
      return { name, mtime: statSync(path.join(dir, name)).mtimeMs };
    } catch {
      unstatable.push(name);
      return { name, mtime: Number.NEGATIVE_INFINITY };
    }
  });
  keyed.sort((a, b) => b.mtime - a.mtime || compareStrings(a.name, b.name));
  return { names: keyed.map((k) => k.name), unstatable: unstatable.sort(compareStrings) };
}

/** Join a workspace-relative directory with a filename, POSIX-style. */
export function joinRel(dirRel: string, name: string): string {
  return toPosix(path.join(dirRel, name));
}
