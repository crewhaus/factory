/**
 * A hand-written YAML reader and writer for the subset that configuration
 * files actually use. There is no YAML dependency here, so the subset below
 * is exactly what is supported — read it as a contract, not a summary.
 *
 * ## Read: supported
 *
 * - Block mappings (`key: value`), nested by space indentation.
 * - Block sequences (`- item`), including a compact map on the dash line
 *   (`- name: a`) and nested sequences.
 * - Plain, single-quoted and double-quoted scalars. Double-quoted strings
 *   honour `\n \t \r \" \\ \/ \0` and `\uXXXX`.
 * - Core-schema typing of plain scalars: `null`, `~` and an empty value are
 *   null; `true`/`false` are booleans; integers, decimals, exponents, `0x`
 *   and `0o` literals are numbers; everything else is a string.
 * - Flow collections: `[1, two, {a: b}]` and `{a: 1, b: [2]}`, nested.
 * - Block scalars `|` and `>`, with the `-` and `+` chomping indicators.
 * - `#` comments, on their own line or after a value.
 * - A leading `---` and a trailing `...`.
 * - Quoted keys, and keys containing a colon when quoted.
 *
 * `.inf`, `-.inf` and `.nan` read as the JavaScript infinities and NaN, and
 * write back out as `.inf` / `.nan`. JSON has no way to spell any of them,
 * so a YAML-to-JSON conversion renders them `null` — round-tripping a
 * document that uses them has to stay within YAML or TOML.
 *
 * ## Read: rejected with an explicit error, never guessed at
 *
 * Anchors and aliases (`&a`, `*a`), merge keys (`<<:`), explicit tags
 * (`!!str`), multiple documents in one stream, complex keys (`? `), tab
 * characters in indentation, and dates — a date stays a string, because
 * silently producing a `Date` would make the round trip lossy.
 *
 * ## Write
 *
 * Block style only, two-space indent, keys in their existing order. Strings
 * are quoted whenever leaving them bare would change how they read back
 * (empty, padded, or looking like a number, boolean or null). Multi-line
 * strings are written double-quoted with `\n` escapes rather than as block
 * scalars, so the output is unambiguous.
 */

import { isPlainObject } from "./json";

export class YamlError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(message);
    this.line = line;
  }
}

type Line = {
  indent: number;
  content: string;
  lineNo: number;
};

const MAX_DEPTH = 64;

/** Parse a YAML document into JSON values. Throws `YamlError` with a line number. */
export function parseYaml(text: string): unknown {
  const lines = tokenize(text);
  if (lines.length === 0) return null;
  const state = { lines, i: 0 };
  const value = parseNode(state, lines[0]?.indent ?? 0, 0);
  if (state.i < lines.length) {
    const rest = lines[state.i] as Line;
    throw new YamlError(`unexpected content ${JSON.stringify(rest.content)}`, rest.lineNo);
  }
  return value;
}

function tokenize(text: string): Line[] {
  const out: Line[] = [];
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  raw.forEach((original, idx) => {
    const lineNo = idx + 1;
    if (original.trim() === "") return;
    const indentMatch = /^[ \t]*/.exec(original) as RegExpExecArray;
    if (indentMatch[0].includes("\t")) {
      throw new YamlError("tab characters cannot be used for indentation", lineNo);
    }
    const indent = indentMatch[0].length;
    const content = original.slice(indent).replace(/\s+$/, "");
    if (content.startsWith("#")) return;
    if (content === "---") return;
    if (content === "...") return;
    if (content.startsWith("--- ")) {
      throw new YamlError(
        "a document header with content on the same line is not supported",
        lineNo,
      );
    }
    if (content.startsWith("? ")) {
      throw new YamlError("complex mapping keys ('? ') are not supported", lineNo);
    }
    if (content.startsWith("<<:")) {
      throw new YamlError("merge keys ('<<:') are not supported", lineNo);
    }
    out.push({ indent, content, lineNo });
  });
  // Block scalars are re-read from the raw text, so keep it reachable.
  rawSource.set(out, raw);
  return out;
}

/** The original lines behind a token list, needed to read block scalars verbatim. */
const rawSource = new WeakMap<Line[], string[]>();

type State = { lines: Line[]; i: number };

function parseNode(state: State, indent: number, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    const line = state.lines[state.i];
    throw new YamlError(`nesting deeper than ${MAX_DEPTH} levels`, line?.lineNo ?? 0);
  }
  const line = state.lines[state.i];
  if (line === undefined) return null;
  if (isSequenceItem(line.content)) return parseSequence(state, indent, depth);
  if (findKeyColon(line.content) >= 0) return parseMapping(state, indent, depth);
  // A bare scalar document.
  state.i += 1;
  return parseScalarValue(line.content, line.lineNo);
}

function isSequenceItem(content: string): boolean {
  return content === "-" || content.startsWith("- ");
}

function parseSequence(state: State, indent: number, depth: number): unknown[] {
  const out: unknown[] = [];
  while (state.i < state.lines.length) {
    const line = state.lines[state.i] as Line;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new YamlError("unexpected indentation inside a sequence", line.lineNo);
    }
    if (!isSequenceItem(line.content)) break;
    const rest = line.content === "-" ? "" : line.content.slice(2).trimStart();
    if (rest === "") {
      state.i += 1;
      out.push(parseChildBlock(state, indent, depth));
      continue;
    }
    const offset = line.content.length - rest.length;
    // Rewrite the dash line as if `rest` began its own line, so a compact
    // map (`- a: 1`) or a nested sequence (`- - x`) parses by the same rules.
    state.lines[state.i] = { indent: indent + offset, content: rest, lineNo: line.lineNo };
    out.push(parseNode(state, indent + offset, depth + 1));
  }
  return out;
}

function parseMapping(state: State, indent: number, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  while (state.i < state.lines.length) {
    const line = state.lines[state.i] as Line;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new YamlError("unexpected indentation inside a mapping", line.lineNo);
    }
    if (isSequenceItem(line.content)) break;
    const colon = findKeyColon(line.content);
    if (colon < 0) {
      throw new YamlError(
        `expected 'key: value', got ${JSON.stringify(line.content)}`,
        line.lineNo,
      );
    }
    const keyText = line.content.slice(0, colon).trim();
    const key = readKey(keyText, line.lineNo);
    const valueText = stripComment(line.content.slice(colon + 1).trim());
    state.i += 1;
    if (valueText === "") {
      out[key] = parseChildBlock(state, indent, depth);
      continue;
    }
    const block = blockScalarHeader(valueText);
    if (block !== null) {
      out[key] = readBlockScalar(state, indent, block, line.lineNo);
      continue;
    }
    out[key] = parseScalarValue(valueText, line.lineNo);
  }
  return out;
}

/** Parse whatever is indented under the current line, or null when nothing is. */
function parseChildBlock(state: State, indent: number, depth: number): unknown {
  const next = state.lines[state.i];
  if (next === undefined || next.indent <= indent) {
    // A sequence may be written at the same indentation as its key.
    if (next !== undefined && next.indent === indent && isSequenceItem(next.content)) {
      return parseSequence(state, indent, depth + 1);
    }
    return null;
  }
  return parseNode(state, next.indent, depth + 1);
}

/** Find the `:` that separates a key from its value, ignoring quotes and flow markers. */
export function findKeyColon(content: string): number {
  let quote: string | null = null;
  let flow = 0;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (quote !== null) {
      if (quote === '"' && c === "\\") {
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c as string;
      continue;
    }
    if (c === "[" || c === "{") flow += 1;
    else if (c === "]" || c === "}") flow -= 1;
    else if (c === "#" && i > 0 && content[i - 1] === " ") return -1;
    else if (c === ":" && flow === 0) {
      const next = content[i + 1];
      if (next === undefined || next === " ") return i;
    }
  }
  return -1;
}

function readKey(text: string, lineNo: number): string {
  if (text === "") throw new YamlError("empty mapping key", lineNo);
  if (text.startsWith("&") || text.startsWith("*")) {
    throw new YamlError("anchors and aliases are not supported", lineNo);
  }
  if (text.startsWith("!")) throw new YamlError("explicit tags are not supported", lineNo);
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return readQuoted(text, lineNo);
  }
  return text;
}

type BlockHeader = { fold: boolean; chomp: "clip" | "strip" | "keep" };

function blockScalarHeader(text: string): BlockHeader | null {
  const m = /^([|>])([-+]?)$/.exec(text);
  if (m === null) return null;
  const chomp = m[2] === "-" ? "strip" : m[2] === "+" ? "keep" : "clip";
  return { fold: m[1] === ">", chomp };
}

function readBlockScalar(
  state: State,
  parentIndent: number,
  header: BlockHeader,
  lineNo: number,
): string {
  const raw = rawSource.get(state.lines);
  if (raw === undefined) throw new YamlError("internal: lost the source text", lineNo);
  // Collect raw lines after the header until the indentation drops back.
  const body: string[] = [];
  let blockIndent = -1;
  let cursor = lineNo; // raw index of the line after the header (0-based == lineNo)
  for (; cursor < raw.length; cursor++) {
    const text = raw[cursor] as string;
    if (text.trim() === "") {
      body.push("");
      continue;
    }
    const ind = (/^ */.exec(text) as RegExpExecArray)[0].length;
    if (ind <= parentIndent) break;
    if (blockIndent < 0) blockIndent = ind;
    if (ind < blockIndent) break;
    body.push(text.slice(blockIndent));
  }
  // Advance the token cursor past every token that came from those raw lines.
  while (state.i < state.lines.length && (state.lines[state.i] as Line).lineNo <= cursor) {
    state.i += 1;
  }
  while (body.length > 0 && body[body.length - 1] === "") body.pop();
  let out: string;
  if (header.fold) {
    const folded: string[] = [];
    for (const l of body) {
      if (l === "") {
        folded.push("\n");
        continue;
      }
      if (folded.length > 0 && !folded[folded.length - 1]?.endsWith("\n")) folded.push(" ");
      folded.push(l);
    }
    out = folded.join("");
  } else {
    out = body.join("\n");
  }
  if (header.chomp === "strip") return out.replace(/\n+$/, "");
  return `${out}\n`;
}

/** Remove a trailing ` # comment`, respecting quotes. */
export function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote !== null) {
      if (quote === '"' && c === "\\") {
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c as string;
      continue;
    }
    if (c === "#" && (i === 0 || text[i - 1] === " ")) return text.slice(0, i).trimEnd();
  }
  return text;
}

/** Parse a single value: flow collection, quoted string, or plain scalar. */
export function parseScalarValue(text: string, lineNo: number): unknown {
  const t = text.trim();
  if (t.startsWith("&") || (t.startsWith("*") && t.length > 1 && !t.includes(" "))) {
    throw new YamlError("anchors and aliases are not supported", lineNo);
  }
  if (t.startsWith("!")) throw new YamlError("explicit tags are not supported", lineNo);
  if (t.startsWith("[") || t.startsWith("{")) {
    const parsed = parseFlow(t, lineNo);
    return parsed;
  }
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length > 1) ||
    (t.startsWith("'") && t.endsWith("'") && t.length > 1)
  ) {
    return readQuoted(t, lineNo);
  }
  return plainScalar(t);
}

/** Core-schema typing for an unquoted scalar. */
export function plainScalar(t: string): unknown {
  if (t === "" || t === "~" || t === "null" || t === "Null" || t === "NULL") return null;
  if (t === "true" || t === "True" || t === "TRUE") return true;
  if (t === "false" || t === "False" || t === "FALSE") return false;
  if (/^[-+]?(0|[1-9][0-9]*)$/.test(t)) {
    const n = Number(t);
    if (Number.isSafeInteger(n)) return n;
    return t;
  }
  if (/^0x[0-9a-fA-F]+$/.test(t)) return Number.parseInt(t.slice(2), 16);
  if (/^0o[0-7]+$/.test(t)) return Number.parseInt(t.slice(2), 8);
  if (/^[-+]?(\.[0-9]+|[0-9]+\.[0-9]*)([eE][-+]?[0-9]+)?$/.test(t)) return Number(t);
  if (/^[-+]?[0-9]+[eE][-+]?[0-9]+$/.test(t)) return Number(t);
  if (t === ".inf" || t === ".Inf") return Number.POSITIVE_INFINITY;
  if (t === "-.inf" || t === "-.Inf") return Number.NEGATIVE_INFINITY;
  return t;
}

function readQuoted(text: string, lineNo: number): string {
  const q = text[0];
  const body = text.slice(1, -1);
  if (q === "'") return body.replace(/''/g, "'");
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = body[i + 1];
    i += 1;
    switch (n) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case "0":
        out += "\0";
        break;
      case "\\":
        out += "\\";
        break;
      case '"':
        out += '"';
        break;
      case "/":
        out += "/";
        break;
      case "u": {
        const hex = body.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new YamlError(`bad \\u escape ${JSON.stringify(hex)}`, lineNo);
        }
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 4;
        break;
      }
      default:
        throw new YamlError(`unknown escape \\${n ?? ""}`, lineNo);
    }
  }
  return out;
}

/** Parse a flow collection (`[...]` or `{...}`) including nesting. */
export function parseFlow(text: string, lineNo: number): unknown {
  const state = { text, i: 0, lineNo };
  const value = parseFlowNode(state, 0);
  skipFlowSpace(state);
  if (state.i < text.length) {
    throw new YamlError(
      `trailing characters after a flow collection: ${text.slice(state.i)}`,
      lineNo,
    );
  }
  return value;
}

type FlowState = { text: string; i: number; lineNo: number };

function skipFlowSpace(s: FlowState): void {
  while (s.i < s.text.length && (s.text[s.i] === " " || s.text[s.i] === "\t")) s.i += 1;
}

function parseFlowNode(s: FlowState, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new YamlError("flow collection nested too deeply", s.lineNo);
  skipFlowSpace(s);
  const c = s.text[s.i];
  if (c === "[") {
    s.i += 1;
    const out: unknown[] = [];
    skipFlowSpace(s);
    if (s.text[s.i] === "]") {
      s.i += 1;
      return out;
    }
    for (;;) {
      out.push(parseFlowNode(s, depth + 1));
      skipFlowSpace(s);
      const d = s.text[s.i];
      if (d === ",") {
        s.i += 1;
        skipFlowSpace(s);
        if (s.text[s.i] === "]") {
          s.i += 1;
          return out;
        }
        continue;
      }
      if (d === "]") {
        s.i += 1;
        return out;
      }
      throw new YamlError("expected ',' or ']' in a flow sequence", s.lineNo);
    }
  }
  if (c === "{") {
    s.i += 1;
    const out: Record<string, unknown> = {};
    skipFlowSpace(s);
    if (s.text[s.i] === "}") {
      s.i += 1;
      return out;
    }
    for (;;) {
      skipFlowSpace(s);
      const key = parseFlowScalarText(s);
      skipFlowSpace(s);
      if (s.text[s.i] !== ":") throw new YamlError("expected ':' in a flow mapping", s.lineNo);
      s.i += 1;
      out[String(coerceFlowKey(key, s.lineNo))] = parseFlowNode(s, depth + 1);
      skipFlowSpace(s);
      const d = s.text[s.i];
      if (d === ",") {
        s.i += 1;
        skipFlowSpace(s);
        if (s.text[s.i] === "}") {
          s.i += 1;
          return out;
        }
        continue;
      }
      if (d === "}") {
        s.i += 1;
        return out;
      }
      throw new YamlError("expected ',' or '}' in a flow mapping", s.lineNo);
    }
  }
  const raw = parseFlowScalarText(s);
  if (raw.quoted) return readQuoted(raw.text, s.lineNo);
  return plainScalar(raw.text.trim());
}

function coerceFlowKey(key: { text: string; quoted: boolean }, lineNo: number): string {
  return key.quoted ? readQuoted(key.text, lineNo) : key.text.trim();
}

function parseFlowScalarText(s: FlowState): { text: string; quoted: boolean } {
  skipFlowSpace(s);
  const c = s.text[s.i];
  if (c === '"' || c === "'") {
    const start = s.i;
    s.i += 1;
    while (s.i < s.text.length) {
      const d = s.text[s.i];
      if (c === '"' && d === "\\") {
        s.i += 2;
        continue;
      }
      if (d === c) {
        s.i += 1;
        return { text: s.text.slice(start, s.i), quoted: true };
      }
      s.i += 1;
    }
    throw new YamlError("unterminated quoted string in a flow collection", s.lineNo);
  }
  const start = s.i;
  while (s.i < s.text.length && !",:]}".includes(s.text[s.i] as string)) s.i += 1;
  return { text: s.text.slice(start, s.i), quoted: false };
}

// ---------------------------------------------------------------------------
// Writing

const PLAIN_SAFE = /^[A-Za-z_][A-Za-z0-9_./ -]*$/;

/** True when a string can be written bare without changing meaning on re-read. */
export function canWritePlain(s: string): boolean {
  if (s === "") return false;
  if (s !== s.trim()) return false;
  if (!PLAIN_SAFE.test(s)) return false;
  if (s.includes(" #")) return false;
  // Anything that would read back as a non-string must be quoted.
  return typeof plainScalar(s) === "string";
}

function writeScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return value > 0 ? ".inf" : Number.isNaN(value) ? ".nan" : "-.inf";
    return String(value);
  }
  const s = String(value);
  return canWritePlain(s) ? s : JSON.stringify(s);
}

/** Serialize a JSON value as block-style YAML with a two-space indent. */
export function stringifyYaml(value: unknown, indentLevel = 0): string {
  const pad = "  ".repeat(indentLevel);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    return value
      .map((el) => {
        if (isPlainObject(el) && Object.keys(el).length > 0) {
          const body = stringifyYaml(el, indentLevel + 1);
          return `${pad}-${body.slice(pad.length + 1)}`;
        }
        if (Array.isArray(el) && el.length > 0) {
          const body = stringifyYaml(el, indentLevel + 1);
          return `${pad}-${body.slice(pad.length + 1)}`;
        }
        return `${pad}- ${writeScalar(el)}`;
      })
      .join("\n");
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return `${pad}{}`;
    return keys
      .map((k) => {
        const v = value[k];
        const key = canWritePlain(k) ? k : JSON.stringify(k);
        if (Array.isArray(v)) {
          if (v.length === 0) return `${pad}${key}: []`;
          return `${pad}${key}:\n${stringifyYaml(v, indentLevel + 1)}`;
        }
        if (isPlainObject(v)) {
          if (Object.keys(v).length === 0) return `${pad}${key}: {}`;
          return `${pad}${key}:\n${stringifyYaml(v, indentLevel + 1)}`;
        }
        return `${pad}${key}: ${writeScalar(v)}`;
      })
      .join("\n");
  }
  return `${pad}${writeScalar(value)}`;
}
