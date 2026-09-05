/**
 * The floor (§7.10) — the conservative-bandit constraint that keeps a learned
 * policy from exploiting an arm below a pinned quality reference.
 *
 * Required whenever `reward.quality_source: in_loop`. Per routeKey the policy
 * computes a FLOOR ARM (`floor.arm`, else the `strong`-tagged or last-declared
 * candidate). An arm A is EXPLOITABLE only if
 *
 *     LCB(q_A) >= q_floor - tolerance
 *
 * where `LCB` is the Wilson lower bound over A's live judged quality at
 * `floor.confidence` and `q_floor` is the floor arm's live judged mean UNDER
 * THE SAME JUDGE. Same-instrument is the rule: live-vs-live, or
 * eval-pin-vs-eval-pin from the same `gradersHash`, never mixed — this module
 * only ever sees one instrument's numbers, so the caller enforces that. When
 * no non-floor arm is exploitable the policy serves the floor arm and records
 * `reason: "floor-blocked"`; when the floor arm itself has no quality data the
 * check is SUSPENDED for the turn (`status: "unavailable"`) and exploitation
 * stays capped at `explorationRate` (§7.13).
 */

/** Live judged-quality statistics for one arm (the `v:2` line's `qN` / `qMean`). */
export type ArmQuality = {
  readonly armId: string;
  readonly tags?: readonly string[];
  /** Judged observations folded into `qMean`. */
  readonly qN: number;
  /** Mean judged quality in `[0, 1]`. */
  readonly qMean: number;
};

export type FloorConfig = {
  /** The floor arm; default the first `strong`-tagged arm, else the last declared. */
  readonly arm?: string;
  /** Confidence for the Wilson lower bound. Default 0.9. */
  readonly confidence?: number;
  /** How far below the floor mean an arm's LCB may sit. Default 0.02. */
  readonly tolerance?: number;
  /** Tag that names the default floor arm. Default `"strong"`. */
  readonly strongTag?: string;
};

export type FloorVerdict = {
  readonly floorArm: string | undefined;
  /** The floor arm's judged mean; `undefined` when it has no data. */
  readonly floorQuality: number | undefined;
  /** `ok` — the constraint applied; `unavailable` — suspended for this turn. */
  readonly status: "ok" | "unavailable";
  /** Arms the policy may exploit, in declared order (the floor arm is always among them when `ok`). */
  readonly exploitable: readonly string[];
  readonly blocked: readonly {
    readonly armId: string;
    readonly lcb: number;
    readonly reason: string;
  }[];
};

export function checkFloor(arms: readonly ArmQuality[], config: FloorConfig = {}): FloorVerdict {
  const confidence = clamp(config.confidence ?? 0.9, 0.5, 0.999999);
  const tolerance = Math.max(0, config.tolerance ?? 0.02);
  const strongTag = config.strongTag ?? "strong";
  const floor =
    (config.arm !== undefined ? arms.find((a) => a.armId === config.arm) : undefined) ??
    arms.find((a) => (a.tags ?? []).includes(strongTag)) ??
    arms[arms.length - 1];

  if (floor === undefined) {
    return {
      floorArm: undefined,
      floorQuality: undefined,
      status: "unavailable",
      exploitable: arms.map((a) => a.armId),
      blocked: [],
    };
  }
  if (floor.qN <= 0) {
    return {
      floorArm: floor.armId,
      floorQuality: undefined,
      status: "unavailable",
      exploitable: arms.map((a) => a.armId),
      blocked: [],
    };
  }
  const z = normalQuantile(1 - (1 - confidence) / 2);
  const threshold = floor.qMean - tolerance;
  const exploitable: string[] = [];
  const blocked: { armId: string; lcb: number; reason: string }[] = [];
  for (const a of arms) {
    if (a.armId === floor.armId) {
      exploitable.push(a.armId);
      continue;
    }
    const lcb = a.qN > 0 ? wilsonLowerBound(a.qMean, a.qN, z) : 0;
    if (lcb >= threshold) exploitable.push(a.armId);
    else {
      blocked.push({
        armId: a.armId,
        lcb,
        reason:
          a.qN > 0
            ? `LCB(q)=${lcb.toFixed(3)} < floor ${floor.qMean.toFixed(3)} - ${tolerance} (n=${a.qN})`
            : "no judged quality yet",
      });
    }
  }
  return { floorArm: floor.armId, floorQuality: floor.qMean, status: "ok", exploitable, blocked };
}

/**
 * Wilson score interval lower bound for a proportion `p` over `n` trials at
 * normal quantile `z`. Quality in `[0, 1]` is treated as a proportion — the
 * bound is conservative for bounded scores, which is the direction the floor
 * wants.
 */
export function wilsonLowerBound(p: number, n: number, z: number): number {
  if (n <= 0) return 0;
  const pHat = clamp(p, 0, 1);
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = pHat + z2 / (2 * n);
  const margin = z * Math.sqrt((pHat * (1 - pHat)) / n + z2 / (4 * n * n));
  return clamp((centre - margin) / denominator, 0, 1);
}

/**
 * Inverse of the standard normal CDF (Acklam's rational approximation,
 * relative error ~1.15e-9) — enough to turn `floor.confidence` into a `z`
 * without a statistics dependency.
 */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`normalQuantile: p must be in (0, 1), got ${p}`);
  const [a0, a1, a2, a3, a4, a5] = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ] as const;
  const [b0, b1, b2, b3, b4] = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ] as const;
  const [c0, c1, c2, c3, c4, c5] = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ] as const;
  const [d0, d1, d2, d3] = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416,
  ] as const;
  const low = 0.02425;
  const high = 1 - low;
  const tail = (q: number): number =>
    (((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) /
    ((((d0 * q + d1) * q + d2) * q + d3) * q + 1);
  if (p < low) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > high) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a0 * r + a1) * r + a2) * r + a3) * r + a4) * r + a5) * q) /
    (((((b0 * r + b1) * r + b2) * r + b3) * r + b4) * r + 1)
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
