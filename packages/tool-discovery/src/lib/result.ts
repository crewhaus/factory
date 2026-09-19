/**
 * The answer shapes for this package: how a caller-supplied path is echoed
 * back, how a directory argument is contained, and how a read that COULD NOT
 * BE PERFORMED is kept apart from one that found nothing.
 *
 * The shapes are `@crewhaus/tool-lifecycle`'s, reproduced here because that
 * package exports its tools and not its library. The distinction they encode
 * is the one a DISCOVERY tool is most dangerous for breaking: both tools here
 * answer "what is out there", and both of them can fail to find out.
 *
 *   - A registry directory that could not be listed is not an empty
 *     marketplace. An operator who reads "0 templates" stops looking.
 *   - A template file that did not parse is not a template that is not there.
 *     The registry source skips it silently; something has to say it did.
 *   - A peer that did not answer is not a peer that is gone. Reporting it as
 *     absent makes the federation look smaller than it is; reporting it as
 *     present makes it look healthier. Both are wrong in a way an operator
 *     acts on.
 */
import { statSync } from "node:fs";
import { type SafePath, ToolPermissionError, resolveSafe } from "../paths";
import { quoteUntrusted } from "./untrusted";

/** Compact JSON — the reader is a model, and every byte is context. */
export const json = (value: unknown): string => JSON.stringify(value);

/**
 * Plain string ordering. `localeCompare` is locale-sensitive, so the same
 * registry sorts differently under a different `LANG`; every listing in this
 * package uses this instead.
 */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** How much of a caller-supplied path is echoed back in a result. */
const MAX_ECHOED_PATH_CHARS = 200;

/**
 * A path, safe to put in a message: bounded and printable.
 *
 * The message goes into a model's context, so nobody can spend that context
 * with a megabyte of path, and nobody can smuggle characters that forge a
 * rendering (a NUL, an ANSI escape, a newline that forges a second line of
 * output, a bidi override that displays the rest of the line reversed).
 *
 * WHY THIS COPY IS STRONGER THAN `@crewhaus/tool-lifecycle`'s. That one
 * replaces C0 and DEL, which is the right set for the only thing it is ever
 * handed: a path the CALLER wrote. Here the same helper is also handed a
 * registry FILENAME off a readdir and a manifest's own `name` — strings
 * whoever published the template chose — so it must neutralise exactly what
 * `authored` text does, or the same string arrives sanitized under `authored`
 * and raw two fields later. That is not hypothetical: a name carrying U+202E
 * and U+0085 reached `unknowns[].probe` untouched while its quoted copy was
 * clean.
 */
export function renderPath(given: string): string {
  return quoteUntrusted(given, MAX_ECHOED_PATH_CHARS).text;
}

/**
 * Why something could not be loaded.
 *
 * `missing` is the only code a caller may carry on past ("there is no registry
 * here"); every other one is a refusal that must be returned. It is a FIELD
 * rather than something sniffed out of the message, so that rewording a
 * message can never silently turn a refusal into a carry-on.
 */
export type FailCode = "refused" | "missing" | "not-a-directory" | "bad-input" | "unreadable";

export type Failure = { readonly ok: false; readonly reason: string; readonly code: FailCode };
export type Loaded<T> = { readonly ok: true; readonly value: T } | Failure;

export function fail(code: FailCode, reason: string): Failure {
  return { ok: false, reason, code };
}

/** The JSON a tool returns when it will not proceed. */
export function refusal(tool: string, code: FailCode, reason: string, extra = {}): string {
  return json({ tool, status: "refused", code, reason, ...extra });
}

/**
 * Resolve a caller-supplied path inside the workspace.
 *
 * The NUL guard is here rather than in `paths.ts` (a verbatim copy of
 * `@crewhaus/tool-pkg`'s, deliberately): a NUL truncates a path at the syscall
 * boundary, so `a\u0000/../../etc` can resolve one way in the containment
 * check and another way in the `open` that follows.
 */
export function contain(toolName: string, rel: string): Loaded<SafePath> {
  if (rel.includes("\u0000")) {
    return fail("refused", `"${renderPath(rel)}" contains a NUL byte`);
  }
  try {
    return { ok: true, value: resolveSafe(toolName, rel) };
  } catch (err) {
    if (err instanceof ToolPermissionError) {
      // The error's own message carries the path unrendered; rebuild it so a
      // control character in the caller's input cannot reach the output.
      return fail(
        "refused",
        `tool "${toolName}" rejected path "${renderPath(rel)}": resolved location escapes the workspace root`,
      );
    }
    throw err;
  }
}

/** Resolve a directory that must already exist. */
export function containExistingDir(toolName: string, rel: string): Loaded<SafePath> {
  const safe = contain(toolName, rel);
  if (!safe.ok) return safe;
  const shown = renderPath(rel);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(safe.value.real);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT is "there is nothing here"; EACCES/ELOOP/anything else is "this
    // could not be read", which is a different answer and must not be reported
    // as absence.
    return code === "ENOENT"
      ? fail("missing", `"${shown}" does not exist`)
      : fail("unreadable", `"${shown}" could not be read (${code ?? "unknown error"})`);
  }
  if (!stat.isDirectory()) return fail("not-a-directory", `"${shown}" is not a directory`);
  return safe;
}

/**
 * The vocabulary for "I could not find out" — `@crewhaus/tool-approvals`'
 * `Unknowns`, which took it from `@crewhaus/tool-pkgmgr`.
 *
 * A fact that could not be established is `null` in the result AND carries an
 * entry here naming the field, what was tried, and why it did not answer. A
 * count is never defaulted to zero and a list is never reported as complete
 * when the read that produced it was cut short. `every null is explained` in
 * index.test.ts walks each tool's output and fails if any null is missing its
 * entry, so the rule cannot rot.
 */
export type UnknownFact = {
  /** Dotted path of the field in the result, e.g. "results.0.signature". */
  readonly field: string;
  /** What was tried: a path read, a request made, or why none was attempted. */
  readonly probe: string;
  /** Why it did not answer, in a sentence a caller can act on. */
  readonly reason: string;
};

export class Unknowns {
  private readonly facts = new Map<string, UnknownFact>();

  add(field: string, probe: string, reason: string): void {
    // First writer wins: the innermost failure is the specific one, and a
    // later generic "this section is unavailable" must not overwrite it.
    if (!this.facts.has(field)) this.facts.set(field, { field, probe, reason });
  }

  has(field: string): boolean {
    return this.facts.has(field);
  }

  get size(): number {
    return this.facts.size;
  }

  /**
   * Sorted by field, so two calls against the same tree return the same bytes
   * rather than whatever order the reads happened to fail in.
   */
  list(): ReadonlyArray<UnknownFact> {
    return [...this.facts.values()].sort((a, b) => compareStrings(a.field, b.field));
  }
}

/** The first non-empty line of an error text, capped. Length only. */
export function firstLine(text: string, max = 200): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (line === undefined) return "";
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** The message of a thrown value, whatever it is, bounded. */
export function errText(err: unknown, max = 200): string {
  const line = firstLine(err instanceof Error ? err.message : String(err), max);
  // Quoted like `authored` text, because a library's message can CARRY
  // authored text: `LocalRegistrySource` interpolates a manifest's own `name`
  // into `invalid template name "…"`, and a stat error carries a filename.
  // `firstLine` runs first — it splits on a real newline, which the quoting
  // would have replaced — and the quoting catches everything else, including
  // the C1 codes and bidi overrides that a newline split never sees.
  return quoteUntrusted(line, max).text;
}
