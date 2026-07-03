/**
 * Item 8 — `crewhaus judge calibrate`: measure how well an llm_judge grader
 * agrees with real human ratings, and recommend the score cut that best
 * separates the answers users liked from the ones they didn't.
 *
 * The command pairs, for each turn that carries BOTH a human `user_feedback`
 * rating AND can be judged, the (human rating, llm_judge score). The judge
 * call itself is a model-dependent seam that lives in the CLI entry file
 * (re-running the judge over the rated transcript turn); this module owns the
 * PURE statistics over the resulting pairs so they are unit-testable without a
 * provider:
 *   - agreement: Pearson correlation + a confusion matrix at the current cut.
 *   - systematic bias: judge mean − human mean (both normalized to [0,1]).
 *   - the ROC-optimal cut: the judge score threshold maximizing Youden's J
 *     (TPR − FPR) at separating up- from down-rated turns.
 *   - per-rubric disagreement flags: rubrics whose judge-vs-human disagreement
 *     exceeds a threshold, naming the specific exemplars to re-anchor.
 *
 * `--apply` writes the per-spec calibrated `--min-score` default to
 * `.crewhaus/judge-calibration.json` (a small documented file distill/optimize
 * could later consult). Kept side-effect-free (the CLI entry file runs an argv
 * switch on import) mirroring `feedback.ts` / `graders-suggest.ts`; all
 * filesystem access + the judge model call live in `apps/cli/src/index.ts`.
 */

/** Thrown on malformed flags / unusable inputs. The CLI entry file routes it
 *  through `die()`; tests assert on `.message`. */
export class JudgeCalibrateError extends Error {
  override readonly name = "JudgeCalibrateError";
}

/** The [0,1] score at/above which a turn is treated as "up-rated" (positive)
 *  for confusion + ROC — the same 0.5 midpoint normalizeRating maps a thumbs
 *  up/down onto. */
export const POSITIVE_THRESHOLD = 0.5;

/** Default judge cut (normalized [0,1]) the confusion matrix reports against,
 *  matching distill/eval's default --min-score 0.7 → passing_score 3/5. */
export const DEFAULT_JUDGE_CUT = 0.5;

/** One paired observation: a human rating and the llm_judge's score for the
 *  same turn. Both are recorded in native units; helpers normalize. */
export type CalibrationPair = {
  readonly sessionId: string;
  readonly turnNumber: number;
  /** Human rating normalized to [0,1] (thumbs up=1/down=0, stars (n-1)/4, …). */
  readonly human: number;
  /** Raw 1–5 llm_judge score. */
  readonly judge: number;
  /** Per-criterion 1–5 judge scores, when the rubric had named criteria. */
  readonly criterionScores?: Readonly<Record<string, number>>;
};

/** Normalize a 1–5 judge score to [0,1] — the same (n-1)/4 map GradeResult uses. */
export function normalizeJudge(score: number): number {
  return clamp01((score - 1) / 4);
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// -------- agreement stats --------

export type ConfusionMatrix = {
  /** judge-pass & human-up. */
  readonly tp: number;
  /** judge-pass & human-down. */
  readonly fp: number;
  /** judge-fail & human-down. */
  readonly tn: number;
  /** judge-fail & human-up. */
  readonly fn: number;
};

/** Confusion of judge (normalized ≥ `judgeCut`) vs human (≥ POSITIVE_THRESHOLD). */
export function confusionAt(
  pairs: ReadonlyArray<CalibrationPair>,
  judgeCut: number,
): ConfusionMatrix {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const p of pairs) {
    const judgePass = normalizeJudge(p.judge) >= judgeCut;
    const humanUp = p.human >= POSITIVE_THRESHOLD;
    if (judgePass && humanUp) tp += 1;
    else if (judgePass && !humanUp) fp += 1;
    else if (!judgePass && !humanUp) tn += 1;
    else fn += 1;
  }
  return { tp, fp, tn, fn };
}

/** Accuracy of the judge's pass/fail vs the human up/down at a cut. */
export function accuracyAt(pairs: ReadonlyArray<CalibrationPair>, judgeCut: number): number {
  if (pairs.length === 0) return 0;
  const { tp, fp, tn, fn } = confusionAt(pairs, judgeCut);
  return (tp + tn) / (tp + fp + tn + fn);
}

/**
 * Pearson correlation between the human ratings and the normalized judge
 * scores. Returns 0 when there is no variance in either series (a degenerate
 * "all the same" set correlates with nothing).
 */
export function pearson(pairs: ReadonlyArray<CalibrationPair>): number {
  const n = pairs.length;
  if (n < 2) return 0;
  const xs = pairs.map((p) => p.human);
  const ys = pairs.map((p) => normalizeJudge(p.judge));
  const mx = mean(xs);
  const my = mean(ys);
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] as number) - mx;
    const dy = (ys[i] as number) - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return 0;
  return cov / Math.sqrt(vx * vy);
}

/** Systematic bias: mean(normalized judge) − mean(human). Positive ⇒ the judge
 *  is more generous than users; negative ⇒ harsher. */
export function judgeBias(pairs: ReadonlyArray<CalibrationPair>): number {
  if (pairs.length === 0) return 0;
  return mean(pairs.map((p) => normalizeJudge(p.judge))) - mean(pairs.map((p) => p.human));
}

function mean(xs: ReadonlyArray<number>): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

// -------- ROC-optimal cut --------

export type RocPoint = {
  readonly cut: number;
  readonly tpr: number;
  readonly fpr: number;
  readonly youdenJ: number;
};

/**
 * Sweep candidate judge cut points (the 5 normalized anchors 0, .25, .5, .75, 1
 * plus midpoints between observed scores) and return the one that maximizes
 * Youden's J = TPR − FPR at separating up-rated (human ≥ 0.5) from down-rated
 * turns. Ties break toward the LOWER cut (more inclusive), then the midpoint
 * default. Returns undefined when the set has no positives or no negatives (a
 * ROC point is undefined without both classes).
 */
export function rocOptimalCut(pairs: ReadonlyArray<CalibrationPair>): RocPoint | undefined {
  const positives = pairs.filter((p) => p.human >= POSITIVE_THRESHOLD);
  const negatives = pairs.filter((p) => p.human < POSITIVE_THRESHOLD);
  if (positives.length === 0 || negatives.length === 0) return undefined;

  const scores = [...new Set(pairs.map((p) => normalizeJudge(p.judge)))].sort((a, b) => a - b);
  const candidateCuts = new Set<number>([0, 0.25, 0.5, 0.75, 1]);
  for (let i = 0; i < scores.length; i += 1) {
    const s = scores[i] as number;
    candidateCuts.add(s);
    const next = scores[i + 1];
    if (next !== undefined) candidateCuts.add((s + next) / 2);
  }

  let best: RocPoint | undefined;
  for (const cut of [...candidateCuts].sort((a, b) => a - b)) {
    let tp = 0;
    let fp = 0;
    for (const p of positives) if (normalizeJudge(p.judge) >= cut) tp += 1;
    for (const p of negatives) if (normalizeJudge(p.judge) >= cut) fp += 1;
    const tpr = tp / positives.length;
    const fpr = fp / negatives.length;
    const youdenJ = tpr - fpr;
    if (best === undefined || youdenJ > best.youdenJ) {
      best = { cut, tpr, fpr, youdenJ };
    }
  }
  return best;
}

// -------- per-rubric disagreement --------

export type RubricDisagreement = {
  readonly criterion: string;
  /** Mean |normalized judge criterion − human| for this criterion. */
  readonly meanAbsError: number;
  /** The sessionId#turn exemplars where they disagreed most (up to 3). */
  readonly exemplars: ReadonlyArray<string>;
};

/**
 * Flag rubric criteria whose judge-vs-human disagreement exceeds `threshold`
 * (mean absolute error on [0,1]). For each flagged criterion the worst
 * exemplars are named so the user knows exactly which transcripts to look at
 * when re-anchoring the rubric. Criteria absent from the pairs are skipped.
 */
export function flagDisagreements(
  pairs: ReadonlyArray<CalibrationPair>,
  threshold = 0.34,
): RubricDisagreement[] {
  const byCriterion = new Map<string, Array<{ ref: string; err: number }>>();
  for (const p of pairs) {
    if (p.criterionScores === undefined) continue;
    for (const [name, raw] of Object.entries(p.criterionScores)) {
      const err = Math.abs(normalizeJudge(raw) - p.human);
      const bucket = byCriterion.get(name) ?? [];
      bucket.push({ ref: `${p.sessionId}#${p.turnNumber}`, err });
      byCriterion.set(name, bucket);
    }
  }
  const out: RubricDisagreement[] = [];
  for (const [criterion, errs] of byCriterion) {
    const meanAbsError = mean(errs.map((e) => e.err));
    if (meanAbsError < threshold) continue;
    const exemplars = [...errs]
      .sort((a, b) => b.err - a.err || a.ref.localeCompare(b.ref))
      .slice(0, 3)
      .map((e) => e.ref);
    out.push({ criterion, meanAbsError, exemplars });
  }
  return out.sort(
    (a, b) => b.meanAbsError - a.meanAbsError || a.criterion.localeCompare(b.criterion),
  );
}

// -------- calibration card + persisted file --------

export type CalibrationCard = {
  readonly specName?: string;
  readonly model?: string;
  readonly pairCount: number;
  readonly correlation: number;
  readonly bias: number;
  readonly accuracyAtDefault: number;
  readonly confusionAtDefault: ConfusionMatrix;
  readonly recommendedCut?: RocPoint;
  readonly disagreements: ReadonlyArray<RubricDisagreement>;
};

/** Compute the full calibration card from the paired data. */
export function buildCalibrationCard(
  pairs: ReadonlyArray<CalibrationPair>,
  opts: { specName?: string; model?: string } = {},
): CalibrationCard {
  const roc = rocOptimalCut(pairs);
  return {
    ...(opts.specName !== undefined ? { specName: opts.specName } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    pairCount: pairs.length,
    correlation: round(pearson(pairs)),
    bias: round(judgeBias(pairs)),
    accuracyAtDefault: round(accuracyAt(pairs, DEFAULT_JUDGE_CUT)),
    confusionAtDefault: confusionAt(pairs, DEFAULT_JUDGE_CUT),
    ...(roc !== undefined ? { recommendedCut: roc } : {}),
    disagreements: flagDisagreements(pairs),
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** The on-disk `.crewhaus/judge-calibration.json` schema `--apply` writes. */
export type JudgeCalibrationFile = {
  readonly version: 1;
  /** Per spec name → the calibrated recommended --min-score cut ([0,1]). */
  readonly calibrations: Record<
    string,
    {
      readonly minScore: number;
      readonly model?: string;
      readonly correlation: number;
      readonly bias: number;
      readonly pairCount: number;
      readonly updatedAt: string;
    }
  >;
};

/** Build/merge the persisted calibration entry for a spec. Existing entries for
 *  OTHER specs are preserved. Returns the file object to write. The recommended
 *  cut is the ROC-optimal cut when available, else the default. */
export function buildCalibrationFile(
  existing: JudgeCalibrationFile | undefined,
  card: CalibrationCard,
  now: string,
): JudgeCalibrationFile {
  const specKey = card.specName ?? "default";
  const minScore = card.recommendedCut?.cut ?? DEFAULT_JUDGE_CUT;
  return {
    version: 1,
    calibrations: {
      ...(existing?.calibrations ?? {}),
      [specKey]: {
        minScore: round(minScore),
        ...(card.model !== undefined ? { model: card.model } : {}),
        correlation: card.correlation,
        bias: card.bias,
        pairCount: card.pairCount,
        updatedAt: now,
      },
    },
  };
}

// -------- rendering --------

/** Render the calibration card as a terminal report. */
export function renderCalibrationCard(card: CalibrationCard): string {
  const lines: string[] = [];
  const forSpec = card.specName !== undefined ? ` for "${card.specName}"` : "";
  const withModel = card.model !== undefined ? ` (judge: ${card.model})` : "";
  lines.push(`judge calibration${forSpec}${withModel}`);
  lines.push(`  paired ratings:   ${card.pairCount}`);
  lines.push(`  correlation:      ${card.correlation.toFixed(3)} (human vs judge)`);
  lines.push(
    `  systematic bias:  ${card.bias >= 0 ? "+" : ""}${card.bias.toFixed(3)} (${card.bias > 0.05 ? "judge too GENEROUS" : card.bias < -0.05 ? "judge too HARSH" : "well-centered"})`,
  );
  const c = card.confusionAtDefault;
  lines.push(
    `  at cut ${DEFAULT_JUDGE_CUT}:  accuracy ${(card.accuracyAtDefault * 100).toFixed(0)}%  ` +
      `(tp ${c.tp} / fp ${c.fp} / tn ${c.tn} / fn ${c.fn})`,
  );
  if (card.recommendedCut !== undefined) {
    const r = card.recommendedCut;
    lines.push(
      `  ROC-optimal cut:  ${r.cut.toFixed(3)}  (TPR ${(r.tpr * 100).toFixed(0)}%, FPR ${(r.fpr * 100).toFixed(0)}%, Youden J ${r.youdenJ.toFixed(3)})`,
    );
  } else {
    lines.push("  ROC-optimal cut:  n/a (need both up- and down-rated turns)");
  }
  if (card.disagreements.length > 0) {
    lines.push("");
    lines.push(
      `  ${card.disagreements.length} rubric criterion/criteria disagree with users — re-anchor:`,
    );
    for (const d of card.disagreements) {
      lines.push(
        `    - "${d.criterion}" (mean abs error ${d.meanAbsError.toFixed(3)}) e.g. ${d.exemplars.join(", ")}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
