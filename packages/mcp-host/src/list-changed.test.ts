/**
 * Loop contract 0.4 (Batch G, G74) — `notifications/tools/list_changed`.
 *
 * The McpClient subscribes to the server's tools/list_changed notification
 * (via the real SDK Client's notification surface), invalidates its tool
 * cache, and fans out to `onToolsChanged` handlers — the seam tool-mcp's
 * re-diff path hooks. These tests drive a real `Client` over a controllable
 * in-process transport that can (a) return a MUTABLE tool list and (b) push a
 * server-initiated notification on demand.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { McpClient } from "./client.js";
import type { McpServerConfig } from "./types.js";

const STDIO_CFG: McpServerConfig = { transport: "stdio", command: "true" };

type ToolList = {
  tools: ReadonlyArray<{ name: string; description?: string; inputSchema: unknown }>;
};

/** Controllable transport with a mutable tool list + a notification pusher. */
function createNotifyingTransport(initial: ToolList): {
  transport: Transport;
  setTools: (t: ToolList) => void;
  pushToolsChanged: () => void;
} {
  let onmessage: ((m: JSONRPCMessage) => void) | undefined;
  let onclose: (() => void) | undefined;
  let tools = initial;
  const transport: Transport = {
    async start() {},
    async send(message: JSONRPCMessage) {
      if (!("method" in message) || !("id" in message)) return;
      const req = message as { id: string | number; method: string };
      let result: unknown;
      switch (req.method) {
        case "initialize":
          result = {
            protocolVersion: "2024-11-05",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "fixture", version: "0.0.0" },
          };
          break;
        case "tools/list":
          result = tools;
          break;
        default:
          result = {};
      }
      queueMicrotask(() => onmessage?.({ jsonrpc: "2.0", id: req.id, result } as JSONRPCMessage));
    },
    async close() {
      onclose?.();
    },
    set onmessage(h: ((m: JSONRPCMessage) => void) | undefined) {
      onmessage = h;
    },
    get onmessage() {
      return onmessage;
    },
    set onclose(h: (() => void) | undefined) {
      onclose = h;
    },
    get onclose() {
      return onclose;
    },
  };
  return {
    transport,
    setTools: (t) => {
      tools = t;
    },
    pushToolsChanged: () =>
      onmessage?.({
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
      } as JSONRPCMessage),
  };
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => queueMicrotask(() => r(undefined)));
}

const SCHEMA = { type: "object" as const };

describe("McpClient — tools/list_changed subscription (G74)", () => {
  test("a list_changed notification invalidates the cache; the next listTools re-fetches", async () => {
    const fx = createNotifyingTransport({ tools: [{ name: "a", inputSchema: SCHEMA }] });
    const client = new McpClient("srv", STDIO_CFG, {
      transportFactory: () => fx.transport,
      clientFactory: (info) => new Client(info, { capabilities: {} }),
    });
    await client.connect();
    expect((await client.listTools()).map((t) => t.name)).toEqual(["a"]);

    fx.setTools({
      tools: [
        { name: "a", inputSchema: SCHEMA },
        { name: "b", inputSchema: SCHEMA },
      ],
    });
    // Without the notification the cache would still say [a].
    expect((await client.listTools()).map((t) => t.name)).toEqual(["a"]);

    fx.pushToolsChanged();
    await flush();
    expect((await client.listTools()).map((t) => t.name)).toEqual(["a", "b"]);
  });

  test("onToolsChanged fires on the notification and unsubscribe stops it", async () => {
    const fx = createNotifyingTransport({ tools: [{ name: "a", inputSchema: SCHEMA }] });
    const client = new McpClient("srv", STDIO_CFG, {
      transportFactory: () => fx.transport,
      clientFactory: (info) => new Client(info, { capabilities: {} }),
    });
    let fires = 0;
    const unsub = client.onToolsChanged(() => {
      fires += 1;
    });
    await client.connect();

    fx.pushToolsChanged();
    await flush();
    expect(fires).toBe(1);

    unsub();
    fx.pushToolsChanged();
    await flush();
    expect(fires).toBe(1);
  });

  test("the constructor onToolsChanged option is registered", async () => {
    const fx = createNotifyingTransport({ tools: [] });
    let fired = false;
    const client = new McpClient("srv", STDIO_CFG, {
      transportFactory: () => fx.transport,
      clientFactory: (info) => new Client(info, { capabilities: {} }),
      onToolsChanged: () => {
        fired = true;
      },
    });
    await client.connect();
    fx.pushToolsChanged();
    await flush();
    expect(fired).toBe(true);
  });

  test("refreshTools bypasses the cache", async () => {
    const fx = createNotifyingTransport({ tools: [{ name: "a", inputSchema: SCHEMA }] });
    const client = new McpClient("srv", STDIO_CFG, {
      transportFactory: () => fx.transport,
      clientFactory: (info) => new Client(info, { capabilities: {} }),
    });
    await client.connect();
    await client.listTools();
    fx.setTools({ tools: [{ name: "z", inputSchema: SCHEMA }] });
    expect((await client.refreshTools()).map((t) => t.name)).toEqual(["z"]);
  });
});
