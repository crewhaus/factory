/**
 * The `provability` skill text a gated run's Task children receive
 * (design/0.8.0-provability-release.md §8, §11).
 *
 * A child is never gated — only the parent's final text is — but it is the
 * one fetching sources for the parent to cite, so it is told how the parent's
 * gate reads a citation. runtime-core projects `RunProvability.skill` (with
 * the floor) onto the bridge as the read-only provability seam, and the
 * spawner puts it in the child's instructions after its own framing
 * (`@crewhaus/sub-agent-spawner`'s `childProvabilityGuidance`).
 *
 * The text is the skill the parent itself advertises — `./skills`'
 * `provabilitySkills`, the ONE renderer of `@crewhaus/default-skills`'
 * `provability` skill (the floor, the checkers, the gate's settings; the
 * `learning-loop` precedent) — so a parent and its children never read two
 * renderings of one block. It is written to the gated model, so the spawner
 * shows a child only the parts true for it: the sections after the skill's
 * opening (what happens to a failing answer is the parent's alone), and a
 * list item naming a provability tool only when the child's own tool set has
 * it. The layout that rests on — the opening before the first `## ` section,
 * each tool named in a list item — is pinned by this module's test.
 *
 * Undefined — and the children get the spawner's framing alone — when this
 * build ships no such skill, or when its body asks for a substitution the
 * block cannot fill (warned by the renderer: a wiring gap, not a reason to
 * fail a run).
 */
import type { IrProvability } from "@crewhaus/ir";
import { type ProvabilitySkillSource, provabilitySkills } from "./skills";

/** Where the skill comes from (default: the shipped default skills); a seam for tests. */
export type ChildSkillSource = ProvabilitySkillSource;

/** The rendered `provability` skill for `config`, or undefined (see the module doc). */
export function provabilitySkillText(
  config: IrProvability,
  source?: ChildSkillSource,
): string | undefined {
  const text = provabilitySkills(config, source)[0]?.body.trim() ?? "";
  return text === "" ? undefined : text;
}
