/**
 * 0.6.0 §8.2 — `enumerateModelSlots`: the ONE spec-walking enumeration of
 * every model-bearing slot in a lowered IR.
 *
 * Before this, three surfaces each hand-rolled their own partial list and
 * each saw a different subset: `doctor --models` looked at `agent.model`,
 * `compaction.model` and sub-agents; `model right-size` looked at the same
 * three; `model-scan` looked at `agent.model` alone. A pool candidate, a
 * judge, a degrade target, a per-step or per-node model, the classifier or a
 * per-profile fallback chain were invisible to all of them — so a retired
 * model sitting on a workflow step, or an unpriced strong arm in a pool, was
 * reported as "no findings".
 *
 * The walk mirrors `collectModels` in `@crewhaus/ir`'s README projection
 * (the same aux-block index-signature read, so a new shape that carries the
 * standard blocks is covered without a per-target case), but keeps each
 * slot's IDENTITY instead of collapsing to a model set: the label a human
 * reads, the spec patch path when the slot is spec-addressable, the resolved
 * `models:` profile name, the per-slot `requires` / params, and whether a
 * downshift search may swap it.
 *
 * Consumers: `crewhaus models audit|explain|list` (§8.2), `doctor --models`
 * (§8.2 — a warn stays a warn there), `model right-size` (§9.1) and
 * `model-scan`'s `require` read (§9.1).
 *
 * Pure and IR-only: no filesystem, no pricing table, no clock.
 */
import type {
  IrModelPool,
  IrModelProfile,
  IrModelProfiles,
  IrModelRequires,
  IrNode,
  IrThinking,
} from "@crewhaus/ir";

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
  | "aux";

/** One model-bearing slot of a lowered spec. */
export type EnumeratedModelSlot = {
  /** Human label — `agent.model`, `steps[2].model`, `model_pool.candidates[1]`. */
  readonly label: string;
  /** The resolved model string sitting in the slot. */
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
        for (const sa of r.subAgents) {
          if (sa.model !== undefined) {
            addRouted(
              { ...sa, model: sa.model },
              `roles[${i}].sub_agents.${sa.name}.model`,
              undefined,
              "sub-agent",
              false,
            );
          }
        }
      });
      if (ir.routing?.model !== undefined) {
        push({
          label: "routing.model",
          model: ir.routing.model,
          kind: "aux",
          path: ["routing", "model"],
          swappable: true,
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
    readonly subAgents?: ReadonlyArray<
      RoutedBlock & { readonly name: string; readonly model?: string }
    >;
    readonly compaction?: { readonly model?: string; readonly modelProfile?: string };
    readonly evaluation?: {
      readonly grader: {
        readonly model?: string;
        readonly modelProfile?: string;
        readonly judges?: ReadonlyArray<string>;
      };
    };
    readonly budget?: { readonly onExceed: { readonly model?: string } };
    readonly security?: { readonly justification?: { readonly model?: string } };
    readonly watchme?: { readonly judgeModel?: string };
    readonly groundingModel?: string;
  };

  for (const sa of aux.subAgents ?? []) {
    if (sa.model !== undefined) {
      addRouted(
        { ...sa, model: sa.model },
        `sub_agents.${sa.name}.model`,
        undefined,
        "sub-agent",
        false,
      );
    }
  }
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
      swappable: true,
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
  if (aux.security?.justification?.model !== undefined) {
    push({
      label: "security.justification.model",
      model: aux.security.justification.model,
      kind: "judge",
      path: ["security", "justification", "model"],
      swappable: true,
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
 * model (when the shape has one) plus every OTHER slot as an aux entry,
 * matching `buildModelChecks`'s `{slot, model}` contract.
 */
export function auxModelsFor(
  slots: ReadonlyArray<EnumeratedModelSlot>,
  primaryLabel = "agent.model",
): Array<{ readonly slot: string; readonly model: string }> {
  return slots
    .filter((s) => s.label !== primaryLabel)
    .map((s) => ({ slot: s.label, model: s.model }));
}

/** The primary slot of a walk (the block a `--write` downshift targets first). */
export function primarySlot(
  slots: ReadonlyArray<EnumeratedModelSlot>,
): EnumeratedModelSlot | undefined {
  return slots.find((s) => s.kind === "primary");
}
