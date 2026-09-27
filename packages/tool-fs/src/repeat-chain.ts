/**
 * How many unbounded repeats of a Grep pattern can split the same run of
 * text between them, one after another.
 *
 * tool-safety's screen refuses the EXPONENTIAL shapes (a repeat inside a
 * repeat, a repeated alternation whose branches overlap). A polynomial
 * shape passes it by design: `\w*\w*!` over a line of k word characters
 * tries every way to split the run between the two repeats, at every start,
 * which is about k³/6 steps. Measured with Bun 1.3.14 on an Apple-silicon
 * Mac, about 1 ns a step: 2 000 characters take 1.5 s, and 10 000 (Grep's
 * line cap) take minutes. Every extra repeat in the chain multiplies by
 * another k.
 *
 * Grep runs the match in tool-safety's worker and answers at its deadline,
 * but the worker cannot be stopped inside one match attempt, so an abandoned
 * worker keeps a core busy until that line is done. Two of them per session,
 * or eight per process, and every later regex run is refused as `busy`
 * (0.7.1 review: `\w*\w*\w*\w*\w*\w*!|zzz` over a 9 000-character line left
 * two workers spinning long after the call returned, and the session's next
 * Grep for a literal answered "busy").
 *
 * So Grep bounds the work of one match attempt by the line length it will
 * run a pattern on, chosen from this count ({@link lineCapForChain}), and
 * refuses a pattern whose chain is so long that no useful line length is
 * safe ({@link REFUSED_CHAIN}).
 *
 * WHAT COUNTS AS A CHAIN. Two unbounded repeats are linked when some
 * character c can be matched by both, and by every element between them that
 * must consume something (a nullable element, such as `\s*` or `(?:x)?`, or
 * an assertion, consumes nothing and does not break a link). `\w*\w*`,
 * `\w+\s*\w+`, `.*a.*` (c = "a") and `a.*b.*c` (c = "b") link; `\w+\s+\w+`
 * (\s shares nothing with \w) and `.*foo.*` (no one character is f, o and o)
 * do not. A chain only costs anything when something after it can fail: a
 * trailing repeat followed by nothing that can fail matches on its first try,
 * so `TODO.*:.*` and `.*.*` are cheap and are not counted.
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
  /** Can consume an unbounded run (`*`, `+`, `{n,}`, or a wide `{n,m}`). */
  readonly unbounded: boolean;
  /** Its own contribution to a chain when unbounded. */
  readonly weight: number;
  /** Can match the empty string. */
  readonly nullable: boolean;
  /** Can fail, so a chain before it may be backtracked into. */
  readonly canFail: boolean;
};

/** A bounded repeat whose span (max − min) is wider than this counts as unbounded. */
const WIDE_REPEAT_SPAN = 32;
/** A bounded repeat of a group holding a chain multiplies it by at most this. */
const MAX_GROUP_MULTIPLIER = 8;

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

/**
 * The longest chain in one sequence that something after it can fail.
 * Links are found left to right from each repeat, narrowing one mask as the
 * elements between are passed, so the work is quadratic in the sequence and
 * a 1 000-character pattern costs milliseconds.
 */
function chainOf(seq: readonly Elem[], tailCanFail: boolean): number {
  const failsAfterAt: boolean[] = new Array(seq.length).fill(false);
  let failsAfter = tailCanFail;
  for (let i = seq.length - 1; i >= 0; i--) {
    failsAfterAt[i] = failsAfter;
    if ((seq[i] as Elem).canFail) failsAfter = true;
  }
  // before[i]: the longest chain that links into repeat i from its left.
  const before: number[] = new Array(seq.length).fill(0);
  let best = 0;
  for (let h = 0; h < seq.length; h++) {
    const d = seq[h] as Elem;
    if (!d.unbounded) continue;
    const k = (before[h] as number) + d.weight;
    if (failsAfterAt[h]) best = Math.max(best, k);
    let mask = d.set;
    for (let j = h + 1; j < seq.length; j++) {
      const e = seq[j] as Elem;
      if (e.unbounded && k > (before[j] as number) && any(and(mask, e.set))) before[j] = k;
      if (!e.nullable) {
        mask = and(mask, e.set);
        if (!any(mask)) break;
      }
    }
  }
  return best;
}

type Parsed = { readonly alternatives: Elem[][]; readonly end: number };

type Atom =
  | { readonly kind: "char"; readonly source: string }
  | { readonly kind: "assert" }
  | { readonly kind: "backref" }
  | { readonly kind: "group"; readonly inner: Parsed; readonly look: boolean };

/**
 * The longest chain anywhere in `pattern` (no flags, as Grep compiles it).
 * The pattern must already have passed tool-safety's syntax screen; anything
 * this parser does not follow is treated as able to match anything.
 */
export function repeatChainLength(pattern: string): number {
  const model = new Model(pattern);
  let worst = 0;

  const readAtom = (i: number): { atom: Atom; next: number } => {
    const c = pattern[i] as string;
    if (c === "(") {
      let body = i + 1;
      let look = false;
      if (pattern.startsWith("(?:", i)) body = i + 3;
      else if (pattern.startsWith("(?=", i) || pattern.startsWith("(?!", i)) {
        body = i + 3;
        look = true;
      } else if (pattern.startsWith("(?<=", i) || pattern.startsWith("(?<!", i)) {
        body = i + 4;
        look = true;
      } else if (pattern.startsWith("(?<", i)) {
        const close = pattern.indexOf(">", i);
        body = close === -1 ? i + 3 : close + 1;
      }
      // A lookaround is atomic: once it has matched, nothing outside it
      // backtracks into it, so only what follows inside it can fail.
      const inner = parse(body, !look);
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
      if (n === "b" || n === "B") return { atom: { kind: "assert" }, next: i + 2 };
      if (n >= "1" && n <= "9") {
        let j = i + 1;
        while (j < pattern.length && /\d/.test(pattern[j] as string)) j++;
        return { atom: { kind: "backref" }, next: j };
      }
      if (n === "k" && pattern[i + 2] === "<") {
        const close = pattern.indexOf(">", i);
        return { atom: { kind: "backref" }, next: close === -1 ? pattern.length : close + 1 };
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
    if (c === "^" || c === "$") return { atom: { kind: "assert" }, next: i + 1 };
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

  const groupElem = (inner: Parsed, min: number, max: number, wide: boolean): Elem => {
    let bits = model.empty();
    let innerUnbounded = false;
    let innerNullable = false;
    for (const alt of inner.alternatives) {
      for (const e of alt) {
        bits = or(bits, e.set);
        if (e.unbounded) innerUnbounded = true;
      }
      if (alt.every((e) => e.nullable)) innerNullable = true;
    }
    // The group's own chain, counted as if something after it could fail.
    const innerChain = Math.max(0, ...inner.alternatives.map((alt) => chainOf(alt, true)));
    const repeats = Math.min(Math.max(1, max), MAX_GROUP_MULTIPLIER);
    const weight = innerUnbounded ? Math.max(1, innerChain) * repeats : wide ? 1 : 0;
    return {
      set: bits,
      unbounded: innerUnbounded || wide,
      weight,
      nullable: min === 0 || innerNullable,
      canFail: true,
    };
  };

  function parse(start: number, tailCanFail: boolean): Parsed {
    const alternatives: Elem[][] = [];
    let seq: Elem[] = [];
    let i = start;
    const finishSeq = (): void => {
      worst = Math.max(worst, chainOf(seq, tailCanFail));
      alternatives.push(seq);
      seq = [];
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
      const wide = max - min > WIDE_REPEAT_SPAN;
      const zeroWidth = { set: model.empty(), unbounded: false, weight: 0, nullable: true };
      if (atom.kind === "assert" || (atom.kind === "group" && atom.look)) {
        seq.push({ ...zeroWidth, canFail: true });
      } else if (atom.kind === "backref") {
        // It repeats whatever its group matched: anything, of any length.
        seq.push({ ...zeroWidth, set: model.all(), canFail: true });
      } else if (atom.kind === "char") {
        seq.push({
          set: model.atom(atom.source),
          unbounded: wide,
          weight: wide ? 1 : 0,
          nullable: min === 0,
          canFail: min > 0,
        });
      } else if (min === 1 && max === 1 && atom.inner.alternatives.length === 1) {
        // A plain group adds nothing a chain can see: it is its contents.
        seq.push(...(atom.inner.alternatives[0] as Elem[]));
      } else {
        seq.push(groupElem(atom.inner, min, max, wide));
      }
    }
    finishSeq();
    return { alternatives, end: i };
  }

  parse(0, false);
  return worst;
}

/** Grep's line cap when no repeats are chained: 0.7.0's. */
export const BASE_LINE_CAP = 10_000;
/** A chain this long or longer is refused outright. */
export const REFUSED_CHAIN = 4;

/**
 * The longest line Grep runs a pattern with this chain on. Each cap keeps
 * the worst single match attempt to about a second on the hardware above:
 * chain 1, 10 000² / 2 steps; chain 2, 2 000³ / 6; chain 3, 400⁴ / 24.
 */
export function lineCapForChain(chain: number): number {
  if (chain <= 1) return BASE_LINE_CAP;
  if (chain === 2) return 2_000;
  return 400;
}
