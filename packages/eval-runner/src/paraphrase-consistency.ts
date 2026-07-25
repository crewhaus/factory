/**
 * A10 — the `consistency.paraphraseGroup` registry pack: robustness-to-
 * paraphrase measured ACROSS samples, consuming the
 * `metadata.paraphrase_group` lineage `dataset synthesize` stamps on its
 * paraphrase variants (template + model paraphrases of the same parent
 * share the parent's source id — see the CLI's `variantToSample`).
 * Hand-stamped datasets work identically; datasets synthesized BEFORE the
 * key existed carry no groups and degrade to no aggregate (re-synthesize
 * or stamp the key to opt in).
 *
 * Per sample the grader is a VACUOUS PASS (score 1) — a single sample
 * cannot be consistent with itself, so the real measurement happens at
 * aggregation. Declaring the grader is the OPT-IN: `aggregate()` (the
 * runner's cross-sample post-run seam — the same seam semantic-fallback
 * and A9 calibration detection use) looks for the pack's stable
 * {@link PARAPHRASE_RATIONALE_PREFIX} rationale marker, and only then
 * groups the run's samples by their string `metadata.paraphrase_group`
 * value and scores each group on VERDICT CONSISTENCY: the fraction of the
 * group's usable verdicts agreeing with the group majority
 * (`grades.overall.passed`; errored and abstained samples are excluded —
 * infra noise and unknowns are not verdicts). A singleton group is
 * perfectly consistent (1.0 — never NaN); an even split reads 0.5.
 *
 * The additive `EvalAggregates.paraphraseConsistency` block carries
 * per-group figures (`consistencyByGroup`, keys sorted) plus their mean.
 * It is ABSENT when the pack was not declared OR no sample carries the
 * group key — a dataset with lineage metadata but no declared pack keeps a
 * byte-identical results.json (grading stays opt-in), and a declared pack
 * over a group-less dataset degrades gracefully to no aggregate.
 *
 * One visible per-sample side effect of declaring the pack: the vacuous
 * pass contributes a CONSTANT score 1 to every sample, so the sample's
 * combined score under `combine: all` (unweighted mean) or `weighted`
 * shifts upward — and with it the run's meanScore/meanScoreCI95 and any
 * score-shift diff — the moment the pack joins the graders file. passRate
 * under `all`/`any` is unaffected (a vacuous pass can never fail a
 * sample), but under `combine: weighted` the shifted combined score feeds
 * the passing_threshold cut too. Cross-run comparisons stay honest via
 * the Wave-0 gradersHash lineage: adding the pack changes the graders
 * hash, so pinned baselines warn + start a new lineage and `eval-report
 * diff` flags the instrument mismatch instead of reading the shift as an
 * improvement.
 */
import type { Grader } from "@crewhaus/eval-grader";
import { sampleAbstained } from "./slices";
import type { SampleResult } from "./types";

/** The registry name this pack registers under. */
export const PARAPHRASE_GROUP_GRADER = "consistency.paraphraseGroup";

/** The sample-metadata key whose (string) value groups paraphrase variants
 *  of the same parent input. */
export const PARAPHRASE_GROUP_METADATA_KEY = "paraphrase_group";

/** Stable rationale marker the aggregation detector keys on — keep
 *  byte-stable (same contract as the semantic-fallback prefix). */
export const PARAPHRASE_RATIONALE_PREFIX = "[consistency.paraphraseGroup]";

/**
 * Construct the `consistency.paraphraseGroup` grader: a per-sample vacuous
 * pass carrying the marker rationale. Takes no construction opts (the
 * default registry loud-rejects an `opts:` block on this name).
 */
export function paraphraseGroupConsistency(): Grader {
  return async (sample) => {
    const group = sample.metadata?.[PARAPHRASE_GROUP_METADATA_KEY];
    const membership =
      typeof group === "string"
        ? `group "${group}"`
        : `no ${PARAPHRASE_GROUP_METADATA_KEY} metadata — sample joins no group`;
    return {
      passed: true,
      score: 1,
      rationale: `${PARAPHRASE_RATIONALE_PREFIX} vacuous per-sample pass (${membership}); consistency is scored across the group at aggregation`,
    };
  };
}

/**
 * The additive `EvalAggregates.paraphraseConsistency` block. Every value is
 * in [0, 1]; `meanConsistency` is the unweighted mean over the groups
 * (groupCount >= 1 by construction — the detector returns undefined
 * otherwise, so no figure here can be NaN).
 */
export type ParaphraseConsistencySummary = {
  readonly groupCount: number;
  /** Group value → fraction of the group's usable verdicts agreeing with
   *  the group majority (singletons = 1.0, even splits = 0.5). Keys sorted. */
  readonly consistencyByGroup: Readonly<Record<string, number>>;
  readonly meanConsistency: number;
};

/** One group's majority-agreement fraction over pass/fail verdicts. */
function groupConsistency(verdicts: ReadonlyArray<boolean>): number {
  const passed = verdicts.filter((v) => v).length;
  const majority = Math.max(passed, verdicts.length - passed);
  return majority / verdicts.length;
}

/**
 * A10 cross-sample detection, run from `aggregate()`. Returns undefined
 * when the pack was not declared on this run (no marker rationale found)
 * or when no sample carries a string `metadata.paraphrase_group` — absent
 * groups = absent aggregate.
 */
export function detectParaphraseConsistency(
  samples: ReadonlyArray<SampleResult>,
): ParaphraseConsistencySummary | undefined {
  const packPresent = samples.some((s) =>
    s.grades.perGrader.some((g) => g.rationale.startsWith(PARAPHRASE_RATIONALE_PREFIX)),
  );
  if (!packPresent) return undefined;

  const groups = new Map<string, boolean[]>();
  for (const s of samples) {
    const group = s.metadata?.[PARAPHRASE_GROUP_METADATA_KEY];
    if (typeof group !== "string") continue;
    // Usable verdicts only: an errored sample is infra noise and an
    // abstained one is an unknown — neither is a verdict to agree with.
    if (s.error !== undefined || sampleAbstained(s)) continue;
    const verdicts = groups.get(group);
    if (verdicts !== undefined) verdicts.push(s.grades.overall.passed);
    else groups.set(group, [s.grades.overall.passed]);
  }
  if (groups.size === 0) return undefined;

  const consistencyByGroup: Record<string, number> = {};
  let sum = 0;
  for (const key of [...groups.keys()].sort()) {
    const consistency = groupConsistency(groups.get(key) as boolean[]);
    consistencyByGroup[key] = consistency;
    sum += consistency;
  }
  return {
    groupCount: groups.size,
    consistencyByGroup,
    meanConsistency: sum / groups.size,
  };
}
