/**
 * 0.6.0 §9.1 (loop 1) — `crewhaus route propose`: mine the reward scoreboard
 * (and the installed priors) into `SpecPatch`es on WHITELISTED paths, written
 * as the same `suggestions.json` `crewhaus advise` emits.
 *
 * The whole point is that this verb PROPOSES and never applies. Its output is
 * fed to `crewhaus optimize --from-advice`, which re-validates every patch
 * against `OPTIMIZABLE_PATHS`, compiles it, evals it and accepts it only if
 * `gateRuns` holds — so the path from "the scoreboard learned something" to
 * "the spec changed" runs entirely through the existing eval gate, with the
 * roster untouched on both sides.
 *
 * WHAT IT MAY PROPOSE (every entry an exact `poolDials` member, §10.3):
 *
 *   model_pool.policy                        static/heuristic → learned
 *   model_pool.learning                      block replace adding exploration
 *   model_pool.strategy.shadow.sample_rate   wind an audition down once it has
 *                                            cleared the power floor
 *
 * `rules[i].enabled` is whitelisted too, but is NOT mined here: the
 * scoreboard records `(routeKey, armId)` and never which rule forced a
 * decision. `crewhaus advise`'s `escalation-precision` rule owns that toggle,
 * because the durable `model_route.ruleId` line is where the attribution
 * actually lives.
 *
 * WHAT IT MAY NOT, ever: `candidates` (the roster), `rules[].when` / `.use`
 * (rule targets), `classifier.model` / `labels`, every `strategy.*` model
 * slot, and all of `reward.*` — the floor included. Those are §9.3's
 * human-owned set and reach a spec only through `models propose`'s PR door.
 * `patchOrAdvice` is not used here because every proposal is a patch by
 * construction; instead each candidate patch is run through `validatePatch`
 * and DROPPED (with its reason kept) if the whitelist refuses it, so a drift
 * in either file surfaces as a missing proposal rather than an unsafe one.
 *
 * Pure: arms, priors and the spec come in; proposals go out.
 */
import type { ArmStats } from "@crewhaus/routing-store";
import { isObserveOnlyLane } from "@crewhaus/routing-store";
import type { Spec } from "@crewhaus/spec";
import { type SpecPatch, validatePatch } from "@crewhaus/spec-patch";
import type { AdviceFinding, SuggestionsFile } from "./advise-rules";
import { buildSuggestionsFile } from "./advise-rules";
import { declaredShadowCandidate, shadowCandidateN, splitShadowLane } from "./shadow-lane";

/** One mined proposal: a whitelisted patch plus the evidence behind it. */
export type RouteProposal = {
  readonly id: string;
  readonly summary: string;
  readonly evidence: ReadonlyArray<string>;
  readonly patch: SpecPatch;
};

/** A candidate the proposer considered but refused, and why. */
export type RouteProposalSkip = {
  readonly id: string;
  readonly reason: string;
};

export type RouteProposeResult = {
  readonly proposals: ReadonlyArray<RouteProposal>;
  readonly skipped: ReadonlyArray<RouteProposalSkip>;
};

type PoolView = {
  readonly policy: string;
  readonly candidates: ReadonlyArray<{ readonly model: string }>;
  readonly learning?: {
    readonly minSamplesPerArm?: number;
    readonly explorationRate?: number;
    readonly bandit?: string;
    readonly seed?: string;
  };
  readonly rules?: ReadonlyArray<{ readonly id: string; readonly enabled?: boolean }>;
  readonly strategy?: {
    readonly shadow?: { readonly sample_rate?: number; readonly candidate?: string };
  };
};

/** The primary agent's `model_pool` block off a parsed spec, when it has one. */
export function agentPoolOf(spec: Spec | undefined): PoolView | undefined {
  const agent = (spec as unknown as { agent?: { model_pool?: PoolView } } | undefined)?.agent;
  const pool = agent?.model_pool;
  return pool !== undefined && Array.isArray(pool.candidates) ? pool : undefined;
}

/** Default sample floor when the spec pins none — the router's own default. */
export const DEFAULT_POOL_MIN_SAMPLES = 20;

export type BuildRouteProposalsOptions = {
  readonly spec?: Spec;
  readonly arms: ReadonlyArray<ArmStats>;
  /** Whether the RAW spec YAML carries a key (the `add` vs `replace` choice). */
  readonly specHasPath?: (path: ReadonlyArray<string>) => boolean;
  /** Arm-count floor for "this band is measured". Default: the spec's, else 20. */
  readonly minSamples?: number;
  /** The audition power floor (`DEFAULT_MIN_EXPERIMENT_N`). */
  readonly minAuditionN?: number;
};

/** LIVE arms only — an observe-only lane never justifies a live policy change. */
function liveArms(arms: ReadonlyArray<ArmStats>): ArmStats[] {
  return arms.filter((a) => !isObserveOnlyLane(a.routeKey));
}

/** Bands in which EVERY declared candidate has cleared `floor` observations. */
function bandsWithFullCoverage(
  arms: ReadonlyArray<ArmStats>,
  candidates: ReadonlyArray<{ readonly model: string }>,
  floor: number,
): string[] {
  const bands = [...new Set(arms.map((a) => a.routeKey))];
  return bands
    .filter((band) =>
      candidates.every((c) =>
        arms.some((a) => a.routeKey === band && a.model === c.model && a.n >= floor),
      ),
    )
    .sort();
}

/**
 * Is one band's leader SEPARATED from its runner-up — the leader's 95% lower
 * bound above the runner-up's mean? Coverage alone says "we measured every
 * arm"; separation says "and the measurement distinguishes them", which is
 * the bar for proposing a policy that will exploit the winner.
 */
export function bandSeparation(
  arms: ReadonlyArray<ArmStats>,
  band: string,
): { readonly leader: string; readonly separated: boolean; readonly margin: number } | undefined {
  const inBand = arms.filter((a) => a.routeKey === band && a.n > 0);
  if (inBand.length < 2) return undefined;
  const sorted = [...inBand].sort((x, y) => y.meanReward - x.meanReward);
  const leader = sorted[0] as ArmStats;
  const runnerUp = sorted[1] as ArmStats;
  const lower = leader.meanReward - 1.96 * Math.sqrt(Math.max(leader.varReward, 0) / leader.n);
  return {
    leader: leader.model,
    separated: lower > runnerUp.meanReward,
    margin: lower - runnerUp.meanReward,
  };
}

function keep(
  spec: Spec | undefined,
  patch: SpecPatch,
  proposal: Omit<RouteProposal, "patch">,
  into: { proposals: RouteProposal[]; skipped: RouteProposalSkip[] },
): void {
  if (spec === undefined) {
    into.skipped.push({
      id: proposal.id,
      reason: "no spec in the harness directory — a patch cannot be validated against one",
    });
    return;
  }
  try {
    validatePatch(spec, patch);
  } catch (err) {
    into.skipped.push({
      id: proposal.id,
      reason: `refused by the optimizable-paths whitelist: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }
  into.proposals.push({ ...proposal, patch });
}

/**
 * Mine the scoreboard into whitelisted pool patches. Deterministic and
 * order-stable: proposals come out in the order the loops declare them, so a
 * nightly job produces the same PR for the same evidence.
 */
export function buildRouteProposals(opts: BuildRouteProposalsOptions): RouteProposeResult {
  const into = { proposals: [] as RouteProposal[], skipped: [] as RouteProposalSkip[] };
  const spec = opts.spec;
  const pool = agentPoolOf(spec);
  const arms = liveArms(opts.arms);
  if (pool === undefined) {
    return {
      proposals: [],
      skipped: [
        {
          id: "no-pool",
          reason:
            "the spec declares no `agent.model_pool` — there is no routing policy to propose a change to",
        },
      ],
    };
  }
  if (arms.length === 0) {
    return {
      proposals: [],
      skipped: [
        {
          id: "no-arms",
          reason:
            "the scoreboard has no LIVE arms yet (an observe-only `q:`/`shadow:` lane never justifies a live policy change) — run the harness until every candidate clears its sample floor",
        },
      ],
    };
  }
  const floor = opts.minSamples ?? pool.learning?.minSamplesPerArm ?? DEFAULT_POOL_MIN_SAMPLES;
  const covered = bandsWithFullCoverage(arms, pool.candidates, floor);
  const has = (path: ReadonlyArray<string>): boolean => opts.specHasPath?.(path) ?? false;

  // ---- 1. policy flip: full coverage AND a separated leader in some band.
  if (pool.policy !== "learned") {
    const separated = covered
      .map((band) => ({ band, sep: bandSeparation(arms, band) }))
      .filter((x) => x.sep?.separated === true);
    if (separated.length > 0) {
      const path = ["agent", "model_pool", "policy"];
      keep(
        spec,
        {
          target: (spec?.target ?? "cli") as SpecPatch["target"],
          path,
          op: has(path) ? "replace" : "add",
          value: "learned",
          rationale: `route propose: band(s) ${separated.map((x) => x.band).join(", ")} have full coverage at ${floor} samples AND a leader whose 95% lower bound clears the runner-up's mean`,
        },
        {
          id: "route-policy-flip",
          summary: "the scoreboard separates a winner — flip model_pool.policy to learned",
          evidence: separated.map(
            (x) =>
              `${x.band}: leader ${x.sep?.leader} clears the runner-up by ${x.sep?.margin.toFixed(4)} reward at the 95% lower bound`,
          ),
        },
        into,
      );
    } else if (covered.length > 0) {
      into.skipped.push({
        id: "route-policy-flip",
        reason: `band(s) ${covered.join(", ")} are fully covered but no leader is separated from its runner-up — flipping to \`learned\` would exploit noise`,
      });
    } else {
      into.skipped.push({
        id: "route-policy-flip",
        reason: `no band has every candidate at >= ${floor} observations yet`,
      });
    }
  }

  // ---- 2. exploration floor: a converged learned pool that never explores.
  if (pool.policy === "learned") {
    const learning = pool.learning ?? {};
    const explores = (learning.explorationRate ?? 0) > 0 || learning.bandit === "thompson";
    if (!explores && covered.length > 0) {
      const path = ["agent", "model_pool", "learning"];
      keep(
        spec,
        {
          target: (spec?.target ?? "cli") as SpecPatch["target"],
          path,
          op: has(path) ? "replace" : "add",
          // The block is replaced WHOLE so the spec's other learning fields —
          // the pinned `seed` above all — survive. A patch that dropped the
          // seed would silently re-randomize the very lineage a routed eval
          // pins.
          value: { ...learning, explorationRate: 0.05 },
          rationale: `route propose: learned pool converged (full coverage in band(s) ${covered.join(", ")}) with explorationRate 0 and a non-thompson bandit`,
        },
        {
          id: "route-exploration-floor",
          summary: "a converged learned pool never explores again — add a small epsilon",
          evidence: [
            `full-coverage band(s) at floor ${floor}: ${covered.join(", ")}`,
            `learning.explorationRate is ${learning.explorationRate ?? "unset"}, bandit is ${learning.bandit ?? "epsilon-greedy"}`,
            "without exploration the pool hard-commits to today's argmax and can never notice model drift or an improved candidate",
          ],
        },
        into,
      );
    }
  }

  // ---- 3. rule hygiene is NOT mined here. The scoreboard records
  //          `(routeKey, armId)`; it does not record WHICH rule forced a
  //          decision. `model_route.ruleId` does, on the durable session
  //          line, so the `escalation-precision` advise rule owns the
  //          `rules[*].enabled` toggle and this verb says so rather than
  //          guessing from band names.
  if ((pool.rules?.length ?? 0) > 0) {
    into.skipped.push({
      id: "route-rule-hygiene",
      reason:
        "rule toggles are mined from the durable `model_route.ruleId` lines, not from the scoreboard — run `crewhaus advise` for the `escalation-precision` finding",
    });
  }

  // ---- 4. wind down an audition that has cleared the power floor.
  //
  // §7.8 — the lane records BOTH sides of each graded turn (the candidate and
  // the primary it was judged against), so summing the whole lane counts
  // every turn twice and would fire the wind-down at half the evidence the
  // rationale claims. Count the CANDIDATE side only, attributed by the
  // declared `strategy.shadow.candidate` (or a single-armed lane); an
  // unattributable lane is skipped with its reason rather than guessed at.
  const split = splitShadowLane(opts.arms, {
    ...((): { declaredCandidate?: string } => {
      const declared = declaredShadowCandidate(pool);
      return declared !== undefined ? { declaredCandidate: declared } : {};
    })(),
  });
  const shadowArms = split.candidateArms;
  const shadowN = shadowCandidateN(split);
  const minAudition = opts.minAuditionN ?? 30;
  const rate = pool.strategy?.shadow?.sample_rate;
  if (
    rate !== undefined &&
    rate > 0 &&
    split.candidateArm === undefined &&
    split.laneArms.length > 0
  ) {
    into.skipped.push({
      id: "route-audition-wind-down",
      reason: `the shadow lane cannot be attributed to an audition candidate, so its evidence cannot be counted: ${split.unattributedReason ?? "no discriminant"}`,
    });
  }
  if (rate !== undefined && rate > 0 && shadowN >= minAudition) {
    const path = ["agent", "model_pool", "strategy", "shadow", "sample_rate"];
    keep(
      spec,
      {
        target: (spec?.target ?? "cli") as SpecPatch["target"],
        path,
        op: has(path) ? "replace" : "add",
        value: 0,
        rationale: `route propose: the audition has ${shadowN} observation(s), past the ${minAudition} power floor — stop paying for the shadow lane while the roster PR is reviewed`,
      },
      {
        id: "route-audition-wind-down",
        summary: "the audition has enough evidence — stop sampling and read the verdict",
        evidence: [
          `${shadowN} audition observation(s) for ${split.candidateArm} across ${shadowArms.length} lane arm(s), floor ${minAudition}`,
          "`crewhaus models propose --source audition` turns the verdict into a roster PR; the lane keeps its recorded history either way",
        ],
      },
      into,
    );
  }

  return { proposals: into.proposals, skipped: into.skipped };
}

/**
 * The proposals as the `suggestions.json` `optimize --from-advice` consumes —
 * byte-compatible with `crewhaus advise`'s own file, so the apply path needs
 * no second format.
 */
export function routeSuggestionsFile(
  result: RouteProposeResult,
  generatedAt: string,
): SuggestionsFile {
  const findings: AdviceFinding[] = result.proposals.map((p) => ({
    id: p.id,
    severity: "info",
    summary: p.summary,
    evidence: p.evidence,
    counts: {},
    suggestion: { kind: "spec-patch", patch: p.patch },
  }));
  return buildSuggestionsFile(findings, [], generatedAt);
}

/** The human report `route propose` prints. */
export function formatRouteProposals(result: RouteProposeResult, suggestionsPath?: string): string {
  const lines: string[] = [];
  if (result.proposals.length === 0) {
    lines.push("No routing change is proposable from the current scoreboard.");
  } else {
    lines.push(`${result.proposals.length} proposed routing change(s):`);
    for (const p of result.proposals) {
      lines.push("");
      lines.push(`  ${p.id}: ${p.summary}`);
      lines.push(`    ${p.patch.op} ${p.patch.path.join(".")} → ${JSON.stringify(p.patch.value)}`);
      for (const e of p.evidence) lines.push(`    · ${e}`);
    }
  }
  if (result.skipped.length > 0) {
    lines.push("");
    lines.push("not proposed:");
    for (const s of result.skipped) lines.push(`  ${s.id}: ${s.reason}`);
  }
  if (suggestionsPath !== undefined && result.proposals.length > 0) {
    lines.push("");
    lines.push(`wrote ${suggestionsPath}`);
    lines.push("Nothing is applied. Eval-gate it:");
    lines.push(
      `  crewhaus optimize <spec> --dataset <d> --graders <g> --from-advice ${suggestionsPath} \\`,
    );
    lines.push("    --routing as-declared --warm-arms --write-back");
    lines.push(
      "Every patch is re-validated against the whitelist, compiled, evaled and accepted only if the gate holds.",
    );
  }
  return lines.join("\n");
}
