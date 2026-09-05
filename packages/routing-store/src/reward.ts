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
 * On SUCCESS, two sub-scores combine with the quality term (default 1), each
 * in `[0,1]`:
 *   - cost     = costRef / (costRef + costUsd)      (0.5 at the reference cost)
 *   - latency  = latRef  / (latRef  + latencyMs)    (0.5 at the reference latency)
 *
 * The reward is the objective-weighted average over the AVAILABLE terms (with
 * quality = `obs.quality ?? 1`, clamped to `[0,1]`). The cost term is dropped
 * (and its weight redistributed) when `costUsd` is unknown — a run without
 * cost accounting still learns on quality + latency rather than pinning every
 * arm to the same cost score.
 *
 * `quality = success` is the default proxy: the delayed grader/rating signals
 * are joined by `crewhaus watchme report --feed-routing` (asynchronously,
 * keyed by `(sessionId, turnNumber, model)`), which records observations
 * carrying the richer `quality` in `[0, 1]` instead of the binary success bit.
 */

/** A single observed model call outcome. */
export type RouteObservation = {
  /** Did the model call complete without a terminal error this turn? */
  readonly success: boolean;
  /**
   * Latency of the model call, in milliseconds. 0.6.0 §7.9 (latency
   * hygiene): on runtime-core's STREAMING path this is the model's own
   * latency — request open → `message_stop`, minus the union of the
   * mid-stream `runTool` spans — so a tool-heavy cheap arm is not penalised
   * for tool time it did not cause. The non-streaming path measured the
   * model call alone already. Wall time stays on the turn (`turn_end`).
   */
  readonly latencyMs: number;
  /**
   * USD cost of the call, when cost accounting is available (runtime-core
   * prices each turn from token usage). Omit when unknown — the reward then
   * folds the cost weight into the remaining terms.
   */
  readonly costUsd?: number;
  /**
   * Delayed graded/rating quality in `[0, 1]`, joined per
   * `(sessionId, turnNumber, model)` — the richer signal the module header
   * reserves. Omitted ⇒ the v1 binary proxy (success ⇒ quality 1) —
   * byte-identical rewards to today.
   */
  readonly quality?: number;
  // ---- 0.6.0 §7.9 / §7.10 — the hybrid-strategy attribution a cascade turn
  // stamps on its member-arm and strategy-arm lines. All optional and never
  // read by `computeReward`: a plain observation is persisted exactly as
  // before (a `v: 1` delta line); a line carrying any of these is `v: 2`.
  /** The strategy stage that produced the call (`"draft"`, `"escalate"`, …). */
  readonly stage?: string;
  /** The `model_pool.strategy` member the observation belongs to (`"cascade"`, …). */
  readonly strategy?: string;
  /**
   * Who the line is attributed to: `"draft"` / `"escalation"` for a member
   * arm's own calls, `"strategy"` for the once-per-turn strategy-arm line
   * (`strategy:<name>`) that folds the whole turn's wall time, spend and
   * final quality.
   */
  readonly attributedTo?: string;
  /**
   * The cascade counterfactual on a REJECTED draft: did the draft score at
   * least as well as the escalation the judge then graded? (`true` means the
   * escalation bought nothing — the signal a cascade needs to learn its
   * threshold.) Absent when the escalation was not graded.
   */
  readonly wouldPass?: boolean;
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
  const qualityScore = Math.min(1, Math.max(0, obs.quality ?? 1));

  const terms: Array<{ readonly w: number; readonly s: number }> = [
    { w: Math.max(0, obj.quality), s: qualityScore },
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
