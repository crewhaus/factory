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
  /**
   * NEW-HUNT-2 — sampling temperature for the judge call. Defaults to `0`
   * (pinned): deterministic-as-possible judging is the point of a judge,
   * and provider-default (~1.0) score variance alone can flip strict
   * gates run-to-run. Override per rubric via the `llm_judge` grader's
   * `temperature` field.
   */
  readonly temperature?: number;
};

export type JudgeResult = {
  readonly score: 1 | 2 | 3 | 4 | 5;
  readonly rationale: string;
  readonly criterionScores: Record<string, number>;
  /** A3 — `true` when the judge declined to score (insufficient evidence).
   *  The `score` is then the judge's nominal best estimate — treat it as
   *  unusable and route the sample to human review. */
  readonly abstain: boolean;
  /** Judge-reported confidence in the verdict, 0..1 (absent when the judge
   *  did not report one). */
  readonly confidence?: number;
  /** The sentinel used for this call's untrusted-block markers. */
  readonly sentinel: string;
};

const SubmitScoreSchema = z.object({
  score: z.number().int().min(1).max(5),
  rationale: z.string().min(1),
  criterion_scores: z.record(z.number().int().min(1).max(5)),
  // A3 — abstention + self-reported confidence. Both optional so judges
  // (and recorded fixtures) predating abstention stay schema-valid.
  abstain: z
    .boolean()
    .optional()
    .describe(
      "Set true when the evidence is insufficient to score honestly — abstain instead of guessing. Still fill in every required field.",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Self-reported confidence in this verdict, 0 (a guess) to 1 (certain)."),
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
            "Set `abstain: true` (still filling every required field) when the evidence is " +
            "insufficient to score honestly. " +
            "The judge MUST call this tool — never reply in plain text.",
          input_schema: submitScoreInputSchema,
        },
      ],
      toolChoice: { type: "tool", name: "submit_score" },
      maxTokens: opts.maxTokens ?? 1024,
      // NEW-HUNT-2 — judge decoding is PINNED to temperature 0 unless the
      // rubric overrides it. Adapters without a native temperature control
      // ignore the field (capability-dependent, like `thinking`).
      temperature: opts.temperature ?? 0,
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
    abstain: parsed.data.abstain ?? false,
    ...(parsed.data.confidence !== undefined ? { confidence: parsed.data.confidence } : {}),
    sentinel,
  };
}

/**
 * Wrap a `judge` call in a `Grader`. Maps 1–5 → 0..1 via (n-1)/4 and uses
 * the rubric's `passing_score` as the gate.
 *
 * A3 — an abstaining judge yields `{ abstained: true, passed: false,
 * score: 0 }` so the runner can route the sample to human review instead
 * of counting a guessed verdict.
 *
 * NEW-HUNT-2 — `repeats` (odd, default 1) fans out a judge panel and takes
 * the MEDIAN score; per-repeat scores and modal agreement land in the
 * rationale. Abstaining repeats are excluded from the median; a strict
 * majority of abstains makes the whole verdict abstained (odd panels keep
 * that vote tie-proof). `temperature` (default 0 — pinned) threads to
 * every call.
 */
export function createJudgeGrader(
  rubric: Rubric,
  opts: { adapter?: ProviderAdapter; model?: string; temperature?: number; repeats?: number } = {},
): Grader {
  const repeats = opts.repeats ?? 1;
  if (!Number.isInteger(repeats) || repeats < 1 || repeats % 2 === 0) {
    throw new JudgeError(`judge repeats must be an odd positive integer, got ${repeats}`);
  }
  const passing = rubric.passing_score;
  const judgeOnce = (sample: Sample, run: RunResult): Promise<JudgeResult> =>
    judge({
      rubric,
      sample,
      agentOutput: run.agentOutput,
      ...(opts.adapter !== undefined ? { adapter: opts.adapter } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    });

  return async (sample: Sample, run: RunResult): Promise<GradeResult> => {
    if (repeats === 1) {
      const result = await judgeOnce(sample, run);
      if (result.abstain) {
        return {
          passed: false,
          score: 0,
          rationale: `judge abstained (need ≥${passing}): ${result.rationale}`,
          abstained: true,
          ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
        };
      }
      return {
        passed: result.score >= passing,
        score: (result.score - 1) / 4,
        rationale: `judge=${result.score} (need ≥${passing}): ${result.rationale}`,
        ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
        // A12 — the per-criterion breakdown survives into the grade (raw
        // 1–5 per criterion). Abstained verdicts above deliberately carry
        // none: their criterion scores are the judge's guesses.
        ...(Object.keys(result.criterionScores).length > 0
          ? { detail: result.criterionScores }
          : {}),
      };
    }

    const results = await Promise.all(
      Array.from({ length: repeats }, () => judgeOnce(sample, run)),
    );
    const abstainers = results.filter((r) => r.abstain);
    const scored = results.filter((r) => !r.abstain);
    const perRepeat = results.map((r) => (r.abstain ? "abstain" : String(r.score))).join(", ");
    const confidences = results.flatMap((r) => (r.confidence !== undefined ? [r.confidence] : []));
    const meanConfidence =
      confidences.length > 0
        ? confidences.reduce((a, b) => a + b, 0) / confidences.length
        : undefined;

    // Majority abstain (strict — an odd panel cannot tie) = abstained verdict.
    if (abstainers.length * 2 > results.length) {
      const first = abstainers[0] as JudgeResult;
      return {
        passed: false,
        score: 0,
        rationale: `judge abstained (${abstainers.length}/${results.length} repeats abstained [${perRepeat}], need ≥${passing}): ${first.rationale}`,
        abstained: true,
        ...(meanConfidence !== undefined ? { confidence: meanConfidence } : {}),
      };
    }

    // Median over the non-abstaining repeats (a minority abstain leaves an
    // even panel — the median is then the mean of the middle two).
    const scores = scored.map((r) => r.score as number).sort((a, b) => a - b);
    const mid = Math.floor(scores.length / 2);
    const median =
      scores.length % 2 === 1
        ? (scores[mid] as number)
        : ((scores[mid - 1] as number) + (scores[mid] as number)) / 2;
    // Modal agreement — how many scored repeats landed on the panel's most
    // common score. 3/3 = unanimous; 1/3 = every repeat disagreed.
    const freq = new Map<number, number>();
    for (const s of scores) freq.set(s, (freq.get(s) ?? 0) + 1);
    const modalCount = Math.max(...freq.values());
    // Representative rationale: the scored repeat closest to the median.
    let representative = scored[0] as JudgeResult;
    for (const r of scored) {
      if (Math.abs(r.score - median) < Math.abs(representative.score - median)) representative = r;
    }
    // A12 — per-criterion breakdown for a panel: the mean per criterion over
    // the scored (non-abstaining) repeats, so the decomposed signal survives
    // panel aggregation the same way the overall score does.
    const criterionSums = new Map<string, { sum: number; n: number }>();
    for (const r of scored) {
      for (const [name, value] of Object.entries(r.criterionScores)) {
        const acc = criterionSums.get(name) ?? { sum: 0, n: 0 };
        criterionSums.set(name, { sum: acc.sum + value, n: acc.n + 1 });
      }
    }
    const detail = Object.fromEntries(
      [...criterionSums.entries()].map(([name, { sum, n }]) => [name, sum / n]),
    );
    return {
      passed: median >= passing,
      score: (median - 1) / 4,
      rationale: `judge=${median} (median of ${results.length} repeats [${perRepeat}], agreement ${modalCount}/${scored.length}, need ≥${passing}): ${representative.rationale}`,
      ...(meanConfidence !== undefined ? { confidence: meanConfidence } : {}),
      ...(Object.keys(detail).length > 0 ? { detail } : {}),
    };
  };
}
