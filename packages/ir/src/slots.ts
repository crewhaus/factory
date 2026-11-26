/**
 * `@crewhaus/ir/slots` — `enumerateModelSlots`: the ONE walk over every
 * model-bearing slot of a lowered IR, and over every remote recipient a
 * harness sends a turn to.
 *
 * Every surface that asks "which models does this harness call?" reads this
 * walk: `crewhaus models audit|explain|list`, `doctor --models`,
 * `model right-size`, `model-scan`'s `require` read, and the compile
 * service's credential list. A slot one surface sees and another does not is
 * how a retired model on a workflow step, or an unpriced strong arm in a
 * pool, came to be reported as "no findings".
 *
 * The walk mirrors `collectModels` in this package's README projection (the
 * same aux-block index-signature read, so a new shape that carries the
 * standard blocks is covered without a per-target case), but keeps each
 * slot's IDENTITY instead of collapsing to a model set: the label a human
 * reads, the spec patch path when the slot is spec-addressable, the resolved
 * `models:` profile name, the per-slot `requires` / params, and whether a
 * downshift search may swap it.
 *
 * Two kinds need care from a consumer:
 *   - `federation` names a remote peer (`sub_agents.<name>.federation.url`),
 *     not a model: its `model` is the peer's URL. A consumer that prices,
 *     resolves or keys a slot's model string skips it.
 *   - a consumer-defaulted model (the justification judge's, when
 *     `security.justification.judge: claude` names no model) is listed with
 *     the model the consumer runs, so the list is what the harness calls.
 *
 * Pure and IR-only: no `node:` import, no filesystem, no pricing table, no
 * clock.
 */
import type {
  IrModelPool,
  IrModelProfile,
  IrModelProfiles,
  IrModelRequires,
  IrNode,
  IrSubAgentDefinition,
  IrThinking,
} from "./index";

/**
 * The model the justification judge runs on when `security.justification`
 * selects `judge: claude` and names no `model`: the consumer's default
 * (`DEFAULT_JUSTIFICATION_JUDGE_MODEL` in `@crewhaus/justification-judge-claude`,
 * which this package cannot import). A test pins the two together.
 */
export const JUSTIFICATION_JUDGE_DEFAULT_MODEL = "claude-haiku-4-5";

/** What kind of slot this is — the audit's grouping and the right-size gate. */
export type ModelSlotKind =
  | "primary"
  | "candidate"
  | "tier"
  | "fallback"
  | "judge"
  | "compaction"
  | "sub-agent"
  | "classifier"
  | "strategy"
  | "aux"
  /** A remote peer a sub-agent's turns go to: `model` is its URL, not a model. */
  | "federation";

/** One model-bearing slot of a lowered spec. */
export type EnumeratedModelSlot = {
  /** Human label — `agent.model`, `steps[2].model`, `model_pool.candidates[1]`. */
  readonly label: string;
  /**
   * The resolved model string sitting in the slot; for a `federation` slot,
   * the peer's URL.
   */
  readonly model: string;
  readonly kind: ModelSlotKind;
  /** The spec patch path, when the slot is addressable as a spec field. */
  readonly path?: ReadonlyArray<string>;
  /** The `models:` profile the slot resolved from (provenance only). */
  readonly profile?: string;
  /** Capability floor the slot declares (`requires:` on its profile). */
  readonly requires?: IrModelRequires;
  readonly thinking?: IrThinking;
  readonly temperature?: number;
  readonly maxTokens?: number;
  /**
   * Whether a right-size / sunset downshift may rewrite this slot. Roster
   * membership (`model_pool.candidates`, tiers, fallback chains) is
   * human-owned (§9.3), so those enumerate but never swap.
   *
   * JUDGE IDENTITY is not swappable either, for a different reason: a
   * downshift search's objective is the AGENT's pass rate on a dataset, and
   * nothing in it measures the judge. `evaluation.grader.model`,
   * `security.justification.model` (the Pillar-3 intent gate's judge),
   * `watchme.judge.model` and `provability.judge.model` (the gate's
   * paraphrase-waiver judge) would therefore always read as a free win when made
   * cheaper — the search would recommend weakening the instrument it is being
   * measured with. `["evaluation","grader","model"]` is in the repo's own
   * `HUMAN_OWNED_PATHS` as "judge identity" and §10.3 excludes the judge panel
   * and the crew router's model; every one of those slots ENUMERATES (so
   * `models audit` still checks its pricing, capabilities and parameters, and
   * `models propose` can still name it in a sunset PR) but never enters a
   * cost-minimising search. A judge downshift, if it is ever wanted, needs its
   * own verb with a judge-AGREEMENT objective.
   */
  readonly swappable: boolean;
};

type RoutedBlock = {
  readonly model: string;
  readonly modelProfile?: string;
  readonly modelPool?: IrModelPool;
  readonly modelTiers?: { readonly fast: string; readonly default: string };
  readonly modelFallbacks?: ReadonlyArray<string>;
  readonly thinking?: IrThinking;
  readonly temperature?: number;
  readonly maxTokens?: number;
};

function profileFields(
  profile: IrModelProfile | undefined,
): Pick<EnumeratedModelSlot, "requires" | "thinking" | "temperature" | "maxTokens"> {
  if (profile === undefined) return {};
  return {
    ...(profile.requires !== undefined ? { requires: profile.requires } : {}),
    ...(profile.thinking !== undefined ? { thinking: profile.thinking } : {}),
    ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
    ...(profile.maxTokens !== undefined ? { maxTokens: profile.maxTokens } : {}),
  };
}

/**
 * Walk one lowered IR and return every model-bearing slot, in a stable
 * declaration order (primary first, then its pool/tier/fallback roster, then
 * per-step/node/role blocks, then the aux blocks).
 */
export function enumerateModelSlots(ir: IrNode): EnumeratedModelSlot[] {
  const out: EnumeratedModelSlot[] = [];
  const registry = (ir as { readonly models?: IrModelProfiles }).models ?? {};
  const profileOf = (name: string | undefined): IrModelProfile | undefined =>
    name === undefined ? undefined : registry[name];

  const push = (slot: EnumeratedModelSlot): void => {
    if (slot.model.length > 0) out.push(slot);
  };

  /** A routed block: the primary plus every roster member it declares. */
  const addRouted = (
    block: RoutedBlock,
    label: string,
    path: ReadonlyArray<string> | undefined,
    kind: ModelSlotKind,
    swappable: boolean,
  ): void => {
    const profile = profileOf(block.modelProfile);
    push({
      label,
      model: block.model,
      kind,
      ...(path !== undefined ? { path } : {}),
      ...(block.modelProfile !== undefined ? { profile: block.modelProfile } : {}),
      ...profileFields(profile),
      // A slot-local param beats the profile default (§4.1 precedence).
      ...(block.thinking !== undefined ? { thinking: block.thinking } : {}),
      ...(block.temperature !== undefined ? { temperature: block.temperature } : {}),
      ...(block.maxTokens !== undefined ? { maxTokens: block.maxTokens } : {}),
      swappable,
    });
    const pool = block.modelPool;
    if (pool !== undefined) {
      pool.candidates.forEach((c, i) => {
        push({
          label: `${label.replace(/\.model$/, "")}.model_pool.candidates[${i}]`,
          model: c.model,
          kind: "candidate",
          ...(c.profile !== undefined ? { profile: c.profile } : {}),
          ...profileFields(c),
          swappable: false,
        });
        (c.fallbacks ?? []).forEach((f, j) => {
          push({
            label: `${label.replace(/\.model$/, "")}.model_pool.candidates[${i}].fallbacks[${j}]`,
            model: f,
            kind: "fallback",
            swappable: false,
          });
        });
      });
      if (pool.classifier !== undefined) {
        push({
          label: `${label.replace(/\.model$/, "")}.model_pool.classifier.model`,
          model: pool.classifier.model,
          kind: "classifier",
          swappable: false,
        });
      }
      const base = label.replace(/\.model$/, "");
      const guide = pool.strategy?.guide;
      if (guide !== undefined) {
        push({
          label: `${base}.model_pool.strategy.guide.model`,
          model: guide.model,
          kind: "strategy",
          ...(guide.modelProfile !== undefined ? { profile: guide.modelProfile } : {}),
          swappable: false,
        });
      }
      // The shadow arm: a model that runs beside the served one on a sampled
      // turn. Roster membership, so it enumerates and never swaps.
      const shadow = pool.strategy?.shadow;
      if (shadow !== undefined) {
        push({
          label: `${base}.model_pool.strategy.shadow.candidate`,
          model: shadow.candidate,
          kind: "candidate",
          ...(shadow.candidateProfile !== undefined ? { profile: shadow.candidateProfile } : {}),
          ...profileFields(profileOf(shadow.candidateProfile)),
          swappable: false,
        });
      }
      const shadowGrader = pool.strategy?.shadow?.gradeWith;
      if (shadowGrader !== undefined) {
        push({
          label: `${base}.model_pool.strategy.shadow.grade_with`,
          model: shadowGrader,
          kind: "judge",
          swappable: false,
        });
      }
      const committeeJudge = pool.strategy?.committee?.judge;
      if (committeeJudge !== undefined) {
        push({
          label: `${base}.model_pool.strategy.committee.judge`,
          model: committeeJudge,
          kind: "judge",
          swappable: false,
        });
      }
    }
    if (block.modelTiers !== undefined) {
      const base = label.replace(/\.model$/, "");
      push({
        label: `${base}.model_tiers.fast`,
        model: block.modelTiers.fast,
        kind: "tier",
        swappable: false,
      });
      push({
        label: `${base}.model_tiers.default`,
        model: block.modelTiers.default,
        kind: "tier",
        swappable: false,
      });
    }
    (block.modelFallbacks ?? []).forEach((f, i) => {
      push({
        label: `${label.replace(/\.model$/, "")}.model_fallbacks[${i}]`,
        model: f,
        kind: "fallback",
        swappable: false,
      });
    });
  };

  /**
   * A sub-agent: its own routed block (its model, when it declares one, and
   * every roster member it routes over), each profile
   * a Task call may pin (`allowed_profiles`, resolved at lower time) with its
   * failover chain, and the remote peer its turns go to under `federation`.
   */
  const addSubAgent = (sa: IrSubAgentDefinition, prefix: string): void => {
    const base = `${prefix}sub_agents.${sa.name}`;
    // A sub-agent with no model of its own still serves its roster (a pool,
    // tiers, a failover chain): the empty primary is dropped, its roster is not.
    addRouted({ ...sa, model: sa.model ?? "" }, `${base}.model`, undefined, "sub-agent", false);
    (sa.allowedProfiles ?? []).forEach((option, i) => {
      push({
        label: `${base}.allowed_profiles[${i}]`,
        model: option.model,
        // An option the Task call may pick, like a pool candidate: the roster
        // is human-owned, so it enumerates and never swaps.
        kind: "candidate",
        profile: option.profile,
        ...profileFields(profileOf(option.profile)),
        ...(option.thinking !== undefined ? { thinking: option.thinking } : {}),
        ...(option.temperature !== undefined ? { temperature: option.temperature } : {}),
        ...(option.maxTokens !== undefined ? { maxTokens: option.maxTokens } : {}),
        swappable: false,
      });
      (option.modelFallbacks ?? []).forEach((f, j) => {
        push({
          label: `${base}.allowed_profiles[${i}].model_fallbacks[${j}]`,
          model: f,
          kind: "fallback",
          swappable: false,
        });
      });
    });
    if (sa.federation !== undefined) {
      push({
        label: `${base}.federation.url`,
        model: sa.federation.url,
        kind: "federation",
        swappable: false,
      });
    }
  };

  switch (ir.target) {
    case "workflow":
      ir.steps.forEach((s, i) => {
        addRouted(s, `steps[${i}].model`, ["steps", String(i), "model"], "primary", true);
        for (const [j, j2] of (s.judge?.judges ?? []).entries()) {
          push({
            label: `steps[${i}].judge.judges[${j}]`,
            model: j2,
            kind: "judge",
            swappable: false,
          });
        }
      });
      break;
    case "graph":
      ir.nodes.forEach((n, i) => {
        addRouted(n, `nodes[${i}].model`, ["nodes", String(i), "model"], "primary", true);
        for (const [j, j2] of (n.judge?.judges ?? []).entries()) {
          push({
            label: `nodes[${i}].judge.judges[${j}]`,
            model: j2,
            kind: "judge",
            swappable: false,
          });
        }
      });
      break;
    case "crew":
      ir.roles.forEach((r, i) => {
        addRouted(r, `roles[${i}].model`, ["roles", String(i), "model"], "primary", true);
        for (const sa of r.subAgents) addSubAgent(sa, `roles[${i}].`);
      });
      if (ir.routing?.model !== undefined) {
        // §10.3 excludes `crew.routing.model`: which model dispatches work to
        // roles is a roster decision (`HUMAN_OWNED_PATHS`: "the crew llm
        // router's model is a roster decision"), so it enumerates but never
        // enters a downshift search.
        push({
          label: "routing.model",
          model: ir.routing.model,
          kind: "aux",
          path: ["routing", "model"],
          swappable: false,
        });
      }
      break;
    default:
      addRouted(ir.agent, "agent.model", ["agent", "model"], "primary", true);
      break;
  }

  // The aux blocks every shape may carry, read through an index signature
  // (the `collectModels` convention) so a shape that grows one is covered.
  const aux = ir as {
    readonly subAgents?: ReadonlyArray<IrSubAgentDefinition>;
    readonly compaction?: { readonly model?: string; readonly modelProfile?: string };
    readonly evaluation?: {
      readonly grader: {
        readonly model?: string;
        readonly modelProfile?: string;
        readonly judges?: ReadonlyArray<string>;
      };
    };
    readonly budget?: { readonly onExceed: { readonly model?: string } };
    readonly security?: {
      readonly justification?: { readonly judge?: string; readonly model?: string };
    };
    readonly watchme?: { readonly judgeModel?: string };
    /** 0.8.0 — `IrProvability.judge`: the opt-in paraphrase-waiver judge. */
    readonly provability?: {
      readonly judge?: { readonly model: string; readonly modelProfile?: string };
    };
    readonly groundingModel?: string;
  };

  for (const sa of aux.subAgents ?? []) addSubAgent(sa, "");
  if (aux.compaction?.model !== undefined) {
    push({
      label: "compaction.model",
      model: aux.compaction.model,
      kind: "compaction",
      path: ["compaction", "model"],
      ...(aux.compaction.modelProfile !== undefined
        ? { profile: aux.compaction.modelProfile }
        : {}),
      ...profileFields(profileOf(aux.compaction.modelProfile)),
      swappable: true,
    });
  }
  if (aux.evaluation?.grader.model !== undefined) {
    push({
      label: "evaluation.grader.model",
      model: aux.evaluation.grader.model,
      kind: "judge",
      path: ["evaluation", "grader", "model"],
      ...(aux.evaluation.grader.modelProfile !== undefined
        ? { profile: aux.evaluation.grader.modelProfile }
        : {}),
      ...profileFields(profileOf(aux.evaluation.grader.modelProfile)),
      // Judge identity — enumerated, never swapped (see `swappable`).
      swappable: false,
    });
  }
  (aux.evaluation?.grader.judges ?? []).forEach((j, i) => {
    push({ label: `evaluation.grader.judges[${i}]`, model: j, kind: "judge", swappable: false });
  });
  if (aux.budget?.onExceed.model !== undefined) {
    push({
      label: "budget.on_exceed.degrade.model",
      model: aux.budget.onExceed.model,
      kind: "aux",
      swappable: false,
    });
  }
  const justification = aux.security?.justification;
  // The intent gate's judge — enumerated, never swapped (see `swappable`). A
  // model-backed judge with no model runs on the consumer's default, so the
  // slot lists that model: it is one the harness calls.
  const justificationModel =
    justification?.model ??
    (justification?.judge === "claude" ? JUSTIFICATION_JUDGE_DEFAULT_MODEL : undefined);
  if (justificationModel !== undefined) {
    push({
      label: "security.justification.model",
      model: justificationModel,
      kind: "judge",
      path: ["security", "justification", "model"],
      swappable: false,
    });
  }
  if (aux.watchme?.judgeModel !== undefined) {
    push({
      label: "watchme.judge.model",
      model: aux.watchme.judgeModel,
      kind: "judge",
      swappable: false,
    });
  }
  // 0.8.0 (design §6.2) — the provability gate's paraphrase-waiver judge. It
  // can waive a grounded miss, never raise a rung, so it is an instrument the
  // gate is measured by: enumerated (pricing, capabilities, params), never
  // swapped — the judge-identity rule above, for the same reason.
  const provabilityJudge = aux.provability?.judge;
  if (provabilityJudge !== undefined) {
    push({
      label: "provability.judge.model",
      model: provabilityJudge.model,
      kind: "judge",
      path: ["provability", "judge", "model"],
      ...(provabilityJudge.modelProfile !== undefined
        ? { profile: provabilityJudge.modelProfile }
        : {}),
      ...profileFields(profileOf(provabilityJudge.modelProfile)),
      swappable: false,
    });
  }
  if (aux.groundingModel !== undefined) {
    push({
      label: "grounding_model",
      model: aux.groundingModel,
      kind: "aux",
      path: ["grounding_model"],
      swappable: true,
    });
  }
  return out;
}

/**
 * The `doctor --models` / `model-scan` view of the walk: the primary agent
 * model (when the shape has one) plus every OTHER model slot as an aux
 * entry, matching `buildModelChecks`'s `{slot, model}` contract. A
 * `federation` slot is left out: its value is a peer's URL.
 */
export function auxModelsFor(
  slots: ReadonlyArray<EnumeratedModelSlot>,
  primaryLabel = "agent.model",
): Array<{ readonly slot: string; readonly model: string }> {
  // A federation slot names a peer's URL, never a model to check.
  return slots
    .filter((s) => s.label !== primaryLabel && s.kind !== "federation")
    .map((s) => ({ slot: s.label, model: s.model }));
}

/** The primary slot of a walk (the block a `--write` downshift targets first). */
export function primarySlot(
  slots: ReadonlyArray<EnumeratedModelSlot>,
): EnumeratedModelSlot | undefined {
  return slots.find((s) => s.kind === "primary");
}
