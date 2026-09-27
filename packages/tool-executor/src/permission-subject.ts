/**
 * What a permission rule is checked against, for one tool call.
 *
 * A rule used to be matched against the raw input the model sent, while the
 * tool ran on that input AFTER its schema had parsed it — unknown keys
 * stripped, defaults filled in. The two could disagree, and every
 * disagreement was a way past a rule: a decoy key the tool never reads, an
 * extra argument that stopped a deny from matching, a left-out field the tool
 * then filled with the very value a deny named. And a path was matched as a
 * string, so `build/../src` passed `build/**` and a symlinked directory led
 * somewhere no rule had looked.
 *
 * So a call is described the way the tool will see it:
 *
 * 1. The input is parsed with the tool's own schema. A call that does not
 *    parse cannot run, and is refused before any rule is read.
 * 2. When the tool declares `operativeArgs`, the values of those fields are
 *    read from the PARSED input (a declared `default` stands in for an
 *    omitted field) and canonicalised by kind:
 *    - a `path` goes through `canonicalizePath`. The Node runtime passes one
 *      that resolves the path against the workspace root, collapses `..` and
 *      follows symlinked directories, so the rule sees the place the tool
 *      will actually touch (runtime-core's `workspacePathCanonicalizer`).
 *      Without one — the edge worker has no filesystem to ask — `..` is
 *      collapsed lexically and a relative path that climbs above its start
 *      is flagged as outside, which no allow rule matches and every deny
 *      does.
 *    - a `url` is parsed (WHATWG) and matched as its `href`.
 *    - a `command` held as an array (an argv) is joined with spaces; each
 *      word is kept as another spelling, so a deny or ask rule naming one
 *      word (`RunCommand(rm)`) still fires on the whole argv.
 *    - a field declared `within` another is written `<qualifier>/<value>` —
 *      except a `command`, whose `within` names the directory it runs in:
 *      the program `./build.sh` names is another program in `src/`. A
 *      command run anywhere but the workspace root keeps its spellings for a
 *      deny or ask, and loses its canonical value, so no scoped allow
 *      covers it (the call asks). A command inside an array of objects
 *      (`steps.argv`) runs in its element's own directory field when it has
 *      one, else the top-level one.
 *    A tool that declares `[]` has no field that decides where it acts, and
 *    is matched on its string values like a tool that declares nothing.
 *
 * Nothing here touches the filesystem or imports a `node:` builtin: this
 * package is part of the worker runtime's import graph.
 */
import type { OperativeArg, OperativeArgKind, RegisteredTool } from "@crewhaus/tool-catalog";
import {
  type OperativeValue,
  type OperativeValueKind,
  normalizePathLexically,
} from "@crewhaus/tool-permission-matcher";
import { validateToolInput } from "@crewhaus/tool-validate";

// The declaration kinds (tool-catalog) and the value kinds (matcher) are two
// spellings of one union; this fails to compile the day they drift apart.
type SameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const kindsAgree: SameUnion<OperativeArgKind, OperativeValueKind> = true;
void kindsAgree;

/** Turns one path-kind operative value into the value(s) a rule is matched against. */
export type PathCanonicalizer = (raw: string) => ReadonlyArray<OperativeValue>;

export type PermissionSubject =
  | {
      readonly ok: true;
      /** The schema-parsed input: what the tool's `execute` will receive. */
      readonly input: unknown;
      /** Canonical values of the tool's `operativeArgs`; absent when the tool declares none. */
      readonly operativeValues?: ReadonlyArray<OperativeValue>;
    }
  | {
      readonly ok: false;
      /** The schema's validation message, naming what is wrong with the input. */
      readonly reason: string;
    };

export type PermissionSubjectOptions = {
  /**
   * How a path-kind value is canonicalised. Default: {@link lexicalPathValues}
   * — `..` collapsed, no symlinks followed, no workspace root known.
   */
  readonly canonicalizePath?: PathCanonicalizer;
};

/**
 * Parse `rawInput` with the tool's schema and read its operative values. The
 * input passed here must be exactly the one that will be handed to
 * `executeTool`, so the rule and the tool see the same call.
 */
export function preparePermissionSubject(
  tool: RegisteredTool,
  rawInput: unknown,
  opts: PermissionSubjectOptions = {},
): PermissionSubject {
  const validation = validateToolInput(tool, rawInput);
  if (!validation.ok) return { ok: false, reason: validation.error.message };
  const operativeValues = operativeValuesFor(tool, validation.value, opts);
  return {
    ok: true,
    input: validation.value,
    ...(operativeValues !== undefined ? { operativeValues } : {}),
  };
}

/**
 * The canonical operative values of an ALREADY PARSED input, or `undefined`
 * when the tool declares no `operativeArgs`, or declares `[]` (the matcher
 * then falls back to the input's string values).
 */
export function operativeValuesFor(
  tool: RegisteredTool,
  parsedInput: unknown,
  opts: PermissionSubjectOptions = {},
): ReadonlyArray<OperativeValue> | undefined {
  return operativeValuesOf(tool.operativeArgs, parsedInput, opts);
}

/**
 * {@link operativeValuesFor} from a declaration alone — for a caller that has
 * a tool's `operativeArgs` as data (the builtin manifest) but not the tool.
 * The values are read the same way; the caller is responsible for passing an
 * input the tool's schema has parsed, when it can.
 */
export function operativeValuesOf(
  operativeArgs: ReadonlyArray<OperativeArg> | undefined,
  parsedInput: unknown,
  opts: PermissionSubjectOptions = {},
): ReadonlyArray<OperativeValue> | undefined {
  if (operativeArgs === undefined || operativeArgs.length === 0) return undefined;
  const canonicalizePath = opts.canonicalizePath ?? lexicalPathValues;
  const values: OperativeValue[] = [];
  for (const arg of operativeArgs) {
    for (const { value: raw, words, runsIn } of readField(parsedInput, arg)) {
      switch (arg.kind) {
        case "path":
          values.push(...canonicalizePath(raw));
          break;
        case "url":
          values.push(canonicalUrl(raw));
          break;
        case "command":
          if (runsIn !== undefined && !namesWorkspaceRoot(canonicalizePath(runsIn))) {
            // Run in another directory, the same words may be another
            // program: nothing canonical for an allow to grant; a deny or ask
            // still reads what was written.
            values.push({ kind: "command", canonical: [], spellings: [raw, ...(words ?? [])] });
            break;
          }
          values.push({
            kind: "command",
            canonical: [raw],
            ...(words !== undefined ? { spellings: words } : {}),
          });
          break;
        default:
          values.push({
            kind: arg.kind,
            canonical: [raw],
            ...(words !== undefined ? { spellings: words } : {}),
          });
      }
    }
  }
  return values;
}

/**
 * One value of a declared field; `words` is the argv it was joined from, and
 * `runsIn` the directory a `command` declared `within` one runs in.
 */
type FieldReading = {
  readonly value: string;
  readonly words?: ReadonlyArray<string>;
  readonly runsIn?: string;
};

/** Do these canonical values name the workspace root itself, and nothing else? */
function namesWorkspaceRoot(values: ReadonlyArray<OperativeValue>): boolean {
  return (
    values.length > 0 && values.every((v) => v.outsideWorkspace !== true && v.canonical[0] === ".")
  );
}

/**
 * Every value of one declared field. Dots descend into objects; an array
 * anywhere on the way is walked element by element — except a `command`
 * field that IS an array of strings, which is one argv and is joined. A
 * field declared `within` another comes back as `<qualifier>/<value>`.
 */
export function readOperativeField(input: unknown, arg: OperativeArg): string[] {
  return readField(input, arg).map((r) => r.value);
}

function readField(input: unknown, arg: OperativeArg): FieldReading[] {
  const segments = arg.field.split(".");
  const out: FieldReading[] = [];
  const topQualifier = arg.within !== undefined ? qualifierOf(input, arg.within) : undefined;
  // A command runs in its own object's directory field (a pipeline step's
  // `cwd`), else the top-level one.
  const runsInOf = (owner: unknown): { runsIn?: string } => {
    if (arg.kind !== "command" || arg.within === undefined) return {};
    const dir = qualifierOf(owner, arg.within) ?? topQualifier;
    return dir !== undefined ? { runsIn: dir } : {};
  };
  const walk = (value: unknown, i: number, depth: number, owner: unknown): void => {
    if (depth > 64) return;
    if (Array.isArray(value)) {
      if (
        i === segments.length &&
        arg.kind === "command" &&
        value.length > 0 &&
        value.every((v) => typeof v === "string")
      ) {
        out.push({ value: value.join(" "), words: value as string[], ...runsInOf(owner) });
        return;
      }
      for (const element of value) walk(element, i, depth + 1, owner);
      return;
    }
    if (i === segments.length) {
      if (typeof value === "string") out.push({ value, ...runsInOf(owner) });
      else if (arg.kind === "id" && typeof value === "number" && Number.isFinite(value)) {
        out.push({ value: String(value) });
      }
      return;
    }
    if (value === null || typeof value !== "object") return;
    const key = segments[i] as string;
    if (!Object.hasOwn(value, key)) return;
    walk((value as Record<string, unknown>)[key], i + 1, depth + 1, value);
  };
  walk(input, 0, 0, input);
  if (out.length === 0 && arg.default !== undefined) {
    out.push({ value: arg.default, ...runsInOf(input) });
  }
  // A command's `within` is where it runs, carried as `runsIn` above.
  if (arg.kind === "command") return out;
  const qualifier = topQualifier;
  if (qualifier === undefined) return out;
  return out.map((r) =>
    // A path relative to a directory field; an absolute one ignores it.
    arg.kind === "path" && isAbsolutePath(r.value) ? r : { ...r, value: `${qualifier}/${r.value}` },
  );
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value);
}

/** The top-level `within` field's value, when the call carries one. */
function qualifierOf(input: unknown, field: string): string | undefined {
  if (input === null || typeof input !== "object" || !Object.hasOwn(input, field)) {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[field];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * The filesystem-free reading of a path: `..` and `.` collapsed, nothing
 * followed. A relative path that climbs above its start is flagged as
 * outside. Used where there is no workspace to ask (the edge worker); the
 * Node runtime passes a canonicaliser that also follows symlinks.
 */
export function lexicalPathValues(raw: string): OperativeValue[] {
  const lexical = normalizePathLexically(raw);
  if (lexical.escapes) {
    return [
      { kind: "path", canonical: [], spellings: [raw, lexical.path], outsideWorkspace: true },
    ];
  }
  const p = lexical.path;
  const canonical = p.startsWith("/") || p === "." ? [p] : [p, `./${p}`];
  return [{ kind: "path", canonical, spellings: [raw] }];
}

function canonicalUrl(raw: string): OperativeValue {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not a URL the tool could fetch. Nothing canonical to grant against; a
    // deny still reads what was written.
    return { kind: "url", canonical: [], spellings: [raw] };
  }
  const href = url.href;
  const canonical = [href];
  // `https://example.com` parses to `https://example.com/`. Both spell the
  // same request, so a rule written either way matches.
  if (url.pathname === "/" && url.search === "" && url.hash === "" && href.endsWith("/")) {
    canonical.push(href.slice(0, -1));
  }
  return { kind: "url", canonical, spellings: [raw] };
}
