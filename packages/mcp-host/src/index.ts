/**
 * @crewhaus/mcp-host — MCP client manager for factory.
 *
 * Catalog R5 (`mcp-host`). Wraps `@modelcontextprotocol/sdk` with:
 *   - stdio + SSE transports (constructed from `McpServerConfig`).
 *   - exp-backoff reconnect (1s → 30s cap, ±10% jitter, no max attempts).
 *   - lazy `addServer()` (sync) + explicit `connect()` (called by
 *     `@crewhaus/tool-mcp.registerMcpServer`).
 *   - reduced `callTool` result (text/image/audio/resource → string).
 *   - typed errors (`McpError` / `McpConnectionError` / `McpProtocolError`).
 *   - boot-time secret-ref resolution (`resolveSecretRef` /
 *     `resolveMcpServerConfig`) for compiler-lowered env/header refs, and a
 *     stdio child env that merges `getDefaultEnvironment()` under explicit
 *     keys so configured secrets survive the SDK's inherit allowlist.
 *
 * Limitation in v0: notifications/tools/list_changed is ignored — the
 * catalog is built once at boot. A future section can add a watcher.
 */

export { McpClient } from "./client.js";
export type { McpClientOptions, McpClientLikeTransport } from "./client.js";
export { McpHost } from "./host.js";
export type { McpHostOptions } from "./host.js";
export { nextBackoffMs } from "./backoff.js";
export { resolveSecretRef, resolveMcpServerConfig } from "./resolve.js";
export type {
  McpSecretRef,
  McpSecretLike,
  UnresolvedStdioServerConfig,
  UnresolvedSseServerConfig,
  UnresolvedMcpServerConfig,
  ResolveSecretRefOptions,
  ResolveMcpServerConfigOptions,
} from "./resolve.js";
export type {
  McpServerConfig,
  StdioServerConfig,
  SseServerConfig,
  McpClientState,
  McpToolDefinition,
  McpCallResult,
  McpCallOptions,
} from "./types.js";
export { ConfigError, McpError, McpConnectionError, McpProtocolError } from "@crewhaus/errors";
