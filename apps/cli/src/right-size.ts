/**
 * Item 25 — `crewhaus model right-size <spec>`: an enumerate → compile → eval
 * loop that searches for a CHEAPER model in ONE slot that HOLDS quality.
 *
 * This is a DEDICATED loop, deliberately NOT the prompt mutator: the
 * `MutationProvider` seam optimize uses is prompt-string-only, whereas
 * right-sizing swaps model IDENTIFIERS (agent.model, cli sub-agents[*].model,
 * compaction.model, the judge model). Each candidate is the spec with exactly
 * ONE model slot swapped to a cheaper same-provider pricing-table sibling; the
 * candidate is evaled, its per-candidate USD computed from the eval's token
 * aggregates (eval artifacts carry no `cost_accrual`, so cost is projected via
 * `resolvePricing`), and the set ranked by score-retained-per-dollar-saved.
 * A candidate is RECOMMENDED only when pass-rate holds and cost drops >= N%.
 *
 * Proposal-only: model paths stay outside `OPTIMIZABLE_PATHS`, so nothing is
 * auto-applied — a documented `--write` does the direct comment-preserving CST
 * edit (reusing `writeModelField`). This module is the pure/injectable core
 * (candidate enumeration + cost projection + ranking); the CLI wires the real
 * compile+eval.
 */
import {
  type CandidateProvider,
  DEFAULT_PRICING,
  type PricingTable,
  type RankedRightSize,
  type RightSizeProposal,
  computeCostMicros,
  enumerateCandidates,
  providerOfSpecString,
  rankRightSizeProposals,
  resolvePricing,
} from "@crewhaus/cost-tracker";

/** A swappable model slot in the spec, addressed by its patch path. */
export type ModelSlot = {
  /** Human label (agent.model, compaction.model, sub-agent <name>.model, judge). */
  readonly label: string;
  /** The spec model string currently in the slot. */
  readonly currentModel: string;
  /** The patch path (for the eventual CST edit); undefined for the judge (a
   *  CLI flag, not a spec field). */
  readonly path?: ReadonlyArray<string>;
};

/** One candidate: the spec with `slot` swapped to `candidateModel`. */
export type SlotCandidate = {
  readonly slot: ModelSlot;
  readonly candidateModel: string;
};

export type EnumerateSlotCandidatesOptions = {
  readonly pricing?: PricingTable;
  /** Cap the candidates per slot (cheapest-first). Default 3. */
  readonly perSlotLimit?: number;
};

/**
 * Enumerate downshift candidates across every slot: each slot yields its
 * cheaper SAME-PROVIDER siblings (cheapest-first, current excluded, capped).
 * Cross-provider is out of scope here — a right-size stays on the provider so
 * credentials/cache continuity hold; cross-provider replacement is model-scan's
 * job. Slots whose model isn't table-backed contribute nothing.
 */
export function enumerateSlotCandidates(
  slots: ReadonlyArray<ModelSlot>,
  opts: EnumerateSlotCandidatesOptions = {},
): SlotCandidate[] {
  const perSlotLimit = opts.perSlotLimit ?? 3;
  const out: SlotCandidate[] = [];
  const seen = new Set<string>();
  for (const slot of slots) {
    const parsed = providerOfSpecString(slot.currentModel);
    if (parsed === undefined) continue;
    const siblings = enumerateCandidates(parsed, {
      ...(opts.pricing !== undefined ? { pricing: opts.pricing } : {}),
      sameProviderOnly: true,
      excludeCurrent: true,
    });
    // Only DOWNSHIFTS: cheaper than the current model.
    const currentPrice = blendedOf(parsed, opts.pricing);
    let taken = 0;
    for (const sib of siblings) {
      if (currentPrice !== undefined && sib.blendedPer1M >= currentPrice) continue;
      const key = `${slot.label}→${sib.modelString}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ slot, candidateModel: sib.modelString });
      if (++taken >= perSlotLimit) break;
    }
  }
  return out;
}

function blendedOf(
  parsed: { readonly provider: CandidateProvider; readonly modelId: string },
  pricing?: PricingTable,
): number | undefined {
  const row = resolvePricing(pricing ?? DEFAULT_PRICING, parsed.provider, parsed.modelId);
  if (row === undefined) return undefined;
  return (row.inputPer1M * 3 + row.outputPer1M) / 4;
}

/**
 * Project a candidate run's USD from its token aggregates, for its model.
 * Returns `undefined` on a pricing miss (an unpriced model can't be compared
 * on cost, so it's never recommended). USD, not micros, for legible reports.
 */
export function projectCostUsd(
  model: string,
  tokens: { readonly input: number; readonly output: number },
  pricing?: PricingTable,
): number | undefined {
  const parsed = providerOfSpecString(model);
  if (parsed === undefined) return undefined;
  const row = resolvePricing(pricing ?? DEFAULT_PRICING, parsed.provider, parsed.modelId);
  if (row === undefined) return undefined;
  return computeCostMicros(row, tokens.input, tokens.output, 0) / 1_000_000;
}

/** The eval outcome of one slot candidate (from the injected runner). */
export type SlotEvalOutcome = {
  readonly candidate: SlotCandidate;
  readonly passRate: number;
  readonly tokens: { readonly input: number; readonly output: number };
  readonly error?: string;
};

/** The baseline (unchanged spec) eval outcome. */
export type BaselineEvalOutcome = {
  readonly passRate: number;
  readonly tokens: { readonly input: number; readonly output: number };
  /** The primary agent model (for cost projection of the baseline). */
  readonly model: string;
};

export type RightSizeReport = {
  readonly baseline: { readonly passRate: number; readonly costUsd: number };
  readonly ranked: ReadonlyArray<RankedRightSize>;
  readonly best?: RankedRightSize & { readonly slotPath?: ReadonlyArray<string> };
};

/**
 * Fold baseline + per-candidate eval outcomes into a ranked right-size report.
 * Baseline cost is projected from ITS tokens on ITS model; each candidate's
 * cost from its tokens on its swapped model. Ranking + the recommend gate
 * (holds pass rate AND cost drop >= minCostDropRatio) come from cost-tracker's
 * `rankRightSizeProposals`.
 */
export function buildRightSizeReport(
  baseline: BaselineEvalOutcome,
  outcomes: ReadonlyArray<SlotEvalOutcome>,
  opts: {
    readonly minCostDropRatio: number;
    readonly passRateTolerance?: number;
    readonly pricing?: PricingTable;
  },
): RightSizeReport {
  const baselineCostUsd = projectCostUsd(baseline.model, baseline.tokens, opts.pricing) ?? 0;
  const proposals: RightSizeProposal[] = [];
  const pathByKey = new Map<string, ReadonlyArray<string> | undefined>();
  for (const o of outcomes) {
    if (o.error !== undefined) continue; // a crashed cell can't be compared
    const costUsd = projectCostUsd(o.candidate.candidateModel, o.tokens, opts.pricing);
    if (costUsd === undefined) continue; // pricing miss → not comparable
    const key = `${o.candidate.slot.label}→${o.candidate.candidateModel}`;
    pathByKey.set(key, o.candidate.slot.path);
    proposals.push({
      modelString: o.candidate.candidateModel,
      slot: o.candidate.slot.label,
      passRate: o.passRate,
      costUsd,
    });
  }
  const ranked = rankRightSizeProposals(
    { passRate: baseline.passRate, costUsd: baselineCostUsd },
    proposals,
    {
      minCostDropRatio: opts.minCostDropRatio,
      ...(opts.passRateTolerance !== undefined
        ? { passRateTolerance: opts.passRateTolerance }
        : {}),
    },
  );
  const topRecommended = ranked.find((r) => r.recommended);
  const best =
    topRecommended !== undefined
      ? {
          ...topRecommended,
          slotPath: pathByKey.get(`${topRecommended.slot}→${topRecommended.modelString}`),
        }
      : undefined;
  return {
    baseline: { passRate: baseline.passRate, costUsd: baselineCostUsd },
    ranked,
    ...(best !== undefined ? { best } : {}),
  };
}
