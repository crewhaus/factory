/**
 * FR-003 — cost budget gate for model-driven optimisation.
 *
 * Bounds a model-driven `crewhaus optimize` run by a dollar budget
 * (`--budget-usd`), not only by the orchestrator's `iterations` cap.
 * Whichever bound is hit first ends the run; the run returns the best
 * candidate found so far plus a spend summary.
 *
 * DESIGN NOTE — why this does NOT attach a `cost-tracker` to a bus:
 * `cost-tracker.createCostTracker` only meters on `model_response`
 * events, and those are emitted exclusively by `runtime-core.runChatLoop`
 * (the agent loop). Mutation calls in `ClaudeMutationProvider.next()` go
 * straight through `adapter.stream()` + `collectFinalMessage()` and never
 * touch `runChatLoop`, so a bus-attached cost-tracker would report $0 for
 * an optimize run. Instead this gate uses `cost-tracker`'s PURE exports
 * (`resolvePricing` + `computeCostMicros` over the versioned
 * `DEFAULT_PRICING` table) applied to the per-call `usage` each provider
 * now returns on its `ProviderMutation`. Do not "simplify" this back to a
 * bus subscriber — it would silently never fire.
 *
 * GATE STRATEGY — estimate-before / record-after:
 *   - Before iteration i's mutation call, compute a worst-case estimate
 *     for the upcoming call (input chars / 4 token heuristic for input +
 *     the provider's `maxOutputTokens` ceiling for output). If
 *     `spent + estimate > budget`, STOP before issuing the call.
 *   - After a call completes, fold its ACTUAL `usage` into the running
 *     total via `computeCostMicros`.
 * The estimate uses the OUTPUT ceiling (the dominant cost axis at
 * $15–75/M output) so it is conservative-high on the expensive axis. To
 * make the guarantee hold on the INPUT axis too — not just when the
 * output cushion happens to absorb an input under-count — the gate prices
 * the *full serialized input* the provider will transmit, not merely the
 * candidate prompt. A model-backed provider exposes an `estimateInputChars
 * (state)` hook returning the exact system-block + rendered failure-block
 * char count it would send (see `ClaudeMutationProvider.estimateInputChars`);
 * the orchestrator feeds that into `wouldExceed`, so a large dev-sample
 * window can no longer let a gate-passing call exceed budget after the
 * fact. Providers without the hook fall back to `best.prompt.length +
 * metaOverheadChars`. Either way the AC — "never ISSUES a call that WOULD
 * exceed", evaluated at gate time — is satisfied, and with the hook it is
 * satisfied unconditionally (both cost axes are bounded from above).
 *
 * PRICING MISS = $0: an unmapped model id (`resolvePricing` returns
 * undefined) is treated as zero micros — cannot price → do not block,
 * consistent with cost-tracker's own pricing-miss behaviour. Such a run
 * degrades to iterations-cap only.
 *
 * Catalog layer: F-eval (active optimisation). Brief: 279 (orchestrator).
 */
import {
  DEFAULT_PRICING,
  type PricingTable,
  computeCostMicros,
  formatUsdMicros,
  resolvePricing,
} from "@crewhaus/cost-tracker";
import type { ProviderId } from "@crewhaus/trace-event-bus";

/** Per-call token usage as surfaced by a `MutationProvider`. */
export type CallUsage = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
};

/** One iteration's recorded spend, for the per-iteration breakdown. */
export type IterationSpend = {
  readonly iteration: number;
  readonly costUsdMicros: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
};

/** Why the run ended — mirrored onto `OptimizeSpecResult` for ergonomics. */
export type StoppedReason = "iterations-cap" | "budget-reached";

/** The spend summary attached to every optimize result + persisted report. */
export type SpendSummary = {
  /** Running total in USD-micros (1 USD = 1_000_000 micros). */
  readonly totalUsdMicros: number;
  /** `totalUsdMicros` formatted as `"$0.0000"` via `formatUsdMicros`. */
  readonly totalUsd: string;
  /** Per-iteration cost breakdown, in iteration order. */
  readonly perIteration: ReadonlyArray<IterationSpend>;
  /** Which bound ended the run. */
  readonly stopped: StoppedReason;
};

const DEFAULT_META_OVERHEAD_CHARS = 800;

/**
 * Worst-case USD-micros for the NEXT mutation call: `chars/4` input-token
 * estimate priced at input rate, plus the full `maxOutputTokens` ceiling
 * priced at output rate. Returns 0 when the model cannot be priced
 * (unknown id → do not block).
 *
 * `inputChars` is the estimated INPUT character count for the upcoming
 * call. When the provider exposes `estimateInputChars`, this is the exact
 * serialized system + user message length (so the dev-set failure block is
 * fully counted); otherwise it is the candidate prompt length. In both
 * cases `metaOverheadChars` is added as an extra safety margin, keeping
 * the estimate conservative-high.
 */
export function estimateCallMicros(
  inputChars: number,
  metaOverheadChars: number,
  maxOutputTokens: number,
  provider: ProviderId,
  modelId: string,
  pricing: PricingTable = DEFAULT_PRICING,
): number {
  const row = resolvePricing(pricing, provider, modelId);
  if (!row) return 0;
  const estInput = Math.ceil((inputChars + metaOverheadChars) / 4);
  return computeCostMicros(row, estInput, maxOutputTokens, 0);
}

/**
 * Actual USD-micros for a completed call given its returned `usage`.
 * Returns 0 when the model cannot be priced.
 */
export function actualCallMicros(
  usage: CallUsage,
  provider: ProviderId,
  modelId: string,
  pricing: PricingTable = DEFAULT_PRICING,
): number {
  const row = resolvePricing(pricing, provider, modelId);
  if (!row) return 0;
  return computeCostMicros(row, usage.input, usage.output, usage.cacheRead ?? 0);
}

/**
 * Running-spend meter for one optimize run. The orchestrator checks
 * `wouldExceed()` BEFORE delegating to the mutator and `record()`s the
 * actual usage AFTER a call completes.
 */
export class BudgetMeter {
  private spent = 0;
  private readonly per: IterationSpend[] = [];

  /**
   * @param budgetMicros Dollar ceiling in micros, or `undefined` for no
   *   budget (iterations-cap only — `wouldExceed` always returns false).
   * @param provider Provider id used to price calls (e.g. `"anthropic"`).
   * @param modelId Model id used to price calls.
   * @param maxOutputTokens Output ceiling per call, for the worst-case estimate.
   * @param metaOverheadChars Extra chars added to the prompt-length estimate
   *   to account for the meta-prompt the model also pays for. Default 800.
   * @param pricing Pricing table override (tests). Default `DEFAULT_PRICING`.
   */
  constructor(
    private readonly budgetMicros: number | undefined,
    private readonly provider: ProviderId,
    private readonly modelId: string,
    private readonly maxOutputTokens: number,
    private readonly metaOverheadChars: number = DEFAULT_META_OVERHEAD_CHARS,
    private readonly pricing: PricingTable = DEFAULT_PRICING,
  ) {}

  /** Total spent so far, in USD-micros. */
  get spentMicros(): number {
    return this.spent;
  }

  /**
   * True ⇒ the caller MUST NOT issue the upcoming call (it would push the
   * running total over budget). Always false when no budget is configured.
   *
   * @param inputChars Estimated INPUT chars for the upcoming call. Pass the
   *   provider's exact serialized input length (system + user message) when
   *   it exposes `estimateInputChars`; otherwise the candidate prompt
   *   length. `metaOverheadChars` is added on top as a safety margin.
   */
  wouldExceed(inputChars: number): boolean {
    if (this.budgetMicros === undefined) return false;
    const estimate = estimateCallMicros(
      inputChars,
      this.metaOverheadChars,
      this.maxOutputTokens,
      this.provider,
      this.modelId,
      this.pricing,
    );
    return this.spent + estimate > this.budgetMicros;
  }

  /** Fold a completed call's actual usage into the running total. */
  record(iteration: number, usage: CallUsage): void {
    const micros = actualCallMicros(usage, this.provider, this.modelId, this.pricing);
    this.spent += micros;
    this.per.push({
      iteration,
      costUsdMicros: micros,
      inputTokens: usage.input,
      outputTokens: usage.output,
    });
  }

  /** Build the final spend summary, stamped with why the run ended. */
  summary(stopped: StoppedReason): SpendSummary {
    return {
      totalUsdMicros: this.spent,
      totalUsd: formatUsdMicros(this.spent),
      perIteration: [...this.per],
      stopped,
    };
  }
}
