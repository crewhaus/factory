import { describe, expect, test } from "bun:test";
import { McpError } from "@crewhaus/errors";
import type { McpHost, McpToolDefinition } from "@crewhaus/mcp-host";
import { ToolCatalog } from "@crewhaus/tool-catalog";
import { buildMcpRegisteredTool, namespacedToolName, registerMcpServer } from "./index.js";

/**
 * In-memory fake McpHost. Sufficient for tool-mcp's surface — we only need
 * `getClient(name).connect() / listTools() / callTool(...)`. The fake is
 * deliberately incomplete (no SDK / no transport) so we don't pull in the
 * full mcp-host test fixture here.
 */
function makeFakeHost(opts: {
  serverName: string;
  tools: ReadonlyArray<McpToolDefinition>;
  callImpl?: (
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<{
    content: string;
    isError: boolean;
  }>;
}): { host: McpHost; calls: Array<{ name: string; args: unknown }> } {
  const calls: Array<{ name: string; args: unknown }> = [];
  const fakeClient = {
    name: opts.serverName,
    async connect() {},
    async listTools() {
      return opts.tools;
    },
    async callTool(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (opts.callImpl) return opts.callImpl(name, args);
      return { content: JSON.stringify(args), isError: false };
    },
    async disconnect() {},
    getState() {
      return { kind: "connected" } as const;
    },
  };
  const host = {
    addServer: () => {
      throw new Error("not used in tests");
    },
    getClient: (name: string) => {
      if (name !== opts.serverName) throw new McpError(`unknown server "${name}"`);
      return fakeClient;
    },
    has: (name: string) => name === opts.serverName,
    list: () => [{ name: opts.serverName, client: fakeClient }],
    disconnectAll: async () => undefined,
  };
  return {
    host: host as unknown as McpHost,
    calls,
  };
}

describe("namespacedToolName", () => {
  test("joins server and tool with double underscore", () => {
    expect(namespacedToolName("everything", "echo")).toBe("everything__echo");
    expect(namespacedToolName("fs", "read_file")).toBe("fs__read_file");
  });
});

describe("buildMcpRegisteredTool — schema and flags", () => {
  test("inputSchema is a permissive validator and jsonSchema carries the JSON Schema bytes", () => {
    const { host } = makeFakeHost({
      serverName: "x",
      tools: [{ name: "echo", inputSchema: { type: "object" } }],
    });
    const tool = buildMcpRegisteredTool(
      host,
      "x",
      {
        name: "echo",
        description: "remote echo",
        inputSchema: { type: "object", properties: { msg: { type: "string" } } },
      },
      { concurrencySafe: false, readOnly: false, destructive: false },
    );

    expect(tool.name).toBe("x__echo");
    expect(tool.description).toBe("remote echo");
    expect(tool.jsonSchema).toEqual({
      type: "object",
      properties: { msg: { type: "string" } },
    });
    // Permissive validator: anything parses.
    expect(tool.inputSchema.safeParse(undefined).success).toBe(true);
    expect(tool.inputSchema.safeParse(42).success).toBe(true);
    expect(tool.inputSchema.safeParse({ deeply: { nested: ["thing"] } }).success).toBe(true);
  });

  test("flags default to false but explicit values pass through", () => {
    const { host } = makeFakeHost({
      serverName: "x",
      tools: [],
    });
    const tool = buildMcpRegisteredTool(
      host,
      "x",
      { name: "tool", inputSchema: {} },
      { concurrencySafe: true, readOnly: true, destructive: false },
    );
    expect(tool.concurrencySafe).toBe(true);
    expect(tool.readOnly).toBe(true);
    expect(tool.destructive).toBe(false);
  });

  test("invalid remote tool name throws McpError", () => {
    const { host } = makeFakeHost({ serverName: "x", tools: [] });
    expect(() =>
      buildMcpRegisteredTool(
        host,
        "x",
        { name: "", inputSchema: {} },
        { concurrencySafe: false, readOnly: false, destructive: false },
      ),
    ).toThrow(McpError);
    expect(() =>
      buildMcpRegisteredTool(
        host,
        "x",
        { name: "has spaces", inputSchema: {} },
        { concurrencySafe: false, readOnly: false, destructive: false },
      ),
    ).toThrow(/invalid name/);
  });

  test("description sanitises C0 control chars and trims whitespace", () => {
    const { host } = makeFakeHost({ serverName: "x", tools: [] });
    const tool = buildMcpRegisteredTool(
      host,
      "x",
      { name: "tool", description: "  hi\x00\x01there\x7f  ", inputSchema: {} },
      { concurrencySafe: false, readOnly: false, destructive: false },
    );
    expect(tool.description).toBe("hithere");
  });

  test("description falls back to a generated label when missing or empty", () => {
    const { host } = makeFakeHost({ serverName: "x", tools: [] });
    const tool = buildMcpRegisteredTool(
      host,
      "x",
      { name: "tool", inputSchema: {} },
      { concurrencySafe: false, readOnly: false, destructive: false },
    );
    expect(tool.description).toBe("MCP tool x__tool");
  });
});

describe("registerMcpServer — round-trip via fake host (T3)", () => {
  test("registers each remote tool with namespaced name and round-trips a call", async () => {
    const { host, calls } = makeFakeHost({
      serverName: "everything",
      tools: [
        { name: "echo", description: "echoes input", inputSchema: { type: "object" } },
        { name: "add", description: "adds numbers", inputSchema: { type: "object" } },
      ],
    });
    const catalog = new ToolCatalog();
    const registered: Array<{ fullName: string; remoteName: string }> = [];
    await registerMcpServer(host, "everything", catalog, {
      onRegister: (info) => registered.push(info),
    });

    const names = catalog.list().map((t) => t.name);
    expect(names).toEqual(["everything__echo", "everything__add"]);
    expect(registered).toEqual([
      { fullName: "everything__echo", remoteName: "echo" },
      { fullName: "everything__add", remoteName: "add" },
    ]);

    // Invoke the registered tool — args should land in the underlying
    // MCP call as the un-namespaced remote tool name.
    const echo = catalog.get("everything__echo");
    if (!echo) throw new Error("echo not registered");
    const result = await echo.execute({ message: "hi" });
    expect(result).toBe('{"message":"hi"}');
    expect(calls).toEqual([{ name: "echo", args: { message: "hi" } }]);
  });

  test("perTool flags win over defaults", async () => {
    const { host } = makeFakeHost({
      serverName: "fs",
      tools: [
        { name: "read", inputSchema: {} },
        { name: "write", inputSchema: {} },
        { name: "delete", inputSchema: {} },
      ],
    });
    const catalog = new ToolCatalog();
    await registerMcpServer(host, "fs", catalog, {
      defaults: { concurrencySafe: true, readOnly: true, destructive: false },
      perTool: {
        write: { readOnly: false },
        delete: { readOnly: false, destructive: true, concurrencySafe: false },
      },
    });

    const read = catalog.get("fs__read");
    const write = catalog.get("fs__write");
    const del = catalog.get("fs__delete");
    expect(read?.concurrencySafe).toBe(true);
    expect(read?.readOnly).toBe(true);
    expect(read?.destructive).toBe(false);
    expect(write?.readOnly).toBe(false);
    expect(write?.concurrencySafe).toBe(true); // inherited from defaults
    expect(del?.destructive).toBe(true);
    expect(del?.concurrencySafe).toBe(false);
  });

  test("isError result from MCP server surfaces as a thrown McpError", async () => {
    const { host } = makeFakeHost({
      serverName: "x",
      tools: [{ name: "broken", inputSchema: {} }],
      callImpl: async () => ({ content: "args invalid", isError: true }),
    });
    const catalog = new ToolCatalog();
    await registerMcpServer(host, "x", catalog);
    const tool = catalog.get("x__broken");
    if (!tool) throw new Error("broken not registered");
    expect(tool.execute({})).rejects.toThrow(McpError);
    expect(tool.execute({})).rejects.toThrow(/args invalid/);
  });
});
