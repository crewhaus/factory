import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { OUTWARD_TOOL_NAMES, buildTool, isOutwardName } from "./index";

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

  test("scope defaults to 'internal' (Pillar 3 sink-side, fail-closed)", () => {
    const tool = buildTool(echoDef);
    expect(tool.scope).toBe("internal");
  });

  test("scope='external' is preserved", () => {
    const tool = buildTool({ ...echoDef, scope: "external" });
    expect(tool.scope).toBe("external");
  });

  test("requireJustification defaults to false (Pillar 3 intent gate, fail-closed)", () => {
    const tool = buildTool(echoDef);
    expect(tool.requireJustification).toBe(false);
  });

  test("requireJustification=true is preserved", () => {
    const tool = buildTool({ ...echoDef, requireJustification: true });
    expect(tool.requireJustification).toBe(true);
  });

  // FR-002 — io-capability passthrough. Like jsonSchema, the field is omitted
  // entirely when the definition does not set it (additive; no behavior change
  // for the ~all tools that don't declare it).
  test("ioCapability is omitted when not set on the definition", () => {
    const tool = buildTool(echoDef);
    expect(tool.ioCapability).toBeUndefined();
    expect("ioCapability" in tool).toBe(false);
  });

  test("ioCapability:'network' is passed through verbatim", () => {
    const tool = buildTool({ ...echoDef, name: "CustomSocket", ioCapability: "network" });
    expect(tool.ioCapability).toBe("network");
  });

  test("ioCapability:'process' is passed through verbatim", () => {
    const tool = buildTool({ ...echoDef, name: "RunDaemon", ioCapability: "process" });
    expect(tool.ioCapability).toBe("process");
  });

  test("ioCapability does NOT itself flip the scope default (scope stays its own decision)", () => {
    // ioCapability is the *fact*; scope is the *policy*. buildTool does not
    // infer scope from ioCapability — the compile-time audit is what couples
    // them. A custom io-capable tool that forgets scope still defaults to
    // "internal" here (fail-closed), which is exactly what --strict then flags.
    const tool = buildTool({ ...echoDef, name: "CustomSocket", ioCapability: "network" });
    expect(tool.scope).toBe("internal");
  });
});

describe("buildTool — FR-002 outward-name scope inference (defense-in-depth)", () => {
  test("an outward-name tool with no explicit scope infers 'external' (Fetch)", () => {
    const tool = buildTool({ ...echoDef, name: "Fetch" });
    expect(tool.scope).toBe("external");
  });

  test.each(["WebFetch", "WebSearch", "SendMessage", "EvmSendTransaction", "ImageGenerate"])(
    "outward built-in %s infers 'external' when scope is unspecified",
    (name) => {
      const tool = buildTool({ ...echoDef, name });
      expect(tool.scope).toBe("external");
    },
  );

  test("a namespaced MCP tool (mcp__server__tool) infers 'external' via the prefix rule", () => {
    const tool = buildTool({ ...echoDef, name: "mcp__slack__send" });
    expect(tool.scope).toBe("external");
  });

  test("a pure-compute name (Echo) still defaults to 'internal'", () => {
    const tool = buildTool({ ...echoDef, name: "Echo" });
    expect(tool.scope).toBe("internal");
  });

  test("an explicit scope:'internal' on an outward NAME is preserved (def.scope wins)", () => {
    // The override path the FR's red gate covers: an author can still force a
    // known-outward tool back to internal, and the audit (compile --strict /
    // doctor) is what flags that as the footgun.
    const tool = buildTool({ ...echoDef, name: "Fetch", scope: "internal" });
    expect(tool.scope).toBe("internal");
  });

  test("an explicit scope:'external' on a non-outward name is preserved", () => {
    const tool = buildTool({ ...echoDef, name: "CustomSocket", scope: "external" });
    expect(tool.scope).toBe("external");
  });
});

describe("isOutwardName / OUTWARD_TOOL_NAMES", () => {
  test("returns true for every name in the outward set", () => {
    for (const name of OUTWARD_TOOL_NAMES) {
      expect(isOutwardName(name)).toBe(true);
    }
  });

  test("returns true for any mcp__-prefixed name", () => {
    expect(isOutwardName("mcp__github__create_issue")).toBe(true);
    expect(isOutwardName("mcp__")).toBe(true);
  });

  test("returns false for internal/compute tool names", () => {
    expect(isOutwardName("Echo")).toBe(false);
    expect(isOutwardName("read")).toBe(false);
    expect(isOutwardName("bash")).toBe(false);
    // a name that merely contains 'mcp' but isn't prefixed is not outward
    expect(isOutwardName("dumpcp")).toBe(false);
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
