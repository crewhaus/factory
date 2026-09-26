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
import type { Element, Node } from "./parse";
import { attrOf } from "./parse";

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
  /** Tests this compound makes, the ones inside `:not()` included. */
  readonly tests: number;
};

type Combinator = " " | ">" | "+" | "~";
type Step = { readonly combinator: Combinator; readonly simple: Simple };
/** A compound selector: a list of steps, applied left to right. */
export type Selector = ReadonlyArray<Step>;

/** Most compound steps one selector may have. */
export const MAX_SELECTOR_STEPS = 32;
/** Most selectors one comma group may have. */
export const MAX_SELECTOR_GROUP = 32;
/**
 * Most tests one compound may make: its tag, `#id`, each `.class`, each
 * `[attr]` and each pseudo-class, counting the tests inside a `:not()`.
 */
export const MAX_COMPOUND_TESTS = 32;
/** Longest selector accepted, in characters. */
export const MAX_SELECTOR_CHARS = 8_192;
/**
 * Matching work one context may spend: about one unit per element a
 * selector is asked about and per compound test made. It bounds the worst
 * case the caps above still allow (every element asked every step of 32
 * selectors of 32 steps) at seconds of one thread, where an ordinary query
 * over the largest page these tools accept spends a small fraction of it.
 */
export const MATCH_WORK_LIMIT = 200_000_000;

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
  let tests = (tag === null ? 0 : 1) + (id === null ? 0 : 1) + classes.length + attrs.length;
  for (const pseudo of pseudos) tests += pseudo.kind === "not" ? 1 + pseudo.simple.tests : 1;
  if (tests > MAX_COMPOUND_TESTS) {
    const shown = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    throw new Error(
      `"${shown}" makes ${tests} tests on one element; at most ${MAX_COMPOUND_TESTS} are supported`,
    );
  }
  return { tag, id, classes, attrs, pseudos, tests };
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
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    if (ch === separator && depth === 0) {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(source.slice(start));
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
  if (source.length > MAX_SELECTOR_CHARS) {
    throw new Error(
      `the selector is ${source.length} characters; at most ${MAX_SELECTOR_CHARS} are supported`,
    );
  }
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

// ---------------------------------------------------------------------------
// Matching
//
// The 0.7.0 matcher ran right to left and re-ran the rest of the selector for
// EVERY ancestor or earlier sibling that matched the step before: about
// C(depth, steps) work per element, so 5 KB of nested markup and a six-step
// selector ran for minutes. Memoising each (element, step) answer made that
// linear, but kept a row per element per selector alive, so a 64 KB page and
// a 64-field scrape recipe took gigabytes.
//
// This matcher runs left to right, in one pass in document order, and keeps
// nothing per element. For each selector it carries three bitsets, one bit
// per step, for the element in hand:
//
//   M  the steps this element is the subject of, every step before them held
//   A  the steps whose previous step an ancestor is the subject of   (` `)
//   S  the steps whose previous step an earlier sibling is the subject of (`~`)
//
// An element's A comes from its parent's A and M, its S from its previous
// sibling's S and M, and its M from those and its own compound tests, so a
// pass holds only the bitsets of the open ancestors and of the last sibling
// at each depth. A step's compound is tested only where its combinator
// already holds, and an element's class list is split at most once. The
// work is a visit per element per selector plus the tests actually made,
// and it is metered against MATCH_WORK_LIMIT.
//
// Ancestors and siblings outside the queried container count, as they do
// for the DOM's querySelectorAll: a query under a container first computes
// the container's own bitsets along its ancestor chain.

type CompiledSelector = {
  readonly steps: ReadonlyArray<Step>;
  /** The bits this selector has steps for. */
  readonly mask: number;
  /** The last step's bit: an element whose M has it is a match. */
  readonly last: number;
  /** The steps entered by a descendant, child, next-sibling and later-sibling combinator. */
  readonly desc: number;
  readonly child: number;
  readonly next: number;
  readonly later: number;
};

type Compiled = {
  readonly selectors: ReadonlyArray<CompiledSelector>;
  /** Some selector has more than one step, so ancestors and siblings matter. */
  readonly contextual: boolean;
  /** Some selector uses `+` or `~`. */
  readonly siblings: boolean;
  /** Some compound uses `:last-child`, which needs the parent's child count. */
  readonly needsCount: boolean;
  /** Some compound uses `:nth-of-type`, which needs the same-tag ordinal. */
  readonly needsTypeIndex: boolean;
};

/**
 * What the queries one call makes over one tree share: parsed selector
 * groups, and one work budget, so many queries cannot add up past it.
 */
export type MatchContext = {
  /** Work units left. */
  work: number;
  readonly limit: number;
  readonly groups: Map<string, Compiled>;
};

export function createMatchContext(limit: number = MATCH_WORK_LIMIT): MatchContext {
  return { work: limit, limit, groups: new Map() };
}

/** Thrown inside a pass when the budget is gone; `metered` names the selector. */
class WorkExhausted extends Error {}

/**
 * Work done since the last `settle`. The tests of one element add to it and
 * `evaluate` settles it against the context once per element, which keeps
 * the metering off the per-test path.
 */
let spent = 0;

function settle(ctx: MatchContext): void {
  ctx.work -= spent;
  spent = 0;
  if (ctx.work < 0) throw new WorkExhausted();
}

function uses(simple: Simple, kind: Pseudo["kind"]): boolean {
  return simple.pseudos.some((p) => p.kind === kind || (p.kind === "not" && uses(p.simple, kind)));
}

function compileGroup(group: ReadonlyArray<Selector>): Compiled {
  const selectors = group.map((steps): CompiledSelector => {
    let desc = 0;
    let child = 0;
    let next = 0;
    let later = 0;
    for (let i = 1; i < steps.length; i++) {
      const bit = 1 << i;
      const combinator = (steps[i] as Step).combinator;
      if (combinator === ">") child |= bit;
      else if (combinator === "+") next |= bit;
      else if (combinator === "~") later |= bit;
      else desc |= bit;
    }
    const n = steps.length;
    // `(1 << 32) - 1` is 0 in 32-bit arithmetic, so 32 steps is spelled out.
    const mask = n >= 32 ? -1 : (1 << n) - 1;
    return { steps, mask, last: 1 << (n - 1), desc, child, next, later };
  });
  const simples = group.flatMap((steps) => steps.map((step) => step.simple));
  return {
    selectors,
    contextual: selectors.some((s) => s.steps.length > 1),
    siblings: selectors.some((s) => (s.next | s.later) !== 0),
    needsCount: simples.some((simple) => uses(simple, "last-child")),
    needsTypeIndex: simples.some((simple) => uses(simple, "nth-of-type")),
  };
}

function compile(source: string, ctx: MatchContext): Compiled {
  const known = ctx.groups.get(source);
  if (known !== undefined) return known;
  const compiled = compileGroup(parseSelectorGroup(source));
  ctx.groups.set(source, compiled);
  return compiled;
}

/** The element in hand: its position among its parent's element children, and its classes. */
type Facts = {
  /** Index among the parent's element children; -1 when no parent lists it. */
  index: number;
  /** Index among the parent's element children of the same tag, when a selector needs it. */
  typeIndex: number;
  /** How many element children the parent has, when a selector needs it. */
  count: number;
  /** The class list, split when a class test first asks. */
  classes: Set<string> | null;
};

const noPosition = (): Facts => ({ index: -1, typeIndex: -1, count: -1, classes: null });

function classesOf(node: Element, facts: Facts): Set<string> {
  if (facts.classes !== null) return facts.classes;
  const raw = attrOf(node, "class") ?? "";
  // The one test whose cost follows the page rather than the selector.
  spent += 1 + (raw.length >> 4);
  const set = new Set<string>();
  for (const c of raw.split(/\s+/)) if (c !== "") set.add(c);
  facts.classes = set;
  return set;
}

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

function matchesSimple(node: Element, simple: Simple, facts: Facts): boolean {
  spent += 1 + simple.tests;
  if (simple.tag !== null && node.tag !== simple.tag) return false;
  if (simple.id !== null && attrOf(node, "id") !== simple.id) return false;
  if (simple.classes.length > 0) {
    const have = classesOf(node, facts);
    for (const c of simple.classes) if (!have.has(c)) return false;
  }
  for (const attr of simple.attrs) if (!attrMatches(node, attr)) return false;

  for (const pseudo of simple.pseudos) {
    if (pseudo.kind === "not") {
      if (matchesSimple(node, pseudo.simple, facts)) return false;
      continue;
    }
    if (facts.index < 0) return false;
    switch (pseudo.kind) {
      case "first-child":
        if (facts.index !== 0) return false;
        break;
      case "last-child":
        if (facts.index !== facts.count - 1) return false;
        break;
      case "nth-child":
        if (facts.index !== pseudo.index - 1) return false;
        break;
      default:
        if (facts.typeIndex !== pseudo.index - 1) return false;
        break;
    }
  }
  return true;
}

/**
 * Compute `node`'s bitsets into `out` — [M | A | S], one int per selector
 * each — from its parent's and its previous element sibling's.
 */
function evaluate(
  node: Element,
  parent: Int32Array | null,
  previous: Int32Array | null,
  facts: Facts,
  group: Compiled,
  out: Int32Array,
  ctx: MatchContext,
): void {
  const k = group.selectors.length;
  spent += k;
  for (let g = 0; g < k; g++) {
    const sel = group.selectors[g] as CompiledSelector;
    const mp = parent === null ? 0 : (parent[g] as number);
    const ap = parent === null ? 0 : (parent[k + g] as number);
    const mq = previous === null ? 0 : (previous[g] as number);
    const sq = previous === null ? 0 : (previous[2 * k + g] as number);
    const a = (ap | (mp << 1)) & sel.mask;
    const s = (sq | (mq << 1)) & sel.mask;
    // The steps whose combinator already holds here; step 0 has none to hold.
    let open =
      (1 | (a & sel.desc) | ((mp << 1) & sel.child) | ((mq << 1) & sel.next) | (s & sel.later)) &
      sel.mask;
    let m = 0;
    while (open !== 0) {
      const bit = open & -open;
      open ^= bit;
      const simple = (sel.steps[31 - Math.clz32(bit)] as Step).simple;
      // The tag first, inline: it settles most tests without a call.
      if (simple.tag !== null && simple.tag !== node.tag) {
        spent += 1;
        continue;
      }
      if (matchesSimple(node, simple, facts)) m |= bit;
    }
    out[g] = m;
    out[k + g] = a;
    out[2 * k + g] = s;
  }
  settle(ctx);
}

function isMatch(state: Int32Array, group: Compiled): boolean {
  for (let g = 0; g < group.selectors.length; g++) {
    if (((state[g] as number) & (group.selectors[g] as CompiledSelector).last) !== 0) return true;
  }
  return false;
}

function elementCount(children: ReadonlyArray<Node>): number {
  let count = 0;
  for (const child of children) if (child.type === "element") count++;
  return count;
}

/**
 * `node`'s own bitsets, in the context of its whole ancestor chain. Each
 * ancestor's earlier siblings are evaluated (their subtrees never are), so
 * the cost is the chain plus those siblings.
 */
function stateOf(node: Element, group: Compiled, ctx: MatchContext): Int32Array {
  const width = 3 * group.selectors.length;
  const chain: Element[] = [];
  for (let at: Element | null = node; at !== null; at = at.parent) chain.push(at);
  chain.reverse();
  let state = new Int32Array(width);
  evaluate(chain[0] as Element, null, null, noPosition(), group, state, ctx);
  for (let level = 1; level < chain.length; level++) {
    const parent = chain[level - 1] as Element;
    const target = chain[level] as Element;
    const next = new Int32Array(width);
    let previous: Int32Array | null = null;
    let scratch = new Int32Array(width);
    let spare = new Int32Array(width);
    const children = parent.children;
    const count = group.needsCount ? elementCount(children) : -1;
    const types = group.needsTypeIndex ? new Map<string, number>() : null;
    let index = 0;
    let found = false;
    for (const child of children) {
      if (child.type !== "element") continue;
      const typeIndex = types === null ? -1 : (types.get(child.tag) ?? 0);
      const facts: Facts = { index, typeIndex, count, classes: null };
      if (child === target) {
        evaluate(target, state, previous, facts, group, next, ctx);
        found = true;
        break;
      }
      spent += 1;
      if (group.siblings) {
        evaluate(child, state, previous, facts, group, scratch, ctx);
        previous = scratch;
        [scratch, spare] = [spare, scratch];
      }
      types?.set(child.tag, typeIndex + 1);
      index++;
    }
    // A node its parent does not list (a hand-built tree) has no position
    // and no siblings, as in 0.7.0.
    if (!found) evaluate(target, state, null, noPosition(), group, next, ctx);
    state = next;
  }
  return state;
}

/** What a pass does after an element: go into its children, skip them, or stop. */
const DESCEND = 0;
const SKIP = 1;
const STOP = 2;
type Next = typeof DESCEND | typeof SKIP | typeof STOP;

/**
 * Visit every element under `root` in document order, telling `onElement`
 * whether it matches the group. `onLeave` runs after the descendants of each
 * element `onElement` descended into.
 */
function pass(
  root: Element,
  group: Compiled,
  ctx: MatchContext,
  onElement: (node: Element, matched: boolean) => Next,
  onLeave?: (node: Element) => void,
): void {
  const width = 3 * group.selectors.length;
  const rootState = group.contextual ? stateOf(root, group, ctx) : new Int32Array(width);
  // One set of buffers per depth, reused by every element at that depth.
  const nodes: Element[] = [root];
  const lists: Array<ReadonlyArray<Node>> = [root.children];
  const childAt: number[] = [0];
  const index: number[] = [0];
  const counts: number[] = [-1];
  const types: Array<Map<string, number> | null> = [null];
  const hasPrevious: boolean[] = [false];
  const states: Int32Array[] = [rootState];
  const previous: Int32Array[] = [new Int32Array(width)];
  const facts: Facts = noPosition();
  let depth = 0;

  while (depth >= 0) {
    const parent = nodes[depth] as Element;
    const children = lists[depth] as ReadonlyArray<Node>;
    const at = childAt[depth] as number;
    if (at >= children.length) {
      if (depth > 0) onLeave?.(parent);
      depth--;
      continue;
    }
    childAt[depth] = at + 1;
    const node = children[at];
    if (node === undefined || node.type !== "element") continue;

    if (states[depth + 1] === undefined) {
      states[depth + 1] = new Int32Array(width);
      previous[depth + 1] = new Int32Array(width);
    }
    const out = states[depth + 1] as Int32Array;
    facts.index = index[depth] as number;
    index[depth] = facts.index + 1;
    if (group.needsCount) {
      if ((counts[depth] as number) < 0) counts[depth] = elementCount(children);
      facts.count = counts[depth] as number;
    }
    if (group.needsTypeIndex) {
      let seen = types[depth] ?? null;
      if (seen === null) {
        seen = new Map();
        types[depth] = seen;
      }
      facts.typeIndex = seen.get(node.tag) ?? 0;
      seen.set(node.tag, facts.typeIndex + 1);
    }
    facts.classes = null;
    evaluate(
      node,
      states[depth] as Int32Array,
      hasPrevious[depth] ? (previous[depth] as Int32Array) : null,
      facts,
      group,
      out,
      ctx,
    );
    const keep = previous[depth] as Int32Array;
    for (let w = 0; w < width; w++) keep[w] = out[w] as number;
    hasPrevious[depth] = true;

    const next = onElement(node, isMatch(out, group));
    if (next === STOP) return;
    if (next === SKIP) continue;
    depth++;
    nodes[depth] = node;
    lists[depth] = node.children;
    childAt[depth] = 0;
    index[depth] = 0;
    counts[depth] = -1;
    types[depth] = null;
    hasPrevious[depth] = false;
  }
}

/** Run `body`, turning an exhausted budget into an error that names the selector. */
function metered<T>(source: string, ctx: MatchContext, body: () => T): T {
  try {
    return body();
  } catch (err) {
    if (!(err instanceof WorkExhausted)) throw err;
    const shown = source.length > 120 ? `${source.slice(0, 120)}…` : source;
    throw new Error(
      `matching "${shown}" on this page needs more than the ${ctx.limit} units of work one call may spend; use a narrower selector, fewer selectors, or a smaller page`,
    );
  }
}

/** Whether `node` matches `selector`. Pass a context to share one work budget across calls. */
export function matches(
  node: Element,
  selector: Selector,
  ctx: MatchContext = createMatchContext(),
): boolean {
  if (selector.length === 0) return false;
  const group = compileGroup([selector]);
  return metered("the selector", ctx, () => isMatch(stateOf(node, group, ctx), group));
}

/**
 * Every element under `root` matching any selector in the group, in document
 * order. Pass one context to every query a call makes over the same tree, so
 * they share one work budget.
 */
export function queryAll(
  root: Element,
  source: string,
  limit = Number.POSITIVE_INFINITY,
  ctx: MatchContext = createMatchContext(),
): Element[] {
  const group = compile(source, ctx);
  const found: Element[] = [];
  if (limit <= 0) return found;
  metered(source, ctx, () =>
    pass(root, group, ctx, (node, matched) => {
      if (matched) {
        found.push(node);
        if (found.length >= limit) return STOP;
      }
      return DESCEND;
    }),
  );
  return found;
}

export function queryFirst(
  root: Element,
  source: string,
  ctx: MatchContext = createMatchContext(),
): Element | undefined {
  return queryAll(root, source, 1, ctx)[0];
}

/**
 * For each container, the first element strictly inside it that matches
 * `source` — what `queryFirst(container, source)` answers for each — from
 * one pass over `root` rather than one query per container. Every container
 * must be under `root`. The pass goes only into the containers, the elements
 * above them, and the subtree of a container still waiting for its match.
 */
export function firstMatchIn(
  root: Element,
  containers: ReadonlyArray<Element>,
  source: string,
  ctx: MatchContext = createMatchContext(),
): Array<Element | undefined> {
  const group = compile(source, ctx);
  const results: Array<Element | undefined> = containers.map(() => undefined);
  const slots = new Map<Element, number[]>();
  containers.forEach((container, i) => {
    const list = slots.get(container);
    if (list === undefined) slots.set(container, [i]);
    else list.push(i);
  });
  // The containers and every element above one, up to `root`.
  const onPath = new Set<Element>();
  for (const container of containers) {
    for (let at: Element | null = container; at !== null && at !== root; at = at.parent) {
      if (onPath.has(at)) break;
      onPath.add(at);
    }
  }
  // Containers open around the element in hand that have no match yet,
  // outermost first.
  const waiting: Element[] = [];
  let unresolved = slots.size;
  if (unresolved === 0) return results;
  metered(source, ctx, () =>
    pass(
      root,
      group,
      ctx,
      (node, matched) => {
        if (matched && waiting.length > 0) {
          for (const container of waiting) {
            for (const i of slots.get(container) as number[]) results[i] = node;
          }
          unresolved -= waiting.length;
          waiting.length = 0;
          if (unresolved === 0) return STOP;
        }
        if (slots.has(node)) waiting.push(node);
        return onPath.has(node) || waiting.length > 0 ? DESCEND : SKIP;
      },
      (node) => {
        if (waiting[waiting.length - 1] === node) {
          waiting.pop();
          unresolved--;
        }
      },
    ),
  );
  return results;
}
