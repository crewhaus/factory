/**
 * 0.6.0 PR 10 — scoped route keys with unscoped backoff (§7.9), per-candidate
 * breakers as an eligibility filter (§4.4), the quality floor (§7.10, the
 * acceptance scenario's item 7 numbers), eval-seeded priors skipping warm-up
 * (§7.11 N2), the verbatim `floor-blocked` reason and the key grammar.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderAdapter, StreamEvent } from "@crewhaus/adapter-anthropic";
import type { CircuitState } from "@crewhaus/circuit-breaker";
import {
  loadPriors,
  normalQuantile,
  seededScoreLookup,
  wilsonLowerBound,
} from "@crewhaus/model-plan";
import {
  type ArmScore,
  FLOOR_BLOCKED_ROUTE_REASON,
  type PoolCandidate,
  type RouteSignals,
  type ScoreLookup,
  createPolicyRouter,
  scopedRouteKey,
  splitRouteKey,
  unscopedRouteKey,
} from "./policy-router";

const EASY: RouteSignals = {
  contextTokens: 100,
  toolsInPlay: false,
  turnIndex: 3,
  priorTurnToolUseCount: 0,
};
const HARD: RouteSignals = { ...EASY, toolsInPlay: true };

function stubAdapter(id: string): ProviderAdapter {
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    stream(): AsyncIterable<StreamEvent> {
      throw new Error(`stub ${id} must not stream`);
    },
  };
}

function candidate(
  modelString: string,
  tags: string[],
  extra: Partial<PoolCandidate> = {},
): PoolCandidate {
  return { adapter: stubAdapter(modelString), modelId: modelString, modelString, tags, ...extra };
}

/** A profiled roster: arm ids are the profile names (§7.9). */
const FAST = candidate("claude-haiku-4-5", ["cheap"], { armId: "fast" });
const STRONG = candidate("claude-opus-4-8", ["strong"], { armId: "strong" });
const ROSTER = [FAST, STRONG];

/** `(routeKey, armId) → score` from a flat table. */
function table(rows: Record<string, ArmScore>): ScoreLookup & { reads: string[] } {
  const reads: string[] = [];
  const fn = ((routeKey: string, armId: string) => {
    reads.push(`${routeKey}|${armId}`);
    return rows[`${routeKey}|${armId}`];
  }) as ScoreLookup & { reads: string[] };
  fn.reads = reads;
  return fn;
}

describe("route key grammar (§7.9)", () => {
  test("scopedRouteKey / splitRouteKey / unscopedRouteKey round-trip; absent scope is the bare band", () => {
    expect(scopedRouteKey("hard")).toBe("hard");
    expect(scopedRouteKey("hard", "")).toBe("hard");
    expect(scopedRouteKey("hard", "support")).toBe("support/hard");
    expect(scopedRouteKey("hard:code", "support")).toBe("support/hard:code");
    expect(splitRouteKey("support/hard:code")).toEqual({ scope: "support", band: "hard:code" });
    expect(splitRouteKey("hard")).toEqual({ band: "hard" });
    expect(unscopedRouteKey("support/hard")).toBe("hard");
    expect(unscopedRouteKey("easy")).toBe("easy");
  });

  test("static / heuristic / forced decisions carry the scoped key; the band is still the difficulty", () => {
    const heur = createPolicyRouter({ candidates: ROSTER, policy: "heuristic", scope: "triage" });
    expect(heur.route(HARD).routeKey).toBe("triage/hard");
    expect(heur.route(EASY).routeKey).toBe("triage/easy");
    expect(heur.route(EASY, "", 0, { source: "rule", forcedArm: "strong" })).toMatchObject({
      candidate: STRONG,
      routeKey: "triage/easy",
      policy: "rule",
    });
    const stat = createPolicyRouter({ candidates: ROSTER, policy: "static", scope: "triage" });
    expect(stat.route(HARD, "", 0, { source: "none", routeKeySuffix: "x" }).routeKey).toBe(
      "triage/hard:x",
    );
    // Unscoped → byte-for-byte the 0.5.x key.
    expect(
      createPolicyRouter({ candidates: ROSTER, policy: "heuristic" }).route(HARD).routeKey,
    ).toBe("hard");
  });
});

describe("learned — scoped arms back off to the unscoped band while under-sampled (§7.9)", () => {
  test("a cold scoped arm reads the warmed unscoped arm, records under the scoped key, and notes the backoff", () => {
    // The unscoped `hard` arms have cleared warm-up (25) from pre-scope history;
    // the scoped `triage/hard` arms are empty.
    const score = table({
      "hard|fast": { n: 40, meanReward: 0.9 },
      "hard|strong": { n: 40, meanReward: 0.6 },
    });
    const r = createPolicyRouter({
      candidates: ROSTER,
      policy: "learned",
      score,
      scope: "triage",
    });
    const d = r.route(HARD, "seed", 7);
    expect(d.candidate).toBe(FAST);
    expect(d.explored).toBe(false);
    expect(d.routeKey).toBe("triage/hard");
    expect(d.backedOffTo).toBe("hard");
    expect(d.reason).toContain("best arm meanReward=0.900");
    // Both keys were consulted, scoped first.
    expect(score.reads).toEqual([
      "triage/hard|fast",
      "hard|fast",
      "triage/hard|strong",
      "hard|strong",
    ]);
  });

  test("once the scoped arm clears warm-up its own statistics win (no backoff)", () => {
    const score = table({
      "triage/hard|fast": { n: 30, meanReward: 0.2 },
      "triage/hard|strong": { n: 30, meanReward: 0.7 },
      "hard|fast": { n: 100, meanReward: 0.95 },
      "hard|strong": { n: 100, meanReward: 0.1 },
    });
    const r = createPolicyRouter({ candidates: ROSTER, policy: "learned", score, scope: "triage" });
    const d = r.route(HARD, "seed", 1);
    expect(d.candidate).toBe(STRONG);
    expect(d.backedOffTo).toBeUndefined();
    expect(score.reads).toEqual(["triage/hard|fast", "triage/hard|strong"]);
  });

  test("with neither arm warm the scoped arm explores least-sampled-first (cold start, no phantom backoff)", () => {
    const score = table({
      "hard|fast": { n: 3, meanReward: 0.9 }, // unscoped but ALSO under-sampled → no backoff
    });
    const r = createPolicyRouter({ candidates: ROSTER, policy: "learned", score, scope: "triage" });
    const d = r.route(HARD, "seed", 1);
    expect(d.explored).toBe(true);
    expect(d.routeKey).toBe("triage/hard");
    expect(d.backedOffTo).toBeUndefined();
  });

  test("without a scope the backoff never fires and only the band is read (0.5.x behaviour)", () => {
    const score = table({
      "hard|fast": { n: 40, meanReward: 0.9 },
      "hard|strong": { n: 40, meanReward: 0.6 },
    });
    const r = createPolicyRouter({ candidates: ROSTER, policy: "learned", score });
    const d = r.route(HARD, "seed", 7);
    expect(d).toMatchObject({ candidate: FAST, routeKey: "hard", explored: false });
    expect("backedOffTo" in d).toBe(false);
    expect(score.reads).toEqual(["hard|fast", "hard|strong"]);
  });

  test("a hint suffix rides inside the scope: <scope>/<band>:<suffix> backs off to <band>:<suffix>", () => {
    const score = table({
      "hard:code|fast": { n: 40, meanReward: 0.1 },
      "hard:code|strong": { n: 40, meanReward: 0.9 },
    });
    const r = createPolicyRouter({ candidates: ROSTER, policy: "learned", score, scope: "triage" });
    const d = r.route(HARD, "seed", 7, { source: "none", routeKeySuffix: "code" });
    expect(d.routeKey).toBe("triage/hard:code");
    expect(d.candidate).toBe(STRONG);
    expect(d.backedOffTo).toBe("hard:code");
  });
});

describe("per-candidate breakers are an eligibility filter (§4.4)", () => {
  function withBreaker(c: PoolCandidate, state: () => CircuitState): PoolCandidate {
    return { ...c, breaker: { state } };
  }

  test("an open breaker removes the candidate for the turn; half_open and closed stay", () => {
    let strongState: CircuitState = "open";
    const roster = [FAST, withBreaker(STRONG, () => strongState)];
    const r = createPolicyRouter({ candidates: roster, policy: "heuristic" });
    // A hard turn would pick strong — but its breaker is open.
    expect(r.route(HARD).candidate).toBe(FAST);
    strongState = "half_open";
    expect(r.route(HARD).candidate).toBe(roster[1]);
    strongState = "closed";
    expect(r.route(HARD).candidate).toBe(roster[1]);
  });

  test("an all-open roster is not a veto: the full roster stays in play", () => {
    const roster = [withBreaker(FAST, () => "open"), withBreaker(STRONG, () => "open")];
    const r = createPolicyRouter({ candidates: roster, policy: "heuristic" });
    expect(r.route(HARD).candidate).toBe(roster[1]);
    expect(r.route(EASY).candidate).toBe(roster[0]);
  });

  test("the breaker filter composes with the hint's eligible set and with learned scoring", () => {
    const mid = candidate("claude-sonnet-5", ["mid"], { armId: "mid" });
    const roster = [FAST, withBreaker(mid, () => "open"), STRONG];
    const score = table({
      "hard|fast": { n: 30, meanReward: 0.2 },
      "hard|mid": { n: 30, meanReward: 0.99 },
      "hard|strong": { n: 30, meanReward: 0.7 },
    });
    const r = createPolicyRouter({ candidates: roster, policy: "learned", score });
    // `mid` has the best reward but its breaker is open → strong wins.
    const d = r.route(HARD, "s", 0, { source: "eligibility", eligible: ["fast", "mid", "strong"] });
    expect(d.candidate).toBe(STRONG);
    expect(score.reads).not.toContain("hard|mid");
  });

  test("lastServed is carried on the candidate untouched (the loop reads it for attribution)", () => {
    const served = {
      modelString: "openai/gpt-4o-mini",
      modelId: "gpt-4o-mini",
      providerId: "openai" as const,
    };
    const c = candidate("claude-haiku-4-5", ["cheap"], { lastServed: () => served });
    const r = createPolicyRouter({ candidates: [c], policy: "static" });
    expect(r.route(EASY).candidate.lastServed?.()).toBe(served);
  });
});

describe("the floor (§7.10) — acceptance item 7", () => {
  // Item 7 of the motivating scenario: the strong arm's live judged mean sits
  // at 0.86 and `$fast`'s Wilson LCB at ≈0.71 after 30 samples → floor-blocked.
  const Z90 = normalQuantile(1 - (1 - 0.9) / 2);
  const FAST_Q = { n: 30, mean: 0.85 };
  const fastLcb = wilsonLowerBound(FAST_Q.mean, FAST_Q.n, Z90);

  function rows(fast: ArmScore, strong: ArmScore): Record<string, ArmScore> {
    return { "hard|fast": fast, "hard|strong": strong };
  }
  const STRONG_SCORE: ArmScore = { n: 30, meanReward: 0.5, meanQuality: 0.86, qualityCount: 30 };

  test("the stated numbers: fast's LCB (≈0.71) is under the floor (0.86 − 0.02) → strong serves with the verbatim reason", () => {
    expect(fastLcb).toBeGreaterThan(0.7);
    expect(fastLcb).toBeLessThan(0.72);
    // `fast` has the better REWARD (cheaper) — without the floor it would be exploited.
    const fast: ArmScore = {
      n: FAST_Q.n,
      meanReward: 0.9,
      meanQuality: FAST_Q.mean,
      qualityCount: FAST_Q.n,
    };
    const unfloored = createPolicyRouter({
      candidates: ROSTER,
      policy: "learned",
      score: table(rows(fast, STRONG_SCORE)),
    });
    expect(unfloored.route(HARD, "s", 1).candidate).toBe(FAST);

    const r = createPolicyRouter({
      candidates: ROSTER,
      policy: "learned",
      score: table(rows(fast, STRONG_SCORE)),
      floor: { arm: "strong", confidence: 0.9, tolerance: 0.02 },
    });
    const d = r.route(HARD, "s", 1);
    expect(d.candidate).toBe(STRONG);
    expect(d.reason).toBe(FLOOR_BLOCKED_ROUTE_REASON);
    expect(d.reason).toBe("floor-blocked");
    expect(d.explored).toBe(false);
    expect(d.policy).toBe("learned");
    expect(d.floor).toEqual({ arm: "strong", status: "blocked", blocked: ["fast"] });
  });

  test("after the stub improves (mean 0.95 over 60 samples) fast becomes exploitable again", () => {
    const fast: ArmScore = { n: 60, meanReward: 0.9, meanQuality: 0.95, qualityCount: 60 };
    const r = createPolicyRouter({
      candidates: ROSTER,
      policy: "learned",
      score: table(rows(fast, STRONG_SCORE)),
      floor: { arm: "strong", confidence: 0.9, tolerance: 0.02 },
    });
    const d = r.route(HARD, "s", 1);
    expect(d.candidate).toBe(FAST);
    expect(d.reason).toContain("best arm");
    expect(d.floor).toEqual({ arm: "strong", status: "ok" });
  });

  test("the floor arm defaults to the strong-tagged candidate; a floor arm with no judged quality suspends the check", () => {
    const fast: ArmScore = { n: 30, meanReward: 0.9, meanQuality: 0.3, qualityCount: 30 };
    const strongNoQuality: ArmScore = { n: 30, meanReward: 0.5 };
    const r = createPolicyRouter({
      candidates: ROSTER,
      policy: "learned",
      score: table(rows(fast, strongNoQuality)),
      floor: {},
    });
    const d = r.route(HARD, "s", 1);
    expect(d.candidate).toBe(FAST);
    expect(d.floor).toEqual({ arm: "strong", status: "unavailable" });
    expect(d.reason).not.toBe(FLOOR_BLOCKED_ROUTE_REASON);
  });

  test("a floor arm outside the eligible set suspends the check for the turn", () => {
    const fast: ArmScore = { n: 30, meanReward: 0.9, meanQuality: 0.3, qualityCount: 30 };
    const r = createPolicyRouter({
      candidates: ROSTER,
      policy: "learned",
      score: table(rows(fast, STRONG_SCORE)),
      floor: { arm: "strong" },
    });
    const d = r.route(HARD, "s", 1, { source: "eligibility", eligible: ["fast"] });
    expect(d.candidate).toBe(FAST);
    expect(d.floor).toEqual({ arm: "strong", status: "unavailable" });
  });

  test("warm-up is unaffected: an under-sampled arm is still explored under a floor", () => {
    const fast: ArmScore = { n: 2, meanReward: 0.9, meanQuality: 0.1, qualityCount: 2 };
    const r = createPolicyRouter({
      candidates: ROSTER,
      policy: "learned",
      score: table(rows(fast, STRONG_SCORE)),
      floor: { arm: "strong" },
    });
    const d = r.route(HARD, "s", 1);
    expect(d.candidate).toBe(FAST);
    expect(d.explored).toBe(true);
    expect("floor" in d).toBe(false);
  });

  test("ε-greedy exploration draws are unaffected by the floor (capped at explorationRate)", () => {
    const fast: ArmScore = { n: 30, meanReward: 0.9, meanQuality: 0.3, qualityCount: 30 };
    const r = createPolicyRouter({
      candidates: ROSTER,
      policy: "learned",
      score: table(rows(fast, STRONG_SCORE)),
      learning: { explorationRate: 0.3 },
      floor: { arm: "strong" },
    });
    let explored = 0;
    let blocked = 0;
    const N = 400;
    for (let seq = 0; seq < N; seq++) {
      const d = r.route(HARD, "run", seq);
      if (d.explored) {
        explored += 1;
        expect(d.candidate).toBe(FAST); // the blocked arm is what exploration tries
      } else {
        blocked += 1;
        expect(d.reason).toBe(FLOOR_BLOCKED_ROUTE_REASON);
        expect(d.candidate).toBe(STRONG);
      }
    }
    expect(explored).toBeGreaterThan(N * 0.15);
    expect(explored).toBeLessThan(N * 0.45);
    expect(blocked + explored).toBe(N);
  });

  test("thompson draws only over the exploitable arms under a floor", () => {
    const fast: ArmScore = {
      n: 30,
      meanReward: 0.9,
      varReward: 0.5,
      meanQuality: 0.3,
      qualityCount: 30,
    };
    const r = createPolicyRouter({
      candidates: ROSTER,
      policy: "learned",
      score: table(rows(fast, { ...STRONG_SCORE, varReward: 0.5 })),
      learning: { bandit: "thompson" },
      floor: { arm: "strong" },
    });
    for (let seq = 0; seq < 50; seq++) {
      const d = r.route(HARD, "run", seq);
      expect(d.candidate).toBe(STRONG);
      expect(d.reason).toBe(FLOOR_BLOCKED_ROUTE_REASON);
    }
  });
});

describe("eval-seeded priors skip warm-up (§7.11 N2)", () => {
  test("a seeded arm is exploited on its prior; an unseeded sibling is still explored first", () => {
    // `strong` carries a seeded prior (pseudo-count 10 < minSamples 25); `fast` is cold.
    const score = table({
      "hard|strong": { n: 10, meanReward: 0.8, seeded: true },
    });
    const r = createPolicyRouter({ candidates: ROSTER, policy: "learned", score });
    // `fast` is under-sampled and unseeded → explored first.
    const d1 = r.route(HARD, "s", 0);
    expect(d1.candidate).toBe(FAST);
    expect(d1.explored).toBe(true);
  });

  test("when every arm is seeded no warm-up happens: the best prior is exploited from the first turn", () => {
    const score = table({
      "hard|fast": { n: 10, meanReward: 0.4, seeded: true },
      "hard|strong": { n: 6, meanReward: 0.8, seeded: true },
    });
    const r = createPolicyRouter({ candidates: ROSTER, policy: "learned", score });
    const d = r.route(HARD, "s", 0);
    expect(d.candidate).toBe(STRONG);
    expect(d.explored).toBe(false);
    expect(d.reason).toContain("best arm meanReward=0.800 (n=6)");
  });

  test("a seeded arm STAYS out of warm-up after live observations land: the prior blends with live history", () => {
    // Priors for both arms (pseudo-count 10 < minSamples 25) over a LIVE
    // scoreboard that starts empty and fills as decisions are recorded.
    const loaded = loadPriors({
      version: 1,
      fingerprint: "f",
      arms: [
        { routeKey: "hard", arm: "fast", n: 10, meanReward: 0.3 },
        { routeKey: "hard", arm: "strong", n: 10, meanReward: 0.8 },
      ],
    });
    if (!loaded.ok) throw new Error("expected ok");
    const live = new Map<string, { n: number; sum: number }>();
    const liveLookup: ScoreLookup = (rk, arm) => {
      const a = live.get(`${rk}|${arm}`);
      return a === undefined ? undefined : { n: a.n, meanReward: a.n > 0 ? a.sum / a.n : 0 };
    };
    const record = (arm: string, reward: number): void => {
      const a = live.get(`hard|${arm}`) ?? { n: 0, sum: 0 };
      live.set(`hard|${arm}`, { n: a.n + 1, sum: a.sum + reward });
    };
    const r = createPolicyRouter({
      candidates: ROSTER,
      policy: "learned",
      score: seededScoreLookup(liveLookup, loaded.priors),
      learning: { explorationRate: 0 },
    });
    // Turn 0: exploited on the prior.
    const d0 = r.route(HARD, "s", 0);
    expect(d0.candidate).toBe(STRONG);
    expect(d0.explored).toBe(false);
    expect(d0.reason).toContain("(n=10)");
    // ONE live observation on the seeded winner: the next decision must NOT
    // fall back into cold warm-up ("exploring under-sampled arm (n=1 < 25)").
    record("strong", 0.9);
    const d1 = r.route(HARD, "s", 1);
    expect(d1.candidate).toBe(STRONG);
    expect(d1.explored).toBe(false);
    expect(d1.reason).toContain("(n=11)");
    // One on each arm: still exploiting, on the blended means.
    record("fast", 0.2);
    const d2 = r.route(HARD, "s", 2);
    expect(d2.candidate).toBe(STRONG);
    expect(d2.explored).toBe(false);
    // Live history can overturn the prior: 20 poor live samples on strong (mean
    // 0.1 → blended ≈ 0.35) against fast's blended 0.29 keeps strong; fifteen
    // more (blend ≈ 0.27) hand the band to fast — the prior FADES, it never pins.
    for (let i = 0; i < 20; i++) record("strong", 0.1);
    expect(r.route(HARD, "s", 3).candidate).toBe(STRONG);
    for (let i = 0; i < 15; i++) record("strong", 0.1);
    const d3 = r.route(HARD, "s", 4);
    expect(d3.candidate).toBe(FAST);
    expect(d3.explored).toBe(false);
  });

  test("a seeded unscoped arm also serves the scoped backoff", () => {
    const score = table({
      "hard|fast": { n: 10, meanReward: 0.9, seeded: true },
      "hard|strong": { n: 10, meanReward: 0.2, seeded: true },
    });
    const r = createPolicyRouter({ candidates: ROSTER, policy: "learned", score, scope: "triage" });
    const d = r.route(HARD, "s", 0);
    expect(d).toMatchObject({ candidate: FAST, routeKey: "triage/hard", backedOffTo: "hard" });
  });
});
