/**
 * Items 24 & 25 — a static, hand-maintained per-model-family CAPABILITY
 * table, the sibling of `DEFAULT_PRICING`.
 *
 * Why a second table instead of reusing the adapters' `ProviderFeatures`:
 * an adapter's feature object is only knowable once the adapter is
 * CONSTRUCTED (which needs credentials and, for the optional providers, an
 * installed SDK). Model-scan / right-size / the `cheapest` sentinel all run
 * OFFLINE — they must reason about "could model X satisfy this slot" without
 * booting anything. So this table encodes, per (provider, model-family
 * prefix), the same capability flags the adapters advertise, keyed exactly
 * like the pricing table so the two stay one-to-one.
 *
 * Maintained by hand, like `DEFAULT_PRICING`: when a provider ships a model
 * with new capabilities, add/adjust a row here AND in pricing.ts. The
 * per-adapter `ProviderFeatures` remains the runtime source of truth; this
 * table is the offline projection of it and is deliberately conservative
 * (a family whose members differ takes the SHARED-subset capabilities so a
 * `cheapest`/right-size pick never over-promises).
 *
 * A THIRD table rides alongside these two: `KNOWN_SUNSETS` in feed.ts. When a
 * family is retired here or in pricing.ts, check whether it also needs a
 * `KNOWN_SUNSETS` entry (or an existing entry's `replacement` needs updating)
 * — `resolveCheapest`/`enumerateCandidates` cross-reference all three so the
 * `cheapest` sentinel never resolves to a model on its way out.
 *
 * The flag set mirrors `ProviderFeatures` in `@crewhaus/adapter-anthropic`:
 *   caching: "explicit" | "automatic" | false
 *   tool_use, vision, thinking, web_search: boolean
 * Kept structurally identical so a capability requirement can be expressed
 * as a partial of this shape.
 */
import type { ProviderId } from "@crewhaus/trace-event-bus";

/** Offline capability flags for a model family — mirrors `ProviderFeatures`. */
export type ModelCapabilities = {
  readonly caching: "explicit" | "automatic" | false;
  readonly tool_use: boolean;
  readonly vision: boolean;
  readonly thinking: boolean;
  readonly web_search: boolean;
};

export type CapabilityTable = {
  readonly version: string;
  readonly providers: {
    readonly [P in ProviderId]?: {
      readonly [modelIdPrefix: string]: ModelCapabilities;
    };
  };
};

/**
 * Snapshotted alongside `DEFAULT_PRICING` (2026-05-08). Rows are keyed on the
 * SAME family prefixes as the pricing table so `resolveCapabilities` and
 * `resolvePricing` line up one-to-one. Values transcribe the concrete
 * `ProviderFeatures` each adapter declares (adapter-anthropic/adapter-openai/
 * adapter-gemini/adapter-bedrock family.ts).
 */
export const DEFAULT_CAPABILITIES: CapabilityTable = {
  version: "2026-05-08",
  providers: {
    anthropic: {
      // Every current claude-* family: explicit caching, tools, vision,
      // thinking, hosted web_search (ANTHROPIC_FEATURES).
      "claude-opus-4": {
        caching: "explicit",
        tool_use: true,
        vision: true,
        thinking: true,
        web_search: true,
      },
      "claude-sonnet-4": {
        caching: "explicit",
        tool_use: true,
        vision: true,
        thinking: true,
        web_search: true,
      },
      "claude-haiku-4": {
        caching: "explicit",
        tool_use: true,
        vision: true,
        thinking: true,
        web_search: true,
      },
      "claude-3-7-sonnet": {
        caching: "explicit",
        tool_use: true,
        vision: true,
        thinking: true,
        web_search: true,
      },
      "claude-3-5-haiku": {
        caching: "explicit",
        tool_use: true,
        vision: true,
        thinking: false,
        web_search: true,
      },
    },
    openai: {
      // OPENAI_FEATURES: automatic caching, tools, vision; no exposed
      // thinking (o-series reasoning is not surfaced through the adapter),
      // no hosted web_search.
      "gpt-4o": {
        caching: "automatic",
        tool_use: true,
        vision: true,
        thinking: false,
        web_search: false,
      },
      "gpt-4.1": {
        caching: "automatic",
        tool_use: true,
        vision: true,
        thinking: false,
        web_search: false,
      },
      "gpt-5": {
        caching: "automatic",
        tool_use: true,
        vision: true,
        thinking: false,
        web_search: false,
      },
      // o-series: tools yes, vision no on the mini reasoning models.
      o1: {
        caching: "automatic",
        tool_use: true,
        vision: true,
        thinking: false,
        web_search: false,
      },
      "o3-mini": {
        caching: "automatic",
        tool_use: true,
        vision: false,
        thinking: false,
        web_search: false,
      },
    },
    gemini: {
      // GEMINI_FEATURES: automatic caching, tools, vision, thinking; no
      // hosted web_search.
      "gemini-2.5-pro": {
        caching: "automatic",
        tool_use: true,
        vision: true,
        thinking: true,
        web_search: false,
      },
      "gemini-2.5-flash": {
        caching: "automatic",
        tool_use: true,
        vision: true,
        thinking: true,
        web_search: false,
      },
      "gemini-2.0-flash": {
        caching: "automatic",
        tool_use: true,
        vision: true,
        thinking: false,
        web_search: false,
      },
      "gemini-1.5-pro": {
        caching: "automatic",
        tool_use: true,
        vision: true,
        thinking: false,
        web_search: false,
      },
      "gemini-1.5-flash": {
        caching: "automatic",
        tool_use: true,
        vision: true,
        thinking: false,
        web_search: false,
      },
    },
    bedrock: {
      // Transcribes adapter-bedrock featuresForFamily(): anthropic on Bedrock
      // keeps explicit caching + thinking; llama/mistral are tools-only;
      // nova adds vision.
      "anthropic.claude-opus-4": {
        caching: "explicit",
        tool_use: true,
        vision: true,
        thinking: true,
        web_search: false,
      },
      "anthropic.claude-sonnet-4": {
        caching: "explicit",
        tool_use: true,
        vision: true,
        thinking: true,
        web_search: false,
      },
      "meta.llama3-1": {
        caching: false,
        tool_use: true,
        vision: false,
        thinking: false,
        web_search: false,
      },
      "mistral.mistral-large": {
        caching: false,
        tool_use: true,
        vision: false,
        thinking: false,
        web_search: false,
      },
    },
  },
};

/** Geo-segment strip, twin of pricing.ts BEDROCK_GEO_PREFIX. */
const BEDROCK_GEO_PREFIX = /^(?:us|eu|apac|jp|au|ca|sa|us-gov|global)\./;

/**
 * Resolve capabilities for `(provider, modelId)`, longest-prefix-match like
 * `resolvePricing`. Returns `undefined` when the family is not in the table
 * (an unknown model — callers treat that as "capabilities unknown", never as
 * "capable").
 */
export function resolveCapabilities(
  table: CapabilityTable,
  provider: ProviderId,
  modelId: string,
): ModelCapabilities | undefined {
  const providerTable = table.providers[provider];
  if (!providerTable) return undefined;
  const bareId = provider === "bedrock" ? modelId.replace(BEDROCK_GEO_PREFIX, "") : modelId;
  const prefixes = Object.keys(providerTable).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (bareId === prefix || bareId.startsWith(`${prefix}-`) || bareId.startsWith(`${prefix}@`)) {
      return providerTable[prefix];
    }
  }
  return undefined;
}

/** A capability requirement: any subset of the flags a slot must satisfy. */
export type CapabilityRequirement = Partial<ModelCapabilities>;

/**
 * Does `caps` satisfy `req`? Booleans: a required `true` needs `caps` true
 * (a required `false`/absent is a don't-care). `caching`: a required
 * `"explicit"` needs explicit; a required `"automatic"` accepts explicit OR
 * automatic (explicit is a superset — anything that caches at all satisfies
 * an automatic requirement); a required `false`/absent is a don't-care.
 */
export function satisfiesCapabilities(
  caps: ModelCapabilities,
  req: CapabilityRequirement,
): boolean {
  for (const key of ["tool_use", "vision", "thinking", "web_search"] as const) {
    if (req[key] === true && caps[key] !== true) return false;
  }
  if (req.caching === "explicit" && caps.caching !== "explicit") return false;
  if (req.caching === "automatic" && caps.caching === false) return false;
  return true;
}
