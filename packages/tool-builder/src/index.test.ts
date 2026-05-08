import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { buildTool } from "./index";

const echoSchema = z.object({ message: z.string() });
type EchoInput = z.infer<typeof echoSchema>;

const echoDef: ToolDefinition<EchoInput> = {
  name: "Echo",
  description: "Echoes the message",
  inputSchema: echoSchema,
  execute: async (input) => input.message,
};

describe("buildTool — fail-closed defaults", () => {
  test("concurrencySafe defaults to false", () => {
    const tool = buildTool(echoDef);
    expect(tool.concurrencySafe).toBe(false);
  });

  test("readOnly defaults to false", () => {
    const tool = buildTool(echoDef);
    expect(tool.readOnly).toBe(false);
  });

  test("destructive defaults to false", () => {
    const tool = buildTool(echoDef);
    expect(tool.destructive).toBe(false);
  });

  test("explicit true flags are preserved", () => {
    const tool = buildTool({
      ...echoDef,
      concurrencySafe: true,
      readOnly: true,
      destructive: true,
    });
    expect(tool.concurrencySafe).toBe(true);
    expect(tool.readOnly).toBe(true);
    expect(tool.destructive).toBe(true);
  });

  test("explicit false flags are preserved", () => {
    const tool = buildTool({
      ...echoDef,
      concurrencySafe: false,
      readOnly: false,
      destructive: false,
    });
    expect(tool.concurrencySafe).toBe(false);
    expect(tool.readOnly).toBe(false);
    expect(tool.destructive).toBe(false);
  });

  test("requiresSandbox defaults to false (fail-closed)", () => {
    const tool = buildTool(echoDef);
    expect(tool.requiresSandbox).toBe(false);
  });

  test("requiresSandbox=true is preserved", () => {
    const tool = buildTool({ ...echoDef, requiresSandbox: true });
    expect(tool.requiresSandbox).toBe(true);
  });

  test("classifyOutput defaults to true", () => {
    const tool = buildTool(echoDef);
    expect(tool.classifyOutput).toBe(true);
  });

  test("classifyOutput=false is preserved", () => {
    const tool = buildTool({ ...echoDef, classifyOutput: false });
    expect(tool.classifyOutput).toBe(false);
  });
});

describe("buildTool — identity fields", () => {
  test("name and description are passed through", () => {
    const tool = buildTool(echoDef);
    expect(tool.name).toBe("Echo");
    expect(tool.description).toBe("Echoes the message");
  });

  test("inputSchema is passed through", () => {
    const tool = buildTool(echoDef);
    expect(tool.inputSchema).toBe(echoSchema);
  });
});

describe("buildTool — jsonSchema passthrough", () => {
  test("jsonSchema is omitted when not set on the definition", () => {
    const tool = buildTool(echoDef);
    expect(tool.jsonSchema).toBeUndefined();
    expect("jsonSchema" in tool).toBe(false);
  });

  test("jsonSchema is preserved verbatim when present", () => {
    const raw = {
      type: "object" as const,
      properties: { message: { type: "string" as const } },
      required: ["message"],
    };
    const tool = buildTool({ ...echoDef, jsonSchema: raw });
    expect(tool.jsonSchema).toBe(raw);
  });
});

describe("buildTool — execute delegation", () => {
  test("registered execute calls original def.execute", async () => {
    const tool = buildTool(echoDef);
    const result = await tool.execute({ message: "hello" });
    expect(result).toBe("hello");
  });

  test("execute propagates errors from def.execute", async () => {
    const failDef: ToolDefinition<EchoInput> = {
      ...echoDef,
      execute: async () => {
        throw new Error("boom");
      },
    };
    const tool = buildTool(failDef);
    expect(tool.execute({ message: "x" })).rejects.toThrow("boom");
  });
});
