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
