/**
 * The work a regular expression does, counted.
 *
 * A pattern's backtracking happens inside the engine, where no test can see
 * it, and timing it lets the machine's speed decide pass or fail. So while
 * `body` runs, every `RegExp.prototype.exec` (which `test`, `match`,
 * `matchAll`, `replace`, `split` and `search` all go through once it is
 * replaced) is also walked by a small backtracking matcher that tries
 * things in ECMAScript's order and counts its steps. The engine still
 * decides every one-character atom and still produces every result the code
 * sees, and the model must agree with it on where each match starts and
 * ends, so the count is of the real pattern on the real input.
 *
 * One step is one node entered, one character a repeat takes, or one it
 * gives back. A search tries every start from `lastIndex` (one start when
 * sticky), each costing at least a step, so a linear scan's count grows
 * with its input, and a pattern that rescans a run from every position in
 * it grows with the square of the run. Past `limit` the next `exec` throws
 * instead of running, so a quadratic pattern fails a test at once rather
 * than after the minutes it would take.
 *
 * Modelled: alternation, groups, lookahead, fixed-width lookbehind, greedy
 * and lazy `* + ? {n} {n,} {n,m}`, `^ $` (with `m`), `\b \B`, and any
 * one-character atom (`.`, a class, an escape, `\p{…}`) under `g i m s u y`.
 * A pattern using anything else (a back-reference, `v`) runs uncounted and
 * is listed in `unmodelled`, which a test asserts is empty. A group repeated
 * so many times that the walk outgrows the stack is listed there too, but
 * is not run: that can be the exponential pattern a test is there to catch,
 * which the engine takes seconds to give up on. The body stops there, as it
 * does past `limit`. Where JavaScriptCore departs from the specification
 * (an empty iteration of a nested quantified group, an anchor inside one, a
 * lone surrogate under `u`), the agreement check throws rather than count
 * something else.
 *
 * The same file is in tool-text, tool-verify, prompt-injection-detector and
 * tool-docs; keep the copies in step.
 */

type K = (j: number) => boolean;
type M = (i: number, k: K) => boolean;

type Node =
  | { readonly t: "char"; readonly text: string }
  | { readonly t: "bol" | "eol" | "wordb" | "nonwordb" }
  | { readonly t: "seq"; readonly items: readonly Node[] }
  | { readonly t: "alt"; readonly options: readonly Node[] }
  | {
      readonly t: "rep";
      readonly body: Node;
      readonly min: number;
      readonly max: number;
      readonly lazy: boolean;
    }
  | { readonly t: "look"; readonly body: Node; readonly behind: boolean; readonly neg: boolean };

class Unmodelled extends Error {}

/*
 * While installed, the model must not call a method a meter replaces: a
 * regex method would come back through the replaced `exec`, and a string or
 * array method, or an array's iterator, would be counted as the code's own
 * work by a meter running alongside (tool-verify's js-work). So it calls the
 * engine's own string methods and loops over arrays by index.
 */
const realExec = RegExp.prototype.exec;
const realCharCodeAt = String.prototype.charCodeAt;
const realCodePointAt = String.prototype.codePointAt;
const realSlice = String.prototype.slice;
const realIndexOf = String.prototype.indexOf;
const codeUnit = (s: string, i: number): number => realCharCodeAt.call(s, i);
const codePoint = (s: string, i: number): number => realCodePointAt.call(s, i) ?? 0;
const cut = (s: string, from: number, to?: number): string => realSlice.call(s, from, to);
const find = (s: string, what: string, from = 0): number => realIndexOf.call(s, what, from);
const QUANTIFIER = /^\{(\d+)(?:(,)(\d*))?\}/;

const isAsciiLetter = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

function hexDigits(text: string, from: number, count: number): boolean {
  for (let i = from; i < from + count; i++) {
    const c = codeUnit(text, i);
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102))) return false;
  }
  return true;
}

/** The structure of a pattern; Unmodelled for syntax the model does not cover. */
function parse(source: string, flags: string): Node {
  if (find(flags, "v") >= 0) throw new Unmodelled("the v flag");
  const unicode = find(flags, "u") >= 0;
  let at = 0;
  const refuse = (what: string): never => {
    throw new Unmodelled(`${what} at ${at}`);
  };
  const quantifier = (): { min: number; max: number } | null => {
    const c = source[at];
    const unbounded = Number.POSITIVE_INFINITY;
    const simple =
      c === "*"
        ? { min: 0, max: unbounded }
        : c === "+"
          ? { min: 1, max: unbounded }
          : c === "?"
            ? { min: 0, max: 1 }
            : null;
    if (simple !== null) {
      at += 1;
      return simple;
    }
    if (c !== "{") return null;
    const m = realExec.call(QUANTIFIER, cut(source, at));
    if (m === null) return null; // a literal `{` (Annex B)
    at += m[0].length;
    const min = Number(m[1]);
    const max = m[2] === undefined ? min : m[3] === "" ? unbounded : Number(m[3]);
    return { min, max };
  };
  const escapeAtom = (): Node => {
    const next = source[at + 1] ?? refuse("a trailing backslash");
    if ((next >= "1" && next <= "9") || next === "k") refuse("a back-reference");
    let end = at + 2;
    if ((next === "p" || next === "P") && unicode) end = find(source, "}", at) + 1;
    else if (next === "u" && unicode && source[at + 2] === "{") end = find(source, "}", at) + 1;
    else if (next === "u" && hexDigits(source, at + 2, 4)) end = at + 6;
    else if (next === "x" && hexDigits(source, at + 2, 2)) end = at + 4;
    else if (next === "c" && isAsciiLetter(codeUnit(source, at + 2))) end = at + 3;
    if (end <= at) refuse("an unterminated escape");
    const text = cut(source, at, end);
    at = end;
    return { t: "char", text };
  };
  const classAtom = (): Node => {
    const from = at;
    at += source[at + 1] === "^" ? 2 : 1;
    while (source[at] !== "]") {
      if (at >= source.length) refuse("an unterminated class");
      at += source[at] === "\\" ? 2 : 1;
    }
    at += 1;
    return { t: "char", text: cut(source, from, at) };
  };
  const term = (): Node => {
    const c = source[at] as string;
    if (c === "^" || c === "$") {
      at += 1;
      return { t: c === "^" ? "bol" : "eol" };
    }
    if (c === "\\" && (source[at + 1] === "b" || source[at + 1] === "B")) {
      const t = source[at + 1] === "b" ? "wordb" : "nonwordb";
      at += 2;
      return { t };
    }
    let atom: Node;
    if (c === "(") {
      let look: { behind: boolean; neg: boolean } | undefined;
      if (source.startsWith("(?=", at) || source.startsWith("(?!", at)) {
        look = { behind: false, neg: source[at + 2] === "!" };
        at += 3;
      } else if (source.startsWith("(?<=", at) || source.startsWith("(?<!", at)) {
        look = { behind: true, neg: source[at + 3] === "!" };
        at += 4;
      } else if (source.startsWith("(?:", at)) {
        at += 3;
      } else if (source.startsWith("(?<", at)) {
        const close = find(source, ">", at);
        if (close < 0) refuse("an unterminated group name");
        at = close + 1;
      } else if (source.startsWith("(?", at)) {
        refuse("a group modifier");
      } else {
        at += 1;
      }
      const body = disjunction();
      if (source[at] !== ")") refuse("an unclosed group");
      at += 1;
      if (look === undefined) atom = body;
      else {
        if (look.behind && unicode) refuse("a lookbehind under u");
        atom = { t: "look", body, ...look };
        if (look.behind) return atom; // not quantifiable
      }
    } else if (c === "[") {
      atom = classAtom();
    } else if (c === "\\") {
      atom = escapeAtom();
    } else {
      if (c === "*" || c === "+" || c === "?") refuse("a quantifier with nothing to repeat");
      const width = unicode && codePoint(source, at) > 0xffff ? 2 : 1;
      atom = { t: "char", text: cut(source, at, at + width) };
      at += width;
    }
    const q = quantifier();
    if (q === null) return atom;
    const lazy = source[at] === "?";
    if (lazy) at += 1;
    return { t: "rep", body: atom, min: q.min, max: q.max, lazy };
  };
  const alternative = (): Node => {
    const items: Node[] = [];
    while (at < source.length && source[at] !== "|" && source[at] !== ")") items.push(term());
    return items.length === 1 ? (items[0] as Node) : { t: "seq", items };
  };
  const disjunction = (): Node => {
    const options = [alternative()];
    while (source[at] === "|") {
      at += 1;
      options.push(alternative());
    }
    return options.length === 1 ? (options[0] as Node) : { t: "alt", options };
  };
  const root = disjunction();
  if (at !== source.length) refuse("an unmatched ')'");
  return root;
}

/** How many code units a lookbehind's body spans, when that is fixed. */
function fixedWidth(node: Node): number {
  switch (node.t) {
    case "char":
      return 1;
    case "bol":
    case "eol":
    case "wordb":
    case "nonwordb":
    case "look":
      return 0;
    case "seq":
      return node.items.reduce((sum, item) => sum + fixedWidth(item), 0);
    case "alt": {
      const width = fixedWidth(node.options[0] as Node);
      for (let n = 1; n < node.options.length; n++) {
        if (fixedWidth(node.options[n] as Node) !== width) {
          throw new Unmodelled("a lookbehind of varying width");
        }
      }
      return width;
    }
    case "rep":
      if (node.min !== node.max) throw new Unmodelled("a lookbehind of varying width");
      return node.min * fixedWidth(node.body);
  }
}

const OVER = Symbol("over the step limit");

/** The input being walked and the count so far: one walk at a time. */
const walk = { input: "", steps: 0, limit: 0 };

function step(): void {
  walk.steps += 1;
  if (walk.steps > walk.limit) throw OVER;
}

/** A one-character atom's verdict, decided by the engine under the pattern's flags. */
function oneChar(text: string, flags: string): (c: string) => boolean {
  const atomFlags =
    (find(flags, "i") >= 0 ? "i" : "") +
    (find(flags, "s") >= 0 ? "s" : "") +
    (find(flags, "u") >= 0 ? "u" : "");
  let single: RegExp;
  try {
    single = new RegExp(`^(?:${text})$`, atomFlags);
  } catch {
    throw new Unmodelled(`the atom ${text}`);
  }
  const ascii = new Int8Array(128);
  const other = new Map<string, boolean>();
  return (c) => {
    const code = codeUnit(c, 0);
    if (c.length === 1 && code < 128) {
      const known = ascii[code] as number;
      if (known !== 0) return known === 1;
      const yes = realExec.call(single, c) !== null;
      ascii[code] = yes ? 1 : 2;
      return yes;
    }
    let yes = other.get(c);
    if (yes === undefined) {
      yes = realExec.call(single, c) !== null;
      other.set(c, yes);
    }
    return yes;
  };
}

const isLineTerminator = (code: number): boolean =>
  code === 10 || code === 13 || code === 0x2028 || code === 0x2029;

type Compiled = {
  readonly run: M;
  readonly unicode: boolean;
  /**
   * When every match starts with one character or a line start: whether a
   * start fails at once, and the steps a walk from there takes to find that
   * out (entering the sequence, then its first item). A search skips the
   * walk for such a start and counts the same steps, which keeps a long scan
   * quick without changing its count.
   */
  readonly failsAtOnce?: (i: number) => boolean;
  readonly stepsToFail: number;
};

function compile(source: string, flags: string): Compiled {
  const unicode = find(flags, "u") >= 0;
  const multiline = find(flags, "m") >= 0;
  const word = oneChar("\\w", flags);
  const isWord = (k: number): boolean =>
    k >= 0 && k < walk.input.length && word(walk.input[k] as string);
  /** The character at `i` (a code point under u), or "" at the end. */
  const charAt = (i: number): string => {
    const input = walk.input;
    if (i >= input.length) return "";
    const code = codeUnit(input, i);
    if (unicode && code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const low = codeUnit(input, i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) return cut(input, i, i + 2);
    }
    return input[i] as string;
  };
  const build = (node: Node): M => {
    switch (node.t) {
      case "char": {
        const test = oneChar(node.text, flags);
        return (i, k) => {
          step();
          const c = charAt(i);
          return c !== "" && test(c) && k(i + c.length);
        };
      }
      case "bol":
        return (i, k) => {
          step();
          const at = i === 0 || (multiline && isLineTerminator(codeUnit(walk.input, i - 1)));
          return at && k(i);
        };
      case "eol":
        return (i, k) => {
          step();
          const at =
            i === walk.input.length || (multiline && isLineTerminator(codeUnit(walk.input, i)));
          return at && k(i);
        };
      case "wordb":
      case "nonwordb": {
        const want = node.t === "wordb";
        return (i, k) => {
          step();
          return (isWord(i - 1) !== isWord(i)) === want && k(i);
        };
      }
      case "seq": {
        const items = node.items.map(build);
        return (i, k) => {
          step();
          const from = (n: number, j: number): boolean =>
            n === items.length ? k(j) : (items[n] as M)(j, (next) => from(n + 1, next));
          return from(0, i);
        };
      }
      case "alt": {
        const options = node.options.map(build);
        return (i, k) => {
          step();
          for (let n = 0; n < options.length; n++) if ((options[n] as M)(i, k)) return true;
          return false;
        };
      }
      case "look": {
        const body = build(node.body);
        const width = node.behind ? fixedWidth(node.body) : 0;
        const { behind, neg } = node;
        return (i, k) => {
          step();
          const found = behind
            ? i - width >= 0 && body(i - width, (j) => j === i)
            : body(i, () => true);
          return found !== neg && k(i);
        };
      }
      case "rep": {
        const { min, max, lazy } = node;
        if (node.body.t === "char") {
          // A run of one-character atoms is a loop, so a long run neither
          // recurses nor overflows the stack.
          const test = oneChar(node.body.text, flags);
          return (i, k) => {
            step();
            if (lazy) {
              let j = i;
              for (let n = 0; ; n++) {
                if (n >= min && k(j)) return true;
                const c = n < max ? charAt(j) : "";
                if (c === "" || !test(c)) return false;
                j += c.length;
                step();
              }
            }
            const ends = [i];
            for (let j = i; ends.length - 1 < max; ) {
              const c = charAt(j);
              if (c === "" || !test(c)) break;
              j += c.length;
              ends.push(j);
              step();
            }
            for (let n = ends.length - 1; n >= min; n--) {
              if (k(ends[n] as number)) return true;
              step();
            }
            return false;
          };
        }
        const body = build(node.body);
        return (i, k) => {
          step();
          // ECMAScript's RepeatMatcher: once the minimum is met, an iteration
          // that matches empty is a failure, so an empty loop ends.
          const again = (lo: number, hi: number, j: number): boolean => {
            if (hi === 0) return k(j);
            const d: K = (y) => !(lo === 0 && y === j) && again(Math.max(0, lo - 1), hi - 1, y);
            if (lo !== 0) return body(j, d);
            return lazy ? k(j) || body(j, d) : body(j, d) || k(j);
          };
          return again(min, max, i);
        };
      }
    }
  };
  const root = parse(source, flags);
  const head = root.t === "seq" ? root.items[0] : root;
  const stepsToFail = root.t === "seq" ? 2 : 1;
  if (head?.t === "char") {
    const test = oneChar(head.text, flags);
    const failsAtOnce = (i: number): boolean => {
      const c = charAt(i);
      return c === "" || !test(c);
    };
    return { run: build(root), unicode, failsAtOnce, stepsToFail };
  }
  if (head?.t === "bol") {
    const failsAtOnce = (i: number): boolean =>
      !(i === 0 || (multiline && isLineTerminator(codeUnit(walk.input, i - 1))));
    return { run: build(root), unicode, failsAtOnce, stepsToFail };
  }
  return { run: build(root), unicode, stepsToFail };
}

const compiledBySource = new Map<string, Compiled | Unmodelled>();
const compiledByRegex = new WeakMap<RegExp, Compiled | Unmodelled>();

function compiledFor(re: RegExp): Compiled | Unmodelled {
  let compiled = compiledByRegex.get(re);
  if (compiled !== undefined) return compiled;
  const key = `${re.flags}/${re.source}`;
  compiled = compiledBySource.get(key);
  if (compiled === undefined) {
    try {
      compiled = compile(re.source, re.flags);
    } catch (err) {
      if (!(err instanceof Unmodelled)) throw err;
      compiled = err;
    }
    compiledBySource.set(key, compiled);
  }
  compiledByRegex.set(re, compiled);
  return compiled;
}

/** Where the match the model found ends. */
let matchEnd = -1;
const matched: K = (j) => {
  matchEnd = j;
  return true;
};

export type RegexWork<T> = {
  /** What `body` returned; undefined when it was stopped. */
  readonly value: T | undefined;
  /**
   * The steps the model took over every exec; Infinity once stopped, past
   * the limit or at a pattern too deep to walk (listed in `unmodelled`).
   */
  readonly steps: number;
  /** How many times exec ran. */
  readonly execs: number;
  /** Patterns the model does not cover, which ran uncounted. */
  readonly unmodelled: readonly string[];
};

type Meter = { steps: number; execs: number; over: boolean; unmodelled: Set<string> };

function install(limit: number, meter: Meter): () => void {
  const installed = RegExp.prototype.exec;
  RegExp.prototype.exec = function (this: RegExp, value: string): RegExpExecArray | null {
    if (meter.over) throw OVER;
    meter.execs += 1;
    const input = typeof value === "string" ? value : String(value);
    const compiled = compiledFor(this);
    if (compiled instanceof Unmodelled) {
      meter.unmodelled.add(`/${this.source}/${this.flags}: ${compiled.message}`);
      return realExec.call(this, input);
    }
    const sticky = this.sticky;
    let from = this.global || sticky ? Math.max(0, Math.trunc(Number(this.lastIndex)) || 0) : 0;
    let found: { index: number; end: number } | null = null;
    let tooDeep = false;
    walk.input = input;
    walk.steps = meter.steps;
    walk.limit = limit;
    try {
      const { failsAtOnce, stepsToFail } = compiled;
      while (from <= input.length) {
        if (failsAtOnce?.(from)) {
          walk.steps += stepsToFail;
          if (walk.steps > walk.limit) throw OVER;
        } else if (compiled.run(from, matched)) {
          found = { index: from, end: matchEnd };
          break;
        }
        if (sticky) break;
        from += compiled.unicode && codePoint(input, from) > 0xffff ? 2 : 1;
      }
    } catch (err) {
      if (err === OVER) meter.over = true;
      // A group repeated thousands of times nests the walk past the stack.
      if (!(err instanceof RangeError)) throw err;
      tooDeep = true;
    } finally {
      meter.steps = walk.steps;
      walk.input = "";
    }
    if (tooDeep) {
      // Not run uncounted: see the header. The body stops here.
      meter.unmodelled.add(`/${this.source}/${this.flags}: nested deeper than the walk's stack`);
      meter.over = true;
      throw OVER;
    }
    const real = realExec.call(this, input);
    const agrees =
      real === null
        ? found === null
        : found !== null && found.index === real.index && found.end === real.index + real[0].length;
    if (!agrees) {
      const engine = real === null ? null : [real.index, real.index + real[0].length];
      const model = found === null ? null : [found.index, found.end];
      throw new Error(
        `the step model disagrees with the engine on /${this.source}/${this.flags}: model ${String(model)}, engine ${String(engine)}`,
      );
    }
    return real;
  };
  return () => {
    RegExp.prototype.exec = installed;
  };
}

function result<T>(meter: Meter, value: T | undefined): RegexWork<T> {
  return {
    value: meter.over ? undefined : value,
    steps: meter.over ? Number.POSITIVE_INFINITY : meter.steps,
    execs: meter.execs,
    unmodelled: [...meter.unmodelled],
  };
}

/** Run `body`, counting every regular expression's steps; stop it past `limit`. */
export function regexWork<T>(limit: number, body: () => T): RegexWork<T> {
  const meter: Meter = { steps: 0, execs: 0, over: false, unmodelled: new Set() };
  const restore = install(limit, meter);
  let value: T | undefined;
  try {
    value = body();
  } catch (err) {
    if (!meter.over) throw err;
  } finally {
    restore();
  }
  return result(meter, value);
}

/** {@link regexWork} for an asynchronous body, counted until it settles. */
export async function regexWorkAsync<T>(
  limit: number,
  body: () => Promise<T>,
): Promise<RegexWork<T>> {
  const meter: Meter = { steps: 0, execs: 0, over: false, unmodelled: new Set() };
  const restore = install(limit, meter);
  let value: T | undefined;
  try {
    value = await body();
  } catch (err) {
    if (!meter.over) throw err;
  } finally {
    restore();
  }
  return result(meter, value);
}
