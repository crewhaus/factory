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
import { findSunset } from "./feed";
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
  /**
   * When true, drop families listed in `KNOWN_SUNSETS` for that provider —
   * a candidate that is itself scheduled for retirement is never a good
   * "replace this model" answer. The `cheapest` sentinel sets this (it
   * resolves silently at compile time with no human review); market-scan
   * defaults to false (its picks are eval-gated and human-reviewed before
   * `--write`, and `doctor --models` separately flags a sunset pick).
   */
  readonly excludeSunsets?: boolean;
};

/**
 * Enumerate replacement candidates for `currentModel`, cheapest blended price
 * first. `currentModel` is a parsed `(provider, modelId)` — the caller parses
 * the spec string with the model-router grammar (kept out of this package to
 * preserve cost-tracker's dependency graph) and passes the pair in.
 *
 * A candidate is included when: (a) it is in the pricing table, (b) it
 * satisfies every required capability (unknown-capability rows are excluded
 * when a requirement is set — never over-promise), (c) it passes the
 * same-provider / exclude-current filters, and (d) — when `excludeSunsets`
 * is set — it is not itself a `KNOWN_SUNSETS` family for that provider.
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
      if (opts.excludeSunsets && findSunset(provider, familyPrefix) !== undefined) {
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
 * 0.6.0 §4.3 — the second sentinel: the strongest model available to the
 * slot. Unlike `cheapest` (price rank only), `strongest` resolves
 * ROSTER-FIRST when a `models:` registry or `model_pool` exists (see
 * `resolveStrongestForSlot`) and falls back to price rank only for a bare
 * single-model spec.
 */
export const STRONGEST_SENTINEL = "strongest";

/** Every model sentinel a slot may carry instead of a grammar string. */
export type ModelSentinel = typeof CHEAPEST_SENTINEL | typeof STRONGEST_SENTINEL;

/** TRUE when `value` is one of the two model sentinels. */
export function isModelSentinel(value: string): value is ModelSentinel {
  return value === CHEAPEST_SENTINEL || value === STRONGEST_SENTINEL;
}

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
 *
 * Sunset families are unconditionally excluded: `cheapest` resolves silently
 * at compile time with no human in the loop, so it must never hand back a
 * model `doctor --models` would immediately flag for migration. (Contrast
 * market-scan's `enumerateCandidates` call, which leaves sunsets in — its
 * picks are eval-gated and human-reviewed before `--write`.)
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
    excludeSunsets: true,
  });
  return candidates[0];
}

/**
 * One roster member the roster-first `strongest` resolution ranks over: a
 * `models:` profile (`name` set) or a `model_pool` candidate (`name` absent,
 * `model` is the arm identity). `tags` are the routing identity — the
 * `strong` tag is what makes a member the strongest, exactly as
 * `PolicyRouter.escalation()` decides it at runtime.
 */
export type RosterMember = {
  /** Profile name when the member is a `models:` profile. */
  readonly name?: string;
  /** Spec model string (grammar string; never a sentinel once lowered). */
  readonly model: string;
  readonly tags?: readonly string[];
};

/** The outcome of a roster-first `strongest` resolution. */
export type StrongestResolution = {
  /** The concrete spec model string the slot resolves to. */
  readonly modelString: string;
  /** Profile name when the resolution landed on a named profile. */
  readonly profile?: string;
  /** How the pick was made — persisted on the compile warning / `models explain`. */
  readonly source: "roster:strong-tag" | "roster:last-declared" | "price-rank";
};

/**
 * 0.6.0 §4.3 — the roster-first half of `strongest`: the FIRST member
 * carrying `strongTag` (default `"strong"`), else the LAST declared member —
 * the same convention `PolicyRouter.escalation()` / `strongest()` use at
 * runtime (`@crewhaus/model-router` policy-router), so the compile-time
 * answer and the runtime escalation target agree. `undefined` for an empty
 * roster. A member whose `model` is itself a sentinel is skipped (it cannot
 * be the answer to its own question — the circularity rule below).
 */
export function resolveStrongestFromRoster(
  roster: ReadonlyArray<RosterMember>,
  opts: { readonly strongTag?: string } = {},
): StrongestResolution | undefined {
  const strongTag = opts.strongTag ?? "strong";
  const members = roster.filter((m) => !isModelSentinel(m.model));
  if (members.length === 0) return undefined;
  const tagged = members.find((m) => (m.tags ?? []).includes(strongTag));
  if (tagged !== undefined) {
    return {
      modelString: tagged.model,
      ...(tagged.name !== undefined ? { profile: tagged.name } : {}),
      source: "roster:strong-tag",
    };
  }
  const last = members[members.length - 1] as RosterMember;
  return {
    modelString: last.model,
    ...(last.name !== undefined ? { profile: last.name } : {}),
    source: "roster:last-declared",
  };
}

/**
 * 0.6.0 §4.3 — resolve the `strongest` sentinel by PRICE RANK: the highest
 * blended price SAME-PROVIDER family whose capabilities satisfy `require`,
 * sunsets excluded (the mirror image of `resolveCheapest`). Returns
 * `undefined` when the provider is not table-backed or nothing qualifies.
 * This is the fallback for bare single-model specs only — with a roster in
 * play, `resolveStrongestForSlot` never reaches price rank, because a
 * price-rank-only `strongest` cannot cross providers (`sameProviderOnly`) and
 * returns `undefined` for a local primary, which would make
 * "local cheap worker + hosted strong judge" uncompilable.
 */
export function resolveStrongest(
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
    excludeSunsets: true,
  });
  // `enumerateCandidates` sorts ascending by blended price; the strongest is
  // the most expensive family. Ties keep declared (table) order — the sort is
  // stable — so we take the LAST of the highest price group's first entry by
  // scanning for the max.
  let best: ModelCandidate | undefined;
  for (const c of candidates) {
    if (best === undefined || c.blendedPer1M > best.blendedPer1M) best = c;
  }
  return best;
}

/**
 * 0.6.0 §4.3 — resolve the `strongest` sentinel for a slot.
 *
 *   1. ROSTER-FIRST: when `opts.roster` names at least one member (the
 *      spec's `models:` profiles and/or `model_pool.candidates`), the answer
 *      is `resolveStrongestFromRoster` — first `strong`-tagged member, else
 *      the last declared. Providers may differ from the primary; that is
 *      the point (a local worker with a hosted judge). `crewhaus lint` and
 *      `doctor` note the cross-provider case (`crossesProvider`).
 *   2. PRICE RANK: only for a bare single-model spec (no roster), the
 *      highest blended-price same-provider family (`resolveStrongest`).
 *
 * THE CIRCULARITY RULE: inside a `models:` profile's own `model:` or a
 * `model_pool.candidates[].model`, the sentinels resolve by price rank
 * against the primary ONLY — a roster member cannot be defined in terms of
 * the roster it belongs to. Callers lowering such a slot pass NO roster (or
 * set `inRoster: true`, which ignores any roster handed in). `undefined`
 * when neither path yields a model; the caller turns that into a
 * `CompilerError` naming the slot, exactly as `cheapest` does today.
 */
export function resolveStrongestForSlot(
  primaryModel: string,
  opts: {
    readonly roster?: ReadonlyArray<RosterMember>;
    /** TRUE when the slot being resolved is itself a roster member (profile / candidate `model:`). */
    readonly inRoster?: boolean;
    readonly strongTag?: string;
    readonly pricing?: PricingTable;
    readonly capabilities?: CapabilityTable;
    readonly require?: CapabilityRequirement;
  } = {},
): StrongestResolution | undefined {
  if (opts.inRoster !== true && opts.roster !== undefined && opts.roster.length > 0) {
    const fromRoster = resolveStrongestFromRoster(opts.roster, {
      ...(opts.strongTag !== undefined ? { strongTag: opts.strongTag } : {}),
    });
    if (fromRoster !== undefined) return fromRoster;
  }
  const parsed = providerOfSpecString(primaryModel);
  if (parsed === undefined) return undefined;
  const picked = resolveStrongest(parsed, {
    ...(opts.pricing !== undefined ? { pricing: opts.pricing } : {}),
    ...(opts.capabilities !== undefined ? { capabilities: opts.capabilities } : {}),
    ...(opts.require !== undefined ? { require: opts.require } : {}),
  });
  return picked === undefined
    ? undefined
    : { modelString: picked.modelString, source: "price-rank" };
}

/**
 * 0.6.0 §4.3 — TRUE when two spec model strings resolve to different
 * table-backed providers, or when exactly one of them is table-backed (a
 * local/azure/named-host primary beside a hosted judge). Both non-table
 * strings compare by their scheme prefix. The lint/doctor note for a
 * cross-provider `strongest` keys on this: transcript content leaves the
 * primary's box and a second credential is needed.
 */
export function crossesProvider(primaryModel: string, resolvedModel: string): boolean {
  const a = providerOfSpecString(primaryModel);
  const b = providerOfSpecString(resolvedModel);
  if (a !== undefined && b !== undefined) return a.provider !== b.provider;
  if (a === undefined && b === undefined) return schemeOf(primaryModel) !== schemeOf(resolvedModel);
  return true;
}

function schemeOf(modelString: string): string {
  const slash = modelString.indexOf("/");
  return slash === -1 ? "" : modelString.slice(0, slash);
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
