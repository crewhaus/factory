/**
 * A shell command line read the way a permission rule needs it: as the
 * simple commands `sh -c` will run.
 *
 * `alwaysAllow Bash(git *)` was matched against the whole line, so it
 * allowed `git status && rm -rf build`, and `alwaysDeny Bash(rm -rf **)`
 * missed the `rm` that came second. A line is one or more simple commands
 * joined by `&&`, `||`, `;`, `|`, `&`, a newline or a pair of parentheses,
 * and each one runs a program. So an allow must match every simple command
 * of the line, and a deny or ask fires on any one of them — as well as on
 * the whole line, as before. An allow whose own pattern reads as a chain
 * (`cd ** && make *`) is matched against a line joined the same way piece
 * by piece, each piece against the command in its place
 * ({@link readShellChain}).
 *
 * This is a reader, not a shell. It splits a line only where it can say
 * exactly what runs. Anything whose commands it cannot read out of the text
 * makes the line OPAQUE: a command substitution (`$(…)` or backticks), a
 * process substitution (`<(…)`, `>(…)`), a here-document (its body is data
 * to one program and commands to another), an unterminated quote, a `$'…'`
 * string (bash reads it as one quoted word, dash as `$` and a quote, so the
 * two split the line differently), a NUL byte, and the compound commands
 * whose words it does not model (`for`, `case`, `select`, a function
 * definition, `[[ … ]]`, `(( … ))`, `coproc`). No scoped allow covers an
 * opaque line: the call asks. A deny or ask still reads it, best effort —
 * the inside of every substitution, both readings of a `$'…'` string, the
 * lines of a here-document — so it fires where it can.
 *
 * What a deny or ask reads of each simple command, beyond the command as
 * written: the command without the variables it sets and the redirections
 * it opens first (`FOO=1 rm -rf x`, `2>/dev/null rm x`), its words with the
 * quoting taken off (`"r"m -rf x` runs `rm`), with the variables the line
 * itself sets to plain text put in (`x=rm; $x -rf build`) and bash's brace
 * lists spread (`{rm,-rf,x}`), the command a wrapper runs (`env`,
 * `command`, `exec`, `builtin`, `nohup`, `time`, `nice`, `timeout`, `sudo`,
 * `doas`, `xargs`, `setsid`, `stdbuf`, `busybox`), and the line an `eval`,
 * an `env -S` or a shell's `-c` runs, read the same way. When the program a
 * command runs is not named in the text at all — a substitution, a
 * pathname pattern, a variable the line fills from input (`read x; $x`) —
 * every deny or ask fires, and no scoped allow grants it; the same when the
 * program is a variable the line sets. A variable the line never sets is
 * the harness's own (`$PYTHON script.py`), and is read as written. A
 * program that runs another from its own arguments in some other way
 * (`find -exec`, `git -c alias.x=!…`, `make`) is not read: an allow list is
 * the way to be sure of those.
 *
 * Linear in the length of the line, per level of nesting; nesting is read
 * {@link MAX_SHELL_NESTING} levels deep.
 *
 * Pure: no filesystem, no process, no `node:` import. The edge worker's
 * permission gate uses it.
 */

/** How one line reads. */
export type ShellReading = {
  /**
   * Each simple command the line runs, as written — trimmed, and without
   * the reserved words that open or close a compound command around it
   * (`if`, `then`, `{`, `!`, …). Empty for a line that runs nothing (blank,
   * or a comment).
   */
  readonly commands: ReadonlyArray<string>;
  /** Why the line cannot be split honestly, when it cannot. */
  readonly opaque?: string;
};

/** How deep an `eval`, a `-c` or a substitution inside another is read for a deny. */
export const MAX_SHELL_NESTING = 4;

/** One token of a simple command. */
type Token = {
  readonly start: number;
  readonly end: number;
  /** The word with its quoting removed (a redirection keeps its source text). */
  readonly value: string;
  readonly quoted: boolean;
  readonly redirect: boolean;
};

type SimpleCommand = {
  readonly tokens: ReadonlyArray<Token>;
};

type Scan = {
  readonly commands: SimpleCommand[];
  /** The text of every substitution, for a deny to read as a line of its own. */
  readonly nested: string[];
  opaque: string | undefined;
};

/** Reserved words that open or close a compound command around a simple one. */
const FRAMING_WORDS: ReadonlySet<string> = new Set([
  "!",
  "{",
  "}",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "while",
  "until",
]);

/** Compound commands whose words this reader does not model. */
const UNREAD_COMPOUNDS: ReadonlyMap<string, string> = new Map([
  ["for", "a `for` loop"],
  ["case", "a `case` statement"],
  ["esac", "a `case` statement"],
  ["select", "a `select` loop"],
  ["function", "a function definition"],
  ["coproc", "a `coproc` command"],
  ["[[", "a `[[ … ]]` test"],
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

function isBlank(c: string | undefined): boolean {
  return c === " " || c === "\t";
}

/** Characters that end an unquoted word. */
function endsWord(c: string): boolean {
  return (
    c === " " ||
    c === "\t" ||
    c === "\n" ||
    c === ";" ||
    c === "&" ||
    c === "|" ||
    c === "(" ||
    c === ")" ||
    c === "<" ||
    c === ">"
  );
}

type Nesting = "paren" | "brace" | "dq" | "bt";

/** A count of the characters a read looked at, for a test that checks the cost is linear. */
export type ShellWork = { steps: number };

/**
 * The index of what closes the construct opened just before `from` (a `)`
 * for `$(`, `<(` or `>(`, a `}` for `${`, a backtick), or -1 when nothing
 * does. Quotes, escapes and constructs nested inside are skipped over with
 * an explicit stack, so a deeply nested line costs its length and no call
 * depth.
 */
function findClose(line: string, from: number, opener: Nesting, work: ShellWork): number {
  const stack: Nesting[] = [opener];
  let j = from;
  let wordStart = true;
  while (j < line.length) {
    work.steps++;
    const top = stack[stack.length - 1] as Nesting;
    const c = line.charAt(j);
    const next = line.charAt(j + 1);
    if (top === "dq") {
      if (c === "\\") j += 2;
      else if (c === '"') {
        stack.pop();
        j++;
      } else if (c === "`") {
        stack.push("bt");
        j++;
      } else if (c === "$" && (next === "(" || next === "{")) {
        stack.push(next === "(" ? "paren" : "brace");
        j += 2;
      } else j++;
    } else if (top === "bt") {
      if (c === "\\") j += 2;
      else if (c === "`") {
        stack.pop();
        j++;
      } else j++;
    } else {
      if (c === "\\") {
        j += 2;
        wordStart = false;
        continue;
      }
      if (c === "'") {
        const close = line.indexOf("'", j + 1);
        work.steps += (close === -1 ? line.length : close) - j;
        if (close === -1) return -1;
        j = close + 1;
        wordStart = false;
        continue;
      }
      if (c === '"') {
        stack.push("dq");
        j++;
        wordStart = false;
        continue;
      }
      if (c === "`") {
        stack.push("bt");
        j++;
        wordStart = false;
        continue;
      }
      if (c === "$" && (next === "(" || next === "{")) {
        stack.push(next === "(" ? "paren" : "brace");
        j += 2;
        wordStart = false;
        continue;
      }
      if (top === "paren" && c === "#" && wordStart) {
        const nl = line.indexOf("\n", j);
        work.steps += (nl === -1 ? line.length : nl) - j;
        j = nl === -1 ? line.length : nl;
        continue;
      }
      const open = top === "paren" ? "(" : "{";
      const close = top === "paren" ? ")" : "}";
      if (c === open) stack.push(top);
      else if (c === close) stack.pop();
      wordStart =
        top === "paren" &&
        (isBlank(c) || c === "\n" || c === ";" || c === "&" || c === "|" || c === "(");
      j++;
    }
    if (stack.length === 0) return j - 1;
  }
  return -1;
}

/** Undo the backslash escapes a backtick substitution's text is written with. */
function unescapeBackticks(text: string): string {
  return text.replace(/\\([\\`$])/g, "$1");
}

/** Decode the escapes of a bash `$'…'` string, the common ones. */
function decodeAnsiC(text: string): string {
  return text.replace(/\\(x[0-9A-Fa-f]{1,2}|[0-7]{1,3}|.)/gs, (_m, e: string) => {
    if (e.startsWith("x")) return String.fromCharCode(Number.parseInt(e.slice(1), 16));
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(Number.parseInt(e, 8));
    switch (e) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      default:
        return e;
    }
  });
}

/**
 * One pass over a line. With `ansiC`, `$'…'` is bash's quoted string;
 * without, it is dash's `$` followed by a single-quoted string.
 *
 * Once a quote or a substitution is found to have no end, the rest of the
 * line is read with quotes and substitutions as plain characters: the line
 * is opaque already, and looking for an end from every later opener would
 * cost the square of the line's length.
 */
function scan(line: string, ansiC: boolean, work: ShellWork): Scan {
  const out: Scan = { commands: [], nested: [], opaque: undefined };
  const markOpaque = (why: string): void => {
    out.opaque ??= why;
  };
  let blind = false;
  const closeAt = (from: number, opener: Nesting): number => {
    if (blind) return -1;
    const at = findClose(line, from, opener, work);
    if (at === -1) blind = true;
    return at;
  };
  const n = line.length;
  let tokens: Token[] = [];
  let depth = 0;
  // A simple command ends: the reserved words that frame it are dropped,
  // and one that opens a compound this reader does not model makes the
  // line opaque. Done here, so reasons are given in the order of the text.
  const flush = (): void => {
    let from = 0;
    while (from < tokens.length) {
      const first = tokens[from] as Token;
      if (first.redirect || first.quoted) break;
      if (FRAMING_WORDS.has(first.value)) {
        from++;
        continue;
      }
      const compound = UNREAD_COMPOUNDS.get(first.value);
      if (compound !== undefined) markOpaque(compound);
      break;
    }
    if (from < tokens.length)
      out.commands.push({ tokens: from === 0 ? tokens : tokens.slice(from) });
    tokens = [];
  };
  let i = 0;

  /** Read one word from `i`; it ends at a blank or an operator outside quotes. */
  const readWord = (): Token => {
    const start = i;
    let value = "";
    let quoted = false;
    while (i < n) {
      work.steps++;
      const c = line.charAt(i);
      if (endsWord(c)) break;
      if (c === "\\") {
        if (i + 1 >= n) {
          value += c;
          i++;
        } else if (line.charAt(i + 1) === "\n") {
          i += 2;
        } else {
          value += line.charAt(i + 1);
          quoted = true;
          i += 2;
        }
        continue;
      }
      if (c === "'") {
        const end = blind ? -1 : line.indexOf("'", i + 1);
        if (end === -1) {
          markOpaque("an unterminated quote");
          blind = true;
          value += c;
          i++;
          continue;
        }
        work.steps += end - i;
        value += line.slice(i + 1, end);
        quoted = true;
        i = end + 1;
        continue;
      }
      if (c === '"') {
        const end = closeAt(i + 1, "dq");
        if (end === -1) {
          markOpaque("an unterminated quote");
          value += c;
          i++;
          continue;
        }
        value += readDoubleQuoted(line.slice(i + 1, end));
        quoted = true;
        i = end + 1;
        continue;
      }
      if (c === "`") {
        markOpaque("a command substitution");
        const end = closeAt(i + 1, "bt");
        if (end === -1) {
          value += c;
          i++;
          continue;
        }
        out.nested.push(unescapeBackticks(line.slice(i + 1, end)));
        value += line.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      if (c === "$") {
        const next = line.charAt(i + 1);
        if (next === "(" || next === "{") {
          const close = blind ? -1 : closeAt(i + 2, next === "(" ? "paren" : "brace");
          if (next === "(") {
            markOpaque(
              line.charAt(i + 2) === "(" ? "an arithmetic expansion" : "a command substitution",
            );
          }
          if (close === -1) {
            markOpaque(`an unterminated ${next === "(" ? "$(" : "${"}`);
            value += c;
            i++;
            continue;
          }
          const inner = line.slice(i + 2, close);
          if (next === "(") out.nested.push(inner);
          else collectNested(inner);
          value += line.slice(i, close + 1);
          i = close + 1;
          continue;
        }
        if (next === "'") {
          markOpaque("a $'…' string, which sh and bash read differently");
          if (ansiC && !blind) {
            let j = i + 2;
            while (j < n && line.charAt(j) !== "'") j += line.charAt(j) === "\\" ? 2 : 1;
            work.steps += j - i;
            if (j >= n) {
              markOpaque("an unterminated quote");
              blind = true;
              value += c;
              i++;
              continue;
            }
            value += decodeAnsiC(line.slice(i + 2, j));
            quoted = true;
            i = j + 1;
            continue;
          }
        }
        if (next === '"' && ansiC) {
          // bash's `$"…"` is the quoted string translated; dash reads a `$`.
          i++;
          continue;
        }
      }
      if (c === "\u0000") markOpaque("a NUL byte");
      value += c;
      i++;
    }
    return { start, end: i, value, quoted, redirect: false };
  };

  /** A substitution inside a `${…}`: read for a deny, and it makes the line opaque. */
  const collectNested = (text: string): void => {
    if (!text.includes("$(") && !text.includes("`")) return;
    markOpaque("a command substitution");
    out.nested.push(text);
  };

  /** The text inside double quotes, with its escapes undone; a substitution inside is noted. */
  const readDoubleQuoted = (text: string): string => {
    let value = "";
    for (let j = 0; j < text.length; j++) {
      work.steps++;
      const c = text.charAt(j);
      const next = text.charAt(j + 1);
      if (c === "\\" && (next === "$" || next === "`" || next === '"' || next === "\\")) {
        value += next;
        j++;
      } else if (c === "\\" && next === "\n") {
        j++;
      } else if (c === "`") {
        const close = findClose(text, j + 1, "bt", work);
        markOpaque("a command substitution");
        if (close === -1) {
          value += c;
          continue;
        }
        out.nested.push(unescapeBackticks(text.slice(j + 1, close)));
        value += text.slice(j, close + 1);
        j = close;
      } else if (c === "$" && (next === "(" || next === "{")) {
        const close = findClose(text, j + 2, next === "(" ? "paren" : "brace", work);
        if (next === "(") markOpaque("a command substitution");
        if (close === -1) {
          value += c;
          continue;
        }
        const inner = text.slice(j + 2, close);
        if (next === "(") out.nested.push(inner);
        else collectNested(inner);
        value += text.slice(j, close + 1);
        j = close;
      } else {
        value += c;
      }
    }
    return value;
  };

  /** A redirection at `i` (`<`, `>`, `>>`, `2>&1`, `&>`, `<<<`, …) and the word it takes. */
  const readRedirect = (opStart: number): void => {
    // A number right before it, with nothing between, is the descriptor it
    // redirects (`2>`): part of the redirection, not a word of the command.
    let start = opStart;
    const last = tokens[tokens.length - 1];
    if (last !== undefined && !last.redirect && !last.quoted && last.end === opStart) {
      if (/^[0-9]+$/.test(last.value)) {
        tokens.pop();
        start = last.start;
      }
    }
    const c = line.charAt(i);
    const next = line.charAt(i + 1);
    if (next === "(" && (c === "<" || c === ">")) {
      markOpaque("a process substitution");
      const close = blind ? -1 : closeAt(i + 2, "paren");
      if (close === -1) {
        markOpaque("an unterminated process substitution");
        i += 2;
      } else {
        out.nested.push(line.slice(i + 2, close));
        i = close + 1;
      }
      tokens.push({ start, end: i, value: line.slice(start, i), quoted: false, redirect: true });
      return;
    }
    if (c === "<" && next === "<" && line.charAt(i + 2) !== "<") {
      // A here-document. Its body follows on the lines after this one, and
      // is read below as if it were lines of commands — only ever more than
      // runs, and only a deny reads an opaque line.
      markOpaque("a here-document");
    }
    // The operator: every run of `<`, `>`, `&`, `|` and `-` a redirection
    // spells (`>>`, `>&`, `<&-`, `>|`, `&>>`, `<<-`, `<<<`, `<>`).
    i++;
    while (i < n) {
      work.steps++;
      const d = line.charAt(i);
      if (d === "<" || d === ">") i++;
      else if (d === "&" && (line.charAt(i - 1) === "<" || line.charAt(i - 1) === ">")) i++;
      else if (d === "|" && line.charAt(i - 1) === ">") i++;
      else if (d === "-" && (line.charAt(i - 1) === "&" || line.charAt(i - 1) === "<")) i++;
      else break;
    }
    while (i < n && isBlank(line.charAt(i))) i++;
    let end = i;
    if (i < n && !endsWord(line.charAt(i))) end = readWord().end;
    tokens.push({ start, end, value: line.slice(start, end), quoted: false, redirect: true });
  };

  while (i < n) {
    work.steps++;
    const c = line.charAt(i);
    const next = line.charAt(i + 1);
    if (isBlank(c)) {
      i++;
    } else if (c === "\\" && next === "\n") {
      i += 2;
    } else if (c === "\n") {
      flush();
      i++;
    } else if (c === "#") {
      // A comment, at the start of a word, runs to the end of the line.
      const nl = line.indexOf("\n", i);
      work.steps += (nl === -1 ? n : nl) - i;
      i = nl === -1 ? n : nl;
    } else if (c === ";") {
      flush();
      if (next === ";") {
        markOpaque("a `case` statement");
        i += line.charAt(i + 2) === "&" ? 3 : 2;
      } else if (next === "&") {
        markOpaque("a `case` statement");
        i += 2;
      } else i++;
    } else if (c === "&") {
      if (next === ">") {
        readRedirect(i);
      } else {
        flush();
        i += next === "&" ? 2 : 1;
      }
    } else if (c === "|") {
      flush();
      i += next === "|" || next === "&" ? 2 : 1;
    } else if (c === "(") {
      if (tokens.length > 0) {
        // `name ()` is a function definition; `word(` anything else is not
        // a subshell either. Read on as if it were, for a deny.
        flush();
        markOpaque("a function definition");
      } else if (next === "(") {
        markOpaque("an arithmetic command");
      }
      depth++;
      i++;
    } else if (c === ")") {
      flush();
      if (depth > 0) depth--;
      else markOpaque("an unmatched `)`");
      i++;
    } else if (c === "<" || c === ">") {
      readRedirect(i);
    } else {
      tokens.push(readWord());
    }
  }
  flush();
  if (depth > 0) markOpaque("an unclosed `(`");
  return out;
}

function spanOf(line: string, tokens: ReadonlyArray<Token>): string {
  const first = tokens[0] as Token;
  const last = tokens[tokens.length - 1] as Token;
  return line.slice(first.start, last.end).trim();
}

/**
 * Read a shell command line into the simple commands it runs, or say why it
 * cannot be read that way. See the module comment.
 */
export function readShellLine(line: string, work: ShellWork = { steps: 0 }): ShellReading {
  const scanned = scan(line, false, work);
  const commands = scanned.commands.map((command) => spanOf(line, command.tokens));
  return scanned.opaque !== undefined ? { commands, opaque: scanned.opaque } : { commands };
}

/**
 * A line read as a chain: its simple commands, and what joins them.
 * `joins` has one more entry than `commands`: the text before the first
 * command, between each two, and after the last — the operators, the
 * reserved words that frame a compound command (`if`, `then`, `{`, …),
 * parentheses and comments — with the blanks beside an operator dropped and
 * any other run of blanks read as one space. Two lines with the same joins
 * run their commands in the same arrangement.
 */
export type ShellChain = {
  readonly commands: ReadonlyArray<string>;
  readonly joins: ReadonlyArray<string>;
};

/**
 * Read a line as a chain (see {@link ShellChain}), or `undefined` when its
 * commands cannot be read out of its text (see {@link readShellLine}).
 *
 * An allow whose own pattern reads as a chain is matched against a line
 * with the same joins command by command: `Bash(cd ** && make *)` grants
 * `cd build && make all`, each piece against its own command.
 */
export function readShellChain(
  line: string,
  work: ShellWork = { steps: 0 },
): ShellChain | undefined {
  const scanned = scan(line, false, work);
  if (scanned.opaque !== undefined) return undefined;
  const commands: string[] = [];
  const joins: string[] = [];
  let from = 0;
  for (const { tokens } of scanned.commands) {
    const start = (tokens[0] as Token).start;
    const end = (tokens[tokens.length - 1] as Token).end;
    joins.push(normalizeJoin(line.slice(from, start)));
    commands.push(line.slice(start, end).trim());
    from = end;
  }
  joins.push(normalizeJoin(line.slice(from)));
  work.steps += line.length;
  return { commands, joins };
}

/** See {@link ShellChain}: blanks beside an operator dropped, other runs read as one space. */
function normalizeJoin(text: string): string {
  return text
    .replace(/\\\n/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?([;&|()\n]) ?/g, "$1")
    .trim();
}

// ---------------------------------------------------------------------------
// What a deny or ask reads
// ---------------------------------------------------------------------------

/**
 * A program that runs the command its arguments name, and how to find that
 * command: the short options that take a value (`-u root`), the long ones
 * that do when written without `=`, whether `NAME=value` words may come
 * first, and how many operands come before the command (`timeout`'s
 * duration).
 */
type Wrapper = {
  readonly shortWithValue?: string;
  readonly longWithValue?: ReadonlyArray<string>;
  readonly assignments?: true;
  readonly operands?: number;
  /** Options after which the program only looks the command up. */
  readonly lookupOnly?: string;
};

const WRAPPERS: ReadonlyMap<string, Wrapper> = new Map<string, Wrapper>([
  [
    "env",
    {
      shortWithValue: "uCSP",
      longWithValue: ["unset", "chdir", "split-string"],
      assignments: true,
    },
  ],
  ["command", { lookupOnly: "vV" }],
  ["builtin", {}],
  ["exec", { shortWithValue: "a" }],
  ["nohup", {}],
  ["time", { shortWithValue: "fo", longWithValue: ["format", "output"] }],
  ["nice", { shortWithValue: "n", longWithValue: ["adjustment"] }],
  ["timeout", { shortWithValue: "ks", longWithValue: ["kill-after", "signal"], operands: 1 }],
  [
    "sudo",
    {
      shortWithValue: "ugCDhprtTU",
      longWithValue: [
        "user",
        "group",
        "close-from",
        "chdir",
        "host",
        "prompt",
        "role",
        "type",
        "command-timeout",
        "other-user",
      ],
      assignments: true,
    },
  ],
  ["doas", { shortWithValue: "uC" }],
  [
    "xargs",
    {
      shortWithValue: "IiLlnPsdEea",
      longWithValue: [
        "max-args",
        "max-procs",
        "max-chars",
        "delimiter",
        "eof",
        "arg-file",
        "max-lines",
        "replace",
      ],
    },
  ],
  ["setsid", {}],
  ["stdbuf", { shortWithValue: "ioe", longWithValue: ["input", "output", "error"] }],
  ["busybox", {}],
]);

/** Shells whose `-c` runs a line of its own. */
const SHELLS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "dash",
  "zsh",
  "ksh",
  "mksh",
  "ash",
  "yash",
  "posh",
  "fish",
  "csh",
  "tcsh",
]);

/** A program name as the lookup sees it: its last path segment, lower case, without `.exe`. */
function programName(word: string): string {
  const base = word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1);
  return base.toLowerCase().replace(/\.exe$/, "");
}

/**
 * Where the command a wrapper at `k` runs starts, and any line its options
 * carry (`env -S "…"`), or `undefined` when `words[k]` is no wrapper or
 * runs nothing.
 */
function unwrap(
  words: ReadonlyArray<string>,
  k: number,
): { readonly at: number; readonly line?: string } | undefined {
  const wrapper = WRAPPERS.get(programName(words[k] as string));
  if (wrapper === undefined) return undefined;
  let j = k + 1;
  let line: string | undefined;
  while (j < words.length) {
    const w = words[j] as string;
    if (w === "--") {
      j++;
      break;
    }
    if (wrapper.assignments === true && ASSIGNMENT.test(w)) {
      j++;
      continue;
    }
    if (w.startsWith("--")) {
      const eq = w.indexOf("=");
      const name = w.slice(2, eq === -1 ? undefined : eq);
      const takes = (wrapper.longWithValue ?? []).includes(name);
      if (name === "split-string") line = eq === -1 ? words[j + 1] : w.slice(eq + 1);
      j += takes && eq === -1 ? 2 : 1;
      continue;
    }
    if (w.startsWith("-") && w.length > 1) {
      const letters = w.slice(1);
      if (
        wrapper.lookupOnly !== undefined &&
        [...letters].some((l) => wrapper.lookupOnly?.includes(l))
      ) {
        return undefined;
      }
      let skip = 1;
      for (let x = 0; x < letters.length; x++) {
        if ((wrapper.shortWithValue ?? "").includes(letters.charAt(x))) {
          const glued = letters.slice(x + 1);
          const valueWord = glued !== "" ? glued : words[j + 1];
          if (letters.charAt(x) === "S" && programName(words[k] as string) === "env") {
            line = valueWord;
          }
          if (glued === "") skip = 2;
          break;
        }
      }
      j += skip;
      continue;
    }
    break;
  }
  j += wrapper.operands ?? 0;
  if (line !== undefined) return { at: j, line };
  return j < words.length ? { at: j } : undefined;
}

/**
 * The line a shell at `k` runs with `-c`, when it is one: `sh -c 'a; b'`,
 * `bash -lc …`, `bash -o pipefail -c …`.
 */
function shellScriptAt(words: ReadonlyArray<string>, k: number): string | undefined {
  if (!SHELLS.has(programName(words[k] as string))) return undefined;
  let hasC = false;
  let j = k + 1;
  while (j < words.length) {
    const w = words[j] as string;
    if (w === "--" || w === "-") {
      j++;
      break;
    }
    if (w.startsWith("--")) {
      j += w === "--rcfile" || w === "--init-file" ? 2 : 1;
      continue;
    }
    if ((w.startsWith("-") || w.startsWith("+")) && w.length > 1) {
      const letters = w.slice(1);
      if (w.startsWith("-") && letters.includes("c")) hasC = true;
      j += /[oO]$/.test(letters) ? 2 : 1;
      continue;
    }
    break;
  }
  return hasC && j < words.length ? (words[j] as string) : undefined;
}

/**
 * Follow the wrappers of the command whose program is `values[first]`: the
 * index each wrapped command starts at, and the lines an `eval`, an `env -S`
 * or a shell's `-c` at the end of the chain runs.
 */
function followWrappers(
  values: ReadonlyArray<string>,
  first: number,
): { readonly starts: number[]; readonly lines: string[] } {
  const starts: number[] = [];
  const lines: string[] = [];
  let k = first;
  for (let hops = 0; hops < 16 && k < values.length; hops++) {
    const script = shellScriptAt(values, k);
    if (script !== undefined) {
      lines.push(script);
      break;
    }
    if (programName(values[k] as string) === "eval") {
      if (k + 1 < values.length) lines.push(values.slice(k + 1).join(" "));
      break;
    }
    const inner = unwrap(values, k);
    if (inner === undefined) break;
    if (inner.line !== undefined) {
      lines.push([inner.line, ...values.slice(inner.at)].join(" "));
      break;
    }
    k = inner.at;
    starts.push(k);
  }
  return { starts, lines };
}

/**
 * The lines an argv runs through a shell, an `eval` or an `env -S`, after
 * any wrappers — `["sh", "-c", "a && b"]` runs `a && b`. For a tool that
 * spawns an argv with no shell of its own (RunCommand): the program it
 * names may be one, and a deny or ask then reads the line it runs.
 */
export function linesRunBy(words: ReadonlyArray<string>): string[] {
  return followWrappers(words, 0).lines;
}

/** How a deny or ask reads a shell line, beyond the line itself. */
export type ShellRestrictReading = {
  /**
   * Each simple command as written, from its program on, and with its
   * quoting taken off; with the variables the line itself sets to plain text
   * put in (`x=rm; $x -rf build` is `rm -rf build`) and bash's brace lists
   * spread (`{rm,-rf,build}`); the command each wrapper runs; and, read the
   * same way, the lines an `eval`, an `env -S`, a shell's `-c` or a
   * substitution runs — {@link MAX_SHELL_NESTING} levels deep. Both readings
   * of a line with a `$'…'` string.
   */
  readonly spellings: ReadonlyArray<string>;
  /**
   * Why the program one of its commands runs cannot be told from the text,
   * when it cannot: a program named by a command substitution, by a pathname
   * pattern (`/bin/r?`), by a variable the line sets from something it
   * cannot read (`read`, `set --`, `for`, `$(…)`), or split on an `IFS` the
   * line sets; or a line whose variables expand past what is read. Every
   * deny or ask then fires, as for a command whose environment is too large
   * to read.
   */
  readonly unknownProgram?: string;
  /**
   * A program named by a variable the line itself sets, to text this reader
   * could put in (`x=rm; $x -rf build`), when one is. A deny reads it with
   * the text put in; no scoped allow grants it, since the allow would be
   * matched against the variable's name and not the program.
   */
  readonly programSetByLine?: string;
};

/**
 * Read a shell line the way a deny or ask does: see
 * {@link ShellRestrictReading}.
 */
export function shellRestrictReading(
  line: string,
  work: ShellWork = { steps: 0 },
): ShellRestrictReading {
  const out = new Set<string>();
  const state: RestrictState = {
    work,
    unknown: undefined,
    setByLine: undefined,
    budget: Math.max(EXPANSION_BUDGET_CHARS, 4 * line.length),
  };
  collectRestrictSpellings(line, 0, out, work, new Map(), state);
  out.delete(line);
  out.delete("");
  const spellings = [...out];
  return {
    spellings,
    ...(state.unknown !== undefined ? { unknownProgram: state.unknown } : {}),
    ...(state.setByLine !== undefined ? { programSetByLine: state.setByLine } : {}),
  };
}

/** The spellings alone; see {@link shellRestrictReading}. */
export function shellRestrictSpellings(line: string, work: ShellWork = { steps: 0 }): string[] {
  return [...shellRestrictReading(line, work).spellings];
}

/**
 * How many characters the variables of one line may expand to, at least,
 * before the line is read as running an unknown program: a few variables
 * used many times would otherwise multiply the text a deny reads.
 */
const EXPANSION_BUDGET_CHARS = 65_536;

type RestrictState = {
  unknown: string | undefined;
  setByLine: string | undefined;
  budget: number;
  readonly work: ShellWork;
};

/**
 * What the line has set each variable to so far: its text, or `null` when
 * that cannot be read (`read x`, `x=$(…)`). `@` stands for the positional
 * parameters once `set` changes them.
 */
type Known = Map<string, string | null>;

/** `$name`, `${name}`, and the special parameters, as they appear in a word. */
const VARIABLE_REFERENCE =
  /\$(?:\{([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])\}|([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-]))/g;

/** `${` followed by anything but a plain name and `}`: a default, a trim, a length. */
const PARAMETER_OPERATION = /\$\{(?![A-Za-z_][A-Za-z0-9_]*\}|[0-9@*#?$!-]\})/;

/**
 * `text` with each variable the line set to plain text put in. `unresolved`
 * when it refers to one the line set from something unreadable, or to a
 * positional parameter; a variable the line never set is the harness's
 * own, and is left as written.
 */
function substitute(
  text: string,
  known: Known,
  state: RestrictState,
): { readonly text: string; readonly unresolved: boolean } {
  if (!text.includes("$")) return { text, unresolved: false };
  let unresolved = false;
  const replaced = text.replace(VARIABLE_REFERENCE, (ref, braced?: string, bare?: string) => {
    const name = (braced ?? bare) as string;
    if (/^[0-9@*]$/.test(name)) {
      unresolved = true;
      return ref;
    }
    if (!known.has(name)) return ref;
    const value = known.get(name);
    if (value === null || value === undefined) {
      unresolved = true;
      return ref;
    }
    if (value.length > state.budget) {
      state.unknown ??= "a line whose variables expand past what is read";
      unresolved = true;
      return ref;
    }
    state.budget -= value.length;
    state.work.steps += value.length;
    return value;
  });
  return { text: replaced, unresolved };
}

/**
 * A word's source with its quoted parts and escapes taken out: what the
 * shell expands as a pattern. One pass; an unterminated quote runs to the
 * end.
 */
function unquotedParts(source: string): string {
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const c = source.charAt(i);
    if (c === "\\") {
      i++;
    } else if (c === "'") {
      const close = source.indexOf("'", i + 1);
      i = close === -1 ? source.length : close;
    } else if (c === '"') {
      let j = i + 1;
      while (j < source.length && source.charAt(j) !== '"') j += source.charAt(j) === "\\" ? 2 : 1;
      i = j;
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * Bash spreads an unquoted `pre{a,b}post` into `prea preb`. One list, not
 * nested; anything else is left as written. Found by position, not by a
 * pattern, so a long word of commas costs its length.
 */
function braceSpread(token: Token, value: string): string[] {
  if (token.quoted) return [value];
  const open = value.indexOf("{");
  if (open === -1) return [value];
  const close = value.indexOf("}", open + 1);
  if (close === -1) return [value];
  if (value.indexOf("{", open + 1) !== -1 || value.indexOf("}", close + 1) !== -1) return [value];
  const items = value.slice(open + 1, close);
  if (!items.includes(",")) return [value];
  const pre = value.slice(0, open);
  const post = value.slice(close + 1);
  return items.split(",").map((item) => `${pre}${item}${post}`);
}

/** Builtins whose arguments set variables: how each one names them. */
function recordBuiltin(
  values: ReadonlyArray<string>,
  k: number,
  known: Known,
  state: RestrictState,
): void {
  const program = programName(values[k] as string);
  const args = values.slice(k + 1);
  const unknown = (name: string): void => {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) known.set(name, null);
  };
  switch (program) {
    case "export":
    case "readonly":
    case "declare":
    case "typeset":
    case "local":
      for (const arg of args) {
        const eq = arg.indexOf("=");
        if (arg.startsWith("-") || eq <= 0) continue;
        recordAssignment(
          arg.slice(0, eq),
          arg.slice(eq + 1),
          arg.includes("$(") || arg.includes("`"),
          known,
          state,
        );
      }
      return;
    case "read":
    case "mapfile":
    case "readarray":
      // Every operand is a name the command fills from its input.
      for (const arg of args) if (!arg.startsWith("-")) unknown(arg);
      if (program !== "read") known.set("MAPFILE", null);
      else known.set("REPLY", null);
      return;
    case "printf": {
      const v = args.indexOf("-v");
      if (v !== -1 && args[v + 1] !== undefined) unknown(args[v + 1] as string);
      return;
    }
    case "getopts":
      if (args[1] !== undefined) unknown(args[1]);
      return;
    case "set":
      if (args.some((a) => a === "--" || !/^[-+]/.test(a))) known.set("@", null);
      return;
    case "unset":
      for (const arg of args) if (!arg.startsWith("-")) known.delete(arg);
      return;
    case "for":
    case "select":
      if (args[0] !== undefined) unknown(args[0]);
      return;
    default:
      return;
  }
}

/** Record `name=value` (its unquoted value): plain text, or `null` when it cannot be read. */
function recordAssignment(
  name: string,
  value: string,
  substituted: boolean,
  known: Known,
  state: RestrictState,
): void {
  if (name.endsWith("+")) {
    known.set(name.slice(0, -1), null);
    return;
  }
  const bare = name.replace(/\[.*$/, "");
  if (substituted || PARAMETER_OPERATION.test(value)) {
    known.set(bare, null);
    return;
  }
  const read = substitute(value, known, state);
  known.set(bare, read.unresolved ? null : read.text);
}

/** Why the program a command runs, at `k`, cannot be told from its text, if it cannot. */
function unknownProgram(
  line: string,
  token: Token | undefined,
  value: string,
  unresolved: boolean,
  known: Known,
): string | undefined {
  const source = token !== undefined ? line.slice(token.start, token.end) : value;
  if (source.includes("$(") || source.includes("`")) {
    return "a program named by a command substitution";
  }
  if (unresolved) {
    return "a program named by a variable the line sets from something it cannot read";
  }
  if (PARAMETER_OPERATION.test(source)) {
    return "a program named by a parameter expansion with a default, a trim or a length";
  }
  if (known.has("IFS") && source.includes("$")) {
    return "a program named by a variable split on an IFS the line sets";
  }
  if (namesPathnamePattern(source)) return "a program named by a pathname pattern";
  return undefined;
}

/**
 * Whether a word is a pathname pattern the shell expands: an unquoted `*`
 * or `?`, or an unquoted `[` that a `]` closes. A `[` with nothing to close
 * it is a plain character, so `[` (test) and `[[` (bash's reserved word)
 * name themselves. Any `]` in the word counts as the close, quoted or not:
 * reading a word as a pattern when it is not only makes a deny fire.
 */
function namesPathnamePattern(source: string): boolean {
  const unquoted = unquotedParts(source);
  if (unquoted.includes("*") || unquoted.includes("?")) return true;
  return unquoted.includes("[") && source.includes("]");
}

function collectRestrictSpellings(
  line: string,
  level: number,
  out: Set<string>,
  work: ShellWork,
  inherited: Known,
  state: RestrictState,
): void {
  const scans = line.includes("$'")
    ? [scan(line, false, work), scan(line, true, work)]
    : [scan(line, false, work)];
  const nested: Array<readonly [string, Known]> = [];
  for (const scanned of scans) {
    const known: Known = new Map(inherited);
    for (const { tokens } of scanned.commands) {
      out.add(spanOf(line, tokens));
      // From the program on: the variables it sets and the redirections it
      // opens first do not change which program runs.
      const words = tokens.filter((t) => !t.redirect);
      // An assignment's name is unquoted; its value may be quoted (`A="a b"`).
      let first = 0;
      while (first < words.length) {
        const w = words[first] as Token;
        if (!ASSIGNMENT.test(line.slice(w.start, w.end))) break;
        first++;
      }
      if (first >= words.length) {
        // Only assignments: they stay set for the commands after it.
        for (const w of words) {
          const source = line.slice(w.start, w.end);
          const eq = w.value.indexOf("=");
          recordAssignment(
            w.value.slice(0, eq),
            w.value.slice(eq + 1),
            source.includes("$(") || source.includes("`"),
            known,
            state,
          );
        }
        continue;
      }
      const end = (tokens[tokens.length - 1] as Token).end;
      const readings = words.map((t) => substitute(t.value, known, state));
      const values = readings.map((r) => r.text);
      const followed = followWrappers(values, first);
      const program = followed.starts.at(-1) ?? first;
      const why = unknownProgram(
        line,
        words[program],
        values[program] as string,
        (readings[program] as { unresolved: boolean }).unresolved,
        known,
      );
      if (why !== undefined) state.unknown ??= why;
      else if (values[program] !== (words[program] as Token).value) {
        state.setByLine ??= "a program named by a variable the line sets";
      }
      for (const from of [first, ...followed.starts]) {
        out.add(line.slice((words[from] as Token).start, end).trim());
        out.add(values.slice(from).join(" "));
      }
      for (const inner of followed.lines) nested.push([inner, known]);
      // Bash's brace lists, spread, and read the same way.
      const spread = words
        .slice(first)
        .flatMap((t, i) => braceSpread(t, values[first + i] as string));
      if (spread.length !== words.length - first) {
        const again = followWrappers(spread, 0);
        for (const from of [0, ...again.starts]) out.add(spread.slice(from).join(" "));
        for (const inner of again.lines) nested.push([inner, known]);
      }
      recordBuiltin(values, program, known, state);
    }
    for (const inner of scanned.nested) nested.push([inner, known]);
  }
  if (level + 1 >= MAX_SHELL_NESTING) return;
  const seen = new Set<string>();
  for (const [inner, known] of nested) {
    if (seen.has(inner)) continue;
    seen.add(inner);
    out.add(inner.trim());
    collectRestrictSpellings(inner, level + 1, out, work, known, state);
  }
}
