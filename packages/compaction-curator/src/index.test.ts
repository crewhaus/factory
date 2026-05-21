import { describe, expect, test } from "bun:test";
import { type EmbedderFn, type Item, curate, dedupeBySimilarity, rankByRelevance } from "./index";

/**
 * Tiny canned embedder for deterministic tests: maps each unique input
 * string to a fixed unit vector. Same input → same vector → cosine of 1.
 * Different input → orthogonal vector → cosine of 0.
 */
function makeCannedEmbedder(): { fn: EmbedderFn; counter: () => number } {
  const cache = new Map<string, ReadonlyArray<number>>();
  let calls = 0;
  const dim = 16;
  const fn: EmbedderFn = async (texts) => {
    calls += 1;
    return texts.map((t) => {
      const cached = cache.get(t);
      if (cached !== undefined) return cached;
      const idx = cache.size % dim;
      const v = new Array(dim).fill(0);
      v[idx] = 1;
      const arr = Object.freeze(v) as ReadonlyArray<number>;
      cache.set(t, arr);
      return arr;
    });
  };
  return { fn, counter: () => calls };
}

describe("curate — happy path", () => {
  test("returns input unchanged when no dedupe + no query", async () => {
    const { fn } = makeCannedEmbedder();
    const items: ReadonlyArray<Item> = [
      { text: "alpha gamma delta epsilon zeta" },
      { text: "beta theta iota kappa lambda" },
      { text: "rho sigma tau upsilon phi" },
    ];
    const result = await curate(items, { embedder: fn });
    expect(result.items.length).toBe(3);
    expect(result.droppedIndices.length).toBe(0);
    expect(result.bytesSaved).toBe(0);
  });

  test("dedupes when two items embed identically", async () => {
    const embedder: EmbedderFn = async (texts) =>
      texts.map(() => [1, 0, 0, 0] as ReadonlyArray<number>);
    const items: ReadonlyArray<Item> = [
      { text: "alpha gamma delta epsilon zeta one" },
      { text: "alpha gamma delta epsilon zeta two" },
      { text: "alpha gamma delta epsilon zeta three" },
    ];
    const result = await curate(items, { embedder });
    expect(result.items.length).toBe(1);
    expect(result.droppedIndices).toEqual([1, 2]);
  });

  test("keeps when below dedupe threshold", async () => {
    const { fn } = makeCannedEmbedder();
    const items: ReadonlyArray<Item> = [
      { text: "alpha gamma delta epsilon zeta" },
      { text: "beta theta iota kappa lambda" },
    ];
    const result = await curate(items, { embedder: fn, dedupeThreshold: 0.99 });
    expect(result.items.length).toBe(2);
  });

  test("relevance-orders when query supplied", async () => {
    const items: ReadonlyArray<Item> = [
      { text: "completely unrelated chitchat", id: "off-topic" },
      { text: "deep technical content about query", id: "on-topic" },
    ];
    // Make on-topic share the query vector
    const embedder: EmbedderFn = async (texts) => {
      return texts.map((t) => {
        if (t === "deep technical content about query" || t === "search query") {
          return [1, 0, 0] as ReadonlyArray<number>;
        }
        return [0, 1, 0] as ReadonlyArray<number>;
      });
    };
    const result = await curate(items, { embedder, query: "search query" });
    expect(result.items[0]?.id).toBe("on-topic");
    expect(result.items[1]?.id).toBe("off-topic");
  });

  test("topK trims after relevance reorder", async () => {
    const items: ReadonlyArray<Item> = [
      { text: "irrelevant content one", id: "1" },
      { text: "highly relevant query match", id: "2" },
      { text: "irrelevant content two", id: "3" },
    ];
    const embedder: EmbedderFn = async (texts) =>
      texts.map((t) => {
        if (t === "highly relevant query match" || t === "the search query") {
          return [1, 0] as ReadonlyArray<number>;
        }
        return [0, 1] as ReadonlyArray<number>;
      });
    const result = await curate(items, {
      embedder,
      query: "the search query",
      relevanceTopK: 1,
    });
    expect(result.items.length).toBe(1);
    expect(result.items[0]?.id).toBe("2");
    expect(result.droppedIndices.length).toBe(2);
  });
});

describe("curate — pre-embedded path", () => {
  test("no embedder needed when all items carry embeddings", async () => {
    const items: ReadonlyArray<Item> = [
      { text: "first item with embedding precomputed", embedding: [1, 0] },
      { text: "second item with embedding precomputed", embedding: [0, 1] },
    ];
    const result = await curate(items, {}); // no embedder, no query
    expect(result.items.length).toBe(2);
  });

  test("throws when items lack embeddings and no embedder is supplied", async () => {
    const items: ReadonlyArray<Item> = [{ text: "needs embedding plenty of words" }];
    await expect(curate(items, {})).rejects.toThrow(/lack pre-computed embeddings/);
  });
});

describe("curate — edge cases", () => {
  test("empty input returns empty result", async () => {
    const result = await curate([], {});
    expect(result.items.length).toBe(0);
    expect(result.bytesSaved).toBe(0);
  });

  test("bytesSaved reflects dropped item lengths", async () => {
    const embedder: EmbedderFn = async (texts) => texts.map(() => [1, 0] as ReadonlyArray<number>);
    const items: ReadonlyArray<Item> = [
      { text: "kept first kept first kept first" }, // 32 bytes
      { text: "dropped dropped dropped" }, // 23 bytes
    ];
    const result = await curate(items, { embedder });
    expect(result.bytesSaved).toBe(Buffer.byteLength("dropped dropped dropped", "utf8"));
  });
});

describe("dedupeBySimilarity (pure)", () => {
  test("first occurrence wins for duplicates", () => {
    const items: ReadonlyArray<Item> = [{ text: "a" }, { text: "b" }, { text: "c" }];
    const embeddings: ReadonlyArray<ReadonlyArray<number>> = [
      [1, 0],
      [1, 0], // duplicate of #0
      [0, 1],
    ];
    const r = dedupeBySimilarity(items, embeddings, 0.92);
    expect(r.kept).toEqual([0, 2]);
    expect(r.dropped).toEqual([1]);
  });
});

describe("rankByRelevance (pure)", () => {
  test("ranks by descending cosine similarity", async () => {
    const items: ReadonlyArray<Item> = [{ text: "x" }, { text: "y" }];
    const embeddings: ReadonlyArray<ReadonlyArray<number>> = [
      [0, 1],
      [1, 0],
    ];
    const embedder: EmbedderFn = async () => [[1, 0]];
    const order = await rankByRelevance(items, embeddings, "q", embedder);
    expect(order).toEqual([1, 0]);
  });
});
