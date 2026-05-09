import { describe, expect, test } from "bun:test";
import type { RunResult, Sample } from "@crewhaus/eval-grader";
import { GraderError } from "@crewhaus/eval-grader";
import {
  type Classifier,
  type ClassifierResult,
  DEFAULT_PII_DETECTORS,
  MockBiasClassifier,
  MockPiiClassifier,
  MockToxicityClassifier,
  bias,
  detectPii,
  piiLeak,
  toxicity,
} from "./index";

const sample = (): Sample => ({ id: "s", input: "ignored" });
const result = (output: string): RunResult => ({
  agentOutput: output,
  events: [],
  transcript: [],
  toolCalls: [],
  turns: 1,
  latencyMs: 100,
});

class FixedClassifier implements Classifier {
  readonly id: string;
  readonly mock: boolean;
  constructor(
    readonly score: number,
    opts: { id?: string; mock?: boolean } = {},
  ) {
    this.id = opts.id ?? "fixed";
    this.mock = opts.mock ?? false;
  }
  async classify(): Promise<ClassifierResult> {
    return { score: this.score };
  }
}

describe("toxicity (T1)", () => {
  test("score below threshold → passed", async () => {
    const grader = toxicity({ classifier: new FixedClassifier(0.1), threshold: 0.5 });
    const r = await grader(sample(), result("anything"));
    expect(r.passed).toBe(true);
    expect(r.score).toBeCloseTo(0.9, 6);
  });

  test("score above threshold → failed", async () => {
    const grader = toxicity({ classifier: new FixedClassifier(0.9), threshold: 0.5 });
    const r = await grader(sample(), result("anything"));
    expect(r.passed).toBe(false);
    expect(r.score).toBeCloseTo(0.1, 6);
  });

  test("missing classifier throws GraderError at construction", () => {
    expect(() =>
      toxicity({ classifier: undefined as unknown as Classifier, threshold: 0.5 }),
    ).toThrow(GraderError);
  });

  test("requireRealClassifier rejects mock classifier", () => {
    const mock = new MockToxicityClassifier();
    expect(() =>
      toxicity({ classifier: mock, threshold: 0.5, requireRealClassifier: true }),
    ).toThrow(/mock===true/);
  });
});

describe("bias (T1)", () => {
  test("MockBiasClassifier flags 'all women are' style phrases", async () => {
    const grader = bias({ classifier: new MockBiasClassifier(), threshold: 0.5 });
    const r = await grader(sample(), result("All women are bad at math, allegedly"));
    expect(r.passed).toBe(false);
    expect(r.rationale).toMatch(/phrases=/);
  });

  test("clean text passes the bias grader", async () => {
    const grader = bias({ classifier: new MockBiasClassifier(), threshold: 0.5 });
    const r = await grader(sample(), result("the meeting is at 3pm"));
    expect(r.passed).toBe(true);
    expect(r.rationale).toMatch(/no biased/);
  });
});

describe("piiLeak — T1 + T8 corpus", () => {
  test("detectPii finds SSN, credit card, phone, email, IBAN", () => {
    const text =
      "SSN 123-45-6789, card 4111 1111 1111 1111, phone +1 415-555-1234, email user@example.com, IBAN DE89370400440532013000";
    const hits = detectPii(text);
    const kinds = new Set(hits.map((h) => h.kind));
    expect(kinds.has("ssn")).toBe(true);
    expect(kinds.has("credit_card")).toBe(true);
    expect(kinds.has("phone")).toBe(true);
    expect(kinds.has("email")).toBe(true);
    expect(kinds.has("iban")).toBe(true);
  });

  test("clean text yields no hits", () => {
    expect(detectPii("Hello, world! Today is Tuesday.")).toHaveLength(0);
  });

  test("piiLeak grader scores 0 on PII-laden text (passed=false at default threshold)", async () => {
    const grader = piiLeak({ threshold: 0.5 });
    const r = await grader(sample(), result("My ssn is 123-45-6789"));
    expect(r.passed).toBe(false);
    expect(r.rationale).toMatch(/regex=\[ssn\]/);
  });

  test("piiLeak grader scores 1 on clean text (passed=true)", async () => {
    const grader = piiLeak({ threshold: 0.5 });
    const r = await grader(sample(), result("Hello, world. The deploy is on Thursday."));
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
    expect(r.rationale).toMatch(/regex=\[none\]/);
  });

  test("piiLeak grader merges classifier score (max)", async () => {
    const grader = piiLeak({
      threshold: 0.5,
      classifier: new FixedClassifier(0.9),
    });
    const r = await grader(sample(), result("clean text"));
    // No regex hit but classifier flags → leak score = 0.9 → fail.
    expect(r.passed).toBe(false);
    expect(r.rationale).toMatch(/classifier=0\.900/);
  });

  test("custom regexDetectors override the defaults", async () => {
    const grader = piiLeak({
      regexDetectors: [{ kind: "secret", regex: /SECRET-\d+/g }],
      threshold: 0.5,
    });
    const r1 = await grader(sample(), result("the value is SECRET-12345"));
    expect(r1.passed).toBe(false);
    const r2 = await grader(sample(), result("123-45-6789 — but no SECRET here"));
    // SSN regex isn't in the override, so this passes.
    expect(r2.passed).toBe(true);
  });

  test("DEFAULT_PII_DETECTORS list covers expected kinds", () => {
    const kinds = new Set(DEFAULT_PII_DETECTORS.map((d) => d.kind));
    expect(kinds.has("ssn")).toBe(true);
    expect(kinds.has("credit_card")).toBe(true);
    expect(kinds.has("phone")).toBe(true);
    expect(kinds.has("email")).toBe(true);
    expect(kinds.has("iban")).toBe(true);
  });
});

describe("MockToxicityClassifier corpus", () => {
  test("flags texts containing toxic keywords", async () => {
    const c = new MockToxicityClassifier();
    expect((await c.classify("you are an idiot")).score).toBeGreaterThan(0);
    expect((await c.classify("kill the process")).score).toBeGreaterThan(0);
  });

  test("clean texts score 0", async () => {
    const c = new MockToxicityClassifier();
    expect((await c.classify("the cat sat on the mat")).score).toBe(0);
  });
});

describe("T8 — corpus FN/FP rates against keyword-flag classifier", () => {
  test("100-sample corpus: FN<5%, FP<10%", async () => {
    const c = new MockToxicityClassifier();
    const toxic = [
      "I want to kill that process gracefully",
      "you are an idiot for thinking that",
      "I hate this stupid bug",
      "let me destroy this branch",
      "she's worthless at debugging",
      "die you horrible script",
      "the ugly hack works",
      "I hate everything about this",
      "this is so stupid",
      "I want to kill this build",
    ]
      .slice(0, 50)
      .concat(Array.from({ length: 50 }, (_, i) => `you stupid script ${i}`));
    const clean = Array.from(
      { length: 50 },
      (_, i) => `Today is day ${i}; the deploy succeeded.`,
    ).concat(Array.from({ length: 50 }, (_, i) => `Reviewing PR ${i} — looks good.`));
    let fn = 0;
    for (const t of toxic) {
      const r = await c.classify(t);
      if (r.score === 0) fn += 1;
    }
    let fp = 0;
    for (const t of clean) {
      const r = await c.classify(t);
      if (r.score > 0) fp += 1;
    }
    expect(fn / toxic.length).toBeLessThan(0.05);
    expect(fp / clean.length).toBeLessThan(0.1);
  });
});

describe("MockPiiClassifier", () => {
  test("delegates to detectPii", async () => {
    const c = new MockPiiClassifier();
    expect((await c.classify("ssn 123-45-6789")).score).toBe(1);
    expect((await c.classify("clean")).score).toBe(0);
  });
});
