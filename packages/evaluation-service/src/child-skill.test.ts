/**
 * `provabilitySkillText` — the skill text a gated run's Task children receive
 * (design §8): the shipped `provability` skill rendered with the
 * substitutions its body asks for, or nothing (the spawner's own framing
 * then stands alone). And the wired gate carries it as `RunProvability.skill`,
 * the field runtime-core projects onto the read-only child seam.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_SKILL_NAMES } from "@crewhaus/default-skills";
import { config, tempDirs } from "./__fixtures__/helpers";
import { type ChildSkillSource, provabilitySkillText } from "./child-skill";
import { wireEvaluation } from "./wire";

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

/** A skill source whose renderer records what it was asked and substitutes like renderSkill. */
function source(
  body: string | undefined,
): ChildSkillSource & { readonly asked: Array<Record<string, string>> } {
  const asked: Array<Record<string, string>> = [];
  return {
    asked,
    skills: body === undefined ? [] : [{ name: "provability", body }],
    render: (_name, subs) => {
      asked.push(subs);
      let out = body ?? "";
      for (const [token, value] of Object.entries(subs))
        out = out.replaceAll(`{{${token}}}`, value);
      if (/\{\{[A-Za-z]\w*\}\}/.test(out)) throw new Error("unfilled token");
      return out;
    },
  };
}

describe("provabilitySkillText", () => {
  test("substitutes the floor and the checkers the block names", () => {
    const s = source("Floor: {{level}}. Checkers: {{checkers}}.");
    expect(
      provabilitySkillText(config("proven", { formal: { checkers: ["builtin", "smt"] } }), s),
    ).toBe("Floor: proven. Checkers: builtin, smt.");
  });

  test("asks only for the tokens the body uses (the renderer refuses an unused key)", () => {
    const s = source("Cite everything at {{level}}.");
    expect(provabilitySkillText(config("grounded"), s)).toBe("Cite everything at grounded.");
    expect(s.asked).toEqual([{ level: "grounded" }]);
  });

  test("no provability skill in the source: undefined", () => {
    expect(provabilitySkillText(config("cited"), source(undefined))).toBeUndefined();
  });

  test("a body asking for a substitution this cannot fill: undefined, not a throw", () => {
    expect(
      provabilitySkillText(config("cited"), source("{{level}} in {{domain}}")),
    ).toBeUndefined();
  });

  test("a body that renders to nothing: undefined", () => {
    expect(provabilitySkillText(config("cited"), source("   \n"))).toBeUndefined();
  });

  test("the shipped default skills: the provability skill's text when this build ships one, else nothing", () => {
    const text = provabilitySkillText(config("grounded"));
    if ((DEFAULT_SKILL_NAMES as readonly string[]).includes("provability")) {
      expect(typeof text).toBe("string");
      expect(text).not.toMatch(/\{\{level\}\}|\{\{checkers\}\}/);
    } else {
      expect(text).toBeUndefined();
    }
  });
});

describe("the wired gate carries the skill for the child seam", () => {
  test("RunProvability.skill is the rendered skill, or absent — never undefined-valued", async () => {
    const cfg = config("grounded");
    const gates = await wireEvaluation(
      { specName: "bot", primaryModel: "claude-sonnet-4-6", provability: cfg },
      { cwd: dirs.make() },
    );
    const expected = provabilitySkillText(cfg);
    if (expected === undefined) expect("skill" in (gates.provability ?? {})).toBe(false);
    else expect(gates.provability?.skill).toBe(expected);
  });
});
