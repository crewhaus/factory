import { classifyBoundary } from "@crewhaus/boundary-classifier";
import { McpError } from "@crewhaus/errors";
import type { McpHost, McpToolDefinition } from "@crewhaus/mcp-host";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { z } from "zod";

/**
 * Wrap an MCP server's remote tools as `RegisteredTool` entries on the
 * shared catalog. Catalog R4 (`tool-mcp`).
 *
 * Naming: each remote tool is registered as `<serverName>__<toolName>` so
 * tools from different servers can never collide. Server names are user-
 * controlled YAML keys (already deduped at the spec layer); remote tool
 * names are server-controlled and validated here.
 *
 * Schema: MCP tools' authoritative schema is JSON Schema. We keep that
 * verbatim on `RegisteredTool.jsonSchema` (forwarded to the model by
 * `runtime-core`) and use `z.unknown()` as the local validator slot, so
 * the validator path passes everything through and the MCP server itself
 * is the source of truth for argument validation.
 */

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export type McpToolFlags = {
  readonly concurrencySafe?: boolean;
  readonly readOnly?: boolean;
  readonly destructive?: boolean;
};

export type RegisterMcpServerOptions = {
  /** Default flags applied to every tool from this server. */
  readonly defaults?: McpToolFlags;
  /**
   * Per-tool flag overrides keyed by remote tool name (NOT the namespaced
   * `<server>__<tool>` form). Wins over `defaults`.
   */
  readonly perTool?: Readonly<Record<string, McpToolFlags>>;
  /** Logger callback fired once per registered tool. Useful for boot banners. */
  readonly onRegister?: (info: { fullName: string; remoteName: string }) => void;
};

export function namespacedToolName(serverName: string, toolName: string): string {
  return `${serverName}__${toolName}`;
}

/**
 * Build a single `RegisteredTool` from one remote MCP tool. Exposed so
 * tests (and any future custom-naming caller) can reuse the wiring without
 * going through `registerMcpServer`.
 */
export function buildMcpRegisteredTool(
  host: McpHost,
  serverName: string,
  remote: McpToolDefinition,
  flags: { concurrencySafe: boolean; readOnly: boolean; destructive: boolean },
): RegisteredTool {
  if (typeof remote.name !== "string" || remote.name.length === 0) {
    throw new McpError(`mcp server "${serverName}" returned a tool with an empty/missing name`);
  }
  if (!TOOL_NAME_PATTERN.test(remote.name)) {
    throw new McpError(
      `mcp server "${serverName}" returned a tool with an invalid name "${remote.name}" (must match ${TOOL_NAME_PATTERN.source})`,
    );
  }
  const fullName = namespacedToolName(serverName, remote.name);
  const description = sanitizeDescription(remote.description) ?? `MCP tool ${fullName}`;
  return buildTool({
    name: fullName,
    description,
    // The MCP server validates arguments on its end. Local validator is
    // permissive so non-Zod-representable JSON Schema features round-trip.
    inputSchema: z.unknown(),
    jsonSchema: remote.inputSchema,
    concurrencySafe: flags.concurrencySafe,
    readOnly: flags.readOnly,
    destructive: flags.destructive,
    // Pillar 3 sink-side: every MCP call is an external sink. The MCP
    // protocol gives us no visibility into what the remote server actually
    // does with its arguments — egress-classifier defaults to "external"
    // scope and treats dynamically-registered servers as
    // "external-dynamic" (strict policy) while spec-configured servers are
    // "external-configured".
    scope: "external",
    // FR-002 — declare the io-capability fact: every MCP call leaves the
    // process for a remote server over the network.
    ioCapability: "network",
    execute: async (input, ctx) => {
      const client = host.getClient(serverName);
      const args = (input ?? {}) as Record<string, unknown>;
      const result = await client.callTool(remote.name, args, {
        ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
      });
      if (result.isError) {
        throw new McpError(result.content || `mcp tool "${fullName}" returned an error result`);
      }
      // Pillar 3 boundary site — classify the FULL MCP response (not just
      // the truncated preview the §18 post-tool classifier sees later).
      // A polymorphic jailbreak hidden mid-payload would otherwise bypass
      // the runtime-core classifier when storeAndPreview truncates the
      // bytes that contained it. The boundary-classifier's content-hash
      // cache means a repeated MCP call to a healthy server doesn't burn
      // re-classification budget.
      const boundary = await classifyBoundary(result.content, { origin: "mcp" });
      if (boundary.action === "redact" && boundary.redacted !== undefined) {
        return boundary.redacted;
      }
      return result.content;
    },
  });
}

/**
 * Connect to a registered server and register every remote tool on the
 * catalog. The host must already have the server added; this function
 * triggers `client.connect()` (idempotent) before listing tools.
 */
export async function registerMcpServer(
  host: McpHost,
  serverName: string,
  catalog: ToolCatalog,
  opts: RegisterMcpServerOptions = {},
): Promise<void> {
  const client = host.getClient(serverName);
  await client.connect();
  const remoteTools = await client.listTools();
  const defaults: { concurrencySafe: boolean; readOnly: boolean; destructive: boolean } = {
    concurrencySafe: opts.defaults?.concurrencySafe ?? false,
    readOnly: opts.defaults?.readOnly ?? false,
    destructive: opts.defaults?.destructive ?? false,
  };
  for (const remote of remoteTools) {
    const override = opts.perTool?.[remote.name] ?? {};
    const flags = {
      concurrencySafe: override.concurrencySafe ?? defaults.concurrencySafe,
      readOnly: override.readOnly ?? defaults.readOnly,
      destructive: override.destructive ?? defaults.destructive,
    };
    const tool = buildMcpRegisteredTool(host, serverName, remote, flags);
    catalog.register(tool);
    opts.onRegister?.({ fullName: tool.name, remoteName: remote.name });
  }
}

/**
 * Strip C0 control chars and trim whitespace. Anthropic's API tolerates
 * Unicode in descriptions but stripping control chars protects against
 * pathological server output.
 */
function sanitizeDescription(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: explicit C0/DEL strip
  const stripped = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
  return stripped.length > 0 ? stripped : undefined;
}
