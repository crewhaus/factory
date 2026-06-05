import { describe, expect, test } from "bun:test";
import { MIN_MATCH_LENGTH } from "@crewhaus/egress-classifier";
import { type EmbedOptions, type Embedder, createEmbedder } from "@crewhaus/embedder";
import type { TrustOrigin } from "@crewhaus/run-context";
import {
  DEFAULT_SEMANTIC_THRESHOLD,
  EgressMatcherSemanticError,
  SemanticEgressMatcher,
  cosineSimilarity,
  createSemanticEgressMatcher,
} from "./index";

// Deterministic embedder — the mock backend is hashed bag-of-words,
// L2-normalised, so cosine is reproducible across runs with NO network
// (AGENTS.md determinism rule: no live embedding API in CI).
function mockEmbedder(): Embedder {
  return createEmbedder({ model: "mock/egress-semantic-test" });
}

function lineageOf(entries: ReadonlyArray<[string, TrustOrigin]>): Map<string, TrustOrigin> {
  return new Map<string, TrustOrigin>(entries);
}

describe("SemanticEgressMatcher", () => {
  test('name is "semantic" for audit + cache namespacing', () => {
    expect(new SemanticEgressMatcher({ embedder: mockEmbedder() }).name).toBe("semantic");
    expect(createSemanticEgressMatcher({ embedder: mockEmbedder() }).name).toBe("semantic");
  });

  test("flags a payload that semantically contains a tagged lineage entry", async () => {
    // The tagged subagent string is long (over the floor) and the payload
    // is dominated by it, so mock-embedder cosine clears the default
    // threshold (~0.88 in calibration). originsFound must include subagent.
    const tagged = "subagent-extracted secret API_KEY=sleeper-token-9f3a2b1c";
    const matcher = new SemanticEgressMatcher({ embedder: mockEmbedder() });
    const result = await matcher.match({
      payload: `POST body ${tagged} now`,
      lineage: lineageOf([[tagged, "subagent"]]),
      minMatchLength: MIN_MATCH_LENGTH,
    });
    expect(result.originsFound).toContain("subagent");
    expect(result.matchCount).toBeGreaterThanOrEqual(1);
  });

  test("ignores tagged entries below the min-match floor", async () => {
    const matcher = new SemanticEgressMatcher({ embedder: mockEmbedder() });
    // "short" is under the floor — even an exact substring presence must
    // not produce a hit (floor contract preserved from the substring matcher).
    const result = await matcher.match({
      payload: "carries short inside the body",
      lineage: lineageOf([["short", "subagent"]]),
      minMatchLength: MIN_MATCH_LENGTH,
    });
    expect(result.originsFound).toEqual([]);
    expect(result.matchCount).toBe(0);
  });

  test("returns no hits for an unrelated payload below threshold", async () => {
    const matcher = new SemanticEgressMatcher({ embedder: mockEmbedder() });
    const tagged = "subagent-extracted secret API_KEY=sleeper-token-9f3a2b1c";
    const result = await matcher.match({
      payload: "the quick brown fox jumps over the lazy dog repeatedly today now",
      lineage: lineageOf([[tagged, "subagent"]]),
      minMatchLength: MIN_MATCH_LENGTH,
    });
    expect(result.originsFound).toEqual([]);
    expect(result.matchCount).toBe(0);
  });

  test("respects a custom threshold (1.01 makes everything miss)", async () => {
    // A threshold above the cosine max (1.0) means nothing can ever clear
    // it — proves the threshold is actually consulted.
    const tagged = "subagent-extracted secret API_KEY=sleeper-token-9f3a2b1c";
    const strict = new SemanticEgressMatcher({ embedder: mockEmbedder(), threshold: 1.01 });
    const strictResult = await strict.match({
      payload: `POST body ${tagged} now`,
      lineage: lineageOf([[tagged, "subagent"]]),
      minMatchLength: MIN_MATCH_LENGTH,
    });
    expect(strictResult.matchCount).toBe(0);

    // And a very low threshold makes the same payload hit.
    const loose = new SemanticEgressMatcher({ embedder: mockEmbedder(), threshold: 0.1 });
    const looseResult = await loose.match({
      payload: `POST body ${tagged} now`,
      lineage: lineageOf([[tagged, "subagent"]]),
      minMatchLength: MIN_MATCH_LENGTH,
    });
    expect(looseResult.matchCount).toBeGreaterThanOrEqual(1);
  });

  test("dedupes origins and counts distinct tagged hits", async () => {
    // Two over-threshold tagged strings from the SAME origin → one origin,
    // matchCount 2.
    const a = "subagent secret one API_KEY=sleeper-token-aaaaaaaa1111";
    const b = "subagent secret two API_KEY=sleeper-token-bbbbbbbb2222";
    const matcher = new SemanticEgressMatcher({ embedder: mockEmbedder(), threshold: 0.1 });
    const result = await matcher.match({
      payload: `${a} ||| ${b}`,
      lineage: lineageOf([
        [a, "subagent"],
        [b, "subagent"],
      ]),
      minMatchLength: MIN_MATCH_LENGTH,
    });
    expect(result.originsFound).toEqual(["subagent"]);
    expect(result.matchCount).toBe(2);
  });

  test("falls back to substring matching when the embedder throws", async () => {
    // A throwing embedder must not blow up the egress check. Fallback is the
    // built-in substring matcher: the payload verbatim-contains the tagged
    // string, so substring finds it → subagent hit, no throw.
    const throwingEmbedder: Embedder = {
      model: "mock/throwing",
      provider: "mock",
      embed: async (_texts: ReadonlyArray<string>, _opts?: EmbedOptions): Promise<number[][]> => {
        throw new Error("simulated embedder outage");
      },
    };
    const tagged = "subagent-extracted secret API_KEY=sleeper-token-9f3a2b1c";
    const matcher = new SemanticEgressMatcher({ embedder: throwingEmbedder });
    const result = await matcher.match({
      payload: `POST body ${tagged} now`,
      lineage: lineageOf([[tagged, "subagent"]]),
      minMatchLength: MIN_MATCH_LENGTH,
    });
    expect(result.originsFound).toContain("subagent");
    expect(result.matchCount).toBe(1);
  });

  test("surfaces the embedder error when disableFallback is set", async () => {
    const throwingEmbedder: Embedder = {
      model: "mock/throwing",
      provider: "mock",
      embed: async (): Promise<number[][]> => {
        throw new Error("simulated embedder outage");
      },
    };
    const tagged = "subagent-extracted secret API_KEY=sleeper-token-9f3a2b1c";
    const matcher = new SemanticEgressMatcher({
      embedder: throwingEmbedder,
      disableFallback: true,
    });
    await expect(
      matcher.match({
        payload: `POST body ${tagged} now`,
        lineage: lineageOf([[tagged, "subagent"]]),
        minMatchLength: MIN_MATCH_LENGTH,
      }),
    ).rejects.toThrow(/embedder failed/);
  });

  test("returns no hits when the lineage is empty (no embed call needed)", async () => {
    let embedCalls = 0;
    const countingEmbedder: Embedder = {
      model: "mock/counting",
      provider: "mock",
      embed: async (texts) => {
        embedCalls += 1;
        return texts.map(() => [0]);
      },
    };
    const matcher = new SemanticEgressMatcher({ embedder: countingEmbedder });
    const result = await matcher.match({
      payload: "anything",
      lineage: lineageOf([]),
      minMatchLength: MIN_MATCH_LENGTH,
    });
    expect(result.matchCount).toBe(0);
    expect(embedCalls).toBe(0); // short-circuits before embedding
  });

  test("constructor rejects a missing embedder", () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime guard
    expect(() => new SemanticEgressMatcher({} as any)).toThrow(/requires an `embedder`/);
  });

  test("constructor rejects an embedder whose embed is not a function", () => {
    // Exercises the *second* operand of the guard: `embedder` is present but
    // `embed` is not callable (e.g. a half-constructed / wrong-shape object).
    expect(
      () =>
        new SemanticEgressMatcher({
          // biome-ignore lint/suspicious/noExplicitAny: testing runtime guard
          embedder: { model: "x", provider: "mock", embed: 123 } as any,
        }),
    ).toThrow(/requires an `embedder`/);
  });

  test("falls back to substring matching when the embedder returns too few vectors", async () => {
    // An embedder that returns an EMPTY array (so `vectors[0]` is undefined)
    // is a config error, not an attack: degrade to the substring tripwire.
    // The payload verbatim-contains the tagged string → substring hit.
    const emptyEmbedder: Embedder = {
      model: "mock/empty",
      provider: "mock",
      embed: async (): Promise<number[][]> => [],
    };
    const tagged = "subagent-extracted secret API_KEY=sleeper-token-9f3a2b1c";
    const matcher = new SemanticEgressMatcher({ embedder: emptyEmbedder });
    const result = await matcher.match({
      payload: `POST body ${tagged} now`,
      lineage: lineageOf([[tagged, "subagent"]]),
      minMatchLength: MIN_MATCH_LENGTH,
    });
    expect(result.originsFound).toContain("subagent");
    expect(result.matchCount).toBe(1);
  });

  test("surfaces a config error when too few vectors are returned and disableFallback is set", async () => {
    const emptyEmbedder: Embedder = {
      model: "mock/empty",
      provider: "mock",
      embed: async (): Promise<number[][]> => [],
    };
    const tagged = "subagent-extracted secret API_KEY=sleeper-token-9f3a2b1c";
    const matcher = new SemanticEgressMatcher({
      embedder: emptyEmbedder,
      disableFallback: true,
    });
    await expect(
      matcher.match({
        payload: `POST body ${tagged} now`,
        lineage: lineageOf([[tagged, "subagent"]]),
        minMatchLength: MIN_MATCH_LENGTH,
      }),
    ).rejects.toThrow(/expected 2/);
  });

  test("skips a candidate whose embedding vector is missing", async () => {
    // payloadVec is present (index 0) but the embedder returns FEWER vectors
    // than candidates, so the per-candidate `candVec === undefined` guard
    // makes the loop skip both candidates → no hits, no throw.
    const shortEmbedder: Embedder = {
      model: "mock/short",
      provider: "mock",
      // Only one vector back for payload + 2 candidates.
      embed: async (): Promise<number[][]> => [[1, 0, 0]],
    };
    const a = "subagent secret one API_KEY=sleeper-token-aaaaaaaa1111";
    const b = "subagent secret two API_KEY=sleeper-token-bbbbbbbb2222";
    const matcher = new SemanticEgressMatcher({ embedder: shortEmbedder, threshold: 0.1 });
    const result = await matcher.match({
      payload: `${a} ||| ${b}`,
      lineage: lineageOf([
        [a, "subagent"],
        [b, "subagent"],
      ]),
      minMatchLength: MIN_MATCH_LENGTH,
    });
    expect(result.originsFound).toEqual([]);
    expect(result.matchCount).toBe(0);
  });

  test("surfaces a typed error (not a raw TypeError) when the embedder throws a non-Error and disableFallback is set", async () => {
    // Regression: the error-message extraction must be null-safe. An embedder
    // that throws a nullish / non-object value (e.g. `throw null`) previously
    // made `(err as Error).message` itself throw a TypeError, masking the
    // failure and breaking the documented "surface the embedder error"
    // contract. It must reject with EgressMatcherSemanticError carrying the
    // stringified cause.
    const nullThrowingEmbedder: Embedder = {
      model: "mock/null-throwing",
      provider: "mock",
      // Reject with a nullish, non-Error value to exercise the source's
      // `?? String(err)` fallback. A plain rejected promise (rather than an
      // `async` body that `throw null`s) keeps the rejection reason exactly
      // `null` without tripping useAwait / noThrowLiteral.
      embed: (): Promise<number[][]> => Promise.reject(null),
    };
    const tagged = "subagent-extracted secret API_KEY=sleeper-token-9f3a2b1c";
    const matcher = new SemanticEgressMatcher({
      embedder: nullThrowingEmbedder,
      disableFallback: true,
    });
    const promise = matcher.match({
      payload: `POST body ${tagged} now`,
      lineage: lineageOf([[tagged, "subagent"]]),
      minMatchLength: MIN_MATCH_LENGTH,
    });
    await expect(promise).rejects.toBeInstanceOf(EgressMatcherSemanticError);
    // The cause is stringified into the message, never a "cannot read
    // properties of null" TypeError.
    await expect(promise).rejects.toThrow(/embedder failed: null/);
  });
});

describe("DEFAULT_SEMANTIC_THRESHOLD", () => {
  test("is a cosine value in (0, 1)", () => {
    expect(DEFAULT_SEMANTIC_THRESHOLD).toBeGreaterThan(0);
    expect(DEFAULT_SEMANTIC_THRESHOLD).toBeLessThan(1);
  });
});

describe("cosineSimilarity helper", () => {
  test("is 1 for identical vectors, 0 for orthogonal", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });
  test("returns 0 for a zero vector", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
  test("returns 0 for two empty vectors", () => {
    // Empty-but-equal-length inputs short-circuit to 0 before the loop.
    expect(cosineSimilarity([], [])).toBe(0);
  });
  test("throws on dimension mismatch", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/dim mismatch/);
  });
});
