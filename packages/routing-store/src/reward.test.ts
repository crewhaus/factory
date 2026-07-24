import { describe, expect, test } from "bun:test";
import { computeReward } from "./reward";
import type { RewardConfig, RouteObservation } from "./reward";

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

describe("computeReward — joined quality (RouteObservation.quality)", () => {
  test("omitted quality is byte-identical to the pre-quality reward on existing fixtures", () => {
    // Hand-computed values from the v1 quality=success proxy; adding the field
    // must not move any of them when quality is omitted.
    const table: Array<{ obs: RouteObservation; cfg?: RewardConfig; expected: number }> = [
      { obs: { success: true, latencyMs: 0, costUsd: 0 }, expected: 1 },
      { obs: { success: false, latencyMs: 0, costUsd: 0 }, expected: 0 },
      // q 1 (w .7) + cost 0.5 (w .2) + latency 0.5 (w .1) → 0.85
      { obs: { success: true, latencyMs: 5000, costUsd: 0.01 }, expected: 0.85 },
      // cost absent → renormalise over quality+latency: (0.7 + 0.05) / 0.8
      { obs: { success: true, latencyMs: 5000 }, expected: 0.9375 },
      {
        obs: { success: true, latencyMs: 5000, costUsd: 0.01 },
        cfg: { objective: { quality: 0, cost: 1, latency: 0 } },
        expected: 0.5,
      },
    ];
    for (const { obs, cfg, expected } of table) {
      const reward = computeReward(obs, cfg);
      expect(reward).toBeCloseTo(expected, 12);
      // Explicit quality: undefined and the success-proxy quality: 1 are both
      // exactly the omitted-field reward.
      expect(computeReward({ ...obs, quality: undefined }, cfg)).toBe(reward);
      if (obs.success) expect(computeReward({ ...obs, quality: 1 }, cfg)).toBe(reward);
    }
  });

  test("quality=0.4 on success scales the quality term (hand-computed)", () => {
    // q 0.4 (w .7) + cost 0.5 (w .2) + latency 0.5 (w .1) → 0.28 + 0.1 + 0.05
    const r = computeReward({ success: true, latencyMs: 5000, costUsd: 0.01, quality: 0.4 });
    expect(r).toBeCloseTo(0.43, 6);
    // Quality-only objective: the reward IS the joined quality.
    expect(
      computeReward(
        { success: true, latencyMs: 0, quality: 0.4 },
        { objective: { quality: 1, cost: 0, latency: 0 } },
      ),
    ).toBeCloseTo(0.4, 12);
  });

  test("out-of-range quality is clamped to [0, 1]", () => {
    const qualityOnly: RewardConfig = { objective: { quality: 1, cost: 0, latency: 0 } };
    expect(computeReward({ success: true, latencyMs: 0, quality: 2.5 }, qualityOnly)).toBe(1);
    expect(computeReward({ success: true, latencyMs: 0, quality: -0.5 }, qualityOnly)).toBe(0);
    // Clamping keeps the default-objective reward within [0, 1] as well.
    expect(computeReward({ success: true, latencyMs: 0, costUsd: 0, quality: 99 })).toBe(1);
  });

  test("a failed turn still scores 0 even with a perfect joined quality", () => {
    expect(computeReward({ success: false, latencyMs: 0, costUsd: 0, quality: 1 })).toBe(0);
    expect(computeReward({ success: false, latencyMs: 100, quality: 0.9 })).toBe(0);
  });
});
