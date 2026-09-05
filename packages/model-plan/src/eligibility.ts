import { unmetRequirement } from "./advertisement.js";
/**
 * N1 — capability-eligibility routing (§7.11), fully deterministic.
 *
 * Per turn `preRoute` computes the turn's REQUIREMENT VECTOR — image blocks
 * present, the context size already available as `contextTokenSignal`, the
 * tools called last turn, the tools a matched rule demands — and intersects
 * it with each candidate's features / declared `requires`, breaker state,
 * `enabled` flag and remaining per-profile `cost.max_usd`, producing
 * `eligible[]`. The policy chooses among eligible candidates and the
 * CHEAPEST eligible wins ties (`cheapestEligible`). Because `eligible[]` is
 * persisted on the route line, every decision replays exactly; because it
 * needs zero model trust, it is the one escalation mechanism that can never
 * be steered by content.
 *
 * The exclusion vocabulary is closed and persisted verbatim, so `route
 * explain` can print why an arm sat out.
 */
import type { CandidateCapabilities, FeatureRequirement } from "./types.js";

/** One roster candidate as the eligibility check sees it at turn time. */
export type EligibilityCandidate = {
  readonly armId: string;
  readonly capabilities?: CandidateCapabilities;
  /** The profile's own declared requirement of its model. */
  readonly requires?: FeatureRequirement;
  readonly enabled?: boolean;
  /** `@crewhaus/circuit-breaker` state; `"open"` is ineligible. */
  readonly breakerState?: "closed" | "open" | "half_open";
  readonly costCapUsdMicros?: number;
  readonly spentUsdMicros?: number;
  /** Price scalar for the cheapest-eligible tie-break (blended $/1M); unknown ⇒ ranked after known. */
  readonly blendedPer1M?: number;
};

/** What THIS turn needs from whichever candidate serves it. */
export type TurnRequirement = {
  readonly hasImages?: boolean;
  /** The transcript size the candidate's context window must hold. */
  readonly contextTokens?: number;
  /** Tools that will be advertised (or were just called) — needs `tool_use`. */
  readonly toolsInPlay?: boolean;
  /** A capability requirement a matched rule demands (`use: { requires }`). */
  readonly requires?: FeatureRequirement;
};

export type EligibilityExclusionReason =
  | "disabled"
  | "breaker-open"
  | "cost-cap-spent"
  | "no-adapter-features"
  | `requires:${string}`
  | `self-requires:${string}`
  | "context-window";

export type EligibilityResult = {
  /** Eligible arm ids in DECLARED order. */
  readonly eligible: readonly string[];
  readonly excluded: readonly {
    readonly armId: string;
    readonly reason: EligibilityExclusionReason;
  }[];
};

export type EligibleCandidatesOptions = {
  /**
   * Headroom the context window must leave above the transcript, as a
   * fraction of the window (the reply and the tool results need room).
   * Default 0.1 — a 200k window serves a transcript up to 180k tokens.
   */
  readonly contextHeadroomRatio?: number;
};

export function eligibleCandidates(
  candidates: readonly EligibilityCandidate[],
  turn: TurnRequirement,
  opts: EligibleCandidatesOptions = {},
): EligibilityResult {
  const headroom = Math.min(0.9, Math.max(0, opts.contextHeadroomRatio ?? 0.1));
  const eligible: string[] = [];
  const excluded: { armId: string; reason: EligibilityExclusionReason }[] = [];

  for (const c of candidates) {
    const reason = exclusionReason(c, turn, headroom);
    if (reason === undefined) eligible.push(c.armId);
    else excluded.push({ armId: c.armId, reason });
  }
  return { eligible, excluded };
}

function exclusionReason(
  c: EligibilityCandidate,
  turn: TurnRequirement,
  headroom: number,
): EligibilityExclusionReason | undefined {
  if (c.enabled === false) return "disabled";
  if (c.breakerState === "open") return "breaker-open";
  if (
    c.costCapUsdMicros !== undefined &&
    c.spentUsdMicros !== undefined &&
    c.spentUsdMicros >= c.costCapUsdMicros
  ) {
    return "cost-cap-spent";
  }
  // The profile's own requirement of its model — validated at compile time
  // for table-backed providers, re-checked here against the live adapter.
  const selfUnmet = unmetRequirement(c.requires, c.capabilities);
  if (selfUnmet !== undefined) return `self-requires:${selfUnmet}`;

  const turnReq: FeatureRequirement = {
    ...(turn.requires ?? {}),
    ...(turn.hasImages === true ? { vision: true } : {}),
    ...(turn.toolsInPlay === true ? { tool_use: true } : {}),
  };
  if (Object.keys(turnReq).length > 0) {
    if (c.capabilities?.features === undefined && needsFeatures(turnReq)) {
      return "no-adapter-features";
    }
    const unmet = unmetRequirement(turnReq, c.capabilities);
    if (unmet !== undefined) return `requires:${unmet}`;
  }
  // A candidate whose context window cannot hold the transcript is
  // ineligible rather than a request-time error. An UNKNOWN window is not a
  // veto — most rosters are hosted models the table covers; a local model
  // declares `capabilities.contextWindow` to opt into the check.
  const window = c.capabilities?.contextWindow;
  if (turn.contextTokens !== undefined && window !== undefined) {
    if (turn.contextTokens > window * (1 - headroom)) return "context-window";
  }
  return undefined;
}

function needsFeatures(req: FeatureRequirement): boolean {
  return (
    req.tool_use === true ||
    req.vision === true ||
    req.thinking === true ||
    req.web_search === true ||
    req.caching === "explicit" ||
    req.caching === "automatic"
  );
}

/**
 * The tie-break: among the eligible arms, the one with the lowest known
 * blended price; unknown prices rank after known ones; ties keep declared
 * order (the first wins). `undefined` when nothing is eligible.
 */
export function cheapestEligible(
  result: EligibilityResult,
  candidates: readonly EligibilityCandidate[],
): string | undefined {
  let best: EligibilityCandidate | undefined;
  for (const armId of result.eligible) {
    const c = candidates.find((x) => x.armId === armId);
    if (c === undefined) continue;
    if (best === undefined) {
      best = c;
      continue;
    }
    const price = c.blendedPer1M;
    const bestPrice = best.blendedPer1M;
    if (bestPrice === undefined && price !== undefined) best = c;
    else if (price !== undefined && bestPrice !== undefined && price < bestPrice) best = c;
  }
  return best?.armId;
}

/**
 * The roster-first "strongest" pick (§4.3, §7.10 default floor arm): the
 * first arm carrying `strongTag`, else the last declared — the convention
 * `PolicyRouter.escalation()` uses. `undefined` for an empty roster.
 */
export function strongestArm<
  T extends { readonly armId: string; readonly tags?: readonly string[] },
>(roster: readonly T[], strongTag = "strong"): T | undefined {
  return roster.find((a) => (a.tags ?? []).includes(strongTag)) ?? roster[roster.length - 1];
}
