/**
 * Item 28 (half 2) — cache-hit-aware candidate ranking.
 *
 * Half 1 (already merged) added cache read/write tokens + realized-savings
 * to the cost-summary. This half prices *cache warmth* into a model-switch
 * decision: when a run has been reading warm prompt-cache segments, hopping
 * to a cross-provider sibling throws that cache away (the other provider
 * cannot honour this provider's `cache_control` markers — see the failover
 * meta-adapter's continuity contract), so the true cost of the hop is the
 * new model's table price PLUS the input tokens that must now be re-read
 * cold at the full input rate.
 *
 * `rankCandidates` folds that penalty into an *effective* per-candidate
 * cost so same-provider siblings (which keep the cache alive) can rank above
 * a nominally-cheaper cross-provider candidate — but only up to the point
 * where the cross-provider price advantage genuinely overcomes the re-warm
 * penalty. It is a pure, side-effect-free function; the failover chain
 * consults it only when a caller supplies a ranking profile (additive —
 * default routing is unchanged).
 *
 * The math is deliberately table-only (no live token counts): it estimates
 * "what one representative turn costs on this candidate" from the session's
 * observed per-turn token shape, so a shared, stable ordering falls out
 * without needing to replay traffic.
 */
import type { ProviderId } from "@crewhaus/trace-event-bus";
import { type PricingRow, type PricingTable, resolvePricing } from "./pricing";

/** One model a switch decision may route to. */
export type RankCandidate = {
  /** Spec model string (`"claude-sonnet-4-5"`, `"openai/gpt-4o-mini"`). */
  readonly modelString: string;
  /** Routing provider — same-provider siblings keep the warm cache. */
  readonly provider: ProviderId;
  /** Wire model id the pricing table is keyed on. */
  readonly modelId: string;
};

/**
 * The session's observed cache behaviour, distilled to what ranking needs.
 * Populated from a `cost-tracker` run summary (or hand-built in tests).
 */
export type SessionCacheProfile = {
  /**
   * The provider currently serving the session. A candidate on THIS provider
   * keeps `cache_control` markers valid; any other provider re-warms cold.
   */
  readonly currentProvider: ProviderId;
  /**
   * Fraction of this session's input tokens that were served from a warm
   * cache read, in [0, 1]. 0 → nothing is cached (no penalty for hopping);
   * 1 → every input token was a warm read (a cross-provider hop re-reads the
   * whole prompt cold). Values outside [0, 1] are clamped.
   */
  readonly cacheReadRatio: number;
  /**
   * Representative INPUT tokens for one turn — the size of the prompt that
   * would have to be re-warmed on a cross-provider hop. Typically the
   * session's mean input tokens per model call. Non-positive → the penalty
   * is zero (nothing to re-read).
   */
  readonly perTurnInputTokens: number;
  /**
   * Representative OUTPUT tokens for one turn. Used only to make the base
   * effective cost a full-turn estimate rather than input-only, so
   * output-heavy models are priced fairly. Defaults to 0.
   */
  readonly perTurnOutputTokens?: number;
};

/** A ranked candidate with its priced-in effective cost, best-first. */
export type RankedCandidate = {
  readonly candidate: RankCandidate;
  /**
   * USD-microdollars for one representative turn on this candidate INCLUDING
   * the projected cache-re-warm penalty. Lower is better. Ranking sorts on
   * this ascending.
   */
  readonly effectiveCostMicros: number;
  /**
   * The base per-turn cost from the pricing table BEFORE the penalty. Equal
   * to `effectiveCostMicros` for same-provider candidates (penalty 0).
   */
  readonly baseCostMicros: number;
  /**
   * The cache-loss penalty added on top of the base cost (0 for
   * same-provider candidates and when the session has no warm cache).
   */
  readonly cacheLossPenaltyMicros: number;
  /** True when this candidate stays on `profile.currentProvider`. */
  readonly sameProvider: boolean;
  /** Set when the candidate's pricing row was not found (base cost is 0). */
  readonly pricingMiss?: true;
};

export type RankCandidatesOptions = {
  /** Pricing table. Defaults to `DEFAULT_PRICING` via the index re-export. */
  readonly pricing: PricingTable;
};

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Per-turn base cost from the table: input + output tokens at their rates,
 * ignoring cache (this is the model's *sticker* per-turn price). Missing
 * pricing row → 0 (flagged `pricingMiss` so callers can down-rank / warn).
 */
function baseTurnCostMicros(
  row: PricingRow | undefined,
  perTurnInputTokens: number,
  perTurnOutputTokens: number,
): number {
  if (row === undefined) return 0;
  const input = Math.max(0, perTurnInputTokens);
  const output = Math.max(0, perTurnOutputTokens);
  return Math.round(input * row.inputPer1M + output * row.outputPer1M);
}

/**
 * Cache-re-warm penalty for hopping to `row`'s provider off a warm session.
 *
 * The warm session was reading `cacheReadRatio × perTurnInputTokens` tokens
 * per turn from cache at the discounted cached-read rate. A cross-provider
 * hop loses that: those tokens are re-read cold at the NEW candidate's full
 * input rate. The penalty is the *extra* the candidate pays for that first
 * cold turn relative to what a cached read would have cost on it — i.e. the
 * money the warm cache was saving, denominated at the candidate's own rates.
 *
 * Same-provider candidates keep the markers valid → penalty 0. A session
 * with `cacheReadRatio` 0 → penalty 0 (nothing was cached to lose).
 */
function cacheLossPenaltyMicros(
  row: PricingRow | undefined,
  cacheReadRatio: number,
  perTurnInputTokens: number,
): number {
  if (row === undefined) return 0;
  const warmTokens = clamp01(cacheReadRatio) * Math.max(0, perTurnInputTokens);
  if (warmTokens <= 0) return 0;
  // Effective cached-read rate on the candidate: explicit, else Anthropic-
  // style ×0.1. Mirrors pricing.ts effectiveCachedReadPer1M (kept private
  // there; the ×0.1 fallback is the documented default).
  const cachedReadPer1M = row.cachedReadPer1M ?? row.inputPer1M * 0.1;
  const perTokenPenalty = row.inputPer1M - cachedReadPer1M;
  return Math.round(warmTokens * Math.max(0, perTokenPenalty));
}

/**
 * Rank switch candidates cheapest-effective-cost first, pricing the
 * session's cache warmth into every cross-provider hop.
 *
 * Guarantees exercised by the unit tests:
 *   - High cache-read ratio → a same-provider sibling ranks above a
 *     nominally-cheaper cross-provider candidate (the penalty tips it).
 *   - A cross-provider candidate cheap enough to overcome the penalty still
 *     wins (the penalty is additive, not a veto).
 *   - `cacheReadRatio === 0` → pure table price, penalty 0 everywhere, so
 *     the ordering is exactly the sticker-price ordering.
 *
 * Stable: candidates with equal effective cost keep input order.
 */
export function rankCandidates(
  candidates: ReadonlyArray<RankCandidate>,
  profile: SessionCacheProfile,
  opts: RankCandidatesOptions,
): RankedCandidate[] {
  const outputTokens = profile.perTurnOutputTokens ?? 0;
  const ranked: RankedCandidate[] = candidates.map((candidate) => {
    const row = resolvePricing(opts.pricing, candidate.provider, candidate.modelId);
    const sameProvider = candidate.provider === profile.currentProvider;
    const baseCostMicros = baseTurnCostMicros(row, profile.perTurnInputTokens, outputTokens);
    const cacheLoss = sameProvider
      ? 0
      : cacheLossPenaltyMicros(row, profile.cacheReadRatio, profile.perTurnInputTokens);
    return {
      candidate,
      baseCostMicros,
      cacheLossPenaltyMicros: cacheLoss,
      effectiveCostMicros: baseCostMicros + cacheLoss,
      sameProvider,
      ...(row === undefined ? { pricingMiss: true as const } : {}),
    };
  });
  // Stable ascending sort on effective cost. Array#sort is stable in V8 /
  // JavaScriptCore, so equal-cost candidates keep input order without an
  // explicit index tiebreak.
  return ranked.sort((a, b) => a.effectiveCostMicros - b.effectiveCostMicros);
}

/**
 * Build a `SessionCacheProfile` from a `cost-tracker` run summary's raw
 * token aggregates. Convenience for callers that already hold the per-run
 * cache totals; the ratio is `cacheRead / (input + cacheRead)` — the share
 * of would-be input tokens that were served warm.
 */
export function cacheProfileFromTotals(input: {
  readonly currentProvider: ProviderId;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly outputTokens: number;
  readonly modelCalls: number;
}): SessionCacheProfile {
  const calls = Math.max(1, input.modelCalls);
  const readable = input.inputTokens + input.cacheReadTokens;
  const cacheReadRatio = readable > 0 ? input.cacheReadTokens / readable : 0;
  return {
    currentProvider: input.currentProvider,
    cacheReadRatio,
    // Per-turn INPUT is the full readable prompt (cold + warm) averaged over
    // calls — that whole prompt is what a cross-provider hop re-reads cold.
    perTurnInputTokens: readable / calls,
    perTurnOutputTokens: input.outputTokens / calls,
  };
}
