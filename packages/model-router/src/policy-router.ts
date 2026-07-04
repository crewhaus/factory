/**
 * `model_pool` — declared-candidate, per-task model selection that improves
 * with usage. The generalisation of the two-tier router (`tier-router.ts`):
 * instead of exactly two rungs picked by a fixed heuristic, a pool holds N
 * user-declared candidates and a `policy` that selects one PER TURN.
 *
 *   - `static`    — always the first candidate (declared order = priority).
 *   - `heuristic` — deterministic difficulty routing (reuses `pickTier`):
 *                   hard turns go to a `strong`-tagged candidate, easy turns to
 *                   a `cheap`-tagged one. Zero state, fully reproducible.
 *   - `learned`   — per-difficulty-band arm selection off the durable reward
 *                   scoreboard (`@crewhaus/routing-store`). Under-sampled arms
 *                   are explored DETERMINISTICALLY (least-sampled first, tie →
 *                   declared order); once every arm in a band clears
 *                   `minSamplesPerArm`, the highest mean-reward arm wins. No
 *                   RNG — the decision replays exactly from the persisted
 *                   scoreboard + the turn's signals.
 *
 * This module is PURE and fs-free (mirroring the rest of model-router): the
 * `learned` policy reads the scoreboard through an injected `score` lookup, so
 * runtime-core owns all persistence and the router stays trivially testable.
 *
 * Like the tier router and the failover chain, every candidate adapter binds
 * ONCE at boot; `route()` only selects among the already-resolved candidates.
 * A failed cheap pick escalates to `escalation()` (the strongest candidate) —
 * composing with the loop's misroute-recovery ladder exactly as the tier
 * router's fast→default escalation does.
 */
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { type TierRoutingConfig, type TierSignals, pickTier } from "./tier-router.js";

/** One resolved candidate in a model pool. */
export type PoolCandidate = {
  readonly adapter: ProviderAdapter;
  /** Wire model id the candidate resolved to. */
  readonly modelId: string;
  /** Spec model-router grammar string — the stable ARM IDENTITY in the scoreboard. */
  readonly modelString: string;
  /** Free-form tags (e.g. `cheap`, `strong`) the heuristic routes on. */
  readonly tags: readonly string[];
};

export type PoolPolicy = "static" | "heuristic" | "learned";

/**
 * Difficulty thresholds (shared verbatim with the tier router) plus the tag
 * preferences the heuristic routes on. All optional — sensible defaults apply.
 */
export type PoolRoutingConfig = TierRoutingConfig & {
  /** Tag the heuristic prefers for HARD turns. Default `"strong"`. */
  readonly strongTag?: string;
  /** Tag the heuristic prefers for EASY turns. Default `"cheap"`. */
  readonly cheapTag?: string;
};

export type PoolLearningConfig = {
  /** Observations an arm needs before it can win its band on merit. Default 25. */
  readonly minSamplesPerArm?: number;
};

/** The minimal per-arm read the learned policy needs from the scoreboard. */
export type ArmScore = {
  readonly n: number;
  readonly meanReward: number;
};

/** Injected scoreboard reader: `(routeKey, modelString) → arm stats | undefined`. */
export type ScoreLookup = (routeKey: string, modelString: string) => ArmScore | undefined;

export type PolicyRouterOptions = {
  readonly candidates: readonly PoolCandidate[];
  readonly policy: PoolPolicy;
  readonly routing?: PoolRoutingConfig;
  readonly learning?: PoolLearningConfig;
  /** Required for `policy: "learned"`; ignored by `static`/`heuristic`. */
  readonly score?: ScoreLookup;
};

export type PolicyDecision = {
  readonly candidate: PoolCandidate;
  /** The learning bucket this decision keys on: `"hard"` | `"easy"`. */
  readonly routeKey: string;
  /** Human-readable trigger for the `model_route` trace event / logs. */
  readonly reason: string;
  readonly policy: PoolPolicy;
  /** True when the learned policy chose an under-sampled arm to explore it. */
  readonly explored: boolean;
};

export interface PolicyRouter {
  /** The per-turn model decision from the loop's deterministic signals. */
  route(signals: TierSignals): PolicyDecision;
  /** The resolved candidate set (declared order). */
  candidates(): readonly PoolCandidate[];
  /** Strongest candidate — the escalation target for a failed cheap pick. */
  escalation(): PoolCandidate;
}

const DEFAULT_MIN_SAMPLES = 25;
const STRONG_TAG = "strong";
const CHEAP_TAG = "cheap";

/**
 * The learning bucket for a turn. Reuses the tier router's escalation logic so
 * a pool with two candidates + `policy: heuristic` behaves identically to the
 * equivalent `model_tiers` block: `"hard"` ⟺ the tier router would pick
 * `default`, `"easy"` ⟺ it would pick `fast`.
 */
function routeBand(
  signals: TierSignals,
  routing: PoolRoutingConfig,
): { band: "hard" | "easy"; reason: string } {
  const decision = pickTier(signals, routing);
  return decision.tier === "default"
    ? { band: "hard", reason: decision.reason }
    : { band: "easy", reason: decision.reason };
}

/** First candidate carrying `tag`, else `undefined`. */
function firstTagged(candidates: readonly PoolCandidate[], tag: string): PoolCandidate | undefined {
  return candidates.find((c) => c.tags.includes(tag));
}

export function createPolicyRouter(opts: PolicyRouterOptions): PolicyRouter {
  const candidates = opts.candidates;
  const firstCandidate = candidates[0];
  if (firstCandidate === undefined) {
    throw new Error("model-router: createPolicyRouter requires at least one candidate");
  }
  // Declaration-order fallbacks when tags don't disambiguate: cheapest = first,
  // strongest = last (the documented "declare cheapest→strongest" convention).
  const lastCandidate = candidates[candidates.length - 1] ?? firstCandidate;
  const routing = opts.routing ?? {};
  const strongTag = routing.strongTag ?? STRONG_TAG;
  const cheapTag = routing.cheapTag ?? CHEAP_TAG;
  const minSamples = Math.max(1, opts.learning?.minSamplesPerArm ?? DEFAULT_MIN_SAMPLES);
  const score = opts.score;
  if (opts.policy === "learned" && score === undefined) {
    throw new Error("model-router: policy 'learned' requires an injected score lookup");
  }

  /** Strongest candidate: first `strongTag` match, else the last declared. */
  const strongest = (): PoolCandidate => firstTagged(candidates, strongTag) ?? lastCandidate;
  /** Cheapest candidate: first `cheapTag` match, else the first declared. */
  const cheapest = (): PoolCandidate => firstTagged(candidates, cheapTag) ?? firstCandidate;

  const decideLearned = (signals: TierSignals): PolicyDecision => {
    const { band } = routeBand(signals, routing);
    // Snapshot each candidate's sample count / mean reward for THIS band.
    const arms = candidates.map((candidate) => {
      const s = score?.(band, candidate.modelString);
      return { candidate, n: s?.n ?? 0, meanReward: s?.meanReward ?? 0 };
    });
    // Explore: any arm below the floor → deterministically pick the least
    // sampled (declared order breaks ties). This round-robins arms up to the
    // floor over successive turns/runs, so the store fills without any RNG.
    const underSampled = arms.filter((a) => a.n < minSamples);
    if (underSampled.length > 0) {
      // Least-sampled wins; declared order breaks ties (reduce keeps the FIRST
      // on a tie since it only switches on a strict `<`).
      const pick = underSampled.reduce((lo, a) => (a.n < lo.n ? a : lo));
      return {
        candidate: pick.candidate,
        routeKey: band,
        reason: `learned/${band}: exploring under-sampled arm (n=${pick.n} < ${minSamples})`,
        policy: "learned",
        explored: true,
      };
    }
    // Exploit: every arm has enough samples → highest mean reward wins
    // (declared order breaks ties, keeping the pick deterministic).
    const best = arms.reduce((hi, a) => (a.meanReward > hi.meanReward ? a : hi));
    return {
      candidate: best.candidate,
      routeKey: band,
      reason: `learned/${band}: best arm meanReward=${best.meanReward.toFixed(3)} (n=${best.n})`,
      policy: "learned",
      explored: false,
    };
  };

  return {
    route(signals: TierSignals): PolicyDecision {
      if (opts.policy === "static") {
        const { band } = routeBand(signals, routing);
        return {
          candidate: firstCandidate,
          routeKey: band,
          reason: "static: first declared candidate",
          policy: "static",
          explored: false,
        };
      }
      if (opts.policy === "heuristic") {
        const { band, reason } = routeBand(signals, routing);
        const candidate = band === "hard" ? strongest() : cheapest();
        return {
          candidate,
          routeKey: band,
          reason: `heuristic/${band}: ${reason}`,
          policy: "heuristic",
          explored: false,
        };
      }
      return decideLearned(signals);
    },
    candidates(): readonly PoolCandidate[] {
      return candidates;
    },
    escalation(): PoolCandidate {
      return strongest();
    },
  };
}
