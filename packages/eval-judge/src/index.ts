/**
 * Catalog R-eval `eval-judge` — LLM-as-judge grader.
 *
 * Returns `{ score: 1..5, rationale, criterionScores, abstain, confidence? }`.
 * Sample inputs and agent outputs are treated as **untrusted data** — the
 * prompt template wraps each in a per-call random sentinel and the system
 * prompt explicitly instructs the judge to ignore embedded instructions.
 *
 * Structured output is enforced via Anthropic tool-use (`submit_score` tool)
 * — the judge cannot deviate from the schema.
 *
 * Measurement literacy (evals hardening Wave 1):
 *  - A3 — the judge may ABSTAIN (`abstain: true`) instead of guessing when
 *    the evidence is insufficient; `createJudgeGrader` surfaces that as an
 *    `abstained` grade for the runner's needs-human routing.
 *  - NEW-HUNT-2 — judge decoding is PINNED to temperature 0 by default
 *    (override per rubric); optional odd `repeats` fans out a judge panel
 *    whose median score is the verdict.
 *
 * Judge quality (evals hardening Wave 2):
 *  - A2 — `createJudgeGrader({ judges: [model, ...] })` fans out a
 *    multi-MODEL panel: median score, strict-majority pass, per-panelist
 *    scores + normalized vote entropy in the grade; high entropy flags the
 *    sample `needsReview` for the runner's review listing.
 *  - A1 — `judgePairwise` compares two candidate outputs head-to-head with
 *    the order swapped across two calls (position-bias control); a
 *    disagreement between orders consolidates to a tie, never a win.
 *  - NEW-graders-2 — categorical rubrics (`kind: categorical`): the judge
 *    picks exactly one label via a forced `submit_label` tool call;
 *    `passed` = label ∈ `passing_labels`, `score` = the label's declared
 *    0..1 score. Scalar rubrics are byte-identical to before.
 *  - NEW-graders-3 — `createJudgeGrader({ target: "transcript" })` judges
 *    the run TRAJECTORY: the judge reads a bounded, sentinel-wrapped
 *    transcript digest (`renderTranscriptDigest` — most-recent-turns-win
 *    truncation) instead of the final output.
 *
 * Reference: build-roadmap.md §16 — risk callout `🔴 Prompt-injection in eval-judge`.
 */
export {
  judge,
  judgeCategorical,
  createJudgeGrader,
  meteredJudgeCall,
  DEFAULT_JUDGE_MODEL,
  PANEL_NEEDS_REVIEW_ENTROPY,
  normalizedVoteEntropy,
} from "./judge";
export type {
  CategoricalJudgeOptions,
  CategoricalJudgeResult,
  JudgeOptions,
  JudgeResult,
  // C35 — judge token metering: the runner meters `llm_judge` spend by
  // passing a sink into every grader it builds.
  JudgeUsageSink,
  // 0.6.0 (design §6.2) — judge spend on the run bus: `bus`/`role`/`stage`
  // on every judge call, and the priced `usage` on every verdict.
  JudgeBusOptions,
  JudgeCallUsage,
} from "./judge";
// 0.6.0 §7.2.3 — the `policy: classifier` route classifier: an enum-
// constrained forced-tool call metered with `role: "classifier"`.
export {
  ROUTE_CLASSIFIER_TOOL,
  buildRouteClassifierPrompt,
  classifyRouteLabel,
} from "./route-classifier";
export type { RouteClassifierOptions, RouteClassifierResult } from "./route-classifier";
export {
  loadRubric,
  loadCategoricalRubric,
  isCategoricalRubric,
  type AnyRubric,
  type CategoricalLabel,
  type CategoricalRubric,
  type Rubric,
  type RubricCriterion,
} from "./rubric";
export { JudgeError } from "./errors";
export {
  buildCategoricalJudgePrompt,
  buildJudgePrompt,
  type JudgeTarget,
  type PromptParts,
} from "./prompt-template";
export {
  renderTranscriptDigest,
  TRANSCRIPT_DIGEST_MAX_CHARS,
  TRANSCRIPT_EVENT_MAX_CHARS,
} from "./transcript-digest";
export {
  buildPairwisePrompt,
  judgePair,
  judgePairwise,
  type JudgePairOptions,
  type JudgePairwiseOptions,
  type PairwiseCallVerdict,
  type PairwiseComparison,
  type PairwiseOrderVerdict,
  type PairwisePromptParts,
} from "./pairwise";
