import { describe, expect, test } from "bun:test";
import {
  CompactionCuratorError,
  type EmbedderFn,
  type Item,
  curate,
  dedupeBySimilarity,
  rankByRelevance,
} from "./index";

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

  test("returns empty for empty items without calling the embedder", async () => {
    let called = false;
    const embedder: EmbedderFn = async (texts) => {
      called = true;
      return texts.map(() => [1, 0]);
    };
    const order = await rankByRelevance([], [], "q", embedder);
    expect(order).toEqual([]);
    expect(called).toBe(false);
  });

  test("throws when no embedder is supplied", async () => {
    const items: ReadonlyArray<Item> = [{ text: "x" }];
    await expect(rankByRelevance(items, [[1, 0]], "q", undefined)).rejects.toThrow(
      /requires an embedder to compute the query vector/,
    );
  });

  test("throws when the embedder returns no vector for the query", async () => {
    const items: ReadonlyArray<Item> = [{ text: "x" }];
    const embedder: EmbedderFn = async () => []; // empty -> queryVec is undefined
    await expect(rankByRelevance(items, [[1, 0]], "q", embedder)).rejects.toThrow(
      /returned no vector for the query/,
    );
  });

  test("skips items whose embedding is missing from the embeddings array", async () => {
    // Two items but only one embedding supplied: index 1 has no embedding and
    // is skipped, so only index 0 is ranked/returned.
    const items: ReadonlyArray<Item> = [{ text: "x" }, { text: "y" }];
    const embeddings: ReadonlyArray<ReadonlyArray<number>> = [[1, 0]];
    const embedder: EmbedderFn = async () => [[1, 0]];
    const order = await rankByRelevance(items, embeddings, "q", embedder);
    expect(order).toEqual([0]);
  });

  test("stable order is preserved for equal similarities", async () => {
    // Both items orthogonal to the query -> identical similarity (0). Stable
    // sort must keep original order [0, 1].
    const items: ReadonlyArray<Item> = [{ text: "x" }, { text: "y" }];
    const embeddings: ReadonlyArray<ReadonlyArray<number>> = [
      [0, 1],
      [0, 1],
    ];
    const embedder: EmbedderFn = async () => [[1, 0]];
    const order = await rankByRelevance(items, embeddings, "q", embedder);
    expect(order).toEqual([0, 1]);
  });

  test("does not trim when topK is greater than or equal to the item count", async () => {
    const items: ReadonlyArray<Item> = [{ text: "x" }, { text: "y" }];
    const embeddings: ReadonlyArray<ReadonlyArray<number>> = [
      [1, 0],
      [0, 1],
    ];
    const embedder: EmbedderFn = async () => [[1, 0]];
    const order = await rankByRelevance(items, embeddings, "q", embedder, 5);
    expect(order).toEqual([0, 1]);
  });
});

describe("cosine (via dedupeBySimilarity / curate)", () => {
  test("throws on embedding dimension mismatch", () => {
    // First kept vector has dim 2, second item has dim 3 -> cosine throws when
    // comparing item 1 against kept item 0.
    const items: ReadonlyArray<Item> = [{ text: "a" }, { text: "b" }];
    const embeddings: ReadonlyArray<ReadonlyArray<number>> = [
      [1, 0],
      [1, 0, 0],
    ];
    expect(() => dedupeBySimilarity(items, embeddings, 0.92)).toThrow(CompactionCuratorError);
    // dedupe compares the current item (index 1, dim 3) against the kept item
    // (index 0, dim 2), so the message reports the dims in that order.
    expect(() => dedupeBySimilarity(items, embeddings, 0.92)).toThrow(
      /embedding dimension mismatch \(3 vs 2\)/,
    );
  });

  test("zero-norm vector yields cosine 0 (not a duplicate, no divide-by-zero)", () => {
    // Item 1 is the zero vector: cosine(any, 0) === 0 < threshold, so it is
    // kept rather than collapsed, and no NaN/Infinity leaks through.
    const items: ReadonlyArray<Item> = [{ text: "a" }, { text: "b" }];
    const embeddings: ReadonlyArray<ReadonlyArray<number>> = [
      [1, 0],
      [0, 0],
    ];
    const r = dedupeBySimilarity(items, embeddings, 0.92);
    expect(r.kept).toEqual([0, 1]);
    expect(r.dropped).toEqual([]);
  });

  test("treats missing trailing components as zero when dims are equal length", () => {
    // Arrays of equal length whose trailing slot is `undefined` -> the `?? 0`
    // fallbacks keep the dot/norm math finite. [1, undefined] vs [1, undefined]
    // is identical -> dedupe.
    const sparse = [1, undefined] as unknown as ReadonlyArray<number>;
    const items: ReadonlyArray<Item> = [{ text: "a" }, { text: "b" }];
    const embeddings: ReadonlyArray<ReadonlyArray<number>> = [sparse, sparse];
    const r = dedupeBySimilarity(items, embeddings, 0.92);
    expect(r.kept).toEqual([0]);
    expect(r.dropped).toEqual([1]);
  });
});

describe("dedupeBySimilarity — missing embeddings are skipped", () => {
  test("a kept item with no embedding is never matched against", () => {
    // Index 0 has no embedding (undefined): the inner loop's `continue` keeps it,
    // and a later identical item is still compared against other kept items.
    const items: ReadonlyArray<Item> = [{ text: "a" }, { text: "b" }, { text: "c" }];
    const embeddings = [undefined, [1, 0], [1, 0]] as unknown as ReadonlyArray<
      ReadonlyArray<number>
    >;
    const r = dedupeBySimilarity(items, embeddings, 0.92);
    // 0 kept (no embedding), 1 kept (first real), 2 dropped (dup of 1)
    expect(r.kept).toEqual([0, 1]);
    expect(r.dropped).toEqual([2]);
  });

  test("current item with no embedding is kept (inner comparison skipped)", () => {
    const items: ReadonlyArray<Item> = [{ text: "a" }, { text: "b" }];
    const embeddings = [[1, 0], undefined] as unknown as ReadonlyArray<ReadonlyArray<number>>;
    const r = dedupeBySimilarity(items, embeddings, 0.92);
    expect(r.kept).toEqual([0, 1]);
    expect(r.dropped).toEqual([]);
  });
});

describe("curate — embedder failure modes", () => {
  test("throws when the embedder returns fewer vectors than requested", async () => {
    // Two items need embeddings but the embedder returns only one vector ->
    // the second slot is undefined and curate reports the offending index.
    const embedder: EmbedderFn = async () => [[1, 0]];
    const items: ReadonlyArray<Item> = [
      { text: "first needs embedding" },
      { text: "second needs embedding" },
    ];
    await expect(curate(items, { embedder })).rejects.toThrow(
      /embedder returned no vector for item 1/,
    );
  });

  test("mixes pre-embedded and freshly embedded items in original order", async () => {
    // Item 0 is pre-embedded, item 1 needs embedding. The fresh vector must land
    // in the right slot so the two are NOT collapsed (different vectors).
    let seen: ReadonlyArray<string> | undefined;
    const embedder: EmbedderFn = async (texts) => {
      seen = texts;
      return texts.map(() => [0, 1]);
    };
    const items: ReadonlyArray<Item> = [
      { text: "pre embedded item", embedding: [1, 0] },
      { text: "needs embedding item" },
    ];
    const result = await curate(items, { embedder });
    // Only the missing one is sent to the embedder.
    expect(seen).toEqual(["needs embedding item"]);
    expect(result.items.length).toBe(2);
    expect(result.droppedIndices).toEqual([]);
  });
});

describe("curate — query/topK branch coverage", () => {
  test("ignores an empty-string query (dedupe only, no reorder)", async () => {
    // query "" has length 0, so the relevance branch is skipped and order is
    // preserved as-is.
    const items: ReadonlyArray<Item> = [
      { text: "alpha gamma delta epsilon zeta", embedding: [1, 0] },
      { text: "beta theta iota kappa lambda", embedding: [0, 1] },
    ];
    const result = await curate(items, { query: "" });
    expect(result.items.length).toBe(2);
    expect(result.originalIndices).toEqual([0, 1]);
    expect(result.droppedIndices).toEqual([]);
  });

  test("query reorder without topK keeps every surviving item (no drops)", async () => {
    // With a query but no relevanceTopK, items are only reordered; the topK
    // drop-accounting branch must NOT run.
    const items: ReadonlyArray<Item> = [
      { text: "off topic", id: "a", embedding: [0, 1] },
      { text: "on topic", id: "b", embedding: [1, 0] },
    ];
    const embedder: EmbedderFn = async () => [[1, 0]]; // query vector
    const result = await curate(items, { query: "q", embedder });
    expect(result.items.map((i) => i.id)).toEqual(["b", "a"]);
    expect(result.droppedIndices).toEqual([]);
  });

  test("dedupe drops and topK drops are merged and sorted in droppedIndices", async () => {
    // index 0 & 1 are duplicates (index 1 dedupe-dropped); of the survivors,
    // topK=1 trims one more. Final droppedIndices must be sorted ascending.
    // Distinct, orthogonal vectors per text so only the intended pair collides.
    const vectors: Record<string, ReadonlyArray<number>> = {
      query: [1, 0, 0],
      dup: [0, 1, 0], // items 0 and 1 share this -> dedupe collapse
      match: [1, 0, 0], // identical to the query -> highest relevance
      filler: [0, 0, 1], // distinct from everything -> survives dedupe, topK-trimmed
    };
    const embedder: EmbedderFn = async (texts) => texts.map((t) => vectors[t] ?? [0, 0, 0]);
    const items: ReadonlyArray<Item> = [
      { text: "dup", id: "0" }, // dedupe-kept, then topK-dropped (sim 0)
      { text: "dup", id: "1" }, // dedupe-dropped (same vector as 0)
      { text: "match", id: "2" }, // most relevant -> kept by topK
      { text: "filler", id: "3" }, // dedupe-kept, then topK-dropped (sim 0)
    ];
    const result = await curate(items, {
      embedder,
      query: "query",
      relevanceTopK: 1,
    });
    expect(result.items.map((i) => i.id)).toEqual(["2"]);
    // 1 from dedupe; 0 and 3 from topK trim -> sorted ascending, no duplicates.
    expect(result.droppedIndices).toEqual([0, 1, 3]);
    // bytesSaved counts the dedupe drop plus both topK drops.
    const expectedBytes =
      Buffer.byteLength("dup", "utf8") + // index 1 (dedupe)
      Buffer.byteLength("dup", "utf8") + // index 0 (topK)
      Buffer.byteLength("filler", "utf8"); // index 3 (topK)
    expect(result.bytesSaved).toBe(expectedBytes);
  });

  test("relevanceTopK without a query is ignored (no reorder, no drops)", async () => {
    // The topK filter only applies inside the query branch; without a query it
    // must have no effect.
    const items: ReadonlyArray<Item> = [
      { text: "one", embedding: [1, 0] },
      { text: "two", embedding: [0, 1] },
      { text: "three", embedding: [1, 1] },
    ];
    const result = await curate(items, { relevanceTopK: 1 });
    expect(result.items.length).toBe(3);
    expect(result.droppedIndices).toEqual([]);
  });
});

describe("CompactionCuratorError", () => {
  test("carries the config code and a wrapped cause", () => {
    const cause = new Error("boom");
    const err = new CompactionCuratorError("wrapped", cause);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CompactionCuratorError");
    expect(err.code).toBe("config");
    expect(err.cause).toBe(cause);
    expect(err.message).toBe("wrapped");
  });
});
