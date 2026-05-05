import { describe, expect, test } from "bun:test";
import { CrewhausError } from "@crewhaus/errors";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { ToolValidationError, validateToolInput } from "./index";

const schema = z.object({ command: z.string(), args: z.array(z.string()).optional() });

const tool: RegisteredTool = {
  name: "Bash",
  description: "Run shell commands",
  inputSchema: schema as RegisteredTool["inputSchema"],
  execute: async () => "",
  concurrencySafe: false,
  readOnly: false,
  destructive: false,
};

describe("validateToolInput — success", () => {
  test("returns ok:true with parsed value for valid input", () => {
    const result = validateToolInput(tool, { command: "ls" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as { command: string }).command).toBe("ls");
    }
  });

  test("optional fields are present when provided", () => {
    const result = validateToolInput(tool, { command: "git", args: ["status"] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as { args: string[] }).args).toEqual(["status"]);
    }
  });

  test("optional fields absent when omitted", () => {
    const result = validateToolInput(tool, { command: "pwd" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as { args?: unknown }).args).toBeUndefined();
    }
  });
});

describe("validateToolInput — failure", () => {
  test("returns ok:false with ToolValidationError for wrong type", () => {
    const result = validateToolInput(tool, { command: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ToolValidationError);
    }
  });

  test("error message includes tool name", () => {
    const result = validateToolInput(tool, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Bash");
    }
  });

  test("error.issues contains path and message", () => {
    const result = validateToolInput(tool, { command: 123 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues.length).toBeGreaterThan(0);
      expect(result.error.issues[0]).toHaveProperty("path");
      expect(result.error.issues[0]).toHaveProperty("message");
    }
  });

  test("ToolValidationError is instanceof CrewhausError", () => {
    const result = validateToolInput(tool, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(CrewhausError);
    }
  });

  test("ToolValidationError has code 'tool'", () => {
    const result = validateToolInput(tool, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("tool");
    }
  });

  test("ToolValidationError name is stable", () => {
    const result = validateToolInput(tool, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("ToolValidationError");
    }
  });
});
