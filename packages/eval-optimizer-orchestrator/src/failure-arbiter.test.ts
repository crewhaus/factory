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

  test("a non-transient errorMessage falls through Rule 1 to the bug default", () => {
    // errorMessage is present but matches none of the transient markers, so
    // the noise rule does not fire and classification falls through to bug.
    const f: FailingSample = {
      sample: baseSample,
      actual: "5",
      score: 0,
      errorMessage: "AssertionError: expected 4 but got 5",
    };
    const v = arbitrate(f);
    expect(v.class).toBe("bug");
    expect(v.action.kind).toBe("fix-impl");
    expect(v.reason).toContain("clear contract clause");
  });

  test("grader flags multipleAcceptable → contract-ambiguity / refine-contract", () => {
    // The second contract-ambiguity branch: `acceptable` is NOT set (so Rule 2
    // first branch is skipped) but the grader reports multiple acceptable
    // outputs.
    const f: FailingSample = {
      sample: baseSample,
      actual: "four",
      score: 0,
      graderOutput: { multipleAcceptable: true },
    };
    const v = arbitrate(f);
    expect(v.class).toBe("contract-ambiguity");
    expect(v.action).toEqual({ kind: "refine-contract", restartImpl: true });
    expect(v.reason).toContain("underspecifies");
  });

  test("absent reference with a positive score → contract-ambiguity", () => {
    // Sample carries no `reference` field at all and the grader still awarded
    // partial credit (score > 0) — the contract underspecifies the answer.
    const f: FailingSample = {
      sample: { id: "s2", input: "name a primary color" },
      actual: "teal",
      score: 0.4,
    };
    const v = arbitrate(f);
    expect(v.class).toBe("contract-ambiguity");
    expect(v.action.kind).toBe("refine-contract");
  });

  test("explicit null reference with a positive score → contract-ambiguity", () => {
    // The `ref === null` disjunct specifically (vs. undefined above).
    // `reference` is read by the arbiter via a cast (it is not part of the
    // `Sample` type), so the sample carries it as an extra runtime property.
    const sample = { id: "s3", input: "name a primary color", reference: null };
    const f: FailingSample = {
      sample,
      actual: "teal",
      score: 0.4,
    };
    const v = arbitrate(f);
    expect(v.class).toBe("contract-ambiguity");
    expect(v.action.kind).toBe("refine-contract");
  });

  test("absent reference but a ZERO score is NOT contract-ambiguity (stays bug)", () => {
    // Guards the `failing.score > 0` half of the predicate: with no reference
    // AND no credit, the second contract-ambiguity branch must not fire.
    const f: FailingSample = {
      sample: { id: "s4", input: "name a primary color" },
      actual: "teal",
      score: 0,
    };
    const v = arbitrate(f);
    expect(v.class).toBe("bug");
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

  test("aggregate recommends calibrate-verifier when noise dominates", () => {
    // All failings are transient → noise is the unambiguous majority, so the
    // recommended action is to calibrate the verifier/CI rather than touch
    // the impl or contract.
    const failings: FailingSample[] = [
      { sample: baseSample, actual: "", score: 0, errorMessage: "ETIMEDOUT" },
      { sample: baseSample, actual: "", score: 0, errorMessage: "ECONNRESET" },
      { sample: baseSample, actual: "", score: 0, errorMessage: "sandbox preempted" },
    ];
    const a = aggregate(failings);
    expect(a.total).toBe(3);
    expect(a.counts.noise).toBe(3);
    expect(a.dominantClass).toBe("noise");
    expect(a.recommendedAction).toEqual({ kind: "calibrate-verifier" });
  });

  test("aggregate recommends update-contract when spec-gap dominates", () => {
    // Drives the spec-gap arm of the recommendedAction ternary.
    const specGap: FailingSample = {
      sample: { ...baseSample, metadata: { requiredBehavior: "cite a source" } },
      actual: "4 (per Wikipedia)",
      score: 0,
      graderOutput: { addressedByImpl: true, inContract: false },
    };
    const a = aggregate([specGap, specGap, { sample: baseSample, actual: "x", score: 0 }]);
    expect(a.dominantClass).toBe("spec-gap");
    expect(a.recommendedAction).toEqual({ kind: "update-contract", retryImpl: true });
  });

  test("aggregate over an empty list defaults to bug / fix-impl", () => {
    // No failings → counts all zero; the deliberate tie-break order leaves
    // `contract-ambiguity` as the >-winner over the -1 seed, but since every
    // count ties at 0 the first-in-order (contract-ambiguity) is dominant.
    const a = aggregate([]);
    expect(a.total).toBe(0);
    expect(a.counts).toEqual({ bug: 0, "spec-gap": 0, noise: 0, "contract-ambiguity": 0 });
    expect(a.dominantClass).toBe("contract-ambiguity");
    expect(a.recommendedAction.kind).toBe("refine-contract");
  });
});
