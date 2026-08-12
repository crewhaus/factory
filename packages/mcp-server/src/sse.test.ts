import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "bun";
import {
  CHAT_TOOL_NAME,
  type CreateMcpServerOptions,
  type McpInvoke,
  type McpInvokeContext,
  type SseMcpServer,
  createMcpServer,
} from "./index.js";

function recorder(
  reply: (message: string, context: McpInvokeContext) => string = (m) => `echo:${m}`,
): { calls: Array<{ message: string; context: McpInvokeContext }>; invoke: McpInvoke } {
  const calls: Array<{ message: string; context: McpInvokeContext }> = [];
  const invoke: McpInvoke = async (message, context) => {
    calls.push({ message, context });
    return reply(message, context);
  };
  return { calls, invoke };
}

function makeSse(opts: Omit<CreateMcpServerOptions, "transport">): SseMcpServer {
  const handle = createMcpServer({ ...opts, transport: "sse" });
  if (handle.transport !== "sse") throw new Error("expected an sse handle");
  return handle;
}

/** Mount an sse handle behind a real Bun.serve and hand back the base URL. */
function serve(handle: SseMcpServer): { server: Server; url: URL } {
  const server = Bun.serve({ port: 0, fetch: (req) => handle.fetch(req) });
  return { server, url: new URL(`http://localhost:${server.port}/`) };
}

async function connect(url: URL): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

function firstText(result: CallToolResult): string | undefined {
  const block = result.content[0];
  return block !== undefined && block.type === "text" ? block.text : undefined;
}

let openHandles: SseMcpServer[] = [];
let openServers: Server[] = [];

function track(handle: SseMcpServer): SseMcpServer {
  openHandles.push(handle);
  return handle;
}

afterEach(async () => {
  for (const s of openServers) s.stop(true);
  await Promise.all(openHandles.map((h) => h.close()));
  openServers = [];
  openHandles = [];
});

describe("createMcpServer — sse fetch handler", () => {
  test("serves a full MCP lifecycle (initialize → list → call) over HTTP", async () => {
    const rec = recorder((m) => `served:${m}`);
    const handle = track(makeSse({ invoke: rec.invoke }));
    expect(handle.toolNames).toEqual([CHAT_TOOL_NAME]);

    const { server, url } = serve(handle);
    openServers.push(server);

    const client = await connect(url);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual([CHAT_TOOL_NAME]);

      const result = (await client.callTool({
        name: CHAT_TOOL_NAME,
        arguments: { message: "over-http" },
      })) as CallToolResult;
      expect(firstText(result)).toBe("served:over-http");
      // The context carries this SESSION's id (#394): a projected bundle keys
      // its own conversation state on it, so two callers never collapse onto
      // one transcript. Absent on stdio, where there is one conversation.
      expect(rec.calls[0]?.context.toolName).toBe(CHAT_TOOL_NAME);
      expect(rec.calls[0]?.context.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await client.close();
    }
  });

  test("projects per-subagent tools over HTTP with sub-agent routing", async () => {
    const rec = recorder((m, ctx) => `${ctx.subAgent}:${m}`);
    const handle = track(
      makeSse({
        invoke: rec.invoke,
        tools: "per-subagent",
        subAgents: [{ name: "analyst", description: "Crunches numbers." }],
      }),
    );
    const { server, url } = serve(handle);
    openServers.push(server);

    const client = await connect(url);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["analyst", "chat"]);

      const result = (await client.callTool({
        name: "analyst",
        arguments: { message: "sum" },
      })) as CallToolResult;
      expect(firstText(result)).toBe("analyst:sum");
      expect(rec.calls[0]?.context.toolName).toBe("analyst");
      expect(rec.calls[0]?.context.subAgent).toBe("analyst");
      expect(rec.calls[0]?.context.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await client.close();
    }
  });

  test("isolates concurrent client sessions", async () => {
    const rec = recorder((m) => `r:${m}`);
    const handle = track(makeSse({ invoke: rec.invoke }));
    const { server, url } = serve(handle);
    openServers.push(server);

    const roundtrip = async (msg: string): Promise<string | undefined> => {
      const client = await connect(url);
      try {
        const result = (await client.callTool({
          name: CHAT_TOOL_NAME,
          arguments: { message: msg },
        })) as CallToolResult;
        return firstText(result);
      } finally {
        await client.close();
      }
    };

    const [a, b] = await Promise.all([roundtrip("one"), roundtrip("two")]);
    expect(new Set([a, b])).toEqual(new Set(["r:one", "r:two"]));
    expect(rec.calls.map((c) => c.message).sort()).toEqual(["one", "two"]);
  });

  test("rejects an unknown session id with 404", async () => {
    const handle = track(makeSse({ invoke: recorder().invoke }));
    const response = await handle.fetch(
      new Request("http://mcp.local/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": "does-not-exist",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", params: {}, id: 1 }),
      }),
    );
    expect(response.status).toBe(404);
  });

  test("refuses requests after close() with 503", async () => {
    const handle = makeSse({ invoke: recorder().invoke });
    await handle.close();
    const response = await handle.fetch(
      new Request("http://mcp.local/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: {}, id: 1 }),
      }),
    );
    expect(response.status).toBe(503);
  });
});
