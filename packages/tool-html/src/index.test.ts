import { afterEach, beforeEach, describe, expect, test } from "bun:test";
/**
 * Every tool this package registers, through its own `execute`, including
 * from a file — the path that matters, since a page worth these tools is
 * often too big to pass as an argument.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HTML_TOOLS,
  htmlForms,
  htmlLinks,
  htmlQuery,
  htmlRecords,
  htmlStructuredData,
  htmlTable,
  htmlText,
} from "./index";

const originalCwd = process.cwd();
let workspace: string;

// biome-ignore lint/suspicious/noExplicitAny: the executor supplies this context, and none of these tools read it.
const ctx = {} as any;

const PAGE = `<html><head><title>Shop</title><meta property="og:price" content="9.99"></head><body>
<nav><a href=/n>Nav</a></nav><main><h1>Bolts</h1>
<table><tr><th>SKU<th>Price<tr><td>B1<td>9.99<tr><td>B2<td>4.50</table>
<div class=p><span class=n>B1</span><a class=l href=/p/1>go</a></div>
<div class=p><span class=n>B2</span><a class=l href=/p/2>go</a></div>
<form action=/s method=post><input name=q required></form>
<p>Some prose.</p></main></body></html>`;

async function raw(tool: (typeof HTML_TOOLS)[number], input: unknown): Promise<string> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`schema rejected the input: ${parsed.error.message}`);
  return tool.execute(parsed.data, ctx);
}

async function call<T = Record<string, unknown>>(
  tool: (typeof HTML_TOOLS)[number],
  input: unknown,
): Promise<T> {
  return JSON.parse(await raw(tool, input)) as T;
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "crewhaus-html-"));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

describe("package-wide contract", () => {
  test("every tool is exported in HTML_TOOLS", () => {
    expect(HTML_TOOLS.length).toBe(7);
  });

  test("names are unique and PascalCase", () => {
    const names = HTML_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of HTML_TOOLS) expect(t.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("every tool is read-only, non-destructive and internal — none fetches anything", () => {
    for (const t of HTML_TOOLS) {
      expect({ name: t.name, readOnly: t.readOnly }).toEqual({ name: t.name, readOnly: true });
      expect({ name: t.name, destructive: t.destructive }).toEqual({
        name: t.name,
        destructive: false,
      });
      expect({ name: t.name, scope: t.scope }).toEqual({ name: t.name, scope: "internal" });
      expect({ name: t.name, io: t.ioCapability }).toEqual({ name: t.name, io: undefined });
    }
  });

  test("no tool opts out of output classification", () => {
    // These read third-party markup, which is the material an injection
    // classifier exists to look at.
    for (const t of HTML_TOOLS) {
      expect({ name: t.name, off: t.classifyOutput === false }).toEqual({
        name: t.name,
        off: false,
      });
    }
  });

  test("every description says what it is for", () => {
    for (const t of HTML_TOOLS) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.description).toContain("Use it");
    }
  });

  test("every schema rejects a wholly wrong input shape", () => {
    for (const t of HTML_TOOLS) {
      expect({ name: t.name, ok: t.inputSchema.safeParse(42).success }).toEqual({
        name: t.name,
        ok: false,
      });
    }
  });

  /** The non-source arguments each tool requires, so only the source varies. */
  const REQUIRED: Record<string, Record<string, unknown>> = {
    HtmlQuery: { selector: "p" },
    HtmlTable: {},
    HtmlLinks: {},
    HtmlForms: {},
    HtmlStructuredData: {},
    HtmlText: {},
    HtmlRecords: { container: ".p", fields: { a: ".n" } },
  };

  test("every tool takes exactly one source, and says so when it gets none or both", async () => {
    for (const tool of HTML_TOOLS) {
      const base = REQUIRED[tool.name] as Record<string, unknown>;
      await expect(raw(tool, base)).rejects.toThrow(/exactly one of html or file/);
      await expect(raw(tool, { ...base, html: PAGE, file: "x.html" })).rejects.toThrow(
        /exactly one of html or file/,
      );
    }
  });

  test("every schema is strict, so a misspelled argument is caught rather than ignored", () => {
    // A silently dropped option is a caller believing a limit applied.
    for (const tool of HTML_TOOLS) {
      const input = { ...(REQUIRED[tool.name] as object), html: PAGE, limmit: 1 };
      expect({ name: tool.name, ok: tool.inputSchema.safeParse(input).success }).toEqual({
        name: tool.name,
        ok: false,
      });
    }
  });

  test("a file outside the workspace is refused by every tool that reads one", async () => {
    await expect(raw(htmlQuery, { file: "../escape.html", selector: "p" })).rejects.toThrow(
      /escapes the workspace/,
    );
  });
});

describe("reading from a file", () => {
  test("a saved page is parsed from disk, which is the point", async () => {
    writeFileSync(join(workspace, "page.html"), PAGE);
    const result = await call<{ from: string; values: string[] }>(htmlQuery, {
      file: "page.html",
      selector: "h1",
    });
    expect(result.from).toBe("page.html");
    expect(result.values).toEqual(["Bolts"]);
  });
});

describe("HtmlQuery", () => {
  test("returns text, and an attribute when asked", async () => {
    expect(
      (
        await call<{ values: string[] }>(htmlQuery, {
          html: PAGE,
          selector: "table tr:nth-of-type(2) td",
        })
      ).values,
    ).toEqual(["B1", "9.99"]);
    expect(
      (
        await call<{ values: string[] }>(htmlQuery, {
          html: PAGE,
          selector: "a.l",
          attribute: "href",
        })
      ).values,
    ).toEqual(["/p/1", "/p/2"]);
  });

  test("truncation is reported rather than silent", async () => {
    const result = await call<{ count: number; truncated: boolean }>(htmlQuery, {
      html: PAGE,
      selector: "td",
      limit: 1,
    });
    expect(result).toMatchObject({ count: 1, truncated: true });
  });

  test("an unsupported selector is an error", async () => {
    await expect(raw(htmlQuery, { html: PAGE, selector: "p:hover" })).rejects.toThrow(
      /not supported/,
    );
  });

  test("no match is an empty result, not an error", async () => {
    expect(
      await call<{ count: number }>(htmlQuery, { html: PAGE, selector: ".nope" }),
    ).toMatchObject({
      count: 0,
    });
  });
});

describe("HtmlTable", () => {
  test("lifts a table into headers and rows", async () => {
    const result = await call<{ tables: Array<{ headers: string[]; rows: string[][] }> }>(
      htmlTable,
      {
        html: PAGE,
        index: 0,
      },
    );
    expect(result.tables[0]).toMatchObject({
      headers: ["SKU", "Price"],
      rows: [
        ["B1", "9.99"],
        ["B2", "4.50"],
      ],
    });
  });

  test("an index past the end explains itself", async () => {
    const out = await raw(htmlTable, { html: PAGE, index: 9 });
    expect(out).toContain("the document has 1");
  });
});

describe("HtmlLinks", () => {
  test("resolves against a base and marks external links", async () => {
    const result = await call<{ links: Array<{ href: string; external: boolean }> }>(htmlLinks, {
      html: `${PAGE}<a href="https://other.test/x">O</a>`,
      baseUrl: "https://shop.test/",
    });
    expect(result.links.find((l) => l.href.includes("other.test"))?.external).toBe(true);
    expect(result.links.some((l) => l.href === "https://shop.test/p/1")).toBe(true);
  });

  test("filters narrow the list", async () => {
    const result = await call<{ count: number }>(htmlLinks, {
      html: PAGE,
      baseUrl: "https://shop.test/",
      pattern: "/p/",
    });
    expect(result.count).toBe(2);
  });
});

describe("HtmlForms", () => {
  test("describes the form and its fields", async () => {
    const result = await call<{
      forms: Array<{ action: string; method: string; fields: unknown[] }>;
    }>(htmlForms, { html: PAGE });
    expect(result.forms[0]).toMatchObject({ action: "/s", method: "post" });
    expect(result.forms[0]?.fields).toHaveLength(1);
  });
});

describe("HtmlStructuredData", () => {
  test("reports each layer", async () => {
    const result = await call<{ openGraph: Record<string, string>; title: string }>(
      htmlStructuredData,
      { html: PAGE },
    );
    expect(result.openGraph).toEqual({ price: "9.99" });
    expect(result.title).toBe("Shop");
  });
});

describe("HtmlText", () => {
  test("drops chrome when asked and reports the outline", async () => {
    const result = await call<{ text: string; outline: Array<{ text: string }> }>(htmlText, {
      html: PAGE,
      dropBoilerplate: true,
      outline: true,
    });
    expect(result.text).not.toContain("Nav");
    expect(result.text).toContain("Some prose.");
    expect(result.outline[0]?.text).toBe("Bolts");
  });

  test("truncation is reported with the full length", async () => {
    const result = await call<{ textChars: number; truncated: boolean; text: string }>(htmlText, {
      html: PAGE,
      maxChars: 10,
    });
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(10);
    expect(result.textChars).toBeGreaterThan(10);
  });

  test("a selector that matches nothing says so", async () => {
    expect(await raw(htmlText, { html: PAGE, selector: ".nope" })).toContain("no element matched");
  });
});

describe("HtmlRecords", () => {
  test("a recipe produces rows and counts what came back empty", async () => {
    const result = await call<{
      records: Array<Record<string, string>>;
      missing: Record<string, number>;
    }>(htmlRecords, {
      html: PAGE,
      container: ".p",
      fields: { sku: ".n", url: "a.l@href", nope: ".x" },
    });
    expect(result.records).toEqual([
      { sku: "B1", url: "/p/1", nope: "" },
      { sku: "B2", url: "/p/2", nope: "" },
    ]);
    expect(result.missing).toEqual({ nope: 2 });
  });

  test("a recipe with no fields is refused", async () => {
    await expect(raw(htmlRecords, { html: PAGE, container: ".p", fields: {} })).rejects.toThrow(
      /at least one field/,
    );
  });
});
