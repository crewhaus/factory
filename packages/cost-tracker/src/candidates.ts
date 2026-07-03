/**
 * Items 24 & 25 — offline model-CANDIDATE enumeration from the pricing table.
 *
 * Both the market scan (#24) and the right-sizing search (#25) start from the
 * same question: "given the model this slot uses today, what OTHER models
 * could replace it?" The answer is the pricing table's own rows, filtered by
 * capability so a candidate can actually serve the slot, ranked by table
 * price so cheaper options surface first. Pure/offline — no adapter
 * construction, no credentials.
 *
 * Candidates are enumerated as `<provider-prefix><family-prefix>` SPEC model
 * strings (the form `agent.model` takes), reconstructed from the pricing
 * table key + provider so the caller can drop one straight into a spec.
 */
import {
  type CapabilityRequirement,
  type CapabilityTable,
  DEFAULT_CAPABILITIES,
  resolveCapabilities,
  satisfiesCapabilities,
} from "./capabilities";
import { DEFAULT_PRICING, type PricingRow, type PricingTable, resolvePricing } from "./pricing";

/** A model-router provider id (pricing/capability tables are keyed on these). */
export type CandidateProvider = "anthropic" | "openai" | "gemini" | "bedrock";

/** Reconstruct the SPEC model string for a `(provider, family-prefix)` pair —
 *  the inverse of parseModelString's provider routing, using a representative
 *  family id (the prefix itself is a valid concrete id for these tables). */
export function specStringFor(provider: CandidateProvider, familyPrefix: string): string {
  switch (provider) {
    case "anthropic":
      return familyPrefix; // claude-* is unprefixed
    case "openai":
      return `openai/${familyPrefix}`;
    case "gemini":
      return `gemini/${familyPrefix}`;
    case "bedrock":
      return `bedrock/${familyPrefix}`;
  }
}

export type ModelCandidate = {
  /** SPEC model string (drop-in for `agent.model`). */
  readonly modelString: string;
  readonly provider: CandidateProvider;
  /** Pricing-table family key this candidate came from. */
  readonly familyPrefix: string;
  readonly pricing: PricingRow;
  /** Blended $/1M at a 3:1 input:output token mix — the ranking scalar. */
  readonly blendedPer1M: number;
};

/** Blended per-1M price at a representative 3:1 input:output ratio (the
 *  typical agent-turn shape), so a single scalar orders candidates. */
export function blendedPer1M(row: PricingRow): number {
  return (row.inputPer1M * 3 + row.outputPer1M) / 4;
}

export type EnumerateCandidatesOptions = {
  readonly pricing?: PricingTable;
  readonly capabilities?: CapabilityTable;
  /** Capabilities the slot requires — a candidate must satisfy all of them. */
  readonly require?: CapabilityRequirement;
  /**
   * When true, restrict candidates to the SAME provider as `currentModel`
   * (same-provider siblings keep cache markers valid and credentials the
   * same). The `cheapest` sentinel uses this; market-scan defaults to false
   * (cross-provider replacements are in scope for a human-reviewed proposal).
   */
  readonly sameProviderOnly?: boolean;
  /** Exclude the current model's own family from the candidate list. */
  readonly excludeCurrent?: boolean;
};

/**
 * Enumerate replacement candidates for `currentModel`, cheapest blended price
 * first. `currentModel` is a parsed `(provider, modelId)` — the caller parses
 * the spec string with the model-router grammar (kept out of this package to
 * preserve cost-tracker's dependency graph) and passes the pair in.
 *
 * A candidate is included when: (a) it is in the pricing table, (b) it
 * satisfies every required capability (unknown-capability rows are excluded
 * when a requirement is set — never over-promise), and (c) it passes the
 * same-provider / exclude-current filters.
 */
export function enumerateCandidates(
  current: { readonly provider: CandidateProvider; readonly modelId: string },
  opts: EnumerateCandidatesOptions = {},
): ModelCandidate[] {
  const pricing = opts.pricing ?? DEFAULT_PRICING;
  const capabilities = opts.capabilities ?? DEFAULT_CAPABILITIES;
  const require = opts.require;
  const currentFamily = familyPrefixOf(pricing, current.provider, current.modelId);

  const out: ModelCandidate[] = [];
  const providers: CandidateProvider[] = opts.sameProviderOnly
    ? [current.provider]
    : (["anthropic", "openai", "gemini", "bedrock"] as const).filter(
        (p) => pricing.providers[p] !== undefined,
      );

  for (const provider of providers) {
    const table = pricing.providers[provider];
    if (table === undefined) continue;
    for (const [familyPrefix, row] of Object.entries(table)) {
      if (opts.excludeCurrent && provider === current.provider && familyPrefix === currentFamily) {
        continue;
      }
      if (require !== undefined) {
        const caps = resolveCapabilities(capabilities, provider, familyPrefix);
        if (caps === undefined || !satisfiesCapabilities(caps, require)) continue;
      }
      out.push({
        modelString: specStringFor(provider, familyPrefix),
        provider,
        familyPrefix,
        pricing: row,
        blendedPer1M: blendedPer1M(row),
      });
    }
  }
  return out.sort((a, b) => a.blendedPer1M - b.blendedPer1M);
}

/** The pricing-table family prefix `(provider, modelId)` resolves to (for
 *  exclude-current); `undefined` when the model isn't in the table. */
export function familyPrefixOf(
  pricing: PricingTable,
  provider: CandidateProvider,
  modelId: string,
): string | undefined {
  const table = pricing.providers[provider];
  if (table === undefined) return undefined;
  const bareId = modelId;
  const prefixes = Object.keys(table).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (
      bareId === prefix ||
      bareId.startsWith(`${prefix}-`) ||
      bareId.startsWith(`${prefix}@`) ||
      bareId.startsWith(`${prefix}.`)
    ) {
      return prefix;
    }
  }
  return undefined;
}

/** The sentinel value an aux model knob may take instead of a concrete id. */
export const CHEAPEST_SENTINEL = "cheapest";

/**
 * Minimal provider + wire-id parse for a spec model string, self-contained so
 * cost-tracker need not depend on the full model-router grammar. Covers the
 * four table-backed providers; returns `undefined` for local/azure/named-host
 * strings (which carry no pricing rows anyway).
 */
export function providerOfSpecString(
  modelString: string,
): { readonly provider: CandidateProvider; readonly modelId: string } | undefined {
  if (modelString.startsWith("openai/")) {
    return { provider: "openai", modelId: modelString.slice("openai/".length) };
  }
  if (modelString.startsWith("gemini/")) {
    return { provider: "gemini", modelId: modelString.slice("gemini/".length) };
  }
  if (modelString.startsWith("bedrock/")) {
    return { provider: "bedrock", modelId: modelString.slice("bedrock/".length) };
  }
  if (modelString.startsWith("vertex/claude-")) {
    return { provider: "anthropic", modelId: modelString.slice("vertex/".length) };
  }
  if (modelString.startsWith("vertex/gemini-")) {
    return { provider: "gemini", modelId: modelString.slice("vertex/".length) };
  }
  if (modelString.startsWith("claude-")) {
    return { provider: "anthropic", modelId: modelString };
  }
  // local/azure/named-host/openai-compat: not table-backed.
  return undefined;
}

/**
 * Item 25 — resolve the `cheapest` sentinel for an aux slot given the PRIMARY
 * model's spec string (the sentinel resolves same-provider to the primary).
 * Returns the concrete spec model string, or `undefined` when the primary's
 * provider isn't table-backed or nothing qualifies. Compile/boot calls this;
 * `doctor` prints the result.
 */
export function resolveCheapestForSlot(
  primaryModel: string,
  opts: {
    readonly pricing?: PricingTable;
    readonly capabilities?: CapabilityTable;
    readonly require?: CapabilityRequirement;
  } = {},
): string | undefined {
  const parsed = providerOfSpecString(primaryModel);
  if (parsed === undefined) return undefined;
  return resolveCheapest(parsed, opts)?.modelString;
}

/**
 * Resolve the `cheapest` sentinel for an auxiliary slot: the lowest blended
 * price SAME-PROVIDER family whose capabilities satisfy `require`. Returns the
 * spec model string, or `undefined` when nothing in the provider's table
 * qualifies (the caller then keeps the explicit model / errors).
 *
 * Same-provider-only by construction: an aux slot (compaction, judge)
 * inherits the primary's credentials and, for compaction, benefits from cache
 * continuity — a `cheapest` that hopped providers would silently need another
 * key.
 */
export function resolveCheapest(
  current: { readonly provider: CandidateProvider; readonly modelId: string },
  opts: {
    readonly pricing?: PricingTable;
    readonly capabilities?: CapabilityTable;
    readonly require?: CapabilityRequirement;
  } = {},
): ModelCandidate | undefined {
  const candidates = enumerateCandidates(current, {
    ...(opts.pricing !== undefined ? { pricing: opts.pricing } : {}),
    ...(opts.capabilities !== undefined ? { capabilities: opts.capabilities } : {}),
    ...(opts.require !== undefined ? { require: opts.require } : {}),
    sameProviderOnly: true,
  });
  return candidates[0];
}

/**
 * Item 25 — score-retained-per-dollar-saved ranking of right-size proposals.
 *
 * Each proposal pairs a candidate model with the eval outcome of swapping it
 * in (pass rate + projected USD). A proposal is RECOMMENDED only when it
 * holds the baseline pass rate (within `passRateTolerance`) AND drops cost by
 * at least `minCostDropRatio`. Recommended proposals rank by dollars saved
 * (per unit of retained score) descending — the biggest safe saving first.
 */
export type RightSizeProposal = {
  readonly modelString: string;
  /** Which slot was swapped (agent / sub-agent / compaction / judge). */
  readonly slot: string;
  readonly passRate: number;
  readonly costUsd: number;
};

export type RightSizeBaseline = {
  readonly passRate: number;
  readonly costUsd: number;
};

export type RankedRightSize = RightSizeProposal & {
  readonly costDropRatio: number;
  readonly passRateDelta: number;
  readonly recommended: boolean;
  readonly reason: string;
  /** Dollars saved vs baseline (>= 0 when cheaper). */
  readonly savingUsd: number;
};

export function rankRightSizeProposals(
  baseline: RightSizeBaseline,
  proposals: ReadonlyArray<RightSizeProposal>,
  opts: { readonly minCostDropRatio: number; readonly passRateTolerance?: number },
): RankedRightSize[] {
  const tolerance = opts.passRateTolerance ?? 0;
  const ranked = proposals.map((p): RankedRightSize => {
    const savingUsd = baseline.costUsd - p.costUsd;
    const costDropRatio = baseline.costUsd > 0 ? savingUsd / baseline.costUsd : 0;
    const passRateDelta = p.passRate - baseline.passRate;
    const holdsQuality = passRateDelta >= -tolerance;
    const cheapEnough = costDropRatio >= opts.minCostDropRatio;
    const recommended = holdsQuality && cheapEnough;
    return {
      ...p,
      savingUsd,
      costDropRatio,
      passRateDelta,
      recommended,
      reason: recommended
        ? `holds pass rate (${(passRateDelta * 100).toFixed(1)}pp) and cuts cost ${(costDropRatio * 100).toFixed(0)}%`
        : !holdsQuality
          ? `pass rate dropped ${(passRateDelta * 100).toFixed(1)}pp (> tolerance ${(tolerance * 100).toFixed(1)}pp)`
          : `cost drop ${(costDropRatio * 100).toFixed(0)}% < required ${(opts.minCostDropRatio * 100).toFixed(0)}%`,
    };
  });
  // Recommended first, then by dollars saved desc; non-recommended keep after.
  return ranked.sort((a, b) => {
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    return b.savingUsd - a.savingUsd;
  });
}
