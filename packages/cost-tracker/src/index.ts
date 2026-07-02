/**
 * Section 27 — `cost-tracker`. Subscribes to the §15 trace bus on
 * `model_response` events and emits one `cost_accrual` event per response,
 * then aggregates into a per-run / per-tenant / per-provider USD micro
 * total.
 *
 * Why micros: avoids float drift when summing thousands of responses; one
 * USD = 1_000_000 micros; the eval-report cost columns + audit-log + studio
 * cost dashboard format back to dollars at display time.
 *
 * Example:
 * ```ts
 * import { TraceEventBus } from "@crewhaus/trace-event-bus";
 * import { createCostTracker } from "@crewhaus/cost-tracker";
 *
 * const bus = new TraceEventBus({ runId, sessionId });
 * const tracker = createCostTracker(bus);
 * // ...run runChatLoop...
 * console.log(tracker.getRunCost(runId));
 * // → { totalUsdMicros: 4200, byProvider: { anthropic: 4200 } }
 * ```
 */
import type {
  CostAccrualEvent,
  ModelResponseEvent,
  ProviderId,
  TraceEvent,
  TraceEventBus,
  Unsubscribe,
} from "@crewhaus/trace-event-bus";
import { DEFAULT_PRICING, type PricingTable, computeCostMicros, resolvePricing } from "./pricing";

export {
  DEFAULT_PRICING,
  computeCacheSavingsMicros,
  computeCostMicros,
  resolvePricing,
  type PricingRow,
  type PricingTable,
} from "./pricing";

export type RunCostSummary = {
  readonly totalUsdMicros: number;
  /** Stable order: providers sorted alphabetically. */
  readonly byProvider: { readonly [P in ProviderId]?: number };
};

export type CostTrackerOptions = {
  /** Pricing table override. Defaults to `DEFAULT_PRICING`. */
  readonly pricing?: PricingTable;
  /**
   * Override the tenant id stamp on emitted `cost_accrual` events. When
   * undefined, events emit without `tenantId`. The gateway-server passes
   * its current request tenant id here so per-tenant aggregation is
   * authoritative even when the run is borrowed across tenancy contexts.
   */
  readonly tenantId?: string;
  /**
   * When true, suppresses `cost_accrual` event publishing — useful when
   * a downstream consumer is itself a subscriber and you want to avoid
   * loops. The aggregated totals are still tracked. Defaults to false.
   */
  readonly suppressEvents?: boolean;
};

export interface CostTracker {
  /** Total USD-micros and per-provider breakdown for a runId. */
  getRunCost(runId: string): RunCostSummary;
  /** Per-tenant breakdown (across all runs observed). */
  getTenantCost(tenantId: string): RunCostSummary;
  /** Stop subscribing. Idempotent. */
  unsubscribe(): void;
  /** Diagnostic: number of `model_response` events processed. */
  observed(): number;
  /** Diagnostic: number of responses where pricing lookup missed (charged $0). */
  pricingMisses(): number;
}

type RunRecord = {
  totalUsdMicros: number;
  byProvider: Map<ProviderId, number>;
};

export function createCostTracker(bus: TraceEventBus, opts: CostTrackerOptions = {}): CostTracker {
  const pricing = opts.pricing ?? DEFAULT_PRICING;
  const tenantId = opts.tenantId;
  const suppressEvents = opts.suppressEvents === true;
  const runs = new Map<string, RunRecord>();
  const tenants = new Map<string, RunRecord>();
  let observed = 0;
  let pricingMisses = 0;

  function recordCost(
    runId: string,
    provider: ProviderId,
    micros: number,
    forTenantId: string | undefined,
  ): void {
    const run = runs.get(runId) ?? { totalUsdMicros: 0, byProvider: new Map() };
    run.totalUsdMicros += micros;
    run.byProvider.set(provider, (run.byProvider.get(provider) ?? 0) + micros);
    runs.set(runId, run);
    if (forTenantId !== undefined) {
      const t = tenants.get(forTenantId) ?? { totalUsdMicros: 0, byProvider: new Map() };
      t.totalUsdMicros += micros;
      t.byProvider.set(provider, (t.byProvider.get(provider) ?? 0) + micros);
      tenants.set(forTenantId, t);
    }
  }

  const handler = (event: TraceEvent): void => {
    if (event.kind !== "model_response") return;
    const resp = event as ModelResponseEvent;
    const provider: ProviderId = resp.provider ?? "anthropic";
    // `resp.model` is the WIRE model id (runtime-core strips the spec
    // grammar before publishing) — the form the pricing table is keyed on.
    const row = resolvePricing(pricing, provider, resp.model);
    if (!row) {
      pricingMisses++;
      return;
    }
    observed++;
    const inputTokens = resp.usage.input;
    const outputTokens = resp.usage.output;
    const cachedReadTokens = resp.usage.cacheRead ?? 0;
    const cacheCreationTokens = resp.usage.cacheCreate ?? 0;
    const costUsdMicros = computeCostMicros(
      row,
      inputTokens,
      outputTokens,
      cachedReadTokens,
      cacheCreationTokens,
    );
    recordCost(resp.runId, provider, costUsdMicros, tenantId);
    if (!suppressEvents) {
      const accrual: CostAccrualEvent = {
        ...bus.envelope(),
        kind: "cost_accrual",
        provider,
        modelId: resp.model,
        ...(resp.specModel !== undefined ? { specModel: resp.specModel } : {}),
        inputTokens,
        outputTokens,
        cachedReadTokens,
        cacheCreationTokens,
        costUsdMicros,
        ...(tenantId !== undefined ? { tenantId } : {}),
      };
      bus.publish(accrual);
    }
  };

  const off: Unsubscribe = bus.subscribe(handler);
  let stopped = false;

  return {
    getRunCost(runId): RunCostSummary {
      const r = runs.get(runId);
      if (!r) return { totalUsdMicros: 0, byProvider: {} };
      return summarize(r);
    },
    getTenantCost(t): RunCostSummary {
      const r = tenants.get(t);
      if (!r) return { totalUsdMicros: 0, byProvider: {} };
      return summarize(r);
    },
    unsubscribe(): void {
      if (stopped) return;
      stopped = true;
      off();
    },
    observed(): number {
      return observed;
    },
    pricingMisses(): number {
      return pricingMisses;
    },
  };
}

function summarize(r: RunRecord): RunCostSummary {
  const out: { [P in ProviderId]?: number } = {};
  // Stable order: alphabetical providers.
  const keys = [...r.byProvider.keys()].sort() as ProviderId[];
  for (const k of keys) {
    out[k] = r.byProvider.get(k);
  }
  return { totalUsdMicros: r.totalUsdMicros, byProvider: out };
}

/** Format a USD-micros total as `"$0.0042"` (4 fractional digits). */
export function formatUsdMicros(micros: number): string {
  const dollars = micros / 1_000_000;
  return `$${dollars.toFixed(4)}`;
}
