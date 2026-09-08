/**
 * 0.6.0 (design §7.8, §7.9) — the OBSERVE-ONLY routeKey lanes.
 *
 * The runtime's `PolicyRouter` mints routeKeys from its band vocabulary
 * (`hard` | `easy`, scoped from PR 10 on) and reads arms back under exactly
 * those keys. Two namespaces sit BESIDE them and are never minted or read by
 * the router, so recording into them observes quality without steering a
 * single live decision:
 *
 *   - `q:<routeKey>` — the OFFLINE join: `crewhaus watchme report
 *     --feed-routing` folds delayed judge / rating quality onto the arm that
 *     served each turn (`@crewhaus/watchme-store`'s `joinQualityToArms`).
 *   - `shadow:<scope>/<band>` — the ONLINE audition lane (this file): a
 *     `strategy.shadow` candidate re-runs a sampled share of turns after the
 *     primary has answered, is graded BLIND against the primary with
 *     order-swapped pairwise judging, and both arms record their verdict here
 *     under the primary's routeKey — the online generalisation of the `q:`
 *     lane. Nothing the shadow says reaches the user, and a shadow arm's
 *     strength never seeds the live policy: it surfaces through
 *     `route status --shadow` and the audition proposal (§9), and folds into
 *     live arms only through `route promote` (PR 14).
 *
 * The separator is safe: `scope` names come from the spec's `safeName`, which
 * admits neither `|` (the arm-key separator) nor `/` (the band separator).
 */

/** The offline quality lane prefix (`watchme report --feed-routing`). */
export const QUALITY_LANE_PREFIX = "q:";

/** The online audition lane prefix (`strategy.shadow`). */
export const SHADOW_LANE_PREFIX = "shadow:";

/**
 * The shadow-lane routeKey for one graded turn: `shadow:<scope>/<band>` when
 * the pool is scoped (a workflow step, a graph node, a crew role), else
 * `shadow:<band>`. `band` is the primary's own routeKey for the turn, so the
 * shadow's verdict lands beside the decision it audits.
 */
export function shadowRouteKey(band: string, scope?: string): string {
  return scope !== undefined && scope.length > 0
    ? `${SHADOW_LANE_PREFIX}${scope}/${band}`
    : `${SHADOW_LANE_PREFIX}${band}`;
}

/** True when `routeKey` sits in an observe-only lane (`q:` or `shadow:`). */
export function isObserveOnlyLane(routeKey: string): boolean {
  return routeKey.startsWith(QUALITY_LANE_PREFIX) || routeKey.startsWith(SHADOW_LANE_PREFIX);
}

/**
 * The `attributedTo` stamp on the SHADOW side of one audition — the candidate
 * that re-ran the turn and never reached the user. `route promote` folds
 * these into the live arm: they are evidence the live arm does not already
 * hold.
 */
export const SHADOW_LANE_SHADOW_ARM = "shadow";

/**
 * The `attributedTo` stamp on the PRIMARY side of one audition — the arm that
 * actually served the turn, and therefore already recorded it live through
 * `recordPoolOutcome`. `route promote` SKIPS these: folding one would add a
 * second observation for a turn the live arm counted once, and would mix a
 * pairwise blind-judging verdict into an absolute judged-quality mean (§7.10:
 * "same-instrument is the rule"). The stamp is what makes the two sides
 * distinguishable at all — nothing else on the line separates them.
 */
export const SHADOW_LANE_PRIMARY_ARM = "primary";

/**
 * The blind pairwise verdict folded into the two shadow-lane observations —
 * one for the shadow arm, one for the primary it was graded against. A win is
 * quality 1 for the winner and 0 for the loser; a tie (which order-swapped
 * judging ALSO yields on a position-biased disagreement) is 0.5 for both, so
 * a tie is never counted as a win for either side.
 */
export function shadowLaneQuality(verdict: "shadow" | "primary" | "tie"): {
  readonly shadow: number;
  readonly primary: number;
} {
  if (verdict === "shadow") return { shadow: 1, primary: 0 };
  if (verdict === "primary") return { shadow: 0, primary: 1 };
  return { shadow: 0.5, primary: 0.5 };
}
