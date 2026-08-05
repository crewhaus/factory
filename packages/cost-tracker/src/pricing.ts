/**
 * Section 27 — versioned per-provider pricing table. Used by `cost-tracker`
 * to convert `(provider, modelId, inputTokens, outputTokens, cachedReadTokens,
 * cacheCreationTokens)` to a deterministic USD-microdollar total.
 *
 * Pricing is **versioned**, not point-in-time queried. Once a `costAccrual`
 * event lands in the audit-log, a re-aggregation later will produce the
 * same dollar figure even if upstream pricing has changed.
 *
 * Sources (2026-07 — keep current per provider release notes):
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
 * Default pricing table snapshotted 2026-07-14. Override at construction
 * time via `createCostTracker(bus, { pricing })` for tests or for
 * historical-run repricing.
 *
 * Maintain alongside `DEFAULT_CAPABILITIES` (capabilities.ts) — same family
 * keys, kept one-to-one — AND `KNOWN_SUNSETS` (feed.ts): a family added here
 * that is already past (or nearing) its provider's retirement date needs a
 * `KNOWN_SUNSETS` entry too, or `cheapest`/right-size can silently pick a
 * model on its way out.
 *
 * Row convention: a version-specific row (`claude-opus-4-8`) is the precise
 * price; a major-family base (`claude-opus-4`) catches unversioned/older ids
 * in that major; a bare-family fallback (`claude-opus`) resolves a future
 * next-major id (`claude-opus-5-…`) at the current-generation rate rather than
 * silently missing. Longest-prefix match (`resolvePricing`) means the most
 * specific row always wins, so the fallbacks only ever catch ids no
 * more-specific row covers.
 *
 * Anthropic pricing note (2026-07): current Anthropic prices come from the
 * `claude-api` skill — Opus 4.5+ is $5/$25, Sonnet is $3/$15, Haiku is $1/$5,
 * Fable/Mythos is $10/$50. Every current family is spelled out rather than left
 * to a fallback so each rate is greppable, and because the bedrock table's
 * fallbacks were added late: an id no row covered there matched NOTHING and
 * billed $0 rather than merely mispricing.
 *
 * `claude-opus-4-7`/`4-6` previously sat at $15/$75. That contradicted the
 * "Opus 4.5+ is $5/$25" rule one paragraph up, and two independent public
 * datasets plus the `claude-api` skill agree the real rate is $5/$25 — so the
 * table was overcharging 3x on two current models. The `claude-opus-4` base
 * stays $15/$75 because what it catches now is the genuinely-legacy 4.0/4.1
 * lineage, which really did cost that. Historical re-aggregation is unaffected:
 * that guarantee comes from table `version` pinning, not from freezing rows in
 * the current table.
 *
 * KEEPING THIS HONEST — `scripts/pricing-audit.ts` pins a golden for every
 * current model and fails the build if a row drifts from it, if a capabilities
 * key has no price, or if the table ages past 120 days.
 * `scripts/pricing-refresh.ts` diffs the table against two independent public
 * datasets and reports; it never writes. Update a price and its golden in the
 * same commit.
 */
export const DEFAULT_PRICING: PricingTable = {
  version: "2026-07-31",
  providers: {
    anthropic: {
      // Current generation (2026-07). Opus 4.5+ dropped to $5/$25.
      "claude-opus-5": { inputPer1M: 5.0, outputPer1M: 25.0 },
      "claude-opus-4-8": { inputPer1M: 5.0, outputPer1M: 25.0 },
      // Kept at the original Opus rate — see the header note.
      "claude-opus-4-7": { inputPer1M: 5.0, outputPer1M: 25.0 },
      "claude-opus-4-6": { inputPer1M: 5.0, outputPer1M: 25.0 },
      // Opus 4.5 is $5/$25 (the header's "Opus 4.5+" line). Without this row it
      // fell through to the `claude-opus-4` legacy base and billed $15/$75 — a
      // 3x overcharge on a current model. The base below stays $15/$75 because
      // what it now catches is the genuinely-legacy 4.0/4.1 lineage.
      "claude-opus-4-5": { inputPer1M: 5.0, outputPer1M: 25.0 },
      "claude-opus-4": { inputPer1M: 15.0, outputPer1M: 75.0 },
      "claude-sonnet-5": { inputPer1M: 3.0, outputPer1M: 15.0 },
      "claude-sonnet-4-6": { inputPer1M: 3.0, outputPer1M: 15.0 },
      "claude-sonnet-4-5": { inputPer1M: 3.0, outputPer1M: 15.0 },
      "claude-sonnet-4": { inputPer1M: 3.0, outputPer1M: 15.0 },
      "claude-haiku-4-5": { inputPer1M: 1.0, outputPer1M: 5.0 },
      "claude-haiku-4": { inputPer1M: 1.0, outputPer1M: 5.0 },
      // Fable 5: Anthropic's most capable widely-released model. Mythos 5
      // (Project Glasswing) is the same capabilities and the same $10/$50; it
      // is invitation-only so it appears in no public dataset — sourced from
      // the bundled `claude-api` skill, not from a price feed.
      "claude-fable-5": { inputPer1M: 10.0, outputPer1M: 50.0 },
      "claude-mythos-5": { inputPer1M: 10.0, outputPer1M: 50.0 },
      "claude-3-7-sonnet": { inputPer1M: 3.0, outputPer1M: 15.0 },
      "claude-3-5-haiku": { inputPer1M: 0.8, outputPer1M: 4.0 },
      // Bare-family fallbacks at the current-generation rate so a next-major
      // id never silently misses. Kept last so the version-specific and
      // major-base rows above win longest-prefix.
      "claude-opus": { inputPer1M: 5.0, outputPer1M: 25.0 },
      "claude-sonnet": { inputPer1M: 3.0, outputPer1M: 15.0 },
      "claude-haiku": { inputPer1M: 1.0, outputPer1M: 5.0 },
      "claude-fable": { inputPer1M: 10.0, outputPer1M: 50.0 },
      "claude-mythos": { inputPer1M: 10.0, outputPer1M: 50.0 },
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
      // gpt-5.1 (current, 2026-07) prices at the gpt-5 rate; best-known
      // public pricing.
      "gpt-5.1": {
        inputPer1M: 1.25,
        outputPer1M: 10.0,
        cachedReadPer1M: 0.125,
        cacheWritePer1M: 1.25,
      },
      "gpt-5.1-mini": {
        inputPer1M: 0.25,
        outputPer1M: 2.0,
        cachedReadPer1M: 0.025,
        cacheWritePer1M: 0.25,
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
      // `o3`/`o4-mini` previously had no row at all and billed $0. Both
      // cross-checked against two independent datasets (2026-07-31).
      o3: { inputPer1M: 2.0, outputPer1M: 8.0 },
      "o3-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
      "o4-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
    },
    gemini: {
      // Standard-context tier. The Gemini Developer API and Vertex publish the
      // same per-token rates for these text models, so one table serves both
      // paths the adapter can take. Every row below was cross-checked against
      // two independent datasets on 2026-07-31 unless noted.
      "gemini-3-pro": { inputPer1M: 2.0, outputPer1M: 12.0 },
      "gemini-3.6-flash": { inputPer1M: 1.5, outputPer1M: 7.5 },
      "gemini-3.5-flash": { inputPer1M: 1.5, outputPer1M: 9.0 },
      "gemini-3.1-flash-lite": { inputPer1M: 0.25, outputPer1M: 1.5 },
      "gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 10.0 },
      // 2.5-flash-lite must precede nothing in particular (longest-prefix
      // wins), but it needs its OWN row: without it, it inherited 2.5-flash
      // and billed 1.5x input / 6.25x output.
      "gemini-2.5-flash-lite": { inputPer1M: 0.1, outputPer1M: 0.4 },
      "gemini-2.5-flash": { inputPer1M: 0.3, outputPer1M: 2.5 },
      "gemini-2.0-flash": { inputPer1M: 0.1, outputPer1M: 0.4 },
      // Retired generation — no longer in any current price feed; kept so
      // historical audit-log re-aggregation still resolves.
      "gemini-1.5-pro": { inputPer1M: 1.25, outputPer1M: 5.0 },
      "gemini-1.5-flash": { inputPer1M: 0.075, outputPer1M: 0.3 },
    },
    bedrock: {
      // Current-generation Anthropic-on-Bedrock at first-party rates, so a
      // current model no longer inherits the legacy $15/$75 base.
      "anthropic.claude-opus-5": { inputPer1M: 5.0, outputPer1M: 25.0 },
      "anthropic.claude-opus-4-8": { inputPer1M: 5.0, outputPer1M: 25.0 },
      // Same 4.5-falls-to-legacy-base trap as the first-party table.
      "anthropic.claude-opus-4-5": { inputPer1M: 5.0, outputPer1M: 25.0 },
      "anthropic.claude-sonnet-5": { inputPer1M: 3.0, outputPer1M: 15.0 },
      "anthropic.claude-haiku-4-5": { inputPer1M: 1.0, outputPer1M: 5.0 },
      "anthropic.claude-fable-5": { inputPer1M: 10.0, outputPer1M: 50.0 },
      "anthropic.claude-opus-4": { inputPer1M: 15.0, outputPer1M: 75.0 },
      "anthropic.claude-sonnet-4": { inputPer1M: 3.0, outputPer1M: 15.0 },
      // Bare-family fallbacks, mirroring the anthropic table. Their absence is
      // why bedrock was the worse half: with no catch-all, an id one row did
      // not spell out (`anthropic.claude-haiku-4-5`, `…fable-5`, any next
      // major) matched NOTHING and billed $0 instead of merely mispricing.
      // Kept last; the version-specific and major-base rows above win on
      // longest-prefix.
      "anthropic.claude-opus": { inputPer1M: 5.0, outputPer1M: 25.0 },
      "anthropic.claude-sonnet": { inputPer1M: 3.0, outputPer1M: 15.0 },
      "anthropic.claude-haiku": { inputPer1M: 1.0, outputPer1M: 5.0 },
      "anthropic.claude-fable": { inputPer1M: 10.0, outputPer1M: 50.0 },
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
