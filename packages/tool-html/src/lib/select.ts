/**
 * A CSS selector subset, over the parsed tree.
 *
 * Deliberately a subset, and the README says which: a selector engine that
 * silently ignores the part it does not understand is worse than one that
 * refuses, because the caller gets elements that merely look right. An
 * unsupported construct is an error naming the construct.
 *
 * Supported: tag, `*`, `#id`, `.class`, `[attr]`, `[attr=v]`, `[attr^=v]`,
 * `[attr$=v]`, `[attr*=v]`, `[attr~=v]`, descendant, `>`, `+`, `~`, comma
 * groups, and the positional pseudo-classes `:first-child`, `:last-child`,
 * `:nth-child(n)`, `:nth-of-type(n)` and `:not(simple)`.
 */
import type { Element } from "./parse";
import { attrOf, walk } from "./parse";

type AttrTest = {
  readonly name: string;
  readonly op: "exists" | "=" | "^=" | "$=" | "*=" | "~=";
  readonly value: string;
  readonly insensitive: boolean;
};

type Pseudo =
  | { readonly kind: "first-child" }
  | { readonly kind: "last-child" }
  | { readonly kind: "nth-child"; readonly index: number }
  | { readonly kind: "nth-of-type"; readonly index: number }
  | { readonly kind: "not"; readonly simple: Simple };

type Simple = {
  readonly tag: string | null;
  readonly id: string | null;
  readonly classes: ReadonlyArray<string>;
  readonly attrs: ReadonlyArray<AttrTest>;
  readonly pseudos: ReadonlyArray<Pseudo>;
};

type Combinator = " " | ">" | "+" | "~";
type Step = { readonly combinator: Combinator; readonly simple: Simple };
/** A compound selector: a list of steps, applied left to right. */
export type Selector = ReadonlyArray<Step>;

const SIMPLE_RE =
  /^(\*|[a-zA-Z][\w-]*)?((?:#[\w-]+|\.[\w-]+|\[[^\]]*\]|:[a-zA-Z-]+(?:\([^)]*\))?)*)$/;

function parseSimple(source: string): Simple {
  const text = source.trim();
  if (text === "") throw new Error("an empty selector matches nothing; say what to look for");
  const head = SIMPLE_RE.exec(text);
  if (head === null) throw new Error(`"${source}" is not a selector this understands`);

  const tag = head[1] === undefined || head[1] === "*" ? null : head[1].toLowerCase();
  let id: string | null = null;
  const classes: string[] = [];
  const attrs: AttrTest[] = [];
  const pseudos: Pseudo[] = [];

  const rest = head[2] ?? "";
  const partRe = /#([\w-]+)|\.([\w-]+)|\[([^\]]*)\]|:([a-zA-Z-]+)(?:\(([^)]*)\))?/g;
  let m: RegExpExecArray | null = partRe.exec(rest);
  while (m !== null) {
    if (m[1] !== undefined) id = m[1];
    else if (m[2] !== undefined) classes.push(m[2]);
    else if (m[3] !== undefined) attrs.push(parseAttr(m[3]));
    else if (m[4] !== undefined) pseudos.push(parsePseudo(m[4], m[5]));
    m = partRe.exec(rest);
  }
  return { tag, id, classes, attrs, pseudos };
}

function parseAttr(body: string): AttrTest {
  const m = /^\s*([\w:-]+)\s*(?:([~^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]*))\s*(i)?)?\s*$/.exec(
    body,
  );
  if (m === null) throw new Error(`"[${body}]" is not an attribute selector this understands`);
  const op = m[2] === undefined ? "exists" : (m[2] as AttrTest["op"]);
  return {
    name: (m[1] as string).toLowerCase(),
    op,
    value: m[3] ?? m[4] ?? m[5] ?? "",
    insensitive: m[6] !== undefined,
  };
}

function parsePseudo(name: string, argument: string | undefined): Pseudo {
  switch (name) {
    case "first-child":
      return { kind: "first-child" };
    case "last-child":
      return { kind: "last-child" };
    case "nth-child":
    case "nth-of-type": {
      const text = (argument ?? "").trim();
      // Digits only. `Number.parseInt("2n+1")` is 2, so checking the parse
      // succeeded would accept a formula and silently treat it as the second
      // child — returning elements that merely look right, which is the
      // failure this engine refuses to have.
      const index = /^\d+$/.test(text) ? Number.parseInt(text, 10) : Number.NaN;
      if (!Number.isInteger(index) || index < 1) {
        throw new Error(
          `":${name}(${argument ?? ""})" needs a positive whole number; formulas like 2n+1 are not supported`,
        );
      }
      return name === "nth-child" ? { kind: "nth-child", index } : { kind: "nth-of-type", index };
    }
    case "not":
      return { kind: "not", simple: parseSimple(argument ?? "") };
    default:
      throw new Error(
        `":${name}" is not supported; this engine handles first-child, last-child, nth-child, nth-of-type and not`,
      );
  }
}

/** Split on a character at the top level, ignoring brackets and parentheses. */
function splitTop(source: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of source) {
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/** Parse one selector (no commas) into its ordered steps. */
export function parseSelector(source: string): Selector {
  const steps: Step[] = [];
  let combinator: Combinator = " ";
  let buffer = "";
  let depth = 0;

  const flush = (): void => {
    if (buffer.trim() === "") return;
    steps.push({ combinator, simple: parseSimple(buffer) });
    buffer = "";
    combinator = " ";
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i] as string;
    if (ch === "[" || ch === "(") depth++;
    if (ch === "]" || ch === ")") depth--;
    if (depth === 0 && (ch === ">" || ch === "+" || ch === "~")) {
      // `~` is also an attribute operator, but only inside brackets, which
      // the depth check has already excluded.
      flush();
      combinator = ch as Combinator;
      continue;
    }
    if (depth === 0 && /\s/.test(ch)) {
      if (buffer.trim() !== "") {
        flush();
        combinator = " ";
      }
      continue;
    }
    buffer += ch;
  }
  flush();
  if (steps.length === 0)
    throw new Error("an empty selector matches nothing; say what to look for");
  if (steps.length > MAX_SELECTOR_STEPS) {
    throw new Error(
      `the selector has ${steps.length} compound steps; at most ${MAX_SELECTOR_STEPS} are supported`,
    );
  }
  return steps;
}

/** Parse a comma-separated selector group. */
export function parseSelectorGroup(source: string): Selector[] {
  const parts = splitTop(source, ",");
  // An empty group would match nothing and report no error, which is the
  // exact behaviour this engine refuses to have: a caller gets zero results
  // and no reason, and concludes the page changed.
  if (parts.length === 0) {
    throw new Error("an empty selector matches nothing; say what to look for");
  }
  if (parts.length > MAX_SELECTOR_GROUP) {
    throw new Error(
      `the selector group has ${parts.length} selectors; at most ${MAX_SELECTOR_GROUP} are supported`,
    );
  }
  return parts.map(parseSelector);
}

const classesOf = (node: Element): string[] =>
  (attrOf(node, "class") ?? "").split(/\s+/).filter((c) => c !== "");

function attrMatches(node: Element, test: AttrTest): boolean {
  // Own attributes only: `[constructor]` must not match every element, and
  // `[constructor^=f]` must not call startsWith on a function.
  const raw = attrOf(node, test.name);
  if (raw === undefined) return false;
  if (test.op === "exists") return true;
  const actual = test.insensitive ? raw.toLowerCase() : raw;
  const expected = test.insensitive ? test.value.toLowerCase() : test.value;
  switch (test.op) {
    case "=":
      return actual === expected;
    case "^=":
      return expected !== "" && actual.startsWith(expected);
    case "$=":
      return expected !== "" && actual.endsWith(expected);
    case "*=":
      return expected !== "" && actual.includes(expected);
    default:
      return actual.split(/\s+/).includes(expected);
  }
}

// ---------------------------------------------------------------------------
// Matching
//
// The naive right-to-left matcher re-ran the rest of the selector for EVERY
// ancestor (descendant) or earlier sibling (`~`) that matched the step before,
// with no memory of having asked the same question: about C(depth, steps)
// work per element, so 5 KB of nested markup and a six-step selector ran for
// minutes on the harness's one thread. Positional pseudo-classes and `+`/`~`
// also rebuilt the parent's child list per element, which is quadratic in a
// long flat list.
//
// Here every question is asked once per query:
//
//   M(node, i)   node is the subject of step i, and steps 0..i all hold
//   A(node, i)   some ancestor a of node has M(a, i - 1)        (descendant)
//   S(node, i)   some earlier element sibling s has M(s, i - 1)  (`~`)
//
// each memoised per (node, i), and a parent's element children are indexed
// once. The whole query is then O(elements × steps). A and S are computed
// iteratively, never by recursion along a chain, because a sibling list can
// be hundreds of thousands long; recursion depth is bounded by the step
// count. Ancestors and siblings outside the queried container count, as they
// do for the DOM's querySelectorAll.

/** Most compound steps one selector may have. */
export const MAX_SELECTOR_STEPS = 32;
/** Most selectors one comma group may have. */
export const MAX_SELECTOR_GROUP = 32;

type Position = { readonly index: number; readonly typeIndex: number };
type Family = { readonly list: ReadonlyArray<Element> };

/** One step's three memo slots per element: 0 unknown, 1 true, 2 false. */
type Memo = Map<Element, Int8Array>;

/**
 * What a query remembers: each parent's element children, each element's
 * position among them, and the memo tables of every selector asked so far.
 * Share one across queries over the SAME, unchanged tree (as HtmlRecords
 * does for its field selectors); never across trees that are edited
 * between queries.
 */
export type MatchContext = {
  readonly families: WeakMap<Element, Family>;
  readonly positions: WeakMap<Element, Position>;
  readonly memos: Map<Selector, Memo>;
  readonly groups: Map<string, Selector[]>;
};

export function createMatchContext(): MatchContext {
  return { families: new WeakMap(), positions: new WeakMap(), memos: new Map(), groups: new Map() };
}

function familyOf(parent: Element, ctx: MatchContext): Family {
  const known = ctx.families.get(parent);
  if (known !== undefined) return known;
  const list: Element[] = [];
  const ofType = new Map<string, number>();
  for (const child of parent.children) {
    if (child.type !== "element") continue;
    const typeIndex = ofType.get(child.tag) ?? 0;
    ofType.set(child.tag, typeIndex + 1);
    ctx.positions.set(child, { index: list.length, typeIndex });
    list.push(child);
  }
  const family = { list };
  ctx.families.set(parent, family);
  return family;
}

/** The element's position among its parent's element children, or null at the top. */
function positionOf(node: Element, ctx: MatchContext): (Position & Family) | null {
  const parent = node.parent;
  if (parent === null) return null;
  const family = familyOf(parent, ctx);
  const position = ctx.positions.get(node);
  // A node its parent does not list (a hand-built tree) has no position.
  if (position === undefined || family.list[position.index] !== node) return null;
  return { ...position, list: family.list };
}

function previousElementSibling(node: Element, ctx: MatchContext): Element | null {
  const at = positionOf(node, ctx);
  if (at === null || at.index === 0) return null;
  return at.list[at.index - 1] ?? null;
}

function matchesSimple(node: Element, simple: Simple, ctx: MatchContext): boolean {
  if (simple.tag !== null && node.tag !== simple.tag) return false;
  if (simple.id !== null && attrOf(node, "id") !== simple.id) return false;
  if (simple.classes.length > 0) {
    const have = classesOf(node);
    if (!simple.classes.every((c) => have.includes(c))) return false;
  }
  for (const attr of simple.attrs) if (!attrMatches(node, attr)) return false;

  for (const pseudo of simple.pseudos) {
    if (pseudo.kind === "not") {
      if (matchesSimple(node, pseudo.simple, ctx)) return false;
      continue;
    }
    const at = positionOf(node, ctx);
    if (at === null) return false;
    switch (pseudo.kind) {
      case "first-child":
        if (at.index !== 0) return false;
        break;
      case "last-child":
        if (at.index !== at.list.length - 1) return false;
        break;
      case "nth-child":
        if (at.index !== pseudo.index - 1) return false;
        break;
      default:
        if (at.typeIndex !== pseudo.index - 1) return false;
        break;
    }
  }
  return true;
}

const UNKNOWN = 0;
const YES = 1;
const NO = 2;

/** The memo row for one selector and element: [M 0..n-1 | A 0..n-1 | S 0..n-1]. */
function row(memo: Memo, node: Element, steps: number): Int8Array {
  let r = memo.get(node);
  if (r === undefined) {
    r = new Int8Array(steps * 3);
    memo.set(node, r);
  }
  return r;
}

function memoFor(selector: Selector, ctx: MatchContext): Memo {
  let memo = ctx.memos.get(selector);
  if (memo === undefined) {
    memo = new Map();
    ctx.memos.set(selector, memo);
  }
  return memo;
}

/** M(node, i): node is the subject of step i and the steps before it hold. */
function subjectOf(
  node: Element,
  selector: Selector,
  i: number,
  memo: Memo,
  ctx: MatchContext,
): boolean {
  const n = selector.length;
  const r = row(memo, node, n);
  const cached = r[i] as number;
  if (cached !== UNKNOWN) return cached === YES;
  const step = selector[i] as Step;
  let ok = matchesSimple(node, step.simple, ctx);
  if (ok && i > 0) {
    switch (step.combinator) {
      case ">": {
        const parent = node.parent;
        ok = parent !== null && subjectOf(parent, selector, i - 1, memo, ctx);
        break;
      }
      case "+": {
        const previous = previousElementSibling(node, ctx);
        ok = previous !== null && subjectOf(previous, selector, i - 1, memo, ctx);
        break;
      }
      case "~":
        ok = someEarlierSibling(node, selector, i, memo, ctx);
        break;
      default:
        ok = someAncestor(node, selector, i, memo, ctx);
        break;
    }
  }
  r[i] = ok ? YES : NO;
  return ok;
}

/** A(node, i): some ancestor is the subject of step i - 1. Iterative up the chain. */
function someAncestor(
  node: Element,
  selector: Selector,
  i: number,
  memo: Memo,
  ctx: MatchContext,
): boolean {
  const n = selector.length;
  const slot = n + i;
  const chain: Element[] = [];
  let top: Element = node;
  // `known` is A(top, i) once the loop stops.
  let known: boolean;
  for (;;) {
    if (top.parent === null) {
      known = false;
      break;
    }
    const cached = row(memo, top, n)[slot] as number;
    if (cached !== UNKNOWN) {
      known = cached === YES;
      break;
    }
    chain.push(top);
    top = top.parent;
  }
  row(memo, top, n)[slot] = known ? YES : NO;
  // Fill downwards: A(x) = A(parent) || M(parent, i - 1).
  for (let k = chain.length - 1; k >= 0; k--) {
    const x = chain[k] as Element;
    const parent = x.parent as Element;
    known = known || subjectOf(parent, selector, i - 1, memo, ctx);
    row(memo, x, n)[slot] = known ? YES : NO;
  }
  return known;
}

/** S(node, i): some earlier element sibling is the subject of step i - 1. Iterative. */
function someEarlierSibling(
  node: Element,
  selector: Selector,
  i: number,
  memo: Memo,
  ctx: MatchContext,
): boolean {
  const n = selector.length;
  const slot = 2 * n + i;
  const at = positionOf(node, ctx);
  if (at === null) return false;
  // Walk back to the first sibling whose answer is known (or the first one),
  // then fill forwards: S(x) = S(prev) || M(prev, i - 1).
  let k = at.index;
  let known = false;
  while (k > 0) {
    const cached = row(memo, at.list[k] as Element, n)[slot] as number;
    if (cached !== UNKNOWN) {
      known = cached === YES;
      break;
    }
    k--;
  }
  if (k === 0) row(memo, at.list[0] as Element, n)[slot] = NO;
  for (let j = k + 1; j <= at.index; j++) {
    const previous = at.list[j - 1] as Element;
    known = known || subjectOf(previous, selector, i - 1, memo, ctx);
    row(memo, at.list[j] as Element, n)[slot] = known ? YES : NO;
  }
  return known;
}

/** Whether `node` matches `selector`. Pass a context to reuse work across calls on one tree. */
export function matches(
  node: Element,
  selector: Selector,
  ctx: MatchContext = createMatchContext(),
): boolean {
  if (selector.length === 0) return false;
  return subjectOf(node, selector, selector.length - 1, memoFor(selector, ctx), ctx);
}

function groupFor(source: string, ctx: MatchContext): Selector[] {
  let group = ctx.groups.get(source);
  if (group === undefined) {
    group = parseSelectorGroup(source);
    ctx.groups.set(source, group);
  }
  return group;
}

/**
 * Every element under `root` matching any selector in the group, in document
 * order. `ctx` may be shared across queries over the same unchanged tree.
 */
export function queryAll(
  root: Element,
  source: string,
  limit = Number.POSITIVE_INFINITY,
  ctx: MatchContext = createMatchContext(),
): Element[] {
  const group = groupFor(source, ctx);
  const memos = group.map((selector) => memoFor(selector, ctx));
  const found: Element[] = [];
  for (const node of walk(root)) {
    if (
      group.some((selector, g) =>
        subjectOf(node, selector, selector.length - 1, memos[g] as Memo, ctx),
      )
    ) {
      found.push(node);
      if (found.length >= limit) break;
    }
  }
  return found;
}

export function queryFirst(
  root: Element,
  source: string,
  ctx: MatchContext = createMatchContext(),
): Element | undefined {
  return queryAll(root, source, 1, ctx)[0];
}
