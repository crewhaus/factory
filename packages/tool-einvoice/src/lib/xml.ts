/**
 * XML in and out, for the two documents this package builds and the one it
 * reads.
 *
 * READING is delegated: `@crewhaus/tool-data` owns the parser, and a second
 * XML reader in this repository would disagree with the first about entity
 * expansion and about which malformed documents are errors — on the same
 * file, in different tools. What is here is the call into it plus the
 * navigation helpers an invoice mapping needs.
 *
 * WRITING is here because nothing in the repository emits XML and a serializer
 * is not a parser. It is deliberately small and deliberately boring: fixed
 * indentation, attributes in insertion order, no clock, no counters, no
 * `Object.keys` over anything a caller supplied. Two runs over the same record
 * produce the same bytes, which is the property the sha256 in the result
 * claims and which a test in this package pins.
 */

/** An element, as this package builds one. */
export type El = {
  readonly name: string;
  readonly attrs?: Readonly<Record<string, string>>;
  /** Text content, or child elements. Never both — no mixed content is emitted. */
  readonly text?: string;
  readonly children?: ReadonlyArray<El | undefined>;
};

/** The tree shape `@crewhaus/tool-data` returns from `XmlParse` with `shape: "tree"`. */
export type ParsedElement = {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: ReadonlyArray<ParsedNode>;
};
export type ParsedText = { readonly text: string };
export type ParsedNode = ParsedElement | ParsedText;

export function isParsedElement(node: ParsedNode): node is ParsedElement {
  return Object.hasOwn(node, "name");
}

/** Raised when a document cannot be read at all, as opposed to failing a rule. */
export class XmlReadError extends Error {
  override readonly name = "XmlReadError";
}

/**
 * Escape text content. `>` is escaped as well as `<` and `&`, which is not
 * strictly required: it costs nothing and means no output of this package can
 * accidentally close a CDATA section it is pasted into.
 */
export function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape an attribute value. Both quote styles, since either may be chosen later. */
export function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * Control characters XML 1.0 has no representation for at all — not even as a
 * numeric reference. A name carrying one would produce a document no parser
 * accepts, so it is refused here rather than written out and discovered by the
 * recipient's validator.
 */
function hasForbiddenChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    // Tab, line feed and carriage return are the three C0 characters
    // XML 1.0 admits; every other one has no representation at all, not
    // even as a numeric reference.
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
  }
  return false;
}

export function assertXmlSafe(value: string, field: string): void {
  if (hasForbiddenChar(value)) {
    throw new XmlReadError(
      `${field} contains a control character XML 1.0 cannot represent; strip it before building the document`,
    );
  }
}

/**
 * Serialize to a byte-stable string.
 *
 * Indentation is two spaces and line endings are `\n`. An element with text is
 * written on one line, an element with children over several, and an element
 * with neither is written as `<Tag/>` — the three cases the invoice syntaxes
 * actually use. `undefined` children are dropped, which is what lets a mapping
 * be written as a flat list of optional elements rather than as a pile of
 * conditional pushes.
 */
export function serialize(root: El, options?: { declaration?: boolean }): string {
  const out: string[] = [];
  if (options?.declaration !== false) out.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  writeElement(root, 0, out);
  return out.join("");
}

function writeElement(el: El, depth: number, out: string[]): void {
  const pad = "  ".repeat(depth);
  const attrs = el.attrs ?? {};
  let open = `${pad}<${el.name}`;
  for (const [key, value] of Object.entries(attrs)) {
    assertXmlSafe(value, `attribute ${key}`);
    open += ` ${key}="${escapeAttribute(value)}"`;
  }
  const children = (el.children ?? []).filter((c): c is El => c !== undefined);
  if (el.text !== undefined) {
    assertXmlSafe(el.text, `<${el.name}>`);
    out.push(`${open}>${escapeText(el.text)}</${el.name}>\n`);
    return;
  }
  if (children.length === 0) {
    out.push(`${open}/>\n`);
    return;
  }
  out.push(`${open}>\n`);
  for (const child of children) writeElement(child, depth + 1, out);
  out.push(`${pad}</${el.name}>\n`);
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * The part of a tag name after the prefix.
 *
 * Prefixes are a document's own choice: `cac:`, `ram:` and `rsm:` are the
 * conventional ones and nearly every real file uses them, but a conformant
 * UBL invoice may bind the same namespaces to `a:` and `b:` and remain a
 * conformant UBL invoice. Matching on the local name reads both, and the
 * vocabulary is decided from the ROOT's namespace declarations rather than
 * from a prefix anywhere else.
 */
export function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

/** Direct child elements with this local name, in document order. */
export function childrenNamed(el: ParsedElement, name: string): ParsedElement[] {
  const out: ParsedElement[] = [];
  for (const node of el.children) {
    if (isParsedElement(node) && localName(node.name) === name) out.push(node);
  }
  return out;
}

/** The first direct child with this local name, or undefined. */
export function child(el: ParsedElement, name: string): ParsedElement | undefined {
  for (const node of el.children) {
    if (isParsedElement(node) && localName(node.name) === name) return node;
  }
  return undefined;
}

/** Walk a chain of local names: `path(inv, "LegalMonetaryTotal", "PayableAmount")`. */
export function path(el: ParsedElement | undefined, ...names: string[]): ParsedElement | undefined {
  let current = el;
  for (const name of names) {
    if (current === undefined) return undefined;
    current = child(current, name);
  }
  return current;
}

/** All the text under an element, concatenated and trimmed — XPath `string()`. */
export function textOf(el: ParsedElement | undefined): string {
  if (el === undefined) return "";
  let out = "";
  const walk = (node: ParsedNode): void => {
    if (isParsedElement(node)) {
      for (const c of node.children) walk(c);
      return;
    }
    out += node.text;
  };
  for (const node of el.children) walk(node);
  return out.trim();
}

/** `textOf(path(...))`, which is most of an invoice mapping. */
export function textAt(el: ParsedElement | undefined, ...names: string[]): string {
  return textOf(path(el, ...names));
}

/**
 * One attribute's value, or `undefined` when it is absent or empty.
 *
 * Attributes come off the parser as an index signature, so reaching into it
 * with a dot would be an unchecked lookup; this keeps absence and the empty
 * string on the same side of the line, which is what every caller wants of a
 * `schemeID` or a `unitCode`.
 */
export function attr(el: ParsedElement | undefined, name: string): string | undefined {
  const value = el?.attributes[name];
  return value === undefined || value === "" ? undefined : value;
}

/** Every namespace URI the element declares, so a vocabulary can be identified. */
export function declaredNamespaces(el: ParsedElement): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(el.attributes)) {
    if (key === "xmlns" || key.startsWith("xmlns:")) out.push(value);
  }
  return out;
}
