/**
 * Item 24 — versioned pricing FEED loading + freshness/sunset watch.
 *
 * A pricing feed is a `PricingTable`-shaped JSON document a user drops into
 * `~/.crewhaus/pricing/` so price updates land WITHOUT a code release:
 * `createCostTracker({ pricing })` already accepts an override table, and
 * `loadUserPricing()` reads the newest feed there (falling back to the
 * built-in `DEFAULT_PRICING`) so the CLI can pass it through.
 *
 * This module is pure/injectable — the CLI supplies the directory + a
 * filesystem reader — so the merge/validation/freshness logic is unit
 * testable without touching `~`.
 */
import { DEFAULT_PRICING, type PricingRow, type PricingTable } from "./pricing";

/** Parse-and-validate a pricing feed JSON string into a `PricingTable`.
 *  Throws `PricingFeedError` on a malformed document (so a corrupt feed is a
 *  loud CLI error, never a silently-ignored $0 pricing regression). */
export class PricingFeedError extends Error {
  override readonly name = "PricingFeedError";
}

const KNOWN_PROVIDERS = ["anthropic", "openai", "gemini", "bedrock"] as const;

function isRow(v: unknown): v is PricingRow {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r["inputPer1M"] !== "number" || typeof r["outputPer1M"] !== "number") return false;
  for (const opt of ["cachedReadPer1M", "cacheWritePer1M"] as const) {
    if (r[opt] !== undefined && typeof r[opt] !== "number") return false;
  }
  return true;
}

/** Parse + structurally validate a feed JSON document. */
export function parsePricingFeed(json: string): PricingTable {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch (err) {
    throw new PricingFeedError(`pricing feed is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof doc !== "object" || doc === null) {
    throw new PricingFeedError("pricing feed must be a JSON object");
  }
  const d = doc as Record<string, unknown>;
  if (typeof d["version"] !== "string" || d["version"].length === 0) {
    throw new PricingFeedError(
      'pricing feed must carry a non-empty string "version" (e.g. "2026-07-01")',
    );
  }
  if (typeof d["providers"] !== "object" || d["providers"] === null) {
    throw new PricingFeedError('pricing feed must carry a "providers" object');
  }
  const providers = d["providers"] as Record<string, unknown>;
  for (const [provider, table] of Object.entries(providers)) {
    if (!(KNOWN_PROVIDERS as readonly string[]).includes(provider)) {
      throw new PricingFeedError(
        `pricing feed: unknown provider "${provider}" (expected ${KNOWN_PROVIDERS.join("/")})`,
      );
    }
    if (typeof table !== "object" || table === null) {
      throw new PricingFeedError(
        `pricing feed: provider "${provider}" must map model prefixes to rows`,
      );
    }
    for (const [modelPrefix, row] of Object.entries(table as Record<string, unknown>)) {
      if (!isRow(row)) {
        throw new PricingFeedError(
          `pricing feed: ${provider}/"${modelPrefix}" is not a valid pricing row (needs numeric inputPer1M + outputPer1M)`,
        );
      }
    }
  }
  return doc as PricingTable;
}

/**
 * Feed staleness: the table's `version` is a date stamp (`YYYY-MM-DD`). Warn
 * when it is older than `maxAgeDays` relative to `now`. A version that is not
 * a parseable date is treated as stale (unknown age -> warn).
 */
export function pricingTableAgeDays(version: string, now: Date): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(version);
  if (m === null) return undefined;
  const stamped = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const diffMs = now.getTime() - stamped;
  return Math.floor(diffMs / 86_400_000);
}

export type PricingStaleness = {
  readonly version: string;
  readonly ageDays?: number;
  readonly stale: boolean;
  readonly reason: string;
};

/** Classify a table's freshness against a `maxAgeDays` threshold. */
export function classifyPricingStaleness(
  table: PricingTable,
  now: Date,
  maxAgeDays: number,
): PricingStaleness {
  const ageDays = pricingTableAgeDays(table.version, now);
  if (ageDays === undefined) {
    return {
      version: table.version,
      stale: true,
      reason: `pricing table version "${table.version}" is not a YYYY-MM-DD date - cannot verify freshness; run \`crewhaus pricing sync\` with a dated feed`,
    };
  }
  const stale = ageDays > maxAgeDays;
  return {
    version: table.version,
    ageDays,
    stale,
    reason: stale
      ? `pricing table is ${ageDays} days old (> ${maxAgeDays}) - prices may have drifted; refresh with \`crewhaus pricing sync --file <feed.json>\``
      : `pricing table is ${ageDays} days old (<= ${maxAgeDays})`,
  };
}

/**
 * Known model SUNSETS - a small, hand-maintained, static table (NOT fetched).
 * `retiresOn` is the provider's announced end-of-life date (YYYY-MM-DD);
 * `replacement` names the recommended successor. doctor --models flags a spec
 * whose model matches one of these so a run isn't surprised by a 404 later.
 * Keyed on the same family-prefix grammar as the pricing table.
 *
 * Maintain by hand from provider deprecation notes - a stale entry is
 * harmless (it just over-warns), a missing one only means no warning.
 */
export type SunsetEntry = {
  readonly modelIdPrefix: string;
  readonly retiresOn: string;
  readonly replacement: string;
  readonly note?: string;
};

export const KNOWN_SUNSETS: Readonly<Record<string, readonly SunsetEntry[]>> = {
  anthropic: [
    {
      modelIdPrefix: "claude-3-5-haiku",
      retiresOn: "2026-10-01",
      replacement: "claude-haiku-4-5",
      note: "3.5 generation; migrate to the 4.x haiku",
    },
    {
      modelIdPrefix: "claude-3-7-sonnet",
      retiresOn: "2026-11-01",
      replacement: "claude-sonnet-4-5",
    },
  ],
  openai: [{ modelIdPrefix: "gpt-4o", retiresOn: "2026-09-01", replacement: "gpt-5" }],
  gemini: [
    { modelIdPrefix: "gemini-1.5-pro", retiresOn: "2026-09-24", replacement: "gemini-2.5-pro" },
    { modelIdPrefix: "gemini-1.5-flash", retiresOn: "2026-09-24", replacement: "gemini-2.5-flash" },
  ],
  bedrock: [],
};

/** Longest-prefix sunset lookup for `(provider, modelId)`; `undefined` when clean. */
export function findSunset(
  provider: string,
  modelId: string,
  table: Readonly<Record<string, readonly SunsetEntry[]>> = KNOWN_SUNSETS,
): SunsetEntry | undefined {
  const entries = table[provider];
  if (entries === undefined) return undefined;
  const sorted = [...entries].sort((a, b) => b.modelIdPrefix.length - a.modelIdPrefix.length);
  for (const e of sorted) {
    if (modelId === e.modelIdPrefix || modelId.startsWith(`${e.modelIdPrefix}-`)) return e;
  }
  return undefined;
}

/**
 * Pick the newest feed from a set of `{ version }` tables (lexicographic on
 * the YYYY-MM-DD stamp), falling back to `DEFAULT_PRICING` when the set is
 * empty. Pure - the CLI reads the directory and passes the parsed tables in.
 */
export function pickNewestPricing(feeds: ReadonlyArray<PricingTable>): PricingTable {
  if (feeds.length === 0) return DEFAULT_PRICING;
  return [...feeds].sort((a, b) =>
    a.version < b.version ? 1 : a.version > b.version ? -1 : 0,
  )[0] as PricingTable;
}
