/**
 * Tests for the persistent memory store. Covers basic remember/recall,
 * BM25 ranking sanity, file persistence across instances, and graceful
 * handling of malformed lines.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStoreError, createMemoryStore } from "./index";

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
    expect(results[0]!.entry.text).toBe("the user prefers TypeScript over JavaScript");
    expect(results[0]!.score).toBeGreaterThan(0);
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
    expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score);
    expect(results.find((r) => r.entry.text.includes("Python"))).toBeUndefined();
  });

  test("tags are indexed for recall", async () => {
    const store = createMemoryStore({ specName: "s", rootDir: tmp });
    await store.remember("personal note", ["family", "anniversary"]);
    const results = await store.recall("anniversary");
    expect(results.length).toBe(1);
    expect(results[0]!.entry.tags).toEqual(["family", "anniversary"]);
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
