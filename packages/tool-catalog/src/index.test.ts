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
    scope: "internal",
    requireJustification: false,
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

// Ops item 38 — unregister / quarantine / restore for MCP auto-quarantine.
describe("ToolCatalog — quarantine (item 38)", () => {
  let catalog: ToolCatalog;
  beforeEach(() => {
    catalog = new ToolCatalog();
  });

  test("unregister removes a live tool and returns it; undefined for unknown", () => {
    const tool = makeTool("weather__forecast");
    catalog.register(tool);
    expect(catalog.unregister("weather__forecast")).toBe(tool);
    expect(catalog.has("weather__forecast")).toBe(false);
    expect(catalog.unregister("weather__forecast")).toBeUndefined();
  });

  test("quarantine withdraws a tool from the active surface but stashes it", () => {
    const tool = makeTool("weather__forecast");
    catalog.register(tool);
    expect(catalog.quarantine("weather__forecast", "80% errors", 1000)).toBe(true);
    // No longer on the model-facing surface.
    expect(catalog.has("weather__forecast")).toBe(false);
    expect(catalog.get("weather__forecast")).toBeUndefined();
    expect(catalog.list()).toEqual([]);
    // But tracked as quarantined.
    expect(catalog.isQuarantined("weather__forecast")).toBe(true);
    expect(catalog.quarantinedNames()).toEqual(["weather__forecast"]);
    expect(catalog.quarantineInfo("weather__forecast")?.reason).toBe("80% errors");
    expect(catalog.quarantineInfo("weather__forecast")?.quarantinedAt).toBe(1000);
  });

  test("quarantine of an unknown tool returns false; of an already-quarantined is idempotent", () => {
    expect(catalog.quarantine("nope", "x")).toBe(false);
    catalog.register(makeTool("s__t"));
    expect(catalog.quarantine("s__t", "x")).toBe(true);
    expect(catalog.quarantine("s__t", "x")).toBe(true); // idempotent no-op
  });

  test("restore re-admits a quarantined tool to the active catalog", () => {
    const tool = makeTool("weather__forecast");
    catalog.register(tool);
    catalog.quarantine("weather__forecast", "flaky");
    expect(catalog.restore("weather__forecast")).toBe(true);
    expect(catalog.get("weather__forecast")).toBe(tool);
    expect(catalog.isQuarantined("weather__forecast")).toBe(false);
    // Restoring a non-quarantined name is a false no-op.
    expect(catalog.restore("weather__forecast")).toBe(false);
  });

  test("register refuses a quarantined name (must restore instead)", () => {
    catalog.register(makeTool("s__t"));
    catalog.quarantine("s__t", "x");
    expect(() => catalog.register(makeTool("s__t"))).toThrow(/quarantined/);
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
