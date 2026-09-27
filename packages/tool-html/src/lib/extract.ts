/**
 * Pulling the useful shapes out of a parsed document.
 *
 * Each of these answers a question that otherwise costs a whole page in a
 * context window: what are the rows, where do the links go, what fields does
 * this form want, what does the page say about itself.
 */
import {
  type Element,
  type TextWork,
  attrOf,
  boundedText,
  normalizeText,
  textOf,
  walk,
} from "./parse";
import { type MatchContext, createMatchContext, firstMatchIn, queryAll } from "./select";

/**
 * What one call may spend on element text: characters it may return, and
 * text and nodes it may read to find them. Shared by every value the call
 * takes, because a value's text is its whole subtree's: nested matches each
 * carry every deeper one, so 1 MB of nested `<div>`s answered 500 MB.
 */
export type TextBudget = {
  /** Characters still to return. */
  chars: number;
  readonly work: TextWork;
  /** Set once a value came back cut, or none could be read. */
  cut: boolean;
};

export function createTextBudget(chars: number, work: number): TextBudget {
  return { chars, work: { units: work }, cut: false };
}

/** An element's normalized text, within what the budget has left. */
export function textWithin(node: Element, budget: TextBudget): string {
  const { text, complete } = boundedText(node, budget.chars, budget.work);
  budget.chars -= text.length;
  if (!complete) budget.cut = true;
  return text;
}

/** A budget nothing reaches, for the library functions' default. */
const unbounded = (): TextBudget =>
  createTextBudget(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);

export type Table = {
  readonly headers: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
  /** Body rows the table has, whether or not all of them were returned. */
  readonly rowCount: number;
  /** The widest row returned (header included). */
  readonly columnCount: number;
  readonly caption: string;
  /** True when `rows`/`headers` are not the whole table; `truncatedBy` says why. */
  readonly truncated: boolean;
  readonly truncatedBy: ReadonlyArray<"rows" | "columns" | "chars">;
};

/**
 * A budget several tables can share, so many small ones cannot add up past
 * it: characters of result, and (optionally) text a call may read to build
 * them, which nested tables otherwise read once per level.
 */
export type TableBudget = { chars: number; work?: TextWork };

export type TableLimits = {
  /** Body rows to build; the rest are counted, never expanded. */
  readonly maxRows?: number;
  /** Columns per row; cells past it are dropped from every row. */
  readonly maxColumns?: number;
  /** Characters of cell and caption text (plus JSON overhead) to spend, shared across calls. */
  readonly budget?: TableBudget;
  /** The call's matching budget, shared with its other queries. */
  readonly match?: MatchContext;
};

/**
 * Lift a table into headers and rows.
 *
 * `colspan` and `rowspan` are expanded, because a table that uses them reads
 * as ragged rows otherwise and every column after the span is off by one —
 * which is invisible in the output and wrong in every row after it.
 *
 * Expansion is where a table's size stops being its markup's size: one cell
 * with `colspan=1000 rowspan=1000` is a million cells, and each copy carries
 * the cell's whole text. So the grid is built under limits and stops at
 * them, rather than being built whole and sliced: at most `maxRows` body
 * rows, `maxColumns` per row, and a character `budget` spent per cell
 * written, carried copies included. Hitting any of them sets `truncated`
 * and names it in `truncatedBy`; a row cut by the budget is dropped whole
 * rather than returned short.
 */
export function extractTable(table: Element, limits: TableLimits = {}): Table {
  const rows = queryAll(table, "tr", Number.POSITIVE_INFINITY, limits.match);
  const maxColumns = limits.maxColumns ?? Number.POSITIVE_INFINITY;
  const budget = limits.budget ?? { chars: Number.POSITIVE_INFINITY };
  const work = budget.work ?? { units: Number.POSITIVE_INFINITY };
  // The text of one cell (or the caption), and whether all of it fit what
  // the budget has left to give. A cell read in part is never written: its
  // row is dropped whole.
  const readCell = (node: Element): { text: string; whole: boolean } => {
    const { text, complete } = boundedText(node, Math.max(0, budget.chars), work);
    return { text, whole: complete };
  };

  // A header row is one whose cells are all `th`, and only if it is first.
  // It depends only on the first row's own children, so it is known before
  // anything is expanded.
  const firstRow = rows[0];
  const cellsIn = (node: Element | undefined, tags: ReadonlyArray<string>): number =>
    node === undefined
      ? 0
      : node.children.filter((c) => c.type === "element" && tags.includes(c.tag)).length;
  const headerCount = cellsIn(firstRow, ["th"]);
  const hasHeader = headerCount > 0 && headerCount === cellsIn(firstRow, ["td", "th"]);
  const bodyRows = rows.length - (hasHeader ? 1 : 0);
  // Rowspans only ever carry downward, so stopping early loses nothing above.
  const rowsToBuild = Math.min(
    rows.length,
    (hasHeader ? 1 : 0) + Math.min(bodyRows, limits.maxRows ?? bodyRows),
  );

  const grid: string[][] = [];
  // Cells a rowspan above is still occupying, by column index.
  const carry = new Map<number, { text: string; cost: number; remaining: number }>();
  let columnsTruncated = false;
  let charsTruncated = false;

  // The caption first, as it comes first: it is charged like a cell, and a
  // caption's text holds every table nested inside it, so it is cut rather
  // than returned whole.
  const captionNode = table.children.find((c) => c.type === "element" && c.tag === "caption");
  let caption = "";
  if (captionNode !== undefined) {
    const read = readCell(captionNode as Element);
    caption = read.text;
    const allowed = Math.max(0, budget.chars);
    // Escaping can make the JSON longer than the text; cut until it fits.
    while (caption.length > 0 && JSON.stringify(caption).length > allowed) {
      caption = caption.slice(0, Math.floor(caption.length / 2));
    }
    budget.chars -= JSON.stringify(caption).length;
    if (!read.whole || caption.length < read.text.length || budget.chars < 0) {
      charsTruncated = true;
    }
  }

  for (let rowIndex = 0; rowIndex < rowsToBuild && !charsTruncated; rowIndex++) {
    const row = rows[rowIndex] as Element;
    const out: string[] = [];
    let column = 0;
    // Spend the budget for one written cell; false once it is gone.
    const spend = (cost: number): boolean => {
      budget.chars -= cost;
      if (budget.chars >= 0) return true;
      charsTruncated = true;
      return false;
    };
    const drainCarried = (): boolean => {
      while (carry.has(column)) {
        const held = carry.get(column) as { text: string; cost: number; remaining: number };
        if (!spend(held.cost)) return false;
        out[column] = held.text;
        if (held.remaining <= 1) carry.delete(column);
        else carry.set(column, { ...held, remaining: held.remaining - 1 });
        column++;
      }
      return true;
    };

    cells: for (const cell of row.children) {
      if (cell.type !== "element" || (cell.tag !== "td" && cell.tag !== "th")) continue;
      if (column >= maxColumns) {
        columnsTruncated = true;
        break;
      }
      const read = readCell(cell);
      if (!read.whole) {
        charsTruncated = true;
        break;
      }
      const text = read.text;
      // What one copy of this cell costs in the result: its JSON string and
      // a separator.
      const cost = JSON.stringify(text).length + 1;
      const colspan = Math.max(
        1,
        Math.min(1000, Number.parseInt(attrOf(cell, "colspan") ?? "1", 10) || 1),
      );
      // A span past the last row would only park entries nothing reads.
      const rowspan = Math.max(
        1,
        Math.min(
          1000,
          rows.length - rowIndex,
          Number.parseInt(attrOf(cell, "rowspan") ?? "1", 10) || 1,
        ),
      );
      for (let c = 0; c < colspan; c++) {
        if (!drainCarried()) break cells;
        if (column >= maxColumns) {
          columnsTruncated = true;
          break cells;
        }
        if (!spend(cost)) break cells;
        const at = column;
        out[column] = text;
        column++;
        if (rowspan > 1) carry.set(at, { text, cost, remaining: rowspan - 1 });
      }
    }
    if (charsTruncated || !drainCarried()) {
      charsTruncated = true;
      break;
    }
    const filled: string[] = [];
    for (let i = 0; i < out.length; i++) filled.push(out[i] ?? "");
    grid.push(filled);
  }

  const headers = hasHeader ? (grid[0] ?? []) : [];
  const body = hasHeader ? grid.slice(1) : grid;
  let columnCount = 0;
  for (const r of grid) if (r.length > columnCount) columnCount = r.length;
  const truncatedBy: Array<"rows" | "columns" | "chars"> = [];
  if (body.length < bodyRows && !charsTruncated) truncatedBy.push("rows");
  if (columnsTruncated) truncatedBy.push("columns");
  if (charsTruncated) truncatedBy.push("chars");
  return {
    headers,
    rows: body,
    rowCount: bodyRows,
    columnCount,
    caption,
    truncated: truncatedBy.length > 0,
    truncatedBy,
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
export function extractLinks(
  root: Element,
  baseUrl?: string,
  budget: TextBudget = unbounded(),
  match: MatchContext = createMatchContext(),
): Link[] {
  const declared = queryAll(root, "base[href]", 1, match)[0]?.attrs["href"];
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
  for (const anchor of queryAll(root, "a[href]", Number.POSITIVE_INFINITY, match)) {
    // A link's text is its subtree's, so nested anchors each carry the
    // deeper ones: once the budget has cut one, the rest are not read.
    if (budget.cut) break;
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
    // Resolving copies the base into every href, so what it adds is charged
    // like text: a 40 KB <base href> and 2,000 `<a href=?>` turned 75 KB of
    // markup into an 80 MB answer, untruncated. The page's own attribute
    // text is not multiplied, and costs nothing here.
    const added = href.length - raw.length;
    if (added > 0) {
      if (added > budget.chars) {
        budget.cut = true;
        break;
      }
      budget.chars -= added;
    }
    const text = textWithin(anchor, budget);
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
function labelFor(
  labels: ReadonlyMap<string, Element>,
  control: Element,
  budget: TextBudget,
): string {
  const id = attrOf(control, "id");
  if (id !== undefined && id !== "" && /^[\w:.-]+$/.test(id)) {
    const explicit = labels.get(id);
    if (explicit !== undefined) return textWithin(explicit, budget);
  }
  let ancestor = control.parent;
  while (ancestor !== null) {
    if (ancestor.tag === "label") return textWithin(ancestor, budget);
    ancestor = ancestor.parent;
  }
  return attrOf(control, "aria-label") ?? attrOf(control, "placeholder") ?? "";
}

export function extractForms(
  root: Element,
  budget: TextBudget = unbounded(),
  match: MatchContext = createMatchContext(),
): Form[] {
  // Every `label[for]`, first in document order winning, as the query per
  // control answered; that query walked the whole page once per control.
  const labels = new Map<string, Element>();
  for (const label of queryAll(root, "label[for]", Number.POSITIVE_INFINITY, match)) {
    const target = attrOf(label, "for") as string;
    if (!labels.has(target)) labels.set(target, label);
  }
  return queryAll(root, "form", Number.POSITIVE_INFINITY, match).map((form) => {
    const fields: FormField[] = [];
    for (const control of walk(form)) {
      if (!["input", "select", "textarea", "button"].includes(control.tag)) continue;
      const type =
        control.tag === "input" ? (control.attrs["type"] ?? "text").toLowerCase() : control.tag;
      // A hidden input is a field the server expects; omitting it would make
      // a described form unsubmittable.
      const options =
        control.tag === "select"
          ? queryAll(control, "option", Number.POSITIVE_INFINITY, match).map((option) => {
              const label = textWithin(option, budget);
              return {
                value: option.attrs["value"] ?? label,
                label,
                selected: "selected" in option.attrs,
              };
            })
          : [];
      fields.push({
        name: control.attrs["name"] ?? "",
        type,
        value:
          control.tag === "textarea" ? textWithin(control, budget) : (control.attrs["value"] ?? ""),
        label: labelFor(labels, control, budget),
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

  // Null prototypes: the keys are the page's meta names. On `{}` a
  // `<meta name="__proto__">` set the map's prototype instead of an entry and
  // vanished from the result.
  const openGraph: Record<string, string> = Object.create(null);
  const twitter: Record<string, string> = Object.create(null);
  const meta: Record<string, string> = Object.create(null);
  for (const tag of queryAll(root, "meta")) {
    const key = (tag.attrs["property"] ?? tag.attrs["name"] ?? "").toLowerCase();
    const content = tag.attrs["content"];
    if (key === "" || content === undefined) continue;
    if (key.startsWith("og:")) openGraph[key.slice(3)] = content;
    else if (key.startsWith("twitter:")) twitter[key.slice(8)] = content;
    else meta[key] = content;
  }

  const titleNode = queryAll(root, "title", 1)[0];
  return {
    jsonLd,
    openGraph,
    twitter,
    meta,
    title: titleNode === undefined ? "" : normalizeText(textOf(titleNode)),
    canonical: queryAll(root, 'link[rel="canonical"]', 1)[0]?.attrs["href"] ?? "",
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
  budget: TextBudget = unbounded(),
  ctx: MatchContext = createMatchContext(),
): {
  records: Array<Record<string, string>>;
  missing: Record<string, number>;
  containers: number;
  /** True when the text budget stopped the records short; the last one may be cut. */
  truncated: boolean;
} {
  const containers = queryAll(root, recipe.container, limit, ctx);
  // Null prototypes: the keys are the caller's field names, and on `{}` a
  // field called `constructor` counted its misses as "function Object()…1".
  const missing: Record<string, number> = Object.create(null);
  if (containers.length === 0) return { records: [], missing, containers: 0, truncated: false };
  // Each field's first match in every container, from one pass per field
  // rather than one query per container per field.
  const fields = Object.entries(recipe.fields).map(([field, spec]) => {
    const at = spec.lastIndexOf("@");
    const selector = at === -1 ? spec : spec.slice(0, at);
    const attribute = at === -1 ? null : spec.slice(at + 1);
    const found =
      selector.trim() === "" ? containers : firstMatchIn(root, containers, selector, ctx);
    return { field, attribute, found };
  });
  const records: Array<Record<string, string>> = [];
  for (let c = 0; c < containers.length && !budget.cut; c++) {
    const row: Record<string, string> = Object.create(null);
    for (const { field, attribute, found } of fields) {
      const node = found[c];
      if (node === undefined) {
        row[field] = "";
        missing[field] = (missing[field] ?? 0) + 1;
        continue;
      }
      const value =
        attribute === null || attribute === "text"
          ? textWithin(node, budget)
          : (attrOf(node, attribute.toLowerCase()) ?? "");
      if (value === "") missing[field] = (missing[field] ?? 0) + 1;
      row[field] = value;
    }
    records.push(row);
  }
  return { records, missing, containers: containers.length, truncated: budget.cut };
}

/**
 * A compact outline of the headings, which is often all a caller needs.
 * Headings nest, and each one's text holds the ones inside it, so the text
 * comes out of `budget`; once it has cut a heading, the outline stops there.
 */
export function outline(
  root: Element,
  budget: TextBudget = unbounded(),
): Array<{ level: number; text: string; id: string }> {
  const out: Array<{ level: number; text: string; id: string }> = [];
  for (const node of walk(root)) {
    const m = /^h([1-6])$/.exec(node.tag);
    if (m === null) continue;
    const text = textWithin(node, budget);
    if (text !== "") out.push({ level: Number(m[1]), text, id: attrOf(node, "id") ?? "" });
    if (budget.cut) break;
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
