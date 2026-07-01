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
 * Cost: each call is one Claude request (~1-3K tokens). Each `next()`
 * now surfaces the call's actual token `usage` on the returned
 * `ProviderMutation`, and the provider exposes its `modelId` +
 * `maxOutputTokens` getters, so the FR-003 `--budget-usd` cost-gate in
 * `eval-optimizer-orchestrator` can price every call against the §27
 * `cost-tracker` table and stop before a mutation call would exceed
 * the budget. The gate composes with the orchestrator's `iterations`
 * cap (whichever bound is hit first ends the run).
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

const META_PROMPT_SYSTEM = `You are a prompt-engineering optimiser. You will receive a CURRENT PROMPT and a SAMPLE OF DEV-SET FAILURES. Each failure shows the input the model received, its observed score (0..1, lower is worse), and — when available — the grader's feedback explaining WHY the output lost points. Your job is to produce a single rewrite of CURRENT PROMPT that you believe will improve grader scores on the dev set.

Hard rules:
- Output exactly one JSON object: {"rewrite": "...", "rationale": "..."}
- The "rewrite" field is the new prompt verbatim. Do NOT include any wrapper text outside the JSON.
- Read the grader feedback and address the ROOT CAUSE it names (e.g. "cites no source", "too verbose", "wrong format") with a general instruction — not a fix hard-coded to these specific inputs.
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

  /**
   * The model id this provider calls, exposed read-only so the FR-003
   * cost-gate can price each call via `resolvePricing(DEFAULT_PRICING,
   * "anthropic", modelId)`. The `MutationProvider` interface only
   * guarantees `name` + `next()`; the orchestrator feature-detects this
   * getter and falls back to a zero-cost meter for providers that don't
   * expose it.
   */
  get modelId(): string {
    return this.model;
  }

  /**
   * The provider id of the injected adapter, exposed read-only so the
   * FR-003 cost-gate prices calls against the REAL provider's pricing
   * table instead of assuming "anthropic". Feature-detected by the
   * orchestrator like `modelId` — providers without the getter price as
   * Anthropic (the historical behaviour).
   */
  get providerId(): string {
    return this.adapter.providerId;
  }

  /**
   * The output-token ceiling for each call, exposed read-only so the
   * cost-gate can compute a worst-case pre-call estimate (the gate must
   * decide BEFORE a call whether it would exceed the budget).
   */
  get maxOutputTokens(): number {
    return this.maxTokens;
  }

  /**
   * FR-003 — exact serialized INPUT character count this provider would
   * transmit for `state`, so the cost-gate prices the *real* meta-prompt
   * rather than just `best.prompt.length + a fixed overhead`. The naive
   * estimate (prompt length only) under-counts the system block AND the
   * rendered dev-set failure block (each failure's input + expected_output)
   * that `next()` actually sends; with a large dev window + small maxTokens
   * that deficit could let a gate-passing call exceed the budget after the
   * fact. Returning the full system+user char count here makes the
   * `chars/4` token estimate cover everything the model is billed for, so
   * the orchestrator's estimate-before guarantee holds unconditionally
   * (input is now bounded from above, output is already the ceiling).
   *
   * The orchestrator feature-detects this method (it is not part of the
   * `MutationProvider` interface); providers that omit it fall back to the
   * `best.prompt.length + metaOverheadChars` heuristic.
   */
  estimateInputChars(state: OptimizerState): number {
    const failures = this.selectFailures(state);
    const userMessage = this.buildUserMessage(state.best.prompt, failures);
    return this.systemBlock.length + userMessage.length;
  }

  async next(state: OptimizerState): Promise<ProviderMutation> {
    const failures = this.selectFailures(state);
    const userMessage = this.buildUserMessage(state.best.prompt, failures);

    // The call's actual token usage, captured so the FR-003 cost-gate
    // can fold it into a running spend total. Stays undefined until the
    // model call round-trips; a failed/unusable response still records
    // whatever was consumed (the model DID run) so spend is accounted.
    let callUsage: ProviderMutation["usage"];
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
      callUsage = {
        input: final.usage.input,
        output: final.usage.output,
        ...(final.usage.cacheRead !== undefined ? { cacheRead: final.usage.cacheRead } : {}),
      };
      rawText = extractFirstText(final);
    } catch (err) {
      // Mutator unavailability is not fatal — fall back to current best.
      // The orchestrator's outer loop will record a degenerate iteration
      // (score unchanged) and the search continues. No usage is available
      // on a stream error (the call did not complete), so spend is zero.
      return this.fallback(state, `model error: ${(err as Error).message}`);
    }
    if (rawText === undefined) {
      return this.fallback(state, "model returned no text block", callUsage);
    }

    // Extract JSON: tolerate ```json fences and leading prose. We
    // search for the first balanced `{...}` substring.
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch === null) {
      return this.fallback(state, "model response did not contain a JSON object", callUsage);
    }
    let parsed: { rewrite: string; rationale: string };
    try {
      const raw = JSON.parse(jsonMatch[0]);
      parsed = META_RESPONSE_SCHEMA.parse(raw);
    } catch (err) {
      return this.fallback(
        state,
        `model response failed schema validation: ${(err as Error).message}`,
        callUsage,
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
      ...(callUsage !== undefined ? { usage: callUsage } : {}),
    };
  }

  /** Build the user message for the meta-prompt. */
  private buildUserMessage(
    currentPrompt: string,
    failures: ReadonlyArray<{
      input: string;
      observedScore: number;
      expected?: string;
      rationale?: string;
    }>,
  ): string {
    const failureBlock =
      failures.length === 0
        ? "(No dev-set failures available yet — propose a refinement that improves clarity, specificity, or instruction-following.)"
        : failures
            .map(
              (f, i) =>
                `--- Failure ${i + 1} (observed score ${f.observedScore.toFixed(2)}) ---\nInput: ${f.input}\n${f.expected !== undefined ? `Expected output (do NOT copy this verbatim into the rewrite): ${f.expected}\n` : ""}${f.rationale !== undefined ? `Grader feedback: ${f.rationale}\n` : ""}`,
            )
            .join("\n");
    return `CURRENT PROMPT:\n${currentPrompt}\n\nSAMPLE OF DEV-SET FAILURES:\n${failureBlock}\n\nReturn one JSON object: {"rewrite": "...", "rationale": "..."}`;
  }

  /**
   * Identify the failing samples to show the model. When the fitness
   * function supplied per-sample grades (`state.bestGrades`, wired by the
   * CLI's eval-runner closure), we surface the samples the current best
   * prompt ACTUALLY fails — worst-scoring first — together with the
   * grader's rationale, so the meta-prompt can address the named root
   * cause. This is the signal the system prompt promises. When grades are
   * absent (a fitness fn returning a bare number, or an all-passing dev
   * set), we fall back to surfacing the dev-set inputs with the aggregate
   * score — the pre-failure-signal behaviour — so the search still runs.
   */
  private selectFailures(state: OptimizerState): ReadonlyArray<{
    input: string;
    observedScore: number;
    expected?: string;
    rationale?: string;
  }> {
    const graded = state.bestGrades;
    if (graded !== undefined && graded.length > 0) {
      const byWorst = [...graded].sort((a, b) => a.score - b.score);
      // Prefer genuine failures (below the threshold); if the dev set is
      // already strong, fall back to the lowest scorers so the mutator
      // still has a concrete target to push on.
      const belowThreshold = byWorst.filter((g) => g.score < this.failureThreshold);
      const window = (belowThreshold.length > 0 ? belowThreshold : byWorst).slice(
        0,
        this.maxFailuresInPrompt,
      );
      return window.map((g) => ({
        input: g.input,
        observedScore: g.score,
        ...(g.expected !== undefined ? { expected: g.expected } : {}),
        ...(g.rationale !== undefined ? { rationale: g.rationale } : {}),
      }));
    }
    // No per-sample grades wired: surface the dev set as raw inputs with
    // the aggregate score. The model still sees the dev-set distribution.
    return state.devSet.slice(0, this.maxFailuresInPrompt).map((s) => ({
      input: s.input,
      observedScore: state.best.score,
      ...(s.expected_output !== undefined ? { expected: s.expected_output } : {}),
    }));
  }

  /**
   * Fallback when the model can't produce a usable rewrite. Returns
   * the current best verbatim so the search loop records a no-op
   * iteration. The orchestrator logs the fallback reason. When the
   * model DID round-trip (returned text/JSON that turned out unusable),
   * the `usage` actually consumed is forwarded so the cost-gate still
   * accounts for the spend; a stream error (no completed call) passes
   * no usage and is therefore charged zero.
   */
  private fallback(
    state: OptimizerState,
    reason: string,
    usage?: ProviderMutation["usage"],
  ): ProviderMutation {
    return {
      prompt: state.best.prompt,
      mutations: [],
      rationale: `claude-fallback: ${reason}`,
      ...(usage !== undefined ? { usage } : {}),
    };
  }
}

/** Convenience factory mirroring `createAnthropicAdapter` ergonomics. */
export function createClaudeMutationProvider(
  opts: ClaudeMutationProviderOptions,
): ClaudeMutationProvider {
  return new ClaudeMutationProvider(opts);
}
