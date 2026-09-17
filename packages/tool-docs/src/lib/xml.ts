/**
 * A hand-written XML reader, scoped to the XML that OOXML parts contain.
 *
 * ## Why not reuse `@crewhaus/tool-data`'s parser
 *
 * Packages here do not depend on one another. The posture is copied — an
 * exactly documented subset, refusing rather than guessing — but this one is
 * tuned for a different job: OOXML parts are machine-generated, deeply
 * nested, and can be large, so this parser carries hard depth and node caps
 * and keeps namespace prefixes verbatim (`w:p`, `a:t`), which is how every
 * OOXML selector in this package addresses elements.
 *
 * ## Supported
 *
 * - Elements, nesting, attributes (single- or double-quoted), self-closing
 *   tags, text content and CDATA sections.
 * - The five predefined entities (`&amp; &lt; &gt; &quot; &apos;`) and
 *   numeric character references (`&#65;`, `&#x41;`). A reference outside
 *   the Unicode range is an error, not a replacement character.
 * - Comments, processing instructions (`<?xml … ?>`) and `<!DOCTYPE …>`
 *   without an internal subset are skipped.
 * - A leading UTF-8 BOM.
 * - Namespace prefixes are part of the name and are NOT resolved to URIs.
 *   `w:p` is the name; a document that binds the `w:` prefix to something
 *   other than WordprocessingML would be misread, which no real producer
 *   does.
 *
 * ## Not supported — each raises `XmlError`
 *
 * - `<!ENTITY …>` in any form, and therefore every entity-expansion and
 *   external-entity attack (XXE, billion laughs). There is no resolver and
 *   no way to add one: a DOCTYPE with an internal subset is refused outright.
 * - DTD or schema validation, `xml:space`, attribute-value normalization
 *   beyond entity expansion.
 * - Mismatched or unclosed tags.
 * - Text outside the root element other than whitespace.
 */

export class XmlError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = "XmlError";
    this.line = line;
  }
}

export type XmlElement = {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: XmlNode[];
};
export type XmlText = { readonly text: string };
export type XmlNode = XmlElement | XmlText;

export function isElement(node: XmlNode): node is XmlElement {
  return Object.hasOwn(node, "name");
}

export type XmlLimits = {
  readonly maxChars: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
};

export const DEFAULT_XML_LIMITS: XmlLimits = Object.freeze({
  maxChars: 32 * 1024 * 1024,
  maxDepth: 256,
  maxNodes: 2_000_000,
});

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[-A-Za-z0-9_.:]/;

function decodeEntities(raw: string, line: number): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
        throw new XmlError(`character reference ${whole} is outside the Unicode range`, line);
      }
      return String.fromCodePoint(code);
    }
    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        throw new XmlError(
          `undefined entity ${whole}; only the five predefined entities and numeric references are supported`,
          line,
        );
    }
  });
}

/** Parse a whole document into its top-level nodes (normally one element). */
export function parseXml(text: string, limits: XmlLimits = DEFAULT_XML_LIMITS): XmlNode[] {
  if (text.length > limits.maxChars) {
    throw new XmlError(
      `xml is ${text.length} characters, over the ${limits.maxChars} limit`,
      1,
    );
  }
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let i = 0;
  let line = 1;
  let nodes = 0;
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
  const countNode = (): void => {
    nodes += 1;
    if (nodes > limits.maxNodes) {
      throw new XmlError(`xml has more than ${limits.maxNodes} nodes`, line);
    }
  };
  const pushText = (raw: string): void => {
    if (raw === "") return;
    const value = decodeEntities(raw, line);
    if (stack.length === 0) {
      if (value.trim() !== "") throw new XmlError("text outside the root element", line);
      return;
    }
    countNode();
    current().push({ text: value });
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
      if (stack.length > 0) {
        countNode();
        current().push({ text: raw });
      }
      advance(end + 3);
      continue;
    }
    if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i + 2);
      if (end < 0) throw new XmlError("unterminated processing instruction", line);
      advance(end + 2);
      continue;
    }
    if (src.startsWith("<!DOCTYPE", i)) {
      // An internal subset can declare entities, which is the whole XXE and
      // billion-laughs surface. There is no resolver here and there will not
      // be one, so a subset is refused rather than skipped.
      const close = src.indexOf(">", i);
      const bracket = src.indexOf("[", i);
      if (bracket >= 0 && (close < 0 || bracket < close)) {
        throw new XmlError(
          "DOCTYPE with an internal subset is refused: entity declarations are not supported",
          line,
        );
      }
      if (close < 0) throw new XmlError("unterminated DOCTYPE", line);
      advance(close + 1);
      continue;
    }
    if (src.startsWith("</", i)) {
      let j = i + 2;
      while (j < src.length && src[j] !== ">") j++;
      if (j >= src.length) throw new XmlError("unterminated closing tag", line);
      const name = src.slice(i + 2, j).trim();
      const top = stack[stack.length - 1];
      if (top === undefined) throw new XmlError(`closing tag </${name}> with nothing open`, line);
      if (top.name !== name) {
        throw new XmlError(`closing tag </${name}> does not match <${top.name}>`, line);
      }
      stack.pop();
      advance(j + 1);
      continue;
    }
    // An open tag.
    let j = i + 1;
    const first = src[j];
    if (first === undefined || !NAME_START.test(first)) {
      throw new XmlError("expected an element name after '<'", line);
    }
    while (j < src.length && NAME_CHAR.test(src[j] as string)) j++;
    const name = src.slice(i + 1, j);
    const attributes: Record<string, string> = {};
    let selfClosing = false;
    for (;;) {
      while (j < src.length && /\s/.test(src[j] as string)) {
        if (src[j] === "\n") line += 1;
        j++;
      }
      const ch = src[j];
      if (ch === undefined) throw new XmlError(`unterminated tag <${name}`, line);
      if (ch === ">") {
        j += 1;
        break;
      }
      if (ch === "/") {
        if (src[j + 1] !== ">") throw new XmlError(`expected '/>' in <${name}>`, line);
        selfClosing = true;
        j += 2;
        break;
      }
      if (!NAME_START.test(ch)) {
        throw new XmlError(`unexpected character '${ch}' in <${name}>`, line);
      }
      const attrStart = j;
      while (j < src.length && NAME_CHAR.test(src[j] as string)) j++;
      const attrName = src.slice(attrStart, j);
      while (j < src.length && /\s/.test(src[j] as string)) j++;
      if (src[j] !== "=") throw new XmlError(`attribute ${attrName} has no value`, line);
      j += 1;
      while (j < src.length && /\s/.test(src[j] as string)) j++;
      const quote = src[j];
      if (quote !== '"' && quote !== "'") {
        throw new XmlError(`attribute ${attrName} value must be quoted`, line);
      }
      const valueEnd = src.indexOf(quote, j + 1);
      if (valueEnd < 0) throw new XmlError(`unterminated value for ${attrName}`, line);
      attributes[attrName] = decodeEntities(src.slice(j + 1, valueEnd), line);
      j = valueEnd + 1;
    }
    countNode();
    const element: XmlElement = { name, attributes, children: [] };
    current().push(element);
    if (!selfClosing) {
      if (stack.length + 1 > limits.maxDepth) {
        throw new XmlError(`xml nests deeper than ${limits.maxDepth} elements`, line);
      }
      stack.push(element);
    }
    advance(j);
  }
  const unclosed = stack[stack.length - 1];
  if (unclosed !== undefined) throw new XmlError(`<${unclosed.name}> is never closed`, line);
  return root;
}

/** The single root element of a document, or an error saying there is none. */
export function rootElement(nodes: ReadonlyArray<XmlNode>): XmlElement {
  for (const node of nodes) if (isElement(node)) return node;
  throw new XmlError("document has no root element", 1);
}

/** Direct element children with the given name. */
export function childrenNamed(element: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of element.children) if (isElement(child) && child.name === name) out.push(child);
  return out;
}

/** The first direct element child with the given name. */
export function childNamed(element: XmlElement, name: string): XmlElement | undefined {
  for (const child of element.children) if (isElement(child) && child.name === name) return child;
  return undefined;
}

/** Every descendant element with the given name, in document order. */
export function descendants(element: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (node: XmlElement): void => {
    for (const child of node.children) {
      if (!isElement(child)) continue;
      if (child.name === name) out.push(child);
      walk(child);
    }
  };
  walk(element);
  return out;
}

/** All text beneath an element, concatenated in document order. */
export function textOf(element: XmlElement): string {
  let out = "";
  const walk = (node: XmlNode): void => {
    if (isElement(node)) {
      for (const child of node.children) walk(child);
    } else {
      out += node.text;
    }
  };
  walk(element);
  return out;
}

/** Escape a string for use as XML text or an attribute value. */
export function escapeXml(value: string): string {
  let out = "";
  for (const ch of value) {
    switch (ch) {
      case "&":
        out += "&amp;";
        break;
      case "<":
        out += "&lt;";
        break;
      case ">":
        out += "&gt;";
        break;
      case '"':
        out += "&quot;";
        break;
      case "'":
        out += "&apos;";
        break;
      default: {
        const code = ch.codePointAt(0) as number;
        // XML 1.0 forbids most C0 controls outright; drop them rather than
        // emit a document no reader will open.
        if (code < 0x20 && ch !== "\t" && ch !== "\n" && ch !== "\r") break;
        out += ch;
      }
    }
  }
  return out;
}
