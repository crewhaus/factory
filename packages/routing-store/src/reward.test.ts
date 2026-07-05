import { describe, expect, test } from "bun:test";
import { computeReward } from "./reward";

describe("computeReward", () => {
  test("a perfect call (success, free, instant) scores 1", () => {
    expect(computeReward({ success: true, latencyMs: 0, costUsd: 0 })).toBe(1);
  });

  test("reward is always within [0, 1]", () => {
    for (const success of [true, false]) {
      for (const latencyMs of [0, 500, 5000, 60_000]) {
        for (const costUsd of [0, 0.001, 0.01, 1]) {
          const r = computeReward({ success, latencyMs, costUsd });
          expect(r).toBeGreaterThanOrEqual(0);
          expect(r).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  test("a failed turn scores 0 no matter how fast or cheap it failed", () => {
    // Even an instant, free failure earns nothing — no rewarding fast failures.
    expect(computeReward({ success: false, latencyMs: 0, costUsd: 0 })).toBe(0);
    expect(
      computeReward(
        { success: false, latencyMs: 0, costUsd: 0 },
        { objective: { quality: 0, cost: 1, latency: 0 } },
      ),
    ).toBe(0);
  });

  test("cheaper call scores higher when only cost matters", () => {
    const cfg = { objective: { quality: 0, cost: 1, latency: 0 } };
    const cheap = computeReward({ success: true, latencyMs: 100, costUsd: 0.001 }, cfg);
    const pricey = computeReward({ success: true, latencyMs: 100, costUsd: 0.1 }, cfg);
    expect(cheap).toBeGreaterThan(pricey);
  });

  test("faster call scores higher when only latency matters", () => {
    const cfg = { objective: { quality: 0, cost: 0, latency: 1 } };
    const fast = computeReward({ success: true, latencyMs: 200 }, cfg);
    const slow = computeReward({ success: true, latencyMs: 20_000 }, cfg);
    expect(fast).toBeGreaterThan(slow);
  });

  test("cost term is dropped and reweighted when costUsd is absent", () => {
    // With default objective (q .7, c .2, l .1), an absent cost renormalises
    // over quality+latency (weights .7 and .1). A slow successful call:
    const withoutCost = computeReward({ success: true, latencyMs: 5000 });
    // quality=1 (w .7), latency=0.5 (w .1) → (0.7 + 0.05) / 0.8 = 0.9375
    expect(withoutCost).toBeCloseTo(0.9375, 6);
  });

  test("costRef/latencyRef put the sub-score at exactly 0.5 at the reference", () => {
    const r = computeReward(
      { success: true, latencyMs: 5000, costUsd: 0.01 },
      { objective: { quality: 0, cost: 1, latency: 0 }, costRefUsd: 0.01 },
    );
    expect(r).toBeCloseTo(0.5, 6);
    const r2 = computeReward(
      { success: true, latencyMs: 5000, costUsd: 0.01 },
      { objective: { quality: 0, cost: 0, latency: 1 }, latencyRefMs: 5000 },
    );
    expect(r2).toBeCloseTo(0.5, 6);
  });

  test("an all-zero objective falls back to the quality bit (never NaN)", () => {
    expect(
      computeReward(
        { success: true, latencyMs: 100 },
        { objective: { quality: 0, cost: 0, latency: 0 } },
      ),
    ).toBe(1);
    expect(
      computeReward(
        { success: false, latencyMs: 100 },
        { objective: { quality: 0, cost: 0, latency: 0 } },
      ),
    ).toBe(0);
  });

  test("negative latency/cost are clamped, not rewarded past 1", () => {
    const r = computeReward({ success: true, latencyMs: -5, costUsd: -1 });
    expect(r).toBe(1);
  });
});
