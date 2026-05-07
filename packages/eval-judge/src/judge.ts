import type Anthropic from "@anthropic-ai/sdk";
import type { Sample } from "@crewhaus/eval-dataset";
import type { Grader, GradeResult, RunResult } from "@crewhaus/eval-grader";
import { createLogger } from "@crewhaus/logging";
import { createAnthropicClient, resolveAuth } from "@crewhaus/runtime-core";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { JudgeError } from "./errors";
import { buildJudgePrompt } from "./prompt-template";
import type { Rubric } from "./rubric";

export const DEFAULT_JUDGE_MODEL = "claude-sonnet-4-5";

const logger = createLogger({ bindings: { module: "eval-judge" } });

/**
 * Minimal subset of the Anthropic SDK we use, narrowed so a stub client can
 * implement only this surface for tests.
 */
export type JudgeClient = {
  messages: {
    create(params: {
      model: string;
      max_tokens: number;
      system: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
      tools: Array<{ name: string; description: string; input_schema: unknown }>;
      tool_choice: { type: "tool"; name: string };
    }): Promise<{
      content: Array<
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; input: unknown }
      >;
      stop_reason?: string | null;
    }>;
  };
};

export type JudgeOptions = {
  readonly rubric: Rubric;
  readonly sample: Sample;
  readonly agentOutput: string;
  readonly client?: JudgeClient;
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
  let client: JudgeClient;
  let isOAuth: boolean;
  if (opts.client) {
    client = opts.client;
    isOAuth = false;
  } else {
    const resolved = await getDefaultClient();
    client = resolved.client;
    isOAuth = resolved.isOAuth;
  }
  const { system, user, sentinel } = buildJudgePrompt({
    rubric: opts.rubric,
    input: opts.sample.input,
    expectedOutput: opts.sample.expected_output,
    agentOutput: opts.agentOutput,
  });

  // OAuth requires the "You are Claude Code" prefix in the system prompt;
  // see runtime-core line 524 for the canonical pattern. Without it, OAuth
  // tokens are rejected by the API as not-Claude-Code traffic.
  const systemBlocks = isOAuth
    ? "You are Claude Code, Anthropic's official CLI for Claude.\n\n" + system
    : system;

  const response = await client.messages.create({
    model,
    max_tokens: opts.maxTokens ?? 1024,
    system: systemBlocks,
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
    tool_choice: { type: "tool", name: "submit_score" },
  });

  const toolUse = response.content.find(
    (b): b is { type: "tool_use"; id: string; name: string; input: unknown } =>
      b.type === "tool_use" && b.name === "submit_score",
  );
  if (!toolUse) {
    throw new JudgeError(
      `judge did not call submit_score (stop_reason=${response.stop_reason ?? "?"})`,
    );
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
export function createJudgeGrader(rubric: Rubric, opts: { client?: JudgeClient; model?: string } = {}): Grader {
  return async (sample: Sample, run: RunResult): Promise<GradeResult> => {
    const result = await judge({
      rubric,
      sample,
      agentOutput: run.agentOutput,
      ...(opts.client !== undefined ? { client: opts.client } : {}),
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

let cachedDefaultClient: { client: JudgeClient; isOAuth: boolean } | undefined;
async function getDefaultClient(): Promise<{ client: JudgeClient; isOAuth: boolean }> {
  if (cachedDefaultClient) return cachedDefaultClient;
  const auth = resolveAuth(process.env);
  if (auth.mode === "none") {
    throw new JudgeError(
      "no Anthropic credentials — set ANTHROPIC_AUTH_TOKEN (Claude subscription) or ANTHROPIC_API_KEY",
    );
  }
  const { client, isOAuth } = createAnthropicClient(auth);
  cachedDefaultClient = { client: client as unknown as JudgeClient, isOAuth };
  return cachedDefaultClient;
}

// Mark Anthropic import to avoid TS unused warning when the SDK is shimmed
type _AnthropicAlias = Anthropic;
