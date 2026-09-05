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
  ModelRole,
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

export {
  cacheProfileFromTotals,
  rankCandidates,
  type RankCandidate,
  type RankCandidatesOptions,
  type RankedCandidate,
  type SessionCacheProfile,
} from "./ranking";

export {
  DEFAULT_CAPABILITIES,
  resolveCapabilities,
  satisfiesCapabilities,
  type CapabilityRequirement,
  type CapabilityTable,
  type ModelCapabilities,
} from "./capabilities";

export {
  classifyPricingStaleness,
  findSunset,
  KNOWN_PROVIDERS,
  KNOWN_SUNSETS,
  parsePricingFeed,
  type ParsePricingFeedOptions,
  pickNewestPricing,
  pricingTableAgeDays,
  PricingFeedError,
  type PricingStaleness,
  type SunsetEntry,
} from "./feed";

export {
  blendedPer1M,
  CHEAPEST_SENTINEL,
  enumerateCandidates,
  familyPrefixOf,
  providerOfSpecString,
  rankRightSizeProposals,
  resolveCheapest,
  resolveCheapestForSlot,
  specStringFor,
  type CandidateProvider,
  type EnumerateCandidatesOptions,
  type ModelCandidate,
  type RankedRightSize,
  type RightSizeBaseline,
  type RightSizeProposal,
} from "./candidates";

export type RunCostSummary = {
  readonly totalUsdMicros: number;
  /** Stable order: providers sorted alphabetically. */
  readonly byProvider: { readonly [P in ProviderId]?: number };
  /**
   * 0.6.0 (design §6.2, §7.12) — priced spend split by the `role` the
   * `model_response` carried (an absent role folds under `"primary"`). This
   * is what `budget.judge_share` reads: the runtime sums the auxiliary roles
   * (`AUXILIARY_MODEL_ROLES`) against the share of the run cap. Stable order:
   * roles sorted alphabetically; only roles that accrued appear.
   */
  readonly byRole: { readonly [R in ModelRole]?: number };
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
  byRole: Map<ModelRole, number>;
};

function emptyRecord(): RunRecord {
  return { totalUsdMicros: 0, byProvider: new Map(), byRole: new Map() };
}

export function createCostTracker(bus: TraceEventBus, opts: CostTrackerOptions = {}): CostTracker {
  const pricing = opts.pricing ?? DEFAULT_PRICING;
  const tenantId = opts.tenantId;
  const suppressEvents = opts.suppressEvents === true;
  const runs = new Map<string, RunRecord>();
  const tenants = new Map<string, RunRecord>();
  let observed = 0;
  let pricingMisses = 0;

  function fold(rec: RunRecord, provider: ProviderId, role: ModelRole, micros: number): void {
    rec.totalUsdMicros += micros;
    rec.byProvider.set(provider, (rec.byProvider.get(provider) ?? 0) + micros);
    rec.byRole.set(role, (rec.byRole.get(role) ?? 0) + micros);
  }

  function recordCost(
    runId: string,
    provider: ProviderId,
    role: ModelRole,
    micros: number,
    forTenantId: string | undefined,
  ): void {
    const run = runs.get(runId) ?? emptyRecord();
    fold(run, provider, role, micros);
    runs.set(runId, run);
    if (forTenantId !== undefined) {
      const t = tenants.get(forTenantId) ?? emptyRecord();
      fold(t, provider, role, micros);
      tenants.set(forTenantId, t);
    }
  }

  const handler = (event: TraceEvent): void => {
    if (event.kind !== "model_response") return;
    const resp = event as ModelResponseEvent;
    const provider: ProviderId = resp.provider ?? "anthropic";
    const inputTokens = resp.usage.input;
    const outputTokens = resp.usage.output;
    const cachedReadTokens = resp.usage.cacheRead ?? 0;
    const cacheCreationTokens = resp.usage.cacheCreate ?? 0;
    // `resp.model` is the WIRE model id (runtime-core strips the spec
    // grammar before publishing) — the form the pricing table is keyed on.
    const row = resolvePricing(pricing, provider, resp.model);
    // F1 — on a pricing MISS we no longer early-return silently. We still
    // count the miss and charge nothing (there is no rate to charge), but we
    // DO publish a `cost_accrual` carrying costUsdMicros:0 and the REAL token
    // counts, flagged `unpriced`. Two reasons: (1) a downstream token tally
    // (the studio cost tile) survives an unpriced model instead of zeroing,
    // and (2) this is exactly the shape `runtime-core`'s alert-watchdog looks
    // for (`costUsdMicros === 0 && inputTokens + outputTokens > 0`) to flag a
    // pricing miss — nothing emitted that shape before. Priced responses are
    // byte-identical to before: they never carry `unpriced`, `observed`
    // still counts only priced calls, and only they touch `recordCost`.
    let costUsdMicros = 0;
    let unpriced = false;
    if (row) {
      observed++;
      costUsdMicros = computeCostMicros(
        row,
        inputTokens,
        outputTokens,
        cachedReadTokens,
        cacheCreationTokens,
      );
      // 0.6.0 — an absent role is the main-turn call, i.e. `"primary"`.
      recordCost(resp.runId, provider, resp.role ?? "primary", costUsdMicros, tenantId);
    } else {
      pricingMisses++;
      unpriced = true;
    }
    if (!suppressEvents) {
      const accrual: CostAccrualEvent = {
        ...bus.envelope(),
        kind: "cost_accrual",
        provider,
        modelId: resp.model,
        ...(resp.specModel !== undefined ? { specModel: resp.specModel } : {}),
        // 0.6.0 (design §8.1) — attribution rides from the response onto the
        // accrual VERBATIM, and only when present, so `cost-summary`, Hangar
        // and `budget.judge_share` can split spend by role/stage/profile while
        // an unattributed response yields a byte-identical accrual.
        ...(resp.role !== undefined ? { role: resp.role } : {}),
        ...(resp.stage !== undefined ? { stage: resp.stage } : {}),
        ...(resp.profile !== undefined ? { profile: resp.profile } : {}),
        ...(resp.paramsFingerprint !== undefined
          ? { paramsFingerprint: resp.paramsFingerprint }
          : {}),
        ...(resp.effectiveParams !== undefined ? { effectiveParams: resp.effectiveParams } : {}),
        inputTokens,
        outputTokens,
        cachedReadTokens,
        cacheCreationTokens,
        costUsdMicros,
        ...(unpriced ? { unpriced: true } : {}),
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
      if (!r) return { totalUsdMicros: 0, byProvider: {}, byRole: {} };
      return summarize(r);
    },
    getTenantCost(t): RunCostSummary {
      const r = tenants.get(t);
      if (!r) return { totalUsdMicros: 0, byProvider: {}, byRole: {} };
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
  const byRole: { [R in ModelRole]?: number } = {};
  for (const k of [...r.byRole.keys()].sort() as ModelRole[]) {
    byRole[k] = r.byRole.get(k);
  }
  return { totalUsdMicros: r.totalUsdMicros, byProvider: out, byRole };
}

/**
 * 0.6.0 (design §6.2, §7.12) — sum the priced spend of the given roles from a
 * {@link RunCostSummary}. `budget.judge_share` calls this with
 * `AUXILIARY_MODEL_ROLES`; `cost-summary` can call it with any slice.
 */
export function sumRoleCost(summary: RunCostSummary, roles: ReadonlyArray<ModelRole>): number {
  let total = 0;
  for (const role of roles) total += summary.byRole[role] ?? 0;
  return total;
}

/** Format a USD-micros total as `"$0.0042"` (4 fractional digits). */
export function formatUsdMicros(micros: number): string {
  const dollars = micros / 1_000_000;
  return `$${dollars.toFixed(4)}`;
}
