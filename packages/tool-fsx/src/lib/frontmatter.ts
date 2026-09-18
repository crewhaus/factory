/**
 * YAML front matter, restricted to a subset small enough to round-trip
 * exactly. The subset is the contract — anything outside it is refused with
 * the offending line rather than guessed at, because a front-matter parser
 * that quietly mis-reads a value is worse than one that says it cannot.
 *
 * Accepted:
 *   - a block fenced by `---` on the first line and a later `---` line
 *   - top-level `key: value` pairs only, no indentation on the key
 *   - scalar values: `true` / `false`, `null` / `~`, integers, floats,
 *     `'single quoted'` (with `''` for a literal quote), `"double quoted"`
 *     (with `\\`, `\"`, `\n`, `\t`, `\r` escapes), or a plain string
 *   - sequences, either flow (`[a, b]`) or block (`- a` on following lines,
 *     indented), whose items are scalars by the same rules
 *   - `#` comments on their own line, and after a plain scalar when preceded
 *     by whitespace
 *
 * Refused: nested mappings, multi-line scalars (`|`, `>`), anchors and
 * aliases (`&`, `*`), explicit tags (`!`), merge keys, and duplicate keys.
 */

export type FrontmatterScalar = string | number | boolean | null;
export type FrontmatterValue = FrontmatterScalar | FrontmatterScalar[];
export type FrontmatterData = Record<string, FrontmatterValue>;

export type SplitResult = {
  /** True when the text opened with a `---` fence that was closed. */
  readonly found: boolean;
  /** The raw YAML between the fences; "" when there is none. */
  readonly yaml: string;
  /** Everything after the closing fence (or the whole text when unfenced). */
  readonly body: string;
  /** "\r\n" when the document used CRLF endings, else "\n". */
  readonly eol: "\n" | "\r\n";
};

/** Split a markdown document into its front matter and its body. */
export function splitFrontmatter(text: string): SplitResult {
  const eol: "\n" | "\r\n" = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split("\n");
  const firstLine = (lines[0] ?? "").replace(/\r$/, "");
  if (firstLine !== "---") {
    return { found: false, yaml: "", body: text, eol };
  }
  for (let i = 1; i < lines.length; i++) {
    const line = (lines[i] as string).replace(/\r$/, "");
    if (line === "---" || line === "...") {
      const yaml = lines
        .slice(1, i)
        .map((l) => l.replace(/\r$/, ""))
        .join("\n");
      const body = lines.slice(i + 1).join("\n");
      return { found: true, yaml, body, eol };
    }
  }
  // An opening fence with no closing fence is not front matter.
  return { found: false, yaml: "", body: text, eol };
}

export class FrontmatterError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(line > 0 ? `${message} (line ${line} of the front matter)` : message);
    this.name = "FrontmatterError";
    this.line = line;
  }
}

const UNSUPPORTED_VALUE_START = /^[&*!|>]/;

function parseDoubleQuoted(text: string, lineNo: number): string {
  let out = "";
  let i = 1;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === undefined) throw new FrontmatterError("unterminated escape", lineNo);
      const mapped =
        next === "n"
          ? "\n"
          : next === "t"
            ? "\t"
            : next === "r"
              ? "\r"
              : next === "0"
                ? "\0"
                : next;
      out += mapped;
      i += 2;
      continue;
    }
    if (ch === '"') {
      const rest = text.slice(i + 1).trim();
      if (rest !== "" && !rest.startsWith("#")) {
        throw new FrontmatterError(`unexpected text after a quoted value: ${rest}`, lineNo);
      }
      return out;
    }
    out += ch;
    i += 1;
  }
  throw new FrontmatterError("unterminated double-quoted string", lineNo);
}

function parseSingleQuoted(text: string, lineNo: number): string {
  let out = "";
  let i = 1;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === "'") {
      if (text[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      const rest = text.slice(i + 1).trim();
      if (rest !== "" && !rest.startsWith("#")) {
        throw new FrontmatterError(`unexpected text after a quoted value: ${rest}`, lineNo);
      }
      return out;
    }
    out += ch;
    i += 1;
  }
  throw new FrontmatterError("unterminated single-quoted string", lineNo);
}

function parseScalar(raw: string, lineNo: number): FrontmatterScalar {
  const text = raw.trim();
  if (text === "") return "";
  if (text.startsWith('"')) return parseDoubleQuoted(text, lineNo);
  if (text.startsWith("'")) return parseSingleQuoted(text, lineNo);
  if (UNSUPPORTED_VALUE_START.test(text)) {
    throw new FrontmatterError(
      `value starts with "${text[0]}", which this subset does not support (no anchors, aliases, tags or block scalars)`,
      lineNo,
    );
  }
  // A plain scalar ends at " #", which starts a comment.
  const commentAt = text.search(/\s#/);
  const value = (commentAt === -1 ? text : text.slice(0, commentAt)).trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?(?:0|[1-9]\d*)$/.test(value)) return Number.parseInt(value, 10);
  if (/^-?(?:0|[1-9]\d*)\.\d+$/.test(value)) return Number.parseFloat(value);
  return value;
}

/** Split a flow sequence body on commas that are not inside quotes. */
function splitFlowItems(body: string, lineNo: number): string[] {
  const items: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    if (quote !== undefined) {
      current += ch;
      if (ch === "\\" && quote === '"') {
        const next = body[i + 1];
        if (next !== undefined) {
          current += next;
          i += 1;
        }
        continue;
      }
      if (ch === quote) {
        if (quote === "'" && body[i + 1] === "'") {
          current += "'";
          i += 1;
          continue;
        }
        quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "[" || ch === "]" || ch === "{" || ch === "}") {
      throw new FrontmatterError("nested collections are not supported in this subset", lineNo);
    }
    if (ch === ",") {
      items.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (quote !== undefined) throw new FrontmatterError("unterminated quoted string", lineNo);
  if (current.trim() !== "" || items.length > 0) items.push(current);
  return items;
}

const KEY_LINE = /^([A-Za-z0-9_][A-Za-z0-9._-]*)\s*:(.*)$/;

/** Parse the YAML subset. Throws `FrontmatterError` on anything outside it. */
export function parseFrontmatter(yaml: string): FrontmatterData {
  const data: FrontmatterData = {};
  const lines = yaml === "" ? [] : yaml.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const lineNo = i + 1;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      i += 1;
      continue;
    }
    if (/^\s/.test(line)) {
      throw new FrontmatterError(`unexpected indentation: ${trimmed}`, lineNo);
    }
    const match = KEY_LINE.exec(line);
    if (match === null) {
      throw new FrontmatterError(`expected "key: value", got: ${trimmed}`, lineNo);
    }
    const key = match[1] as string;
    const rest = (match[2] as string).trim();
    if (Object.hasOwn(data, key)) {
      throw new FrontmatterError(`duplicate key "${key}"`, lineNo);
    }

    if (rest.startsWith("[")) {
      if (!rest.endsWith("]")) {
        throw new FrontmatterError("a flow sequence must open and close on one line", lineNo);
      }
      const inner = rest.slice(1, -1).trim();
      data[key] =
        inner === "" ? [] : splitFlowItems(inner, lineNo).map((s) => parseScalar(s, lineNo));
      i += 1;
      continue;
    }

    if (rest === "" || rest.startsWith("#")) {
      // Either a block sequence follows, or the value is an empty string.
      const items: FrontmatterScalar[] = [];
      let j = i + 1;
      let sawItem = false;
      while (j < lines.length) {
        const next = lines[j] as string;
        const nextTrimmed = next.trim();
        if (nextTrimmed === "" || nextTrimmed.startsWith("#")) {
          j += 1;
          continue;
        }
        if (!/^\s/.test(next)) break;
        if (!nextTrimmed.startsWith("- ") && nextTrimmed !== "-") {
          throw new FrontmatterError(
            `nested mappings are not supported in this subset: ${nextTrimmed}`,
            j + 1,
          );
        }
        items.push(parseScalar(nextTrimmed === "-" ? "" : nextTrimmed.slice(2), j + 1));
        sawItem = true;
        j += 1;
      }
      data[key] = sawItem ? items : "";
      i = sawItem ? j : i + 1;
      continue;
    }

    if (rest.startsWith("{")) {
      throw new FrontmatterError("nested mappings are not supported in this subset", lineNo);
    }
    data[key] = parseScalar(rest, lineNo);
    i += 1;
  }
  return data;
}

const PLAIN_SAFE = /^[A-Za-z0-9][A-Za-z0-9 ._\-/@+]*$/;
const RESERVED_PLAIN = new Set(["true", "false", "null", "~", "yes", "no", "on", "off"]);

/** Quote a string only when a plain scalar would be read back as something else. */
function serializeString(value: string): string {
  if (
    value === "" ||
    value !== value.trim() ||
    !PLAIN_SAFE.test(value) ||
    RESERVED_PLAIN.has(value.toLowerCase()) ||
    /^-?\d/.test(value)
  ) {
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return `"${escaped}"`;
  }
  return value;
}

function serializeScalar(value: FrontmatterScalar): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new FrontmatterError(`cannot serialize the non-finite number ${value}`, 0);
    }
    return String(value);
  }
  return serializeString(value);
}

/**
 * Serialize the subset back to YAML. `keyOrder` lists keys that already
 * existed, in their original order; anything not named there is appended in
 * sorted order, so rewriting a file leaves the operator's layout alone while
 * new keys land somewhere predictable.
 */
export function serializeFrontmatter(
  data: FrontmatterData,
  keyOrder: ReadonlyArray<string> = [],
): string {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const key of keyOrder) {
    if (Object.hasOwn(data, key) && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  for (const key of Object.keys(data).sort()) {
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  const lines: string[] = [];
  for (const key of keys) {
    const value = data[key] as FrontmatterValue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
        continue;
      }
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${serializeScalar(item)}`);
      continue;
    }
    lines.push(`${key}: ${serializeScalar(value)}`);
  }
  return lines.join("\n");
}

/** Rebuild a document from front matter and body, keeping the original EOL. */
export function renderDocument(yaml: string, body: string, eol: "\n" | "\r\n"): string {
  const block = yaml === "" ? "---\n---\n" : `---\n${yaml}\n---\n`;
  const joined = `${block}${body.replace(/^\n/, "")}`;
  return eol === "\r\n" ? joined.replace(/\r?\n/g, "\r\n") : joined;
}
