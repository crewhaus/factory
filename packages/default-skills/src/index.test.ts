import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearBoundaryCache } from "@crewhaus/boundary-classifier";
import {
  citationDefinitions,
  classifyDefinition,
  extractClaims,
  lintCitations,
} from "@crewhaus/claim-ledger";
import { type RunContext, createRunContext } from "@crewhaus/run-context";
import { discoverSkills, loadSkillBody, parseSkillFile } from "@crewhaus/skills-registry";
import { expand, loadCommands } from "@crewhaus/slash-commands";
import { createPlanTools } from "@crewhaus/tool-plan";
import { PROOF_TOOLS } from "@crewhaus/tool-proof";
import { THREDZ_WIKI_TOOL_NAMES } from "@crewhaus/tool-wiki";
import {
  BUILTIN_COMMAND_NAMES,
  CONTINUITY_SKILL_BODY,
  DEFAULT_COMMANDS,
  DEFAULT_SKILLS,
  DEFAULT_SKILL_NAMES,
  DREAM_SKILL_BODY,
  DefaultSkillsError,
  LEARNING_LOOP_SKILL_BODY,
  PROVABILITY_SKILL_BODY,
  builtinCommandsDir,
  builtinSkillsDir,
  renderSkill,
  renderSkillText,
  skillTokens,
} from "./index";

function withTempHomeAndCwd(
  setup: (paths: { home: string; cwd: string }) => void,
  body: (paths: { home: string; cwd: string }) => Promise<void> | void,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "defaults-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "defaults-cwd-"));
  try {
    setup({ home, cwd });
    return Promise.resolve(body({ home, cwd })).finally(() => {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    });
  } catch (err) {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    throw err;
  }
}

describe("package shape", () => {
  // The three design-§2.6 skills, then 0.8.0's `provability` (design/
  // 0.8.0-provability-release.md §11). A new default skill lands here
  // deliberately: it is prompt surface on every harness that registers it.
  test("ships exactly the four default skills, in order", () => {
    expect(DEFAULT_SKILL_NAMES).toEqual([
      "continuity",
      "learning-loop",
      "dream",
      "provability",
    ] as const);
    expect(DEFAULT_SKILLS.map((s) => s.name)).toEqual([
      "continuity",
      "learning-loop",
      "dream",
      "provability",
    ]);
  });

  test("ships exactly the eleven builtin commands", () => {
    expect([...BUILTIN_COMMAND_NAMES]).toEqual([
      "plan",
      "focus",
      "next",
      "handoff",
      "clear-plan",
      "clear-focus",
      "forget",
      "study",
      "reflect",
      "exam",
      "dream",
    ]);
    expect(DEFAULT_COMMANDS.map((c) => c.name)).toEqual([...BUILTIN_COMMAND_NAMES]);
  });

  test("body constants mirror DEFAULT_SKILLS entries", () => {
    const byName = new Map(DEFAULT_SKILLS.map((s) => [s.name, s.body]));
    expect(CONTINUITY_SKILL_BODY).toBe(byName.get("continuity") as string);
    expect(LEARNING_LOOP_SKILL_BODY).toBe(byName.get("learning-loop") as string);
    expect(DREAM_SKILL_BODY).toBe(byName.get("dream") as string);
    expect(PROVABILITY_SKILL_BODY).toBe(byName.get("provability") as string);
    expect(CONTINUITY_SKILL_BODY.length).toBeGreaterThan(500);
    expect(LEARNING_LOOP_SKILL_BODY.length).toBeGreaterThan(500);
    expect(DREAM_SKILL_BODY.length).toBeGreaterThan(500);
    expect(PROVABILITY_SKILL_BODY.length).toBeGreaterThan(500);
  });

  test("every skill body ends with a newline (clean file embedding)", () => {
    for (const skill of DEFAULT_SKILLS) {
      expect(skill.body.endsWith("\n")).toBe(true);
    }
  });
});

describe("SKILL.md files — frontmatter validation", () => {
  test("each shipped SKILL.md parses under the registry's frontmatter schema", () => {
    for (const name of DEFAULT_SKILL_NAMES) {
      const file = join(builtinSkillsDir, name, "SKILL.md");
      expect(existsSync(file)).toBe(true);
      const { frontmatter, body } = parseSkillFile(readFileSync(file, "utf8"));
      expect(frontmatter.name).toBe(name);
      expect(frontmatter.description.length).toBeGreaterThan(20);
      const shipped = DEFAULT_SKILLS.find((s) => s.name === name);
      expect(body).toBe(shipped?.body as string);
      expect(frontmatter.description).toBe(shipped?.description as string);
    }
  });

  test("each command file exposes a description; arg-taking commands declare hints", () => {
    for (const command of DEFAULT_COMMANDS) {
      expect(command.description ?? "").not.toBe("");
      expect(command.filePath).toBe(join(builtinCommandsDir, `${command.name}.md`));
    }
    const hints = new Map(DEFAULT_COMMANDS.map((c) => [c.name, c.argumentHint]));
    expect(hints.get("focus")).toBe("<text>");
    expect(hints.get("forget")).toBe("<query>");
    expect(hints.get("study")).toBe("[topic]");
  });

  test("commands that take arguments carry $ARGUMENTS; the rest do not", () => {
    const takesArgs = new Set(["focus", "forget", "study"]);
    for (const command of DEFAULT_COMMANDS) {
      const has = command.body.includes("$ARGUMENTS");
      expect(has).toBe(takesArgs.has(command.name));
    }
  });
});

describe("renderSkill — {{token}} substitution", () => {
  const SUBS = {
    domain: "specialty coffee extraction science",
    curriculum: "curriculum.md",
    sources: "sca.coffee, *.edu",
  };

  test("learning-loop substitutes domain, curriculum, and sources", () => {
    const rendered = renderSkill("learning-loop", SUBS);
    expect(rendered).toContain("specialty coffee extraction science");
    expect(rendered).toContain("curriculum.md");
    expect(rendered).toContain("sca.coffee, *.edu");
    expect(rendered).not.toContain("{{");
    expect(rendered).not.toContain("}}");
  });

  test("only learning-loop and provability carry tokens, exactly their own", () => {
    const tokensOf = (body: string): string[] => [...skillTokens(body)].sort();
    expect(tokensOf(CONTINUITY_SKILL_BODY)).toEqual([]);
    expect(tokensOf(DREAM_SKILL_BODY)).toEqual([]);
    expect(tokensOf(LEARNING_LOOP_SKILL_BODY)).toEqual(["curriculum", "domain", "sources"]);
    // The names the composition root fills from the lowered block
    // (`@crewhaus/evaluation-service`'s provabilitySkillSubstitutions) — one
    // it does not fill would leave every gated harness without the skill.
    expect(tokensOf(PROVABILITY_SKILL_BODY)).toEqual([
      "assumptions",
      "checkers",
      "independent",
      "level",
      "on_fail",
      "proofs",
      "window",
    ]);
  });

  test("token-free skills render unchanged with an empty map", () => {
    expect(renderSkill("continuity")).toBe(CONTINUITY_SKILL_BODY);
    expect(renderSkill("dream", {})).toBe(DREAM_SKILL_BODY);
  });

  test("a missing substitution throws", () => {
    expect(() => renderSkill("learning-loop", { domain: "x", curriculum: "y" })).toThrow(
      DefaultSkillsError,
    );
    expect(() => renderSkill("learning-loop", { domain: "x", curriculum: "y" })).toThrow(
      /\{\{sources\}\}/,
    );
  });

  test("an unknown substitution token throws", () => {
    expect(() => renderSkill("learning-loop", { ...SUBS, domian: "typo" })).toThrow(
      DefaultSkillsError,
    );
    expect(() => renderSkill("continuity", { domain: "x" })).toThrow(/unknown substitution token/);
  });

  test("an unknown skill name throws and names the known skills", () => {
    expect(() => renderSkill("nope")).toThrow(DefaultSkillsError);
    expect(() => renderSkill("nope")).toThrow(/continuity, learning-loop, dream/);
  });
});

describe("renderSkillText — {{#section}} blocks", () => {
  const BODY = "Intro.\n{{#extra}}\n- extra: {{extra}}\n{{/extra}}\n- always\n";

  test("a non-empty value keeps the block (markers and their line breaks removed)", () => {
    expect(renderSkillText(BODY, { extra: "yes" })).toBe("Intro.\n- extra: yes\n- always\n");
  });

  test("an empty value drops the block whole, leaving no blank line", () => {
    expect(renderSkillText(BODY, { extra: "" })).toBe("Intro.\n- always\n");
  });

  test("an inline section keeps the text around it, line breaks included", () => {
    const body = "A{{#x}} and B{{/x}}.\nC\n";
    expect(renderSkillText(body, { x: "1" })).toBe("A and B.\nC\n");
    expect(renderSkillText(body, { x: "" })).toBe("A.\nC\n");
  });

  test("sections nest under different names", () => {
    const body = "{{#a}}\nA\n{{#b}}\nB\n{{/b}}\n{{/a}}\nZ\n";
    expect(renderSkillText(body, { a: "1", b: "1" })).toBe("A\nB\nZ\n");
    expect(renderSkillText(body, { a: "1", b: "" })).toBe("A\nZ\n");
    expect(renderSkillText(body, { a: "", b: "1" })).toBe("Z\n");
  });

  test("section names are tokens: required, and a token inside a dropped block still is", () => {
    expect([...skillTokens(BODY)]).toEqual(["extra"]);
    expect(() => renderSkillText(BODY, {})).toThrow(/\{\{extra\}\}/);
    expect(() => renderSkillText("{{#a}}{{b}}{{/a}}", { a: "" })).toThrow(/\{\{b\}\}/);
    expect(renderSkillText("{{#a}}{{b}}{{/a}}", { a: "", b: "x" })).toBe("");
  });

  test("an unbalanced marker throws instead of leaking into the prompt", () => {
    expect(() => renderSkillText("{{#a}} open", { a: "1" })).toThrow(/no closing \{\{\/a\}\}/);
    expect(() => renderSkillText("close {{/a}}", { a: "1" })).toThrow(/unbalanced section marker/);
  });
});

// ---------------------------------------------------------------------------
// 0.8.0 §11 — the `provability` skill. What the model is told must be what
// the gate checks: these pin the substitutions, the ladder, the citation
// grammar (read by the gate's own parser, claim-ledger) and the tools.
// ---------------------------------------------------------------------------

describe("the provability skill (0.8.0 §11)", () => {
  /** The shipped defaults' values (evaluation-service computes the real ones). */
  const SUBS = {
    level: "cited",
    checkers: "builtin, smt",
    on_fail: "comes back to you with what failed",
    window: "in this session",
    assumptions: "counted and shown to the reader",
    independent: "",
    proofs: "",
  };
  const render = (level: string, checkers = "builtin, smt", proofs = "To prove a claim,"): string =>
    renderSkill("provability", { ...SUBS, level, checkers, proofs });

  /** The worked example under "How to cite": the indented block, dedented. */
  function citingExample(body: string): string {
    const section = body.slice(body.indexOf("## How to cite"), body.indexOf("## What the gate"));
    return section
      .split("\n")
      .filter((line) => line.startsWith("    ") || line === "")
      .map((line) => line.slice(4))
      .join("\n")
      .trim();
  }

  test("renders the floor and the checker order, leaving no token behind", () => {
    const rendered = render("grounded", "lean4, builtin");
    const prose = rendered.replace(/\s+/g, " ");
    expect(prose).toContain("the floor is `grounded`");
    expect(prose).toContain("this harness prefers lean4, builtin, in that order");
    expect(rendered).not.toMatch(/\{\{|\}\}/);
    // Every rung renders: the body is one text with the floor substituted,
    // not a per-rung variant that could drift from the others.
    for (const level of ["cited", "grounded", "checked", "proven"]) {
      expect(render(level).replace(/\s+/g, " ")).toContain(`the floor is \`${level}\``);
    }
  });

  test("every substitution is required, and nothing else is accepted", () => {
    const { checkers: _c, ...noCheckers } = SUBS;
    const { level: _l, ...noLevel } = SUBS;
    expect(() => renderSkill("provability", noCheckers)).toThrow(/\{\{checkers\}\}/);
    expect(() => renderSkill("provability", noLevel)).toThrow(/\{\{level\}\}/);
    expect(() => renderSkill("provability", { ...SUBS, domain: "x" })).toThrow(
      /unknown substitution token "domain"/,
    );
  });

  test("the proofs section — the proof tools — renders only for a non-empty value", () => {
    const without = render("cited", "builtin, smt", "");
    for (const tool of ["`ProofCheckers`", "`ProofCheck`", "proof:prf_…` — the id"]) {
      expect(without).not.toContain(tool);
    }
    // The ladder still names the rung, and the preflight stays.
    expect(without).toContain("- `proven`: the claim cites `proof:prf_…`");
    expect(without).toContain("`ProvabilityPreflight`");
    expect(without).not.toMatch(/\n\n\n/);
    const withProofs = render("proven", "smt", "Every claim needs a proof:");
    expect(withProofs.replace(/\s+/g, " ")).toContain(
      "- Every claim needs a proof: call `ProofCheckers` and pick an available checker — this harness prefers smt,",
    );
    expect(withProofs).toContain("- `[n]: proof:prf_…` — the id `ProofCheck` returned\n");
  });

  test("the gate's settings land where the text describes them", () => {
    const prose = renderSkill("provability", {
      ...SUBS,
      on_fail: "is never served: the run stops",
      window: "since the user's last message",
      assumptions: "refused here",
      independent: "; each claim needs 2 independent sources",
    }).replace(/\s+/g, " ");
    expect(prose).toContain("An answer that falls short is never served: the run stops.");
    expect(prose).toContain("a tool call you made since the user's last message");
    expect(prose).toContain("fetched or read since the user's last message");
    expect(prose).toContain("cited as `[A1]` — an assumption: refused here");
    expect(prose).toContain(
      "(a quote must appear verbatim); each claim needs 2 independent sources.",
    );
  });

  test("explains every rung in one entry, saying what the gate checks", () => {
    const ladder = PROVABILITY_SKILL_BODY.slice(
      PROVABILITY_SKILL_BODY.indexOf("## What the gate checks"),
      PROVABILITY_SKILL_BODY.indexOf("## How to pass"),
    );
    const entries = ladder.split("\n").filter((line) => line.startsWith("- `"));
    expect(entries.map((line) => /^- `(\w+)`:/.exec(line)?.[1])).toEqual([
      "cited",
      "grounded",
      "checked",
      "proven",
    ]);
    // The honest limit of `cited` (design §2): what the source says is not
    // read — true whether or not `sources.resolve: head` checks it is there.
    expect(ladder).toContain("What the source says is not checked.");
    expect(ladder).toContain("Higher-rung evidence meets a lower floor.");
  });

  test("teaches the whole evidence-ref grammar the gate reads (design §4.1)", () => {
    for (const form of [
      "[n]: <url>",
      "[n]: <workspace path>",
      "[n]: tool:<toolUseId>",
      "[n]: proof:prf_…",
      "[A1]: assume: <text>",
    ]) {
      expect(PROVABILITY_SKILL_BODY).toContain(form);
    }
    // Each form, filled in, reads as the evidence kind the skill names.
    expect(classifyDefinition("https://acme.example/policy").kind).toBe("url");
    expect(classifyDefinition("./docs/pricing.md").kind).toBe("path");
    expect(classifyDefinition("tool:toolu_01").kind).toBe("tool");
    expect(classifyDefinition("proof:prf_3f9a").kind).toBe("proof");
    expect(classifyDefinition("assume: the fiscal year starts in April").kind).toBe("assume");
  });

  test("the worked example is a valid answer under the gate's own parser", () => {
    const example = citingExample(PROVABILITY_SKILL_BODY);
    expect(example).toContain("[1]: https://acme.example/policy");
    // Every marker defined, every definition cited.
    const lint = lintCitations(example);
    expect(lint.ok).toBe(true);
    expect(lint.undefinedMarkers).toEqual([]);
    expect(lint.uncited).toEqual([]);
    // Two claims, one marker each; the definitions are a source and a tool call.
    expect(extractClaims(example).map((c) => c.markers)).toEqual([["1"], ["2"]]);
    const definitions = citationDefinitions(example);
    expect(classifyDefinition(definitions.get("1") ?? "").kind).toBe("url");
    expect(classifyDefinition(definitions.get("2") ?? "").kind).toBe("tool");
  });

  test("names the steps the design asks for (§11)", () => {
    // Read as prose: the file's line wrapping is not part of the contract.
    const prose = PROVABILITY_SKILL_BODY.replace(/\s+/g, " ");
    expect(prose).toContain("Fetch or read a source before you cite it");
    expect(prose).toContain("quote its exact words");
    expect(prose).toContain("Never state a number you did not read or compute");
    expect(prose).toContain("call `ProofCheckers`");
    expect(prose).toContain("call `ProofCheck`");
    expect(prose).toContain("run `ProvabilityPreflight` on the whole draft");
    expect(prose).toContain("Never invent a source, a toolUseId or a proof id");
  });

  test("stays concise — it is prompt weight on every gated turn", () => {
    // A ceiling, not a target: the continuity skill is the size to beat.
    expect(PROVABILITY_SKILL_BODY.length).toBeLessThan(CONTINUITY_SKILL_BODY.length);
    const skill = DEFAULT_SKILLS.find((s) => s.name === "provability");
    // The description is in the skills list on EVERY turn — one sentence.
    expect(skill?.description.length).toBeLessThan(200);
    expect(skill?.description).toMatch(/^Load before you answer/);
  });

  test("a rendered body still passes the skill-origin boundary unredacted", async () => {
    clearBoundaryCache();
    const skill = DEFAULT_SKILLS.find((s) => s.name === "provability");
    if (skill === undefined) throw new Error("expected the provability skill");
    const rendered = { ...skill, body: render("proven") };
    const ctx: RunContext = createRunContext();
    const body = await loadSkillBody(rendered, ctx);
    expect(body).toBe(rendered.body);
    expect(ctx.dataLineage?.get(body)).toBe("skill");
  });
});

describe("classification path — builtins get no trust shortcut (Pillar 3)", () => {
  test("all four builtins survive frontmatter classification at discovery", async () => {
    clearBoundaryCache();
    await withTempHomeAndCwd(
      () => {},
      async ({ home, cwd }) => {
        const skills = await discoverSkills({ cwd, homeDir: home, builtinSkills: DEFAULT_SKILLS });
        expect(skills.map((s) => s.name).sort()).toEqual([
          "continuity",
          "dream",
          "learning-loop",
          "provability",
        ]);
      },
    );
  });

  test("each builtin body loads through classify + tagContent and is not redacted", async () => {
    clearBoundaryCache();
    await withTempHomeAndCwd(
      () => {},
      async ({ home, cwd }) => {
        const skills = await discoverSkills({ cwd, homeDir: home, builtinSkills: DEFAULT_SKILLS });
        for (const ref of skills) {
          const ctx: RunContext = createRunContext();
          const body = await loadSkillBody(ref, ctx);
          const shipped = DEFAULT_SKILLS.find((s) => s.name === ref.name);
          expect(body).toBe(shipped?.body as string);
          expect(body).not.toContain("[tool output redacted");
          expect(ctx.dataLineage?.get(body)).toBe("skill");
        }
      },
    );
  });

  test("the same files also pass disk-based discovery from the builtin root", async () => {
    // Interpreter-path variant: point discovery at the package's skills/
    // directory itself (via pluginDirs, which walks arbitrary roots) and
    // confirm the on-disk files parse and load identically.
    await withTempHomeAndCwd(
      () => {},
      async ({ home, cwd }) => {
        const skills = await discoverSkills({ cwd, homeDir: home, pluginDirs: [builtinSkillsDir] });
        expect(skills.map((s) => s.name).sort()).toEqual([
          "continuity",
          "dream",
          "learning-loop",
          "provability",
        ]);
        const continuity = skills.find((s) => s.name === "continuity");
        if (!continuity) throw new Error("expected continuity from disk");
        expect(await loadSkillBody(continuity)).toBe(CONTINUITY_SKILL_BODY);
      },
    );
  });
});

describe("override story — users can replace or clear the defaults", () => {
  function writeSkill(root: string, name: string, frontmatter: string, body: string): void {
    const dir = join(root, ".crewhaus", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
  }

  test("a project skill named continuity overrides the shipped default", async () => {
    await withTempHomeAndCwd(
      ({ cwd }) => {
        writeSkill(cwd, "continuity", "name: continuity\ndescription: our house rules", "Ours.");
      },
      async ({ home, cwd }) => {
        const skills = await discoverSkills({ cwd, homeDir: home, builtinSkills: DEFAULT_SKILLS });
        const continuity = skills.find((s) => s.name === "continuity");
        expect(continuity?.description).toBe("our house rules");
        if (!continuity) throw new Error("expected continuity");
        expect(await loadSkillBody(continuity)).toBe("Ours.");
        // The other builtins are untouched.
        expect(skills.map((s) => s.name).sort()).toEqual([
          "continuity",
          "dream",
          "learning-loop",
          "provability",
        ]);
      },
    );
  });

  test("an empty-body user override effectively disables a default skill", async () => {
    await withTempHomeAndCwd(
      ({ home }) => {
        writeSkill(home, "dream", "name: dream\ndescription: disabled here", "");
      },
      async ({ home, cwd }) => {
        const skills = await discoverSkills({ cwd, homeDir: home, builtinSkills: DEFAULT_SKILLS });
        const dream = skills.find((s) => s.name === "dream");
        if (!dream) throw new Error("expected dream");
        expect(await loadSkillBody(dream)).toBe("");
      },
    );
  });
});

describe("builtin slash commands — discovery + expansion", () => {
  test("loadCommands picks up all eleven from builtinCommandsDir", async () => {
    await withTempHomeAndCwd(
      () => {},
      async ({ home, cwd }) => {
        const cmds = await loadCommands({
          cwd,
          homeDir: home,
          builtinDirs: [builtinCommandsDir],
        });
        expect([...cmds.keys()].sort()).toEqual([...BUILTIN_COMMAND_NAMES].sort());
      },
    );
  });

  test("/focus expands $ARGUMENTS into the template", async () => {
    await withTempHomeAndCwd(
      () => {},
      async ({ home, cwd }) => {
        const cmds = await loadCommands({
          cwd,
          homeDir: home,
          builtinDirs: [builtinCommandsDir],
        });
        const r = expand("/focus Ship the CSV export", cmds);
        expect(r.handled).toBe(true);
        expect(r.expanded).toContain("Ship the CSV export");
        expect(r.expanded).not.toContain("$ARGUMENTS");
      },
    );
  });

  test("argument-free commands expand to their full instruction body", async () => {
    await withTempHomeAndCwd(
      () => {},
      async ({ home, cwd }) => {
        const cmds = await loadCommands({
          cwd,
          homeDir: home,
          builtinDirs: [builtinCommandsDir],
        });
        const plan = expand("/plan", cmds);
        expect(plan.handled).toBe(true);
        expect(plan.expanded).toContain("PlanRead");
        const handoff = expand("/handoff", cmds);
        expect(handoff.handled).toBe(true);
        expect(handoff.expanded).toContain("FocusWrite");
      },
    );
  });

  test("a project command overrides a builtin by name", async () => {
    await withTempHomeAndCwd(
      ({ cwd }) => {
        const dir = join(cwd, ".crewhaus", "commands");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "plan.md"), "Custom plan body.");
      },
      async ({ home, cwd }) => {
        const cmds = await loadCommands({
          cwd,
          homeDir: home,
          builtinDirs: [builtinCommandsDir],
        });
        expect(cmds.get("plan")?.body).toBe("Custom plan body.");
        expect(cmds.size).toBe(BUILTIN_COMMAND_NAMES.length);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Content lint — every tool name mentioned in a skill/command body must be a
// real tool. The allowlist below is PINNED to the v0.3.0 tool vocabulary
// (tool-plan, tool-memory, tool-wiki, tool-todo, and the synthetic Skill
// tool). If a body drifts from the vocabulary (a typo, a renamed tool), this
// test fails before the prose ships.
// ---------------------------------------------------------------------------

const TOOL_VOCABULARY = new Set([
  // continuity (tool-plan / continuity-store)
  "FocusRead",
  "FocusWrite",
  "PlanRead",
  "PlanUpdate",
  "PlanComplete",
  "GoalWrite",
  "GoalUpdate",
  "GoalList",
  "MemoryClear",
  // memory (tool-memory / memory-store v2)
  "Remember",
  "Recall",
  "MemoryForget",
  // todos (tool-todo, re-backed by the plan store)
  "TodoWrite",
  // the synthetic skill loader (skills-registry)
  "Skill",
  // wiki (tool-wiki, thredz-identical names)
  "wiki_recall",
  "wiki_search",
  "wiki_semantic_search",
  "wiki_get",
  "wiki_write",
  "wiki_list",
  "wiki_related",
  "wiki_set_signals",
  "wiki_stats",
  "log_knowledge_gap",
  // thredz goal/task vocabulary (bare-name aliases, PR 16) — the gap
  // listing surface on the hosted backend
  "task_list",
  // the first-class exam (memory-service run_exam, PR 17)
  "run_exam",
  // the proof tools (tool-proof, 0.8.0 §7) the provability skill teaches
  "ProofCheckers",
  "ProofCheck",
  "ProvabilityPreflight",
]);

// Identifiers that look tool-shaped inside code spans but are deliberately
// not tools (statuses, tail-block tags, section headings).
const KNOWN_NON_TOOLS = new Set([
  "in_progress", // proof-ladder status
  "current_plan", // <current_plan> tail block tag
  "requirements_ledger", // <requirements_ledger> tail block tag
  "Sources", // the `## Sources` wiki section
]);

const CODE_SPAN_RE = /`([^`]+)`/g;
const PASCAL_CASE = /^[A-Z][a-z][A-Za-z0-9]*$/;
const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

function toolShapedIdentifiers(body: string): string[] {
  const out: string[] = [];
  for (const span of body.matchAll(CODE_SPAN_RE)) {
    for (const token of (span[1] ?? "").split(/[^A-Za-z0-9_]+/)) {
      if (token.length === 0) continue;
      if (PASCAL_CASE.test(token) || SNAKE_CASE.test(token)) out.push(token);
    }
  }
  return out;
}

describe("content lint — tool vocabulary", () => {
  const documents: ReadonlyArray<{ label: string; body: string }> = [
    ...DEFAULT_SKILLS.map((s) => ({ label: `skill:${s.name}`, body: s.body })),
    ...DEFAULT_COMMANDS.map((c) => ({ label: `command:/${c.name}`, body: c.body })),
  ];

  test("every tool-shaped identifier in every body is a known tool or known non-tool", () => {
    for (const doc of documents) {
      for (const token of toolShapedIdentifiers(doc.body)) {
        const known = TOOL_VOCABULARY.has(token) || KNOWN_NON_TOOLS.has(token);
        if (!known) {
          throw new Error(
            `${doc.label} mentions \`${token}\`, which is neither in the pinned tool vocabulary nor the known-non-tool list — typo, or a drifted tool name?`,
          );
        }
        expect(known).toBe(true);
      }
    }
  });

  test("the skills actually teach their core tools (anchors, not incidental)", () => {
    expect(toolShapedIdentifiers(CONTINUITY_SKILL_BODY)).toEqual(
      expect.arrayContaining(["PlanRead", "FocusWrite", "PlanUpdate", "PlanComplete", "TodoWrite"]),
    );
    expect(toolShapedIdentifiers(LEARNING_LOOP_SKILL_BODY)).toEqual(
      expect.arrayContaining([
        "wiki_recall",
        "wiki_write",
        "wiki_set_signals",
        "log_knowledge_gap",
      ]),
    );
    expect(toolShapedIdentifiers(DREAM_SKILL_BODY)).toEqual(
      expect.arrayContaining(["wiki_write", "wiki_set_signals", "MemoryForget", "PlanUpdate"]),
    );
    expect(toolShapedIdentifiers(PROVABILITY_SKILL_BODY)).toEqual(
      expect.arrayContaining(["ProofCheckers", "ProofCheck", "ProvabilityPreflight"]),
    );
  });

  test("no stray thredz__ prefixes — tool names are backend-neutral", () => {
    for (const doc of documents) {
      expect(doc.body).not.toContain("thredz__");
    }
  });

  // v0.3.0 integration seam — the vocabulary above was pinned while tool-plan
  // and tool-wiki were still parallel branches. Now that both are in-tree,
  // tie the pin to the ACTUAL registered tool names so a rename on either
  // side fails here instead of shipping stale prose.
  test("the pinned vocabulary matches the REAL registered tool-plan and tool-wiki names", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "defaults-vocab-"));
    try {
      const planNames = createPlanTools({ specName: "vocab-probe", rootDir: stateDir }).all.map(
        (t) => t.name,
      );
      for (const name of planNames) {
        expect(TOOL_VOCABULARY.has(name)).toBe(true);
      }
      for (const name of THREDZ_WIKI_TOOL_NAMES) {
        expect(TOOL_VOCABULARY.has(name)).toBe(true);
      }
      for (const tool of PROOF_TOOLS) {
        expect(TOOL_VOCABULARY.has(tool.name)).toBe(true);
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
