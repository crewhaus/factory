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
 * Reference: build-roadmap.md §16 — risk callout `🔴 Prompt-injection in eval-judge`.
 */
export { judge, createJudgeGrader, DEFAULT_JUDGE_MODEL } from "./judge";
export type { JudgeOptions, JudgeResult } from "./judge";
export { loadRubric, type Rubric, type RubricCriterion } from "./rubric";
export { JudgeError } from "./errors";
export { buildJudgePrompt, type PromptParts } from "./prompt-template";
