import { describe, expect, test } from "bun:test";
import { McpError } from "@crewhaus/errors";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { nextBackoffMs } from "./backoff.js";
import { McpClient } from "./client.js";
import { McpHost } from "./host.js";
import type { McpServerConfig } from "./types.js";

describe("nextBackoffMs", () => {
  test("attempt 0 returns ~1s with jitter", () => {
    const fixedRng = () => 0.5;
    const result = nextBackoffMs(0, fixedRng);
    expect(result).toBe(1000);
  });

  test("doubles each attempt up to the cap", () => {
    const noJitter = () => 0.5;
    expect(nextBackoffMs(0, noJitter)).toBe(1000);
    expect(nextBackoffMs(1, noJitter)).toBe(2000);
    expect(nextBackoffMs(2, noJitter)).toBe(4000);
    expect(nextBackoffMs(3, noJitter)).toBe(8000);
    expect(nextBackoffMs(4, noJitter)).toBe(16000);
    expect(nextBackoffMs(5, noJitter)).toBe(30000);
    expect(nextBackoffMs(10, noJitter)).toBe(30000);
  });

  test("jitter stays within ±10% of the exponential value", () => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let r = 0; r <= 1; r += 0.05) {
      const v = nextBackoffMs(2, () => r);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    // 4000 ms ±10% → [3600, 4400]
    expect(min).toBeGreaterThanOrEqual(3600);
    expect(max).toBeLessThanOrEqual(4400);
  });

  test("never drops below the 100ms floor", () => {
    const minRng = () => 0;
    expect(nextBackoffMs(0, minRng)).toBeGreaterThanOrEqual(100);
  });
});

describe("McpHost registry", () => {
  test("addServer registers a server and returns the client", () => {
    const host = new McpHost();
    const client = host.addServer("fs", {
      transport: "stdio",
      command: "true",
    });
    expect(client.name).toBe("fs");
    expect(host.has("fs")).toBe(true);
    expect(host.getClient("fs")).toBe(client);
  });

  test("addServer rejects duplicate names with McpError", () => {
    const host = new McpHost();
    host.addServer("fs", { transport: "stdio", command: "true" });
    expect(() => host.addServer("fs", { transport: "stdio", command: "true" })).toThrow(McpError);
    expect(() => host.addServer("fs", { transport: "stdio", command: "true" })).toThrow(
      /already registered/,
    );
  });

  test("getClient throws McpError for an unknown server", () => {
    const host = new McpHost();
    expect(() => host.getClient("ghost")).toThrow(McpError);
    expect(() => host.getClient("ghost")).toThrow(/is not registered/);
  });

  test("list returns every entry in insertion order", () => {
    const host = new McpHost();
    host.addServer("a", { transport: "stdio", command: "true" });
    host.addServer("b", { transport: "stdio", command: "true" });
    expect(host.list().map((e) => e.name)).toEqual(["a", "b"]);
  });

  test("disconnectAll resolves even when no servers are connected", async () => {
    const host = new McpHost();
    host.addServer("a", { transport: "stdio", command: "true" });
    await host.disconnectAll();
  });
});

/**
 * Minimal in-memory MCP server fixture for unit tests. It implements the
 * SDK Transport interface with a synchronous request/response loop driven
 * by the JSON-RPC `method` field. Tests can preload tool listings and call
 * results without spawning a real subprocess.
 */
function createInProcessServer(opts: {
  tools: ReadonlyArray<{ name: string; description?: string; inputSchema: unknown }>;
  callResult?: (
    toolName: string,
    args: unknown,
  ) => { content: ReadonlyArray<unknown>; isError?: boolean };
}): {
  transport: Transport;
  triggerClose: () => void;
  callsLog: () => ReadonlyArray<{ name: string; args: unknown }>;
} {
  const calls: { name: string; args: unknown }[] = [];
  let onmessage: ((m: JSONRPCMessage) => void) | undefined;
  let onclose: (() => void) | undefined;
  let started = false;

  const transport: Transport = {
    async start() {
      started = true;
    },
    async send(message: JSONRPCMessage) {
      if (!("method" in message) || !("id" in message)) {
        // Notification — ignore.
        return;
      }
      const req = message as { id: string | number; method: string; params?: unknown };
      const params = req.params as { name?: string; arguments?: unknown } | undefined;
      let result: unknown;
      switch (req.method) {
        case "initialize":
          result = {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "in-process-fixture", version: "0.0.0" },
          };
          break;
        case "tools/list":
          result = { tools: opts.tools };
          break;
        case "tools/call":
          calls.push({ name: params?.name ?? "", args: params?.arguments });
          result = opts.callResult
            ? opts.callResult(params?.name ?? "", params?.arguments)
            : {
                content: [{ type: "text", text: JSON.stringify(params?.arguments ?? {}) }],
                isError: false,
              };
          break;
        default:
          // Send back a JSON-RPC error so the SDK rejects.
          queueMicrotask(() =>
            onmessage?.({
              jsonrpc: "2.0",
              id: req.id,
              error: { code: -32601, message: `method ${req.method} not found` },
            } as JSONRPCMessage),
          );
          return;
      }
      queueMicrotask(() => onmessage?.({ jsonrpc: "2.0", id: req.id, result } as JSONRPCMessage));
    },
    async close() {
      onclose?.();
    },
    set onmessage(handler: ((m: JSONRPCMessage) => void) | undefined) {
      onmessage = handler;
    },
    get onmessage() {
      return onmessage;
    },
    set onclose(handler: (() => void) | undefined) {
      onclose = handler;
    },
    get onclose() {
      return onclose;
    },
  };

  return {
    transport,
    triggerClose: () => onclose?.(),
    callsLog: () => calls,
    // expose started for sanity
    get started() {
      return started;
    },
  } as ReturnType<typeof createInProcessServer> & { started: boolean };
}

describe("McpClient — happy path with in-process server", () => {
  const cfg: McpServerConfig = { transport: "stdio", command: "true" };

  test("connect → listTools → callTool round-trips", async () => {
    const fixture = createInProcessServer({
      tools: [
        {
          name: "echo",
          description: "echoes back",
          inputSchema: { type: "object", properties: { msg: { type: "string" } } },
        },
        {
          name: "add",
          description: "sum two numbers",
          inputSchema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
          },
        },
      ],
    });
    const client = new McpClient("test", cfg, {
      transportFactory: () => fixture.transport,
      clientFactory: (info) => new Client(info, { capabilities: {} }),
    });
    await client.connect();
    expect(client.getState().kind).toBe("connected");

    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo", "add"]);
    expect(tools[0]?.inputSchema).toEqual({
      type: "object",
      properties: { msg: { type: "string" } },
    });

    const result = await client.callTool("echo", { msg: "hi there" });
    expect(result.isError).toBe(false);
    expect(result.content).toBe('{"msg":"hi there"}');

    await client.disconnect();
    expect(client.getState().kind).toBe("closed");
  });

  test("isError result surfaces as { isError: true, content }", async () => {
    const fixture = createInProcessServer({
      tools: [{ name: "broken", inputSchema: { type: "object" } }],
      callResult: () => ({
        content: [{ type: "text", text: "argv invalid" }],
        isError: true,
      }),
    });
    const client = new McpClient("t", cfg, {
      transportFactory: () => fixture.transport,
      clientFactory: (info) => new Client(info, { capabilities: {} }),
    });
    await client.connect();
    const result = await client.callTool("broken", {});
    expect(result.isError).toBe(true);
    expect(result.content).toBe("argv invalid");
    await client.disconnect();
  });

  test("non-text content blocks reduce to placeholders", async () => {
    const fixture = createInProcessServer({
      tools: [{ name: "img", inputSchema: { type: "object" } }],
      callResult: () => ({
        content: [
          { type: "text", text: "header" },
          { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", mimeType: "image/png" },
          {
            type: "resource",
            resource: { uri: "file:///x.txt", text: "stub", mimeType: "text/plain" },
          },
        ],
        isError: false,
      }),
    });
    const client = new McpClient("t", cfg, {
      transportFactory: () => fixture.transport,
      clientFactory: (info) => new Client(info, { capabilities: {} }),
    });
    await client.connect();
    const result = await client.callTool("img", {});
    expect(result.content).toBe("header\n[image: image/png]\n[resource: file:///x.txt]");
    await client.disconnect();
  });
});

describe("McpClient — closed terminal state", () => {
  test("connect on a closed client throws McpConnectionError", async () => {
    const fixture = createInProcessServer({ tools: [] });
    const client = new McpClient(
      "t",
      { transport: "stdio", command: "true" },
      {
        transportFactory: () => fixture.transport,
        clientFactory: (info) => new Client(info, { capabilities: {} }),
      },
    );
    await client.connect();
    await client.disconnect();
    expect(client.connect()).rejects.toThrow(/is closed/);
  });
});
