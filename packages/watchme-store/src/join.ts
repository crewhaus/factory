/**
 * The pure quality→routing join behind `crewhaus watchme report --feed-routing`.
 *
 * Route decisions (durable `model_route` lines) and delayed quality scores
 * (phase-2 judgments or normalized ratings) meet per `(sessionId, turnNumber)`;
 * the model on the decision names the arm. Emitted rows carry SHADOW routeKeys
 * — `"q:" + originalRouteKey` — a namespace the runtime router never mints or
 * reads, so recording them observes routing quality without steering it.
 * Rewards are computed by the CALLER via routing-store's `computeReward` with
 * `obs.quality` set; this module stays reward-free.
 *
 * 0.6.0 (design §7.8) — this OFFLINE lane has an ONLINE twin: `strategy.shadow`
 * re-runs a sampled share of turns on an audition candidate after the primary
 * has answered, grades it blind against the primary with order-swapped
 * pairwise judging, and records both arms under `shadow:<scope>/<band>`
 * (`@crewhaus/routing-store`'s `shadowRouteKey`). Both lanes are observe-only:
 * the runtime router mints neither prefix and reads neither back, so nothing
 * recorded here steers a live decision until `route promote` folds it.
 */

/** One durable route decision (a `model_route` line, turn-attributed). */
export type RouteDecision = {
  sessionId: string;
  turnNumber: number;
  routeKey: string;
  model: string;
  latencyMs?: number;
  costUsd?: number;
  success: boolean;
};

/** One delayed quality score for a turn, in `[0, 1]` (clamped on join). */
export type TurnQuality = {
  sessionId: string;
  turnNumber: number;
  score: number;
};

/** One shadow-arm row ready for `openScoreboard(...).record(...)`. */
export type QualityArmRow = {
  routeKey: string;
  model: string;
  obs: { success: boolean; latencyMs: number; costUsd?: number; quality: number };
};

/** The offline quality lane prefix (its runtime twin is `shadow:`, see above). */
export const QUALITY_LANE_PREFIX = "q:";
const SHADOW_PREFIX = QUALITY_LANE_PREFIX;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * Join route decisions to quality scores per `(sessionId, turnNumber)`.
 * Decisions without a quality score are dropped (nothing to learn from);
 * multiple scores for the same turn (a rating AND a judgment) average.
 * Row order follows `decisions` order.
 */
export function joinQualityToArms(
  decisions: ReadonlyArray<RouteDecision>,
  quality: ReadonlyArray<TurnQuality>,
): ReadonlyArray<QualityArmRow> {
  const scores = new Map<string, { sum: number; n: number }>();
  for (const q of quality) {
    const key = `${q.sessionId}\u0000${q.turnNumber}`;
    const acc = scores.get(key) ?? { sum: 0, n: 0 };
    acc.sum += clamp01(q.score);
    acc.n += 1;
    scores.set(key, acc);
  }
  const rows: QualityArmRow[] = [];
  for (const d of decisions) {
    const acc = scores.get(`${d.sessionId}\u0000${d.turnNumber}`);
    if (acc === undefined || acc.n === 0) continue;
    const obs: QualityArmRow["obs"] = {
      success: d.success,
      latencyMs: Math.max(0, d.latencyMs ?? 0),
      quality: clamp01(acc.sum / acc.n),
    };
    if (d.costUsd !== undefined) obs.costUsd = d.costUsd;
    rows.push({ routeKey: `${SHADOW_PREFIX}${d.routeKey}`, model: d.model, obs });
  }
  return rows;
}
