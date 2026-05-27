import { describe, expect, test } from "bun:test";
import { type FailingSample, aggregate, arbitrate } from "./failure-arbiter";

const baseSample = {
  id: "s1",
  input: "what is 2+2?",
  reference: "4",
};

describe("Track B — four-way failure arbiter", () => {
  test("transient infrastructure error → noise / calibrate-verifier", () => {
    const f: FailingSample = {
      sample: baseSample,
      actual: "",
      score: 0,
      errorMessage: "ETIMEDOUT connecting to model provider",
    };
    const v = arbitrate(f);
    expect(v.class).toBe("noise");
    expect(v.action.kind).toBe("calibrate-verifier");
  });

  test("grader-acceptable mismatch → contract-ambiguity / refine-contract", () => {
    const f: FailingSample = {
      sample: baseSample,
      actual: "four",
      score: 0.5,
      graderOutput: { acceptable: true },
    };
    const v = arbitrate(f);
    expect(v.class).toBe("contract-ambiguity");
    expect(v.action.kind).toBe("refine-contract");
  });

  test("impl addresses behavior not in contract → spec-gap / update-contract", () => {
    const f: FailingSample = {
      sample: {
        ...baseSample,
        metadata: { requiredBehavior: "show step-by-step working" },
      },
      actual: "4 (because 2+2=4)",
      score: 0,
      graderOutput: { addressedByImpl: true, inContract: false },
    };
    const v = arbitrate(f);
    expect(v.class).toBe("spec-gap");
    expect(v.action.kind).toBe("update-contract");
  });

  test("no rule matches → bug / fix-impl (default)", () => {
    const f: FailingSample = {
      sample: baseSample,
      actual: "5",
      score: 0,
    };
    const v = arbitrate(f);
    expect(v.class).toBe("bug");
    expect(v.action.kind).toBe("fix-impl");
  });

  test("aggregate picks dominant class and matching action", () => {
    const failings: FailingSample[] = [
      { sample: baseSample, actual: "x", score: 0 }, // bug
      { sample: baseSample, actual: "x", score: 0 }, // bug
      {
        sample: baseSample,
        actual: "y",
        score: 0.5,
        graderOutput: { acceptable: true },
      }, // contract-ambiguity
    ];
    const a = aggregate(failings);
    expect(a.total).toBe(3);
    expect(a.counts.bug).toBe(2);
    expect(a.counts["contract-ambiguity"]).toBe(1);
    expect(a.dominantClass).toBe("bug");
    expect(a.recommendedAction.kind).toBe("fix-impl");
  });

  test("aggregate tie-break favors process-correcting actions", () => {
    const failings: FailingSample[] = [
      { sample: baseSample, actual: "x", score: 0 }, // bug
      {
        sample: baseSample,
        actual: "y",
        score: 0.5,
        graderOutput: { acceptable: true },
      }, // contract-ambiguity
    ];
    // 1 bug, 1 contract-ambiguity — contract-ambiguity wins tie.
    const a = aggregate(failings);
    expect(a.dominantClass).toBe("contract-ambiguity");
    expect(a.recommendedAction.kind).toBe("refine-contract");
  });

  test("noise tie-break loses to anything else", () => {
    const failings: FailingSample[] = [
      { sample: baseSample, actual: "x", score: 0, errorMessage: "rate limit" }, // noise
      { sample: baseSample, actual: "y", score: 0 }, // bug
    ];
    const a = aggregate(failings);
    expect(a.dominantClass).toBe("bug");
  });
});
