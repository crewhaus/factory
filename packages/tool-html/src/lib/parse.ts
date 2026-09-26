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
 * The close-tag search for each raw-text element, run from the cursor.
 *
 * Case-insensitive WITHOUT the `u` flag, so only ASCII letters fold, as a
 * browser's tag-name match does (`</ſcript>` closes nothing). The search runs
 * on the source itself: the old `source.toLowerCase().indexOf(...)` lowercased
 * the whole document once per raw-text element (quadratic: 256 KB of titles
 * took seconds, the 16 MB limit hours), and its offsets were in the
 * lowercased copy, which is longer wherever a character lowercases to two
 * (`İ`), so the element's text ran into its own close tag.
 */
const RAW_TEXT_CLOSE: ReadonlyMap<string, RegExp> = new Map(
  [...RAW_TEXT].map((tag) => [tag, new RegExp(`</${tag}`, "gi")]),
);

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

/**
 * A null prototype, because the key is whatever name a page wrote between `&`
 * and `;`: on an object literal `&constructor;`, `&valueOf;` and
 * `&toString;` resolved to Object.prototype's functions and decoded into
 * their source text ("function Object() { [native code] }") in the middle of
 * the page's prose.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, string>, {
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
  }),
);

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

/**
 * An attribute map with a null prototype. Attribute names are the page's
 * choice: on a plain object, `constructor` and `__proto__` read as inherited
 * members, so `[constructor]` matched every element, a real `constructor`
 * attribute was dropped as "already present", and `__proto__="x"` set the
 * map's prototype instead of storing a value.
 */
function attributeMap(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

/**
 * The value of attribute `name` on `node`, reading own entries only.
 *
 * Every lookup by a name that came from a caller or a page goes through
 * this, so an Element whose `attrs` some other code built as a plain `{}`
 * still cannot answer with an Object.prototype member.
 */
export function attrOf(node: Element, name: string): string | undefined {
  return Object.hasOwn(node.attrs, name) ? node.attrs[name] : undefined;
}

/** Parse an attribute list: quoted, unquoted, and bare attributes. */
function parseAttributes(source: string): Record<string, string> {
  const attrs = attributeMap();
  const re = /([^\s"'=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]*)))?/g;
  let m: RegExpExecArray | null = re.exec(source);
  while (m !== null) {
    const name = (m[1] as string).toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    // First wins, which is what browsers do with a repeated attribute.
    if (!Object.hasOwn(attrs, name)) attrs[name] = decodeEntities(value);
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

  const root = element("#root", attributeMap(), null);
  let current = root;
  let depth = 0;
  let i = 0;

  // How many open elements of each tag sit between `current` and the nearest
  // scope barrier (inclusive), one map per barrier on the open chain. A close
  // tag with no open element of its name in scope is ignored without walking
  // the chain: the walk cost up to maxDepth per stray close, so 16 MB of
  // `</x>` under deep nesting took most of a minute. Every element counted
  // here is uncounted exactly when it leaves the open chain.
  const scopes: Array<Map<string, number>> = [new Map()];
  const enter = (node: Element): void => {
    if (SCOPE_BARRIERS.has(node.tag)) {
      scopes.push(new Map([[node.tag, 1]]));
      return;
    }
    const top = scopes[scopes.length - 1] as Map<string, number>;
    top.set(node.tag, (top.get(node.tag) ?? 0) + 1);
  };
  const leave = (node: Element): void => {
    if (SCOPE_BARRIERS.has(node.tag)) {
      if (scopes.length > 1) scopes.pop();
      return;
    }
    const top = scopes[scopes.length - 1] as Map<string, number>;
    top.set(node.tag, (top.get(node.tag) ?? 1) - 1);
  };

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
    const name = nameMatch[0] as string;
    const tag = name.toLowerCase();

    // Find the end of the tag, respecting quoted attribute values so a `>`
    // inside one does not terminate it early. Measured on the name as
    // written: its lowercase can be longer (`İ` lowercases to two code units).
    const nameEnd = nameStart + name.length;
    let cursor = nameEnd;
    let quote: string | null = null;
    while (cursor < source.length) {
      const ch = source[cursor] as string;
      if (quote !== null) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
      cursor++;
    }
    const inner = source.slice(nameEnd, cursor);
    i = cursor + 1;

    if (isClose) {
      // Walk up to the matching open element, but never past a barrier: a
      // stray `</div>` should not unwind the whole document. The count says
      // up front whether the walk would find one.
      if (((scopes[scopes.length - 1] as Map<string, number>).get(tag) ?? 0) === 0) continue;
      let node: Element | null = current;
      let unwound = 0;
      while (node !== null && node !== root) {
        if (node.tag === tag) {
          for (let open: Element = current; ; open = open.parent as Element) {
            leave(open);
            if (open === node) break;
          }
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

    for (const closable of Object.hasOwn(IMPLICIT_CLOSE, tag) ? (IMPLICIT_CLOSE[tag] ?? []) : []) {
      if (current.tag === closable) {
        leave(current);
        current = (current.parent ?? root) as Element;
        depth = Math.max(0, depth - 1);
      }
    }

    const attrs = parseAttributes(inner);
    const node = element(tag, attrs, current);
    current.children.push(node);

    const selfClosing = inner.trimEnd().endsWith("/");
    if (VOID_ELEMENTS.has(tag) || selfClosing) continue;

    const closeSearch = RAW_TEXT_CLOSE.get(tag);
    if (closeSearch !== undefined) {
      // Everything up to the matching close tag is text, including markup.
      closeSearch.lastIndex = i;
      const closeAt = closeSearch.exec(source)?.index ?? -1;
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
      enter(node);
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

/**
 * What one call may spend reading element text: characters and nodes read,
 * shared by every element the call takes text from. Nested matches each
 * read their whole subtree, so without it 500 nested `<div>`s cost 500
 * copies of the page.
 */
export type TextWork = { units: number };

/**
 * `normalizeText(textOf(node))`, cut to at most `max` characters, reading
 * no more of the subtree than that needs and charging what it reads to
 * `work`. `complete` is false when the text returned is not all of it:
 * longer than `max`, or the walk stopped because `work` ran out (or the
 * subtree held far more whitespace and markup than text).
 */
export function boundedText(
  node: Node,
  max: number,
  work: TextWork,
): { text: string; complete: boolean } {
  const limit = Math.max(0, Math.floor(max));
  // The raw text a walk may collect: whitespace collapses, so it may need
  // more than `limit` raw characters, but never unboundedly more.
  const rawCap = limit * 8 + 4096;
  const parts: string[] = [];
  let raw = 0;
  let check = limit + 1;
  let complete = true;
  const take = (value: string): boolean => {
    if (value === "") return true;
    let piece = value;
    if (raw + piece.length > rawCap) {
      piece = piece.slice(0, rawCap - raw);
      complete = false;
    }
    if (piece.length > work.units) {
      piece = piece.slice(0, Math.max(0, work.units));
      complete = false;
    }
    work.units -= piece.length;
    parts.push(piece);
    raw += piece.length;
    if (!complete) return false;
    // At doubling lengths, stop once the text is already longer than wanted.
    if (raw >= check) {
      if (normalizeText(parts.join("")).length > limit) {
        complete = false;
        return false;
      }
      check = raw * 2;
    }
    return true;
  };

  if (node.type === "text") {
    take(node.value);
  } else if (!NON_RENDERED.has(node.tag)) {
    const frames: Array<{ node: Element; at: number }> = [{ node, at: 0 }];
    let going = !BLOCK.has(node.tag) || take("\n");
    while (going && frames.length > 0) {
      const frame = frames[frames.length - 1] as { node: Element; at: number };
      if (frame.at >= frame.node.children.length) {
        frames.pop();
        if (BLOCK.has(frame.node.tag)) going = take("\n");
        continue;
      }
      const child = frame.node.children[frame.at] as Node;
      frame.at += 1;
      work.units -= 1;
      if (work.units < 0) {
        complete = false;
        break;
      }
      if (child.type === "text") going = take(child.value);
      else if (!NON_RENDERED.has(child.tag)) {
        frames.push({ node: child, at: 0 });
        if (BLOCK.has(child.tag)) going = take("\n");
      }
    }
  }
  let text = normalizeText(parts.join(""));
  if (text.length > limit) {
    text = text.slice(0, limit);
    complete = false;
  }
  return { text, complete };
}

/** Collapse runs of whitespace the way rendering does, keeping paragraphs. */
export function normalizeText(text: string): string {
  return text
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
