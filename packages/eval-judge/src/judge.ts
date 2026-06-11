import {
  type ProviderAdapter,
  collectFinalMessage,
  extractToolUse,
} from "@crewhaus/adapter-anthropic";
import type { Sample } from "@crewhaus/eval-dataset";
import type { GradeResult, Grader, RunResult } from "@crewhaus/eval-grader";
import { createLogger } from "@crewhaus/logging";
import { resolveModel } from "@crewhaus/model-router";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { JudgeError } from "./errors";
import { buildJudgePrompt } from "./prompt-template";
import type { Rubric } from "./rubric";

export const DEFAULT_JUDGE_MODEL = "claude-sonnet-4-5";

const logger = createLogger({ bindings: { module: "eval-judge" } });

export type JudgeOptions = {
  readonly rubric: Rubric;
  readonly sample: Sample;
  readonly agentOutput: string;
  /**
   * Section 17 — optional pre-built ProviderAdapter. When omitted, the
   * judge resolves `model` (or `DEFAULT_JUDGE_MODEL`) through the
   * model-router so any provider — Anthropic, OpenAI, Gemini,
   * Bedrock — can act as the judge model.
   */
  readonly adapter?: ProviderAdapter;
  readonly model?: string;
  readonly maxTokens?: number;
};

export type JudgeResult = {
  readonly score: 1 | 2 | 3 | 4 | 5;
  readonly rationale: string;
  readonly criterionScores: Record<string, number>;
  /** The sentinel used for this call's untrusted-block markers. */
  readonly sentinel: string;
};

const SubmitScoreSchema = z.object({
  score: z.number().int().min(1).max(5),
  rationale: z.string().min(1),
  criterion_scores: z.record(z.number().int().min(1).max(5)),
});

const submitScoreInputSchema = zodToJsonSchema(SubmitScoreSchema, {
  $refStrategy: "none",
}) as Record<string, unknown>;

export async function judge(opts: JudgeOptions): Promise<JudgeResult> {
  const model = opts.model ?? DEFAULT_JUDGE_MODEL;
  // Section 17 — resolve via model-router unless caller injected an
  // adapter. The OAuth Claude-Code prefix logic now lives inside
  // adapter-anthropic; we no longer need to handle it here.
  //
  // Wire model: when the router resolves the string, the request MUST
  // carry the resolution's *stripped* modelId (e.g. "openai/gpt-4o-mini"
  // → "gpt-4o-mini") — providers reject the full prefixed router string
  // with model-not-found. When the caller injects an adapter we keep the
  // model as-is (tests pass synthetic ids the stub adapter ignores).
  // Mirrors planner's resolution (packages/planner/src/index.ts).
  const resolution = opts.adapter
    ? { adapter: opts.adapter, modelId: model }
    : await resolveModel(model);
  const adapter: ProviderAdapter = resolution.adapter;
  const wireModelId: string = resolution.modelId;
  const { system, user, sentinel } = buildJudgePrompt({
    rubric: opts.rubric,
    input: opts.sample.input,
    expectedOutput: opts.sample.expected_output,
    agentOutput: opts.agentOutput,
  });

  const final = await collectFinalMessage(
    adapter.stream({
      model: wireModelId,
      system: [{ type: "text", text: system }],
      messages: [{ role: "user", content: user }],
      tools: [
        {
          name: "submit_score",
          description:
            "Submit the overall 1–5 score, a brief rationale, and the per-criterion scores. " +
            "The judge MUST call this tool — never reply in plain text.",
          input_schema: submitScoreInputSchema,
        },
      ],
      toolChoice: { type: "tool", name: "submit_score" },
      maxTokens: opts.maxTokens ?? 1024,
    }),
  );

  const toolUse = extractToolUse(final, "submit_score");
  if (!toolUse) {
    throw new JudgeError(`judge did not call submit_score (stop_reason=${final.stopReason})`);
  }

  const parsed = SubmitScoreSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new JudgeError(`judge submit_score had invalid shape: ${parsed.error.message}`);
  }

  // Validate criterion_scores has an entry for every rubric criterion (no extras).
  const expectedNames = new Set(opts.rubric.criteria.map((c) => c.name));
  const actualNames = Object.keys(parsed.data.criterion_scores);
  const missing = [...expectedNames].filter((n) => !actualNames.includes(n));
  if (missing.length > 0) {
    logger.warn("judge.criteria_missing", { missing });
  }

  return {
    score: parsed.data.score as 1 | 2 | 3 | 4 | 5,
    rationale: parsed.data.rationale,
    criterionScores: parsed.data.criterion_scores,
    sentinel,
  };
}

/**
 * Wrap a `judge` call in a `Grader`. Maps 1–5 → 0..1 via (n-1)/4 and uses
 * the rubric's `passing_score` as the gate.
 */
export function createJudgeGrader(
  rubric: Rubric,
  opts: { adapter?: ProviderAdapter; model?: string } = {},
): Grader {
  return async (sample: Sample, run: RunResult): Promise<GradeResult> => {
    const result = await judge({
      rubric,
      sample,
      agentOutput: run.agentOutput,
      ...(opts.adapter !== undefined ? { adapter: opts.adapter } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    });
    const passing = rubric.passing_score;
    return {
      passed: result.score >= passing,
      score: (result.score - 1) / 4,
      rationale: `judge=${result.score} (need ≥${passing}): ${result.rationale}`,
    };
  };
}
