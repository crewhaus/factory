/**
 * A tolerant HTML parser.
 *
 * Real HTML is not XML. Tags close implicitly, void elements never close,
 * attributes go unquoted, and the markup a page actually serves would fail
 * any strict parser — so a strict parser is useless for the job this
 * package exists to do. This one recovers the way browsers do, for the
 * subset that matters when reading a document: structure, attributes, text.
 *
 * It is not a browser. It does not run scripts, apply CSS, or build the DOM
 * a page would have after its JavaScript ran. What it parses is the markup
 * it was given, which is what a fetch returns.
 */

export type Element = {
  readonly type: "element";
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: Node[];
  parent: Element | null;
};

export type TextNode = { readonly type: "text"; readonly value: string; parent: Element | null };
export type Node = Element | TextNode;

/** Elements that never have children and never close. */
export const VOID_ELEMENTS: ReadonlySet<string> = new Set([
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

/** Elements whose content is text, not markup, until their closing tag. */
const RAW_TEXT: ReadonlySet<string> = new Set(["script", "style", "textarea", "title"]);

/**
 * Which open elements a start tag implicitly closes.
 *
 * `<li>` closes an open `<li>`; a `<td>` closes an open `<td>` or `<th>`.
 * Without these the tree nests every row inside the one before it, and a
 * table of ten rows parses as ten levels deep.
 */
const IMPLICIT_CLOSE: Readonly<Record<string, ReadonlyArray<string>>> = {
  li: ["li"],
  dt: ["dt", "dd"],
  dd: ["dt", "dd"],
  p: ["p"],
  td: ["td", "th"],
  th: ["td", "th"],
  tr: ["td", "th", "tr"],
  thead: ["td", "th", "tr"],
  tbody: ["td", "th", "tr", "thead"],
  tfoot: ["td", "th", "tr", "tbody"],
  option: ["option"],
  optgroup: ["option", "optgroup"],
};

/** Elements a `</p>`-style stray close may not escape past. */
const SCOPE_BARRIERS: ReadonlySet<string> = new Set(["table", "template", "html", "body"]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
  szlig: "ß",
  ccedil: "ç",
  ntilde: "ñ",
  pound: "£",
  euro: "€",
  yen: "¥",
  cent: "¢",
  deg: "°",
  middot: "·",
  bull: "•",
  times: "×",
  divide: "÷",
  laquo: "«",
  raquo: "»",
  sect: "§",
  para: "¶",
  dagger: "†",
  permil: "‰",
  prime: "′",
  ne: "≠",
  le: "≤",
  ge: "≥",
  minus: "−",
  plusmn: "±",
  frac12: "½",
  shy: "",
  zwnj: "",
  zwj: "",
};

/** Expand character references. Unknown ones are left as written. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body.startsWith("#x") || body.startsWith("#X")
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      // Lone surrogates are not characters; emitting one produces a string
      // that cannot be encoded back to UTF-8.
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

const element = (tag: string, attrs: Record<string, string>, parent: Element | null): Element => ({
  type: "element",
  tag,
  attrs,
  children: [],
  parent,
});

/** Parse an attribute list: quoted, unquoted, and bare attributes. */
function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]*)))?/g;
  let m: RegExpExecArray | null = re.exec(source);
  while (m !== null) {
    const name = (m[1] as string).toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    // First wins, which is what browsers do with a repeated attribute.
    if (!(name in attrs)) attrs[name] = decodeEntities(value);
    m = re.exec(source);
  }
  return attrs;
}

export type ParseOptions = {
  /** Cap on the input, in characters. */
  readonly maxChars?: number;
  /** Cap on nesting depth; deeper elements are attached at the cap. */
  readonly maxDepth?: number;
};

const DEFAULT_MAX_CHARS = 16 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 512;

/** Parse markup into a tree rooted at a synthetic element. */
export function parseHtml(source: string, options: ParseOptions = {}): Element {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  if (source.length > maxChars) {
    throw new Error(`the document is ${source.length} characters, over the ${maxChars} limit`);
  }
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  const root = element("#root", {}, null);
  let current = root;
  let depth = 0;
  let i = 0;

  const addText = (value: string): void => {
    if (value === "") return;
    current.children.push({ type: "text", value: decodeEntities(value), parent: current });
  };

  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt === -1) {
      addText(source.slice(i));
      break;
    }
    if (lt > i) addText(source.slice(i, lt));

    // Comments, CDATA and doctype carry no content this package reports.
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<!", lt) || source.startsWith("<?", lt)) {
      const end = source.indexOf(">", lt);
      i = end === -1 ? source.length : end + 1;
      continue;
    }

    const isClose = source.startsWith("</", lt);
    const nameStart = lt + (isClose ? 2 : 1);
    const nameMatch = /^[a-zA-Z][^\s/>]*/.exec(source.slice(nameStart, nameStart + 128));
    if (nameMatch === null) {
      // A `<` that begins no tag is literal text, which is common in the wild.
      addText("<");
      i = lt + 1;
      continue;
    }
    const tag = (nameMatch[0] as string).toLowerCase();

    // Find the end of the tag, respecting quoted attribute values so a `>`
    // inside one does not terminate it early.
    let cursor = nameStart + tag.length;
    let quote: string | null = null;
    while (cursor < source.length) {
      const ch = source[cursor] as string;
      if (quote !== null) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
      cursor++;
    }
    const inner = source.slice(nameStart + tag.length, cursor);
    i = cursor + 1;

    if (isClose) {
      // Walk up to the matching open element, but never past a barrier: a
      // stray `</div>` should not unwind the whole document.
      let node: Element | null = current;
      let unwound = 0;
      while (node !== null && node !== root) {
        if (node.tag === tag) {
          current = (node.parent ?? root) as Element;
          depth = Math.max(0, depth - unwound - 1);
          break;
        }
        if (SCOPE_BARRIERS.has(node.tag)) break;
        node = node.parent;
        unwound++;
      }
      continue;
    }

    for (const closable of IMPLICIT_CLOSE[tag] ?? []) {
      if (current.tag === closable) {
        current = (current.parent ?? root) as Element;
        depth = Math.max(0, depth - 1);
      }
    }

    const attrs = parseAttributes(inner);
    const node = element(tag, attrs, current);
    current.children.push(node);

    const selfClosing = inner.trimEnd().endsWith("/");
    if (VOID_ELEMENTS.has(tag) || selfClosing) continue;

    if (RAW_TEXT.has(tag)) {
      // Everything up to the matching close tag is text, including markup.
      const closeAt = source.toLowerCase().indexOf(`</${tag}`, i);
      const end = closeAt === -1 ? source.length : closeAt;
      const raw = source.slice(i, end);
      if (raw !== "") {
        // Script and style content is never entity-decoded by a browser.
        node.children.push({
          type: "text",
          value: tag === "script" || tag === "style" ? raw : decodeEntities(raw),
          parent: node,
        });
      }
      const gt = closeAt === -1 ? -1 : source.indexOf(">", closeAt);
      i = gt === -1 ? source.length : gt + 1;
      continue;
    }

    if (depth < maxDepth) {
      current = node;
      depth++;
    }
  }

  return root;
}

/** Depth-first walk over every element under `node`. */
export function* walk(node: Element): Generator<Element> {
  for (const child of node.children) {
    if (child.type !== "element") continue;
    yield child;
    yield* walk(child);
  }
}

/** Elements whose text should not appear in a document's readable text. */
const NON_RENDERED: ReadonlySet<string> = new Set(["script", "style", "noscript", "template"]);

/** Elements that introduce a line break in readable text. */
const BLOCK: ReadonlySet<string> = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "div",
  "dd",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

/** The text of a node, with block elements separated by newlines. */
export function textOf(node: Node, skipNonRendered = true): string {
  if (node.type === "text") return node.value;
  if (skipNonRendered && NON_RENDERED.has(node.tag)) return "";
  const parts: string[] = [];
  for (const child of node.children) {
    const text = textOf(child, skipNonRendered);
    if (text === "") continue;
    parts.push(text);
  }
  const joined = parts.join("");
  return BLOCK.has(node.tag) ? `\n${joined}\n` : joined;
}

/** Collapse runs of whitespace the way rendering does, keeping paragraphs. */
export function normalizeText(text: string): string {
  return text
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
