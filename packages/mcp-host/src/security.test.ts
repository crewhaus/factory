import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { McpClient } from "./client.js";

/**
 * T8 — security: a malicious server must not be able to escape the schema
 * validator boundary. We never deref `$ref`, never mutate prototypes via
 * an attacker-controlled JSON Schema, and the schema bytes returned to the
 * caller must be the same object handed to us by the SDK.
 */

function malicousFixture(maliciousSchema: unknown): Transport {
  let onmessage: ((m: JSONRPCMessage) => void) | undefined;
  return {
    async start() {},
    async send(message) {
      if (!("method" in message) || !("id" in message)) return;
      const req = message as { id: string | number; method: string };
      let result: unknown;
      switch (req.method) {
        case "initialize":
          result = {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "evil", version: "0.0.0" },
          };
          break;
        case "tools/list":
          result = {
            tools: [
              {
                name: "evil_tool",
                description: "looks innocent",
                inputSchema: maliciousSchema,
              },
            ],
          };
          break;
        default:
          queueMicrotask(() =>
            onmessage?.({
              jsonrpc: "2.0",
              id: req.id,
              error: { code: -32601, message: "no" },
            } as JSONRPCMessage),
          );
          return;
      }
      queueMicrotask(() => onmessage?.({ jsonrpc: "2.0", id: req.id, result } as JSONRPCMessage));
    },
    async close() {},
    set onmessage(h) {
      onmessage = h;
    },
    get onmessage() {
      return onmessage;
    },
  };
}

describe("McpClient — schema-validator escape attempts (T8)", () => {
  test("malicious $ref prototype-pollution attempt does not mutate Object.prototype", async () => {
    // Schema must satisfy the MCP protocol baseline (type: "object") so
    // ListToolsResult validates, but carries adversarial extras: a $ref
    // that would, under naive deref, walk into __proto__. We never
    // dereference the schema — we treat it as opaque bytes through to the
    // model.
    const sentinel = `${(Object.prototype as Record<string, unknown>)["polluted"]}`;
    const malicious: Record<string, unknown> = {
      type: "object",
      properties: {
        legit_field: { type: "string", description: "innocent" },
        evil_field: { $ref: "#/__proto__" },
      },
      $ref: "#/__proto__",
      // Standalone polluted-style keyword — model would see it but no naive
      // deref/merge happens server-side.
      "x-polluted": true,
    };
    const client = new McpClient(
      "evil",
      { transport: "stdio", command: "true" },
      {
        transportFactory: () => malicousFixture(malicious),
        clientFactory: (info) => new Client(info, { capabilities: {} }),
      },
    );
    await client.connect();
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("evil_tool");

    // Object.prototype must be untouched.
    const after = `${(Object.prototype as Record<string, unknown>)["polluted"]}`;
    expect(after).toBe(sentinel);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    await client.disconnect();
  });

  test("schema bytes round-trip verbatim through listTools", async () => {
    // The schema is captured by reference identity through the SDK Zod
    // pipeline, so the deep-equal check is sufficient even if the SDK
    // strips additional fields not in its zod shape.
    const schema = {
      type: "object",
      properties: {
        x: { type: "number", description: "value" },
      },
      required: ["x"],
    };
    const client = new McpClient(
      "ok",
      { transport: "stdio", command: "true" },
      {
        transportFactory: () => malicousFixture(schema),
        clientFactory: (info) => new Client(info, { capabilities: {} }),
      },
    );
    await client.connect();
    const tools = await client.listTools();
    expect(tools[0]?.inputSchema).toEqual(schema);
    await client.disconnect();
  });

  test("absurdly deep nested schema does not crash listTools", async () => {
    // Build a 200-level nested schema. We don't recurse; we just hand it
    // back in McpToolDefinition.inputSchema. The SDK validates the top-
    // level shape (type:object) but does not walk arbitrary nested keys.
    const root: Record<string, unknown> = { type: "object", properties: {} };
    let cursor: Record<string, unknown> = root;
    for (let i = 0; i < 200; i++) {
      const next: Record<string, unknown> = { type: "object", properties: {} };
      (cursor["properties"] as Record<string, unknown>)["nested"] = next;
      cursor = next;
    }
    const client = new McpClient(
      "deep",
      { transport: "stdio", command: "true" },
      {
        transportFactory: () => malicousFixture(root),
        clientFactory: (info) => new Client(info, { capabilities: {} }),
      },
    );
    await client.connect();
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    await client.disconnect();
  });
});
