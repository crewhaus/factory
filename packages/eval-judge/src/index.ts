/**
 * Catalog R-eval `eval-judge` — LLM-as-judge grader.
 *
 * Returns `{ score: 1..5, rationale, criterionScores }`. Sample inputs and
 * agent outputs are treated as **untrusted data** — the prompt template wraps
 * each in a per-call random sentinel and the system prompt explicitly
 * instructs the judge to ignore embedded instructions.
 *
 * Structured output is enforced via Anthropic tool-use (`submit_score` tool)
 * — the judge cannot deviate from the schema.
 *
 * Reference: build-roadmap.md §16 — risk callout `🔴 Prompt-injection in eval-judge`.
 */
export { judge, createJudgeGrader, DEFAULT_JUDGE_MODEL } from "./judge";
export type { JudgeOptions, JudgeResult, JudgeClient } from "./judge";
export { loadRubric, type Rubric, type RubricCriterion } from "./rubric";
export { JudgeError } from "./errors";
export { buildJudgePrompt, type PromptParts } from "./prompt-template";
