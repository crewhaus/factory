/**
 * The shared answer shapes for this package: how a caller-supplied path is
 * echoed back, how a directory argument is contained, and how a read that
 * COULD NOT BE PERFORMED is distinguished from one that found nothing.
 *
 * That last distinction is the whole point of the `Loaded` type. Four
 * irreversible operations sit behind these tools; every one of them decides
 * what to destroy from something it read first. A read that failed and got
 * reported as an empty result is how a retention sweep deletes a store it
 * could not enumerate, so an unreadable directory has its own code and its
 * own reason here, and never collapses into `[]`.
 */
import { statSync } from "node:fs";
import * as path from "node:path";
import { type SafePath, ToolPermissionError, resolveSafe } from "../paths";

/** Compact JSON — the reader is a model, and every byte is context. */
export const json = (value: unknown): string => JSON.stringify(value);

/**
 * How much of a caller-supplied path is echoed back in a result.
 *
 * The message goes into a model's context, so a caller cannot be allowed to
 * spend that context with a megabyte of path, and cannot be allowed to
 * smuggle control characters (a NUL, an ANSI escape, a newline that forges a
 * second line of output) through a string a human or a model then reads.
 */
const MAX_ECHOED_PATH_CHARS = 200;

/** A caller-supplied path, safe to put in a message: bounded and printable. */
export function renderPath(given: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: neutralising control characters is the point
  const printable = given.replace(/[\u0000-\u001f\u007f]/g, "\uFFFD");
  return printable.length > MAX_ECHOED_PATH_CHARS
    ? `${printable.slice(0, MAX_ECHOED_PATH_CHARS)}…`
    : printable;
}

/**
 * Why something could not be loaded.
 *
 * `missing` is the only code a caller may carry on past ("there is no store
 * here"); every other one is a refusal that must be returned. It is a field
 * rather than something sniffed out of the message so that rewording a
 * message can never silently turn a refusal into a carry-on.
 */
export type FailCode =
  | "refused"
  | "missing"
  | "not-a-directory"
  | "bad-input"
  | "unreadable"
  | "too-large";

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
 * The NUL guard is here rather than in `paths.ts` (which is a verbatim copy
 * of `@crewhaus/tool-pkg`'s, deliberately): a NUL truncates a path at the
 * syscall boundary, so `a\u0000/../../etc` can resolve one way in the
 * containment check and another way in the `open` that follows. Refused at
 * the gate instead of surfacing later as "unreadable".
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

/**
 * Contain every path an operation will WRITE, not just the directory it was
 * handed.
 *
 * `contain` resolves the ROOT through its symlinks and proves the root sits
 * inside the workspace. It says nothing about the names BELOW it — and the
 * writes these tools perform all go to those names: a store export copies to
 * `<dest>/sessions/<id>.json`, a knowledge push appends to
 * `<shared>/memories.jsonl`, a pull drops files into
 * `<harness>/.crewhaus/prompts`. A symlink sitting at one of those names
 * sends the write to the link's target instead, and a DANGLING one is the
 * worst case: `stat` reports it absent, so it does not even look like a
 * conflict, while `open(…, "w")` through it CREATES the target. Validating
 * the directory and then writing through a link underneath it is exactly the
 * "validate one spelling, act on another" shape this repository keeps paying
 * for.
 *
 * Each write path therefore goes through the SAME `resolveSafe` the root went
 * through — symlink-aware, dangling links followed by hand — rather than a
 * second symlink walker written here. Returns the refusal, or `undefined`
 * when every write path stays inside the workspace.
 */
export function containWritePaths(
  toolName: string,
  root: SafePath,
  rels: ReadonlyArray<string>,
): Failure | undefined {
  const shownRoot = root.rel === "" ? "." : root.rel;
  for (const rel of rels) {
    const under = root.rel === "" ? rel : `${root.rel}/${rel}`;
    if (!contain(toolName, under).ok) {
      return fail(
        "refused",
        `"${renderPath(rel)}" under "${renderPath(shownRoot)}" resolves outside the workspace root — a symlink on that path leads out, so the write would land on the link's target rather than inside "${renderPath(shownRoot)}". Remove the link and run again; there is no flag for writing through it.`,
      );
    }
  }
  return undefined;
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
    // could not be read", which is a different answer and must not be
    // reported as absence.
    return code === "ENOENT"
      ? fail("missing", `"${shown}" does not exist`)
      : fail("unreadable", `"${shown}" could not be read (${code ?? "unknown error"})`);
  }
  if (!stat.isDirectory()) return fail("not-a-directory", `"${shown}" is not a directory`);
  return safe;
}

/** True when `candidate` is `parent` or lives underneath it (both absolute). */
export function isInside(parent: string, candidate: string): boolean {
  const p = path.resolve(parent);
  const c = path.resolve(candidate);
  return c === p || c.startsWith(`${p}${path.sep}`);
}

/** True when either absolute path contains the other, or they are equal. */
export function overlaps(a: string, b: string): boolean {
  return isInside(a, b) || isInside(b, a);
}

/** Epoch ms → ISO, or `undefined` when there is nothing to render. */
export function iso(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

/** A bounded slice of a list, plus the full count, for a result field. */
export function sample<T>(items: ReadonlyArray<T>, limit = 50): { shown: T[]; total: number } {
  return { shown: items.slice(0, limit), total: items.length };
}
