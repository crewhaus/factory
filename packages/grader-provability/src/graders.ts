/**
 * The six provability graders (design/0.8.0-provability-release.md §9.1) —
 * deterministic reads of the proof bundle the eval runner captured for a
 * sample (`RunResult.artifacts.proof`, the gate's STANDING verdict). No
 * grader re-verifies anything: the bundle is the gate's own record, and these
 * only measure it, so a sample graded here and the footer its answer carried
 * can never disagree.
 *
 * The floor a sample is graded at is `metadata.provability.level` when the
 * sample sets one, else the bundle's own (the spec's `provability.level`, or
 * the `crewhaus eval --provability` override). The eval runner wires each
 * gated sample's gate AT that floor, so in a runner-made bundle the two
 * agree and every grade is the gate's own. A bundle made elsewhere (a
 * hand-wired invoker) can disagree:
 *   - a floor BELOW the bundle's re-reads the rungs the gate RECORDED: a
 *     claim meets it when it has no dangling marker and some non-assumption
 *     binding reached that rung. `grounded.independent` and the guarded HEAD
 *     are applied only at the run's own floor, so that grade is close, not
 *     exact;
 *   - a floor ABOVE the bundle's is not graded at all by the floor-dependent
 *     graders (claimCoverage, rungAchieved, replayIntegrity,
 *     costPerProvenClaim): the verifier computes rungs above its floor
 *     WITHOUT the checks only those floors run (replay at checked), so a
 *     recorded `checked` there is a claim nobody checked. Those graders fail
 *     the sample as unmeasured ({@link FLOOR_ABOVE_BUNDLE}); citationValidity
 *     and assumptionRate do not depend on the floor and still measure.
 *
 * Every failure that replaces a measurement starts with a pinned prefix
 * ({@link UNMEASURED_PREFIXES}, read by {@link isUnmeasured} and the roll-up),
 * never a guess:
 *   - NO BUNDLE — the run was not gated (no `provability:` block and no
 *     `--provability`), or the sample ended (an invoker error, a timeout)
 *     before the gate graded an answer. A provability grader is configured
 *     because proof is expected; a missing verdict must not read as a pass
 *     (the research report's NO_CITATIONS_NOTICE posture: an ungated answer
 *     never passes for a gated one).
 *   - UNVERIFIED — the gate's verifier threw and the answer stood unchecked
 *     (design §5.1 fail-open). Nothing was measured, so nothing passes.
 *   - INVALID METADATA — a malformed `metadata.provability`, naming the field.
 *   - FLOOR ABOVE THE BUNDLE — see above.
 */
import type { GradeResult, Grader, RunResult, Sample } from "@crewhaus/eval-grader";
import {
  type ProofBinding,
  type ProofBundle,
  type ProofClaim,
  type ProvabilityLevel,
  type Rung,
  type UnmetReason,
  claimReasons,
  levelRank,
  maxRung,
  meetsFloor,
} from "@crewhaus/provability";
import { type GatePricing, gateSpendOf } from "./cost";
import { type SampleProvability, expectedSourceKey, sampleProvabilityOf } from "./metadata";

/** The release thresholds (design §9.1's table). */
export const PROVABILITY_METRIC_THRESHOLDS = Object.freeze({
  /** met / (claims − assumptions) at the floor. */
  claimCoverage: 0.95,
  /** defined markers / markers. */
  citationValidity: 0.99,
  /** declared assumptions / claims — an UPPER bound. */
  assumptionRate: 0.1,
  /** matched replays / replays — every replay must match. */
  replayIntegrity: 1,
});

/** The reason a provability grader returns when the run carried no bundle. */
export const NO_PROOF_BUNDLE = "no proof bundle (is provability: declared?)";

/** The pinned prefix of the result for a bundle whose verifier threw (§5.1 fail-open). */
export const UNVERIFIED_BUNDLE = "the gate could not verify this answer";

/** The pinned prefix of the result for a malformed `metadata.provability`. */
export const INVALID_SAMPLE_METADATA = "invalid metadata.provability";

/** The pinned prefix of a floor-dependent result whose floor is above the bundle's. */
export const FLOOR_ABOVE_BUNDLE = "not gradable at this floor";

/**
 * Every prefix a result carries when it REPLACES a measurement (no score was
 * measured; `score` is a placeholder 0). A roll-up keeps these out of a
 * lower-is-better mean, where a placeholder 0 would read as the best value.
 */
export const UNMEASURED_PREFIXES: ReadonlyArray<string> = Object.freeze([
  NO_PROOF_BUNDLE,
  UNVERIFIED_BUNDLE,
  INVALID_SAMPLE_METADATA,
  FLOOR_ABOVE_BUNDLE,
]);

/** Whether a provability grade replaced its measurement with a failure (see {@link UNMEASURED_PREFIXES}). */
export function isUnmeasured(result: Pick<GradeResult, "rationale">): boolean {
  return UNMEASURED_PREFIXES.some((prefix) => result.rationale.startsWith(prefix));
}

/** The pinned prefix of an infinite `costPerProvenClaim` rationale (see the grader). */
export const INFINITE_COST_PREFIX = "∞ per proven claim";

/** The pinned prefix of a `costPerProvenClaim` whose spend is a lower bound (see the grader). */
export const UNPRICED_COST_PREFIX = "≥ (partly unpriced) per proven claim";

type Standing =
  | {
      readonly bundle: ProofBundle;
      readonly floor: ProvabilityLevel;
      readonly meta: SampleProvability;
    }
  | { readonly result: GradeResult };

const fail = (rationale: string): { result: GradeResult } => ({
  result: { passed: false, score: 0, rationale },
});

/**
 * The bundle and floor a grader measures, or the failing result that replaces
 * the measurement. `floorDependent` graders also refuse a floor above the
 * bundle's (see the module doc).
 */
function standing(sample: Sample, run: RunResult, floorDependent: boolean): Standing {
  const meta = sampleProvabilityOf(sample);
  // `meta.error` names the field: "metadata.provability… must be …".
  if (!meta.ok) return fail(`invalid ${meta.error}`);
  const bundle = run.artifacts?.proof;
  if (bundle === undefined) {
    return fail(
      `${NO_PROOF_BUNDLE} — this sample carries no provability verdict: the run was not gated (declare provability: on the spec, or run \`crewhaus eval --provability <level>\`), or the sample ended before the gate graded an answer`,
    );
  }
  if (bundle.verdict === "unverified") {
    return fail(
      `${UNVERIFIED_BUNDLE} (${bundle.error ?? "the verifier failed"}) — it stood unverified, so nothing was graded`,
    );
  }
  const floor = meta.value.level ?? bundle.level;
  if (floorDependent && levelRank(floor) > levelRank(bundle.level)) {
    return fail(
      `${FLOOR_ABOVE_BUNDLE}: the sample's ${floor} floor is above the ${bundle.level} floor the gate graded at, and rungs above a gate's floor are recorded without the checks only those floors run — gate the sample at ${floor} (the eval runner does, per sample) for a grade`,
    );
  }
  return { bundle, floor, meta: meta.value };
}

/** The claims that count toward the score: everything but accepted assumptions. */
function counted(bundle: ProofBundle): ProofClaim[] {
  return bundle.claims.filter((c) => c.status !== "assumption");
}

/** The highest floor one recorded claim would meet (see the module doc). */
function claimCeiling(claim: ProofClaim): Rung {
  if (claim.bindings.some((b) => b.reason === "no_definition")) return "none";
  return maxRung(...claim.bindings.filter((b) => b.kind !== "assumption").map((b) => b.rung));
}

/** Does `claim` meet `floor`? Exact at the bundle's own floor, re-read from rungs elsewhere. */
function claimMeets(bundle: ProofBundle, claim: ProofClaim, floor: ProvabilityLevel): boolean {
  if (floor === bundle.level) return claim.status === "met";
  if (claim.status === "assumption") return false;
  return meetsFloor(claimCeiling(claim), floor);
}

/** met / counted at `floor`; 1 for the vacuous zero-counted answer. */
function coverageAt(
  bundle: ProofBundle,
  floor: ProvabilityLevel,
): { readonly met: number; readonly counted: number; readonly score: number } {
  const claims = counted(bundle);
  if (floor === bundle.level) {
    return { met: bundle.met, counted: claims.length, score: bundle.score };
  }
  const met = claims.filter((c) => claimMeets(bundle, c, floor)).length;
  return { met, counted: claims.length, score: claims.length === 0 ? 1 : met / claims.length };
}

/** `reason ×n` tally over the claims that miss `floor`, most frequent first. */
function reasonTally(bundle: ProofBundle, floor: ProvabilityLevel): string {
  const tally = new Map<UnmetReason, number>();
  for (const claim of counted(bundle)) {
    if (claimMeets(bundle, claim, floor)) continue;
    const reasons = claimReasons(claim.status === "unmet" ? claim : { ...claim, status: "unmet" });
    for (const reason of reasons.length > 0 ? reasons : (["below_floor"] as const)) {
      tally.set(reason, (tally.get(reason) ?? 0) + 1);
    }
  }
  return [...tally]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, n]) => (n > 1 ? `${reason} ×${n}` : reason))
    .join(", ");
}

/** The highest rung a source binding can reach (design §3: a source grounds; it never checks). */
const SOURCE_CEILING: ProvabilityLevel = "grounded";

/**
 * Whether a source binding grounded the answer at `floor`. At `cited` /
 * `grounded` that is the floor itself — the gate's own `ok` at its floor
 * (which also applies `grounded.independent`), the recorded rung elsewhere.
 * Above `grounded` no source is ever `ok` (`below_floor`: a figure at
 * `checked` needs a tool), yet a source the claim was grounded in still
 * grounded the answer, so the bar there is the source ceiling, `grounded`.
 */
function sourceGrounds(bundle: ProofBundle, b: ProofBinding, floor: ProvabilityLevel): boolean {
  if (levelRank(floor) > levelRank(SOURCE_CEILING)) return meetsFloor(b.rung, SOURCE_CEILING);
  return floor === bundle.level ? b.ok : meetsFloor(b.rung, floor);
}

/** Every source origin that grounded the answer at `floor` (see {@link sourceGrounds}). */
function okSourceOrigins(bundle: ProofBundle, floor: ProvabilityLevel): Set<string> {
  const out = new Set<string>();
  for (const claim of bundle.claims) {
    for (const b of claim.bindings) {
      if (b.kind !== "source" || b.origin === undefined) continue;
      if (sourceGrounds(bundle, b, floor)) out.add(b.origin);
    }
  }
  return out;
}

/** The `expected_sources` no ok binding grounded, as written. */
function missingSources(
  bundle: ProofBundle,
  floor: ProvabilityLevel,
  expected: ReadonlyArray<string>,
): string[] {
  const origins = okSourceOrigins(bundle, floor);
  return expected.filter((source) => !origins.has(expectedSourceKey(source)));
}

const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);

// ---------------------------------------------------------------------------
// 1. provability.claimCoverage
// ---------------------------------------------------------------------------

/**
 * met / (claims − assumptions) at the floor, the gate's own score when the
 * floor is the run's. Passes at ≥ 0.95 AND when every
 * `metadata.provability.expected_sources` origin grounded the answer — an ok
 * source binding, or at `checked` / `proven` (where a source is never `ok`)
 * one that reached `grounded` (see `sourceGrounds`). A missing one fails the
 * sample; the score stays the coverage, the rationale names the source.
 */
export const claimCoverage: Grader = async (sample, run) => {
  const s = standing(sample, run, true);
  if ("result" in s) return s.result;
  const { bundle, floor } = s;
  const { met, counted: n, score } = coverageAt(bundle, floor);
  const threshold = PROVABILITY_METRIC_THRESHOLDS.claimCoverage;
  const missing = missingSources(bundle, floor, s.meta.expectedSources ?? []);
  const parts: string[] = [
    n === 0
      ? `no claims to prove at the ${floor} floor (vacuous: ${bundle.vacuous ?? "no counted claims"})`
      : `${met}/${n} ${plural(n, "claim")} meet the ${floor} floor (threshold ≥${threshold})`,
  ];
  const tally = reasonTally(bundle, floor);
  if (tally !== "") parts.push(`unmet: ${tally}`);
  if (bundle.assumptions > 0) {
    parts.push(`${bundle.assumptions} ${plural(bundle.assumptions, "assumption")} excluded`);
  }
  if (missing.length > 0) {
    parts.push(
      `expected source(s) not grounding the answer: ${missing.map((m) => JSON.stringify(m)).join(", ")}`,
    );
  }
  return { passed: score >= threshold && missing.length === 0, score, rationale: parts.join("; ") };
};

// ---------------------------------------------------------------------------
// 2. provability.rungAchieved
// ---------------------------------------------------------------------------

/**
 * The highest floor the answer would have passed (`bundle.achieved`, the
 * gate ran every rung for it), normalized 0..1 as rank/4 — a per-sample
 * ladder score that shows HOW FAR an answer falls short. Passes when the
 * achieved rung is at or above the floor.
 */
export const rungAchieved: Grader = async (sample, run) => {
  const s = standing(sample, run, true);
  if ("result" in s) return s.result;
  const { bundle, floor } = s;
  const rank = levelRank(bundle.achieved);
  const passed = rank >= levelRank(floor);
  return {
    passed,
    score: rank / 4,
    rationale: `achieved ${bundle.achieved} (rung ${rank}/4) against the ${floor} floor — ${
      passed
        ? "at or above it"
        : `${levelRank(floor) - rank} ${plural(levelRank(floor) - rank, "rung")} short`
    }`,
  };
};

// ---------------------------------------------------------------------------
// 3. provability.citationValidity
// ---------------------------------------------------------------------------

/**
 * defined markers / markers — the `cited` sub-check alone: every `[n]` in a
 * claim needs its `[n]: …` definition. One binding is one marker occurrence;
 * a marker with no definition is a binding whose reason is `no_definition`.
 * No markers at all is a vacuous pass (claimCoverage is what fails an
 * uncited answer). Passes at ≥ 0.99.
 */
export const citationValidity: Grader = async (sample, run) => {
  const s = standing(sample, run, false);
  if ("result" in s) return s.result;
  const { bundle } = s;
  let markers = 0;
  let dangling = 0;
  const undefinedRefs: string[] = [];
  for (const claim of bundle.claims) {
    for (const b of claim.bindings) {
      markers += 1;
      if (b.reason === "no_definition") {
        dangling += 1;
        if (!undefinedRefs.includes(b.ref)) undefinedRefs.push(b.ref);
      }
    }
  }
  const threshold = PROVABILITY_METRIC_THRESHOLDS.citationValidity;
  if (markers === 0) {
    const uncited = bundle.claims.filter((c) => c.bindings.length === 0).length;
    return {
      passed: true,
      score: 1,
      rationale: `no citation markers to check (vacuous)${uncited > 0 ? ` — ${uncited} uncited ${plural(uncited, "claim")} (see claimCoverage)` : ""}`,
    };
  }
  const score = (markers - dangling) / markers;
  return {
    passed: score >= threshold,
    score,
    rationale: `${markers - dangling}/${markers} ${plural(markers, "marker")} defined (threshold ≥${threshold})${
      undefinedRefs.length > 0 ? ` — no definition for ${undefinedRefs.join(" ")}` : ""
    }`,
  };
};

// ---------------------------------------------------------------------------
// 4. provability.assumptionRate
// ---------------------------------------------------------------------------

/**
 * declared assumptions / claims — the assumption dodge made visible. LOWER is
 * better (the continuity.reAskRate precedent): passes at ≤ 0.1. Declared
 * counts the accepted assumptions AND the ones the config refused
 * (`assumptions: forbid`, past `max_assumptions`): a refused assumption is
 * still the answer leaning on one. Zero claims is a vacuous 0.
 */
export const assumptionRate: Grader = async (sample, run) => {
  const s = standing(sample, run, false);
  if ("result" in s) return s.result;
  const { bundle } = s;
  const refused = bundle.assumptionsRefused ?? 0;
  const declared = bundle.assumptions + refused;
  const threshold = PROVABILITY_METRIC_THRESHOLDS.assumptionRate;
  if (bundle.claimCount === 0) {
    return { passed: true, score: 0, rationale: "no claims (assumption rate 0, vacuous)" };
  }
  const rate = declared / bundle.claimCount;
  return {
    passed: rate <= threshold,
    score: rate,
    rationale: `${declared}/${bundle.claimCount} ${plural(bundle.claimCount, "claim")} rest on a declared assumption (upper-bound ≤${threshold})${
      refused > 0 ? ` — ${refused} refused by the config` : ""
    }`,
  };
};

// ---------------------------------------------------------------------------
// 5. provability.replayIntegrity
// ---------------------------------------------------------------------------

/**
 * replayed executions whose output digest matched / replayed executions.
 * An execution is one `tool:<toolUseId>` (bindings citing the same call share
 * its one replay). Must be exactly 1: a mismatch means a cited result is not
 * what the tool returns for that input. None replayed is a vacuous pass —
 * replay runs only at a `checked` floor, for pure tools, with
 * `execution.replay` on.
 */
export const replayIntegrity: Grader = async (sample, run) => {
  const s = standing(sample, run, true);
  if ("result" in s) return s.result;
  const replays = new Map<string, boolean>();
  s.bundle.claims.forEach((claim, i) => {
    claim.bindings.forEach((b: ProofBinding, j) => {
      if (b.kind !== "execution" || b.replayed !== true) return;
      const key = b.origin ?? `${i}:${j}`;
      const matched = b.reason !== "replay_mismatch";
      // One mismatching citation of a call is the call's verdict.
      replays.set(key, (replays.get(key) ?? true) && matched);
    });
  });
  if (replays.size === 0) {
    return {
      passed: true,
      score: 1,
      rationale:
        "no replayed executions (vacuous) — replay runs at the checked floor, for pure tools, with execution.replay on",
    };
  }
  const matched = [...replays.values()].filter(Boolean).length;
  const mismatched = [...replays].filter(([, ok]) => !ok).map(([id]) => id);
  const score = matched / replays.size;
  return {
    passed: score === PROVABILITY_METRIC_THRESHOLDS.replayIntegrity,
    score,
    rationale: `${matched}/${replays.size} replayed ${plural(replays.size, "execution")} matched (must be 1.0)${
      mismatched.length > 0 ? ` — replay mismatch: ${mismatched.join(", ")}` : ""
    }`,
  };
};

// ---------------------------------------------------------------------------
// 6. provability.costPerProvenClaim
// ---------------------------------------------------------------------------

const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`;

/**
 * Gate-caused spend per met claim (see `./cost` for exactly what counts and
 * how it is priced) — the `continuity.costPerProvenOutcome` precedent, but
 * REPORTED, with no threshold: it never fails a measured sample (only a
 * missing or unverified bundle does, like every grader here). Score is USD
 * per claim met at the floor. Three outcomes are told apart by a pinned
 * rationale prefix, which the roll-up reads:
 *   - {@link INFINITE_COST_PREFIX} — spend (priced, or tokens nothing could
 *     price) with zero met claims: the infinite ratio, kept JSON-safe as
 *     score 0;
 *   - {@link UNPRICED_COST_PREFIX} — some re-run tokens had no price, so the
 *     score is the PRICED part per met claim, a lower bound, never a $0 that
 *     reads as free;
 *   - otherwise the exact ratio.
 *
 * `pricing` prices re-run calls on a run no cost-tracker metered (the eval
 * runner passes its own `RunEvalOptions.pricing`); without it those calls
 * are unpriced.
 */
export function createCostPerProvenClaim(opts: { readonly pricing?: GatePricing } = {}): Grader {
  return async (sample, run) => {
    const s = standing(sample, run, true);
    if ("result" in s) return s.result;
    const { bundle, floor } = s;
    const { met } = coverageAt(bundle, floor);
    const spend = gateSpendOf(run.events, bundle, opts);
    const breakdown = [
      `re-runs ${usd(spend.rerunUsdMicros)} over ${spend.reruns} gate ${plural(spend.reruns, "pass", "passes")} after the first`,
      `waiver judge ${usd(spend.judgeUsdMicros)}`,
      ...(spend.unpriced
        ? [
            `${spend.unpricedTokens} of ${spend.rerunTokens} re-run tokens unpriced (no cost_accrual priced them, and no pricing row for their model)`,
          ]
        : []),
      ...(spend.checks > 0
        ? [
            `checker time ${spend.checkerMs}ms over ${spend.checks} ${plural(spend.checks, "check")}`,
          ]
        : []),
    ].join("; ");
    if (met === 0) {
      // Unpriced tokens are real spend: with nothing met, the ratio is ∞.
      return spend.totalUsdMicros > 0 || spend.unpriced
        ? {
            passed: true,
            score: 0,
            rationale: `${INFINITE_COST_PREFIX} — spent ${usd(spend.totalUsdMicros)}${spend.unpriced ? ` + ${spend.unpricedTokens} unpriced tokens` : ""} with zero claims met at the ${floor} floor (${breakdown}; reported, no threshold)`,
          }
        : {
            passed: true,
            score: 0,
            rationale: `$0.0000 per proven claim — no gate spend and no claims met at the ${floor} floor (${breakdown}; reported, no threshold)`,
          };
    }
    const ratio = spend.totalUsdMicros / 1_000_000 / met;
    if (spend.unpriced) {
      return {
        passed: true,
        score: ratio,
        rationale: `${UNPRICED_COST_PREFIX} — at least $${ratio.toFixed(4)} (${usd(spend.totalUsdMicros)} priced gate spend across ${met} met ${plural(met, "claim")}: ${breakdown}; reported, no threshold)`,
      };
    }
    return {
      passed: true,
      score: ratio,
      rationale: `$${ratio.toFixed(4)} per proven claim (${usd(spend.totalUsdMicros)} gate spend across ${met} met ${plural(met, "claim")}: ${breakdown}; reported, no threshold)`,
    };
  };
}

/** {@link createCostPerProvenClaim} with no pricing seam (the registry's instance). */
export const costPerProvenClaim: Grader = createCostPerProvenClaim();
