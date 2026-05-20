import { SpecParseError } from "@crewhaus/errors";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * v0 spec schema — a discriminated union over `target`.
 *
 * - `cli`: a single streaming-chat agent (Section 1–5).
 * - `workflow`: a sequence of named steps run in order, threading the prior
 *   step's final assistant text into the next step's user message (Section 6).
 * - `channel`: a long-running daemon that listens for inbound channel events
 *   (Slack today, more channels later) and runs one agent turn per inbound
 *   message, threaded by the routing key. Section 12.
 *
 * Will grow into the full catalog spec (eval, deploy) — see
 * docs/MODULE-CATALOG.md PART A Layer F1.
 */

// Permissions block (Section 7). SECURITY: `mode: "bypass"` is intentionally
// absent from the enum — bypass can only enter the system via the CLI flag.
// Defense in depth: parse-time and runtime checks both reject it.
const permissionRuleSchema = z
  .object({
    type: z.enum(["alwaysAllow", "alwaysDeny", "alwaysAsk"]),
    pattern: z.string().min(1),
  })
  .strict();

const permissionsBlock = z
  .object({
    mode: z.enum(["default", "plan", "auto"]).optional(),
    rules: z.array(permissionRuleSchema).optional(),
  })
  .strict()
  .optional();

// MCP servers block (Section 9). Discriminated on `transport` so unknown
// configs surface as a clear "Invalid literal value" error rather than a
// confusing union-of-rejections.
const stdioMcpConfig = z
  .object({
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
  })
  .strict();

const sseMcpConfig = z
  .object({
    transport: z.literal("sse"),
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
  })
  .strict();

const mcpServerConfigSchema = z.discriminatedUnion("transport", [stdioMcpConfig, sseMcpConfig]);

const mcpServersBlock = z.record(z.string().min(1), mcpServerConfigSchema).optional();

// Section 13 — sub-agent definitions. Inline on the agent block (cli +
// channel today; workflow has no agent block). The map's key is the
// `subagent_type` users pass to the Task tool. Permissions field mirrors
// the runtime's resolution shape.
const subAgentDefinitionSchema = z
  .object({
    description: z.string().min(1),
    instructions: z.string().min(1),
    tools: z.array(z.string().min(1)).optional(),
    model: z.string().min(1).optional(),
    permissions: z
      .union([
        z.enum(["inherit", "scoped"]),
        z
          .object({
            allow: z.array(z.string().min(1)),
            deny: z.array(z.string().min(1)),
          })
          .strict(),
      ])
      .optional(),
    inherit_bypass: z.boolean().optional(),
  })
  .strict();

const subAgentsBlock = z.record(z.string().min(1), subAgentDefinitionSchema).optional();

/**
 * Section 14 — per-tool runtime config map. Tool-specific schemas live
 * inside each tool package; the spec layer treats every value as opaque
 * `unknown` and forwards it verbatim to the IR. The codegen layer emits
 * an init call (e.g. `registerFetchConfig({ ... })`) for tools whose
 * BUILTIN_TOOL_MAP entry declares an `initSymbol`.
 */
const toolConfigBlock = z.record(z.string().min(1), z.unknown()).optional();

/**
 * Section 17 — optional override for the model used by
 * `compaction-autocompact` when summarising long conversations. Defaults
 * to the agent's primary model when omitted, but you can target a
 * cheaper/faster model (or a different provider) for compaction.
 */
const compactionBlock = z
  .object({
    model: z.string().min(1).optional(),
  })
  .strict()
  .optional();

/**
 * Section 47 — blockchain subsystem blocks (cross-cutting). Any shape may
 * declare any subset of `chains` / `wallets` / `contracts` /
 * `transaction_policy`. Authoring rules:
 *   - `chains[]`: at least one when other blocks are present.
 *   - `wallets[]`: every entry references a declared `chains[].id`.
 *   - `contracts[]`: every entry references a declared `chains[].id`.
 *   - `transaction_policy`: enforced by §47 IR pass at compile time;
 *     entries in `allowed_contracts` must reference declared `contracts[].id`.
 * Per-field semantics mirror the IR variants in `@crewhaus/ir`.
 */
const chainFinalitySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("confirmations"),
      count: z.number().int().min(0).max(256),
    })
    .strict(),
  z.object({ kind: z.literal("finalized") }).strict(),
  z.object({ kind: z.literal("safe") }).strict(),
]);

const chainBindingSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("evm"),
    rpcUrls: z.array(z.string().min(1)).min(1),
    rpcPolicy: z.enum(["single", "quorum", "fallback"]).default("single"),
    finality: chainFinalitySchema,
    reorgTolerant: z.boolean().default(true),
  })
  .strict();

const walletBindingSchema = z
  .object({
    id: z.string().min(1),
    chainId: z.string().min(1),
    custody: z.enum(["user-controlled", "kms", "hsm", "local"]),
    signingPolicy: z
      .enum(["explicit-user-approval", "policy-gated", "automated"])
      .default("explicit-user-approval"),
    keyRef: z.string().min(1).optional(),
  })
  .strict();

const contractBindingSchema = z
  .object({
    id: z.string().min(1),
    chainId: z.string().min(1),
    address: z.string().min(1),
    abiRef: z.string().min(1),
  })
  .strict();

const transactionPolicySchema = z
  .object({
    defaultWriteApproval: z.enum(["required", "policy", "none"]).default("required"),
    maxValueUsd: z.number().positive().optional(),
    allowedContracts: z.array(z.string().min(1)).default([]),
    simulationRequired: z.boolean().default(true),
  })
  .strict();

const chainsBlock = z.array(chainBindingSchema).optional();
const walletsBlock = z.array(walletBindingSchema).optional();
const contractsBlock = z.array(contractBindingSchema).optional();
const transactionPolicyBlock = transactionPolicySchema.optional();

/**
 * Phase 3 §3.3 — CLI banner with optional tagline rotation. When set,
 * the compiled cli-target bundle prints this banner on cold start
 * (suppressed under `--resume` / `--continue` so resumed sessions
 * don't re-banner). Static mode picks the first tagline; random mode
 * picks one uniformly per startup.
 */
const cliBannerBlock = z
  .object({
    taglineMode: z.enum(["static", "random"]).default("static"),
    taglines: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .optional();

const cliOptionsBlock = z
  .object({
    banner: cliBannerBlock,
    /**
     * Phase 2 M2.2 — TUI polish gate. "basic" is the current readline-
     * driven REPL; "rich" is reserved for future Ink-based output
     * (status line, multi-line input, ESC interrupt). Today both modes
     * compile identically; the field is forward-compatible.
     */
    tui: z.enum(["basic", "rich"]).default("basic"),
  })
  .strict()
  .optional();

/**
 * Phase 3 §3.1 — heartbeat scheduled wake for channel daemons. When
 * present, target-channel-bot emits a setInterval loop that
 * synthesises a heartbeat turn at the configured interval. The
 * `every` field accepts a duration string (e.g. "2h", "30m", "60s").
 * `instructions` is what the runtime sends as the synthetic user
 * message at each tick; pair with HEARTBEAT.md in cwd for richer
 * playbook reads.
 */
const HEARTBEAT_DURATION_REGEX = /^\d+(?:ms|s|m|h)$/;

const heartbeatBlock = z
  .object({
    every: z
      .string()
      .regex(
        HEARTBEAT_DURATION_REGEX,
        'heartbeat.every must be a duration like "2h", "30m", "60s", or "500ms"',
      ),
    instructions: z.string().min(1),
  })
  .strict()
  .optional();

/**
 * Phase 3 §3.4 — channel daemon control-UI gateway. When set, the
 * compiled daemon spawns a second HTTP listener on `port` that serves
 * a status endpoint (and, when `ui: true`, a minimal dashboard).
 * Mirrors OpenClaw's Gateway control plane in concept; ours starts
 * minimal and is intended to host packaged Studio UI in a follow-up.
 */
const channelGatewayBlock = z
  .object({
    port: z.number().int().min(1).max(65535),
    ui: z.boolean().default(false),
  })
  .strict()
  .optional();

const cliSchema = z
  .object({
    name: z.string().min(1),
    target: z.literal("cli"),
    agent: z
      .object({
        model: z.string().min(1),
        instructions: z.string().min(1),
        sub_agents: subAgentsBlock,
      })
      .strict(),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    mcp_servers: mcpServersBlock,
    permissions: permissionsBlock,
    compaction: compactionBlock,
    cli: cliOptionsBlock,
    chains: chainsBlock,
    wallets: walletsBlock,
    contracts: contractsBlock,
    transaction_policy: transactionPolicyBlock,
  })
  .strict();

const workflowStepSchema = z
  .object({
    name: z.string().min(1),
    instructions: z.string().min(1),
    model: z.string().min(1).optional(),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
  })
  .strict();

const workflowSchema = z
  .object({
    name: z.string().min(1),
    target: z.literal("workflow"),
    model: z.string().min(1),
    steps: z.array(workflowStepSchema).min(1),
    mcp_servers: mcpServersBlock,
    permissions: permissionsBlock,
    compaction: compactionBlock,
    chains: chainsBlock,
    wallets: walletsBlock,
    contracts: contractsBlock,
    transaction_policy: transactionPolicyBlock,
  })
  .strict();

// Channel target (Section 12). Secret fields (botToken/signingSecret/appToken)
// are kept as plain strings here; the compiler's `lower()` rewrites strings
// matching `$VAR_NAME` into env-var references in the IR so the compiled
// bundle reads `process.env.VAR_NAME` at runtime instead of embedding secrets.
const slackChannelSchema = z
  .object({
    botToken: z.string().min(1),
    signingSecret: z.string().min(1),
    appToken: z.string().min(1).optional(),
  })
  .strict();

const telegramChannelSchema = z
  .object({
    botToken: z.string().min(1),
    secretToken: z.string().min(1),
  })
  .strict();

const discordChannelSchema = z
  .object({
    applicationId: z.string().min(1),
    botToken: z.string().min(1),
    publicKeyHex: z.string().min(1),
  })
  .strict();

const whatsappChannelSchema = z
  .object({
    phoneNumberId: z.string().min(1),
    accessToken: z.string().min(1),
    appSecret: z.string().min(1),
  })
  .strict();

const imessageChannelSchema = z
  .object({
    chatDbPath: z.string().min(1).optional(),
    cursorPath: z.string().min(1).optional(),
  })
  .strict();

const channelsBlock = z
  .object({
    slack: slackChannelSchema.optional(),
    telegram: telegramChannelSchema.optional(),
    discord: discordChannelSchema.optional(),
    whatsapp: whatsappChannelSchema.optional(),
    imessage: imessageChannelSchema.optional(),
  })
  .strict()
  .refine(
    (c) =>
      c.slack !== undefined ||
      c.telegram !== undefined ||
      c.discord !== undefined ||
      c.whatsapp !== undefined ||
      c.imessage !== undefined,
    {
      message:
        "channels block requires at least one channel (slack | telegram | discord | whatsapp | imessage)",
    },
  );

const routingBlock = z
  .object({
    sessionKey: z.enum(["thread", "user", "channel"]),
  })
  .strict();

const channelAgentSchema = z
  .object({
    model: z.string().min(1),
    instructions: z.string().min(1),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    sub_agents: subAgentsBlock,
  })
  .strict();

const channelSchema = z
  .object({
    name: z.string().min(1),
    target: z.literal("channel"),
    agent: channelAgentSchema,
    channels: channelsBlock,
    routing: routingBlock,
    mcp_servers: mcpServersBlock,
    permissions: permissionsBlock,
    compaction: compactionBlock,
    heartbeat: heartbeatBlock,
    gateway: channelGatewayBlock,
    chains: chainsBlock,
    wallets: walletsBlock,
    contracts: contractsBlock,
    transaction_policy: transactionPolicyBlock,
  })
  .strict();

// Graph target (Section 19) — stateful DAG runtime. Nodes are LLM-backed
// invocations; edges link nodes; HITL pauses interrupt the run on
// `requestApproval()`. Each node may have its own model + tools.
const graphNodeSchema = z
  .object({
    instructions: z.string().min(1),
    model: z.string().min(1).optional(),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    /**
     * When true, the node calls `ctx.requestApproval(prompt)` before
     * returning. The engine pauses, persists a checkpoint, and waits for
     * `resume(checkpointId, decision)` from the operator/CLI.
     */
    hitl: z
      .object({
        prompt: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

const graphEdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
  })
  .strict();

const graphSchema = z
  .object({
    name: z.string().min(1),
    target: z.literal("graph"),
    model: z.string().min(1),
    entry: z.string().min(1),
    nodes: z.record(z.string().min(1), graphNodeSchema),
    edges: z.array(graphEdgeSchema).default([]),
    permissions: permissionsBlock,
    compaction: compactionBlock,
    chains: chainsBlock,
    wallets: walletsBlock,
    contracts: contractsBlock,
    transaction_policy: transactionPolicyBlock,
  })
  .strict();

// Managed daemon target (Section 20). Multi-tenant gateway with
// per-tenant budgets + policy overrides; emitted bundle is daemon.ts +
// agent.ts. Authentication is HS256 JWT — the signing secret enters
// via env at boot, not via the spec.
const managedTenantSchema = z
  .object({
    id: z.string().min(1),
    budget: z
      .object({
        maxInputTokens: z.number().int().positive(),
        maxOutputTokens: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

const managedAgentSchema = z
  .object({
    model: z.string().min(1),
    instructions: z.string().min(1),
  })
  .strict();

const managedSchema = z
  .object({
    name: z.string().min(1),
    target: z.literal("managed"),
    agent: managedAgentSchema,
    tenants: z.array(managedTenantSchema).min(1),
    permissions: permissionsBlock,
    compaction: compactionBlock,
  })
  .strict();

// Pipeline / RAG target (Section 21). Carries the embedder + vector-store
// config, an indexing pipeline, and a chat agent that uses Retrieve.
const pipelineDocumentSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const pipelineSchema = z
  .object({
    name: z.string().min(1),
    target: z.literal("pipeline"),
    agent: z
      .object({
        model: z.string().min(1),
        instructions: z.string().min(1),
      })
      .strict(),
    retrieve: z
      .object({
        embedderModel: z.string().min(1),
        vectorBackend: z.enum(["in-memory"]).default("in-memory"),
        defaultK: z.number().int().positive().max(50).default(5),
      })
      .strict(),
    indexing: z
      .object({
        chunkStrategy: z.enum(["fixed", "semantic", "markdown"]).default("fixed"),
        chunkSize: z.number().int().positive().default(400),
        chunkOverlap: z.number().int().nonnegative().default(0),
        documents: z.array(pipelineDocumentSchema).min(1),
      })
      .strict(),
    permissions: permissionsBlock,
    compaction: compactionBlock,
  })
  .strict();

// Crew target (Section 22). Multi-role agent runtime; each role is an
// `agent`-shaped block (model + instructions + tools); `entry` names the
// first-active role; optional `routing` block carries either `match`
// rules or `llm` directive (lower-time placeholder for an LLM-backed
// router; runtime falls back to "no router" when the target shape lands
// on the codegen path).
const crewRoleSchema = z
  .object({
    instructions: z.string().min(1),
    model: z.string().min(1).optional(),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    sub_agents: subAgentsBlock,
  })
  .strict();

const crewRoutingMatchEntrySchema = z
  .object({
    contains: z.string().min(1),
    to: z.string().min(1),
  })
  .strict();

const crewRoutingSchema = z
  .object({
    kind: z.enum(["match", "llm"]),
    match: z.record(z.string().min(1), z.array(crewRoutingMatchEntrySchema).min(1)).optional(),
  })
  .strict();

const crewSchema = z
  .object({
    name: z.string().min(1),
    target: z.literal("crew"),
    /** Crew-wide model fallback used by any role that omits `role.model`. */
    model: z.string().min(1),
    entry: z.string().min(1),
    roles: z.record(z.string().min(1), crewRoleSchema),
    routing: crewRoutingSchema.optional(),
    mcp_servers: mcpServersBlock,
    permissions: permissionsBlock,
    compaction: compactionBlock,
    chains: chainsBlock,
    wallets: walletsBlock,
    contracts: contractsBlock,
    transaction_policy: transactionPolicyBlock,
  })
  .strict();
// `.refine()` on a discriminatedUnion member would change the type from
// ZodObject to ZodEffects (incompatible with the union); the
// "entry-in-roles" + "non-empty roles" cross-field checks live in
// `parseSpec` below as a post-parse pass.

// Research target (Section 23 RES). The compiled daemon decomposes
// `goal` into `branchingFactor` sub-questions, runs one agent loop per
// branch, and writes a numbered-citation report under
// `.crewhaus/research/<runId>/`.
const researchRetrieveSchema = z
  .object({
    allowedOrigins: z.array(z.string().min(1)).default([]),
    allowedFileRoots: z.array(z.string().min(1)).default([]),
    vectorBackend: z.enum(["in-memory"]).optional(),
  })
  .strict();

const researchSchema = z
  .object({
    name: z.string().min(1),
    target: z.literal("research"),
    agent: z
      .object({
        model: z.string().min(1),
        instructions: z.string().min(1),
      })
      .strict(),
    goal: z.string().min(1),
    branchingFactor: z.number().int().min(1).max(8).default(3),
    maxDurationMs: z.number().int().positive().default(300_000),
    retrieve: researchRetrieveSchema.default({}),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    mcp_servers: mcpServersBlock,
    permissions: permissionsBlock,
    compaction: compactionBlock,
    chains: chainsBlock,
    wallets: walletsBlock,
    contracts: contractsBlock,
    transaction_policy: transactionPolicyBlock,
  })
  .strict();

// Batch target (Section 23 BATCH). Queue-worker daemon: pulls jobs
// from `queue`, runs the agent on each input, dedups via idempotency
// keys. v0 ships an in-memory adapter for tests + smoke; SQS / Redis
// Streams / Postgres adapters land in follow-up PRs.
const batchQueueSchema = z
  .object({
    adapter: z.enum(["in-memory", "sqs", "redis-streams", "postgres"]),
    visibilityTimeoutMs: z.number().int().positive().default(30_000),
    visibilityRenewIntervalMs: z.number().int().positive().optional(),
    maxRetries: z.number().int().min(1).max(10).default(3),
    seedJobs: z.array(z.string().min(1)).optional(),
  })
  .strict();

const batchSchema = z
  .object({
    name: z.string().min(1),
    target: z.literal("batch"),
    agent: z
      .object({
        model: z.string().min(1),
        instructions: z.string().min(1),
      })
      .strict(),
    queue: batchQueueSchema,
    concurrency: z.number().int().min(1).max(64).default(4),
    idempotencyWindowMs: z.number().int().positive().default(60_000),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    mcp_servers: mcpServersBlock,
    permissions: permissionsBlock,
    compaction: compactionBlock,
    chains: chainsBlock,
    wallets: walletsBlock,
    contracts: contractsBlock,
    transaction_policy: transactionPolicyBlock,
  })
  .strict();

// Voice target (Section 24 VOICE). Realtime audio agent.
const voiceBlockSchema = z
  .object({
    provider: z.enum(["openai", "vapi"]),
    voiceId: z.string().min(1).default("alloy"),
    vad: z.enum(["server", "none"]).default("server"),
    bargeInTriggerFrames: z.number().int().min(1).max(20).default(4),
    bargeInWindowMs: z.number().int().min(60).max(2000).default(200),
  })
  .strict();

const voiceTelephonySchema = z
  .object({
    provider: z.enum(["twilio", "livekit-sip", "in-memory"]),
  })
  .strict();

const voiceSchema = z
  .object({
    name: z.string().min(1),
    target: z.literal("voice"),
    agent: z
      .object({
        model: z.string().min(1),
        instructions: z.string().min(1),
      })
      .strict(),
    voice: voiceBlockSchema,
    telephony: voiceTelephonySchema.optional(),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    mcp_servers: mcpServersBlock,
    permissions: permissionsBlock,
    compaction: compactionBlock,
  })
  .strict();

// Browser target (Section 25 BROW). Computer-use / browser-driver agent.
const browserDriverSchema = z
  .object({
    backend: z.enum(["host", "chromium", "remote"]).default("chromium"),
    viewport: z
      .object({
        width: z.number().int().positive().default(1280),
        height: z.number().int().positive().default(720),
      })
      .strict()
      .default({ width: 1280, height: 720 }),
    startUrl: z.string().url().optional(),
  })
  .strict();

const browserSchema = z
  .object({
    name: z.string().min(1),
    target: z.literal("browser"),
    agent: z
      .object({
        model: z.string().min(1),
        instructions: z.string().min(1),
      })
      .strict(),
    driver: browserDriverSchema.default({}),
    /** Vision-grounding model. Defaults to the agent's primary model. */
    groundingModel: z.string().min(1).optional(),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    mcp_servers: mcpServersBlock,
    permissions: permissionsBlock,
    compaction: compactionBlock,
  })
  .strict();

/**
 * Section 29 — `target: "eval"` — the EVAL target shape. A spec carries an
 * agent definition, a dataset reference (resolved via §29 dataset-registry),
 * a list of grader names (resolved via §29 grader-registry), concurrency
 * and seed knobs. The compiled bundle boots dataset-registry +
 * grader-registry + eval-runner and writes results to
 * `.crewhaus/evals/<runId>/`.
 */
const evalSchema = z
  .object({
    name: z.string().min(1),
    target: z.literal("eval"),
    agent: z
      .object({
        model: z.string().min(1),
        instructions: z.string().min(1),
        tools: z.array(z.string().min(1)).optional(),
      })
      .strict(),
    dataset: z
      .object({
        name: z.string().min(1),
        version: z.string().min(1),
        split: z.enum(["train", "dev", "test"]).default("dev"),
      })
      .strict(),
    graders: z
      .array(
        z
          .object({
            name: z.string().min(1),
            opts: z.record(z.unknown()).optional(),
          })
          .strict(),
      )
      .min(1),
    concurrency: z.number().int().min(1).default(4),
    seed: z.number().int().optional(),
  })
  .strict();

/**
 * Section 47 — `onchain` target. Long-running event-driven daemon.
 * Triggers fire on contract events / block scans / address watches;
 * each trigger runs one agent turn with the decoded payload as the
 * user message. Wallets + transaction_policy let the agent respond
 * with signed transactions (escrow release, treasury rebalance, etc).
 */
const onchainTriggerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("event"),
      chainId: z.string().min(1),
      contract: z.string().min(1),
      event: z.string().min(1),
      filter: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("block"),
      chainId: z.string().min(1),
      scanIntervalMs: z.number().int().min(1000).max(3_600_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("address"),
      chainId: z.string().min(1),
      address: z.string().min(1),
      direction: z.enum(["in", "out", "both"]).default("both"),
    })
    .strict(),
]);

const onchainSchema = z
  .object({
    name: z.string().min(1),
    target: z.literal("onchain"),
    agent: z
      .object({
        model: z.string().min(1),
        instructions: z.string().min(1),
      })
      .strict(),
    chains: z.array(chainBindingSchema).min(1),
    wallets: z.array(walletBindingSchema).default([]),
    contracts: z.array(contractBindingSchema).default([]),
    transaction_policy: transactionPolicySchema.default({
      defaultWriteApproval: "required",
      allowedContracts: [],
      simulationRequired: true,
    }),
    triggers: z.array(onchainTriggerSchema).min(1),
    idempotencyWindowMs: z.number().int().positive().default(60_000),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    mcp_servers: mcpServersBlock,
    permissions: permissionsBlock,
    compaction: compactionBlock,
  })
  .strict();

/**
 * Section 47 — `onchain-game` target. Perceive-act-perceive loop
 * against a game contract: read state via `stateReader`, ask the model
 * for a move, broadcast it as a transaction, await confirmation,
 * re-read state. Single chain, single wallet.
 */
const onchainGameSchema = z
  .object({
    name: z.string().min(1),
    target: z.literal("onchain-game"),
    agent: z
      .object({
        model: z.string().min(1),
        instructions: z.string().min(1),
      })
      .strict(),
    chain: chainBindingSchema,
    wallet: walletBindingSchema,
    game: z
      .object({
        contract: contractBindingSchema,
        stateReader: z.string().min(1),
        actionsContract: z.string().min(1).optional(),
        turnSemantics: z.enum(["turn-based", "real-time", "async"]).default("turn-based"),
        moveTimeoutMs: z.number().int().positive().optional(),
        objective: z.string().min(1).optional(),
      })
      .strict(),
    transaction_policy: transactionPolicySchema.default({
      defaultWriteApproval: "required",
      allowedContracts: [],
      simulationRequired: true,
    }),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    mcp_servers: mcpServersBlock,
    permissions: permissionsBlock,
    compaction: compactionBlock,
  })
  .strict();

export const Spec = z.discriminatedUnion("target", [
  cliSchema,
  workflowSchema,
  channelSchema,
  graphSchema,
  managedSchema,
  pipelineSchema,
  crewSchema,
  researchSchema,
  batchSchema,
  voiceSchema,
  browserSchema,
  evalSchema,
  onchainSchema,
  onchainGameSchema,
]);

export type Spec = z.infer<typeof Spec>;
export type SpecCli = z.infer<typeof cliSchema>;
export type SpecWorkflow = z.infer<typeof workflowSchema>;
export type SpecWorkflowStep = z.infer<typeof workflowStepSchema>;
export type SpecChannel = z.infer<typeof channelSchema>;
export type SpecChannelAgent = z.infer<typeof channelAgentSchema>;
export type SpecSlackChannel = z.infer<typeof slackChannelSchema>;
export type SpecTelegramChannel = z.infer<typeof telegramChannelSchema>;
export type SpecDiscordChannel = z.infer<typeof discordChannelSchema>;
export type SpecWhatsAppChannel = z.infer<typeof whatsappChannelSchema>;
export type SpecIMessageChannel = z.infer<typeof imessageChannelSchema>;
export type SpecGraph = z.infer<typeof graphSchema>;
export type SpecGraphNode = z.infer<typeof graphNodeSchema>;
export type SpecGraphEdge = z.infer<typeof graphEdgeSchema>;
export type SpecManaged = z.infer<typeof managedSchema>;
export type SpecManagedTenant = z.infer<typeof managedTenantSchema>;
export type SpecPipeline = z.infer<typeof pipelineSchema>;
export type SpecPipelineDocument = z.infer<typeof pipelineDocumentSchema>;
export type SpecCrew = z.infer<typeof crewSchema>;
export type SpecCrewRole = z.infer<typeof crewRoleSchema>;
export type SpecCrewRouting = z.infer<typeof crewRoutingSchema>;
export type SpecResearch = z.infer<typeof researchSchema>;
export type SpecResearchRetrieve = z.infer<typeof researchRetrieveSchema>;
export type SpecBatch = z.infer<typeof batchSchema>;
export type SpecBatchQueue = z.infer<typeof batchQueueSchema>;
export type SpecOnchain = z.infer<typeof onchainSchema>;
export type SpecOnchainGame = z.infer<typeof onchainGameSchema>;
export type SpecChainTrigger = z.infer<typeof onchainTriggerSchema>;
export type SpecVoice = z.infer<typeof voiceSchema>;
export type SpecVoiceBlock = z.infer<typeof voiceBlockSchema>;
export type SpecVoiceTelephony = z.infer<typeof voiceTelephonySchema>;
export type SpecBrowser = z.infer<typeof browserSchema>;
export type SpecBrowserDriver = z.infer<typeof browserDriverSchema>;
export type SpecEval = z.infer<typeof evalSchema>;
export type SpecMcpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type SpecSubAgentDefinition = z.infer<typeof subAgentDefinitionSchema>;
export type SpecCompactionBlock = z.infer<typeof compactionBlock>;

export { SpecParseError };

export function parseSpec(yamlText: string): Spec {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new SpecParseError("invalid YAML", err);
  }

  // Friendly early-rejection for `permissions.mode: bypass` so the error
  // message names the actual security policy rather than a Zod enum mismatch.
  // The Zod schema also excludes "bypass" from its enum (defense in depth).
  if (typeof raw === "object" && raw !== null && "permissions" in raw) {
    const perms = (raw as { permissions?: unknown }).permissions;
    if (typeof perms === "object" && perms !== null && "mode" in perms) {
      const mode = (perms as { mode?: unknown }).mode;
      if (mode === "bypass") {
        throw new SpecParseError(
          "permissions.mode: bypass is rejected — bypass mode is only available via the --permission-mode CLI flag, never from a spec file",
        );
      }
    }
  }

  const result = Spec.safeParse(raw);
  if (!result.success) {
    throw new SpecParseError(
      `spec validation failed:\n${result.error.issues
        .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("\n")}`,
      result.error,
    );
  }
  // Section 22 — crew cross-field invariants. Kept here rather than as
  // `.refine()`s on the schema so the discriminated-union member stays
  // a plain ZodObject (Zod's discriminatedUnion rejects ZodEffects).
  const data = result.data;
  if (data.target === "crew") {
    const roleNames = Object.keys(data.roles);
    if (roleNames.length === 0) {
      throw new SpecParseError("crew target requires at least one role");
    }
    if (!roleNames.includes(data.entry)) {
      throw new SpecParseError(
        `crew.entry "${data.entry}" must name one of crew.roles (got: ${roleNames.join(", ")})`,
      );
    }
    if (data.routing !== undefined && data.routing.kind === "match" && data.routing.match) {
      for (const [from, rules] of Object.entries(data.routing.match)) {
        if (!roleNames.includes(from)) {
          throw new SpecParseError(`crew.routing.match["${from}"]: source role not in crew.roles`);
        }
        for (const rule of rules) {
          if (!roleNames.includes(rule.to)) {
            throw new SpecParseError(
              `crew.routing.match["${from}"].to = "${rule.to}" — target role not in crew.roles`,
            );
          }
        }
      }
    }
  }
  return data;
}
