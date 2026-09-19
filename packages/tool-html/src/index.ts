/**
 * @crewhaus/tool-html — reading HTML without reading all of it.
 *
 * A harness that fetched a page and needs one number from it should not put
 * the page in a context window to find it. These tools take markup and give
 * back the answer: the rows of a table, where the links go, what a form
 * wants, what the page says about itself, the prose without the navigation.
 *
 * This is not a browser. Nothing here runs JavaScript, applies CSS, or sees
 * the DOM a page would have after its scripts ran — it parses the markup it
 * was given, which is what a fetch returns. For a page that builds itself in
 * the browser, the markup will not contain the content, and the tools will
 * correctly report that it does not.
 */
import { readFileSync, statSync } from "node:fs";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import {
  extractForms,
  extractLinks,
  extractRecords,
  extractStructuredData,
  extractTable,
  outline,
  readableText,
} from "./lib/extract";
import { type Element, normalizeText, parseHtml, textOf } from "./lib/parse";
import { queryAll } from "./lib/select";
import { resolveSafe } from "./paths";

const json = (value: unknown): string => JSON.stringify(value);

const LIMITS = {
  chars: 16 * 1024 * 1024,
  fileBytes: 64 * 1024 * 1024,
  matches: 2_000,
  fields: 64,
} as const;

/**
 * Take the markup from wherever the caller has it.
 *
 * A page big enough to be worth these tools is often too big to pass as an
 * argument, so a path is accepted and read here — which is the whole saving.
 */
const sourceFields = {
  html: z.string().max(LIMITS.chars).optional().describe("the markup itself"),
  file: z.string().optional().describe("workspace-relative path to an .html file"),
};

function loadSource(
  tool: string,
  input: { html?: string; file?: string },
): {
  root: Element;
  from: string;
  chars: number;
} {
  if ((input.html === undefined) === (input.file === undefined)) {
    throw new Error(`${tool} needs exactly one of html or file`);
  }
  if (input.file !== undefined) {
    const at = resolveSafe(tool, input.file);
    const size = statSync(at.real).size;
    if (size > LIMITS.fileBytes) {
      throw new Error(`${at.rel} is ${size} bytes, over the ${LIMITS.fileBytes}-byte limit`);
    }
    const text = readFileSync(at.real, "utf-8");
    return { root: parseHtml(text), from: at.rel, chars: text.length };
  }
  const text = input.html as string;
  return { root: parseHtml(text), from: "inline", chars: text.length };
}

/** An element, as plain JSON. The tree's parent links cannot be serialized. */
function describe(node: Element, includeHtml: boolean): Record<string, unknown> {
  const text = normalizeText(textOf(node));
  return {
    tag: node.tag,
    text,
    attrs: node.attrs,
    ...(includeHtml ? { childCount: node.children.length } : {}),
  };
}

// ---------------------------------------------------------------------------

export const htmlQuery: RegisteredTool = buildTool({
  name: "HtmlQuery",
  description:
    "Find elements in HTML with a CSS selector and return their text and attributes. Use it to pull one value — a price, a status, a row count, a link target — out of a page without the page entering a context window. The selector grammar is a documented subset, and a construct outside it is an ERROR rather than being ignored: a selector engine that skips the part it does not understand returns elements that merely look right.",
  inputSchema: z
    .object({
      ...sourceFields,
      selector: z.string().min(1).describe("e.g. '#main .price', 'table tr > td:nth-of-type(2)'"),
      attribute: z.string().optional().describe("return this attribute instead of the text"),
      limit: z.number().int().positive().max(LIMITS.matches).optional().describe("default 50"),
      firstOnly: z.boolean().optional().describe("return just the first match"),
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const { root, from, chars } = loadSource("HtmlQuery", input);
    const limit = input.firstOnly ? 1 : (input.limit ?? 50);
    const found = queryAll(root, input.selector, limit + 1);
    const shown = found.slice(0, limit);
    const values = shown.map((node) =>
      input.attribute === undefined
        ? normalizeText(textOf(node))
        : (node.attrs[input.attribute.toLowerCase()] ?? ""),
    );
    return json({
      from,
      sourceChars: chars,
      selector: input.selector,
      count: shown.length,
      truncated: found.length > limit,
      ...(input.attribute === undefined ? {} : { attribute: input.attribute }),
      values,
      matches: shown.map((node) => describe(node, false)),
    });
  },
});

export const htmlTable: RegisteredTool = buildTool({
  name: "HtmlTable",
  description:
    "Lift HTML tables into headers and rows, with colspan and rowspan expanded. Use it to read a pricing grid, an order history or a financial statement as data instead of as markup. Spans are expanded because a table that uses them reads as ragged rows otherwise, and every column after the span is off by one — which is invisible in the output and wrong in every row.",
  inputSchema: z
    .object({
      ...sourceFields,
      selector: z.string().optional().describe("which tables; defaults to every table"),
      index: z.number().int().nonnegative().optional().describe("just this table, zero-based"),
      maxRows: z
        .number()
        .int()
        .positive()
        .max(100_000)
        .optional()
        .describe("default 500 per table"),
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const { root, from } = loadSource("HtmlTable", input);
    const all = queryAll(root, input.selector ?? "table");
    const chosen = input.index === undefined ? all : all.slice(input.index, input.index + 1);
    if (chosen.length === 0) {
      return `no table matched ${input.selector === undefined ? "<table>" : `"${input.selector}"`} in ${from}${all.length > 0 ? ` (the document has ${all.length}, so the index may be out of range)` : ""}`;
    }
    const maxRows = input.maxRows ?? 500;
    return json({
      from,
      tables: chosen.map((table) => {
        const lifted = extractTable(table);
        return {
          caption: lifted.caption,
          headers: lifted.headers,
          rowCount: lifted.rowCount,
          columnCount: lifted.columnCount,
          rows: lifted.rows.slice(0, maxRows),
          truncated: lifted.rowCount > maxRows,
        };
      }),
      tableCount: all.length,
    });
  },
});

export const htmlLinks: RegisteredTool = buildTool({
  name: "HtmlLinks",
  description:
    "List a page's links with relative hrefs resolved against a base URL, and each one marked internal or external. Use it for pagination, for finding the detail pages behind a listing, or for checking where a page actually points. Resolving is the point rather than a convenience — half a page's links are '/thing' and useless on their own — and a page's own <base href> wins, as it would in a browser.",
  inputSchema: z
    .object({
      ...sourceFields,
      baseUrl: z.string().optional().describe("what relative hrefs resolve against"),
      externalOnly: z.boolean().optional(),
      internalOnly: z.boolean().optional(),
      pattern: z.string().optional().describe("keep only hrefs containing this substring"),
      limit: z.number().int().positive().max(LIMITS.matches).optional().describe("default 200"),
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const { root, from } = loadSource("HtmlLinks", input);
    let links = extractLinks(root, input.baseUrl);
    if (input.externalOnly) links = links.filter((l) => l.external);
    if (input.internalOnly) links = links.filter((l) => !l.external);
    if (input.pattern !== undefined)
      links = links.filter((l) => l.href.includes(input.pattern as string));
    const limit = input.limit ?? 200;
    return json({
      from,
      count: links.length,
      links: links.slice(0, limit),
      truncated: links.length > limit,
    });
  },
});

export const htmlForms: RegisteredTool = buildTool({
  name: "HtmlForms",
  description:
    "Describe every form on a page: its action and method, and each field's name, type, current value, label and options. Use it to work out what a submission needs before composing one. Hidden inputs are included, because a form described without its CSRF token is a form that cannot be submitted, and labels are resolved from a for= attribute, a wrapping label or aria-label.",
  inputSchema: z.object({ ...sourceFields, selector: z.string().optional() }).strict(),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const { root, from } = loadSource("HtmlForms", input);
    const forms = extractForms(root).filter((f) =>
      input.selector === undefined ? true : f.id === input.selector || f.name === input.selector,
    );
    return json({ from, count: forms.length, forms });
  },
});

export const htmlStructuredData: RegisteredTool = buildTool({
  name: "HtmlStructuredData",
  description:
    "Read the machine-readable layer a page carries about itself: JSON-LD, OpenGraph, Twitter card tags, the rest of its meta tags, its title and its canonical URL. Use it to get a product, article or event as structured fields instead of scraping the rendering. A JSON-LD block that does not parse is reported as invalid rather than dropped — a page with broken structured data looks identical to one carrying none, and those need different action.",
  inputSchema: z.object(sourceFields).strict(),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const { root, from } = loadSource("HtmlStructuredData", input);
    return json({ from, ...extractStructuredData(root) });
  },
});

export const htmlText: RegisteredTool = buildTool({
  name: "HtmlText",
  description:
    "Turn HTML into readable text, optionally dropping the navigation, header, footer, aside and form chrome. Use it when the prose is what matters and the markup is not. Script, style and head content never appear — an earlier version of this returned a page's inline JavaScript as body text, which is both wrong and usually the largest thing on the page — and whitespace is collapsed the way rendering collapses it.",
  inputSchema: z
    .object({
      ...sourceFields,
      selector: z.string().optional().describe("take the text of this region only"),
      dropBoilerplate: z.boolean().optional().describe("drop nav, header, footer, aside and forms"),
      maxChars: z.number().int().positive().max(1_000_000).optional().describe("default 20000"),
      outline: z.boolean().optional().describe("also return the heading outline"),
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const { root, from, chars } = loadSource("HtmlText", input);
    const region = input.selector === undefined ? root : queryAll(root, input.selector, 1)[0];
    if (region === undefined) return `no element matched "${input.selector}" in ${from}`;
    const text = readableText(region, input.dropBoilerplate === true);
    const maxChars = input.maxChars ?? 20_000;
    return json({
      from,
      sourceChars: chars,
      textChars: text.length,
      truncated: text.length > maxChars,
      ...(input.outline ? { outline: outline(region) } : {}),
      text: text.slice(0, maxChars),
    });
  },
});

export const htmlRecords: RegisteredTool = buildTool({
  name: "HtmlRecords",
  description:
    "Run a declarative scrape recipe — one container selector plus a selector per field — and get back a table of records. Use it for listings, search results and any repeated block. A field selector may end in '@attr' to take an attribute rather than the text, which is what you want for links. Fields that came back empty are COUNTED, so a recipe that has quietly stopped working shows up as a count instead of as rows of blanks that look like data.",
  inputSchema: z
    .object({
      ...sourceFields,
      container: z.string().min(1).describe("selector for each repeated block"),
      fields: z
        .record(z.string())
        .describe("field name to selector; append @attr for an attribute, e.g. 'a@href'"),
      limit: z.number().int().positive().max(LIMITS.matches).optional().describe("default 200"),
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const fieldCount = Object.keys(input.fields).length;
    if (fieldCount === 0) throw new Error("HtmlRecords needs at least one field");
    if (fieldCount > LIMITS.fields) {
      throw new Error(`HtmlRecords takes at most ${LIMITS.fields} fields, got ${fieldCount}`);
    }
    const { root, from } = loadSource("HtmlRecords", input);
    const result = extractRecords(
      root,
      { container: input.container, fields: input.fields },
      input.limit ?? 200,
    );
    return json({
      from,
      containers: result.containers,
      count: result.records.length,
      missing: result.missing,
      records: result.records,
    });
  },
});

/** Every tool this package registers, in the order a catalog should list them. */
export const HTML_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  htmlForms,
  htmlLinks,
  htmlQuery,
  htmlRecords,
  htmlStructuredData,
  htmlTable,
  htmlText,
]);

/**
 * The parser and the readers, re-exported as a library.
 *
 * The tools above are the narrow view of these: one call, one JSON answer.
 * A package that has to make a decision ABOUT a page rather than extract one
 * thing from it — `@crewhaus/tool-verify`'s `SeoLint` walks the headings, the
 * images, the anchors and the JSON-LD in a single pass — needs the tree, and
 * the one thing it must not do is parse the markup a second time.
 *
 * A second HTML parser in this repo would drift from this one, and then two
 * tools in one harness would give different answers about the same page:
 * a page whose `<p>` never closes has a different heading order depending on
 * whose recovery rules ran. Same reason `@crewhaus/tool-text` exports its
 * diff parser beside its tools, and `@crewhaus/tool-code` its lockfile
 * readers.
 */
export {
  type Element,
  type TextNode,
  normalizeText,
  parseHtml,
  textOf,
  walk,
} from "./lib/parse";
export {
  type Link,
  type StructuredData,
  extractLinks,
  extractStructuredData,
  outline,
  readableText,
} from "./lib/extract";
export { queryAll, queryFirst } from "./lib/select";
