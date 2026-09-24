import {
  type CharSet,
  DIGIT,
  EMPTY,
  SPACE,
  UNIVERSAL,
  WORD,
  complement,
  dot,
  fold,
  intersects,
  isEmpty,
  range,
  single,
  union,
} from "./charset";

/**
 * Compiling and screening a CALLER-SUPPLIED regular expression.
 *
 * "Caller-supplied" means the model or an operator wrote the pattern, and so
 * a prompt injection can too. Three things are checked, cheapest first: the
 * pattern's length, its flags, and whether the engine accepts it at all. A
 * pattern that passes those is then screened for the shapes that make a
 * backtracking engine take exponential time.
 *
 * THE SCREEN IS THE SECOND LAYER, NEVER THE FIRST. It recognises the known
 * catastrophic shapes by structure; it cannot prove a pattern is fast, and
 * polynomial blow-ups (`\s+$` on a long run of spaces is quadratic) are not
 * shapes it looks for. The bound that always holds is the deadline in
 * `runRegex`, which runs the match in a worker it can abandon. The screen
 * exists because of what JavaScriptCore does on the way to that deadline: it
 * abandons a match after a fixed backtracking budget and reports "no match",
 * with no error and nothing else to tell the two apart (see the README). A
 * pattern refused here never reaches that point.
 */

/** Why a pattern was refused. Stable strings: callers may switch on them. */
export type RegexRejectCode =
  /** Longer than `maxPatternChars`. */
  | "pattern-too-long"
  /** Not a string of JavaScript regex flags, or a flag repeated. */
  | "invalid-flags"
  /** A real flag the caller's policy does not permit. */
  | "flag-not-allowed"
  /** The engine rejected the pattern. */
  | "invalid-syntax"
  /**
   * A repeated group whose body can itself match a varying amount of text,
   * with nothing that marks where one repetition ends: `(a+)+`,
   * `(\w{1,})*`, `(\w+\s?)+`, `(.*a){12}`. On a non-matching input the
   * engine tries every way of splitting the text between repetitions.
   */
  | "nested-quantifier"
  /**
   * A repeated group containing an alternation whose branches can begin with
   * the same character: `(a|a)*`, `(\w|\d)*`, `(a|ab)+`. Each repetition
   * doubles the number of ways to match.
   */
  | "overlapping-alternation"
  /**
   * The engine accepted the pattern but the screen could not analyse it.
   * Refused rather than waved through — a screen that gives up must not say
   * "safe".
   */
  | "unanalysable";

export type RegexRejection = {
  readonly ok: false;
  readonly code: RegexRejectCode;
  /** One sentence, written for whoever supplied the pattern — usually a model. */
  readonly reason: string;
  /** The offending part of the pattern, when there is one. */
  readonly fragment?: string;
};

export type RegexLimits = {
  /** Longest pattern accepted, in UTF-16 code units. Default 1000. */
  readonly maxPatternChars?: number;
  /**
   * Flags the caller permits. Default `"dgimsuvy"` — every flag the engine
   * knows. Narrow it where a flag changes meaning: a tool that reports
   * matches per line has no use for `y`.
   */
  readonly allowedFlags?: string;
};

export const REGEX_LIMIT_DEFAULTS = {
  maxPatternChars: 1_000,
  allowedFlags: "dgimsuvy",
} as const;

const KNOWN_FLAGS = "dgimsuvy";

/**
 * Validate and compile a caller-supplied pattern.
 *
 * Returns the compiled `RegExp` only when the pattern passes every check,
 * including the shape screen. Running that `RegExp` synchronously over
 * untrusted text is still unbounded — the screen is not a proof of speed —
 * so a tool that matches caller patterns against caller-sized input runs
 * them through `runRegex` instead. This function is for the other uses: a
 * schema that must refuse a bad pattern up front, or matching against input
 * the tool itself keeps small.
 */
export function compileUserRegex(
  pattern: string,
  flags = "",
  limits: RegexLimits = {},
): { readonly ok: true; readonly regex: RegExp } | RegexRejection {
  const maxChars = limits.maxPatternChars ?? REGEX_LIMIT_DEFAULTS.maxPatternChars;
  const allowed = limits.allowedFlags ?? REGEX_LIMIT_DEFAULTS.allowedFlags;
  if (typeof pattern !== "string") {
    return reject("invalid-syntax", "the pattern must be a string");
  }
  if (pattern.length > maxChars) {
    return reject(
      "pattern-too-long",
      `the pattern is ${pattern.length} characters; the limit is ${maxChars}`,
    );
  }
  if (typeof flags !== "string") {
    return reject("invalid-flags", "the flags must be a string");
  }
  const seen = new Set<string>();
  for (const flag of flags) {
    if (!KNOWN_FLAGS.includes(flag)) {
      return reject("invalid-flags", `"${flag}" is not a regular-expression flag`);
    }
    if (seen.has(flag)) return reject("invalid-flags", `the flag "${flag}" is repeated`);
    seen.add(flag);
    if (!allowed.includes(flag)) {
      return reject(
        "flag-not-allowed",
        `the flag "${flag}" is not allowed here (allowed: ${allowed || "none"})`,
      );
    }
  }
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reject("invalid-syntax", `the pattern is not a valid regular expression: ${message}`);
  }
  const shape = screenShape(pattern, flags);
  if (shape !== null) return shape;
  return { ok: true, regex };
}

/**
 * The same checks as {@link compileUserRegex}, for a call site that must stay
 * synchronous and has no use for the compiled value — a zod `refine`, say.
 * Returns the same codes and reasons.
 */
export function screenUserRegex(
  pattern: string,
  flags = "",
  limits: RegexLimits = {},
): { readonly ok: true } | RegexRejection {
  const compiled = compileUserRegex(pattern, flags, limits);
  return compiled.ok ? { ok: true } : compiled;
}

function reject(code: RegexRejectCode, reason: string, fragment?: string): RegexRejection {
  return fragment === undefined
    ? { ok: false, code, reason }
    : { ok: false, code, reason, fragment };
}

// ─── Parser ─────────────────────────────────────────────────────────────────
//
// Only ever run on a pattern the engine has already accepted, so it is
// lenient: its job is to recover structure, not to validate. Anything it
// cannot place is modelled as matching anything (UNIVERSAL), which errs
// toward refusing.

type Span = { readonly start: number; readonly end: number };

type GroupNode = { readonly t: "group"; readonly look: boolean; readonly alts: Node[][] } & Span;

type Node =
  | ({ readonly t: "char"; readonly set: CharSet } & Span)
  | ({ readonly t: "assert" } & Span)
  | ({ readonly t: "backref" } & Span)
  | GroupNode
  | ({
      readonly t: "quant";
      readonly node: Node;
      readonly min: number;
      readonly max: number;
    } & Span);

type Mode = {
  readonly unicode: boolean;
  readonly unicodeSets: boolean;
  readonly dotAll: boolean;
  foldCase: boolean;
};

class UnanalysableError extends Error {}

const BRACE_QUANTIFIER = /^\{(\d+)(?:(,)(\d*))?\}/;
const LEGACY_OCTAL = /^[0-7]{1,3}/;
const HEX_DIGITS = /^[0-9a-fA-F]+$/;

class Parser {
  private i = 0;

  constructor(
    private readonly src: string,
    private readonly mode: Mode,
  ) {}

  parse(): Node[][] {
    const alts = this.alternation();
    if (this.i < this.src.length) throw new UnanalysableError(`stray "${this.src[this.i]}"`);
    return alts;
  }

  private peek(offset = 0): string | undefined {
    return this.src[this.i + offset];
  }

  private alternation(): Node[][] {
    const alts: Node[][] = [this.sequence()];
    while (this.peek() === "|") {
      this.i += 1;
      alts.push(this.sequence());
    }
    return alts;
  }

  private sequence(): Node[] {
    const seq: Node[] = [];
    while (this.i < this.src.length && this.peek() !== "|" && this.peek() !== ")") {
      const start = this.i;
      const atom = this.atom();
      seq.push(this.quantified(atom, start));
    }
    return seq;
  }

  private quantified(atom: Node, start: number): Node {
    const c = this.peek();
    let min: number;
    let max: number;
    if (c === "*") {
      min = 0;
      max = Number.POSITIVE_INFINITY;
      this.i += 1;
    } else if (c === "+") {
      min = 1;
      max = Number.POSITIVE_INFINITY;
      this.i += 1;
    } else if (c === "?") {
      min = 0;
      max = 1;
      this.i += 1;
    } else if (c === "{") {
      const brace = this.src.slice(this.i).match(BRACE_QUANTIFIER);
      if (brace === null) return atom;
      min = Number(brace[1]);
      max =
        brace[2] === undefined
          ? min
          : brace[3] === undefined || brace[3] === ""
            ? Number.POSITIVE_INFINITY
            : Number(brace[3]);
      this.i += brace[0].length;
    } else {
      return atom;
    }
    if (this.peek() === "?") this.i += 1; // lazy: backtracks just as much on failure
    return { t: "quant", node: atom, min, max, start, end: this.i };
  }

  private atom(): Node {
    const start = this.i;
    const c = this.src[this.i] as string;
    if (c === "^" || c === "$") {
      this.i += 1;
      return { t: "assert", start, end: this.i };
    }
    if (c === ".") {
      this.i += 1;
      return { t: "char", set: dot(this.mode.dotAll), start, end: this.i };
    }
    if (c === "(") return this.group();
    if (c === "[") {
      const set = this.charClass();
      return { t: "char", set, start, end: this.i };
    }
    if (c === "\\") return this.escape();
    return { t: "char", set: this.caseSet(single(this.codePoint())), start, end: this.i };
  }

  /** One literal character, a surrogate pair counting as one under `u`/`v`. */
  private codePoint(): number {
    const cp = this.src.codePointAt(this.i) as number;
    this.i += this.mode.unicode && cp > 0xffff ? 2 : 1;
    return cp;
  }

  private caseSet(set: CharSet): CharSet {
    return this.mode.foldCase ? fold(set) : set;
  }

  private group(): Node {
    const start = this.i;
    this.i += 1; // (
    let look = false;
    const rest = this.src.slice(this.i);
    if (rest.startsWith("?:")) {
      this.i += 2;
    } else if (rest.startsWith("?=") || rest.startsWith("?!")) {
      this.i += 2;
      look = true;
    } else if (rest.startsWith("?<=") || rest.startsWith("?<!")) {
      this.i += 3;
      look = true;
    } else if (rest.startsWith("?<")) {
      const close = this.src.indexOf(">", this.i);
      if (close === -1) throw new UnanalysableError("unterminated group name");
      this.i = close + 1;
    } else if (rest.startsWith("?")) {
      // Modifiers, `(?i:…)` / `(?-i:…)`. Folding case anywhere folds it
      // everywhere, which only widens sets — the safe direction.
      const colon = this.src.indexOf(":", this.i);
      if (colon === -1) throw new UnanalysableError("unrecognised group");
      if (this.src.slice(this.i + 1, colon).includes("i")) this.mode.foldCase = true;
      this.i = colon + 1;
    }
    const alts = this.alternation();
    if (this.peek() !== ")") throw new UnanalysableError("unterminated group");
    this.i += 1;
    return { t: "group", look, alts, start, end: this.i };
  }

  private escape(): Node {
    const start = this.i;
    this.i += 1; // backslash
    const c = this.peek();
    if (c === undefined) throw new UnanalysableError("trailing backslash");
    const done = (set: CharSet): Node => ({ t: "char", set, start, end: this.i });
    if (c === "b" || c === "B") {
      this.i += 1;
      return { t: "assert", start, end: this.i };
    }
    if (c >= "1" && c <= "9") {
      while ((this.peek() ?? "") >= "0" && (this.peek() ?? "") <= "9") this.i += 1;
      return { t: "backref", start, end: this.i };
    }
    if (c === "k" && this.peek(1) === "<") {
      const close = this.src.indexOf(">", this.i);
      if (close === -1) throw new UnanalysableError("unterminated backreference");
      this.i = close + 1;
      return { t: "backref", start, end: this.i };
    }
    const cls = this.classEscape();
    if (cls !== undefined) return done(cls);
    return done(this.caseSet(single(this.characterEscape())));
  }

  /** `\d \D \w \W \s \S \p{…} \P{…}` — or undefined when the escape is not one. */
  private classEscape(): CharSet | undefined {
    const c = this.peek();
    switch (c) {
      case "d":
        this.i += 1;
        return DIGIT;
      case "D":
        this.i += 1;
        return this.caseSet(complement(DIGIT));
      case "w":
        this.i += 1;
        return this.caseSet(WORD);
      case "W":
        this.i += 1;
        return this.caseSet(complement(WORD));
      case "s":
        this.i += 1;
        return SPACE;
      case "S":
        this.i += 1;
        return this.caseSet(complement(SPACE));
      case "p":
      case "P":
        if (this.mode.unicode && this.peek(1) === "{") {
          const close = this.src.indexOf("}", this.i);
          if (close === -1) throw new UnanalysableError("unterminated property escape");
          this.i = close + 1;
          return UNIVERSAL;
        }
        return undefined;
      default:
        return undefined;
    }
  }

  /** A single-character escape; `this.i` is just past the backslash. */
  private characterEscape(): number {
    const c = this.peek() as string;
    // Every character must be a hex digit: `parseInt("1g", 16)` is 1, but
    // `\x1g` is a literal "x1g", and modelling it as U+0001 would shrink a
    // set — the unsafe direction.
    const hex = (from: number, len: number): number | undefined => {
      const digits = this.src.slice(from, from + len);
      if (digits.length !== len || !HEX_DIGITS.test(digits)) return undefined;
      return Number.parseInt(digits, 16);
    };
    switch (c) {
      case "t":
        this.i += 1;
        return 0x09;
      case "n":
        this.i += 1;
        return 0x0a;
      case "v":
        this.i += 1;
        return 0x0b;
      case "f":
        this.i += 1;
        return 0x0c;
      case "r":
        this.i += 1;
        return 0x0d;
      case "0": {
        // `\0`, or a legacy octal escape outside `u`/`v`.
        const oct = this.src.slice(this.i).match(LEGACY_OCTAL);
        const digits = this.mode.unicode ? "0" : (oct?.[0] ?? "0");
        this.i += digits.length;
        return Number.parseInt(digits, 8) & 0xff;
      }
      case "c": {
        const letter = this.peek(1) ?? "";
        if ((letter >= "a" && letter <= "z") || (letter >= "A" && letter <= "Z")) {
          this.i += 2;
          return letter.charCodeAt(0) % 32;
        }
        // Annex B: a lone `\c` is a literal backslash; the `c` is read next.
        return 0x5c;
      }
      case "x": {
        const value = hex(this.i + 1, 2);
        if (value === undefined) {
          this.i += 1;
          return 0x78;
        }
        this.i += 3;
        return value;
      }
      case "u": {
        if (this.mode.unicode && this.peek(1) === "{") {
          const close = this.src.indexOf("}", this.i);
          if (close === -1) throw new UnanalysableError("unterminated code point escape");
          const value = Number.parseInt(this.src.slice(this.i + 2, close), 16);
          this.i = close + 1;
          return value;
        }
        const value = hex(this.i + 1, 4);
        if (value === undefined) {
          this.i += 1;
          return 0x75;
        }
        this.i += 5;
        if (this.mode.unicode && value >= 0xd800 && value <= 0xdbff) {
          // A surrogate pair spelled as two escapes is one code point.
          if (this.peek() === "\\" && this.peek(1) === "u") {
            const low = hex(this.i + 2, 4);
            if (low !== undefined && low >= 0xdc00 && low <= 0xdfff) {
              this.i += 6;
              return (value - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
            }
          }
        }
        return value;
      }
      default:
        return this.codePoint(); // identity escape: `\.`, `\/`, `\-`, …
    }
  }

  /** `[…]`, returning the set it matches; `this.i` is at the `[`. */
  private charClass(): CharSet {
    if (this.mode.unicodeSets) return this.skipClassV();
    this.i += 1; // [
    let negate = false;
    if (this.peek() === "^") {
      negate = true;
      this.i += 1;
    }
    const parts: CharSet[] = [];
    while (this.peek() !== "]") {
      if (this.peek() === undefined) throw new UnanalysableError("unterminated class");
      const left = this.classAtom();
      if (this.peek() === "-" && this.peek(1) !== "]" && this.peek(1) !== undefined) {
        this.i += 1;
        const right = this.classAtom();
        if (left.cp !== undefined && right.cp !== undefined) {
          parts.push(range(left.cp, right.cp));
        } else {
          // Annex B: `[\d-z]` is a union with a literal hyphen.
          parts.push(left.set, right.set, single(0x2d));
        }
      } else {
        parts.push(left.set);
      }
    }
    this.i += 1; // ]
    const set = this.caseSet(union(...parts));
    return negate ? complement(set) : set;
  }

  private classAtom(): { readonly set: CharSet; readonly cp?: number } {
    if (this.peek() !== "\\") {
      const cp = this.codePoint();
      return { set: single(cp), cp };
    }
    this.i += 1;
    const cls = this.classEscape();
    if (cls !== undefined) return { set: cls };
    const c = this.peek() ?? "";
    if (c === "b") {
      this.i += 1;
      return { set: single(0x08), cp: 0x08 };
    }
    if (c === "-") {
      this.i += 1;
      return { set: single(0x2d), cp: 0x2d };
    }
    if (c >= "1" && c <= "9" && !this.mode.unicode) {
      // Legacy octal inside a class; `\8` and `\9` are identity escapes.
      const oct = this.src.slice(this.i).match(LEGACY_OCTAL);
      if (oct !== null) {
        this.i += oct[0].length;
        const cp = Number.parseInt(oct[0], 8) & 0xff;
        return { set: single(cp), cp };
      }
      const cp = this.codePoint();
      return { set: single(cp), cp };
    }
    const cp = this.characterEscape();
    return { set: single(cp), cp };
  }

  /**
   * A `v`-mode class, with nesting, `--` and `&&`. Modelling set operations
   * is not worth it for a screen; the class is treated as matching anything.
   */
  private skipClassV(): CharSet {
    let depth = 0;
    while (this.i < this.src.length) {
      const c = this.src[this.i];
      if (c === "\\") {
        this.i += 2;
        continue;
      }
      if (c === "[") depth += 1;
      if (c === "]") {
        depth -= 1;
        if (depth === 0) {
          this.i += 1;
          return UNIVERSAL;
        }
      }
      this.i += 1;
    }
    throw new UnanalysableError("unterminated class");
  }
}

// ─── Analysis ───────────────────────────────────────────────────────────────

/** Characters a node could ever consume. Zero-width nodes consume none. */
function consumes(node: Node): CharSet {
  switch (node.t) {
    case "char":
      return node.set;
    case "assert":
      return EMPTY;
    case "backref":
      return UNIVERSAL;
    case "group":
      return node.look ? EMPTY : union(...node.alts.flat().map(consumes));
    case "quant":
      return node.max === 0 ? EMPTY : consumes(node.node);
  }
}

/** The fixed number of characters a node consumes, or undefined if it varies. */
function fixedLength(node: Node): number | undefined {
  switch (node.t) {
    case "char":
      return 1;
    case "assert":
      return 0;
    case "backref":
      return undefined;
    case "group": {
      if (node.look) return 0;
      let length: number | undefined;
      for (const alt of node.alts) {
        let sum = 0;
        for (const n of alt) {
          const l = fixedLength(n);
          if (l === undefined) return undefined;
          sum += l;
        }
        if (length !== undefined && length !== sum) return undefined;
        length = sum;
      }
      return length ?? 0;
    }
    case "quant": {
      if (node.min !== node.max) return undefined;
      const inner = fixedLength(node.node);
      return inner === undefined ? undefined : inner * node.min;
    }
  }
}

/** Can the node match without consuming anything? */
function nullable(node: Node): boolean {
  switch (node.t) {
    case "char":
      return false;
    case "assert":
    case "backref":
      return true;
    case "group":
      return node.look || node.alts.some((alt) => alt.every(nullable));
    case "quant":
      return node.min === 0 || nullable(node.node);
  }
}

/** Characters that could be the first one a node consumes. */
function first(node: Node): CharSet {
  switch (node.t) {
    case "char":
      return node.set;
    case "assert":
      return EMPTY;
    case "backref":
      return UNIVERSAL;
    case "group":
      return node.look ? EMPTY : union(...node.alts.map(firstOfSequence));
    case "quant":
      return node.max === 0 ? EMPTY : first(node.node);
  }
}

function firstOfSequence(seq: ReadonlyArray<Node>): CharSet {
  const parts: CharSet[] = [];
  for (const node of seq) {
    parts.push(first(node));
    if (!nullable(node)) break;
  }
  return union(...parts);
}

/**
 * A sequence with every plain (unquantified, non-lookaround, single-branch)
 * group opened up, so a delimiter written inside `(?:…)` still counts.
 */
function flatten(seq: ReadonlyArray<Node>): Node[] {
  const out: Node[] = [];
  for (const node of seq) {
    if (node.t === "group" && !node.look && node.alts.length === 1) {
      out.push(...flatten(node.alts[0] as Node[]));
    } else {
      out.push(node);
    }
  }
  return out;
}

/** A node that consumes exactly one character, in place, every time: a delimiter candidate. */
function delimiterSet(node: Node): CharSet | undefined {
  if (node.t === "char") return node.set;
  if (node.t === "quant" && node.min === node.max && node.min >= 1 && node.node.t === "char") {
    return node.node.set;
  }
  return undefined;
}

/**
 * One branch of a repeated group's body is safe to repeat when either
 * nothing in it varies in length, or it contains a character it must match
 * in place that none of its varying parts can match. That character fixes
 * where each repetition ends: `(\w+\.)+` and `(\d{1,3}\.){3}` are safe,
 * `(\w+\s?)+` and `(.*a)+` are not.
 */
function branchIsDelimited(branch: ReadonlyArray<Node>): boolean {
  const flat = flatten(branch);
  const varying = flat.filter((n) => fixedLength(n) === undefined);
  if (varying.length === 0) return true;
  const varyingChars = union(...varying.map(consumes));
  return flat.some((n) => {
    const d = delimiterSet(n);
    return d !== undefined && !isEmpty(d) && !intersects(d, varyingChars);
  });
}

/** Every non-lookaround group with more than one branch, at any depth. */
function alternationsIn(nodes: ReadonlyArray<Node>, out: GroupNode[]): void {
  for (const node of nodes) {
    if (node.t === "group") {
      if (node.look) continue;
      if (node.alts.length > 1) out.push(node);
      for (const alt of node.alts) alternationsIn(alt, out);
    } else if (node.t === "quant") {
      alternationsIn([node.node], out);
    }
  }
}

function branchesOverlap(group: GroupNode): boolean {
  if (group.alts.some((alt) => alt.every(nullable))) return true;
  const firsts = group.alts.map(firstOfSequence);
  for (let i = 0; i < firsts.length; i++) {
    for (let j = i + 1; j < firsts.length; j++) {
      if (intersects(firsts[i] as CharSet, firsts[j] as CharSet)) return true;
    }
  }
  return false;
}

type Finding = {
  readonly code: "nested-quantifier" | "overlapping-alternation";
  readonly at: Span;
};

function findShape(nodes: ReadonlyArray<Node>): Finding | undefined {
  for (const node of nodes) {
    if (node.t === "group") {
      for (const alt of node.alts) {
        const inner = findShape(alt);
        if (inner !== undefined) return inner;
      }
      continue;
    }
    if (node.t !== "quant") continue;
    // Inner first, so the report names the smallest offending group.
    const inner = findShape([node.node]);
    if (inner !== undefined) return inner;
    const body = node.node;
    if (node.max < 2 || body.t !== "group" || body.look) continue;
    if (!body.alts.every(branchIsDelimited)) {
      return { code: "nested-quantifier", at: node };
    }
    const alternations: GroupNode[] = [];
    alternationsIn([body], alternations);
    if (alternations.some(branchesOverlap)) {
      return { code: "overlapping-alternation", at: node };
    }
  }
  return undefined;
}

function screenShape(pattern: string, flags: string): RegexRejection | null {
  const base = {
    unicode: flags.includes("u") || flags.includes("v"),
    unicodeSets: flags.includes("v"),
    dotAll: flags.includes("s"),
  };
  let finding: Finding | undefined;
  try {
    // A modifier group (`(?i:…)`) switches folding on part-way through the
    // parse, and folding must then apply to every set, including the ones
    // already built — so a first pass discovers it, and the pass analysed
    // is one with folding on from the start.
    const probe: Mode = { ...base, foldCase: flags.includes("i") };
    new Parser(pattern, probe).parse();
    const mode: Mode = { ...base, foldCase: probe.foldCase };
    finding = findShape(new Parser(pattern, mode).parse().flat());
  } catch (err) {
    const why = err instanceof UnanalysableError ? err.message : String(err);
    return reject(
      "unanalysable",
      `the pattern could not be checked for catastrophic backtracking (${why}); simplify it`,
    );
  }
  if (finding === undefined) return null;
  const fragment = pattern.slice(finding.at.start, finding.at.end);
  if (finding.code === "nested-quantifier") {
    return reject(
      "nested-quantifier",
      `${fragment} repeats a group whose contents can themselves match a varying amount of text, with nothing that marks where one repetition ends — on a non-matching input that takes exponential time. Remove the inner repetition (a+ instead of (a+)+), or end each repetition with a character the rest of the group cannot match ((\\w+\\s)* instead of (\\w+\\s?)*)`,
      fragment,
    );
  }
  return reject(
    "overlapping-alternation",
    `${fragment} repeats an alternation whose branches can start with the same character, so every repetition doubles the ways to match — exponential time on a non-matching input. Use a character class ([ab]* instead of (a|b)*) or make the branches start differently`,
    fragment,
  );
}
