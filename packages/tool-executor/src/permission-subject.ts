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
 *      them collapsed (and with the `./` it was written with kept), so
 *      `scripts//release.sh` is `scripts/release.sh`.
 *    - the words of a command that name a file are read where the kernel
 *      finds them (`readProgramPath`; runtime-core's reader walks each name
 *      from the directory the command runs in, a `..` after a symlink
 *      climbing out of the link's target): its program when written with a
 *      `/` (also through wrappers such as `env` or `sudo`), a bare program on
 *      each entry of a PATH a wrapper or the line sets (`env PATH=dir x`,
 *      `PATH=dir x`), and each script an interpreter (`sh`, `node`, `bun`,
 *      `python`, …) is handed — from a file on its input too (`sh < x.sh`).
 *      One that lands elsewhere than it reads is put in its place for an
 *      allow: `./scripts/../evil.sh` is `./evil.sh`, which
 *      `RunCommand(./scripts/**)` does not grant, and a deny or ask reads
 *      that place too — `link/../run.sh` with `link → secrets/deep` is
 *      `secrets/run.sh`. A program reached through a symlink to it
 *      (`node_modules/.bin/eslint`) is named by the link; a deny or ask also
 *      reads where the link leads. A program named by an absolute path
 *      outside the workspace is read as written unless it has a `..` after
 *      a name: the system's own links (`/bin → usr/bin`) are not the call's
 *      to move. One read where a wrapper moved the command (`env -C`), or
 *      found on a PATH entry, cannot be put in its place in the argv: no
 *      scoped allow grants it. Every other word of an argv with a `/` (any
 *      word, where a wrapper moved it) is read the same way, for a deny or
 *      ask only — another program may run it (`arch x`, `find -exec x`) —
 *      and a grant is bound to where it lands.
 *    - a line a shell parses runs each command where the `cd`s before it
 *      leave it: joined as text the way `cd` does by default, walked when it
 *      is `cd -P`, and each place a `cd` that may not have run leaves it
 *      (`cd a; x` may run x in either). A wrapper's directory (`env -C`) is
 *      walked as the kernel walks it. A line cannot have a word put in its
 *      place, so an allow must also name each command whose words moved,
 *      with them put in: `Bash(./scripts/**)` does not grant
 *      `./scripts/lnk/run.sh` (`lnk → ../evil`), and `Bash(node **)` still
 *      grants a script reached through a linked package directory. `$PWD`
 *      is the directory the command runs in. A word read from a directory
 *      that cannot be told (`cd "$X"`, `cd -`, a `cd` in a loop), or that a
 *      variable the line does not set or a `~` starts, is read as written;
 *      with a `..` after a name it cannot be placed. A pattern the shell
 *      expands is read as every path it can list; a script that is one with
 *      a wildcard before its last name cannot be placed. A word that cannot
 *      be placed — also one with a `..` after a name and no reader (the edge
 *      worker) — is flagged `outsideWorkspace`.
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
 *      A path declared `within` a directory that is absolute or has a `..`
 *      segment — the call's directory or the root when it gives none — is
 *      flagged `outsideWorkspace`: the tool hands it on as written to a
 *      program running there, and the OS follows a symlink before the `..`
 *      after it, so `../x.ts` run in `link/` (`link → secrets/deep`) is
 *      `secrets/x.ts`, not the `x.ts` a collapsed reading names (see
 *      `leavesItsDirectory`).
 *      Unless it is a path or a command, the value alone and the qualifier
 *      alone are kept as other spellings, so a deny or ask rule written
 *      without the qualifier — `alwaysDeny EvmCall(0xdAC17F…)`,
 *      `EvmCall(*)`, the way 0.7.0 matched every string in the call — still
 *      fires. An allow must name the qualified value, so it cannot be
 *      widened by leaving the qualifier out.
 *    - a `command` declared `shell` and held as a string is a line a shell
 *      parses: it is marked `shell`, and the matcher reads each simple
 *      command in it (an allow must match every one, a deny or ask fires on
 *      any). A `command` held as an argv is never split — no shell reads it
 *      — but when the program it names is a shell given `-c`, an `eval` or
 *      an `env -S` (after wrappers such as `env` or `sudo`), the line that
 *      runs is added as a value only a deny or ask reads, marked `shell`:
 *      `alwaysDeny RunCommand(rm **)` fires on `["sh", "-c", "a && rm x"]`.
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
 *      unless the canonicaliser marked it `notDirectory`. A walk that
 *      skips hidden names reads them too when the call sets the switch its
 *      `hiddenWhen` names (Tree's `includeHidden`). One declared
 *      `defaultAtRoot` and left out is the workspace root, not its `within`
 *      directory: a git command given no path acts on the whole repository.
 *    - a `path` declared `glob` (the Glob tool's pattern) is marked
 *      `globPattern`: the matcher reads it as every path it can list.
 *    - a `relocates` field left out stands in with its default, which a
 *      deny or ask reads; when the call carries another operative value an
 *      allow skips it (`restrictOnly`), because the grant is about the
 *      record the call names, not the store it lives in. One declared
 *      `beneath` too (a store the tool reads whole) carries its prefixes.
 *    - an `id` declared `secretRef` is a secret reference, trimmed as the
 *      tool trims it; a `file:` or `envfile:` one is matched with the file
 *      it names canonicalised in it, and the file is also a value only a
 *      deny or ask reads (see {@link secretRefValues}).
 *    - a field declared `source` (where the tool takes a value from) is read
 *      by a deny or ask only.
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
  type ProgramWords,
  type ShellDir,
  climbsAfterName,
  holdsUnexpanded,
  linesRunBy,
  normalizePathLexically,
  programWords,
  readsShellOnInput,
  shellProgramWords,
  withShellPwd,
} from "@crewhaus/tool-permission-matcher";
import { validateToolInput } from "@crewhaus/tool-validate";

// The declaration kinds (tool-catalog) and the value kinds (matcher) are two
// spellings of one union; this fails to compile the day they drift apart.
type SameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const kindsAgree: SameUnion<OperativeArgKind, OperativeValueKind> = true;
void kindsAgree;

/** Turns one path-kind operative value into the value(s) a rule is matched against. */
export type PathCanonicalizer = (raw: string) => ReadonlyArray<OperativeValue>;

/**
 * Where a word of a command that names a file lands — a program run by its
 * path, or a script handed to an interpreter — read the way the kernel reads
 * it from the directory the command runs in (`runsIn` as the call wrote it;
 * `undefined` for the workspace root): each directory on the way followed,
 * and each `..` applied AFTER the link before it, so `link/../run.sh` with
 * `link → secrets/deep` is `secrets/run.sh`. `undefined` when that cannot be
 * worked out (a loop of links, a directory that cannot be searched, a path
 * longer than any path can be): no tool can run the word either.
 */
export type ProgramPathReader = (
  word: string,
  runsIn: string | undefined,
  opts?: ProgramPathReaderOptions,
) => ProgramPathReading | undefined;

/** How a {@link ProgramPathReader} is asked about one word. */
export type ProgramPathReaderOptions = {
  /**
   * The word is an argument of the command, or a candidate on a PATH it
   * sets, rather than its program or script: a reader that keeps a record
   * of where words land (for an approval to be bound to) keeps it only
   * when the word lands elsewhere than it reads, or is a symlink.
   */
  readonly argument?: boolean;
  /**
   * Where the command moved from `runsIn` before the word is opened,
   * walked as the kernel walks it: a wrapper's directory (`env -C dir`), a
   * `cd -P`. The word is read from there; `asWritten` joins all three as
   * text.
   */
  readonly prefix?: string;
};

/** One word read by a {@link ProgramPathReader}. */
export type ProgramPathReading = {
  /** Absolute: where the word lands, its last name as written (not followed). */
  readonly at: string;
  /** `at` relative to the workspace root (`.` for the root, never `./`), when it is inside it. */
  readonly inWorkspace?: string;
  /** Absolute: the same word read as text — joined to the directory, `..` collapsed, nothing followed. */
  readonly asWritten: string;
  /** Whether {@link asWritten} is inside the workspace. */
  readonly writtenInWorkspace: boolean;
  /** Where the last name leads when it is a symlink: the file the kernel runs. */
  readonly target?: { readonly at: string; readonly inWorkspace?: string };
};

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
  /**
   * Where a command word that names a file lands. Default: none — the words
   * are read as text, and one with a `..` after a name is flagged outside,
   * since a symlink before the `..` could not be seen.
   */
  readonly readProgramPath?: ProgramPathReader;
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
    const from = values.length;
    for (const {
      value: raw,
      words,
      runsIn,
      env,
      stdin,
      dir,
      leavesDir,
      unqualified,
      every,
      anyAfter,
      defaulted,
      anyQualifier,
      prefixOf,
    } of readField(parsedInput, arg)) {
      if (arg.relocates === true && defaulted === true) {
        if (arg.kind === "url") relocated.push(canonicalUrl(raw));
        else {
          // A store the tool reads whole, whatever record the call names
          // (DatasetMine's sessions directory), is read with what is in it.
          const { beneath } = arg;
          const read = canonicalizePath(raw);
          relocated.push(
            ...(beneath !== undefined ? read.map((v) => withBeneath(v, beneath)) : read),
          );
        }
        continue;
      }
      switch (arg.kind) {
        case "path": {
          if (every === true) {
            values.push(...everyPathValues(dir ?? ".", canonicalizePath));
            break;
          }
          if (leavesDir !== undefined) {
            values.push(leavingValue(raw, leavesDir.written));
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
          // A walk that skips hidden names opens them too when the call sets
          // the switch its declaration names (Tree's `includeHidden`).
          const walk =
            beneath === "visible" &&
            arg.hiddenWhen !== undefined &&
            switchedOn(parsedInput, arg.hiddenWhen)
              ? "all"
              : beneath;
          values.push(...(walk !== undefined ? read.map((v) => withBeneath(v, walk)) : read));
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
          // A shell parses a string it is handed; an argv reaches one only
          // when the program it names is a shell, an eval or an env -S.
          const shellLine = arg.shell === true && words === undefined;
          const shell = shellLine ? { shell: true } : {};
          // The lines an argv hands a shell: one it runs with `-c`, and the
          // text the call puts on the input of a shell given no script.
          const shellLines =
            words !== undefined
              ? [
                  ...linesRunBy(words),
                  ...(stdin !== undefined && readsShellOnInput(words) ? [stdin] : []),
                ]
              : [];
          const where = { runsIn, readProgramPath: opts.readProgramPath };
          const read = commandSpellings(
            argv,
            elsewhere ? runDirSpellings(runsIn as string, dirValues as OperativeValue[]) : [],
            setsEnv ? env : undefined,
            canonicalizePath,
            where,
          );
          // The words that name a file, read where the OS finds them: an
          // argv's own, and those of each command of a line a shell runs
          // (the Bash tool's, or one an argv hands to `sh -c`). A string that
          // is neither, and runs nowhere in particular, is code for a sandboxed
          // interpreter (`Python`'s `code`), not a command line.
          const found = programWords(argv);
          const own = shellLine
            ? readShellPrograms([raw], where)
            : words !== undefined || arg.within !== undefined
              ? readCommand(argv, found, [{ runsIn, prefix: "" }], where, {
                  rewrite: true,
                  shell: false,
                })
              : NOTHING_READ;
          // A line an argv hands a shell starts where the wrappers before
          // the shell moved to (`env -C dir sh -c …`).
          const handed = readShellPrograms(shellLines, where, chdirPrefix(found));
          // A word that lands elsewhere than it reads is put in its place for
          // an allow. A line an argv hands a shell cannot have it put in, so
          // no scoped allow grants the argv; one the Bash tool runs is
          // granted only by an allow that also names each command with it
          // put in (`placed`, below).
          const ungrantable =
            own.unplaceable ||
            own.ungrantable ||
            handed.unplaceable ||
            handed.moved ||
            handed.ungrantable;
          const unplaceable = read.unreadable || own.unplaceable || handed.unplaceable;
          const programSpellings = shellLine ? [] : own.spellings;
          if (elsewhere || setsEnv || ungrantable) {
            // Run in another directory, or with an environment the call set,
            // the same words may be another program: nothing canonical for an
            // allow to grant. A deny or ask reads what was written, and each
            // word also as the file it names there — `release.sh` run in
            // `scripts/` is `scripts/release.sh`, which a deny may name.
            values.push({
              kind: "command",
              canonical: [],
              spellings: [
                ...new Set([raw, ...(words ?? []), ...read.spellings, ...programSpellings]),
              ],
              ...shell,
              ...(unplaceable ? { outsideWorkspace: true } : {}),
              ...(every === true ? { standsForAny: [""] } : {}),
            });
          } else {
            // A program word that lands elsewhere than it reads is read where
            // it lands: `./scripts/../evil.sh` is `./evil.sh`, which
            // `RunCommand(./scripts/**)` does not grant.
            const canonical = own.rewritten?.join(" ") ?? raw;
            const spellings = [
              ...new Set([
                ...(canonical !== raw ? [raw] : []),
                ...(words ?? []),
                ...read.spellings,
                ...programSpellings,
              ]),
            ];
            values.push({
              kind: "command",
              canonical: [canonical],
              ...(spellings.length > 0 ? { spellings } : {}),
              ...shell,
              ...(anyAfter !== undefined ? { standsForAny: anyAfter } : {}),
            });
            // A line a shell parses cannot have a word put in its place, so
            // an allow reads each command whose words moved, with them put
            // in, as well as the line: `Bash(./scripts/**)` does not grant
            // `./scripts/lnk/run.sh` (lnk → ../evil), and `Bash(node **)`
            // still grants a script through a linked package directory.
            for (const command of new Set(own.placed)) {
              values.push({ kind: "command", canonical: [command] });
            }
          }
          values.push(...shellLineValues(shellLines));
          // What a deny or ask reads of the program words in a line a shell
          // parses, as plain text: read as a line again, a word with its
          // quoting taken off could split into commands the line never runs.
          values.push(
            ...programPlaceValues(
              shellLine ? [...own.spellings, ...handed.spellings] : handed.spellings,
              [...own.patterns, ...handed.patterns],
            ),
          );
          break;
        }
        default: {
          if (arg.secretRef === true) {
            values.push(...secretRefValues(raw, canonicalizePath));
            break;
          }
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
    // Where the tool takes a value from: a deny or ask reads it, an allow
    // is about where the tool acts (`source` on OperativeArg).
    if (arg.source === true) {
      for (let i = from; i < values.length; i++) {
        values[i] = { ...(values[i] as OperativeValue), restrictOnly: true };
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

/**
 * The lines an argv hands to a shell (`["sh", "-c", "…"]`), as values only a
 * deny or ask reads: no allow is widened or narrowed by them, and a deny
 * reads each simple command in them.
 */
function shellLineValues(lines: ReadonlyArray<string>): OperativeValue[] {
  if (lines.length === 0) return [];
  return [
    { kind: "command", canonical: [], spellings: [...lines], shell: true, restrictOnly: true },
  ];
}

/**
 * Where the words of a command that name code it runs land, as values only a
 * deny or ask reads, never read as a shell line: see {@link readCommand}.
 * A word the shell expands as a pattern is read as every path it can list.
 */
function programPlaceValues(
  spellings: ReadonlyArray<string>,
  patterns: ReadonlyArray<string>,
): OperativeValue[] {
  const out: OperativeValue[] = [];
  if (spellings.length > 0) {
    out.push({
      kind: "command",
      canonical: [],
      spellings: [...new Set(spellings)],
      restrictOnly: true,
    });
  }
  if (patterns.length > 0) {
    out.push({
      kind: "command",
      canonical: [],
      spellings: [...new Set(patterns)],
      globPattern: true,
      restrictOnly: true,
    });
  }
  return out;
}

/**
 * A secret reference (`secretRef` on its OperativeArg), read the way
 * `@crewhaus/tool-secrets`' `parseRef` reads it: with the whitespace around
 * it trimmed, and its `file:` and `envfile:` forms naming a workspace file.
 * Such a reference is matched with the file's canonical path in it — where
 * it lands, `./`, `..` and links resolved — so `file:./secrets/token`,
 * `file:pub/../secrets/token` and `file:pub/lnk/token` (a link to
 * `../secrets`) are all `file:secrets/token`, which an allow must name and a
 * deny on `file:secrets/**` names. The reference as written and trimmed is
 * a spelling a deny or ask also reads, and the file is a path value only a
 * deny or ask reads (`alwaysDeny *(secrets/**)`). A file outside the
 * workspace is outside: every deny or ask fires, no allow grants it. Any
 * other form (`env:NAME`, `keychain:…`, `op://…`) is an id. A bare NAME is
 * an id an allow names as written; it is also looked up in the files of the
 * local chain ({@link secretChain}), which a deny or ask reads as those
 * references and those files, so `alwaysDeny *(.env)` fires on `API_KEY`.
 */
function secretRefValues(raw: string, canonicalizePath: PathCanonicalizer): OperativeValue[] {
  const ref = raw.trim();
  const place = secretRefPlace(ref);
  if (place === undefined) {
    const id: OperativeValue = {
      kind: "id",
      canonical: [ref],
      ...(ref !== raw ? { spellings: [raw] } : {}),
      ...(HEX_ID.test(ref) ? { caseInsensitive: true } : {}),
    };
    if (!BARE_SECRET_NAME.test(ref)) return [id];
    return [
      id,
      ...secretChain(ref).flatMap((step) =>
        placeValues(step, canonicalizePath).map((v) => ({ ...v, restrictOnly: true })),
      ),
    ];
  }
  // The reference as written and as trimmed are spellings a deny reads too.
  return placeValues(place, canonicalizePath).map((v) =>
    v.kind === "id" ? { ...v, spellings: [...new Set([raw, ref, ...(v.spellings ?? [])])] } : v,
  );
}

/**
 * The file one `file:` or `envfile:` reference opens, as the values a rule
 * reads: the reference with the file's canonical path in it, which an allow
 * names, and the file itself as a path only a deny or ask reads.
 */
function placeValues(
  place: { readonly scheme: "file" | "envfile"; readonly path: string; readonly key: string },
  canonicalizePath: PathCanonicalizer,
): OperativeValue[] {
  const named = (path: string): string => `${place.scheme}:${path}${place.key}`;
  const out: OperativeValue[] = [];
  for (const file of canonicalizePath(place.path)) {
    const spellings = [...new Set([named(place.path), ...(file.spellings ?? []).map(named)])];
    out.push(
      file.outsideWorkspace === true
        ? { kind: "id", canonical: [], spellings, outsideWorkspace: true }
        : { kind: "id", canonical: file.canonical.map(named), spellings },
    );
    out.push({ ...file, restrictOnly: true });
  }
  return out;
}

/** Where a command runs, and how to read where its words land. */
type CommandPlace = {
  readonly runsIn: string | undefined;
  readonly readProgramPath: ProgramPathReader | undefined;
};

/**
 * One directory the words of a command may be read from: the call's
 * directory field joined, as text, with each `cd` of a shell line before
 * the command (`runsIn`, as a {@link ProgramPathReader} takes it), and then
 * `prefix`, walked as the kernel walks it — a `cd -P`, or the directory a
 * wrapper moved to (`env -C`, a `sh -c` run after one). `undefined` for one
 * that cannot be told.
 */
type WordDir = { readonly runsIn: string | undefined; readonly prefix: string } | undefined;

/** What a rule reads of the words of a command that name a file. */
type ProgramsReading = {
  /**
   * The words with each one that lands elsewhere than it reads put in its
   * place (see {@link placeForms}); absent when none does.
   */
  readonly rewritten?: ReadonlyArray<string>;
  /** Some word lands elsewhere than it reads. */
  readonly moved: boolean;
  /**
   * Where some word lands could not be worked out: every deny or ask fires,
   * and only an allow naming every command grants it.
   */
  readonly unplaceable: boolean;
  /**
   * A word read where a wrapper moved the command (`env -C`) lands
   * elsewhere than it reads: no scoped allow grants it, as for a command run
   * in another directory.
   */
  readonly ungrantable: boolean;
  /** What a deny or ask also reads: each place alone, and the words with it put in. */
  readonly spellings: ReadonlyArray<string>;
  /** The same for a word the shell expands as a pattern: read as every path it can list. */
  readonly patterns: ReadonlyArray<string>;
  /**
   * Each simple command of a line a shell parses with every word that lands
   * elsewhere than it reads put in its place: an allow must name it as well
   * as the line.
   */
  readonly placed: ReadonlyArray<string>;
};

/** A command none of whose words is read as a place. */
const NOTHING_READ: ProgramsReading = {
  moved: false,
  unplaceable: false,
  ungrantable: false,
  spellings: [],
  patterns: [],
  placed: [],
};

/** How {@link readCommand} reads one command's words. */
type CommandReadingOptions = {
  /** An argv, whose words an allow reads with each moved one put in its place. */
  readonly rewrite: boolean;
  /**
   * Words a shell has unquoted: `$PWD` is the directory, a variable the line
   * does not set or a `~` is the harness's to say, a pattern is expanded, and
   * an argument is only bound to where it lands for an approval — a deny
   * reads a line's commands, not each word in them.
   */
  readonly shell: boolean;
  /** The words the shell expands as a pathname pattern. */
  readonly patterns?: ReadonlySet<number>;
};

/** The words a shell runs as `NAME=value`, which name no file. */
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Read the words of one command that name a file where the OS finds them,
 * from each directory it may run in ({@link WordDir}):
 *
 * - its programs, through any wrappers, when written with a `/` — and a bare
 *   one on each entry of a PATH a wrapper or the line sets (`env PATH=dir
 *   x`, `PATH=dir x`), as an argv's `envSet` PATH is read;
 * - each word an interpreter at the end is handed (its script, and what
 *   else it loads);
 * - and every other word with a `/`, or any word in a directory the command
 *   moved to: an argument, which another program may still run (`caffeinate
 *   x`, `find -exec x`). An argv's words are each a spelling a deny reads, so
 *   where one lands is too; a shell line's are not, and are only bound to
 *   where they land for an approval.
 *
 * Read through `readProgramPath`, each lands where the kernel takes it:
 * every directory on the way followed and each `..` applied after the link
 * before it. A program or script that lands elsewhere than it reads — a
 * `..` after a name, or a symlinked directory on the way — is put in its
 * place ({@link placeForms}), so an allow reads where it lands; a deny or ask
 * also reads that place in each of its forms, and, when the word itself is a
 * symlink, where it leads. A program named by an absolute path outside the
 * workspace with no `..` after a name is not put in its place: the system's
 * own links (`/bin → usr/bin`) are not the call's to move, and an allow
 * written `/bin/sh` still reads `/bin/sh`.
 *
 * A word cannot be placed — every deny or ask fires, and only an allow
 * naming every command grants it — when it has a `..` after a name and no
 * reader can follow the links before it (the edge worker), or it is read
 * from a directory that cannot be told; when a script is a pattern with a
 * wildcard before its last name; or when the reader cannot walk it. A word
 * from a directory that cannot be told, or that a variable the line does
 * not set or a `~` starts, is otherwise read as written.
 */
function readCommand(
  words: ReadonlyArray<string>,
  found: ProgramWords,
  dirs: ReadonlyArray<WordDir>,
  where: CommandPlace,
  opts: CommandReadingOptions,
): ProgramsReading {
  const spellings = new Set<string>();
  const patterns = new Set<string>();
  const placed = new Set<string>();
  let rewritten: string[] | undefined;
  let moved = false;
  let unplaceable = false;
  let ungrantable = false;
  const programs = new Set(found.programs);
  const operands = new Set(found.operands);
  // Collapsed as text, once: a deny written against the call's own words.
  for (const i of [...found.programs, ...found.operands]) {
    const word = opts.shell ? withShellPwd(words[i] as string) : (words[i] as string);
    if (programs.has(i) && !/[\\/]/.test(word)) continue;
    if (word.includes("://")) continue;
    for (const c of collapsedWords(word)) spellings.add(c);
  }
  for (const dir of dirs) {
    // The words with every placed word in one of its forms, per form, and
    // whether one of those is a pattern.
    const lines = new Map<number, { words: string[]; pattern: boolean }>();
    const put = (slot: number, i: number, form: string, pattern: boolean): void => {
      let line = lines.get(slot);
      if (line === undefined) {
        line = { words: [...words], pattern: false };
        lines.set(slot, line);
      }
      line.words[i] = form;
      line.pattern ||= pattern;
      (pattern ? patterns : spellings).add(form);
    };
    // The words with each one that moved put in its place, for an allow.
    const inPlace = [...words];
    let movedHere = false;
    // A bare program found on a PATH entry that moved: one line each.
    const lookups: Array<readonly [number, string]> = [];
    /** Read one word, or one PATH candidate for word `i`; see above. */
    const readWord = (
      i: number,
      word: string,
      role: "program" | "script" | "argument",
      lookup: boolean,
    ): void => {
      const runs = role === "program";
      const pattern = opts.shell && opts.patterns?.has(i) === true && !lookup;
      // The directory it is read from: the command's, then each wrapper's.
      let prefix = dir?.prefix;
      for (const { from, dir: to } of found.chdirs) {
        if (from > i || prefix === undefined) continue;
        const written = opts.shell ? withShellPwd(to) : to;
        prefix = opts.shell && holdsUnexpanded(written) ? undefined : joinedDir(prefix, written);
      }
      const cut = Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1;
      const ownDir = word.slice(0, cut);
      const known =
        dir !== undefined &&
        prefix !== undefined &&
        !(opts.shell && holdsUnexpanded(ownDir)) &&
        !(opts.shell && word.startsWith("~"));
      const climbs = climbsAfterName(word);
      const elsewhere = dir === undefined || dir.runsIn !== where.runsIn || prefix !== "";
      // A bare argument names no directory of its own: on an argv, read it
      // where a wrapper moved the command; in a shell line, where only an
      // approval would be bound to it, not at all.
      if (role === "argument" && !/[\\/]/.test(word) && (opts.shell || !elsewhere)) return;
      if (!known) {
        if (role !== "argument" && climbs) unplaceable = true;
        return;
      }
      if (pattern && (/[*?[]/.test(ownDir) || climbs)) {
        // A wildcard before its last name may match a symlinked directory.
        if (role === "script") unplaceable = true;
        return;
      }
      const absolute = isAbsolutePath(word);
      if (where.readProgramPath === undefined) {
        const anyDotDot = word.split(/[\\/]/).includes("..");
        if (role !== "argument" && (climbs || (elsewhere && !absolute && anyDotDot))) {
          unplaceable = true;
        }
        return;
      }
      const place = where.readProgramPath(word, dir.runsIn, {
        ...(role === "argument" || lookup ? { argument: true } : {}),
        ...(prefix !== "" && !absolute ? { prefix } : {}),
      });
      if (place === undefined) {
        if (role !== "argument") unplaceable = true;
        return;
      }
      const forms = placeForms(place.at, place.inWorkspace, word, runs);
      const system = absolute && place.inWorkspace === undefined && !place.writtenInWorkspace;
      const lands = climbs || (place.at !== place.asWritten && !system);
      const led =
        place.target !== undefined
          ? placeForms(place.target.at, place.target.inWorkspace, word, runs)
          : [];
      if (role === "argument") {
        // An argv's words are spellings a deny reads; where one lands is too.
        if (opts.shell || !(lands || led.length > 0 || elsewhere)) return;
      } else if (lands) {
        moved = true;
        movedHere = true;
        if (lookup) lookups.push([i, forms[0]]);
        else inPlace[i] = forms[0];
        if (opts.rewrite) {
          // A word read where a wrapper moved the command, or found on a
          // PATH: one place in the argv cannot say so.
          if (prefix !== "" || lookup) ungrantable = true;
          else {
            rewritten ??= [...words];
            rewritten[i] = forms[0];
          }
        }
      }
      forms.forEach((form, k) => put(k, i, form, pattern));
      led.forEach((form, k) => put(forms.length + k, i, form, pattern));
    };
    for (let i = 0; i < words.length; i++) {
      const raw = words[i] as string;
      if (raw === "" || raw.includes("://")) continue;
      const word = opts.shell ? withShellPwd(raw) : raw;
      if (programs.has(i)) {
        if (/[\\/]/.test(word)) readWord(i, word, "program", false);
        else {
          const lookUp = (candidate: string) => readWord(i, candidate, "program", true);
          if (!readLookups(i, word, found, opts, lookUp)) unplaceable = true;
        }
        continue;
      }
      if (operands.has(i)) {
        readWord(i, word, "script", false);
        continue;
      }
      if (word.startsWith("-") || ASSIGNMENT_WORD.test(word)) continue;
      readWord(i, word, "argument", false);
    }
    for (const line of lines.values()) {
      (line.pattern ? patterns : spellings).add(line.words.join(" "));
    }
    if (movedHere) placed.add(inPlace.join(" "));
    for (const [i, form] of lookups) {
      const line = [...inPlace];
      line[i] = form;
      placed.add(line.join(" "));
    }
  }
  return {
    ...(rewritten !== undefined ? { rewritten } : {}),
    moved,
    unplaceable,
    ungrantable,
    spellings: [...spellings],
    patterns: [...patterns],
    placed: opts.shell ? [...placed] : [],
  };
}

/**
 * A bare program looked up on the PATH a wrapper or the line set for it
 * (the last one before it), entry by entry: `read` is handed each entry
 * joined to the program. An entry that a variable the line does not set or
 * a `~` starts is the harness's own PATH, looked up as before. False for a
 * PATH of more than {@link MAX_ENV_WORDS} entries, which cannot be read.
 */
function readLookups(
  i: number,
  program: string,
  found: ProgramWords,
  opts: CommandReadingOptions,
  read: (candidate: string) => void,
): boolean {
  const path = found.paths.findLast((p) => p.from <= i);
  if (path === undefined) return true;
  const entries = path.path.split(":");
  for (const raw of entries.slice(0, MAX_ENV_WORDS)) {
    const trimmed = raw === "" ? "." : withoutTrailingSeparators(raw) || "/";
    const entry = opts.shell ? withShellPwd(trimmed) : trimmed;
    if (opts.shell && holdsUnexpanded(entry)) continue;
    read(`${entry === "/" ? "" : entry}/${program}`);
  }
  return entries.length <= MAX_ENV_WORDS;
}

/** `word` joined after the directory `dir` (`""` for none), as text: an absolute `word` stands alone. */
function joinedDir(dir: string, word: string): string {
  if (dir === "" || isAbsolutePath(word)) return word;
  if (word === "") return dir;
  return /[\\/]$/.test(dir) ? `${dir}${word}` : `${dir}/${word}`;
}

/**
 * The directories a command of a shell line may run in, as
 * {@link readCommand} reads them: each of `dirs` (relative to where the
 * line starts) from where it starts — the call's directory field, then
 * `prefix`, walked, when an argv hands the line to a shell after a wrapper
 * moved (`env -C dir sh -c …`). One that leaves where the line started by a
 * leading `..` cannot be told when the shell starts somewhere other than the
 * root: its PWD is then the physical directory, which the text of the
 * directory field does not name.
 */
function wordDirsOf(
  dirs: ReadonlyArray<ShellDir> | undefined,
  where: CommandPlace,
  prefix: string | undefined,
): ReadonlyArray<WordDir> {
  if (dirs === undefined || prefix === undefined) return [undefined];
  return dirs.map((d): WordDir => {
    if (prefix !== "" && !isAbsolutePath(d.logical)) {
      // The shell's PWD is physical already: a `cd` is walked from it, but
      // one whose `..` follows a name is folded as text by the shell.
      if (climbsAfterName(d.logical)) return undefined;
      return {
        runsIn: where.runsIn,
        prefix: joinedDir(joinedDir(prefix, d.logical), d.physical),
      };
    }
    if (d.logical === "") return { runsIn: where.runsIn, prefix: d.physical };
    if (isAbsolutePath(d.logical)) return { runsIn: d.logical, prefix: d.physical };
    if (where.runsIn !== undefined && normalizePathLexically(d.logical).escapes) return undefined;
    return {
      runsIn: where.runsIn === undefined ? d.logical : joinedDir(where.runsIn, d.logical),
      prefix: d.physical,
    };
  });
}

/**
 * Where the wrappers of an argv moved before the shell at its end (`env -C
 * dir sh -c …`): their directories joined, as text the kernel walks.
 */
function chdirPrefix(found: ProgramWords): string {
  let prefix = "";
  for (const { dir } of found.chdirs) prefix = joinedDir(prefix, dir);
  return prefix;
}

/**
 * {@link readCommand} for each simple command of each line a shell parses,
 * at every level a deny reads (`shellProgramWords`), with their quoting
 * taken off, from each directory it may run in. `prefix` is where a wrapper
 * moved the argv that hands the line to a shell (`""` for nowhere,
 * `undefined` when that cannot be told).
 */
function readShellPrograms(
  lines: ReadonlyArray<string>,
  where: CommandPlace,
  prefix: string | undefined = "",
): ProgramsReading {
  const spellings: string[] = [];
  const patterns: string[] = [];
  const placed: string[] = [];
  let moved = false;
  let unplaceable = false;
  let ungrantable = false;
  for (const line of lines) {
    for (const command of shellProgramWords(line)) {
      // A script an interpreter reads on its input (`sh < x.sh`) is read as
      // the one it is handed, and the `<` kept in front of it.
      const words =
        command.stdinScript !== undefined
          ? [...command.words, "<", command.stdinScript]
          : command.words;
      const found =
        command.stdinScript !== undefined
          ? { ...command.programs, operands: [...command.programs.operands, words.length - 1] }
          : command.programs;
      const read = readCommand(words, found, wordDirsOf(command.dirs, where, prefix), where, {
        rewrite: false,
        shell: true,
        patterns: new Set(command.patterns),
      });
      moved ||= read.moved;
      unplaceable ||= read.unplaceable;
      ungrantable ||= read.ungrantable;
      spellings.push(...read.spellings);
      patterns.push(...read.patterns);
      placed.push(...read.placed);
    }
  }
  return { moved, unplaceable, ungrantable, spellings, patterns, placed };
}

/**
 * The forms a rule reads of a place a command word lands at: first the one
 * written the way the call wrote the word — absolute when the word was, or
 * when the place is outside the workspace; else relative to the workspace
 * root, with `./` when the word had one, or when it is a program and the
 * place has no `/` left (`deploy.sh` alone would be looked up on PATH) —
 * then the place relative to the root. The workspace's own absolute path is
 * not one of them unless the call wrote it: `RunCommand(**prod**)` does not
 * fire on `sh x.sh` because the workspace lives in `prod-agent/`.
 */
function placeForms(
  at: string,
  inWorkspace: string | undefined,
  word: string,
  runs: boolean,
): [string, string] {
  if (inWorkspace === undefined) return [at, at];
  const dotted = startsWithDotSlash(word) || (runs && !inWorkspace.includes("/"));
  const written = isAbsolutePath(word)
    ? at
    : dotted && inWorkspace !== "."
      ? `./${inWorkspace}`
      : inWorkspace;
  return [written, inWorkspace];
}

/** `./` or `.\\` at the start: a word the call wrote relative to its directory. */
function startsWithDotSlash(word: string): boolean {
  return word.startsWith("./") || word.startsWith(".\\");
}

/** A bare reference: an environment-variable name, which the local chain looks up. */
const BARE_SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The files a bare NAME is looked up in after the environment, highest
 * precedence first: `@crewhaus/tool-secrets`' `chainRefs` (the harness
 * supervisor's `.env.local` and `.env`, then the secrets directory). That
 * package's tests hold this list to its own.
 */
function secretChain(name: string): ReadonlyArray<{
  readonly scheme: "file" | "envfile";
  readonly path: string;
  readonly key: string;
}> {
  return [
    { scheme: "envfile", path: ".env.local", key: `#${name}` },
    { scheme: "envfile", path: ".env", key: `#${name}` },
    { scheme: "file", path: `.crewhaus/secrets/${name}`, key: "" },
  ];
}

/**
 * The file a trimmed `file:<path>` or `envfile:<path>#KEY` reference opens,
 * split as `parseRef` splits it (an `envfile:` at its LAST `#`), with the
 * rest of the reference around it; `undefined` for any other form, and for
 * one the tool refuses whole (an empty path, no `#KEY`, a newline or NUL).
 */
function secretRefPlace(
  ref: string,
):
  | { readonly scheme: "file" | "envfile"; readonly path: string; readonly key: string }
  | undefined {
  if (/[\0\n\r]/.test(ref)) return undefined;
  if (ref.startsWith("file:")) {
    const path = ref.slice("file:".length);
    return path === "" ? undefined : { scheme: "file", path, key: "" };
  }
  if (ref.startsWith("envfile:")) {
    const rest = ref.slice("envfile:".length);
    const hash = rest.lastIndexOf("#");
    return hash <= 0
      ? undefined
      : { scheme: "envfile", path: rest.slice(0, hash), key: rest.slice(hash) };
  }
  return undefined;
}

/** A value that ends in a `0x` (or `0X`) hex id, after any `<qualifier>/`. */
const HEX_ID = /(?:^|\/)0[xX][0-9a-fA-F]+$/;

/**
 * One value of a declared field. `words` is the argv it was joined from;
 * `runsIn` the directory a `command` declared `within` one runs in; `dir`
 * the directory a `path` declared `within` one is relative to;
 * `unqualified` the value and its qualifier apart, for any other `within`
 * field; `stdin` the text a `command` declared with a `stdin` field is
 * handed on its input; `every` that a left-out field's `*` default stands for every value,
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
  readonly stdin?: string;
  /** The directory a `path` declared `within` one is relative to. */
  readonly dir?: string;
  /**
   * A `path` declared `within` a directory whose value is absolute or has a
   * `..` segment: where it lands cannot be read off the directory's values.
   * `written` is the path as the call wrote it; `value` stays joined to the
   * directory, as for any other path, so a row shows where the `..` climbs
   * from. See {@link leavesItsDirectory}.
   */
  readonly leavesDir?: { readonly written: string };
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
 * field declared `within` another comes back as `<qualifier>/<value>` — a
 * `..` path too, so a row shows the directory it climbs from — and an
 * absolute path as it is.
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
  // And with its own object's input text, else the top-level one.
  const topStdin = arg.stdin !== undefined ? qualifierOf(input, arg.stdin) : undefined;
  const stdinOf = (owner: unknown): { stdin?: string } => {
    if (arg.kind !== "command" || arg.stdin === undefined) return {};
    const text = (owner !== input ? qualifierOf(owner, arg.stdin) : undefined) ?? topStdin;
    return text !== undefined ? { stdin: text } : {};
  };
  const placed = (owner: unknown) => ({ ...runsInOf(owner), ...envOf(owner), ...stdinOf(owner) });
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
    // A path within a directory the call left out is relative to the root,
    // and handed on as written all the same.
    if (arg.kind === "path" && arg.within !== undefined && !every) {
      return out.map((r) =>
        leavesItsDirectory(r.value) ? { ...r, leavesDir: { written: r.value } } : r,
      );
    }
    // The qualifier is left out as well: a code search with no owner reaches
    // every repository, so the value stands for every `<owner>/<repo>` too.
    const read = anyValue(out);
    return every && arg.within !== undefined
      ? read.map((r) => ({ ...r, anyQualifier: true as const }))
      : read;
  }
  return out.map((r) => {
    // A path relative to a directory field.
    if (arg.kind === "path") {
      if (every) return { ...r, value: `${qualifier}/${r.value}`, dir: qualifier, every: true };
      // A git command given no path acts on the whole repository, wherever
      // it runs: its default is the workspace root, not the directory.
      if (r.defaulted === true && arg.defaultAtRoot === true) return r;
      // One that leaves it is still shown joined to it — an approver needs to
      // see what `..` climbs from — but not read that way (`leavingValue`).
      if (leavesItsDirectory(r.value)) {
        const value = isAbsolutePath(r.value) ? r.value : `${qualifier}/${r.value}`;
        return { ...r, value, leavesDir: { written: r.value } };
      }
      return { ...r, value: `${qualifier}/${r.value}` };
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
 * Does a path declared `within` a directory leave it: is it absolute, or does
 * it have a `..` segment? Where such a path lands cannot be read off the
 * directory's values.
 *
 * - The tool hands the path on as written, to a program that runs in the
 *   directory (git, a formatter, a test runner), and the OS follows each
 *   symlink BEFORE it applies the `..` after it. Through a symlinked
 *   directory (`cwd: "link"`, `link → secrets/deep`), `../x.ts` is
 *   `secrets/x.ts`; through a link inside the path itself (`lnk/../x.ts`),
 *   it climbs out of the link's target, which no join of the path to the
 *   directory can see without a filesystem to ask. Read like every other
 *   path, with `..` collapsed first, both were `x.ts`.
 * - An absolute path ignores the directory for a program that resolves it,
 *   but not for `path.join`, which a tool may check it with: the two name
 *   different files.
 *
 * `\` counts as a separator too, as in tool-git's pathspec check: splitting
 * at it can only flag more.
 */
function leavesItsDirectory(value: string): boolean {
  return isAbsolutePath(value) || value.split(/[\\/]/).includes("..");
}

/**
 * The value of a path that leaves its directory ({@link leavesItsDirectory}):
 * outside the workspace, so no allow rule names it and every deny or ask fires
 * on it. Every builtin that declares such a field refuses the path itself;
 * this keeps a rule about another place from granting it to a tool that does
 * not. The spellings are the path as written, and joined to the directory as
 * written (`joined`, the reading's value; the same string when the call gave
 * no directory or the path is absolute).
 */
function leavingValue(joined: string, written: string): OperativeValue {
  const spellings = joined === written ? [written] : [written, joined];
  return { kind: "path", canonical: [], spellings, outsideWorkspace: true };
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
    const trimmed = withoutTrailingSeparators(d);
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
 * `text` without its trailing `/` and `\`: what `text.replace(/[\\/]+$/, "")`
 * returned, in one pass from the end. That pattern tries every start inside
 * a run of separators that is not at the end and rescans the rest of the run
 * from each, so it was quadratic in the run's length, and a directory or a
 * PATH entry is whatever the call wrote.
 */
export function withoutTrailingSeparators(text: string): string {
  let end = text.length;
  for (; end > 0; end--) {
    const c = text.charCodeAt(end - 1);
    if (c !== 0x2f && c !== 0x5c) break;
  }
  return end === text.length ? text : text.slice(0, end);
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

/**
 * A word with separators, collapsed the way {@link joinedSpellings} does,
 * when that changes it — and again with the `./` the call wrote kept, so
 * `alwaysDeny RunCommand(./deploy.sh)` reads `./a/../deploy.sh` as well.
 */
function collapsedWords(word: string): string[] {
  if (!/[\\/]/.test(word)) return [];
  const lexical = normalizePathLexically(word);
  if (lexical.escapes || lexical.path === word || lexical.path === ".") return [];
  const dotted = startsWithDotSlash(word) ? `./${lexical.path}` : undefined;
  return dotted !== undefined && dotted !== word ? [lexical.path, dotted] : [lexical.path];
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
  where: CommandPlace,
): CommandReading {
  const out = new Set<string>();
  const program = argv[0] ?? "";
  const bareProgram = program !== "" && !/[\\/]/.test(program);
  // Words collapsed where the call wrote a separator: once as collapsed, and
  // once with the `./` the call wrote kept.
  const collapsed = argv.map((w) => (namesAFile(w) ? collapsedWords(w) : []));
  if (collapsed.some((c) => c.length > 0)) {
    for (const c of collapsed) for (const form of c) out.add(form);
    for (const k of [0, 1]) {
      out.add(argv.map((w, i) => collapsed[i]?.[k] ?? collapsed[i]?.[0] ?? w).join(" "));
    }
  }
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
      for (const c of collapsedWords(w)) out.add(c);
      for (const d of dirs) for (const j of joinedSpellings(d, w)) out.add(j);
    }
    if (name.toUpperCase() !== "PATH" || !bareProgram) continue;
    const pathEntries = value.split(":");
    if (pathEntries.length > MAX_ENV_WORDS) unreadable = true;
    for (const raw of pathEntries.slice(0, MAX_ENV_WORDS)) {
      const entry = raw === "" ? "." : withoutTrailingSeparators(raw) || "/";
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
      // And where the kernel finds it there, each link followed before the
      // `..` after it: `PATH=link/..` is the directory above link's target.
      if (where.readProgramPath !== undefined) {
        const candidate = `${entry === "/" ? "" : entry}/${program}`;
        const from = isAbsolutePath(entry) ? [undefined] : [undefined, where.runsIn];
        for (const runsIn of new Set(from)) {
          const place = where.readProgramPath(candidate, runsIn);
          if (place === undefined) continue;
          for (const f of placeForms(place.at, place.inWorkspace, candidate, true)) found.add(f);
          if (place.target === undefined) continue;
          const { at, inWorkspace } = place.target;
          for (const f of placeForms(at, inWorkspace, candidate, true)) found.add(f);
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

/** Does the call set the top-level boolean `field` to `true`? */
function switchedOn(input: unknown, field: string): boolean {
  return (
    input !== null &&
    typeof input === "object" &&
    Object.hasOwn(input, field) &&
    (input as Record<string, unknown>)[field] === true
  );
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
