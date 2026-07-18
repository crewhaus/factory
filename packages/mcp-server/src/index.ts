/**
 * `@crewhaus/mcp-server` — project a compiled bundle's turn function as an MCP
 * server (Loop-contract 0.4, Item 1 / G30). See `./types.ts` for the design
 * rationale and the `IrExpose`/`IrExposeMcp` correspondence.
 *
 * `createMcpServer({ invoke, transport, tools, subAgents })` registers a `chat`
 * tool (and, under `tools: "per-subagent"`, one tool per sub-agent) that all
 * delegate to the injected `invoke`, then binds the requested transport:
 *   - `stdio` → a `StdioMcpServer` you `listen()` on the process stdio.
 *   - `sse`   → an `SseMcpServer` whose `fetch(Request)` handler mounts in any
 *     Web-Standard `fetch` pipeline (Bun / Workers / gateway-server).
 */

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { buildConfiguredServer, computeToolNames, validateOptions } from "./build.js";
import {
  type CreateMcpServerOptions,
  McpServerError,
  type McpServerHandle,
  type SseMcpServer,
  type StdioMcpServer,
  type StdioStreams,
} from "./types.js";

/**
 * Build an MCP server that projects `invoke` as tools over the chosen transport.
 * Throws {@link McpServerError} on a misconfigured projection. Narrow the return
 * on `.transport` to reach the transport-specific methods.
 */
export function createMcpServer(opts: CreateMcpServerOptions): McpServerHandle {
  validateOptions(opts);
  return opts.transport === "stdio" ? createStdioServer(opts) : createSseServer(opts);
}

function createStdioServer(opts: CreateMcpServerOptions): StdioMcpServer {
  const { server, toolNames } = buildConfiguredServer(opts);
  let connected = false;

  const connect = async (transport: Transport): Promise<void> => {
    if (connected) {
      throw new McpServerError("this MCP server is already connected to a transport");
    }
    connected = true;
    try {
      await server.connect(transport);
    } catch (err) {
      connected = false;
      throw err;
    }
  };

  const listen = (streams?: StdioStreams): Promise<void> =>
    connect(new StdioServerTransport(streams?.stdin, streams?.stdout));

  const close = async (): Promise<void> => {
    await server.close();
    connected = false;
  };

  return { transport: "stdio", server, toolNames, connect, listen, close };
}

interface SseSession {
  readonly server: McpServer;
  readonly transport: WebStandardStreamableHTTPServerTransport;
}

function createSseServer(opts: CreateMcpServerOptions): SseMcpServer {
  const toolNames = computeToolNames(opts);
  const sessions = new Map<string, SseSession>();
  let closed = false;

  const closeSession = async (id: string): Promise<void> => {
    const session = sessions.get(id);
    if (session === undefined) return;
    sessions.delete(id);
    await session.transport.close().catch(() => {});
    await session.server.close().catch(() => {});
  };

  const openSession = async (request: Request): Promise<Response> => {
    const { server } = buildConfiguredServer(opts);
    const transport: WebStandardStreamableHTTPServerTransport =
      new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { server, transport });
        },
        onsessionclosed: (id) => {
          void closeSession(id);
        },
      });
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    // A request that never initialized a session (e.g. an invalid non-initialize
    // POST with no session id) leaves an orphan transport — tear it down so a
    // misbehaving client cannot leak servers.
    const id = transport.sessionId;
    if (id === undefined || !sessions.has(id)) {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
    return response;
  };

  const fetch = async (request: Request): Promise<Response> => {
    if (closed) return jsonRpcErrorResponse(503, -32000, "MCP server is closed");
    const sessionId = request.headers.get("mcp-session-id") ?? undefined;
    if (sessionId !== undefined) {
      const session = sessions.get(sessionId);
      if (session !== undefined) return session.transport.handleRequest(request);
      return jsonRpcErrorResponse(404, -32001, "MCP session not found");
    }
    return openSession(request);
  };

  const close = async (): Promise<void> => {
    closed = true;
    await Promise.all([...sessions.keys()].map((id) => closeSession(id)));
  };

  return { transport: "sse", toolNames, fetch, close };
}

/** A minimal JSON-RPC error envelope for transport-level rejections. */
function jsonRpcErrorResponse(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export { CHAT_TOOL_NAME, McpServerError } from "./types.js";
export type {
  CreateMcpServerOptions,
  McpInvoke,
  McpInvokeContext,
  McpServerHandle,
  McpSubAgentDescriptor,
  McpToolsMode,
  McpTransportKind,
  SseMcpServer,
  StdioMcpServer,
  StdioStreams,
} from "./types.js";
