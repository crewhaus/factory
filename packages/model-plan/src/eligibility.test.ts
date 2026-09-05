/**
 * N1 capability-eligibility routing (§7.11): the requirement vector meets each
 * candidate's features, declared requires, breaker, enabled flag and cost cap;
 * eligible[] keeps declared order; cheapest eligible breaks ties.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderFeatures } from "@crewhaus/adapter-anthropic";
import {
  type EligibilityCandidate,
  cheapestEligible,
  eligibleCandidates,
  strongestArm,
} from "./eligibility";

const FULL: ProviderFeatures = {
  caching: "explicit",
  tool_use: true,
  vision: true,
  thinking: true,
  web_search: true,
};
const LOCAL: ProviderFeatures = {
  caching: false,
  tool_use: true,
  vision: false,
  thinking: false,
  web_search: false,
};

const ROSTER: EligibilityCandidate[] = [
  {
    armId: "local",
    capabilities: { features: LOCAL, contextWindow: 8192, maxOutputTokens: 2048 },
    blendedPer1M: 0,
  },
  {
    armId: "fast",
    capabilities: { features: FULL, contextWindow: 200000, maxOutputTokens: 64000 },
    blendedPer1M: 1.6,
  },
  {
    armId: "strong",
    capabilities: { features: FULL, contextWindow: 200000, maxOutputTokens: 32000 },
    blendedPer1M: 30,
  },
];

describe("eligibleCandidates", () => {
  test("an empty requirement leaves everyone eligible, declared order", () => {
    const r = eligibleCandidates(ROSTER, {});
    expect(r.eligible).toEqual(["local", "fast", "strong"]);
    expect(r.excluded).toEqual([]);
  });

  test("images need vision", () => {
    const r = eligibleCandidates(ROSTER, { hasImages: true });
    expect(r.eligible).toEqual(["fast", "strong"]);
    expect(r.excluded).toEqual([{ armId: "local", reason: "requires:vision" }]);
  });

  test("a transcript that outgrows a small context window moves the turn", () => {
    const r = eligibleCandidates(ROSTER, { contextTokens: 7500 });
    expect(r.eligible).toEqual(["fast", "strong"]);
    expect(r.excluded[0]).toEqual({ armId: "local", reason: "context-window" });
    // 10% headroom by default: 8192 * 0.9 = 7372.8 → 7000 still fits
    expect(eligibleCandidates(ROSTER, { contextTokens: 7000 }).eligible).toContain("local");
    expect(
      eligibleCandidates(ROSTER, { contextTokens: 7000 }, { contextHeadroomRatio: 0.2 }).eligible,
    ).not.toContain("local");
  });

  test("an unknown context window is not a veto", () => {
    const r = eligibleCandidates([{ armId: "x", capabilities: { features: FULL } }], {
      contextTokens: 10_000_000,
    });
    expect(r.eligible).toEqual(["x"]);
  });

  test("a matched rule's requires is honoured", () => {
    const r = eligibleCandidates(ROSTER, { requires: { thinking: true } });
    expect(r.eligible).toEqual(["fast", "strong"]);
    expect(r.excluded[0]?.reason).toBe("requires:thinking");
  });

  test("tools in play need tool_use; unknown adapter features cannot satisfy it", () => {
    const roster: EligibilityCandidate[] = [
      { armId: "unknown" },
      { armId: "no-tools", capabilities: { features: { ...LOCAL, tool_use: false } } },
      { armId: "ok", capabilities: { features: LOCAL } },
    ];
    const r = eligibleCandidates(roster, { toolsInPlay: true });
    expect(r.eligible).toEqual(["ok"]);
    expect(r.excluded).toEqual([
      { armId: "unknown", reason: "no-adapter-features" },
      { armId: "no-tools", reason: "requires:tool_use" },
    ]);
  });

  test("disabled, breaker-open and cost-cap-spent candidates sit out", () => {
    const roster: EligibilityCandidate[] = [
      { armId: "a", enabled: false },
      { armId: "b", breakerState: "open" },
      { armId: "c", costCapUsdMicros: 500_000, spentUsdMicros: 500_000 },
      { armId: "d", costCapUsdMicros: 500_000, spentUsdMicros: 499_999 },
      { armId: "e", breakerState: "half_open" },
    ];
    const r = eligibleCandidates(roster, {});
    expect(r.eligible).toEqual(["d", "e"]);
    expect(r.excluded.map((e) => e.reason)).toEqual(["disabled", "breaker-open", "cost-cap-spent"]);
  });

  test("a profile whose own requires its model cannot meet is ineligible", () => {
    const r = eligibleCandidates(
      [{ armId: "x", capabilities: { features: LOCAL }, requires: { vision: true } }],
      {},
    );
    expect(r.excluded).toEqual([{ armId: "x", reason: "self-requires:vision" }]);
  });

  test("the result is a pure function of its inputs (replayable)", () => {
    const turn = { hasImages: true, contextTokens: 5000, toolsInPlay: true };
    expect(eligibleCandidates(ROSTER, turn)).toEqual(eligibleCandidates(ROSTER, turn));
  });
});

describe("cheapestEligible", () => {
  test("lowest known blended price wins; unknown ranks after known; ties keep declared order", () => {
    expect(cheapestEligible(eligibleCandidates(ROSTER, {}), ROSTER)).toBe("local");
    expect(cheapestEligible(eligibleCandidates(ROSTER, { hasImages: true }), ROSTER)).toBe("fast");
    const roster: EligibilityCandidate[] = [
      { armId: "unknown-price" },
      { armId: "priced", blendedPer1M: 5 },
      { armId: "tie", blendedPer1M: 5 },
    ];
    expect(cheapestEligible(eligibleCandidates(roster, {}), roster)).toBe("priced");
    expect(cheapestEligible({ eligible: [], excluded: [] }, roster)).toBeUndefined();
  });
});

describe("strongestArm", () => {
  test("first strong-tagged, else last declared, else undefined", () => {
    expect(
      strongestArm([
        { armId: "a", tags: ["cheap"] },
        { armId: "b", tags: ["strong"] },
        { armId: "c", tags: ["strong"] },
      ])?.armId,
    ).toBe("b");
    expect(strongestArm([{ armId: "a" }, { armId: "b" }])?.armId).toBe("b");
    expect(strongestArm([])).toBeUndefined();
    expect(strongestArm([{ armId: "a", tags: ["big"] }, { armId: "b" }], "big")?.armId).toBe("a");
  });
});
