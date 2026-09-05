/**
 * `@crewhaus/model-plan` — shared types (0.6.0 §4.2, §4.4, §7.1).
 *
 * Every type here is STRUCTURAL and dependency-light on purpose: the
 * compiler's `IrModelProfile` / `IrModelPoolCandidate` (widened in the IR
 * PR) satisfy `ModelProfile` without an import, runtime-core's boot
 * candidates satisfy `EligibilityCandidate`, and `RouteSignals` is a strict
 * superset of `@crewhaus/model-router`'s `TierSignals` so the same object
 * feeds `pickTier` and `evaluateRules`. This package therefore depends only
 * on `@crewhaus/adapter-anthropic` (for `ProviderFeatures`, `ReasoningEffort`
 * and the effort→budget preset table).
 */
import type { ProviderFeatures, ReasoningEffort } from "@crewhaus/adapter-anthropic";

/**
 * The extended-thinking selector, the exact shape of the IR's `IrThinking`:
 * an explicit token budget OR a portable effort preset, never both.
 */
export type ModelThinking =
  | { readonly budgetTokens: number }
  | { readonly effort: ReasoningEffort };

/**
 * The model features a tool or profile requires. Structurally
 * `Partial<ProviderFeatures>` plus the two size floors N1 adds — the same
 * shape as `@crewhaus/cost-tracker`'s `CapabilityRequirement` and a superset
 * of `@crewhaus/tool-catalog`'s `ModelFeatureRequirement`, so one
 * declaration serves the runtime gate and the offline twin.
 */
export type FeatureRequirement = Partial<ProviderFeatures> & {
  /** The candidate's context window must be KNOWN and at least this many tokens. */
  readonly contextWindowGte?: number;
  /** The candidate's max output must be KNOWN and at least this many tokens. */
  readonly maxOutputTokensGte?: number;
};

/**
 * What a candidate CAN do, as far as the plan knows: the adapter's runtime
 * `features` plus the two size facts the capability table (or a declared
 * `capabilities:` override) supplies. Either half may be unknown — an
 * unknown fact never satisfies a requirement on it.
 */
export type CandidateCapabilities = {
  readonly features?: ProviderFeatures;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
};

/**
 * The restricted per-profile permission schema (§5.4): deny / ask ONLY —
 * no `alwaysAllow`, no `mode`, no `ask_mode`. A profile can narrow the
 * shape's permissions, never widen them.
 */
export type ProfilePermissions = {
  readonly deny?: readonly string[];
  readonly ask?: readonly string[];
};

/**
 * One resolved model profile — the lower-time expansion of a `models:`
 * entry, or a `model_pool` candidate carrying the same fields inline
 * (§4.2 `IrModelProfile`). Every field but `model` is optional; a bare
 * `{ model }` is a valid profile with every setting inherited from the run.
 */
export type ModelProfile = {
  /** Registry name when the profile came from `models:` — the arm identity (§7.9). */
  readonly profile?: string;
  /** Spec model string (model-router grammar). */
  readonly model: string;
  /** Routing identity tags (`cheap`, `strong`, …). */
  readonly tags?: readonly string[];
  readonly thinking?: ModelThinking;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly modelCallTimeoutMs?: number;
  /** Per-model instructions overlay, appended in the volatile region (§4.4). */
  readonly overlay?: string;
  /**
   * Subset-only tool selection: builtin keys / `RegisteredTool` names,
   * server-scoped MCP globs (`mcp__github__*`), `Consult`, `Escalate`.
   * `[]` means ZERO shape tools (auto-registered loop tools survive, §5.2).
   * Absent means the full shape toolset.
   */
  readonly tools?: readonly string[];
  readonly toolConfigs?: Readonly<Record<string, unknown>>;
  readonly permissions?: ProfilePermissions;
  readonly rateLimits?: Readonly<Record<string, unknown>>;
  /** `prefer` (default) keeps cache markers; `off` strips them for this candidate. */
  readonly caching?: "prefer" | "off";
  /** Per-profile spend cap inside a run: ineligible when spent, never ends the run. */
  readonly costCapUsdMicros?: number;
  /** What the profile demands of its own model (validated at compile time AND per turn). */
  readonly requires?: FeatureRequirement;
  /** Declared capability override for non-table providers (local / azure / named hosts). */
  readonly capabilities?: CandidateCapabilities;
  /** Per-profile failover chain. */
  readonly fallbacks?: readonly string[];
  readonly circuitBreaker?: {
    readonly failureThreshold?: number;
    readonly windowMs?: number;
    readonly cooldownMs?: number;
  };
  /** `false` withdraws a candidate from routing without deleting its history. */
  readonly enabled?: false;
};

/** A `models:` registry: profile name → profile. */
export type ProfileRegistry = Readonly<Record<string, ModelProfile>>;

/**
 * The per-candidate request parameters `buildRequestParams` derives — the
 * candidate half of `CandidatePlan.params` plus the thinking-aware ceiling
 * (§4.4). Mirrors `ProviderRequest`'s param fields exactly so it spreads
 * straight into a request literal.
 */
export type RequestParams = {
  /** The declared output budget (bridge / sub-agent value). */
  readonly maxTokens: number;
  /** The thinking-aware ceiling main-turn requests carry (`budget + maxTokens` when the budget crowds the ceiling out). */
  readonly effectiveMaxTokens: number;
  readonly thinking?: { readonly type: "enabled"; readonly budgetTokens: number };
  readonly reasoningEffort?: ReasoningEffort;
  readonly temperature?: number;
  /** Set when `maxTokens` was clamped to the candidate's `maxOutputTokens` (N1). */
  readonly clampedTo?: number;
};

/** The run-level defaults a profile overrides field-by-field. */
export type RequestParamsBase = {
  readonly maxTokens: number;
  readonly thinking?: ModelThinking;
  readonly temperature?: number;
};

/**
 * The deterministic per-turn signals `preRoute` computes (§7.2.2). A strict
 * superset of `@crewhaus/model-router`'s `TierSignals` — the four required
 * fields are that type verbatim — so one object drives both `pickTier` and
 * `evaluateRules`. `userText` is an INPUT only: it is never persisted (see
 * `deriveSignalRecord`), because on a channel shape it is attacker-controlled
 * prose and would otherwise put verbatim prompts into session logs.
 */
export type RouteSignals = {
  /** Estimated context tokens for this turn. */
  readonly contextTokens: number;
  /** Whether any tools are advertised on this turn's request. */
  readonly toolsInPlay: boolean;
  /** 0-based turn index within the run. */
  readonly turnIndex: number;
  /** Tool_use blocks the PREVIOUS turn produced (0 on the first turn). */
  readonly priorTurnToolUseCount: number;
  /** The latest user text (input only — never persisted). */
  readonly userText?: string;
  /** Character count of the latest user text; derived from `userText` when absent. */
  readonly userTextChars?: number;
  /** Whether the latest user message carries image blocks. */
  readonly hasImages?: boolean;
  /** Names of the tools the PREVIOUS turn called. */
  readonly toolNamesLastTurn?: readonly string[];
  /** Fraction of the run budget already spent, in `[0, 1]`; absent without a budget. */
  readonly budgetSpentRatio?: number;
  /** Channel-supplied routing hint (e.g. a Slack channel name), when the host has one. */
  readonly channelHint?: string;
};

/**
 * The persisted projection of `RouteSignals` — derived values only, never
 * the user's text (§7.2.2). `userTextHash` lets `route explain` correlate
 * two turns that carried the same prompt without storing it.
 */
export type RouteSignalRecord = {
  readonly contextTokens: number;
  readonly toolsInPlay: boolean;
  readonly turnIndex: number;
  readonly priorTurnToolUseCount: number;
  readonly userTextChars?: number;
  readonly userTextHash?: string;
  readonly hasImages?: boolean;
  readonly toolNamesLastTurn?: readonly string[];
  readonly budgetSpentRatio?: number;
  readonly channelHint?: string;
};

/** The `when:` clause of a route rule — every present condition must hold. */
export type RouteRuleWhen = {
  readonly has_images?: boolean;
  /** A regex source matched against the user text (guarded — see `evaluateRules`). */
  readonly message_matches?: string;
  readonly user_text_chars_gt?: number;
  readonly context_tokens_gt?: number;
  readonly tool_in_play?: boolean;
  readonly channel?: string;
  readonly budget_spent_ratio_gt?: number;
  readonly turn_index_lt?: number;
};

/**
 * The `use:` target of a rule: a tag (`strong`), a profile ref (`$fast`),
 * or a capability requirement the turn's candidates must satisfy.
 */
export type RouteRuleUse = string | { readonly requires: FeatureRequirement };

export type RouteRule = {
  readonly id: string;
  readonly when: RouteRuleWhen;
  readonly use: RouteRuleUse;
  /** `false` disables the rule without deleting it (the optimizer's switch, §10.3). */
  readonly enabled?: boolean;
};

/** The route hint `preRoute` hands to the synchronous `route()` (§7.2). */
export type RouteHintSource =
  | "forced"
  | "directive"
  | "rule"
  | "classifier"
  | "eligibility"
  | "none";

export type RouteHint = {
  /** An arm the policy MUST serve (budget degrade, cascade escalation, a directive pin). */
  readonly forcedArm?: string;
  readonly excludedArms?: readonly string[];
  /** The arms the policy may choose among this turn (N1). */
  readonly eligible: readonly string[];
  /** Appended to the route key so a hinted decision learns in its own bucket. */
  readonly routeKeySuffix?: string;
  readonly source: RouteHintSource;
  /** Derived, persistable evidence: matched rule id, exclusion reasons, … */
  readonly evidence: Readonly<Record<string, unknown>>;
};

/** The minimal per-arm score shape the router reads — `ArmScore` in `@crewhaus/model-router`. */
export type ArmPrior = {
  readonly n: number;
  readonly meanReward: number;
  readonly varReward?: number;
  /**
   * N2 (§7.11) — set by `seededScoreLookup` on a score that came from the
   * priors file rather than live observations: the router skips warm-up
   * (`minSamplesPerArm`) for a seeded arm even though its pseudo-count is
   * capped below the warm-up floor.
   */
  readonly seeded?: boolean;
};
