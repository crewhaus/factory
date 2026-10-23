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
 * The text is `@crewhaus/default-skills`' `provability` skill, rendered once
 * at wiring time from the lowered block with the compile-time substitutions
 * its body asks for — the parent's own (`./skills`'
 * `provabilitySkillSubstitutions`: the floor, the checkers, the gate's
 * settings; the `learning-loop` precedent). Undefined — and the children get the spawner's framing alone —
 * when this build ships no such skill, or when its body asks for a
 * substitution this cannot fill (warned: a wiring gap, not a reason to fail a
 * run).
 */
import { DEFAULT_SKILLS, renderSkill } from "@crewhaus/default-skills";
import type { IrProvability } from "@crewhaus/ir";
import { createLogger } from "@crewhaus/logging";
import { substitutionsFor } from "./skills";

const logger = createLogger({ bindings: { module: "evaluation-service" } });

const SKILL_NAME = "provability";

/** Where the skill comes from (default: the shipped default skills); a seam for tests. */
export type ChildSkillSource = {
  readonly skills: ReadonlyArray<{ readonly name: string; readonly body: string }>;
  readonly render: (name: string, substitutions: Record<string, string>) => string;
};

const DEFAULT_SOURCE: ChildSkillSource = { skills: DEFAULT_SKILLS, render: renderSkill };

/** The rendered `provability` skill for `config`, or undefined (see the module doc). */
export function provabilitySkillText(
  config: IrProvability,
  source: ChildSkillSource = DEFAULT_SOURCE,
): string | undefined {
  const skill = source.skills.find((s) => s.name === SKILL_NAME);
  if (skill === undefined) return undefined;
  try {
    // Only the names the body uses: the renderer refuses a key the body lacks.
    // Computed inside the try: a block missing a field (a bundle compiled
    // against another shape) costs the skill, never the boot.
    const substitutions = substitutionsFor(config, skill.body);
    const text = source.render(SKILL_NAME, substitutions).trim();
    return text === "" ? undefined : text;
  } catch (err) {
    logger.warn("provability: the provability skill could not be rendered for sub-agents", {
      message: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
