/**
 * Integration test: wire ToolCatalog + buildTool + validateToolInput +
 * matchesPattern + executeTool around the todoWrite tool.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { __resetTodos, todoWrite } from "./index";

let catalog: ToolCatalog;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeEach(() => {
  __resetTodos();
  catalog = new ToolCatalog();
  catalog.register(todoWrite);
});

describe("integration: tool-todo through executeTool", () => {
  test("happy path returns a markdown checklist", async () => {
    const result = await executeTool(
      lookup("TodoWrite"),
      {
        todos: [
          { id: "1", content: "alpha", status: "pending", priority: "high" },
          { id: "2", content: "beta", status: "completed", priority: "low" },
        ],
      },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("- [ ] (high) alpha");
    expect(result.content).toContain("- [x] (low) beta");
  });

  test("invalid input is caught before execute", async () => {
    const result = await executeTool(
      lookup("TodoWrite"),
      { todos: [{ id: "1", content: "x", status: "bogus", priority: "low" }] },
      { toolUseId: "t2" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("TodoWrite");
  });

  test("permission pattern gates the call", async () => {
    const denied = await executeTool(
      lookup("TodoWrite"),
      { todos: [] },
      { toolUseId: "t3", allowedPatterns: ["Read"] },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("not permitted");
  });
});
