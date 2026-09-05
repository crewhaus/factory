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
import {
  DEFAULT_PRICING,
  type PricingRow,
  type PricingTable,
  type SunsetEntry,
  type SunsetTable,
} from "./pricing";

export type { SunsetEntry, SunsetTable } from "./pricing";

/** Parse-and-validate a pricing feed JSON string into a `PricingTable`.
 *  Throws `PricingFeedError` on a malformed document (so a corrupt feed is a
 *  loud CLI error, never a silently-ignored $0 pricing regression). */
export class PricingFeedError extends Error {
  override readonly name = "PricingFeedError";
}

export const KNOWN_PROVIDERS = ["anthropic", "openai", "gemini", "bedrock"] as const;

/** Options for {@link parsePricingFeed}. */
export type ParsePricingFeedOptions = {
  /**
   * Accept a feed that does not cover every provider in
   * {@link KNOWN_PROVIDERS}. Default `false` — see the completeness gate note
   * on {@link parsePricingFeed}. Only pass `true` when the caller is going to
   * merge the result into a complete table itself.
   */
  readonly partial?: boolean;
};

function isRow(v: unknown): v is PricingRow {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r["inputPer1M"] !== "number" || typeof r["outputPer1M"] !== "number") return false;
  for (const opt of ["cachedReadPer1M", "cacheWritePer1M"] as const) {
    if (r[opt] !== undefined && typeof r[opt] !== "number") return false;
  }
  return true;
}

/**
 * Parse + structurally validate a feed JSON document.
 *
 * COMPLETENESS GATE — a feed REPLACES the effective table wholesale
 * (`pickNewestPricing` picks one table by version; it deliberately does not
 * merge, so a pinned historical table stays byte-reproducible). That makes an
 * under-populated feed a silent, total billing regression rather than a
 * partial one: a document as small as `{"version":"2099-01-01","providers":{}}`
 * used to parse clean, win on version, and turn EVERY model into a pricing
 * miss — which `cost-tracker` charges at $0. A feed naming only one provider
 * zeroed the other three the same way.
 *
 * So a feed must carry every provider in {@link KNOWN_PROVIDERS}, each with at
 * least one row, unless the caller explicitly opts into `{ partial: true }`
 * and takes responsibility for merging. Rejecting is the right lever rather
 * than merging over `DEFAULT_PRICING`: merging would silently blend the
 * built-in table into a feed pinned for historical re-aggregation and break
 * the determinism contract this module exists to uphold.
 */
export function parsePricingFeed(json: string, opts: ParsePricingFeedOptions = {}): PricingTable {
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
  if (d["sunsets"] !== undefined) validateFeedSunsets(d["sunsets"]);
  if (opts.partial !== true) {
    const missing = KNOWN_PROVIDERS.filter((p) => {
      const t = providers[p];
      return typeof t !== "object" || t === null || Object.keys(t).length === 0;
    });
    if (missing.length > 0) {
      throw new PricingFeedError(
        `pricing feed is incomplete: no rows for ${missing.join("/")}. A feed REPLACES the effective pricing table, so an absent provider prices every one of its models at $0. Supply rows for all of ${KNOWN_PROVIDERS.join("/")}.`,
      );
    }
  }
  return doc as PricingTable;
}

const SUNSET_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 0.6.0 §9.1 — structural validation of a feed's optional `sunsets` section:
 * `{ <provider>: [{ modelIdPrefix, retiresOn: YYYY-MM-DD, replacement, note? }] }`.
 * Same loudness policy as the rows — a malformed entry rejects the whole
 * feed, because a sunset that silently failed to install is exactly the
 * surprise 404 the table exists to prevent.
 */
function validateFeedSunsets(raw: unknown): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PricingFeedError('pricing feed: "sunsets" must map providers to entry arrays');
  }
  for (const [provider, entries] of Object.entries(raw as Record<string, unknown>)) {
    if (!(KNOWN_PROVIDERS as readonly string[]).includes(provider)) {
      throw new PricingFeedError(
        `pricing feed: sunsets names unknown provider "${provider}" (expected ${KNOWN_PROVIDERS.join("/")})`,
      );
    }
    if (!Array.isArray(entries)) {
      throw new PricingFeedError(`pricing feed: sunsets["${provider}"] must be an array`);
    }
    entries.forEach((e, i) => {
      const at = `sunsets["${provider}"][${i}]`;
      if (typeof e !== "object" || e === null || Array.isArray(e)) {
        throw new PricingFeedError(`pricing feed: ${at} must be an object`);
      }
      const r = e as Record<string, unknown>;
      if (typeof r["modelIdPrefix"] !== "string" || r["modelIdPrefix"].length === 0) {
        throw new PricingFeedError(`pricing feed: ${at} needs a non-empty "modelIdPrefix"`);
      }
      if (typeof r["retiresOn"] !== "string" || !SUNSET_DATE_RE.test(r["retiresOn"])) {
        throw new PricingFeedError(`pricing feed: ${at} needs "retiresOn" as YYYY-MM-DD`);
      }
      if (typeof r["replacement"] !== "string" || r["replacement"].length === 0) {
        throw new PricingFeedError(`pricing feed: ${at} needs a non-empty "replacement"`);
      }
      if (r["note"] !== undefined && typeof r["note"] !== "string") {
        throw new PricingFeedError(`pricing feed: ${at} "note" must be a string when present`);
      }
    });
  }
}

/**
 * 0.6.0 §9.1 — the sunset table `doctor --models` (and later `models audit`)
 * consults: the compiled-in {@link KNOWN_SUNSETS} plus whatever `sunsets` the
 * installed pricing feed carries. Feed entries ADD new families and may
 * refresh the date / replacement / note of a compiled-in family, but a family
 * the compiled-in table knows keeps `source: "builtin"` — so a feed can never
 * demote a gate-bearing sunset to advisory, and only ever widens the watch.
 * Every entry is stamped with its `source`.
 */
export function effectiveSunsets(
  table: PricingTable | undefined,
  builtin: SunsetTable = KNOWN_SUNSETS,
): SunsetTable {
  const out: Record<string, SunsetEntry[]> = {};
  for (const [provider, entries] of Object.entries(builtin)) {
    out[provider] = entries.map((e) => ({ ...e, source: "builtin" as const }));
  }
  for (const [provider, entries] of Object.entries(table?.sunsets ?? {})) {
    const list = out[provider] ?? [];
    for (const e of entries) {
      const i = list.findIndex((b) => b.modelIdPrefix === e.modelIdPrefix);
      if (i >= 0) {
        const existing = list[i] as SunsetEntry;
        list[i] = { ...existing, ...e, source: existing.source ?? "builtin" };
      } else {
        list.push({ ...e, source: "feed" });
      }
    }
    out[provider] = list;
  }
  return out;
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
 *
 * Maintain ALONGSIDE `DEFAULT_PRICING` (pricing.ts) and `DEFAULT_CAPABILITIES`
 * (capabilities.ts): `enumerateCandidates`/`resolveCheapest` (candidates.ts)
 * cross-reference this table to exclude sunset families from the `cheapest`
 * sentinel's pool, so a family that goes end-of-life here should be checked
 * against those two tables as well (and vice versa — adding a new family to
 * pricing/capabilities is a good moment to check it isn't already sunset).
 */
export const KNOWN_SUNSETS: SunsetTable = {
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
    {
      modelIdPrefix: "claude-3-haiku",
      retiresOn: "2026-04-19",
      replacement: "claude-haiku-4-5",
      note: "Claude 3 haiku; migrate to the 4.x haiku",
    },
    // Version-specific keys only — a bare `claude-opus-4` / `claude-sonnet-4`
    // here would wrongly flag the current 4.5+/-5 models (findSunset prefix
    // match), so the retiring 4.0/4.1 lineage is listed by exact minor.
    {
      modelIdPrefix: "claude-opus-4-1",
      retiresOn: "2026-08-05",
      replacement: "claude-opus-4-8",
    },
    {
      modelIdPrefix: "claude-opus-4-0",
      retiresOn: "2026-06-15",
      replacement: "claude-opus-4-8",
    },
    {
      modelIdPrefix: "claude-sonnet-4-0",
      retiresOn: "2026-06-15",
      replacement: "claude-sonnet-5",
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
  table: SunsetTable = KNOWN_SUNSETS,
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
