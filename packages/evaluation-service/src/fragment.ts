/**
 * The serializable input of the gate composition root (design/0.8.0-
 * provability-release.md §4.4): the lowered `evaluation:` and `provability:`
 * blocks plus the two facts about the spec they need — its name (where proof
 * bundles and artifacts are filed) and its primary model (the judge default).
 *
 * The fragment is DATA: an emitter serializes it with `JSON.stringify` into
 * one `wireEvaluation(<fragment>, …)` boot line, and the interpreter builds
 * the same object from the same IR, so a compiled bundle and `crewhaus run`
 * hand the composition root the identical input (the `memoryFragmentFromIr` /
 * `modelWiringFragmentFromIr` precedent).
 */
import type { IrEvaluation, IrProvability } from "@crewhaus/ir";

export type EvaluationFragment = {
  /** The spec's `name:` — proof bundles and artifacts live under `.crewhaus/proofs/<specName>/`. */
  readonly specName: string;
  /** The shape's primary model: the `llm_judge` default when `grader.model` is absent. */
  readonly primaryModel: string;
  /** The lowered `evaluation:` block, when the spec declares one. */
  readonly evaluation?: IrEvaluation;
  /** The lowered `provability:` block, when the spec declares one at a rung above `off`. */
  readonly provability?: IrProvability;
};

/** The IR slice the fragment reads — structural, so cli / channel / managed IR all satisfy it. */
export type EvaluationIrSlice = {
  readonly name: string;
  readonly agent: { readonly model: string };
  readonly evaluation?: IrEvaluation;
  readonly provability?: IrProvability;
};

/**
 * The fragment for `ir`, or `undefined` when the IR carries NEITHER gate —
 * the signal every emitter reads to render nothing at all, so a spec without
 * both blocks compiles to the bytes it compiled to before this package
 * existed (design §1 principle 3). Keys are added in a fixed order and only
 * when present, so the serialized fragment is deterministic.
 */
export function evaluationFragmentFromIr(ir: EvaluationIrSlice): EvaluationFragment | undefined {
  if (ir.evaluation === undefined && ir.provability === undefined) return undefined;
  return {
    specName: ir.name,
    primaryModel: ir.agent.model,
    ...(ir.evaluation !== undefined ? { evaluation: ir.evaluation } : {}),
    ...(ir.provability !== undefined ? { provability: ir.provability } : {}),
  };
}
