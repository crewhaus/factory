import { beforeEach, describe, expect, test } from "bun:test";
import { CrewhausError } from "@crewhaus/errors";
import { z } from "zod";
import { type RegisteredTool, ToolCatalog, ToolCatalogError, defaultCatalog } from "./index";

function makeTool(name: string): RegisteredTool {
  return {
    name,
    description: `${name} tool`,
    inputSchema: z.object({ value: z.string() }) as RegisteredTool["inputSchema"],
    execute: async (_input) => "ok",
    concurrencySafe: false,
    readOnly: false,
    destructive: false,
    requiresSandbox: false,
    classifyOutput: true,
  };
}

describe("ToolCatalog", () => {
  let catalog: ToolCatalog;

  beforeEach(() => {
    catalog = new ToolCatalog();
  });

  test("register and get round-trip", () => {
    const tool = makeTool("Bash");
    catalog.register(tool);
    expect(catalog.get("Bash")).toBe(tool);
  });

  test("has returns true after register, false before", () => {
    expect(catalog.has("Read")).toBe(false);
    catalog.register(makeTool("Read"));
    expect(catalog.has("Read")).toBe(true);
  });

  test("list returns tools in insertion order", () => {
    const bash = makeTool("Bash");
    const read = makeTool("Read");
    const write = makeTool("Write");
    catalog.register(bash);
    catalog.register(read);
    catalog.register(write);
    expect(catalog.list()).toEqual([bash, read, write]);
  });

  test("list returns empty array when catalog is empty", () => {
    expect(catalog.list()).toEqual([]);
  });

  test("get returns undefined for unknown tool", () => {
    expect(catalog.get("Unknown")).toBeUndefined();
  });

  test("duplicate name throws ToolCatalogError", () => {
    catalog.register(makeTool("Bash"));
    expect(() => catalog.register(makeTool("Bash"))).toThrow(ToolCatalogError);
    expect(() => catalog.register(makeTool("Bash"))).toThrow(/already registered/);
  });

  test("ToolCatalogError is instanceof CrewhausError", () => {
    expect(new ToolCatalogError("x")).toBeInstanceOf(CrewhausError);
  });

  test("ToolCatalogError has code 'tool'", () => {
    expect(new ToolCatalogError("x").code).toBe("tool");
  });
});

describe("defaultCatalog", () => {
  test("is a ToolCatalog instance", () => {
    expect(defaultCatalog).toBeInstanceOf(ToolCatalog);
  });
});

describe("RegisteredTool jsonSchema field", () => {
  test("optional jsonSchema is preserved when set", () => {
    const catalog = new ToolCatalog();
    const tool: RegisteredTool = {
      ...makeTool("Mcp"),
      jsonSchema: { type: "object", properties: { x: { type: "number" } } },
    };
    catalog.register(tool);
    const got = catalog.get("Mcp");
    expect(got?.jsonSchema).toEqual({ type: "object", properties: { x: { type: "number" } } });
  });

  test("absent jsonSchema is undefined", () => {
    const catalog = new ToolCatalog();
    const tool = makeTool("Plain");
    catalog.register(tool);
    expect(catalog.get("Plain")?.jsonSchema).toBeUndefined();
  });
});
