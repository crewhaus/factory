/**
 * Items 24 & 25 — capability table tests.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_CAPABILITIES, resolveCapabilities, satisfiesCapabilities } from "./capabilities";

describe("resolveCapabilities", () => {
  test("matches claude family by longest prefix", () => {
    const caps = resolveCapabilities(DEFAULT_CAPABILITIES, "anthropic", "claude-sonnet-4-5");
    expect(caps?.caching).toBe("explicit");
    expect(caps?.tool_use).toBe(true);
    expect(caps?.thinking).toBe(true);
  });

  test("3-5-haiku has no thinking", () => {
    const caps = resolveCapabilities(DEFAULT_CAPABILITIES, "anthropic", "claude-3-5-haiku");
    expect(caps?.thinking).toBe(false);
  });

  test("openai automatic caching, no thinking", () => {
    const caps = resolveCapabilities(DEFAULT_CAPABILITIES, "openai", "gpt-4o");
    expect(caps?.caching).toBe("automatic");
    expect(caps?.thinking).toBe(false);
  });

  test("bedrock geo-prefixed anthropic id resolves to explicit caching", () => {
    const caps = resolveCapabilities(
      DEFAULT_CAPABILITIES,
      "bedrock",
      "us.anthropic.claude-sonnet-4",
    );
    expect(caps?.caching).toBe("explicit");
  });

  test("bedrock llama is tools-only, no caching/vision", () => {
    const caps = resolveCapabilities(DEFAULT_CAPABILITIES, "bedrock", "meta.llama3-1-70b");
    expect(caps?.caching).toBe(false);
    expect(caps?.tool_use).toBe(true);
    expect(caps?.vision).toBe(false);
  });

  test("unknown model returns undefined", () => {
    expect(resolveCapabilities(DEFAULT_CAPABILITIES, "openai", "totally-made-up")).toBeUndefined();
  });
});

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("expected a defined capability row");
  return v;
}

describe("satisfiesCapabilities", () => {
  const anthropic = must(
    resolveCapabilities(DEFAULT_CAPABILITIES, "anthropic", "claude-sonnet-4-5"),
  );
  const llama = must(resolveCapabilities(DEFAULT_CAPABILITIES, "bedrock", "meta.llama3-1-70b"));

  test("required tool_use satisfied by a tools-capable model", () => {
    expect(satisfiesCapabilities(llama, { tool_use: true })).toBe(true);
  });

  test("required vision NOT satisfied by a vision-less model", () => {
    expect(satisfiesCapabilities(llama, { vision: true })).toBe(false);
  });

  test("required explicit caching needs explicit — automatic fails", () => {
    const openai = must(resolveCapabilities(DEFAULT_CAPABILITIES, "openai", "gpt-4o"));
    expect(satisfiesCapabilities(openai, { caching: "explicit" })).toBe(false);
    expect(satisfiesCapabilities(anthropic, { caching: "explicit" })).toBe(true);
  });

  test("required automatic caching accepts explicit (superset)", () => {
    expect(satisfiesCapabilities(anthropic, { caching: "automatic" })).toBe(true);
    expect(satisfiesCapabilities(llama, { caching: "automatic" })).toBe(false); // no caching at all
  });

  test("empty requirement is always satisfied", () => {
    expect(satisfiesCapabilities(llama, {})).toBe(true);
  });
});

describe("0.6.0 N1 — contextWindow / maxOutputTokens", () => {
  test("every table row carries both size facts", () => {
    for (const [provider, table] of Object.entries(DEFAULT_CAPABILITIES.providers)) {
      for (const [prefix, caps] of Object.entries(table ?? {})) {
        expect(typeof caps.contextWindow, `${provider}/${prefix} contextWindow`).toBe("number");
        expect(typeof caps.maxOutputTokens, `${provider}/${prefix} maxOutputTokens`).toBe("number");
        expect(caps.contextWindow ?? 0).toBeGreaterThan(caps.maxOutputTokens ?? 0);
      }
    }
  });

  test("the conservative shared-subset values resolve by longest prefix", () => {
    expect(
      resolveCapabilities(DEFAULT_CAPABILITIES, "anthropic", "claude-3-5-haiku")?.maxOutputTokens,
    ).toBe(8192);
    expect(
      resolveCapabilities(DEFAULT_CAPABILITIES, "anthropic", "claude-sonnet-4-5")?.contextWindow,
    ).toBe(200000);
    expect(resolveCapabilities(DEFAULT_CAPABILITIES, "openai", "gpt-4o")?.contextWindow).toBe(
      128000,
    );
    expect(
      resolveCapabilities(DEFAULT_CAPABILITIES, "bedrock", "meta.llama3-1-70b")?.maxOutputTokens,
    ).toBe(4096);
  });

  test("size floors: known-and-at-least satisfies, unknown never does", () => {
    const haiku = must(resolveCapabilities(DEFAULT_CAPABILITIES, "anthropic", "claude-3-5-haiku"));
    expect(satisfiesCapabilities(haiku, { contextWindowGte: 200000 })).toBe(true);
    expect(satisfiesCapabilities(haiku, { contextWindowGte: 200001 })).toBe(false);
    expect(satisfiesCapabilities(haiku, { maxOutputTokensGte: 8192 })).toBe(true);
    expect(satisfiesCapabilities(haiku, { maxOutputTokensGte: 16000 })).toBe(false);
    const unknownSizes = { ...haiku, contextWindow: undefined, maxOutputTokens: undefined };
    expect(satisfiesCapabilities(unknownSizes, { contextWindowGte: 1 })).toBe(false);
    expect(satisfiesCapabilities(unknownSizes, { maxOutputTokensGte: 1 })).toBe(false);
    expect(satisfiesCapabilities(unknownSizes, { tool_use: true })).toBe(true);
  });

  test("a tool's requiresModelFeatures is accepted verbatim as a requirement", () => {
    const req: { vision?: boolean; tool_use?: boolean } = { vision: true };
    const sonnet = must(
      resolveCapabilities(DEFAULT_CAPABILITIES, "anthropic", "claude-sonnet-4-5"),
    );
    const llama = must(resolveCapabilities(DEFAULT_CAPABILITIES, "bedrock", "meta.llama3-1-70b"));
    expect(satisfiesCapabilities(sonnet, req)).toBe(true);
    expect(satisfiesCapabilities(llama, req)).toBe(false);
  });
});
