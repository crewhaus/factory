import { describe, expect, test } from "bun:test";
import { type Embedder, createEmbedder } from "@crewhaus/embedder";
import type { RunResult, Sample } from "@crewhaus/eval-grader";
import { GraderError } from "@crewhaus/eval-grader";
import { _cosineSimilarityForTest, _resolveReferenceForTest, semanticSimilarity } from "./index";

const sample = (expected: string): Sample => ({
  id: "s1",
  input: "ignored",
  expected_output: expected,
});

const result = (output: string): RunResult => ({
  agentOutput: output,
  events: [],
  transcript: [],
  toolCalls: [],
  turns: 1,
  latencyMs: 100,
});

const mockEmbedder = createEmbedder({ model: "mock/test" });

class FailingEmbedder implements Embedder {
  readonly model = "mock/failing";
  readonly provider = "mock" as const;
  constructor(private readonly message: string) {}
  async embed(): Promise<number[][]> {
    throw new Error(this.message);
  }
}

/** Returns a caller-controlled vector list (used to exercise the arity guard). */
class FixedVectorsEmbedder implements Embedder {
  readonly model = "mock/fixed";
  readonly provider = "mock" as const;
  constructor(private readonly vectors: number[][]) {}
  async embed(): Promise<number[][]> {
    return this.vectors;
  }
}

describe("cosineSimilarity (T1)", () => {
  test("identical vectors → 1.0", () => {
    expect(_cosineSimilarityForTest([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6);
  });
  test("orthogonal vectors → 0", () => {
    expect(_cosineSimilarityForTest([1, 0], [0, 1])).toBe(0);
  });
  test("opposite vectors → -1", () => {
    expect(_cosineSimilarityForTest([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });
  test("zero vector → 0", () => {
    expect(_cosineSimilarityForTest([0, 0, 0], [1, 1, 1])).toBe(0);
  });
  test("dim mismatch throws GraderError", () => {
    expect(() => _cosineSimilarityForTest([1, 2], [1, 2, 3])).toThrow(GraderError);
  });
});

describe("semanticSimilarity (T1 + T3)", () => {
  test("identical strings score ≈ 1.0 with mock embedder", async () => {
    const grader = semanticSimilarity({ embedder: mockEmbedder, threshold: 0.5 });
    const out = await grader(sample("the cat sat"), result("the cat sat"));
    expect(out.passed).toBe(true);
    expect(out.score).toBeGreaterThan(0.99);
    expect(out.rationale).toMatch(/cosine/);
  });

  test("disjoint strings score low with mock embedder", async () => {
    const grader = semanticSimilarity({ embedder: mockEmbedder, threshold: 0.5 });
    const out = await grader(sample("alpha beta gamma"), result("zeta eta theta"));
    expect(out.score).toBeLessThan(0.5);
    expect(out.passed).toBe(false);
  });

  test("threshold gates pass/fail", async () => {
    const strict = semanticSimilarity({ embedder: mockEmbedder, threshold: 0.99 });
    const lax = semanticSimilarity({ embedder: mockEmbedder, threshold: 0.1 });
    const out1 = await strict(sample("the cat sat on the mat"), result("the cat sat on the rug"));
    const out2 = await lax(sample("the cat sat on the mat"), result("the cat sat on the rug"));
    expect(out1.passed).toBe(false);
    expect(out2.passed).toBe(true);
  });

  test("explicit reference overrides sample.expected_output", async () => {
    const grader = semanticSimilarity({
      embedder: mockEmbedder,
      threshold: 0.5,
      reference: "explicit override text",
    });
    const out = await grader(sample("wrong"), result("explicit override text"));
    expect(out.passed).toBe(true);
    expect(out.score).toBeGreaterThan(0.99);
  });

  test("missing expected_output throws GraderError", async () => {
    const grader = semanticSimilarity({ embedder: mockEmbedder, threshold: 0.5 });
    await expect(grader({ id: "s", input: "x" }, result("y"))).rejects.toThrow(
      /expected_output is required/,
    );
  });

  test("missing embedder throws at construction", () => {
    expect(() =>
      semanticSimilarity({ embedder: undefined as unknown as Embedder, threshold: 0.5 }),
    ).toThrow(/requires an `embedder`/);
  });
});

describe("T9 — property: embed(x) ≈ embed(x) ⇒ similarity ≈ 1.0", () => {
  test("multi-sentence inputs are self-similar", async () => {
    const grader = semanticSimilarity({ embedder: mockEmbedder, threshold: 0.99 });
    const inputs = [
      "Hello world",
      "The quick brown fox jumps over the lazy dog",
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit",
    ];
    for (const t of inputs) {
      const out = await grader(sample(t), result(t));
      expect(out.score).toBeGreaterThan(0.99);
      expect(out.passed).toBe(true);
    }
  });
});

describe("Fallback to ROUGE-L on embedder error", () => {
  test("embedder error falls back to ROUGE-L by default", async () => {
    const failing = new FailingEmbedder("rate limit");
    const grader = semanticSimilarity({ embedder: failing, threshold: 0.5 });
    const out = await grader(sample("the cat sat"), result("the cat sat"));
    // Identical strings still pass via ROUGE-L (which scores 1.0).
    expect(out.passed).toBe(true);
    expect(out.score).toBe(1);
    expect(out.rationale).toMatch(/fallback ROUGE-L/);
    expect(out.rationale).toMatch(/rate limit/);
  });

  test("disableFallback=true surfaces the embedder error", async () => {
    const failing = new FailingEmbedder("API key missing");
    const grader = semanticSimilarity({
      embedder: failing,
      threshold: 0.5,
      disableFallback: true,
    });
    await expect(grader(sample("hello"), result("hello"))).rejects.toThrow(/API key missing/);
  });

  test("fallbackThreshold tunes the ROUGE-L pass boundary", async () => {
    const failing = new FailingEmbedder("transient");
    const strict = semanticSimilarity({
      embedder: failing,
      threshold: 0.5,
      fallbackThreshold: 0.99,
    });
    const out = await strict(sample("the cat sat on the mat"), result("the cat sat on the rug"));
    expect(out.passed).toBe(false); // ROUGE-L score won't reach 0.99
    expect(out.rationale).toMatch(/fallback ROUGE-L/);
  });
});

describe("embedder arity guard", () => {
  test("too few vectors (length 1) throws GraderError", async () => {
    const grader = semanticSimilarity({
      embedder: new FixedVectorsEmbedder([[1, 0, 0]]),
      threshold: 0.5,
    });
    await expect(grader(sample("hello"), result("world"))).rejects.toThrow(GraderError);
    await expect(grader(sample("hello"), result("world"))).rejects.toThrow(
      /returned 1 vectors; expected 2/,
    );
  });

  test("empty vector list throws GraderError", async () => {
    const grader = semanticSimilarity({
      embedder: new FixedVectorsEmbedder([]),
      threshold: 0.5,
    });
    await expect(grader(sample("hello"), result("world"))).rejects.toThrow(
      /returned 0 vectors; expected 2/,
    );
  });
});

describe("resolveReference helper", () => {
  test("uses options.reference when provided", () => {
    expect(_resolveReferenceForTest({ reference: "from-option" }, sample("from-sample"))).toBe(
      "from-option",
    );
  });
  test("falls back to sample.expected_output", () => {
    expect(_resolveReferenceForTest({}, sample("from-sample"))).toBe("from-sample");
  });
  test("throws GraderError when neither set", () => {
    expect(() => _resolveReferenceForTest({}, { id: "s", input: "x" })).toThrow(/required/);
  });
});
