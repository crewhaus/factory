/**
 * Integration test: wires ToolCatalog + buildTool + validateToolInput +
 * matchesPattern + executeTool together with a real mock tool. No mocking of
 * internal modules — each layer is exercised end-to-end.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { z } from "zod";
import { ToolCatalog } from "@crewhaus/tool-catalog";
import { buildTool } from "@crewhaus/tool-builder";
import { executeTool } from "./index";

const greetSchema = z.object({ name: z.string() });
type GreetInput = z.infer<typeof greetSchema>;

const greetDef = {
  name: "Greet",
  description: "Returns a greeting",
  inputSchema: greetSchema,
  execute: async (input: GreetInput) => `Hello, ${input.name}!`,
  readOnly: true,
};

const failDef = {
  name: "Fail",
  description: "Always throws",
  inputSchema: greetSchema,
  execute: async (_input: GreetInput): Promise<string> => {
    throw new Error("intentional failure");
  },
};

describe("integration: full execution pipeline", () => {
  let catalog: ToolCatalog;

  beforeEach(() => {
    catalog = new ToolCatalog();
    catalog.register(buildTool(greetDef));
    catalog.register(buildTool(failDef));
  });

  test("catalog → buildTool → executeTool succeeds end-to-end", async () => {
    const tool = catalog.get("Greet");
    expect(tool).toBeDefined();
    const result = await executeTool(tool!, { name: "World" }, { toolUseId: "i1" });
    expect(result.isError).toBe(false);
    expect(result.content).toBe("Hello, World!");
    expect(result.toolUseId).toBe("i1");
  });

  test("buildTool applies fail-closed defaults in the catalog", () => {
    const tool = catalog.get("Greet");
    expect(tool!.concurrencySafe).toBe(false);
    expect(tool!.destructive).toBe(false);
    expect(tool!.readOnly).toBe(true); // explicit
  });

  test("permission pattern allows matching tool call", async () => {
    const tool = catalog.get("Greet");
    const result = await executeTool(
      tool!,
      { name: "Max" },
      { toolUseId: "i2", allowedPatterns: ["Greet"] },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("Hello, Max!");
  });

  test("permission pattern denies non-matching tool call", async () => {
    const tool = catalog.get("Greet");
    const result = await executeTool(
      tool!,
      { name: "Max" },
      { toolUseId: "i3", allowedPatterns: ["Bash(git *)"] },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not permitted");
  });

  test("tool that throws produces isError:true result", async () => {
    const tool = catalog.get("Fail");
    const result = await executeTool(tool!, { name: "anyone" }, { toolUseId: "i4" });
    expect(result.isError).toBe(true);
    expect(result.content).toBe("intentional failure");
  });

  test("invalid input is caught before execute is called", async () => {
    const tool = catalog.get("Greet");
    const result = await executeTool(tool!, { name: 42 }, { toolUseId: "i5" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Greet");
  });

  test("wildcard permission pattern permits all tools", async () => {
    const tool = catalog.get("Greet");
    const result = await executeTool(
      tool!,
      { name: "Everyone" },
      { toolUseId: "i6", allowedPatterns: ["*"] },
    );
    expect(result.isError).toBe(false);
  });
});
