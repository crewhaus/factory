/**
 * A LENIENT block-YAML reader for the credentials / channels / security
 * panels, and the typed accessors those panels read the spec through.
 *
 * WHY NOT `parseSpec`. `@crewhaus/spec`'s parser is a strict zod schema: it
 * REFUSES a document with an unrecognised key. That is exactly right for the
 * compiler — and exactly wrong for a fleet console, which must render a
 * harness whose spec is a schema version ahead of (or behind) this manager,
 * or that simply has a typo the operator is on their way to fix. A panel
 * that shows nothing until the spec is perfect is the least useful moment to
 * be useless. `schedulers.ts` already took this stance for its cadence scan;
 * this module generalises it from "find one scalar" to "read the block", so
 * `channels:` / `mcp_servers:` / `gateway:` / `observability:` can be walked
 * as ordinary objects.
 *
 * WHAT IT UNDERSTANDS. The block subset real specs are written in: nested
 * maps by indentation, `- ` sequences (scalar and map items), single/double
 * quoted and bare scalars, `#` comments, and `|`/`>` block scalars (folded
 * to text so `instructions` survives). Flow collections are read only in
 * their one-line form (`[a, b]`, `{}`). Anything it cannot read becomes
 * `undefined` rather than an exception — every caller here treats an
 * unreadable block as "not declared", which is the same answer a missing
 * block gives and never a 500.
 *
 * WHAT IT IS NOT. It is not a YAML implementation and must never become the
 * basis of a WRITE. Spec writes go through `@crewhaus/spec-patch`'s
 * CST-preserving editor; this reader exists so a READ can be tolerant.
 */

/** A parsed document node: object, array, string, number, boolean, or null. */
export type YamlNode = unknown;

type Line = { readonly indent: number; readonly text: string; readonly raw: string };

/** Indentation width of a line (tabs count as one — YAML forbids them for
 *  indentation, so a tabbed document is already unparseable everywhere). */
function indentOf(raw: string): number {
  let n = 0;
  while (n < raw.length && (raw[n] === " " || raw[n] === "\t")) n += 1;
  return n;
}

/** Split the document into content lines, dropping blanks and whole-line
 *  comments (both are transparent to block structure). */
function contentLines(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    out.push({ indent: indentOf(raw), text: trimmed, raw });
  }
  return out;
}

/** Strip a trailing ` # comment` from a scalar, respecting quotes. */
function stripComment(value: string): string {
  let quote: string | undefined;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && i > 0 && (value[i - 1] === " " || value[i - 1] === "\t")) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value;
}

function unquote(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

/** Coerce a bare scalar to boolean / null / number where YAML would. */
function scalar(rawValue: string): YamlNode {
  const value = stripComment(rawValue).trim();
  if (value === "") return "";
  const first = value[0];
  if (first === '"' || first === "'") return unquote(value);
  if (value === "true" || value === "True") return true;
  if (value === "false" || value === "False") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?\d+$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value;
  }
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  // One-line flow collections — the only flow forms specs use in practice.
  if (value === "{}") return {};
  if (value === "[]") return [];
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((part) => scalar(part.trim()));
  }
  return value;
}

/** True when a scalar introduces a `|`/`>` block scalar. */
const BLOCK_SCALAR_RE = /^[|>][-+]?\d*$/;

/** Consume a `|`/`>` block scalar's indented body, returning the joined text
 *  and the index of the first line after it. */
function readBlockScalar(
  lines: readonly Line[],
  start: number,
  parentIndent: number,
): [string, number] {
  const body: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined || line.indent <= parentIndent) break;
    body.push(line.text);
    i += 1;
  }
  return [body.join("\n"), i];
}

/** Split `key: value` at the first colon that is not inside quotes. */
function splitKey(text: string): { key: string; rest: string } | undefined {
  let quote: string | undefined;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ":" && (i + 1 >= text.length || text[i + 1] === " " || text[i + 1] === "\t")) {
      return { key: unquote(text.slice(0, i).trim()), rest: text.slice(i + 1).trim() };
    }
  }
  return undefined;
}

/** Parse the block starting at `start` whose members sit at `indent`.
 *  Returns the node and the index of the first unconsumed line. */
function parseBlock(lines: readonly Line[], start: number, indent: number): [YamlNode, number] {
  const first = lines[start];
  if (first === undefined) return [null, start];
  if (first.text.startsWith("- ") || first.text === "-") return parseSequence(lines, start, indent);
  return parseMapping(lines, start, indent);
}

function parseSequence(lines: readonly Line[], start: number, indent: number): [YamlNode, number] {
  const items: YamlNode[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined || line.indent !== indent) break;
    if (!(line.text.startsWith("- ") || line.text === "-")) break;
    const inline = line.text === "-" ? "" : line.text.slice(2).trim();
    i += 1;
    if (inline === "") {
      const next = lines[i];
      if (next !== undefined && next.indent > indent) {
        const [node, after] = parseBlock(lines, i, next.indent);
        items.push(node);
        i = after;
      } else {
        items.push(null);
      }
      continue;
    }
    const kv = splitKey(inline);
    if (kv === undefined) {
      items.push(scalar(inline));
      continue;
    }
    // `- key: value` opens a mapping whose members are indented to the
    // column the key starts at (two past the dash).
    const itemIndent = indent + 2;
    const synthetic: Line[] = [{ indent: itemIndent, text: inline, raw: inline }];
    let j = i;
    while (j < lines.length) {
      const next = lines[j];
      if (next === undefined || next.indent <= indent) break;
      synthetic.push(next);
      j += 1;
    }
    const [node] = parseMapping(synthetic, 0, itemIndent);
    items.push(node);
    i = j;
  }
  return [items, i];
}

function parseMapping(lines: readonly Line[], start: number, indent: number): [YamlNode, number] {
  const map: Record<string, YamlNode> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined || line.indent !== indent) break;
    const kv = splitKey(line.text);
    if (kv === undefined) break;
    i += 1;
    if (kv.rest === "") {
      const next = lines[i];
      if (next !== undefined && next.indent > indent) {
        const [node, after] = parseBlock(lines, i, next.indent);
        map[kv.key] = node;
        i = after;
      } else {
        map[kv.key] = null;
      }
      continue;
    }
    if (BLOCK_SCALAR_RE.test(kv.rest)) {
      const [body, after] = readBlockScalar(lines, i, indent);
      map[kv.key] = body;
      i = after;
      continue;
    }
    map[kv.key] = scalar(kv.rest);
  }
  return [map, i];
}

/** Read a block-YAML document leniently. Never throws: an unreadable
 *  document yields `undefined`, which every caller reads as "not declared". */
export function readYamlLoose(text: string): YamlNode {
  try {
    const lines = contentLines(text);
    if (lines.length === 0) return {};
    const baseIndent = lines[0]?.indent ?? 0;
    const [node] = parseBlock(lines, 0, baseIndent);
    return node;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Typed accessors — every panel reads the document through these
// ---------------------------------------------------------------------------

/** A plain object, or undefined for anything else. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A non-empty string, or undefined. */
export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A finite number, or undefined. */
export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Walk a dotted path through nested records. */
export function at(doc: unknown, path: readonly string[]): unknown {
  let cursor: unknown = doc;
  for (const key of path) {
    const record = asRecord(cursor);
    if (record === undefined) return undefined;
    cursor = record[key];
  }
  return cursor;
}

/** Every `$UPPER_SNAKE` / `${UPPER_SNAKE}` name a document's TEXT mentions.
 *  Names, never values — an env reference is an indirection, not a secret. */
export function envRefsIn(yamlText: string): string[] {
  const names = new Set<string>();
  for (const match of yamlText.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return [...names].sort();
}
