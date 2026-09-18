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
import { walk } from "./parse";

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
  return parts.map(parseSelector);
}

const classesOf = (node: Element): string[] =>
  (node.attrs["class"] ?? "").split(/\s+/).filter((c) => c !== "");

function attrMatches(node: Element, test: AttrTest): boolean {
  const raw = node.attrs[test.name];
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

function elementChildren(node: Element | null): Element[] {
  if (node === null) return [];
  return node.children.filter((c): c is Element => c.type === "element");
}

function matchesSimple(node: Element, simple: Simple): boolean {
  if (simple.tag !== null && node.tag !== simple.tag) return false;
  if (simple.id !== null && node.attrs["id"] !== simple.id) return false;
  if (simple.classes.length > 0) {
    const have = classesOf(node);
    if (!simple.classes.every((c) => have.includes(c))) return false;
  }
  for (const attr of simple.attrs) if (!attrMatches(node, attr)) return false;

  for (const pseudo of simple.pseudos) {
    const siblings = elementChildren(node.parent);
    switch (pseudo.kind) {
      case "first-child":
        if (siblings[0] !== node) return false;
        break;
      case "last-child":
        if (siblings[siblings.length - 1] !== node) return false;
        break;
      case "nth-child":
        if (siblings[pseudo.index - 1] !== node) return false;
        break;
      case "nth-of-type": {
        const sameTag = siblings.filter((s) => s.tag === node.tag);
        if (sameTag[pseudo.index - 1] !== node) return false;
        break;
      }
      default:
        if (matchesSimple(node, pseudo.simple)) return false;
    }
  }
  return true;
}

/** Whether `node` matches `selector`, checked right to left. */
export function matches(node: Element, selector: Selector): boolean {
  const last = selector[selector.length - 1];
  if (last === undefined) return false;
  if (!matchesSimple(node, last.simple)) return false;
  return matchesFrom(node, selector, selector.length - 1);
}

function matchesFrom(node: Element, selector: Selector, index: number): boolean {
  if (index === 0) return true;
  const step = selector[index] as Step;
  const previous = selector[index - 1] as Step;

  if (step.combinator === ">") {
    const parent = node.parent;
    if (parent === null || !matchesSimple(parent, previous.simple)) return false;
    return matchesFrom(parent, selector, index - 1);
  }
  if (step.combinator === "+" || step.combinator === "~") {
    const siblings = elementChildren(node.parent);
    const at = siblings.indexOf(node);
    if (at <= 0) return false;
    const candidates =
      step.combinator === "+" ? [siblings[at - 1]] : siblings.slice(0, at).reverse();
    for (const candidate of candidates) {
      if (candidate === undefined) continue;
      if (
        matchesSimple(candidate, previous.simple) &&
        matchesFrom(candidate, selector, index - 1)
      ) {
        return true;
      }
    }
    return false;
  }
  // Descendant: any ancestor may satisfy the previous step.
  let ancestor = node.parent;
  while (ancestor !== null) {
    if (matchesSimple(ancestor, previous.simple) && matchesFrom(ancestor, selector, index - 1)) {
      return true;
    }
    ancestor = ancestor.parent;
  }
  return false;
}

/** Every element under `root` matching any selector in the group. */
export function queryAll(
  root: Element,
  source: string,
  limit = Number.POSITIVE_INFINITY,
): Element[] {
  const group = parseSelectorGroup(source);
  const found: Element[] = [];
  for (const node of walk(root)) {
    if (group.some((selector) => matches(node, selector))) {
      found.push(node);
      if (found.length >= limit) break;
    }
  }
  return found;
}

export function queryFirst(root: Element, source: string): Element | undefined {
  return queryAll(root, source, 1)[0];
}
