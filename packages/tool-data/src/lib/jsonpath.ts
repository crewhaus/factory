/**
 * A small JSONPath-like query language, implemented here rather than taken
 * from a dependency so its grammar is exactly what is documented and nothing
 * more.
 *
 * ## Supported grammar
 *
 * ```
 * path      := "$"? step*
 * step      := "." name
 *            | ".." name            recursive descent to every `name` at any depth
 *            | ".." "*"             every node at any depth
 *            | "." "*"  |  "[*]"    every element of an array / every value of an object
 *            | "[" index "]"        integer, negative counts from the end
 *            | "[" slice "]"        start:end  or  start:end:step  (Python semantics)
 *            | "[" quoted "]"       'key' or "key" — for keys with dots or spaces
 *            | "[?(" filter ")]"    keep array elements / object values matching filter
 * filter    := "@" ("." name)*  (op literal)?
 * op        := == | != | < | <= | > | >= | =~
 * literal   := number | 'string' | "string" | true | false | null
 * ```
 *
 * A filter with no operator is an existence test: `[?(@.email)]` keeps
 * elements whose `email` is defined and neither null nor false. `=~` matches
 * the string form of the field against a JavaScript regular expression
 * source (no flags).
 *
 * ## Deliberately not supported
 *
 * Unions (`['a','b']`), script expressions beyond the filter grammar above,
 * `length()` and other functions, parent axes, and boolean combinators
 * (`&&`, `||`) inside a filter. Chain two filter steps instead of using
 * `&&`. Anything unsupported raises a parse error naming the offending
 * position, never a silent empty result.
 */

import { getOwn, isPlainObject } from "./json";

export type PathStep =
  | { kind: "child"; name: string }
  | { kind: "descend"; name: string | null }
  | { kind: "wildcard" }
  | { kind: "index"; index: number }
  | { kind: "slice"; start: number | null; end: number | null; step: number }
  | { kind: "filter"; field: string[]; op: FilterOp | null; literal: unknown };

export type FilterOp = "==" | "!=" | "<" | "<=" | ">" | ">=" | "=~";

export class PathError extends Error {}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$-]*/;

/** Match a leading identifier, or null when the text does not start with one. */
function leadingIdent(text: string): string | null {
  const m = IDENT.test(text) ? text.match(IDENT) : null;
  return m === null ? null : m[0];
}

/** Parse a path expression into steps, or throw a `PathError` saying where it broke. */
export function parsePath(expr: string): PathStep[] {
  const steps: PathStep[] = [];
  let i = 0;
  if (expr.startsWith("$")) i = 1;
  const fail = (msg: string): never => {
    throw new PathError(`${msg} at position ${i} of ${JSON.stringify(expr)}`);
  };

  while (i < expr.length) {
    const ch = expr[i];
    if (ch === ".") {
      if (expr[i + 1] === ".") {
        i += 2;
        if (expr[i] === "*") {
          i += 1;
          steps.push({ kind: "descend", name: null });
          continue;
        }
        const name = leadingIdent(expr.slice(i));
        if (name === null) fail("expected a name after '..'");
        i += (name as string).length;
        steps.push({ kind: "descend", name: name as string });
        continue;
      }
      i += 1;
      if (expr[i] === "*") {
        i += 1;
        steps.push({ kind: "wildcard" });
        continue;
      }
      const name = leadingIdent(expr.slice(i));
      if (name === null) fail("expected a name after '.'");
      i += (name as string).length;
      steps.push({ kind: "child", name: name as string });
      continue;
    }
    if (ch === "[") {
      i += 1;
      const close = findBracketEnd(expr, i);
      if (close < 0) fail("unclosed '['");
      const inner = expr.slice(i, close);
      steps.push(parseBracket(inner, expr, i));
      i = close + 1;
      continue;
    }
    const bare = steps.length === 0 ? leadingIdent(expr.slice(i)) : null;
    if (bare !== null) {
      // Allow a leading bare name: `users[0].name` means `$.users[0].name`.
      i += bare.length;
      steps.push({ kind: "child", name: bare });
      continue;
    }
    fail(`unexpected character ${JSON.stringify(ch)}`);
  }
  return steps;
}

/** Find the `]` that closes the bracket opened before `from`, skipping quoted text. */
function findBracketEnd(expr: string, from: number): number {
  let depth = 1;
  let quote: string | null = null;
  for (let i = from; i < expr.length; i++) {
    const c = expr[i];
    if (quote !== null) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c as string;
      continue;
    }
    if (c === "[") depth += 1;
    else if (c === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseBracket(inner: string, whole: string, at: number): PathStep {
  const body = inner.trim();
  const fail = (msg: string): never => {
    throw new PathError(`${msg} at position ${at} of ${JSON.stringify(whole)}`);
  };
  if (body === "*") return { kind: "wildcard" };
  if (body.startsWith("?(") && body.endsWith(")")) {
    return parseFilter(body.slice(2, -1).trim(), whole, at);
  }
  if (body.startsWith("?")) return parseFilter(body.slice(1).trim(), whole, at);
  if (
    (body.startsWith("'") && body.endsWith("'")) ||
    (body.startsWith('"') && body.endsWith('"'))
  ) {
    if (body.length < 2) fail("empty quoted key");
    return { kind: "child", name: unquote(body) };
  }
  if (body.includes(":")) {
    const parts = body.split(":");
    if (parts.length > 3) fail("a slice takes at most start:end:step");
    const num = (s: string | undefined, label: string): number | null => {
      if (s === undefined || s.trim() === "") return null;
      const n = Number(s.trim());
      if (!Number.isInteger(n)) fail(`slice ${label} must be an integer`);
      return n;
    };
    const step = num(parts[2], "step") ?? 1;
    if (step === 0) fail("slice step cannot be 0");
    return { kind: "slice", start: num(parts[0], "start"), end: num(parts[1], "end"), step };
  }
  const n = Number(body);
  if (body !== "" && Number.isInteger(n)) return { kind: "index", index: n };
  if (body === "") fail("empty '[]'");
  fail(`cannot read ${JSON.stringify(body)} as an index, slice, quoted key or filter`);
  return { kind: "wildcard" };
}

function unquote(s: string): string {
  return s.slice(1, -1).replace(/\\(.)/g, "$1");
}

function parseFilter(body: string, whole: string, at: number): PathStep {
  const fail = (msg: string): never => {
    throw new PathError(`${msg} at position ${at} of ${JSON.stringify(whole)}`);
  };
  if (!body.startsWith("@")) fail("a filter must start with '@'");
  let rest = body.slice(1);
  const field: string[] = [];
  while (rest.startsWith(".") || rest.startsWith("[")) {
    if (rest.startsWith(".")) {
      const name = leadingIdent(rest.slice(1));
      if (name === null) break;
      field.push(name);
      rest = rest.slice(1 + name.length);
    } else {
      const end = findBracketEnd(rest, 1);
      if (end < 0) fail("unclosed '[' in a filter");
      field.push(unquoteOrRaw(rest.slice(1, end).trim()));
      rest = rest.slice(end + 1);
    }
  }
  rest = rest.trim();
  if (rest === "") return { kind: "filter", field, op: null, literal: undefined };
  const ops: FilterOp[] = ["==", "!=", "<=", ">=", "=~", "<", ">"];
  const found = ops.find((o) => rest.startsWith(o));
  if (found === undefined) fail(`expected a comparison operator, got ${JSON.stringify(rest)}`);
  const op = found as FilterOp;
  const literalText = rest.slice(op.length).trim();
  return { kind: "filter", field, op, literal: parseLiteral(literalText, whole, at) };
}

function unquoteOrRaw(s: string): string {
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return unquote(s);
  }
  return s;
}

function parseLiteral(text: string, whole: string, at: number): unknown {
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  if (
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('"') && text.endsWith('"'))
  ) {
    if (text.length >= 2) return unquote(text);
  }
  const n = Number(text);
  if (text !== "" && Number.isFinite(n)) return n;
  throw new PathError(
    `cannot read ${JSON.stringify(text)} as a literal at position ${at} of ${JSON.stringify(whole)}`,
  );
}

/** One result of a query: the value, plus the normalized path that reaches it. */
export type PathMatch = { path: string; value: unknown };

/**
 * One step of a match's location. A number is an array index, a string is an
 * object key — the distinction has to be carried, because an object may have
 * the key `"0"` and rendering that as `[0]` would produce a path that reads
 * back as an array index and matches nothing.
 */
export type PathSegment = string | number;

/**
 * A node reached by the query. Its location is a link to the node it was
 * reached from plus one segment, rendered into a path only for the matches
 * that are returned: 0.7.0 copied the whole path array for every node it
 * visited, which is quadratic in depth for a `..` step.
 */
type Node = {
  readonly value: unknown;
  readonly parent: Node | null;
  readonly seg: PathSegment | null;
};

/**
 * The most nodes one query may visit, counting every node a step produces
 * and every node a `..` walk passes. A single pass over the largest document
 * this package accepts is well inside it; a path that walks the document
 * again for each node it found (`$..*..x` over a deep document) is what it
 * stops.
 */
export const MAX_QUERY_VISITS = 5_000_000;

export type QueryResult = {
  matches: PathMatch[];
  /**
   * True when there are, or may be, matches past the ones returned: the
   * limit was reached, or the query stopped at the visit budget.
   */
  truncated: boolean;
  /** Set when the query stopped at MAX_QUERY_VISITS rather than at the limit. */
  stoppedAtVisits?: number;
};

/**
 * Run a parsed path over a value, returning matches in document order.
 *
 * Evaluated lazily, depth first: each node a step produces runs through the
 * remaining steps before the next is produced, which gives exactly the
 * step-by-step, document-order result, and lets the query stop as soon as it
 * has one match more than `limit` (to know it truncated). 0.7.0 built each
 * step's whole node list first and then cut it at 20 x limit — so `$..*`
 * materialized every node with its path, and a cut in the middle of a path
 * silently dropped real matches: `$[*].b` over thirty records with `b` only
 * in the last answered zero matches, not truncated.
 */
export function queryPath(
  root: unknown,
  steps: ReadonlyArray<PathStep>,
  limit: number,
  maxVisits = MAX_QUERY_VISITS,
): QueryResult {
  const found: Node[] = [];
  const want = Math.max(limit, 0) + 1;
  const budget = { left: maxVisits };
  const start: Node = { value: root, parent: null, seg: null };
  let stopped = false;
  if (steps.length === 0) {
    found.push(start);
  } else {
    // One iterator per step: iterators[i] yields step i's outputs for the
    // node the level above handed it. An explicit stack, not recursion, so a
    // long path cannot overflow it.
    const iterators: Array<Iterator<Node>> = [expand(steps[0] as PathStep, start, budget)];
    while (iterators.length > 0) {
      const next = (iterators[iterators.length - 1] as Iterator<Node>).next();
      if (budget.left < 0) {
        stopped = true;
        break;
      }
      if (next.done === true) {
        iterators.pop();
        continue;
      }
      if (iterators.length === steps.length) {
        found.push(next.value);
        if (found.length >= want) break;
        continue;
      }
      iterators.push(expand(steps[iterators.length] as PathStep, next.value, budget));
    }
  }
  const shown = found.slice(0, Math.max(limit, 0));
  return {
    matches: shown.map((n) => ({ path: renderPath(segmentsOf(n)), value: n.value })),
    truncated: stopped || found.length > shown.length,
    ...(stopped ? { stoppedAtVisits: maxVisits } : {}),
  };
}

function segmentsOf(node: Node): PathSegment[] {
  const out: PathSegment[] = [];
  for (let n: Node | null = node; n !== null && n.seg !== null; n = n.parent) out.push(n.seg);
  return out.reverse();
}

const child = (parent: Node, seg: PathSegment, value: unknown): Node => ({ value, parent, seg });

/** The nodes one step produces from `node`, lazily, charging each to the budget. */
function* expand(step: PathStep, node: Node, budget: { left: number }): Generator<Node> {
  const v = node.value;
  switch (step.kind) {
    case "child": {
      if (isPlainObject(v) && Object.hasOwn(v, step.name)) {
        budget.left -= 1;
        yield child(node, step.name, v[step.name]);
      }
      return;
    }
    case "wildcard": {
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          budget.left -= 1;
          yield child(node, i, v[i]);
        }
      } else if (isPlainObject(v)) {
        for (const k of Object.keys(v)) {
          budget.left -= 1;
          yield child(node, k, v[k]);
        }
      }
      return;
    }
    case "descend": {
      const name = step.name;
      for (const n of descendants(node, budget)) {
        if (name === null) {
          if (n !== node) yield n;
        } else if (isPlainObject(n.value) && Object.hasOwn(n.value, name)) {
          yield child(n, name, n.value[name]);
        }
      }
      return;
    }
    case "index": {
      if (!Array.isArray(v)) return;
      const i = step.index < 0 ? v.length + step.index : step.index;
      if (i >= 0 && i < v.length) {
        budget.left -= 1;
        yield child(node, i, v[i]);
      }
      return;
    }
    case "slice": {
      if (!Array.isArray(v)) return;
      for (const i of sliceIndices(v.length, step.start, step.end, step.step)) {
        budget.left -= 1;
        yield child(node, i, v[i]);
      }
      return;
    }
    case "filter": {
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          budget.left -= 1;
          if (matchesFilter(v[i], step)) yield child(node, i, v[i]);
        }
      } else if (isPlainObject(v)) {
        for (const k of Object.keys(v)) {
          budget.left -= 1;
          if (matchesFilter(v[k], step)) yield child(node, k, v[k]);
        }
      }
      return;
    }
    default:
      return;
  }
}

/**
 * `node` and everything under it, depth-first pre-order, lazily. An explicit
 * stack of child cursors, one per level, so a deep document costs one frame
 * per level and never a recursion.
 */
function* descendants(node: Node, budget: { left: number }): Generator<Node> {
  budget.left -= 1;
  yield node;
  type Cursor = { readonly of: Node; readonly keys: ReadonlyArray<string> | null; at: number };
  const cursorOf = (n: Node): Cursor | null =>
    Array.isArray(n.value)
      ? { of: n, keys: null, at: 0 }
      : isPlainObject(n.value)
        ? { of: n, keys: Object.keys(n.value), at: 0 }
        : null;
  const stack: Cursor[] = [];
  const first = cursorOf(node);
  if (first !== null) stack.push(first);
  while (stack.length > 0) {
    const top = stack[stack.length - 1] as Cursor;
    const container = top.of.value;
    const size = top.keys === null ? (container as unknown[]).length : top.keys.length;
    if (top.at >= size) {
      stack.pop();
      continue;
    }
    const at = top.at;
    top.at += 1;
    const next =
      top.keys === null
        ? child(top.of, at, (container as unknown[])[at])
        : child(
            top.of,
            top.keys[at] as string,
            (container as Record<string, unknown>)[top.keys[at] as string],
          );
    budget.left -= 1;
    yield next;
    const deeper = cursorOf(next);
    if (deeper !== null) stack.push(deeper);
  }
}

/** Python slice semantics, including negative bounds and a negative step. */
export function sliceIndices(
  length: number,
  start: number | null,
  end: number | null,
  step: number,
): number[] {
  const out: number[] = [];
  const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);
  if (step > 0) {
    const s = clamp(start === null ? 0 : start < 0 ? length + start : start, 0, length);
    const e = clamp(end === null ? length : end < 0 ? length + end : end, 0, length);
    for (let i = s; i < e; i += step) out.push(i);
  } else {
    const s = clamp(
      start === null ? length - 1 : start < 0 ? length + start : start,
      -1,
      length - 1,
    );
    const e = clamp(end === null ? -1 : end < 0 ? length + end : end, -1, length - 1);
    for (let i = s; i > e; i += step) out.push(i);
  }
  return out;
}

function matchesFilter(value: unknown, step: Extract<PathStep, { kind: "filter" }>): boolean {
  let cur: unknown = value;
  for (const seg of step.field) {
    if (isPlainObject(cur)) cur = getOwn(cur, seg);
    else if (Array.isArray(cur) && /^-?\d+$/.test(seg)) {
      const i = Number(seg);
      cur = cur[i < 0 ? cur.length + i : i];
    } else return false;
  }
  if (step.op === null) return cur !== undefined && cur !== null && cur !== false;
  const lit = step.literal;
  if (step.op === "==") return looseEqual(cur, lit);
  if (step.op === "!=") return !looseEqual(cur, lit);
  if (step.op === "=~") {
    if (typeof lit !== "string") return false;
    try {
      return new RegExp(lit).test(String(cur));
    } catch {
      return false;
    }
  }
  if (typeof cur === "number" && typeof lit === "number") {
    return compare(cur < lit, cur > lit, step.op);
  }
  if (typeof cur === "string" && typeof lit === "string") {
    return compare(cur < lit, cur > lit, step.op);
  }
  return false;
}

function compare(lt: boolean, gt: boolean, op: FilterOp): boolean {
  if (op === "<") return lt;
  if (op === "<=") return lt || !gt;
  if (op === ">") return gt;
  if (op === ">=") return gt || !lt;
  return false;
}

/** `==` compares scalars by value; objects and arrays never equal a literal. */
function looseEqual(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === "object" || typeof b === "object") return false;
  return a === b;
}

const SAFE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Render a path as `$.a[0]["odd key"]` — readable, and re-parseable by
 * `parsePath` into a path that reaches the same node in the same document.
 *
 * A numeric *segment* is only written as `[0]` when it really is an array
 * index. An object key that happens to look numeric is written `["0"]`,
 * because `[0]` only ever matches an array and the round trip would
 * otherwise silently return nothing.
 */
export function renderPath(segments: ReadonlyArray<PathSegment>): string {
  let out = "$";
  for (const seg of segments) {
    if (typeof seg === "number") out += `[${seg}]`;
    else if (SAFE_KEY.test(seg)) out += `.${seg}`;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out;
}
