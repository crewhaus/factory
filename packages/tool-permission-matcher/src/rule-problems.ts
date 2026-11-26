/**
 * Permission rules that can never do what they say — found before a run.
 *
 * The engine matches a rule's tool half against a tool's REGISTERED name and
 * its argument half against the fields the tool declares as operative. A
 * rule that gets either wrong is not an error at run time: it simply never
 * matches, and the call falls through to the next rule or the mode's
 * fallback. `crewhaus lint`, `compile` and `PermissionAudit` use this to say
 * so while the spec is being written (permission-integration#12).
 *
 * Only what can be shown is reported as dead. A rule naming a tool this
 * module has never heard of is not — a plugin or a custom tool may register
 * it — unless the name is one or two letters away from a tool it does know;
 * otherwise it gets an informational `tool-not-known` note, which `compile
 * --strict` does not escalate. The caller's `known` list must therefore carry
 * the tools the runtime registers on its own (`Skill`, the browser shape's
 * `Type`, a `thredz:` block's `goal_list`), not only the builtins, or a real
 * tool name reads as a typo of a builtin.
 *
 * A correction never widens an allow: when the nearest name belongs to a tool
 * that can change or delete things, or needs a sandbox (or its flags are not
 * known), an allow rule is reported without a `Write "…"` fix, because
 * following it would grant that tool.
 *
 * A rule is matched against a name exactly, so `REMOVEPATH`, `remove_path`
 * and `Codegraph*` never fire on RemovePath or CodeGraphSearch; they are
 * found by folding case and dropping `_`, `-` and spaces on both sides.
 *
 * A glob that can still match a tool of an MCP server the spec declares
 * (`*write*` reaches `mcp__fs__write_file`) is not dead, so it is never
 * reported as one. When it reaches no granted builtin it resembles, that is
 * a `builtin-not-reached` note, which names the builtins and offers no
 * rewrite; `compile --strict` does not escalate it.
 *
 * Pure: plain data in, findings out.
 */
import {
  type CompiledPattern,
  type InclusionBudget,
  PatternParseError,
  compilePattern,
  globIncludedIn,
  legacyMcpToolName,
  matchesToolName,
} from "./index";

/** What the checker needs to know about one tool. */
export type RuleToolDescriptor = {
  /** The registered name a rule's tool half is matched against (`RemovePath`). */
  readonly name: string;
  /** The key a spec lists it under, when that differs (`removePath`). */
  readonly key?: string;
  /**
   * The tool's `operativeArgs`. Absent when it declares none, which leaves
   * nothing to check an argument pattern against.
   */
  readonly operativeArgs?: ReadonlyArray<{
    readonly kind: string;
    readonly field?: string;
    readonly service?: string;
  }>;
  /** Its flags, when known. Absent reads as "may be destructive". */
  readonly destructive?: boolean;
  readonly requiresSandbox?: boolean;
};

export type PermissionRuleProblemCode =
  /** The tool half is a spec key (`removePath`); rules use the name (`RemovePath`). */
  | "tool-key-not-name"
  /** The tool half matches no tool, and is a near miss of one that exists. */
  | "unknown-tool"
  /** `mcp__<server>__…` for a server the spec does not declare. */
  | "unknown-mcp-server"
  /** An argument pattern on a tool with no argument that says where it acts. */
  | "argument-not-scoped"
  /** An argument pattern no value of the tool's operative fields can match. */
  | "argument-cannot-match"
  /**
   * INFORMATIONAL, not a dead rule: a glob that can match tools of a declared
   * MCP server, and reaches no granted builtin whose key or spelling it
   * resembles. It still fires on the MCP tools; the note names the builtins.
   */
  | "builtin-not-reached"
  /**
   * INFORMATIONAL: a literal name that is no tool the caller knows and is
   * close to none. It never fires unless something the checker cannot see
   * offline — a plugin, a custom tool, an MCP server's pre-0.7.1
   * `<server>__<tool>` spelling — registers a tool by that name.
   */
  | "tool-not-known"
  /**
   * A deny or ask below an allow, in the same layer, that matches every call
   * it would: the first matching rule decides, so it never fires (except in
   * plan mode, which reads no allow). See {@link shadowedPermissionRules}.
   */
  | "shadowed-by-allow"
  /**
   * INFORMATIONAL: the same, in a spec whose `permissions.mode` is `plan`.
   * Plan mode reads no allow, so the rule fires as the spec runs; it would
   * stop firing if the spec were run in another mode (`--permission-mode`).
   */
  | "shadowed-outside-plan"
  /**
   * INFORMATIONAL: the rule-order check does a bounded amount of work (see
   * {@link RULE_ORDER_LIMITS}) and reached that bound at this rule, so this
   * rule, the rules after it and any later list were not checked for an
   * allow above them that always matches first. The findings it had already
   * shown are kept.
   */
  | "order-not-checked"
  /**
   * INFORMATIONAL: the rule checks of {@link permissionRuleProblems} do a
   * bounded amount of work (see {@link RULE_PROBLEM_LIMITS}) and reached that
   * bound at this rule, so this rule, the rules after it and any later list
   * sharing the bound were not checked for a tool name or argument that can
   * never match. The findings it had already shown are kept.
   */
  | "rule-not-checked";

export type PermissionRuleProblem = {
  readonly type: string;
  readonly pattern: string;
  readonly code: PermissionRuleProblemCode;
  /** What is wrong, and what to write instead. */
  readonly message: string;
  /** The corrected pattern, when there is exactly one. */
  readonly suggestion?: string;
};

export type PermissionRuleProblemsInput = {
  readonly rules: ReadonlyArray<{ readonly type: string; readonly pattern: string }>;
  /** The tools the spec grants. */
  readonly granted: ReadonlyArray<RuleToolDescriptor>;
  /** Every tool the caller knows exists (the builtins), granted or not. */
  readonly known: ReadonlyArray<RuleToolDescriptor>;
  /** The MCP server names the spec declares. */
  readonly mcpServers: ReadonlyArray<string>;
  /**
   * The work the checks may still do, counted as {@link RULE_PROBLEM_LIMITS}
   * counts it and spent by subtraction. Hand one object to the call for each
   * list of a spec to bound them together: once it is spent, a later call
   * checks nothing and adds no second note. Absent, the call gets its own
   * `RULE_PROBLEM_LIMITS.steps`.
   */
  readonly budget?: { steps: number };
};

/**
 * How much work the checks of one {@link permissionRuleProblems} call (or of
 * every call sharing its `budget`) do at most. One step is one automaton
 * state visited while a tool glob is matched against a name, one element of
 * the working array each such match fills, one cell of a near-miss
 * comparison, one known or granted tool, one name looked up, one declared
 * MCP server read (with its name's length), or a few for each character of
 * a rule's text read or compiled. A tool glob that is a literal name is
 * looked up, not matched against each tool; a wildcard one is matched only
 * against the tools that start with its fixed start, hold its letters and
 * are no shorter than its shortest match, and once per budget for each
 * distinct glob, however many rules or lists repeat it.
 */
export const RULE_PROBLEM_LIMITS = { steps: 1 << 24 } as const;

/**
 * Steps charged per character of a rule's text for the reads every rule gets:
 * splitting it, and the declared servers it reaches.
 */
const RULE_TEXT_STEPS = 4;
/** Steps charged per character of a pattern compiled: the rule, or a rewrite derived from it. */
const COMPILE_STEPS = 4;
/** Steps charged per character of a tool glob folded. */
const FOLD_STEPS = 2;

const GLOB_META = /[*?\\]/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*$/;

/** A code unit `\s` matches: WhiteSpace or LineTerminator. */
function isRegExpSpace(c: number): boolean {
  return (
    (c >= 0x09 && c <= 0x0d) ||
    c === 0x20 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** A code unit `.` does not match without the `s` flag. */
function isLineBreak(c: number): boolean {
  return c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;
}

/**
 * What follows a leading word and its whitespace (`GET https://…`): what
 * `/^[A-Za-z]+\s+(.+)$/` captured, read in one pass. The letters and the
 * whitespace are taken whole and the rest must hold no line break (`.` stops
 * at \n, \r, U+2028 and U+2029); with nothing after the whitespace, the
 * pattern took its last character, unless that is a line break or the
 * whitespace is a single character. The pattern tried every shorter run of
 * whitespace and rescanned the rest from each, so a run before a stray \r
 * in a spec's rule was quadratic in the run's length.
 */
export function afterMethod(argGlob: string): string | undefined {
  let at = 0;
  while (at < argGlob.length) {
    const c = argGlob.charCodeAt(at) | 0x20;
    if (c < 0x61 || c > 0x7a) break;
    at++;
  }
  if (at === 0) return undefined;
  const spaceFrom = at;
  while (at < argGlob.length && isRegExpSpace(argGlob.charCodeAt(at))) at++;
  if (at === spaceFrom) return undefined;
  if (at === argGlob.length) {
    const last = at - 1;
    return last > spaceFrom && !isLineBreak(argGlob.charCodeAt(last))
      ? argGlob.charAt(last)
      : undefined;
  }
  for (let i = at; i < argGlob.length; i++) {
    if (isLineBreak(argGlob.charCodeAt(i))) return undefined;
  }
  return argGlob.slice(at);
}

function split(pattern: string): { tool: string; arg: string | null } {
  const paren = pattern.indexOf("(");
  if (paren === -1) return { tool: pattern.trim(), arg: null };
  return { tool: pattern.slice(0, paren).trim(), arg: pattern.slice(paren + 1, -1) };
}

function withTool(pattern: string, tool: string): string {
  const { arg } = split(pattern);
  return arg === null ? tool : `${tool}(${arg})`;
}

/**
 * Levenshtein distance, capped: anything past `cap` is reported as `cap + 1`.
 * Only the cells within `cap` of the diagonal are worked out: a path through
 * any other cell already costs more than `cap`, so the distance is exact
 * whenever it is at most `cap`.
 */
function distance(a: string, b: string, cap: number): number {
  const over = cap + 1;
  if (Math.abs(a.length - b.length) > cap) return over;
  let prev = new Array<number>(b.length + 1).fill(over);
  let curr = new Array<number>(b.length + 1).fill(over);
  /** A cell of row `i`, or `over` outside the band. */
  const at = (row: number[], i: number, j: number): number =>
    j < 0 || j > b.length || Math.abs(i - j) > cap ? over : (row[j] ?? over);
  for (let j = 0; j <= Math.min(cap, b.length); j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const hi = Math.min(b.length, i + cap);
    for (let j = Math.max(0, i - cap); j <= hi; j++) {
      if (j === 0) {
        curr[0] = i;
        continue;
      }
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        at(prev, i - 1, j) + 1,
        at(curr, i, j - 1) + 1,
        at(prev, i - 1, j - 1) + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return Math.min(at(prev, a.length, b.length), over);
}

/** The cells {@link distance} works out for `a` against a name within `cap` of its length. */
function distanceCells(a: string, cap: number): number {
  return (a.length + 1) * (2 * cap + 1);
}

/**
 * The text a glob must start with: everything before its first wildcard,
 * with escapes resolved.
 */
function literalPrefix(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === "\\" && i + 1 < glob.length) {
      out += glob.charAt(i + 1);
      i++;
    } else if (ch === "*" || ch === "?") {
      break;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Can this argument glob match any URL? A URL is compared in its parsed
 * form, which always starts with a scheme and a colon (`https:`), so a glob
 * whose fixed start cannot begin that way — `GET https://…` — never matches.
 */
export function argGlobCanMatchUrl(argGlob: string): boolean {
  const prefix = literalPrefix(argGlob);
  const colon = prefix.indexOf(":");
  const scheme = colon === -1 ? prefix : prefix.slice(0, colon);
  // A scheme is a letter, then letters, digits, `+`, `-` or `.`; the fixed
  // start may stop part-way through one (`ht*`).
  return scheme === "" ? colon === -1 : SCHEME.test(scheme);
}

/**
 * A `url` declared as its own `service`: the API a call goes to, itself
 * (tool-catalog's `isApiRootArg`, restated here because this package takes
 * plain data and depends on no tool package).
 */
function isApiRoot(arg: {
  readonly kind: string;
  readonly field?: string;
  readonly service?: string;
}): boolean {
  return arg.kind === "url" && arg.service !== undefined && arg.service === arg.field;
}

/** When a URL glob was written after an HTTP method (`GET https://…`), the glob without it. */
function withoutMethodPrefix(argGlob: string): string | undefined {
  const rest = afterMethod(argGlob);
  return rest !== undefined && argGlobCanMatchUrl(rest) ? rest : undefined;
}

/**
 * `glob` re-cased to match `name`, for the shapes a case-only rewrite can be
 * derived for: an exact name, `prefix*`, `*suffix` and `*middle*` whose
 * literal part appears in `name` ignoring case. Undefined otherwise.
 */
function recasedGlob(glob: string, name: string): string | undefined {
  const lower = name.toLowerCase();
  if (!GLOB_META.test(glob)) return glob.toLowerCase() === lower ? name : undefined;
  const inner = /^(\*?)([^*?\\]+)(\*?)$/.exec(glob);
  if (inner === null) return undefined;
  const [, lead, literal, trail] = inner as unknown as [string, string, string, string];
  const want = literal.toLowerCase();
  let at: number;
  if (lead === "" && trail === "*") at = lower.startsWith(want) ? 0 : -1;
  else if (lead === "*" && trail === "")
    at = lower.endsWith(want) ? lower.length - want.length : -1;
  else if (lead === "*" && trail === "*") at = lower.indexOf(want);
  else return undefined;
  return at === -1 ? undefined : `${lead}${name.slice(at, at + literal.length)}${trail}`;
}

/** Lower-cased, without the `_`, `-` and spaces people put between words. */
function fold(text: string): string {
  return text.toLowerCase().replace(/[\s_-]+/g, "");
}

/**
 * `glob` folded the way {@link fold} folds a name: its literal text
 * lower-cased and stripped of `_`, `-` and spaces, its wildcards and escapes
 * kept.
 */
function foldGlob(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === "\\" && i + 1 < glob.length) {
      const next = glob.charAt(i + 1);
      i++;
      if (!/[\s_-]/.test(next)) out += `\\${next.toLowerCase()}`;
    } else if (ch === "*" || ch === "?") {
      out += ch;
    } else if (!/[\s_-]/.test(ch)) {
      out += ch.toLowerCase();
    }
  }
  return out;
}

/**
 * The declared MCP servers a tool glob can still reach, in either spelling
 * (`mcp__<server>__<tool>`, or the pre-0.7.1 `<server>__<tool>` the matcher
 * still honours). Judged from the glob's fixed start, so it may say yes for
 * a glob whose tail rules the server's tools out, never no for one that can
 * reach them. An exact `mcp__…` name is handled where `mcp__` rules are; an
 * exact name in the old spelling (`web__fetch`) reaches its server here.
 */
function mcpServersReached(glob: string, servers: ReadonlySet<string>): string[] {
  if (!GLOB_META.test(glob)) {
    return [...servers].filter(
      (server) => glob.startsWith(`${server}__`) && glob.length > server.length + 2,
    );
  }
  const fixed = literalPrefix(glob);
  return [...servers].filter((server) =>
    [`mcp__${server}__`, `${server}__`].some(
      (start) => fixed.startsWith(start) || start.startsWith(fixed),
    ),
  );
}

/**
 * The declared MCP servers whose tools a rule's tool half can match, in
 * either spelling (see {@link mcpServersReached}); none for a malformed
 * pattern. Such a rule may fire on a tool no offline check can list — the
 * server says which tools it has when it starts.
 */
export function mcpServersReachedBy(pattern: string, servers: ReadonlyArray<string>): string[] {
  const paren = pattern.indexOf("(");
  if (paren !== -1 && !pattern.endsWith(")")) return [];
  const toolGlob = (paren === -1 ? pattern : pattern.slice(0, paren)).trim();
  if (toolGlob === "") return [];
  const reached = new Set(mcpServersReached(toolGlob, new Set(servers)));
  // An exact `mcp__<server>__<tool>` name, which mcpServersReached leaves to
  // the `mcp__` rules' own check.
  if (!GLOB_META.test(toolGlob)) {
    for (const server of servers) {
      const start = `mcp__${server}__`;
      if (toolGlob.startsWith(start) && toolGlob.length > start.length) reached.add(server);
    }
  }
  return [...reached].sort();
}

/** `a`, `a and b`, `a, b and c`; past six, the first five and a count. */
function listNames(names: readonly string[]): string {
  const shown = names.length > 6 ? [...names.slice(0, 5), `${names.length - 5} more`] : names;
  return shown.length === 1
    ? (shown[0] as string)
    : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/** The budget of {@link permissionRuleProblems} ran out while a rule was being checked. */
class RuleChecksSpent extends Error {}

/** Which string of a tool a glob is matched against. */
type ToolField = "name" | "key" | "foldedName" | "foldedKey";

function fieldOf(tool: RuleToolDescriptor, field: ToolField): string | undefined {
  switch (field) {
    case "name":
      return tool.name;
    case "key":
      return tool.key;
    case "foldedName":
      return fold(tool.name);
    case "foldedKey":
      return tool.key === undefined ? undefined : fold(tool.key);
  }
}

/**
 * At most how many automaton states a tool glob compiles to: no token of
 * the grammar takes more than two states per character it is written with
 * (a `*` takes two), plus the accepting state. A wildcard glob's match fills
 * an array that long on every call.
 */
function automatonSizeBound(compiled: CompiledPattern): number {
  return compiled._toolRe.isLiteral ? 1 : 2 * compiled.toolGlob.length + 1;
}

/** One bit for each UTF-16 code unit of `text`, by its value mod 32. */
function lettersOf(text: string): number {
  let bits = 0;
  for (let i = 0; i < text.length; i++) bits |= 1 << (text.charCodeAt(i) & 31);
  return bits;
}

/** What every string a tool glob matches has, read from the glob's text once. */
type GlobFacts = {
  /** The one string a glob with no wildcard matches, escapes resolved. */
  readonly literal: string | undefined;
  /**
   * The text every string it matches starts with: what comes before its
   * first wildcard, escapes resolved, less a final `/`, because a trailing
   * `/**` also matches the text before its `/` (`Read/**` matches `Read`).
   */
  readonly start: string;
  /**
   * {@link lettersOf} its literal characters other than `/` (which a `/**`
   * may stand in for): each is in every string it matches.
   */
  readonly letters: number;
  /** Its literal characters other than `/`, and its `?`s: no string it matches is shorter. */
  readonly minLength: number;
};

function globFacts(glob: string, isLiteral: boolean): GlobFacts {
  let start = "";
  let fixed = true;
  let letters = 0;
  let minLength = 0;
  for (let i = 0; i < glob.length; i++) {
    let ch = glob.charAt(i);
    if (ch === "\\" && i + 1 < glob.length) {
      i++;
      ch = glob.charAt(i);
    } else if (ch === "*" || ch === "?") {
      fixed = false;
      if (ch === "?") minLength++;
      continue;
    }
    if (fixed) start += ch;
    if (ch !== "/") {
      letters |= 1 << (ch.charCodeAt(0) & 31);
      minLength++;
    }
  }
  if (isLiteral) return { literal: start, start, letters, minLength };
  return {
    literal: undefined,
    start: start.endsWith("/") ? start.slice(0, -1) : start,
    letters,
    minLength,
  };
}

/** One tool list's strings for one {@link ToolField}, read once per budget. */
type FieldTable = {
  /** Each tool's string, by position; absent when the tool has none. */
  readonly values: ReadonlyArray<string | undefined>;
  /** {@link lettersOf} each string, by position. */
  readonly letters: Int32Array;
  /** Each string, and its old MCP spelling, to the positions holding it. */
  index?: ReadonlyMap<string, number[]>;
  /** The same strings, sorted, with their positions. */
  sorted?: ReadonlyArray<readonly [string, number]>;
  /**
   * What each wildcard tool glob reached, by its text: `all` when every
   * tool was read, `first` when the read stopped at the first hit.
   */
  readonly reached: Map<string, { all?: readonly number[]; first?: readonly number[] }>;
};

/**
 * The work {@link permissionRuleProblems} does, charged to its budget, and
 * what it builds once for every call that shares that budget, the same tools
 * and the same servers: each tool list's strings with their letters and an
 * index by name, so a literal tool glob is a lookup; what each wildcard glob
 * reached, so a glob repeated in another rule or list is matched once; the
 * known names by length, so a near-miss search reads only the names within
 * reach. A charge that spends the budget throws {@link RuleChecksSpent}, and
 * the rule being checked is unchecked.
 */
class RuleWork {
  private readonly tables = new Map<
    ReadonlyArray<RuleToolDescriptor>,
    Map<ToolField, FieldTable>
  >();
  private readonly factsOf = new WeakMap<CompiledPattern, GlobFacts>();
  private poolOf: ReadonlyArray<RuleToolDescriptor> | undefined;
  private knownNamesOf: ReadonlySet<string> | undefined;
  private knownByLengthOf: ReadonlyMap<number, number[]> | undefined;
  private serversOf: { readonly set: ReadonlySet<string>; readonly cost: number } | undefined;

  constructor(
    readonly budget: { steps: number },
    readonly granted: ReadonlyArray<RuleToolDescriptor>,
    readonly known: ReadonlyArray<RuleToolDescriptor>,
    readonly mcpServers: ReadonlyArray<string>,
  ) {}

  /** Charge `steps`; throws once the budget is spent. */
  spend(steps: number): void {
    this.budget.steps -= steps;
    if (this.budget.steps <= 0) throw new RuleChecksSpent();
  }

  /** {@link compilePattern}, charged by the length of what it compiles. */
  compile(pattern: string): CompiledPattern {
    this.spend(COMPILE_STEPS * pattern.length + 1);
    return compilePattern(pattern);
  }

  /** {@link foldGlob}, charged by the glob's length. */
  fold(glob: string): string {
    this.spend(FOLD_STEPS * glob.length + 1);
    return foldGlob(glob);
  }

  /**
   * {@link matchesToolName}, with the states it visits and the array it
   * fills charged. The budget is read first: a spent one answers nothing.
   */
  matches(compiled: CompiledPattern, value: string): boolean {
    if (this.budget.steps <= 0) throw new RuleChecksSpent();
    const work = { steps: 0 };
    const answer = matchesToolName(compiled, value, work);
    const tests = legacyMcpToolName(value) === undefined ? 1 : 2;
    this.spend(work.steps + tests * automatonSizeBound(compiled));
    return answer;
  }

  /** The granted tools, then the known ones. */
  pool(): ReadonlyArray<RuleToolDescriptor> {
    if (this.poolOf === undefined) {
      this.spend(this.granted.length + this.known.length);
      this.poolOf = [...this.granted, ...this.known];
    }
    return this.poolOf;
  }

  /** What every string the tool glob matches has, read once per compiled pattern. */
  private facts(compiled: CompiledPattern): GlobFacts {
    let facts = this.factsOf.get(compiled);
    if (facts === undefined) {
      this.spend(compiled.toolGlob.length + 1);
      facts = globFacts(compiled.toolGlob, compiled._toolRe.isLiteral);
      this.factsOf.set(compiled, facts);
    }
    return facts;
  }

  /**
   * The positions in `tools` of the tools whose `field` the tool glob
   * matches, in order (with `first`, at most the first). A literal glob
   * matches one string, so its tools are looked up by that string and its
   * pre-0.7.1 MCP spelling. A wildcard one is read once per budget for each
   * distinct glob, and is matched only against the tools whose string, or
   * its old spelling, starts with the glob's fixed start (see
   * {@link GlobFacts}), is at least as long as the glob's shortest match and
   * holds every one of its letters: no other can match it.
   */
  reaching(
    compiled: CompiledPattern,
    tools: ReadonlyArray<RuleToolDescriptor>,
    field: ToolField,
    first = false,
  ): readonly number[] {
    const facts = this.facts(compiled);
    const table = this.table(tools, field);
    if (facts.literal !== undefined) {
      const hits = this.index(table).get(facts.literal) ?? [];
      this.spend(1 + hits.length);
      return first ? hits.slice(0, 1) : hits;
    }
    const held = table.reached.get(compiled.toolGlob);
    const known = held?.all ?? (first ? held?.first : undefined);
    if (known !== undefined) {
      const out = first ? known.slice(0, 1) : known;
      this.spend(1 + out.length);
      return out;
    }
    const candidates = facts.start === "" ? undefined : this.startingWith(table, facts.start);
    const count = candidates === undefined ? tools.length : candidates.length;
    const out: number[] = [];
    let stopped = false;
    for (let i = 0; i < count; i++) {
      const at = candidates === undefined ? i : (candidates[i] as number);
      this.spend(1);
      const value = table.values[at];
      if (
        value === undefined ||
        value.length < facts.minLength ||
        (facts.letters & ~(table.letters[at] as number)) !== 0
      ) {
        continue;
      }
      if (this.matches(compiled, value)) {
        out.push(at);
        if (first) {
          stopped = true;
          break;
        }
      }
    }
    const entry = held ?? {};
    if (stopped) entry.first = out;
    else entry.all = out;
    table.reached.set(compiled.toolGlob, entry);
    return out;
  }

  /** `tools`' strings for `field`, with their letters: read once per budget, charged by their length. */
  private table(tools: ReadonlyArray<RuleToolDescriptor>, field: ToolField): FieldTable {
    let byField = this.tables.get(tools);
    if (byField === undefined) {
      byField = new Map();
      this.tables.set(tools, byField);
    }
    const held = byField.get(field);
    if (held !== undefined) return held;
    let cost = tools.length + 1;
    for (const tool of tools) cost += tool.name.length + (tool.key?.length ?? 0);
    this.spend(cost);
    const values = tools.map((tool) => fieldOf(tool, field));
    const letters = new Int32Array(values.length);
    for (const [at, value] of values.entries()) {
      if (value !== undefined) letters[at] = lettersOf(value);
    }
    const table: FieldTable = { values, letters, reached: new Map() };
    byField.set(field, table);
    return table;
  }

  /** Each string of `table`, and its old MCP spelling, to the positions holding it. */
  private index(table: FieldTable): ReadonlyMap<string, number[]> {
    if (table.index !== undefined) return table.index;
    this.spend(table.values.length + 1);
    const index = new Map<string, number[]>();
    const add = (value: string, at: number) => {
      const positions = index.get(value);
      if (positions === undefined) index.set(value, [at]);
      else positions.push(at);
    };
    for (const [at, value] of table.values.entries()) {
      if (value === undefined) continue;
      add(value, at);
      const legacy = legacyMcpToolName(value);
      if (legacy !== undefined) add(legacy, at);
    }
    table.index = index;
    return index;
  }

  /**
   * The positions in `table` whose string, or its old MCP spelling, starts
   * with `start`, in order: a binary search of the strings, sorted once.
   */
  private startingWith(table: FieldTable, start: string): number[] {
    let sorted = table.sorted;
    if (sorted === undefined) {
      const strings: Array<readonly [string, number]> = [];
      for (const [at, value] of table.values.entries()) {
        if (value === undefined) continue;
        strings.push([value, at]);
        const legacy = legacyMcpToolName(value);
        if (legacy !== undefined) strings.push([legacy, at]);
      }
      this.spend((strings.length + 1) * Math.ceil(Math.log2(strings.length + 2)));
      strings.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
      sorted = strings;
      table.sorted = sorted;
    }
    // The first string not below `start`; every string that starts with it
    // follows, together.
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((sorted[mid] as readonly [string, number])[0] < start) lo = mid + 1;
      else hi = mid;
    }
    this.spend(1 + Math.ceil(Math.log2(sorted.length + 1)));
    const found = new Set<number>();
    for (let i = lo; i < sorted.length; i++) {
      const [value, at] = sorted[i] as readonly [string, number];
      if (!value.startsWith(start)) break;
      this.spend(1);
      found.add(at);
    }
    return [...found].sort((a, b) => a - b);
  }

  /** Whether a known tool is named exactly `name`. */
  isKnownName(name: string): boolean {
    if (this.knownNamesOf === undefined) {
      this.spend(this.known.length + 1);
      this.knownNamesOf = new Set(this.known.map((t) => t.name));
    }
    this.spend(1);
    return this.knownNamesOf.has(name);
  }

  /**
   * The known tools within `cap` of `name` by Levenshtein distance, as
   * `{tool, name, d}`, in the order `known` lists them. Only the names
   * whose length is within `cap` of `name`'s are compared; each comparison
   * is charged its cells.
   */
  nearNames(
    name: string,
    cap: number,
  ): Array<{ readonly tool: RuleToolDescriptor; readonly name: string; readonly d: number }> {
    if (this.knownByLengthOf === undefined) {
      this.spend(this.known.length + 1);
      const byLength = new Map<number, number[]>();
      for (const [at, tool] of this.known.entries()) {
        const positions = byLength.get(tool.name.length);
        if (positions === undefined) byLength.set(tool.name.length, [at]);
        else positions.push(at);
      }
      this.knownByLengthOf = byLength;
    }
    const within: number[] = [];
    for (let length = name.length - cap; length <= name.length + cap; length++) {
      this.spend(1);
      for (const at of this.knownByLengthOf.get(length) ?? []) within.push(at);
    }
    within.sort((a, b) => a - b);
    const near: Array<{ tool: RuleToolDescriptor; name: string; d: number }> = [];
    for (const at of within) {
      const tool = this.known[at] as RuleToolDescriptor;
      this.spend(1 + distanceCells(name, cap));
      const d = distance(name, tool.name, cap);
      if (d <= cap) near.push({ tool, name: tool.name, d });
    }
    return near;
  }

  private serverSet(): { readonly set: ReadonlySet<string>; readonly cost: number } {
    if (this.serversOf === undefined) {
      let cost = 0;
      for (const server of this.mcpServers) cost += 1 + server.length;
      this.spend(cost + 1);
      this.serversOf = { set: new Set(this.mcpServers), cost };
    }
    return this.serversOf;
  }

  /** The declared MCP servers, for a read of them all, charged with each name's length. */
  servers(): ReadonlySet<string> {
    const servers = this.serverSet();
    this.spend(servers.cost + 1);
    return servers.set;
  }

  /** Whether `name` is a declared MCP server. */
  isServer(name: string): boolean {
    const servers = this.serverSet();
    this.spend(1);
    return servers.set.has(name);
  }
}

/** The work state each budget object carries across the calls that share it. */
const ruleWorkByBudget = new WeakMap<{ steps: number }, RuleWork>();

function ruleWorkFor(input: PermissionRuleProblemsInput, budget: { steps: number }): RuleWork {
  const held = ruleWorkByBudget.get(budget);
  if (
    held !== undefined &&
    held.granted === input.granted &&
    held.known === input.known &&
    held.mcpServers === input.mcpServers
  ) {
    return held;
  }
  const work = new RuleWork(budget, input.granted, input.known, input.mcpServers);
  ruleWorkByBudget.set(budget, work);
  return work;
}

/**
 * The tools a rule that reaches none of them by name was written for: every
 * tool in `pool` whose spec key the glob matches, or whose name or key it
 * matches once case, `_`, `-` and spaces are set aside. Empty when the glob
 * reaches any tool in `pool` by its name — then it is a live spelling of a
 * tool that exists, not a misspelling of one.
 */
function toolsMisspelled(
  compiled: CompiledPattern,
  toolGlob: string,
  pool: ReadonlyArray<RuleToolDescriptor>,
  work: RuleWork,
): RuleToolDescriptor[] {
  if (work.reaching(compiled, pool, "name", true).length > 0) return [];
  const folded = work.fold(toolGlob);
  let foldedCompiled: CompiledPattern | undefined;
  try {
    foldedCompiled = folded === "" ? undefined : work.compile(folded);
  } catch (err) {
    if (err instanceof RuleChecksSpent) throw err;
    foldedCompiled = undefined;
  }
  const hits = new Set<number>(work.reaching(compiled, pool, "key"));
  if (foldedCompiled !== undefined) {
    for (const at of work.reaching(foldedCompiled, pool, "foldedName")) hits.add(at);
    for (const at of work.reaching(foldedCompiled, pool, "foldedKey")) hits.add(at);
  }
  const byName = new Map<string, RuleToolDescriptor>();
  for (const at of [...hits].sort((a, b) => a - b)) {
    const t = pool[at] as RuleToolDescriptor;
    byName.set(t.name, t);
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Every rule in `input.rules` that cannot do what it says, with the fix.
 *
 * The checks do a bounded amount of work ({@link RULE_PROBLEM_LIMITS}, or
 * `input.budget`, which calls for a spec's lists share). When it is spent,
 * the rule being checked gets one `rule-not-checked` note in place of its
 * findings, and it, the rules after it and every later call sharing the
 * budget are not checked; the findings already shown are kept.
 */
export function permissionRuleProblems(
  input: PermissionRuleProblemsInput,
): PermissionRuleProblem[] {
  const budget = input.budget ?? { steps: RULE_PROBLEM_LIMITS.steps };
  if (budget.steps <= 0) return [];
  const work = ruleWorkFor(input, budget);
  const problems: PermissionRuleProblem[] = [];
  for (const rule of input.rules) {
    const shown = problems.length;
    try {
      checkRule(rule, input, work, problems);
    } catch (err) {
      if (!(err instanceof RuleChecksSpent)) throw err;
      // A spent budget's answers prove nothing: this rule is unchecked.
      problems.length = shown;
      problems.push({
        type: rule.type,
        pattern: rule.pattern,
        code: "rule-not-checked",
        message: `rule "${rule.type} ${rule.pattern}": the permission rule checks do a bounded amount of work and stopped here, so this rule, the rules after it and any later list were not checked for a tool name or argument that can never match.`,
      });
      return problems;
    }
  }
  return problems;
}

/** The findings for one rule, added to `problems`; see {@link permissionRuleProblems}. */
function checkRule(
  rule: { readonly type: string; readonly pattern: string },
  input: PermissionRuleProblemsInput,
  work: RuleWork,
  problems: PermissionRuleProblem[],
): void {
  // Every rule's text is read a few times (split, its fixed start and
  // letters, the declared servers it reaches) and compiled once.
  work.spend(RULE_TEXT_STEPS * rule.pattern.length + 1);
  let compiled: CompiledPattern;
  try {
    compiled = work.compile(rule.pattern);
  } catch (err) {
    if (err instanceof PatternParseError) return; // reported as malformed elsewhere
    throw err;
  }
  const { tool: toolGlob, arg } = split(rule.pattern);
  const report = (code: PermissionRuleProblemCode, message: string, suggestion?: string) =>
    problems.push({
      type: rule.type,
      pattern: rule.pattern,
      code,
      message,
      ...(suggestion !== undefined ? { suggestion } : {}),
    });

  const matched = work
    .reaching(compiled, input.granted, "name")
    .map((at) => input.granted[at] as RuleToolDescriptor);
  if (matched.length === 0) {
    // A glob that can still match a declared MCP server's tools is not
    // dead: `*write*` fires on mcp__fs__write_file. When it also resembles
    // a GRANTED builtin it does not reach, say so, name the builtin, and
    // offer no rewrite — the rule means something already.
    const reachable = mcpServersReached(toolGlob, work.servers());
    if (reachable.length > 0) {
      // An exact name that addresses a declared server is an MCP rule: it
      // names one tool, and `web__fetch` is not a misspelled WebFetch.
      if (!GLOB_META.test(toolGlob)) return;
      const missed = toolsMisspelled(compiled, toolGlob, input.granted, work);
      if (missed.length > 0) {
        const names = missed.map((t) => t.name);
        const one = names.length === 1;
        report(
          "builtin-not-reached",
          `rule "${rule.pattern}" can match tools of the MCP server${reachable.length === 1 ? "" : "s"} ${listNames(reachable)}, but no granted builtin: a rule is matched against a tool's exact name, and it does not match ${listNames(names)}, whose ${one ? "key or spelling" : "keys or spellings"} it resembles. If it is meant for ${one ? "that tool" : "those tools"} too, add a rule that names ${one ? "it" : "them"}: ${listNames(names)}.`,
        );
      }
      return;
    }
    // Written with spec keys? The glob is tried against every tool's KEY,
    // not only with its first letter capitalised: `codegraph*` reaches the
    // keys codegraphSearch… whose names are CodeGraphSearch…, and `*script`
    // reaches javascript, whose name is JavaScript.
    const pool = work.pool();
    const byName = new Map<string, RuleToolDescriptor>();
    for (const at of work.reaching(compiled, pool, "key")) {
      const t = pool[at] as RuleToolDescriptor;
      if (t.key !== t.name && !work.matches(compiled, t.name)) byName.set(t.name, t);
    }
    if (byName.size > 0) {
      const names = [...byName.keys()].sort();
      // A rewrite is offered only when one re-cased glob reaches exactly
      // these tools by name, no more and no fewer.
      const candidate = recasedGlob(toolGlob, names[0] as string);
      let fixed: string | undefined;
      if (candidate !== undefined) {
        const next = withTool(rule.pattern, candidate);
        const nextCompiled = work.compile(next);
        const reached = new Set(
          work
            .reaching(nextCompiled, pool, "name")
            .map((at) => (pool[at] as RuleToolDescriptor).name),
        );
        if (reached.size === names.length && names.every((n) => reached.has(n))) fixed = next;
      }
      const shown = names.length > 6 ? [...names.slice(0, 5), `${names.length - 5} more`] : names;
      const list =
        shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
      const advice =
        fixed !== undefined
          ? `Write "${fixed}".`
          : `Name ${names.length === 1 ? "it" : "them"} by name: ${list}.`;
      const only = names.length === 1 ? byName.get(names[0] as string) : undefined;
      report(
        "tool-key-not-name",
        only !== undefined
          ? `rule "${rule.pattern}" ${GLOB_META.test(toolGlob) ? `matches ${only.key}` : `names ${toolGlob}`}, the key a spec lists the tool under, but a rule is matched against the tool's name, ${only.name}, so this rule never fires. ${advice}`
          : `rule "${rule.pattern}" matches the keys a spec lists ${list} under, but a rule is matched against each tool's name, so this rule never fires. ${advice}`,
        fixed,
      );
      return;
    }
    // Written with a spec key the descriptors do not carry? Rules are
    // matched against the registered name, which starts with a capital.
    const capitalised = toolGlob.charAt(0).toUpperCase() + toolGlob.slice(1);
    if (capitalised !== toolGlob) {
      const fixed = withTool(rule.pattern, capitalised);
      const fixedCompiled = work.compile(fixed);
      let hit: RuleToolDescriptor | undefined;
      for (const at of work.reaching(fixedCompiled, pool, "name")) {
        const t = pool[at] as RuleToolDescriptor;
        if (!work.matches(compiled, t.name)) {
          hit = t;
          break;
        }
      }
      if (hit !== undefined) {
        report(
          "tool-key-not-name",
          hit.key !== undefined
            ? `rule "${rule.pattern}" names ${toolGlob}, the key a spec lists the tool under, but a rule is matched against the tool's name, ${hit.name}, so this rule never fires. Write "${fixed}".`
            : `rule "${rule.pattern}" names ${toolGlob}, but a rule is matched against the tool's name, ${hit.name}, so this rule never fires. Write "${fixed}".`,
          fixed,
        );
        return;
      }
    }
    if (toolGlob.startsWith("mcp__")) {
      const rest = toolGlob.slice(5);
      // A declared key may itself contain `__` (0.7.0 ran such keys), so
      // the server is found by the keys, not by splitting the name.
      if ([...work.servers()].some((s) => rest.startsWith(`${s}__`))) return;
      const server = rest.split("__")[0] ?? "";
      if (server !== "" && !GLOB_META.test(server) && !work.isServer(server)) {
        report(
          "unknown-mcp-server",
          `rule "${rule.pattern}" names the MCP server "${server}", which this spec does not declare, so it never fires. Declare it under mcp_servers, or remove the rule.`,
        );
      }
      return;
    }
    // Spelled another way? A rule is matched exactly, so REMOVEPATH,
    // remove_path, `web fetch` and Codegraph* never fire on RemovePath,
    // WebFetch or CodeGraphSearch (C146).
    const misspelled = toolsMisspelled(compiled, toolGlob, pool, work);
    if (misspelled.length > 0) {
      const names = misspelled.map((t) => t.name);
      const one = names.length === 1;
      // Following a rewrite of an allow must not grant a tool that can
      // change or delete things on a guess about the spelling.
      const widens =
        rule.type === "alwaysAllow" &&
        misspelled.some((t) => t.destructive !== false || t.requiresSandbox !== false);
      let fixed: string | undefined;
      if (!GLOB_META.test(toolGlob)) {
        if (one) fixed = withTool(rule.pattern, names[0] as string);
      } else {
        const candidate = recasedGlob(work.fold(toolGlob), names[0] as string);
        if (candidate !== undefined) {
          const next = withTool(rule.pattern, candidate);
          const nextCompiled = work.compile(next);
          const reached = new Set(
            work
              .reaching(nextCompiled, pool, "name")
              .map((at) => (pool[at] as RuleToolDescriptor).name),
          );
          if (reached.size === names.length && names.every((n) => reached.has(n))) fixed = next;
        }
      }
      const list = listNames(names);
      const advice =
        fixed !== undefined && widens
          ? `${one ? `${list} is a tool that` : `${list} are tools that`} may change or delete things, so no fix is offered: write "${fixed}" only if you mean to allow ${one ? "it" : "them"}, or remove the rule.`
          : widens
            ? `${one ? `${list} is a tool that` : `${list} are tools that`} may change or delete things, so no fix is offered: name ${one ? "it" : "them"} only if you mean to allow ${one ? "it" : "them"}, or remove the rule.`
            : fixed !== undefined
              ? `Write "${fixed}".`
              : `Name ${one ? "it" : "them"} by name: ${list}.`;
      report(
        "unknown-tool",
        `rule "${rule.pattern}" matches no tool, so it never fires: a rule is matched against a tool's name exactly (case, "_", "-" and spaces count), and ${one ? `the name is ${list}` : `the names are ${list}`}. ${advice}`,
        widens ? undefined : fixed,
      );
      return;
    }
    if (!GLOB_META.test(toolGlob) && !work.isKnownName(toolGlob)) {
      const near = work
        .nearNames(toolGlob, 2)
        .sort((a, b) => a.d - b.d || (a.name < b.name ? -1 : 1));
      const best = near[0];
      const tied = best === undefined ? [] : near.filter((c) => c.d === best.d);
      if (best === undefined || tied.length > 1) {
        // Known to nothing, and close to no one tool (or to several alike):
        // say so, without a fix, and without calling it dead outright.
        report(
          "tool-not-known",
          `rule "${rule.pattern}" names ${toolGlob}, which is no builtin and no tool the runtime adds${
            tied.length > 1 ? ` (it is equally close to ${listNames(tied.map((c) => c.name))})` : ""
          }, so it never fires unless a plugin, a custom tool or an MCP server's "<server>__<tool>" spelling registers a tool by that name. Check the name, or remove the rule.`,
        );
      } else {
        const fixed = withTool(rule.pattern, best.name);
        const widens =
          rule.type === "alwaysAllow" &&
          (best.tool.destructive !== false || best.tool.requiresSandbox !== false);
        if (widens) {
          report(
            "unknown-tool",
            `rule "${rule.pattern}" matches no tool, so it never fires. The nearest name is ${best.name}, which may change or delete things, so it is not offered as the fix: write "${fixed}" only if you mean to allow ${best.name}, or remove the rule.`,
          );
        } else {
          report(
            "unknown-tool",
            `rule "${rule.pattern}" matches no tool. Did you mean ${best.name}? Write "${fixed}".`,
            fixed,
          );
        }
      }
    }
    return;
  }

  if (arg === null) return;
  // The argument half is checked against every granted tool the tool half
  // reaches. It is a finding only when it is wrong for all of them.
  let notScoped = 0;
  let cannotMatch = 0;
  // Whether the argument can match a URL depends on the argument alone: it
  // is read once, however many tools the rule reaches (its text is charged
  // with the rule's).
  let canMatchUrlOf: boolean | undefined;
  const canMatchUrl = (): boolean => {
    if (canMatchUrlOf === undefined) canMatchUrlOf = argGlobCanMatchUrl(arg);
    return canMatchUrlOf;
  };
  for (const tool of matched) {
    const declared = tool.operativeArgs;
    if (declared === undefined) break;
    work.spend(1 + declared.length);
    if (declared.length === 0) {
      notScoped++;
      continue;
    }
    if (declared.every((a) => a.kind === "url") && !canMatchUrl()) {
      // A deny or ask on an API root (a url that is its own service, as
      // RateLimitStatus's baseUrl) also reads its host alone, and every
      // string of a call as 0.7.0 did: `RateLimitStatus(ghe.example.com/**)`
      // fires. Only an allow, which reads the URL alone, never matches.
      if (rule.type !== "alwaysAllow" && declared.some(isApiRoot)) break;
      cannotMatch++;
      continue;
    }
    break;
  }
  const named = (): string => {
    work.spend(matched.reduce((n, t) => n + t.name.length + 2, 1));
    return matched.map((t) => t.name).join(", ");
  };
  if (cannotMatch > 0 && notScoped + cannotMatch === matched.length) {
    const names = named();
    const fixedArg = withoutMethodPrefix(arg);
    const fixed = fixedArg !== undefined ? `${toolGlob}(${fixedArg})` : undefined;
    report(
      "argument-cannot-match",
      `rule "${rule.pattern}" can never match: a rule on ${names} is checked against its URL, and a URL starts with its scheme, such as https:. ${
        fixed !== undefined
          ? `Write "${fixed}".`
          : `Write the URL pattern, e.g. "${toolGlob}(https://api.example.com/**)".`
      }`,
      fixed,
    );
  } else if (notScoped === matched.length) {
    const names = named();
    report(
      "argument-not-scoped",
      `rule "${rule.pattern}" has an argument pattern, but ${names} has no argument that says where it acts, so the pattern is checked against the text of each call, not a place. To cover every call, write "${toolGlob}".`,
      toolGlob,
    );
  }
}

/** One list of permission patterns a spec carries, each typed the way the engine applies it. */
export type PermissionRuleList = {
  /** Where it sits in the spec, e.g. `models.fast.permissions.deny`. */
  readonly path: string;
  readonly rules: ReadonlyArray<{ readonly type: string; readonly pattern: string }>;
};

/**
 * Every list of permission patterns a spec document carries (as parsed,
 * before lowering), in document order:
 *
 * - the shape's `permissions.rules`;
 * - each model profile's `models.<name>.permissions.deny` / `ask`, and each
 *   pool candidate's own (`….model_pool.candidates[i].permissions.deny` /
 *   `ask`) — they narrow whatever the profile or candidate serves;
 * - each sub-agent's `….sub_agents.<name>.permissions.allow` / `deny` —
 *   they replace or narrow the parent's for the sub-agent (`agent.sub_agents`
 *   on the cli and channel shapes, `roles.<role>.sub_agents` on a crew).
 *
 * All of them are matched against a tool's registered name, so a spec key or
 * a misspelling is as dead in one as in another (C146). `crewhaus lint`,
 * `compile` and `PermissionAudit` read the lists from here, so the three
 * cannot disagree about which lists exist.
 */
export function specPermissionRuleLists(spec: unknown): PermissionRuleList[] {
  const lists: PermissionRuleList[] = [];
  const record = (v: unknown): Record<string, unknown> | undefined =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  const patterns = (type: string, value: unknown) =>
    Array.isArray(value)
      ? value
          .filter((p): p is string => typeof p === "string")
          .map((pattern) => ({ type, pattern }))
      : [];
  const typedLists = (
    at: string,
    block: Record<string, unknown>,
    fields: ReadonlyArray<readonly [string, string]>,
  ): void => {
    for (const [field, type] of fields) {
      const rules = patterns(type, block[field]);
      if (rules.length > 0) lists.push({ path: `${at}.${field}`, rules });
    }
  };
  const top = record(record(spec)?.["permissions"]);
  const topRules: Array<{ type: string; pattern: string }> = [];
  if (Array.isArray(top?.["rules"])) {
    for (const raw of top["rules"] as unknown[]) {
      const rule = record(raw);
      if (typeof rule?.["type"] === "string" && typeof rule["pattern"] === "string") {
        topRules.push({ type: rule["type"], pattern: rule["pattern"] });
      }
    }
  }
  if (topRules.length > 0) lists.push({ path: "permissions.rules", rules: topRules });
  // `segments` holds each key, and `[i]` for an array element.
  const visit = (node: unknown, segments: readonly string[], depth: number): void => {
    if (depth > 16) return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, [...segments, `[${i}]`], depth + 1));
      return;
    }
    const map = record(node);
    if (map === undefined) return;
    const n = segments.length;
    const at = segments.reduce(
      (acc, s) => (s.startsWith("[") ? `${acc}${s}` : acc === "" ? s : `${acc}.${s}`),
      "",
    );
    const perms = n > 0 ? record(map["permissions"]) : undefined;
    if (perms !== undefined) {
      if (n >= 2 && segments[n - 2] === "sub_agents") {
        typedLists(`${at}.permissions`, perms, [
          ["allow", "alwaysAllow"],
          ["deny", "alwaysDeny"],
        ]);
      } else if (
        (n === 2 && segments[0] === "models") ||
        (n >= 3 && segments[n - 2] === "candidates" && segments[n - 3] === "model_pool")
      ) {
        typedLists(`${at}.permissions`, perms, [
          ["deny", "alwaysDeny"],
          ["ask", "alwaysAsk"],
        ]);
      }
    }
    for (const [key, value] of Object.entries(map)) {
      if (key === "permissions" || key === "mcp_servers" || key === "tool_config") continue;
      visit(value, [...segments, key], depth + 1);
    }
  };
  visit(spec, [], 0);
  return lists;
}

// ---------------------------------------------------------------------------
// A deny or ask an allow above it always beats
// ---------------------------------------------------------------------------

/** A shadowed rule, and the list that holds it. */
export type ShadowedRuleProblem = PermissionRuleProblem & {
  /** Where the shadowed rule sits, e.g. `permissions.rules`. */
  readonly list: string;
  /**
   * The allow that decides every call the rule would. Absent exactly on the
   * `order-not-checked` note, which names no allow.
   */
  readonly shadowedBy?: string;
};

/**
 * How much work one {@link shadowedPermissionRules} call does at most, over
 * every list it reads. `pairs`: how many (deny or ask, allow above it) pairs
 * of tool patterns it compares with automaton inclusion, which is a deny's
 * comparison with each bare allow whose tool pattern holds a wildcard. An
 * allow whose tool pattern is a literal name costs no pair: it covers a deny
 * exactly when the deny names the same tool, which is a string comparison.
 * `steps`: how much work the comparisons do together, counted as
 * {@link InclusionBudget} counts it, plus a few steps for each character of
 * each rule's text, which is compiled and read once, so a few very long
 * patterns are bounded as well as many short ones. On a list of ordinary
 * rules, MCP tool names included, neither bound is reached.
 */
export const RULE_ORDER_LIMITS = { pairs: 1 << 17, steps: 1 << 23 } as const;

/** Steps of {@link RULE_ORDER_LIMITS} charged per character of a rule's text, compiled and read once. */
const ORDER_TEXT_STEPS = 2;

/** Options for {@link shadowedPermissionRules}. */
export type ShadowedRuleOptions = {
  /**
   * The spec's `permissions.mode`. Under `plan`, which reads no allow, a
   * shadowed rule still fires as the spec runs: it is reported as the note
   * `shadowed-outside-plan`, never as `shadowed-by-allow`.
   */
  readonly mode?: string;
  /**
   * Tighter (or, in a test, looser) bounds than {@link RULE_ORDER_LIMITS},
   * for tests and callers that need one; a bound left out is the default.
   */
  readonly limits?: { readonly pairs?: number; readonly steps?: number };
};

/**
 * The deny and ask rules that can never fire because an allow read before
 * them, in the same layer, matches every call they match: the engine takes
 * the first matching rule, so the allow decides.
 *
 * Only what can be proven is reported. That is an allow with no argument
 * pattern (`alwaysAllow Bash`) whose tool pattern matches every tool name
 * the deny's does — shown with the matcher's own automaton inclusion
 * ({@link globIncludedIn}), whatever the deny's argument. An allow scoped to
 * an argument never covers every call a deny reads: a deny also fires on a
 * path outside the workspace, on another letter case or spelling of a value,
 * on a call with several values, and on a shell line of several commands,
 * none of which a scoped allow grants. So a scoped allow is never reported,
 * however wide.
 *
 * Plan mode reads no allow rule, so a shadowed deny still acts there. In a
 * spec whose mode is `plan` (see {@link ShadowedRuleOptions}), every list
 * runs in plan mode — a sub-agent inherits its parent's mode — so each hit
 * is a note that the rule stops firing in any other mode, not a dead rule.
 *
 * Two orders are read. A list (`permissions.rules`) top to bottom. And a
 * sub-agent's `permissions.allow` then its `permissions.deny`, which is the
 * order its rules are read in when they replace the parent's.
 *
 * The whole call does a bounded amount of work ({@link RULE_ORDER_LIMITS},
 * or `opts.limits`): at most `pairs` comparisons of a deny or ask with a
 * wildcard allow above it, and at most `steps` of work across them and the
 * reading of each rule's text. An allow that names one tool is compared by
 * that name, at no pair, so on a list of ordinary rules the findings are
 * those of a check with no bound. When a bound is reached, the check stops
 * there: the findings already shown are kept, and one `order-not-checked`
 * note names the rule and the list where it stopped. Nothing after that rule
 * is checked, in that list or a later one.
 */
export function shadowedPermissionRules(
  lists: ReadonlyArray<PermissionRuleList>,
  opts: ShadowedRuleOptions = {},
): ShadowedRuleProblem[] {
  const plan = opts.mode === "plan";
  const code: PermissionRuleProblemCode = plan ? "shadowed-outside-plan" : "shadowed-by-allow";
  // Under plan mode the rule is live: say when it would stop firing.
  const lead = (rule: { readonly type: string; readonly pattern: string }): string =>
    plan
      ? `rule "${rule.type} ${rule.pattern}" fires in this spec's plan mode, which reads no allow, and in no other mode (\`--permission-mode\` sets one):`
      : `rule "${rule.type} ${rule.pattern}" never fires outside plan mode:`;
  const budget: OrderBudget = {
    pairs: opts.limits?.pairs ?? RULE_ORDER_LIMITS.pairs,
    inclusion: { steps: opts.limits?.steps ?? RULE_ORDER_LIMITS.steps },
  };
  const out: ShadowedRuleProblem[] = [];
  const stopAt = (
    rule: { readonly type: string; readonly pattern: string },
    list: string,
  ): ShadowedRuleProblem[] => {
    out.push({
      type: rule.type,
      pattern: rule.pattern,
      code: "order-not-checked",
      message: `rule "${rule.type} ${rule.pattern}" in ${list}: the rule-order check does a bounded amount of work and stopped here, so this rule, the rules after it and any later list were not checked for an allow above them that always matches first.`,
      list,
    });
    return out;
  };
  for (const list of lists) {
    const found = shadowsIn(list.rules, budget);
    for (const hit of found.hits) {
      out.push({
        type: hit.rule.type,
        pattern: hit.rule.pattern,
        code,
        message: `${lead(hit.rule)} "alwaysAllow ${hit.allow}", above it in the same list, matches every call it matches, and the first rule that matches a call decides it. Move it above "alwaysAllow ${hit.allow}".`,
        list: list.path,
        shadowedBy: hit.allow,
      });
    }
    if (found.stoppedAt !== undefined) return stopAt(found.stoppedAt, list.path);
  }
  const allowLists = new Map<string, PermissionRuleList>();
  for (const list of lists) {
    if (list.path.endsWith(".permissions.allow")) {
      allowLists.set(list.path.slice(0, -".allow".length), list);
    }
  }
  for (const list of lists) {
    if (!list.path.endsWith(".permissions.deny")) continue;
    const allow = allowLists.get(list.path.slice(0, -".deny".length));
    if (allow === undefined) continue;
    const combined = [...allow.rules, ...list.rules];
    const found = shadowsIn(combined, budget);
    for (const hit of found.hits) {
      out.push({
        type: hit.rule.type,
        pattern: hit.rule.pattern,
        code,
        message: `${lead(hit.rule)} a sub-agent's allow list is read before its deny list, and "alwaysAllow ${hit.allow}" in ${allow.path} matches every call it matches. Narrow that allow to what the sub-agent should run, so the deny is reached.`,
        list: list.path,
        shadowedBy: hit.allow,
      });
    }
    if (found.stoppedAt !== undefined) return stopAt(found.stoppedAt, list.path);
  }
  return out;
}

/** What one {@link shadowedPermissionRules} call may still spend. */
type OrderBudget = {
  /** Pair comparisons left. */
  pairs: number;
  /** Automaton work left, spent by {@link globIncludedIn}. */
  readonly inclusion: InclusionBudget;
};

/**
 * The deny and ask rules an earlier bare allow shadows, with the first such
 * allow. An allow whose tool pattern is a literal covers exactly the deny
 * whose tool pattern is the same literal (escapes resolved): every wildcard
 * matches more than one name. So the literal allows are looked up by name,
 * at no pair, and only the wildcard allows above the first literal one that
 * matches are compared by automaton inclusion. Each such comparison spends
 * one pair of `budget`, and its automaton work spends `budget.inclusion`, as
 * does each rule's text before it is read. When either bound is reached,
 * `stoppedAt` is the rule being checked: it and every rule after it are
 * unchecked, and `hits` holds what was shown before it.
 */
function shadowsIn(
  rules: ReadonlyArray<{ readonly type: string; readonly pattern: string }>,
  budget: OrderBudget,
): {
  readonly hits: ReadonlyArray<{
    readonly rule: { readonly type: string; readonly pattern: string };
    readonly allow: string;
  }>;
  readonly stoppedAt?: { readonly type: string; readonly pattern: string };
} {
  const hits: Array<{
    readonly rule: { readonly type: string; readonly pattern: string };
    readonly allow: string;
  }> = [];
  // The bare allows with a wildcard in their tool pattern, in order, each
  // with its position among all the rules; and each literal one's tool name,
  // with the first allow that names it.
  const wildcardAllows: Array<{
    readonly pattern: string;
    readonly toolGlob: string;
    readonly at: number;
  }> = [];
  const literalAllows = new Map<string, { readonly pattern: string; readonly at: number }>();
  for (const [at, rule] of rules.entries()) {
    // Each rule's text is compiled and read once, charged by its length.
    budget.inclusion.steps -= ORDER_TEXT_STEPS * rule.pattern.length + 1;
    if (budget.inclusion.steps <= 0) return { hits, stoppedAt: rule };
    let compiled: ReturnType<typeof compilePattern>;
    try {
      compiled = compilePattern(rule.pattern);
    } catch {
      // A malformed allow grants nothing; a malformed deny is reported as
      // malformed elsewhere, and the engine treats it as matching everything.
      continue;
    }
    if (rule.type === "alwaysAllow") {
      if (compiled.argGlob === null) {
        if (!compiled._toolRe.isLiteral) {
          wildcardAllows.push({ pattern: rule.pattern, toolGlob: compiled.toolGlob, at });
        } else {
          const name = literalPrefix(compiled.toolGlob);
          if (!literalAllows.has(name)) literalAllows.set(name, { pattern: rule.pattern, at });
        }
      }
      continue;
    }
    if (rule.type !== "alwaysDeny" && rule.type !== "alwaysAsk") continue;
    const named = compiled._toolRe.isLiteral
      ? literalAllows.get(literalPrefix(compiled.toolGlob))
      : undefined;
    let covering = named?.pattern;
    for (const allow of wildcardAllows) {
      // An allow below the first literal one that names this tool is never
      // the first that covers it.
      if (named !== undefined && allow.at > named.at) break;
      if (budget.pairs <= 0) return { hits, stoppedAt: rule };
      budget.pairs -= 1;
      const covered = globIncludedIn(compiled.toolGlob, allow.toolGlob, budget.inclusion);
      // A spent budget's `false` proves nothing: the rule is unchecked.
      if (budget.inclusion.steps <= 0) return { hits, stoppedAt: rule };
      if (covered) {
        covering = allow.pattern;
        break;
      }
    }
    if (covering !== undefined) hits.push({ rule, allow: covering });
  }
  return { hits };
}
