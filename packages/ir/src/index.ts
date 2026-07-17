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
 *
 * 0.3.0 (breaking, pre-1.0): stdio `env` and sse `headers` VALUES are
 * `IrSecretRef`, not plain strings — `$UPPER_SNAKE` spec values lower to
 * `{ kind: "env" }` references exactly like every other credential field,
 * so secrets never land in compiled artifacts. Target codegen embeds the
 * unresolved config verbatim and the emitted bundle resolves it at process
 * start via `resolveMcpServerConfig` from `@crewhaus/mcp-host`.
 */
export type IrMcpStdioConfig = {
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, IrSecretRef>>;
};

export type IrMcpSseConfig = {
  readonly transport: "sse";
  readonly url: string;
  readonly headers?: Readonly<Record<string, IrSecretRef>>;
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
  /** Loop contract 0.4 (Batch A) — context-window fill fraction that
   *  triggers autocompaction (spec `compaction.threshold`, 0.5–0.99).
   *  Runtime default applies when absent. */
  readonly threshold?: number;
  /** Loop contract 0.4 (Batch A) — messages preserved verbatim at the
   *  transcript HEAD by `compaction-snip` (spec `compaction.snip_keep_head`).
   *  Snip package default when absent. */
  readonly snipKeepHead?: number;
  /** Loop contract 0.4 (Batch A) — messages preserved verbatim at the
   *  transcript TAIL by `compaction-snip` (spec `compaction.snip_keep_tail`).
   *  Snip package default when absent. */
  readonly snipKeepTail?: number;
  /** Pillar 2 — RESERVED, not yet wired at runtime. Intended to make
   *  target emitters wire `compaction-curator` as a pre-pass before the
   *  autocompact threshold check, but no emitter or runtime-core path
   *  consumes this field today — setting it is currently a no-op. The
   *  spec layer accepts this verbatim (validated in `packages/spec`) and
   *  it lowers here unchanged so the value round-trips once wiring lands;
   *  the IR holds it as an opt-in flag with no default so emitters can
   *  eventually distinguish "user said false" from "user didn't say". */
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
 * Item 22 — per-candidate circuit-breaker tuning lowered from the spec's
 * `agent.circuit_breaker` block. Field names mirror `CircuitBreakerOptions`
 * in `@crewhaus/circuit-breaker` exactly; every field optional so the
 * breaker package's own defaults apply per knob. Carried on the agent
 * blocks of the shapes wired for the failover chain (cli, channel,
 * managed). Absent when the spec omits the block — declaring it WITHOUT
 * `modelFallbacks` still breaker-wraps the single primary adapter.
 */
export type IrCircuitBreaker = {
  readonly failureThreshold?: number;
  readonly windowMs?: number;
  readonly cooldownMs?: number;
};

/**
 * Item 26 — two-tier turn-difficulty router config. `fast`/`default` are full
 * model-router grammar strings; `routing` tunes the per-turn escalation
 * thresholds (all optional — runtime defaults apply per knob). Carried on the
 * agent blocks of the failover-capable shapes (cli, channel, managed). Absent
 * when the spec omits `model_tiers` — codegen gates on presence so an unset
 * block leaves bundles byte-identical.
 */
export type IrModelTiers = {
  readonly fast: string;
  readonly default: string;
  readonly routing?: {
    readonly contextTokenThreshold?: number;
    readonly toolsToDefault?: boolean;
    readonly firstTurnToDefault?: boolean;
    readonly priorToolDensityThreshold?: number;
  };
};

/** One declared candidate in a `model_pool`. */
export type IrModelPoolCandidate = {
  readonly model: string;
  readonly tags: readonly string[];
};

/**
 * Adaptive model routing — the N-candidate `model_pool` with a per-turn
 * selection `policy` (`static` | `heuristic` | `learned`). Carried on the
 * agent blocks of the routing-capable shapes (cli, channel, managed), mutually
 * exclusive with `modelTiers`/`modelFallbacks` (enforced in the spec). Absent
 * when the spec omits `model_pool` — codegen gates on presence so an unset
 * block leaves bundles byte-identical. `policy` and each candidate's `tags` are
 * always present (spec defaults them); every other knob is carried verbatim.
 */
export type IrModelPool = {
  readonly candidates: readonly IrModelPoolCandidate[];
  readonly policy: "static" | "heuristic" | "learned";
  readonly objective?: {
    readonly quality?: number;
    readonly cost?: number;
    readonly latency?: number;
  };
  readonly routing?: {
    readonly contextTokenThreshold?: number;
    readonly toolsToDefault?: boolean;
    readonly firstTurnToDefault?: boolean;
    readonly priorToolDensityThreshold?: number;
    readonly strongTag?: string;
    readonly cheapTag?: string;
  };
  readonly learning?: {
    readonly minSamplesPerArm?: number;
    readonly costRefUsd?: number;
    readonly latencyRefMs?: number;
    readonly explorationRate?: number;
    readonly seed?: string;
    readonly bandit?: "epsilon-greedy" | "thompson";
  };
};

/**
 * Loop contract 0.4 (Batch A) — extended-thinking selector, lowered from
 * the spec's `thinking` block (agent-level on cli/channel/managed;
 * step/node/role-level on workflow/graph/crew). Exactly one variant is ever
 * present (the spec's superRefine enforces the exactly-one rule):
 *
 *   - `{ budgetTokens }` — explicit thinking-token budget (>= 1024), passed
 *     to the provider verbatim (`ProviderRequest.thinking`).
 *   - `{ effort }` — portable preset the adapter layer converts to a
 *     provider-appropriate budget (`EFFORT_THINKING_BUDGET_TOKENS` in
 *     `@crewhaus/adapter-anthropic`; threads as
 *     `ProviderRequest.reasoningEffort`).
 */
export type IrThinking =
  | { readonly budgetTokens: number }
  | { readonly effort: "low" | "medium" | "high" };

/**
 * Loop contract 0.4 (Batch A) — runaway-loop detection tuning inside
 * {@link IrLimits}. Every field carried verbatim only when declared; the
 * runtime owns per-knob defaults. `escalation`: `warn` (trace event only) |
 * `justify` (demand a justification via the intent gate) | `abort` (end the
 * run).
 */
export type IrLoopDetection = {
  readonly window?: number;
  readonly threshold?: number;
  readonly escalation?: "warn" | "justify" | "abort";
};

/**
 * Loop contract 0.4 (Batch A) — crew-only orchestration ceilings, lowered
 * from `limits.crew`. Present ONLY on the `IrCrewV0` variant's limits.
 */
export type IrCrewLimits = {
  readonly maxActivations?: number;
  readonly refusalDepth?: number;
  readonly maxA2aDepth?: number;
};

/**
 * Loop contract 0.4 (Batch A) — hard runtime ceilings for one agent loop,
 * lowered from the top-level `limits:` block. Carried on the loop-running
 * shapes (IrV0/cli, IrChannelV0, IrManagedV0, IrWorkflowV0, IrGraphV0,
 * IrCrewV0, IrResearchV0, IrBatchV0, IrBrowserV0). Absent when the spec
 * omits the block; every field carried verbatim only when declared (the
 * runtime owns per-knob defaults). `crew` is populated only on the crew
 * variant (the spec rejects `limits.crew` elsewhere).
 */
export type IrLimits = {
  readonly maxToolIterations?: number;
  readonly maxConcurrentTools?: number;
  readonly contextLimit?: number;
  readonly deadlineMs?: number;
  readonly turnTimeoutMs?: number;
  readonly modelCallTimeoutMs?: number;
  readonly loopDetection?: IrLoopDetection;
  readonly crew?: IrCrewLimits;
};

/**
 * Loop contract 0.4 (Batch A) — the hook-event names the spec accepts.
 * Mirrors `HookEvent` from `@crewhaus/hooks-engine` — the canonical list —
 * kept inline (exactly as `IrVectorBackend` mirrors vector-store's ids) so
 * the runtime-agnostic IR keeps its zero runtime-package dependencies. The
 * spec's `SPEC_HOOK_EVENTS` const carries the same list with a hooks-engine
 * cross-check test; keep all three in sync.
 */
export type IrHookEvent =
  | "session-start"
  | "stop"
  | "pre-tool"
  | "post-tool"
  | "pre-model"
  | "post-model"
  | "pre-compact"
  | "post-compact"
  | "pre-slash"
  | "alert";

/**
 * Loop contract 0.4 (Batch A) — one spec-declared lifecycle hook, lowered
 * from a `hooks:` entry (snake_case `timeout_ms` → `timeoutMs`). Same shape
 * as hooks-engine's `HookDef`, so emitters can concat these with the
 * settings.json-discovered hooks. Carried (as `hooks?: readonly IrHook[]`)
 * on the same shapes as {@link IrLimits}.
 */
export type IrHook = {
  readonly event: IrHookEvent;
  readonly matcher?: string;
  readonly command: string;
  readonly timeoutMs?: number;
};

/** Loop contract 0.4 (Batch A) — one tool's rate-limit tuning (sustained
 *  requests-per-minute + optional short-burst allowance). */
export type IrRateLimit = {
  readonly rpm: number;
  readonly burst?: number;
};

/**
 * Loop contract 0.4 (Batch A) — per-tool rate limits, lowered from
 * `agent.rate_limits` on the interactive shapes (IrV0/cli, IrChannelV0,
 * IrManagedV0). Keys are tool names or `"*"` (the catch-all bucket).
 * Absent when the spec omits the block.
 */
export type IrRateLimits = Readonly<Record<string, IrRateLimit>>;

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
  /** Item 23 — `switch-model` reroutes onto the next provider failover
   *  candidate mid-turn (see recovery-engine). */
  readonly recovery: "retry" | "compact" | "continue" | "tombstone" | "switch-model" | "fail";
  readonly hint?: string;
};

export type IrFailureTaxonomy = readonly IrFailureTaxonomyEntry[];

/**
 * Item 27 — run-level spend cap with a degradation ladder, lowered from the
 * spec's `budget` block. `usdMicros` is the dollar ceiling in USD-micros
 * (1 USD = 1_000_000) — the unit the runtime meters in. `onExceed` decides
 * the behaviour when accrued spend reaches the cap: `stop` ends the run
 * before the next turn; `degrade` re-resolves the primary model to `model`
 * (one cheaper rung) and continues. Carried on the interactive shapes that
 * loop (cli, channel, managed); absent when the spec omits the block.
 */
export type IrBudget = {
  readonly usdMicros: number;
  readonly onExceed:
    | { readonly kind: "stop" }
    | { readonly kind: "degrade"; readonly model: string };
};

/**
 * Loop contract 0.4 (Batch B, G02) — the grader selector inside
 * {@link IrEvaluation}, lowered 1:1 from `evaluation.grader`:
 *
 *   - `llm_judge` — a model scores the final text in [0,1] against
 *     `criteria`. `model` is the judge model id; when ABSENT the runtime
 *     uses the shape's primary model (the `cheapest` sentinel was already
 *     resolved at lower time, like `compaction.model`). Judge calls are
 *     METERED into the run budget.
 *   - `contains` / `regex` — deterministic pass/fail text checks (score 1
 *     on pass, 0 on fail; no model spend).
 */
export type IrEvaluationGrader =
  | { readonly type: "llm_judge"; readonly criteria: string; readonly model?: string }
  | { readonly type: "contains"; readonly value: string }
  | { readonly type: "regex"; readonly value: string };

/**
 * Loop contract 0.4 (Batch B, G02) — in-loop output evaluation, lowered
 * from the top-level `evaluation:` block on the interactive shapes
 * (IrV0/cli, IrChannelV0, IrManagedV0). After each completed assistant
 * turn the runtime scores the final text with `grader`; a score below
 * `threshold` triggers `onFail`:
 *
 *   - `retry` — re-prompt with the judge rationale appended as a system
 *     nudge, at most `maxRetries` times (retries are hard-capped and the
 *     judge/model calls metered into the run budget).
 *   - `halt`  — abort the turn with a classified `"evaluation"` failure.
 *   - `note`  — emit the `eval_graded` trace event only.
 *
 * `onFail`/`maxRetries` are RESOLVED at lower time (defaults `"retry"`/1)
 * so emitters and the interpreter read one deterministic shape.
 * `threshold` is present iff `grader.type === "llm_judge"` (RESOLVED
 * default 0.7) — deterministic graders are pass/fail and carry none.
 * Absent from the IR when the spec omits the block.
 */
export type IrEvaluation = {
  readonly grader: IrEvaluationGrader;
  /** Present iff `grader.type === "llm_judge"` (resolved default 0.7). */
  readonly threshold?: number;
  /** Resolved below-threshold behaviour (spec `on_fail`, default "retry"). */
  readonly onFail: "retry" | "halt" | "note";
  /** Resolved retry hard-cap (spec `max_retries`, default 1). */
  readonly maxRetries: number;
};

/**
 * Loop contract 0.4 (Batch B, G02) — the judge gate carried by
 * `kind: "judge"` workflow steps ({@link IrWorkflowStep}) and graph nodes
 * ({@link IrGraphNode}). The judge scores the PREVIOUS step's (workflow) /
 * upstream node's (graph) final output in [0,1] against `criteria`; below
 * `threshold`, `onFail` applies:
 *
 *   - `retry_previous` — re-run the gated step/node with the judge
 *     rationale appended as a system nudge, at most `maxRetries` times.
 *   - `halt`     — abort the run with a classified `"evaluation"` failure.
 *   - `continue` — record the `judge_verdict` trace event and proceed.
 *
 * All three knobs are RESOLVED at lower time (defaults 0.7 /
 * `"retry_previous"` / 1). The judge MODEL is not carried here: it lives
 * in the step's/node's existing `model` field, resolved at lower time as
 * `judge.model ?? <shape>.model` (exactly how regular steps resolve
 * theirs), so emitters read one model slot per step/node.
 */
export type IrJudge = {
  readonly criteria: string;
  /** Resolved passing score in [0,1] (spec `threshold`, default 0.7). */
  readonly threshold: number;
  /** Resolved below-threshold behaviour (spec `on_fail`,
   *  default "retry_previous"). */
  readonly onFail: "retry_previous" | "halt" | "continue";
  /** Resolved re-run hard-cap (spec `max_retries`, default 1). */
  readonly maxRetries: number;
};

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
  /**
   * Pillar 3 sink-side fabric (FR-006) — the egress-matching strategy.
   * `"substring"` is the behavior-preserving `SubstringEgressMatcher`
   * (`MIN_MATCH_LENGTH`); `"semantic"` selects the optional embedding-backed
   * `@crewhaus/egress-matcher-semantic`. Lowered from
   * `spec.security.egressMatcher`. Absent when the spec omits it, in which
   * case the runtime stays on the substring default. Honoured on BOTH paths:
   * the `crewhaus run` interpreter resolves it into
   * `runChatLoop({ egressMatcher })`, and `@crewhaus/target-cli` emits the
   * same matcher construction into the standalone compiled bundle. Only
   * changes *how* lineage matches are detected — the per-origin/per-sink
   * policy and the three audit outcomes (`egress-passed | egress-warned |
   * egress-blocked`) are matcher-independent and live in `classifyEgress`,
   * not here.
   */
  readonly egressMatcher?: "substring" | "semantic";
};

/**
 * Response-feedback config, lowered from `spec.feedback`. Declares that a
 * harness collects human ratings on responses. `modality` always resolves
 * (Zod defaults it to `"binary"`); the rest are optional. `channelReactions`
 * gates the channel target's codegen of Slack 👍/👎 → `user_feedback`. Carried
 * on the interactive shapes that consume it (IrV0/cli, IrChannelV0). Absent
 * when the spec omits the `feedback` block.
 */
export type IrFeedback = {
  readonly enabled?: boolean;
  readonly modality: "binary" | "stars" | "scale" | "comment";
  readonly scale?: { readonly min: number; readonly max: number };
  readonly storage?: { readonly location: string };
  readonly autoDistill?: boolean;
  /** Item 1 — gate for the CLI REPL's one-keystroke exit rating prompt.
   *  Absent → prompt (the block's presence opts in); `false` → never. */
  readonly exitPrompt?: boolean;
  readonly channelReactions?: boolean;
};

/**
 * v0.3.0 §3.1/§9 — the wiki (semantic tier) config, lowered from
 * `spec.memory.wiki`. Presence (with `enabled` not `false`) registers the
 * thredz-vocabulary `wiki_*` tools over `@crewhaus/wiki-store`. Every field
 * is carried only when the spec declared it (absent-when-omitted).
 */
export type IrMemoryWiki = {
  readonly enabled?: boolean;
  /** Wiki hits fused into auto-recall (1–50). */
  readonly recallK?: number;
  /** `@crewhaus/embedder` factory grammar — enables hybrid recall on both
   *  the wiki and the fact store. */
  readonly embedder?: string;
  /** Fuse wiki recall into the session-start memory bundle. */
  readonly autoRecall?: boolean;
  /** Learning-mode write governance: `wiki_write` rejects bodies without a
   *  `## Sources` heading. */
  readonly requireSources?: boolean;
};

/**
 * v0.3.0 Goal 5 (§6/§9) — scheduled memory consolidation, lowered from
 * `spec.memory.dream`. `every` is parsed to `everyMs` at lower time
 * (>= 5m enforced there); `mode` is RESOLVED at lower time (default
 * `"full"`) so emitters and the interpreter read one deterministic shape.
 * `budgetUsd`/`instructions` are carried only when declared — the model
 * phase runs only when `mode` is `"full"` AND `budgetUsd > 0`.
 */
export type IrMemoryDream = {
  /** Consolidation cadence in milliseconds (`spec.memory.dream.every`). */
  readonly everyMs: number;
  /** `deterministic` (no model, ever) | `full` (bounded model synthesis). */
  readonly mode: "deterministic" | "full";
  /** Item-27 spend cap for the model phase (USD). Absent or 0 =
   *  deterministic only. */
  readonly budgetUsd?: number;
  /** Playbook override; default = the builtin `dream` skill body. */
  readonly instructions?: string;
};

/**
 * Feature #53 — cross-session memory config, lowered from `spec.memory`.
 * Presence of the block wires Remember/Recall into the target; the auto-*
 * switches gate auto-capture (summarize durable outcomes at teardown) and
 * auto-recall (inject top-K memories into the system prompt at session start).
 * Carried on the agent-loop shapes (IrV0/cli, IrChannelV0, IrManagedV0,
 * IrResearchV0, IrCrewV0). Absent when the spec omits `memory`.
 *
 * v0.3.0 (§9) extensions, all absent-when-omitted: `backend` (`file` |
 * reserved `thredz`), `ttlMs` (explicit fact forgetting — `spec.memory.ttl`
 * parsed to milliseconds at lower time, >= 1h enforced there), `wiki`
 * (see {@link IrMemoryWiki}), and `dream` (see {@link IrMemoryDream}).
 */
export type IrMemory = {
  readonly enabled?: boolean;
  readonly backend?: "file" | "thredz";
  /** Loop contract 0.4 (Batch A) — top-level embedder for the FACT store
   *  (`@crewhaus/embedder` factory grammar, spec `memory.embedder`).
   *  Runtime fallback order: `embedder` → `wiki.embedder`. */
  readonly embedder?: string;
  readonly ttlMs?: number;
  readonly autoCapture?: boolean;
  readonly autoCaptureThreshold?: number;
  readonly autoRecall?: boolean;
  readonly recallK?: number;
  readonly wiki?: IrMemoryWiki;
  readonly dream?: IrMemoryDream;
};

/** v0.3.0 §2.7 — the RESOLVED continuity scope. `auto` is a compiler
 *  concern: `lower()` resolves it per shape (cli/research/crew/managed →
 *  `spec`, channel → `session`), so the IR never carries `auto`. */
export type IrContinuityScope = "spec" | "session";

/**
 * v0.3.0 Goal 1 (§2.1/§9) — continuity config, lowered from the top-level
 * `continuity:` block. THE release's one sanctioned default-on: on the five
 * emit-wired agent-loop shapes (IrV0/cli, IrChannelV0, IrManagedV0,
 * IrResearchV0, IrCrewV0) an ABSENT spec key lowers to the default-on config
 * below, and only `continuity: false` (or `enabled: false`) removes this
 * field — presence means enabled. Also carried, when the spec declares it,
 * on IrWorkflowV0/IrBatchV0/IrVoiceV0/IrBrowserV0, whose emitters print the
 * 0.2.3-convention ignored-note comment instead of wiring it.
 *
 * All fields except `focusMaxChars` are RESOLVED at lower time (defaults
 * filled in: plan/ledger/handoff true, proof "ladder", scope per §2.7), so
 * emitters and the interpreter read one deterministic shape.
 */
export type IrContinuity = {
  /** Plan/goal persistence + the Plan and Goal tool families; `false`
   *  keeps only FocusRead/FocusWrite + MemoryClear. */
  readonly plan: boolean;
  /** §2.4 proof-of-action: `ladder` (default) | `require` | `off`. */
  readonly proof: "ladder" | "require" | "off";
  /** §2.3 verbatim requirements ledger (context_evicted externalization). */
  readonly ledger: boolean;
  /** §2.8 deterministic teardown handoff.md. */
  readonly handoff: boolean;
  /** Resolved store scope (§2.7/§14.5). */
  readonly scope: IrContinuityScope;
  /** Hard cap on the mutable tail block. Absent → runtime default (4096). */
  readonly focusMaxChars?: number;
};

/**
 * v0.3.0 Goal 3 (§4.1/§9) — the Thredz config, lowered from the top-level
 * `thredz:` block (boolean/string shorthand or the object form — the spec
 * shorthands are RESOLVED at lower time so this carries one deterministic
 * shape). Presence means Thredz is on.
 *
 * The compiler additionally SYNTHESIZES an `mcp_servers.thredz` stdio entry
 * (`npx -y thredz-mcp@0.2.0` with `THREDZ_API_KEY` as an `IrSecretRef` env
 * value, riding the §4.2 secret machinery end-to-end) on the emit-wired
 * shape (cli). A user-declared `mcp_servers.thredz` wins over synthesis
 * (explicit beats implicit — `crewhaus lint` warns); this config block is
 * carried either way so the wiring layer (memory-service) still routes the
 * wiki backend and goal mirror through that server.
 */
export type IrThredzVisibility = "private" | "shared";

export type IrThredz = {
  /** The Thredz API key — credential-lowered (`$THREDZ_API_KEY` →
   *  `{ kind: "env" }`; fail-fast on a malformed `$…` ref). */
  readonly apiKey: IrSecretRef;
  /** Self-hosted / local API base (`THREDZ_API_BASE`). Absent → the hosted
   *  default inside thredz-mcp. */
  readonly baseUrl?: string;
  /** RESOLVED default `private` — becomes `THREDZ_DEFAULT_VISIBILITY`, so
   *  agent memory is never public by accident (Thredz's own API defaults
   *  new articles to globally-shared). */
  readonly visibility: IrThredzVisibility;
  /** RESOLVED — mirror continuity goal writes to Thredz `goal_write`/
   *  `goal_update` (spec-scoped only, §14.5 decision 5). Defaulted at lower
   *  time to "on when continuity goals are on". */
  readonly goals: boolean;
  /** Register this addressable agent handle at boot (idempotent
   *  `agent_register`). Absent → no registration (the default). */
  readonly agentName?: string;
};

/** v0.3.0 Goal 2 (§3.3, PR 17) — the first-class competency exam: dataset +
 *  graders paths, spec-relative. Whether the files EXIST is a runtime
 *  concern (the `run_exam` tool fails with a clear error); the compiler
 *  validates shape only. */
export type IrLearningExam = {
  /** Spec-relative path to the exam dataset (jsonl). */
  readonly dataset: string;
  /** Spec-relative path to the graders config (yaml). */
  readonly graders: string;
};

/** v0.3.0 Goal 2 (§3.3, PR 17) — unattended-study toggles, RESOLVED at lower
 *  time (both default true) so downstream reads one deterministic shape. */
export type IrLearningStudy = {
  /** Prepend the study-rotation preamble (gaps first, ~3:1 study:reflect,
   *  bounded per tick) to channel heartbeat instructions. */
  readonly onHeartbeat: boolean;
  /** Seed the dream model phase's findings with the top open knowledge gaps
   *  + the next unmastered curriculum rung. */
  readonly onDream: boolean;
};

/**
 * v0.3.0 Goal 2 (§3.3, PR 17) — continual-learning config, lowered from the
 * top-level `learning:` block. Presence means learning is ON (the compiler
 * dropped `enabled: false` at lower time). Learning REQUIRES a wiki —
 * `lower()` rejects the block without `memory.wiki` (local) or `thredz:`
 * (hosted) — and deterministically stamps `memory.wiki.requireSources: true`
 * (Sources-required write governance, what was prompt-only in the expert
 * demo).
 *
 * `domain`/`curriculum`/`sources` are substituted into the builtin
 * `learning-loop` skill body at wire time; `exam` drives the programmatic
 * `run_exam` tool; `study` carries the resolved unattended-study toggles.
 * Carried on the five memory shapes (IrV0/cli, IrChannelV0, IrManagedV0,
 * IrResearchV0, IrCrewV0).
 */
export type IrLearning = {
  /** One sentence naming the field of expertise. */
  readonly domain: string;
  /** Spec-relative path to the agent-editable curriculum ladder. Absent →
   *  the skill keeps the ladder in the wiki. */
  readonly curriculum?: string;
  /** Source-allowlist hints. NOT optimizable — allowlist = security (§7.5). */
  readonly sources?: readonly string[];
  readonly exam?: IrLearningExam;
  readonly study: IrLearningStudy;
};

/** Ops item 37 — a mitigation-ladder rung the runtime SLO monitor walks on a
 *  sustained breach, in declared order. See {@link IrSlo}. */
export type IrSloMitigation = "alert" | "pause-intake" | "rollback";

/**
 * Ops item 37 — production SLO targets + the mitigation ladder, lowered from
 * `spec.observability.slo`. Every target is optional (declare only the ones you
 * care about); an omitted target is never evaluated by the monitor. `windowMs`
 * is the rolling window a breach must persist before the ladder fires (spec's
 * `window_seconds` × 1000; the monitor defaults it when absent). `mitigation`
 * defaults to `["alert"]` at lower time so an observe-only spec still warns.
 * Absent from the IR when the spec omits the block.
 */
export type IrSlo = {
  readonly errorRate?: number;
  readonly p95LatencyMs?: number;
  readonly ttftMs?: number;
  readonly costPerHourUsd?: number;
  readonly egressBlockRate?: number;
  readonly windowMs?: number;
  readonly mitigation: ReadonlyArray<IrSloMitigation>;
};

/**
 * Ops item 37 — cross-cutting observability config, lowered from
 * `spec.observability`. Today it carries one sub-block, `slo`. Carried on the
 * interactive/daemon shapes that run a chat loop (IrV0/cli, IrChannelV0,
 * IrManagedV0). Absent when the spec omits the `observability` block.
 */
export type IrObservability = {
  readonly slo?: IrSlo;
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
    /** Model max OUTPUT tokens for one turn (spec `agent.max_tokens`).
     *  Optional; when absent the runtime default applies. */
    readonly maxTokens?: number;
    /** Loop contract 0.4 (Batch A) — extended-thinking selector (spec
     *  `agent.thinking`). Absent when the spec omits the block. */
    readonly thinking?: IrThinking;
    /** Loop contract 0.4 (Batch A) — stream partial output tokens (spec
     *  `agent.streaming`, cli shape only). Carried verbatim only when
     *  declared; absent means false. */
    readonly streaming?: boolean;
    /** Loop contract 0.4 (Batch A) — per-tool rate limits (spec
     *  `agent.rate_limits`). Absent when the spec omits the block. */
    readonly rateLimits?: IrRateLimits;
    /** Item 22 — ordered failover models (spec `agent.model_fallbacks`).
     *  Absent when the spec omits the block; the runtime then keeps its
     *  single-adapter path. */
    readonly modelFallbacks?: readonly string[];
    /** Item 22 — breaker tuning (spec `agent.circuit_breaker`). */
    readonly circuitBreaker?: IrCircuitBreaker;
    /** Item 26 — two-tier turn-difficulty router. Absent → single-model. */
    readonly modelTiers?: IrModelTiers;
    /** Adaptive model routing — N-candidate pool. Absent → single-model. */
    readonly modelPool?: IrModelPool;
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
  /** Item 27 — run-level spend cap + degradation ladder. Optional. */
  readonly budget?: IrBudget;
  /** Loop contract 0.4 (Batch A) — hard runtime ceilings. Optional; absent
   *  when the spec omits the `limits` block. */
  readonly limits?: IrLimits;
  /** Loop contract 0.4 (Batch A) — spec-declared lifecycle hooks. Optional;
   *  absent when the spec omits the `hooks` block. */
  readonly hooks?: readonly IrHook[];
  /** Loop contract 0.4 (Batch B, G02) — in-loop output evaluation.
   *  Optional; absent when the spec omits the `evaluation` block. */
  readonly evaluation?: IrEvaluation;
  /** Pillar 3 (FR-004) — security fabric config (intent-gate judge
   *  selection). Optional; absent when the spec omits the `security`
   *  block. */
  readonly security?: IrSecurity;
  /** Response-feedback config. Optional; absent when the spec omits `feedback`. */
  readonly feedback?: IrFeedback;
  /** #53 cross-session memory config. Optional; absent when the spec omits `memory`. */
  readonly memory?: IrMemory;
  /** v0.3.0 Goal 1 — continuity config. DEFAULT-ON: present unless the spec
   *  opted out with `continuity: false`. */
  readonly continuity?: IrContinuity;
  /** v0.3.0 Goal 3 — Thredz config. Present when the spec declares `thredz:`;
   *  the compiler also synthesizes `mcp_servers.thredz` on this shape. */
  readonly thredz?: IrThredz;
  /** v0.3.0 Goal 2 — continual-learning config (§3.3, PR 17). Present
   *  when the spec declares an enabled `learning:` block. */
  readonly learning?: IrLearning;
  /** Ops item 37 — SLO targets + mitigation ladder. Optional; absent when the
   *  spec omits the `observability` block. */
  readonly observability?: IrObservability;
  /** §47 cross-cutting blockchain subsystem (slice 0). All optional. */
  readonly chains?: readonly IrChainBinding[];
  readonly wallets?: readonly IrWalletBinding[];
  readonly contracts?: readonly IrContractBinding[];
  readonly transactionPolicy?: IrTransactionPolicy;
};

/**
 * One step in a workflow IR. `model` is resolved at lower-time
 * (`step.model ?? workflow.model`) so codegen can read it directly.
 *
 * Loop contract 0.4 (Batch B, G02) — a step may be a JUDGE GATE
 * (`kind: "judge"`) over the previous step's output. Judge steps keep the
 * full step shape so every existing consumer compiles and iterates
 * unchanged: `instructions` carries the judge `criteria` verbatim, `model`
 * is the resolved judge model (`judge.model ?? workflow.model`), and
 * `tools`/`toolConfigs` are empty. Emitters/interpreters branch on
 * `kind === "judge"` and read the gate config from `judge`.
 */
export type IrWorkflowStep = {
  readonly name: string;
  readonly instructions: string;
  readonly model: string;
  /** Model max OUTPUT tokens for this step's turn (spec `steps[].max_tokens`).
   *  Optional; when absent the runtime default applies. */
  readonly maxTokens?: number;
  /** Loop contract 0.4 (Batch A) — per-step extended-thinking selector
   *  (spec `steps[].thinking`). Absent when the spec omits the block. */
  readonly thinking?: IrThinking;
  readonly tools: readonly string[];
  readonly toolConfigs: IrToolConfigs;
  /** Loop contract 0.4 (Batch B, G02) — `"judge"` marks a gate step over
   *  the previous step's output. ABSENT on regular agent steps. */
  readonly kind?: "judge";
  /** Present iff `kind === "judge"` — the resolved gate config. */
  readonly judge?: IrJudge;
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
  /** Item 27 — run-level spend cap + degradation ladder (Batch A extends it
   *  to this shape). Optional. */
  readonly budget?: IrBudget;
  /** Loop contract 0.4 (Batch A) — hard runtime ceilings. Optional. */
  readonly limits?: IrLimits;
  /** Loop contract 0.4 (Batch A) — spec-declared lifecycle hooks. Optional. */
  readonly hooks?: readonly IrHook[];
  /** v0.3.0 — carried when the spec declares `continuity:` (NOT default-on
   *  here); target-workflow prints the ignored-note comment. */
  readonly continuity?: IrContinuity;
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
 * `automated` custody, which the §47 IR pass enforces. `maxValueWei`
 * is an upper bound on native-token transfers (in wei, the oracle-free
 * spend ceiling enforced by wallet-engine); transactions exceeding the
 * cap are rejected pre-broadcast. (`maxValueUsd` cannot be enforced —
 * there is no price oracle in this build, so it hard-throws at runtime;
 * use `maxValueWei`.) `allowedContracts` is a list of
 * `IrContractBinding.id` values — destructive calls to any other
 * contract are rejected. `simulationRequired: true` forces every
 * destructive call through a fork-simulator before approval.
 */
export type IrTransactionPolicy = {
  readonly defaultWriteApproval: "required" | "policy" | "none";
  readonly maxValueUsd?: number;
  /** Oracle-free native-token spend ceiling (wei, decimal or 0x-hex string). */
  readonly maxValueWei?: string;
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
    /** Model max OUTPUT tokens for one turn (spec `agent.max_tokens`).
     *  Optional; when absent the runtime default applies. */
    readonly maxTokens?: number;
    /** Loop contract 0.4 (Batch A) — extended-thinking selector (spec
     *  `agent.thinking`). Absent when the spec omits the block. */
    readonly thinking?: IrThinking;
    /** Loop contract 0.4 (Batch A) — per-tool rate limits (spec
     *  `agent.rate_limits`). Absent when the spec omits the block. */
    readonly rateLimits?: IrRateLimits;
    /** Item 22 — ordered failover models (spec `agent.model_fallbacks`). */
    readonly modelFallbacks?: readonly string[];
    /** Item 22 — breaker tuning (spec `agent.circuit_breaker`). */
    readonly circuitBreaker?: IrCircuitBreaker;
    /** Item 26 — two-tier turn-difficulty router. Absent → single-model. */
    readonly modelTiers?: IrModelTiers;
    /** Adaptive model routing — N-candidate pool. Absent → single-model. */
    readonly modelPool?: IrModelPool;
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
  /** Item 27 — run-level spend cap + degradation ladder. Optional. */
  readonly budget?: IrBudget;
  /** Loop contract 0.4 (Batch A) — hard runtime ceilings. Optional. */
  readonly limits?: IrLimits;
  /** Loop contract 0.4 (Batch A) — spec-declared lifecycle hooks. Optional. */
  readonly hooks?: readonly IrHook[];
  /** Loop contract 0.4 (Batch B, G02) — in-loop output evaluation.
   *  Optional; absent when the spec omits the `evaluation` block. */
  readonly evaluation?: IrEvaluation;
  /** Response-feedback config. `feedback.channelReactions` gates Slack 👍/👎
   *  → user_feedback codegen in this target. Absent when spec omits it. */
  readonly feedback?: IrFeedback;
  /** #53 cross-session memory config. Optional; absent when the spec omits `memory`. */
  readonly memory?: IrMemory;
  /** v0.3.0 Goal 1 — continuity config. DEFAULT-ON: present unless the spec
   *  opted out with `continuity: false`. `scope` resolves to `session` here
   *  (per-conversation stores riding the session router's sessionId, §14.5). */
  readonly continuity?: IrContinuity;
  /** v0.3.0 Goal 3 — Thredz config, CARRIED but not emit-wired on this shape
   *  in this release (the emitter prints the ignored-note comment). */
  readonly thredz?: IrThredz;
  /** v0.3.0 Goal 2 — continual-learning config (§3.3, PR 17). Present
   *  when the spec declares an enabled `learning:` block. */
  readonly learning?: IrLearning;
  /** Ops item 37 — SLO targets + mitigation ladder. Optional; absent when the
   *  spec omits the `observability` block. */
  readonly observability?: IrObservability;
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
    /** Model max OUTPUT tokens for one turn (spec `agent.max_tokens`).
     *  Optional; when absent the runtime default applies. */
    readonly maxTokens?: number;
    /** Loop contract 0.4 (Batch A) — extended-thinking selector (spec
     *  `agent.thinking`). Absent when the spec omits the block. */
    readonly thinking?: IrThinking;
    /** Loop contract 0.4 (Batch A) — per-tool rate limits (spec
     *  `agent.rate_limits`). Absent when the spec omits the block. */
    readonly rateLimits?: IrRateLimits;
    /** Item 22 — ordered failover models (spec `agent.model_fallbacks`). */
    readonly modelFallbacks?: readonly string[];
    /** Item 22 — breaker tuning (spec `agent.circuit_breaker`). */
    readonly circuitBreaker?: IrCircuitBreaker;
    /** Item 26 — two-tier turn-difficulty router. Absent → single-model. */
    readonly modelTiers?: IrModelTiers;
    /** Adaptive model routing — N-candidate pool. Absent → single-model. */
    readonly modelPool?: IrModelPool;
  };
  readonly tenants: readonly IrManagedTenant[];
  readonly permissions: IrPermissions;
  readonly compaction: IrCompaction;
  /** Section 55 (Track A) — named failure taxonomy. Optional. */
  readonly failureTaxonomy?: IrFailureTaxonomy;
  /** Item 27 — run-level spend cap + degradation ladder. Optional. */
  readonly budget?: IrBudget;
  /** Loop contract 0.4 (Batch A) — hard runtime ceilings. Optional. */
  readonly limits?: IrLimits;
  /** Loop contract 0.4 (Batch A) — spec-declared lifecycle hooks. Optional. */
  readonly hooks?: readonly IrHook[];
  /** Loop contract 0.4 (Batch B, G02) — in-loop output evaluation.
   *  Optional; absent when the spec omits the `evaluation` block. */
  readonly evaluation?: IrEvaluation;
  /** #53 cross-session memory config. Optional; absent when the spec omits `memory`. */
  readonly memory?: IrMemory;
  /** v0.3.0 Goal 1 — continuity config. DEFAULT-ON: present unless the spec
   *  opted out with `continuity: false`. `scope` resolves to `spec` here;
   *  every store is tenant-fenced at boot (deps carry the tenant, §2.7). */
  readonly continuity?: IrContinuity;
  /** v0.3.0 Goal 3 — Thredz config, CARRIED but not emit-wired on this shape
   *  in this release (the emitter prints the ignored-note comment). */
  readonly thredz?: IrThredz;
  /** v0.3.0 Goal 2 — continual-learning config (§3.3, PR 17). Present
   *  when the spec declares an enabled `learning:` block. */
  readonly learning?: IrLearning;
  /** Ops item 37 — SLO targets + mitigation ladder. Optional; absent when the
   *  spec omits the `observability` block. The managed daemon's `pause-intake`
   *  rung reuses its `budget_exceeded` 429 path. */
  readonly observability?: IrObservability;
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
  /** Model max OUTPUT tokens for this node's turn (spec
   *  `nodes.<n>.max_tokens`). Optional; runtime default when absent. */
  readonly maxTokens?: number;
  /** Loop contract 0.4 (Batch A) — per-node extended-thinking selector
   *  (spec `nodes.<n>.thinking`). Absent when the spec omits the block. */
  readonly thinking?: IrThinking;
  readonly tools: readonly string[];
  readonly toolConfigs: IrToolConfigs;
  /**
   * When set, the node calls `ctx.requestApproval(prompt)` after the
   * LLM turn and pauses the graph until `resume(checkpointId, decision)`.
   */
  readonly hitlPrompt?: string;
  /** Loop contract 0.4 (Batch B, G02) — `"judge"` marks a gate node over
   *  its upstream node's output. ABSENT on regular LLM nodes. Judge nodes
   *  keep the full node shape (`instructions` = the judge criteria, `model`
   *  = resolved `judge.model ?? graph.model`, empty `tools`) so existing
   *  consumers compile unchanged; branch on `kind` and read `judge`. */
  readonly kind?: "judge";
  /** Present iff `kind === "judge"` — the resolved gate config. */
  readonly judge?: IrJudge;
};

/**
 * Loop contract 0.4 (Batch A) — declarative edge predicate over the graph's
 * shared state, lowered 1:1 from `edges[].when`. `key` names an upstream
 * NODE whose recorded output (`state["<nodeName>"]`) the predicate reads
 * (parse-validated; the ir-passes wellformedness check re-verifies for
 * direct-IR builders). Exactly one of `equals`/`exists` is ever present.
 * Emitters lower it onto a graph-engine `EdgeCondition`:
 * `(state) => state[key] === equals` / `(state) => state[key] !== undefined`.
 */
export type IrGraphEdgeWhen = {
  readonly key: string;
  readonly equals?: string | number | boolean;
  readonly exists?: true;
};

export type IrGraphEdge = {
  readonly from: string;
  readonly to: string;
  /** Loop contract 0.4 (Batch A) — declarative predicate gating this edge.
   *  Absent means the edge matches unconditionally (the engine takes the
   *  first matching edge in declaration order). */
  readonly when?: IrGraphEdgeWhen;
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
  /** Loop contract 0.4 (Batch A) — parallel barrier groups (>= 2 node names
   *  each), lowered verbatim from the spec's `parallel` and emitted as
   *  graph-engine `addParallel` calls. A group executes concurrently when
   *  the cursor reaches its FIRST member; execution continues from the LAST
   *  member's outgoing edge. Absent when the spec omits the block. */
  readonly parallel?: ReadonlyArray<ReadonlyArray<string>>;
  /** Track F (Section 57) — named message schemas referenced by edges.
   *  Absent means no typed edges (all `untyped` by default). */
  readonly messageSchemas?: readonly IrMessageSchema[];
  readonly permissions: IrPermissions;
  readonly compaction: IrCompaction;
  /** Section 55 (Track A) — named failure taxonomy. Optional. */
  readonly failureTaxonomy?: IrFailureTaxonomy;
  /** Item 27 — run-level spend cap + degradation ladder (Batch A extends it
   *  to this shape). Optional. */
  readonly budget?: IrBudget;
  /** Loop contract 0.4 (Batch A) — hard runtime ceilings. Optional. */
  readonly limits?: IrLimits;
  /** Loop contract 0.4 (Batch A) — spec-declared lifecycle hooks. Optional. */
  readonly hooks?: readonly IrHook[];
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

/**
 * Vector-store backend selector. Mirrors `VectorBackendId` from
 * `@crewhaus/vector-store` — the canonical source of truth for which
 * backends exist — but kept inline here (exactly as `IrBatchQueueAdapter`
 * mirrors the `queue-protocol` adapter ids) so the runtime-agnostic IR
 * keeps its zero runtime-package dependencies. Keep the two in sync when a
 * backend is added or removed.
 */
export type IrVectorBackend = "in-memory" | "lance" | "qdrant" | "pinecone" | "weaviate";

export type IrPipelineV0 = {
  readonly version: 0;
  readonly name: string;
  readonly target: "pipeline";
  readonly agent: {
    readonly model: string;
    readonly instructions: string;
    /** Adaptive model routing — N-candidate pool. Absent → single-model. */
    readonly modelPool?: IrModelPool;
  };
  readonly retrieve: {
    readonly embedderModel: string;
    readonly vectorBackend: IrVectorBackend;
    readonly defaultK: number;
    /**
     * Remote (qdrant/pinecone/weaviate) and file (lance) backends — the
     * service base URL or, for lance, the on-disk index path. Omitted for
     * `in-memory`. Required for the HTTP backends (enforced at spec parse).
     */
    readonly url?: string;
    /** Remote/file backends — collection / table name. */
    readonly collection?: string;
    /**
     * Remote backends — API key, lowered to an env-ref (`$VAR` →
     * `process.env`) or a literal so real secrets stay out of the bundle.
     */
    readonly apiKey?: IrSecretRef;
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
  /** Model max OUTPUT tokens for this role's turns (spec
   *  `roles.<r>.max_tokens`). Optional; runtime default when absent. */
  readonly maxTokens?: number;
  /** Loop contract 0.4 (Batch A) — per-role extended-thinking selector
   *  (spec `roles.<r>.thinking`). Absent when the spec omits the block. */
  readonly thinking?: IrThinking;
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
  /** Item 27 — run-level spend cap + degradation ladder (Batch A extends it
   *  to this shape). Optional. */
  readonly budget?: IrBudget;
  /** Loop contract 0.4 (Batch A) — hard runtime ceilings. The crew shape is
   *  the one place `limits.crew` (orchestration ceilings) can be populated.
   *  Optional. */
  readonly limits?: IrLimits;
  /** Loop contract 0.4 (Batch A) — spec-declared lifecycle hooks. Optional. */
  readonly hooks?: readonly IrHook[];
  /** #53/v0.3.0 — cross-session memory config (crew joins the carrying
   *  shapes in 0.3.0; roles share the spec-scoped store). Optional. */
  readonly memory?: IrMemory;
  /** v0.3.0 Goal 1 — continuity config. DEFAULT-ON: present unless the spec
   *  opted out with `continuity: false`. Roles share the `spec`-scoped plan
   *  store — the plan IS the coordination surface (§2.7). */
  readonly continuity?: IrContinuity;
  /** v0.3.0 Goal 3 — Thredz config, CARRIED but not emit-wired on this shape
   *  in this release (the emitter prints the ignored-note comment). */
  readonly thredz?: IrThredz;
  /** v0.3.0 Goal 2 — continual-learning config (§3.3, PR 17). Present
   *  when the spec declares an enabled `learning:` block. */
  readonly learning?: IrLearning;
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
    /** Model max OUTPUT tokens for one turn (spec `agent.max_tokens`).
     *  Optional; when absent the runtime default applies. */
    readonly maxTokens?: number;
    /** Adaptive model routing — N-candidate pool. Absent → single-model. */
    readonly modelPool?: IrModelPool;
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
    readonly vectorBackend?: IrVectorBackend;
  };
  readonly tools: readonly string[];
  readonly toolConfigs: IrToolConfigs;
  readonly mcp_servers: IrMcpServers;
  readonly permissions: IrPermissions;
  readonly compaction: IrCompaction;
  /** Section 55 (Track A) — named failure taxonomy. Optional. */
  readonly failureTaxonomy?: IrFailureTaxonomy;
  /** Item 27 — run-level spend cap + degradation ladder (Batch A extends it
   *  to this shape). Optional. */
  readonly budget?: IrBudget;
  /** Loop contract 0.4 (Batch A) — hard runtime ceilings. Optional. */
  readonly limits?: IrLimits;
  /** Loop contract 0.4 (Batch A) — spec-declared lifecycle hooks. Optional. */
  readonly hooks?: readonly IrHook[];
  /** #53 cross-session memory config. Optional; absent when the spec omits `memory`. */
  readonly memory?: IrMemory;
  /** v0.3.0 Goal 1 — continuity config. DEFAULT-ON: present unless the spec
   *  opted out with `continuity: false`. `scope` resolves to `spec` here. */
  readonly continuity?: IrContinuity;
  /** v0.3.0 Goal 3 — Thredz config, CARRIED but not emit-wired on this shape
   *  in this release (the emitter prints the ignored-note comment). */
  readonly thredz?: IrThredz;
  /** v0.3.0 Goal 2 — continual-learning config (§3.3, PR 17). Present
   *  when the spec declares an enabled `learning:` block. */
  readonly learning?: IrLearning;
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
    /** Model max OUTPUT tokens for one turn (spec `agent.max_tokens`).
     *  Optional; when absent the runtime default applies. */
    readonly maxTokens?: number;
    /** Adaptive model routing — N-candidate pool. Absent → single-model. */
    readonly modelPool?: IrModelPool;
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
  /** Item 27 — run-level spend cap + degradation ladder (Batch A extends it
   *  to this shape). Optional. */
  readonly budget?: IrBudget;
  /** Loop contract 0.4 (Batch A) — hard runtime ceilings. Optional. */
  readonly limits?: IrLimits;
  /** Loop contract 0.4 (Batch A) — spec-declared lifecycle hooks. Optional. */
  readonly hooks?: readonly IrHook[];
  /** v0.3.0 — carried when the spec declares `continuity:` (NOT default-on
   *  here); target-batch-worker prints the ignored-note comment. */
  readonly continuity?: IrContinuity;
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
  /** v0.3.0 — carried when the spec declares `continuity:` (NOT default-on
   *  here); target-voice prints the ignored-note comment. */
  readonly continuity?: IrContinuity;
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
    /** Model max OUTPUT tokens for one turn (spec `agent.max_tokens`).
     *  Optional; when absent the runtime default applies. */
    readonly maxTokens?: number;
    /** Adaptive model routing — N-candidate pool. Absent → single-model. */
    readonly modelPool?: IrModelPool;
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
  /** Item 27 — run-level spend cap + degradation ladder (Batch A extends it
   *  to this shape). Optional. */
  readonly budget?: IrBudget;
  /** Loop contract 0.4 (Batch A) — hard runtime ceilings. Optional. */
  readonly limits?: IrLimits;
  /** Loop contract 0.4 (Batch A) — spec-declared lifecycle hooks. Optional. */
  readonly hooks?: readonly IrHook[];
  /** v0.3.0 — carried when the spec declares `continuity:` (NOT default-on
   *  here); target-browser-driver prints the ignored-note comment. */
  readonly continuity?: IrContinuity;
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

// Generated-bundle README renderer (item 42) — pure functions over the IR,
// shared by every target emitter. See ./readme.ts for the module docs.
export {
  type BundleReadmeOptions,
  type BundleReadmeSection,
  type CollectedSecretRefs,
  type EmitReadmeOptions,
  GENERATED_README_MARKER,
  collectSecretRefs,
  renderBundleReadme,
} from "./readme";

// Loop contract 0.4 (Batch B, G42) — the canonical agent-loop projection
// (`projectLoop(ir)`), whose LoopProjection shape is the wire contract
// shared with the studio's /builder page and the compiler-worker's
// `POST /loop` endpoint. See ./loop.ts for the module docs.
export {
  CANVAS_TARGETS,
  type LoopCanvas,
  type LoopEdge,
  type LoopNode,
  type LoopNodeKind,
  type LoopProjection,
  type LoopRing,
  type LoopSegment,
  type LoopSegmentId,
  NO_BUDGET_WARNING,
  PERCEIVE_TOOL_RE,
  RING_TARGETS,
  SEGMENT_ORDER,
  projectLoop,
} from "./loop";
