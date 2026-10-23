import { describe, expect, test } from "bun:test";
import type { GradeResult } from "@crewhaus/eval-grader";
import { GraderRegistry } from "@crewhaus/grader-registry";
import { unverifiedBundle } from "@crewhaus/provability";
import {
  POLICY,
  POLICY_FETCH,
  accrual,
  bundleFor,
  pass,
  response,
  runWith,
  sample,
} from "./__test__/fixtures";
import {
  INFINITE_COST_PREFIX,
  PROVABILITY_GRADERS,
  PROVABILITY_GRADER_NAMES,
  PROVABILITY_METRIC_SPECS,
  UNPRICED_COST_PREFIX,
  assumptionRate,
  registerProvabilityGraders,
  renderProvabilitySummaryLines,
  summarizeCostPerProvenClaim,
  summarizeProvabilityMetrics,
} from "./index";

const r = (passed: boolean, score: number, rationale = "x"): GradeResult => ({
  passed,
  score,
  rationale,
});

describe("summarizeProvabilityMetrics", () => {
  test("means, pass fractions and breaches per metric, in spec order", () => {
    const summary = summarizeProvabilityMetrics({
      "provability.claimCoverage": [r(true, 1), r(false, 0.5)],
      "provability.rungAchieved": [r(true, 0.5), r(true, 0.75)],
      "provability.citationValidity": [r(true, 1)],
      "provability.assumptionRate": [r(false, 0.4), r(true, 0)],
      "provability.replayIntegrity": [],
      "provability.costPerProvenClaim": [r(true, 0.01), r(true, 0.03)],
    });
    expect(summary.metrics.map((m) => m.name)).toEqual(
      PROVABILITY_METRIC_SPECS.filter((s) => s.name !== "provability.costPerProvenClaim").map(
        (s) => s.name,
      ),
    );
    const by = Object.fromEntries(summary.metrics.map((m) => [m.name, m]));
    expect(by["provability.claimCoverage"]).toMatchObject({
      mean: 0.75,
      passFraction: 0.5,
      thresholdBreach: true, // 0.75 < 0.95
    });
    // rungAchieved has no fixed bar: it breaches only when a sample fell short.
    expect(by["provability.rungAchieved"]?.thresholdBreach).toBe(false);
    expect(by["provability.rungAchieved"]?.threshold).toBeUndefined();
    // assumptionRate is LOWER-is-better: mean 0.2 > 0.1 breaches.
    expect(by["provability.assumptionRate"]).toMatchObject({ mean: 0.2, thresholdBreach: true });
    // No results: count 0, never a breach.
    expect(by["provability.replayIntegrity"]).toMatchObject({ count: 0, thresholdBreach: false });
    expect(summary.breaches).toBe(2);
    expect(summary.cost).toMatchObject({ count: 2, finiteCount: 2, infiniteCount: 0 });
    expect(summary.cost.meanUsd).toBeCloseTo(0.02, 9);
  });

  test("rungAchieved breaches when any sample fell short of its floor", () => {
    const summary = summarizeProvabilityMetrics({
      "provability.rungAchieved": [r(true, 1), r(false, 0.25)],
    });
    expect(
      summary.metrics.find((m) => m.name === "provability.rungAchieved")?.thresholdBreach,
    ).toBe(true);
  });

  test("unmeasured samples never pull a LOWER-is-better mean under its bar (review W3-C2)", async () => {
    // 5 unverified samples + 5 that each breach at 0.2: the mean of the
    // measured ones is 0.2 > 0.1 — a placeholder 0 must not dilute it to 0.1.
    const twoClaims = `The refund window is 14 days [1]. Our store is open daily [A1]. Returns are free [1]. Shipping is quick [1]. Support is 24/7 [1].\n\n[1]: ${POLICY}\n[A1]: assume: hours`;
    const measured = await bundleFor(twoClaims, "cited");
    const unverified = unverifiedBundle({ level: "cited", threshold: 1 }, new Error("boom"));
    const results = [
      ...(await Promise.all(
        [1, 2, 3, 4, 5].map(() => assumptionRate(sample(), runWith(unverified))),
      )),
      ...(await Promise.all(
        [1, 2, 3, 4, 5].map(() => assumptionRate(sample(), runWith(measured))),
      )),
    ];
    expect(results.slice(5).every((x) => x.score === 0.2)).toBe(true);
    const metric = summarizeProvabilityMetrics({
      "provability.assumptionRate": results,
    }).metrics.find((m) => m.name === "provability.assumptionRate");
    expect(metric).toMatchObject({
      count: 10,
      unmeasured: 5,
      passFraction: 0,
      thresholdBreach: true,
    });
    expect(metric?.mean).toBeCloseTo(0.2, 9);
    // Every sample unmeasured: nothing met the bound, so it breaches.
    const none = summarizeProvabilityMetrics({
      "provability.assumptionRate": results.slice(0, 5),
    }).metrics.find((m) => m.name === "provability.assumptionRate");
    expect(none).toMatchObject({ unmeasured: 5, thresholdBreach: true });
    // A higher-is-better metric keeps the placeholder 0 (conservative).
    const coverage = summarizeProvabilityMetrics({
      "provability.claimCoverage": [
        r(true, 1),
        r(false, 0, "no proof bundle (is provability: declared?)"),
      ],
    }).metrics.find((m) => m.name === "provability.claimCoverage");
    expect(coverage).toMatchObject({ unmeasured: 1, mean: 0.5, thresholdBreach: true });
  });

  test("an empty roll-up is all zeros and no breaches", () => {
    const summary = summarizeProvabilityMetrics({});
    expect(summary.breaches).toBe(0);
    expect(summary.overall).toBe(0);
    expect(summary.cost.count).toBe(0);
  });
});

describe("summarizeCostPerProvenClaim", () => {
  test("∞ samples are counted apart, failures are unmeasured, the mean is over finite ones", () => {
    const cost = summarizeCostPerProvenClaim([
      r(true, 0.02),
      r(true, 0, `${INFINITE_COST_PREFIX} — spent $0.0100 with zero claims met`),
      r(true, 0, "$0.0000 per proven claim — no gate spend"),
      r(false, 0, "no proof bundle (is provability: declared?)"),
    ]);
    expect(cost).toMatchObject({ count: 4, finiteCount: 2, infiniteCount: 1, unmeasured: 1 });
    expect(cost.meanUsd).toBeCloseTo(0.01, 9);
  });

  test("partly unpriced samples are counted apart, never as a finite $0 (review W3-C2)", async () => {
    const bundle = await bundleFor(
      `The refund window is 14 days [1].\n\n[1]: ${POLICY}`,
      "grounded",
      [POLICY_FETCH],
    );
    const cost = PROVABILITY_GRADERS.find(([n]) => n === "provability.costPerProvenClaim")?.[1];
    if (cost === undefined) throw new Error("missing grader");
    const unpriced = await cost(
      sample(),
      runWith(bundle, [pass("fail", 0), response(5000, 2000), pass("pass", 1)]),
    );
    expect(unpriced.rationale.startsWith(UNPRICED_COST_PREFIX)).toBe(true);
    const summary = summarizeCostPerProvenClaim([unpriced, r(true, 0.04)]);
    expect(summary).toMatchObject({ finiteCount: 1, unpricedCount: 1, infiniteCount: 0 });
    expect(summary.meanUsd).toBeCloseTo(0.04, 9);
    const lines = renderProvabilitySummaryLines(
      summarizeProvabilityMetrics({ "provability.costPerProvenClaim": [unpriced] }),
    );
    expect(lines.find((l) => l.startsWith("provability.costPerProvenClaim"))).toContain(
      "partly unpriced 1",
    );
  });

  test("the summary reads the REAL grader's ∞ rationale", async () => {
    const bundle = await bundleFor(
      `The refund window is 14 days [1].\n\n[1]: ${POLICY}`,
      "grounded",
    );
    const cost = PROVABILITY_GRADERS.find(([n]) => n === "provability.costPerProvenClaim")?.[1];
    if (cost === undefined) throw new Error("missing grader");
    // Never fetched: zero met claims, and a retry window that spent.
    const infinite = await cost(
      sample(),
      runWith(bundle, [pass("fail", 0), accrual(12_000), pass("fail", 1)]),
    );
    const zero = await cost(sample(), runWith(bundle, [pass("fail", 0)]));
    expect(summarizeCostPerProvenClaim([infinite, zero])).toMatchObject({
      infiniteCount: 1,
      finiteCount: 1,
    });
  });
});

describe("renderProvabilitySummaryLines", () => {
  test("one line per metric, the cost line, and the overall line", () => {
    const lines = renderProvabilitySummaryLines(
      summarizeProvabilityMetrics({
        "provability.claimCoverage": [r(false, 0.5)],
        "provability.costPerProvenClaim": [r(true, 0, `${INFINITE_COST_PREFIX} — spent`)],
      }),
    );
    expect(lines).toHaveLength(7);
    expect(lines[0]).toContain("provability.claimCoverage");
    expect(lines[0]).toContain("≥0.95 BREACH");
    expect(lines[1]).toContain("≥ each sample's floor");
    expect(lines[3]).toContain("≤0.1");
    expect(lines[5]).toContain("∞ 1");
    expect(lines[5]).toContain("reported, no threshold");
    expect(lines[6]).toContain("provability overall:");
  });
});

describe("registerProvabilityGraders", () => {
  test("registers the six names and returns them", () => {
    const registry = new GraderRegistry();
    expect(registerProvabilityGraders(registry)).toEqual(PROVABILITY_GRADER_NAMES);
    expect(registry.list()).toEqual([...PROVABILITY_GRADER_NAMES].sort());
  });

  test("is idempotent and keeps a name already registered (a plugin wins)", async () => {
    const registry = new GraderRegistry();
    const mine = async () => r(true, 0.42, "plugin");
    registry.register("provability.claimCoverage", mine);
    registerProvabilityGraders(registry);
    registerProvabilityGraders(registry);
    expect(registry.lookup("provability.claimCoverage")).toBe(mine);
    expect(registry.list()).toHaveLength(6);
  });

  test("a registered grader grades a real bundle", async () => {
    const registry = new GraderRegistry();
    registerProvabilityGraders(registry);
    const bundle = await bundleFor(
      `The refund window is 14 days [1].\n\n[1]: ${POLICY}`,
      "grounded",
      [POLICY_FETCH],
    );
    const result = await registry.lookup("provability.claimCoverage")(sample(), runWith(bundle));
    expect(result).toMatchObject({ passed: true, score: 1 });
  });
});
