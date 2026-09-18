/**
 * A small, deliberately limited XML reader for the two document shapes this
 * package parses: sitemaps and syndication feeds.
 *
 * It is not a conforming XML processor and does not try to be. What it
 * refuses is the point:
 *
 *   - a DOCTYPE with an internal subset, or any `<!ENTITY>` declaration, is
 *     rejected outright rather than expanded, which is what closes XXE and
 *     the billion-laughs expansion (CWE-611 / CWE-776);
 *   - only the five predefined entities and numeric character references are
 *     decoded — an unknown `&name;` is left as written rather than resolved;
 *   - nesting depth and document size are capped.
 *
 * Namespace prefixes are dropped, so `<dc:creator>` and `<creator>` are the
 * same element here. Feeds in the wild mix prefixes freely and the callers
 * only ever ask for a local name.
 */

export class XmlParseError extends Error {
  override readonly name = "XmlParseError";
}

export type XmlNode = {
  /** Local name, lowercased, prefix removed. */
  readonly name: string;
  /** Attributes keyed by lowercased local name. */
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
  /** Direct text content, entity-decoded, with surrounding whitespace kept. */
  readonly text: string;
};

type Mutable = {
  name: string;
  attrs: Record<string, string>;
  children: Mutable[];
  text: string;
};

export const MAX_XML_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 100;

/** Strip a namespace prefix and lowercase what is left. */
export function localName(raw: string): string {
  const colon = raw.lastIndexOf(":");
  return (colon === -1 ? raw : raw.slice(colon + 1)).toLowerCase();
}

/** Decode the five predefined entities plus numeric character references. */
export function decodeXmlText(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
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
        // Not a predefined entity. Leaving it literal is the safe answer:
        // resolving it is exactly what an XXE payload wants.
        return whole;
    }
  });
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of source.matchAll(ATTR_RE)) {
    const key = localName(match[1] as string);
    attrs[key] = decodeXmlText(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

/** Index just past the `>` that closes the tag starting at `open`. */
function endOfTag(source: string, open: number): number {
  let quote: string | null = null;
  for (let i = open + 1; i < source.length; i++) {
    const ch = source[i] as string;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") return i + 1;
  }
  return -1;
}

/** Parse a document and return its root element. Throws `XmlParseError`. */
export function parseXml(source: string): XmlNode {
  if (source.length > MAX_XML_BYTES) {
    throw new XmlParseError(
      `document is ${source.length} characters, over the ${MAX_XML_BYTES} limit`,
    );
  }
  if (/<!ENTITY/i.test(source)) {
    throw new XmlParseError("refused: the document declares entities (entity-expansion risk)");
  }
  if (/<!DOCTYPE[^>]*\[/i.test(source)) {
    throw new XmlParseError("refused: the document has an internal DTD subset (XXE risk)");
  }

  const root: Mutable = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: Mutable[] = [root];
  let i = 0;

  const top = (): Mutable => stack[stack.length - 1] as Mutable;

  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt === -1) {
      top().text += decodeXmlText(source.slice(i));
      break;
    }
    if (lt > i) top().text += decodeXmlText(source.slice(i, lt));

    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt + 9);
      top().text += source.slice(lt + 9, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<?", lt) || source.startsWith("<!", lt)) {
      const end = endOfTag(source, lt);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (source.startsWith("</", lt)) {
      const end = endOfTag(source, lt);
      if (end === -1) break;
      const name = localName(source.slice(lt + 2, end - 1).trim());
      // Close the nearest matching ancestor; an unmatched closing tag is
      // ignored rather than treated as fatal, because real feeds contain them.
      for (let depth = stack.length - 1; depth >= 1; depth--) {
        if ((stack[depth] as Mutable).name === name) {
          stack.length = depth;
          break;
        }
      }
      i = end;
      continue;
    }

    const end = endOfTag(source, lt);
    if (end === -1) break;
    const inner = source.slice(lt + 1, end - 1);
    const selfClosing = inner.trimEnd().endsWith("/");
    const body = selfClosing ? inner.trimEnd().slice(0, -1) : inner;
    const spaceAt = body.search(/\s/);
    const rawName = spaceAt === -1 ? body : body.slice(0, spaceAt);
    const node: Mutable = {
      name: localName(rawName),
      attrs: spaceAt === -1 ? {} : parseAttrs(body.slice(spaceAt)),
      children: [],
      text: "",
    };
    top().children.push(node);
    if (!selfClosing) {
      if (stack.length >= MAX_DEPTH) {
        throw new XmlParseError(`document nests deeper than ${MAX_DEPTH} elements`);
      }
      stack.push(node);
    }
    i = end;
  }

  const first = root.children[0];
  if (first === undefined) throw new XmlParseError("no root element found");
  return first;
}

/** Every direct child with this local name, in document order. */
export function childrenNamed(node: XmlNode, name: string): readonly XmlNode[] {
  return node.children.filter((c) => c.name === name);
}

/** The first direct child matching any of these local names. */
export function firstNamed(node: XmlNode, ...names: readonly string[]): XmlNode | undefined {
  for (const name of names) {
    const found = node.children.find((c) => c.name === name);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Trimmed text of the first matching child, or `undefined` when absent/blank. */
export function textOf(node: XmlNode, ...names: readonly string[]): string | undefined {
  const child = firstNamed(node, ...names);
  if (child === undefined) return undefined;
  const value = child.text.trim();
  return value === "" ? undefined : value;
}
