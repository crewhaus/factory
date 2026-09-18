import { afterEach, beforeEach, describe, expect, test } from "bun:test";
/**
 * The tools driven the way the runtime drives them, and the workflow they
 * exist for: fetch once, then ask the page questions without re-reading it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { HTML_TOOLS } from "./index";

const originalCwd = process.cwd();
let catalog: ToolCatalog;
let workspace: string;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

const LISTING = `<html><head><title>Results</title>
<link rel=canonical href="https://shop.test/search?q=bolt">
<script type="application/ld+json">{"@type":"ItemList","numberOfItems":2}</script></head>
<body><nav><a href="/">Home</a></nav>
<main><h1>2 results</h1>
<div class=hit><h2 class=t>Hex Bolt</h2><span class=price>£9.99</span><a class=more href="/item/1">details</a></div>
<div class=hit><h2 class=t>Wing Nut</h2><span class=price>£4.50</span><a class=more href="/item/2">details</a></div>
<a class=next href="/search?q=bolt&amp;page=2">Next</a></main>
<footer>© Shop</footer></body></html>`;

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of HTML_TOOLS) catalog.register(tool);
  workspace = mkdtempSync(join(tmpdir(), "crewhaus-html-int-"));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(HTML_TOOLS.length);
  });
});

describe("dispatch through executeTool", () => {
  test("a valid call returns a non-error result", async () => {
    const result = await executeTool(
      lookup("HtmlQuery"),
      { html: LISTING, selector: "h1" },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("2 results");
  });

  test("a bad selector is an error result, not a crash", async () => {
    const result = await executeTool(
      lookup("HtmlQuery"),
      { html: LISTING, selector: "h1:hover" },
      { toolUseId: "t2" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not supported");
  });

  test("a containment escape is an error result", async () => {
    const result = await executeTool(
      lookup("HtmlText"),
      { file: "../../etc/passwd" },
      { toolUseId: "t3" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("escapes the workspace");
  });

  test("every tool can be dispatched with a minimal valid input", async () => {
    writeFileSync(join(workspace, "p.html"), LISTING);
    const inputs: Record<string, unknown> = {
      HtmlQuery: { file: "p.html", selector: "h1" },
      HtmlTable: { html: "<table><tr><td>1</table>" },
      HtmlLinks: { file: "p.html" },
      HtmlForms: { html: "<form></form>" },
      HtmlStructuredData: { file: "p.html" },
      HtmlText: { file: "p.html" },
      HtmlRecords: { file: "p.html", container: ".hit", fields: { t: ".t" } },
    };
    for (const tool of HTML_TOOLS) {
      const result = await executeTool(lookup(tool.name), inputs[tool.name], {
        toolUseId: `min-${tool.name}`,
      });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });
});

describe("the workflow these exist for", () => {
  test("one saved page answers four questions, and never enters a context window", async () => {
    // A harness fetched this once and wrote it down. Everything after is
    // answers, not markup — the page is 900-odd characters and each result
    // is a fraction of that.
    writeFileSync(join(workspace, "results.html"), LISTING);

    const records = await executeTool(
      lookup("HtmlRecords"),
      {
        file: "results.html",
        container: ".hit",
        fields: { title: ".t", price: ".price", url: "a.more@href" },
      },
      { toolUseId: "w1" },
    );
    expect(JSON.parse(records.content).records).toEqual([
      { title: "Hex Bolt", price: "£9.99", url: "/item/1" },
      { title: "Wing Nut", price: "£4.50", url: "/item/2" },
    ]);

    // Where the next page is, resolved — the href carries an entity, which
    // has to be decoded or the follow-up fetch asks for the wrong thing.
    const links = await executeTool(
      lookup("HtmlLinks"),
      { file: "results.html", baseUrl: "https://shop.test/search", pattern: "page=2" },
      { toolUseId: "w2" },
    );
    expect(JSON.parse(links.content).links[0]?.href).toBe("https://shop.test/search?q=bolt&page=2");

    // What the page says about itself.
    const data = await executeTool(
      lookup("HtmlStructuredData"),
      { file: "results.html" },
      { toolUseId: "w3" },
    );
    expect(JSON.parse(data.content).jsonLd[0]).toEqual({ "@type": "ItemList", numberOfItems: 2 });

    // And the prose, without the chrome.
    const text = await executeTool(
      lookup("HtmlText"),
      { file: "results.html", dropBoilerplate: true },
      { toolUseId: "w4" },
    );
    const body = JSON.parse(text.content);
    expect(body.text).not.toContain("Home");
    expect(body.text).not.toContain("© Shop");
    expect(body.textChars).toBeLessThan(body.sourceChars / 3);
  });
});
