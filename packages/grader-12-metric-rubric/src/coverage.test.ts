/**
 * Track C (Section 55) — coverage cross-check against the TDS article.
 *
 * Programmatic guard that all 12 metrics named in the source article are
 * registered and have plausible thresholds. The 12-metric framework
 * (Towards Data Science, 100+ deployments, 2026-05) divides metrics
 * into 4 categories: retrieval (4), generation (3), agent (3),
 * production (2). This test fails if any metric goes missing in a
 * refactor — the source article is the contract.
 *
 * Cited article: "Building an Evaluation Harness for Production AI Agents:
 * A 12-Metric Framework From 100+ Deployments" (Towards Data Science, 2026-05).
 */
import { describe, expect, test } from "bun:test";
import { TWELVE_METRIC_SPECS, TWELVE_METRIC_THRESHOLDS } from "./index";

const EXPECTED_METRICS = {
  retrieval: [
    "twelve.contextRelevance",
    "twelve.contextRecall",
    "twelve.contextPrecision",
    "twelve.retrievalLatencyP95Ms",
  ],
  generation: ["twelve.answerFaithfulness", "twelve.answerRelevance", "twelve.hallucinationRate"],
  agent: [
    "twelve.toolSelectionAccuracy",
    "twelve.toolExecutionSuccess",
    "twelve.multiStepCoherence",
  ],
  production: ["twelve.costPerQueryUsd", "twelve.p99LatencyMs"],
};

const EXPECTED_LOWER_IS_BETTER = new Set([
  "twelve.retrievalLatencyP95Ms",
  "twelve.hallucinationRate",
  "twelve.costPerQueryUsd",
  "twelve.p99LatencyMs",
]);

describe("Track C — 12-metric framework coverage", () => {
  test("exactly 12 metrics registered (no drift)", () => {
    expect(TWELVE_METRIC_SPECS.length).toBe(12);
  });

  test("4 retrieval / 3 generation / 3 agent / 2 production metrics", () => {
    const byCat: Record<string, number> = {};
    for (const spec of TWELVE_METRIC_SPECS) {
      byCat[spec.category] = (byCat[spec.category] ?? 0) + 1;
    }
    expect(byCat["retrieval"]).toBe(4);
    expect(byCat["generation"]).toBe(3);
    expect(byCat["agent"]).toBe(3);
    expect(byCat["production"]).toBe(2);
  });

  for (const [category, names] of Object.entries(EXPECTED_METRICS)) {
    for (const name of names) {
      test(`${category}: ${name} is registered`, () => {
        const found = TWELVE_METRIC_SPECS.find((m) => m.name === name);
        expect(found).toBeDefined();
        expect(found?.category).toBe(category as never);
      });
    }
  }

  test("lower-is-better metrics have higherIsBetter: false", () => {
    for (const spec of TWELVE_METRIC_SPECS) {
      if (EXPECTED_LOWER_IS_BETTER.has(spec.name)) {
        expect(spec.higherIsBetter).toBe(false);
      } else {
        expect(spec.higherIsBetter).toBe(true);
      }
    }
  });

  test("TWELVE_METRIC_THRESHOLDS matches the article's published values", () => {
    // Retrieval
    expect(TWELVE_METRIC_THRESHOLDS.contextRelevance).toBe(0.85);
    expect(TWELVE_METRIC_THRESHOLDS.contextRecall).toBe(0.9);
    expect(TWELVE_METRIC_THRESHOLDS.contextPrecision).toBe(0.8);
    expect(TWELVE_METRIC_THRESHOLDS.retrievalLatencyP95Ms).toBe(200);
    // Generation
    expect(TWELVE_METRIC_THRESHOLDS.answerFaithfulness).toBe(0.95);
    expect(TWELVE_METRIC_THRESHOLDS.answerRelevance).toBe(0.9);
    expect(TWELVE_METRIC_THRESHOLDS.hallucinationRate).toBe(0.02);
    // Agent
    expect(TWELVE_METRIC_THRESHOLDS.toolSelectionAccuracy).toBe(0.92);
    expect(TWELVE_METRIC_THRESHOLDS.toolExecutionSuccess).toBe(0.98);
    expect(TWELVE_METRIC_THRESHOLDS.multiStepCoherence).toBe(0.85);
    // Production
    expect(TWELVE_METRIC_THRESHOLDS.costPerQueryUsd).toBe(0.05);
    expect(TWELVE_METRIC_THRESHOLDS.p99LatencyMs).toBe(3000);
  });
});
