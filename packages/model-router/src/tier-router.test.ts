/**
 * Item 26 — two-tier router decision + boot holder tests.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { type ResolvedTier, type TierSignals, createTierRouter, pickTier } from "./tier-router";

const EASY: TierSignals = {
  contextTokens: 500,
  toolsInPlay: false,
  turnIndex: 3,
  priorTurnToolUseCount: 0,
};

describe("pickTier — deterministic tier decision", () => {
  test("an all-easy mid-conversation turn routes to fast", () => {
    const d = pickTier(EASY);
    expect(d.tier).toBe("fast");
    expect(d.reason).toContain("fast tier");
  });

  test("first turn (index 0) escalates to default", () => {
    expect(pickTier({ ...EASY, turnIndex: 0 }).tier).toBe("default");
    expect(pickTier({ ...EASY, turnIndex: 0 }).reason).toContain("first turn");
  });

  test("tools in play escalate to default", () => {
    const d = pickTier({ ...EASY, toolsInPlay: true });
    expect(d.tier).toBe("default");
    expect(d.reason).toContain("tools in play");
  });

  test("large context escalates to default", () => {
    const d = pickTier({ ...EASY, contextTokens: 20_000 });
    expect(d.tier).toBe("default");
    expect(d.reason).toContain("context");
  });

  test("dense prior tool turn escalates to default", () => {
    const d = pickTier({ ...EASY, priorTurnToolUseCount: 3 });
    expect(d.tier).toBe("default");
    expect(d.reason).toContain("prior turn");
  });

  test("just-below thresholds stay on fast", () => {
    expect(
      pickTier({
        contextTokens: 16_000,
        toolsInPlay: false,
        turnIndex: 2,
        priorTurnToolUseCount: 2,
      }).tier,
    ).toBe("fast");
  });

  test("config can disable the tools escalator", () => {
    const d = pickTier({ ...EASY, toolsInPlay: true }, { toolsToDefault: false });
    expect(d.tier).toBe("fast");
  });

  test("config can disable the first-turn escalator", () => {
    const d = pickTier({ ...EASY, turnIndex: 0 }, { firstTurnToDefault: false });
    expect(d.tier).toBe("fast");
  });

  test("custom context threshold is honored", () => {
    expect(pickTier({ ...EASY, contextTokens: 5_000 }, { contextTokenThreshold: 4_000 }).tier).toBe(
      "default",
    );
  });

  test("custom prior-tool-density threshold is honored", () => {
    expect(
      pickTier({ ...EASY, priorTurnToolUseCount: 1 }, { priorToolDensityThreshold: 1 }).tier,
    ).toBe("default");
  });

  test("the decision is a pure function (same signals → same tier)", () => {
    const a = pickTier(EASY);
    const b = pickTier(EASY);
    expect(a).toEqual(b);
  });
});

function stubAdapter(id: string): ProviderAdapter {
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: false,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    // biome-ignore lint/correctness/useYield: stub never yields
    stream: async function* () {
      throw new Error(`stub ${id} not streamed in this test`);
    },
  };
}

describe("createTierRouter — boot holder", () => {
  const fast: ResolvedTier = {
    adapter: stubAdapter("fast"),
    modelId: "claude-haiku-4-5",
    modelString: "claude-haiku-4-5",
  };
  const dflt: ResolvedTier = {
    adapter: stubAdapter("default"),
    modelId: "claude-sonnet-4-5",
    modelString: "claude-sonnet-4-5",
  };

  test("route() delegates to pickTier and tier() returns the resolved adapter", () => {
    const router = createTierRouter({ fast, default: dflt });
    expect(router.route(EASY).tier).toBe("fast");
    expect(router.tier("fast").modelString).toBe("claude-haiku-4-5");
    expect(router.tier("default").modelString).toBe("claude-sonnet-4-5");
  });

  test("escalation() is always the default tier (fast→default misroute target)", () => {
    const router = createTierRouter({ fast, default: dflt });
    expect(router.escalation().modelString).toBe("claude-sonnet-4-5");
  });

  test("router config threads into route()", () => {
    const router = createTierRouter({ fast, default: dflt, config: { firstTurnToDefault: false } });
    expect(router.route({ ...EASY, turnIndex: 0 }).tier).toBe("fast");
  });
});
