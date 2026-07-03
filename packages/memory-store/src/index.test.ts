/**
 * Tests for the persistent memory store. Covers basic remember/recall,
 * BM25 ranking sanity, file persistence across instances, and graceful
 * handling of malformed lines.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_AUTO_CAPTURE_THRESHOLD,
  DEFAULT_AUTO_RECALL_K,
  MemoryStoreError,
  captureFacts,
  createMemoryStore,
  deriveMemoryDecision,
  summarizeDurableFacts,
} from "./index";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "memory-store-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("createMemoryStore", () => {
  test("rejects empty specName", () => {
    expect(() => createMemoryStore({ specName: "", rootDir: tmp })).toThrow(MemoryStoreError);
  });

  test("rejects specName with bad characters (path traversal etc.)", () => {
    expect(() => createMemoryStore({ specName: "../etc/passwd", rootDir: tmp })).toThrow(
      MemoryStoreError,
    );
    expect(() => createMemoryStore({ specName: "foo bar", rootDir: tmp })).toThrow(
      MemoryStoreError,
    );
  });

  test("path() returns the expected file location", () => {
    const store = createMemoryStore({ specName: "my-spec", rootDir: tmp });
    expect(store.path()).toBe(join(tmp, "my-spec.jsonl"));
  });
});

describe("remember + recall", () => {
  test("size() returns 0 before any remember", async () => {
    const store = createMemoryStore({ specName: "s", rootDir: tmp });
    expect(await store.size()).toBe(0);
  });

  test("remember() persists and recall() finds it", async () => {
    const store = createMemoryStore({ specName: "s", rootDir: tmp });
    await store.remember("the user prefers TypeScript over JavaScript");
    const results = await store.recall("TypeScript");
    expect(results.length).toBe(1);
    expect(results[0]?.entry.text).toBe("the user prefers TypeScript over JavaScript");
    expect(results[0]?.score).toBeGreaterThan(0);
  });

  test("remember assigns ids with the mem_ prefix", async () => {
    const store = createMemoryStore({ specName: "s", rootDir: tmp });
    const e1 = await store.remember("a");
    const e2 = await store.remember("b");
    expect(e1.id).toMatch(/^mem_[0-9a-f]{16}$/);
    expect(e2.id).toMatch(/^mem_[0-9a-f]{16}$/);
    expect(e1.id).not.toBe(e2.id);
  });

  test("recall() ranks closer matches higher", async () => {
    const store = createMemoryStore({ specName: "s", rootDir: tmp });
    await store.remember("the user prefers TypeScript");
    await store.remember("we discussed Python yesterday");
    await store.remember("TypeScript is a typed superset of JavaScript");
    const results = await store.recall("TypeScript", 3);
    expect(results.length).toBe(2);
    // Both TypeScript-mentioning entries should outrank the Python one,
    // which is excluded entirely (zero score).
    expect(results[0]?.score).toBeGreaterThanOrEqual(results[1]?.score);
    expect(results.find((r) => r.entry.text.includes("Python"))).toBeUndefined();
  });

  test("tags are indexed for recall", async () => {
    const store = createMemoryStore({ specName: "s", rootDir: tmp });
    await store.remember("personal note", ["family", "anniversary"]);
    const results = await store.recall("anniversary");
    expect(results.length).toBe(1);
    expect(results[0]?.entry.tags).toEqual(["family", "anniversary"]);
  });

  test("recall returns empty array when nothing matches", async () => {
    const store = createMemoryStore({ specName: "s", rootDir: tmp });
    await store.remember("apples and oranges");
    const results = await store.recall("kumquat");
    expect(results).toEqual([]);
  });

  test("k parameter caps the result count", async () => {
    const store = createMemoryStore({ specName: "s", rootDir: tmp });
    for (let i = 0; i < 5; i++) {
      await store.remember(`memory entry number ${i} about banana`);
    }
    const results = await store.recall("banana", 2);
    expect(results.length).toBe(2);
  });

  test("persists across store instances (file-backed)", async () => {
    const store1 = createMemoryStore({ specName: "persist", rootDir: tmp });
    await store1.remember("durable claim");
    const store2 = createMemoryStore({ specName: "persist", rootDir: tmp });
    expect(await store2.size()).toBe(1);
    const results = await store2.recall("durable");
    expect(results.length).toBe(1);
  });

  test("malformed lines in the JSONL are skipped (not raised)", async () => {
    const store = createMemoryStore({ specName: "broken", rootDir: tmp });
    await store.remember("good entry");
    // Corrupt the file by appending a broken line.
    appendFileSync(store.path(), "{not json\n");
    await store.remember("another good entry");
    expect(await store.size()).toBe(2);
    const results = await store.recall("entry");
    expect(results.length).toBe(2);
  });

  test("recall rejects empty queries", async () => {
    const store = createMemoryStore({ specName: "s", rootDir: tmp });
    await expect(store.recall("")).rejects.toThrow(MemoryStoreError);
  });

  test("remember rejects empty text", async () => {
    const store = createMemoryStore({ specName: "s", rootDir: tmp });
    await expect(store.remember("")).rejects.toThrow(MemoryStoreError);
  });
});

describe("deriveMemoryDecision (#53)", () => {
  test("absent config disables capture + recall", () => {
    const d = deriveMemoryDecision(undefined, 100);
    expect(d.capture).toBe(false);
    expect(d.recall).toBe(false);
    expect(d.recallK).toBe(DEFAULT_AUTO_RECALL_K);
    expect(d.captureThreshold).toBe(DEFAULT_AUTO_CAPTURE_THRESHOLD);
  });

  test("enabled:false disables both even with auto flags set", () => {
    const d = deriveMemoryDecision({ enabled: false, autoCapture: true, autoRecall: true }, 100);
    expect(d.capture).toBe(false);
    expect(d.recall).toBe(false);
  });

  test("autoCapture gated by threshold on completed turns", () => {
    const cfg = { autoCapture: true, autoCaptureThreshold: 3 };
    expect(deriveMemoryDecision(cfg, 2).capture).toBe(false);
    expect(deriveMemoryDecision(cfg, 3).capture).toBe(true);
  });

  test("autoRecall + recallK honoured", () => {
    const d = deriveMemoryDecision({ autoRecall: true, recallK: 9 }, 0);
    expect(d.recall).toBe(true);
    expect(d.recallK).toBe(9);
  });

  test("threshold and recallK are floored at 1", () => {
    const d = deriveMemoryDecision({ autoCapture: true, autoCaptureThreshold: 0, recallK: 0 }, 1);
    expect(d.captureThreshold).toBe(1);
    expect(d.recallK).toBe(1);
    expect(d.capture).toBe(true);
  });
});

describe("summarizeDurableFacts (#53)", () => {
  test("keeps one durable line per turn, dropping empties + dupes", () => {
    const facts = summarizeDurableFacts([
      { input: "q1", output: "The build uses Bun.\nmore detail" },
      { input: "q2", output: "   " },
      { input: "q3", output: "The build uses Bun." },
      { input: "q4", output: "Deploys go to Cloudflare Workers." },
    ]);
    expect(facts).toEqual(["The build uses Bun.", "Deploys go to Cloudflare Workers."]);
  });

  test("truncates very long answers with an ellipsis", () => {
    const long = "x".repeat(400);
    const [fact] = summarizeDurableFacts([{ input: "q", output: long }], { maxLen: 50 });
    expect(fact?.length).toBe(50);
    expect(fact?.endsWith("…")).toBe(true);
  });

  test("caps at maxFacts", () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({ input: "q", output: `fact ${i}` }));
    expect(summarizeDurableFacts(turns, { maxFacts: 3 })).toHaveLength(3);
  });
});

describe("captureFacts (#53) idempotency", () => {
  test("writes facts once; re-running is a no-op", async () => {
    const store = createMemoryStore({ specName: "cap", rootDir: tmp });
    const facts = ["The user prefers dark mode.", "Releases ship on Fridays."];
    const first = await captureFacts(store, facts);
    expect(first).toHaveLength(2);
    expect(await store.size()).toBe(2);
    const second = await captureFacts(store, facts);
    expect(second).toHaveLength(0);
    expect(await store.size()).toBe(2);
  });

  test("skips a fact that differs only by case/whitespace from an existing one", async () => {
    const store = createMemoryStore({ specName: "cap2", rootDir: tmp });
    await captureFacts(store, ["Deploys go to Cloudflare."]);
    const again = await captureFacts(store, ["deploys   go to cloudflare."]);
    expect(again).toHaveLength(0);
    expect(await store.size()).toBe(1);
  });

  test("empty facts list writes nothing", async () => {
    const store = createMemoryStore({ specName: "cap3", rootDir: tmp });
    expect(await captureFacts(store, [])).toHaveLength(0);
  });
});
