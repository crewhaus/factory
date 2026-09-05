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

// ---------------------------------------------------------------------------
// 0.6.0 §9.1 — feed `sunsets`: installed by `pricing sync`, no release needed
// ---------------------------------------------------------------------------

import { KNOWN_SUNSETS, effectiveSunsets, findSunset as findSunsetIn } from "./feed";

const FULL_FEED = {
  version: "2026-09-01",
  providers: {
    anthropic: { "claude-sonnet-4-5": { inputPer1M: 3, outputPer1M: 15 } },
    openai: { "gpt-5": { inputPer1M: 1, outputPer1M: 4 } },
    gemini: { "gemini-2.5-pro": { inputPer1M: 1, outputPer1M: 4 } },
    bedrock: { "anthropic.claude": { inputPer1M: 3, outputPer1M: 15 } },
  },
};

describe("pricing feed sunsets (0.6.0)", () => {
  test("a well-formed sunsets section parses and rides the table", () => {
    const table = parsePricingFeed(
      JSON.stringify({
        ...FULL_FEED,
        sunsets: {
          anthropic: [
            {
              modelIdPrefix: "claude-sonnet-4-5",
              retiresOn: "2027-03-01",
              replacement: "claude-sonnet-5",
            },
          ],
        },
      }),
    );
    expect(table.sunsets?.["anthropic"]?.[0]?.replacement).toBe("claude-sonnet-5");
  });

  test("a feed without sunsets is unchanged (the key is optional)", () => {
    expect(parsePricingFeed(JSON.stringify(FULL_FEED)).sunsets).toBeUndefined();
  });

  test.each([
    ["not an object", { sunsets: [] }, /must map providers/],
    ["unknown provider", { sunsets: { mistral: [] } }, /unknown provider "mistral"/],
    ["non-array provider", { sunsets: { anthropic: {} } }, /must be an array/],
    [
      "missing prefix",
      { sunsets: { anthropic: [{ retiresOn: "2027-01-01", replacement: "x" }] } },
      /modelIdPrefix/,
    ],
    [
      "bad date",
      { sunsets: { anthropic: [{ modelIdPrefix: "a", retiresOn: "soon", replacement: "x" }] } },
      /YYYY-MM-DD/,
    ],
    [
      "missing replacement",
      { sunsets: { anthropic: [{ modelIdPrefix: "a", retiresOn: "2027-01-01" }] } },
      /replacement/,
    ],
    [
      "non-string note",
      {
        sunsets: {
          anthropic: [{ modelIdPrefix: "a", retiresOn: "2027-01-01", replacement: "x", note: 3 }],
        },
      },
      /note/,
    ],
  ])("a malformed sunsets section rejects the whole feed: %s", (_label, extra, re) => {
    expect(() => parsePricingFeed(JSON.stringify({ ...FULL_FEED, ...extra }))).toThrow(re);
  });

  test("effectiveSunsets adds feed families as source: feed and keeps compiled-in ones as builtin", () => {
    const merged = effectiveSunsets({
      ...FULL_FEED,
      sunsets: {
        anthropic: [
          // a brand-new family
          {
            modelIdPrefix: "claude-sonnet-4-5",
            retiresOn: "2027-03-01",
            replacement: "claude-sonnet-5",
          },
          // a refresh of a compiled-in family: the date moves, the source does NOT
          {
            modelIdPrefix: "claude-3-5-haiku",
            retiresOn: "2026-12-01",
            replacement: "claude-haiku-4-5",
          },
        ],
        bedrock: [
          {
            modelIdPrefix: "anthropic.claude-v2",
            retiresOn: "2026-10-01",
            replacement: "anthropic.claude-sonnet-4-5",
          },
        ],
      },
    });
    const added = findSunsetIn("anthropic", "claude-sonnet-4-5-20260101", merged);
    expect(added).toMatchObject({ replacement: "claude-sonnet-5", source: "feed" });
    const refreshed = findSunsetIn("anthropic", "claude-3-5-haiku", merged);
    expect(refreshed).toMatchObject({ retiresOn: "2026-12-01", source: "builtin" });
    expect(findSunsetIn("bedrock", "anthropic.claude-v2", merged)?.source).toBe("feed");
    // Compiled-in entries all carry their source; untouched providers survive.
    expect(merged["openai"]?.every((e) => e.source === "builtin")).toBe(true);
    // The compiled-in table itself is not mutated.
    expect(
      KNOWN_SUNSETS["anthropic"]?.find((e) => e.modelIdPrefix === "claude-3-5-haiku")?.retiresOn,
    ).toBe("2026-10-01");
  });

  test("effectiveSunsets over the built-in table (no feed) is the compiled-in table, stamped", () => {
    const merged = effectiveSunsets(undefined);
    expect(Object.keys(merged).sort()).toEqual(Object.keys(KNOWN_SUNSETS).sort());
    expect(merged["anthropic"]?.length).toBe(KNOWN_SUNSETS["anthropic"]?.length);
    expect(merged["anthropic"]?.[0]?.source).toBe("builtin");
  });
});
