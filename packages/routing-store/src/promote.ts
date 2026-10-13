/**
 * 0.6.0 §6.3 / §7.8 (PR 14) — PROMOTION: folding an observe-only lane's
 * evidence into the live arms it audited.
 *
 * `q:<band>` (the offline `watchme report --feed-routing` join) and
 * `shadow:<scope>/<band>` (the online `strategy.shadow` audition) are
 * namespaces the runtime router never mints and never reads, so recording
 * into them observes quality without steering a single live decision. That is
 * deliberate: PR 9d/PR 10 decided committee and shadow MEMBER arms do NOT
 * fold into live arms on their own. Promotion is the ONE sanctioned path out
 * of the lane, and it is gated — `crewhaus route promote` refuses unless a
 * routed (`as-declared`) eval with a pinned seed and a frozen arm snapshot
 * passed its baseline gate — and audited (`routing_promotion`).
 *
 * THE TWO LANES DO NOT FOLD THE SAME WAY, because they are not the same kind
 * of evidence. A promotion must never count one measurement twice (§7.10's
 * Wilson lower bound reads `n` as independent evidence), and must never mix
 * instruments ("live-vs-live, or eval-pin-vs-eval-pin from the same
 * gradersHash, never mixed").
 *
 *   - `shadow:` is NEW evidence for the audition candidate — an arm that
 *     never served live — so its line is carried WHOLE (reward, latency,
 *     cost, quality). Its `primary` side is NOT: the arm that served the turn
 *     already recorded it live through `recordPoolOutcome`, and its lane
 *     `quality` is a pairwise blind verdict (0 / 0.5 / 1), not an absolute
 *     judged score. Both sides are stamped (`at`:
 *     {@link SHADOW_LANE_SHADOW_ARM} / {@link SHADOW_LANE_PRIMARY_ARM}) so
 *     the fold can tell them apart; the primary side stays in the lane, where
 *     `route status --shadow` reads it as the audition's other half.
 *   - `q:` is a RE-OBSERVATION of turns the live arm already recorded: the
 *     offline join keys on the durable `model_route` line's own routeKey and
 *     profile — exactly the `(routeKey, armId)` pair `recordPoolOutcome` used
 *     at call time — so copying the line whole would double `n`, the latency
 *     sum and the cost sum for every graded turn. It folds as a QUALITY
 *     BACK-FILL instead: an aggregate line with `n: 0` carrying only
 *     `qs`/`qn`/`qm2`, which `applyLine` adds through `combineQuality` while
 *     `combineAggregate(arm, 0, …)` returns early and leaves the reward,
 *     latency and cost accumulators untouched.
 *
 * The fold is a SINGLE-WRITER maintenance op, the same class as `compact()`:
 * every lane line that has not been promoted before is folded under the live
 * routeKey (the lane prefix stripped) and the ORIGINAL is stamped `pm: 1` so
 * a second `route promote` can never double-count it. Two properties follow:
 *
 *   - the lane keeps its own history, so `route status` still shows what the
 *     audition measured after it was promoted; and
 *   - promotion is idempotent — re-running it folds nothing, and folds only
 *     the DELTA once the lane has accumulated new observations.
 *
 * The folded copy carries NO `pf` lineage stamp. A lane line is stamped with
 * the lineage in force when it was recorded, and the fingerprint covers
 * `reward.quality_source` — so §6.3's documented workflow (`shadow` → `route
 * promote` → `quality_source: promoted`) would flip the lineage and make
 * `applyLine` discard every line the promotion had just written, permanently:
 * the sources are already stamped `pm: 1` and can never be re-folded. An
 * unstamped line is always kept, which is the honest semantics for a
 * deliberate, gated, operator-authorized carry ACROSS a lineage boundary.
 *
 * `route freeze` is a kill switch, so it stops this too: while the marker
 * exists the scoreboard is read-only ("no new observation moves an arm"), and
 * a fold that writes `arms.jsonl` directly would otherwise walk straight past
 * it. `promoteLanes` refuses under a marker and reports the pinned
 * `policyVersion`; `crewhaus route promote` refuses before it even resolves
 * the gate.
 *
 * `pm` and `pr` (the copy's provenance stamp naming the lane it came from)
 * are unknown fields to `applyLine`, which reads only `k`/`m`/`agg`/`n`/`r`/
 * `l`/`c`/`q`/`pf` — so a 0.5.x reader and this package's own reader both
 * fold a promoted line exactly as they fold any other line.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readRouteFreeze } from "./freeze.js";
import {
  QUALITY_LANE_PREFIX,
  SHADOW_LANE_PREFIX,
  SHADOW_LANE_PRIMARY_ARM,
  isObserveOnlyLane,
} from "./lanes.js";
import { ARMS_REL } from "./scoreboard.js";
import { writeStoreFile } from "./store-io.js";

/** The marker stamped on a lane line once it has been folded into a live arm. */
export const PROMOTED_MARKER = "pm";
/** The provenance stamp on the folded COPY: the lane routeKey it came from. */
export const PROMOTED_FROM = "pr";

/** What a lane's evidence contributes to the live arm it audited. */
export type PromotedCarry =
  /** The whole observation — reward, latency, cost and quality (`shadow:`). */
  | "full"
  /** The judged quality alone, as an `n: 0` aggregate back-fill (`q:`). */
  | "quality";

/** One lane arm's contribution to a promotion. */
export type LanePromotion = {
  /** The observe-only routeKey the evidence was recorded under (`q:hard`). */
  readonly from: string;
  /** The live routeKey it folds into (`hard`). */
  readonly to: string;
  /** The arm id (a `models:` profile name, else the spec model string). */
  readonly model: string;
  /** Lines folded into the live arm (deltas + aggregates). */
  readonly lines: number;
  /** How much of each line was carried — see {@link PromotedCarry}. */
  readonly carried: PromotedCarry;
  /**
   * What those lines add to the live arm: reward observations for a `full`
   * carry (`1` per delta, `n` per aggregate), judged-quality observations for
   * a `quality` back-fill (which adds no reward observation at all).
   */
  readonly observations: number;
  /** Mean judged quality across the promoted evidence, when any carried one. */
  readonly meanQuality?: number;
};

export type PromoteResult = {
  /** Per lane arm, sorted by `from` then `model`. */
  readonly promotions: readonly LanePromotion[];
  /** Total lane lines folded. */
  readonly lines: number;
  /** Lane lines skipped because an earlier promotion already folded them. */
  readonly alreadyPromoted: number;
  /** Absolute path of the backing file. */
  readonly path: string;
  /** True when `dryRun` kept the file untouched. */
  readonly dryRun: boolean;
  /**
   * Set when `route freeze` pinned the policy: nothing was folded and nothing
   * was written, whatever the lanes hold.
   */
  readonly frozenPolicyVersion?: string;
};

export type PromoteOptions = {
  /** Compute the fold and report it without writing anything. */
  readonly dryRun?: boolean;
  /** Clock for the promotion timestamp stamped on each folded line. */
  readonly now?: () => number;
};

/** The live routeKey a lane key audits (`q:hard` → `hard`). */
export function liveRouteKeyOf(laneRouteKey: string): string | undefined {
  if (laneRouteKey.startsWith(QUALITY_LANE_PREFIX)) {
    return laneRouteKey.slice(QUALITY_LANE_PREFIX.length);
  }
  if (laneRouteKey.startsWith(SHADOW_LANE_PREFIX)) {
    return laneRouteKey.slice(SHADOW_LANE_PREFIX.length);
  }
  return undefined;
}

/** Per-lane-arm accumulator while the file is walked. */
type Acc = {
  from: string;
  to: string;
  model: string;
  carried: PromotedCarry;
  lines: number;
  observations: number;
  qSum: number;
  qN: number;
};

/** The judged quality a lane line carries, as a Welford-combinable triple. */
type LaneQuality = { readonly sum: number; readonly n: number; readonly m2: number };

function laneQualityOf(rec: Record<string, unknown>): LaneQuality | undefined {
  if (rec["agg"] === 1) {
    const qn = rec["qn"];
    const qs = rec["qs"];
    if (typeof qn !== "number" || qn <= 0 || typeof qs !== "number") return undefined;
    return { sum: qs, n: qn, m2: typeof rec["qm2"] === "number" ? rec["qm2"] : 0 };
  }
  const q = rec["q"];
  if (typeof q !== "number" || !Number.isFinite(q)) return undefined;
  return { sum: Math.min(1, Math.max(0, q)), n: 1, m2: 0 };
}

/** The reward observations a lane line carries (`1` per delta, `n` per aggregate). */
function laneObservationsOf(rec: Record<string, unknown>): number {
  if (rec["agg"] !== 1) return 1;
  return typeof rec["n"] === "number" ? Math.max(0, rec["n"]) : 0;
}

/**
 * Fold every not-yet-promoted `q:` / `shadow:` line into the live arm it
 * audits. Returns what was (or, under `dryRun`, would be) folded. A missing
 * store, or one with no lane lines left to promote, is a no-op that reports
 * zero — never an error, so a scheduled promotion is safe to re-run. A
 * `route freeze` marker is likewise a no-op, reported through
 * `frozenPolicyVersion`.
 */
export function promoteLanes(rootDir: string, opts: PromoteOptions = {}): PromoteResult {
  const path = join(rootDir, ARMS_REL);
  const now = opts.now ?? Date.now;
  const dryRun = opts.dryRun ?? false;
  const empty: PromoteResult = {
    promotions: [],
    lines: 0,
    alreadyPromoted: 0,
    path,
    dryRun,
  };
  // §6.3 / §10.1 — the kill switch. `promoteLanes` writes `arms.jsonl`
  // directly rather than through the frozen `Scoreboard`, so the marker has
  // to be honoured here too or the one verb whose purpose is changing which
  // model serves would be the one verb that ignores the freeze.
  const freeze = readRouteFreeze(rootDir);
  if (freeze !== undefined) return { ...empty, frozenPolicyVersion: freeze.policyVersion };
  if (!existsSync(path)) return empty;

  const out: string[] = [];
  const accs = new Map<string, Acc>();
  let folded = 0;
  let touched = 0;
  let alreadyPromoted = 0;
  const stamp = now();

  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      out.push(line); // a torn line from a crashed writer survives verbatim
      continue;
    }
    const from = typeof rec["k"] === "string" ? rec["k"] : undefined;
    const model = typeof rec["m"] === "string" ? rec["m"] : undefined;
    if (from === undefined || model === undefined || !isObserveOnlyLane(from)) {
      out.push(line);
      continue;
    }
    if (rec[PROMOTED_MARKER] === 1) {
      alreadyPromoted += 1;
      out.push(line);
      continue;
    }
    const to = liveRouteKeyOf(from);
    // A lane prefix with nothing after it names no live arm — leave it alone
    // rather than folding evidence into an empty routeKey.
    if (to === undefined || to.length === 0) {
      out.push(line);
      continue;
    }
    // The PRIMARY side of an audition: the live arm already recorded this
    // turn, and the lane's `quality` is a pairwise verdict rather than an
    // absolute judged score. It stays in the lane, unstamped, so
    // `route status --shadow` keeps both halves of the comparison.
    if (rec["at"] === SHADOW_LANE_PRIMARY_ARM) {
      out.push(line);
      continue;
    }
    const carried: PromotedCarry = from.startsWith(QUALITY_LANE_PREFIX) ? "quality" : "full";
    const quality = laneQualityOf(rec);
    // A `q:` line with no judged quality carries nothing the live arm does
    // not already hold (it re-observed a turn the runtime recorded): stamp it
    // so it is never revisited, and fold nothing.
    if (carried === "quality" && quality === undefined) {
      out.push(JSON.stringify({ ...rec, [PROMOTED_MARKER]: 1 }));
      touched += 1;
      continue;
    }
    // The fold. `pr` records where it came from; `pf` is deliberately DROPPED
    // (see the module header) so a later `quality_source` flip cannot discard
    // the promoted evidence. Both stamps are unknown fields to every reader.
    const { pf: _lineage, ...withoutLineage } = rec;
    // `quality` is always defined on the `quality` carry (guarded above); the
    // check is what narrows it for the back-fill line's `qs`/`qn`/`qm2`.
    const copy: Record<string, unknown> =
      carried === "quality" && quality !== undefined
        ? {
            v: 2,
            agg: 1,
            k: to,
            m: model,
            n: 0,
            qs: quality.sum,
            qn: quality.n,
            qm2: quality.m2,
            [PROMOTED_FROM]: from,
            t: stamp,
          }
        : { ...withoutLineage, k: to, [PROMOTED_FROM]: from, t: stamp };
    // The source line, stamped so no later promotion folds it twice.
    out.push(JSON.stringify({ ...rec, [PROMOTED_MARKER]: 1 }));
    out.push(JSON.stringify(copy));
    folded += 1;
    touched += 1;

    const accKey = `${from} ${model}`;
    const acc = accs.get(accKey) ?? {
      from,
      to,
      model,
      carried,
      lines: 0,
      observations: 0,
      qSum: 0,
      qN: 0,
    };
    acc.lines += 1;
    acc.observations += carried === "full" ? laneObservationsOf(rec) : (quality?.n ?? 0);
    if (quality !== undefined) {
      acc.qN += quality.n;
      acc.qSum += quality.sum;
    }
    accs.set(accKey, acc);
  }

  if (touched > 0 && !dryRun) {
    // Write-then-rename, the `compact()` contract: a concurrent reader sees
    // either the old file or the new one, never a half-written fold. The temp
    // is random and never followed through a planted link (0.7.1).
    writeStoreFile(rootDir, ARMS_REL, `${out.join("\n")}\n`);
  }

  const promotions = [...accs.values()]
    .sort((a, b) => a.from.localeCompare(b.from) || a.model.localeCompare(b.model))
    .map((a) => ({
      from: a.from,
      to: a.to,
      model: a.model,
      carried: a.carried,
      lines: a.lines,
      observations: a.observations,
      ...(a.qN > 0 ? { meanQuality: a.qSum / a.qN } : {}),
    }));
  return { promotions, lines: folded, alreadyPromoted, path, dryRun };
}
