/**
 * C28 — `crewhaus eval plan`: the sample-size arithmetic, its terms, and the
 * rendering that has to TEACH rather than assert. Pure + offline; the pilot
 * reader is injected, so nothing here touches the filesystem.
 */
import { describe, expect, test } from "bun:test";
import {
  EvalPlanError,
  inverseNormalCdf,
  planSampleSize,
  powerFactor,
  renderEvalPlan,
  zForConfidence,
} from "./eval-plan";

const pilotJson = (passRate: number, sampleCount: number, runId = "run_pilot"): string =>
  JSON.stringify({
    runId,
    aggregates: { passRate },
    samples: Array.from({ length: sampleCount }, (_, i) => ({ sampleId: `s${i}` })),
  });

describe("zForConfidence", () => {
  test("matches the textbook two-sided critical values", () => {
    expect(zForConfidence(0.9)).toBeCloseTo(1.6449, 3);
    expect(zForConfidence(0.95)).toBeCloseTo(1.96, 3);
    expect(zForConfidence(0.99)).toBeCloseTo(2.5758, 3);
    expect(zForConfidence(0.999)).toBeCloseTo(3.2905, 3);
  });

  test("the inverse-normal helper is symmetric around the median", () => {
    expect(inverseNormalCdf(0.5)).toBeCloseTo(0, 6);
    expect(inverseNormalCdf(0.975)).toBeCloseTo(-inverseNormalCdf(0.025), 6);
    // Deep tails use the rational tail branch — still accurate.
    expect(inverseNormalCdf(0.999999)).toBeCloseTo(4.7534, 3);
  });

  test("a confidence outside (0,1) is refused, not clamped", () => {
    expect(() => zForConfidence(0)).toThrow(EvalPlanError);
    expect(() => zForConfidence(1)).toThrow(/strictly between 0 and 1/);
    expect(() => zForConfidence(95)).toThrow(EvalPlanError);
  });
});

describe("planSampleSize", () => {
  test("worst-case p: n = z²·0.25/e², rounded UP", () => {
    const plan = planSampleSize({ targetDelta: 0.05 });
    expect(plan.p).toBe(0.5);
    expect(plan.pSource).toBe("worst-case");
    expect(plan.rawN).toBeCloseTo((1.959964 ** 2 * 0.25) / 0.05 ** 2, 3);
    expect(plan.n).toBe(385); // ceil(384.15)
    expect(plan.nPerArmForComparison).toBe(769); // ceil(2 × 384.15)
  });

  test("a tighter target delta costs quadratically more samples", () => {
    const coarse = planSampleSize({ targetDelta: 0.1 });
    const fine = planSampleSize({ targetDelta: 0.05 });
    expect(coarse.n).toBe(97);
    // Halving e quadruples n (± the ceil).
    expect(fine.rawN / coarse.rawN).toBeCloseTo(4, 6);
  });

  test("a lower confidence needs fewer samples", () => {
    expect(planSampleSize({ targetDelta: 0.05, confidence: 0.9 }).n).toBeLessThan(
      planSampleSize({ targetDelta: 0.05 }).n,
    );
  });

  test("--pilot seeds p from the run's measured pass rate", () => {
    const plan = planSampleSize({
      targetDelta: 0.1,
      confidence: 0.9,
      pilotRunDir: "/runs/pilot",
      readPilot: () => pilotJson(0.8, 8),
    });
    expect(plan.pSource).toBe("pilot");
    expect(plan.p).toBe(0.8);
    expect(plan.pilotRunId).toBe("run_pilot");
    expect(plan.pilotSampleCount).toBe(8);
    expect(plan.rawN).toBeCloseTo((1.644854 ** 2 * 0.8 * 0.2) / 0.01, 3);
    expect(plan.n).toBe(44);
  });

  test("a lopsided pilot pass rate needs FEWER samples than the worst case", () => {
    const lopsided = planSampleSize({
      targetDelta: 0.05,
      pilotRunDir: "/p",
      readPilot: () => pilotJson(0.95, 40),
    });
    expect(lopsided.n).toBeLessThan(planSampleSize({ targetDelta: 0.05 }).n);
  });

  test("reports the smallest delta the pilot's own n could resolve", () => {
    const plan = planSampleSize({
      targetDelta: 0.05,
      pilotRunDir: "/p",
      readPilot: () => pilotJson(0.5, 8),
    });
    // z·sqrt(p(1-p)/n) = 1.96·sqrt(0.25/8) ≈ 0.3465
    expect(plan.pilotDetectableDelta).toBeCloseTo(0.3465, 3);
  });

  test("an unusable target delta is refused with a message that explains the unit", () => {
    expect(() => planSampleSize({ targetDelta: 0 })).toThrow(/strictly between 0 and 1/);
    expect(() => planSampleSize({ targetDelta: 5 })).toThrow(/5 percentage-point/);
    expect(() => planSampleSize({ targetDelta: Number.NaN })).toThrow(EvalPlanError);
  });

  test("an unreadable / malformed / incomplete pilot is a clear error, never a silent 0.5", () => {
    const read = (throwing: () => string) =>
      planSampleSize({ targetDelta: 0.05, pilotRunDir: "/p", readPilot: throwing });
    expect(() =>
      read(() => {
        throw new Error("ENOENT");
      }),
    ).toThrow(/not a readable eval run directory/);
    expect(() => read(() => "{not json")).toThrow(/not valid JSON/);
    expect(() => read(() => JSON.stringify({ aggregates: {} }))).toThrow(
      /no usable aggregates.passRate/,
    );
  });
});

describe("renderEvalPlan", () => {
  test("prints every term, its source, and the substituted arithmetic", () => {
    const text = renderEvalPlan(planSampleSize({ targetDelta: 0.05 }));
    expect(text).toContain("n ≈ z² · p(1−p) / e²");
    expect(text).toContain("z:                1.960");
    expect(text).toContain("worst case — no --pilot");
    expect(text).toContain("n = 1.960² · 0.500·0.500 / 0.050² = 384.15 → 385 samples");
    expect(text).toContain("budget ~769 samples per run");
    expect(text).toContain("Caveat:");
  });

  test("says the number is an interval half-width, not a test's power", () => {
    const text = renderEvalPlan(planSampleSize({ targetDelta: 0.05 }));
    // The formula has no z_β term: at n the true delta is caught ~half the
    // time, and a command whose whole purpose is metric literacy must say so.
    expect(text).toContain("ESTIMATE's WIDTH, not a test's POWER");
    expect(text).toContain("~50% of the time");
    // 95%/80%: ((1.959964 + 0.841621)/1.959964)² ≈ 2.0428 → ceil(384.15·2.0428) = 785.
    expect(powerFactor(zForConfidence(0.95))).toBeCloseTo(2.0428, 3);
    expect(text).toContain("~785 samples (2.04× these)");
  });

  test("the power factor is derived from the plan's own z, not a flat 2×", () => {
    // A 99% interval already carries a bigger z, so the power surcharge on
    // top of it is SMALLER — quoting a flat "2×" would over-budget it.
    expect(powerFactor(zForConfidence(0.99))).toBeCloseTo(1.7607, 3);
    const text = renderEvalPlan(planSampleSize({ targetDelta: 0.02, confidence: 0.99 }));
    expect(text).toContain("(1.76× these)");
  });

  test("with a pilot it names the run and calls out an under-powered pilot", () => {
    const text = renderEvalPlan(
      planSampleSize({
        targetDelta: 0.05,
        pilotRunDir: "/p",
        readPilot: () => pilotJson(0.5, 8, "run_abc"),
      }),
    );
    expect(text).toContain("(pilot run_abc, n=8 measured pass rate)");
    expect(text).toContain("too coarse for a 5.0pp target");
  });

  test("a well-powered pilot is described as already fine enough", () => {
    const text = renderEvalPlan(
      planSampleSize({
        targetDelta: 0.2,
        pilotRunDir: "/p",
        readPilot: () => pilotJson(0.5, 400),
      }),
    );
    expect(text).toContain("already fine enough");
  });
});
