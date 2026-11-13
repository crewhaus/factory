/**
 * The files a harness's own hooks name directly, for the runtime-state floor: the
 * script a hook runs is as much a control file as the settings entry that names it.
 *
 * Two readings, both pure apart from one `lstat` per candidate word and the read of
 * `.crewhaus/settings.json`:
 *
 * - A shell command (`hooks[].command`, which hooks-engine runs with `sh -c`) is
 *   tokenized with POSIX single and double quotes, backslash escapes and `#` comments,
 *   and split into simple commands at `;`, `&&`, `||`, `|`, `&`, newlines and the
 *   parentheses of a subshell. A redirection (`<`, `>`, `>>`, `>|`, `<>`, `N>`, `&>`,
 *   `>&`, `<&`) ends a word, and its target is not a command's word. A command that
 *   holds `$(`, a backquote, a here-document (`<<`) or an unbalanced quote names
 *   nothing at all: what it runs is not known until it runs.
 * - An argv (`manager.hooks.postCompile` and `.preSpawn`, which the supervisor spawns
 *   with no shell) is read word by word, as `parseManagerHook` and `resolveHookCommand`
 *   in harness-supervisor read it: a string is one word, never split; an array is the
 *   argv; a first word written as a path resolves against the harness.
 *
 * Each simple command is read the same way. Leading `NAME=value` assignments, the
 * reserved words `if`, `then`, `elif`, `else`, `do`, `while`, `until`, `!` and `{`,
 * and a closed list of wrappers that run the command after them (`env` and its
 * options, `exec`, `command`, `builtin`, `time`, `nohup`, `nice`, `timeout`, `sudo`,
 * `xargs`, `npx`, `bunx`, `pnpx` and `bun x`, each matched by its basename, with the
 * options that take a value skipped with their value) are passed over. Then:
 *
 * - the command word names its file when it is written as a path (`./`, `../`, `/`,
 *   or it holds a `/`);
 * - a shell (`sh`, `bash`, `zsh`, `dash`, `ksh`) names its first argument that is
 *   not an option, or, with none, the file a `<` redirection feeds it; with `-c`,
 *   its command string is read as a shell command in its turn;
 * - `.` and `source` name their first argument;
 * - another interpreter (`node`, `tsx`, `python`, `python3`, `ruby`, `perl`, `php`,
 *   and `bun` and `deno` bare or with `run`) names the first argument that is not an
 *   option and is written as a path, has a file extension, or is an existing regular
 *   file. An option that runs code or a module (`-e`, `-c`, `-m`, `-p`, `--eval`,
 *   `--print`, `--test`, …) ends the reading, and any other `bun` or `deno`
 *   subcommand (`test`, `install`, `task`, …) names nothing: a package script or a
 *   module is not a file this can name.
 *
 * A literal `cd <dir>` (or `pushd`, or a wrapper's own directory option) moves where
 * the later relative words of that command resolve, as the shell would: not past a
 * pipe or `&`, and not out of a subshell. When where they resolve cannot be known (a
 * `cd` to a variable, `cd -`), relative words name nothing rather than a different
 * file. A word with `$`, `*`, `?`, `[` or `{` names nothing, nor do `.` and `..`,
 * nor a path that is an existing directory: these are exact files. A leading `~/`
 * is the home directory. Nothing here throws.
 *
 * Not read: what a script a hook names runs in its turn, a word built at run time,
 * and a command a here-document feeds.
 */
import { lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

/** The shells: the first argument that is not an option is the script. */
const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** The interpreters that run the first argument that reads as a file. */
const INTERPRETERS: ReadonlySet<string> = new Set([
  "bun",
  "node",
  "deno",
  "tsx",
  "python",
  "python3",
  "ruby",
  "perl",
  "php",
]);

/** `bun` subcommands; `run` and `x` and `exec` are read, every other one names nothing. */
const BUN_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "run",
  "x",
  "exec",
  "test",
  "install",
  "i",
  "add",
  "a",
  "remove",
  "rm",
  "update",
  "outdated",
  "link",
  "unlink",
  "pm",
  "build",
  "init",
  "create",
  "c",
  "upgrade",
  "publish",
  "audit",
  "info",
  "patch",
  "patch-commit",
  "why",
  "repl",
  "completions",
  "discord",
  "help",
  "getcompletes",
  "feedback",
]);

/** `deno` subcommands; `run` and `serve` name their script, every other one names nothing. */
const DENO_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "run",
  "serve",
  "x",
  "task",
  "test",
  "bench",
  "check",
  "compile",
  "fmt",
  "lint",
  "install",
  "i",
  "uninstall",
  "info",
  "doc",
  "eval",
  "repl",
  "upgrade",
  "cache",
  "coverage",
  "init",
  "jupyter",
  "publish",
  "add",
  "remove",
  "types",
  "vendor",
  "outdated",
  "clean",
  "completions",
  "help",
  "lsp",
  "update",
]);

/** Per interpreter: options that end the reading, options that take a value, options that set the directory. */
interface Options {
  readonly stop: ReadonlySet<string>;
  readonly value: ReadonlySet<string>;
  readonly chdir?: ReadonlySet<string>;
}

const NODE_OPTIONS: Options = {
  stop: new Set([
    "-e",
    "--eval",
    "-p",
    "--print",
    "--test",
    "-v",
    "--version",
    "-h",
    "--help",
    "-",
  ]),
  value: new Set([
    "-r",
    "--require",
    "--import",
    "--loader",
    "--experimental-loader",
    "-C",
    "--conditions",
    "--env-file",
    "--input-type",
    "--title",
    "--tsconfig",
  ]),
};

const INTERPRETER_OPTIONS: Readonly<Record<string, Options>> = {
  node: NODE_OPTIONS,
  tsx: NODE_OPTIONS,
  bun: {
    stop: new Set(["-e", "--eval", "-p", "--print", "-v", "--version", "-h", "--help", "-"]),
    value: new Set([
      "-r",
      "--preload",
      "-c",
      "--config",
      "--env-file",
      "--tsconfig-override",
      "-d",
      "--define",
      "-l",
      "--loader",
      "--main-fields",
      "--conditions",
      "--port",
      "-F",
      "--filter",
      "--shell",
      "--elide-lines",
    ]),
    chdir: new Set(["--cwd"]),
  },
  deno: {
    stop: new Set(["-v", "--version", "-h", "--help", "-"]),
    value: new Set(["-c", "--config", "--import-map", "-L", "--log-level", "--env-file", "--lock"]),
  },
  python: { stop: new Set(["-"]), value: new Set(["-W", "-X", "-Q"]) },
  python3: { stop: new Set(["-"]), value: new Set(["-W", "-X", "-Q"]) },
  ruby: {
    stop: new Set(["-e", "-"]),
    value: new Set(["-r", "-I", "-E", "--encoding"]),
    chdir: new Set(["-C"]),
  },
  perl: { stop: new Set(["-e", "-E", "-"]), value: new Set(["-I"]) },
  php: { stop: new Set(["-r", "-a", "-"]), value: new Set(["-c", "-d", "-z"]) },
};

/** A wrapper runs the command after its options; `chdir` options move where it runs. */
interface Wrapper {
  readonly value: ReadonlySet<string>;
  readonly chdir?: ReadonlySet<string>;
  /** Positional words the wrapper takes before the command (`timeout`'s duration). */
  readonly positional?: number;
  /** Options whose value is a shell command (`npx -c`). */
  readonly shellString?: ReadonlySet<string>;
  /** Options whose value is a list of words to put before the command (`env -S`). */
  readonly splitString?: ReadonlySet<string>;
  /** Assignments may stand among the options (`env A=1`). */
  readonly assignments?: boolean;
}

const WRAPPERS: Readonly<Record<string, Wrapper>> = {
  env: {
    value: new Set(["-u", "--unset", "-P"]),
    chdir: new Set(["-C", "--chdir"]),
    splitString: new Set(["-S", "--split-string"]),
    assignments: true,
  },
  exec: { value: new Set(["-a"]) },
  command: { value: new Set() },
  builtin: { value: new Set() },
  time: { value: new Set(["-o", "-f", "--output", "--format"]) },
  nohup: { value: new Set() },
  nice: { value: new Set(["-n", "--adjustment"]) },
  timeout: {
    value: new Set(["-s", "--signal", "-k", "--kill-after"]),
    positional: 1,
  },
  sudo: {
    value: new Set([
      "-u",
      "--user",
      "-g",
      "--group",
      "-C",
      "--close-from",
      "-p",
      "--prompt",
      "-U",
      "--other-user",
      "-r",
      "--role",
      "-t",
      "--type",
      "-T",
      "--command-timeout",
      "-h",
      "--host",
    ]),
    chdir: new Set(["-D", "--chdir"]),
  },
  xargs: {
    value: new Set([
      "-n",
      "--max-args",
      "-I",
      "--replace",
      "-L",
      "--max-lines",
      "-P",
      "--max-procs",
      "-s",
      "--max-chars",
      "-d",
      "--delimiter",
      "-E",
      "--eof",
      "-a",
      "--arg-file",
    ]),
  },
  npx: {
    value: new Set(["-p", "--package"]),
    shellString: new Set(["-c", "--call"]),
  },
  pnpx: { value: new Set(["-p", "--package"]), shellString: new Set(["-c", "--call"]) },
  bunx: { value: new Set(["-p", "--package"]) },
};

/** Reserved words and grouping a simple command may start with; what follows is the command. */
const LEADING_WORDS: ReadonlySet<string> = new Set([
  "if",
  "then",
  "elif",
  "else",
  "do",
  "while",
  "until",
  "!",
  "{",
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const UNNAMED = /[$*?[{]/;
const EXTENSION = /\.[A-Za-z0-9]+$/;

type Separator = ";" | "&&" | "||" | "|" | "&";

type Token =
  | { readonly kind: "word"; readonly text: string }
  | { readonly kind: "sep"; readonly op: Separator }
  | { readonly kind: "open" }
  | { readonly kind: "close" }
  | { readonly kind: "redir"; readonly op: string };

/**
 * A shell command as tokens, POSIX-quoted, or `undefined` when it holds a
 * substitution, a here-document or an unbalanced quote.
 */
function tokenize(command: string): Token[] | undefined {
  if (command.includes("$(") || command.includes("`")) return undefined;
  const tokens: Token[] = [];
  let word = "";
  let inWord = false;
  let quoted = false;
  const endWord = (): void => {
    if (inWord) tokens.push({ kind: "word", text: word });
    word = "";
    inWord = false;
    quoted = false;
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] as string;
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      if (close === -1) return undefined;
      word += command.slice(i + 1, close);
      inWord = true;
      quoted = true;
      i = close;
    } else if (ch === '"') {
      let j = i + 1;
      let closed = false;
      for (; j < command.length; j += 1) {
        const inner = command[j] as string;
        if (inner === '"') {
          closed = true;
          break;
        }
        if (inner === "\\" && j + 1 < command.length) {
          const next = command[j + 1] as string;
          if (next === "\\" || next === '"' || next === "$" || next === "`") {
            word += next;
            j += 1;
            continue;
          }
          if (next === "\n") {
            j += 1;
            continue;
          }
        }
        word += inner;
      }
      if (!closed) return undefined;
      inWord = true;
      quoted = true;
      i = j;
    } else if (ch === "\\") {
      if (i + 1 >= command.length) return undefined;
      const next = command[i + 1] as string;
      if (next !== "\n") {
        word += next;
        inWord = true;
        quoted = true;
      }
      i += 1;
    } else if (ch === "#" && !inWord) {
      // A comment runs to the end of the line.
      while (i + 1 < command.length && command[i + 1] !== "\n") i += 1;
    } else if (ch === "<" || ch === ">") {
      // `2>` and `0<` carry the descriptor in the word before the operator.
      if (inWord && !quoted && /^[0-9]+$/.test(word)) {
        word = "";
        inWord = false;
      } else {
        endWord();
      }
      const next = command[i + 1];
      if (ch === "<" && next === "<") return undefined;
      let op = ch;
      if (next === ">" || next === "&" || next === "|" || (ch === "<" && next === ">")) {
        op += next;
        i += 1;
      }
      tokens.push({ kind: "redir", op });
    } else if (ch === "&") {
      endWord();
      if (command[i + 1] === ">") {
        let op = "&>";
        i += 1;
        if (command[i + 1] === ">") {
          op += ">";
          i += 1;
        }
        tokens.push({ kind: "redir", op });
      } else if (command[i + 1] === "&") {
        tokens.push({ kind: "sep", op: "&&" });
        i += 1;
      } else {
        tokens.push({ kind: "sep", op: "&" });
      }
    } else if (ch === "|") {
      endWord();
      if (command[i + 1] === "|") {
        tokens.push({ kind: "sep", op: "||" });
        i += 1;
      } else {
        if (command[i + 1] === "&") i += 1;
        tokens.push({ kind: "sep", op: "|" });
      }
    } else if (ch === ";" || ch === "\n") {
      endWord();
      tokens.push({ kind: "sep", op: ";" });
    } else if (ch === "(") {
      endWord();
      tokens.push({ kind: "open" });
    } else if (ch === ")") {
      endWord();
      tokens.push({ kind: "close" });
    } else if (ch === " " || ch === "\t") {
      endWord();
    } else {
      word += ch;
      inWord = true;
    }
  }
  endWord();
  return tokens;
}

/** One simple command: its words, and the files `<` feeds it. */
interface Simple {
  readonly words: readonly string[];
  readonly inputs: readonly string[];
}

/** The simple commands of a token list, each with the separators either side of it. */
function* simpleCommands(tokens: readonly Token[]): Generator<
  | {
      readonly kind: "command";
      readonly command: Simple;
      readonly before?: Separator;
      readonly after?: Separator;
    }
  | { readonly kind: "open" }
  | { readonly kind: "close" }
> {
  let words: string[] = [];
  let inputs: string[] = [];
  let redirect: string | undefined;
  let before: Separator | undefined;
  const take = function* (after: Separator | undefined) {
    if (words.length > 0 || inputs.length > 0) {
      yield {
        kind: "command" as const,
        command: { words, inputs },
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
      };
    }
    words = [];
    inputs = [];
    redirect = undefined;
  };
  for (const token of tokens) {
    if (token.kind === "word") {
      if (redirect !== undefined) {
        if (redirect === "<") inputs.push(token.text);
        redirect = undefined;
      } else {
        words.push(token.text);
      }
    } else if (token.kind === "redir") {
      redirect = token.op;
    } else if (token.kind === "sep") {
      yield* take(token.op);
      before = token.op;
    } else {
      yield* take(undefined);
      before = undefined;
      yield token;
    }
  }
  yield* take(undefined);
}

/**
 * A shell command as its simple commands' words, POSIX-quoted, with redirections and
 * their targets left out, or `undefined` when it holds a substitution, a
 * here-document or an unbalanced quote.
 */
export function splitShellCommand(command: string): readonly (readonly string[])[] | undefined {
  const tokens = tokenize(command);
  if (tokens === undefined) return undefined;
  const out: string[][] = [];
  for (const item of simpleCommands(tokens)) {
    if (item.kind === "command" && item.command.words.length > 0) {
      out.push([...item.command.words]);
    }
  }
  return out;
}

/** Whether a word is written as a path rather than a name looked up on `PATH`. */
function pathShaped(word: string): boolean {
  return word.startsWith("/") || word.includes("/");
}

/** A word with `~` expanded as the shell expands a leading one; `undefined` for `~user`. */
function expandHome(word: string): string | undefined {
  if (word === "~") return homedir();
  if (word.startsWith("~/")) return join(homedir(), word.slice(2));
  if (word.startsWith("~")) return undefined;
  return word;
}

/**
 * The exact file a word names, resolved against `base`; `undefined` when it names
 * none, or when it is relative and where it resolves is not known.
 */
function fileOf(word: string, base: string | undefined): string | undefined {
  if (word === "" || word === "." || word === ".." || UNNAMED.test(word)) return undefined;
  const expanded = expandHome(word);
  if (expanded === undefined) return undefined;
  let path: string;
  if (isAbsolute(expanded)) path = resolve(expanded);
  else if (base === undefined) return undefined;
  else path = resolve(base, expanded);
  try {
    if (lstatSync(path).isDirectory()) return undefined;
  } catch {
    // Not there yet: still the file the hook will run.
  }
  return path;
}

/** Whether `path` is an existing regular file, a link to one included. */
function existingFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (stat.isFile()) return true;
    return stat.isSymbolicLink() && statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Whether an interpreter's argument reads as a file: a path, a file extension, or a file that is there. */
function readsAsFile(word: string, base: string | undefined): boolean {
  if (pathShaped(word) || word.startsWith("~/") || EXTENSION.test(word)) return true;
  const path = fileOf(word, base);
  return path !== undefined && existingFile(path);
}

/** The directory a `cd` word moves to from `base`; `undefined` when it cannot be known. */
function directoryOf(word: string | undefined, base: string | undefined): string | undefined {
  if (word === undefined) return homedir();
  if (word === "" || word === "-" || UNNAMED.test(word)) return undefined;
  const expanded = expandHome(word);
  if (expanded === undefined) return undefined;
  if (isAbsolute(expanded)) return resolve(expanded);
  return base === undefined ? undefined : resolve(base, expanded);
}

/** Whether a word is an option: `-x`, `--x`, but not a lone `-`. */
function isOption(word: string): boolean {
  return word.startsWith("-") && word !== "-";
}

/** What reading one command found: the files, and where a `cd` in it moves to. */
interface Reading {
  /** Set when the command is a `cd`: the directory, or `undefined` when unknown. */
  readonly cd?: { readonly dir: string | undefined };
}

/**
 * Read one simple command's words (after any reserved words) into `out`, resolving
 * relative words against `base`. `shell` says whether the words came from a shell
 * command (where `cd` means something) or an argv.
 */
function readCommand(
  initial: readonly string[],
  inputs: readonly string[],
  base: string | undefined,
  shell: boolean,
  out: (string | undefined)[],
  depth: number,
): Reading {
  let words = [...initial];
  let dir = base;
  for (;;) {
    while (words.length > 0 && ASSIGNMENT.test(words[0] as string)) words = words.slice(1);
    const command = words[0];
    if (command === undefined) return {};
    const name = basename(command);
    if (shell && (command === "cd" || command === "pushd")) {
      const args = words.slice(1).filter((word) => !/^-[LPe@]+$/.test(word));
      const target = args[0] === "--" ? args[1] : args[0];
      return { cd: { dir: directoryOf(target, dir) } };
    }
    if (pathShaped(command)) out.push(fileOf(command, dir));
    const rest = words.slice(1);
    const wrapper = WRAPPERS[name];
    if (wrapper !== undefined) {
      words = skipOptions(
        rest,
        wrapper,
        (to) => {
          dir = to;
        },
        dir,
        out,
        depth,
      );
      continue;
    }
    if (SHELLS.has(name)) {
      readShell(rest, inputs, dir, out, depth);
      return {};
    }
    if (name === "." || name === "source") {
      const script = rest[0] === "--" ? rest[1] : rest[0];
      if (script !== undefined) out.push(fileOf(script, dir));
      return {};
    }
    if (INTERPRETERS.has(name)) {
      readInterpreter(name, rest, dir, out, depth);
      return {};
    }
    return {};
  }
}

/**
 * The words after a wrapper's options (and its positional words), with a directory
 * option applied through `moveTo`. A shell-string option is read as a shell command;
 * a split-string option's words go before the rest.
 */
function skipOptions(
  words: readonly string[],
  wrapper: Wrapper,
  moveTo: (dir: string | undefined) => void,
  base: string | undefined,
  out: (string | undefined)[],
  depth: number,
): string[] {
  let i = 0;
  let dir = base;
  let positional = wrapper.positional ?? 0;
  while (i < words.length) {
    const word = words[i] as string;
    if (word === "--") {
      i += 1;
      break;
    }
    if (wrapper.assignments === true && ASSIGNMENT.test(word)) {
      i += 1;
      continue;
    }
    if (isOption(word) || (word === "-" && wrapper.assignments === true)) {
      const eq = word.indexOf("=");
      const flag = eq === -1 ? word : word.slice(0, eq);
      const inline = eq === -1 ? undefined : word.slice(eq + 1);
      const takesValue = (set: ReadonlySet<string> | undefined): boolean => set?.has(flag) === true;
      if (takesValue(wrapper.chdir)) {
        const value = inline ?? words[i + 1];
        dir = directoryOf(value, dir);
        moveTo(dir);
        i += inline === undefined ? 2 : 1;
        continue;
      }
      if (takesValue(wrapper.shellString)) {
        const value = inline ?? words[i + 1];
        if (value !== undefined) readShellText(value, dir, out, depth);
        return [];
      }
      if (takesValue(wrapper.splitString)) {
        const value = inline ?? words[i + 1];
        const split = value === undefined ? undefined : splitShellCommand(value);
        const head = split?.[0] ?? [];
        return [...head, ...words.slice(i + (inline === undefined ? 2 : 1))];
      }
      if (takesValue(wrapper.value)) {
        i += inline === undefined ? 2 : 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (positional > 0) {
      positional -= 1;
      i += 1;
      continue;
    }
    break;
  }
  return words.slice(i);
}

/** A shell's arguments: its script, its `-c` string, or the file `<` feeds it. */
function readShell(
  args: readonly string[],
  inputs: readonly string[],
  base: string | undefined,
  out: (string | undefined)[],
  depth: number,
): void {
  let commandMode = false;
  let i = 0;
  while (i < args.length) {
    const word = args[i] as string;
    if (word === "--") {
      i += 1;
      break;
    }
    if (word === "-") break;
    if (word === "--rcfile" || word === "--init-file") {
      i += 2;
      continue;
    }
    if (/^[-+][A-Za-z]+$/.test(word)) {
      let skip = 0;
      for (const letter of word.slice(1)) {
        if (letter === "c") commandMode = true;
        if (letter === "o" || letter === "O") skip += 1;
      }
      i += 1 + skip;
      continue;
    }
    if (word.startsWith("--")) {
      i += 1;
      continue;
    }
    break;
  }
  const first = args[i];
  if (commandMode) {
    if (first !== undefined) readShellText(first, base, out, depth);
    return;
  }
  if (first !== undefined && first !== "-") {
    out.push(fileOf(first, base));
    return;
  }
  for (const input of inputs) out.push(fileOf(input, base));
}

/** An interpreter's arguments: the first that reads as a file, unless an option ends the reading. */
function readInterpreter(
  name: string,
  args: readonly string[],
  base: string | undefined,
  out: (string | undefined)[],
  depth: number,
): void {
  const options = INTERPRETER_OPTIONS[name] as Options;
  let dir = base;
  let words = [...args];
  const pythonLike = name === "python" || name === "python3";
  let sawSubcommand = false;
  let afterOption = false;
  while (words.length > 0) {
    const word = words[0] as string;
    if (word === "--") {
      words = words.slice(1);
      continue;
    }
    if (isOption(word) || word === "-") {
      const eq = word.indexOf("=");
      const flag = eq === -1 ? word : word.slice(0, eq);
      if (options.stop.has(flag)) return;
      // `python -m mod`, `python -c code` and a cluster holding either run no file.
      if (pythonLike && /^-[A-Za-z]+$/.test(word) && /[mc]/.test(word.slice(1))) return;
      if (options.chdir?.has(flag) === true) {
        dir = directoryOf(eq === -1 ? words[1] : word.slice(eq + 1), dir);
        words = words.slice(eq === -1 ? 2 : 1);
        afterOption = false;
        continue;
      }
      const takesValue = eq === -1 && options.value.has(flag);
      words = words.slice(takesValue ? 2 : 1);
      afterOption = !takesValue;
      continue;
    }
    if (!sawSubcommand && (name === "bun" || name === "deno")) {
      const subcommands = name === "bun" ? BUN_SUBCOMMANDS : DENO_SUBCOMMANDS;
      if (subcommands.has(word)) {
        if (name === "bun" && word === "exec") {
          if (words[1] !== undefined) readShellText(words[1], dir, out, depth);
          return;
        }
        if (name === "bun" && word === "x") {
          // `bun x <command>` runs the command after it, as `bunx` does.
          const after = skipOptions(
            words.slice(1),
            WRAPPERS["bunx"] as Wrapper,
            () => {},
            dir,
            out,
            depth,
          );
          out.push(...filesOfWords(after, dir, depth, true));
          return;
        }
        if (word !== "run" && word !== "serve") return;
        sawSubcommand = true;
        words = words.slice(1);
        continue;
      }
    }
    if (readsAsFile(word, dir)) {
      out.push(fileOf(word, dir));
      return;
    }
    // `bun lint` and `bun run lint` run a package script; a word that is not a file
    // is passed over only after an option that may have taken it as its value.
    if (name === "bun" || name === "deno" || !afterOption) return;
    afterOption = false;
    words = words.slice(1);
  }
}

/** The files an argv names, read from its command word on. */
function filesOfWords(
  words: readonly string[],
  base: string | undefined,
  depth: number,
  shell: boolean,
): (string | undefined)[] {
  const out: (string | undefined)[] = [];
  readCommand(words, [], base, shell, out, depth);
  return out;
}

/** The deepest a `sh -c` inside a `sh -c` is read. */
const MAX_DEPTH = 4;

/** Read a shell command's simple commands into `out`, tracking a literal `cd`. */
function readShellText(
  command: string,
  base: string | undefined,
  out: (string | undefined)[],
  depth: number,
): void {
  if (depth > MAX_DEPTH) return;
  const tokens = tokenize(command);
  if (tokens === undefined) return;
  let dir = base;
  const saved: (string | undefined)[] = [];
  for (const item of simpleCommands(tokens)) {
    if (item.kind === "open") {
      saved.push(dir);
      continue;
    }
    if (item.kind === "close") {
      if (saved.length > 0) dir = saved.pop();
      continue;
    }
    let words = item.command.words;
    while (words.length > 0 && LEADING_WORDS.has(words[0] as string)) words = words.slice(1);
    const reading = readCommand(words, item.command.inputs, dir, true, out, depth + 1);
    // A `cd` in a pipeline or in the background runs in its own process.
    const own = item.before !== "|" && item.after !== "|" && item.after !== "&";
    if (reading.cd !== undefined && own) dir = reading.cd.dir;
  }
}

function dedupe(paths: readonly (string | undefined)[]): string[] {
  return [...new Set(paths.filter((path): path is string => path !== undefined))];
}

/** The files a shell command names directly, resolved against `cwd`. */
export function filesNamedBy(command: string, cwd: string): string[] {
  const out: (string | undefined)[] = [];
  readShellText(command, cwd, out, 0);
  return dedupe(out);
}

/** The files an argv names directly, read with no shell, resolved against `cwd`. */
export function filesNamedByArgv(argv: readonly string[], cwd: string): string[] {
  return dedupe(filesOfWords(argv, cwd, 0, false));
}

/**
 * A manager hook's argv, read as harness-supervisor's `parseManagerHook` reads the
 * declaration (a string is one word, never split; an array keeps its non-empty
 * strings, trimmed) with its first word resolved as `resolveHookCommand` resolves it:
 * against the harness when it is written as a path. `undefined` for no usable hook.
 * runtime-core does not depend on harness-supervisor; a test holds the two equal.
 */
export function managerHookArgv(value: unknown, harnessDir: string): string[] | undefined {
  let argv: string[];
  if (typeof value === "string") {
    const command = value.trim();
    if (command === "") return undefined;
    argv = [command];
  } else if (Array.isArray(value)) {
    argv = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    if (argv.length === 0) return undefined;
  } else {
    return undefined;
  }
  const first = argv[0] as string;
  const resolved =
    isAbsolute(first) || !(first.startsWith("./") || first.startsWith("../"))
      ? first
      : resolve(harnessDir, first);
  return [resolved, ...argv.slice(1)];
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The files the hooks of `<cwd>/.crewhaus/settings.json` name directly
 * (`manager.hooks.postCompile`, `.preSpawn` and each `hooks[].command`), and those
 * `hookCommands` name (shell commands: the hooks a run loaded). Tolerant as the
 * supervisor's own reader is: a missing or malformed file, a key of the wrong type
 * and a bad entry each read as nothing.
 */
export function hookTargetFiles(cwd: string, hookCommands: readonly string[] = []): string[] {
  const out: string[] = [];
  let settings: Record<string, unknown> | undefined;
  try {
    settings = objectOf(
      JSON.parse(readFileSync(resolve(cwd, ".crewhaus", "settings.json"), "utf8")),
    );
  } catch {
    settings = undefined;
  }
  const managerHooks = objectOf(objectOf(settings?.["manager"])?.["hooks"]);
  for (const name of ["postCompile", "preSpawn"]) {
    const argv = managerHookArgv(managerHooks?.[name], cwd);
    if (argv !== undefined) out.push(...filesNamedByArgv(argv, cwd));
  }
  const hooks = settings?.["hooks"];
  if (Array.isArray(hooks)) {
    for (const hook of hooks) {
      const command = objectOf(hook)?.["command"];
      if (typeof command === "string") out.push(...filesNamedBy(command, cwd));
    }
  }
  for (const command of hookCommands) {
    if (typeof command === "string") out.push(...filesNamedBy(command, cwd));
  }
  return dedupe(out);
}
