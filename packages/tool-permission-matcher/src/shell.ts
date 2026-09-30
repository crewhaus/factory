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
 * the whole line, as before.
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
 * quoting taken off (`"r"m -rf x` runs `rm`), the command a wrapper runs
 * (`env`, `command`, `exec`, `builtin`, `nohup`, `time`, `nice`, `timeout`,
 * `sudo`, `doas`, `xargs`, `setsid`, `stdbuf`, `busybox`), and the line an
 * `eval`, an `env -S` or a shell's `-c` runs, read the same way. A program
 * that runs another from its own arguments in some other way (`find -exec`,
 * `git -c alias.x=!…`, `make`) is not read: an allow list is the way to be
 * sure of those.
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

/**
 * Every spelling of a shell line a deny or ask reads, beyond the line
 * itself: each simple command as written, from its program on, and with
 * its quoting taken off; the command each wrapper runs; and, read the same
 * way, the lines an `eval`, an `env -S`, a shell's `-c` or a substitution
 * runs — {@link MAX_SHELL_NESTING} levels deep. Both readings of a line
 * with a `$'…'` string.
 */
export function shellRestrictSpellings(line: string, work: ShellWork = { steps: 0 }): string[] {
  const out = new Set<string>();
  collectRestrictSpellings(line, 0, out, work);
  out.delete(line);
  out.delete("");
  return [...out];
}

function collectRestrictSpellings(
  line: string,
  level: number,
  out: Set<string>,
  work: ShellWork,
): void {
  const scans = line.includes("$'")
    ? [scan(line, false, work), scan(line, true, work)]
    : [scan(line, false, work)];
  const nested: string[] = [];
  for (const scanned of scans) {
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
      if (first >= words.length) continue;
      const end = (tokens[tokens.length - 1] as Token).end;
      const values = words.map((t) => t.value);
      const followed = followWrappers(values, first);
      for (const from of [first, ...followed.starts]) {
        out.add(line.slice((words[from] as Token).start, end).trim());
        out.add(values.slice(from).join(" "));
      }
      nested.push(...followed.lines);
    }
    nested.push(...scanned.nested);
  }
  if (level + 1 >= MAX_SHELL_NESTING) return;
  for (const inner of new Set(nested)) {
    out.add(inner.trim());
    collectRestrictSpellings(inner, level + 1, out, work);
  }
}
