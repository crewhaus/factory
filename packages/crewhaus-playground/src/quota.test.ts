import { describe, expect, test } from "bun:test";

import { DEFAULT_QUOTA, PlaygroundQuotaError, type QuotaState, enforceQuota } from "./quota";

describe("enforceQuota — anonymous tier (T1)", () => {
  test("first call accepted, remaining = max-1", () => {
    const r = enforceQuota({ state: { runs: [] }, tier: "anonymous", now: 1000 });
    expect(r.accepted).toBe(true);
    if (r.accepted) {
      expect(r.remaining).toBe(DEFAULT_QUOTA.anonymous.maxRuns - 1);
      expect(r.state.runs.length).toBe(1);
    }
  });

  test("at the cap → rejected with retryAfterSeconds", () => {
    const now = 10_000_000;
    const state: QuotaState = {
      runs: Array.from({ length: DEFAULT_QUOTA.anonymous.maxRuns }, (_, i) => now - 1000 * i),
    };
    const r = enforceQuota({ state, tier: "anonymous", now });
    expect(r.accepted).toBe(false);
    if (!r.accepted) {
      expect(r.retryAfterSeconds).toBeGreaterThan(0);
      expect(r.reason).toContain("anonymous");
    }
  });

  test("expired runs do not count toward the cap", () => {
    const now = 10_000_000;
    const aLongTimeAgo = now - DEFAULT_QUOTA.anonymous.windowSeconds * 1000 - 1;
    const state: QuotaState = {
      runs: Array.from({ length: DEFAULT_QUOTA.anonymous.maxRuns }, () => aLongTimeAgo),
    };
    const r = enforceQuota({ state, tier: "anonymous", now });
    expect(r.accepted).toBe(true);
  });

  test("signed-in tier has higher cap than anonymous", () => {
    expect(DEFAULT_QUOTA["signed-in"].maxRuns).toBeGreaterThan(DEFAULT_QUOTA.anonymous.maxRuns);
  });

  test("team tier has higher cap than signed-in", () => {
    expect(DEFAULT_QUOTA.team.maxRuns).toBeGreaterThan(DEFAULT_QUOTA["signed-in"].maxRuns);
  });

  test("unknown tier throws PlaygroundQuotaError", () => {
    expect(() => enforceQuota({ state: { runs: [] }, tier: "wrong" as never, now: 0 })).toThrow(
      PlaygroundQuotaError,
    );
  });

  test("custom config overrides the tier default", () => {
    const r = enforceQuota({
      state: { runs: [1, 2] },
      tier: "anonymous",
      now: 1000,
      config: { maxRuns: 2, windowSeconds: 3600 },
    });
    expect(r.accepted).toBe(false);
  });
});
