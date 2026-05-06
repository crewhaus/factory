/**
 * Integration test: wire ToolCatalog + buildTool + validateToolInput +
 * matchesPattern + executeTool around the bash tool. Confirms the timeout
 * path surfaces a non-error result whose content includes the timeout
 * marker, and that permission patterns gate prefix-style command rules.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { bash } from "./index";

let catalog: ToolCatalog;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeEach(() => {
  catalog = new ToolCatalog();
  catalog.register(bash);
});

describe("integration: tool-bash through executeTool", () => {
  test("happy path returns stdout and exit code", async () => {
    const result = await executeTool(
      lookup("Bash"),
      { command: "echo integration" },
      { toolUseId: "b1" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("integration");
    expect(result.content).toContain("[exit] 0");
  });

  test("non-zero exit is reported via formatted content (not isError)", async () => {
    const result = await executeTool(lookup("Bash"), { command: "exit 3" }, { toolUseId: "b2" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("[exit] 3");
  });

  test("timeout surfaces in content", async () => {
    const result = await executeTool(
      lookup("Bash"),
      { command: "sleep 5", timeout: 120 },
      { toolUseId: "b3" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("timed out");
  });

  test("invalid input is caught before execute (empty command)", async () => {
    const result = await executeTool(lookup("Bash"), { command: "" }, { toolUseId: "b4" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Bash");
  });

  test("permission pattern Bash gates the call", async () => {
    const allowed = await executeTool(
      lookup("Bash"),
      { command: "echo ok" },
      { toolUseId: "b5", allowedPatterns: ["Bash"] },
    );
    expect(allowed.isError).toBe(false);

    const denied = await executeTool(
      lookup("Bash"),
      { command: "echo ok" },
      { toolUseId: "b6", allowedPatterns: ["Read"] },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("not permitted");
  });
});
