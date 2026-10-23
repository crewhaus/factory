/**
 * `provabilitySkillText` — the skill text a gated run's Task children receive
 * (design §8): the shipped `provability` skill, rendered by the one renderer
 * the parent's own skill comes from (`provabilitySkills`), or nothing (the
 * spawner's own framing then stands alone). And the wired gate carries it as
 * `RunProvability.skill`, the field runtime-core projects onto the read-only
 * child seam. And the shipped skill keeps the layout the spawner reads to
 * show a child only what is true for it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_SKILL_NAMES } from "@crewhaus/default-skills";
import type { IrProvability } from "@crewhaus/ir";
import { config, tempDirs } from "./__fixtures__/helpers";
import { type ChildSkillSource, provabilitySkillText } from "./child-skill";
import { provabilitySkills } from "./skills";
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
    skills:
      body === undefined
        ? []
        : [
            {
              name: "provability",
              description: "test",
              filePath: "/builtin/provability/SKILL.md",
              body,
            },
          ],
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

  test("is the parent's own skill, from the one renderer (./skills)", () => {
    for (const level of ["cited", "grounded", "checked", "proven"] as const) {
      const s = source("Cite at {{level}} and {{on_fail}}.");
      expect(provabilitySkillText(config(level), s)).toBe(
        provabilitySkills(config(level), s)[0]?.body.trim() as string,
      );
    }
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

describe("the shipped skill's layout, as the spawner reads it for a child (design §8)", () => {
  // `@crewhaus/sub-agent-spawner`'s `childProvabilityGuidance` shows a child
  // the skill from its first `## ` section on, and drops a list item naming
  // a provability tool the child lacks. Both rest on this layout.
  const TOOLS = /`(?:ProvabilityPreflight|ProofCheckers|ProofCheck)`/;
  const cases: ReadonlyArray<Partial<IrProvability>> = [
    { onFail: "retry", maxRetries: 1 },
    { onFail: "escalate", maxRetries: 2 },
    { onFail: "halt" },
    { onFail: "note" },
  ];

  test("what happens to a failing answer is said before the first section, and only there", () => {
    if (!(DEFAULT_SKILL_NAMES as readonly string[]).includes("provability")) return;
    for (const level of ["cited", "grounded", "checked", "proven"] as const) {
      for (const patch of cases) {
        const text = provabilitySkillText(config(level, patch)) as string;
        const at = text.search(/^## /m);
        expect(at).toBeGreaterThan(0);
        expect(text.slice(0, at)).toContain("falls short");
        const sections = text.slice(at);
        for (const parentOnly of ["falls short", "comes back to you", "is served", "run stops"]) {
          expect({ level, patch, parentOnly, found: sections.includes(parentOnly) }).toEqual({
            level,
            patch,
            parentOnly,
            found: false,
          });
        }
      }
    }
  });

  test("every provability tool is named inside a list item", () => {
    if (!(DEFAULT_SKILL_NAMES as readonly string[]).includes("provability")) return;
    for (const level of ["cited", "proven"] as const) {
      const lines = (provabilitySkillText(config(level)) as string).split("\n");
      let inItem = false;
      for (const line of lines) {
        if (/^\s*[-*+]\s/.test(line)) inItem = true;
        else if (line.trim() === "" || !/^\s/.test(line)) inItem = false;
        if (TOOLS.test(line)) expect({ line, inItem }).toEqual({ line, inItem: true });
      }
    }
  });
});
