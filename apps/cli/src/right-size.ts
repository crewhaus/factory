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
import type { IrNode } from "@crewhaus/ir";

/** A swappable model slot in the spec, addressed by its patch path. */
export type ModelSlot = {
  /** The `enumerateModelSlots` label (`agent.model`, `compaction.model`,
   *  `sub_agents.<name>.model`) — the SAME string the walk emits, because
   *  {@link patchIrModelSlot} dispatches on it. */
  readonly label: string;
  /** The spec model string currently in the slot. */
  readonly currentModel: string;
  /** The patch path (for the eventual CST edit); undefined for a slot the
   *  patch grammar cannot address (a sub-agent model, say), whose winning
   *  swap is reported and applied by hand. */
  readonly path?: ReadonlyArray<string>;
};

/**
 * The lowered `target: cli` IR — the only shape `model right-size` searches
 * (its runner compiles and evals a cli harness).
 */
export type CliIr = Extract<IrNode, { target: "cli" }>;

/**
 * The slot kinds a right-size search may swap, and the reason the rest are
 * out: the loop's objective is the AGENT's pass rate on a dataset, so it can
 * only rank slots that objective actually measures.
 *
 *   - `primary` / `compaction` / `sub-agent` — every one of them serves the
 *     turns the dataset scores, so a cheaper model there shows up as a
 *     pass-rate change.
 *   - `judge` — the instrument. Nothing in the run measures the judge, so a
 *     cheaper judge always reads as a free win (§9.3 / §10.3 keep judge
 *     identity human-owned; `["evaluation","grader","model"]` is in
 *     `HUMAN_OWNED_PATHS` as "judge identity").
 *   - `candidate` / `tier` / `fallback` / `classifier` / `strategy` — roster
 *     membership, human-owned (§9.3).
 *   - `aux` — the crew router's model, a degrade target, the grounding model:
 *     roster decisions, or slots this dataset does not exercise.
 */
const RIGHT_SIZE_KINDS: ReadonlySet<string> = new Set(["primary", "compaction", "sub-agent"]);

/** One enumerated slot as {@link rightSizeSlots} reads it (the walk's shape). */
type WalkedSlot = {
  readonly label: string;
  readonly model: string;
  readonly kind: string;
  readonly path?: ReadonlyArray<string>;
  readonly swappable: boolean;
};

/**
 * The right-size view of `enumerateModelSlots`: the serving slots, in walk
 * order. A slot must be BOTH a serving kind and `swappable` — the two
 * conditions are independent (a `sub-agent` slot is not `swappable` because
 * the patch grammar cannot address it, and a judge slot is not a serving
 * kind), and requiring both is what keeps a future walk change from quietly
 * widening the search.
 */
export function rightSizeSlots(walked: ReadonlyArray<WalkedSlot>): ModelSlot[] {
  return walked
    .filter((sl) => RIGHT_SIZE_KINDS.has(sl.kind) && (sl.swappable || sl.kind === "sub-agent"))
    .map((sl) => ({
      label: sl.label,
      currentModel: sl.model,
      ...(sl.path !== undefined && sl.swappable ? { path: sl.path } : {}),
    }));
}

/** The `sub_agents.<name>.model` label `enumerateModelSlots` emits. */
const SUB_AGENT_LABEL_RE = /^sub_agents\.(.+)\.model$/;

/**
 * Apply a single-slot model swap to a lowered cli IR, in memory — the
 * candidate `model right-size` actually evals.
 *
 * It dispatches on the slot's PATCH PATH (and, for the sub-agents the patch
 * grammar cannot address, on the walk's own label), never on a hand-copied
 * label spelling: a patcher that silently fails to patch is the worst failure
 * this loop can have. The candidate would run the BASELINE spec while the
 * report priced its tokens at the candidate's rate, so an unmeasured downshift
 * would score "identical pass rate, large cost drop" and be recommended —
 * and `--write` would apply it. Hence the throw: a slot this cannot address
 * must never be evaled and ranked.
 */
export function patchIrModelSlot(ir: CliIr, slot: ModelSlot, model: string): CliIr {
  const key = slot.path?.join(".");
  if (key === "agent.model") return { ...ir, agent: { ...ir.agent, model } };
  if (key === "compaction.model") return { ...ir, compaction: { ...ir.compaction, model } };
  const sub = SUB_AGENT_LABEL_RE.exec(slot.label);
  if (sub !== null) {
    const name = sub[1];
    let patched = false;
    const subAgents = ir.subAgents.map((sa) => {
      if (sa.name !== name) return sa;
      patched = true;
      return { ...sa, model };
    });
    if (patched) return { ...ir, subAgents };
  }
  throw new Error(
    `model right-size: cannot patch slot "${slot.label}"${
      key === undefined ? "" : ` (${key})`
    } in memory — refusing to eval a candidate that would run the unchanged baseline and be ranked as a free downshift. This is a bug: the slot walk and the patcher have drifted apart.`,
  );
}

/** One candidate: the spec with `slot` swapped to `candidateModel`. */
export type SlotCandidate = {
  readonly slot: ModelSlot;
  readonly candidateModel: string;
};

export type EnumerateSlotCandidatesOptions = {
  readonly pricing?: PricingTable;
  /** Cap the candidates per slot (cheapest-first). Default 3. */
  readonly perSlotLimit?: number;
  /**
   * 0.6.0 §9.1 (loop 4) — FIX the candidate set to these models instead of
   * searching for cheaper siblings (`model right-size --candidates`). This is
   * what makes the loop usable as the sunset GATE: a replacement model is
   * normally MORE expensive than the model it retires (`claude-3-5-haiku`
   * $0.8/$4 → `claude-haiku-4-5` $1/$5), so the downshift filter can never
   * enumerate it and the sunset proposal would ship unmeasured. With this set
   * the price filter is off — the eval still measures pass rate, and the
   * recommend gate still applies (open it with `--min-cost-drop`).
   */
  readonly fixedCandidates?: ReadonlyArray<string>;
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
  // A FIXED candidate set skips the pricing walk entirely: the caller has
  // already decided what to measure (the sunset gate's replacement).
  if (opts.fixedCandidates !== undefined && opts.fixedCandidates.length > 0) {
    for (const slot of slots) {
      for (const candidateModel of opts.fixedCandidates) {
        if (candidateModel === slot.currentModel) continue;
        const key = `${slot.label}→${candidateModel}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ slot, candidateModel });
      }
    }
    return out;
  }
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
