/**
 * The verdict cache's key is hashed by Bun, or with WebCrypto where Bun is
 * absent (a Cloudflare Worker), so the classifier imports no Node builtin. The
 * function the cache uses, and the WebCrypto digest a Worker uses, are each
 * checked here against a reference SHA-256 of the same UTF-8 bytes, over seeded
 * random strings, non-ASCII text and lone surrogates (every encoding here turns
 * a lone surrogate into U+FFFD).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { __internals, boundaryCacheSize, classifyBoundary, clearBoundaryCache } from "./index";

afterEach(() => clearBoundaryCache());

const reference = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Deterministic xorshift32, so a failure names a reproducible string. */
function seeded(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

/** A string mixing ASCII, the rest of the BMP, astral pairs and lone surrogates. */
function randomText(next: () => number): string {
  const length = next() % 64;
  let out = "";
  for (let i = 0; i < length; i++) {
    const pick = next() % 10;
    if (pick < 5) out += String.fromCharCode(0x20 + (next() % 0x5f));
    else if (pick < 7) out += String.fromCharCode(0xa0 + (next() % 0xd700));
    else if (pick < 8) out += String.fromCodePoint(0x10000 + (next() % 0xfffff));
    else if (pick < 9) out += String.fromCharCode(0xd800 + (next() % 0x800));
    else out += String.fromCharCode(next() % 0x20);
  }
  return out;
}

const SPECIAL = [
  "",
  "plain ascii",
  "Grüße, ça va? Привет, 世界",
  "emoji 🎉 and astral 𝔸",
  "lone high \ud800 in the middle",
  "lone low \udc00 in the middle",
  "\udbff",
  "reversed pair \udc00\ud800",
  "x".repeat(100_000),
];

describe("the cache key", () => {
  test("is <origin>:<hex sha256 of the UTF-8 text> for 1,000 seeded random strings", async () => {
    const next = seeded(0x5eed);
    const mismatches: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const text = randomText(next);
      const expected = reference(text);
      if ((await __internals.cacheKey(text, "api")) !== `api:${expected}`) {
        mismatches.push(`key ${JSON.stringify(text)}`);
      }
      if ((await __internals.webCryptoHex(utf8(text))) !== expected) {
        mismatches.push(`webcrypto ${JSON.stringify(text)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("matches on non-ASCII text, lone surrogates, the empty string and a long text", async () => {
    for (const text of SPECIAL) {
      const key = await __internals.cacheKey(text, "channel");
      expect(key).toBe(`channel:${reference(text)}`);
      expect(key).toMatch(/^channel:[0-9a-f]{64}$/);
      expect(await __internals.webCryptoHex(utf8(text))).toBe(reference(text));
    }
  });

  test("on Bun the key is computed synchronously, so a lookup costs no event-loop turn", () => {
    expect(typeof __internals.cacheKey("a cached text", "api")).toBe("string");
  });

  test("a repeated call is served from the cache; another origin still misses", async () => {
    const text = "Résumé of the weekly sync — nothing to act on.";
    expect((await classifyBoundary(text, { origin: "api" })).fromCache).toBe(false);
    expect(boundaryCacheSize()).toBe(1);
    expect((await classifyBoundary(text, { origin: "api" })).fromCache).toBe(true);
    expect((await classifyBoundary(text, { origin: "channel" })).fromCache).toBe(false);
    expect(boundaryCacheSize()).toBe(2);
  });

  test("bypassCache neither reads nor writes the cache", async () => {
    const text = "Résumé of the weekly sync — nothing to act on.";
    await classifyBoundary(text, { origin: "api" });
    expect(boundaryCacheSize()).toBe(1);
    const bypassed = await classifyBoundary(text, { origin: "api", bypassCache: true });
    expect(bypassed.fromCache).toBe(false);
    await classifyBoundary("another text entirely", { origin: "api", bypassCache: true });
    expect(boundaryCacheSize()).toBe(1);
  });
});
