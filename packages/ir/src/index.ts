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

/**
 * Section 14 — per-tool runtime config carried verbatim from the spec to
 * codegen. Keys are tool names (lowercase variable name as used in
 * `BUILTIN_TOOL_MAP`); values are tool-specific config blobs whose schemas
 * live inside each tool package. Empty-default at lower-time so codegen
 * never has to `?? {}`.
 */
export type IrToolConfigs = Readonly<Record<string, unknown>>;

/**
 * Section 17 — optional per-target compaction config. `model` overrides
 * the model used by `compaction-autocompact` for summarisation; when
 * undefined (or the whole block is undefined) the runtime defaults to
 * the agent's primary model. Lower-time the spec block is normalised to
 * an object so codegen never has to `?? {}`.
 */
export type IrCompaction = {
  readonly model?: string;
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
  readonly toolConfigs: IrToolConfigs;
  readonly mcp_servers: IrMcpServers;
  readonly permissions: IrPermissions;
  readonly subAgents: readonly IrSubAgentDefinition[];
  readonly compaction: IrCompaction;
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
  readonly toolConfigs: IrToolConfigs;
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
  readonly compaction: IrCompaction;
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
  readonly toolConfigs: IrToolConfigs;
  readonly channels: IrChannels;
  readonly routing: IrRouting;
  readonly mcp_servers: IrMcpServers;
  readonly permissions: IrPermissions;
  readonly subAgents: readonly IrSubAgentDefinition[];
  readonly compaction: IrCompaction;
};

/**
 * Section 20 — Managed daemon IR. Carries the agent block, the
 * tenant table, and any per-tenant policy / budget overrides. The
 * `target-managed` codegen consumes this to emit `daemon.ts` +
 * `agent.ts` files.
 */
export type IrManagedTenant = {
  readonly id: string;
  readonly budget: {
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
  };
};

export type IrManagedV0 = {
  readonly version: 0;
  readonly name: string;
  readonly target: "managed";
  readonly agent: {
    readonly model: string;
    readonly instructions: string;
  };
  readonly tenants: readonly IrManagedTenant[];
  readonly permissions: IrPermissions;
  readonly compaction: IrCompaction;
};

/**
 * Section 19 — Graph IR. A `target: "graph"` spec lowers into a fixed
 * set of LLM-backed nodes plus the edges that connect them.
 */
export type IrGraphNode = {
  readonly name: string;
  readonly instructions: string;
  /** Resolved at lower-time (node.model ?? graph.model). */
  readonly model: string;
  readonly tools: readonly string[];
  readonly toolConfigs: IrToolConfigs;
  /**
   * When set, the node calls `ctx.requestApproval(prompt)` after the
   * LLM turn and pauses the graph until `resume(checkpointId, decision)`.
   */
  readonly hitlPrompt?: string;
};

export type IrGraphEdge = {
  readonly from: string;
  readonly to: string;
};

export type IrGraphV0 = {
  readonly version: 0;
  readonly name: string;
  readonly target: "graph";
  readonly entry: string;
  readonly nodes: readonly IrGraphNode[];
  readonly edges: readonly IrGraphEdge[];
  readonly permissions: IrPermissions;
  readonly compaction: IrCompaction;
};

/**
 * Section 21 — Pipeline / RAG IR. Carries the embedder + vector-store
 * config + an indexing pipeline (chunker → embed → store) + the agent
 * block that uses the Retrieve tool.
 */
export type IrPipelineDocument = {
  readonly id: string;
  readonly text: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export type IrPipelineV0 = {
  readonly version: 0;
  readonly name: string;
  readonly target: "pipeline";
  readonly agent: {
    readonly model: string;
    readonly instructions: string;
  };
  readonly retrieve: {
    readonly embedderModel: string;
    readonly vectorBackend: "in-memory";
    readonly defaultK: number;
  };
  readonly indexing: {
    readonly chunkStrategy: "fixed" | "semantic" | "markdown";
    readonly chunkSize: number;
    readonly chunkOverlap: number;
    readonly documents: readonly IrPipelineDocument[];
  };
  readonly permissions: IrPermissions;
  readonly compaction: IrCompaction;
};

/**
 * Section 22 — CRW (multi-agent crew) IR. One role definition per entry;
 * `entry` names the role that runs first; optional `routing` block carries
 * either a `match` map (predicate-driven) or `llm` directive (use a model
 * to pick the next role) — both lower-time placeholders today, with the
 * built-in default-router behaviour preserved when both are absent.
 */
export type IrCrewRole = {
  readonly name: string;
  /** Resolved at lower-time (`role.model ?? crew.model`). */
  readonly model: string;
  readonly instructions: string;
  readonly tools: readonly string[];
  readonly toolConfigs: IrToolConfigs;
  readonly subAgents: readonly IrSubAgentDefinition[];
};

export type IrCrewRoutingKind = "match" | "llm";

export type IrCrewRouting = {
  readonly kind: IrCrewRoutingKind;
  /**
   * Per-role match table. Only set when `kind === "match"`. Keys are
   * source role names; values are simple substring matchers tested
   * against the source role's terminal output to pick the next role.
   */
  readonly match?: Readonly<
    Record<string, ReadonlyArray<{ readonly contains: string; readonly to: string }>>
  >;
};

export type IrCrewV0 = {
  readonly version: 0;
  readonly name: string;
  readonly target: "crew";
  readonly entry: string;
  readonly roles: readonly IrCrewRole[];
  readonly routing?: IrCrewRouting;
  readonly mcp_servers: IrMcpServers;
  readonly permissions: IrPermissions;
  readonly compaction: IrCompaction;
};

/**
 * Section 23 — RES (autonomous research) IR. The compiled daemon
 * decomposes `goal` into `branchingFactor` sub-questions, runs each
 * branch as a single-turn agent loop, and writes a numbered-citation
 * report. The agent in each branch has the standard tool catalog plus
 * the auto-injected `Source(uri)` and `CiteFact(uri, snippet, ...)`
 * tools from `@crewhaus/crawler` + `@crewhaus/citation-tracker`.
 */
export type IrResearchV0 = {
  readonly version: 0;
  readonly name: string;
  readonly target: "research";
  readonly agent: {
    readonly model: string;
    readonly instructions: string;
  };
  /** Default research goal. The daemon's `--goal "..."` flag overrides. */
  readonly goal: string;
  /** How many sub-questions the planner decomposes into per run. */
  readonly branchingFactor: number;
  /** Soft per-run wall-clock cap. The daemon emits `[budget exceeded]` and writes a partial report. */
  readonly maxDurationMs: number;
  readonly retrieve: {
    /** http(s) origins the crawler may fetch. Empty array denies all https. */
    readonly allowedOrigins: readonly string[];
    /** Absolute file:// roots the crawler may read from. Empty denies all file://. */
    readonly allowedFileRoots: readonly string[];
    /** Optional vector backend hint for future RAG-augmented research. */
    readonly vectorBackend?: "in-memory";
  };
  readonly tools: readonly string[];
  readonly toolConfigs: IrToolConfigs;
  readonly mcp_servers: IrMcpServers;
  readonly permissions: IrPermissions;
  readonly compaction: IrCompaction;
};

/** Discriminated union over every supported target IR. */
export type IrNode =
  | IrV0
  | IrWorkflowV0
  | IrChannelV0
  | IrGraphV0
  | IrManagedV0
  | IrPipelineV0
  | IrCrewV0
  | IrResearchV0;

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
