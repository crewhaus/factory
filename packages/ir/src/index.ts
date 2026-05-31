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
  /** Pillar 2 — when true, target emitters wire `compaction-curator`
   *  as a pre-pass before the autocompact threshold check. The spec
   *  layer accepts this verbatim (validated in `packages/spec`); the
   *  IR holds it as an opt-in flag with no default so emitters can
   *  distinguish "user said false" from "user didn't say". */
  readonly curate?: boolean;
  /** Cosine threshold for the curator's dedupe pass. Curator's own
   *  default (0.92, `DEFAULT_DEDUPE_THRESHOLD` in
   *  `@crewhaus/compaction-curator`) applies when undefined. */
  readonly dedupeThreshold?: number;
  /** Top-K cap for the curator's relevance reorder. Undefined means
   *  reorder without trimming. */
  readonly relevanceTopK?: number;
};

/**
 * Section 55 (Track A) — named failure taxonomy. Cross-cutting; carried
 * through to runtime-core so `recovery-engine` can consult the user's
 * named classes before falling back to its built-in taxonomy.
 *
 * `pattern` is a substring (case-insensitive) of the error.message OR a
 * `/regex/` literal — the recovery engine compiles each form once at
 * spec-load time. `recovery` names which `RecoveryAction` to take.
 * `hint`, when present, is what `runtime-core` appends as a synthetic
 * system message on `retry`/`continue` recoveries so the model gets
 * named-class self-correction guidance.
 *
 * Source: Natural-Language Agent Harnesses (arxiv 2603.25723).
 */
export type IrFailureTaxonomyEntry = {
  readonly class: string;
  readonly pattern: string;
  readonly recovery: "retry" | "compact" | "continue" | "tombstone" | "fail";
  readonly hint?: string;
};

export type IrFailureTaxonomy = readonly IrFailureTaxonomyEntry[];

/**
 * Pillar 3 (FR-004) — per-target security fabric configuration the
 * compiler lowers from the spec's `security` block. Today it carries the
 * intent-gate's judge selection; `egressPolicy` is reserved for the
 * sink-side fabric (FR-002/006) and intentionally not modelled here.
 *
 * `justification.judge` selects which `JustificationJudge` the runtime
 * wires for `requireJustification: true` tools — `"rule-based"` (the
 * deterministic default, `ruleBasedJustificationJudge`) or `"claude"`
 * (the model-backed `@crewhaus/justification-judge-claude`). `model` is
 * the judge model id when `judge: "claude"`; the consumer defaults it to
 * a haiku-class model when omitted. Optional + spread-in at lower-time so
 * the field is absent when the spec omits the block (same convention as
 * `failureTaxonomy`).
 */
export type IrSecurity = {
  readonly justification?: {
    readonly judge: "rule-based" | "claude";
    readonly model?: string;
  };
};

/**
 * Track F (Section 57) — typed message schemas (Σ) for multi-agent
 * communication. Source: AgentFlow (arxiv 2604.20801). A typed graph
 * DSL with well-formedness checking makes searching the full multi-
 * agent design space tractable: structurally broken candidates are
 * eliminated cheaply, so the search budget goes to well-formed
 * harnesses only.
 *
 * An IrMessageSchema is a named JSON-Schema shape describing what a
 * given edge in the crew/graph carries. The well-formedness pass in
 * `@crewhaus/ir-passes` checks that every edge in the graph references
 * either a declared schema or `untyped` (the legacy default).
 */
export type IrMessageSchema = {
  readonly name: string;
  /** JSON Schema describing the message payload. v0 keeps it as `unknown`
   *  rather than typed-importing zod-to-json-schema — the wellformedness
   *  pass only checks that the schema is an object; full validation
   *  happens at runtime in `@crewhaus/runtime-core`. */
  readonly schema: Readonly<Record<string, unknown>>;
};

/**
 * Per-edge schema reference. `untyped` means "any payload" (the v0
 * default that preserves backwards compatibility). Named references
 * must match one of the variant's `messageSchemas` entries.
 */
export type IrSchemaRef =
  | { readonly kind: "untyped" }
  | { readonly kind: "named"; readonly name: string };

/**
 * Phase 3 §3.3 — CLI banner config carried into IR for codegen.
 */
export type IrCliBanner = {
  readonly taglineMode: "static" | "random";
  readonly taglines: readonly string[];
};

export type IrCliOptions = {
  readonly banner?: IrCliBanner;
  /** Phase 2 M2.2 — TUI mode gate. */
  readonly tui?: "basic" | "rich";
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
  readonly cli?: IrCliOptions;
  /** Section 55 (Track A) — named failure taxonomy. Optional. */
  readonly failureTaxonomy?: IrFailureTaxonomy;
  /** Pillar 3 (FR-004) — security fabric config (intent-gate judge
   *  selection). Optional; absent when the spec omits the `security`
   *  block. */
  readonly security?: IrSecurity;
  /** §47 cross-cutting blockchain subsystem (slice 0). All optional. */
  readonly chains?: readonly IrChainBinding[];
  readonly wallets?: readonly IrWalletBinding[];
  readonly contracts?: readonly IrContractBinding[];
  readonly transactionPolicy?: IrTransactionPolicy;
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
  /** §47 cross-cutting blockchain subsystem (slice 0). All optional. */
  readonly chains?: readonly IrChainBinding[];
  readonly wallets?: readonly IrWalletBinding[];
  readonly contracts?: readonly IrContractBinding[];
  readonly transactionPolicy?: IrTransactionPolicy;
  readonly compaction: IrCompaction;
  /** Section 55 (Track A) — named failure taxonomy. Optional. */
  readonly failureTaxonomy?: IrFailureTaxonomy;
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

/**
 * Section 47 — Blockchain primitives (cross-cutting subsystem).
 *
 * These types are shared across shapes that interact with chain state.
 * Any shape may declare optional `chains` / `wallets` / `contracts` /
 * `transactionPolicy` blocks; the §47 `onchain` and `onchain-game`
 * target variants additionally require `triggers` and a `game` block
 * respectively (those types land with slice 2).
 *
 * Finality policy is encoded explicitly because reorg tolerance and
 * confirmation counts are quality knobs (Pillar 2: optimizable) and
 * security boundaries (Pillar 3: a wrong finality choice lets an
 * attacker present a reorged log as real). See [recipes/47-onchain-daemon-and-game.md](https://github.com/crewhaus/demos/blob/main/walkthroughs/47-onchain-daemon-and-game.md).
 */
export type IrChainFinality =
  | { readonly kind: "confirmations"; readonly count: number }
  | { readonly kind: "finalized" }
  | { readonly kind: "safe" };

/**
 * Resolved chain config. `kind: "evm"` is the only supported family in
 * slice 0/1/2 — Solana, Cosmos, and Bitcoin are deferred. `rpcUrls` is
 * an array of `IrSecretRef` so URLs that carry API keys (Alchemy,
 * Infura) can be loaded from env at runtime. `rpcPolicy` controls how
 * multiple URLs are used: `single` picks the first, `fallback` retries
 * the next on error, `quorum` requires N/M agreement on critical reads.
 */
export type IrChainBinding = {
  readonly id: string;
  readonly kind: "evm";
  readonly rpcUrls: readonly IrSecretRef[];
  readonly rpcPolicy: "single" | "quorum" | "fallback";
  readonly finality: IrChainFinality;
  readonly reorgTolerant: boolean;
};

/**
 * Wallet binding — how the runtime signs transactions for `chainId`.
 * `custody` declares where the key lives; `signingPolicy` declares how
 * each sign request is gated. The default for any `destructive: true`
 * tool that uses this wallet is `explicit-user-approval`; `policy-gated`
 * defers to the §47 `transaction_policy` block; `automated` is only
 * permitted when the wallet is also marked `kms` or `hsm` custody.
 * `keyRef` is required for `kms` / `hsm` / `local` custody; for
 * `user-controlled` (WalletConnect, MetaMask, etc.) the signing happens
 * externally and `keyRef` is omitted.
 */
export type IrWalletBinding = {
  readonly id: string;
  readonly chainId: string;
  readonly custody: "user-controlled" | "kms" | "hsm" | "local";
  readonly signingPolicy: "explicit-user-approval" | "policy-gated" | "automated";
  readonly keyRef?: IrSecretRef;
};

/**
 * Smart-contract binding. `abiRef` is a string the
 * `tool-contract-gateway` (slice 1) resolves into a typed-tool set;
 * supported schemes are `abi://erc20`, `abi://erc721`, `abi://erc1155`,
 * and `file://path/to/abi.json`. Reads against this contract become
 * `readOnly: true` tools; writes become `destructive: true` and gate
 * approval automatically via `permission-engine`.
 */
export type IrContractBinding = {
  readonly id: string;
  readonly chainId: string;
  readonly address: string;
  readonly abiRef: string;
};

/**
 * Transaction policy — the safety floor for any tool that signs and
 * broadcasts a transaction. `defaultWriteApproval: "required"` is the
 * default; setting it to `"none"` is only valid when every wallet is
 * `automated` custody, which the §47 IR pass enforces. `maxValueUsd`
 * is an upper bound on native-token transfers (in USD, evaluated at
 * sign-time via the configured price oracle); transactions exceeding
 * the cap are rejected pre-broadcast. `allowedContracts` is a list of
 * `IrContractBinding.id` values — destructive calls to any other
 * contract are rejected. `simulationRequired: true` forces every
 * destructive call through a fork-simulator before approval.
 */
export type IrTransactionPolicy = {
  readonly defaultWriteApproval: "required" | "policy" | "none";
  readonly maxValueUsd?: number;
  readonly allowedContracts: readonly string[];
  readonly simulationRequired: boolean;
};

export type IrSlackConfig = {
  readonly botToken: IrSecretRef;
  readonly signingSecret: IrSecretRef;
  readonly appToken?: IrSecretRef;
};

/**
 * Section 33 — Telegram channel config. `secretToken` is the value passed
 * to `setWebhook(secret_token=...)` and verified on every inbound POST
 * via the `X-Telegram-Bot-Api-Secret-Token` header.
 */
export type IrTelegramConfig = {
  readonly botToken: IrSecretRef;
  readonly secretToken: IrSecretRef;
};

/**
 * Section 33 — Discord channel config. `publicKeyHex` is the bot
 * application's public key (hex, 64 chars) used for Ed25519 verification
 * of inbound interaction webhooks.
 */
export type IrDiscordConfig = {
  readonly applicationId: IrSecretRef;
  readonly botToken: IrSecretRef;
  readonly publicKeyHex: IrSecretRef;
};

/**
 * Section 33 — WhatsApp Business Cloud API channel config.
 * `phoneNumberId` is the Meta-issued phone-number id (numeric,
 * stringified) the bot sends messages from. `accessToken` is the
 * system-user token authorising sends. `appSecret` is the Meta app
 * secret used to verify the `X-Hub-Signature-256` HMAC.
 */
export type IrWhatsAppConfig = {
  readonly phoneNumberId: IrSecretRef;
  readonly accessToken: IrSecretRef;
  readonly appSecret: IrSecretRef;
};

/**
 * Section 33 — iMessage channel config (macOS host-bound). `chatDbPath`
 * defaults to `~/Library/Messages/chat.db`; `cursorPath` defaults to
 * `.crewhaus/imessage-cursor.json`. Both can be overridden in spec for
 * tests. The adapter requires `CREWHAUS_IMESSAGE_HOST_ENABLED=1` at
 * boot, so no IR-level secret is needed.
 */
export type IrIMessageConfig = {
  readonly chatDbPath?: IrSecretRef;
  readonly cursorPath?: IrSecretRef;
};

export type IrChannels = {
  readonly slack?: IrSlackConfig;
  readonly telegram?: IrTelegramConfig;
  readonly discord?: IrDiscordConfig;
  readonly whatsapp?: IrWhatsAppConfig;
  readonly imessage?: IrIMessageConfig;
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
/**
 * Phase 3 §3.1 — heartbeat config carried into IR. `everyMs` is
 * normalized from the duration-string in the spec to milliseconds at
 * lower time so codegen can emit a literal numeric setInterval arg.
 */
export type IrHeartbeat = {
  readonly everyMs: number;
  readonly instructions: string;
};

/**
 * Phase 3 §3.4 — channel daemon control-UI gateway config.
 */
export type IrChannelGateway = {
  readonly port: number;
  readonly ui: boolean;
};

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
  readonly heartbeat?: IrHeartbeat;
  readonly gateway?: IrChannelGateway;
  /** Section 55 (Track A) — named failure taxonomy. Optional. */
  readonly failureTaxonomy?: IrFailureTaxonomy;
  /** §47 cross-cutting blockchain subsystem (slice 0). All optional. */
  readonly chains?: readonly IrChainBinding[];
  readonly wallets?: readonly IrWalletBinding[];
  readonly contracts?: readonly IrContractBinding[];
  readonly transactionPolicy?: IrTransactionPolicy;
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
  /** Section 55 (Track A) — named failure taxonomy. Optional. */
  readonly failureTaxonomy?: IrFailureTaxonomy;
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
  /** Track F (Section 57) — typed message schema carried by this edge.
   *  Defaults to `{ kind: "untyped" }` (any payload) when absent. The
   *  ir-passes wellformedness check verifies named refs resolve. */
  readonly schema?: IrSchemaRef;
};

export type IrGraphV0 = {
  readonly version: 0;
  readonly name: string;
  readonly target: "graph";
  readonly entry: string;
  readonly nodes: readonly IrGraphNode[];
  readonly edges: readonly IrGraphEdge[];
  /** Track F (Section 57) — named message schemas referenced by edges.
   *  Absent means no typed edges (all `untyped` by default). */
  readonly messageSchemas?: readonly IrMessageSchema[];
  readonly permissions: IrPermissions;
  readonly compaction: IrCompaction;
  /** Section 55 (Track A) — named failure taxonomy. Optional. */
  readonly failureTaxonomy?: IrFailureTaxonomy;
  /** §47 cross-cutting blockchain subsystem (slice 0). All optional. */
  readonly chains?: readonly IrChainBinding[];
  readonly wallets?: readonly IrWalletBinding[];
  readonly contracts?: readonly IrContractBinding[];
  readonly transactionPolicy?: IrTransactionPolicy;
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
  /** Section 55 (Track A) — named failure taxonomy. Optional. */
  readonly failureTaxonomy?: IrFailureTaxonomy;
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
  /** Track F (Section 57) — named message schemas referenced by handoffs.
   *  Absent means no typed handoffs (all `untyped` by default). */
  readonly messageSchemas?: readonly IrMessageSchema[];
  readonly mcp_servers: IrMcpServers;
  readonly permissions: IrPermissions;
  readonly compaction: IrCompaction;
  /** Section 55 (Track A) — named failure taxonomy. Optional. */
  readonly failureTaxonomy?: IrFailureTaxonomy;
  /** §47 cross-cutting blockchain subsystem (slice 0). All optional. */
  readonly chains?: readonly IrChainBinding[];
  readonly wallets?: readonly IrWalletBinding[];
  readonly contracts?: readonly IrContractBinding[];
  readonly transactionPolicy?: IrTransactionPolicy;
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
  /** Section 55 (Track A) — named failure taxonomy. Optional. */
  readonly failureTaxonomy?: IrFailureTaxonomy;
  /** §47 cross-cutting blockchain subsystem (slice 0). All optional. */
  readonly chains?: readonly IrChainBinding[];
  readonly wallets?: readonly IrWalletBinding[];
  readonly contracts?: readonly IrContractBinding[];
  readonly transactionPolicy?: IrTransactionPolicy;
};

/**
 * Section 23 BATCH — queue-worker IR. The compiled daemon pulls jobs
 * from the configured queue, runs the user's handler with `concurrency`
 * bounded parallelism, wraps each invocation in an idempotency-key
 * cache, and acks/nacks based on outcome. The handler runs the agent
 * (single-turn `runChatLoop`) with the job's input as the user message.
 */
export type IrBatchQueueAdapter = "in-memory" | "sqs" | "redis-streams" | "postgres";

export type IrBatchV0 = {
  readonly version: 0;
  readonly name: string;
  readonly target: "batch";
  readonly agent: {
    readonly model: string;
    readonly instructions: string;
  };
  readonly queue: {
    readonly adapter: IrBatchQueueAdapter;
    /** Per-domain rate-limit ms; >= 0. */
    readonly visibilityTimeoutMs: number;
    /** Stop renew sidecar past this; ack/nack by then. */
    readonly visibilityRenewIntervalMs?: number;
    /** Cap on attempts before DLQ. Default 3. */
    readonly maxRetries: number;
    /** When `adapter === "in-memory"`, optional seed jobs (mostly tests + smoke). */
    readonly seedJobs?: readonly string[];
  };
  readonly concurrency: number;
  readonly idempotencyWindowMs: number;
  readonly tools: readonly string[];
  readonly toolConfigs: IrToolConfigs;
  readonly mcp_servers: IrMcpServers;
  readonly permissions: IrPermissions;
  readonly compaction: IrCompaction;
  /** Section 55 (Track A) — named failure taxonomy. Optional. */
  readonly failureTaxonomy?: IrFailureTaxonomy;
  /** §47 cross-cutting blockchain subsystem (slice 0). All optional. */
  readonly chains?: readonly IrChainBinding[];
  readonly wallets?: readonly IrWalletBinding[];
  readonly contracts?: readonly IrContractBinding[];
  readonly transactionPolicy?: IrTransactionPolicy;
};

/**
 * Section 24 — VOICE (realtime audio agent) IR. The compiled daemon
 * opens a realtime adapter (OpenAI Realtime by default), hosts a
 * call-session state machine, and runs a barge-in controller over
 * inbound audio frames.
 */
export type IrVoiceProvider = "openai" | "vapi";
export type IrVoiceTelephony = "twilio" | "livekit-sip" | "in-memory";

export type IrVoiceV0 = {
  readonly version: 0;
  readonly name: string;
  readonly target: "voice";
  readonly agent: {
    readonly model: string;
    readonly instructions: string;
  };
  readonly voice: {
    readonly provider: IrVoiceProvider;
    /** Provider-specific voice id (OpenAI: alloy, echo, …). */
    readonly voiceId: string;
    /** Server VAD vs caller-driven. v0 defaults to "server". */
    readonly vad: "server" | "none";
    /** Barge-in trigger frame count (consecutive speech frames). */
    readonly bargeInTriggerFrames: number;
    /** Barge-in window ms — sliding window for the trigger count. */
    readonly bargeInWindowMs: number;
  };
  /** Optional telephony adapter wiring (Twilio, LiveKit, in-memory for the smoke). */
  readonly telephony?: {
    readonly provider: IrVoiceTelephony;
  };
  readonly tools: readonly string[];
  readonly toolConfigs: IrToolConfigs;
  readonly mcp_servers: IrMcpServers;
  readonly permissions: IrPermissions;
  readonly compaction: IrCompaction;
  /** Section 55 (Track A) — named failure taxonomy. Optional. */
  readonly failureTaxonomy?: IrFailureTaxonomy;
};

/**
 * Section 25 — BROW (computer-use / browser driver) IR. The compiled
 * daemon launches a chromium driver, registers Screenshot + Click /
 * Type / Key / Scroll + FindElement tools, optionally navigates to
 * `startUrl`, and runs `runChatLoop` against the user's prompt.
 */
export type IrBrowserBackend = "host" | "chromium" | "remote";

export type IrBrowserV0 = {
  readonly version: 0;
  readonly name: string;
  readonly target: "browser";
  readonly agent: {
    readonly model: string;
    readonly instructions: string;
  };
  readonly driver: {
    readonly backend: IrBrowserBackend;
    readonly viewport: {
      readonly width: number;
      readonly height: number;
    };
    /** Optional initial URL; daemon calls driver.goto() before runChatLoop. */
    readonly startUrl?: string;
  };
  /** Vision-grounding model. Defaults at lower-time to agent.model. */
  readonly groundingModel: string;
  readonly tools: readonly string[];
  readonly toolConfigs: IrToolConfigs;
  readonly mcp_servers: IrMcpServers;
  readonly permissions: IrPermissions;
  readonly compaction: IrCompaction;
  /** Section 55 (Track A) — named failure taxonomy. Optional. */
  readonly failureTaxonomy?: IrFailureTaxonomy;
};

/** Discriminated union over every supported target IR. */
/**
 * Section 29 — IR for the EVAL target shape. Lowered from the spec's
 * dataset/graders/concurrency/seed; codegen writes a single-file
 * `agent.ts` that boots dataset-registry + grader-registry + eval-runner.
 */
export type IrEvalV0 = {
  readonly version: 0;
  readonly name: string;
  readonly target: "eval";
  readonly agent: {
    readonly model: string;
    readonly instructions: string;
    readonly tools: readonly string[];
  };
  readonly dataset: {
    readonly name: string;
    readonly version: string;
    readonly split: "train" | "dev" | "test";
  };
  readonly graders: readonly {
    readonly name: string;
    readonly opts?: Readonly<Record<string, unknown>>;
  }[];
  readonly concurrency: number;
  readonly seed?: number;
  /** Section 55 (Track A) — named failure taxonomy. Optional. */
  readonly failureTaxonomy?: IrFailureTaxonomy;
};

/**
 * Section 47 — `onchain` daemon trigger. The compiled daemon listens
 * for one of three trigger kinds and runs one agent turn per inbound
 * event:
 *   - `event`: subscribe to a contract event (topic[0] = keccak of the
 *     event signature). The daemon decodes the event using the
 *     declared contract ABI and threads the decoded payload into the
 *     agent's user message.
 *   - `block`: scan new blocks at `scanIntervalMs` cadence, running
 *     the agent against block-level summaries. Used by treasury
 *     monitors and reorg detectors.
 *   - `address`: watch transfers/calls to or from a watched address.
 *     `direction` ("in" | "out" | "both") filters which side of the
 *     transfer fires the trigger.
 */
export type IrChainTrigger =
  | {
      readonly kind: "event";
      readonly chainId: string;
      readonly contract: string;
      readonly event: string;
      readonly filter?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "block";
      readonly chainId: string;
      readonly scanIntervalMs: number;
    }
  | {
      readonly kind: "address";
      readonly chainId: string;
      readonly address: string;
      readonly direction: "in" | "out" | "both";
    };

/**
 * Section 47 — IR for the `onchain` target shape. The compiled daemon
 * subscribes to the configured triggers, dedupes events by `(txHash,
 * logIndex)` within `idempotencyWindowMs`, and runs one
 * `runChatLoop({singleTurn: true})` per inbound trigger with the
 * decoded payload as the user message. The agent has access to the
 * standard tool catalog (including §47 `tool-evm` + `tool-evm-tx`) so
 * it can respond with transactions, alerts, or notifications.
 */
export type IrChainV0 = {
  readonly version: 0;
  readonly name: string;
  readonly target: "onchain";
  readonly agent: {
    readonly model: string;
    readonly instructions: string;
  };
  readonly chains: readonly IrChainBinding[];
  readonly wallets: readonly IrWalletBinding[];
  readonly contracts: readonly IrContractBinding[];
  readonly transactionPolicy: IrTransactionPolicy;
  readonly triggers: readonly IrChainTrigger[];
  /** Dedup window for `(txHash, logIndex)` (or block height for block triggers). */
  readonly idempotencyWindowMs: number;
  readonly tools: readonly string[];
  readonly toolConfigs: IrToolConfigs;
  readonly mcp_servers: IrMcpServers;
  readonly permissions: IrPermissions;
  readonly compaction: IrCompaction;
  /** Section 55 (Track A) — named failure taxonomy. Optional. */
  readonly failureTaxonomy?: IrFailureTaxonomy;
};

/**
 * Section 47 — IR for the `onchain-game` target. Models a perceive-act
 * loop against a game contract: the daemon reads game state via the
 * configured `stateReader` view function, runs the agent to propose a
 * move, broadcasts the move as a transaction, waits for confirmation,
 * and re-reads the new state. Closest analogues are `voice` (realtime
 * perceive-act loop with barge-in) and `browser` (perceive-act loop
 * with vision grounding). The chain-specific concerns are turn
 * semantics (sync/realtime/async) and move-confirmation finality.
 */
export type IrChainGameTurnSemantics = "turn-based" | "real-time" | "async";

export type IrChainGameV0 = {
  readonly version: 0;
  readonly name: string;
  readonly target: "onchain-game";
  readonly agent: {
    readonly model: string;
    readonly instructions: string;
  };
  /** Games are bound to one chain at a time; multi-chain games are rare. */
  readonly chain: IrChainBinding;
  /** Single player wallet. */
  readonly wallet: IrWalletBinding;
  readonly game: {
    /** Game contract binding. */
    readonly contract: IrContractBinding;
    /** ABI method name for reading the full game state (a view fn). */
    readonly stateReader: string;
    /** Optional separate actions contract; defaults to game.contract. */
    readonly actionsContract?: string;
    readonly turnSemantics: IrChainGameTurnSemantics;
    /** Hard cap on a move's wall-clock spend for real-time games. */
    readonly moveTimeoutMs?: number;
    /** Natural-language win condition the model uses to evaluate state. */
    readonly objective?: string;
  };
  readonly transactionPolicy: IrTransactionPolicy;
  readonly tools: readonly string[];
  readonly toolConfigs: IrToolConfigs;
  readonly mcp_servers: IrMcpServers;
  readonly permissions: IrPermissions;
  readonly compaction: IrCompaction;
  /** Section 55 (Track A) — named failure taxonomy. Optional. */
  readonly failureTaxonomy?: IrFailureTaxonomy;
};

export type IrNode =
  | IrV0
  | IrWorkflowV0
  | IrChannelV0
  | IrGraphV0
  | IrManagedV0
  | IrPipelineV0
  | IrCrewV0
  | IrResearchV0
  | IrBatchV0
  | IrVoiceV0
  | IrBrowserV0
  | IrEvalV0
  | IrChainV0
  | IrChainGameV0;

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
