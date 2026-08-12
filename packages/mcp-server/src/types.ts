/**
 * Catalog R5 (`mcp-server`) — public surface for the MCP-server PROJECTION
 * (Loop-contract 0.4, Item 1 / G30).
 *
 * The `expose:` spec block lowers to `IrExpose`/`IrExposeMcp` (`@crewhaus/ir`)
 * and asks the compiler to project THIS compiled bundle's turn function as an
 * MCP server so Claude Code / IDEs / other CrewHaus runtimes can call the whole
 * agent as a tool. This package is the runtime half of that projection.
 *
 * Deliberately IR- and runtime-agnostic: the bundle's turn function is INJECTED
 * as `invoke`, so `mcp-server` depends on neither `@crewhaus/compiler` nor
 * `@crewhaus/runtime-core`. The CLI slice builds `invoke` from a compiled
 * bundle and hands it here; `mcp-server` only knows how to wrap it in the
 * official `@modelcontextprotocol/sdk` server + a transport.
 *
 *   - `transport: "stdio"` → a spawned stdio MCP server (the
 *     `crewhaus serve --mcp` path). Node/Bun only.
 *   - `transport: "sse"` → a Web-Standard `fetch(Request): Promise<Response>`
 *     handler that SSE-streams responses (built on the SDK's Streamable-HTTP
 *     transport). Mountable in a `Bun.serve` / Cloudflare Workers /
 *     `gateway-server` fetch pipeline so the SSE exposure can ride the
 *     gateway's tenancy/budgets where the shape has them.
 *
 * Tool projection mirrors `IrExposeMcp.tools`:
 *   - `"chat"` (default) → one primary `chat` tool taking `{ message }` and
 *     returning the final assistant text.
 *   - `"per-subagent"` → the `chat` tool PLUS one tool per declared sub-agent,
 *     each delegating to `invoke` with the sub-agent's name in the call
 *     context so the injected fn can route to that sub-agent.
 */

import type { Readable, Writable } from "node:stream";
import { McpError } from "@crewhaus/errors";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** Wire transport for the projected MCP server. Mirrors `IrExposeMcp.transport`. */
export type McpTransportKind = "stdio" | "sse";

/** Which tools to project. Mirrors the RESOLVED `IrExposeMcp.tools`. */
export type McpToolsMode = "chat" | "per-subagent";

/** Name of the primary invoke tool that delegates the whole agent turn. */
export const CHAT_TOOL_NAME = "chat";

/**
 * Context handed to the injected `invoke` on every MCP tool call.
 *
 * `toolName` is the MCP tool the client called. `subAgent` is set ONLY for a
 * per-sub-agent tool and carries the ORIGINAL spec sub-agent name (before MCP
 * tool-name sanitization), so the injected fn can route the message to that
 * sub-agent. Absent for the primary `chat` tool.
 */
export interface McpInvokeContext {
  readonly toolName: string;
  readonly subAgent?: string;
  /**
   * The MCP transport's session id, on the `sse` transport once the client
   * has initialized one. Absent on `stdio` (one process, one conversation)
   * and on the very first request of an SSE session.
   *
   * It exists so a bundle that projects itself can key its OWN conversation
   * state per CALLER: a channel daemon exposing `expose.mcp` maps this onto
   * a harness session id, so two IDEs driving the same daemon do not write
   * into one transcript. Without it every caller collapses onto a single
   * shared session — which is not a subtle wrong, it is one user reading
   * another's conversation.
   */
  readonly sessionId?: string;
}

/**
 * The injected delegate: run one agent turn for `message` and resolve with the
 * final assistant text. A plain `(message: string) => Promise<string>` is
 * assignable here — the `context` argument is optional for callers that don't
 * need per-sub-agent routing.
 */
export type McpInvoke = (message: string, context: McpInvokeContext) => Promise<string>;

/** A sub-agent to project as its own MCP tool under `tools: "per-subagent"`. */
export interface McpSubAgentDescriptor {
  /** The spec sub-agent name (`sub_agents.<name>`). Passed back via `McpInvokeContext.subAgent`. */
  readonly name: string;
  /** Shown to the calling model as the tool's description. */
  readonly description: string;
}

/** Options for {@link createMcpServer}. */
export interface CreateMcpServerOptions {
  /** The bundle's turn function. Required. */
  readonly invoke: McpInvoke;
  /** Which transport to bind. Required. */
  readonly transport: McpTransportKind;
  /** Tool projection mode. Defaults to `"chat"`. */
  readonly tools?: McpToolsMode;
  /** Sub-agents to project — required (and non-empty) when `tools: "per-subagent"`. */
  readonly subAgents?: readonly McpSubAgentDescriptor[];
  /** MCP server info `name` advertised to clients. Defaults to `"crewhaus"`. */
  readonly name?: string;
  /** MCP server info `version`. Defaults to `"0.0.0"`. */
  readonly version?: string;
  /** Optional MCP server instructions advertised in the initialize result. */
  readonly instructions?: string;
  /** Override the primary `chat` tool's description. */
  readonly chatToolDescription?: string;
}

/**
 * Streams for {@link StdioMcpServer.listen}. Defaults to the process's
 * `stdin`/`stdout` when omitted; the injection hook exists mainly for tests.
 */
export interface StdioStreams {
  readonly stdin?: Readable;
  readonly stdout?: Writable;
}

interface McpServerHandleBase {
  readonly transport: McpTransportKind;
  /** The MCP tool names registered per session, in registration order. */
  readonly toolNames: readonly string[];
  /** Close the server and every transport/session it owns. */
  close(): Promise<void>;
}

/** Handle returned by {@link createMcpServer} for `transport: "stdio"`. */
export interface StdioMcpServer extends McpServerHandleBase {
  readonly transport: "stdio";
  /** The underlying SDK server (advanced use: notifications, custom handlers). */
  readonly server: McpServer;
  /**
   * Connect the server to any SDK {@link Transport} and start serving.
   * Transport-agnostic — `listen()` wraps this with a `StdioServerTransport`,
   * and tests link it to an `InMemoryTransport`. Throws if already connected.
   */
  connect(transport: Transport): Promise<void>;
  /** Bind to the process's stdio (or the injected `streams`) and serve until `close()`. */
  listen(streams?: StdioStreams): Promise<void>;
}

/** Handle returned by {@link createMcpServer} for `transport: "sse"`. */
export interface SseMcpServer extends McpServerHandleBase {
  readonly transport: "sse";
  /**
   * Web-Standard fetch handler. Mount it directly:
   * `Bun.serve({ fetch: handle.fetch })`, or from a Workers/gateway `fetch`.
   * MCP sessions are managed internally (one Streamable-HTTP transport + SDK
   * server per session, keyed by the `mcp-session-id` header).
   */
  fetch(request: Request): Promise<Response>;
}

/** Discriminated handle over the two transports. Narrow on `.transport`. */
export type McpServerHandle = StdioMcpServer | SseMcpServer;

/**
 * Raised for misconfigured projections (missing `invoke`, unknown transport,
 * `per-subagent` with no sub-agents, double-connect). Carries the shared
 * `"mcp"` error code via {@link McpError}.
 */
export class McpServerError extends McpError {
  override readonly name = "McpServerError";
}
