import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearBoundaryCache } from "@crewhaus/boundary-classifier";
import { type RunContext, createRunContext } from "@crewhaus/run-context";
import { discoverSkills, loadSkillBody, parseSkillFile } from "@crewhaus/skills-registry";
import { expand, loadCommands } from "@crewhaus/slash-commands";
import {
  BUILTIN_COMMAND_NAMES,
  CONTINUITY_SKILL_BODY,
  DEFAULT_COMMANDS,
  DEFAULT_SKILLS,
  DEFAULT_SKILL_NAMES,
  DREAM_SKILL_BODY,
  DefaultSkillsError,
  LEARNING_LOOP_SKILL_BODY,
  builtinCommandsDir,
  builtinSkillsDir,
  renderSkill,
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
  test("ships exactly the three design-§2.6 skills, in order", () => {
    expect(DEFAULT_SKILL_NAMES).toEqual(["continuity", "learning-loop", "dream"] as const);
    expect(DEFAULT_SKILLS.map((s) => s.name)).toEqual(["continuity", "learning-loop", "dream"]);
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
    expect(CONTINUITY_SKILL_BODY.length).toBeGreaterThan(500);
    expect(LEARNING_LOOP_SKILL_BODY.length).toBeGreaterThan(500);
    expect(DREAM_SKILL_BODY.length).toBeGreaterThan(500);
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

  test("only learning-loop carries tokens, and exactly the three learning tokens", () => {
    const tokenRe = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;
    expect([...CONTINUITY_SKILL_BODY.matchAll(tokenRe)]).toEqual([]);
    expect([...DREAM_SKILL_BODY.matchAll(tokenRe)]).toEqual([]);
    const tokens = new Set(
      [...LEARNING_LOOP_SKILL_BODY.matchAll(tokenRe)].map((m) => m[1] as string),
    );
    expect([...tokens].sort()).toEqual(["curriculum", "domain", "sources"]);
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

describe("classification path — builtins get no trust shortcut (Pillar 3)", () => {
  test("all three builtins survive frontmatter classification at discovery", async () => {
    clearBoundaryCache();
    await withTempHomeAndCwd(
      () => {},
      async ({ home, cwd }) => {
        const skills = await discoverSkills({ cwd, homeDir: home, builtinSkills: DEFAULT_SKILLS });
        expect(skills.map((s) => s.name).sort()).toEqual(["continuity", "dream", "learning-loop"]);
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
        expect(skills.map((s) => s.name).sort()).toEqual(["continuity", "dream", "learning-loop"]);
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
        expect(skills.map((s) => s.name).sort()).toEqual(["continuity", "dream", "learning-loop"]);
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
  });

  test("no stray thredz__ prefixes — tool names are backend-neutral", () => {
    for (const doc of documents) {
      expect(doc.body).not.toContain("thredz__");
    }
  });
});
