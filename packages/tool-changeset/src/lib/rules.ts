/**
 * The change-set policy rules, as pure functions over an already-parsed diff.
 *
 * Two decisions shape everything here.
 *
 * The first is that a rule only ever sees an ADDED line. A change set is not
 * a codebase: nobody wants a review that reports the `console.log` somebody
 * else left behind three years ago, and a linter that does it once gets
 * turned off. The rules run on `kind === "added"` and on nothing else.
 *
 * The second is that every finding carries `line`, the line number in the NEW
 * file, straight from `parseUnifiedDiff`. That number is the product: it is
 * what lets a caller fix a finding without re-reading the file. Nothing in
 * this module counts lines itself — the parser already did, and a second
 * counter would be a second chance to be off by one.
 *
 * A rule sees one line, without the file around it. That is a real limit and
 * it is the reason the rules here are anchored tightly and lean toward
 * silence: `console.log` inside a multi-line string literal reads exactly
 * like a call, and no amount of regex fixes that without the whole file.
 */
import type { ParsedDiff, ParsedDiffFile } from "@crewhaus/tool-text";

export type Severity = "error" | "warning";

/**
 * Every rule, in the order findings are reported within one line.
 *
 * The ids are the caller's vocabulary — `enable`, `disable` and every finding
 * name one — so they are a closed set, and an id that is not in it is refused
 * rather than ignored. A typo that silently disables nothing is how a team
 * ends up believing a rule is off for a year.
 */
export const RULE_IDS = [
  "conflictMarker",
  "debugger",
  "focusedTest",
  "consoleLog",
  "suppression",
  "ticketlessTodo",
  "machinePath",
  "crlf",
  "longLine",
  "oversizedFile",
  "commentedCode",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

const RULE_SET: ReadonlySet<string> = new Set(RULE_IDS);

/**
 * Rules that are OFF unless the caller asks for them.
 *
 * `commentedCode` is a heuristic with a genuine false-positive rate (see
 * `looksLikeCommentedCode`), and a heuristic that fires on prose is how the
 * whole tool gets disabled. It ships opt-in and at warning severity.
 */
export const OPT_IN_RULES: ReadonlyArray<RuleId> = Object.freeze(["commentedCode"]);

/** Default severity per rule; a few rules pick per finding (see `machinePath`). */
const DEFAULT_SEVERITY: Readonly<Record<RuleId, Severity>> = {
  conflictMarker: "error",
  debugger: "error",
  focusedTest: "error",
  consoleLog: "warning",
  suppression: "warning",
  ticketlessTodo: "warning",
  machinePath: "warning",
  crlf: "warning",
  longLine: "warning",
  oversizedFile: "warning",
  commentedCode: "warning",
};

export type Finding = {
  readonly rule: RuleId;
  readonly severity: Severity;
  /** Path in the new tree, as the diff spells it. */
  readonly file: string;
  /** 1-based line in the NEW file; null only on a whole-file finding. */
  readonly line: number | null;
  readonly message: string;
  /** The offending line, trimmed and capped — enough to recognise, not to quote. */
  readonly snippet: string;
};

export type SkippedFile = {
  readonly file: string;
  readonly why: string;
};

export type LintResult = {
  readonly findings: ReadonlyArray<Finding>;
  readonly filesScanned: number;
  readonly addedLinesScanned: number;
  /** Counts over EVERY finding, including any dropped by `maxFindings`. */
  readonly counts: {
    readonly byRule: Readonly<Record<string, number>>;
    readonly bySeverity: Readonly<Record<Severity, number>>;
  };
  readonly skipped: ReadonlyArray<SkippedFile>;
  /** True when `maxFindings` cut the list; the counts above are still whole. */
  readonly truncated: boolean;
};

export type LintOptions = {
  /** Turn opt-in rules on. */
  readonly enable?: ReadonlyArray<RuleId>;
  /** Turn default rules off. */
  readonly disable?: ReadonlyArray<RuleId>;
  /** What counts as a ticket reference on a TODO. */
  readonly ticketPattern?: RegExp;
  /** Extra machine-specific path shapes, on top of the built-in ones. */
  readonly machinePathPatterns?: ReadonlyArray<RegExp>;
  /** An added line longer than this is reported once; default 500. */
  readonly maxLineChars?: number;
  /** A file adding more lines than this is reported once; default 800. */
  readonly maxAddedLinesPerFile?: number;
  /** Hard cap on returned findings; default 500. */
  readonly maxFindings?: number;
};

const DEFAULT_TICKET = /(?:\b[A-Z][A-Z0-9]{1,9}-\d+\b|#\d+|https?:\/\/\S+)/;
const DEFAULT_MAX_LINE_CHARS = 1_000;
const DEFAULT_MAX_ADDED_LINES = 800;
const DEFAULT_MAX_FINDINGS = 500;
const SNIPPET_CHARS = 160;

/** Ids in `ids` that are not rules — returned so a caller can refuse by name. */
export function unknownRuleIds(ids: ReadonlyArray<string>): string[] {
  return ids.filter((id) => !RULE_SET.has(id));
}

/** The rules that will actually run, after the opt-in list and the caller's edits. */
export function activeRules(options: LintOptions = {}): ReadonlySet<RuleId> {
  const optIn = new Set<string>(OPT_IN_RULES);
  const active = new Set<RuleId>(RULE_IDS.filter((id) => !optIn.has(id)));
  for (const id of options.enable ?? []) active.add(id);
  for (const id of options.disable ?? []) active.delete(id);
  return active;
}

// ---------------------------------------------------------------------------
// languages
//
// A rule that does not apply to a file's language must not run on it: there
// is no `debugger` statement in Python, and `#` starts a comment there and a
// preprocessor directive in C. Extension is a weak signal, but it is the only
// one a diff carries — the file's contents are not here.

export type Lang =
  | "js"
  | "python"
  | "go"
  | "rust"
  | "jvm"
  | "c"
  | "ruby"
  | "php"
  | "shell"
  | "sql"
  | "config"
  | "markdown"
  | "other";

const EXT_LANG: Readonly<Record<string, Lang>> = {
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  svelte: "js",
  vue: "js",
  py: "python",
  pyi: "python",
  go: "go",
  rs: "rust",
  java: "jvm",
  kt: "jvm",
  kts: "jvm",
  scala: "jvm",
  groovy: "jvm",
  c: "c",
  h: "c",
  cc: "c",
  cpp: "c",
  hpp: "c",
  cs: "c",
  m: "c",
  swift: "c",
  rb: "ruby",
  php: "php",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  sql: "sql",
  json: "config",
  jsonc: "config",
  yaml: "config",
  yml: "config",
  toml: "config",
  ini: "config",
  cfg: "config",
  conf: "config",
  env: "config",
  properties: "config",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
};

export function languageOf(path: string): Lang {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "other";
  return EXT_LANG[base.slice(dot + 1).toLowerCase()] ?? "other";
}

/** Comment openers, per language, for the comment-aware rules. */
const COMMENT_PREFIXES: Readonly<Record<Lang, ReadonlyArray<string>>> = {
  js: ["//", "/*", "*/", "*"],
  go: ["//", "/*", "*/", "*"],
  rust: ["//", "/*", "*/", "*"],
  jvm: ["//", "/*", "*/", "*"],
  c: ["//", "/*", "*/", "*"],
  php: ["//", "#", "/*", "*/", "*"],
  python: ["#"],
  ruby: ["#"],
  shell: ["#"],
  sql: ["--"],
  config: ["#"],
  markdown: [],
  other: [],
};

/** True when the whole line is a comment — not merely when one trails the code. */
export function isCommentLine(text: string, lang: Lang): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  return COMMENT_PREFIXES[lang].some((prefix) => trimmed.startsWith(prefix));
}

/** The comment's body: what is left after its opener. */
function commentBody(text: string, lang: Lang): string | undefined {
  const trimmed = text.trim();
  for (const prefix of COMMENT_PREFIXES[lang]) {
    if (!trimmed.startsWith(prefix)) continue;
    // `///` and `//!` are doc comments; `#!` is a shebang, not a note.
    return trimmed
      .slice(prefix.length)
      .replace(/^[/!]+/, "")
      .trim();
  }
  return undefined;
}

/** Openers that begin a comment mid-line, as opposed to continuing one. */
const COMMENT_OPENERS: Readonly<Record<Lang, ReadonlyArray<string>>> = {
  js: ["//", "/*"],
  go: ["//", "/*"],
  rust: ["//", "/*"],
  jvm: ["//", "/*"],
  c: ["//", "/*"],
  php: ["//", "/*", "#"],
  python: ["#"],
  ruby: ["#"],
  shell: ["#"],
  sql: ["--"],
  config: ["#"],
  markdown: ["<!--"],
  other: [],
};

/**
 * Where the comment on this line starts, if one does.
 *
 * This is the closest a diff gets to knowing code from commentary. With the
 * whole file in hand the honest move is a mask (`@crewhaus/tool-code`'s
 * `maskSource` does exactly that, which is how `TodoScan` avoids string
 * literals); with one line in hand, the position of the first opener is what
 * there is. It is wrong in one direction — an opener inside a string literal
 * reads as a comment — and that direction is silence, which is the one to be
 * wrong in.
 */
function commentStart(text: string, lang: Lang): number | undefined {
  if (isCommentLine(text, lang)) return text.length - text.trimStart().length;
  let best: number | undefined;
  for (const opener of COMMENT_OPENERS[lang]) {
    const at = text.indexOf(opener);
    if (at !== -1 && (best === undefined || at < best)) best = at;
  }
  return best;
}

/** True when `index` falls inside this line's comment. */
function inComment(start: number | undefined, index: number): boolean {
  return start !== undefined && start <= index;
}

// ---------------------------------------------------------------------------
// the rules themselves

/** `it.only`, `describe.only`, `fit`, `fdescribe` — a test run that silently covers one case. */
const FOCUSED_TEST = /(?:\.only\s*(?:\(|\.\s*each\b)|\b(?:fdescribe|fit|fcontext)\s*\()/;
/** A bare `debugger` statement, not the word inside an identifier or a string of prose. */
const DEBUGGER = /(?:^|[\s;{}()])debugger\s*(?:;|$)/;
/** The console calls that are output, not diagnostics: `error` and `warn` are left alone. */
const CONSOLE_LOG = /\bconsole\s*\.\s*(?:log|debug|dir|trace)\s*\(/;
/** Merge leftovers. `<<<<<<<` and `|||||||` are unmistakable; `=======` is not — see below. */
const CONFLICT_STRONG = /^(?:<{7}|>{7}|\|{7})(?:\s|$)/;
const CONFLICT_WEAK = /^={7}\s*$/;
const TODO_MARKER = /\b(TODO|FIXME|HACK|XXX)\b/;

/**
 * Suppressions worth reporting when they are NEW.
 *
 * `@ts-expect-error` is deliberately absent: it fails once the error it
 * covers is gone, which is the behaviour we want people to reach for.
 * `biome-ignore` is absent for the same kind of reason — its syntax already
 * requires a stated reason, so flagging it would be noise in this repository
 * and every other one that uses biome.
 */
const SUPPRESSIONS: ReadonlyArray<{ re: RegExp; what: string; advice: string }> = [
  {
    re: /@ts-ignore\b/,
    what: "@ts-ignore",
    advice: "use @ts-expect-error, which fails when the error it covers goes away",
  },
  {
    re: /@ts-nocheck\b/,
    what: "@ts-nocheck",
    advice: "it turns off type checking for the whole file",
  },
  {
    re: /\beslint-disable(?:-next-line|-line)?\b/,
    what: "an eslint-disable",
    advice: "name the rule and say why, or fix the finding",
  },
  {
    re: /#\s*type:\s*ignore\b/,
    what: "a type: ignore",
    advice: "narrow it to the specific error code, or fix the annotation",
  },
];

/**
 * Machine-specific absolute paths — the ones that work on the author's laptop
 * and nowhere else.
 *
 * A home directory carries a username and is always wrong in a repository, so
 * it is an error. A temp directory is usually a fixture that should have been
 * built with `mkdtemp`, but it is occasionally a legitimate platform path, so
 * it is a warning.
 */
const MACHINE_PATHS: ReadonlyArray<{ re: RegExp; severity: Severity; what: string }> = [
  {
    re: /(?:^|[^\w\\])(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+\//,
    severity: "error",
    what: "a home directory",
  },
  {
    re: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/,
    severity: "error",
    what: "a Windows home directory",
  },
  {
    re: /(?:\/private)?\/var\/folders\/[A-Za-z0-9_+-]/,
    severity: "warning",
    what: "a macOS temporary directory",
  },
  {
    re: /(?:^|[^\w])\/private\/tmp\//,
    severity: "warning",
    what: "a temporary directory",
  },
];

/** Keywords that open a statement, for the commented-out-code heuristic. */
const CODE_KEYWORD =
  /^(?:const|let|var|function|class|import|export|return|if|else|elif|for|while|switch|case|def|fn|pub|func|package|public|private|protected|static|async|await|new|throw|try|catch|finally|use|impl|struct|enum|type|interface|print|println!?|echo)\b/;
/** An assignment or a bare call, the two shapes most commented-out code has. */
const CODE_ASSIGN = /^[\w$][\w$.[\]"']*\s*(?:[-+*/|&^]?=[^=]|:=)/;
const CODE_CALL = /^[\w$][\w$.]*\s*\(.*\)\s*[;,]?$/;
/** Languages where the heuristic runs at all: prose-heavy and config files are excluded. */
const COMMENTED_CODE_LANGS: ReadonlySet<Lang> = new Set<Lang>([
  "js",
  "go",
  "rust",
  "jvm",
  "c",
  "php",
  "python",
  "ruby",
]);

/**
 * Does this comment look like code somebody commented out rather than a note
 * somebody wrote?
 *
 * This is the one rule here that guesses, so it guesses toward silence. A
 * body qualifies only on a positive code signal — a statement keyword, an
 * assignment, a bare call, or a line ending in `;`/`{`/`}` — and a body that
 * reads like a sentence vetoes all of them. The prose veto is a word count
 * rather than a word list because a comment in German is still prose:
 * five or more plain alphabetic words in a row is writing, not code.
 *
 * What still gets through: a short imperative comment that ends in a brace or
 * names a function, `// see runTests()` most of all. That is why the rule is
 * opt-in and warns rather than errors.
 */
export function looksLikeCommentedCode(body: string): boolean {
  if (body.length < 4) return false;
  if (TODO_MARKER.test(body)) return false; // the ticketlessTodo rule's business
  if (/^[-*=_#]{3,}$/.test(body)) return false; // a section rule, not code
  if (/^(?:https?:|www\.)/.test(body)) return false;
  const words = body.split(/\s+/).filter((w) => /^[A-Za-z']+$/.test(w));
  if (words.length >= 5) return false;
  if (CODE_KEYWORD.test(body)) return /[(={:]/.test(body) || body.endsWith(";");
  if (CODE_ASSIGN.test(body)) return true;
  if (CODE_CALL.test(body)) return true;
  return /[;{}]$/.test(body) && /[\w$)\]]/.test(body);
}

// ---------------------------------------------------------------------------
// the engine

const snippet = (text: string): string => {
  const trimmed = text.replace(/\r$/, "").trim();
  return trimmed.length > SNIPPET_CHARS ? `${trimmed.slice(0, SNIPPET_CHARS)}…` : trimmed;
};

type Hit = { rule: RuleId; message: string; severity?: Severity };

/**
 * Should this file be looked at at all, and if not, why not.
 *
 * Only a binary stanza is refused: there is no text in it to lint, and the
 * base85 payload of a `GIT binary patch` would read as content. A deletion, a
 * pure rename and a mode change carry no added lines, so they cost nothing
 * and are not worth reporting as skipped.
 *
 * A rename WITH edits IS scanned, which is a deliberate departure from the
 * obvious "skip renames" rule: git reports a move-plus-edit as a rename whose
 * hunks contain only the lines that really changed, and those lines are new
 * code. Skipping them would make a `debugger` added while moving a file the
 * one finding a review never sees.
 */
function skipReason(file: ParsedDiffFile): string | undefined {
  return file.binary ? "binary file — no text to lint" : undefined;
}

function lineHits(
  text: string,
  lang: Lang,
  active: ReadonlySet<RuleId>,
  opts: LintOptions,
  fileHasStrongConflict: boolean,
): Hit[] {
  const hits: Hit[] = [];
  const comment = commentStart(text, lang);
  const maxLineChars = opts.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;

  if (active.has("conflictMarker")) {
    // `=======` is a markdown heading underline, a section divider and half
    // the ASCII art in the world, so it only counts as a conflict marker in a
    // file that also gained an unmistakable one.
    if (CONFLICT_STRONG.test(text) || (fileHasStrongConflict && CONFLICT_WEAK.test(text))) {
      hits.push({
        rule: "conflictMarker",
        message: "a merge conflict marker was committed — resolve the conflict and remove it",
      });
    }
  }

  if (lang === "js") {
    // Each of these is a STATEMENT, so anything from the comment opener
    // rightwards cannot be one. That covers the trailing `// debugger;` and,
    // usefully, the `"// debugger;"` in a test fixture: a line-local rule
    // cannot tell a string from code, and this is the reading that stays
    // quiet rather than the one that cries wolf.
    const statement = (re: RegExp): boolean => {
      const m = re.exec(text);
      return m !== null && !inComment(comment, m.index);
    };
    if (active.has("debugger") && statement(DEBUGGER)) {
      hits.push({
        rule: "debugger",
        message: "a `debugger` statement stops every browser that runs it",
      });
    }
    if (active.has("focusedTest") && statement(FOCUSED_TEST)) {
      hits.push({
        rule: "focusedTest",
        message:
          "a focused test (`.only` / `fit` / `fdescribe`) makes the suite pass while running almost nothing",
      });
    }
    if (active.has("consoleLog") && statement(CONSOLE_LOG)) {
      hits.push({
        rule: "consoleLog",
        message: "a console.log/debug/dir/trace call — use the logger, or delete it",
      });
    }
  }

  if (active.has("suppression")) {
    for (const suppression of SUPPRESSIONS) {
      const match = suppression.re.exec(text);
      // A suppression directive only does anything inside a comment. The word
      // in a rule table, a string or a test name is talk ABOUT one.
      if (match === null || !inComment(comment, match.index)) continue;
      hits.push({
        rule: "suppression",
        message: `${suppression.what} was added — ${suppression.advice}`,
      });
    }
  }

  if (active.has("ticketlessTodo")) {
    const marker = TODO_MARKER.exec(text);
    // The marker must OPEN the comment: `// TODO: x` is a note to a
    // maintainer, and "a TODO with no ticket" in the middle of a sentence is
    // prose about todos. With the whole file a mask would decide this; with
    // one line, where the marker sits is the signal there is.
    if (marker !== null && inComment(comment, marker.index)) {
      const between = text.slice(comment ?? 0, marker.index);
      if (/^(?:\/\/+|\/\*+|#+|\*+|--|<!--)?[\s\-*>]*$/.test(between)) {
        const body = text.slice(marker.index).replace(/\*\/\s*$/, "");
        const ticket = opts.ticketPattern ?? DEFAULT_TICKET;
        if (!ticket.test(body)) {
          hits.push({
            rule: "ticketlessTodo",
            message:
              "a TODO/FIXME/HACK with no ticket or issue reference — nobody will ever find it",
          });
        }
      }
    }
  }

  if (active.has("machinePath")) {
    for (const pattern of MACHINE_PATHS) {
      if (!pattern.re.test(text)) continue;
      hits.push({
        rule: "machinePath",
        severity: pattern.severity,
        message: `${pattern.what} is hard-coded here — it resolves on one machine and nowhere else`,
      });
      break; // one path finding per line is enough to act on
    }
    for (const extra of opts.machinePathPatterns ?? []) {
      if (!extra.test(text)) continue;
      hits.push({
        rule: "machinePath",
        message: `matches the operator's machine-path pattern /${extra.source}/`,
      });
      break;
    }
  }

  if (active.has("longLine") && text.replace(/\r$/, "").length > maxLineChars) {
    hits.push({
      rule: "longLine",
      message: `an added line of ${text.replace(/\r$/, "").length} characters (over ${maxLineChars}) — usually generated, minified or vendored content`,
    });
  }

  if (active.has("commentedCode") && COMMENTED_CODE_LANGS.has(lang) && isCommentLine(text, lang)) {
    const body = commentBody(text, lang);
    if (body !== undefined && looksLikeCommentedCode(body)) {
      hits.push({
        rule: "commentedCode",
        message:
          "this comment looks like commented-out code — delete it, the history keeps it (heuristic: prose that reads like code is reported too)",
      });
    }
  }

  return hits;
}

/**
 * Run the policy over a parsed diff.
 *
 * Findings come back in diff order and then line order, which is stable for a
 * stable diff — this is a deterministic tool and two runs over the same patch
 * return the same bytes.
 */
export function lintParsedDiff(parsed: ParsedDiff, options: LintOptions = {}): LintResult {
  const active = activeRules(options);
  const maxFindings = options.maxFindings ?? DEFAULT_MAX_FINDINGS;
  const maxAdded = options.maxAddedLinesPerFile ?? DEFAULT_MAX_ADDED_LINES;
  const findings: Finding[] = [];
  const byRule: Record<string, number> = {};
  const bySeverity: Record<Severity, number> = { error: 0, warning: 0 };
  const skipped: SkippedFile[] = [];
  let filesScanned = 0;
  let addedLinesScanned = 0;
  let total = 0;

  const record = (finding: Finding): void => {
    total++;
    byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1;
    bySeverity[finding.severity]++;
    if (findings.length < maxFindings) findings.push(finding);
  };

  for (const file of parsed.files) {
    const path = file.newPath ?? file.oldPath ?? "(unknown path)";
    const why = skipReason(file);
    if (why !== undefined) {
      skipped.push({ file: path, why });
      continue;
    }
    if (file.hunks.length === 0) continue;
    filesScanned++;
    const lang = languageOf(path);

    // Two passes over the file's added lines: the first decides whether a
    // bare `=======` in this file can be a conflict marker at all.
    const added: Array<{ text: string; line: number }> = [];
    for (const hunk of file.hunks) {
      for (const parsedLine of hunk.lines) {
        if (parsedLine.kind !== "added" || parsedLine.newLine === null) continue;
        added.push({ text: parsedLine.text, line: parsedLine.newLine });
      }
    }
    addedLinesScanned += added.length;
    const strongConflict = added.some((l) => CONFLICT_STRONG.test(l.text));

    if (active.has("oversizedFile") && file.added > maxAdded) {
      record({
        rule: "oversizedFile",
        severity: DEFAULT_SEVERITY.oversizedFile,
        file: path,
        line: null,
        message: `${file.added} added lines in one file (over ${maxAdded}) — if it is generated or vendored, say so in the PR or ignore the path`,
        snippet: "",
      });
    }

    // CRLF is a property of the file, not of a line: reporting 400 of them
    // buries every other finding in the change set.
    let crlfSeen = 0;
    let crlfFirst = 0;

    for (const line of added) {
      if (line.text.endsWith("\r")) {
        crlfSeen++;
        if (crlfSeen === 1) crlfFirst = line.line;
      }
      for (const hit of lineHits(line.text, lang, active, options, strongConflict)) {
        record({
          rule: hit.rule,
          severity: hit.severity ?? DEFAULT_SEVERITY[hit.rule],
          file: path,
          line: line.line,
          message: hit.message,
          snippet: snippet(line.text),
        });
      }
    }

    if (active.has("crlf") && crlfSeen > 0) {
      record({
        rule: "crlf",
        severity: DEFAULT_SEVERITY.crlf,
        file: path,
        line: crlfFirst,
        message: `${crlfSeen} added line${crlfSeen === 1 ? "" : "s"} end${crlfSeen === 1 ? "s" : ""} with CRLF — normalise the line endings or set .gitattributes`,
        snippet: "",
      });
    }
  }

  return {
    findings,
    filesScanned,
    addedLinesScanned,
    counts: { byRule, bySeverity },
    skipped,
    truncated: total > findings.length,
  };
}
