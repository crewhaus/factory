/**
 * The reward function for `model_pool` learned routing.
 *
 * A pure map from one observed model call to a scalar in `[0, 1]` — higher is
 * better (successful, cheap, fast). The `PolicyRouter`'s `learned` policy
 * maximises the per-arm mean of this reward, so the learning objective lives
 * ENTIRELY here: it is deterministic, side-effect free, and reproducible from
 * the persisted observation.
 *
 * A FAILED turn scores 0 outright — regardless of how fast or cheap it failed.
 * This is deliberate: crediting a fast failure on the latency axis would let a
 * frequently-failing-but-quick model out-score a slower, reliable one, so the
 * reward must not reward failing quickly.
 *
 * On SUCCESS, two sub-scores combine (quality is implicitly 1), each in `[0,1]`:
 *   - cost     = costRef / (costRef + costUsd)      (0.5 at the reference cost)
 *   - latency  = latRef  / (latRef  + latencyMs)    (0.5 at the reference latency)
 *
 * The reward is the objective-weighted average over the AVAILABLE terms (with
 * quality fixed at 1). The cost term is dropped (and its weight redistributed)
 * when `costUsd` is unknown — a run without cost accounting still learns on
 * quality + latency rather than pinning every arm to the same cost score.
 *
 * `quality = success` is a deliberate v1 proxy: the delayed grader/rating
 * signals the FR describes join later (they arrive asynchronously, keyed by
 * `(sessionId, turnNumber, model)`), at which point a graded observation can
 * carry a richer `quality` in `[0, 1]` instead of the binary success bit.
 */

/** A single observed model call outcome. */
export type RouteObservation = {
  /** Did the model call complete without a terminal error this turn? */
  readonly success: boolean;
  /** Wall-clock latency of the model call, in milliseconds. */
  readonly latencyMs: number;
  /**
   * USD cost of the call, when cost accounting is available (runtime-core
   * prices each turn from token usage). Omit when unknown — the reward then
   * folds the cost weight into the remaining terms.
   */
  readonly costUsd?: number;
};

/** Weights over the reward's component terms. Missing terms default sensibly. */
export type RouteObjective = {
  readonly quality?: number;
  readonly cost?: number;
  readonly latency?: number;
};

/** Reward tuning. All optional; the defaults match the FR's stated objective. */
export type RewardConfig = {
  readonly objective?: RouteObjective;
  /** Cost (USD) at which the cost sub-score is 0.5. Default 0.01. */
  readonly costRefUsd?: number;
  /** Latency (ms) at which the latency sub-score is 0.5. Default 5000. */
  readonly latencyRefMs?: number;
};

/** The default objective: quality-dominant, then cost, then latency. */
export const DEFAULT_OBJECTIVE: Required<RouteObjective> = {
  quality: 0.7,
  cost: 0.2,
  latency: 0.1,
};

const DEFAULT_COST_REF_USD = 0.01;
const DEFAULT_LATENCY_REF_MS = 5000;

/**
 * Map one observation to a reward in `[0, 1]`. See the module header for the
 * scoring model. Negative objective weights are clamped to 0; an all-zero
 * objective falls back to pure quality so the reward is never `NaN`.
 */
export function computeReward(obs: RouteObservation, config: RewardConfig = {}): number {
  // A failed turn is worthless — never credit a fast/cheap failure.
  if (!obs.success) return 0;

  const obj = { ...DEFAULT_OBJECTIVE, ...(config.objective ?? {}) };
  const costRef = config.costRefUsd ?? DEFAULT_COST_REF_USD;
  const latRef = config.latencyRefMs ?? DEFAULT_LATENCY_REF_MS;

  const latencyScore = latRef / (latRef + Math.max(0, obs.latencyMs));

  const terms: Array<{ readonly w: number; readonly s: number }> = [
    { w: Math.max(0, obj.quality), s: 1 }, // quality is 1 on the success path
    { w: Math.max(0, obj.latency), s: latencyScore },
  ];
  if (obs.costUsd !== undefined) {
    const costScore = costRef / (costRef + Math.max(0, obs.costUsd));
    terms.push({ w: Math.max(0, obj.cost), s: costScore });
  }

  const totalWeight = terms.reduce((acc, t) => acc + t.w, 0);
  // All-zero (or all-negative) objective → the weighted average is undefined;
  // a successful turn falls back to full quality rather than emitting NaN.
  if (totalWeight <= 0) return 1;
  return terms.reduce((acc, t) => acc + t.w * t.s, 0) / totalWeight;
}
