/**
 * The shared answer shapes for this package: how a caller-supplied path is
 * echoed back, how a directory argument is contained, and how a read that
 * COULD NOT BE PERFORMED is distinguished from one that found nothing.
 *
 * That last distinction is what the `Loaded` type exists for, and routing is
 * where it bites hardest. A scoreboard with no arms is not a scoreboard
 * saying the routing is healthy — it is a store nobody has written to yet, or
 * one this process could not read. A freeze marker that will not parse is not
 * an absent freeze marker: `route freeze` is the kill switch, and reading a
 * corrupt one as "not frozen" is how a promotion walks straight through a pin
 * an operator set after an incident. So every read here carries its own
 * reason, and `[]` never stands in for "could not tell".
 */
import { realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import { type SafePath, ToolPermissionError, resolveSafe } from "../paths";

/** Compact JSON — the reader is a model, and every byte is context. */
export const json = (value: unknown): string => JSON.stringify(value);

/**
 * How much of a caller-supplied string is echoed back in a result.
 *
 * The message goes into a model's context, so a caller cannot be allowed to
 * spend that context with a megabyte of path, and cannot be allowed to
 * smuggle control characters (a NUL, an ANSI escape, a newline that forges a
 * second line of output) through a string a human or a model then reads.
 */
const MAX_ECHOED_CHARS = 200;

/** A caller-supplied string, safe to put in a message: bounded and printable. */
export function renderPath(given: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: neutralising control characters is the point
  const printable = given.replace(/[\u0000-\u001f\u007f]/g, "\uFFFD");
  return printable.length > MAX_ECHOED_CHARS
    ? `${printable.slice(0, MAX_ECHOED_CHARS)}…`
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
  | "frozen"
  | "corrupt";

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
 * Why `resolveSafe` refused — an ESCAPE, or a path it could not resolve.
 *
 * `paths.ts` is a verbatim copy of `@crewhaus/tool-pkg`'s and fails closed:
 * every error inside its symlink walk becomes one `ToolPermissionError`
 * saying the location "escapes the workspace root". Failing closed is right —
 * a path whose real location cannot be determined has not been proven
 * contained, so the call must still stop. Saying it ESCAPED is not: a name
 * this process cannot `realpath` (mode 0, an ELOOP chain, a component that is
 * not a directory) has not been shown to lead anywhere, and reporting it as
 * an escape sends the reader hunting for a symlink that is not there.
 *
 * So the refusal is classified after the fact, on the failure path only, by
 * asking the filesystem where the resolution actually stopped. A path that
 * resolves cleanly and was rejected anyway is an ESCAPE; one whose walk dies
 * on EACCES / ELOOP / ENOTDIR is UNREADABLE. `resolveSafe` remains the
 * authority on whether the call proceeds — this only decides what the result
 * says about it.
 */
function containmentFailure(abs: string): FailCode {
  let probe = abs;
  for (;;) {
    try {
      realpathSync(probe);
      return "refused";
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") return "unreadable";
      // A leaf that does not exist yet is normal — every write validates a
      // destination before making it — so ask the parent where it stopped.
      const parent = path.dirname(probe);
      if (parent === probe) return "refused";
      probe = parent;
    }
  }
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
      const shown = renderPath(rel);
      return containmentFailure(path.resolve(process.cwd(), rel)) === "unreadable"
        ? fail(
            "unreadable",
            `tool "${toolName}" could not resolve path "${shown}", so it cannot prove the location is inside the workspace root and refuses. That is not an absent path and not an escape — it is a path this process could not resolve.`,
          )
        : fail(
            "refused",
            `tool "${toolName}" rejected path "${shown}": resolved location escapes the workspace root`,
          );
    }
    throw err;
  }
}

/**
 * Contain every path an operation will actually TOUCH, not just the directory
 * it was handed.
 *
 * `contain` resolves the ROOT through its symlinks and proves the root sits
 * inside the workspace. It says nothing about the names BELOW it — and every
 * write in this package goes to one of those names: `routing/arms.jsonl`,
 * the `routing/arms.jsonl.tmp` that `compact()` and `promoteLanes()` rename
 * ON TOP of it, `routing/freeze.json` and its own `.tmp`,
 * `experiments/<sanitized>.jsonl`. A symlink sitting at one of those leaves
 * sends the write to the link's target, and a DANGLING one is the worst case:
 * `stat` reports it absent, so it does not even look like a conflict, while
 * `open(…, "w")` through it CREATES the target. Containing a directory and
 * not its leaves contains nothing.
 *
 * Each path therefore goes through the SAME `resolveSafe` the root went
 * through — symlink-aware, dangling links followed by hand — rather than a
 * second symlink walker written here. Returns the refusal, or `undefined`
 * when every path stays inside the workspace.
 */
export function containWritePaths(
  toolName: string,
  root: SafePath,
  rels: ReadonlyArray<string>,
): Failure | undefined {
  const shownRoot = root.rel === "" ? "." : root.rel;
  for (const rel of rels) {
    const under = root.rel === "" ? rel : `${root.rel}/${rel}`;
    const resolved = contain(toolName, under);
    if (resolved.ok) continue;
    // The CODE comes from `contain`, which already separated "this leads out
    // of the workspace" from "this could not be resolved at all". Flattening
    // them here would put the reader back to hunting for a symlink that is
    // not there.
    return resolved.code === "unreadable"
      ? fail(
          "unreadable",
          `"${renderPath(rel)}" under "${renderPath(shownRoot)}" could not be resolved, so this tool cannot prove the operation would stay inside the workspace root and refuses. ${resolved.reason}`,
        )
      : fail(
          "refused",
          `"${renderPath(rel)}" under "${renderPath(shownRoot)}" resolves outside the workspace root — a symlink on that path leads out, so the operation would land on the link's target rather than inside "${renderPath(shownRoot)}". Remove the link and run again; there is no flag for writing through it.`,
        );
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

/**
 * The widest epoch-ms `Date` can represent (ECMA-262 time-clip): ±100 000 000
 * days. One millisecond past it and `toISOString()` throws.
 */
const MAX_TIME_MS = 8.64e15;

/** True when `value` is an epoch-ms number `new Date(value)` can render. */
function renderableInstant(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_TIME_MS;
}

/**
 * Epoch ms → ISO, or `undefined` when there is nothing renderable.
 *
 * Total on purpose. `new Date(x).toISOString()` THROWS a RangeError for a
 * non-finite number and for anything outside ±8.64e15 ms, and the timestamps
 * this package renders do not all come from `statSync`: `WatchmeState` is
 * whatever JSON was in `state.json`, handed back by the store with only
 * `schemaVersion` checked. A hand-edited `startedAt: 1e20` used to leave
 * `execute` as an uncaught RangeError — a crash where a report belongs.
 */
export function iso(ms: unknown): string | undefined {
  return renderableInstant(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * A timestamp field read out of a document this package did not validate.
 *
 * Three answers, kept apart, because they are three different facts: the
 * field was not there (`null`), it was there and renders (the ISO string), or
 * it was there and is not an instant at all — which is a damaged state file,
 * not an absent timestamp, and must not read as one.
 */
export function instant(value: unknown): string | null | { readonly unrenderable: string } {
  if (value === undefined || value === null) return null;
  const rendered = iso(value);
  return rendered ?? { unrenderable: renderPath(String(value)) };
}

/** True when `value` is a plain JSON object — not an array, not a scalar. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A bounded slice of a list, plus the full count, for a result field. */
export function sample<T>(items: ReadonlyArray<T>, limit = 50): { shown: T[]; total: number } {
  return { shown: items.slice(0, limit), total: items.length };
}

/**
 * Sort with plain string comparison, never `localeCompare`.
 *
 * A result a test pins has to come out the same on every machine, and
 * `localeCompare` is locale-dependent (and ICU-build dependent). The stores
 * themselves sort with `localeCompare`, which is fine for a human table; a
 * tool's JSON gets re-sorted here so the ordering is a property of the data
 * rather than of the box the tool ran on.
 */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
