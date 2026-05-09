import { describe, expect, test } from "bun:test";
import type { RunResult, Sample } from "@crewhaus/eval-grader";
import {
  _bleuScoreForTest,
  _meteorScoreForTest,
  _rougeLScoreForTest,
  _rougeNForTest,
  _tokenizeForTest,
  bleu,
  bleu1,
  bleu4,
  meteor,
  rouge1,
  rouge2,
  rougeL,
} from "./index";

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

describe("tokenize", () => {
  test("lowercases + splits on non-alphanumeric", () => {
    expect(_tokenizeForTest("Hello, World!  How are you?")).toEqual([
      "hello",
      "world",
      "how",
      "are",
      "you",
    ]);
  });
  test("respects lowercase=false", () => {
    expect(_tokenizeForTest("Hello", false)).toEqual(["Hello"]);
  });
});

describe("ROUGE — T1", () => {
  test("ROUGE-1: identical strings score 1.0", () => {
    expect(_rougeNForTest("the cat sat", "the cat sat", 1, true)).toBe(1);
  });
  test("ROUGE-1: completely disjoint scores 0", () => {
    expect(_rougeNForTest("foo bar", "baz qux", 1, true)).toBe(0);
  });
  test("ROUGE-1: half overlap is between 0 and 1", () => {
    const score = _rougeNForTest("the cat sat on the mat", "the cat sat on the rug", 1, true);
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(1);
  });
  test("ROUGE-2: identical bigrams score 1.0", () => {
    expect(_rougeNForTest("the cat sat", "the cat sat", 2, true)).toBe(1);
  });
  test("ROUGE-L: identical strings score 1.0", () => {
    expect(_rougeLScoreForTest("the cat sat", "the cat sat", true)).toBe(1);
  });
  test("ROUGE-L: subsequence preserved scores high", () => {
    // Insertion in hypothesis — LCS still captures the original order.
    const score = _rougeLScoreForTest("the cat sat", "the big cat sat down", true);
    expect(score).toBeGreaterThan(0.7);
  });
  test("ROUGE-L: empty input/reference scores 0", () => {
    expect(_rougeLScoreForTest("", "anything", true)).toBe(0);
    expect(_rougeLScoreForTest("anything", "", true)).toBe(0);
  });
});

describe("BLEU — T1", () => {
  test("BLEU-1: identical strings near 1.0", () => {
    const s = _bleuScoreForTest("the cat sat", "the cat sat", 1, true);
    expect(s).toBeGreaterThan(0.99);
    expect(s).toBeLessThanOrEqual(1);
  });
  test("BLEU-4: identical strings (≥4 tokens) near 1.0", () => {
    const s = _bleuScoreForTest("the cat sat on", "the cat sat on", 4, true);
    expect(s).toBeGreaterThan(0.99);
  });
  test("BLEU-4: completely disjoint scores low (with +1 smoothing)", () => {
    // With +1 smoothing (Chen & Cherry Method 1), disjoint short strings
    // get a non-zero floor — but the score still stays well below the
    // identical-string ~1.0 ceiling. We assert it's < 0.5 to keep the
    // disjoint vs. identical separation meaningful.
    const s = _bleuScoreForTest("foo bar baz qux", "alpha beta gamma delta", 4, true);
    expect(s).toBeLessThan(0.5);
    const ident = _bleuScoreForTest("foo bar baz qux", "foo bar baz qux", 4, true);
    expect(s).toBeLessThan(ident);
  });
  test("BLEU brevity penalty fires when hypothesis is shorter", () => {
    const score = _bleuScoreForTest("the cat sat on the mat today", "the cat", 1, true);
    expect(score).toBeLessThan(0.5);
  });
});

describe("METEOR — T1", () => {
  test("identical strings score near 1.0", () => {
    const s = _meteorScoreForTest("the cat sat", "the cat sat", 0.9, 3, 0.5, true);
    expect(s).toBeGreaterThan(0.95);
  });
  test("completely disjoint scores 0", () => {
    const s = _meteorScoreForTest("foo bar", "baz qux", 0.9, 3, 0.5, true);
    expect(s).toBe(0);
  });
  test("permuted matches incur the chunk penalty", () => {
    const inOrder = _meteorScoreForTest(
      "the cat sat on the mat",
      "the cat sat on the mat",
      0.9,
      3,
      0.5,
      true,
    );
    const permuted = _meteorScoreForTest(
      "the cat sat on the mat",
      "mat the on sat cat the",
      0.9,
      3,
      0.5,
      true,
    );
    expect(permuted).toBeLessThan(inOrder);
  });
});

describe("Grader factories — pull from sample.expected_output", () => {
  test("rougeL grader uses sample.expected_output by default", async () => {
    const grader = rougeL({ threshold: 0.5 });
    const out = await grader(sample("the cat sat"), result("the cat sat"));
    expect(out.passed).toBe(true);
    expect(out.score).toBe(1);
    expect(out.rationale).toMatch(/ROUGE-L/);
  });

  test("rouge1 threshold gates pass/fail", async () => {
    const strict = rouge1({ threshold: 0.99 });
    const lax = rouge1({ threshold: 0.1 });
    const out1 = await strict(sample("the cat sat on the mat"), result("the cat sat on the rug"));
    const out2 = await lax(sample("the cat sat on the mat"), result("the cat sat on the rug"));
    expect(out1.passed).toBe(false);
    expect(out2.passed).toBe(true);
  });

  test("explicit reference option overrides sample.expected_output", async () => {
    const grader = rougeL({ threshold: 0.5, reference: "explicit override" });
    // sample expected says "wrong" but reference says "explicit override"
    const out = await grader(sample("wrong"), result("explicit override"));
    expect(out.passed).toBe(true);
    expect(out.score).toBe(1);
  });

  test("missing expected_output throws GraderError", async () => {
    const grader = rougeL({ threshold: 0.5 });
    await expect(grader({ id: "s1", input: "x" }, result("anything"))).rejects.toThrow(
      /expected_output is required/,
    );
  });

  test("bleu factory dispatches by n", async () => {
    const g4 = bleu(4, { threshold: 0.5 });
    const g4b = bleu4({ threshold: 0.5 });
    const out1 = await g4(sample("the cat sat on the mat"), result("the cat sat on the mat"));
    const out2 = await g4b(sample("the cat sat on the mat"), result("the cat sat on the mat"));
    expect(out1.score).toBeCloseTo(out2.score, 6);
    expect(out1.rationale).toMatch(/BLEU-4/);
  });

  test("bleu1 alias matches bleu(1)", async () => {
    const a = bleu1({ threshold: 0.5 });
    const b = bleu(1, { threshold: 0.5 });
    const out1 = await a(sample("hello"), result("hello"));
    const out2 = await b(sample("hello"), result("hello"));
    expect(out1.score).toBe(out2.score);
  });

  test("meteor factory works with default α/β/γ", async () => {
    const g = meteor({ threshold: 0.5 });
    const out = await g(sample("the cat sat"), result("the cat sat"));
    expect(out.passed).toBe(true);
    expect(out.score).toBeGreaterThan(0.95);
  });
});

describe("T9 — score-monotonicity property", () => {
  test("ROUGE-1 score is monotonic: longer overlap ⇒ higher score", () => {
    const ref = "alpha beta gamma delta epsilon";
    const hyps = [
      "alpha", // 1 overlap
      "alpha beta", // 2 overlap
      "alpha beta gamma", // 3 overlap
      "alpha beta gamma delta", // 4 overlap
      "alpha beta gamma delta epsilon", // 5 overlap (full)
    ];
    let prev = -1;
    for (const h of hyps) {
      const s = _rougeNForTest(ref, h, 1, true);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
    expect(prev).toBe(1);
  });

  test("ROUGE-L is monotonic in shared subsequence length", () => {
    const ref = "a b c d e f g";
    const hyps = ["a", "a b", "a b c", "a b c d", "a b c d e f g"];
    let prev = -1;
    for (const h of hyps) {
      const s = _rougeLScoreForTest(ref, h, true);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });

  test("BLEU-1 is non-decreasing in unigram overlap", () => {
    const ref = "alpha beta gamma";
    const hyps = ["zeta", "alpha zeta", "alpha beta zeta", "alpha beta gamma"];
    let prev = -1;
    for (const h of hyps) {
      const s = _bleuScoreForTest(ref, h, 1, true);
      expect(s).toBeGreaterThanOrEqual(prev - 0.01);
      prev = s;
    }
  });

  test("Identical strings always score the maximum (≈1.0) across all metrics", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    expect(_rougeNForTest(text, text, 1, true)).toBe(1);
    expect(_rougeNForTest(text, text, 2, true)).toBe(1);
    expect(_rougeLScoreForTest(text, text, true)).toBe(1);
    expect(_bleuScoreForTest(text, text, 4, true)).toBeGreaterThan(0.99);
    expect(_meteorScoreForTest(text, text, 0.9, 3, 0.5, true)).toBeGreaterThan(0.95);
  });
});
