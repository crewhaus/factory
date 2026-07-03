/**
 * Item 26 — two-tier turn-difficulty router.
 *
 * An opt-in `model_tiers: { fast, default }` spec block compiles into a
 * per-turn tier pick: cheap `fast` model for easy turns, the `default` model
 * for hard ones. The decision is DETERMINISTIC — derived from signals the
 * agent loop already computes each turn (estimated context tokens, whether
 * tools are in play this turn, the turn index / continuation shape, and the
 * previous turn's tool_use density) — so it never spends a probe call and is
 * fully reproducible from the transcript.
 *
 * Sibling to the failover meta-adapter (`failover.ts`): like failover, BOTH
 * tier adapters resolve ONCE at boot (adapters bind at boot today), and the
 * per-turn pick just selects between the two already-resolved adapters —
 * mirroring how the failover chain holds multiple resolved candidates and how
 * compaction resolves a second adapter. Unlike failover it does NOT wrap
 * `stream()`: the tier decision is a LOOP-level signal (tools/ context this
 * turn), so runtime-core calls `pickTier` each turn and streams through the
 * returned adapter, publishing a `model_tier_route` trace event.
 *
 * Misroutes: a `fast`-tier turn that FAILS is re-run on `default` — this
 * composes with item 23's `switch-model` recovery ladder (the loop escalates
 * the tier for the retry rather than burning backoff on the fast model).
 */
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";

/** The two tiers. */
export type ModelTier = "fast" | "default";

/**
 * Tuning for the tier decision. All thresholds have conservative defaults so
 * an unset `model_tiers` block (with only fast/default models) still routes
 * sensibly. Every field is optional in the spec/IR; defaults live here.
 */
export type TierRoutingConfig = {
  /**
   * Escalate to `default` when estimated context tokens exceed this. Big
   * context ≈ a harder / higher-stakes turn where the cheap model's quality
   * drop hurts most. Default 16000.
   */
  readonly contextTokenThreshold?: number;
  /**
   * Route tool-bearing turns to `default` (tool orchestration is where cheap
   * models most often mis-step). Default true.
   */
  readonly toolsToDefault?: boolean;
  /**
   * Route the FIRST turn (turn index 0) to `default` — the opening turn sets
   * the trajectory and usually carries the full task framing. Default true.
   */
  readonly firstTurnToDefault?: boolean;
  /**
   * Escalate when the PREVIOUS turn issued at least this many tool calls (a
   * dense tool turn signals an active multi-step task). Default 3.
   */
  readonly priorToolDensityThreshold?: number;
};

/** Deterministic per-turn signals the loop already computes. */
export type TierSignals = {
  /** Estimated context tokens for this turn (token-budget estimateTokens). */
  readonly contextTokens: number;
  /** Whether any tools are available/eligible on this turn's request. */
  readonly toolsInPlay: boolean;
  /** 0-based turn index within the run. */
  readonly turnIndex: number;
  /** Tool_use blocks the PREVIOUS turn produced (0 on the first turn). */
  readonly priorTurnToolUseCount: number;
};

export type TierDecision = {
  readonly tier: ModelTier;
  /** Human-readable trigger for the trace event / logs. */
  readonly reason: string;
};

const DEFAULTS: Required<TierRoutingConfig> = {
  contextTokenThreshold: 16_000,
  toolsToDefault: true,
  firstTurnToDefault: true,
  priorToolDensityThreshold: 3,
};

/**
 * The pure tier decision. Any single "hard turn" signal escalates to
 * `default`; when none fire, the cheap `fast` tier serves. Order of the
 * checks only affects the `reason` string (the first matching escalator
 * wins), not the tier — every escalator lands on `default`.
 */
export function pickTier(signals: TierSignals, config: TierRoutingConfig = {}): TierDecision {
  const cfg = { ...DEFAULTS, ...config };

  if (cfg.firstTurnToDefault && signals.turnIndex === 0) {
    return { tier: "default", reason: "first turn (task framing) → default tier" };
  }
  if (cfg.toolsToDefault && signals.toolsInPlay) {
    return { tier: "default", reason: "tools in play this turn → default tier" };
  }
  if (signals.contextTokens > cfg.contextTokenThreshold) {
    return {
      tier: "default",
      reason: `context ${signals.contextTokens} tokens > ${cfg.contextTokenThreshold} threshold → default tier`,
    };
  }
  if (signals.priorTurnToolUseCount >= cfg.priorToolDensityThreshold) {
    return {
      tier: "default",
      reason: `prior turn ran ${signals.priorTurnToolUseCount} tool calls (>= ${cfg.priorToolDensityThreshold}) → default tier`,
    };
  }
  return { tier: "fast", reason: "no hard-turn signal → fast tier" };
}

/** One resolved tier: its adapter + the wire model id it resolved to. */
export type ResolvedTier = {
  readonly adapter: ProviderAdapter;
  readonly modelId: string;
  readonly modelString: string;
};

export type TierRouterOptions = {
  readonly fast: ResolvedTier;
  readonly default: ResolvedTier;
  readonly config?: TierRoutingConfig;
};

/**
 * Boot-time holder of both resolved tier adapters. runtime-core resolves the
 * two adapters (mirroring the compaction second-adapter wiring) and hands
 * them here; the loop then calls `route(signals)` each turn, streams through
 * `.tier(tier).adapter`, and on a fast-tier FAILURE re-runs on `default`
 * (escalation — the misroute recovery).
 */
export interface TierRouter {
  /** Pure per-turn decision from the loop's signals. */
  route(signals: TierSignals): TierDecision;
  /** The resolved adapter/model for a tier. */
  tier(tier: ModelTier): ResolvedTier;
  /** The default-tier escalation target for a fast-tier misroute recovery. */
  escalation(): ResolvedTier;
}

export function createTierRouter(opts: TierRouterOptions): TierRouter {
  const config = opts.config ?? {};
  return {
    route(signals: TierSignals): TierDecision {
      return pickTier(signals, config);
    },
    tier(tier: ModelTier): ResolvedTier {
      return tier === "fast" ? opts.fast : opts.default;
    },
    escalation(): ResolvedTier {
      return opts.default;
    },
  };
}
