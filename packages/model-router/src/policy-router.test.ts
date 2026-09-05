/**
 * `model_pool` PolicyRouter — static / heuristic / learned selection tests.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import {
  type PolicyDecision,
  type PoolCandidate,
  type ScoreLookup,
  createPolicyRouter,
} from "./policy-router";
import type { TierSignals } from "./tier-router";

const EASY: TierSignals = {
  contextTokens: 500,
  toolsInPlay: false,
  turnIndex: 3,
  priorTurnToolUseCount: 0,
};
const HARD: TierSignals = { ...EASY, toolsInPlay: true };

function stubAdapter(id: string): ProviderAdapter {
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: false,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    // biome-ignore lint/correctness/useYield: stub never yields
    stream: async function* () {
      throw new Error(`stub ${id} not streamed`);
    },
  };
}

function candidate(modelString: string, tags: string[]): PoolCandidate {
  return { adapter: stubAdapter(modelString), modelId: modelString, modelString, tags };
}

const HAIKU = candidate("claude-haiku-4-5", ["cheap", "fast"]);
const SONNET = candidate("claude-sonnet-5", ["balanced"]);
const OPUS = candidate("claude-opus-4-8", ["strong"]);
const POOL = [HAIKU, SONNET, OPUS];

describe("PolicyRouter — construction guards", () => {
  test("empty candidate list throws", () => {
    expect(() => createPolicyRouter({ candidates: [], policy: "static" })).toThrow(
      /at least one candidate/,
    );
  });
  test("learned without a score lookup throws", () => {
    expect(() => createPolicyRouter({ candidates: POOL, policy: "learned" })).toThrow(
      /requires an injected score/,
    );
  });
});

describe("PolicyRouter — static", () => {
  test("always the first declared candidate, regardless of difficulty", () => {
    const r = createPolicyRouter({ candidates: POOL, policy: "static" });
    expect(r.route(EASY).candidate.modelString).toBe("claude-haiku-4-5");
    expect(r.route(HARD).candidate.modelString).toBe("claude-haiku-4-5");
    expect(r.route(EASY).policy).toBe("static");
  });
});

describe("PolicyRouter — heuristic", () => {
  const r = createPolicyRouter({ candidates: POOL, policy: "heuristic" });

  test("hard turns route to the strong-tagged candidate; easy to the cheap-tagged", () => {
    expect(r.route(HARD).candidate.modelString).toBe("claude-opus-4-8");
    expect(r.route(HARD).routeKey).toBe("hard");
    expect(r.route(EASY).candidate.modelString).toBe("claude-haiku-4-5");
    expect(r.route(EASY).routeKey).toBe("easy");
  });

  test("first turn is a hard signal (task framing → strong)", () => {
    expect(r.route({ ...EASY, turnIndex: 0 }).candidate.modelString).toBe("claude-opus-4-8");
  });

  test("behaves like a two-tier block: tag-less pool falls back to declaration order", () => {
    const untagged = [candidate("m-cheap", []), candidate("m-strong", [])];
    const rr = createPolicyRouter({ candidates: untagged, policy: "heuristic" });
    expect(rr.route(EASY).candidate.modelString).toBe("m-cheap"); // first = cheapest
    expect(rr.route(HARD).candidate.modelString).toBe("m-strong"); // last = strongest
  });

  test("routing thresholds thread through (custom context threshold)", () => {
    const rr = createPolicyRouter({
      candidates: POOL,
      policy: "heuristic",
      routing: { contextTokenThreshold: 400 },
    });
    expect(rr.route({ ...EASY, contextTokens: 500 }).routeKey).toBe("hard");
  });

  test("escalation() is the strongest candidate", () => {
    expect(r.escalation().modelString).toBe("claude-opus-4-8");
  });
});

/** A tiny in-memory scoreboard fake so learned selection is deterministic. */
function fakeScore(
  rows: Record<string, Record<string, { n: number; meanReward: number }>>,
): ScoreLookup {
  return (routeKey, model) => rows[routeKey]?.[model];
}

describe("PolicyRouter — learned", () => {
  test("explores least-sampled arm first (deterministic round-robin), then argmax", () => {
    // easy band: all arms below the floor of 3 → least-sampled wins, ties by order.
    const score = fakeScore({
      easy: {
        "claude-haiku-4-5": { n: 2, meanReward: 0.4 },
        "claude-sonnet-5": { n: 1, meanReward: 0.9 },
        "claude-opus-4-8": { n: 2, meanReward: 0.9 },
      },
    });
    const r = createPolicyRouter({
      candidates: POOL,
      policy: "learned",
      learning: { minSamplesPerArm: 3 },
      score,
    });
    const d = r.route(EASY);
    expect(d.candidate.modelString).toBe("claude-sonnet-5"); // n=1 is least sampled
    expect(d.explored).toBe(true);
    expect(d.reason).toContain("exploring");
  });

  test("once every arm clears the floor, the highest mean reward wins", () => {
    const score = fakeScore({
      easy: {
        "claude-haiku-4-5": { n: 30, meanReward: 0.55 },
        "claude-sonnet-5": { n: 30, meanReward: 0.72 },
        "claude-opus-4-8": { n: 30, meanReward: 0.51 },
      },
    });
    const r = createPolicyRouter({
      candidates: POOL,
      policy: "learned",
      learning: { minSamplesPerArm: 25 },
      score,
    });
    const d = r.route(EASY);
    expect(d.candidate.modelString).toBe("claude-sonnet-5");
    expect(d.explored).toBe(false);
    expect(d.reason).toContain("best arm");
  });

  test("hard and easy bands are independent buckets", () => {
    const score = fakeScore({
      easy: {
        "claude-haiku-4-5": { n: 30, meanReward: 0.9 },
        "claude-sonnet-5": { n: 30, meanReward: 0.1 },
        "claude-opus-4-8": { n: 30, meanReward: 0.1 },
      },
      hard: {
        "claude-haiku-4-5": { n: 30, meanReward: 0.1 },
        "claude-sonnet-5": { n: 30, meanReward: 0.1 },
        "claude-opus-4-8": { n: 30, meanReward: 0.9 },
      },
    });
    const r = createPolicyRouter({
      candidates: POOL,
      policy: "learned",
      learning: { minSamplesPerArm: 25 },
      score,
    });
    expect(r.route(EASY).candidate.modelString).toBe("claude-haiku-4-5");
    expect(r.route(HARD).candidate.modelString).toBe("claude-opus-4-8");
  });

  test("unknown arms count as n=0 and are explored before any sampled arm", () => {
    const score = fakeScore({
      easy: { "claude-haiku-4-5": { n: 30, meanReward: 0.9 } }, // sonnet & opus unknown
    });
    const r = createPolicyRouter({
      candidates: POOL,
      policy: "learned",
      learning: { minSamplesPerArm: 25 },
      score,
    });
    const d = r.route(EASY);
    expect(d.candidate.modelString).toBe("claude-sonnet-5"); // first unknown (n=0), declared order
    expect(d.explored).toBe(true);
  });

  test("the decision is reproducible: same scoreboard + signals → same pick", () => {
    const score = fakeScore({
      hard: {
        "claude-haiku-4-5": { n: 30, meanReward: 0.3 },
        "claude-sonnet-5": { n: 30, meanReward: 0.8 },
        "claude-opus-4-8": { n: 30, meanReward: 0.8 },
      },
    });
    const r = createPolicyRouter({
      candidates: POOL,
      policy: "learned",
      learning: { minSamplesPerArm: 25 },
      score,
    });
    const a = r.route(HARD);
    const b = r.route(HARD);
    expect(a.candidate.modelString).toBe(b.candidate.modelString);
    expect(a.candidate.modelString).toBe("claude-sonnet-5"); // argmax tie broken by declared order
  });
});

describe("PolicyRouter — learned ε-greedy online exploration", () => {
  // All arms past the sample floor (exploit phase), with a clear best (sonnet).
  const exploitScore = () =>
    fakeScore({
      easy: {
        "claude-haiku-4-5": { n: 30, meanReward: 0.1 },
        "claude-sonnet-5": { n: 30, meanReward: 0.9 },
        "claude-opus-4-8": { n: 30, meanReward: 0.1 },
      },
    });
  const learnedPool = (explorationRate: number) =>
    createPolicyRouter({
      candidates: POOL,
      policy: "learned",
      learning: { minSamplesPerArm: 25, explorationRate },
      score: exploitScore(),
    });
  const turn = (t: number) => ({ ...EASY, turnIndex: t }); // turnIndex ≥ 1 stays in the easy band

  test("explorationRate 0 (default) → always the best arm, never explores (0.2.1-identical)", () => {
    const r = learnedPool(0);
    for (let t = 1; t <= 40; t++) {
      const d = r.route(turn(t), "run-A");
      expect(d.candidate.modelString).toBe("claude-sonnet-5");
      expect(d.explored).toBe(false);
    }
    // Unset explorationRate behaves the same as 0.
    const rDefault = createPolicyRouter({
      candidates: POOL,
      policy: "learned",
      learning: { minSamplesPerArm: 25 },
      score: exploitScore(),
    });
    expect(rDefault.route(turn(7), "run-A").explored).toBe(false);
  });

  test("explorationRate 1 → every exploit-phase turn explores a NON-best arm", () => {
    const r = learnedPool(1);
    for (let t = 1; t <= 40; t++) {
      const d = r.route(turn(t), "run-A");
      expect(d.explored).toBe(true);
      expect(d.candidate.modelString).not.toBe("claude-sonnet-5"); // never the best
      expect(d.reason).toContain("ε-greedy explore");
    }
  });

  test("exploration fires on ~explorationRate of turns and is keyed on (seed, turn)", () => {
    const r = learnedPool(0.3);
    let explored = 0;
    for (let t = 1; t <= 300; t++) {
      const d = r.route(turn(t), "run-A");
      if (d.explored) {
        explored++;
        expect(d.candidate.modelString).not.toBe("claude-sonnet-5");
      } else {
        expect(d.candidate.modelString).toBe("claude-sonnet-5");
      }
    }
    // ~30% of 300 = ~90; allow a wide band for a deterministic hash.
    expect(explored).toBeGreaterThan(50);
    expect(explored).toBeLessThan(140);
  });

  test("the ε-greedy decision is reproducible from (seed, turn) and varies by seed", () => {
    const r = learnedPool(0.3);
    // Same seed + turn → identical decision.
    const a = r.route(turn(9), "run-A");
    const b = r.route(turn(9), "run-A");
    expect(a.candidate.modelString).toBe(b.candidate.modelString);
    expect(a.explored).toBe(b.explored);
    // Different seeds → the explore/exploit pattern differs on at least one turn.
    let differs = false;
    for (let t = 1; t <= 60; t++) {
      if (r.route(turn(t), "run-A").explored !== r.route(turn(t), "run-B").explored) {
        differs = true;
        break;
      }
    }
    expect(differs).toBe(true);
  });

  test("warm-up ignores explorationRate — under-sampled arms still round-robin deterministically", () => {
    const r = createPolicyRouter({
      candidates: POOL,
      policy: "learned",
      learning: { minSamplesPerArm: 25, explorationRate: 1 },
      score: fakeScore({
        easy: {
          "claude-haiku-4-5": { n: 5, meanReward: 0.9 },
          "claude-sonnet-5": { n: 2, meanReward: 0.1 }, // least sampled
          "claude-opus-4-8": { n: 5, meanReward: 0.9 },
        },
      }),
    });
    const d = r.route(turn(9), "run-A");
    expect(d.candidate.modelString).toBe("claude-sonnet-5"); // least-sampled, not ε-greedy
    expect(d.reason).toContain("under-sampled");
  });
});

/** Scoreboard fake carrying variance, for Thompson sampling. */
function tScore(
  rows: Record<string, Record<string, { n: number; meanReward: number; varReward: number }>>,
): ScoreLookup {
  return (routeKey, model) => rows[routeKey]?.[model];
}

describe("PolicyRouter — learned Thompson sampling", () => {
  const thompsonPool = (rows: Parameters<typeof tScore>[0]) =>
    createPolicyRouter({
      candidates: POOL,
      policy: "learned",
      learning: { minSamplesPerArm: 25, bandit: "thompson" },
      score: tScore(rows),
    });
  const turn = (t: number) => ({ ...EASY, turnIndex: t });

  test("a confident high-mean arm wins the vast majority of turns", () => {
    const r = thompsonPool({
      easy: {
        "claude-haiku-4-5": { n: 30, meanReward: 0.3, varReward: 0.01 },
        "claude-sonnet-5": { n: 30, meanReward: 0.9, varReward: 0.01 }, // clear best
        "claude-opus-4-8": { n: 30, meanReward: 0.3, varReward: 0.01 },
      },
    });
    let best = 0;
    for (let t = 1; t <= 300; t++) {
      if (r.route(turn(t), "run-A").candidate.modelString === "claude-sonnet-5") best++;
    }
    // A confident, well-separated best (means 0.9 vs 0.3, tiny variance) is
    // ~33 posterior-std apart, so Thompson dominates — up to and including 100%.
    expect(best).toBeGreaterThan(290);
  });

  test("an UNCERTAIN arm gets explored more than its mean alone would allow", () => {
    // haiku's mean (0.5) is below sonnet's (0.6), so pure argmax never picks
    // it — but its high variance means Thompson samples it above sonnet a
    // non-trivial fraction of the time.
    const r = thompsonPool({
      easy: {
        "claude-haiku-4-5": { n: 30, meanReward: 0.5, varReward: 0.2 }, // uncertain
        "claude-sonnet-5": { n: 30, meanReward: 0.6, varReward: 0.001 }, // confident
        "claude-opus-4-8": { n: 30, meanReward: 0.1, varReward: 0.001 },
      },
    });
    let haiku = 0;
    for (let t = 1; t <= 400; t++) {
      const d = r.route(turn(t), "run-A");
      if (d.candidate.modelString === "claude-haiku-4-5") {
        haiku++;
        expect(d.explored).toBe(true); // picking a non-empirical-best arm is exploration
      }
    }
    expect(haiku).toBeGreaterThan(10); // explored
    expect(haiku).toBeLessThan(200); // but sonnet still wins most
  });

  test("zero-variance arms collapse Thompson to a deterministic argmax", () => {
    const r = thompsonPool({
      easy: {
        "claude-haiku-4-5": { n: 30, meanReward: 0.4, varReward: 0 },
        "claude-sonnet-5": { n: 30, meanReward: 0.8, varReward: 0 },
        "claude-opus-4-8": { n: 30, meanReward: 0.4, varReward: 0 },
      },
    });
    for (let t = 1; t <= 30; t++) {
      const d = r.route(turn(t), "run-A");
      expect(d.candidate.modelString).toBe("claude-sonnet-5");
      expect(d.explored).toBe(false);
    }
  });

  test("Thompson picks are reproducible from (seed, seq)", () => {
    const rows = {
      easy: {
        "claude-haiku-4-5": { n: 30, meanReward: 0.5, varReward: 0.1 },
        "claude-sonnet-5": { n: 30, meanReward: 0.55, varReward: 0.1 },
        "claude-opus-4-8": { n: 30, meanReward: 0.5, varReward: 0.1 },
      },
    };
    const a = thompsonPool(rows).route(turn(7), "run-A");
    const b = thompsonPool(rows).route(turn(7), "run-A");
    expect(a.candidate.modelString).toBe(b.candidate.modelString);
    expect(a.reason).toContain("thompson");
  });

  test("Thompson still respects the warm-up (under-sampled arms round-robin first)", () => {
    const r = createPolicyRouter({
      candidates: POOL,
      policy: "learned",
      learning: { minSamplesPerArm: 25, bandit: "thompson" },
      score: tScore({
        easy: {
          "claude-haiku-4-5": { n: 30, meanReward: 0.9, varReward: 0.01 },
          "claude-sonnet-5": { n: 3, meanReward: 0.1, varReward: 0.01 }, // under-sampled
          "claude-opus-4-8": { n: 30, meanReward: 0.9, varReward: 0.01 },
        },
      }),
    });
    const d = r.route(turn(9), "run-A");
    expect(d.candidate.modelString).toBe("claude-sonnet-5");
    expect(d.reason).toContain("under-sampled");
  });
});

/**
 * 0.6.0 §4.4 pin — `toolsInPlay` is the RUN-WIDE UNION advertisement.
 *
 * runtime-core computes the signal as `anthropicTools.length > 0` over the
 * one tool list every candidate is sent, BEFORE a candidate is chosen. Later
 * releases give candidates their own toolsets (§5); the routing signal must
 * stay the union — "any tool advertised on this request" — so a per-candidate
 * subset can never change which band a turn lands in, and a candidate cannot
 * make itself look "easy" by carrying fewer tools. These tests pin that the
 * router (a) treats the flag as a single boolean, (b) never consults a
 * candidate-level tool list, and (c) yields identical decisions whether the
 * union came from one candidate's tools or several.
 */
describe("PolicyRouter — toolsInPlay is the union advertisement (0.6.0 §4.4 pin)", () => {
  const unionSignal = (toolsets: ReadonlyArray<readonly string[]>): TierSignals => ({
    ...EASY,
    // exactly how runtime-core derives it: any advertised tool, run-wide
    toolsInPlay: toolsets.flat().length > 0,
  });

  test("any advertised tool routes the turn HARD, regardless of which candidate could serve it", () => {
    const r = createPolicyRouter({ candidates: POOL, policy: "heuristic" });
    // The cheap candidate owns the only tool; the union still says "tools in play".
    const d = r.route(unionSignal([["read"], [], []]));
    expect(d.routeKey).toBe("hard");
    expect(d.candidate.modelString).toBe("claude-opus-4-8");
    expect(d.reason).toContain("tools in play");
    // An empty union is the only way to land on the easy band.
    expect(r.route(unionSignal([[], [], []])).routeKey).toBe("easy");
  });

  test("a candidate-level tool list is NOT a routing input (unknown candidate fields are ignored)", () => {
    // Candidates decorated with a hypothetical per-candidate `tools` field —
    // the shape later releases add. The router must not read it: the
    // decision is a function of the signals alone.
    const decorated: PoolCandidate[] = POOL.map((c, i) => ({
      ...c,
      ...({ tools: i === 0 ? ["read", "grep"] : [] } as Record<string, unknown>),
    }));
    const plain = createPolicyRouter({ candidates: POOL, policy: "heuristic" });
    const withTools = createPolicyRouter({ candidates: decorated, policy: "heuristic" });
    for (const signals of [EASY, HARD, { ...EASY, turnIndex: 0 }]) {
      const a = plain.route(signals);
      const b = withTools.route(signals);
      expect(b.candidate.modelString).toBe(a.candidate.modelString);
      expect(b.routeKey).toBe(a.routeKey);
      expect(b.reason).toBe(a.reason);
    }
  });

  test("the learned band key is the union flag too (hard/easy arms never split per candidate)", () => {
    const seen: string[] = [];
    const r = createPolicyRouter({
      candidates: POOL,
      policy: "learned",
      learning: { minSamplesPerArm: 1 },
      score: (routeKey) => {
        seen.push(routeKey);
        return undefined;
      },
    });
    r.route(unionSignal([["read"], []]));
    r.route(unionSignal([[], []]));
    // Exactly the two bands, keyed on the union — no per-candidate band.
    expect(new Set(seen)).toEqual(new Set(["hard", "easy"]));
  });

  test("a forced decision keeps the router's band: `forced` is a loop-side substitution, never a router output", () => {
    // The router's own policies are the only values `route()` returns; the
    // loop (budget degrade, §7.12) substitutes the candidate into the decision
    // it produced and stamps `policy: "forced"` while keeping `routeKey`.
    const r = createPolicyRouter({ candidates: POOL, policy: "heuristic" });
    const base = r.route(HARD);
    expect(["static", "heuristic", "learned"]).toContain(base.policy);
    const forced: PolicyDecision = {
      ...base,
      candidate: HAIKU,
      policy: "forced",
      reason: "budget_degrade",
      explored: false,
    };
    expect(forced.routeKey).toBe(base.routeKey);
    expect(forced.policy).toBe("forced");
  });
});

describe("PolicyRouter — the preRoute hint input (0.6.0 §7.2, §7.11)", () => {
  const profiled = (modelString: string, tags: string[], armId: string): PoolCandidate => ({
    ...candidate(modelString, tags),
    armId,
  });
  const FAST = profiled("claude-haiku-4-5", ["cheap"], "fast");
  const MID = profiled("claude-sonnet-5", ["balanced"], "mid");
  const STRONG = profiled("claude-opus-4-8", ["strong"], "strong");
  const ROSTER = [FAST, MID, STRONG];

  test("route() without a hint is byte-identical to the 0.5.x decision", () => {
    const r = createPolicyRouter({ candidates: ROSTER, policy: "heuristic" });
    expect(r.route(HARD)).toEqual(r.route(HARD, "", HARD.turnIndex, undefined));
    expect(r.route(EASY).candidate).toBe(FAST);
  });

  test("forcedArm on the roster is served and stamped with the lane's policy; the band is kept", () => {
    const r = createPolicyRouter({ candidates: ROSTER, policy: "heuristic" });
    const directive = r.route(EASY, "", 0, {
      source: "directive",
      forcedArm: "strong",
      eligible: [],
    });
    expect(directive.candidate).toBe(STRONG);
    expect(directive.policy).toBe("directive");
    expect(directive.routeKey).toBe("easy");
    expect(directive.explored).toBe(false);
    const rule = r.route(HARD, "", 0, {
      source: "rule",
      forcedArm: "fast",
      eligible: ["fast", "strong"],
      evidence: { ruleId: "cheap-when-broke" },
    });
    expect(rule.candidate).toBe(FAST);
    expect(rule.policy).toBe("rule");
    expect(rule.reason).toBe("rule: fast (ruleId=cheap-when-broke)");
    const classified = r.route(HARD, "", 0, { source: "classifier", forcedArm: "mid" });
    expect(classified.policy).toBe("classifier");
    expect(classified.candidate).toBe(MID);
  });

  test("a forcedArm the roster does not hold is ignored (the loop forces out-of-roster rungs itself)", () => {
    const r = createPolicyRouter({ candidates: ROSTER, policy: "static" });
    const d = r.route(HARD, "", 0, { source: "forced", forcedArm: "not-declared" });
    expect(d.candidate).toBe(FAST);
    expect(d.policy).toBe("static");
  });

  test("eligible[] narrows static / heuristic to the eligible arms; an empty set leaves the roster in play", () => {
    const stat = createPolicyRouter({ candidates: ROSTER, policy: "static" });
    expect(
      stat.route(HARD, "", 0, { source: "eligibility", eligible: ["mid", "strong"] }),
    ).toMatchObject({
      candidate: MID,
      reason: "static: first eligible candidate",
    });
    expect(stat.route(HARD, "", 0, { source: "none", eligible: [] }).candidate).toBe(FAST);
    const heur = createPolicyRouter({ candidates: ROSTER, policy: "heuristic" });
    // Hard turn, strong excluded → the last eligible (no strong tag left).
    expect(
      heur.route(HARD, "", 0, { source: "eligibility", eligible: ["fast", "mid"] }).candidate,
    ).toBe(MID);
    // Easy turn, cheap excluded → the first eligible.
    expect(
      heur.route(EASY, "", 0, { source: "eligibility", eligible: ["mid", "strong"] }).candidate,
    ).toBe(MID);
    // Every eligible id unknown → the roster (a stale hint never strands the turn).
    expect(heur.route(EASY, "", 0, { source: "eligibility", eligible: ["ghost"] }).candidate).toBe(
      FAST,
    );
  });

  test("learned scores only the eligible arms (warm-up round-robins among them)", () => {
    const seen: string[] = [];
    const score: ScoreLookup = (_rk, m) => {
      seen.push(m);
      return undefined;
    };
    const r = createPolicyRouter({
      candidates: ROSTER,
      policy: "learned",
      learning: { minSamplesPerArm: 1 },
      score,
    });
    const d = r.route(HARD, "s", 0, { source: "eligibility", eligible: ["mid", "strong"] });
    expect(d.candidate).toBe(MID);
    expect(d.explored).toBe(true);
    // §7.9 (PR 10) — the scoreboard is read by ARM ID (the profile name).
    expect(seen).toEqual(["mid", "strong"]);
  });

  test("routeKeySuffix appends to the band as <band>:<suffix>", () => {
    const r = createPolicyRouter({ candidates: ROSTER, policy: "heuristic" });
    expect(r.route(HARD, "", 0, { source: "none", routeKeySuffix: "x" }).routeKey).toBe("hard:x");
  });

  test("armId defaults to the model string for an unprofiled candidate", () => {
    const r = createPolicyRouter({ candidates: POOL, policy: "static" });
    const d = r.route(HARD, "", 0, { source: "directive", forcedArm: OPUS.modelString });
    expect(d.candidate).toBe(OPUS);
    expect(d.policy).toBe("directive");
  });
});
