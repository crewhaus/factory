/**
 * Item 28 (half 2) — cache-hit-aware candidate ranking tests.
 *
 * Uses a small SEEDED pricing table (not DEFAULT_PRICING) so the math is
 * legible: an anthropic sibling vs a nominally-cheaper cross-provider
 * openai candidate, and the cache penalty that flips the ordering.
 */
import { describe, expect, test } from "bun:test";
import type { PricingTable } from "./pricing";
import {
  type RankCandidate,
  type SessionCacheProfile,
  cacheProfileFromTotals,
  rankCandidates,
} from "./ranking";

// Seeded table: anthropic input $10/1M (cached-read defaults to ×0.1 = $1/1M),
// openai input $4/1M with an explicit cheap cached-read. Output rates chosen
// so the input term dominates and the penalty is easy to reason about.
const TABLE: PricingTable = {
  version: "test-seed",
  providers: {
    anthropic: {
      "claude-sonnet": { inputPer1M: 10.0, outputPer1M: 20.0 },
      "claude-haiku": { inputPer1M: 1.0, outputPer1M: 5.0 },
    },
    openai: {
      "gpt-cheap": { inputPer1M: 4.0, outputPer1M: 12.0, cachedReadPer1M: 0.4 },
    },
  },
};

const SIBLING: RankCandidate = {
  modelString: "claude-haiku",
  provider: "anthropic",
  modelId: "claude-haiku",
};
const CURRENT: RankCandidate = {
  modelString: "claude-sonnet",
  provider: "anthropic",
  modelId: "claude-sonnet",
};
const CROSS: RankCandidate = {
  modelString: "openai/gpt-cheap",
  provider: "openai",
  modelId: "gpt-cheap",
};

describe("rankCandidates — cache warmth pricing", () => {
  test("high cache-read ratio: same-provider sibling ranks above a cheaper cross-provider hop", () => {
    // Warm session on anthropic: 90% of a 100k-token prompt served from cache.
    const profile: SessionCacheProfile = {
      currentProvider: "anthropic",
      cacheReadRatio: 0.9,
      perTurnInputTokens: 100_000,
      perTurnOutputTokens: 0,
    };
    const ranked = rankCandidates([CROSS, SIBLING], profile, { pricing: TABLE });

    // Sibling (anthropic, input $1/1M): base = 100k × 1 = 100_000 micros, no penalty.
    // Cross (openai, input $4/1M): base = 100k × 4 = 400_000 micros; penalty =
    //   0.9 × 100k × (4 − 0.4) = 324_000 micros → effective 724_000.
    // Even though openai output is cheaper, the sibling wins here on input alone.
    expect(ranked[0]?.candidate.modelString).toBe("claude-haiku");
    expect(ranked[0]?.cacheLossPenaltyMicros).toBe(0);
    expect(ranked[0]?.sameProvider).toBe(true);

    const cross = ranked.find((r) => r.candidate.modelString === "openai/gpt-cheap");
    expect(cross?.baseCostMicros).toBe(400_000);
    expect(cross?.cacheLossPenaltyMicros).toBe(324_000);
    expect(cross?.effectiveCostMicros).toBe(724_000);
    expect(cross?.sameProvider).toBe(false);
  });

  test("cross-provider wins when cheap enough to overcome the penalty", () => {
    // Same warm session, but the same-provider sibling is now EXPENSIVE
    // (the current sonnet at $10/1M input) and the cross candidate is cheap.
    const profile: SessionCacheProfile = {
      currentProvider: "anthropic",
      cacheReadRatio: 0.5,
      perTurnInputTokens: 10_000,
      perTurnOutputTokens: 0,
    };
    const ranked = rankCandidates([CURRENT, CROSS], profile, { pricing: TABLE });

    // Current sonnet: base = 10k × 10 = 100_000, no penalty (same provider).
    // Cross openai: base = 10k × 4 = 40_000; penalty = 0.5 × 10k × 3.6 = 18_000
    //   → effective 58_000 < 100_000. Cross wins despite the penalty.
    expect(ranked[0]?.candidate.modelString).toBe("openai/gpt-cheap");
    expect(ranked[0]?.effectiveCostMicros).toBe(58_000);
    expect(ranked[1]?.candidate.modelString).toBe("claude-sonnet");
    expect(ranked[1]?.effectiveCostMicros).toBe(100_000);
  });

  test("zero cache-read ratio: pure table price, no penalty anywhere", () => {
    const profile: SessionCacheProfile = {
      currentProvider: "anthropic",
      cacheReadRatio: 0,
      perTurnInputTokens: 10_000,
      perTurnOutputTokens: 1_000,
    };
    const ranked = rankCandidates([CURRENT, CROSS, SIBLING], profile, { pricing: TABLE });

    for (const r of ranked) {
      expect(r.cacheLossPenaltyMicros).toBe(0);
      expect(r.effectiveCostMicros).toBe(r.baseCostMicros);
    }
    // Pure sticker ordering: haiku (1×10k+5×1k=15_000) < openai (4×10k+12×1k=52_000)
    //   < sonnet (10×10k+20×1k=120_000).
    expect(ranked.map((r) => r.candidate.modelString)).toEqual([
      "claude-haiku",
      "openai/gpt-cheap",
      "claude-sonnet",
    ]);
  });

  test("same-provider candidates never incur a penalty even at ratio 1", () => {
    const profile: SessionCacheProfile = {
      currentProvider: "anthropic",
      cacheReadRatio: 1,
      perTurnInputTokens: 50_000,
    };
    const ranked = rankCandidates([SIBLING, CURRENT], profile, { pricing: TABLE });
    for (const r of ranked) {
      expect(r.sameProvider).toBe(true);
      expect(r.cacheLossPenaltyMicros).toBe(0);
    }
  });

  test("cacheReadRatio is clamped to [0,1]", () => {
    const over: SessionCacheProfile = {
      currentProvider: "anthropic",
      cacheReadRatio: 5, // absurd — clamps to 1
      perTurnInputTokens: 10_000,
    };
    const at1: SessionCacheProfile = {
      currentProvider: "anthropic",
      cacheReadRatio: 1,
      perTurnInputTokens: 10_000,
    };
    const a = rankCandidates([CROSS], over, { pricing: TABLE })[0];
    const b = rankCandidates([CROSS], at1, { pricing: TABLE })[0];
    expect(a?.cacheLossPenaltyMicros).toBe(b?.cacheLossPenaltyMicros);
    // ratio 1 → full 10k × (4 − 0.4) = 36_000.
    expect(a?.cacheLossPenaltyMicros).toBe(36_000);

    const under = rankCandidates([CROSS], { ...over, cacheReadRatio: -3 }, { pricing: TABLE })[0];
    expect(under?.cacheLossPenaltyMicros).toBe(0);
  });

  test("pricing miss: base 0, flagged, ranked first (free) but marked", () => {
    const unknown: RankCandidate = {
      modelString: "gemini/who-knows",
      provider: "gemini",
      modelId: "who-knows",
    };
    const profile: SessionCacheProfile = {
      currentProvider: "anthropic",
      cacheReadRatio: 0.5,
      perTurnInputTokens: 10_000,
    };
    const ranked = rankCandidates([CURRENT, unknown], profile, { pricing: TABLE });
    const miss = ranked.find((r) => r.candidate.modelString === "gemini/who-knows");
    expect(miss?.pricingMiss).toBe(true);
    expect(miss?.baseCostMicros).toBe(0);
    expect(miss?.cacheLossPenaltyMicros).toBe(0);
  });

  test("stable ordering: equal effective cost keeps input order", () => {
    // Two identical-priced anthropic siblings → input order preserved.
    const a: RankCandidate = { modelString: "a", provider: "anthropic", modelId: "claude-haiku" };
    const b: RankCandidate = { modelString: "b", provider: "anthropic", modelId: "claude-haiku" };
    const profile: SessionCacheProfile = {
      currentProvider: "anthropic",
      cacheReadRatio: 0.9,
      perTurnInputTokens: 10_000,
    };
    const ranked = rankCandidates([a, b], profile, { pricing: TABLE });
    expect(ranked.map((r) => r.candidate.modelString)).toEqual(["a", "b"]);
  });
});

describe("cacheProfileFromTotals", () => {
  test("derives ratio and per-turn shape from run token totals", () => {
    const profile = cacheProfileFromTotals({
      currentProvider: "anthropic",
      inputTokens: 20_000,
      cacheReadTokens: 80_000,
      outputTokens: 4_000,
      modelCalls: 4,
    });
    // readable = 100k; ratio = 80k/100k = 0.8; per-turn input = 100k/4 = 25k.
    expect(profile.cacheReadRatio).toBeCloseTo(0.8, 10);
    expect(profile.perTurnInputTokens).toBe(25_000);
    expect(profile.perTurnOutputTokens).toBe(1_000);
    expect(profile.currentProvider).toBe("anthropic");
  });

  test("zero readable tokens → ratio 0, no divide-by-zero", () => {
    const profile = cacheProfileFromTotals({
      currentProvider: "openai",
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      modelCalls: 0,
    });
    expect(profile.cacheReadRatio).toBe(0);
    expect(Number.isFinite(profile.perTurnInputTokens)).toBe(true);
  });
});
