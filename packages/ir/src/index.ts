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
 * attacker present a reorged log as real). See [docs/recipes/47-onchain-daemon-and-game.md](docs/recipes/47-onchain-daemon-and-game.md).
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
  | IrEvalV0;

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
