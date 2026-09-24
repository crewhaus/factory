import { CrewhausError } from "@crewhaus/errors";

export class PatternParseError extends CrewhausError {
  override readonly name = "PatternParseError";
  constructor(message: string, cause?: unknown) {
    super("tool", message, cause);
  }
}

export type CompiledPattern = {
  readonly toolGlob: string;
  readonly argGlob: string | null;
  /** The compiled tool-name glob. Internal: use {@link matchesToolName}. */
  readonly _toolRe: GlobMatcher;
  /** The compiled argument glob, or null for a bare tool pattern. */
  readonly _argRe: GlobMatcher | null;
};

/**
 * The glob metacharacters the glob compiler treats specially — the ONLY characters
 * that widen a match beyond a literal (`*` = any run, `?` = one char). Every
 * other character (`. + ^ $ { } ( ) | [ ] \`) is regex-escaped and matched
 * literally. `\` is the escape lead-in: `\*`, `\?`, `\\` match the literal
 * character. Exported so callers that inject an observed literal value into a
 * pattern (e.g. permission-suggest) can neutralise widening via
 * `escapeGlobLiteral` and stay in sync with the grammar defined HERE.
 */
export const GLOB_METACHARS: readonly string[] = Object.freeze(["\\", "*", "?"]);

/**
 * Escape a raw string so it matches ONLY itself when spliced into a glob
 * pattern. Backslash-escapes every {@link GLOB_METACHARS} character (backslash
 * first, so we don't double-escape the escapes we add). Round-trips through
 * the glob compiler: `escapeGlobLiteral("a*b")` → `"a\\*b"` → matches only "a*b".
 */
export function escapeGlobLiteral(value: string): string {
  let out = "";
  for (const ch of value) {
    if (ch === "\\" || ch === "*" || ch === "?") out += `\\${ch}`;
    else out += ch;
  }
  return out;
}

/**
 * Where the tokenizer stands when it reads a `**`, which decides what the
 * `**` means at a path-segment boundary: `a/**` must also match `a`, and a
 * leading double-star segment must also match a bare `b`.
 *
 *   - `"start"` — nothing emitted yet, OR the previous token was a `**` group
 *     that already absorbed the separator after it, so a new path segment
 *     begins here.
 *   - `"sep"`   — the last token is the literal `/` of a glob `/`. A `**` in
 *     this position folds that separator into its own optional group.
 *   - `"other"` — anything else; a `**` here is mid-segment and just means
 *     "any run of characters".
 *
 * Tracking this explicitly (rather than guessing from what was emitted) is the
 * fix for issue #17: a bare `**` once compiled to something that matched only
 * the empty string or a string starting with `/`, so a catch-all `Bash(**)`
 * rule was dead.
 */
type GlobPos = "start" | "sep" | "other";

/**
 * One step of a compiled glob. The grammar is small, and every construct is
 * one of these:
 *
 *   - `lit`       — one literal UTF-16 code unit;
 *   - `qmark`     — `?`: one code unit that is not `/`;
 *   - `star`      — `*`: any run of code units without a `/`;
 *   - `any`       — `**` mid-segment: any run at all, newlines included;
 *   - `optPrefix` — a leading `**` + `/`: an optional "any run then `/`";
 *   - `mid`       — `/` + `**` + `/`: a `/`, optionally followed by
 *                   "any run then `/`";
 *   - `optSuffix` — a trailing `/` + `**`: an optional "`/` then any run".
 */
type GlobToken =
  | { readonly k: "lit"; readonly c: number }
  | { readonly k: "qmark" | "star" | "any" | "optPrefix" | "mid" | "optSuffix" };

const SLASH = 0x2f;

function tokenizeGlob(glob: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  let i = 0;
  let pos: GlobPos = "start";
  while (i < glob.length) {
    const ch = glob.charAt(i);
    if (ch === "\\" && i + 1 < glob.length) {
      // Escape lead-in: the next code unit is literal, never a metachar. Lets
      // `escapeGlobLiteral` emit `\*`/`\?`/`\\` that match the literal
      // character. An escaped `/` is still a separator, so a following `**`
      // folds it exactly as it would an unescaped one.
      const lit = glob.charCodeAt(i + 1);
      tokens.push({ k: "lit", c: lit });
      pos = lit === SLASH ? "sep" : "other";
      i += 2;
    } else if (ch === "*" && glob[i + 1] === "*") {
      const afterTwo = glob[i + 2];
      if (afterTwo === "/" && pos === "start") {
        tokens.push({ k: "optPrefix" });
        pos = "start";
        i += 3;
      } else if (afterTwo === "/" && pos === "sep") {
        tokens.pop(); // the `/` just emitted is part of this group
        tokens.push({ k: "mid" });
        pos = "start";
        i += 3;
      } else if (afterTwo === undefined && pos === "sep") {
        tokens.pop();
        tokens.push({ k: "optSuffix" });
        pos = "other";
        i += 2;
      } else {
        // A bare `**`, a `**` glued to a non-separator (`rm**`), or a
        // redundant `**` right after another `**` group: any run at all.
        tokens.push({ k: "any" });
        pos = "other";
        i += 2;
      }
    } else if (ch === "*") {
      tokens.push({ k: "star" });
      pos = "other";
      i++;
    } else if (ch === "?") {
      tokens.push({ k: "qmark" });
      pos = "other";
      i++;
    } else {
      tokens.push({ k: "lit", c: glob.charCodeAt(i) });
      pos = ch === "/" ? "sep" : "other";
      i++;
    }
  }
  return tokens;
}

/** A state of the glob automaton. Index 0 is always the accepting state. */
type GlobState =
  | { readonly t: "lit"; readonly c: number; readonly out: number }
  | { readonly t: "notSlash"; readonly out: number }
  | { readonly t: "anyChar"; readonly out: number }
  | { t: "split"; a: number; readonly b: number }
  | { readonly t: "accept" };

/**
 * A compiled glob: `test(value)` says whether the glob matches the whole of
 * `value`.
 *
 * This used to be a JavaScript RegExp, and a backtracking regex with several
 * `*` in it takes polynomial time — `Bash(*git*push*--force*)` against an
 * 18 KB command blocked the event loop for twelve seconds, and a rule with a
 * handful more wildcards did not finish at all. Every tool call is matched
 * against every rule, synchronously, with a model-supplied argument.
 *
 * So the glob is compiled to a small automaton and run by keeping the SET of
 * states it could be in (Thompson's construction). Each character is looked
 * at once, against each state once: the time is proportional to the length
 * of the value times the length of the glob, whatever the input looks like.
 * The language accepted is exactly the old regex's — the test suite checks
 * the two against each other.
 *
 * `work`, when passed, has the number of automaton states visited added to
 * `work.steps`: a count of the work done that does not depend on how busy
 * the machine is, so a test can check the cost grows linearly without
 * racing a clock.
 */
export type GlobMatcher = {
  readonly test: (value: string, work?: { steps: number }) => boolean;
};

function compileGlob(glob: string): GlobMatcher {
  const tokens = tokenizeGlob(glob);
  // Fast path: a glob with no metacharacters is a string comparison. Most
  // tool-name halves (`Read`, `Bash`) are this.
  if (tokens.every((t) => t.k === "lit")) {
    let literal = "";
    for (const t of tokens) literal += String.fromCharCode((t as { c: number }).c);
    return {
      test: (value: string, work?: { steps: number }) => {
        if (work !== undefined) work.steps += value.length;
        return value === literal;
      },
    };
  }

  const states: GlobState[] = [{ t: "accept" }];
  const push = (state: GlobState): number => states.push(state) - 1;
  const loop = (t: "notSlash" | "anyChar", exit: number): number => {
    const split: GlobState = { t: "split", a: -1, b: exit };
    const splitAt = push(split);
    split.a = push({ t, out: splitAt });
    return splitAt;
  };
  const optionalRunThenSlash = (next: number): number => {
    const slash = push({ t: "lit", c: SLASH, out: next });
    return push({ t: "split", a: loop("anyChar", slash), b: next });
  };

  // Build right to left, so each fragment knows where it continues.
  let next = 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i] as GlobToken;
    switch (token.k) {
      case "lit":
        next = push({ t: "lit", c: token.c, out: next });
        break;
      case "qmark":
        next = push({ t: "notSlash", out: next });
        break;
      case "star":
        next = loop("notSlash", next);
        break;
      case "any":
        next = loop("anyChar", next);
        break;
      case "optPrefix":
        next = optionalRunThenSlash(next);
        break;
      case "mid":
        next = push({ t: "lit", c: SLASH, out: optionalRunThenSlash(next) });
        break;
      case "optSuffix": {
        const slash = push({ t: "lit", c: SLASH, out: loop("anyChar", next) });
        next = push({ t: "split", a: slash, b: next });
        break;
      }
    }
  }
  const start = next;
  const count = states.length;

  return {
    test(value: string, work?: { steps: number }): boolean {
      // `seen[s] === step` ⇔ state s is already in the set for this step.
      const seen = new Int32Array(count).fill(-1);
      let current: number[] = [];
      let following: number[] = [];
      const stack: number[] = [];
      const add = (into: number[], state: number, step: number): void => {
        stack.push(state);
        while (stack.length > 0) {
          const s = stack.pop() as number;
          if (seen[s] === step) continue;
          seen[s] = step;
          const st = states[s] as GlobState;
          if (st.t === "split") {
            stack.push(st.b, st.a);
          } else {
            into.push(s);
          }
        }
      };
      add(current, start, 0);
      let steps = 0;
      const done = (answer: boolean): boolean => {
        if (work !== undefined) work.steps += steps;
        return answer;
      };
      for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        following.length = 0;
        steps += current.length;
        for (const s of current) {
          const st = states[s] as GlobState;
          if (
            (st.t === "lit" && st.c === c) ||
            (st.t === "notSlash" && c !== SLASH) ||
            st.t === "anyChar"
          ) {
            add(following, st.out, i + 1);
          }
        }
        if (following.length === 0) return done(false);
        [current, following] = [following, current];
      }
      return done(current.includes(0));
    },
  };
}

export function compilePattern(pattern: string): CompiledPattern {
  if (!pattern.trim()) throw new PatternParseError("pattern must not be empty");

  const parenIdx = pattern.indexOf("(");
  if (parenIdx === -1) {
    const toolGlob = pattern.trim();
    return { toolGlob, argGlob: null, _toolRe: compileGlob(toolGlob), _argRe: null };
  }

  if (!pattern.endsWith(")")) {
    throw new PatternParseError(`pattern "${pattern}" has unmatched parenthesis`);
  }

  const toolGlob = pattern.slice(0, parenIdx).trim();
  const argGlob = pattern.slice(parenIdx + 1, -1);

  if (!toolGlob) throw new PatternParseError("tool name portion must not be empty");

  return {
    toolGlob,
    argGlob,
    _toolRe: compileGlob(toolGlob),
    _argRe: compileGlob(argGlob),
  };
}

function stringValues(input: unknown): string[] {
  if (typeof input === "string") return [input];
  if (input === null || typeof input !== "object") return [];
  return Object.values(input as Record<string, unknown>).flatMap(stringValues);
}

/**
 * The operative argument field(s) per well-known tool NAME — the input a
 * permission arg-glob is meant to constrain.
 *
 * Since 0.7.1 this table is a FALLBACK. A tool says for itself which fields a
 * rule constrains (`operativeArgs` on its definition), and the runtime hands
 * the matcher those values, already canonicalised. The table only speaks for
 * a tool that declares nothing but carries one of these names — an MCP or
 * custom tool called `Write`, say — which is why it keeps the Claude-Code
 * style `file_path` alias next to `path`.
 *
 * Exported because `crewhaus permissions suggest` and the approvals tooling
 * read it to show an operator the field a rule would be checked against.
 */
export const OPERATIVE_ARG_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Bash: ["command"],
  Read: ["file_path", "path"],
  Write: ["file_path", "path"],
  Edit: ["file_path", "path"],
  Glob: ["pattern"],
  Grep: ["pattern", "path"],
  Fetch: ["url"],
  WebFetch: ["url"],
  WebSearch: ["query"],
  Navigate: ["url"],
};

// ---------------------------------------------------------------------------
// MCP tool names
// ---------------------------------------------------------------------------

/**
 * The prefix of every tool an MCP server contributes:
 * `mcp__<server>__<tool>`.
 */
export const MCP_TOOL_NAME_PREFIX = "mcp__";

/**
 * The spelling an MCP tool name had before crewhaus 0.7.1, `<server>__<tool>`,
 * or `undefined` when `name` is not an MCP tool name. A rule written against
 * the old spelling keeps matching through it.
 */
export function legacyMcpToolName(name: string): string | undefined {
  if (!name.startsWith(MCP_TOOL_NAME_PREFIX)) return undefined;
  const rest = name.slice(MCP_TOOL_NAME_PREFIX.length);
  // The separator after a server of at least one character. An
  // `mcp_servers` key may itself contain `__` or start with `_` (0.7.0 ran
  // such keys), and the old spelling is still everything after `mcp__`.
  const sep = rest.indexOf("__", 1);
  if (sep < 1 || sep + 2 >= rest.length) return undefined;
  return rest;
}

/**
 * Does the pattern's tool half name `toolName`? An MCP tool also answers to
 * its pre-0.7.1 spelling, so a rule written `github__*` still governs
 * `mcp__github__create_issue`. The alias runs one way only: `mcp__x__y` never
 * matches a tool that is not an MCP tool.
 */
export function matchesToolName(compiled: CompiledPattern, toolName: string): boolean {
  if (compiled._toolRe.test(toolName)) return true;
  const legacy = legacyMcpToolName(toolName);
  return legacy !== undefined && compiled._toolRe.test(legacy);
}

// ---------------------------------------------------------------------------
// Operative values
// ---------------------------------------------------------------------------

/** Which way a rule points. `allow` grants; `restrict` is a deny or an ask. */
export type RulePolarity = "allow" | "restrict";

/** Mirrors `OperativeArgKind` in `@crewhaus/tool-catalog`. */
export type OperativeValueKind = "path" | "url" | "command" | "recipient" | "text" | "id";

/**
 * One value a rule's argument glob is checked against, prepared by the
 * runtime from the tool's declared `operativeArgs` and its PARSED input.
 *
 * - `canonical` — the spelling(s) of what the tool will act on: for a path,
 *   the workspace-relative location with `..` collapsed and symlinks
 *   followed, plus the same location as an absolute path. An allow rule must
 *   match one of these.
 * - `spellings` — other ways of writing the same value (what the model sent,
 *   the path before symlinks were followed). A deny or ask rule also fires on
 *   these, so a rule written against either form is not dodged.
 * - `outsideWorkspace` — the path lands outside the workspace, or where it
 *   lands could not be worked out. It never satisfies an allow rule and
 *   always satisfies a deny or ask rule.
 * - `caseInsensitive` — the path lands on a filesystem that does not tell
 *   names apart by letter case (macOS and Windows by default), or the runtime
 *   could not find out. A deny or ask rule then compares it ignoring case, so
 *   `alwaysDeny Write(.crewhaus/settings.json)` also fires on
 *   `.crewhaus/Settings.json`, which is the same file there.
 *
 * For a `path` value, a glob that starts with `/` is compared with the
 * absolute spellings and any other glob with the relative ones, so
 * `**` + `/src/**` cannot reach into the directories ABOVE the workspace. A
 * deny or ask rule also compares a path in Unicode normal form C, so a name
 * spelled with a combining accent (`cafe` + U+0301) is the name spelled with
 * the precomposed one (`café`), as it is on macOS.
 */
export type OperativeValue = {
  readonly kind: OperativeValueKind;
  readonly canonical: ReadonlyArray<string>;
  readonly spellings?: ReadonlyArray<string>;
  readonly outsideWorkspace?: boolean;
  readonly caseInsensitive?: boolean;
};

export type MatchOptions = {
  /** Default `"allow"`, the conservative reading for a grant. */
  readonly polarity?: RulePolarity;
  /**
   * The tool's declared operative values, canonicalised by the runtime.
   * Absent ⇒ the tool declared none (or declared `[]`: no argument decides
   * where it acts), and the matcher falls back to the
   * {@link OPERATIVE_ARG_FIELDS} name table, then to every string in `input`.
   * Present but empty ⇒ the tool declares operative fields and this call
   * carries none of them, so no argument-scoped rule can match it.
   */
  readonly operativeValues?: ReadonlyArray<OperativeValue>;
};

function isAbsoluteSpelling(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value);
}

/** True when an argument glob is written as an absolute path. */
function globIsAbsolute(argGlob: string): boolean {
  return argGlob.startsWith("/") || argGlob.startsWith("\\/") || /^[A-Za-z]:[\\/]/.test(argGlob);
}

const DOT_DOT_SEGMENT = /(^|[\\/])\.\.([\\/]|$)/;

/**
 * Collapse `.` and `..` segments without touching the filesystem, and write
 * the result with `/` separators. `escapes` is true when a relative path
 * climbs above its starting point.
 *
 * Exported for the runtimes that canonicalise a path-kind operative value
 * where there is no filesystem to ask (the edge worker).
 */
export function normalizePathLexically(value: string): {
  readonly path: string;
  readonly escapes: boolean;
} {
  const absolute = value.startsWith("/");
  const out: string[] = [];
  let escapes = false;
  for (const segment of value.split(/[\\/]/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0) out.pop();
      else if (!absolute) escapes = true;
      continue;
    }
    out.push(segment);
  }
  const joined = out.join("/");
  return { path: absolute ? `/${joined}` : joined === "" ? "." : joined, escapes };
}

/**
 * A string from an input the tool has not described. Nothing says it is a
 * path, but it may be one, so a `..` segment in it is read the careful way
 * round for each polarity: an allow never matches it (what it resolves to is
 * unknown), and a deny or ask sees it with the `..` collapsed — and fires
 * outright when it climbs out of wherever it starts.
 */
function undeclaredValue(value: string): OperativeValue {
  if (!DOT_DOT_SEGMENT.test(value)) return { kind: "text", canonical: [value] };
  const lexical = normalizePathLexically(value);
  return {
    kind: "text",
    canonical: [],
    spellings: [value, lexical.path],
    ...(lexical.escapes ? { outsideWorkspace: true } : {}),
  };
}

function fallbackValues(toolName: string, input: unknown): OperativeValue[] {
  const fields = OPERATIVE_ARG_FIELDS[toolName];
  if (fields !== undefined && input !== null && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const present: string[] = [];
    for (const f of fields) {
      const v = record[f];
      if (typeof v === "string") present.push(v);
    }
    if (present.length > 0) return present.map(undeclaredValue);
    // operative field absent → every string in the input
  }
  return stringValues(input).map(undeclaredValue);
}

/** A path as a deny or ask rule compares it: NFC, and lower-cased when the filesystem ignores case. */
function foldPath(value: string, ignoreCase: boolean): string {
  const nfc = value.normalize("NFC");
  return ignoreCase ? nfc.toLowerCase() : nfc;
}

/** Argument globs compiled in folded form, per pattern, built on first use. */
const foldedArgGlobs = new WeakMap<CompiledPattern, Map<boolean, GlobMatcher>>();

function foldedArgMatcher(compiled: CompiledPattern, ignoreCase: boolean): GlobMatcher {
  let byMode = foldedArgGlobs.get(compiled);
  if (byMode === undefined) {
    byMode = new Map();
    foldedArgGlobs.set(compiled, byMode);
  }
  let matcher = byMode.get(ignoreCase);
  if (matcher === undefined) {
    matcher = compileGlob(foldPath(compiled.argGlob ?? "", ignoreCase));
    byMode.set(ignoreCase, matcher);
  }
  return matcher;
}

function valueMatches(
  value: OperativeValue,
  compiled: CompiledPattern,
  argRe: GlobMatcher,
  absoluteGlob: boolean,
  polarity: RulePolarity,
): boolean {
  if (value.outsideWorkspace === true) return polarity === "restrict";
  const candidates =
    polarity === "allow" ? value.canonical : [...value.canonical, ...(value.spellings ?? [])];
  for (const candidate of candidates) {
    if (value.kind === "path" && isAbsoluteSpelling(candidate) !== absoluteGlob) continue;
    if (argRe.test(candidate)) return true;
  }
  // A deny or ask on a path is not dodged by spelling the name another way
  // the filesystem treats as the same: another Unicode normal form always,
  // and another letter case where the filesystem ignores case.
  if (polarity === "restrict" && value.kind === "path") {
    const ignoreCase = value.caseInsensitive === true;
    const folded = foldedArgMatcher(compiled, ignoreCase);
    for (const candidate of candidates) {
      if (isAbsoluteSpelling(candidate) !== absoluteGlob) continue;
      if (folded.test(foldPath(candidate, ignoreCase))) return true;
    }
  }
  return false;
}

/**
 * Does a rule's pattern match this tool call?
 *
 * The tool half is matched against the tool's name (see
 * {@link matchesToolName}). A bare pattern stops there. An argument glob is
 * matched against the call's operative values, and how depends on which way
 * the rule points:
 *
 * - `polarity: "allow"` (the default) — EVERY operative value must match. One
 *   in-scope value cannot carry an out-of-scope one: `Write(src/**)` does not
 *   authorise `{ file_path: "src/ok.ts", path: ".git/hooks/pre-commit" }`.
 * - `polarity: "restrict"` (deny, ask) — ANY operative value matching is
 *   enough. A deny that needed every value to match would be dodged by
 *   adding one more argument.
 *
 * A call with no operative value matches no argument-scoped rule of either
 * polarity.
 */
export function matchesPattern(
  compiled: CompiledPattern,
  toolName: string,
  input: unknown,
  options: MatchOptions = {},
): boolean {
  if (!matchesToolName(compiled, toolName)) return false;
  const argRe = compiled._argRe;
  if (argRe === null) return true;
  const polarity = options.polarity ?? "allow";
  const values = options.operativeValues ?? fallbackValues(toolName, input);
  if (values.length === 0) return false;
  const absoluteGlob = globIsAbsolute(compiled.argGlob ?? "");
  return polarity === "allow"
    ? values.every((v) => valueMatches(v, compiled, argRe, absoluteGlob, polarity))
    : values.some((v) => valueMatches(v, compiled, argRe, absoluteGlob, polarity));
}

export {
  type PermissionRuleProblem,
  type PermissionRuleProblemCode,
  type PermissionRuleProblemsInput,
  type RuleToolDescriptor,
  argGlobCanMatchUrl,
  permissionRuleProblems,
} from "./rule-problems";
