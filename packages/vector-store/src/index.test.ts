import { describe, expect, test } from "bun:test";
import { VectorStoreError, createVectorStore } from "./index";

describe("in-memory backend", () => {
  test("upsert + query round-trip", async () => {
    const store = createVectorStore({ backend: "in-memory" });
    await store.upsert("a", [1, 0, 0], { kind: "alpha" });
    await store.upsert("b", [0, 1, 0], { kind: "bravo" });
    await store.upsert("c", [0, 0, 1], { kind: "charlie" });
    const hits = await store.query([1, 0, 0], 2);
    expect(hits.length).toBe(2);
    expect(hits[0]?.id).toBe("a");
    // Exact match → distance 0 → score 0 (sign-insensitive comparison; -0 === 0).
    expect(hits[0]?.score === 0).toBe(true);
  });

  test("delete removes the entry", async () => {
    const store = createVectorStore({ backend: "in-memory" });
    await store.upsert("a", [1]);
    await store.delete("a");
    expect(await store.count()).toBe(0);
  });

  test("count grows with upserts", async () => {
    const store = createVectorStore({ backend: "in-memory" });
    expect(await store.count()).toBe(0);
    await store.upsert("a", [1]);
    await store.upsert("b", [2]);
    expect(await store.count()).toBe(2);
  });

  test("upsert with same id replaces (not duplicates)", async () => {
    const store = createVectorStore({ backend: "in-memory" });
    await store.upsert("a", [1, 0]);
    await store.upsert("a", [0, 1]);
    expect(await store.count()).toBe(1);
  });

  test("filter narrows hits by metadata equality", async () => {
    const store = createVectorStore({ backend: "in-memory" });
    await store.upsert("a", [1, 0], { domain: "x" });
    await store.upsert("b", [1, 0], { domain: "y" });
    const hits = await store.query([1, 0], 5, { domain: "x" });
    expect(hits.length).toBe(1);
    expect(hits[0]?.id).toBe("a");
  });

  test("query hits sorted by score descending (closer = higher score)", async () => {
    const store = createVectorStore({ backend: "in-memory" });
    await store.upsert("near", [1, 0]);
    await store.upsert("far", [10, 10]);
    const hits = await store.query([1, 0], 2);
    expect(hits[0]?.id).toBe("near");
    expect(hits[1]?.id).toBe("far");
  });

  test("empty store returns empty hits", async () => {
    const store = createVectorStore({ backend: "in-memory" });
    expect(await store.query([1, 2, 3], 5)).toEqual([]);
  });

  test("dimension mismatch throws", async () => {
    const store = createVectorStore({ backend: "in-memory" });
    await store.upsert("a", [1, 2, 3]);
    await expect(store.query([1, 2], 3)).rejects.toBeInstanceOf(VectorStoreError);
  });
});

describe("filter injection guard (T8)", () => {
  test("rejects SQL-injection-shaped key", async () => {
    const store = createVectorStore({ backend: "in-memory" });
    await expect(store.query([1], 1, { "1=1; DROP TABLE": "x" })).rejects.toBeInstanceOf(
      VectorStoreError,
    );
  });
  test("rejects SQL-injection-shaped value", async () => {
    const store = createVectorStore({ backend: "in-memory" });
    await expect(store.query([1], 1, { domain: "1=1; DROP" })).rejects.toBeInstanceOf(
      VectorStoreError,
    );
  });
  test("rejects backtick / quote characters in key", async () => {
    const store = createVectorStore({ backend: "in-memory" });
    await expect(store.query([1], 1, { "name`": "x" })).rejects.toBeInstanceOf(VectorStoreError);
  });
});

describe("concurrent upserts (T9)", () => {
  test("100 parallel upserts settle to count=100", async () => {
    const store = createVectorStore({ backend: "in-memory" });
    await Promise.all(
      Array.from({ length: 100 }, (_, i) => store.upsert(`id${i}`, [Math.random(), i])),
    );
    expect(await store.count()).toBe(100);
  });
});

describe("Section 30 — non-default backends require config", () => {
  test("qdrant / pinecone / weaviate require url + collection", () => {
    for (const backend of ["qdrant", "pinecone", "weaviate"] as const) {
      expect(() => createVectorStore({ backend })).toThrow(VectorStoreError);
    }
  });
});
