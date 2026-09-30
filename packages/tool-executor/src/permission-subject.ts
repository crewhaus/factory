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
 *      word (`RunCommand(rm)`) still fires on the whole argv. A word that
 *      names a file through `.`, `..` or a doubled `/` is also read with
 *      them collapsed, so `scripts//release.sh` is `scripts/release.sh`.
 *    - a field declared `within` another is written `<qualifier>/<value>` —
 *      except a `command`, whose `within` names the directory it runs in:
 *      the program `./build.sh` names is another program in `src/`. A
 *      command run anywhere but the workspace root loses its canonical
 *      value, so no scoped allow covers it (the call asks) except one that
 *      names every command (`RunCommand(**)`). A deny or ask reads it as
 *      written, and each word that may name a file also as that file from
 *      the root, so `alwaysDeny RunCommand(*scripts/release.sh*)` fires on
 *      `[sh, release.sh]` run in `scripts/`. Only the directory's
 *      workspace-relative spellings (and the one the call wrote) are joined:
 *      the workspace's own absolute path is not something the call named,
 *      so `RunCommand(**prod**)` does not fire because the workspace lives
 *      in `prod-agent/`. A bare program name (`git`) is not joined — PATH
 *      finds it, not the directory. A command inside an array of objects
 *      (`steps.argv`) runs in its element's own directory field when it has
 *      one, else the top-level one.
 *      Unless it is a path or a command, the value alone and the qualifier
 *      alone are kept as other spellings, so a deny or ask rule written
 *      without the qualifier — `alwaysDeny EvmCall(0xdAC17F…)`,
 *      `EvmCall(*)`, the way 0.7.0 matched every string in the call — still
 *      fires. An allow must name the qualified value, so it cannot be
 *      widened by leaving the qualifier out.
 *    - a `command` declared with an `env` field — the variables the call
 *      sets in the child's environment — can run another program than its
 *      words say: PATH decides what a bare program name is, and BASH_ENV,
 *      NODE_OPTIONS, LD_PRELOAD and the like load code of their own. So a
 *      call that sets any variable loses its canonical value (only an
 *      allow naming every command covers it), and a deny or ask also reads
 *      a bare program as it is found on each PATH entry the call sets, and
 *      every value it sets — each word that may name a file also joined to
 *      where it resolves. An
 *      environment too large to read that way (more than
 *      {@link MAX_ENV_VARS} variables, {@link MAX_ENV_WORDS} words in a
 *      value, or a value longer than {@link MAX_ENV_VALUE_CHARS} characters)
 *      is flagged `outsideWorkspace`: which program runs could not be worked
 *      out, so every deny or ask fires, and only an allow naming every
 *      command covers it.
 *    - a field left out whose declared default is `*` stands for every
 *      value (`standsForAny`), whatever its kind: a deny or ask naming any
 *      one value there fires on it, and an allow grants it only when it
 *      covers every value there. A path stands for every path under its
 *      directory (the workspace root when it has none); a URL, or a
 *      command, for any at all. When the field is declared `within` another
 *      that the call leaves out as well, it stands for every
 *      `<qualifier>/<value>` (`anyQualifier`): a code search naming no owner
 *      reaches every repository.
 *    - a field declared `prefix` (KvList's `prefix`) stands for every value
 *      that starts with it, whether the call gives it or leaves it out (the
 *      empty prefix): `<qualifier>/<prefix>` followed by any run, since a
 *      key may hold `/`, and the prefix alone for a deny written without
 *      the qualifier (read one segment on, so a deny naming another
 *      namespace's key does not fire on every listing).
 *    - a `path` declared `beneath` (a directory the tool walks: RemovePath,
 *      Grep, a git pathspec) also carries its spellings as `beneath`
 *      prefixes, so a deny or ask naming anything under it fires —
 *      unless the canonicaliser marked it `notDirectory`. One declared
 *      `defaultAtRoot` and left out is the workspace root, not its `within`
 *      directory: a git command given no path acts on the whole repository.
 *    - a `path` declared `glob` (the Glob tool's pattern) is marked
 *      `globPattern`: the matcher reads it as every path it can list.
 *    - a `relocates` field left out stands in with its default, which a
 *      deny or ask reads; when the call carries another operative value an
 *      allow skips it (`restrictOnly`), because the grant is about the
 *      record the call names, not the store it lives in.
 *    - an `id`, `recipient` or `text` value that is `0x` hex (an address, a
 *      hash — `0x` or `0X`, both of which a node accepts) is marked
 *      `caseInsensitive`: its letter case is at most an EIP-55 checksum, so
 *      a deny or ask rule must not be dodged by it.
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
  // The defaults of relocating fields the call left out. Whether an allow
  // reads them depends on what else the call carries, so they are placed
  // last (see `relocates` on OperativeArg).
  const relocated: OperativeValue[] = [];
  for (const arg of operativeArgs) {
    for (const {
      value: raw,
      words,
      runsIn,
      env,
      dir,
      unqualified,
      every,
      anyAfter,
      defaulted,
      anyQualifier,
      prefixOf,
    } of readField(parsedInput, arg)) {
      if (arg.relocates === true && defaulted === true) {
        if (arg.kind === "url") relocated.push(canonicalUrl(raw));
        else relocated.push(...canonicalizePath(raw));
        continue;
      }
      switch (arg.kind) {
        case "path": {
          if (every === true) {
            values.push(...everyPathValues(dir ?? ".", canonicalizePath));
            break;
          }
          const read = canonicalizePath(raw);
          const { beneath } = arg;
          if (arg.glob === true) {
            // A pattern the tool lists the paths of: the matcher reads it as
            // every path it can list.
            values.push(
              ...read.map((v) => (v.outsideWorkspace === true ? v : { ...v, globPattern: true })),
            );
            break;
          }
          values.push(...(beneath !== undefined ? read.map((v) => withBeneath(v, beneath)) : read));
          break;
        }
        case "url":
          values.push(
            every === true
              ? { kind: "url", canonical: [ANY_VALUE], standsForAny: [""] }
              : canonicalUrl(raw),
          );
          break;
        case "command": {
          const dirValues = runsIn !== undefined ? canonicalizePath(runsIn) : undefined;
          const elsewhere =
            runsIn !== undefined && dirValues !== undefined && !namesWorkspaceRoot(dirValues);
          const setsEnv = env !== undefined && Object.keys(env).length > 0;
          const argv = words ?? raw.split(/\s+/).filter((w) => w !== "");
          const read = commandSpellings(
            argv,
            elsewhere ? runDirSpellings(runsIn as string, dirValues as OperativeValue[]) : [],
            setsEnv ? env : undefined,
            canonicalizePath,
          );
          if (elsewhere || setsEnv) {
            // Run in another directory, or with an environment the call set,
            // the same words may be another program: nothing canonical for an
            // allow to grant. A deny or ask reads what was written, and each
            // word also as the file it names there — `release.sh` run in
            // `scripts/` is `scripts/release.sh`, which a deny may name.
            values.push({
              kind: "command",
              canonical: [],
              spellings: [...new Set([raw, ...(words ?? []), ...read.spellings])],
              ...(read.unreadable ? { outsideWorkspace: true } : {}),
              ...(every === true ? { standsForAny: [""] } : {}),
            });
            break;
          }
          const spellings = [...new Set([...(words ?? []), ...read.spellings])];
          values.push({
            kind: "command",
            canonical: [raw],
            ...(spellings.length > 0 ? { spellings } : {}),
            ...(anyAfter !== undefined ? { standsForAny: anyAfter } : {}),
          });
          break;
        }
        default: {
          const spellings = [...(words ?? []), ...(unqualified ?? [])];
          values.push({
            kind: arg.kind,
            canonical: [raw],
            ...(spellings.length > 0 ? { spellings } : {}),
            ...(HEX_ID.test(raw) ? { caseInsensitive: true } : {}),
            ...(anyAfter !== undefined ? { standsForAny: anyAfter } : {}),
            ...(anyQualifier === true ? { anyQualifier: true } : {}),
            // A prefix stands for every value that starts with it, and a
            // key may hold `/`: what follows is any run, not one segment.
            ...(prefixOf !== undefined ? { standsForAnyRun: true } : {}),
          });
          // The prefix alone, for a deny or ask written without the
          // qualifier (`alwaysDeny KvGet(apikey)`, as for any `within`
          // field). Read one segment on: with a run, a deny naming another
          // namespace's key (`secrets/apikey`) would fire on every listing
          // with no prefix, whatever namespace it lists.
          if (prefixOf?.unqualified !== undefined) {
            values.push({
              kind: arg.kind,
              canonical: [],
              standsForAny: [prefixOf.unqualified],
              restrictOnly: true,
            });
          }
        }
      }
    }
  }
  // A relocating field's default is a place the call did not name. When the
  // call names a record there, an allow is about the record and skips the
  // default; a deny or ask still reads it. With nothing else to read, the
  // default is the call's only place, and every rule reads it.
  if (values.length > 0) {
    for (const v of relocated) values.push({ ...v, restrictOnly: true });
  } else {
    values.push(...relocated);
  }
  return values;
}

/** A value that ends in a `0x` (or `0X`) hex id, after any `<qualifier>/`. */
const HEX_ID = /(?:^|\/)0[xX][0-9a-fA-F]+$/;

/**
 * One value of a declared field. `words` is the argv it was joined from;
 * `runsIn` the directory a `command` declared `within` one runs in; `dir`
 * the directory a `path` declared `within` one is relative to;
 * `unqualified` the value and its qualifier apart, for any other `within`
 * field; `every` that a left-out field's `*` default stands for every value,
 * and `anyAfter` the prefixes after which it does for an id, a recipient, a
 * text value or a command run at the root (a path, a URL and a command run
 * elsewhere build their own). `env` is the environment a `command` declared
 * with an `env` field sets for its child.
 */
type FieldReading = {
  readonly value: string;
  readonly words?: ReadonlyArray<string>;
  readonly runsIn?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** The directory a `path` declared `within` one is relative to. */
  readonly dir?: string;
  readonly unqualified?: ReadonlyArray<string>;
  /** The field was left out and its default `*` stands for every value. */
  readonly every?: true;
  readonly anyAfter?: ReadonlyArray<string>;
  /** The declared default, standing in for a field the call left out. */
  readonly defaulted?: true;
  /** With `anyAfter`: the `within` qualifier was left out too. */
  readonly anyQualifier?: true;
  /**
   * A field declared `prefix`: `anyAfter` is followed by any run, and
   * `unqualified` is the prefix alone when the value was qualified.
   */
  readonly prefixOf?: { readonly unqualified?: string };
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
  // And with its own object's environment field, else the top-level one.
  const topEnv = arg.env !== undefined ? envMapOf(input, arg.env) : undefined;
  const envOf = (owner: unknown): { env?: Readonly<Record<string, string>> } => {
    if (arg.kind !== "command" || arg.env === undefined) return {};
    const env = envMapOf(owner, arg.env) ?? topEnv;
    return env !== undefined ? { env } : {};
  };
  const placed = (owner: unknown) => ({ ...runsInOf(owner), ...envOf(owner) });
  const walk = (value: unknown, i: number, depth: number, owner: unknown): void => {
    if (depth > 64) return;
    if (Array.isArray(value)) {
      if (
        i === segments.length &&
        arg.kind === "command" &&
        value.length > 0 &&
        value.every((v) => typeof v === "string")
      ) {
        out.push({ value: value.join(" "), words: value as string[], ...placed(owner) });
        return;
      }
      for (const element of value) walk(element, i, depth + 1, owner);
      return;
    }
    if (i === segments.length) {
      if (typeof value === "string") out.push({ value, ...placed(owner) });
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
  if (arg.prefix === true && arg.kind !== "path" && arg.kind !== "url" && arg.kind !== "command") {
    return prefixReadings(out, arg, topQualifier);
  }
  // A default of `*` is "every value": EvmGetLogs without an `address`
  // reads every contract's logs.
  const every = out.length === 0 && arg.default === ANY_VALUE;
  if (out.length === 0 && arg.default !== undefined) {
    out.push({ value: arg.default, ...placed(input), defaulted: true });
  }
  const anyValue = (rs: FieldReading[]): FieldReading[] =>
    every ? rs.map((r) => ({ ...r, every: true, anyAfter: [""] })) : rs;
  // A command's `within` is where it runs, carried as `runsIn` above.
  if (arg.kind === "command") return anyValue(out);
  const qualifier = topQualifier;
  if (qualifier === undefined) {
    // The qualifier is left out as well: a code search with no owner reaches
    // every repository, so the value stands for every `<owner>/<repo>` too.
    const read = anyValue(out);
    return every && arg.within !== undefined
      ? read.map((r) => ({ ...r, anyQualifier: true as const }))
      : read;
  }
  return out.map((r) => {
    // A path relative to a directory field; an absolute one ignores it.
    if (arg.kind === "path") {
      if (every) return { ...r, value: `${qualifier}/${r.value}`, dir: qualifier, every: true };
      // A git command given no path acts on the whole repository, wherever
      // it runs: its default is the workspace root, not the directory.
      if (r.defaulted === true && arg.defaultAtRoot === true) return r;
      return isAbsolutePath(r.value) ? r : { ...r, value: `${qualifier}/${r.value}` };
    }
    return {
      ...r,
      value: `${qualifier}/${r.value}`,
      unqualified: [r.value, qualifier],
      ...(every ? { every: true, anyAfter: [`${qualifier}/`, ""] } : {}),
    };
  });
}

/** The declared default that stands for every value of its field. */
const ANY_VALUE = "*";

/**
 * The readings of a field declared `prefix` (KvList's `prefix`): each value
 * `p` stands for every value that starts with it, and one left out is the
 * empty prefix — every value. Qualified, `<qualifier>/<p>` is followed by any
 * run (a key may hold `/`), and `<p>` alone is kept for a deny written
 * without the qualifier. With the qualifier left out too, the value stands
 * for every `<qualifier>/<value>` there is: an allow must name every value.
 */
function prefixReadings(
  out: ReadonlyArray<FieldReading>,
  arg: OperativeArg,
  qualifier: string | undefined,
): FieldReading[] {
  const prefixes = out.length > 0 ? out.map((r) => r.value) : [""];
  return prefixes.map((p): FieldReading => {
    if (qualifier === undefined) {
      const anyQualifier = arg.within !== undefined;
      const start = anyQualifier ? "" : p;
      return {
        value: `${start}${ANY_VALUE}`,
        every: true,
        anyAfter: [start],
        prefixOf: {},
        ...(out.length === 0 ? { defaulted: true } : {}),
      };
    }
    return {
      value: `${qualifier}/${p}${ANY_VALUE}`,
      unqualified: [`${p}${ANY_VALUE}`, qualifier],
      every: true,
      anyAfter: [`${qualifier}/${p}`],
      prefixOf: { unqualified: p },
      ...(out.length === 0 ? { defaulted: true } : {}),
    };
  });
}

/**
 * Every path under `dir` — a path field left out whose default is `*` — as
 * the values a rule reads: for each place `dir` resolves to, its spellings
 * as prefixes (`sub/`, `/abs/ws/sub/`; the workspace root is the empty
 * prefix) and `<prefix>*` as the canonical spelling an allow must cover
 * whole. A directory outside the workspace stays outside: every deny or ask
 * fires on it, and no allow does.
 */
function everyPathValues(dir: string, canonicalizePath: PathCanonicalizer): OperativeValue[] {
  const under = (p: string): string => (p === "." ? "" : p.endsWith("/") ? p : `${p}/`);
  return canonicalizePath(dir).map((v): OperativeValue => {
    if (v.outsideWorkspace === true) return v;
    return {
      kind: "path",
      canonical: v.canonical.map((c) => `${under(c)}${ANY_VALUE}`),
      standsForAny: [...new Set([...v.canonical, ...(v.spellings ?? [])].map(under))],
      ...(v.caseInsensitive === true ? { caseInsensitive: true } : {}),
    };
  });
}

/**
 * A path the tool walks when it names a directory (`beneath` on its
 * OperativeArg): each of its spellings as a prefix a deny or ask reads with
 * anything after it. A path the canonicaliser found to be an existing
 * non-directory stands for itself alone, and one outside the workspace
 * already fires every deny.
 */
function withBeneath(value: OperativeValue, mode: "all" | "visible"): OperativeValue {
  if (value.outsideWorkspace === true || value.notDirectory === true) return value;
  // The root — `.`, or the empty path a call may write for it — is the empty
  // prefix, never `/`, which would read as the filesystem root.
  const under = (p: string): string => (p === "." || p === "" ? "" : p.endsWith("/") ? p : `${p}/`);
  return {
    ...value,
    beneath: [...new Set([...value.canonical, ...(value.spellings ?? [])].map(under))],
    ...(mode === "visible" ? { beneathSkipsHidden: true } : {}),
  };
}

/**
 * The most variables, words in one value, and characters in one value, of an
 * environment a command's call sets that a deny or ask reads one by one. A
 * call past any of them is flagged `outsideWorkspace` instead: which program
 * it runs could not be worked out, so every deny or ask fires on it.
 */
export const MAX_ENV_VARS = 64;
export const MAX_ENV_WORDS = 64;
export const MAX_ENV_VALUE_CHARS = 8192;

/** What a deny or ask also reads for one command, beyond what the call wrote. */
type CommandReading = {
  readonly spellings: ReadonlyArray<string>;
  /** The call's environment was too large to read; see {@link MAX_ENV_VARS}. */
  readonly unreadable: boolean;
};

/**
 * The workspace-relative spellings of the directory a command runs in, and
 * the one the call wrote, without trailing slashes: `scripts/` and
 * `./scripts` as written, `scripts` as canonicalised, `lnk` for a symlink
 * the canonicaliser followed to `scripts`. The canonicaliser's absolute
 * spellings of the workspace root are left out — the call named none of
 * them, and joining them put every word the workspace's own path holds
 * (`prod-agent/…`, `/private/var/…`) in front of every command run in a
 * subdirectory. Its `./sub` spellings are left out too: a word the call did
 * not write with `./` is not read with one, so `RunCommand(./**)` does not
 * fire on `git status` run in `sub/`.
 */
function runDirSpellings(runsIn: string, dirValues: ReadonlyArray<OperativeValue>): string[] {
  const out = new Set<string>();
  const add = (d: string): void => {
    const trimmed = d.replace(/[\\/]+$/, "");
    if (trimmed !== "" && trimmed !== ".") out.add(trimmed);
  };
  add(runsIn);
  for (const v of dirValues) {
    for (const d of [...v.canonical, ...(v.spellings ?? [])]) {
      if (isAbsolutePath(d) || d.startsWith("./") || d === ".") continue;
      add(d);
    }
  }
  return [...out];
}

/**
 * `dir/word`, as written and with `.`, `..` and doubled `/` collapsed. A join
 * that climbs out of the directory it starts in is kept only as written: its
 * collapsed form would drop the climb.
 */
function joinedSpellings(dir: string, word: string): string[] {
  const written = `${dir}/${word}`;
  const lexical = normalizePathLexically(written);
  return lexical.escapes || lexical.path === written ? [written] : [written, lexical.path];
}

/** A word with separators, collapsed the way {@link joinedSpellings} does, when that changes it. */
function collapsedWord(word: string): string | undefined {
  if (!/[\\/]/.test(word)) return undefined;
  const lexical = normalizePathLexically(word);
  return lexical.escapes || lexical.path === word || lexical.path === "."
    ? undefined
    : lexical.path;
}

/**
 * The spellings a deny or ask reads for one command beyond the words as
 * written. Every spelling only widens what a deny or ask catches; none is
 * canonical, so no allow reads them.
 *
 * - Each word that names a file through `.`, `..` or a doubled `/`, with
 *   them collapsed, and the command line with those words collapsed.
 * - For a command run in a directory other than the root (`dirs`, its
 *   relative spellings): each word that may name a file joined to the
 *   directory — except a bare program name, which PATH finds, not the
 *   directory — and the command line with those words joined, once per
 *   directory. So `scripts/**` fires on `sh x` run in `scripts/`. The
 *   directory on its own is not a spelling: `alwaysDeny RunCommand(rm*)` must
 *   not fire on `ls` run in `rmtemp/`.
 * - For a call that sets its child's environment (`env`): a bare program as
 *   PATH finds it on each entry the call sets — a relative entry is looked
 *   up from the workspace root and run from the child's directory (Bun's
 *   spawn does both), so both are read, and an absolute entry inside the
 *   workspace is read from the root — and every value the call sets, each of
 *   its words that may name a file (split at spaces, `:`, `=` and `;`, so
 *   `--require=./hook.js` and `a:b` are read) as written, collapsed, and
 *   joined to the child's directory.
 */
function commandSpellings(
  argv: ReadonlyArray<string>,
  dirs: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> | undefined,
  canonicalizePath: PathCanonicalizer,
): CommandReading {
  const out = new Set<string>();
  const program = argv[0] ?? "";
  const bareProgram = program !== "" && !/[\\/]/.test(program);
  // Words collapsed where the call wrote a separator.
  let collapsedAny = false;
  const collapsedLine = argv.map((w) => {
    const c = namesAFile(w) ? collapsedWord(w) : undefined;
    if (c === undefined) return w;
    out.add(c);
    collapsedAny = true;
    return c;
  });
  if (collapsedAny) out.add(collapsedLine.join(" "));
  // Words joined to the directory the command runs in.
  for (const d of dirs) {
    const line = argv.map((w, i) => {
      if ((i === 0 && bareProgram) || !namesAFile(w)) return w;
      const joined = joinedSpellings(d, w);
      for (const j of joined) out.add(j);
      return joined[joined.length - 1] as string;
    });
    out.add(line.join(" "));
  }
  if (env === undefined) return { spellings: [...out], unreadable: false };
  const entries = Object.entries(env);
  let unreadable = entries.length > MAX_ENV_VARS;
  // Where a relative path in a value resolves: the child's directory.
  const places = dirs.length > 0 ? dirs : ["."];
  for (const [name, value] of entries.slice(0, MAX_ENV_VARS)) {
    if (value.length > MAX_ENV_VALUE_CHARS) {
      unreadable = true;
      continue;
    }
    if (value !== "") out.add(value);
    const words = value.split(/[\s:=;]+/).filter((w) => w !== "");
    if (words.length > MAX_ENV_WORDS) unreadable = true;
    for (const w of words.slice(0, MAX_ENV_WORDS)) {
      if (!namesAFile(w)) continue;
      out.add(w);
      const c = collapsedWord(w);
      if (c !== undefined) out.add(c);
      for (const d of dirs) for (const j of joinedSpellings(d, w)) out.add(j);
    }
    if (name.toUpperCase() !== "PATH" || !bareProgram) continue;
    const pathEntries = value.split(":");
    if (pathEntries.length > MAX_ENV_WORDS) unreadable = true;
    for (const raw of pathEntries.slice(0, MAX_ENV_WORDS)) {
      const entry = raw === "" ? "." : raw.replace(/[\\/]+$/, "") || "/";
      const found = new Set<string>();
      if (isAbsolutePath(entry)) {
        found.add(`${entry === "/" ? "" : entry}/${program}`);
        for (const v of canonicalizePath(entry)) {
          if (v.outsideWorkspace === true) continue;
          for (const c of [...v.canonical, ...(v.spellings ?? [])]) {
            if (isAbsolutePath(c) || c.startsWith("./")) continue;
            found.add(c === "." ? program : `${c}/${program}`);
          }
        }
      } else {
        for (const j of joinedSpellings(entry, program)) found.add(j);
        for (const d of places) {
          for (const j of joinedSpellings(d === "." ? entry : `${d}/${entry}`, program))
            found.add(j);
        }
      }
      for (const f of found) {
        out.add(f);
        out.add([f, ...argv.slice(1)].join(" "));
      }
    }
  }
  return { spellings: [...out], unreadable };
}

/** The string-valued entries of the object at `field`, when the call carries one. */
function envMapOf(input: unknown, field: string): Readonly<Record<string, string>> | undefined {
  if (input === null || typeof input !== "object" || !Object.hasOwn(input, field)) {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[field];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(value)) if (typeof v === "string") out[name] = v;
  return out;
}

/**
 * Could this argv word name a file relative to the working directory? Not a
 * flag, not an absolute path, not a URL; anything else might be a program
 * or a script (`release.sh`, `./eslint`, `bin/tool`).
 */
function namesAFile(word: string): boolean {
  return word !== "" && !word.startsWith("-") && !isAbsolutePath(word) && !word.includes("://");
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
