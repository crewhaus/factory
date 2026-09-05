import { describe, expect, test } from "bun:test";
import { joinQualityToArms } from "./join";

const decision = {
  sessionId: "sess_a000000000000000",
  turnNumber: 1,
  routeKey: "hard",
  model: "anthropic/claude-haiku-4-5",
  latencyMs: 800,
  costUsd: 0.002,
  success: true,
};

describe("joinQualityToArms", () => {
  test("joins per (sessionId, turnNumber) and emits q:-prefixed shadow rows", () => {
    const rows = joinQualityToArms(
      [
        decision,
        { ...decision, turnNumber: 2, routeKey: "easy", success: false },
        { ...decision, sessionId: "sess_b000000000000000", turnNumber: 1 }, // no quality → dropped
      ],
      [
        { sessionId: "sess_a000000000000000", turnNumber: 1, score: 0.9 },
        { sessionId: "sess_a000000000000000", turnNumber: 2, score: 0.1 },
      ],
    );
    expect(rows).toEqual([
      {
        routeKey: "q:hard",
        model: "anthropic/claude-haiku-4-5",
        obs: { success: true, latencyMs: 800, costUsd: 0.002, quality: 0.9 },
      },
      {
        routeKey: "q:easy",
        model: "anthropic/claude-haiku-4-5",
        obs: { success: false, latencyMs: 800, costUsd: 0.002, quality: 0.1 },
      },
    ]);
    expect(rows.every((r) => r.routeKey.startsWith("q:"))).toBe(true);
  });

  test("multiple scores for one turn (rating AND judgment) average", () => {
    const rows = joinQualityToArms(
      [decision],
      [
        { sessionId: decision.sessionId, turnNumber: 1, score: 1.0 },
        { sessionId: decision.sessionId, turnNumber: 1, score: 0.5 },
      ],
    );
    expect(rows[0]?.obs.quality).toBeCloseTo(0.75, 9);
  });

  test("scores clamp into [0, 1]", () => {
    const rows = joinQualityToArms(
      [decision, { ...decision, turnNumber: 2 }],
      [
        { sessionId: decision.sessionId, turnNumber: 1, score: 7 },
        { sessionId: decision.sessionId, turnNumber: 2, score: -3 },
      ],
    );
    expect(rows[0]?.obs.quality).toBe(1);
    expect(rows[1]?.obs.quality).toBe(0);
  });

  test("costUsd is omitted when the decision carried none; latency defaults to 0", () => {
    const rows = joinQualityToArms(
      [{ ...decision, costUsd: undefined, latencyMs: undefined }],
      [{ sessionId: decision.sessionId, turnNumber: 1, score: 0.5 }],
    );
    expect(rows[0]?.obs).toEqual({ success: true, latencyMs: 0, quality: 0.5 });
    expect("costUsd" in (rows[0]?.obs ?? {})).toBe(false);
  });

  test("no matches → empty result", () => {
    expect(
      joinQualityToArms([decision], [{ sessionId: "sess_other", turnNumber: 9, score: 1 }]),
    ).toEqual([]);
  });
});

describe("QUALITY_LANE_PREFIX (0.6.0 §7.8)", () => {
  test("the offline lane is exported for the online shadow twin to stay disjoint from", async () => {
    const { QUALITY_LANE_PREFIX } = await import("./index.js");
    expect(QUALITY_LANE_PREFIX).toBe("q:");
    const rows = joinQualityToArms(
      [{ sessionId: "s", turnNumber: 1, routeKey: "hard", model: "m", success: true }],
      [{ sessionId: "s", turnNumber: 1, score: 1 }],
    );
    expect(rows[0]?.routeKey.startsWith(QUALITY_LANE_PREFIX)).toBe(true);
  });
});
