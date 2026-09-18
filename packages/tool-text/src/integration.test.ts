/**
 * The tools driven the way the runtime drives them: registered in a catalog,
 * dispatched through `executeTool`, which validates the input against the
 * declared schema and checks the permission patterns before calling execute.
 *
 * A tool that works when called directly but fails here is a tool the
 * runtime cannot actually use, which is why this file exists separately.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { TEXT_TOOLS } from "./index";

let catalog: ToolCatalog;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of TEXT_TOOLS) catalog.register(tool);
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(TEXT_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of TEXT_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("a valid call returns a non-error result", async () => {
    const result = await executeTool(
      lookup("RegexExtract"),
      { text: "a1 b2", pattern: "\\w\\d" },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("a1");
  });

  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await executeTool(
      lookup("RegexExtract"),
      { text: 42, pattern: "x" },
      { toolUseId: "t2" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("RegexExtract");
  });

  test("a missing required field is rejected", async () => {
    const result = await executeTool(lookup("TextDiff"), { a: "x" }, { toolUseId: "t3" });
    expect(result.isError).toBe(true);
  });

  test("permission patterns gate the call", async () => {
    const denied = await executeTool(
      lookup("CountTokens"),
      { text: "x" },
      { toolUseId: "t4", allowedPatterns: ["Read"] },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("not permitted");
  });

  test("an explicit allow lets it through", async () => {
    const allowed = await executeTool(
      lookup("CountTokens"),
      { text: "x" },
      { toolUseId: "t5", allowedPatterns: ["CountTokens"] },
    );
    expect(allowed.isError).toBe(false);
  });

  test("every tool survives a schema-valid call — none throws out of execute", async () => {
    const calls: Record<string, unknown> = {
      CompactLog: { text: "a\na\nERROR b" },
      CountTokens: { text: "hello" },
      EscapeString: { text: "a.b", target: "regex" },
      ExtractEntities: { text: "a@b.com", kinds: ["email"] },
      ExtractKeywords: { text: "compiler compiler widget" },
      FuzzyMatch: { query: "a", candidates: ["a", "b"] },
      GlossaryReplace: { text: "ai", mapping: { ai: "AI" } },
      MarkdownOutline: { text: "# T\nbody" },
      MarkdownTable: { rows: [{ a: 1 }] },
      NormalizeText: { text: "a  \r\nb" },
      RegexExtract: { text: "a1", pattern: "\\w\\d" },
      RenderTemplate: { template: "{{a}}", data: { a: 1 } },
      RuleClassify: { text: "refund", rules: [{ label: "r", patterns: ["refund"] }] },
      SortLines: { text: "b\na" },
      TextDiff: { a: "x", b: "y" },
      TextSimilarity: { a: "x", b: "y" },
      TruncateToBudget: { text: "x".repeat(50), maxChars: 10 },
      WrapText: { text: "a b c", width: 20 },
    };
    // Every registered tool must appear above; a new tool without a call here
    // would otherwise go unexercised.
    expect(Object.keys(calls).sort()).toEqual(TEXT_TOOLS.map((t) => t.name).sort());
    for (const tool of TEXT_TOOLS) {
      const result = await executeTool(tool, calls[tool.name], { toolUseId: `x-${tool.name}` });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });

  test("results are deterministic — the same call twice gives the same bytes", async () => {
    const args = { text: "alpha beta alpha", kinds: ["url", "email"] };
    const a = await executeTool(lookup("ExtractEntities"), args, { toolUseId: "d1" });
    const b = await executeTool(lookup("ExtractEntities"), args, { toolUseId: "d2" });
    expect(a.content).toBe(b.content);
  });
});
