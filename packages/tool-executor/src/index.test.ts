import { describe, expect, test } from "bun:test";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { ToolPermissionError, executeTool } from "./index";

const schema = z.object({ command: z.string() });

function makeEchoTool(overrides?: Partial<RegisteredTool>): RegisteredTool {
  return {
    name: "Bash",
    description: "Run a command",
    inputSchema: schema as RegisteredTool["inputSchema"],
    execute: async (input) => `ran: ${(input as { command: string }).command}`,
    concurrencySafe: false,
    readOnly: false,
    destructive: false,
    requiresSandbox: false,
    classifyOutput: true,
    scope: "internal",
    requireJustification: false,
    ...overrides,
  };
}

describe("executeTool — happy path", () => {
  test("returns isError:false with content from execute", async () => {
    const result = await executeTool(makeEchoTool(), { command: "ls" }, { toolUseId: "1" });
    expect(result.isError).toBe(false);
    expect(result.content).toBe("ran: ls");
    expect(result.toolUseId).toBe("1");
  });

  test("no allowedPatterns means all tools are permitted", async () => {
    const result = await executeTool(makeEchoTool(), { command: "rm -rf /" }, { toolUseId: "2" });
    expect(result.isError).toBe(false);
  });

  test("matching allowedPattern permits the call", async () => {
    const result = await executeTool(
      makeEchoTool(),
      { command: "git status" },
      { toolUseId: "3", allowedPatterns: ["Bash(git *)"] },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("ran: git status");
  });
});

describe("executeTool — validation failure", () => {
  test("returns isError:true when input fails schema", async () => {
    const result = await executeTool(makeEchoTool(), { command: 99 }, { toolUseId: "4" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Bash");
  });

  test("returns isError:true for null input", async () => {
    const result = await executeTool(makeEchoTool(), null, { toolUseId: "5" });
    expect(result.isError).toBe(true);
  });
});

describe("executeTool — permission denied", () => {
  test("returns isError:true when no pattern matches", async () => {
    const result = await executeTool(
      makeEchoTool(),
      { command: "ls" },
      { toolUseId: "6", allowedPatterns: ["Bash(git *)"] },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not permitted");
    expect(result.content).toContain("Bash");
  });

  test("returns isError:true when patterns list is empty", async () => {
    const result = await executeTool(
      makeEchoTool(),
      { command: "ls" },
      { toolUseId: "7", allowedPatterns: [] },
    );
    expect(result.isError).toBe(true);
  });
});

describe("executeTool — execute throws", () => {
  test("returns isError:true with error message", async () => {
    const failTool = makeEchoTool({
      execute: async () => {
        throw new Error("disk full");
      },
    });
    const result = await executeTool(failTool, { command: "write" }, { toolUseId: "8" });
    expect(result.isError).toBe(true);
    expect(result.content).toBe("disk full");
  });

  test("captures non-Error throws as strings", async () => {
    const failTool = makeEchoTool({
      execute: async () => {
        throw "string error";
      },
    });
    const result = await executeTool(failTool, { command: "x" }, { toolUseId: "9" });
    expect(result.isError).toBe(true);
    expect(result.content).toBe("string error");
  });
});

describe("ToolPermissionError", () => {
  test("has code 'tool' and stable name", () => {
    const err = new ToolPermissionError("Bash");
    expect(err.code).toBe("tool");
    expect(err.name).toBe("ToolPermissionError");
    expect(err.toolName).toBe("Bash");
  });
});
