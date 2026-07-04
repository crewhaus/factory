/**
 * `model_pool` PolicyRouter — static / heuristic / learned selection tests.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { type PoolCandidate, type ScoreLookup, createPolicyRouter } from "./policy-router";
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
