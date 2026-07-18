/**
 * Tool registration + SDK-server construction for the MCP projection.
 *
 * `buildConfiguredServer` mints a fresh `McpServer` with the projected tools
 * registered; the stdio path calls it once, the SSE path calls it per session.
 * Every tool delegates to the injected `invoke`, which is the ONLY behavioural
 * dependency — there is no compiler/runtime coupling here.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  CHAT_TOOL_NAME,
  type CreateMcpServerOptions,
  type McpInvoke,
  type McpInvokeContext,
  McpServerError,
  type McpSubAgentDescriptor,
  type McpToolsMode,
} from "./types.js";

const DEFAULT_NAME = "crewhaus";
const DEFAULT_VERSION = "0.0.0";

/** Resolve the tools-mode default (`"chat"`), mirroring the IR lower step. */
export function resolveToolsMode(mode: McpToolsMode | undefined): McpToolsMode {
  return mode ?? "chat";
}

/**
 * Reject a projection that cannot be built. The spec's cross-field check
 * already guards `per-subagent` upstream, but this package must be safe when
 * driven standalone (e.g. from a hand-built `invoke`).
 */
export function validateOptions(opts: CreateMcpServerOptions): void {
  if (typeof opts.invoke !== "function") {
    throw new McpServerError("createMcpServer requires an `invoke` function");
  }
  if (opts.transport !== "stdio" && opts.transport !== "sse") {
    throw new McpServerError(
      `unsupported MCP transport ${JSON.stringify(opts.transport)} (expected "stdio" or "sse")`,
    );
  }
  if (
    resolveToolsMode(opts.tools) === "per-subagent" &&
    (opts.subAgents === undefined || opts.subAgents.length === 0)
  ) {
    throw new McpServerError('tools: "per-subagent" requires at least one sub-agent to project');
  }
}

/** Fold a spec name into an MCP-safe tool name (`[A-Za-z0-9_-]`). */
function sanitizeToolName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned : "subagent";
}

/** Make `base` unique against `used`, appending `_2`, `_3`, … on collision. */
function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  while (used.has(`${base}_${n}`)) n += 1;
  const candidate = `${base}_${n}`;
  used.add(candidate);
  return candidate;
}

interface ResolvedSubAgentTool {
  /** The (sanitized, de-duplicated) MCP tool name. */
  readonly toolName: string;
  /** The ORIGINAL spec sub-agent name, threaded back through `McpInvokeContext`. */
  readonly subAgent: string;
  readonly description: string;
}

/**
 * Map sub-agent descriptors to MCP tools, sanitizing names and de-duplicating
 * against each other AND the reserved `chat` tool. The original sub-agent name
 * is preserved on `subAgent` so `invoke` still routes by the real name even
 * when the tool name was rewritten.
 */
export function resolveSubAgentTools(
  subAgents: readonly McpSubAgentDescriptor[],
): readonly ResolvedSubAgentTool[] {
  const used = new Set<string>([CHAT_TOOL_NAME]);
  return subAgents.map((sa) => ({
    toolName: uniqueName(sanitizeToolName(sa.name), used),
    subAgent: sa.name,
    description: sa.description,
  }));
}

/** The tool names a projection will register, without building a server. */
export function computeToolNames(opts: CreateMcpServerOptions): readonly string[] {
  if (resolveToolsMode(opts.tools) === "chat") return [CHAT_TOOL_NAME];
  return [CHAT_TOOL_NAME, ...resolveSubAgentTools(opts.subAgents ?? []).map((t) => t.toolName)];
}

/** Run `invoke`, mapping success/failure onto a `CallToolResult` (never throws). */
async function runInvoke(
  invoke: McpInvoke,
  message: string,
  context: McpInvokeContext,
): Promise<CallToolResult> {
  try {
    const text = await invoke(message, context);
    return { content: [{ type: "text", text: typeof text === "string" ? text : String(text) }] };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `invoke failed: ${reason}` }] };
  }
}

/** Register the projected tools onto `server`; returns their names in order. */
export function registerAgentTools(
  server: McpServer,
  opts: CreateMcpServerOptions,
): readonly string[] {
  const agentName = opts.name ?? DEFAULT_NAME;
  const names: string[] = [];

  server.registerTool(
    CHAT_TOOL_NAME,
    {
      title: `Chat with ${agentName}`,
      description:
        opts.chatToolDescription ??
        `Send a message to the ${agentName} agent and receive its final response.`,
      inputSchema: { message: z.string().describe("The message to send to the agent.") },
    },
    ({ message }) => runInvoke(opts.invoke, message, { toolName: CHAT_TOOL_NAME }),
  );
  names.push(CHAT_TOOL_NAME);

  if (resolveToolsMode(opts.tools) === "per-subagent") {
    for (const tool of resolveSubAgentTools(opts.subAgents ?? [])) {
      server.registerTool(
        tool.toolName,
        {
          title: `Delegate to ${tool.subAgent}`,
          description: tool.description,
          inputSchema: {
            message: z.string().describe(`The message to route to the ${tool.subAgent} sub-agent.`),
          },
        },
        ({ message }) =>
          runInvoke(opts.invoke, message, { toolName: tool.toolName, subAgent: tool.subAgent }),
      );
      names.push(tool.toolName);
    }
  }

  return names;
}

/** Mint a fresh SDK server with the projected tools registered. */
export function buildConfiguredServer(opts: CreateMcpServerOptions): {
  readonly server: McpServer;
  readonly toolNames: readonly string[];
} {
  const server = new McpServer(
    { name: opts.name ?? DEFAULT_NAME, version: opts.version ?? DEFAULT_VERSION },
    opts.instructions === undefined ? undefined : { instructions: opts.instructions },
  );
  const toolNames = registerAgentTools(server, opts);
  return { server, toolNames };
}
