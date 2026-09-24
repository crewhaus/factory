/**
 * Public types for @crewhaus/mcp-host. All transports and clients reduce to
 * these shapes so callers (tool-mcp, target-cli emit, apps/cli) don't have to
 * touch the underlying @modelcontextprotocol/sdk types.
 */

/**
 * Trust flags a spec sets on a server's tools (`mcp_servers.<n>.tool_flags`).
 * They can only TIGHTEN: each is the literal `true`, and there is no
 * `readOnly`, because read-only is a grant (plan and auto mode run a
 * read-only tool without asking), not a restriction.
 */
export type McpToolTrustFlags = {
  readonly destructive?: true;
  readonly requireJustification?: true;
};

/** `defaults` for every tool on the server; `perTool` by remote tool name. */
export type McpToolFlagsConfig = {
  readonly defaults?: McpToolTrustFlags;
  readonly perTool?: Readonly<Record<string, McpToolTrustFlags>>;
};

export type StdioServerConfig = {
  readonly transport: "stdio";
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  /** See {@link McpToolFlagsConfig}. Read by `@crewhaus/tool-mcp` when it registers the tools. */
  readonly toolFlags?: McpToolFlagsConfig;
};

export type SseServerConfig = {
  readonly transport: "sse";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** See {@link McpToolFlagsConfig}. */
  readonly toolFlags?: McpToolFlagsConfig;
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
  /**
   * The server's own trust hints (MCP `ToolAnnotations`), kept only when they
   * are booleans. They are claims by the server, not facts: `@crewhaus/tool-mcp`
   * lets `destructiveHint: true` and `readOnlyHint: false` tighten a tool and
   * ignores the loosening directions.
   */
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
  };
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
