/**
 * The one hand-written input to the support manifest (`@crewhaus/ir/support`):
 * a minimal value for every setting a spec can declare. The generator
 * (`scripts/gen-support-manifest.ts`) adds each value to every shape's minimal
 * spec (`ABSENT_CORPUS`), compiles with and without it, and records what the
 * shape did with it. No cell is written by hand.
 *
 * A probe:
 *   - `snippet` is merged into the spec for the probe compile only; `base` is
 *     merged into both, so a dial is probed against its own block (for
 *     example `compaction.dedupeThreshold` with `curate: true` on both sides);
 *   - `place(shape)` puts the setting where a shape's structure nests it (a
 *     model pool under `agent`, a workflow step, a graph node or a crew role),
 *     or answers `undefined` for the default placement at the feature's path;
 *   - `kind: "authoring"` records a decision and must change no compiled byte (on every
 *     variant its `effectiveOn` does not name);
 *     `kind: "toolchain"` is read by a CLI verb from `crewhaus.yaml` rather
 *     than by the bundle, and names that verb's file in `readBy` (a test
 *     checks the file reads the key);
 *   - `at` lists the spec paths that declare the feature (`*` is any key or
 *     index), for `declaredFeatures`; it defaults to the feature id.
 *
 * Model ids are fixed, and the generator compiles at a pinned date, so a model
 * sunset cannot move a cell.
 *
 * Exported for the generator and tests; not re-exported from the package's
 * main entry.
 */

/**
 * The release line this compiler's cells are stamped with: the manifest's
 * `generatedBy`, and the `since` of a cell whose status changed. Not
 * `package.json`'s version: release preparation bumps every version without
 * regenerating anything. After a release ships, the first change that moves a
 * cell bumps this to the next release line; the next release fails a test
 * until someone has (`scripts/support-manifest.test.ts`).
 */
export const SUPPORT_RELEASE = "0.9.0";

/** A piece of spec, as the parsed YAML object it is merged into. */
export type SpecFragment = Readonly<Record<string, unknown>>;

export type ProbePlacement = {
  /** Where the setting sits on this shape (warnings are matched against it). */
  readonly path: string;
  readonly snippet: SpecFragment;
  readonly base?: SpecFragment;
};

export type FeatureProbe = {
  /** The feature id: the spec path, `.`-joined. */
  readonly feature: string;
  readonly kind: "runtime" | "authoring" | "toolchain";
  readonly snippet: SpecFragment;
  readonly base?: SpecFragment;
  /** `variant` is the shape itself, or `<shape>@cf-worker` for a Worker build. */
  readonly place?: (shape: string, variant: string) => ProbePlacement | undefined;
  /**
   * For `kind: "authoring"`: the variants where the key takes effect after all, beside the
   * base its `place` adds there. It is judged as a runtime setting on those, and must change
   * no byte on every other.
   */
  readonly effectiveOn?: ReadonlyArray<string>;
  /** For `kind: "toolchain"`: the repo file whose code reads the key. */
  readonly readBy?: string;
  /** For `kind: "toolchain"`: the shapes that file reads it for (all, when absent). */
  readonly toolchainShapes?: ReadonlyArray<string>;
  /** The spec paths that declare the feature; defaults to `[feature]`. */
  readonly at?: ReadonlyArray<string>;
};

/** A key of a shape's schema that is that shape's own structure, not a setting. */
export type StructuralKey = { readonly key: string; readonly reason: string };

/**
 * Keys no probe covers, because they are a shape's own structure: each is
 * required (or filled in by default) by at least one shape's schema, which a
 * test checks. A key optional on every schema is a setting and needs a probe.
 */
export const STRUCTURAL_KEYS: ReadonlyArray<StructuralKey> = [
  { key: "name", reason: "every spec names its harness" },
  { key: "target", reason: "every spec names its shape" },
  { key: "agent", reason: "the agent a single-agent shape runs" },
  { key: "model", reason: "the default model of a workflow, graph or crew" },
  { key: "steps", reason: "a workflow's steps" },
  { key: "nodes", reason: "a graph's nodes" },
  { key: "edges", reason: "a graph's edges (none when the spec lists none)" },
  { key: "entry", reason: "where a graph or a crew starts" },
  { key: "roles", reason: "a crew's roles" },
  { key: "channels", reason: "the channels a channel harness answers on" },
  { key: "tenants", reason: "the tenants a managed harness serves" },
  { key: "indexing", reason: "what a pipeline indexes" },
  { key: "goal", reason: "what a research run sets out to answer" },
  { key: "queue", reason: "where a batch harness takes its jobs from" },
  { key: "voice", reason: "a voice harness's realtime provider" },
  { key: "dataset", reason: "the dataset an eval harness grades" },
  { key: "graders", reason: "how an eval harness grades" },
  { key: "triggers", reason: "what wakes an onchain harness" },
  { key: "chain", reason: "the chain an onchain-game harness plays on" },
  { key: "wallet", reason: "the wallet an onchain-game harness plays with" },
  { key: "game", reason: "the game an onchain-game harness plays" },
];

const CANDIDATES = [
  { model: "claude-haiku-4-5", tags: ["cheap"] },
  { model: "claude-opus-4-8", tags: ["strong"] },
];

/** Where a shape's model pool lives, as a path and a fragment holding `pool`. */
function poolAt(
  shape: string,
  pool: SpecFragment,
): { readonly path: string; readonly fragment: SpecFragment } {
  switch (shape) {
    case "workflow":
      return { path: "steps[0].model_pool", fragment: { steps: [{ model_pool: pool }] } };
    case "graph":
      return {
        path: "nodes.classify.model_pool",
        fragment: { nodes: { classify: { model_pool: pool } } },
      };
    case "crew":
      return {
        path: "roles.editor.model_pool",
        fragment: { roles: { editor: { model_pool: pool } } },
      };
    default:
      return { path: "agent.model_pool", fragment: { agent: { model_pool: pool } } };
  }
}

/** A hybrid strategy family, probed inside a two-candidate pool both compiles carry. */
function strategyProbe(feature: string, key: string, strategy: unknown): FeatureProbe {
  const at = (shape: string): ProbePlacement => {
    const base = poolAt(shape, { candidates: CANDIDATES });
    const probe = poolAt(shape, { strategy: { [key]: strategy } });
    return { path: `${base.path}.strategy.${key}`, snippet: probe.fragment, base: base.fragment };
  };
  const fallback = at("cli");
  return {
    feature,
    kind: "runtime",
    snippet: fallback.snippet,
    base: fallback.base as SpecFragment,
    place: at,
    at: [`agent.${feature}`, `steps.*.${feature}`, `nodes.*.${feature}`, `roles.*.${feature}`],
  };
}

/** A `compaction:` sub-key, probed alone (its dials against `curate: true`). */
function compactionProbe(sub: string, value: unknown, base?: SpecFragment): FeatureProbe {
  return {
    feature: `compaction.${sub}`,
    kind: "runtime",
    snippet: { compaction: { [sub]: value } },
    ...(base !== undefined ? { base } : {}),
  };
}

const CURATE_ON = { compaction: { curate: true } };

/** A top-level setting, probed by adding `snippet` to the shape's minimal spec. */
const setting = (
  feature: string,
  snippet: SpecFragment,
  extra: Partial<Omit<FeatureProbe, "feature" | "snippet">> = {},
): FeatureProbe => ({ feature, kind: "runtime", snippet, ...extra });

/** A judge gate inside a workflow step or a graph node, or (elsewhere) at the top level. */
const judgeGate = (shape: string): ProbePlacement | undefined => {
  const gate = { kind: "judge", judge: { criteria: "mentions the deadline" } };
  const flag = { judge: { protected: true } };
  if (shape === "workflow") {
    return {
      path: "steps[1].judge.protected",
      snippet: { steps: [{}, flag] },
      base: { steps: [{}, { name: "gate", ...gate }] },
    };
  }
  if (shape === "graph") {
    return {
      path: "nodes.gate.judge.protected",
      snippet: { nodes: { gate: flag } },
      base: { nodes: { gate }, edges: [{ from: "classify", to: "gate" }] },
    };
  }
  return undefined;
};

const EVALUATION = { grader: { type: "llm_judge", criteria: "answers the question" } };

/** Where a shape lists its agent's tools, as a fragment holding `tools`. */
function toolsAt(shape: string, tools: readonly string[]): SpecFragment {
  switch (shape) {
    case "channel":
    case "managed":
      return { agent: { tools } };
    case "workflow":
      return { steps: [{ tools }] };
    case "graph":
      return { nodes: { classify: { tools } } };
    case "crew":
      return { roles: { editor: { tools } } };
    default:
      return { tools };
  }
}

/** Where a shape names its primary model, as a fragment. */
function primaryModelAt(shape: string, model: string): SpecFragment {
  return shape === "workflow" || shape === "graph" || shape === "crew"
    ? { model }
    : { agent: { model } };
}

const BASE_CHAIN = {
  id: "base",
  kind: "evm",
  rpcUrls: ["$BASE_RPC_URL"],
  finality: { kind: "finalized" },
};

/**
 * A chain block is read by the chain tools a spec lists, so it is probed with
 * one in both compiles (`EvmMulticall` reads the chains, wallets, contracts and
 * transaction policy together); the blocks other than `chains` also keep a
 * chain in both.
 */
function chainBlockProbe(feature: string, value: unknown, withChain: boolean): FeatureProbe {
  const at = (shape: string): ProbePlacement => ({
    path: feature,
    snippet: { [feature]: value },
    base: {
      ...toolsAt(shape, ["evmMulticall"]),
      ...(withChain ? { chains: [BASE_CHAIN] } : {}),
    },
  });
  const fallback = at("cli");
  return {
    feature,
    kind: "runtime",
    snippet: fallback.snippet,
    base: fallback.base as SpecFragment,
    place: at,
  };
}

/** The shapes whose harness delivers work to a repository. */
const REPOSITORY_SHAPES = ["cli", "workflow", "channel", "managed", "batch"] as const;
const REPOSITORIES = { app: { host: "github", repo: "acme/budget-app" } };
const INTENT = { intent: { purpose: "Keep the budgeting app reliable and fast." } };

export const FEATURE_PROBES: ReadonlyArray<FeatureProbe> = [
  // The 0.9.0 keys (`DELTA_090_KEYS`).
  {
    // Read by the acceptance judge alone, on the shapes that deliver work and beside the
    // repositories it is delivered to; a recorded decision everywhere else.
    feature: "intent",
    kind: "authoring",
    snippet: INTENT,
    effectiveOn: REPOSITORY_SHAPES,
    place: (shape, variant) =>
      (REPOSITORY_SHAPES as readonly string[]).includes(variant)
        ? {
            path: "intent",
            snippet: INTENT,
            base: { ...toolsAt(shape, ["workspaceOpen"]), repositories: REPOSITORIES },
          }
        : undefined,
  },
  {
    // Read by the workspace tools, so it is probed with one in both compiles.
    feature: "repositories",
    kind: "runtime",
    snippet: { repositories: REPOSITORIES },
    place: (shape) =>
      (REPOSITORY_SHAPES as readonly string[]).includes(shape)
        ? {
            path: "repositories",
            snippet: { repositories: REPOSITORIES },
            base: toolsAt(shape, ["workspaceOpen"]),
          }
        : undefined,
  },
  {
    feature: "evaluation.protected",
    kind: "authoring",
    snippet: { evaluation: { protected: true } },
    base: { evaluation: EVALUATION },
  },
  {
    feature: "provability.protected",
    kind: "authoring",
    snippet: { provability: { protected: true } },
    base: { provability: { level: "cited" } },
  },
  {
    feature: "judge.protected",
    kind: "authoring",
    snippet: { judge: { protected: true } },
    place: judgeGate,
    at: ["steps.*.judge.protected", "nodes.*.judge.protected"],
  },
  setting("schedule", { schedule: { kind: "interval", every: "6h" } }),
  // Every other optional top-level key, in alphabetical order.
  setting("branchingFactor", { branchingFactor: 3 }),
  // Read only by a Cloudflare Worker build (`--emit-as cf-worker`).
  setting("cf_worker.public_chat", { cf_worker: { public_chat: true } }),
  setting("budget", { budget: { usd: 5, on_exceed: { action: "stop" } } }),
  // The safety blocks, sub-key by sub-key (a test holds this list to the schemas).
  setting("budget.usd", { budget: { usd: 5 } }),
  setting(
    "budget.on_exceed",
    { budget: { on_exceed: { action: "degrade", model: "claude-haiku-4-5" } } },
    { base: { budget: { usd: 5 } } },
  ),
  setting("budget.scope", { budget: { scope: "session" } }, { base: { budget: { usd: 5 } } }),
  setting("budget.judge_share", { budget: { judge_share: 0.5 } }, { base: { budget: { usd: 5 } } }),
  // A harness-wide period (#514), and each of its keys against a declared period.
  setting(
    "budget.period",
    { budget: { period: { every: "month", usd: 50 } } },
    { base: { budget: { usd: 5 } } },
  ),
  setting(
    "budget.period.every",
    { budget: { period: { every: "week" } } },
    { base: { budget: { usd: 5, period: { every: "month", usd: 50 } } } },
  ),
  setting(
    "budget.period.usd",
    { budget: { period: { usd: 60 } } },
    { base: { budget: { usd: 5, period: { every: "month", usd: 50 } } } },
  ),
  setting(
    "budget.period.starts",
    { budget: { period: { starts: "2026-01-05" } } },
    { base: { budget: { usd: 5, period: { every: "month", usd: 50 } } } },
  ),
  setting(
    "budget.period.timezone",
    { budget: { period: { timezone: "Europe/Berlin" } } },
    { base: { budget: { usd: 5, period: { every: "month", usd: 50 } } } },
  ),
  chainBlockProbe("chains", [BASE_CHAIN], false),
  setting("cli", { cli: { banner: { taglines: ["Hello."] } } }),
  setting("concurrency", { concurrency: 3 }),
  setting("continuity", { continuity: { proof: "require" } }),
  chainBlockProbe(
    "contracts",
    [{ id: "token", chainId: "base", address: "0x2", abiRef: "abi://erc20" }],
    true,
  ),
  setting("driver", { driver: { backend: "chromium", viewport: { width: 800, height: 600 } } }),
  setting("evaluation", { evaluation: EVALUATION }),
  // `crewhaus serve --mcp` reads a cli spec's `expose:`; the daemon shapes mount it themselves.
  {
    feature: "expose",
    kind: "toolchain",
    snippet: { expose: { mcp: { transport: "sse" } } },
    readBy: "apps/cli/src/serve-mcp.ts",
    toolchainShapes: ["cli"],
  },
  setting("failure_taxonomy", {
    failure_taxonomy: [{ class: "net", pattern: "ETIMEDOUT", recovery: "retry" }],
  }),
  // Each shape takes ratings its own way: the cli exit prompt and the managed
  // `feedback.submit` method read the scale, the channel daemon reads reactions.
  setting(
    "feedback",
    { feedback: { modality: "stars" } },
    {
      place: (shape) =>
        shape === "channel"
          ? { path: "feedback", snippet: { feedback: { channelReactions: true } } }
          : undefined,
    },
  ),
  setting("gateway", { gateway: { port: 9090 } }),
  setting("groundingModel", { groundingModel: "claude-haiku-4-5" }),
  setting("heartbeat", { heartbeat: { every: "1h", instructions: "Check in." } }),
  setting("hooks", { hooks: [{ event: "pre-tool", matcher: "Bash", command: "./guard.sh" }] }),
  setting("idempotencyWindowMs", { idempotencyWindowMs: 12345 }),
  setting("knowledge", { knowledge: { sources: [{ path: "./docs" }] } }),
  setting(
    "learning",
    { learning: { domain: "coffee" } },
    { base: { memory: { wiki: { enabled: true } } } },
  ),
  setting("limits", { limits: { max_tool_iterations: 7 } }),
  setting("limits.max_tool_iterations", { limits: { max_tool_iterations: 7 } }),
  setting("limits.max_concurrent_tools", { limits: { max_concurrent_tools: 2 } }),
  setting("limits.context_limit", { limits: { context_limit: 50000 } }),
  setting("limits.deadline_ms", { limits: { deadline_ms: 60000 } }),
  setting("limits.turn_timeout_ms", { limits: { turn_timeout_ms: 120000 } }),
  setting("limits.model_call_timeout_ms", { limits: { model_call_timeout_ms: 30000 } }),
  setting("limits.loop_detection.window", { limits: { loop_detection: { window: 6 } } }),
  setting("limits.loop_detection.threshold", { limits: { loop_detection: { threshold: 4 } } }),
  // By value: `justify` against `warn`, so a build that reads it as `warn` fails here.
  setting(
    "limits.loop_detection.escalation",
    { limits: { loop_detection: { escalation: "justify" } } },
    { base: { limits: { loop_detection: { escalation: "warn" } } } },
  ),
  setting("limits.crew.max_activations", { limits: { crew: { max_activations: 5 } } }),
  setting("limits.crew.refusal_depth", { limits: { crew: { refusal_depth: 1 } } }),
  setting("limits.crew.max_a2a_depth", { limits: { crew: { max_a2a_depth: 2 } } }),
  setting("maxDurationMs", { maxDurationMs: 60000 }),
  // A workflow boots its servers for the steps that declare tools.
  setting(
    "mcp_servers",
    { mcp_servers: { docs: { transport: "stdio", command: "docs-mcp" } } },
    {
      place: (shape) =>
        shape === "workflow"
          ? {
              path: "mcp_servers",
              snippet: { mcp_servers: { docs: { transport: "stdio", command: "docs-mcp" } } },
              base: toolsAt(shape, ["fetch"]),
            }
          : undefined,
    },
  ),
  setting("memory", { memory: { backend: "file" } }),
  setting("memory.wiki", { memory: { wiki: { enabled: true } } }),
  setting("memory.dream", { memory: { dream: { every: "24h" } } }),
  // A profile does something only where a slot names it, so the probe names it
  // from the primary model slot.
  {
    feature: "models",
    kind: "runtime",
    snippet: {
      models: { main: { model: "claude-haiku-4-5" } },
      agent: { model: "$main" },
    },
    place: (shape) => ({
      path: "models",
      snippet: {
        models: { main: { model: "claude-haiku-4-5" } },
        ...primaryModelAt(shape, "$main"),
      },
    }),
  },
  // A model's declared price (#514): the runtime prices every call of the
  // harness with it, so it reaches each model-wiring block whether or not a
  // slot names the profile.
  {
    feature: "models.*.price",
    kind: "runtime",
    snippet: { models: { local: { price: { input_per_1m: 1, output_per_1m: 2 } } } },
    base: { models: { local: { model: "local/qwen3@http://127.0.0.1:11434/v1" } } },
  },
  // The sub-blocks other than `trace`, which has a probe of its own.
  setting(
    "observability",
    { observability: { slo: { error_rate: 0.05 }, metrics: { enabled: true } } },
    {
      at: ["slo", "metrics", "cost", "alerts", "incidents", "otel"].map(
        (sub) => `observability.${sub}`,
      ),
    },
  ),
  // A daemon prints `pretty` or `json` traces; a Cloudflare Worker reads `off`;
  // a compiled cli bundle reads neither, and `crewhaus run` reads the level.
  {
    feature: "observability.trace",
    kind: "toolchain",
    snippet: { observability: { trace: { level: "off" } } },
    place: (shape) =>
      shape === "channel" || shape === "managed"
        ? {
            path: "observability.trace",
            snippet: { observability: { trace: { level: "pretty" } } },
          }
        : undefined,
    readBy: "apps/cli/src/run-observability.ts",
    toolchainShapes: ["cli"],
  },
  setting(
    "parallel",
    { parallel: [["fetch_a", "fetch_b"]] },
    {
      base: {
        nodes: {
          fetch_a: { instructions: "Fetch the first source." },
          fetch_b: { instructions: "Fetch the second source." },
        },
        edges: [
          { from: "classify", to: "fetch_a" },
          { from: "fetch_a", to: "fetch_b" },
        ],
      },
    },
  ),
  setting("permissions", {
    permissions: { rules: [{ type: "alwaysDeny", pattern: "Bash(rm *)" }] },
  }),
  setting("permissions.mode", { permissions: { mode: "plan" } }),
  setting("permissions.rules", {
    permissions: { rules: [{ type: "alwaysAsk", pattern: "Fetch(https://internal.example/*)" }] },
  }),
  // `crewhaus compile` records the ceiling in the build's deployment record
  // (apps/cli/src/compile-record.ts); Home's delegation service applies it from there.
  {
    feature: "permissions.delegation.max_days",
    kind: "toolchain",
    snippet: { permissions: { delegation: { max_days: 14 } } },
    readBy: "packages/control-service/src/delegations.ts",
  },
  // `crewhaus run` and `serve` read it on a cli spec (a compiled REPL asks at its prompt).
  {
    feature: "permissions.ask_mode",
    kind: "toolchain",
    snippet: { permissions: { ask_mode: "deny" } },
    readBy: "apps/cli/src/loop-contract.ts",
    toolchainShapes: ["cli"],
  },
  setting("plugins", { plugins: ["example-plugin"] }),
  // The object form: a plugin and the host tools it may drive.
  setting(
    "plugins.tools",
    { plugins: [{ name: "example-plugin", tools: ["Fetch"] }] },
    { at: ["plugins.*.tools"] },
  ),
  setting("provability", { provability: { level: "cited" } }),
  setting("retrieve", { retrieve: { allowedOrigins: ["https://example.com"] } }),
  setting("routing", {
    routing: { kind: "match", match: { editor: [{ contains: "refund", to: "editor" }] } },
  }),
  setting("security.justification.judge", { security: { justification: { judge: "claude" } } }),
  setting(
    "security.justification.model",
    { security: { justification: { model: "claude-haiku-4-5" } } },
    { base: { security: { justification: { judge: "claude" } } } },
  ),
  setting("security.egressMatcher", { security: { egressMatcher: "semantic" } }),
  setting("seed", { seed: 42 }),
  setting("telephony", { telephony: { provider: "twilio" } }),
  setting("thredz", { thredz: true }),
  setting(
    "tool_config",
    { tool_config: { fetch: { allowed_origins: ["https://example.com"] } } },
    {
      place: (shape) => ({
        path: "tool_config",
        snippet: { tool_config: { fetch: { allowed_origins: ["https://example.com"] } } },
        base: toolsAt(shape, ["fetch"]),
      }),
    },
  ),
  setting("tools", { tools: ["fetch"] }),
  chainBlockProbe("transaction_policy", { defaultWriteApproval: "policy" }, true),
  // The spec's schema version, read by `crewhaus upgrade`'s migrations.
  {
    feature: "version",
    kind: "toolchain",
    snippet: { version: 2 },
    readBy: "packages/migration-runner/src/index.ts",
  },
  chainBlockProbe(
    "wallets",
    [{ id: "w2", chainId: "base", custody: "local", keyRef: "$WALLET_KEY" }],
    true,
  ),
  setting("watchme", { watchme: { enabled: true } }),
  // compaction:, field by field.
  compactionProbe("model", "claude-haiku-4-5"),
  compactionProbe("threshold", 0.7),
  compactionProbe("snip_keep_head", 2),
  compactionProbe("snip_keep_tail", 9),
  compactionProbe("curate", true),
  compactionProbe("dedupeThreshold", 0.8, CURATE_ON),
  compactionProbe("relevanceTopK", 3, CURATE_ON),
  // The hybrid strategy families, inside a model pool.
  strategyProbe("model_pool.strategy.cascade", "cascade", {
    draft: "cheap",
    escalate_to: "strong",
  }),
  strategyProbe("model_pool.strategy.guide", "guide", {
    model: "claude-opus-4-8",
    every: "first_turn",
  }),
  strategyProbe("model_pool.strategy.committee", "committee", { members: ["cheap", "strong"] }),
  strategyProbe("model_pool.strategy.model_directed", "model_directed", true),
];
