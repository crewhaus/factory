/**
 * Item 24 — pricing feed + freshness/sunset tests.
 */
import { describe, expect, test } from "bun:test";
import {
  PricingFeedError,
  classifyPricingStaleness,
  findSunset,
  parsePricingFeed,
  pickNewestPricing,
  pricingTableAgeDays,
} from "./feed";
import { DEFAULT_PRICING } from "./pricing";

describe("parsePricingFeed", () => {
  test("accepts a well-formed feed", () => {
    const table = parsePricingFeed(
      JSON.stringify({
        version: "2026-07-01",
        providers: { anthropic: { "claude-opus-4": { inputPer1M: 12, outputPer1M: 60 } } },
      }),
    );
    expect(table.version).toBe("2026-07-01");
    expect(table.providers.anthropic?.["claude-opus-4"]?.inputPer1M).toBe(12);
  });

  test("rejects non-JSON", () => {
    expect(() => parsePricingFeed("{not json")).toThrow(PricingFeedError);
  });

  test("rejects a feed missing version", () => {
    expect(() => parsePricingFeed(JSON.stringify({ providers: {} }))).toThrow(/version/);
  });

  test("rejects an unknown provider", () => {
    expect(() =>
      parsePricingFeed(JSON.stringify({ version: "2026-07-01", providers: { cohere: {} } })),
    ).toThrow(/unknown provider/);
  });

  test("rejects a malformed row", () => {
    expect(() =>
      parsePricingFeed(
        JSON.stringify({
          version: "2026-07-01",
          providers: { openai: { "gpt-4o": { inputPer1M: "cheap" } } },
        }),
      ),
    ).toThrow(/not a valid pricing row/);
  });
});

describe("pricing staleness", () => {
  test("ageDays computes the day delta from a dated version", () => {
    const age = pricingTableAgeDays("2026-05-08", new Date("2026-05-18T00:00:00Z"));
    expect(age).toBe(10);
  });

  test("non-date version is unverifiable → stale", () => {
    const s = classifyPricingStaleness(
      { version: "beta", providers: {} },
      new Date("2026-07-01"),
      90,
    );
    expect(s.stale).toBe(true);
    expect(s.ageDays).toBeUndefined();
  });

  test("within threshold is fresh; beyond is stale", () => {
    const fresh = classifyPricingStaleness(DEFAULT_PRICING, new Date("2026-06-01"), 90);
    expect(fresh.stale).toBe(false);
    const stale = classifyPricingStaleness(DEFAULT_PRICING, new Date("2027-01-01"), 90);
    expect(stale.stale).toBe(true);
    expect(stale.reason).toContain("days old");
  });
});

describe("findSunset", () => {
  test("flags a sunset model with its replacement", () => {
    const s = findSunset("anthropic", "claude-3-5-haiku");
    expect(s?.replacement).toBe("claude-haiku-4-5");
    expect(s?.retiresOn).toBe("2026-10-01");
  });

  test("current-generation model is clean", () => {
    expect(findSunset("anthropic", "claude-sonnet-4-5")).toBeUndefined();
  });

  test("openai gpt-4o is flagged", () => {
    expect(findSunset("openai", "gpt-4o")?.replacement).toBe("gpt-5");
  });

  test("unknown provider is clean", () => {
    expect(findSunset("nope", "whatever")).toBeUndefined();
  });
});

describe("pickNewestPricing", () => {
  test("empty → DEFAULT_PRICING", () => {
    expect(pickNewestPricing([]).version).toBe(DEFAULT_PRICING.version);
  });

  test("picks the lexicographically-latest dated version", () => {
    const a = { version: "2026-05-08", providers: {} };
    const b = { version: "2026-07-01", providers: {} };
    const c = { version: "2026-06-15", providers: {} };
    expect(pickNewestPricing([a, b, c]).version).toBe("2026-07-01");
  });
});
