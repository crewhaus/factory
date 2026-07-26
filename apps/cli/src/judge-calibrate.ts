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
 * could later consult) — ATOMICALLY, via {@link writeCalibrationFileAtomic}
 * (see its docstring: torn files were observed in the wild). Otherwise kept
 * side-effect-free (the CLI entry file runs an argv switch on import)
 * mirroring `feedback.ts` / `graders-suggest.ts`; the judge model call and
 * every other filesystem access live in `apps/cli/src/index.ts`.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Sample } from "@crewhaus/eval-dataset";

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

// -------- NEW-graders-1: dataset golden-verdict pairs --------

/**
 * A calibration pair candidate extracted from a `--dataset` sample — the
 * judged answer text plus the human verdict, BEFORE the judge call (the
 * judge scores `answer` in `index.ts`, exactly like a session turn).
 */
export type DatasetPairCandidate = {
  /** `metadata.sessionId` when it is a string (distill records it), else
   *  the sample id — the exemplar/dedupe key beside session pairs. */
  readonly sessionId: string;
  /** `metadata.turnNumber` when it is an integer (distill records it), else 0. */
  readonly turnNumber: number;
  readonly input: string;
  /** The rated answer the judge scores (the sample's `expected_output`). */
  readonly answer: string;
  /** The human rating, normalized [0,1] (`metadata.user_rating`). */
  readonly human: number;
};

export type DatasetPairExtraction = {
  readonly candidates: DatasetPairCandidate[];
  /** No numeric `metadata.user_rating` in [0,1] — nothing human to pair. */
  readonly skippedNoRating: number;
  /** Rated, but no non-empty `expected_output` to judge (distill records
   *  no answer text for low-rated turns). */
  readonly skippedNoAnswer: number;
  /** `metadata.correction` / `metadata.gold_refreshed` present: the stored
   *  gold is a human correction (or a later-refreshed gold), NOT the answer
   *  the rating was placed on — pairing them would mis-attribute the
   *  rating, so these are skipped and counted. */
  readonly skippedMisPaired: number;
};

/**
 * NEW-graders-1 — extract calibration pairs from the golden verdicts a
 * dataset carries. The contract is exactly what `crewhaus distill` records:
 * a sample pairs when `metadata.user_rating` is a number in [0,1] AND
 * `expected_output` is the non-empty answer that rating was placed on
 * (true for distilled positives; corrections and `dataset refresh-goldens`
 * rewrites are skipped as mis-paired — see {@link DatasetPairExtraction}).
 */
export function extractDatasetCalibrationPairs(
  samples: ReadonlyArray<Sample>,
): DatasetPairExtraction {
  const candidates: DatasetPairCandidate[] = [];
  let skippedNoRating = 0;
  let skippedNoAnswer = 0;
  let skippedMisPaired = 0;
  for (const s of samples) {
    const meta = s.metadata ?? {};
    const rating = meta["user_rating"];
    if (typeof rating !== "number" || Number.isNaN(rating) || rating < 0 || rating > 1) {
      skippedNoRating += 1;
      continue;
    }
    if (meta["correction"] !== undefined || meta["gold_refreshed"] !== undefined) {
      skippedMisPaired += 1;
      continue;
    }
    const answer = s.expected_output;
    if (answer === undefined || answer.trim() === "") {
      skippedNoAnswer += 1;
      continue;
    }
    const sessionId = typeof meta["sessionId"] === "string" ? meta["sessionId"] : s.id;
    const turnNumber =
      typeof meta["turnNumber"] === "number" && Number.isInteger(meta["turnNumber"])
        ? meta["turnNumber"]
        : 0;
    candidates.push({ sessionId, turnNumber, input: s.input, answer, human: rating });
  }
  return { candidates, skippedNoRating, skippedNoAnswer, skippedMisPaired };
}

/**
 * Drop dataset candidates whose `sessionId#turnNumber` ref is already
 * covered by a session-ratings pair (the two sources COMBINE — a distilled
 * dataset re-read beside the very sessions it came from must not
 * double-count and double-judge the same turn). Session pairs win: they are
 * re-derived from the live transcript, the dataset copy may be redacted.
 * Duplicates WITHIN the dataset (the same turn under two sample ids, e.g.
 * two distill outputs of overlapping sessions merged into one registry
 * version) are dropped keep-first and counted into the same bucket.
 */
export function dropDuplicateCandidates(
  candidates: ReadonlyArray<DatasetPairCandidate>,
  takenRefs: ReadonlySet<string>,
): { kept: DatasetPairCandidate[]; duplicates: number } {
  const kept: DatasetPairCandidate[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const c of candidates) {
    const ref = `${c.sessionId}#${c.turnNumber}`;
    if (takenRefs.has(ref) || seen.has(ref)) {
      duplicates += 1;
    } else {
      seen.add(ref);
      kept.push(c);
    }
  }
  return { kept, duplicates };
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

/**
 * Write `.crewhaus/judge-calibration.json` ATOMICALLY: serialize to a
 * uniquely-named temp file in the SAME directory (so the rename stays within
 * one filesystem), then `rename` it over the destination — POSIX rename is
 * atomic, so every reader sees either the old file or the new one, never a
 * half-written prefix.
 *
 * Why this is not a nicety: the eval runner READS this file at run start to
 * gate `llm_judge` graders that declare no `passing_score` (G47). A plain
 * `writeFileSync` is a truncate-then-write, and a concurrent
 * `judge calibrate --apply` in a shared checkout produced exactly the torn
 * artifact that state predicts — observed during the Wave-3 flake hunt,
 * where a truncated calibration file was visible mid-run to the eval
 * package's own tests. A malformed file only WARNS (calibration is skipped),
 * so the failure mode is silent mis-gating, not a crash.
 *
 * The temp file is removed if the rename fails, so a failed write never
 * leaves litter beside the artifact.
 */
export function writeCalibrationFileAtomic(path: string, file: JudgeCalibrationFile): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

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
