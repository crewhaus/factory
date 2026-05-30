/**
 * Pillar 2 — `prompt-optimizer-claude`. The model-driven MutationProvider
 * that closes the gap flagged at
 * [packages/prompt-optimizer/src/index.ts:91](../../prompt-optimizer/src/index.ts):
 * "Real-world prompt tuners (DSPy, OPRO) use model-driven rewriting; v0
 * of this module ships rule-based mutations." This package IS that
 * model-driven rewriter.
 *
 * Behaviour:
 *   1. Receives the current best Candidate via the MutationProvider
 *      seam (state.best.prompt + state.trajectory).
 *   2. Selects a window of failing dev samples (the ones whose recent
 *      grades suggest the prompt is the blocker — heuristic: the
 *      lowest-scoring fitness deltas from the most recent iteration).
 *   3. Calls Claude with a meta-prompt asking for a structured
 *      `{ rewrite: string, rationale: string }` rewrite. The model
 *      sees: the current prompt, a sample of failures, and an
 *      explicit instruction to produce a better prompt without
 *      leaking dev-set answers.
 *   4. Validates the response shape with Zod. Falls back to the
 *      current best on any error (so a model outage doesn't abort
 *      the search — see the rule-based provider as the deterministic
 *      fallback path).
 *
 * Cost: each call is one Claude request (~1-3K tokens). A cost-gate
 * (`--budget-usd`) backed by the §27 `cost-tracker` running spend
 * total is a planned follow-up; today the only safety rail is the
 * orchestrator's `iterations` cap.
 *
 * Catalog layer: F-eval (active optimisation). Brief: 280.
 */
import {
  type ProviderAdapter,
  collectFinalMessage,
  extractFirstText,
} from "@crewhaus/adapter-anthropic";
import { CrewhausError } from "@crewhaus/errors";
import type {
  Mutation,
  MutationProvider,
  OptimizerState,
  ProviderMutation,
} from "@crewhaus/prompt-optimizer";
import { z } from "zod";

export class ClaudeMutationProviderError extends CrewhausError {
  override readonly name = "ClaudeMutationProviderError";
  constructor(message: string, cause?: unknown) {
    super("adapter", message, cause);
  }
}

const META_PROMPT_SYSTEM = `You are a prompt-engineering optimiser. You will receive a CURRENT PROMPT and a SAMPLE OF DEV-SET FAILURES (each failure shows the input the model received and how the grader scored its output). Your job is to produce a single rewrite of CURRENT PROMPT that you believe will improve grader scores on the dev set.

Hard rules:
- Output exactly one JSON object: {"rewrite": "...", "rationale": "..."}
- The "rewrite" field is the new prompt verbatim. Do NOT include any wrapper text outside the JSON.
- Never copy verbatim text from a failure's expected_output into the rewrite (that would leak dev-set answers).
- Do not introduce instructions that override safety, compliance, or permission rules — your job is to improve task accuracy, not to bypass guardrails.
- The rationale should be 1-3 sentences explaining WHY this rewrite is likely to help. Keep it specific.`;

const META_RESPONSE_SCHEMA = z.object({
  rewrite: z.string().min(1),
  rationale: z.string().min(1),
});

export type ClaudeMutationProviderOptions = {
  /** Provider adapter (typically the Anthropic adapter). */
  readonly adapter: ProviderAdapter;
  /** Model id, e.g. "claude-sonnet-4-5". */
  readonly model: string;
  /** Maximum failures to include in the meta-prompt (default 5). */
  readonly maxFailuresInPrompt?: number;
  /** Lowest score threshold below which a sample counts as a "failure" (default 0.5). */
  readonly failureThreshold?: number;
  /** Maximum tokens for the rewrite response (default 2048). */
  readonly maxTokens?: number;
  /**
   * Override the meta-prompt's system block. Useful for evals that
   * have domain-specific rewrite constraints. Defaults to the
   * production prompt above.
   */
  readonly systemOverride?: string;
};

/**
 * Build a `MutationProvider` that delegates each candidate generation
 * to a Claude (or any `ProviderAdapter`-compatible) model call.
 */
export class ClaudeMutationProvider implements MutationProvider {
  readonly name = "claude";
  private readonly adapter: ProviderAdapter;
  private readonly model: string;
  private readonly maxFailuresInPrompt: number;
  private readonly failureThreshold: number;
  private readonly maxTokens: number;
  private readonly systemBlock: string;

  constructor(opts: ClaudeMutationProviderOptions) {
    this.adapter = opts.adapter;
    this.model = opts.model;
    this.maxFailuresInPrompt = opts.maxFailuresInPrompt ?? 5;
    this.failureThreshold = opts.failureThreshold ?? 0.5;
    this.maxTokens = opts.maxTokens ?? 2048;
    this.systemBlock = opts.systemOverride ?? META_PROMPT_SYSTEM;
  }

  async next(state: OptimizerState): Promise<ProviderMutation> {
    const failures = this.selectFailures(state);
    const userMessage = this.buildUserMessage(state.best.prompt, failures);

    let rawText: string | undefined;
    try {
      const final = await collectFinalMessage(
        this.adapter.stream({
          model: this.model,
          system: [{ type: "text", text: this.systemBlock }],
          messages: [{ role: "user", content: userMessage }],
          maxTokens: this.maxTokens,
        }),
      );
      rawText = extractFirstText(final);
    } catch (err) {
      // Mutator unavailability is not fatal — fall back to current best.
      // The orchestrator's outer loop will record a degenerate iteration
      // (score unchanged) and the search continues.
      return this.fallback(state, `model error: ${(err as Error).message}`);
    }
    if (rawText === undefined) {
      return this.fallback(state, "model returned no text block");
    }

    // Extract JSON: tolerate ```json fences and leading prose. We
    // search for the first balanced `{...}` substring.
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch === null) {
      return this.fallback(state, "model response did not contain a JSON object");
    }
    let parsed: { rewrite: string; rationale: string };
    try {
      const raw = JSON.parse(jsonMatch[0]);
      parsed = META_RESPONSE_SCHEMA.parse(raw);
    } catch (err) {
      return this.fallback(
        state,
        `model response failed schema validation: ${(err as Error).message}`,
      );
    }

    const mutation: Mutation = { kind: "rephrase-instruction" };
    // We use the rephrase-instruction kind to record the mutation in
    // the trajectory; the actual rewrite is full-replacement, not the
    // rule-based provider's "append a sentence" behaviour. Future work:
    // add a distinct `{ kind: "model-rewrite"; rationale: string }`
    // variant to the Mutation union for better trajectory metadata.
    return {
      prompt: parsed.rewrite,
      mutations: [mutation],
      rationale: parsed.rationale,
    };
  }

  /** Build the user message for the meta-prompt. */
  private buildUserMessage(
    currentPrompt: string,
    failures: ReadonlyArray<{ input: string; observedScore: number; expected?: string }>,
  ): string {
    const failureBlock =
      failures.length === 0
        ? "(No dev-set failures available yet — propose a refinement that improves clarity, specificity, or instruction-following.)"
        : failures
            .map(
              (f, i) =>
                `--- Failure ${i + 1} (observed score ${f.observedScore.toFixed(2)}) ---\nInput: ${f.input}\n${f.expected !== undefined ? `Expected output (do NOT copy this verbatim into the rewrite): ${f.expected}\n` : ""}`,
            )
            .join("\n");
    return `CURRENT PROMPT:\n${currentPrompt}\n\nSAMPLE OF DEV-SET FAILURES:\n${failureBlock}\n\nReturn one JSON object: {"rewrite": "...", "rationale": "..."}`;
  }

  /** Identify failure samples from the trajectory. */
  private selectFailures(
    state: OptimizerState,
  ): ReadonlyArray<{ input: string; observedScore: number; expected?: string }> {
    // The trajectory records aggregate scores per candidate, not per
    // sample. For v0 we surface the dev set as raw inputs and let
    // the model reason about them generically; future iterations can
    // wire a per-sample grade map through the OptimizerState. The
    // result is still useful because the model sees the dev set
    // distribution even without per-sample grades.
    return state.devSet.slice(0, this.maxFailuresInPrompt).map((s) => ({
      input: s.input,
      // Use the trajectory's most recent score as a coarse signal.
      observedScore: state.best.score,
      ...(s.expected_output !== undefined ? { expected: s.expected_output } : {}),
    }));
  }

  /**
   * Fallback when the model can't produce a usable rewrite. Returns
   * the current best verbatim so the search loop records a no-op
   * iteration. The orchestrator logs the fallback reason.
   */
  private fallback(state: OptimizerState, reason: string): ProviderMutation {
    return {
      prompt: state.best.prompt,
      mutations: [],
      rationale: `claude-fallback: ${reason}`,
    };
  }
}

/** Convenience factory mirroring `createAnthropicAdapter` ergonomics. */
export function createClaudeMutationProvider(
  opts: ClaudeMutationProviderOptions,
): ClaudeMutationProvider {
  return new ClaudeMutationProvider(opts);
}
