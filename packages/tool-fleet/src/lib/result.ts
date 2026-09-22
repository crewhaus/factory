/**
 * The shared answer shapes for this package: how a caller-supplied path is
 * echoed back, how a path argument is contained, and how a read that COULD
 * NOT BE PERFORMED is kept apart from one that found nothing.
 *
 * That last distinction is the reason the `Loaded` type exists rather than a
 * bare `T | undefined`. Every tool here reports on a store somebody else
 * writes — the machine registry, a job ledger, a compiled bundle, a
 * human-owned `settings.json` — and every one of those stores answers an
 * unreadable file with an EMPTY result: `openHangarRegistry`'s reader
 * swallows a parse error into an empty document, `createFileJobStore.read`
 * returns `[]` for a file it could not open, `readManagerSettings` returns
 * its defaults for a file that is not JSON. Each is the right posture for a
 * boot path that must not die on a typo, and each is a LIE in a report: "no
 * harnesses registered" and "the registry could not be read" are different
 * answers, and only one of them means the fleet is empty.
 *
 * So the tools probe the file themselves before concluding anything from an
 * empty result, and the probe's failure has its own code and its own reason
 * here, which never collapses into `[]`.
 */
import { lstatSync, statSync } from "node:fs";
import * as path from "node:path";
import { type SafePath, ToolPermissionError, resolveSafe } from "../paths";

/** Compact JSON — the reader is a model, and every byte is context. */
export const json = (value: unknown): string => JSON.stringify(value);

/**
 * How much of a caller-supplied string is echoed back in a message.
 *
 * The message goes into a model's context, so a caller cannot be allowed to
 * spend that context with a megabyte of path, and cannot be allowed to
 * smuggle control characters (a NUL, an ANSI escape, a newline that forges a
 * second line of output) through a string a human or a model then reads.
 */
const MAX_ECHOED_CHARS = 200;

/**
 * How much of a PATH a store handed back is echoed back.
 *
 * Longer than a caller's own argument, because truncating an absolute path
 * an operator has to act on (a registry row's `dir`, a resolved hook
 * command) makes the answer useless; `PATH_MAX` is 1024 on every platform
 * this runs on, so nothing legitimate is cut.
 */
const MAX_ECHOED_STORE_PATH_CHARS = 1024;

/**
 * Text this package did not write, on its way into a model's context.
 *
 * Every string these tools report that they did not compute themselves came
 * from somewhere a caller does not control and an attacker might: a spec's
 * `name`, a bundle manifest's `compiledWith`, a row another writer put in
 * the machine registry, a line a spawned binary printed. Each is bounded
 * (so one of them cannot spend the whole context) and stripped of control
 * characters (so it cannot forge a second line of output, move a terminal
 * cursor, or end the framing of the field it sits in).
 *
 * This is NOT a claim that the text is trustworthy — a bounded, printable
 * sentence can still read like an instruction. It is the part that can be
 * done mechanically: whatever is reported stays inside the field it was put
 * in, and stays small.
 */
export function renderText(given: string, limit = MAX_ECHOED_CHARS): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: neutralising control characters is the point
  const printable = given.replace(/[\u0000-\u001f\u007f]/g, "\uFFFD");
  return printable.length > limit ? `${printable.slice(0, limit)}…` : printable;
}

/** A caller-supplied string, safe to put in a message: bounded and printable. */
export function renderPath(given: string): string {
  return renderText(given, MAX_ECHOED_CHARS);
}

/** A path a STORE handed back, safe to put in a result. */
export function renderStorePath(given: string): string {
  return renderText(given, MAX_ECHOED_STORE_PATH_CHARS);
}

/**
 * Why something could not be loaded.
 *
 * `missing` is the only code a caller may carry on past ("there is nothing
 * here"); every other one is a refusal that must be returned. It is a field
 * rather than something sniffed out of the message so that rewording a
 * message can never silently turn a refusal into a carry-on.
 */
export type FailCode =
  | "refused"
  | "missing"
  | "not-a-directory"
  | "not-a-file"
  | "bad-input"
  | "unreadable"
  | "conflict"
  | "unavailable";

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

/** A leaf's path as the workspace root sees it. One spelling, so the write
 *  gate and the read gate walk the same symlinks. */
function underRel(root: SafePath, rel: string): string {
  return root.rel === "" ? rel : `${root.rel}/${rel}`;
}

/**
 * Contain a path an operation will OPEN under an already-contained root.
 *
 * `contain` proves the DIRECTORY sits inside the workspace, with its own
 * symlinks resolved. It says nothing about the names below it, and every
 * file these tools read is one of those names: `<harness>/crewhaus.yaml`,
 * `<harness>/dist/package.json`, `<harness>/.crewhaus/settings.json`. A
 * symlink at one of them is read straight through — the spec of a harness
 * somewhere else entirely gets parsed, and its `name` comes back as this
 * harness's identity (and, for `HarnessRegister`, goes into the machine
 * registry). `@crewhaus/tool-crewhaus` already refuses exactly this for
 * `PreflightRun` and `HarnessInventory`; this is the same gate, so the two
 * packages answer a symlinked spec the same way.
 *
 * The leaf goes through the SAME `resolveSafe` the root went through, never
 * a second symlink walker. Returns the contained leaf, or the refusal.
 */
export function containUnder(toolName: string, root: SafePath, rel: string): Loaded<SafePath> {
  const safe = contain(toolName, underRel(root, rel));
  if (safe.ok) return safe;
  const shownRoot = root.rel === "" ? "." : root.rel;
  return fail(
    "refused",
    `"${renderPath(rel)}" under "${renderPath(shownRoot)}" resolves outside the workspace root — a symlink on that path leads out, so this call would open, and a recompile would WRITE, a location the workspace does not contain, and report it as this harness's own. Remove the link and run again; there is no flag for following it.`,
  );
}

/**
 * Contain every path an operation will WRITE, not just the directory it was
 * handed.
 *
 * `contain` resolves the ROOT through its symlinks and proves the root sits
 * inside the workspace. It says nothing about the names BELOW it — and the
 * write this package performs goes to one of those names:
 * `<harness>/.crewhaus/settings.json`, plus the temp file the atomic replace
 * renames from. A symlink sitting at one of those names sends the write to
 * the link's target instead, and a DANGLING one is the worst case: `stat`
 * reports it absent, so it does not even look like a conflict, while
 * `open(…, "w")` through it CREATES the target. Validating the directory and
 * then writing through a link underneath it is exactly the "validate one
 * spelling, act on another" shape this repository keeps paying for — and the
 * write here ends in a RENAME, which replaces whatever the link points at.
 *
 * Each write path goes through the SAME `resolveSafe` the root went through,
 * rather than a second symlink walker written here. Returns the refusal, or
 * `undefined` when every write path stays inside the workspace.
 */
export function containWritePaths(
  toolName: string,
  root: SafePath,
  rels: ReadonlyArray<string>,
): Failure | undefined {
  const shownRoot = root.rel === "" ? "." : root.rel;
  for (const rel of rels) {
    if (!contain(toolName, underRel(root, rel)).ok) {
      return fail(
        "refused",
        `"${renderPath(rel)}" under "${renderPath(shownRoot)}" resolves outside the workspace root — a symlink on that path leads out, so the write would land on the link's target rather than inside "${renderPath(shownRoot)}". Remove the link and run again; there is no flag for writing through it.`,
      );
    }
  }
  return undefined;
}

/** What a NAME is, keeping "absent" and "could not tell" apart. */
export type NameKind = "file" | "directory" | "symlink" | "other";

/**
 * Probe a path with `lstat` — the NAME itself, never what it leads to.
 *
 * Returned as a `Loaded` so the three answers stay three: it is there and it
 * is a file, it is not there, or it could not be determined. A boolean
 * `existsSync` collapses the last two, which is how an EACCES store gets
 * reported as an empty one.
 */
export function probeName(shown: string, abs: string): Loaded<NameKind | undefined> {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR"
      ? { ok: true, value: undefined }
      : fail("unreadable", `"${shown}" could not be read (${code ?? "unknown error"})`);
  }
  if (stat.isSymbolicLink()) return { ok: true, value: "symlink" };
  if (stat.isDirectory()) return { ok: true, value: "directory" };
  if (stat.isFile()) return { ok: true, value: "file" };
  return { ok: true, value: "other" };
}

/** True when `candidate` is `parent` or lives underneath it (both absolute). */
export function isInside(parent: string, candidate: string): boolean {
  const p = path.resolve(parent);
  const c = path.resolve(candidate);
  return c === p || c.startsWith(`${p}${path.sep}`);
}

/** A bounded slice of a list, plus the full count, for a result field. */
export function sample<T>(items: ReadonlyArray<T>, limit = 50): { shown: T[]; total: number } {
  return { shown: items.slice(0, limit), total: items.length };
}

/** Plain string order — never `localeCompare`, so a listing is the same
 *  bytes on every machine regardless of locale. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
