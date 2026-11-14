/**
 * The command-line-equivalent checker: is a command Home (or anything else)
 * shows one the CLI accepts, typed into a POSIX shell as written?
 *
 * Two steps. {@link shellWords} splits a line the way `sh` does: single
 * quotes, double quotes with `\` escapes, a backslash outside quotes, a `#`
 * comment to the end of the line, and commands split on `&&` and `;`. A pipe,
 * a redirect, `$` expansion, a backtick, a glob, a parenthesis, an ellipsis or
 * an unbalanced quote is a reason, not a command. Then {@link checkCommand}
 * holds each `crewhaus …` command to the verb inventory (`verbs.ts`): a legacy
 * verb's tokens go through the real `parseArgs` with its real schema, and a
 * family's through the flags its module declares. Parsing is not running, so
 * {@link REQUIRED} then holds the commands that refuse to start without a
 * positional or a flag to what they need, each pinned to the CLI's own
 * refusal so the table cannot drift from it.
 *
 * The notation a command may use, and nothing more:
 *
 *   - `<name>` (`^<[a-z][a-z0-9-]*>$`, a whole unquoted word) is a
 *     placeholder for a positional or a flag value;
 *   - an unquoted `a|b` word (`^[a-z0-9-]+(\|[a-z0-9-]+)+$`) in a sub-verb or
 *     flag-value slot is a choice, and every alternative is checked;
 *   - `cd <path> &&` before the command is accepted and skipped, and so is a
 *     `cp -R <from> <to> &&` copy step.
 *
 * Test-only: it imports the arg parser and the inventory, never the server.
 */
import { ArgParseError, parseArgs } from "@crewhaus/infra-utils";
import {
  type CliFamily,
  type Inventory,
  type LegacyVerb,
  type SchemaName,
  composeInventory,
  findVerb,
  schemaNamed,
} from "../verbs";
import { loadFamilies } from "./families";

/** One shell word, with what the checker needs to know about how it was written. */
export type Word = {
  readonly text: string;
  /** Any part of it was quoted or escaped. */
  readonly quoted: boolean;
  /** An unquoted `<name>`. */
  readonly placeholder: boolean;
  /** An unquoted `a|b|…`. */
  readonly alternation: boolean;
};

export class ShellGrammarError extends Error {}

const PLACEHOLDER_RE = /^<[a-z][a-z0-9-]*>/;
const PLACEHOLDER_WORD_RE = /^<[a-z][a-z0-9-]*>$/;
const ALTERNATION_RE = /^[a-z0-9-]+(\|[a-z0-9-]+)+$/;
const BLANK = new Set([" ", "\t"]);
const GLOB = new Set(["*", "?", "[", "]", "{", "}"]);

/** Split one line into commands of words, as `sh` would; throws {@link ShellGrammarError}. */
export function tokenize(line: string): Word[][] {
  const commands: Word[][] = [];
  let current: Word[] = [];
  let text: string | null = null;
  let quoted = false;
  let pipe = false;
  let separatorPending = false;

  const endWord = (): void => {
    if (text === null) return;
    const alternation = pipe && !quoted && ALTERNATION_RE.test(text);
    if (pipe && !alternation) {
      throw new ShellGrammarError(`a pipe ("|") in "${text}" runs a second program`);
    }
    current.push({ text, quoted, placeholder: false, alternation });
    text = null;
    quoted = false;
    pipe = false;
  };
  const endCommand = (separator: string): void => {
    endWord();
    if (current.length === 0) {
      throw new ShellGrammarError(`"${separator}" with no command before it`);
    }
    commands.push(current);
    current = [];
  };

  let i = 0;
  while (i < line.length) {
    const c = line[i] as string;
    if (BLANK.has(c)) {
      endWord();
      i += 1;
      continue;
    }
    if (c === "\n" || c === ";") {
      endCommand(c === ";" ? ";" : "newline");
      separatorPending = true;
      i += 1;
      continue;
    }
    if (c === "#" && text === null) break; // a comment runs to the end of the line
    if (c === "&") {
      if (line[i + 1] !== "&")
        throw new ShellGrammarError('a lone "&" runs the command in the background');
      endCommand("&&");
      separatorPending = true;
      i += 2;
      continue;
    }
    separatorPending = false;
    if (c === "'") {
      const close = line.indexOf("'", i + 1);
      if (close === -1) throw new ShellGrammarError("an unbalanced single quote");
      text = (text ?? "") + line.slice(i + 1, close);
      quoted = true;
      i = close + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let value = "";
      for (;;) {
        const d = line[j];
        if (d === undefined) throw new ShellGrammarError("an unbalanced double quote");
        if (d === '"') break;
        if (d === "\\") {
          const e = line[j + 1];
          if (e === "$" || e === "`" || e === '"' || e === "\\" || e === "\n") {
            value += e === "\n" ? "" : e;
            j += 2;
            continue;
          }
          value += d;
          j += 1;
          continue;
        }
        if (d === "$") throw new ShellGrammarError(`"$" inside double quotes is an expansion`);
        if (d === "`") throw new ShellGrammarError("a backtick runs a command");
        value += d;
        j += 1;
      }
      text = (text ?? "") + value;
      quoted = true;
      i = j + 1;
      continue;
    }
    if (c === "\\") {
      const e = line[i + 1];
      if (e === undefined) throw new ShellGrammarError("a trailing backslash");
      text = (text ?? "") + (e === "\n" ? "" : e);
      quoted = true;
      i += 2;
      continue;
    }
    if (c === "`") throw new ShellGrammarError("a backtick runs a command");
    if (c === "$") throw new ShellGrammarError('"$" is an expansion');
    if (c === "(" || c === ")")
      throw new ShellGrammarError(`a parenthesis ("${c}") is shell syntax`);
    if (c === "…") throw new ShellGrammarError("an ellipsis is not a value");
    if (GLOB.has(c)) throw new ShellGrammarError(`"${c}" is a glob or brace pattern`);
    if (c === "<" || c === ">") {
      const match = c === "<" && text === null ? PLACEHOLDER_RE.exec(line.slice(i)) : null;
      const after = match !== null ? line[i + match[0].length] : undefined;
      if (
        match !== null &&
        (after === undefined ||
          BLANK.has(after) ||
          after === ";" ||
          after === "&" ||
          after === "\n")
      ) {
        current.push({ text: match[0], quoted: false, placeholder: true, alternation: false });
        i += match[0].length;
        continue;
      }
      throw new ShellGrammarError(`"${c}" outside a placeholder is a redirect`);
    }
    if (c === "|") pipe = true;
    text = (text ?? "") + c;
    i += 1;
  }
  endWord();
  if (current.length > 0) commands.push(current);
  else if (separatorPending) throw new ShellGrammarError("a separator with no command after it");
  return commands;
}

/** The words of each command in `line`, as `sh` would split them. Throws on what it refuses. */
export function shellWords(line: string): string[][] {
  return tokenize(line).map((words) => words.map((w) => w.text));
}

/** A word as written, when a caller hands over plain strings. */
function asWord(raw: string | Word): Word {
  if (typeof raw !== "string") return raw;
  return {
    text: raw,
    quoted: false,
    placeholder: PLACEHOLDER_WORD_RE.test(raw),
    alternation: ALTERNATION_RE.test(raw),
  };
}

const own = (record: object, key: string): boolean => Object.hasOwn(record, key);

function subList(keys: readonly string[]): string {
  return keys.filter((k) => k !== "").join(" | ");
}

/**
 * Where the CLI's own refusal for a {@link Requirement} is written: `text`
 * appears in `file` (under `apps/cli/src`), inside the function that opens
 * with `within` when that is given.
 */
export type RequirementPin = {
  readonly file: string;
  readonly within?: string;
  readonly text: string;
};

/**
 * What one verb (or `verb sub`) needs before it does anything: how many
 * positionals it takes, the flags it cannot run without, and groups of
 * which at least one must be given. Flag names are the long names, as the
 * parser reports them (`-o` is `out`).
 */
export type Requirement = {
  readonly positionals?: { readonly min?: number; readonly max?: number };
  readonly flags?: readonly string[];
  readonly oneOf?: ReadonlyArray<readonly string[]>;
  readonly pins: readonly RequirementPin[];
};

const harnessNeedsOne = (sub: string, what: string): Requirement => ({
  positionals: { min: 1 },
  pins: [{ file: "harness-cmd.ts", text: `requirePositional("${sub}", args, 0, "${what}")` }],
});
const accessTakesNone = (sub: string): Requirement => ({
  positionals: { max: 0 },
  pins: [{ file: "access-cmd.ts", text: `noPositional("${sub}", args);` }],
});
const accessNeedsFlags = (sub: string, flags: readonly string[]): Requirement => ({
  positionals: { max: 0 },
  flags,
  pins: [
    { file: "access-cmd.ts", text: `noPositional("${sub}", args);` },
    ...flags.map((f) => ({ file: "access-cmd.ts", text: `requireValue("${sub}", args, "${f}")` })),
  ],
});

const peopleNeedsOne = (sub: string, what: string): Requirement => ({
  positionals: { min: 1, max: 1 },
  pins: [{ file: "people-cmd.ts", text: `exactlyOne("${sub}", args, "${what}")` }],
});

const changesNeedsOne = (sub: string, flag?: string): Requirement => ({
  positionals: { min: 1, max: 1 },
  ...(flag !== undefined ? { flags: [flag] } : {}),
  pins: [
    { file: "changes-cmd.ts", text: `changeId("${sub}", args)` },
    ...(flag !== undefined
      ? [{ file: "changes-cmd.ts", text: `requireValue("${sub}", args, "${flag}")` }]
      : []),
  ],
});

/**
 * The commands that parse but refuse to start without more, keyed by
 * `verb` or `verb sub`. A command shown in Home that misses one of these
 * dies when pasted, so the checker refuses it.
 */
export const REQUIRED: Readonly<Record<string, Requirement>> = {
  run: {
    positionals: { min: 1 },
    pins: [
      { file: "index.ts", within: "async function runRun(", text: 'die("missing <spec.yaml>")' },
    ],
  },
  rate: {
    flags: ["session"],
    oneOf: [["thumbs", "stars", "score"]],
    pins: [
      {
        file: "index.ts",
        within: "async function captureFeedback(",
        text: 'die("missing --session <id>")',
      },
      {
        file: "index.ts",
        within: "async function runRate(",
        text: 'die("give one of --thumbs up|down, --stars 1-5, or --score 0-1")',
      },
    ],
  },
  distill: {
    oneOf: [
      ["out", "register"],
      ["session", "all-sessions"],
    ],
    pins: [
      {
        file: "index.ts",
        within: "async function runDistill(",
        text: 'die("missing -o <dataset.jsonl> (or --register <name> to promote into the registry)")',
      },
      {
        file: "index.ts",
        within: "async function runDistill(",
        text: 'die("missing --session <id> (or --all-sessions)")',
      },
    ],
  },
  "experiment record": {
    flags: ["name", "version", "outcome"],
    pins: [
      { file: "experiment.ts", text: "return fail(`--name is required" },
      { file: "experiment.ts", text: 'fail("missing --version <v>")' },
      { file: "experiment.ts", text: 'fail(`--outcome must be "pass" or "fail"' },
    ],
  },
  "experiment assign": {
    flags: ["name", "key"],
    pins: [
      { file: "experiment.ts", text: "return fail(`--name is required" },
      { file: "experiment.ts", text: 'fail("missing --key <request-key>")' },
    ],
  },
  "dataset refresh-goldens": {
    flags: ["dataset"],
    pins: [
      {
        file: "index.ts",
        within: "async function runRefreshGoldens(",
        text: 'die("missing --dataset <file|registry:ref>")',
      },
    ],
  },
  "harness show": harnessNeedsOne("show", "<dir|hrn_id>"),
  "harness add": harnessNeedsOne("add", "<dir>"),
  "harness remove": harnessNeedsOne("remove", "<dir|hrn_id>"),
  "harness group": harnessNeedsOne("group", "<name>"),
  "harness tag": harnessNeedsOne("tag", "<dir|hrn_id>"),
  "harness pin": harnessNeedsOne("pin", "<dir|hrn_id>"),
  "harness preflight": harnessNeedsOne("preflight", "<dir|hrn_id>"),
  "harness relocate": {
    positionals: { min: 2 },
    pins: [{ file: "harness-cmd.ts", text: 'requirePositional("relocate", args, 1, "<newDir>")' }],
  },
  "hangar serve": {
    positionals: { max: 0 },
    pins: [{ file: "hangar-cmd.ts", text: "`hangar serve: unexpected argument" }],
  },
  "hangar rotate-token": {
    positionals: { max: 0 },
    pins: [{ file: "hangar-cmd.ts", text: "`hangar rotate-token: unexpected argument" }],
  },
  "access members": accessTakesNone("members"),
  "access tokens": accessTakesNone("tokens"),
  "access sync": accessTakesNone("sync"),
  "access proxy": accessTakesNone("proxy"),
  "access invite": accessNeedsFlags("invite", ["role"]),
  "access grant": accessNeedsFlags("grant", ["member", "role"]),
  "access mint": accessNeedsFlags("mint", ["service"]),
  "access revoke": {
    positionals: { max: 1 },
    pins: [{ file: "access-cmd.ts", text: 'noPositional("revoke", args, 1);' }],
  },
  "access link": {
    positionals: { min: 1, max: 1 },
    flags: ["member"],
    pins: [
      { file: "access-cmd.ts", text: 'noPositional("link", args, 1);' },
      { file: "access-cmd.ts", text: 'requireValue("link", args, "member")' },
    ],
  },
  "access unlink": {
    positionals: { min: 1, max: 1 },
    pins: [
      { file: "access-cmd.ts", text: 'noPositional("unlink", args, 1);' },
      { file: "access-cmd.ts", text: '"access unlink: name a link id' },
    ],
  },
  "access approve": {
    positionals: { min: 1, max: 1 },
    pins: [
      { file: "access-cmd.ts", text: 'noPositional("approve", args, 1);' },
      { file: "access-cmd.ts", text: '"access approve: name the code' },
    ],
  },
  "commands list": {
    flags: ["harness"],
    pins: [
      { file: "commands-cmd.ts", text: '"commands list: name the harness with --harness <h>"' },
    ],
  },
  "commands show": {
    positionals: { min: 1, max: 1 },
    pins: [{ file: "commands-cmd.ts", text: '"commands show: name a command, cmd_…"' }],
  },
  "people add": {
    positionals: { max: 0 },
    flags: ["kind"],
    pins: [{ file: "people-cmd.ts", text: 'requireValue("add", args, "kind")' }],
  },
  "people show": peopleNeedsOne("show", "<psn_…>"),
  "people set": peopleNeedsOne("set", "<psn_…>"),
  "people note": {
    positionals: { min: 1, max: 1 },
    flags: ["area"],
    pins: [
      { file: "people-cmd.ts", text: 'exactlyOne("note", args, "<psn_…>")' },
      { file: "people-cmd.ts", text: 'requireValue("note", args, "area")' },
    ],
  },
  "people edit": peopleNeedsOne("edit", "<pcl_…>"),
  "people review": peopleNeedsOne("review", "a profile (psn_…) or a note (pcl_…)"),
  "people export": peopleNeedsOne("export", "<psn_…>"),
  "people activity": peopleNeedsOne("activity", "<psn_…>"),
  "people erase": peopleNeedsOne("erase", "<psn_…>"),
  "changes show": changesNeedsOne("show"),
  "changes check": changesNeedsOne("check"),
  "changes withdraw": changesNeedsOne("withdraw"),
  "changes adopt": changesNeedsOne("adopt", "expect"),
  "changes rollback": changesNeedsOne("rollback", "expect"),
  "changes decline": changesNeedsOne("decline", "reason"),
  "changes propose": {
    positionals: { max: 0 },
    flags: ["from"],
    pins: [{ file: "changes-cmd.ts", text: 'requireValue("propose", args, "from")' }],
  },
  "datasets holdout": {
    positionals: { min: 1 },
    flags: ["fraction"],
    pins: [
      {
        file: "index.ts",
        within: "async function runDatasetsHoldout(",
        text: 'die("datasets holdout: missing --fraction <f> (e.g. 0.2)")',
      },
    ],
  },
};

/** Why `given` falls short of what `key` needs, or null. */
export function checkRequirement(
  key: string,
  positionals: number,
  given: ReadonlySet<string>,
  table: Readonly<Record<string, Requirement>> = REQUIRED,
): string | null {
  const need = table[key];
  if (need === undefined) return null;
  const label = `crewhaus ${key}`;
  const min = need.positionals?.min;
  const max = need.positionals?.max;
  if (min !== undefined && positionals < min) {
    return `${label} needs ${min === 1 ? "an argument" : `${min} arguments`} (given ${positionals})`;
  }
  if (max !== undefined && positionals > max) {
    return `${label} takes ${max === 0 ? "no arguments" : `at most ${max}`} (given ${positionals})`;
  }
  for (const flag of need.flags ?? []) {
    if (!given.has(flag)) return `${label} needs --${flag}`;
  }
  for (const group of need.oneOf ?? []) {
    if (!group.some((flag) => given.has(flag))) {
      return `${label} needs one of ${group.map((f) => `--${f}`).join(", ")}`;
    }
  }
  return null;
}

/** Tokens after a legacy verb (or its sub-verb), through the real parser. */
function checkSchemaTokens(
  label: string,
  schemaName: SchemaName | undefined,
  tokens: readonly Word[],
): string | null {
  if (schemaName === undefined) {
    for (const t of tokens) {
      if (t.alternation)
        return `crewhaus ${label}: "${t.text}" offers a choice where none is taken`;
      if (t.text.startsWith("-") && t.text !== "-") {
        return `crewhaus ${label} declares no flags, so "${t.text}" is not accepted`;
      }
    }
    return checkRequirement(label, tokens.length, new Set());
  }
  const schema = schemaNamed(schemaName);
  if (schema === undefined) return `crewhaus ${label}: schema ${schemaName} does not exist`;
  const takesValue = new Map<string, boolean>();
  for (const flag of schema.flags) {
    takesValue.set(`--${flag.name}`, flag.takesValue === true);
    if (flag.short !== undefined) takesValue.set(`-${flag.short}`, flag.takesValue === true);
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Word;
    if (t.text === "--") {
      if (tokens.slice(i + 1).some((w) => w.alternation)) {
        return `crewhaus ${label}: a choice after "--" is a positional, not a flag value`;
      }
      break;
    }
    if (takesValue.get(t.text) === true) {
      i += 1; // the value: a placeholder, a choice, or anything else
      continue;
    }
    if (t.alternation) {
      return `crewhaus ${label}: "${t.text}" offers a choice outside a sub-verb or flag value`;
    }
  }
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(
      tokens.map((t) => t.text),
      schema,
    );
  } catch (err) {
    if (err instanceof ArgParseError) return `crewhaus ${label}: ${err.message}`;
    throw err;
  }
  return checkRequirement(label, parsed.positional.length, new Set(Object.keys(parsed.flags)));
}

function checkLegacy(entry: LegacyVerb, tokens: readonly Word[]): string | null {
  const verb = entry.verb;
  if (entry.sub === undefined) return checkSchemaTokens(verb, entry.schema, tokens);
  const sub = entry.sub;
  const first = tokens[0];
  const keys = Object.keys(sub);
  if (first === undefined) {
    if (own(sub, "")) return checkSchemaTokens(verb, sub[""] ?? entry.schema, []);
    if (entry.positionalFirst === true) return checkSchemaTokens(verb, entry.schema, []);
    return `crewhaus ${verb} needs a sub-verb (expected: ${subList(keys)})`;
  }
  const alternatives = first.alternation ? first.text.split("|") : [first.text];
  const known = alternatives.every((a) => a !== "" && !first.placeholder && own(sub, a));
  if (!known) {
    if (entry.positionalFirst === true && !first.alternation) {
      return checkSchemaTokens(verb, entry.schema, tokens);
    }
    const bad = alternatives.find((a) => a === "" || first.placeholder || !own(sub, a)) ?? "";
    return `unknown ${verb} sub-verb "${bad}" (expected: ${subList(keys)})`;
  }
  for (const alternative of alternatives) {
    const reason = checkSchemaTokens(
      `${verb} ${alternative}`,
      sub[alternative] ?? entry.schema,
      tokens.slice(1),
    );
    if (reason !== null) return reason;
  }
  return null;
}

function checkFamilySub(family: CliFamily, name: string, tokens: readonly Word[]): string | null {
  const flags = family.sub[name]?.flags ?? {};
  const label = `crewhaus ${family.verb} ${name}`;
  const expected = Object.keys(flags).map((f) => `--${f}`);
  const given = new Set<string>();
  let positionals = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Word;
    if (!t.text.startsWith("--")) {
      if (t.alternation) return `${label}: "${t.text}" offers a choice where none is taken`;
      positionals += 1;
      continue;
    }
    if (t.text.includes("=")) {
      return `${label}: "${t.text}" is one word to this parser; write the flag and its value apart`;
    }
    const flag = t.text.slice(2);
    if (!own(flags, flag)) {
      return `${label}: unknown flag "${t.text}" (expected: ${expected.length > 0 ? expected.join(", ") : "none"})`;
    }
    const kind = flags[flag];
    if (kind === "boolean") {
      given.add(flag);
      continue;
    }
    const value = tokens[i + 1];
    if (value === undefined || value.text.startsWith("--")) {
      return `${label}: ${t.text} needs a value`;
    }
    if (kind === "value" && given.has(flag)) return `${label}: ${t.text} can be given once`;
    given.add(flag);
    i += 1;
  }
  return checkRequirement(`${family.verb} ${name}`, positionals, given);
}

function checkFamily(family: CliFamily, tokens: readonly Word[]): string | null {
  const first = tokens[0];
  const keys = Object.keys(family.sub);
  if (first === undefined || (!first.quoted && first.text.startsWith("--"))) {
    if (family.bare === undefined) {
      return `crewhaus ${family.verb} needs a sub-verb (expected: ${keys.join(" | ")})`;
    }
    return checkFamilySub(family, family.bare, tokens);
  }
  const alternatives = first.alternation ? first.text.split("|") : [first.text];
  for (const alternative of alternatives) {
    if (first.placeholder || !own(family.sub, alternative)) {
      return `unknown ${family.verb} verb "${alternative}" (expected: ${keys.join(" | ")})`;
    }
    const reason = checkFamilySub(family, alternative, tokens.slice(1));
    if (reason !== null) return reason;
  }
  return null;
}

/**
 * Why one `crewhaus …` command would not run as written, or null when it
 * would. `words` starts with `crewhaus`; plain strings are read as unquoted
 * words.
 */
export function checkCommand(inv: Inventory, words: ReadonlyArray<string | Word>): string | null {
  const all = words.map(asWord);
  if (all[0]?.text !== "crewhaus") return `not a crewhaus command: "${all[0]?.text ?? ""}"`;
  const verbWord = all[1];
  if (verbWord === undefined) return "bare `crewhaus` with no verb";
  if (verbWord.placeholder || verbWord.alternation) {
    return `"${verbWord.text}" stands where a verb must be named`;
  }
  const entry = findVerb(inv, verbWord.text);
  if (entry === undefined) return `unknown verb "${verbWord.text}"`;
  const tokens = all.slice(2);
  return entry.kind === "legacy" ? checkLegacy(entry, tokens) : checkFamily(entry, tokens);
}

/**
 * Why `line` would not run as written, or null when every command in it
 * would. It must hold at least one `crewhaus` command.
 */
export function checkLine(inv: Inventory, line: string): string | null {
  let commands: Word[][];
  try {
    commands = tokenize(line);
  } catch (err) {
    if (err instanceof ShellGrammarError) return err.message;
    throw err;
  }
  if (!commands.some((words) => words[0]?.text === "crewhaus")) {
    return "no crewhaus command in it";
  }
  for (const [index, words] of commands.entries()) {
    const program = words[0]?.text ?? "";
    if (program === "cd") {
      if (index !== 0) return "cd may only open the line";
      if (words.length !== 2) return "cd takes exactly one directory";
      continue;
    }
    if (program === "cp") {
      if (words.length !== 4 || words[1]?.text !== "-R")
        return "a copy step is `cp -R <from> <to>`";
      continue;
    }
    if (program !== "crewhaus") return `not a crewhaus command: "${program}"`;
    const reason = checkCommand(inv, words);
    if (reason !== null) return reason;
  }
  return null;
}

let cached: Promise<Inventory> | undefined;

/** The CLI's own inventory: the legacy rows and every family module's `CLI_FAMILY`. */
export function realInventory(): Promise<Inventory> {
  cached ??= loadFamilies().then(composeInventory);
  return cached;
}
