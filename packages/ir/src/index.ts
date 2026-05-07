/**
 * v0 IR — runtime-agnostic representation, target-tagged.
 * In the slice, IR shape mirrors the spec; later passes (ir-passes module)
 * will perform optimization and target-specific lowering.
 */
export type IrPermissionRule = {
  readonly type: "alwaysAllow" | "alwaysDeny" | "alwaysAsk";
  readonly pattern: string;
};

/**
 * Permissions config carried through to codegen. The mode here cannot be
 * "bypass" — that's enforced by the spec parser. Bypass enters via CLI flag.
 */
export type IrPermissions = {
  readonly mode?: "default" | "plan" | "auto";
  readonly rules: readonly IrPermissionRule[];
};

/**
 * MCP server configs carried through to codegen (Section 9). Lower-time
 * normalisation: optional spec fields become required IR fields with
 * empty defaults, so target codegen doesn't need `?? []` guards.
 */
export type IrMcpStdioConfig = {
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
};

export type IrMcpSseConfig = {
  readonly transport: "sse";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
};

export type IrMcpServerConfig = IrMcpStdioConfig | IrMcpSseConfig;
export type IrMcpServers = Readonly<Record<string, IrMcpServerConfig>>;

/**
 * Section 13 — a sub-agent definition lowered from spec form. The map's key
 * is hoisted to a `name` field for ergonomics. `tools: readonly string[]`
 * mirrors `IrV0.tools`; codegen filters the parent catalog to this
 * allowlist when building the child catalog. `permissions` defaults to
 * `"inherit"` at lower-time when undefined; `inheritBypass` to false.
 */
export type IrSubAgentDefinition = {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly tools: readonly string[];
  readonly model?: string;
  readonly permissions:
    | "inherit"
    | "scoped"
    | { readonly allow: readonly string[]; readonly deny: readonly string[] };
  readonly inheritBypass: boolean;
};

export type IrV0 = {
  readonly version: 0;
  readonly name: string;
  readonly target: "cli";
  readonly agent: {
    readonly model: string;
    readonly instructions: string;
  };
  readonly tools: readonly string[];
  readonly mcp_servers: IrMcpServers;
  readonly permissions: IrPermissions;
  readonly subAgents: readonly IrSubAgentDefinition[];
};

/**
 * One step in a workflow IR. `model` is resolved at lower-time
 * (`step.model ?? workflow.model`) so codegen can read it directly.
 */
export type IrWorkflowStep = {
  readonly name: string;
  readonly instructions: string;
  readonly model: string;
  readonly tools: readonly string[];
};

/**
 * Workflow IR — a sequence of steps. Each step runs as one user→assistant
 * turn; the prior step's terminal assistant text is threaded into the next
 * step's user message by the generated runtime (target-workflow).
 */
export type IrWorkflowV0 = {
  readonly version: 0;
  readonly name: string;
  readonly target: "workflow";
  readonly steps: readonly IrWorkflowStep[];
  readonly mcp_servers: IrMcpServers;
  readonly permissions: IrPermissions;
};

/**
 * A secret value referenced by a channel config (Section 12). Lower-time
 * normalisation: spec strings starting with `$VAR_NAME` (where VAR_NAME
 * matches `[A-Z_][A-Z0-9_]*`) become `{ kind: "env", name }`, anything else
 * becomes `{ kind: "literal", value }`. Codegen emits literals as quoted
 * strings and env-refs as `process.env.VAR_NAME`, plus a startup check
 * that exits non-zero when a referenced env var is unset.
 */
export type IrSecretRef =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "env"; readonly name: string };

export type IrSlackConfig = {
  readonly botToken: IrSecretRef;
  readonly signingSecret: IrSecretRef;
  readonly appToken?: IrSecretRef;
};

export type IrChannels = {
  readonly slack?: IrSlackConfig;
};

export type IrRouting = {
  readonly sessionKey: "thread" | "user" | "channel";
};

/**
 * Channel IR — a long-running daemon that listens for inbound webhook events
 * and runs one agent turn per inbound message. The daemon resumes per-thread
 * sessions (keyed by `routing.sessionKey`) via session-store + event-log,
 * appends the new message, and runs one `runChatLoop` turn.
 */
export type IrChannelV0 = {
  readonly version: 0;
  readonly name: string;
  readonly target: "channel";
  readonly agent: {
    readonly model: string;
    readonly instructions: string;
  };
  readonly tools: readonly string[];
  readonly channels: IrChannels;
  readonly routing: IrRouting;
  readonly mcp_servers: IrMcpServers;
  readonly permissions: IrPermissions;
  readonly subAgents: readonly IrSubAgentDefinition[];
};

/** Discriminated union over every supported target IR. */
export type IrNode = IrV0 | IrWorkflowV0 | IrChannelV0;

/**
 * The output of compilation: a set of files to be written to disk by the
 * bundle-packager (slice: written directly by the CLI app).
 */
export type Bundle = {
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }>;
};
