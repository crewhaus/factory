/**
 * A hand-written XML / HTML-fragment reader.
 *
 * ## What it is
 *
 * A well-formedness-checking parser for the XML that shows up in API
 * responses, RSS feeds, SVG, and configuration files. It is not a conformant
 * XML processor and does not claim to be one.
 *
 * ## Supported
 *
 * - Elements, nesting, attributes (single- or double-quoted), self-closing
 *   tags, text content, and CDATA sections.
 * - The five predefined entities (`&amp; &lt; &gt; &quot; &apos;`) and
 *   numeric character references (`&#65;`, `&#x41;`). A reference outside
 *   the Unicode range, or naming a surrogate, is an error rather than a
 *   crash.
 * - Comments, processing instructions (`<?xml ... ?>`) and `<!DOCTYPE ...>`
 *   are skipped, not returned.
 * - Namespace prefixes are kept verbatim as part of the name (`ns:tag`);
 *   they are not resolved to URIs.
 * - In `html` mode, the void elements (`br`, `img`, `input`, `meta`, `link`,
 *   `hr`, `area`, `base`, `col`, `embed`, `param`, `source`, `track`, `wbr`)
 *   are treated as self-closing, unquoted attribute values are accepted, and
 *   tag names are compared case-insensitively.
 *
 * ## Not supported — each raises an error rather than guessing
 *
 * - DTD-declared entities, parameter entities and external entity references
 *   (so this parser cannot be made to fetch anything: there is no resolver).
 * - Validation against a DTD or schema, `xml:space`, and attribute-value
 *   normalization beyond entity expansion.
 * - Mismatched or unclosed tags are an error in `xml` mode. In `html` mode a
 *   mismatched close tag that matches an open ancestor closes the
 *   intervening elements, which is what browsers do; anything else is an
 *   error.
 * - Raw-text elements (`<script>`, `<style>`) are parsed as ordinary
 *   elements, so `<` inside them must be escaped.
 */

export class XmlError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(message);
    this.line = line;
  }
}

export type XmlElement = {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
};
export type XmlText = { text: string };
export type XmlNode = XmlElement | XmlText;

export function isElement(node: XmlNode): node is XmlElement {
  return Object.hasOwn(node, "name");
}

const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

export type XmlParseOptions = {
  mode: "xml" | "html";
  /** Drop text nodes that are only whitespace, which is nearly always formatting. */
  trimWhitespace: boolean;
  maxDepth: number;
};

/** Parse a document or fragment into a list of top-level nodes. */
export function parseXml(text: string, options: XmlParseOptions): XmlNode[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let i = 0;
  let line = 1;
  const root: XmlNode[] = [];
  const stack: XmlElement[] = [];

  const current = (): XmlNode[] => {
    const top = stack[stack.length - 1];
    return top === undefined ? root : top.children;
  };
  const advance = (to: number): void => {
    for (let k = i; k < to; k++) if (src[k] === "\n") line += 1;
    i = to;
  };
  const pushText = (raw: string): void => {
    if (raw === "") return;
    const value = decodeEntities(raw, line);
    if (options.trimWhitespace && value.trim() === "") return;
    current().push({ text: options.trimWhitespace ? value.trim() : value });
  };

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      pushText(src.slice(i));
      break;
    }
    if (lt > i) {
      const raw = src.slice(i, lt);
      advance(lt);
      pushText(raw);
    }
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      if (end < 0) throw new XmlError("unterminated comment", line);
      advance(end + 3);
      continue;
    }
    if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i + 9);
      if (end < 0) throw new XmlError("unterminated CDATA section", line);
      const raw = src.slice(i + 9, end);
      if (!(options.trimWhitespace && raw.trim() === "")) current().push({ text: raw });
      advance(end + 3);
      continue;
    }
    if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i + 2);
      if (end < 0) throw new XmlError("unterminated processing instruction", line);
      advance(end + 2);
      continue;
    }
    if (src.startsWith("<!", i)) {
      if (/^<!ENTITY/i.test(src.slice(i))) {
        throw new XmlError("entity declarations are not supported", line);
      }
      const end = src.indexOf(">", i + 2);
      if (end < 0) throw new XmlError("unterminated declaration", line);
      advance(end + 1);
      continue;
    }
    if (src.startsWith("</", i)) {
      const end = src.indexOf(">", i + 2);
      if (end < 0) throw new XmlError("unterminated close tag", line);
      const rawName = src.slice(i + 2, end).trim();
      const name = options.mode === "html" ? rawName.toLowerCase() : rawName;
      const depth = findOpen(stack, name);
      if (depth < 0) {
        throw new XmlError(`close tag </${rawName}> has no matching open tag`, line);
      }
      if (depth !== stack.length - 1 && options.mode === "xml") {
        const open = stack[stack.length - 1] as XmlElement;
        throw new XmlError(`expected </${open.name}>, found </${rawName}>`, line);
      }
      stack.length = depth;
      advance(end + 1);
      continue;
    }
    // An open tag.
    const tag = readTag(src, i, line, options.mode);
    const element: XmlElement = { name: tag.name, attributes: tag.attributes, children: [] };
    current().push(element);
    advance(tag.end);
    const selfClosing =
      tag.selfClosing || (options.mode === "html" && VOID_ELEMENTS.has(tag.name.toLowerCase()));
    if (!selfClosing) {
      if (stack.length >= options.maxDepth) {
        throw new XmlError(`nesting deeper than ${options.maxDepth} elements`, line);
      }
      stack.push(element);
    }
  }
  if (stack.length > 0 && options.mode === "xml") {
    const open = stack[stack.length - 1] as XmlElement;
    throw new XmlError(`element <${open.name}> is never closed`, line);
  }
  return root;
}

function findOpen(stack: ReadonlyArray<XmlElement>, name: string): number {
  for (let d = stack.length - 1; d >= 0; d--) {
    if ((stack[d] as XmlElement).name === name) return d;
  }
  return -1;
}

const NAME_CHAR = /[A-Za-z0-9_.:\-]/;

function readTag(
  src: string,
  start: number,
  line: number,
  mode: "xml" | "html",
): { name: string; attributes: Record<string, string>; selfClosing: boolean; end: number } {
  let i = start + 1;
  const nameStart = i;
  while (i < src.length && NAME_CHAR.test(src[i] as string)) i += 1;
  if (i === nameStart) throw new XmlError("expected an element name after '<'", line);
  const raw = src.slice(nameStart, i);
  const name = mode === "html" ? raw.toLowerCase() : raw;
  const attributes: Record<string, string> = {};

  for (;;) {
    while (i < src.length && /\s/.test(src[i] as string)) i += 1;
    if (i >= src.length) throw new XmlError(`unterminated tag <${raw}>`, line);
    if (src.startsWith("/>", i)) return { name, attributes, selfClosing: true, end: i + 2 };
    if (src[i] === ">") return { name, attributes, selfClosing: false, end: i + 1 };
    const attrStart = i;
    while (i < src.length && NAME_CHAR.test(src[i] as string)) i += 1;
    if (i === attrStart) {
      throw new XmlError(`unexpected ${JSON.stringify(src[i] ?? "")} in tag <${raw}>`, line);
    }
    const attrRaw = src.slice(attrStart, i);
    const attrName = mode === "html" ? attrRaw.toLowerCase() : attrRaw;
    while (i < src.length && /\s/.test(src[i] as string)) i += 1;
    if (src[i] !== "=") {
      // A bare attribute is HTML's `<input disabled>`; XML requires a value.
      if (mode === "xml") throw new XmlError(`attribute "${attrRaw}" has no value`, line);
      attributes[attrName] = "";
      continue;
    }
    i += 1;
    while (i < src.length && /\s/.test(src[i] as string)) i += 1;
    const quote = src[i];
    if (quote === '"' || quote === "'") {
      const end = src.indexOf(quote, i + 1);
      if (end < 0) throw new XmlError(`unterminated value for "${attrRaw}"`, line);
      attributes[attrName] = decodeEntities(src.slice(i + 1, end), line);
      i = end + 1;
      continue;
    }
    if (mode === "xml") throw new XmlError(`value for "${attrRaw}" must be quoted`, line);
    const valueStart = i;
    while (i < src.length && !/[\s>]/.test(src[i] as string)) i += 1;
    attributes[attrName] = decodeEntities(src.slice(valueStart, i), line);
  }
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Expand the predefined entities and numeric references; anything else is an error. */
export function decodeEntities(text: string, line: number): string {
  if (!text.includes("&")) return text;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c !== "&") {
      out += c;
      continue;
    }
    const semi = text.indexOf(";", i + 1);
    if (semi < 0 || semi - i > 12) {
      throw new XmlError("a bare '&' must be written as '&amp;'", line);
    }
    const body = text.slice(i + 1, semi);
    i = semi;
    if (body.startsWith("#x") || body.startsWith("#X")) {
      out += codePoint(body, Number.parseInt(body.slice(2), 16), line);
      continue;
    }
    if (body.startsWith("#")) {
      out += codePoint(body, Number.parseInt(body.slice(1), 10), line);
      continue;
    }
    const named = NAMED_ENTITIES[body];
    if (named === undefined) {
      throw new XmlError(
        `unknown entity &${body}; — only the five predefined ones are known`,
        line,
      );
    }
    out += named;
  }
  return out;
}

/**
 * Turn a parsed character-reference number into its character, refusing
 * anything Unicode has no code point for. Without the range check
 * `String.fromCodePoint` throws a `RangeError`, which would escape the tool
 * as a crash instead of arriving as a readable result — `&#-1;` and
 * `&#x110000;` are a caller's malformed input, not a bug in the parser.
 */
function codePoint(body: string, code: number, line: number): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) {
    throw new XmlError(`character reference &${body}; is not a Unicode code point`, line);
  }
  if (code >= 0xd800 && code <= 0xdfff) {
    throw new XmlError(`character reference &${body}; is an unpaired surrogate`, line);
  }
  return String.fromCodePoint(code);
}

/**
 * Collapse the explicit tree into the compact shape most callers want:
 * attributes under `@name`, text under `#text`, and repeated child elements
 * as arrays. An element with one text child and no attributes becomes that
 * string, which is what makes the result pleasant to query.
 */
export function toCompact(nodes: ReadonlyArray<XmlNode>): unknown {
  const out: Record<string, unknown> = {};
  const texts: string[] = [];
  for (const node of nodes) {
    if (!isElement(node)) {
      texts.push(node.text);
      continue;
    }
    const value = compactElement(node);
    const existing = out[node.name];
    if (existing === undefined) out[node.name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[node.name] = [existing, value];
  }
  const text = texts.join("").trim();
  if (Object.keys(out).length === 0) return text;
  if (text !== "") out["#text"] = text;
  return out;
}

function compactElement(el: XmlElement): unknown {
  const attrs = Object.keys(el.attributes);
  const inner = toCompact(el.children);
  if (attrs.length === 0) return inner;
  const out: Record<string, unknown> = {};
  for (const a of attrs) out[`@${a}`] = el.attributes[a];
  if (typeof inner === "string") {
    if (inner !== "") out["#text"] = inner;
    return out;
  }
  Object.assign(out, inner);
  return out;
}

/** All the text under a node, concatenated — the XPath `string()` of it. */
export function textContent(node: XmlNode): string {
  if (!isElement(node)) return node.text;
  return node.children.map(textContent).join("");
}
