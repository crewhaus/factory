/**
 * A9 — the `calibration.abstentionAware` registry pack: abstention-aware
 * (SimpleQA-style) correctness grading that distinguishes WRONG from
 * DECLINED-TO-ANSWER, so a well-calibrated agent that abstains on unknowns
 * stops grading identically to a confident hallucinator.
 *
 * Per sample, the grader classifies the agent output as exactly one of:
 *
 *   answered-correct  — the agent answered and the answer matches the
 *                       sample's `expected_output` under `opts.mode`
 *                       (`exact` — trimmed equality, the default — or
 *                       `contains`; `caseInsensitive` folds case first);
 *   answered-wrong    — the agent answered and the answer does not match;
 *   not-attempted     — the agent produced an empty/whitespace-only output
 *                       OR an explicit decline ({@link isExplicitDecline}:
 *                       a curated decline-opener heuristic, apology
 *                       prefixes stripped, capped at
 *                       {@link DECLINE_MAX_CHARS} characters, and the
 *                       decline must be TERMINAL — "I'm not sure, but
 *                       it's Paris." continues past the hedge with a
 *                       contrastive answer, so it is an attempt at ANY
 *                       length, exactly like a long answer that merely
 *                       OPENS with "I don't know exactly, but…").
 *
 * The GradeResult stays conservative: only answered-correct passes
 * (score 1); answered-wrong and not-attempted fail (score 0). The
 * abstention-aware lens lives in the RUN aggregates: `aggregate()` (the
 * runner's cross-sample post-run seam) detects the classification via the
 * stable {@link CALIBRATION_RATIONALE_PREFIX} rationale marker — the same
 * detection contract semantic-fallback uses — and emits the additive
 * `EvalAggregates.calibration` block (answerRate / abstentionRate /
 * accuracyWhenAnswered) whenever the pack graded at least one sample.
 *
 * Loud-gold rule (locked): classification of not-attempted needs no gold,
 * but an ANSWERED sample without `expected_output` throws a GraderError —
 * correctness against a missing gold is not a judgment call this pack will
 * silently invent.
 */
import { GraderError } from "@crewhaus/eval-grader";
import type { Grader } from "@crewhaus/eval-grader";
import { z } from "zod";
import type { SampleResult } from "./types";

/** The registry name this pack registers under. */
export const CALIBRATION_ABSTENTION_GRADER = "calibration.abstentionAware";

/** Stable rationale marker: `[calibration: <classification>] …`. The
 *  aggregation detector keys on it — keep byte-stable. */
export const CALIBRATION_RATIONALE_PREFIX = "[calibration: ";

/** The three A9 classifications. */
export type CalibrationClassification = "answered-correct" | "answered-wrong" | "not-attempted";

/** NEW-HUNT-7-style pack construction opts (strict — see default-registry). */
export const CalibrationAbstentionOptsSchema = z
  .object({
    /** How correctness compares the answer to `expected_output`:
     *  `exact` (trimmed equality, default) or `contains`. */
    mode: z.enum(["exact", "contains"]).optional(),
    /** Case-fold both sides before comparing. Default false. */
    caseInsensitive: z.boolean().optional(),
  })
  .strict();

export type CalibrationAbstentionOpts = z.infer<typeof CalibrationAbstentionOptsSchema>;

/** Declines longer than this are treated as attempts — a substantive answer
 *  that merely opens with a hedge is not an abstention. */
export const DECLINE_MAX_CHARS = 300;

/** Apology/hedge prefixes stripped before matching the decline openers. */
const APOLOGY_PREFIX_RE =
  /^(?:(?:i'm\s+sorry|i\s+am\s+sorry|sorry|apologies|unfortunately)[,.!]?\s+)+/i;

/** Curated explicit-decline openers (matched against the start of the
 *  apology-stripped, apostrophe-normalized output). */
const DECLINE_OPENERS: ReadonlyArray<RegExp> = [
  /^i\s+(?:don't|do\s+not)\s+know\b/i,
  /^i\s+(?:can't|cannot)\s+(?:answer|determine|say|tell|help\s+with)\b/i,
  /^i\s+am\s+(?:unable|not\s+able)\s+to\s+(?:answer|determine|say|tell)\b/i,
  /^i'm\s+(?:unable|not\s+able)\s+to\s+(?:answer|determine|say|tell)\b/i,
  /^i\s+(?:don't|do\s+not)\s+have\s+(?:enough|sufficient|that|this|the)\s+(?:information|context|data|knowledge)\b/i,
  /^i'm\s+not\s+sure\b/i,
  /^i\s+am\s+not\s+sure\b/i,
  /^(?:unknown|no\s+answer|not\s+attempted)[.!]?$/i,
];

/** A decline opener followed by a contrastive continuation ("…, but it's
 *  Paris." / "; however, my best guess is…") is a hedged ATTEMPT — an
 *  answer follows the hedge. An optional short qualifier ("exactly",
 *  "for sure") may sit between the opener and the connector. */
const CONTRASTIVE_CONTINUATION_RE =
  /^[\s,;:]*(?:exactly|precisely|for\s+sure|for\s+certain|offhand)?[\s,;:—–-]*(?:but|however|though|although|that\s+said|my\s+best\s+guess|if\s+i\s+had\s+to\s+guess)\b/i;

/**
 * A9 explicit-decline heuristic. True when the trimmed output (curly
 * apostrophes normalized, apology prefixes stripped) starts with a curated
 * decline opener, the decline is TERMINAL (not immediately followed by a
 * contrastive continuation like ", but …" / "; however …" — those carry an
 * answer), AND the whole output is at most {@link DECLINE_MAX_CHARS}
 * characters. Deliberately conservative: false on hedged-but-substantive
 * answers, empty strings (classified separately), and anything long.
 */
export function isExplicitDecline(output: string): boolean {
  const trimmed = output.trim();
  if (trimmed === "" || trimmed.length > DECLINE_MAX_CHARS) return false;
  const normalized = trimmed.replace(/[‘’]/g, "'").replace(APOLOGY_PREFIX_RE, "");
  for (const re of DECLINE_OPENERS) {
    const match = re.exec(normalized);
    if (match === null) continue;
    // Hedged-but-substantive: the text continues past the decline phrase
    // with a contrastive connector — "I'm not sure, but it's Paris." is an
    // answer, not an abstention, even under the length cap.
    return !CONTRASTIVE_CONTINUATION_RE.test(normalized.slice(match[0].length));
  }
  return false;
}

/**
 * Construct the `calibration.abstentionAware` grader. See the module doc
 * for classification + scoring semantics.
 */
export function calibrationAbstentionAware(opts: CalibrationAbstentionOpts = {}): Grader {
  const mode = opts.mode ?? "exact";
  const fold = (s: string): string => (opts.caseInsensitive === true ? s.toLowerCase() : s);
  return async (sample, run) => {
    const trimmed = run.agentOutput.trim();
    if (trimmed === "") {
      return {
        passed: false,
        score: 0,
        rationale: `${CALIBRATION_RATIONALE_PREFIX}not-attempted] empty/whitespace-only output`,
      };
    }
    if (isExplicitDecline(trimmed)) {
      return {
        passed: false,
        score: 0,
        rationale: `${CALIBRATION_RATIONALE_PREFIX}not-attempted] explicit decline detected`,
      };
    }
    // Answered — correctness needs the gold. A missing gold is a LOUD
    // grader error (locked), never a silently-invented verdict.
    if (sample.expected_output === undefined) {
      throw new GraderError(
        `grader "${CALIBRATION_ABSTENTION_GRADER}": sample "${sample.id}" was answered but has no expected_output — correctness needs a gold; add expected_output to the sample or drop the grader for gold-less datasets`,
      );
    }
    const answer = fold(trimmed);
    const gold = fold(sample.expected_output.trim());
    const correct = mode === "contains" ? answer.includes(gold) : answer === gold;
    return correct
      ? {
          passed: true,
          score: 1,
          rationale: `${CALIBRATION_RATIONALE_PREFIX}answered-correct] output matches expected_output (mode: ${mode})`,
        }
      : {
          passed: false,
          score: 0,
          rationale: `${CALIBRATION_RATIONALE_PREFIX}answered-wrong] output does not match expected_output (mode: ${mode})`,
        };
  };
}

/**
 * The additive `EvalAggregates.calibration` block. Rates are over the
 * CLASSIFIED samples (non-errored samples the pack graded); denominators
 * are guaranteed non-zero by construction (`detectCalibrationAggregates`
 * returns undefined when nothing classified), and `accuracyWhenAnswered`
 * is ABSENT — never NaN — when no sample was answered.
 */
export type CalibrationAggregates = {
  readonly classifiedSamples: number;
  /** Fraction of classified samples the agent attempted (correct + wrong). */
  readonly answerRate: number;
  /** Fraction of classified samples the agent declined (not-attempted). */
  readonly abstentionRate: number;
  /** correct / answered. Absent when the agent answered nothing. */
  readonly accuracyWhenAnswered?: number;
};

/** Parse the classification token out of a marker rationale. */
function classificationOf(rationale: string): CalibrationClassification | undefined {
  if (!rationale.startsWith(CALIBRATION_RATIONALE_PREFIX)) return undefined;
  const rest = rationale.slice(CALIBRATION_RATIONALE_PREFIX.length);
  const end = rest.indexOf("]");
  if (end === -1) return undefined;
  const token = rest.slice(0, end);
  return token === "answered-correct" || token === "answered-wrong" || token === "not-attempted"
    ? token
    : undefined;
}

/**
 * A9 cross-sample detection, run from `aggregate()` (the runner's post-run
 * seam). Scans each NON-ERRORED sample's canonical per-grader grades for
 * the {@link CALIBRATION_RATIONALE_PREFIX} marker (first hit wins — one
 * classification per sample); errored samples are skipped because their
 * empty output would misread as not-attempted when the truth is infra
 * noise. Returns undefined when the pack classified nothing, keeping
 * pack-less results.json byte-identical.
 */
export function detectCalibrationAggregates(
  samples: ReadonlyArray<SampleResult>,
): CalibrationAggregates | undefined {
  let correct = 0;
  let wrong = 0;
  let notAttempted = 0;
  for (const s of samples) {
    if (s.error !== undefined) continue;
    let classification: CalibrationClassification | undefined;
    for (const g of s.grades.perGrader) {
      classification = classificationOf(g.rationale);
      if (classification !== undefined) break;
    }
    if (classification === undefined) continue;
    if (classification === "answered-correct") correct += 1;
    else if (classification === "answered-wrong") wrong += 1;
    else notAttempted += 1;
  }
  const classifiedSamples = correct + wrong + notAttempted;
  if (classifiedSamples === 0) return undefined;
  const answered = correct + wrong;
  return {
    classifiedSamples,
    answerRate: answered / classifiedSamples,
    abstentionRate: notAttempted / classifiedSamples,
    ...(answered > 0 ? { accuracyWhenAnswered: correct / answered } : {}),
  };
}
