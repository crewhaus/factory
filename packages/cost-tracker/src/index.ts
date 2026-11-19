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
  declaredPricingKey,
  mergeDeclaredPricing,
  resolvePricing,
  type DeclaredPricing,
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
  effectiveSunsets,
  findSunset,
  sunsetRetired,
  KNOWN_PROVIDERS,
  KNOWN_SUNSETS,
  parsePricingFeed,
  type ParsePricingFeedOptions,
  pickNewestPricing,
  pricingTableAgeDays,
  PricingFeedError,
  type PricingStaleness,
  type SunsetEntry,
  type SunsetTable,
} from "./feed";

export {
  blendedPer1M,
  CHEAPEST_SENTINEL,
  crossesProvider,
  enumerateCandidates,
  familyPrefixOf,
  isModelSentinel,
  providerOfSpecString,
  rankRightSizeProposals,
  resolveCheapest,
  resolveCheapestForSlot,
  resolveStrongest,
  resolveStrongestForSlot,
  resolveStrongestFromRoster,
  specStringFor,
  STRONGEST_SENTINEL,
  type CandidateProvider,
  type EnumerateCandidatesOptions,
  type ModelCandidate,
  type ModelSentinel,
  type RankedRightSize,
  type RightSizeBaseline,
  type RightSizeProposal,
  type RosterMember,
  type StrongestResolution,
} from "./candidates";

export {
  describeToolLimitOverrun,
  limitIsUnverified,
  PROVIDER_TOOL_LIMITS,
  providerToolLimit,
  toolLimitOverrun,
  type ProviderToolLimit,
  type ToolLimitEnv,
  type ToolLimitOverrun,
} from "./tool-limits";

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
  /**
   * Model calls nothing could price (no row in the effective pricing table):
   * their cost is unknown, not $0, so a total that includes them is a lower
   * bound. Present only when at least one such call was seen, so a fully
   * priced summary keeps exactly the three keys above. A role-bearing
   * roll-up's `unpricedCalls` (a sub-agent's or a side call's unknown calls)
   * folds in here too.
   */
  readonly unpricedCalls?: number;
  /** Input plus output tokens of the per-call misses above; present only when > 0. */
  readonly unpricedTokens?: number;
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
  /**
   * Diagnostic: responses whose model had no price, across every run this
   * tracker saw. Their cost is unknown: totals leave it out and say so
   * through `unpricedCalls`; it is never counted as $0 spend.
   */
  pricingMisses(): number;
}

type RunRecord = {
  totalUsdMicros: number;
  byProvider: Map<ProviderId, number>;
  byRole: Map<ModelRole, number>;
  unpricedCalls: number;
  unpricedTokens: number;
};

function emptyRecord(): RunRecord {
  return {
    totalUsdMicros: 0,
    byProvider: new Map(),
    byRole: new Map(),
    unpricedCalls: 0,
    unpricedTokens: 0,
  };
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

  /** Count unknown-cost calls (and their tokens) on the run and the tenant. */
  function recordUnpriced(
    runId: string,
    calls: number,
    tokens: number,
    forTenantId: string | undefined,
  ): void {
    const run = runs.get(runId) ?? emptyRecord();
    run.unpricedCalls += calls;
    run.unpricedTokens += tokens;
    runs.set(runId, run);
    if (forTenantId !== undefined) {
      const t = tenants.get(forTenantId) ?? emptyRecord();
      t.unpricedCalls += calls;
      t.unpricedTokens += tokens;
      tenants.set(forTenantId, t);
    }
  }

  const handler = (event: TraceEvent): void => {
    // 0.6.0 §7.6 / §10.2 — a ROLE-bearing `summary: true` accrual is a nested
    // run's roll-up re-published on this bus (a sub-agent child's
    // `role: "subagent"` total; a hybrid side call's `guide` / `shadow` /
    // `committee` total): spend whose `model_response` events this tracker
    // never saw, already priced by the publisher. Fold it — that is what lets
    // the parent's budget meter count a child's spend at all. Every other
    // externally published accrual stays ignored, including this tracker's
    // own per-call output and the optimizer's ROLE-LESS run total (a sum over
    // per-call accruals this tracker already folded — counting it would
    // double-count). Never re-published: the roll-up is on the bus already.
    if (event.kind === "cost_accrual") {
      const accrual = event as CostAccrualEvent;
      if (accrual.summary !== true || accrual.role === undefined) return;
      recordCost(accrual.runId, accrual.provider, accrual.role, accrual.costUsdMicros, tenantId);
      // The nested run's unknown calls stay unknown on the parent.
      const nestedUnpriced = accrual.unpricedCalls ?? 0;
      if (nestedUnpriced > 0) recordUnpriced(accrual.runId, nestedUnpriced, 0, tenantId);
      return;
    }
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
    // A pricing MISS is a call whose cost is unknown. It adds nothing to the
    // priced totals and is counted as an unknown call on its run (and
    // tenant), so every total that includes it can say "unknown" instead of
    // reading as $0. The `cost_accrual` still goes out, flagged `unpriced`,
    // with the REAL token counts and `costUsdMicros: 0` as a placeholder (no
    // rate to charge), so a token tally survives and the alert-watchdog's
    // pricing-miss detector fires. Priced responses never carry `unpriced`,
    // and `observed` still counts only priced calls.
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
      recordUnpriced(resp.runId, 1, inputTokens + outputTokens, tenantId);
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
  return {
    totalUsdMicros: r.totalUsdMicros,
    byProvider: out,
    byRole,
    ...(r.unpricedCalls > 0 ? { unpricedCalls: r.unpricedCalls } : {}),
    ...(r.unpricedTokens > 0 ? { unpricedTokens: r.unpricedTokens } : {}),
  };
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
