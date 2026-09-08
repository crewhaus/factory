/**
 * 0.6.0 §7.8 / §9.1 — telling the shadow lane's two sides apart, for every
 * surface that reads an audition.
 *
 * A `strategy.shadow` audition records BOTH halves of one comparison in the
 * lane, under the primary's routeKey: the candidate that re-ran the turn and
 * never reached the user, and the incumbent it was blind-judged against.
 * `@crewhaus/routing-store`'s `lanes.ts` is explicit that the `at` stamp on
 * the raw line "is what makes the two sides distinguishable at all — nothing
 * else on the line separates them", and `ArmStats` does not carry it.
 *
 * So a consumer holding only the scoreboard snapshot must NOT guess. Guessing
 * by evidence ("the lane arm with the most observations is the candidate")
 * fails in the ordinary case: each graded turn writes one observation per
 * side, so the two counts move together and the INCUMBENT wins the guess as
 * often as the candidate. The consequences are real — an audition proposal
 * naming the incumbent as the challenger, an arm compared against itself, a
 * pairwise lane mean (0/0.5/1) folded into an absolute live mean, and a
 * `shadowN` that double-counts every turn and so trips a power floor at half
 * the evidence it names.
 *
 * The discriminant, in order of authority:
 *
 *   1. the recorded `at` stamp (`readShadowLaneSides`), where the caller has
 *      the harness directory to read;
 *   2. the spec's declared `model_pool.strategy.shadow.candidate` — the arm
 *      id the runtime auditions (its `models:` profile name when profiled,
 *      else the model string), available to the pure rules;
 *   3. a lane holding exactly ONE arm id: only one side ever recorded, so
 *      there is nothing to confuse it with.
 *
 * When none of those answers, the lane is UNATTRIBUTED and every consumer
 * here says so rather than proposing on a coin flip.
 */
import type { ArmStats, ShadowLaneSides } from "@crewhaus/routing-store";
import { QUALITY_LANE_PREFIX, SHADOW_LANE_PREFIX } from "@crewhaus/routing-store";

/** The lane split into the audition's two sides. */
export type ShadowLaneSplit = {
  /** The candidate arm id, when the lane can be attributed. */
  readonly candidateArm?: string;
  /** Lane rows belonging to the candidate side (empty when unattributed). */
  readonly candidateArms: ReadonlyArray<ArmStats>;
  /** Lane rows belonging to the incumbent side — never the candidate's. */
  readonly counterpartArms: ReadonlyArray<ArmStats>;
  /** Every lane row, attributed or not. */
  readonly laneArms: ReadonlyArray<ArmStats>;
  /** Why the lane could not be attributed (undefined when it could). */
  readonly unattributedReason?: string;
};

export type SplitShadowLaneOptions = {
  /** The `at` stamps read off the raw lines, when the caller has them. */
  readonly sides?: ShadowLaneSides;
  /** The spec's declared `strategy.shadow.candidate` arm id. */
  readonly declaredCandidate?: string;
};

/** Every arm outside the observe-only lanes — the LIVE bands. */
export function liveArmsOf(arms: ReadonlyArray<ArmStats>): ArmStats[] {
  return arms.filter(
    (a) =>
      !a.routeKey.startsWith(SHADOW_LANE_PREFIX) && !a.routeKey.startsWith(QUALITY_LANE_PREFIX),
  );
}

/** The shadow-lane rows of a scoreboard snapshot. */
export function shadowLaneArmsOf(arms: ReadonlyArray<ArmStats>): ArmStats[] {
  return arms.filter((a) => a.routeKey.startsWith(SHADOW_LANE_PREFIX));
}

/**
 * Split the shadow lane into the audition candidate's rows and the
 * incumbent's, using the strongest discriminant the caller could supply.
 */
export function splitShadowLane(
  arms: ReadonlyArray<ArmStats>,
  opts: SplitShadowLaneOptions = {},
): ShadowLaneSplit {
  const laneArms = shadowLaneArmsOf(arms);
  const empty = { candidateArms: [], counterpartArms: [], laneArms };
  if (laneArms.length === 0) {
    return { ...empty, unattributedReason: "the shadow lane has no arms" };
  }
  const ids = [...new Set(laneArms.map((a) => a.model))];

  const stamped = [...(opts.sides?.shadow ?? [])].filter((id) => ids.includes(id));
  if (stamped.length > 0) {
    // The recorded stamp wins. More than one candidate id in one lane means
    // several auditions ran into it; the one with the most evidence is the
    // audition being read, and every other arm is on the other side.
    const chosen = pickByEvidence(laneArms, stamped);
    return splitOn(laneArms, chosen);
  }
  if (opts.declaredCandidate !== undefined && ids.includes(opts.declaredCandidate)) {
    return splitOn(laneArms, opts.declaredCandidate);
  }
  if (ids.length === 1) return splitOn(laneArms, ids[0] as string);
  return {
    ...empty,
    unattributedReason: `the shadow lane holds ${ids.length} arm ids (${ids.join(", ")}) and none of them is stamped as the audition candidate — the lane records BOTH sides of the comparison, so which is the challenger cannot be inferred from the observation counts. Declare \`model_pool.strategy.shadow.candidate\`, or re-run the audition on a build that stamps the lane.`,
  };
}

function pickByEvidence(laneArms: ReadonlyArray<ArmStats>, ids: ReadonlyArray<string>): string {
  const byArm = new Map<string, number>();
  for (const a of laneArms) {
    if (ids.includes(a.model)) byArm.set(a.model, (byArm.get(a.model) ?? 0) + a.n);
  }
  const sorted = [...byArm.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
  return (sorted[0]?.[0] ?? ids[0]) as string;
}

function splitOn(laneArms: ReadonlyArray<ArmStats>, candidateArm: string): ShadowLaneSplit {
  return {
    candidateArm,
    candidateArms: laneArms.filter((a) => a.model === candidateArm),
    counterpartArms: laneArms.filter((a) => a.model !== candidateArm),
    laneArms,
  };
}

/** Total observations recorded for the audition candidate — TURNS, not the
 *  two-per-turn observation count a whole-lane sum reports. */
export function shadowCandidateN(split: ShadowLaneSplit): number {
  return split.candidateArms.reduce((acc, a) => acc + a.n, 0);
}

/**
 * The `strategy.shadow.candidate` ARM ID a pool declares — read off either a
 * RAW spec pool (`candidate: $strong`) or a LOWERED one (the resolved model
 * string plus `candidateProfile`). §7.9 arm identity: a profiled arm is keyed
 * by its profile name, so the profile wins and a `$` prefix is dropped.
 */
export function declaredShadowCandidate(pool: unknown): string | undefined {
  const shadow = (
    pool as
      | { strategy?: { shadow?: { candidate?: unknown; candidateProfile?: unknown } } }
      | undefined
  )?.strategy?.shadow;
  const profile = shadow?.candidateProfile;
  if (typeof profile === "string" && profile.length > 0) return profile;
  const candidate = shadow?.candidate;
  if (typeof candidate !== "string" || candidate.length === 0) return undefined;
  return candidate.startsWith("$") ? candidate.slice(1) : candidate;
}
