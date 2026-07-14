/**
 * Section 27 — `prompt-cache-manager` tests:
 *  - T1 rotation trigger logic
 *  - T3 with `caching: "explicit"` confirming rotation injects fresh marker
 *  - T9 ensures `caching: "automatic"`/`false` skip cleanly
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalTextBlockParam, ProviderFeatures } from "@crewhaus/adapter-anthropic";
import {
  type CacheManagedBlock,
  DEFAULT_ROTATE_AFTER_MS,
  countCacheMarkers,
  manage,
} from "./index";

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

// v0.3.0 Goal 1 (§2.5) — the mutable-tail cache-marker regression suite. A
// bug here silently busts the cached prefix on every turn and multiplies
// cost, so the invariants get their own dedicated block: the volatile tail
// always sits AFTER the marker, and editing the tail never strips or moves
// the marker off the frozen prefix.
describe("prompt-cache-manager — volatile tail blocks (v0.3.0 §2.5)", () => {
  const prefixAndTail = (tailText: string): CacheManagedBlock[] => [
    { type: "text", text: "instructions", cache_control: { type: "ephemeral" } },
    { type: "text", text: "project memory", cache_control: { type: "ephemeral" } },
    { type: "text", text: tailText, volatile: true },
  ];

  test("rotation marks the LAST NON-VOLATILE block — the tail sits AFTER the marker", () => {
    const result = manage(prefixAndTail("<current_plan>ship CSV export</current_plan>"), {
      features: EXPLICIT,
      now: () => 1_000,
    });
    expect(result.rotated).toBe(true);
    expect(countCacheMarkers(result.blocks)).toBe(1);
    // The marker lands on the frozen prefix's final block…
    expect(result.blocks[1]?.cache_control).toEqual({ type: "ephemeral" });
    // …and every block after it is the unmarked volatile tail.
    expect(result.blocks[2]?.cache_control).toBeUndefined();
    expect(result.blocks[2]?.volatile).toBe(true);
    const markerIndex = result.blocks.findIndex((b) => b.cache_control?.type === "ephemeral");
    const firstVolatileIndex = result.blocks.findIndex((b) => b.volatile === true);
    expect(markerIndex).toBeLessThan(firstVolatileIndex);
  });

  test("a volatile block is NEVER marked, even when a stray marker rides in on it", () => {
    const poisoned: CacheManagedBlock[] = [
      { type: "text", text: "prefix" },
      { type: "text", text: "tail", volatile: true, cache_control: { type: "ephemeral" } },
    ];
    const result = manage(poisoned, { features: EXPLICIT, now: () => 1 });
    expect(result.rotated).toBe(true);
    expect(result.blocks[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(result.blocks[1]?.cache_control).toBeUndefined();
    expect(countCacheMarkers(result.blocks)).toBe(1);
  });

  test("editing the tail between calls never strips or moves the fresh prefix marker", () => {
    const first = manage(prefixAndTail("plan v1"), { features: EXPLICIT, now: () => 1_000 });
    expect(first.rotated).toBe(true);
    // Per-call tail rebuild: same frozen prefix, new tail text, FRESH
    // rotatedAt threaded back — manage() must be a pure pass-through.
    const edited: CacheManagedBlock[] = [
      ...first.blocks.slice(0, 2),
      { type: "text", text: "plan v2 — step 3 done", volatile: true },
    ];
    const second = manage(edited, {
      features: EXPLICIT,
      lastRotatedAt: first.rotatedAt,
      now: () => 1_000 + 60_000,
    });
    expect(second.rotated).toBe(false);
    expect(second.blocks).toBe(edited);
    expect(second.blocks[1]?.cache_control).toEqual({ type: "ephemeral" });
    expect(second.blocks[2]?.cache_control).toBeUndefined();
    expect(countCacheMarkers(second.blocks)).toBe(1);
  });

  test("all-volatile input has no frozen prefix to cache — no-op, no marker", () => {
    const allVolatile: CacheManagedBlock[] = [
      { type: "text", text: "tail a", volatile: true },
      { type: "text", text: "tail b", volatile: true },
    ];
    const result = manage(allVolatile, { features: EXPLICIT, now: () => 1 });
    expect(result.rotated).toBe(false);
    expect(result.blocks).toBe(allVolatile);
    expect(countCacheMarkers(result.blocks)).toBe(0);
  });

  test("plain CanonicalTextBlockParam arrays (no volatile flags) behave exactly as before", () => {
    const input: CanonicalTextBlockParam[] = [
      { type: "text", text: "a", cache_control: { type: "ephemeral" } },
      { type: "text", text: "b" },
    ];
    const result = manage(input, { features: EXPLICIT, now: () => 42 });
    expect(result.rotated).toBe(true);
    expect(countCacheMarkers(result.blocks)).toBe(1);
    expect(result.blocks[1]?.cache_control).toEqual({ type: "ephemeral" });
    expect(result.blocks[0]?.cache_control).toBeUndefined();
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
