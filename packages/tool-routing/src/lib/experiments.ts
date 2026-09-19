/**
 * The N-variant experiment ledger, on top of `@crewhaus/canary-controller`.
 *
 * WHY THE DEPENDENCY IS NOT NEGOTIABLE. The assignment is
 * `sha256(salt|requestKey)`, first four bytes as a uint32, `Math.abs(v) % 100`
 * — and `CanaryController.route()` buckets the SAME way, on purpose, so a
 * two-version canary and an N-variant experiment can never disagree about
 * which side of the split a key is on. A second implementation of that hash
 * anywhere means a tenant is served version A at the boundary and attributed
 * to version B in the ledger, and the experiment's whole output is then
 * wrong in a way no test of this package would catch. So the hash, the weight
 * walk, the config validation, the filename sanitizer, the ledger format, the
 * repeat-measurement dedupe and the per-version fold are all imported. This
 * module contributes containment, refusals, the result shape and the
 * statistics.
 *
 * WHAT IT ADDS. `tallyExperimentOutcomes` returns counts and means. A count
 * is where the statistics trap lives: 3 successes in 3 is not a better
 * version than 280 in 300, and `successRate: 1.0` says it is. So every rate
 * leaves here with a Wilson interval, and a comparison between versions is a
 * Mann-Whitney rank test over the per-observation scores the ledger keeps —
 * never a difference of the means the tally already computed.
 *
 * AND THE BOUNDARY THE LEDGER ITSELF DECLARES. Nothing in CrewHaus intercepts
 * a live request on an assignment: `selectExperimentVariant` is a decision
 * function and the ledger is accounting. Wiring them into a serving boundary
 * is an explicit integration. Every result here repeats that, because a tool
 * that answers "which version serves this key" invites exactly the assumption
 * the library's own header spends a paragraph refusing.
 */
import {
  DEFAULT_EXPERIMENTS_DIR,
  EXPERIMENT_ASSIGNMENT_SUFFIX,
  EXPERIMENT_LEDGER_SUFFIX,
  type ExperimentAssignment,
  type ExperimentOutcomeRecord,
  type VariantTally,
  appendExperimentOutcomes,
  dedupeExperimentOutcomes,
  experimentFileName,
  listExperiments,
  readExperimentAssignment,
  readExperimentOutcomes,
  selectExperimentVariant,
  tallyExperimentOutcomes,
  validateExperimentConfig,
} from "@crewhaus/canary-controller";
import { type Loaded, compareStrings, fail, renderPath } from "./result";
import {
  ALPHA,
  type RateComparison,
  type RateView,
  type SampleComparison,
  compareRates,
  compareSamples,
  rate,
} from "./stats";

export {
  DEFAULT_EXPERIMENTS_DIR,
  EXPERIMENT_ASSIGNMENT_SUFFIX,
  EXPERIMENT_LEDGER_SUFFIX,
  listExperiments,
  readExperimentAssignment,
  readExperimentOutcomes,
  selectExperimentVariant,
  type ExperimentAssignment,
  type ExperimentOutcomeRecord,
};

/**
 * The honest boundary, repeated on every result that could be misread as
 * live traffic splitting.
 */
export const SERVING_BOUNDARY_NOTE =
  "nothing in CrewHaus intercepts a live request on this assignment. `selectExperimentVariant` is a pure decision function and this ledger is accounting; wiring them into a serving boundary (gateway-server's RunHandler, the managed daemon, a channel bot) is an explicit integration, and `target: cli` has no live request stream at all.";

/**
 * The FILENAME an experiment name becomes — the value every path check and
 * every read must use.
 *
 * `experimentFileName` maps anything outside `[A-Za-z0-9._-]` to `_` and
 * replaces a leading run of dots, then refuses a name with no alphanumeric
 * character at all. Containing the name the CALLER wrote would be checking a
 * string nothing opens: this is the InvoiceRender shape, where the directory
 * was resolved and the document number that became the filename was not.
 * Everything downstream keys on the returned value.
 */
export function safeExperimentName(name: string): Loaded<string> {
  try {
    return { ok: true, value: experimentFileName(name) };
  } catch (err) {
    return fail(
      "bad-input",
      `experiment name "${renderPath(name)}" is not usable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Whether a manifest on disk is a SPLIT, or only looks like one.
 *
 * `readExperimentAssignment` validates shapes (a `name` string, an array of
 * `{version, weight}`) and nothing else — it never checks that the weights
 * are integers summing to 100, which is what makes a split a split.
 * `selectExperimentVariant` DOES, through `validateExperimentConfig`, and
 * throws. So a manifest with weights of 10 and 10 is reported by `list` and
 * `tally` as a declared 10/10 split while `assign` refuses it: the tool
 * contradicting itself between two of its own actions. The verdict comes
 * from canary-controller's own validator — never from a second rule written
 * here about what a valid weight is.
 */
export type SplitStatus =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

export function splitStatus(assignment: ExperimentAssignment): SplitStatus {
  try {
    validateExperimentConfig(assignment);
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      reason: `this manifest is on disk but is not a usable split, so \`assign\` refuses it: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Both files one experiment owns, relative to the experiments directory. */
export function experimentRelPaths(safeName: string): string[] {
  return [`${safeName}${EXPERIMENT_LEDGER_SUFFIX}`, `${safeName}${EXPERIMENT_ASSIGNMENT_SUFFIX}`];
}

/** One version's tally with every proportion carrying its interval. */
export type VariantView = {
  readonly version: string;
  readonly n: number;
  readonly successes: number;
  readonly failures: number;
  readonly successRate: RateView;
  readonly meanScore: number | null;
  readonly scoredN: number;
  readonly meanRating: number | null;
  readonly ratedN: number;
  /**
   * Observations per `source`. An `n` built from offline eval re-runs is not
   * the same evidence as one built from live serving outcomes, and the tally
   * keeps them apart so a reader can see which they have.
   */
  readonly sources: Readonly<Record<string, number>>;
};

function variantView(tally: VariantTally): VariantView {
  return {
    version: tally.version,
    n: tally.n,
    successes: tally.successes,
    failures: tally.failures,
    successRate: rate(tally.successes, tally.n),
    // `meanScore` is absent from the tally when nothing carried a score.
    // Rendering that as 0 would say "everything scored zero" instead of
    // "nothing was scored".
    meanScore: tally.meanScore ?? null,
    scoredN: tally.scoredN,
    meanRating: tally.meanRating ?? null,
    ratedN: tally.ratedN,
    sources: tally.sources,
  };
}

/** One pairwise comparison between two versions. */
export type PairComparison = {
  readonly a: string;
  readonly b: string;
  /** Rank test over the per-observation scores, when both sides carry any. */
  readonly byScore: SampleComparison | null;
  /** Wilson-interval overlap on the success rates. */
  readonly bySuccessRate: RateComparison;
  /** Which version the score test put higher, when it separated them. */
  readonly higher: string | null;
};

export type LedgerVerdict = {
  readonly verdict: "winner" | "undecided" | "not-comparable";
  readonly winner: string | null;
  readonly reason: string;
  /** The per-comparison alpha, after correction for the number of pairs. */
  readonly alpha: number;
  readonly comparisons: ReadonlyArray<PairComparison>;
};

/**
 * Compare every pair of versions and name a winner only if one beats all the
 * others.
 *
 * MULTIPLICITY. With k versions there are k(k-1)/2 pairs, and running each at
 * alpha=0.05 makes a false "winner" progressively likelier — six versions is
 * fifteen tests and about a 54% chance of at least one spurious separation on
 * data with no real difference. The alpha is therefore Bonferroni-corrected
 * by the number of pairs actually run, and the corrected value is reported so
 * the verdict can be re-derived. This is the conservative choice: it makes
 * winners harder to declare, which is the direction a tool that changes what
 * production serves should err in.
 *
 * DIRECTION COMES FROM THE TEST, not from the means. `compareSamples` reads
 * the sign of `z`; re-deriving the direction here by comparing `meanScore`
 * would put the statistic this test replaced back in the decision.
 */
export function judge(
  views: ReadonlyArray<VariantView>,
  byVersion: Map<string, number[]>,
): LedgerVerdict {
  const withData = views.filter((v) => v.n > 0);
  if (withData.length < 2) {
    return {
      verdict: "not-comparable",
      winner: null,
      reason: `${withData.length} version(s) have any observations — a comparison needs two`,
      alpha: ALPHA,
      comparisons: [],
    };
  }
  const pairs: Array<[VariantView, VariantView]> = [];
  for (let i = 0; i < withData.length; i += 1) {
    for (let j = i + 1; j < withData.length; j += 1) {
      const a = withData[i];
      const b = withData[j];
      if (a !== undefined && b !== undefined) pairs.push([a, b]);
    }
  }
  const alpha = ALPHA / pairs.length;
  const comparisons: PairComparison[] = [];
  // version -> versions it beat on the score test
  const beats = new Map<string, Set<string>>();
  for (const [a, b] of pairs) {
    const sa = byVersion.get(a.version) ?? [];
    const sb = byVersion.get(b.version) ?? [];
    const byScore = sa.length > 0 && sb.length > 0 ? compareSamples(sa, sb, alpha) : null;
    const higher =
      byScore === null || byScore.verdict !== "separated"
        ? null
        : byScore.higher === "first"
          ? a.version
          : b.version;
    if (higher !== null) {
      const loser = higher === a.version ? b.version : a.version;
      const set = beats.get(higher) ?? new Set<string>();
      set.add(loser);
      beats.set(higher, set);
    }
    comparisons.push({
      a: a.version,
      b: b.version,
      byScore,
      bySuccessRate: compareRates(a.successRate, b.successRate),
      higher,
    });
  }
  comparisons.sort((x, y) => compareStrings(x.a, y.a) || compareStrings(x.b, y.b));
  const needed = withData.length - 1;
  const champions = [...beats.entries()]
    .filter(([, losers]) => losers.size === needed)
    .map(([version]) => version)
    .sort(compareStrings);
  if (champions.length === 1) {
    const winner = champions[0] as string;
    return {
      verdict: "winner",
      winner,
      reason: `"${winner}" scores higher than each of the other ${needed} version(s) on a Mann-Whitney rank test at a Bonferroni-corrected alpha=${alpha} (${ALPHA} over ${pairs.length} pair(s))`,
      alpha,
      comparisons,
    };
  }
  const scored = withData.filter((v) => v.scoredN > 0).length;
  return {
    verdict: "undecided",
    winner: null,
    reason:
      scored < 2
        ? `only ${scored} version(s) carry per-observation scores, and a rank test needs two — record outcomes with a \`score\` to make them comparable. Success rates alone are reported per version with their intervals.`
        : `no version separated from every other at a Bonferroni-corrected alpha=${alpha} (${ALPHA} over ${pairs.length} pair(s)). This is not a finding that the versions are equal; it is a finding that this much data cannot rank them.`,
    alpha,
    comparisons,
  };
}

/** Everything one `tally` call produces. */
export type LedgerView = {
  readonly experiment: string;
  readonly file: string;
  readonly records: number;
  /** Repeat eval measurements of the same (version, sample) collapsed before the fold. */
  readonly collapsedRepeats: number;
  readonly variants: ReadonlyArray<VariantView>;
  readonly verdict: LedgerVerdict;
  readonly dedupeNote: string;
};

/**
 * Fold a ledger: dedupe repeat measurements, tally per version, attach the
 * intervals, then judge.
 *
 * The dedupe is `@crewhaus/canary-controller`'s and runs BEFORE the tally,
 * which is the whole point of it: four ramp steps over an eight-sample
 * dataset otherwise report n=32 per version, shrink the Wilson half-width
 * about twofold and name a winner that a re-run would not reproduce. Its
 * scope is narrow on purpose — only `source: "eval"` records with a
 * `requestKey` collapse, because a serving record's request key is commonly a
 * sticky user id, where repeats are genuinely separate requests.
 */
export function foldLedger(
  experiment: string,
  file: string,
  records: ReadonlyArray<ExperimentOutcomeRecord>,
): LedgerView {
  const deduped = dedupeExperimentOutcomes(records);
  const variants = tallyExperimentOutcomes(deduped.records).map(variantView);
  const byVersion = new Map<string, number[]>();
  for (const rec of deduped.records) {
    if (rec.score === undefined) continue;
    const scores = byVersion.get(rec.version) ?? [];
    scores.push(rec.score);
    byVersion.set(rec.version, scores);
  }
  return {
    experiment,
    file,
    records: deduped.records.length,
    collapsedRepeats: deduped.collapsed,
    variants,
    verdict: judge(variants, byVersion),
    dedupeNote:
      deduped.collapsed > 0
        ? `${deduped.collapsed} repeat eval measurement(s) of the same (version, requestKey) were collapsed before the tally, last-write-wins. Counting them would have inflated n and narrowed every interval.`
        : 'no repeat eval measurements to collapse (only `source: "eval"` records with a requestKey are eligible; a serving record\'s key is commonly a sticky user id, where repeats are real).',
  };
}

/**
 * Append outcomes, reporting which FILES the batch would touch.
 *
 * `appendExperimentOutcomes` groups by `record.experiment`, so one call can
 * write several ledgers — every one of which has to be contained, under its
 * SANITIZED name, before anything is appended. A caller that contained only
 * the experiment it named in the arguments would have validated one file and
 * written to another.
 */
export function ledgerTargets(records: ReadonlyArray<ExperimentOutcomeRecord>): Loaded<string[]> {
  const names = new Set<string>();
  for (const rec of records) {
    const safe = safeExperimentName(rec.experiment);
    if (!safe.ok) return safe;
    names.add(safe.value);
  }
  return { ok: true, value: [...names].sort(compareStrings) };
}

export { appendExperimentOutcomes };
