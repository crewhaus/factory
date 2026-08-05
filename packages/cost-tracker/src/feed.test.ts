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
import { DEFAULT_PRICING, resolvePricing } from "./pricing";

/** A feed covering every provider — the only shape accepted by default. */
const completeFeed = (version = "2026-07-01") => ({
  version,
  providers: {
    anthropic: { "claude-opus-4": { inputPer1M: 12, outputPer1M: 60 } },
    openai: { "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 } },
    gemini: { "gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 10 } },
    bedrock: { "anthropic.claude-opus-5": { inputPer1M: 5, outputPer1M: 25 } },
  },
});

describe("parsePricingFeed", () => {
  test("accepts a well-formed feed", () => {
    const table = parsePricingFeed(JSON.stringify(completeFeed()));
    expect(table.version).toBe("2026-07-01");
    expect(table.providers.anthropic?.["claude-opus-4"]?.inputPer1M).toBe(12);
  });

  test("rejects a feed that omits a provider (it would price that provider at $0)", () => {
    // A feed REPLACES the effective table, so a provider absent from the feed
    // has no rows at all — every one of its models becomes a pricing miss,
    // which cost-tracker charges at $0.
    const partial = completeFeed();
    (partial.providers as Record<string, unknown>)["gemini"] = {};
    expect(() => parsePricingFeed(JSON.stringify(partial))).toThrow(/incomplete/);
  });

  test("rejects the empty-providers feed that silently zeroed the whole table", () => {
    // Regression: `{"version":"2099-01-01","providers":{}}` parsed clean, won
    // pickNewestPricing on version, and turned EVERY model into a $0 miss.
    // One file dropped into ~/.crewhaus/pricing/ was enough to zero all billing.
    const evil = JSON.stringify({ version: "2099-01-01", providers: {} });
    expect(() => parsePricingFeed(evil)).toThrow(PricingFeedError);

    // Closed end-to-end, not merely at the parser boundary.
    let zeroed = false;
    try {
      const table = parsePricingFeed(evil);
      const winner = pickNewestPricing([DEFAULT_PRICING, table]);
      zeroed = resolvePricing(winner, "anthropic", "claude-opus-5") === undefined;
    } catch {
      zeroed = false;
    }
    expect(zeroed).toBe(false);
  });

  test("partial:true opts a caller into an incomplete feed deliberately", () => {
    const partial = { version: "2026-07-01", providers: { anthropic: {} } };
    expect(() => parsePricingFeed(JSON.stringify(partial))).toThrow(/incomplete/);
    expect(parsePricingFeed(JSON.stringify(partial), { partial: true }).version).toBe("2026-07-01");
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
