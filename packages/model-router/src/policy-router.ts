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
 * 0.6.0 §7.12 — the policy stamped on a {@link PolicyDecision}. Every
 * configured {@link PoolPolicy}, plus `"forced"`: a decision the loop made
 * OUTSIDE the router (today: a `budget.on_exceed: degrade` breach restricting
 * the pool to its degrade rung, reason `budget_degrade`). `route()` itself
 * never returns `"forced"` — the router stays a pure selector over the
 * roster; the loop substitutes the forced candidate into the decision the
 * router produced, keeping the band (`routeKey`) so the scoreboard arm is
 * still keyed on the turn's difficulty.
 */
export type PolicyDecisionPolicy = PoolPolicy | "forced";

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
  /**
   * ε for ε-greedy ONLINE exploration once every arm in a band has cleared
   * `minSamplesPerArm`: the fraction of exploit-phase turns that try a
   * non-best candidate instead of the current best, so the policy keeps
   * sampling (catching drift, escaping a stale local optimum) rather than
   * hard-committing forever. Default `0` — with `0` the learned policy is
   * exactly the deterministic explore-then-exploit of 0.2.1 (no RNG). Clamped
   * to `[0, 1]`. The draw is seeded from the run + turn (see `route`), so it
   * stays replayable from the transcript.
   */
  readonly explorationRate?: number;
  /**
   * Which exploration strategy runs in the exploit phase (after every arm
   * clears `minSamplesPerArm`):
   *   - `"epsilon-greedy"` (default) — exploit the best arm, explore a random
   *     non-best arm `explorationRate` of the time.
   *   - `"thompson"` — Gaussian Thompson sampling: draw each arm from its
   *     reward posterior `Normal(meanReward, varReward / n)` and take the arm
   *     with the highest draw. Self-balances explore/exploit (an uncertain arm
   *     wins more often), so `explorationRate` is ignored under `thompson`.
   * Both draw from a transcript-seeded RNG, so both replay exactly.
   */
  readonly bandit?: "epsilon-greedy" | "thompson";
};

/** The minimal per-arm read the learned policy needs from the scoreboard. */
export type ArmScore = {
  readonly n: number;
  readonly meanReward: number;
  /** Sample variance of reward (0 when n < 2). Consumed by Thompson sampling. */
  readonly varReward?: number;
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
  readonly policy: PolicyDecisionPolicy;
  /** True when the learned policy chose an under-sampled arm to explore it. */
  readonly explored: boolean;
};

export interface PolicyRouter {
  /**
   * The per-turn model decision from the loop's deterministic signals.
   *
   * `seed` + `seq` seed ε-greedy online exploration (only consulted by
   * `learned` with `explorationRate > 0`). `seed` is a per-RUN-stable value
   * that varies across runs (runtime-core passes the spec's `learning.seed`
   * when set, else the `sessionId`). `seq` is a MONOTONIC per-decision counter
   * that must keep advancing across `--resume` and across a channel-bot's
   * resume-per-message pattern — runtime-core passes the transcript length, so
   * every decision (even the first turn of a resumed session) draws a fresh
   * coin, while replay of the same transcript reproduces it exactly. `seq`
   * defaults to `signals.turnIndex` for callers/tests that route a single run
   * without resume. Omitting `seed` is equivalent to `""`.
   */
  route(signals: TierSignals, seed?: string, seq?: number): PolicyDecision;
  /** The resolved candidate set (declared order). */
  candidates(): readonly PoolCandidate[];
  /** Strongest candidate — the escalation target for a failed cheap pick. */
  escalation(): PoolCandidate;
}

const DEFAULT_MIN_SAMPLES = 25;
const STRONG_TAG = "strong";
const CHEAP_TAG = "cheap";

/**
 * A deterministic uniform draw in `[0, 1)` from string/number seed material
 * (FNV-1a over the joined parts). Same inputs → same draw, so ε-greedy
 * exploration keyed on `(seed, turnIndex, band)` is fully replayable from the
 * transcript — no persisted RNG state.
 */
function uniform01(...parts: ReadonlyArray<string | number>): number {
  let h = 0x811c9dc5;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 0x1_0000_0000;
}

/**
 * A standard-normal draw `N(0, 1)` from the same deterministic seed material,
 * via Box-Muller over two independent `uniform01` draws. Used by Thompson
 * sampling to draw each arm from its reward posterior. Reproducible from the
 * transcript for the same reason `uniform01` is.
 */
function gaussian(...parts: ReadonlyArray<string | number>): number {
  const u1 = Math.max(1e-12, uniform01(...parts, "z1"));
  const u2 = uniform01(...parts, "z2");
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

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
  const explorationRate = Math.max(0, Math.min(1, opts.learning?.explorationRate ?? 0));
  const bandit = opts.learning?.bandit ?? "epsilon-greedy";
  const score = opts.score;
  if (opts.policy === "learned" && score === undefined) {
    throw new Error("model-router: policy 'learned' requires an injected score lookup");
  }

  /** Strongest candidate: first `strongTag` match, else the last declared. */
  const strongest = (): PoolCandidate => firstTagged(candidates, strongTag) ?? lastCandidate;
  /** Cheapest candidate: first `cheapTag` match, else the first declared. */
  const cheapest = (): PoolCandidate => firstTagged(candidates, cheapTag) ?? firstCandidate;

  const decideLearned = (signals: TierSignals, seed: string, seq: number): PolicyDecision => {
    const { band } = routeBand(signals, routing);
    // Snapshot each candidate's sample count / mean reward for THIS band.
    const arms = candidates.map((candidate) => {
      const s = score?.(band, candidate.modelString);
      return {
        candidate,
        n: s?.n ?? 0,
        meanReward: s?.meanReward ?? 0,
        varReward: s?.varReward ?? 0,
      };
    });
    // Warm-up: any arm below the floor → deterministically pick the least
    // sampled (declared order breaks ties). This round-robins arms up to the
    // floor over successive turns/runs, so every arm gets sampled without any
    // RNG BEFORE any exploit/explore trade-off begins.
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
    // Exploit-phase best: highest mean reward (declared order breaks ties).
    const best = arms.reduce((hi, a) => (a.meanReward > hi.meanReward ? a : hi));
    // Thompson sampling: draw each arm from its reward posterior
    // `Normal(meanReward, varReward / n)` and take the highest draw. Arms with
    // more uncertainty (higher variance / fewer samples) win more often, so it
    // self-balances explore/exploit without an ε knob. Deterministic per
    // (seed, seq, band, model) → replayable from the transcript.
    if (bandit === "thompson" && arms.length > 1) {
      const drawn = arms.map((a) => ({
        arm: a,
        value:
          a.meanReward +
          gaussian(seed, seq, band, a.candidate.modelString) * Math.sqrt(a.varReward / a.n),
      }));
      const winner = drawn.reduce((hi, x) => (x.value > hi.value ? x : hi));
      return {
        candidate: winner.arm.candidate,
        routeKey: band,
        reason: `learned/${band}: thompson draw=${winner.value.toFixed(3)} (mean=${winner.arm.meanReward.toFixed(3)}, n=${winner.arm.n})`,
        policy: "learned",
        explored: winner.arm !== best,
      };
    }
    // ε-greedy ONLINE exploration: with probability `explorationRate` (per a
    // transcript-seeded draw), try a non-best arm so the policy keeps sampling
    // and can escape a stale optimum. `explorationRate === 0` (the default)
    // never draws — the pick is exactly the deterministic argmax of 0.2.1.
    if (explorationRate > 0 && arms.length > 1) {
      const draw = uniform01(seed, seq, band, "explore");
      if (draw < explorationRate) {
        const alternatives = arms.filter((a) => a !== best);
        const idx = Math.min(
          alternatives.length - 1,
          Math.floor(uniform01(seed, seq, band, "arm") * alternatives.length),
        );
        const pick = alternatives[idx] ?? best;
        return {
          candidate: pick.candidate,
          routeKey: band,
          reason: `learned/${band}: ε-greedy explore (ε=${explorationRate}, draw=${draw.toFixed(3)}) → n=${pick.n} meanReward=${pick.meanReward.toFixed(3)}`,
          policy: "learned",
          explored: true,
        };
      }
    }
    // Exploit: the best arm.
    return {
      candidate: best.candidate,
      routeKey: band,
      reason: `learned/${band}: best arm meanReward=${best.meanReward.toFixed(3)} (n=${best.n})`,
      policy: "learned",
      explored: false,
    };
  };

  return {
    route(signals: TierSignals, seed = "", seq = signals.turnIndex): PolicyDecision {
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
      return decideLearned(signals, seed, seq);
    },
    candidates(): readonly PoolCandidate[] {
      return candidates;
    },
    escalation(): PoolCandidate {
      return strongest();
    },
  };
}
