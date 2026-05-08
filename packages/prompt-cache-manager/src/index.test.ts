/**
 * Section 27 — `prompt-cache-manager` tests:
 *  - T1 rotation trigger logic
 *  - T3 with `caching: "explicit"` confirming rotation injects fresh marker
 *  - T9 ensures `caching: "automatic"`/`false` skip cleanly
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalTextBlockParam, ProviderFeatures } from "@crewhaus/adapter-anthropic";
import { DEFAULT_ROTATE_AFTER_MS, countCacheMarkers, manage } from "./index";

const EXPLICIT: ProviderFeatures = {
  caching: "explicit",
  tool_use: true,
  vision: true,
  thinking: true,
  web_search: true,
};

const AUTOMATIC: ProviderFeatures = {
  caching: "automatic",
  tool_use: true,
  vision: true,
  thinking: false,
  web_search: false,
};

const NO_CACHING: ProviderFeatures = {
  caching: false,
  tool_use: false,
  vision: false,
  thinking: false,
  web_search: false,
};

function blocks(...texts: string[]): CanonicalTextBlockParam[] {
  return texts.map((text) => ({ type: "text" as const, text }));
}

describe("prompt-cache-manager — T1 rotation trigger", () => {
  test("rotates when lastRotatedAt is undefined (first turn)", () => {
    const result = manage(blocks("system A", "system B"), {
      features: EXPLICIT,
      now: () => 1_000_000,
    });
    expect(result.rotated).toBe(true);
    expect(result.rotatedAt).toBe(1_000_000);
    expect(countCacheMarkers(result.blocks)).toBe(1);
    expect(result.blocks[result.blocks.length - 1]?.cache_control).toEqual({
      type: "ephemeral",
    });
  });

  test("rotates when lastRotatedAt is stale (>= rotateAfterMs)", () => {
    const day = 24 * 60 * 60 * 1000;
    const result = manage(blocks("a", "b"), {
      features: EXPLICIT,
      lastRotatedAt: 1_000_000,
      now: () => 1_000_000 + 8 * day, // 8 days later
    });
    expect(result.rotated).toBe(true);
    expect(result.rotatedAt).toBe(1_000_000 + 8 * day);
  });

  test("does NOT rotate when marker is fresh (< rotateAfterMs)", () => {
    const day = 24 * 60 * 60 * 1000;
    const result = manage(blocks("a", "b"), {
      features: EXPLICIT,
      lastRotatedAt: 1_000_000,
      now: () => 1_000_000 + 3 * day, // 3 days later
    });
    expect(result.rotated).toBe(false);
    expect(result.rotatedAt).toBe(1_000_000);
  });

  test("respects custom rotateAfterMs", () => {
    const result = manage(blocks("a"), {
      features: EXPLICIT,
      lastRotatedAt: 1_000_000,
      rotateAfterMs: 1000,
      now: () => 1_002_000,
    });
    expect(result.rotated).toBe(true);
  });

  test("DEFAULT_ROTATE_AFTER_MS is 7 days", () => {
    expect(DEFAULT_ROTATE_AFTER_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("prompt-cache-manager — T3 explicit caching", () => {
  test("strips existing markers on intermediate blocks; only last block keeps marker", () => {
    const input: CanonicalTextBlockParam[] = [
      { type: "text", text: "first", cache_control: { type: "ephemeral" } },
      { type: "text", text: "second", cache_control: { type: "ephemeral" } },
      { type: "text", text: "third" },
    ];
    const result = manage(input, { features: EXPLICIT, now: () => 999 });
    expect(result.rotated).toBe(true);
    expect(countCacheMarkers(result.blocks)).toBe(1);
    expect(result.blocks[0]?.cache_control).toBeUndefined();
    expect(result.blocks[1]?.cache_control).toBeUndefined();
    expect(result.blocks[2]?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("preserves text content verbatim across rotation", () => {
    const result = manage(blocks("alpha", "beta", "gamma"), {
      features: EXPLICIT,
      now: () => 1,
    });
    expect(result.blocks.map((b) => b.text)).toEqual(["alpha", "beta", "gamma"]);
  });

  test("empty blocks array → no-op", () => {
    const result = manage([], { features: EXPLICIT });
    expect(result.rotated).toBe(false);
    expect(result.blocks.length).toBe(0);
  });
});

describe("prompt-cache-manager — T9 skip cleanly for non-explicit caching", () => {
  test("automatic caching → returns input unchanged", () => {
    const input = blocks("a", "b");
    const result = manage(input, { features: AUTOMATIC });
    expect(result.rotated).toBe(false);
    expect(result.blocks).toBe(input);
  });

  test("no caching → returns input unchanged", () => {
    const input = blocks("a", "b");
    const result = manage(input, { features: NO_CACHING });
    expect(result.rotated).toBe(false);
    expect(result.blocks).toBe(input);
  });

  test("automatic with stale lastRotatedAt → still skips (rotated false)", () => {
    const result = manage(blocks("a"), {
      features: AUTOMATIC,
      lastRotatedAt: 1,
      now: () => 1_000_000_000_000,
    });
    expect(result.rotated).toBe(false);
  });
});

describe("prompt-cache-manager — countCacheMarkers", () => {
  test("counts only ephemeral markers", () => {
    const bs: CanonicalTextBlockParam[] = [
      { type: "text", text: "no-marker" },
      { type: "text", text: "marker", cache_control: { type: "ephemeral" } },
      { type: "text", text: "null-marker", cache_control: null },
    ];
    expect(countCacheMarkers(bs)).toBe(1);
  });
});
