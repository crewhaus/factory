/**
 * Section 27 — versioned per-provider pricing table. Used by `cost-tracker`
 * to convert `(provider, modelId, inputTokens, outputTokens, cachedReadTokens,
 * cacheCreationTokens)` to a deterministic USD-microdollar total.
 *
 * Pricing is **versioned**, not point-in-time queried. Once a `costAccrual`
 * event lands in the audit-log, a re-aggregation later will produce the
 * same dollar figure even if upstream pricing has changed.
 *
 * Sources (2026-05 — keep current per provider release notes):
 *   anthropic — https://www.anthropic.com/pricing
 *   openai    — https://openai.com/api/pricing
 *   gemini    — https://ai.google.dev/pricing
 *   bedrock   — https://aws.amazon.com/bedrock/pricing
 */
import type { ProviderId } from "@crewhaus/trace-event-bus";

export type PricingRow = {
  /** $ per million input tokens. */
  readonly inputPer1M: number;
  /** $ per million output tokens. */
  readonly outputPer1M: number;
  /** $ per million cached-read tokens. Undefined → falls back to inputPer1M × 0.1 (Anthropic-style). */
  readonly cachedReadPer1M?: number;
  /** $ per million cache-write tokens. Undefined → falls back to inputPer1M × 1.25 (Anthropic-style). */
  readonly cacheWritePer1M?: number;
};

export type PricingTable = {
  readonly version: string;
  readonly providers: {
    readonly [P in ProviderId]?: {
      readonly [modelIdPrefix: string]: PricingRow;
    };
  };
};

/**
 * Default pricing table snapshotted 2026-05-08. Override at construction
 * time via `createCostTracker(bus, { pricing })` for tests or for
 * historical-run repricing.
 */
export const DEFAULT_PRICING: PricingTable = {
  version: "2026-05-08",
  providers: {
    anthropic: {
      "claude-opus-4-7": { inputPer1M: 15.0, outputPer1M: 75.0 },
      "claude-opus-4-6": { inputPer1M: 15.0, outputPer1M: 75.0 },
      "claude-opus-4": { inputPer1M: 15.0, outputPer1M: 75.0 },
      "claude-sonnet-4-6": { inputPer1M: 3.0, outputPer1M: 15.0 },
      "claude-sonnet-4-5": { inputPer1M: 3.0, outputPer1M: 15.0 },
      "claude-sonnet-4": { inputPer1M: 3.0, outputPer1M: 15.0 },
      "claude-haiku-4-5": { inputPer1M: 1.0, outputPer1M: 5.0 },
      "claude-haiku-4": { inputPer1M: 1.0, outputPer1M: 5.0 },
      "claude-3-7-sonnet": { inputPer1M: 3.0, outputPer1M: 15.0 },
      "claude-3-5-haiku": { inputPer1M: 0.8, outputPer1M: 4.0 },
    },
    openai: {
      // OpenAI's automatic prompt caching charges no write premium — cached
      // segments are billed as ordinary input — so `cacheWritePer1M` is set
      // explicitly to the input rate rather than inheriting the Anthropic-style
      // ×1.25 fallback. (The openai adapter reports no cache-write tokens
      // today, so these rows are defensive, not load-bearing.)
      "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10.0, cachedReadPer1M: 1.25, cacheWritePer1M: 2.5 },
      "gpt-4o-mini": {
        inputPer1M: 0.15,
        outputPer1M: 0.6,
        cachedReadPer1M: 0.075,
        cacheWritePer1M: 0.15,
      },
      "gpt-4.1": { inputPer1M: 2.0, outputPer1M: 8.0, cachedReadPer1M: 0.5, cacheWritePer1M: 2.0 },
      "gpt-4.1-mini": {
        inputPer1M: 0.4,
        outputPer1M: 1.6,
        cachedReadPer1M: 0.1,
        cacheWritePer1M: 0.4,
      },
      "gpt-5": {
        inputPer1M: 1.25,
        outputPer1M: 10.0,
        cachedReadPer1M: 0.125,
        cacheWritePer1M: 1.25,
      },
      "gpt-5-mini": {
        inputPer1M: 0.25,
        outputPer1M: 2.0,
        cachedReadPer1M: 0.025,
        cacheWritePer1M: 0.25,
      },
      o1: { inputPer1M: 15.0, outputPer1M: 60.0 },
      "o3-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
    },
    gemini: {
      "gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 5.0 },
      "gemini-2.5-flash": { inputPer1M: 0.15, outputPer1M: 0.6 },
      "gemini-2.0-flash": { inputPer1M: 0.1, outputPer1M: 0.4 },
      "gemini-1.5-pro": { inputPer1M: 1.25, outputPer1M: 5.0 },
      "gemini-1.5-flash": { inputPer1M: 0.075, outputPer1M: 0.3 },
    },
    bedrock: {
      "anthropic.claude-opus-4": { inputPer1M: 15.0, outputPer1M: 75.0 },
      "anthropic.claude-sonnet-4": { inputPer1M: 3.0, outputPer1M: 15.0 },
      "meta.llama3-1-70b": { inputPer1M: 0.99, outputPer1M: 0.99 },
      "meta.llama3-1-8b": { inputPer1M: 0.22, outputPer1M: 0.22 },
      "mistral.mistral-large": { inputPer1M: 4.0, outputPer1M: 12.0 },
    },
  },
};

/**
 * Resolve pricing for `(provider, modelId)`. Looks up the longest matching
 * key prefix so versioned model ids (e.g. `claude-opus-4-7@beta`) still hit
 * the family base row.
 *
 * Returns `undefined` when the provider isn't in the table, and likewise when
 * the provider is known but no model prefix matches. Callers (cost-tracker,
 * the eval budget-gate) treat a `undefined` result as a "pricing miss" and
 * charge $0 for that response while incrementing a miss counter, rather than
 * throwing — an unmapped model id must not crash an in-flight run.
 */
/**
 * Geo segments AWS prepends to Bedrock model ids to form cross-region
 * inference-profile ids (`us.anthropic.claude-...`). Pricing rows are
 * keyed on the bare model id; the profile routes to the same model, so
 * strip the segment before prefix matching. Twin of
 * model-router/src/parse.ts BEDROCK_GEO_PREFIX — keep in sync.
 */
const BEDROCK_GEO_PREFIX = /^(?:us|eu|apac|jp|au|ca|sa|us-gov|global)\./;

export function resolvePricing(
  table: PricingTable,
  provider: ProviderId,
  modelId: string,
): PricingRow | undefined {
  const providerTable = table.providers[provider];
  if (!providerTable) return undefined;
  const bareId = provider === "bedrock" ? modelId.replace(BEDROCK_GEO_PREFIX, "") : modelId;
  // Sort prefixes longest-first for deterministic specificity.
  const prefixes = Object.keys(providerTable).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (bareId === prefix || bareId.startsWith(`${prefix}-`) || bareId.startsWith(`${prefix}@`)) {
      return providerTable[prefix];
    }
  }
  return undefined;
}

/** Effective $ per million cached-read tokens: explicit row price, else the Anthropic-style ×0.1 input discount. */
function effectiveCachedReadPer1M(pricing: PricingRow): number {
  return pricing.cachedReadPer1M ?? pricing.inputPer1M * 0.1;
}

/** Effective $ per million cache-write tokens: explicit row price, else the Anthropic-style ×1.25 input premium (5-minute TTL; TTL variants are deliberately not modeled). */
function effectiveCacheWritePer1M(pricing: PricingRow): number {
  return pricing.cacheWritePer1M ?? pricing.inputPer1M * 1.25;
}

/**
 * Compute USD-microdollars for a `(provider, modelId, tokens)` triple. The
 * conversion is `(tokens / 1_000_000) * usdPerM * 1_000_000` collapsed to
 * `tokens * usdPerM`, integer-rounded for stable equality across runs.
 *
 * `cacheCreationTokens` (prompt-cache WRITES, billed at a premium) is an
 * additive trailing parameter defaulting to 0 so pre-existing 4-argument
 * call sites keep their exact historical totals.
 */
export function computeCostMicros(
  pricing: PricingRow,
  inputTokens: number,
  outputTokens: number,
  cachedReadTokens: number,
  cacheCreationTokens = 0,
): number {
  const inputCost = inputTokens * pricing.inputPer1M;
  const outputCost = outputTokens * pricing.outputPer1M;
  const cachedReadCost = cachedReadTokens * effectiveCachedReadPer1M(pricing);
  const cacheWriteCost = cacheCreationTokens * effectiveCacheWritePer1M(pricing);
  return Math.round(inputCost + outputCost + cachedReadCost + cacheWriteCost);
}

/**
 * Realized prompt-cache savings in USD-microdollars:
 *
 *   (what cached reads WOULD have cost at the full input rate)
 * − (what they actually cost at the discounted cached-read rate)
 * − (the cache-write premium paid ABOVE the normal input rate)
 *
 * Negative when write premiums outweigh read discounts — i.e. caching lost
 * money on this traffic. Same `tokens * usdPerM` micros collapse and
 * integer rounding as `computeCostMicros`.
 */
export function computeCacheSavingsMicros(
  pricing: PricingRow,
  cachedReadTokens: number,
  cacheCreationTokens: number,
): number {
  const readSavings = cachedReadTokens * (pricing.inputPer1M - effectiveCachedReadPer1M(pricing));
  const writePremium =
    cacheCreationTokens * (effectiveCacheWritePer1M(pricing) - pricing.inputPer1M);
  return Math.round(readSavings - writePremium);
}
