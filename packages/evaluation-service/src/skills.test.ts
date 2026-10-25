/**
 * `provabilitySkills` / `renderGateSkills` — the `provability` skill a gated
 * harness advertises (design §11): rendered from the lowered block, present
 * with the block and absent without it, merged at lowest precedence through
 * the same discovery seam every builtin skill uses, and rendered into a bundle
 * as one expression that evaluates to the same skill. And the text is TRUE
 * for the block it was rendered from: every setting that changes what the
 * gate accepts reads back in the skill, and the skill teaches a proof tool
 * exactly where the gate wires it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SKILLS, renderSkill } from "@crewhaus/default-skills";
import type { IrProvability } from "@crewhaus/ir";
import { buildEvidenceIndex, verifyDocument } from "@crewhaus/provability";
import { type LoadedSkill, discoverSkills, loadSkillBody } from "@crewhaus/skills-registry";
import { config, tempDirs } from "./__fixtures__/helpers";
import { provabilitySkillText } from "./child-skill";
import {
  PROVABILITY_SKILL_NAME,
  type ProvabilitySkillSource,
  provabilitySkillSubstitutions,
  provabilitySkills,
  renderGateSkills,
} from "./skills";
import { gateTools } from "./tools";

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

/** A skill source with one `provability` skill whose body is `body`. */
function source(body: string): ProvabilitySkillSource & { readonly asked: string[][] } {
  const asked: string[][] = [];
  const skill: LoadedSkill = {
    name: PROVABILITY_SKILL_NAME,
    description: "test",
    filePath: "/builtin/provability/SKILL.md",
    body,
  };
  return {
    asked,
    skills: [skill],
    render: (_name, subs) => {
      asked.push(Object.keys(subs).sort());
      let out = body;
      for (const [token, value] of Object.entries(subs))
        out = out.replaceAll(`{{${token}}}`, value);
      if (/\{\{[A-Za-z]\w*\}\}/.test(out)) throw new Error("unfilled token");
      return out;
    },
  };
}

describe("provabilitySkills", () => {
  test("no block: no skill — a provability-less harness gains no prompt bytes", () => {
    expect(provabilitySkills(undefined)).toEqual([]);
  });

  test("with the block: the shipped skill, rendered with the floor and the checker order", () => {
    const [skill, ...rest] = provabilitySkills(
      config("proven", { formal: { checkers: ["lean4", "builtin"] } }),
    );
    expect(rest).toEqual([]);
    const shipped = DEFAULT_SKILLS.find((s) => s.name === "provability");
    expect(skill?.name).toBe("provability");
    // Frontmatter and identity are the shipped skill's; only the body is rendered.
    expect(skill?.description).toBe(shipped?.description as string);
    expect(skill?.filePath).toBe(shipped?.filePath as string);
    expect(skill?.body).toBe(
      renderSkill(
        "provability",
        provabilitySkillSubstitutions(
          config("proven", { formal: { checkers: ["lean4", "builtin"] } }),
        ),
      ),
    );
    expect(skill?.body).toContain("this\n  harness prefers lean4, builtin, in that order");
    expect(skill?.body).not.toMatch(/\{\{|\}\}/);
  });

  test("reads only the fields a bundle passes — that shape alone renders the same skill", () => {
    const full = provabilitySkills(config("checked"));
    const minimal = provabilitySkills({
      level: "checked",
      onFail: "retry",
      maxRetries: 1,
      scope: "session",
      assumptions: "allow",
      grounded: { independent: 1 },
      formal: { checkers: ["builtin", "smt"] },
    });
    expect(minimal).toEqual(full);
  });

  test("the same text the Task children receive (./child-skill)", () => {
    for (const level of ["cited", "grounded", "checked", "proven"] as const) {
      const cfg = config(level);
      expect(provabilitySkills(cfg)[0]?.body.trim()).toBe(provabilitySkillText(cfg) as string);
    }
  });

  test("asks the renderer only for the tokens the body uses", () => {
    const s = source("Cite at {{level}}.");
    expect(provabilitySkills(config("grounded"), s)[0]?.body).toBe("Cite at grounded.");
    expect(s.asked).toEqual([["level"]]);
  });

  test("a build without the skill registers none (and does not throw)", () => {
    expect(provabilitySkills(config("cited"), { skills: [], render: () => "x" })).toEqual([]);
  });

  test("a block missing a field the text needs registers none (and does not throw)", () => {
    const partial = { level: "cited", formal: { checkers: ["builtin"] } } as never;
    expect(provabilitySkills(partial)).toEqual([]);
    expect(provabilitySkillText(partial)).toBeUndefined();
  });

  test("a body asking for a substitution the block cannot fill registers none", () => {
    expect(provabilitySkills(config("cited"), source("{{level}} in {{domain}}"))).toEqual([]);
  });
});

/** The rendered skill for `cfg`, as prose (the file's line wrapping is not the contract). */
const prose = (cfg: IrProvability): string =>
  (provabilitySkills(cfg)[0]?.body ?? "").replace(/\s+/g, " ");

describe("the text says what THIS gate checks (design §11)", () => {
  test("the defaults: one retry, the session's evidence, assumptions counted", () => {
    const text = prose(config("grounded"));
    expect(text).toContain(
      "An answer that falls short comes back to you with what failed, at most once; after that it is served with a failing verdict.",
    );
    expect(text).toContain("a tool call you made in this session");
    expect(text).toContain("fetched or read in this session");
    expect(text).toContain(
      "an assumption: counted and shown to the reader, so keep it for what no evidence can settle",
    );
    expect(text).not.toContain("independent sources");
  });

  test("on_fail: what a failing answer becomes, for every mode", () => {
    const failing = (patch: Parameters<typeof config>[1]): string =>
      /An answer that falls short ([^.]*)\./.exec(prose(config("cited", patch)))?.[1] ?? "";
    expect(failing({ onFail: "retry", maxRetries: 3 })).toBe(
      "comes back to you with what failed, at most 3 times; after that it is served with a failing verdict",
    );
    // Zero retries is note semantics — runtime-core's reading of the cap.
    expect(failing({ onFail: "retry", maxRetries: 0 })).toBe(
      "is served anyway, with a failing verdict",
    );
    expect(failing({ onFail: "note" })).toBe("is served anyway, with a failing verdict");
    expect(failing({ onFail: "halt" })).toBe("is never served: the run stops");
    expect(failing({ onFail: "escalate" })).toBe(
      "goes, with what failed, to a stronger model to answer instead, at most once; after that it is served with a failing verdict",
    );
    expect(failing({ onFail: "escalate", maxRetries: 2 })).toBe(
      "goes, with what failed, to a stronger model to answer instead, at most 2 times; after that it is served with a failing verdict",
    );
  });

  test("on_fail: escalate with max_retries: 0 never escalates — the skill says note, as the gate does", () => {
    // runtime-core: a pass at retryIndex >= maxRetries is spent, so with a
    // cap of 0 the first failing answer stands. A non-finite cap reads as 0.
    const failing = (maxRetries: number): string =>
      /An answer that falls short ([^.]*)\./.exec(
        prose(config("cited", { onFail: "escalate", maxRetries })),
      )?.[1] ?? "";
    expect(failing(0)).toBe("is served anyway, with a failing verdict");
    expect(failing(Number.NaN)).toBe("is served anyway, with a failing verdict");
    expect(prose(config("cited", { onFail: "escalate", maxRetries: 0 }))).not.toContain(
      "stronger model",
    );
  });

  test("scope: turn — evidence from before the user's last message is not offered", () => {
    const text = prose(config("grounded", { scope: "turn" }));
    expect(text).toContain("a tool call you made since the user's last message");
    expect(text).toContain("fetched or read since the user's last message");
    expect(text).not.toContain("in this session");
  });

  test("assumptions: forbid (or a cap of 0) — the skill refuses them, as the gate does", async () => {
    for (const patch of [{ assumptions: "forbid" as const }, { maxAssumptions: 0 }]) {
      const text = prose(config("cited", patch));
      expect(text).toContain("an assumption: refused here — declaring one fails the whole answer");
      expect(text).not.toContain("counted and shown");
    }
    // The gate agrees: an answer that declares one fails at the floor.
    const answer =
      "The fiscal year starts in April for this company [A1].\n\n[A1]: assume: April start\n";
    const verdict = async (cfg: IrProvability): Promise<string> =>
      (await verifyDocument(answer, { config: cfg, evidence: buildEvidenceIndex([]) })).verdict;
    expect(await verdict(config("cited", { assumptions: "forbid" }))).toBe("fail");
    expect(await verdict(config("cited"))).toBe("pass");
  });

  test("max_assumptions: the cap is stated", () => {
    expect(prose(config("cited", { maxAssumptions: 1 }))).toContain(
      "an assumption: at most one per answer, each shown to the reader",
    );
    expect(prose(config("cited", { maxAssumptions: 3 }))).toContain("at most 3 per answer");
  });

  test("grounded.independent > 1 asks for that many sources — at the grounded floor only", () => {
    expect(prose(config("grounded", { grounded: { independent: 2 } }))).toContain(
      "(a quote must appear verbatim); each claim needs 2 independent sources (different sites, publishers or files).",
    );
    // The rule applies at no other floor (verify.ts applyIndependence).
    for (const level of ["cited", "checked", "proven"] as const) {
      expect(prose(config(level, { grounded: { independent: 2 } }))).not.toContain(
        "independent sources",
      );
    }
  });

  test("the proof tools are taught exactly where the gate wires them", () => {
    const cases: IrProvability[] = [];
    for (const level of ["cited", "grounded", "checked", "proven"] as const) {
      cases.push(config(level));
      cases.push(config(level, { formal: { checkers: ["lean4", "builtin"] } }));
    }
    for (const cfg of cases) {
      const wired = new Set(
        gateTools({
          config: cfg,
          workspaceRoot: "/ws",
          proofsRoot: () => "/ws/.crewhaus/proofs",
          evidence: async () => buildEvidenceIndex([]),
        }).tools.map((tool) => tool.name),
      );
      const body = provabilitySkills(cfg)[0]?.body ?? "";
      for (const name of ["ProofCheckers", "ProofCheck", "ProvabilityPreflight"]) {
        expect([
          cfg.level,
          cfg.formal.checkers.join(","),
          name,
          body.includes(`\`${name}\``),
        ]).toEqual([cfg.level, cfg.formal.checkers.join(","), name, wired.has(name)]);
      }
    }
    // Where they are wired: required at proven, optional below it.
    expect(prose(config("proven"))).toContain("Every claim needs a proof: call `ProofCheckers`");
    expect(prose(config("checked", { formal: { checkers: ["lean4"] } }))).toContain(
      "A proof meets any floor. To prove a claim, call `ProofCheckers`",
    );
  });
});

describe("registration through discovery (lowest precedence, classified)", () => {
  test("as a builtin, discovery advertises it — and without the block, nothing is added", async () => {
    const cwd = dirs.make();
    const home = dirs.make();
    const without = await discoverSkills({ cwd, homeDir: home });
    expect(without.map((s) => s.name)).toEqual([]);
    const gated = await discoverSkills({
      cwd,
      homeDir: home,
      builtinSkills: provabilitySkills(config("grounded")),
    });
    expect(gated.map((s) => s.name)).toEqual(["provability"]);
    // The Skill tool loads the rendered body, through the skill-origin boundary.
    const body = await loadSkillBody(gated[0] as LoadedSkill);
    expect(body).toContain("`grounded`");
    expect(body).not.toContain("[tool output redacted");
  });

  test("a project skill named provability replaces the builtin", async () => {
    const cwd = dirs.make();
    const home = dirs.make();
    const dir = join(cwd, ".crewhaus", "skills", "provability");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: provability\ndescription: our house citation rules\n---\nOurs.\n",
    );
    const skills = await discoverSkills({
      cwd,
      homeDir: home,
      builtinSkills: provabilitySkills(config("cited")),
    });
    expect(skills.map((s) => [s.name, s.description])).toEqual([
      ["provability", "our house citation rules"],
    ]);
  });
});

describe("renderGateSkills — the codegen twin", () => {
  test("no block: both pieces empty (byte-identical bundles)", () => {
    expect(renderGateSkills({})).toEqual({ imports: [], expr: "" });
    expect(renderGateSkills({ provability: undefined })).toEqual({ imports: [], expr: "" });
  });

  test("with the block: one import and a call carrying only the fields the skill reads", () => {
    const wiring = renderGateSkills({
      provability: config("proven", { formal: { checkers: ["smt", "builtin"] } }),
    });
    expect(wiring.imports).toEqual([
      'import { provabilitySkills } from "@crewhaus/evaluation-service";',
    ]);
    expect(wiring.expr).toBe(
      'provabilitySkills({"level":"proven","onFail":"retry","maxRetries":1,"scope":"session","assumptions":"allow","grounded":{"independent":1},"formal":{"checkers":["smt","builtin"]}})',
    );
    // A cap rides along only when the block sets one.
    expect(
      renderGateSkills({ provability: config("cited", { maxAssumptions: 2 }) }).expr,
    ).toContain('"assumptions":"allow","maxAssumptions":2,"grounded"');
  });

  test("the rendered expression evaluates to the skill the interpreter registers", () => {
    for (const cfg of [
      config("checked", { formal: { checkers: ["builtin"] } }),
      config("grounded", {
        onFail: "halt",
        scope: "turn",
        assumptions: "forbid",
        maxAssumptions: 2,
        grounded: { independent: 3 },
      }),
    ]) {
      const { expr } = renderGateSkills({ provability: cfg });
      const arg = JSON.parse(/^provabilitySkills\((.*)\)$/.exec(expr)?.[1] ?? "null");
      expect(provabilitySkills(arg)).toEqual(provabilitySkills(cfg));
    }
  });
});
