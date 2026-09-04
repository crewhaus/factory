/**
 * 0.6.0 §4.3 — the `strongest` sentinel: roster-first when a roster exists,
 * price rank via blendedPer1M only for bare single-model specs, the
 * circularity rule for sentinels inside a roster member, cross-provider note.
 */
import { describe, expect, test } from "bun:test";
import {
  STRONGEST_SENTINEL,
  crossesProvider,
  isModelSentinel,
  resolveCheapestForSlot,
  resolveStrongest,
  resolveStrongestForSlot,
  resolveStrongestFromRoster,
} from "./candidates";
import { DEFAULT_PRICING, resolvePricing } from "./pricing";

describe("sentinels", () => {
  test("isModelSentinel recognises both", () => {
    expect(STRONGEST_SENTINEL).toBe("strongest");
    expect(isModelSentinel("cheapest")).toBe(true);
    expect(isModelSentinel("strongest")).toBe(true);
    expect(isModelSentinel("claude-opus-5")).toBe(false);
  });
});

describe("resolveStrongestFromRoster", () => {
  test("first strong-tagged member wins, carrying the profile name", () => {
    const r = resolveStrongestFromRoster([
      { name: "fast", model: "claude-haiku-4-5", tags: ["cheap"] },
      { name: "strong", model: "local/llama3", tags: ["strong"] },
      { name: "strong2", model: "claude-opus-5", tags: ["strong"] },
    ]);
    expect(r).toEqual({
      modelString: "local/llama3",
      profile: "strong",
      source: "roster:strong-tag",
    });
  });

  test("no strong tag → last declared (PolicyRouter.escalation convention)", () => {
    const r = resolveStrongestFromRoster([
      { model: "claude-haiku-4-5", tags: ["cheap"] },
      { model: "openai/gpt-4o" },
    ]);
    expect(r).toEqual({ modelString: "openai/gpt-4o", source: "roster:last-declared" });
  });

  test("a custom strongTag is honoured; sentinel members are skipped; empty → undefined", () => {
    expect(
      resolveStrongestFromRoster(
        [
          { model: "a", tags: ["big"] },
          { model: "b", tags: ["strong"] },
        ],
        { strongTag: "big" },
      )?.modelString,
    ).toBe("a");
    expect(
      resolveStrongestFromRoster([{ model: "claude-haiku-4-5" }, { model: "strongest" }])
        ?.modelString,
    ).toBe("claude-haiku-4-5");
    expect(resolveStrongestFromRoster([])).toBeUndefined();
    expect(resolveStrongestFromRoster([{ model: "cheapest" }])).toBeUndefined();
  });
});

describe("resolveStrongest (price rank)", () => {
  test("picks the most expensive same-provider family, never a sunset one", () => {
    const pick = resolveStrongest({ provider: "anthropic", modelId: "claude-haiku-4-5" });
    expect(pick).toBeDefined();
    const anthropic = DEFAULT_PRICING.providers.anthropic ?? {};
    const maxBlended = Math.max(
      ...Object.values(anthropic).map((row) => (row.inputPer1M * 3 + row.outputPer1M) / 4),
    );
    expect(pick?.blendedPer1M).toBe(maxBlended);
    expect(pick?.provider).toBe("anthropic");
    // and it is genuinely the opposite end from `cheapest`
    const cheapest = resolveCheapestForSlot("claude-haiku-4-5");
    expect(cheapest).toBeDefined();
    expect(pick?.modelString).not.toBe(cheapest);
  });

  test("honours a capability requirement", () => {
    const pick = resolveStrongest(
      { provider: "openai", modelId: "gpt-4o-mini" },
      { require: { vision: true } },
    );
    expect(pick).toBeDefined();
    expect(pick?.provider).toBe("openai");
    expect(resolvePricing(DEFAULT_PRICING, "openai", pick?.familyPrefix ?? "")).toBeDefined();
  });
});

describe("resolveStrongestForSlot", () => {
  const ROSTER = [
    { name: "fast", model: "local/llama3", tags: ["cheap"] },
    { name: "strong", model: "claude-opus-5", tags: ["strong"] },
  ];

  test("roster-first: a local primary with a hosted strong profile compiles", () => {
    // Price rank alone would return undefined here (local/ is not table-backed).
    expect(resolveStrongestForSlot("local/llama3")).toBeUndefined();
    const r = resolveStrongestForSlot("local/llama3", { roster: ROSTER });
    expect(r).toEqual({
      modelString: "claude-opus-5",
      profile: "strong",
      source: "roster:strong-tag",
    });
  });

  test("bare single-model spec falls back to price rank", () => {
    const r = resolveStrongestForSlot("claude-haiku-4-5");
    expect(r?.source).toBe("price-rank");
    expect(r?.profile).toBeUndefined();
    expect(r?.modelString.startsWith("claude-")).toBe(true);
  });

  test("an empty roster behaves like no roster", () => {
    expect(resolveStrongestForSlot("claude-haiku-4-5", { roster: [] })?.source).toBe("price-rank");
  });

  test("circularity rule: inside a roster member the roster is ignored → price rank", () => {
    const r = resolveStrongestForSlot("claude-haiku-4-5", { roster: ROSTER, inRoster: true });
    expect(r?.source).toBe("price-rank");
    expect(r?.modelString).not.toBe("claude-opus-5-from-roster");
    // and a local primary inside a roster member cannot be resolved at all
    expect(
      resolveStrongestForSlot("local/llama3", { roster: ROSTER, inRoster: true }),
    ).toBeUndefined();
  });
});

describe("crossesProvider", () => {
  test("table-backed pairs compare by provider; a local primary beside a hosted pick crosses", () => {
    expect(crossesProvider("claude-haiku-4-5", "claude-opus-5")).toBe(false);
    expect(crossesProvider("claude-haiku-4-5", "openai/gpt-5")).toBe(true);
    expect(crossesProvider("local/llama3", "claude-opus-5")).toBe(true);
    expect(crossesProvider("local/llama3", "local/qwen")).toBe(false);
    expect(crossesProvider("local/llama3", "azure/gpt-4o")).toBe(true);
  });
});
