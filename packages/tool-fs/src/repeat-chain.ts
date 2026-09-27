/**
 * How many choice points of a Grep pattern can split the same run of text
 * between them, one after another, and so how long a line the pattern can
 * safely run on.
 *
 * tool-safety's screen refuses the best-known EXPONENTIAL shapes (a repeat
 * inside a repeat, a repeated alternation whose branches overlap). A
 * polynomial shape passes it by design: `\w*\w*!` over a line of k word
 * characters tries every way to split the run between the two repeats, at
 * every start, which is about k³/6 steps. Measured with Bun 1.3.14 on an
 * Apple-silicon Mac, about 1 ns a step: 2 000 characters take 1.5 s, and
 * 10 000 (Grep's line cap) take minutes. Every extra repeat in the chain
 * multiplies by another k.
 *
 * Grep runs the match in tool-safety's worker and answers at its deadline,
 * but the worker cannot be stopped inside one match attempt, so an abandoned
 * worker keeps a core busy until that line is done. Two of them per session,
 * or eight per process, and every later regex run is refused as `busy`
 * (0.7.1 review: `\w*\w*\w*\w*\w*\w*!|zzz` over a 9 000-character line left
 * two workers spinning long after the call returned, and the session's next
 * Grep for a literal answered "busy").
 *
 * So Grep bounds the work of one match attempt by the line it will run a
 * pattern on ({@link lineBudgetOf}): every line up to a length chosen from
 * the chain ({@link staticLineCap}), and a longer one only when what it
 * holds leaves the chain few ways to split it. A chain is never refused.
 *
 * WHAT IS A CHOICE POINT. Anything that can match in more than one way at
 * one place: a repeat, bounded or not (`\w*`, `\w{0,30}`, `a?`), a group
 * holding one, and an alternation whose branches can begin with the same
 * character (`(?:a|ab)`). A run of them multiplies: `a?` twenty-four times
 * before 24 `a`s takes a second on 60 characters, and 5 × `\w{0,30}` minutes
 * on 10 000. A lookaround holding one is re-run wherever the choices before
 * it lead, so it ends a chain (nothing outside backtracks into it), and so
 * does a backreference to a capture of varying length (`(a+)\1`), which
 * compares the whole capture after each choice.
 *
 * WHAT COUNTS AS A LINK. Two choice points are linked when some text can be
 * taken by either: they share a character, and so does every element between
 * them that must consume something, with both (a nullable element, such as
 * `\s*` or `(?:x)?`, or an assertion, consumes nothing and does not break a
 * link). `\w*\w*`, `\w+\s*\w+`, `.*a.*`, `a.*b.*c` and `.*foo.*bar` link:
 * on `foofoofoo…` the first `.*` can stop before any `foo`, which made
 * `.*ab.*ab.*x` take hours on one 10 000-character line. `\w+\s+\w+`
 * (\s shares nothing with \w) and `\w*-\w*` do not. A chain only costs
 * anything when something after it can fail: a trailing repeat followed by
 * nothing that can fail matches on its first try, so `TODO.*:.*` and `.*.*`
 * are cheap and are not counted.
 *
 * The count is conservative: a group it cannot see into (repeated, or
 * holding an alternation) is treated as able to consume any character any of
 * its parts can, and its inner chain is counted as if something after it
 * could fail. Character sets are compared over a sample of code units (all of
 * Latin-1 and Latin Extended-A, common non-Latin letters, the Unicode
 * whitespace and every code unit the pattern names), so two classes that
 * share only a character outside the sample are taken as disjoint; the
 * deadline and the busy cap remain the backstop for what this misses.
 */

/** A set of sample code units, as bits. */
type Bits = Uint32Array;

type Elem = {
  /** What it can consume (over-approximated for opaque groups). */
  readonly set: Bits;
  /** A choice point: it can match in more than one way at one place. */
  readonly member: boolean;
  /** Its own contribution to a chain when a member. */
  readonly weight: number;
  /** Can match the empty string. */
  readonly nullable: boolean;
  /** Can fail, so a chain before it may be backtracked into. */
  readonly canFail: boolean;
  /**
   * A lookaround: re-run wherever the choices before it lead, but nothing
   * after it backtracks into it, so it can end a chain and never passes one on.
   */
  readonly atomic: boolean;
  /** The one character it always matches, once: a plain literal. */
  readonly literal: string | undefined;
};

/** A bounded repeat whose span (max − min) is wider than this can take as much as an unbounded one. */
const WIDE_REPEAT_SPAN = 32;
/** A bounded repeat of a group holding a chain multiplies it by at most this. */
const MAX_GROUP_MULTIPLIER = 8;
/**
 * Distinct separator classes a link is checked against exactly; past this,
 * only the two choice points' own overlap is checked (more links, never fewer).
 */
const MAX_SEPARATOR_CLASSES = 16;

const EXTRA_SAMPLES = [
  0x2028, 0x2029, 0x3000, 0xfeff, 0x1680, 0x2000, 0x200a, 0x202f, 0x205f, 0xfffd, 0x3b1, 0x430,
  0x5d0, 0x627, 0x905, 0x3042, 0x4e2d, 0xac00, 0xd800, 0xdc00,
];
const LATIN_SAMPLES = 0x180;
/** `\uXXXX` and `\xHH` in a pattern name code units the sample must hold. */
const ESCAPED_UNIT = /\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g;
const QUANTIFIER = /^\{(\d+)(?:(,)(\d*))?\}/;

class Model {
  readonly samples: string[];
  readonly index = new Map<number, number>();
  readonly words: number;
  private readonly cache = new Map<string, Bits>();

  /** The sample units outside ASCII. */
  readonly high: Bits;

  constructor(pattern: string) {
    const units = new Set<number>();
    for (let c = 0; c < LATIN_SAMPLES; c++) units.add(c);
    for (const c of EXTRA_SAMPLES) units.add(c);
    for (let i = 0; i < pattern.length; i++) units.add(pattern.charCodeAt(i));
    for (const m of pattern.matchAll(ESCAPED_UNIT)) {
      units.add(Number.parseInt((m[1] ?? m[2]) as string, 16));
    }
    const list = [...units];
    this.samples = list.map((c) => String.fromCharCode(c));
    list.forEach((c, i) => this.index.set(c, i));
    this.words = Math.ceil(this.samples.length / 32);
    this.high = this.empty();
    list.forEach((c, i) => {
      if (c >= 128) set(this.high, i);
    });
  }

  /**
   * The ASCII characters in `bits`, as a lookup table, when `bits` holds
   * nothing else: no sampled unit above ASCII. A set that holds any
   * non-ASCII character holds a sampled one (every range bound and every
   * character the pattern names is sampled), so this is exact.
   */
  asciiTable(bits: Bits): Uint8Array | undefined {
    if (any(and(bits, this.high))) return undefined;
    const table = new Uint8Array(128);
    for (let i = 0; i < this.samples.length; i++) {
      if (((bits[i >>> 5] as number) & (1 << (i & 31))) !== 0) {
        table[(this.samples[i] as string).charCodeAt(0)] = 1;
      }
    }
    return table;
  }

  /**
   * The ASCII characters in `bits`, as a lookup table, whatever else it
   * holds: for a test that treats every character outside ASCII as in.
   */
  asciiPart(bits: Bits): Uint8Array {
    const table = new Uint8Array(128);
    for (let i = 0; i < this.samples.length; i++) {
      const c = (this.samples[i] as string).charCodeAt(0);
      if (c < 128 && ((bits[i >>> 5] as number) & (1 << (i & 31))) !== 0) table[c] = 1;
    }
    return table;
  }

  empty(): Bits {
    return new Uint32Array(this.words);
  }

  all(): Bits {
    const bits = this.empty();
    for (let i = 0; i < this.samples.length; i++) set(bits, i);
    return bits;
  }

  /** The sample units one atom (a class, an escape, `.`, a literal) matches. */
  atom(source: string): Bits {
    const cached = this.cache.get(source);
    if (cached !== undefined) return cached;
    const bits = this.empty();
    if (source.length === 1 && source !== ".") {
      set(bits, this.index.get(source.charCodeAt(0)) as number);
    } else {
      let re: RegExp | undefined;
      try {
        re = new RegExp(`^(?:${source})$`);
      } catch {
        re = undefined;
      }
      for (let i = 0; i < this.samples.length; i++) {
        if (re === undefined || re.test(this.samples[i] as string)) set(bits, i);
      }
    }
    this.cache.set(source, bits);
    return bits;
  }
}

function set(bits: Bits, at: number): void {
  bits[at >>> 5] = (bits[at >>> 5] as number) | (1 << (at & 31));
}

function and(a: Bits, b: Bits): Bits {
  const out = new Uint32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] as number) & (b[i] as number);
  return out;
}

function or(a: Bits, b: Bits): Bits {
  const out = new Uint32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] as number) | (b[i] as number);
  return out;
}

function any(a: Bits): boolean {
  for (let i = 0; i < a.length; i++) if ((a[i] as number) !== 0) return true;
  return false;
}

function meets(a: Bits, b: Bits): boolean {
  for (let i = 0; i < a.length; i++) if (((a[i] as number) & (b[i] as number)) !== 0) return true;
  return false;
}

/**
 * Where one choice point of a chain can hand over to the next: the
 * characters such a place can hold, or a run of plain characters that must
 * begin there. A line holding few of them splits few ways (see
 * {@link lineBudgetOf}).
 */
type Boundaries = { bits: Bits; readonly literals: Set<string> };

/**
 * The longest chain in one sequence that something after it can fail.
 * Links are found left to right from each choice point, keeping the
 * distinct classes of the elements between, so the work is about quadratic
 * in the sequence and a 1 000-character pattern costs milliseconds.
 */
function chainOf(seq: readonly Elem[], tailCanFail: boolean, bounds?: Boundaries): number {
  const failsAfterAt: boolean[] = new Array(seq.length).fill(false);
  let failsAfter = tailCanFail;
  for (let i = seq.length - 1; i >= 0; i--) {
    failsAfterAt[i] = failsAfter;
    if ((seq[i] as Elem).canFail) failsAfter = true;
  }
  // before[i]: the longest chain that links into choice point i from its left.
  const before: number[] = new Array(seq.length).fill(0);
  let best = 0;
  for (let h = 0; h < seq.length; h++) {
    const d = seq[h] as Elem;
    if (!d.member) continue;
    const k = (before[h] as number) + d.weight;
    // A lookaround can fail itself, and nothing after it backtracks into it.
    if (d.atomic) {
      best = Math.max(best, k);
      continue;
    }
    if (failsAfterAt[h]) best = Math.max(best, k);
    /** What `d` shares with each distinct element between it and the next point. */
    const between = new Map<string, Bits>();
    let overflow = false;
    /** The characters the text after `d` can begin with, until something must consume. */
    let first: Bits | undefined;
    let consumed = false;
    /** The plain characters that must follow `d` at once, while they last. */
    let run = "";
    let runOpen = true;
    for (let j = h + 1; j < seq.length; j++) {
      const e = seq[j] as Elem;
      if (e.member && meets(d.set, e.set)) {
        let linked = true;
        if (!overflow) {
          for (const b of between.values()) {
            if (!meets(b, e.set)) {
              linked = false;
              break;
            }
          }
        }
        if (linked) {
          if (k > (before[j] as number)) before[j] = k;
          if (bounds !== undefined) {
            // A hand-over from inside d's run to what follows it: at a place
            // the text after d can begin, which is one of d's own characters
            // (the end of d's run is the one place more, and is allowed for).
            if (run.length >= 2) bounds.literals.add(run);
            else bounds.bits = or(bounds.bits, consumed ? and(d.set, first as Bits) : d.set);
          }
        }
      }
      if (!consumed) first = first === undefined ? e.set : or(first, e.set);
      if (runOpen && e.literal !== undefined) run += e.literal;
      else runOpen = false;
      if (!e.nullable) {
        consumed = true;
        const shared = and(e.set, d.set);
        // d cannot take this element's text, so it cannot pass anything to a
        // later point: the split is fixed here.
        if (!any(shared)) break;
        if (!overflow) {
          between.set(shared.join(","), shared);
          if (between.size > MAX_SEPARATOR_CLASSES) overflow = true;
        }
      }
    }
  }
  return best;
}

type Parsed = { readonly alternatives: Elem[][]; readonly end: number };

type Atom =
  | { readonly kind: "char"; readonly source: string }
  | { readonly kind: "assert"; readonly anchor: boolean }
  | { readonly kind: "backref"; readonly group: number | string }
  | { readonly kind: "group"; readonly inner: Parsed; readonly look: boolean };

/**
 * How a top-level alternative's match attempt can begin: only at the start
 * of the line (`^`, as Grep compiles with no flags), only where a run of
 * plain characters is (`<h2` in `<h2.*>.*</h2>`), only at a character of
 * one set, or anywhere.
 */
type Opening =
  | { readonly kind: "anchored" }
  | { readonly kind: "prefix"; readonly text: string }
  | { readonly kind: "first"; readonly bits: Bits }
  | { readonly kind: "any" };

const PLAIN_ESCAPES: Readonly<Record<string, string>> = {
  t: "\t",
  n: "\n",
  r: "\r",
  v: "\v",
  f: "\f",
};

/** The one character an atom's source stands for, when it is a plain one. */
function literalOf(source: string): string | undefined {
  if (source.length === 1) return source === "." ? undefined : source;
  if (source[0] !== "\\") return undefined;
  const n = source[1] as string;
  if (source.length === 2) {
    const plain = PLAIN_ESCAPES[n];
    if (plain !== undefined) return plain;
    return /[A-Za-z0-9]/.test(n) ? undefined : n;
  }
  if ((n === "u" && source.length === 6) || (n === "x" && source.length === 4)) {
    return String.fromCharCode(Number.parseInt(source.slice(2), 16));
  }
  return undefined;
}

/**
 * Whether two branches of an alternation can both begin at one place: their
 * first characters meet, or one of them can match nothing. Only then does
 * the alternation offer a choice there.
 */
function branchesOverlap(alternatives: readonly (readonly Elem[])[]): boolean {
  const firsts: Bits[] = [];
  for (const alt of alternatives) {
    let first: Bits | undefined;
    let consumes = false;
    for (const e of alt) {
      first = first === undefined ? e.set : or(first, e.set);
      if (!e.nullable) {
        consumes = true;
        break;
      }
    }
    if (!consumes || first === undefined) return true;
    for (const other of firsts) if (meets(other, first)) return true;
    firsts.push(first);
  }
  return false;
}

type Analysis = {
  readonly model: Model;
  /** The longest chain (see {@link repeatChainLength}). */
  readonly chain: number;
  /** Every place one choice point of a chain can hand over to the next. */
  readonly bounds: Boundaries;
  /** Per top-level alternative. */
  readonly openings: readonly Opening[];
  /** It holds a lookbehind (see {@link LOOKBEHIND_SLOWDOWN}). */
  readonly lookbehind: boolean;
  /** Every character any part of the pattern can consume or compare. */
  readonly reach: Bits;
};

/**
 * The longest chain anywhere in `pattern` (no flags, as Grep compiles it).
 * The pattern must already have passed tool-safety's syntax screen; anything
 * this parser does not follow is treated as able to match anything.
 */
export function repeatChainLength(pattern: string): number {
  return analyse(pattern).chain;
}

function analyse(pattern: string): Analysis {
  const model = new Model(pattern);
  let worst = 0;
  const bounds: Boundaries = { bits: model.empty(), literals: new Set() };
  const openings: Opening[] = [];
  let lookbehind = false;
  let reach = model.empty();

  /** Capturing groups, numbered as the engine numbers them (by their opening). */
  let captureCount = 0;
  const captureNames = new Map<string, number>();
  /** What each closed capturing group can hold, for a backreference to it. */
  const captures = new Map<number, { readonly bits: Bits; readonly variable: boolean }>();

  const readAtom = (i: number): { atom: Atom; next: number } => {
    const c = pattern[i] as string;
    if (c === "(") {
      let body = i + 1;
      let look = false;
      let capture: number | undefined;
      if (pattern.startsWith("(?:", i)) body = i + 3;
      else if (pattern.startsWith("(?=", i) || pattern.startsWith("(?!", i)) {
        body = i + 3;
        look = true;
      } else if (pattern.startsWith("(?<=", i) || pattern.startsWith("(?<!", i)) {
        body = i + 4;
        look = true;
        lookbehind = true;
      } else if (pattern.startsWith("(?<", i)) {
        const close = pattern.indexOf(">", i);
        body = close === -1 ? i + 3 : close + 1;
        capture = ++captureCount;
        captureNames.set(pattern.slice(i + 3, Math.max(i + 3, close)), capture);
      } else {
        capture = ++captureCount;
      }
      // A lookaround is atomic: once it has matched, nothing outside it
      // backtracks into it, so only what follows inside it can fail.
      const inner = parse(body, !look);
      if (capture !== undefined) {
        const held = inside(inner);
        captures.set(capture, { bits: held.bits, variable: held.member });
      }
      return { atom: { kind: "group", inner, look }, next: inner.end + 1 };
    }
    if (c === "[") {
      let j = i + 1;
      if (pattern[j] === "^") j++;
      while (j < pattern.length && pattern[j] !== "]") j += pattern[j] === "\\" ? 2 : 1;
      return { atom: { kind: "char", source: pattern.slice(i, j + 1) }, next: j + 1 };
    }
    if (c === "\\") {
      const n = pattern[i + 1] ?? "";
      if (n === "b" || n === "B") return { atom: { kind: "assert", anchor: false }, next: i + 2 };
      if (n >= "1" && n <= "9") {
        let j = i + 1;
        while (j < pattern.length && /\d/.test(pattern[j] as string)) j++;
        return { atom: { kind: "backref", group: Number(pattern.slice(i + 1, j)) }, next: j };
      }
      if (n === "k" && pattern[i + 2] === "<") {
        const close = pattern.indexOf(">", i);
        const name = close === -1 ? "" : pattern.slice(i + 3, close);
        return {
          atom: { kind: "backref", group: name },
          next: close === -1 ? pattern.length : close + 1,
        };
      }
      let len = 2;
      if (n === "u" && /^[0-9a-fA-F]{4}$/.test(pattern.slice(i + 2, i + 6))) len = 6;
      else if (n === "x" && /^[0-9a-fA-F]{2}$/.test(pattern.slice(i + 2, i + 4))) len = 4;
      else if (n === "c" && /^[A-Za-z]$/.test(pattern[i + 2] ?? "")) len = 3;
      else if (n >= "0" && n <= "7") {
        while (len < 4 && /[0-7]/.test(pattern[i + len] ?? "")) len++;
      }
      return { atom: { kind: "char", source: pattern.slice(i, i + len) }, next: i + len };
    }
    if (c === "^" || c === "$") return { atom: { kind: "assert", anchor: c === "^" }, next: i + 1 };
    return { atom: { kind: "char", source: c }, next: i + 1 };
  };

  const readQuantifier = (i: number): { min: number; max: number; next: number } => {
    let min = 1;
    let max = 1;
    let next = i;
    const q = pattern[i];
    if (q === "*" || q === "+" || q === "?") {
      min = q === "+" ? 1 : 0;
      max = q === "?" ? 1 : Number.POSITIVE_INFINITY;
      next = i + 1;
    } else if (q === "{") {
      const m = pattern.slice(i, i + 24).match(QUANTIFIER);
      if (m !== null) {
        min = Number(m[1]);
        max = m[2] === undefined ? min : m[3] === "" ? Number.POSITIVE_INFINITY : Number(m[3]);
        next = i + m[0].length;
      }
    }
    if (next > i && pattern[next] === "?") next++;
    return { min, max, next };
  };

  /** The union of what a group's branches can consume, and whether any is a choice point. */
  const inside = (inner: Parsed): { bits: Bits; member: boolean; nullable: boolean } => {
    let bits = model.empty();
    let member = false;
    let nullable = false;
    for (const alt of inner.alternatives) {
      for (const e of alt) {
        bits = or(bits, e.set);
        if (e.member) member = true;
      }
      if (alt.every((e) => e.nullable)) nullable = true;
    }
    return { bits, member, nullable };
  };

  const groupElem = (inner: Parsed, min: number, max: number): Elem => {
    const { bits, member: innerMember, nullable: innerNullable } = inside(inner);
    // The group's own chain, counted as if something after it could fail.
    const innerChain = Math.max(0, ...inner.alternatives.map((alt) => chainOf(alt, true)));
    const repeats = Math.min(Math.max(1, max), MAX_GROUP_MULTIPLIER);
    const choice = max > min || branchesOverlap(inner.alternatives);
    const weight = innerMember ? Math.max(1, innerChain) * repeats : choice ? 1 : 0;
    // A repetition, or a choice of branch, hands over inside the group,
    // where chainOf does not look: any character the group takes may be a
    // boundary.
    if (weight > 0) bounds.bits = or(bounds.bits, bits);
    return {
      set: bits,
      member: weight > 0,
      weight,
      nullable: min === 0 || innerNullable,
      canFail: true,
      atomic: false,
      literal: undefined,
    };
  };

  /**
   * A lookaround. With no choice point inside, it is a fixed test of a few
   * characters. With one, it is re-run at every place the choices before it
   * lead to (`a+(?=[^:]+x)` re-scans the line for each length of `a+`), so
   * it is a choice point that ends a chain.
   */
  const lookElem = (inner: Parsed): Elem => {
    const { bits, member } = inside(inner);
    const zero = { nullable: true, canFail: true, atomic: true, literal: undefined };
    if (!member) return { ...zero, set: model.empty(), member: false, weight: 0 };
    // One run of it stops at its first match: nothing after its own end can
    // fail inside it.
    const innerChain = Math.max(0, ...inner.alternatives.map((alt) => chainOf(alt, false)));
    bounds.bits = or(bounds.bits, bits);
    return { ...zero, set: bits, member: true, weight: Math.max(1, innerChain) };
  };

  function parse(start: number, tailCanFail: boolean, top = false): Parsed {
    const alternatives: Elem[][] = [];
    let seq: Elem[] = [];
    let opening: Opening | undefined;
    /** The plain characters an alternative begins with, while they last. */
    let prefix: string | undefined;
    let i = start;
    const finishSeq = (): void => {
      worst = Math.max(worst, chainOf(seq, tailCanFail, bounds));
      alternatives.push(seq);
      seq = [];
      if (top) {
        openings.push(
          opening ?? (prefix === undefined ? { kind: "any" } : { kind: "prefix", text: prefix }),
        );
      }
      opening = undefined;
      prefix = undefined;
    };
    while (i < pattern.length && pattern[i] !== ")") {
      if (pattern[i] === "|") {
        finishSeq();
        i++;
        continue;
      }
      const { atom, next } = readAtom(i);
      const { min, max, next: after } = readQuantifier(next);
      i = after;
      const literal =
        atom.kind === "char" && min === 1 && max === 1 ? literalOf(atom.source) : undefined;
      let elem: Elem | Elem[];
      if (atom.kind === "assert") {
        elem = {
          set: model.empty(),
          member: false,
          weight: 0,
          nullable: true,
          canFail: true,
          atomic: false,
          literal: undefined,
        };
      } else if (atom.kind === "group" && atom.look) {
        elem = lookElem(atom.inner);
      } else if (atom.kind === "backref") {
        // It compares whatever its group matched, in one way only, but the
        // comparison is as long as the capture: after choices that can each
        // leave the capture a different length (`(a+)\1`), it is a scan of
        // the line at every one of them, so it ends a chain as a lookaround
        // does. A repeated one is a choice point of its own. A reference to
        // a group not yet closed is taken to hold anything.
        const number = typeof atom.group === "number" ? atom.group : captureNames.get(atom.group);
        const held = number === undefined ? undefined : captures.get(number);
        const repeated = max > min;
        const scans = held === undefined || held.variable;
        elem = {
          set: held === undefined || repeated ? model.all() : held.bits,
          member: repeated || scans,
          weight: repeated || scans ? 1 : 0,
          nullable: true,
          canFail: true,
          atomic: !repeated,
          literal: undefined,
        };
      } else if (atom.kind === "char") {
        // Any repeat is a choice point, bounded or not: `\w{0,30}` five
        // times over is as slow as five `\w*` on a line they can all take.
        const choice = max > min;
        elem = {
          set: model.atom(atom.source),
          member: choice,
          weight: choice ? 1 : 0,
          nullable: min === 0,
          canFail: min > 0,
          atomic: false,
          literal,
        };
      } else if (min === 1 && max === 1 && atom.inner.alternatives.length === 1) {
        // A plain group adds nothing a chain can see: it is its contents.
        elem = atom.inner.alternatives[0] as Elem[];
      } else {
        elem = groupElem(atom.inner, min, max);
      }
      if (top && opening === undefined) {
        if (prefix !== undefined) {
          // The run ends at the first thing that is not a plain character.
          if (literal !== undefined) prefix += literal;
          else opening = { kind: "prefix", text: prefix };
        } else if (atom.kind === "assert") {
          // A zero-width test other than `^` only narrows where a match can
          // begin, so the first thing that consumes decides.
          if (atom.anchor) opening = { kind: "anchored" };
        } else if (atom.kind === "group" && atom.look) {
          // A fixed lookaround is a few steps wherever it is tried; one with
          // a choice point inside is a search of its own at every place.
          if ((elem as Elem).member) opening = { kind: "any" };
        } else if (literal !== undefined) {
          prefix = literal;
        } else if (atom.kind === "char" && min > 0) {
          opening = { kind: "first", bits: model.atom(atom.source) };
        } else {
          opening = { kind: "any" };
        }
      }
      if (Array.isArray(elem)) seq.push(...elem);
      else {
        seq.push(elem);
        reach = or(reach, elem.set);
      }
    }
    finishSeq();
    return { alternatives, end: i };
  }

  parse(0, false, true);
  return { model, chain: worst, bounds, openings, lookbehind, reach };
}

/** Grep's line cap when nothing is chained: 0.7.0's. */
export const BASE_LINE_CAP = 10_000;

/** log C(n, k), the number of ways to choose k of n; -Infinity when there are none. */
function logChoose(n: number, k: number): number {
  if (k < 0 || n < k) return Number.NEGATIVE_INFINITY;
  const r = Math.min(k, n - k);
  let sum = 0;
  for (let i = 1; i <= r; i++) sum += Math.log((n - r + i) / i);
  return sum;
}

/**
 * The work Grep lets one match attempt of a chained pattern do, in
 * backtracking steps: about a second on the hardware above. It is the worst
 * case of a chain of 2 on a 2 000-character line, where 0.7.1 first put that
 * chain's cap, C(2 003, 3) steps.
 */
const LOG_BUDGET = logChoose(2_003, 3);

/**
 * How many times slower a step is when the pattern holds a lookbehind:
 * JavaScriptCore runs such a pattern in its interpreter, not its JIT
 * (`(?<=\w)\w*\w*\w*!` took 5.5 times as long as `\w*\w*\w*!` on the same
 * line; a lookahead, a backreference or a named group cost nothing extra).
 */
const LOOKBEHIND_SLOWDOWN = 8;

/**
 * How much less a longer line may cost than a line within the static cap:
 * a tenth, about the regex worker's give-up time (100 ms). A no-match that
 * takes longer is reported as undetermined anyway, so running such a line
 * would spend the call's deadline for no answer: over a site's built HTML,
 * `.*=.*;` given the whole budget stopped at the deadline with 1 803 hits,
 * and given a tenth found 6 648 in half a second.
 */
const ADMIT_FRACTION = 10;

/**
 * The longest line on which a chain of `chain` choice points stays within
 * the budget, whatever the line holds. The worst line is one every point can
 * take all of: splitting L characters among the chain's c points, from each
 * of the L places a match can begin, takes about C(L + c + 1, c + 1) steps,
 * or C(L + c, c) when every alternative is anchored with `^` and so begins
 * only at the start. Chains 2, 3, 4 and 5 get 2 000, 420, 171 and 95
 * characters; anchored, 10 000 (0.7.0's cap: the budget allows 51 000),
 * 2 000, 420 and 171. `slowdown` divides the budget, for an engine that
 * runs the pattern slower than its JIT does.
 */
export function staticLineCap(chain: number, anchored: boolean, slowdown = 1): number {
  if (chain <= 1) return BASE_LINE_CAP;
  const k = anchored ? chain : chain + 1;
  const budget = LOG_BUDGET - Math.log(slowdown);
  let lo = 0;
  let hi = BASE_LINE_CAP;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (logChoose(mid + k, k) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Where `text` occurs in `line`, overlaps included, in order. */
function occurrencesAt(line: string, text: string): number[] {
  const at: number[] = [];
  for (let p = line.indexOf(text); p !== -1; p = line.indexOf(text, p + 1)) at.push(p);
  return at;
}

/** log(e^a + e^b), for adding costs kept as logarithms. */
function logAdd(a: number, b: number): number {
  if (a === Number.NEGATIVE_INFINITY) return b;
  if (b === Number.NEGATIVE_INFINITY) return a;
  const hi = Math.max(a, b);
  return hi + Math.log1p(Math.exp(Math.min(a, b) - hi));
}

/** How long a line Grep runs a pattern on, and which longer lines are cheap enough anyway. */
export type LineBudget = {
  /** The longest chain (see {@link repeatChainLength}). */
  readonly chain: number;
  /** Every line up to this length is run. */
  readonly lineCap: number;
  /**
   * Whether a longer line (up to {@link BASE_LINE_CAP}) is cheap enough to
   * run all the same; undefined when no longer line can be.
   */
  readonly admits: ((line: string) => boolean) | undefined;
};

/**
 * Grep's line budget for `pattern`. Up to {@link staticLineCap} every line
 * is run. A longer one is run when its own worst case is within a tenth of
 * the budget ({@link ADMIT_FRACTION}):
 * one point of a chain can hand over to the next only where the text after
 * it can begin (the `:` of `^.*:.*:.*:.*$`, the `>` of `<h2.*>.*</h2>`, the
 * `foo` of `.*foo.*bar`), and a match can get past its first step only where
 * an alternative's opening characters are (`<h2`), or only at the start when
 * it is anchored. A line of length L with k such places and s places to
 * begin costs at most about s × C(k + c − 1, c − 1) × (L + 1) × c steps for a
 * chain of c (the combinations of hand-over places, each point scanning at
 * most the line), far below the worst case on an ordinary line. Only
 * character sets made wholly of ASCII are counted; where one is not, every
 * character is taken to be one of them.
 */
export function lineBudgetOf(pattern: string): LineBudget {
  const a = analyse(pattern);
  const chain = a.chain;
  if (chain <= 1) return { chain, lineCap: BASE_LINE_CAP, admits: undefined };
  let anchoredAlts = 0;
  let firstAlts = 0;
  let otherAlts = 0;
  let firstBits = a.model.empty();
  const prefixes: string[] = [];
  for (const o of a.openings) {
    if (o.kind === "anchored") anchoredAlts++;
    else if (o.kind === "prefix") prefixes.push(o.text);
    else if (o.kind === "first" && a.model.asciiTable(o.bits) !== undefined) {
      firstAlts++;
      firstBits = or(firstBits, o.bits);
    } else otherAlts++;
  }
  const everyAnchored = anchoredAlts === a.openings.length;
  const slowdown = a.lookbehind ? LOOKBEHIND_SLOWDOWN : 1;
  const budget = LOG_BUDGET - Math.log(slowdown) - Math.log(ADMIT_FRACTION);
  const lineCap = staticLineCap(chain, everyAnchored, slowdown);
  const hands = a.model.asciiTable(a.bounds.bits);
  const handTexts = [...a.bounds.literals];
  // What the pattern can take, among ASCII (anything else is taken to be in
  // it): a match attempt never gets past a character outside it.
  const within = a.model.asciiPart(a.reach);
  const splits = within.includes(0);
  // With every character a possible hand-over, every place (or only the
  // start, which the static cap already allows for) a possible beginning,
  // and the line one run, a longer line is never within the budget.
  if (hands === undefined && !splits && (otherAlts > 0 || everyAnchored)) {
    return { chain, lineCap, admits: undefined };
  }
  const firsts = firstAlts > 0 ? a.model.asciiTable(firstBits) : undefined;
  const admits = (line: string): boolean => {
    const length = line.length;
    // Where the texts that mark a beginning or a hand-over occur.
    const opens = prefixes.flatMap((text) => occurrencesAt(line, text)).sort((x, y) => x - y);
    const handsAt = handTexts.flatMap((text) => occurrencesAt(line, text)).sort((x, y) => x - y);
    let nextOpen = 0;
    let nextHand = 0;
    let total = Number.NEGATIVE_INFINITY;
    // Each run of characters the pattern can take is searched apart: an
    // attempt that begins in one never reads past its end, so the runs'
    // costs add. With nothing to split on, the line is one run.
    let start = 0;
    while (start <= length) {
      let end = start;
      if (splits) {
        while (end < length) {
          const c = line.charCodeAt(end);
          if (c < 128 && within[c] === 0) break;
          end++;
        }
      } else {
        end = length;
      }
      let starts = (start === 0 ? anchoredAlts : 0) + otherAlts * (end - start + 1);
      let places = 0;
      for (let i = start; i < end; i++) {
        const c = line.charCodeAt(i);
        if (firsts !== undefined && c < 128 && firsts[c] === 1) starts += firstAlts;
        if (hands === undefined || (c < 128 && hands[c] === 1)) places++;
      }
      while (nextOpen < opens.length && (opens[nextOpen] as number) < end) {
        if ((opens[nextOpen] as number) >= start) starts++;
        nextOpen++;
      }
      while (nextHand < handsAt.length && (handsAt[nextHand] as number) < end) {
        if ((handsAt[nextHand] as number) >= start) places++;
        nextHand++;
      }
      // Nowhere in the run a match can begin: no attempt gets past its first step.
      if (starts > 0) {
        total = logAdd(
          total,
          Math.log(starts) +
            logChoose(places + chain - 1, chain - 1) +
            Math.log(end - start + 1) +
            Math.log(chain),
        );
        if (total > budget) return false;
      }
      start = end + 1;
    }
    return true;
  };
  return { chain, lineCap, admits };
}
