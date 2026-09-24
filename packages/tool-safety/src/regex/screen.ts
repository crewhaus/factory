import {
  type CharSet,
  DIGIT,
  EMPTY,
  MAX_CODE_POINT,
  SPACE,
  UNIVERSAL,
  WORD,
  complement,
  dot,
  fold,
  fromRanges,
  intersects,
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
   * A repeated group whose body can end in more than one place, or split
   * the same text more than one way, with nothing that fixes where one
   * repetition ends: `(a+)+`, `(\w{1,})*`, `(\w+\s?)+`, `(.*a){12}`,
   * `(?:,\d+\d*)*`. On a non-matching input the engine tries every way of
   * splitting the text between repetitions.
   */
  | "nested-quantifier"
  /**
   * A repeated group containing an alternation whose branches can match the
   * same text: `(a|a)*`, `(\w|\d)*`, `(?:\.(?:ab|a[bc]))*`. Each repetition
   * multiplies the number of ways to match.
   */
  | "overlapping-alternation"
  /**
   * The engine accepted the pattern but the screen could not analyse it, or
   * could not finish within its work budget. Refused rather than waved
   * through — a screen that gives up must not say "safe".
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
  /**
   * Work units the shape screen may spend on one pattern before it refuses
   * it as `unanalysable`. This is what bounds the screen's own cost: it runs
   * on the caller's thread, not in the worker, so it must never take long
   * whatever the pattern. The default keeps the worst case to a few
   * milliseconds on an Apple-silicon Mac; ordinary patterns use a few
   * hundred units.
   */
  readonly maxScreenWork?: number;
};

export const REGEX_LIMIT_DEFAULTS = {
  maxPatternChars: 1_000,
  allowedFlags: "dgimsuvy",
  maxScreenWork: 200_000,
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
  const verdict = screenVerdict(pattern, flags, limits);
  if (verdict !== null) return verdict;
  return { ok: true, regex: new RegExp(pattern, flags) };
}

/**
 * The same checks as {@link compileUserRegex}, for a call site that must stay
 * synchronous and has no use for the compiled value — a zod `refine`, say.
 * Returns the same codes and reasons.
 *
 * Both run on the caller's thread. Their cost is bounded by
 * `maxPatternChars` and `maxScreenWork`, not by any deadline, and a verdict
 * is remembered: screening the same pattern again (a refine, then a run, then
 * the same rule on the next call) costs a map lookup.
 */
export function screenUserRegex(
  pattern: string,
  flags = "",
  limits: RegexLimits = {},
): { readonly ok: true } | RegexRejection {
  return screenVerdict(pattern, flags, limits) ?? { ok: true };
}

// ─── Verdict cache ──────────────────────────────────────────────────────────

/** The most recently screened patterns, least recent first. */
const verdicts = new Map<string, RegexRejection | null>();
const VERDICT_CACHE_ENTRIES = 512;
/** Longer patterns are screened every time rather than pinned in memory. */
const VERDICT_CACHE_MAX_PATTERN = 10_000;

function screenVerdict(pattern: string, flags: string, limits: RegexLimits): RegexRejection | null {
  if (typeof pattern !== "string") {
    return reject("invalid-syntax", "the pattern must be a string");
  }
  if (typeof flags !== "string") {
    return reject("invalid-flags", "the flags must be a string");
  }
  const cacheable = pattern.length <= VERDICT_CACHE_MAX_PATTERN;
  const key = cacheable
    ? `${limits.maxPatternChars ?? ""}\u0000${limits.allowedFlags ?? "\u0001"}\u0000${limits.maxScreenWork ?? ""}\u0000${flags}\u0000${pattern}`
    : "";
  if (cacheable && verdicts.has(key)) {
    const cached = verdicts.get(key) as RegexRejection | null;
    verdicts.delete(key);
    verdicts.set(key, cached);
    return cached;
  }
  const verdict = screenUncached(pattern, flags, limits);
  if (cacheable) {
    if (verdicts.size >= VERDICT_CACHE_ENTRIES) {
      verdicts.delete(verdicts.keys().next().value as string);
    }
    verdicts.set(key, verdict);
  }
  return verdict;
}

function screenUncached(
  pattern: string,
  flags: string,
  limits: RegexLimits,
): RegexRejection | null {
  const maxChars = limits.maxPatternChars ?? REGEX_LIMIT_DEFAULTS.maxPatternChars;
  const allowed = limits.allowedFlags ?? REGEX_LIMIT_DEFAULTS.allowedFlags;
  const maxWork = limits.maxScreenWork ?? REGEX_LIMIT_DEFAULTS.maxScreenWork;
  if (pattern.length > maxChars) {
    return reject(
      "pattern-too-long",
      `the pattern is ${pattern.length} characters; the limit is ${maxChars}`,
    );
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
  // The engine's own compile runs here, on the caller's thread. A property
  // escape inside a class makes it compute a set over all of Unicode (about
  // 0.1 ms each, measured on Bun 1.3.14), and a `v`-mode set operation over
  // one (`[\p{L}--[a-z]]`, `[\p{Any}&&\p{L}]`) 1–3.5 ms. They are charged to
  // the budget before anything is compiled.
  workLeft = maxWork - compileCost(pattern, flags);
  if (workLeft < 0) {
    workLeft = 0;
    return reject(
      "unanalysable",
      "the pattern could not be checked for catastrophic backtracking: it has too many Unicode property escapes or set operations inside character classes, which are slow to compile. Use fewer, or split it into several patterns",
    );
  }
  try {
    new RegExp(pattern, flags);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reject("invalid-syntax", `the pattern is not a valid regular expression: ${message}`);
  }
  return screenShape(pattern, flags, workLeft);
}

/** Work units charged for a property escape inside a character class. */
const PROPERTY_IN_CLASS_UNITS = 2_000;
/** Work units charged for a `v`-mode set operation (`--`, `&&`). */
const SET_OPERATION_UNITS = 40_000;

/** What compiling the pattern is expected to cost, in work units. */
function compileCost(pattern: string, flags: string): number {
  if (!flags.includes("u") && !flags.includes("v")) return 0;
  const sets = flags.includes("v");
  let depth = 0;
  let cost = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      const next = pattern[i + 1];
      if (depth > 0 && (next === "p" || next === "P") && pattern[i + 2] === "{") {
        cost += PROPERTY_IN_CLASS_UNITS;
      }
      i += 1;
    } else if (c === "[") {
      depth += 1;
    } else if (c === "]" && depth > 0) {
      depth -= 1;
    } else if (sets && depth > 0 && (c === "-" || c === "&") && pattern[i + 1] === c) {
      cost += SET_OPERATION_UNITS;
      i += 1;
    }
  }
  return cost;
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

// ─── Work budget ────────────────────────────────────────────────────────────
//
// The screen runs synchronously on the caller's thread, so its own cost must
// be bounded whatever the pattern. Every step of the parse and the analysis
// is charged here, and running out refuses the pattern as unanalysable.
// A unit is roughly one set range touched or one node visited.

let workLeft = 0;

function spend(units: number): void {
  workLeft -= units;
  if (workLeft < 0) throw new UnanalysableError(OUT_OF_WORK);
}

const OUT_OF_WORK = "it is too complex to check within the screen's work budget";

/** Unions and intersections, charged by the ranges they touch. */
function unionOf(sets: ReadonlyArray<CharSet>): CharSet {
  let size = 1;
  for (const set of sets) size += set.length;
  spend(size);
  return union(...sets);
}

function meets(a: CharSet, b: CharSet): boolean {
  spend(1 + ((a.length + b.length) >> 1));
  return intersects(a, b);
}

// ─── Engine-computed sets ───────────────────────────────────────────────────
//
// A Unicode property escape and a `v`-mode class are awkward to model by
// hand, and treating them as matching anything makes `^\p{L}+(?:-\p{L}+)*$`
// look undelimited. The engine knows exactly what they match, so ask it —
// for U+0000–U+00FF and the whitespace above it, which is where the
// delimiters callers write live. Every other code point above U+00FF is
// assumed to match: a superset, the safe side.

const ENGINE_SET_ENTRIES = 256;
const engineSets = new Map<string, CharSet>();

/** The code points `engineSet` tests one by one. */
const EXACT_CODE_POINTS: ReadonlyArray<number> = (() => {
  const out: number[] = [];
  for (let cp = 0; cp <= 0xff; cp++) out.push(cp);
  for (let r = 0; r + 1 < SPACE.length; r += 2) {
    for (let cp = Math.max(SPACE[r] as number, 0x100); cp <= (SPACE[r + 1] as number); cp++) {
      out.push(cp);
    }
  }
  return out;
})();

/** Everything above U+00FF except the code points tested one by one. */
const ASSUMED_ABOVE: ReadonlyArray<readonly [number, number]> = (() => {
  const out: Array<[number, number]> = [];
  let next = 0x100;
  for (const cp of EXACT_CODE_POINTS) {
    if (cp < next) continue;
    if (cp > next) out.push([next, cp - 1]);
    next = cp + 1;
  }
  out.push([next, MAX_CODE_POINT]);
  return out;
})();

function engineSet(source: string, flags: string): CharSet {
  const key = `${flags}/${source}`;
  const hit = engineSets.get(key);
  if (hit !== undefined) return hit;
  spend(512);
  let re: RegExp;
  try {
    re = new RegExp(`^(?:${source})$`, flags);
  } catch {
    return UNIVERSAL;
  }
  const ranges: Array<readonly [number, number]> = [...ASSUMED_ABOVE];
  for (const cp of EXACT_CODE_POINTS) {
    if (re.test(String.fromCodePoint(cp))) ranges.push([cp, cp]);
  }
  const set = fromRanges(ranges);
  if (engineSets.size >= ENGINE_SET_ENTRIES) engineSets.clear();
  engineSets.set(key, set);
  return set;
}

/**
 * Unicode properties of strings (`v` mode only): each matches a sequence of
 * code points, not one, so it is modelled as varying-length text.
 */
const STRING_PROPERTY =
  /\\p\{(?:Basic_Emoji|Emoji_Keycap_Sequence|RGI_Emoji_Modifier_Sequence|RGI_Emoji_Flag_Sequence|RGI_Emoji_Tag_Sequence|RGI_Emoji_ZWJ_Sequence|RGI_Emoji)\}/;

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
    spend(1);
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
      if (set === "strings") return anyText(start, this.i);
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
    return this.mode.foldCase ? fold(set, spend) : set;
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
    if (c === "p" && this.mode.unicodeSets && this.peek(1) === "{") {
      const close = this.src.indexOf("}", this.i);
      if (close !== -1 && STRING_PROPERTY.test(`\\${this.src.slice(this.i, close + 1)}`)) {
        this.i = close + 1;
        return anyText(start, this.i);
      }
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
          const text = `\\${this.src.slice(this.i, close + 1)}`;
          this.i = close + 1;
          return this.caseSet(engineSet(text, this.mode.unicodeSets ? "v" : "u"));
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

  /**
   * `[…]`, returning the set it matches, or "strings" for a `v`-mode class
   * that can match more than one code point; `this.i` is at the `[`.
   */
  private charClass(): CharSet | "strings" {
    if (this.mode.unicodeSets) return this.classV();
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
   * A `v`-mode class, with nesting, `--` and `&&`. Rather than model the set
   * operations, the screen asks the engine what the class matches (see
   * {@link engineSet}). A class holding strings (`\q{…}`, a property of
   * strings) can match several code points, so it is varying-length text.
   */
  private classV(): CharSet | "strings" {
    const start = this.i;
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
          const text = this.src.slice(start, this.i);
          if (text.includes("\\q{") || STRING_PROPERTY.test(text)) return "strings";
          return this.caseSet(engineSet(text, "v"));
        }
      }
      this.i += 1;
    }
    throw new UnanalysableError("unterminated class");
  }
}

/** A node that matches any text of one or more code points. */
function anyText(start: number, end: number): Node {
  return {
    t: "quant",
    node: { t: "char", set: UNIVERSAL, start, end },
    min: 1,
    max: Number.POSITIVE_INFINITY,
    start,
    end,
  };
}

// ─── Analysis ───────────────────────────────────────────────────────────────
//
// A backtracking engine takes exponential time on a repeated group when one
// repetition can match the same text in more than one way, or when where one
// repetition ends is not fixed: on a failing input it tries every
// combination, and the combinations multiply with each repetition. So a
// repeated group is accepted when, for its body,
//
//   - where it ends is fixed once it has started and the next character is
//     known (see `endFixed`), so each repetition ends in one place, and
//   - over a fixed stretch of text it matches in at most one way (see
//     `unambiguous`).
//
// Each check is a sufficient condition built from the sets of characters the
// parts can consume and start with, so it errs toward refusing. The final
// repetition, and whatever follows the loop, can still vary: that costs a
// polynomial factor, which the deadline bounds, not an exponential one.
//
// A repetition with a small fixed upper bound is exempt when the number of
// ways through all of it is small (`(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}`):
// the work is then a constant however ambiguous each repetition is.

/** Most distinct ways through a bounded repetition that are still accepted. */
const BOUNDED_PATHS_LIMIT = 1_024;

type Ambiguity = "alternation" | "split";

const consumesMemo = new WeakMap<Node, CharSet>();
const firstMemo = new WeakMap<Node, CharSet>();
const fixedMemo = new WeakMap<Node, number | null>();
const nullableMemo = new WeakMap<Node, boolean>();
const flatMemo = new WeakMap<ReadonlyArray<Node>, Node[]>();
const unambiguousMemo = new WeakMap<Node, Ambiguity | null>();

/** Characters a node could ever consume. Zero-width nodes consume none. */
function consumes(node: Node): CharSet {
  const hit = consumesMemo.get(node);
  if (hit !== undefined) return hit;
  spend(1);
  let out: CharSet;
  switch (node.t) {
    case "char":
      out = node.set;
      break;
    case "assert":
      out = EMPTY;
      break;
    case "backref":
      out = UNIVERSAL;
      break;
    case "group":
      out = node.look ? EMPTY : unionOf(node.alts.map((alt) => unionOf(alt.map(consumes))));
      break;
    case "quant":
      out = node.max === 0 ? EMPTY : consumes(node.node);
      break;
  }
  consumesMemo.set(node, out);
  return out;
}

/** The fixed number of characters a node consumes, or undefined if it varies. */
function fixedLength(node: Node): number | undefined {
  const hit = fixedMemo.get(node);
  if (hit !== undefined) return hit ?? undefined;
  spend(1);
  const out = computeFixedLength(node);
  fixedMemo.set(node, out ?? null);
  return out;
}

function computeFixedLength(node: Node): number | undefined {
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
        const sum = sequenceLength(alt);
        if (sum === undefined) return undefined;
        if (length !== undefined && length !== sum) return undefined;
        length = sum;
      }
      return length ?? 0;
    }
    case "quant": {
      if (node.max === 0) return 0;
      if (node.min !== node.max) return undefined;
      const inner = fixedLength(node.node);
      return inner === undefined ? undefined : inner * node.min;
    }
  }
}

function sequenceLength(seq: ReadonlyArray<Node>): number | undefined {
  let sum = 0;
  for (const n of seq) {
    const l = fixedLength(n);
    if (l === undefined) return undefined;
    sum += l;
  }
  return sum;
}

/** Can the node match without consuming anything? */
function nullable(node: Node): boolean {
  const hit = nullableMemo.get(node);
  if (hit !== undefined) return hit;
  spend(1);
  let out: boolean;
  switch (node.t) {
    case "char":
      out = false;
      break;
    case "assert":
    case "backref":
      out = true;
      break;
    case "group":
      out = node.look || node.alts.some((alt) => alt.every(nullable));
      break;
    case "quant":
      out = node.min === 0 || nullable(node.node);
      break;
  }
  nullableMemo.set(node, out);
  return out;
}

/** Characters that could be the first one a node consumes. */
function first(node: Node): CharSet {
  const hit = firstMemo.get(node);
  if (hit !== undefined) return hit;
  spend(1);
  let out: CharSet;
  switch (node.t) {
    case "char":
      out = node.set;
      break;
    case "assert":
      out = EMPTY;
      break;
    case "backref":
      out = UNIVERSAL;
      break;
    case "group":
      out = node.look ? EMPTY : unionOf(node.alts.map(firstOfSequence));
      break;
    case "quant":
      out = node.max === 0 ? EMPTY : first(node.node);
      break;
  }
  firstMemo.set(node, out);
  return out;
}

function firstOfSequence(seq: ReadonlyArray<Node>): CharSet {
  const parts: CharSet[] = [];
  for (const node of seq) {
    parts.push(first(node));
    if (!nullable(node)) break;
  }
  return unionOf(parts);
}

/**
 * A sequence with every plain (unquantified, non-lookaround, single-branch)
 * group opened up, so a delimiter written inside `(?:…)` still counts.
 */
function flatten(seq: ReadonlyArray<Node>): Node[] {
  const hit = flatMemo.get(seq);
  if (hit !== undefined) return hit;
  spend(1 + seq.length);
  const out: Node[] = [];
  for (const node of seq) {
    if (node.t === "group" && !node.look && node.alts.length === 1) {
      out.push(...flatten(node.alts[0] as Node[]));
    } else {
      out.push(node);
    }
  }
  flatMemo.set(seq, out);
  return out;
}

/**
 * For each node of a flattened sequence, the characters that can come right
 * after it: the first characters of what follows, up to the first part that
 * cannot match empty, and `after` when everything that follows can.
 */
function followSets(flat: ReadonlyArray<Node>, after: CharSet): CharSet[] {
  const out = new Array<CharSet>(flat.length);
  let next = after;
  for (let i = flat.length - 1; i >= 0; i--) {
    out[i] = next;
    const node = flat[i] as Node;
    next = nullable(node) ? unionOf([first(node), next]) : first(node);
  }
  return out;
}

/** No character belongs to two of the sets. */
function pairwiseDisjoint(sets: ReadonlyArray<CharSet>): boolean {
  const ranges: Array<[number, number]> = [];
  for (const set of sets) {
    for (let r = 0; r + 1 < set.length; r += 2)
      ranges.push([set[r] as number, set[r + 1] as number]);
  }
  spend(1 + ranges.length);
  ranges.sort((a, b) => a[0] - b[0]);
  // Ranges of one set never overlap, so any overlap is between two sets.
  let reach = -1;
  for (const [lo, hi] of ranges) {
    if (lo <= reach) return false;
    reach = Math.max(reach, hi);
  }
  return true;
}

/** At any position, at most one branch can start: their first characters differ and none is empty. */
function branchesExclusive(group: GroupNode): boolean {
  if (group.alts.some((alt) => alt.every(nullable))) return false;
  return pairwiseDisjoint(group.alts.map(firstOfSequence));
}

/**
 * Given where `node` starts, is where it ends fixed, provided the character
 * after it is in `follow`? Undefined when it is; otherwise what makes it vary.
 */
function endFixed(node: Node, follow: CharSet): Ambiguity | undefined {
  spend(1);
  if (fixedLength(node) !== undefined) return undefined;
  // Two ends would mean the longer match consumed a character that can
  // also follow the shorter one.
  if (!meets(consumes(node), follow)) return undefined;
  switch (node.t) {
    case "char":
    case "assert":
      return undefined;
    case "backref":
      return "split";
    case "group": {
      if (node.look) return undefined;
      if (node.alts.length === 1) return sequenceEndFixed(node.alts[0] as Node[], follow);
      if (!branchesExclusive(node)) return "alternation";
      for (const alt of node.alts) {
        const why = sequenceEndFixed(alt, follow);
        if (why !== undefined) return why;
      }
      return undefined;
    }
    case "quant": {
      const body = node.node;
      if (node.max === 0) return undefined;
      if (node.max === 1) {
        const why = endFixed(body, follow);
        if (why !== undefined) return why;
        // Whether the optional part is there must follow from the next character.
        return node.min === 1 || !meets(first(body), follow) ? undefined : kindOf(body);
      }
      const why = endFixed(body, unionOf([first(body), follow]));
      if (why !== undefined) return why;
      return node.min === node.max || !meets(first(body), follow) ? undefined : kindOf(body);
    }
  }
}

function sequenceEndFixed(seq: ReadonlyArray<Node>, follow: CharSet): Ambiguity | undefined {
  const flat = flatten(seq);
  const follows = followSets(flat, follow);
  for (let i = 0; i < flat.length; i++) {
    const why = endFixed(flat[i] as Node, follows[i] as CharSet);
    if (why !== undefined) return why;
  }
  return undefined;
}

/** Which kind of ambiguity a varying body shows, for the refusal's code. */
function kindOf(body: Node): Ambiguity {
  if (body.t === "group" && !body.look && body.alts.length > 1 && !branchesExclusive(body)) {
    return "alternation";
  }
  return "split";
}

/**
 * Over a fixed stretch of text, can the node match in at most one way?
 * Undefined when it can; otherwise what makes it ambiguous.
 */
function unambiguous(node: Node): Ambiguity | undefined {
  const hit = unambiguousMemo.get(node);
  if (hit !== undefined) return hit ?? undefined;
  spend(1);
  const out = computeUnambiguous(node);
  unambiguousMemo.set(node, out ?? null);
  return out;
}

function computeUnambiguous(node: Node): Ambiguity | undefined {
  switch (node.t) {
    case "char":
    case "assert":
    case "backref":
      return undefined;
    case "group": {
      // A lookaround is atomic: the engine never backtracks into it.
      if (node.look) return undefined;
      for (let i = 0; i < node.alts.length; i++) {
        for (let j = i + 1; j < node.alts.length; j++) {
          if (!separable(node.alts[i] as Node[], node.alts[j] as Node[])) return "alternation";
        }
      }
      for (const alt of node.alts) {
        const why = sequenceUnambiguous(alt);
        if (why !== undefined) return why;
      }
      return undefined;
    }
    case "quant":
      if (node.max === 0) return undefined;
      if (node.max === 1) return unambiguous(node.node);
      return repetitionUnambiguous(node);
  }
}

function sequenceUnambiguous(seq: ReadonlyArray<Node>): Ambiguity | undefined {
  const flat = flatten(seq);
  const follows = followSets(flat, EMPTY);
  // Where the stretch ends is fixed, so a part followed only by fixed-length
  // parts ends at a fixed distance from that end.
  const fixedTail = new Array<boolean>(flat.length + 1);
  fixedTail[flat.length] = true;
  for (let i = flat.length - 1; i >= 0; i--) {
    fixedTail[i] = (fixedTail[i + 1] as boolean) && fixedLength(flat[i] as Node) !== undefined;
  }
  for (let i = 0; i < flat.length; i++) {
    const node = flat[i] as Node;
    const inner = unambiguous(node);
    if (inner !== undefined) return inner;
    if (i === flat.length - 1 || fixedTail[i + 1]) continue;
    const why = endFixed(node, follows[i] as CharSet);
    if (why !== undefined) return why;
  }
  return undefined;
}

/**
 * A repeated body: each repetition ends in one place and matches one way.
 * A body that can match empty text and also consume some never passes the
 * first test, since its own first characters are among those that can
 * follow it; an always-empty one (`(?:\b)+`) repeats harmlessly.
 */
function repetitionUnambiguous(node: Node & { t: "quant" }): Ambiguity | undefined {
  const body = node.node;
  const why = endFixed(body, first(body));
  if (why !== undefined) return why;
  return unambiguous(body);
}

/** Every character a sequence must contain one of, whichever way it matches. */
function mustContain(seq: ReadonlyArray<Node>): CharSet[] {
  const out: CharSet[] = [];
  for (const node of flatten(seq)) {
    if (node.t === "char") out.push(node.set);
    else if (node.t === "quant" && node.min >= 1 && node.node.t === "char") out.push(node.node.set);
  }
  return out;
}

/** The single characters a flattened sequence starts with, in order, as far as they are fixed. */
function fixedPrefix(seq: ReadonlyArray<Node>, limit: number): CharSet[] {
  const out: CharSet[] = [];
  for (const node of flatten(seq)) {
    if (out.length >= limit) break;
    if (node.t === "char") {
      out.push(node.set);
    } else if (node.t === "quant" && node.min === node.max && node.node.t === "char") {
      for (let k = 0; k < node.min && out.length < limit; k++) out.push(node.node.set);
    } else if (node.t !== "assert") {
      break;
    }
  }
  return out;
}

/** Can no text be matched by both branches? A sufficient test, erring toward "no". */
function separable(a: ReadonlyArray<Node>, b: ReadonlyArray<Node>): boolean {
  spend(1);
  const aEmpty = a.every(nullable);
  const bEmpty = b.every(nullable);
  if (aEmpty && bEmpty) return false;
  // Different first characters, and at most one of them matches empty text.
  if (!meets(firstOfSequence(a), firstOfSequence(b))) return true;
  const aLength = sequenceLength(a);
  const bLength = sequenceLength(b);
  if (aLength !== undefined && bLength !== undefined && aLength !== bLength) return true;
  // One must contain a character the other can never consume.
  const aChars = unionOf(a.map(consumes));
  const bChars = unionOf(b.map(consumes));
  if (mustContain(a).some((set) => !meets(set, bChars))) return true;
  if (mustContain(b).some((set) => !meets(set, aChars))) return true;
  // Or they differ at some fixed position near the start: `25[0-5]` against `2[0-4]\d`.
  const aPrefix = fixedPrefix(a, 16);
  const bPrefix = fixedPrefix(b, 16);
  for (let k = 0; k < Math.min(aPrefix.length, bPrefix.length); k++) {
    if (!meets(aPrefix[k] as CharSet, bPrefix[k] as CharSet)) return true;
  }
  return false;
}

/** How many distinct ways through a node there are, or Infinity past the limit. */
function paths(node: Node): number {
  spend(1);
  switch (node.t) {
    case "char":
    case "assert":
    case "backref":
      return 1;
    case "group": {
      if (node.look) return 1;
      let total = 0;
      for (const alt of node.alts) {
        let product = 1;
        for (const n of alt) {
          product *= paths(n);
          if (product > BOUNDED_PATHS_LIMIT) return Number.POSITIVE_INFINITY;
        }
        total += product;
        if (total > BOUNDED_PATHS_LIMIT) return Number.POSITIVE_INFINITY;
      }
      return total;
    }
    case "quant": {
      if (!Number.isFinite(node.max)) return Number.POSITIVE_INFINITY;
      const each = paths(node.node);
      if (each === 1) {
        const counts = node.max - node.min + 1;
        return counts > BOUNDED_PATHS_LIMIT ? Number.POSITIVE_INFINITY : counts;
      }
      let total = 0;
      for (let k = node.min; k <= node.max; k++) {
        total += each ** k;
        if (total > BOUNDED_PATHS_LIMIT) return Number.POSITIVE_INFINITY;
      }
      return total;
    }
  }
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
    // A repeated single character or backreference matches one way per length.
    if (node.max < 2 || body.t !== "group" || body.look) continue;
    if (paths(node) <= BOUNDED_PATHS_LIMIT) continue;
    const why = repetitionUnambiguous(node);
    if (why !== undefined) {
      return {
        code: why === "alternation" ? "overlapping-alternation" : "nested-quantifier",
        at: node,
      };
    }
  }
  return undefined;
}

function screenShape(pattern: string, flags: string, maxWork: number): RegexRejection | null {
  const base = {
    unicode: flags.includes("u") || flags.includes("v"),
    unicodeSets: flags.includes("v"),
    dotAll: flags.includes("s"),
  };
  let finding: Finding | undefined;
  workLeft = maxWork;
  try {
    // A modifier group (`(?i:…)`) switches folding on part-way through the
    // parse, and folding must then apply to every set, including the ones
    // already built — so a first pass discovers it, and the pass analysed
    // is one with folding on from the start. Under the `i` flag folding is
    // on already and the first pass is skipped.
    let foldCase = flags.includes("i");
    if (!foldCase && pattern.includes("(?")) {
      const probe: Mode = { ...base, foldCase: false };
      new Parser(pattern, probe).parse();
      foldCase = probe.foldCase;
    }
    const mode: Mode = { ...base, foldCase };
    finding = findShape(new Parser(pattern, mode).parse().flat());
  } catch (err) {
    const why = err instanceof UnanalysableError ? err.message : String(err);
    return reject(
      "unanalysable",
      why === OUT_OF_WORK
        ? `the pattern could not be checked for catastrophic backtracking: ${why}. Simplify it, or split it into several patterns`
        : `the pattern could not be checked for catastrophic backtracking (${why}); simplify it`,
    );
  } finally {
    workLeft = 0;
  }
  if (finding === undefined) return null;
  const fragment = pattern.slice(finding.at.start, finding.at.end);
  if (finding.code === "nested-quantifier") {
    return reject(
      "nested-quantifier",
      `${fragment} repeats a group whose contents can match the same text in more than one way, or end in more than one place, with nothing that marks where one repetition ends — on a non-matching input that takes exponential time. Remove the inner repetition (a+ instead of (a+)+), or end each repetition with a character the rest of the group cannot match ((\\w+\\s)* instead of (\\w+\\s?)*)`,
      fragment,
    );
  }
  return reject(
    "overlapping-alternation",
    `${fragment} repeats an alternation whose branches can match the same text, so every repetition multiplies the ways to match — exponential time on a non-matching input. Use a character class ([ab]* instead of (a|b)*) or make the branches start differently`,
    fragment,
  );
}
