/**
 * The minimal-diff writer: render an edited spec by splicing only the source
 * ranges its edits touched, so every other byte of the author's file —
 * indentation, quoting, flow lists, comments, blank lines — stays as written.
 *
 * `renderMinimal(before, doc, touched)` takes the original text, the edited
 * `yaml` Document (parsed from `before` and changed in place) and the paths
 * the edits named. Each path is placed the narrowest way that fits:
 *
 *   - a plain or quoted scalar: its own range, quoting kept;
 *   - a block scalar: its header and content, re-indented to the content
 *     indentation the file uses;
 *   - a flow collection: that node's range, re-rendered in flow style;
 *   - a block collection replaced by another: its range, re-indented;
 *   - an added key: after the parent map's last pair, at its indentation;
 *   - a deleted key: its lines, with the comment lines attached to it;
 *   - a sequence append: after the last item, with the siblings' dash style;
 *   - anything else (a value that changes kind, a parent emptied): the whole
 *     pair, and failing that the smallest enclosing top-level pair.
 *
 * The result is checked before it is returned: it must parse with no errors,
 * its `toJS()` must equal `doc.toJS()`, and it must carry the same comments a
 * full re-render would. Anything else answers `undefined`, and the caller
 * falls back to `doc.toString()`. A source that holds an alias, or CRLF line
 * ends, is never spliced.
 *
 * Also here: the scalar splice `lint --fix` and `init --provability` use to
 * rewrite one scalar in place ({@link scalarSplice}, {@link applySplices}).
 */
import {
  type Document,
  type Node,
  type Pair,
  type ParsedNode,
  type Scalar,
  type YAMLMap,
  type YAMLSeq,
  isCollection,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  stringify,
  visit,
} from "yaml";

/** One edit path: map keys and sequence indices. */
export type TouchedPath = ReadonlyArray<string | number>;

export type MinimalRender = { readonly yaml: string; readonly formatting: "kept" };

/** A replacement of `src.slice(start, end)` by `text`. */
export type Splice = { readonly start: number; readonly end: number; readonly text: string };

// ---------------------------------------------------------------------------
// the scalar splice (shared with lint --fix and init --provability)
// ---------------------------------------------------------------------------

/**
 * A replacement for a one-line scalar's source that keeps how it was quoted:
 * a double- or single-quoted scalar stays quoted the same way (a value that
 * cannot sit inside those quotes as written is JSON-quoted instead), a plain
 * one stays plain when the value is a plain word, and is JSON-quoted
 * otherwise. `{ quoting: "plain-word" }` writes a plain word bare whatever
 * the old quoting was (a keyword such as a provability level). Undefined for a
 * block scalar or a node with no source range.
 */
export function scalarSplice(
  src: string,
  node: Scalar,
  value: string,
  opts: { readonly quoting?: "keep" | "plain-word" } = {},
): Splice | undefined {
  const range = node.range;
  if (range === undefined || range === null) return undefined;
  if (node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED") return undefined;
  const [start, end] = range;
  const written = src.slice(start, end);
  const plainWord = /^[A-Za-z0-9_$][\w.$-]*$/.test(value);
  if (opts.quoting === "plain-word" && plainWord) return { start, end, text: value };
  const quote = written.startsWith('"') ? '"' : written.startsWith("'") ? "'" : "";
  let text: string;
  if (quote === '"') {
    text = JSON.stringify(value);
  } else if (quote === "'") {
    text = /[\n\r]/.test(value) ? JSON.stringify(value) : `'${value.replace(/'/g, "''")}'`;
  } else {
    text = plainWord ? value : JSON.stringify(value);
  }
  return { start, end, text };
}

/** Apply non-overlapping splices to `src`, last first. */
export function applySplices(src: string, splices: ReadonlyArray<Splice>): string {
  let out = src;
  for (const s of [...splices].sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, s.start)}${s.text}${out.slice(s.end)}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------

function lineStart(text: string, pos: number): number {
  return text.lastIndexOf("\n", pos - 1) + 1;
}

/** The position after the newline that ends the line holding `pos` (a line start stays put). */
function lineEnd(text: string, pos: number): number {
  if (pos > 0 && text[pos - 1] === "\n") return pos;
  const i = text.indexOf("\n", pos);
  return i === -1 ? text.length : i + 1;
}

function column(text: string, pos: number): number {
  return pos - lineStart(text, pos);
}

function lineIndent(text: string, pos: number): number {
  const start = lineStart(text, pos);
  let i = start;
  while (text[i] === " ") i++;
  return i - start;
}

/** Shift every line after the first (or every line) by `delta` columns; undefined when a line has too few. */
function reindent(text: string, delta: number, fromFirst: boolean): string | undefined {
  if (delta === 0) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if ((i === 0 && !fromFirst) || line === "") {
      out.push(line);
      continue;
    }
    if (delta > 0) {
      out.push(`${" ".repeat(delta)}${line}`);
      continue;
    }
    const cut = -delta;
    if (line.slice(0, cut).trim() !== "") return undefined;
    out.push(line.slice(Math.min(cut, line.length)));
  }
  return out.join("\n");
}

class Unplaceable extends Error {}

function need<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Unplaceable();
  return value;
}

// ---------------------------------------------------------------------------
// node access
// ---------------------------------------------------------------------------

type Located = { node: ParsedNode; parent: YAMLMap | YAMLSeq | undefined; pair?: Pair };

/** Path segments as the document reads them: an index under a sequence is a number. */
function canonical(doc: Document, path: TouchedPath): Array<string | number> {
  const out: Array<string | number> = [];
  let node: unknown = doc.contents;
  for (const seg of path) {
    if (isSeq(node)) {
      const index = typeof seg === "number" ? seg : Number(seg);
      out.push(Number.isInteger(index) ? index : seg);
      node = Number.isInteger(index) ? node.items[index] : undefined;
    } else if (isMap(node)) {
      const key = String(seg);
      out.push(key);
      node = node.get(key, true);
    } else {
      out.push(seg);
      node = undefined;
    }
  }
  return out;
}

function locate(doc: Document, path: ReadonlyArray<string | number>): Located | undefined {
  let node: unknown = doc.contents;
  let parent: YAMLMap | YAMLSeq | undefined;
  let pair: Pair | undefined;
  for (const seg of path) {
    if (isMap(node)) {
      parent = node;
      pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === String(seg)) as
        | Pair
        | undefined;
      if (pair === undefined) return undefined;
      node = pair.value;
    } else if (isSeq(node) && typeof seg === "number") {
      parent = node;
      pair = undefined;
      node = node.items[seg];
    } else {
      return undefined;
    }
    if (node === undefined || node === null) return undefined;
  }
  if (path.length === 0)
    return node === null || node === undefined
      ? undefined
      : { node: node as ParsedNode, parent: undefined };
  return { node: node as ParsedNode, parent, ...(pair !== undefined ? { pair } : {}) };
}

type Kind = "inline-scalar" | "block-scalar" | "flow" | "block" | "other";

function kindOf(node: unknown): Kind {
  if (isScalar(node)) {
    return node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED"
      ? "block-scalar"
      : "inline-scalar";
  }
  if (isCollection(node)) return node.flow === true ? "flow" : "block";
  return "other";
}

function rangeOf(node: unknown): [number, number, number] {
  const range = (node as { range?: [number, number, number] | null }).range;
  return need(range ?? undefined);
}

/** Where a node's text ends, its trailing comment lines included, at a line start. */
function nodeEnd(text: string, node: unknown): number {
  const end = rangeOf(node)[2];
  const start = lineStart(text, end);
  return text.slice(start, end).trim() === "" ? start : lineEnd(text, end);
}

/** Structural equality of parsed YAML values (plain data: no runtime-specific helper, so the main entry runs anywhere). */
function sameJs(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameJs(item, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.hasOwn(right, key) && sameJs(left[key], right[key]));
}

function jsOf(node: unknown): unknown {
  return isScalar(node) || isCollection(node) ? (node as Node).toJSON() : node;
}

// ---------------------------------------------------------------------------
// placement
// ---------------------------------------------------------------------------

type Ctx = {
  readonly before: string;
  readonly beforeDoc: Document.Parsed;
  readonly full: string;
  readonly fullDoc: Document.Parsed;
  readonly doc: Document;
};

/** The text of a whole map pair, `[key line start, value end)`. */
function pairSpan(text: string, pair: Pair): [number, number] {
  const keyStart = rangeOf(pair.key)[0];
  const end =
    pair.value === null || pair.value === undefined
      ? lineEnd(text, rangeOf(pair.key)[1])
      : nodeEnd(text, pair.value);
  return [lineStart(text, keyStart), end];
}

/** The text of a whole block-sequence item, `[dash line start, item end)`; the item must start its line. */
function itemSpan(text: string, item: unknown): [number, number] {
  const start = rangeOf(item)[0];
  const ls = lineStart(text, start);
  if (!/^\s*-\s+$/.test(text.slice(ls, start))) throw new Unplaceable();
  return [ls, nodeEnd(text, item)];
}

/** The whole entry (pair or item) at `path`, in a block parent: `[start, end)` plus its indentation. */
function entrySpan(
  text: string,
  doc: Document,
  path: ReadonlyArray<string | number>,
): { span: [number, number]; indent: number } {
  const at = need(locate(doc, path));
  if (at.parent === undefined) throw new Unplaceable();
  if (at.parent.flow === true) throw new Unplaceable();
  if (isMap(at.parent)) {
    const pair = need(at.pair);
    return { span: pairSpan(text, pair), indent: column(text, rangeOf(pair.key)[0]) };
  }
  const span = itemSpan(text, at.node);
  return { span, indent: lineIndent(text, span[0]) };
}

/** Replace the whole entry at `path` (it exists on both sides). */
function replaceEntry(ctx: Ctx, path: ReadonlyArray<string | number>): Splice {
  const old = entrySpan(ctx.before, ctx.beforeDoc, path);
  const now = entrySpan(ctx.full, ctx.fullDoc, path);
  const text = need(
    reindent(ctx.full.slice(now.span[0], now.span[1]), old.indent - now.indent, true),
  );
  return { start: old.span[0], end: old.span[1], text };
}

/** Replace a node's own range with its new rendering. */
function replaceNode(ctx: Ctx, path: ReadonlyArray<string | number>): Splice | "skip" {
  const old = need(locate(ctx.beforeDoc, path)).node;
  const now = need(locate(ctx.fullDoc, path)).node;
  const oldKind = kindOf(old);
  const newKind = kindOf(now);
  if (oldKind === newKind && sameJs(jsOf(old), jsOf(now)) && oldKind !== "block-scalar") {
    return "skip";
  }
  const [oldStart, oldEnd] = rangeOf(old);
  if (oldKind === "flow" && (newKind === "flow" || newKind === "block")) {
    // Padded (`[ a, b ]`) or tight (`[a, b]`), as the source wrote it.
    const padded = /^[[{] /.test(ctx.before.slice(oldStart, oldEnd));
    const text = stringify(jsOf(now), {
      collectionStyle: "flow",
      flowCollectionPadding: padded,
      lineWidth: 0,
    }).replace(/\n$/, "");
    if (text.includes("\n")) throw new Unplaceable();
    return { start: oldStart, end: oldEnd, text };
  }
  if (oldKind !== newKind) return replaceEntry(ctx, path);
  const [newStart, newEnd] = rangeOf(now);
  const rendered = ctx.full.slice(newStart, newEnd);
  if (oldKind === "inline-scalar") {
    if (rendered.includes("\n")) return replaceEntry(ctx, path);
    return { start: oldStart, end: oldEnd, text: rendered };
  }
  if (oldKind === "block-scalar") {
    const header = rendered.slice(0, rendered.indexOf("\n") + 1 || rendered.length);
    if (/\d/.test(header) || /\d/.test(ctx.before.slice(oldStart, lineEnd(ctx.before, oldStart)))) {
      throw new Unplaceable();
    }
    const contentIndent = (text: string, start: number, end: number): number | undefined => {
      const body = text.slice(lineEnd(text, start), end).split("\n");
      const first = body.find((line) => line.trim() !== "");
      return first === undefined ? undefined : first.length - first.trimStart().length;
    };
    const fullIndent = contentIndent(ctx.full, newStart, newEnd);
    const beforeIndent =
      contentIndent(ctx.before, oldStart, oldEnd) ??
      (fullIndent === undefined
        ? undefined
        : lineIndent(ctx.before, oldStart) + (fullIndent - lineIndent(ctx.full, newStart)));
    const delta =
      fullIndent === undefined || beforeIndent === undefined ? 0 : beforeIndent - fullIndent;
    return { start: oldStart, end: oldEnd, text: need(reindent(rendered, delta, false)) };
  }
  if (oldKind === "block") {
    const delta = column(ctx.before, oldStart) - column(ctx.full, newStart);
    return { start: oldStart, end: oldEnd, text: need(reindent(rendered, delta, false)) };
  }
  throw new Unplaceable();
}

/** Insert the new child `childPath` of the block collection at `parentPath`. */
function insertChild(
  ctx: Ctx,
  parentPath: ReadonlyArray<string | number>,
  childPath: ReadonlyArray<string | number>,
): Splice {
  const parentOld = need(locate(ctx.beforeDoc, parentPath)).node;
  const parentNew = need(locate(ctx.fullDoc, parentPath)).node;
  if (!isCollection(parentOld) || parentOld.flow === true || parentOld.items.length === 0) {
    throw new Unplaceable();
  }
  if (isMap(parentOld)) {
    if (!isMap(parentNew)) throw new Unplaceable();
    const last = parentOld.items[parentOld.items.length - 1] as Pair;
    const first = parentOld.items[0] as Pair;
    const at = pairSpan(ctx.before, last)[1];
    const key = String(childPath[childPath.length - 1]);
    const pairNew = need(
      parentNew.items.find((p) => isScalar(p.key) && String(p.key.value) === key) as
        | Pair
        | undefined,
    );
    const [s, e] = pairSpan(ctx.full, pairNew);
    const delta =
      column(ctx.before, rangeOf(first.key)[0]) - column(ctx.full, rangeOf(pairNew.key)[0]);
    let text = need(reindent(ctx.full.slice(s, e), delta, true));
    if (at > 0 && ctx.before[at - 1] !== "\n") text = `\n${text}`;
    return { start: at, end: at, text };
  }
  // A sequence: only an append at the end.
  const seqOld = parentOld as YAMLSeq;
  const index = childPath[childPath.length - 1];
  if (typeof index !== "number" || index !== seqOld.items.length || !isSeq(parentNew)) {
    throw new Unplaceable();
  }
  const lastOld = seqOld.items[seqOld.items.length - 1];
  const [lastStart, lastEnd] = itemSpan(ctx.before, lastOld);
  const dashOld = lineIndent(ctx.before, lastStart);
  const gapOld = column(ctx.before, rangeOf(lastOld)[0]) - dashOld - 1;
  const itemNew = need(parentNew.items[index]);
  const [s, e] = itemSpan(ctx.full, itemNew);
  const dashNew = lineIndent(ctx.full, s);
  const gapNew = column(ctx.full, rangeOf(itemNew)[0]) - dashNew - 1;
  const rendered = ctx.full.slice(s, e);
  const firstBreak = rendered.indexOf("\n");
  const firstLine = firstBreak === -1 ? rendered : rendered.slice(0, firstBreak);
  const rest = firstBreak === -1 ? "" : rendered.slice(firstBreak);
  const content = firstLine.slice(dashNew + 1 + gapNew);
  const head = `${" ".repeat(dashOld)}-${" ".repeat(Math.max(1, gapOld))}${content}`;
  const shift = dashOld + 1 + Math.max(1, gapOld) - (dashNew + 1 + gapNew);
  let text = head + need(reindent(rest, shift, false));
  if (lastEnd > 0 && ctx.before[lastEnd - 1] !== "\n") text = `\n${text}`;
  return { start: lastEnd, end: lastEnd, text };
}

/** Remove the entry at `path` (present before, absent now), with the comment lines attached to it. */
function removeEntry(ctx: Ctx, path: ReadonlyArray<string | number>): Splice {
  const { span } = entrySpan(ctx.before, ctx.beforeDoc, path);
  let start = span[0];
  const at = need(locate(ctx.beforeDoc, path));
  const keyNode = at.pair?.key as { commentBefore?: string | null } | undefined;
  const attached =
    keyNode?.commentBefore ??
    (at.pair === undefined
      ? (at.node as { commentBefore?: string | null }).commentBefore
      : undefined);
  if (typeof attached === "string" && attached !== "") {
    let lines = attached.split("\n").length;
    while (lines > 0 && start > 0) {
      const prev = lineStart(ctx.before, start - 1);
      if (!ctx.before.slice(prev, start).trimStart().startsWith("#")) break;
      start = prev;
      lines--;
    }
  }
  return { start, end: span[1], text: "" };
}

/** The narrowest splice for one edit path. */
function place(ctx: Ctx, path: ReadonlyArray<string | number>): Splice | "skip" {
  const had = locate(ctx.beforeDoc, path) !== undefined;
  const has = locate(ctx.fullDoc, path) !== undefined;
  if (had && has) return replaceNode(ctx, path);
  if (!had && has) {
    // The deepest prefix the source already has.
    let depth = path.length - 1;
    while (depth > 0 && locate(ctx.beforeDoc, path.slice(0, depth)) === undefined) depth--;
    const parentPath = path.slice(0, depth);
    const parent =
      depth === 0 ? ctx.beforeDoc.contents : need(locate(ctx.beforeDoc, parentPath)).node;
    if (isCollection(parent) && parent.flow !== true) {
      return insertChild(ctx, parentPath, path.slice(0, depth + 1));
    }
    if (depth === 0) throw new Unplaceable();
    return replaceNode(ctx, parentPath);
  }
  if (had && !has) {
    const parentPath = path.slice(0, -1);
    const parentNew =
      parentPath.length === 0 ? ctx.fullDoc.contents : locate(ctx.fullDoc, parentPath)?.node;
    if (isCollection(parentNew) && parentNew.items.length === 0) {
      if (parentPath.length === 0) throw new Unplaceable();
      return replaceNode(ctx, parentPath);
    }
    const parentOld =
      parentPath.length === 0
        ? ctx.beforeDoc.contents
        : need(locate(ctx.beforeDoc, parentPath)).node;
    if (isCollection(parentOld) && parentOld.flow === true) return replaceNode(ctx, parentPath);
    return removeEntry(ctx, path);
  }
  return "skip";
}

/** The top-level pair of `key`, replaced, added or removed whole. */
function placeTop(ctx: Ctx, key: string): Splice | "skip" {
  const path = [key];
  const had = locate(ctx.beforeDoc, path) !== undefined;
  const has = locate(ctx.fullDoc, path) !== undefined;
  if (had && has) {
    const old = need(locate(ctx.beforeDoc, path));
    const now = need(locate(ctx.fullDoc, path));
    if (sameJs(jsOf(old.node), jsOf(now.node))) return "skip";
    return replaceEntry(ctx, path);
  }
  if (!had && has) return insertChild(ctx, [], path);
  if (had && !has) return removeEntry(ctx, path);
  return "skip";
}

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

function commentsOf(doc: Document): string[] {
  const out: string[] = [];
  const add = (c: string | null | undefined): void => {
    if (typeof c === "string" && c !== "") out.push(...c.split("\n").map((l) => l.trim()));
  };
  add(doc.commentBefore);
  add(doc.comment);
  visit(doc, {
    Node(_key, node) {
      add((node as { commentBefore?: string | null }).commentBefore);
      add((node as { comment?: string | null }).comment);
    },
    Pair(_key, pair) {
      add((pair as unknown as { commentBefore?: string | null }).commentBefore);
      add((pair as unknown as { comment?: string | null }).comment);
    },
  });
  return out.filter((c) => c !== "").sort();
}

function hasAlias(doc: Document): boolean {
  let found = false;
  visit(doc, {
    Alias() {
      found = true;
      return visit.BREAK;
    },
  });
  return found;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Render `doc` (parsed from `before` and edited in place) by splicing only
 * the ranges `touched` names into `before`. Undefined when the edits cannot
 * be placed that way, or the spliced text would not read back as `doc`.
 */
export function renderMinimal(
  before: string,
  doc: Document,
  touched: ReadonlyArray<TouchedPath>,
): MinimalRender | undefined {
  try {
    if (before.includes("\r")) return undefined;
    const beforeDoc = parseDocument(before);
    if (beforeDoc.errors.length > 0 || doc.errors.length > 0) return undefined;
    if (!isMap(beforeDoc.contents) || beforeDoc.contents.flow === true) return undefined;
    if (hasAlias(beforeDoc)) return undefined;
    const full = doc.toString();
    const fullDoc = parseDocument(full);
    if (fullDoc.errors.length > 0 || !isMap(fullDoc.contents)) return undefined;
    const ctx: Ctx = { before, beforeDoc, full, fullDoc, doc };

    // Canonical paths, a path under another touched path dropped (the outer one covers it).
    const paths: Array<Array<string | number>> = [];
    for (const raw of touched) {
      if (raw.length === 0) return undefined;
      const a = canonical(beforeDoc, raw);
      const b = canonical(fullDoc, raw);
      const path = a.map((seg, i) => (typeof b[i] === "number" ? b[i] : seg)) as Array<
        string | number
      >;
      if (!paths.some((p) => p.length === path.length && p.every((s, i) => s === path[i]))) {
        paths.push(path);
      }
    }
    const covering = paths.filter(
      (p) =>
        !paths.some((q) => q !== p && q.length < p.length && q.every((seg, i) => seg === p[i])),
    );

    const byKey = new Map<string, Splice[]>();
    const tops = new Set<string>();
    for (const path of covering) {
      const key = String(path[0]);
      let splice: Splice | "skip";
      try {
        splice = place(ctx, path);
      } catch (err) {
        if (!(err instanceof Unplaceable)) throw err;
        tops.add(key);
        continue;
      }
      if (splice === "skip") continue;
      byKey.set(key, [...(byKey.get(key) ?? []), splice]);
    }
    // Two splices that overlap inside one top-level pair collapse to that pair.
    for (const [key, list] of byKey) {
      const sorted = [...list].sort((a, b) => a.start - b.start);
      for (let i = 1; i < sorted.length; i++) {
        if ((sorted[i] as Splice).start < (sorted[i - 1] as Splice).end) tops.add(key);
      }
    }
    const splices: Splice[] = [];
    for (const [key, list] of byKey) if (!tops.has(key)) splices.push(...list);
    for (const key of tops) {
      const top = placeTop(ctx, key);
      if (top !== "skip") splices.push(top);
    }
    const ordered = [...splices].sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1] as Splice;
      const cur = ordered[i] as Splice;
      if (
        cur.start < prev.end ||
        (cur.start === prev.start && cur.end === prev.end && cur.start === cur.end)
      ) {
        return undefined;
      }
    }
    const yaml = applySplices(before, ordered);

    const result = parseDocument(yaml);
    if (result.errors.length > 0) return undefined;
    if (!sameJs(result.toJS(), doc.toJS())) return undefined;
    const want = commentsOf(fullDoc);
    const got = commentsOf(result);
    if (want.length !== got.length || want.some((c, i) => c !== got[i])) return undefined;
    return { yaml, formatting: "kept" };
  } catch (err) {
    if (err instanceof Unplaceable) return undefined;
    return undefined;
  }
}
