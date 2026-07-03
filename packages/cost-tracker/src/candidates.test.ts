/**
 * Items 24 & 25 — candidate enumeration, cheapest sentinel, right-size ranking.
 */
import { describe, expect, test } from "bun:test";
import {
  blendedPer1M,
  enumerateCandidates,
  familyPrefixOf,
  rankRightSizeProposals,
  resolveCheapest,
  specStringFor,
} from "./candidates";
import type { CapabilityTable } from "./capabilities";
import type { PricingTable } from "./pricing";

// Small seeded tables so enumeration/ranking is legible.
const PRICING: PricingTable = {
  version: "test",
  providers: {
    anthropic: {
      "claude-opus": { inputPer1M: 15, outputPer1M: 75 },
      "claude-sonnet": { inputPer1M: 3, outputPer1M: 15 },
      "claude-haiku": { inputPer1M: 1, outputPer1M: 5 },
    },
    openai: {
      "gpt-big": { inputPer1M: 10, outputPer1M: 30 },
      "gpt-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
    },
  },
};

const CAPS: CapabilityTable = {
  version: "test",
  providers: {
    anthropic: {
      "claude-opus": {
        caching: "explicit",
        tool_use: true,
        vision: true,
        thinking: true,
        web_search: true,
      },
      "claude-sonnet": {
        caching: "explicit",
        tool_use: true,
        vision: true,
        thinking: true,
        web_search: true,
      },
      "claude-haiku": {
        caching: "explicit",
        tool_use: true,
        vision: false,
        thinking: false,
        web_search: false,
      },
    },
    openai: {
      "gpt-big": {
        caching: "automatic",
        tool_use: true,
        vision: true,
        thinking: false,
        web_search: false,
      },
      "gpt-mini": {
        caching: "automatic",
        tool_use: false,
        vision: false,
        thinking: false,
        web_search: false,
      },
    },
  },
};

describe("specStringFor", () => {
  test("reconstructs spec strings per provider", () => {
    expect(specStringFor("anthropic", "claude-haiku")).toBe("claude-haiku");
    expect(specStringFor("openai", "gpt-mini")).toBe("openai/gpt-mini");
    expect(specStringFor("gemini", "gemini-2.5-flash")).toBe("gemini/gemini-2.5-flash");
    expect(specStringFor("bedrock", "meta.llama3-1-70b")).toBe("bedrock/meta.llama3-1-70b");
  });
});

describe("enumerateCandidates", () => {
  test("returns all pricing rows cheapest-blended first (cross-provider)", () => {
    const cands = enumerateCandidates(
      { provider: "anthropic", modelId: "claude-opus" },
      { pricing: PRICING, capabilities: CAPS },
    );
    // gpt-mini cheapest, then claude-haiku, sonnet, gpt-big, opus.
    expect(cands.map((c) => c.modelString)).toEqual([
      "openai/gpt-mini",
      "claude-haiku",
      "claude-sonnet",
      "openai/gpt-big",
      "claude-opus",
    ]);
  });

  test("sameProviderOnly restricts to the current provider", () => {
    const cands = enumerateCandidates(
      { provider: "anthropic", modelId: "claude-opus" },
      { pricing: PRICING, capabilities: CAPS, sameProviderOnly: true },
    );
    expect(cands.every((c) => c.provider === "anthropic")).toBe(true);
    expect(cands.map((c) => c.modelString)).toEqual([
      "claude-haiku",
      "claude-sonnet",
      "claude-opus",
    ]);
  });

  test("excludeCurrent drops the current family", () => {
    const cands = enumerateCandidates(
      { provider: "anthropic", modelId: "claude-opus" },
      { pricing: PRICING, capabilities: CAPS, sameProviderOnly: true, excludeCurrent: true },
    );
    expect(cands.map((c) => c.modelString)).toEqual(["claude-haiku", "claude-sonnet"]);
  });

  test("capability requirement excludes incapable rows", () => {
    // require tool_use → gpt-mini (tool_use:false) is dropped.
    const cands = enumerateCandidates(
      { provider: "anthropic", modelId: "claude-opus" },
      { pricing: PRICING, capabilities: CAPS, require: { tool_use: true } },
    );
    expect(cands.some((c) => c.modelString === "openai/gpt-mini")).toBe(false);
    expect(cands[0]?.modelString).toBe("claude-haiku");
  });

  test("require vision drops vision-less families", () => {
    const cands = enumerateCandidates(
      { provider: "anthropic", modelId: "claude-opus" },
      { pricing: PRICING, capabilities: CAPS, require: { vision: true } },
    );
    // haiku (vision:false) + gpt-mini (vision:false) excluded.
    expect(cands.map((c) => c.modelString).sort()).toEqual([
      "claude-opus",
      "claude-sonnet",
      "openai/gpt-big",
    ]);
  });
});

describe("familyPrefixOf", () => {
  test("resolves the pricing family for a concrete id", () => {
    expect(familyPrefixOf(PRICING, "anthropic", "claude-opus")).toBe("claude-opus");
    expect(familyPrefixOf(PRICING, "anthropic", "claude-sonnet-4-5")).toBe("claude-sonnet");
  });
  test("undefined for an unknown id", () => {
    expect(familyPrefixOf(PRICING, "openai", "nope")).toBeUndefined();
  });
});

describe("resolveCheapest sentinel", () => {
  test("cheapest same-provider family satisfying the requirement", () => {
    const cheapest = resolveCheapest(
      { provider: "anthropic", modelId: "claude-opus" },
      { pricing: PRICING, capabilities: CAPS, require: { tool_use: true } },
    );
    // haiku is cheapest anthropic, and it has tool_use.
    expect(cheapest?.modelString).toBe("claude-haiku");
  });

  test("skips the cheapest when it fails the requirement, picks next", () => {
    // require vision: haiku (vision:false) is skipped → sonnet is cheapest capable.
    const cheapest = resolveCheapest(
      { provider: "anthropic", modelId: "claude-opus" },
      { pricing: PRICING, capabilities: CAPS, require: { vision: true } },
    );
    expect(cheapest?.modelString).toBe("claude-sonnet");
  });

  test("undefined when nothing in the provider qualifies", () => {
    const cheapest = resolveCheapest(
      { provider: "openai", modelId: "gpt-big" },
      { pricing: PRICING, capabilities: CAPS, require: { thinking: true } },
    );
    expect(cheapest).toBeUndefined();
  });

  test("never hops provider even when a cross-provider model is cheaper", () => {
    const cheapest = resolveCheapest(
      { provider: "anthropic", modelId: "claude-opus" },
      { pricing: PRICING, capabilities: CAPS },
    );
    expect(cheapest?.provider).toBe("anthropic");
  });
});

describe("blendedPer1M", () => {
  test("3:1 input:output blend", () => {
    // (15*3 + 75)/4 = 30
    expect(blendedPer1M({ inputPer1M: 15, outputPer1M: 75 })).toBe(30);
  });
});

describe("rankRightSizeProposals", () => {
  const baseline = { passRate: 0.9, costUsd: 1.0 };

  test("recommends a candidate that holds pass rate and cuts cost", () => {
    const ranked = rankRightSizeProposals(
      baseline,
      [{ modelString: "claude-haiku", slot: "agent", passRate: 0.9, costUsd: 0.3 }],
      { minCostDropRatio: 0.2 },
    );
    expect(ranked[0]?.recommended).toBe(true);
    expect(ranked[0]?.savingUsd).toBeCloseTo(0.7, 10);
    expect(ranked[0]?.costDropRatio).toBeCloseTo(0.7, 10);
  });

  test("rejects a candidate that drops pass rate beyond tolerance", () => {
    const ranked = rankRightSizeProposals(
      baseline,
      [{ modelString: "cheap-but-dumb", slot: "agent", passRate: 0.7, costUsd: 0.1 }],
      { minCostDropRatio: 0.2, passRateTolerance: 0.05 },
    );
    expect(ranked[0]?.recommended).toBe(false);
    expect(ranked[0]?.reason).toContain("pass rate dropped");
  });

  test("rejects a candidate whose cost drop is too small", () => {
    const ranked = rankRightSizeProposals(
      baseline,
      [{ modelString: "barely-cheaper", slot: "agent", passRate: 0.9, costUsd: 0.95 }],
      { minCostDropRatio: 0.2 },
    );
    expect(ranked[0]?.recommended).toBe(false);
    expect(ranked[0]?.reason).toContain("< required");
  });

  test("recommended proposals rank by dollars saved desc, before non-recommended", () => {
    const ranked = rankRightSizeProposals(
      baseline,
      [
        { modelString: "small-save", slot: "agent", passRate: 0.9, costUsd: 0.7 },
        { modelString: "big-save", slot: "agent", passRate: 0.9, costUsd: 0.2 },
        { modelString: "regressed", slot: "agent", passRate: 0.5, costUsd: 0.05 },
      ],
      { minCostDropRatio: 0.2 },
    );
    expect(ranked.map((r) => r.modelString)).toEqual(["big-save", "small-save", "regressed"]);
    expect(ranked[2]?.recommended).toBe(false);
  });

  test("within-tolerance pass-rate dip still recommends", () => {
    const ranked = rankRightSizeProposals(
      baseline,
      [{ modelString: "haiku", slot: "agent", passRate: 0.88, costUsd: 0.3 }],
      { minCostDropRatio: 0.2, passRateTolerance: 0.05 },
    );
    expect(ranked[0]?.recommended).toBe(true);
  });
});
