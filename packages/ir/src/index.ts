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
  /**
   * Loop contract 0.4 (Batch C, G11) — what an `ask` permission does on a
   * NON-interactive surface: `"pause"` parks the turn as a `PendingApproval`
   * (the SAFE default), `"deny"` collapses the ask to a denial in place (the
   * pre-0.4 behaviour). ABSENT MEANS `"pause"` — the runtime resolves the
   * default with `permissions.askMode ?? "pause"`, so the safe direction
   * holds even when no `permissions:` block is declared. Carried only when
   * the spec sets it explicitly (mirrors `mode`), keeping the IR minimal and
   * byte-stable for the emitters that don't read it. NOT optimizer-reachable
   * (a safety control — excluded from `OPTIMIZABLE_PATHS`).
   */
  readonly askMode?: "pause" | "deny";
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
  /** #406 — present (false) ONLY when the spec opted out of fail-fast
   *  (`required: false`): a failed boot connect degrades + retries instead
   *  of exiting. Absent = required, byte-identical to pre-#406. */
  readonly required?: false;
};

export type IrMcpSseConfig = {
  readonly transport: "sse";
  readonly url: string;
  readonly headers?: Readonly<Record<string, IrSecretRef>>;
  /** #406 — see {@link IrMcpStdioConfig.required}. */
  readonly required?: false;
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
  /**
   * Item 2 (G31 — A2A federation) — present when the spec wires this
   * sub-agent to a REMOTE peer (`sub_agents.<name>.federation.url`). The
   * spawner routes the Task call through `@crewhaus/federation-router` to the
   * peer's inbound A2A handler instead of spawning locally. Absent → the
   * sub-agent is spawned in-process as before.
   */
  readonly federation?: { readonly url: string };
  /** 0.6.0 §4.2 — provenance: the `models:` profile `model` resolved from. */
  readonly modelProfile?: string;
  /** 0.6.0 §7.7 — the child's own request params (spec `thinking` /
   *  `max_tokens` / `temperature`, or the referenced profile's). */
  readonly thinking?: IrThinking;
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** 0.6.0 §7.7 — per-sub-agent model routing (the agent block's quartet). */
  readonly modelFallbacks?: readonly string[];
  readonly circuitBreaker?: IrCircuitBreaker;
  readonly modelTiers?: IrModelTiers;
  readonly modelPool?: IrModelPool;
  /** 0.6.0 §7.7 — fraction of the parent's `budget.usd` this child may spend. */
  readonly budgetShare?: number;
  /** 0.6.0 §7.7 — inherit the parent's SERVED arm instead of the declared
   *  primary (default false keeps today's declared-primary behaviour). */
  readonly inheritRouting?: boolean;
  /** 0.6.0 §7.7 — profile names (no `$`) the Task tool's `profile` argument
   *  may name for this child. */
  readonly allowedProfiles?: readonly string[];
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
  /** 0.6.0 §4.2 — provenance: the `models:` profile `model` resolved from. */
  readonly modelProfile?: string;
  /** 0.6.0 §4.2 — the profile's pinned request params (autocompact builds its
   *  own request). Present only when the profile declares any. */
  readonly params?: IrModelParams;
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

/**
 * 0.6.0 §4.2 — the per-model request parameters a `models:` profile can pin
 * on an AUXILIARY slot (judge / compaction / degrade / security / watchme),
 * where the consumer builds its own provider request. Carried ONLY when the
 * slot resolved through a profile that declares them; absent otherwise.
 */
export type IrModelParams = {
  readonly thinking?: IrThinking;
  readonly maxTokens?: number;
  readonly temperature?: number;
};

/**
 * 0.6.0 §5.4 — the RESTRICTED per-profile permission schema: `deny` and
 * `ask` ONLY. A profile can narrow the shape's permissions (decision-level
 * meet: deny < ask < allow), never widen them — the spec rejects
 * `alwaysAllow` / `mode` / `ask_mode`, and `modelPlanIntegrity` re-pins the
 * shape for direct-IR builders.
 */
export type IrProfilePermissions = {
  readonly deny?: readonly string[];
  readonly ask?: readonly string[];
};

/**
 * 0.6.0 §7.11 (N1) — what a profile REQUIRES of its own model. The four
 * feature flags mirror `ProviderFeatures`; the two size floors are spelled
 * as floors (`…Gte`). Structurally `@crewhaus/cost-tracker`'s
 * `CapabilityRequirement` and `@crewhaus/model-plan`'s `FeatureRequirement`,
 * so one value serves the compile-time twin and the runtime gate.
 */
export type IrModelRequires = {
  readonly tool_use?: boolean;
  readonly vision?: boolean;
  readonly thinking?: boolean;
  readonly web_search?: boolean;
  readonly contextWindowGte?: number;
  readonly maxOutputTokensGte?: number;
};

/**
 * 0.6.0 §4.1 — a DECLARED capability override for a model the offline
 * capability table does not know (local / azure / named hosts). Flat, every
 * field optional: an unknown fact never satisfies a requirement on it.
 */
export type IrModelCapabilities = {
  readonly tool_use?: boolean;
  readonly vision?: boolean;
  readonly thinking?: boolean;
  readonly web_search?: boolean;
  readonly caching?: "explicit" | "automatic" | false;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
};

/**
 * 0.6.0 §4.2 — one resolved model profile: the lower-time expansion of a
 * `models:` entry, and the settings a `model_pool` candidate carries inline.
 * Every field but `model` is optional, and a profile-less candidate is a bare
 * `{ model, tags }` with every key here absent — which is exactly why
 * existing pools lower and emit byte-identically. `profile` is the registry
 * name (provenance AND the scoreboard arm identity, §7.9); `overlay` is the
 * per-model instructions overlay appended in the volatile prompt region when
 * this candidate serves; `tools` is SUBSET-ONLY (builtin keys as the spec
 * spells them, `mcp__<server>__*` globs, `Consult` / `Escalate`; `[]` means
 * zero shape tools); `costCapUsdMicros` is the per-profile cap inside a run.
 * `$` never appears in an IR model string — references are resolved here.
 */
export type IrModelProfile = {
  readonly profile?: string;
  readonly model: string;
  readonly tags?: readonly string[];
  readonly thinking?: IrThinking;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly modelCallTimeoutMs?: number;
  readonly overlay?: string;
  readonly tools?: readonly string[];
  readonly toolConfigs?: IrToolConfigs;
  readonly permissions?: IrProfilePermissions;
  readonly rateLimits?: IrRateLimits;
  readonly caching?: "prefer" | "off";
  readonly costCapUsdMicros?: number;
  readonly requires?: IrModelRequires;
  readonly capabilities?: IrModelCapabilities;
  readonly fallbacks?: readonly string[];
  readonly circuitBreaker?: IrCircuitBreaker;
};

/**
 * 0.6.0 §4.2 — the `models:` registry as lowered: profile name → resolved
 * profile (sentinels resolved by price rank, every snake_case key renamed).
 * Present on a variant ONLY when the spec declares `models:`; emitters never
 * read it (README / loop projection / `models explain` do), so an absent
 * registry keeps every bundle byte-identical.
 */
export type IrModelProfiles = Readonly<Record<string, IrModelProfile>>;

/**
 * One declared candidate in a `model_pool`. 0.6.0 §4.2: a profile plus the
 * routing identity `tags` (always present — the spec defaults them; a
 * `$profile` candidate inherits the profile's tags when it declares none)
 * and `enabled: false`, which withdraws the candidate from routing without
 * deleting its learned history. The lowering inserts `model` then `tags`
 * FIRST and spreads every 0.6.0 key after them, so `JSON.stringify` of a
 * plain candidate is byte-identical to 0.5.x (the key-order guard).
 */
export type IrModelPoolCandidate = IrModelProfile & {
  readonly tags: readonly string[];
  readonly enabled?: false;
};

/** 0.6.0 §7.2.2 — the `when:` clause of a route rule (spec keys verbatim — the
 *  runtime's `evaluateRules` in `@crewhaus/model-plan` reads this shape). */
export type IrModelPoolRuleWhen = {
  readonly has_images?: boolean;
  readonly message_matches?: string;
  readonly user_text_chars_gt?: number;
  readonly context_tokens_gt?: number;
  readonly tool_in_play?: boolean;
  readonly channel?: string;
  readonly budget_spent_ratio_gt?: number;
  readonly turn_index_lt?: number;
};

/**
 * 0.6.0 §7.2.2 — one rule-directed routing rule, evaluated first-match in
 * `preRoute` before the policy. `use` names a candidate tag, a roster arm id
 * (a `$profile` reference lowers to its profile name — the arm identity), or
 * a capability requirement the turn's candidates must satisfy.
 */
export type IrModelPoolRule = {
  readonly id: string;
  readonly when: IrModelPoolRuleWhen;
  readonly use: string | { readonly requires: IrModelRequires };
  readonly enabled?: boolean;
};

/** 0.6.0 §7.2.3 — `policy: classifier`: a forced-tool single call whose
 *  verdict is constrained to the roster's tags. */
export type IrModelPoolClassifier = {
  readonly model: string;
  readonly modelProfile?: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly maxTokens?: number;
};

/**
 * 0.6.0 §7.3–§7.8 — the hybrid strategy block. Role slots (`draft`,
 * `escalateTo`, `members`, `escalateOnDisagreement`) name a candidate tag or
 * a roster arm id; model slots (`guide.model`, `shadow.candidate`,
 * `shadow.gradeWith`, `committee.judge`) are resolved model strings with
 * their profile provenance beside them.
 */
export type IrModelPoolStrategy = {
  readonly cascade?: {
    readonly draft: string;
    readonly escalateTo: string;
    readonly cleanPrompt?: boolean;
  };
  readonly guide?: {
    readonly model: string;
    readonly modelProfile?: string;
    readonly every?: "first_turn" | "turn";
    readonly maxTokens?: number;
    readonly budgetUsd?: number;
  };
  readonly shadow?: {
    readonly candidate: string;
    readonly candidateProfile?: string;
    readonly sampleRate?: number;
    readonly gradeWith?: string;
    readonly gradeWithProfile?: string;
  };
  readonly committee?: {
    readonly members: readonly string[];
    readonly judge?: string;
    readonly judgeProfile?: string;
    readonly escalateOnDisagreement?: string;
  };
  readonly modelDirected?: boolean;
  readonly maxEscalations?: number;
};

/** 0.6.0 §6.3, §7.10 — the reward block (a sibling of `learning`; nothing
 *  here is optimizer-tunable). */
export type IrModelPoolReward = {
  readonly qualitySource?: "none" | "in_loop" | "shadow" | "promoted";
  readonly priors?: "none" | "eval";
  readonly floor?: {
    readonly arm?: string;
    readonly confidence?: number;
    readonly tolerance?: number;
  };
  readonly resetOnProfileChange?: boolean;
};

/**
 * Adaptive model routing — the N-candidate `model_pool` with a per-turn
 * selection `policy` (`static` | `heuristic` | `learned` | `classifier`).
 * Carried on the agent blocks of the routing-capable shapes (cli, channel,
 * managed), on workflow steps, graph nodes (0.6.0), crew roles and
 * sub-agents (0.6.0), mutually exclusive with `modelTiers`/`modelFallbacks`
 * (enforced in the spec). Absent when the spec omits `model_pool` — codegen
 * gates on presence so an unset block leaves bundles byte-identical. `policy`
 * and each candidate's `tags` are always present (spec defaults them); every
 * other knob is carried verbatim.
 *
 * 0.6.0 §7.1 — the pool IS the hybrid container: `rules` / `directives` /
 * `classifier` / `strategy` / `reward` / `scope` are siblings of `routing`
 * and `learning`, each present only when declared. The whole block travels
 * to runtime inside the one `JSON.stringify(modelPool)` every emitter
 * already writes, so every new key rides that blob without an emitter edit.
 */
export type IrModelPool = {
  readonly candidates: readonly IrModelPoolCandidate[];
  readonly policy: "static" | "heuristic" | "learned" | "classifier";
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
  /** 0.6.0 §7.2.1 — per-message `/model` steering (default off everywhere). */
  readonly directives?: boolean;
  readonly rules?: readonly IrModelPoolRule[];
  readonly classifier?: IrModelPoolClassifier;
  readonly strategy?: IrModelPoolStrategy;
  readonly reward?: IrModelPoolReward;
  /** 0.6.0 §7.9 — scoped routeKey prefix, carried verbatim when declared. */
  readonly scope?: string;
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
 * (0.6.0 §7.12: checked before every model call, tool iterations included);
 * `degrade` re-resolves the primary model to `model` (one cheaper rung) and
 * continues — the rung serves the rest of the turn the degrade fired in and
 * the run ends at the next turn boundary; under a `modelPool` the rung is
 * the forced candidate rather than an adapter swap. `scope` (0.6.0) is
 * carried ONLY when the spec
 * declares it (absent ⇒ the runtime's `run` default, byte-identical for
 * older specs): `session` seeds the meter on resume from the session log's
 * persisted `cost_accrual` lines so the cap bounds the conversation.
 * `judgeShare` (0.6.0 §6.2, spec `judge_share`) is likewise carried only
 * when declared (absent ⇒ the runtime's 0.3 default): the fraction of
 * `usdMicros` the auxiliary roles (judge, compaction, guide, classifier,
 * consult, committee, shadow) may spend before the runtime raises the
 * `judge_share_exhausted` signal. Carried on the shapes that run the shared
 * loop; absent when the spec omits the block.
 */
export type IrBudget = {
  readonly usdMicros: number;
  readonly onExceed:
    | { readonly kind: "stop" }
    | {
        readonly kind: "degrade";
        readonly model: string;
        /** 0.6.0 §4.2 — provenance + the degrade profile's request params. */
        readonly modelProfile?: string;
        readonly params?: IrModelParams;
      };
  readonly scope?: "run" | "session";
  readonly judgeShare?: number;
};

/**
 * Loop contract 0.4 (Batch B, G02) — the grader selector inside
 * {@link IrEvaluation}, lowered 1:1 from `evaluation.grader`:
 *
 *   - `llm_judge` — a model scores the final text in [0,1] against
 *     `criteria`. `model` is the judge model id; when ABSENT the runtime
 *     uses the shape's primary model (the `cheapest` sentinel was already
 *     resolved at lower time, like `compaction.model`). Judge calls are
 *     METERED into the run budget (0.6.0: on the run bus with
 *     `role: "judge"`, bounded by `IrBudget.judgeShare`).
 *   - `contains` / `regex` — deterministic pass/fail text checks (score 1
 *     on pass, 0 on fail; no model spend).
 */
export type IrEvaluationGrader =
  | {
      readonly type: "llm_judge";
      readonly criteria: string;
      readonly model?: string;
      /** 0.6.0 §4.2 — provenance: the `models:` profile `model` resolved from. */
      readonly modelProfile?: string;
      /** 0.6.0 §6.2 — a judge PANEL (resolved model strings); exclusive with `model`. */
      readonly judges?: readonly string[];
      /** 0.6.0 §6.2 — repeat verdicts per judge, folded by median. */
      readonly repeats?: number;
      /** 0.6.0 §6.2 — pinned judge sampling temperature. */
      readonly temperature?: number;
      /** 0.6.0 §6.2 — what the judge grades. */
      readonly target?: "output" | "transcript";
      /** 0.6.0 §4.2 — the judge profile's other pinned params (thinking / maxTokens). */
      readonly params?: IrModelParams;
    }
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
  /** Resolved below-threshold behaviour (spec `on_fail`, default "retry").
   *  0.6.0 §7.3 adds `escalate`: re-run the turn on the pool's
   *  `strategy.cascade.escalateTo` candidate (else the strongest). */
  readonly onFail: "retry" | "halt" | "note" | "escalate";
  /** Resolved retry hard-cap (spec `max_retries`, default 1). */
  readonly maxRetries: number;
  /** 0.6.0 §4.3 — the judge-independence lint waiver; carried only when true. */
  readonly allowSelfJudge?: true;
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
  /** 0.6.0 §4.2 — provenance of the judge model folded into the step's/node's
   *  `model` slot, when it resolved through a `models:` profile. */
  readonly modelProfile?: string;
  /** 0.6.0 §6.2 — a judge PANEL (resolved model strings); exclusive with the
   *  single judge model. */
  readonly judges?: readonly string[];
  /** 0.6.0 §6.2 — repeat verdicts per judge, folded by median. */
  readonly repeats?: number;
  /** 0.6.0 §6.2 — pinned judge sampling temperature. */
  readonly temperature?: number;
  /** 0.6.0 §6.2 — what the judge grades. */
  readonly target?: "output" | "transcript";
  /** 0.6.0 §7.3 — the pool tag / arm id a `retry_previous` re-run is forced onto. */
  readonly escalateTo?: string;
  /** 0.6.0 §4.2 — the judge profile's other pinned params (thinking / maxTokens). */
  readonly params?: IrModelParams;
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
    /** 0.6.0 §4.2 — provenance + the judge profile's request params. */
    readonly modelProfile?: string;
    readonly params?: IrModelParams;
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
 *
 * Loop contract 0.4 (Batch E): `autoRecall`/`autoCapture` are now RESOLVED at
 * lower time — with the block present they default to `true` (G46, mildly
 * breaking), so a compiled bundle carries an explicit boolean rather than
 * relying on a runtime default. `recallMode`/`refreshEvery` (G21) carry the
 * per-turn recall cadence; `sessionRecall` (G77) folds session summaries into
 * the recall fusion.
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
  /**
   * Loop contract 0.4 (Batch E, G21) — WHEN auto-recall runs, RESOLVED at
   * lower time from `spec.memory.autoRecall`. Carried ONLY when `"per-turn"`
   * (the interactive cadence); `"session-start"` is the implicit default
   * whenever `autoRecall` is true, so the common case stays absent. In
   * `"per-turn"` mode the runtime re-runs the recall closure against the
   * latest user message every `refreshEvery` turns and swaps the volatile
   * recalled TAIL block — it never re-injects into the frozen cache prefix.
   */
  readonly recallMode?: "session-start" | "per-turn";
  /**
   * Loop contract 0.4 (Batch E, G21) — turns between per-turn recall
   * refreshes (`spec.memory.refreshEvery`, int > 0). Meaningful only when
   * `recallMode` is `"per-turn"`; the runtime defaults to 1 when absent.
   */
  readonly refreshEvery?: number;
  /**
   * Loop contract 0.4 (Batch E, G77) — fold session summaries in as a third
   * RRF ranker in the recall fusion (`spec.memory.sessionRecall`). Absent
   * unless the spec opted in (default false).
   */
  readonly sessionRecall?: boolean;
  readonly recallK?: number;
  readonly wiki?: IrMemoryWiki;
  readonly dream?: IrMemoryDream;
};

/**
 * Loop contract 0.4 (Batch E, G22) — one lowered `knowledge.sources[]` entry.
 * A discriminated union so an emitter switches on `kind` without re-deriving
 * which of path/glob/url was set (the spec's exactly-one-of rule already
 * enforced that). Mirrors how {@link IrPipelineDocument} carries the pipeline
 * corpus, but for the agent shapes the corpus is ingested from disk/URL at
 * build/boot rather than inlined.
 */
export type IrKnowledgeSource =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "glob"; readonly glob: string }
  | { readonly kind: "url"; readonly url: string };

/**
 * Loop contract 0.4 (Batch E, G22) — the agent-shape RAG config, lowered from
 * `spec.knowledge` on cli/channel/managed. Presence registers
 * `@crewhaus/tool-retrieve` as a citation-bearing `Retrieve` tool, ingesting
 * `sources` at build/boot. It REUSES target-pipeline's retrieve engine, so
 * the resolved shape mirrors `IrPipelineV0.retrieve` + `.indexing`:
 * `vectorBackend`/`defaultK`/`chunkSize`/`chunkOverlap` are RESOLVED to the
 * pipeline defaults (`in-memory` / 5 / 400 / 0) at lower time so the engine
 * reads concrete values. `embedder` is carried only when declared;
 * resolution order is `knowledge.embedder → memory.embedder →
 * memory.wiki.embedder → the target's default embedder model` (a vector store
 * needs embeddings — it never degrades to BM25, unlike memory recall).
 * Absent when the spec omits `knowledge`.
 */
export type IrKnowledge = {
  readonly embedder?: string;
  readonly vectorBackend: IrVectorBackend;
  readonly defaultK: number;
  readonly chunkSize: number;
  readonly chunkOverlap: number;
  readonly sources: readonly IrKnowledgeSource[];
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
  /** 0.5.0 — the Thredz wiki space (Pro/Scale) this agent's memory is scoped
   *  to; becomes `THREDZ_DEFAULT_SPACE`. Absent → unspaced, i.e. the legacy
   *  account-wide wiki, which is also the only path on Free/Starter. Inside a
   *  space the space's TYPE decides visibility, so {@link visibility} stops
   *  applying — it is still carried, because the two are independent knobs and
   *  a bundle may be pointed at a space after the fact. */
  readonly space?: string;
  /** RESOLVED — mirror continuity goal writes to Thredz `goal_write`/
   *  `goal_update` (spec-scoped only, §14.5 decision 5). Defaulted at lower
   *  time to "on when continuity goals are on". */
  readonly goals: boolean;
  /** Register this addressable agent handle at boot (idempotent
   *  `agent_register`). Absent → no registration (the default). */
  readonly agentName?: string;
  /** Item 5 (G44) — the nine Thredz messaging tools (`message_send` /
   *  `inbox_poll` / `message_ack` / `thread_get` / `agent_*`) are registered.
   *  Present and `true` ONLY when the spec opts in (`thredz.messaging: true`);
   *  ABSENT means the default-off posture (the send-side tools are
   *  destructive + justification-gated, so they never register unasked). */
  readonly messaging?: boolean;
};

/**
 * Item 1 (G30) — the MCP-server projection config inside {@link IrExpose}.
 * `transport` is `stdio` (spawned stdio MCP server) or `sse` (HTTP+SSE
 * endpoint, riding the gateway-server tenancy/budgets where the shape has
 * them). `tools` is RESOLVED (default `"chat"`): `chat` projects one primary
 * invoke tool (`{ message }` → final assistant text); `per-subagent` adds one
 * tool per declared sub-agent (the spec's cross-field check guarantees at
 * least one exists).
 */
export type IrExposeMcp = {
  readonly transport: "stdio" | "sse";
  readonly tools: "chat" | "per-subagent";
};

/**
 * Item 1 (G30) — the `expose:` config, lowered from the top-level `expose:`
 * block. Carried on the serving shapes (IrV0/cli, IrChannelV0, IrManagedV0).
 * Present ONLY when the spec declares `expose.mcp`; ABSENT → the bundle is not
 * exposed as an MCP server (byte-identical to pre-Batch-G). `mcp` is the one
 * projection kind today; the object leaves room for future exposure targets.
 */
export type IrExpose = {
  readonly mcp?: IrExposeMcp;
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
 * Loop contract 0.4 (Batch C, G26) — trace subscriber level.
 *   `off`    — no ring buffer, no printer.
 *   `ring`   — ring buffer only (the DEFAULT), no printer attached.
 *   `pretty` — ring buffer + colorised stderr printer.
 *   `json`   — ring buffer + JSON-Lines printer.
 */
export type IrObservabilityTraceLevel = "off" | "ring" | "pretty" | "json";
export type IrObservabilityTrace = { readonly level: IrObservabilityTraceLevel };

/** Loop contract 0.4 (Batch C, G26) — a simple on/off subscriber toggle
 *  (metrics / cost / alerts / incidents). */
export type IrObservabilityToggle = { readonly enabled: boolean };

/** Loop contract 0.4 (Batch C, G26) — OTLP exporter config. `endpoint` is
 *  carried verbatim (a `$VAR` value is the emitter's to resolve). */
export type IrObservabilityOtel = { readonly endpoint?: string };

/**
 * Ops item 37 + Loop contract 0.4 (Batch C, G26) — cross-cutting
 * observability config, lowered from `spec.observability`. Carries the `slo`
 * targets (item 37) plus the subscriber/exporter controls (G26). Carried on
 * the shapes that run an agent loop with observability subscribers
 * (IrV0/cli, IrChannelV0, IrManagedV0, IrCrewV0).
 *
 * DEFAULTS SEMANTICS — spec ABSENCE is NOT `off`. The lowering carries ONLY
 * what the spec declares; each key is absent when its sub-block is omitted,
 * and the emitter/runtime applies the default:
 *   - `cost` absent   ⇒ cost-tracker ON  (`ir.observability?.cost?.enabled ?? true`)
 *   - `trace` absent  ⇒ ring buffer ON, no printer (`?.trace?.level ?? "ring"`)
 *   - `metrics`/`alerts`/`incidents` absent ⇒ OFF (opt-in: `?.enabled ?? false`)
 *   - `otel` absent   ⇒ no OTel export
 * An EXPLICIT `cost: { enabled: false }` / `trace: { level: "off" }` reaches
 * the IR verbatim and wins. Absent from the IR entirely when the spec omits
 * the whole `observability:` block.
 */
export type IrObservability = {
  readonly slo?: IrSlo;
  readonly trace?: IrObservabilityTrace;
  readonly metrics?: IrObservabilityToggle;
  readonly cost?: IrObservabilityToggle;
  readonly alerts?: IrObservabilityToggle;
  readonly incidents?: IrObservabilityToggle;
  readonly otel?: IrObservabilityOtel;
};

/**
 * "Watch me" (design/watch-me.md §4.6) — observe-and-learn config, lowered
 * from `spec.watchme` on the three interactive-loop shapes (IrV0/cli,
 * IrChannelV0, IrManagedV0), carried beside `observability` (a sibling
 * feature, not a telemetry sub-key). Unlike IrObservability's declare-only
 * carriage, every field here is REQUIRED: the lowering resolves all defaults
 * (a bare `watchme: {}` arrives fully populated), so emitters/runtimes never
 * re-derive them. Absent from the IR entirely when the spec omits the block.
 */
export type IrWatchme = {
  readonly enabled: boolean;
  readonly capture: "full" | "mirrors";
  /** Phase-2 judge model — default resolved at lower time. */
  readonly judgeModel: string;
  /** 0.6.0 §4.2 — provenance + the judge profile's request params. */
  readonly judgeProfile?: string;
  readonly judgeParams?: IrModelParams;
  readonly judgeSampleRate: number;
  readonly judgeBudgetUsd: number;
  readonly scope: "harness" | "user";
  readonly share: boolean;
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
};

export type IrV0 = {
  readonly version: 0;
  readonly name: string;
  readonly target: "cli";
  /** 0.6.0 §4.2 — the lowered `models:` registry. Present only when the spec
   *  declares one; emitters never read it. */
  readonly models?: IrModelProfiles;
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
    /** 0.6.0 §4.2 — provenance: the `models:` profile `model` resolved from.
     *  Absent unless the slot was declared as a `$profile` reference. */
    readonly modelProfile?: string;
    /** 0.6.0 §4.1 — sampling temperature (spec `temperature`, or the
     *  referenced profile's). Exclusive with `thinking`. Absent when neither
     *  declares it. */
    readonly temperature?: number;
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
  /** Loop contract 0.4 (Batch E, G22) — agent-shape RAG config. Present when
   *  the spec declares `knowledge:`; absent otherwise. */
  readonly knowledge?: IrKnowledge;
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
  /** "Watch me" — observe-and-learn config (design/watch-me.md §4.6).
   *  Optional; absent when the spec omits the `watchme` block; all defaults
   *  resolved at lower time when present. */
  readonly watchme?: IrWatchme;
  /** Item 1 (G30) — MCP-server projection config. Present when the spec
   *  declares `expose.mcp`; absent otherwise. */
  readonly expose?: IrExpose;
  /** Item 3 (G32) — marketplace plugin names loaded at boot (`plugins:`).
   *  Present (non-empty) only when the spec declares them; load order. */
  readonly plugins?: readonly string[];
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
  /** Item 9 (G37) — per-step ordered failover models (spec
   *  `steps[].model_fallbacks`). Absent → single-model. */
  readonly modelFallbacks?: readonly string[];
  /** Item 9 (G37) — per-step breaker tuning (spec `steps[].circuit_breaker`). */
  readonly circuitBreaker?: IrCircuitBreaker;
  /** Item 9 (G37) — per-step two-tier turn-difficulty router. Absent →
   *  single-model. */
  readonly modelTiers?: IrModelTiers;
  /** Item 9 (G37) — per-step N-candidate pool with a selection policy (a
   *  PolicyRouter decides per step against the shared routing-store
   *  scoreboard). Absent → single-model. */
  readonly modelPool?: IrModelPool;
  /** 0.6.0 §4.2 — provenance: the `models:` profile `model` resolved from. */
  readonly modelProfile?: string;
  /** 0.6.0 §4.1 — sampling temperature (spec `steps[].temperature`, or the
   *  referenced profile's). Exclusive with `thinking`. */
  readonly temperature?: number;
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
  /** 0.6.0 §4.2 — the lowered `models:` registry. Present only when the spec
   *  declares one; emitters never read it. */
  readonly models?: IrModelProfiles;
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
  /**
   * Shared token echoed back on Meta's unsigned GET callback-URL verification
   * handshake (`hub.verify_token`). Optional — absent means the daemon fails
   * that handshake closed and serves only an already-verified subscription.
   */
  readonly verifyToken?: IrSecretRef;
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
 * Loop contract 0.4 (Batch F, temporal contract / G84 schedule half) — a
 * cron OR interval wake trigger carried into the IR for the daemon-able
 * shapes (IrChannelV0, IrManagedV0, IrBatchV0). The temporal downstream
 * lowers this into the emitted daemon's wake loop; `runs resume` rehydrates
 * an interrupted scheduled run. Durations (`jitter`, interval `every`) are
 * normalized to milliseconds at lower time so codegen reads literal numbers,
 * while `cron` is carried verbatim for the daemon's cron parser. Exactly one
 * `kind` — the discriminated union mirrors the spec's `schedule:` block.
 */
export type IrSchedule =
  | {
      readonly kind: "cron";
      /** A 5- or 6-field cron expression, carried verbatim. */
      readonly cron: string;
      /** IANA tz the cron evaluates in; absent → the daemon's default (UTC). */
      readonly timezone?: string;
      /** Random +/- delay per wake, normalized to ms. Absent → no jitter. */
      readonly jitterMs?: number;
      /** Synthetic prompt each wake runs. Absent → the daemon's default tick. */
      readonly instructions?: string;
    }
  | {
      readonly kind: "interval";
      /** Wake cadence in ms (spec `every` duration, normalized at lower time). */
      readonly everyMs: number;
      readonly jitterMs?: number;
      readonly instructions?: string;
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
  /** 0.6.0 §4.2 — the lowered `models:` registry. Present only when the spec
   *  declares one; emitters never read it. */
  readonly models?: IrModelProfiles;
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
    /** 0.6.0 §4.2 — provenance: the `models:` profile `model` resolved from.
     *  Absent unless the slot was declared as a `$profile` reference. */
    readonly modelProfile?: string;
    /** 0.6.0 §4.1 — sampling temperature (spec `temperature`, or the
     *  referenced profile's). Exclusive with `thinking`. Absent when neither
     *  declares it. */
    readonly temperature?: number;
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
  /** Loop contract 0.4 (Batch F) — cron/interval wake trigger. Optional;
   *  absent when the spec omits `schedule:`. */
  readonly schedule?: IrSchedule;
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
  /** Loop contract 0.4 (Batch E, G22) — agent-shape RAG config. Present when
   *  the spec declares `knowledge:`; absent otherwise. */
  readonly knowledge?: IrKnowledge;
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
  /** "Watch me" — observe-and-learn config (design/watch-me.md §4.6).
   *  Optional; absent when the spec omits the `watchme` block; all defaults
   *  resolved at lower time when present. */
  readonly watchme?: IrWatchme;
  /** Item 1 (G30) — MCP-server projection config. Present when the spec
   *  declares `expose.mcp`; absent otherwise. */
  readonly expose?: IrExpose;
  /** Item 3 (G32) — marketplace plugin names loaded at boot (`plugins:`).
   *  Present (non-empty) only when the spec declares them; load order. */
  readonly plugins?: readonly string[];
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
  /** 0.6.0 §4.2 — the lowered `models:` registry. Present only when the spec
   *  declares one; emitters never read it. */
  readonly models?: IrModelProfiles;
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
    /** 0.6.0 §4.2 — provenance: the `models:` profile `model` resolved from.
     *  Absent unless the slot was declared as a `$profile` reference. */
    readonly modelProfile?: string;
    /** 0.6.0 §4.1 — sampling temperature (spec `temperature`, or the
     *  referenced profile's). Exclusive with `thinking`. Absent when neither
     *  declares it. */
    readonly temperature?: number;
  };
  readonly tenants: readonly IrManagedTenant[];
  /** Loop contract 0.4 (Batch F, G81) — tool catalog for the managed daemon.
   *  Optional (absent when the spec omits `agent.tools`); the emitter reads
   *  `ir.tools ?? []`. Per-tenant tool_config overlays apply at runtime via the
   *  policy-engine's tenant context. */
  readonly tools?: readonly string[];
  /** Loop contract 0.4 (Batch F, G81) — builtin tool config blobs (spec
   *  `agent.tool_config`). Optional; absent when the spec omits it. */
  readonly toolConfigs?: IrToolConfigs;
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
  /** Loop contract 0.4 (Batch F) — cron/interval wake trigger. Optional. */
  readonly schedule?: IrSchedule;
  /** Loop contract 0.4 (Batch B, G02) — in-loop output evaluation.
   *  Optional; absent when the spec omits the `evaluation` block. */
  readonly evaluation?: IrEvaluation;
  /** NEW-inloop-coverage — response-feedback config. Gates the gateway's
   *  `feedback.submit` rating route and (with `autoDistill`) the daemon's
   *  distill janitor step. Absent when the spec omits the block. */
  readonly feedback?: IrFeedback;
  /** #53 cross-session memory config. Optional; absent when the spec omits `memory`. */
  readonly memory?: IrMemory;
  /** Loop contract 0.4 (Batch E, G22) — agent-shape RAG config. Present when
   *  the spec declares `knowledge:`; absent otherwise. */
  readonly knowledge?: IrKnowledge;
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
  /** "Watch me" — observe-and-learn config (design/watch-me.md §4.6).
   *  Optional; absent when the spec omits the `watchme` block; all defaults
   *  resolved at lower time when present. CARRIED but not runtime-wired on
   *  this shape in v1 — `compile()` emits the accepted-but-unwired warning
   *  (design/watch-me.md §6.3 names the target-managed stamp seam). */
  readonly watchme?: IrWatchme;
  /** Item 1 (G30) — MCP-server projection config. Present when the spec
   *  declares `expose.mcp`; absent otherwise. SSE-backed exposure rides this
   *  shape's gateway-server tenancy/budgets. */
  readonly expose?: IrExpose;
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
  /** 0.6.0 §7.7 — per-node model routing (graph nodes carried NONE before
   *  0.6.0): the agent block's quartet, lowered by the same
   *  `lowerModelFailover` and rendered onto the node's `runChatLoop` call
   *  exactly like a workflow step. Absent → the node's single resolved model. */
  readonly modelFallbacks?: readonly string[];
  readonly circuitBreaker?: IrCircuitBreaker;
  readonly modelTiers?: IrModelTiers;
  readonly modelPool?: IrModelPool;
  /** 0.6.0 §4.2 — provenance: the `models:` profile `model` resolved from. */
  readonly modelProfile?: string;
  /** 0.6.0 §4.1 — sampling temperature (spec `nodes.<n>.temperature`, or the
   *  referenced profile's). Exclusive with `thinking`. */
  readonly temperature?: number;
  /**
   * When set, the node calls `ctx.requestApproval(prompt)` BEFORE its LLM
   * turn and pauses the graph until `resume(checkpointId, decision)`. The
   * gate is a pre-condition: at the pause the node has spent nothing, the
   * `hitl_pause` event carries the upstream state the approver is deciding
   * on, and a rejecting decision cancels the turn (the node records only
   * `state["<name>_decision"]`).
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
  /** 0.6.0 §4.2 — the lowered `models:` registry. Present only when the spec
   *  declares one; emitters never read it. */
  readonly models?: IrModelProfiles;
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
  /** 0.6.0 §4.2 — the lowered `models:` registry. Present only when the spec
   *  declares one; emitters never read it. */
  readonly models?: IrModelProfiles;
  readonly agent: {
    readonly model: string;
    readonly instructions: string;
    /** Adaptive model routing — N-candidate pool. Absent → single-model. */
    readonly modelPool?: IrModelPool;
    /** 0.6.0 §4.2 — provenance: the `models:` profile `model` resolved from.
     *  Absent unless the slot was declared as a `$profile` reference. */
    readonly modelProfile?: string;
    /** 0.6.0 §4.1 — sampling temperature (spec `temperature`, or the
     *  referenced profile's). Exclusive with `thinking`. Absent when neither
     *  declares it. */
    readonly temperature?: number;
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
  /** Item 9 (G37) — per-role ordered failover models (spec
   *  `roles.<r>.model_fallbacks`). Absent → single-model. */
  readonly modelFallbacks?: readonly string[];
  /** Item 9 (G37) — per-role breaker tuning (spec `roles.<r>.circuit_breaker`). */
  readonly circuitBreaker?: IrCircuitBreaker;
  /** Item 9 (G37) — per-role two-tier turn-difficulty router. Absent →
   *  single-model. */
  readonly modelTiers?: IrModelTiers;
  /** Item 9 (G37) — per-role N-candidate pool with a selection policy (a
   *  PolicyRouter decides per role against the shared routing-store
   *  scoreboard). Absent → single-model. */
  readonly modelPool?: IrModelPool;
  /** 0.6.0 §4.2 — provenance: the `models:` profile `model` resolved from. */
  readonly modelProfile?: string;
  /** 0.6.0 §4.1 — sampling temperature (spec `roles.<r>.temperature`, or the
   *  referenced profile's). Exclusive with `thinking`. */
  readonly temperature?: number;
  /** 0.5.0 — this role's RESOLVED Thredz config: the crew-wide defaults with
   *  the role's own `thredz.roles.<name>` overrides merged in, shorthands
   *  expanded and the credential lowered. Absent → this role has no hosted
   *  wiki. Resolution happens at lower time precisely so the emitter does no
   *  inheritance logic. */
  readonly thredz?: IrThredz;
  /** 0.5.0 — the `mcp_servers` key of the server this role's Thredz rides:
   *  `"thredz"` for the crew default, `"thredz-<slug>"` for a role override.
   *  Carried explicitly so the emitter never re-derives it — a name derived
   *  twice is a name that can drift, and `McpHost.getClient` on a name the
   *  host does not carry degrades the role to local files SILENTLY. */
  readonly thredzServer?: string;
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
  /**
   * 0.6.0 §7.7 — the model the `kind: "llm"` router runs on (resolved; a
   * `$profile` reference lowers here with its provenance beside it). Absent →
   * the emitter keeps today's default, the entry role's model.
   */
  readonly model?: string;
  readonly modelProfile?: string;
};

export type IrCrewV0 = {
  readonly version: 0;
  readonly name: string;
  readonly target: "crew";
  /** 0.6.0 §4.2 — the lowered `models:` registry. Present only when the spec
   *  declares one; emitters never read it. */
  readonly models?: IrModelProfiles;
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
  /** Loop contract 0.4 (Batch C, G26) — observability subscriber/exporter
   *  controls (+ item-37 SLO targets). Optional; absent when the spec omits
   *  the `observability` block. */
  readonly observability?: IrObservability;
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
  /** 0.6.0 §4.2 — the lowered `models:` registry. Present only when the spec
   *  declares one; emitters never read it. */
  readonly models?: IrModelProfiles;
  readonly agent: {
    readonly model: string;
    readonly instructions: string;
    /** Model max OUTPUT tokens for one turn (spec `agent.max_tokens`).
     *  Optional; when absent the runtime default applies. */
    readonly maxTokens?: number;
    /** Adaptive model routing — N-candidate pool. Absent → single-model. */
    readonly modelPool?: IrModelPool;
    /** 0.6.0 §4.2 — provenance: the `models:` profile `model` resolved from.
     *  Absent unless the slot was declared as a `$profile` reference. */
    readonly modelProfile?: string;
    /** 0.6.0 §4.1 — sampling temperature (spec `temperature`, or the
     *  referenced profile's). Exclusive with `thinking`. Absent when neither
     *  declares it. */
    readonly temperature?: number;
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
  /** 0.6.0 §4.2 — the lowered `models:` registry. Present only when the spec
   *  declares one; emitters never read it. */
  readonly models?: IrModelProfiles;
  readonly agent: {
    readonly model: string;
    readonly instructions: string;
    /** Model max OUTPUT tokens for one turn (spec `agent.max_tokens`).
     *  Optional; when absent the runtime default applies. */
    readonly maxTokens?: number;
    /** Adaptive model routing — N-candidate pool. Absent → single-model. */
    readonly modelPool?: IrModelPool;
    /** 0.6.0 §4.2 — provenance: the `models:` profile `model` resolved from.
     *  Absent unless the slot was declared as a `$profile` reference. */
    readonly modelProfile?: string;
    /** 0.6.0 §4.1 — sampling temperature (spec `temperature`, or the
     *  referenced profile's). Exclusive with `thinking`. Absent when neither
     *  declares it. */
    readonly temperature?: number;
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
  /** Loop contract 0.4 (Batch F) — cron/interval wake trigger for the queue
   *  worker daemon. Optional. */
  readonly schedule?: IrSchedule;
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
  /** 0.6.0 §4.2 — the lowered `models:` registry. Present only when the spec
   *  declares one; emitters never read it. */
  readonly models?: IrModelProfiles;
  readonly agent: {
    readonly model: string;
    readonly instructions: string;
    /** 0.6.0 §4.2 — provenance: the `models:` profile `model` resolved from
     *  (profile → model only on this shape; every other field is warned). */
    readonly modelProfile?: string;
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
  /** 0.6.0 §4.2 — the lowered `models:` registry. Present only when the spec
   *  declares one; emitters never read it. */
  readonly models?: IrModelProfiles;
  readonly agent: {
    readonly model: string;
    readonly instructions: string;
    /** Model max OUTPUT tokens for one turn (spec `agent.max_tokens`).
     *  Optional; when absent the runtime default applies. */
    readonly maxTokens?: number;
    /** Adaptive model routing — N-candidate pool. Absent → single-model. */
    readonly modelPool?: IrModelPool;
    /** 0.6.0 §4.2 — provenance: the `models:` profile `model` resolved from.
     *  Absent unless the slot was declared as a `$profile` reference. */
    readonly modelProfile?: string;
    /** 0.6.0 §4.1 — sampling temperature (spec `temperature`, or the
     *  referenced profile's). Exclusive with `thinking`. Absent when neither
     *  declares it. */
    readonly temperature?: number;
  };
  readonly driver: {
    readonly backend: IrBrowserBackend;
    readonly viewport: {
      readonly width: number;
      readonly height: number;
    };
    /** Optional initial URL; daemon calls driver.goto() before runChatLoop. */
    readonly startUrl?: string;
    /**
     * SECURITY — the spec opted in to private/loopback navigation targets
     * (`driver.allowPrivateTargets: true`). Relaxes BOTH the Navigate
     * pre-goto guard and the chromium DNS-pinning proxy for this harness,
     * never the http/https scheme allowlist. Carried only when true, so a
     * bundle that leaves it at the default stays byte-identical.
     */
    readonly allowPrivateTargets?: boolean;
  };
  /** Vision-grounding model. Defaults at lower-time to agent.model. */
  readonly groundingModel: string;
  /** 0.6.0 §4.2 — provenance when `groundingModel` resolved through a profile. */
  readonly groundingModelProfile?: string;
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
  /** 0.6.0 §4.2 — the lowered `models:` registry. Present only when the spec
   *  declares one; emitters never read it. */
  readonly models?: IrModelProfiles;
  readonly agent: {
    readonly model: string;
    readonly instructions: string;
    readonly tools: readonly string[];
    /** 0.6.0 §4.2 — provenance: the `models:` profile `model` resolved from. */
    readonly modelProfile?: string;
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
  /** 0.6.0 §4.2 — the lowered `models:` registry. Present only when the spec
   *  declares one; emitters never read it. */
  readonly models?: IrModelProfiles;
  readonly agent: {
    readonly model: string;
    readonly instructions: string;
    /** 0.6.0 §4.2 — provenance: the `models:` profile `model` resolved from. */
    readonly modelProfile?: string;
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
  /** 0.6.0 §4.2 — the lowered `models:` registry. Present only when the spec
   *  declares one; emitters never read it. */
  readonly models?: IrModelProfiles;
  readonly agent: {
    readonly model: string;
    readonly instructions: string;
    /** 0.6.0 §4.2 — provenance: the `models:` profile `model` resolved from. */
    readonly modelProfile?: string;
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
