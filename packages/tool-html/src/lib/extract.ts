/**
 * Pulling the useful shapes out of a parsed document.
 *
 * Each of these answers a question that otherwise costs a whole page in a
 * context window: what are the rows, where do the links go, what fields does
 * this form want, what does the page say about itself.
 */
import { type Element, normalizeText, textOf, walk } from "./parse";
import { queryAll } from "./select";

const cellText = (node: Element): string => normalizeText(textOf(node));

export type Table = {
  readonly headers: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly caption: string;
};

/**
 * Lift a table into headers and rows.
 *
 * `colspan` and `rowspan` are expanded, because a table that uses them reads
 * as ragged rows otherwise and every column after the span is off by one —
 * which is invisible in the output and wrong in every row after it.
 */
export function extractTable(table: Element): Table {
  const rows = queryAll(table, "tr");
  const grid: string[][] = [];
  // Cells a rowspan above is still occupying, by column index.
  const carry = new Map<number, { text: string; remaining: number }>();

  for (const [rowIndex, row] of rows.entries()) {
    const out: string[] = [];
    let column = 0;
    const drainCarried = (): void => {
      while (carry.has(column)) {
        const held = carry.get(column) as { text: string; remaining: number };
        out[column] = held.text;
        if (held.remaining <= 1) carry.delete(column);
        else carry.set(column, { text: held.text, remaining: held.remaining - 1 });
        column++;
      }
    };

    for (const cell of row.children) {
      if (cell.type !== "element" || (cell.tag !== "td" && cell.tag !== "th")) continue;
      const text = cellText(cell);
      const colspan = Math.max(
        1,
        Math.min(1000, Number.parseInt(cell.attrs["colspan"] ?? "1", 10) || 1),
      );
      const rowspan = Math.max(
        1,
        Math.min(1000, Number.parseInt(cell.attrs["rowspan"] ?? "1", 10) || 1),
      );
      for (let c = 0; c < colspan; c++) {
        drainCarried();
        const at = column;
        out[column] = text;
        column++;
        if (rowspan > 1) carry.set(at, { text, remaining: rowspan - 1 });
      }
    }
    drainCarried();
    grid[rowIndex] = out.map((v) => v ?? "");
  }

  // A header row is one whose cells are all `th`, and only if it is first.
  const firstRow = rows[0];
  const cellsIn = (node: Element | undefined, tags: ReadonlyArray<string>): number =>
    node === undefined
      ? 0
      : node.children.filter((c) => c.type === "element" && tags.includes(c.tag)).length;
  const headerCount = cellsIn(firstRow, ["th"]);
  const hasHeader = headerCount > 0 && headerCount === cellsIn(firstRow, ["td", "th"]);

  const headers = hasHeader ? (grid[0] ?? []) : [];
  const body = hasHeader ? grid.slice(1) : grid;
  const captionNode = table.children.find((c) => c.type === "element" && c.tag === "caption");
  return {
    headers,
    rows: body,
    rowCount: body.length,
    columnCount: grid.length === 0 ? 0 : Math.max(...grid.map((r) => r.length)),
    caption: captionNode === undefined ? "" : cellText(captionNode as Element),
  };
}

export type Link = {
  readonly href: string;
  readonly text: string;
  readonly title: string;
  readonly rel: string;
  readonly external: boolean;
};

/**
 * Every navigable link, with relative hrefs resolved against `baseUrl`.
 *
 * A relative href is useless on its own — half a page's links are `/thing`
 * or `../thing` — so resolving is the point rather than a convenience. A
 * page that declares `<base href>` overrides the supplied base, which is
 * what a browser does.
 */
export function extractLinks(root: Element, baseUrl?: string): Link[] {
  const declared = queryAll(root, "base[href]")[0]?.attrs["href"];
  let base: URL | undefined;
  for (const candidate of [baseUrl, declared]) {
    if (candidate === undefined || candidate === "") continue;
    try {
      base = new URL(candidate, base);
    } catch {
      // A malformed base is ignored rather than fatal: the links are still
      // worth reporting, unresolved.
    }
  }

  const seen = new Set<string>();
  const links: Link[] = [];
  for (const anchor of queryAll(root, "a[href]")) {
    const raw = (anchor.attrs["href"] ?? "").trim();
    if (raw === "" || raw.startsWith("#")) continue;
    let href = raw;
    let external = false;
    if (base !== undefined) {
      try {
        const resolved = new URL(raw, base);
        href = resolved.toString();
        external = resolved.origin !== base.origin;
      } catch {
        // Keep the raw value; `javascript:` and `mailto:` land here.
      }
    }
    const text = normalizeText(textOf(anchor));
    // A JSON pair rather than a joined key: link text is arbitrary page
    // content, and any separator could occur inside it and collide.
    const key = JSON.stringify([href, text]);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({
      href,
      text,
      title: anchor.attrs["title"] ?? "",
      rel: anchor.attrs["rel"] ?? "",
      external,
    });
  }
  return links;
}

export type FormField = {
  readonly name: string;
  readonly type: string;
  readonly value: string;
  readonly label: string;
  readonly required: boolean;
  readonly options: ReadonlyArray<{
    readonly value: string;
    readonly label: string;
    readonly selected: boolean;
  }>;
};

export type Form = {
  readonly action: string;
  readonly method: string;
  readonly id: string;
  readonly name: string;
  readonly fields: ReadonlyArray<FormField>;
};

/** The label text for a control: a `for=` label, a wrapping one, or aria. */
function labelFor(root: Element, control: Element): string {
  const id = control.attrs["id"];
  if (id !== undefined && id !== "" && /^[\w:.-]+$/.test(id)) {
    const explicit = queryAll(root, `label[for="${id}"]`)[0];
    if (explicit !== undefined) return normalizeText(textOf(explicit));
  }
  let ancestor = control.parent;
  while (ancestor !== null) {
    if (ancestor.tag === "label") return normalizeText(textOf(ancestor));
    ancestor = ancestor.parent;
  }
  return control.attrs["aria-label"] ?? control.attrs["placeholder"] ?? "";
}

export function extractForms(root: Element): Form[] {
  return queryAll(root, "form").map((form) => {
    const fields: FormField[] = [];
    for (const control of walk(form)) {
      if (!["input", "select", "textarea", "button"].includes(control.tag)) continue;
      const type =
        control.tag === "input" ? (control.attrs["type"] ?? "text").toLowerCase() : control.tag;
      // A hidden input is a field the server expects; omitting it would make
      // a described form unsubmittable.
      const options =
        control.tag === "select"
          ? queryAll(control, "option").map((option) => ({
              value: option.attrs["value"] ?? normalizeText(textOf(option)),
              label: normalizeText(textOf(option)),
              selected: "selected" in option.attrs,
            }))
          : [];
      fields.push({
        name: control.attrs["name"] ?? "",
        type,
        value:
          control.tag === "textarea"
            ? normalizeText(textOf(control))
            : (control.attrs["value"] ?? ""),
        label: labelFor(root, control),
        required: "required" in control.attrs,
        options,
      });
    }
    return {
      action: form.attrs["action"] ?? "",
      method: (form.attrs["method"] ?? "get").toLowerCase(),
      id: form.attrs["id"] ?? "",
      name: form.attrs["name"] ?? "",
      fields,
    };
  });
}

export type StructuredData = {
  readonly jsonLd: ReadonlyArray<unknown>;
  readonly openGraph: Readonly<Record<string, string>>;
  readonly twitter: Readonly<Record<string, string>>;
  readonly meta: Readonly<Record<string, string>>;
  readonly title: string;
  readonly canonical: string;
  readonly invalid: ReadonlyArray<string>;
};

/** The machine-readable layer a page carries about itself. */
export function extractStructuredData(root: Element): StructuredData {
  const jsonLd: unknown[] = [];
  const invalid: string[] = [];
  for (const script of queryAll(root, 'script[type="application/ld+json"]')) {
    const body = textOf(script, false).trim();
    if (body === "") continue;
    try {
      jsonLd.push(JSON.parse(body));
    } catch (err) {
      // Reported rather than dropped: a page whose JSON-LD is broken looks
      // identical to one carrying none, and those need different action.
      invalid.push((err as Error).message);
    }
  }

  const openGraph: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  const meta: Record<string, string> = {};
  for (const tag of queryAll(root, "meta")) {
    const key = (tag.attrs["property"] ?? tag.attrs["name"] ?? "").toLowerCase();
    const content = tag.attrs["content"];
    if (key === "" || content === undefined) continue;
    if (key.startsWith("og:")) openGraph[key.slice(3)] = content;
    else if (key.startsWith("twitter:")) twitter[key.slice(8)] = content;
    else meta[key] = content;
  }

  const titleNode = queryAll(root, "title")[0];
  return {
    jsonLd,
    openGraph,
    twitter,
    meta,
    title: titleNode === undefined ? "" : normalizeText(textOf(titleNode)),
    canonical: queryAll(root, 'link[rel="canonical"]')[0]?.attrs["href"] ?? "",
    invalid,
  };
}

export type RecordRecipe = {
  readonly container: string;
  readonly fields: Readonly<Record<string, string>>;
};

/**
 * A declarative scrape: one container selector, then a selector per field.
 *
 * A field selector may end in `@attr` to take an attribute instead of text —
 * `a@href` is the usual case, since a link's text is rarely what is wanted.
 * A field that comes back empty is COUNTED, so a recipe that has quietly
 * stopped working shows up as a count rather than as rows of blanks that
 * look like data.
 */
export function extractRecords(
  root: Element,
  recipe: RecordRecipe,
  limit = 1000,
): { records: Array<Record<string, string>>; missing: Record<string, number>; containers: number } {
  const containers = queryAll(root, recipe.container, limit);
  const missing: Record<string, number> = {};
  const records = containers.map((container) => {
    const row: Record<string, string> = {};
    for (const [field, spec] of Object.entries(recipe.fields)) {
      const at = spec.lastIndexOf("@");
      const selector = at === -1 ? spec : spec.slice(0, at);
      const attribute = at === -1 ? null : spec.slice(at + 1);
      const found = selector.trim() === "" ? container : queryAll(container, selector, 1)[0];
      if (found === undefined) {
        row[field] = "";
        missing[field] = (missing[field] ?? 0) + 1;
        continue;
      }
      const value =
        attribute === null || attribute === "text"
          ? normalizeText(textOf(found))
          : (found.attrs[attribute.toLowerCase()] ?? "");
      if (value === "") missing[field] = (missing[field] ?? 0) + 1;
      row[field] = value;
    }
    return row;
  });
  return { records, missing, containers: containers.length };
}

/** A compact outline of the headings, which is often all a caller needs. */
export function outline(root: Element): Array<{ level: number; text: string; id: string }> {
  const out: Array<{ level: number; text: string; id: string }> = [];
  for (const node of walk(root)) {
    const m = /^h([1-6])$/.exec(node.tag);
    if (m === null) continue;
    const text = normalizeText(textOf(node));
    if (text === "") continue;
    out.push({ level: Number(m[1]), text, id: node.attrs["id"] ?? "" });
  }
  return out;
}

/** Chrome a reader usually does not want in the page's prose. */
const BOILERPLATE: ReadonlySet<string> = new Set(["nav", "header", "footer", "aside", "form"]);

/**
 * Never part of a page's readable text.
 *
 * `head` is here because its content is metadata, not prose — a title and a
 * pile of meta tags are not what somebody reading the page sees. The
 * scripted elements are here because their content is code: an earlier
 * version of this walked children directly instead of going through
 * `textOf`, and a page's JSON-LD and inline JavaScript came back as body
 * text, which is both wrong and the largest thing on the page.
 */
const NEVER_PROSE: ReadonlySet<string> = new Set([
  "head",
  "script",
  "style",
  "noscript",
  "template",
]);

/** Elements that put a line break around their text when rendered. */
const BLOCK_LEVEL: ReadonlySet<string> = new Set([
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

/** The page's readable text, optionally without its navigation chrome. */
export function readableText(root: Element, dropBoilerplate: boolean): string {
  const parts: string[] = [];
  const visit = (node: Element): void => {
    if (NEVER_PROSE.has(node.tag)) return;
    if (dropBoilerplate && BOILERPLATE.has(node.tag)) return;
    const block = BLOCK_LEVEL.has(node.tag);
    if (block) parts.push("\n");
    for (const child of node.children) {
      if (child.type === "element") visit(child);
      else parts.push(child.value);
    }
    if (block) parts.push("\n");
  };
  visit(root);
  return normalizeText(parts.join(""));
}
