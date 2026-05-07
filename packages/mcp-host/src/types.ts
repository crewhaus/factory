/**
 * Public types for @crewhaus/mcp-host. All transports and clients reduce to
 * these shapes so callers (tool-mcp, target-cli emit, apps/cli) don't have to
 * touch the underlying @modelcontextprotocol/sdk types.
 */

export type StdioServerConfig = {
  readonly transport: "stdio";
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
};

export type SseServerConfig = {
  readonly transport: "sse";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
};

export type McpServerConfig = StdioServerConfig | SseServerConfig;

/**
 * State machine for a single McpClient. `idle` is pre-`connect()`; `closed`
 * is post-`disconnect()` (terminal — a closed client never reconnects).
 */
export type McpClientState =
  | { readonly kind: "idle" }
  | { readonly kind: "connecting"; readonly attempt: number }
  | { readonly kind: "connected" }
  | { readonly kind: "disconnected"; readonly cause?: unknown }
  | { readonly kind: "closed" };

/**
 * One tool advertised by the remote server. `inputSchema` is the raw JSON
 * Schema bytes (we never deref or rewrite it — see security.test.ts for the
 * opaque-passthrough invariant).
 */
export type McpToolDefinition = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
};

/**
 * Reduced result of a `tools/call`. The SDK returns an array of content
 * blocks (text, image, audio, resource); we collapse them to a single string
 * for the runtime tool-result contract. Non-text blocks become placeholders.
 */
export type McpCallResult = {
  readonly content: string;
  readonly isError: boolean;
};

export type McpCallOptions = {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
};
