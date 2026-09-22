/**
 * The shared answer shapes for this package: how a caller-supplied string is
 * echoed back, how a path argument is contained, and how a read that COULD
 * NOT BE PERFORMED is distinguished from one that found nothing.
 *
 * That last distinction is why `Loaded` exists rather than `T | undefined`.
 * Every tool here decides what to pin from something it read first, and the
 * registry's own reads collapse two very different answers into one: a
 * missing `manifest.json` and a manifest behind a dangling symlink both come
 * back from `loadManifest` as `{ versions: [], pins: {} }`. Reported as "no
 * versions", that is how a rollback refuses a version that is really there,
 * and how a pin writes a fresh manifest over a registry it could not read.
 * So an unreadable manifest carries its own code and its own reason here, and
 * never collapses into an empty one.
 *
 * Deliberately a near-sibling of `@crewhaus/tool-lifecycle`'s `lib/result.ts`:
 * the two packages share the convention, not the module (neither exports it),
 * and the containment helper below delegates to the verbatim `paths.ts` copy
 * rather than growing a second symlink walker.
 */
import { lstatSync, statSync } from "node:fs";
import * as path from "node:path";
import { type SafePath, ToolPermissionError, resolveSafe } from "../paths";

/** Compact JSON — the reader is a model, and every byte is context. */
export const json = (value: unknown): string => JSON.stringify(value);

/**
 * How much of a string this package did not author is echoed back.
 *
 * The result goes into a model's context, so neither a caller nor a file on
 * disk may spend that context with a megabyte of text, and neither may
 * smuggle control characters (a NUL, an ANSI escape, a newline that forges a
 * second line of output) through a string a human or a model then reads.
 *
 * THIS APPLIES TO RESULT FIELDS, NOT ONLY TO MESSAGES. A manifest's `pins`
 * keys and `versions` entries, a `listSpecs` directory name and a caller's
 * `actor` reach exactly the same reader a refusal's `reason` does, and a
 * value that has to be neutralised in one has to be neutralised in the other.
 * Sanitising the prose and handing the same string through untouched one key
 * away is this repository's standing defect shape: validate one spelling, act
 * on another.
 *
 * It costs nothing legitimate. Every name involved must satisfy one of
 * `@crewhaus/spec-registry`'s grammars to mean anything at all (`NAME_REGEX`,
 * `VERSION_REGEX`, `ENV_REGEX`, `TENANT_REGEX`), and none of those admits a
 * control character or a 200-character name — so this is the identity on
 * every value a caller could act on, and bites only on ones they could not.
 */
const MAX_ECHOED_CHARS = 200;

/** A string this package did not author, safe to return: bounded and printable. */
export function render(given: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: neutralising control characters is the point
  const printable = given.replace(/[\u0000-\u001f\u007f]/g, "\uFFFD");
  return printable.length > MAX_ECHOED_CHARS
    ? `${printable.slice(0, MAX_ECHOED_CHARS)}…`
    : printable;
}

/** `render`, through a list of store-supplied names. */
export const renderAll = (values: ReadonlyArray<string>): string[] => values.map(render);

/** `render`, passing `undefined` through, for an optional result field. */
export const renderOpt = (given: string | undefined): string | undefined =>
  given === undefined ? undefined : render(given);

/**
 * `render` through every string of a record another package built.
 *
 * `@crewhaus/deployment-controller`'s `DeploymentRecordPayload` is returned
 * verbatim rather than rebuilt — rebuilding it would be a second copy of a
 * shape that package owns, which is the drift this package exists to avoid —
 * but its `fromVersion` comes straight out of the manifest and its `actor`
 * straight from the caller. So the record keeps its own shape and its strings
 * are neutralised in place.
 */
export function renderStrings(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = typeof v === "string" ? render(v) : v;
  }
  return out;
}

/**
 * Why something could not be loaded.
 *
 * `missing` is the only code a caller may carry on past ("there is no
 * registry entry here"); every other one is a refusal that must be returned.
 * It is a field rather than something sniffed out of the message so that
 * rewording a message can never silently turn a refusal into a carry-on.
 */
export type FailCode =
  | "refused"
  | "missing"
  | "not-a-directory"
  | "bad-input"
  | "unreadable"
  | "conflict";

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
 * `@crewhaus/tool-pkg`'s, deliberately): a NUL truncates a path at the
 * syscall boundary, so `a\u0000/../../etc` can resolve one way in the
 * containment check and another way in the `open` that follows. Refused at
 * the gate instead of surfacing later as "unreadable".
 */
export function contain(toolName: string, rel: string): Loaded<SafePath> {
  if (rel.includes("\u0000")) {
    return fail("refused", `"${render(rel)}" contains a NUL byte`);
  }
  try {
    return { ok: true, value: resolveSafe(toolName, rel) };
  } catch (err) {
    if (err instanceof ToolPermissionError) {
      // The error's own message carries the path unrendered; rebuild it so a
      // control character in the caller's input cannot reach the output.
      return fail(
        "refused",
        `tool "${toolName}" rejected path "${render(rel)}": resolved location escapes the workspace root`,
      );
    }
    throw err;
  }
}

/**
 * Contain every path the REGISTRY will open under a root, not just the root
 * the caller named.
 *
 * `contain` resolves the root through its symlinks and proves the root sits
 * inside the workspace. It says nothing about the names BELOW it — and every
 * write `@crewhaus/spec-registry` and `@crewhaus/spec-changelog` perform goes
 * to those names: `<root>/<name>/manifest.json`, `<root>/<name>/<v>.yaml`,
 * `<root>/<name>/CHANGELOG.md`, `<root>/_tenants/<id>/<name>.json`. All four
 * are written with `writeFileSync`, which FOLLOWS a symlink sitting at the
 * name; a DANGLING one is the worst case, because `stat` reports it absent —
 * so it does not even look like a conflict — while `open(…, "w")` through it
 * CREATES the target. Validating the directory and then writing through a
 * link underneath it is exactly the "validate one spelling, act on another"
 * shape this repository keeps paying for.
 *
 * Each path therefore goes through the SAME `resolveSafe` the root went
 * through — symlink-aware, dangling links followed by hand. Returns the
 * refusal, or `undefined` when every path stays inside the workspace.
 */
export function containUnder(
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
        `"${render(rel)}" under "${render(shownRoot)}" resolves outside the workspace root — a symlink on that path leads out, so the registry would read or write the link's target rather than something inside "${render(shownRoot)}". Remove the link and run again; there is no flag for working through it.`,
      );
    }
  }
  return undefined;
}

/** Resolve a directory that must already exist. */
export function containExistingDir(toolName: string, rel: string): Loaded<SafePath> {
  const safe = contain(toolName, rel);
  if (!safe.ok) return safe;
  const shown = render(rel);
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

/**
 * What a NAME on disk is, keeping "not there" apart from "could not tell" and
 * from "a link standing in for it".
 *
 * `lstat`, not `stat`: the question is about the name itself. The registry's
 * readers all probe with `existsSync`, which FOLLOWS links and therefore
 * answers `false` for a dangling one — the single case where "absent" and
 * "there is a door here" are the same word. Every caller of this helper is
 * somewhere that difference decides whether a read result means "empty".
 */
export type NameKind =
  | { readonly kind: "absent" }
  | { readonly kind: "file" }
  | { readonly kind: "directory" }
  | { readonly kind: "symlink"; readonly dangling: boolean }
  | { readonly kind: "other" }
  | { readonly kind: "unreadable"; readonly code: string };

export function probeName(abs: string): NameKind {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable", code: code ?? "unknown" };
  }
  if (st.isSymbolicLink()) {
    let dangling = true;
    try {
      statSync(abs);
      dangling = false;
    } catch {
      // Stays true: the link leads nowhere that can be stat'd.
    }
    return { kind: "symlink", dangling };
  }
  if (st.isDirectory()) return { kind: "directory" };
  if (st.isFile()) return { kind: "file" };
  return { kind: "other" };
}

/** True when `candidate` is `parent` or lives underneath it (both absolute). */
export function isInside(parent: string, candidate: string): boolean {
  const p = path.resolve(parent);
  const c = path.resolve(candidate);
  return c === p || c.startsWith(`${p}${path.sep}`);
}

/** Epoch ms → ISO, or `undefined` when there is nothing to render. */
export function iso(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

/** A bounded slice of a list, plus the full count, for a result field. */
export function sample<T>(items: ReadonlyArray<T>, limit = 50): { shown: T[]; total: number } {
  return { shown: items.slice(0, limit), total: items.length };
}
