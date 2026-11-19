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
 * UNKNOWN COST: a model nothing can price (`resolvePricing` returns
 * undefined) has an unknown cost, never $0. Its estimate is `undefined`, so
 * the gate cannot bound the call and lets it through (an unknown cost never
 * stops a run); its actual cost is counted as an unknown call
 * (`SpendSummary.unpricedCalls`), and the summary's `totalUsd` reads
 * `"$0.0012 + unknown"`. A declared price (`models.<name>.price`) makes it
 * known.
 *
 * The estimate functions live in `@crewhaus/cost-tracker/spend` (the spend
 * meter's own worst case) and are re-exported here under the same names.
 *
 * Catalog layer: F-eval (active optimisation). Brief: 279 (orchestrator).
 */
import { DEFAULT_PRICING, type PricingTable, formatUsdMicros } from "@crewhaus/cost-tracker";
import { type CallUsage, actualCallMicros, estimateCallMicros } from "@crewhaus/cost-tracker/spend";
import type { ProviderId } from "@crewhaus/trace-event-bus";

export { actualCallMicros, estimateCallMicros, type CallUsage };

/** One iteration's recorded spend, for the per-iteration breakdown. */
export type IterationSpend = {
  readonly iteration: number;
  /** `0` as a placeholder when {@link unpriced}: the cost is unknown, not zero. */
  readonly costUsdMicros: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Present when nothing could price this call. */
  readonly unpriced?: true;
};

/** Why the run ended — mirrored onto `OptimizeSpecResult` for ergonomics. */
export type StoppedReason = "iterations-cap" | "budget-reached";

/** The spend summary attached to every optimize result + persisted report. */
export type SpendSummary = {
  /** Running total of the priced calls, in USD-micros (1 USD = 1_000_000 micros). */
  readonly totalUsdMicros: number;
  /**
   * `totalUsdMicros` formatted as `"$0.0000"` via `formatUsdMicros`, with
   * `" + unknown"` appended when {@link unpricedCalls} is present.
   */
  readonly totalUsd: string;
  /** Calls nothing could price; present only when > 0. */
  readonly unpricedCalls?: number;
  /** Per-iteration cost breakdown, in iteration order. */
  readonly perIteration: ReadonlyArray<IterationSpend>;
  /** Which bound ended the run. */
  readonly stopped: StoppedReason;
};

const DEFAULT_META_OVERHEAD_CHARS = 800;

/**
 * Running-spend meter for one optimize run. The orchestrator checks
 * `wouldExceed()` BEFORE delegating to the mutator and `record()`s the
 * actual usage AFTER a call completes.
 */
export class BudgetMeter {
  private spent = 0;
  private unpriced = 0;
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
   * running total over budget). Always false when no budget is configured,
   * and when the model has no price (an unknown estimate cannot be bounded,
   * and an unknown cost never stops a run).
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
    if (estimate === undefined) return false;
    return this.spent + estimate > this.budgetMicros;
  }

  /** The worst case of the upcoming call; `undefined` when the model has no price. */
  estimate(inputChars: number): number | undefined {
    return estimateCallMicros(
      inputChars,
      this.metaOverheadChars,
      this.maxOutputTokens,
      this.provider,
      this.modelId,
      this.pricing,
    );
  }

  /** Fold a completed call's actual usage into the running total. */
  /**
   * Fold a completed call's actual usage into the running total. Returns its
   * cost in USD-micros, or `undefined` when nothing could price it (counted
   * as an unknown call, adding nothing to the total).
   */
  record(iteration: number, usage: CallUsage): number | undefined {
    const micros = actualCallMicros(usage, this.provider, this.modelId, this.pricing);
    if (micros === undefined) this.unpriced += 1;
    else this.spent += micros;
    this.per.push({
      iteration,
      costUsdMicros: micros ?? 0,
      inputTokens: usage.input,
      outputTokens: usage.output,
      ...(micros === undefined ? { unpriced: true as const } : {}),
    });
    return micros;
  }

  /** Build the final spend summary, stamped with why the run ended. */
  summary(stopped: StoppedReason): SpendSummary {
    return {
      totalUsdMicros: this.spent,
      totalUsd: `${formatUsdMicros(this.spent)}${this.unpriced > 0 ? " + unknown" : ""}`,
      ...(this.unpriced > 0 ? { unpricedCalls: this.unpriced } : {}),
      perIteration: [...this.per],
      stopped,
    };
  }
}
