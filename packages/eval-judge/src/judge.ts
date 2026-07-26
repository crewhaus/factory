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
import { buildCategoricalJudgePrompt, buildJudgePrompt } from "./prompt-template";
import type { JudgeTarget } from "./prompt-template";
import type { AnyRubric, CategoricalRubric, Rubric } from "./rubric";
import { isCategoricalRubric } from "./rubric";
import { renderTranscriptDigest } from "./transcript-digest";

export const DEFAULT_JUDGE_MODEL = "claude-sonnet-4-5";

const logger = createLogger({ bindings: { module: "eval-judge" } });

/**
 * C35 — judge token metering sink. Judge calls are model calls the eval
 * pays for, and until now their usage was discarded here (the adapter
 * reports it; nothing read it), so `llm_judge` spend was invisible to the
 * run summary, the matrix estimate, and every budget conversation.
 *
 * The sink is called ONCE per judge model call with the provider-reported
 * usage and the model string as the CALLER named it (router grammar — the
 * same key the pricing table is looked up by). It fires even when the call's
 * response then fails validation: those tokens were really spent.
 *
 * Purely observational: the sink never influences the verdict, and a sink
 * that throws would break judging, so callers must keep it total.
 */
export type JudgeUsageSink = (usage: {
  readonly model: string;
  readonly input: number;
  readonly output: number;
}) => void;

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
  /**
   * NEW-graders-3 — what `agentOutput` IS: the agent's final `output`
   * (default) or a rendered run-`transcript` digest. Only changes the
   * prompt framing (block label + trajectory instructions) — the caller is
   * responsible for supplying the digest text (see
   * `renderTranscriptDigest`); `createJudgeGrader` does both.
   */
  readonly target?: JudgeTarget;
  /** C35 — per-call token metering sink (see {@link JudgeUsageSink}). */
  readonly onUsage?: JudgeUsageSink;
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
    ...(opts.target !== undefined ? { target: opts.target } : {}),
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

  // C35 — meter BEFORE validating the response: a judge call that answered
  // in the wrong shape still burned the tokens it burned.
  opts.onUsage?.({ model, input: final.usage.input, output: final.usage.output });

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

/** NEW-graders-2 — options for {@link judgeCategorical}. Mirrors
 *  {@link JudgeOptions} with a categorical rubric (no repeats/panel —
 *  see `createJudgeGrader`). */
export type CategoricalJudgeOptions = {
  readonly rubric: CategoricalRubric;
  readonly sample: Sample;
  readonly agentOutput: string;
  readonly adapter?: ProviderAdapter;
  readonly model?: string;
  readonly maxTokens?: number;
  /** NEW-HUNT-2 — pinned to 0 by default, exactly like the scalar judge. */
  readonly temperature?: number;
  /** NEW-graders-3 — same prompt-framing switch as {@link JudgeOptions.target}. */
  readonly target?: JudgeTarget;
  /** C35 — per-call token metering sink (see {@link JudgeUsageSink}). */
  readonly onUsage?: JudgeUsageSink;
};

/** NEW-graders-2 — one categorical judge verdict. */
export type CategoricalJudgeResult = {
  /** The chosen label's name — always one of the rubric's declared labels
   *  (the tool schema constrains the judge to the declared vocabulary and
   *  the response is re-validated against it). */
  readonly label: string;
  /** The chosen label's DECLARED score (0..1) — the judge never invents
   *  numbers, it only classifies. */
  readonly score: number;
  readonly rationale: string;
  /** A3 — `true` when the judge declined to classify (insufficient
   *  evidence); `label`/`score` are then its nominal closest pick — treat
   *  them as unusable and route the sample to human review. */
  readonly abstain: boolean;
  readonly confidence?: number;
  /** The sentinel used for this call's untrusted-block markers. */
  readonly sentinel: string;
};

/**
 * NEW-graders-2 — run one categorical judge call: the judge picks exactly
 * one of the rubric's labels via a forced `submit_label` tool call (the
 * sibling of the scalar `submit_score` — scalar judging is untouched).
 * Same sentinel injection defense, model-router resolution, and NEW-HUNT-2
 * temperature pin as {@link judge}.
 */
export async function judgeCategorical(
  opts: CategoricalJudgeOptions,
): Promise<CategoricalJudgeResult> {
  const model = opts.model ?? DEFAULT_JUDGE_MODEL;
  const resolution = opts.adapter
    ? { adapter: opts.adapter, modelId: model }
    : await resolveModel(model);
  const adapter: ProviderAdapter = resolution.adapter;
  const wireModelId: string = resolution.modelId;
  const { system, user, sentinel } = buildCategoricalJudgePrompt({
    rubric: opts.rubric,
    input: opts.sample.input,
    expectedOutput: opts.sample.expected_output,
    agentOutput: opts.agentOutput,
    ...(opts.target !== undefined ? { target: opts.target } : {}),
  });

  // The submit_label schema is built per rubric: `label` is a closed enum of
  // the declared names, so the model cannot answer outside the vocabulary
  // and a hallucinated label is a schema violation, not a silent miss.
  const names = opts.rubric.labels.map((l) => l.name);
  const SubmitLabelSchema = z.object({
    label: z.enum(names as [string, ...string[]]),
    rationale: z.string().min(1),
    abstain: z
      .boolean()
      .optional()
      .describe(
        "Set true when the evidence is insufficient to classify honestly — abstain instead of guessing. Still pick the closest label.",
      ),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Self-reported confidence in this verdict, 0 (a guess) to 1 (certain)."),
  });
  const submitLabelInputSchema = zodToJsonSchema(SubmitLabelSchema, {
    $refStrategy: "none",
  }) as Record<string, unknown>;

  const final = await collectFinalMessage(
    adapter.stream({
      model: wireModelId,
      system: [{ type: "text", text: system }],
      messages: [{ role: "user", content: user }],
      tools: [
        {
          name: "submit_label",
          description:
            "Submit the single label that best classifies the agent's response, with a brief " +
            "rationale. Set `abstain: true` (still picking the closest label) when the evidence " +
            "is insufficient to classify honestly. " +
            "The judge MUST call this tool — never reply in plain text.",
          input_schema: submitLabelInputSchema,
        },
      ],
      toolChoice: { type: "tool", name: "submit_label" },
      maxTokens: opts.maxTokens ?? 1024,
      // NEW-HUNT-2 — pinned decoding, identical to the scalar judge.
      temperature: opts.temperature ?? 0,
    }),
  );

  // C35 — meter every judge model call, validation outcome notwithstanding.
  opts.onUsage?.({ model, input: final.usage.input, output: final.usage.output });

  const toolUse = extractToolUse(final, "submit_label");
  if (!toolUse) {
    throw new JudgeError(`judge did not call submit_label (stop_reason=${final.stopReason})`);
  }
  const parsed = SubmitLabelSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new JudgeError(`judge submit_label had invalid shape: ${parsed.error.message}`);
  }
  const chosen = opts.rubric.labels.find((l) => l.name === parsed.data.label);
  if (chosen === undefined) {
    // Unreachable through the enum schema — kept as a hard invariant.
    throw new JudgeError(`judge chose undeclared label "${parsed.data.label}"`);
  }
  return {
    label: chosen.name,
    score: chosen.score,
    rationale: parsed.data.rationale,
    abstain: parsed.data.abstain ?? false,
    ...(parsed.data.confidence !== undefined ? { confidence: parsed.data.confidence } : {}),
    sentinel,
  };
}

/** A2 — normalized-vote-entropy cut above which a panel verdict is flagged
 *  `needsReview` (strictly above; 0.8 lets a 4–1 split pass while 2–1 and
 *  3–2 splits route to review). */
export const PANEL_NEEDS_REVIEW_ENTROPY = 0.8;

/**
 * A2 — normalized Shannon entropy of a pass/fail vote split, in [0, 1]
 * (binary, so log₂ normalization is the identity): 0 = unanimous,
 * 1 = an even split. An empty vote set reads 0 — no votes, no disagreement.
 */
export function normalizedVoteEntropy(passVotes: number, total: number): number {
  if (total === 0) return 0;
  const term = (p: number): number => (p <= 0 ? 0 : -p * Math.log2(p));
  const p = passVotes / total;
  return term(p) + term(1 - p);
}

/** Median of a non-empty score list (mean of the middle two when even). */
function medianOf(values: ReadonlyArray<number>): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Mean of the reported confidences, or undefined when none were reported. */
function meanConfidenceOf(
  results: ReadonlyArray<{ readonly confidence?: number }>,
): number | undefined {
  const confidences = results.flatMap((r) => (r.confidence !== undefined ? [r.confidence] : []));
  return confidences.length > 0
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length
    : undefined;
}

/**
 * A12 — mean per-criterion breakdown over the verdicts that carried one,
 * preserving first-seen criterion order (matches the pre-refactor repeats
 * aggregation byte-for-byte).
 */
function meanCriterionDetails(
  details: ReadonlyArray<Readonly<Record<string, number>> | undefined>,
): Record<string, number> {
  const sums = new Map<string, { sum: number; n: number }>();
  for (const d of details) {
    if (d === undefined) continue;
    for (const [name, value] of Object.entries(d)) {
      const acc = sums.get(name) ?? { sum: 0, n: 0 };
      sums.set(name, { sum: acc.sum + value, n: acc.n + 1 });
    }
  }
  return Object.fromEntries([...sums.entries()].map(([name, { sum, n }]) => [name, sum / n]));
}

/** Internal — one judge model's aggregated outcome over its repeat calls
 *  (NEW-HUNT-2 single-model repeats AND each A2 panelist's own repeats). */
type RepeatAggregate =
  | {
      readonly abstained: true;
      readonly rationale: string;
      readonly confidence?: number;
    }
  | {
      readonly abstained: false;
      readonly median: number;
      readonly rationale: string;
      readonly confidence?: number;
      readonly detail?: Record<string, number>;
    };

/**
 * NEW-HUNT-2 — fold k repeat verdicts from ONE judge model into a single
 * outcome: strict-majority abstain ⇒ abstained; else the median score over
 * the non-abstaining repeats, with per-repeat scores + modal agreement in
 * the rationale. Shared verbatim between the single-model repeats path and
 * the A2 per-panelist repeats composition.
 */
function aggregateRepeats(results: ReadonlyArray<JudgeResult>, passing: number): RepeatAggregate {
  const abstainers = results.filter((r) => r.abstain);
  const scored = results.filter((r) => !r.abstain);
  const perRepeat = results.map((r) => (r.abstain ? "abstain" : String(r.score))).join(", ");
  const meanConfidence = meanConfidenceOf(results);

  // Majority abstain (strict — an odd panel cannot tie) = abstained verdict.
  if (abstainers.length * 2 > results.length) {
    const first = abstainers[0] as JudgeResult;
    return {
      abstained: true,
      rationale: `judge abstained (${abstainers.length}/${results.length} repeats abstained [${perRepeat}], need ≥${passing}): ${first.rationale}`,
      ...(meanConfidence !== undefined ? { confidence: meanConfidence } : {}),
    };
  }

  // Median over the non-abstaining repeats (a minority abstain leaves an
  // even panel — the median is then the mean of the middle two).
  const scores = scored.map((r) => r.score as number);
  const median = medianOf(scores);
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
  const detail = meanCriterionDetails(scored.map((r) => r.criterionScores));
  return {
    abstained: false,
    median,
    rationale: `judge=${median} (median of ${results.length} repeats [${perRepeat}], agreement ${modalCount}/${scored.length}, need ≥${passing}): ${representative.rationale}`,
    ...(meanConfidence !== undefined ? { confidence: meanConfidence } : {}),
    ...(Object.keys(detail).length > 0 ? { detail } : {}),
  };
}

/** Internal — one A2 panelist's resolved verdict (its repeats already folded). */
type PanelistOutcome = {
  readonly model: string;
  /** 1–5, fractional when a per-panelist repeats median composed it;
   *  absent when this panelist abstained. */
  readonly score?: number;
  readonly passed: boolean;
  readonly abstained: boolean;
  readonly rationale: string;
  readonly confidence?: number;
  readonly detail?: Record<string, number>;
};

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
 *
 * A2 — `judges` (non-empty model list) fans out a MULTI-MODEL panel that
 * OVERRIDES `model`: one temperature-pinned `judge` call per panelist,
 * median score over the non-abstaining panelists, pass by STRICT majority
 * of their pass votes (an even panel's tie conservatively fails), and the
 * grade records per-panelist scores plus the normalized entropy of the
 * pass/fail vote split (`panel`). Entropy above
 * {@link PANEL_NEEDS_REVIEW_ENTROPY} additionally sets `needsReview: true`
 * — the verdict still counts, but the runner lists the sample for human
 * review. A strict majority of abstaining panelists makes the whole
 * verdict abstained, exactly like repeats. When BOTH `judges` and
 * `repeats` are declared, repeats apply PER PANELIST: each panelist's own
 * verdict is its repeats-median (the NEW-HUNT-2 fold above), and the panel
 * then votes over those folded verdicts — k×m calls total, kept
 * deliberately simple.
 *
 * NEW-graders-3 — `target: "transcript"` judges the run TRAJECTORY: every
 * judge call receives `renderTranscriptDigest(run)` (bounded,
 * most-recent-turns-win) in a sentinel-wrapped "Agent transcript" block
 * instead of the final output. Default `"output"` — today's exact behavior.
 *
 * NEW-graders-2 — a CATEGORICAL rubric (`kind: categorical`) dispatches to
 * `judgeCategorical`: the judge picks exactly one label, `passed` = the
 * label is in `passing_labels`, `score` = the label's declared 0..1 score
 * (no 1–5 projection). `temperature`/`target` apply as usual;
 * `repeats`/`judges` are NOT yet defined for label votes and are rejected
 * loudly at grader build (the graders.yaml schema already rejects the
 * combination at parse). Scalar rubrics are byte-identical to before.
 */
export function createJudgeGrader(
  rubric: AnyRubric,
  opts: {
    adapter?: ProviderAdapter;
    model?: string;
    temperature?: number;
    repeats?: number;
    judges?: ReadonlyArray<string>;
    target?: JudgeTarget;
    /**
     * C35 — token metering sink threaded into EVERY judge call this grader
     * makes: single verdicts, each repeat, and each panelist (the sink
     * receives that call's own model string, so a panel meters per model).
     */
    onUsage?: JudgeUsageSink;
  } = {},
): Grader {
  const repeats = opts.repeats ?? 1;
  if (!Number.isInteger(repeats) || repeats < 1 || repeats % 2 === 0) {
    throw new JudgeError(`judge repeats must be an odd positive integer, got ${repeats}`);
  }
  if (opts.judges !== undefined && opts.judges.length === 0) {
    throw new JudgeError("judge panel (judges) must name at least one model");
  }
  // NEW-graders-3 — what the judge reads: the final output (default) or the
  // bounded transcript digest.
  const judgedText = (run: RunResult): string =>
    opts.target === "transcript" ? renderTranscriptDigest(run) : run.agentOutput;

  // NEW-graders-2 — categorical dispatch (single-call only; see doc above).
  if (isCategoricalRubric(rubric)) {
    if (repeats !== 1 || opts.judges !== undefined) {
      throw new JudgeError(
        "categorical rubrics do not support `repeats` or `judges` panels yet — label votes need a majority-label fold that scalar-median aggregation cannot provide; drop the fields or use a scalar rubric",
      );
    }
    const passingSet = new Set(rubric.passing_labels);
    const passingText = rubric.passing_labels.join("|");
    return async (sample: Sample, run: RunResult): Promise<GradeResult> => {
      const result = await judgeCategorical({
        rubric,
        sample,
        agentOutput: judgedText(run),
        ...(opts.adapter !== undefined ? { adapter: opts.adapter } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.target !== undefined ? { target: opts.target } : {}),
        ...(opts.onUsage !== undefined ? { onUsage: opts.onUsage } : {}),
      });
      if (result.abstain) {
        // A3 — same conservative-placeholder contract as the scalar path:
        // the closest-pick label is a guess, not a verdict.
        return {
          passed: false,
          score: 0,
          rationale: `judge abstained (closest label "${result.label}", passing: ${passingText}): ${result.rationale}`,
          abstained: true,
          ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
        };
      }
      return {
        passed: passingSet.has(result.label),
        score: result.score,
        rationale: `judge label="${result.label}" (score ${result.score}, passing: ${passingText}): ${result.rationale}`,
        ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
      };
    };
  }

  const passing = rubric.passing_score;
  const judgeOnce = (sample: Sample, run: RunResult, model?: string): Promise<JudgeResult> => {
    const effectiveModel = model ?? opts.model;
    return judge({
      rubric,
      sample,
      agentOutput: judgedText(run),
      ...(opts.adapter !== undefined ? { adapter: opts.adapter } : {}),
      ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.target !== undefined ? { target: opts.target } : {}),
      ...(opts.onUsage !== undefined ? { onUsage: opts.onUsage } : {}),
    });
  };

  // A2 — multi-model panel path (judges overrides model).
  if (opts.judges !== undefined) {
    const panelModels = opts.judges;
    return async (sample: Sample, run: RunResult): Promise<GradeResult> => {
      const outcomes: PanelistOutcome[] = await Promise.all(
        panelModels.map(async (model): Promise<PanelistOutcome> => {
          const results = await Promise.all(
            Array.from({ length: repeats }, () => judgeOnce(sample, run, model)),
          );
          if (results.length === 1) {
            const r = results[0] as JudgeResult;
            if (r.abstain) {
              return {
                model,
                passed: false,
                abstained: true,
                rationale: r.rationale,
                ...(r.confidence !== undefined ? { confidence: r.confidence } : {}),
              };
            }
            return {
              model,
              score: r.score,
              passed: r.score >= passing,
              abstained: false,
              rationale: r.rationale,
              ...(r.confidence !== undefined ? { confidence: r.confidence } : {}),
              ...(Object.keys(r.criterionScores).length > 0 ? { detail: r.criterionScores } : {}),
            };
          }
          const agg = aggregateRepeats(results, passing);
          if (agg.abstained) {
            return {
              model,
              passed: false,
              abstained: true,
              rationale: agg.rationale,
              ...(agg.confidence !== undefined ? { confidence: agg.confidence } : {}),
            };
          }
          return {
            model,
            score: agg.median,
            passed: agg.median >= passing,
            abstained: false,
            rationale: agg.rationale,
            ...(agg.confidence !== undefined ? { confidence: agg.confidence } : {}),
            ...(agg.detail !== undefined ? { detail: agg.detail } : {}),
          };
        }),
      );

      const abstainers = outcomes.filter((o) => o.abstained);
      const scored = outcomes.filter((o) => !o.abstained);
      const perPanelist = outcomes
        .map((o) => `${o.model}=${o.abstained ? "abstain" : String(o.score)}`)
        .join(", ");
      const meanConfidence = meanConfidenceOf(outcomes);
      const passVotes = scored.filter((o) => o.passed).length;
      const voteEntropy = normalizedVoteEntropy(passVotes, scored.length);
      const panel: NonNullable<GradeResult["panel"]> = {
        panelists: outcomes.map((o) => ({
          model: o.model,
          ...(o.score !== undefined ? { score: o.score } : {}),
          passed: o.passed,
          ...(o.abstained ? { abstained: true } : {}),
        })),
        voteEntropy,
      };

      // Strict-majority abstain = abstained verdict, mirroring repeats. The
      // per-panelist evidence still rides along for the human reviewer; no
      // `needsReview` on top — the sample already routes to needs-human.
      if (abstainers.length * 2 > outcomes.length) {
        const first = abstainers[0] as PanelistOutcome;
        return {
          passed: false,
          score: 0,
          rationale: `judge abstained (${abstainers.length}/${outcomes.length} panelists abstained [${perPanelist}], need ≥${passing}): ${first.rationale}`,
          abstained: true,
          ...(meanConfidence !== undefined ? { confidence: meanConfidence } : {}),
          panel,
        };
      }

      const median = medianOf(scored.map((o) => o.score as number));
      // Majority pass — STRICT majority of the scored panelists' pass
      // votes; an even panel's tie conservatively fails (and reads
      // entropy 1, so it is flagged needsReview below).
      const passed = passVotes * 2 > scored.length;
      // Representative rationale: the scored panelist closest to the median.
      let representative = scored[0] as PanelistOutcome;
      for (const o of scored) {
        if (
          Math.abs((o.score as number) - median) <
          Math.abs((representative.score as number) - median)
        ) {
          representative = o;
        }
      }
      const detail = meanCriterionDetails(scored.map((o) => o.detail));
      const needsReview = voteEntropy > PANEL_NEEDS_REVIEW_ENTROPY;
      return {
        passed,
        score: (median - 1) / 4,
        rationale: `judge=${median} (panel of ${outcomes.length} [${perPanelist}], votes ${passVotes}/${scored.length} pass, entropy ${voteEntropy.toFixed(2)}, need ≥${passing}): ${representative.rationale}`,
        ...(meanConfidence !== undefined ? { confidence: meanConfidence } : {}),
        ...(Object.keys(detail).length > 0 ? { detail } : {}),
        panel,
        ...(needsReview ? { needsReview: true } : {}),
      };
    };
  }

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
    const agg = aggregateRepeats(results, passing);
    if (agg.abstained) {
      return {
        passed: false,
        score: 0,
        rationale: agg.rationale,
        abstained: true,
        ...(agg.confidence !== undefined ? { confidence: agg.confidence } : {}),
      };
    }
    return {
      passed: agg.median >= passing,
      score: (agg.median - 1) / 4,
      rationale: agg.rationale,
      ...(agg.confidence !== undefined ? { confidence: agg.confidence } : {}),
      ...(agg.detail !== undefined ? { detail: agg.detail } : {}),
    };
  };
}
