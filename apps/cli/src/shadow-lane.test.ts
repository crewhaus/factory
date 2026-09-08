/**
 * 0.6.0 §7.8 / §9.1 — the shadow lane holds BOTH sides of every audition.
 *
 * Every fixture here records the candidate AND the incumbent it was graded
 * against, which is what the runtime actually writes and what the old readers
 * never saw: each of them treated a lane arm as "the candidate", so the
 * incumbent was proposed as the challenger whenever it won the pairwise
 * judging, and a whole-lane `n` sum counted every graded turn twice.
 */
import { describe, expect, test } from "bun:test";
import type { ArmStats } from "@crewhaus/routing-store";
import {
  declaredShadowCandidate,
  liveArmsOf,
  shadowCandidateN,
  splitShadowLane,
} from "./shadow-lane";

const arm = (routeKey: string, model: string, n: number, meanReward = 0.5): ArmStats => ({
  routeKey,
  model,
  n,
  meanReward,
  varReward: 0.01,
  meanLatencyMs: 10,
  meanCostUsd: 0,
  costCount: 0,
  meanQuality: meanReward,
  varQuality: 0.01,
  qualityCount: n,
  ungraded: 0,
});

/** One audition, 20 graded turns: 40 lane observations, 20 per side. */
const BOTH_SIDES: ArmStats[] = [
  arm("shadow:hard", "challenger", 20, 0.6),
  arm("shadow:hard", "incumbent", 20, 0.4),
  arm("hard", "incumbent", 200, 0.55),
];

describe("splitShadowLane", () => {
  test("the recorded `at` stamp decides which side is the candidate", () => {
    const split = splitShadowLane(BOTH_SIDES, {
      sides: {
        shadow: new Set(["challenger"]),
        primary: new Set(["incumbent"]),
        unattributed: new Set(),
      },
    });
    expect(split.candidateArm).toBe("challenger");
    expect(split.counterpartArms.map((a) => a.model)).toEqual(["incumbent"]);
  });

  test("the stamp wins even when the INCUMBENT has more lane evidence", () => {
    const lopsided = [
      arm("shadow:hard", "challenger", 30, 0.9),
      arm("shadow:easy", "incumbent", 90, 0.4),
      arm("shadow:hard", "incumbent", 30, 0.4),
    ];
    const split = splitShadowLane(lopsided, {
      sides: {
        shadow: new Set(["challenger"]),
        primary: new Set(["incumbent"]),
        unattributed: new Set(),
      },
    });
    expect(split.candidateArm).toBe("challenger");
  });

  test("without a stamp the spec's declared candidate decides", () => {
    const split = splitShadowLane(BOTH_SIDES, { declaredCandidate: "challenger" });
    expect(split.candidateArm).toBe("challenger");
    expect(shadowCandidateN(split)).toBe(20);
  });

  test("a single-armed lane needs no discriminant", () => {
    const split = splitShadowLane([
      arm("shadow:hard", "challenger", 12),
      ...liveArmsOf(BOTH_SIDES),
    ]);
    expect(split.candidateArm).toBe("challenger");
  });

  test("REFUSES to guess a two-sided lane it cannot attribute", () => {
    const split = splitShadowLane(BOTH_SIDES);
    expect(split.candidateArm).toBeUndefined();
    expect(split.candidateArms).toHaveLength(0);
    expect(split.unattributedReason).toContain("BOTH sides");
  });

  test("`shadowCandidateN` counts TURNS, not the two observations each turn writes", () => {
    const split = splitShadowLane(BOTH_SIDES, { declaredCandidate: "challenger" });
    // The whole lane sums to 40 — the double count that tripped a 30-turn
    // power floor at 15 real turns.
    expect(split.laneArms.reduce((n, a) => n + a.n, 0)).toBe(40);
    expect(shadowCandidateN(split)).toBe(20);
  });

  test("liveArmsOf keeps the observe-only lanes out of the live bands", () => {
    const arms = [...BOTH_SIDES, arm("q:hard", "incumbent", 5)];
    expect(liveArmsOf(arms).map((a) => a.routeKey)).toEqual(["hard"]);
  });
});

describe("declaredShadowCandidate", () => {
  test("reads a raw spec pool, dropping the `$` of a profile reference", () => {
    expect(declaredShadowCandidate({ strategy: { shadow: { candidate: "$strong" } } })).toBe(
      "strong",
    );
    expect(declaredShadowCandidate({ strategy: { shadow: { candidate: "claude-opus-5" } } })).toBe(
      "claude-opus-5",
    );
  });

  test("a lowered pool's profile name wins — that is the arm id (§7.9)", () => {
    expect(
      declaredShadowCandidate({
        strategy: { shadow: { candidate: "claude-opus-5", candidateProfile: "strong" } },
      }),
    ).toBe("strong");
  });

  test("no shadow block, no candidate", () => {
    expect(declaredShadowCandidate(undefined)).toBeUndefined();
    expect(declaredShadowCandidate({ strategy: {} })).toBeUndefined();
  });
});
