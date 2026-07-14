/**
 * v0.3.0 Goal 2 (design §3.3, PR 17) — the learning wiring:
 *
 *   - end-to-end skill substitution (the rendered `learning-loop` body
 *     carries the fragment's domain/curriculum/sources, never a leftover
 *     `{{token}}`), the /study /reflect command gate, and /exam gated on a
 *     RUNNABLE exam (config + injected runner);
 *   - the `run_exam` tool: report shape, failed-sample → knowledge-gap
 *     auto-logging (plan-store `[gap]` goals locally, `log_knowledge_gap`
 *     over the client on a live Thredz backend), runner failure surfacing;
 *   - the gap→study loop closing: exam-logged gaps are exactly what
 *     `GoalList` (and the dream seed) list at study time;
 *   - the dream model-phase learning seed (gaps + next curriculum rung)
 *     composed on the existing seam, and its `study.on_dream: false` opt-out;
 *   - the heartbeat study-rotation preamble text;
 *   - regression: no learning block → the wired surface is unchanged.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DreamModelPhase, DreamModelPhaseInput } from "@crewhaus/dream-engine";
import { loadSkillBody } from "@crewhaus/skills-registry";
import type { RegisteredTool, ToolExecuteResult } from "@crewhaus/tool-catalog";
import {
  type ExamReport,
  type ExamRunner,
  type MemoryWiringFragment,
  type ThredzCallResult,
  type ThredzClient,
  type WireMemoryDeps,
  buildLearningDreamSeed,
  learningSkillSubstitutions,
  memoryFragmentFromIr,
  nextCurriculumRung,
  renderStudyRotationPreamble,
  renderedLearningSkill,
  wireDream,
  wireMemory,
} from "./index";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "memory-service-learning-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function collectingCatalog(): { registered: RegisteredTool[]; register(t: RegisteredTool): void } {
  const registered: RegisteredTool[] = [];
  return {
    registered,
    register(t: RegisteredTool) {
      registered.push(t);
    },
  };
}

function deps(overrides: Partial<WireMemoryDeps> = {}) {
  const catalog = collectingCatalog();
  const logs: string[] = [];
  const base: WireMemoryDeps = {
    catalog,
    cwd: tmp,
    homeDir: join(tmp, "home"),
    log: (line) => {
      logs.push(line);
    },
    ...overrides,
  };
  return { deps: base, catalog, logs };
}

const LEARNING_FRAGMENT: MemoryWiringFragment = {
  specName: "expert",
  memory: { wiki: { enabled: true, requireSources: true } },
  continuity: {},
  learning: {
    domain: "specialty coffee extraction science",
    curriculum: "curriculum.md",
    sources: ["sca.coffee", "*.edu"],
    study: { onHeartbeat: true, onDream: true },
  },
};

const EXAM_FRAGMENT: MemoryWiringFragment = {
  ...LEARNING_FRAGMENT,
  learning: {
    ...LEARNING_FRAGMENT.learning,
    domain: LEARNING_FRAGMENT.learning?.domain ?? "coffee",
    exam: { dataset: "eval/dataset.jsonl", graders: "eval/graders.yaml" },
  },
};

function passingReport(): ExamReport {
  return {
    total: 2,
    passed: 2,
    failed: 0,
    passRate: 1,
    outcomes: [
      { sampleId: "q1", input: "what is extraction yield?", passed: true, score: 1 },
      { sampleId: "q2", input: "what is the SCA brew ratio?", passed: true, score: 1 },
    ],
  };
}

function failingReport(): ExamReport {
  return {
    total: 2,
    passed: 1,
    failed: 1,
    passRate: 0.5,
    outcomes: [
      { sampleId: "q1", input: "what is extraction yield?", passed: true, score: 1 },
      {
        sampleId: "q2",
        input: "what is the ideal TDS range for filter coffee?",
        passed: false,
        score: 0.2,
        rationale: "[factual_correctness: ✗] gave espresso numbers for filter coffee",
        agentOutput: "8-12% TDS",
      },
    ],
    outDir: "/tmp/exam-run",
  };
}

async function execText(tool: RegisteredTool, input: unknown = {}): Promise<string> {
  const result: ToolExecuteResult = await tool.execute(input);
  return typeof result === "string" ? result : JSON.stringify(result);
}

// ---------------------------------------------------------------------------
// skill substitution (§3.3 — end to end through wireMemory)
// ---------------------------------------------------------------------------

describe("PR 17 — learning-loop skill substitution", () => {
  test("wireMemory renders the learning-loop skill with domain/curriculum/sources", async () => {
    const { deps: d } = deps();
    const wired = await wireMemory(LEARNING_FRAGMENT, d);
    const skill = wired.options.skills?.find((s) => s.name === "learning-loop");
    expect(skill).toBeDefined();
    const body = await loadSkillBody(skill as never);
    expect(body).toContain("specialty coffee extraction science");
    expect(body).toContain("`curriculum.md`");
    expect(body).toContain("`sca.coffee`, `*.edu`");
    // No token survives rendering.
    expect(body).not.toContain("{{domain}}");
    expect(body).not.toContain("{{curriculum}}");
    expect(body).not.toContain("{{sources}}");
  });

  test("omitted curriculum/sources render the documented fallbacks, never a literal token", () => {
    const subs = learningSkillSubstitutions({ domain: "tax law" });
    expect(subs["curriculum"]).toContain("no curriculum file is configured");
    expect(subs["sources"]).toContain("no allowlist configured");
    const skill = renderedLearningSkill({ domain: "tax law" });
    expect(skill.body).toContain("tax law");
    expect(skill.body).not.toMatch(/\{\{[a-z]+\}\}/i);
  });

  test("/study and /reflect join the gated set; /exam stays out without a runner", async () => {
    const { deps: d } = deps();
    const wired = await wireMemory(LEARNING_FRAGMENT, d);
    expect(wired.options.slashCommands?.has("study")).toBe(true);
    expect(wired.options.slashCommands?.has("reflect")).toBe(true);
    expect(wired.options.slashCommands?.has("exam")).toBe(false);
    expect(wired.tools.some((t) => t.name === "run_exam")).toBe(false);
  });

  test("a project learning-loop skill overrides the rendered builtin by name", async () => {
    const skillDir = join(tmp, ".crewhaus", "skills", "learning-loop");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: learning-loop\ndescription: project override\n---\nMy own loop.\n",
    );
    const { deps: d } = deps();
    const wired = await wireMemory(LEARNING_FRAGMENT, d);
    const skills = wired.options.skills?.filter((s) => s.name === "learning-loop");
    expect(skills?.length).toBe(1);
    expect(skills?.[0]?.description).toBe("project override");
  });

  test("learning without continuity still owns the skill surface", async () => {
    const { deps: d } = deps();
    const wired = await wireMemory(
      { specName: "no-cont", memory: { wiki: { enabled: true } }, learning: { domain: "x" } },
      d,
    );
    expect(wired.options.skills?.some((s) => s.name === "learning-loop")).toBe(true);
    expect(wired.options.slashCommands?.has("study")).toBe(true);
    // Continuity commands stay gated out without continuity.
    expect(wired.options.slashCommands?.has("plan")).toBe(false);
    expect(wired.options.continuity).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// the run_exam tool (§3.3 EXAM)
// ---------------------------------------------------------------------------

describe("PR 17 — run_exam via wireMemory", () => {
  test("exam config + injected runner registers run_exam and gates in /exam", async () => {
    const runner: ExamRunner = async () => passingReport();
    const { deps: d, catalog } = deps({ examRunner: runner });
    const wired = await wireMemory(EXAM_FRAGMENT, d);
    expect(wired.tools.some((t) => t.name === "run_exam")).toBe(true);
    expect(catalog.registered.some((t) => t.name === "run_exam")).toBe(true);
    expect(wired.options.slashCommands?.has("exam")).toBe(true);
    const tool = wired.tools.find((t) => t.name === "run_exam");
    expect(tool?.destructive).toBe(true);
  });

  test("exam config WITHOUT a runner registers nothing (a consumer without the eval stack)", async () => {
    const { deps: d } = deps();
    const wired = await wireMemory(EXAM_FRAGMENT, d);
    expect(wired.tools.some((t) => t.name === "run_exam")).toBe(false);
    expect(wired.options.slashCommands?.has("exam")).toBe(false);
  });

  test("the runner receives the fragment's paths resolved against cwd", async () => {
    let seen: { datasetPath: string; gradersPath: string } | undefined;
    const runner: ExamRunner = async (req) => {
      seen = req;
      return passingReport();
    };
    const { deps: d } = deps({ examRunner: runner });
    const wired = await wireMemory(EXAM_FRAGMENT, d);
    const tool = wired.tools.find((t) => t.name === "run_exam");
    await execText(tool as RegisteredTool);
    expect(seen?.datasetPath).toBe(join(tmp, "eval/dataset.jsonl"));
    expect(seen?.gradersPath).toBe(join(tmp, "eval/graders.yaml"));
  });

  test("failed samples are logged as [gap] goals in the plan store (the flywheel edge)", async () => {
    const runner: ExamRunner = async () => failingReport();
    const { deps: d } = deps({ examRunner: runner });
    const wired = await wireMemory(EXAM_FRAGMENT, d);
    const tool = wired.tools.find((t) => t.name === "run_exam");
    const out = await execText(tool as RegisteredTool);

    expect(out).toContain("1/2 passed (50%)");
    expect(out).toContain("what is the ideal TDS range for filter coffee?");
    expect(out).toContain("gave espresso numbers for filter coffee");
    expect(out).toContain("knowledge gaps logged automatically (1)");

    // The gap→study loop closes: the failure is now a [gap] goal the study
    // priority (GoalList) and the dream seed both surface.
    const goals = await wired.stores.continuity?.listGoals();
    expect(goals?.length).toBe(1);
    expect(goals?.[0]?.title).toContain("[gap]");
    expect(goals?.[0]?.title).toContain("exam failure q2");
  });

  test("with a live Thredz backend, exam gaps route to log_knowledge_gap over the client", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client: ThredzClient = {
      async callTool(name, args): Promise<ThredzCallResult> {
        calls.push({ name, args });
        return { content: "{}", isError: false };
      },
    };
    const runner: ExamRunner = async () => failingReport();
    const { deps: d } = deps({ examRunner: runner, thredz: { client } });
    const fragment: MemoryWiringFragment = { ...EXAM_FRAGMENT, thredz: {} };
    const wired = await wireMemory(fragment, d);
    const tool = wired.tools.find((t) => t.name === "run_exam");
    const out = await execText(tool as RegisteredTool);

    expect(out).toContain("knowledge gaps logged automatically (1)");
    const gapCalls = calls.filter((c) => c.name === "log_knowledge_gap");
    expect(gapCalls.length).toBe(1);
    expect(String(gapCalls[0]?.args["topic"])).toContain("exam failure q2");
    expect(gapCalls[0]?.args["priority"]).toBe("high");
    // The failure never became a local goal — gaps live server-side.
    const goals = await wired.stores.continuity?.listGoals();
    expect(goals?.length).toBe(0);
  });

  test("an all-pass exam logs nothing and suggests growing the exam", async () => {
    const runner: ExamRunner = async () => passingReport();
    const { deps: d } = deps({ examRunner: runner });
    const wired = await wireMemory(EXAM_FRAGMENT, d);
    const out = await execText(wired.tools.find((t) => t.name === "run_exam") as RegisteredTool);
    expect(out).toContain("2/2 passed (100%)");
    expect(out).toContain("adding questions");
    expect((await wired.stores.continuity?.listGoals())?.length).toBe(0);
  });

  test("a throwing runner surfaces as a clear tool error, not a crash", async () => {
    const runner: ExamRunner = async () => {
      throw new Error('exam: cannot load dataset "eval/dataset.jsonl"');
    };
    const { deps: d } = deps({ examRunner: runner });
    const wired = await wireMemory(EXAM_FRAGMENT, d);
    const out = await execText(wired.tools.find((t) => t.name === "run_exam") as RegisteredTool);
    expect(out).toContain("[run_exam error]");
    expect(out).toContain("cannot load dataset");
  });
});

// ---------------------------------------------------------------------------
// unattended study — dream seed (§3.3 study.on_dream)
// ---------------------------------------------------------------------------

describe("PR 17 — dream model-phase learning seed", () => {
  const DREAM_LEARNING_FRAGMENT: MemoryWiringFragment = {
    ...LEARNING_FRAGMENT,
    memory: {
      ...LEARNING_FRAGMENT.memory,
      dream: { everyMs: 86_400_000, mode: "full", budgetUsd: 0.5 },
    },
  };

  function capturingPhase(): { phase: DreamModelPhase; inputs: DreamModelPhaseInput[] } {
    const inputs: DreamModelPhaseInput[] = [];
    return {
      inputs,
      phase: {
        model: "claude-haiku-4-5",
        run: async (input) => {
          inputs.push(input);
          return { summary: "ok" };
        },
      },
    };
  }

  test("nextCurriculumRung finds the first unchecked checkbox", () => {
    const text = "# ladder\n- [x] fundamentals\n- [X] methods\n- [ ] measurement\n- [ ] frontier\n";
    expect(nextCurriculumRung(text)).toBe("measurement");
    expect(nextCurriculumRung("- [x] done\n")).toBeNull();
    expect(nextCurriculumRung("")).toBeNull();
  });

  test("the seed carries open [gap] goals + the next curriculum rung", async () => {
    writeFileSync(join(tmp, "curriculum.md"), "- [x] fundamentals\n- [ ] water chemistry\n");
    const seed = await buildLearningDreamSeed({
      learning: { domain: "coffee", curriculum: "curriculum.md" },
      cwd: tmp,
      listGaps: async () => ["ideal TDS range for filter coffee"],
    });
    expect(seed).toContain("## Learning");
    expect(seed).toContain("ideal TDS range for filter coffee");
    expect(seed).toContain("next unmastered curriculum rung: water chemistry");
  });

  test("wireDream seeds the model phase with gaps + rung when learning is on", async () => {
    writeFileSync(join(tmp, "curriculum.md"), "- [ ] extraction theory\n");
    const { phase, inputs } = capturingPhase();
    // Log a gap first — through the exam sink, closing the loop end to end.
    const runner: ExamRunner = async () => failingReport();
    const { deps: d } = deps({ examRunner: runner });
    const wired = await wireMemory(
      { ...DREAM_LEARNING_FRAGMENT, learning: EXAM_FRAGMENT.learning },
      d,
    );
    await execText(wired.tools.find((t) => t.name === "run_exam") as RegisteredTool);

    const dream = wireDream(
      { ...DREAM_LEARNING_FRAGMENT, learning: EXAM_FRAGMENT.learning },
      { cwd: tmp, modelPhase: phase },
    );
    expect(dream).not.toBeNull();
    await dream?.engine.run({ trigger: "cli" });
    expect(inputs.length).toBe(1);
    expect(inputs[0]?.prompt).toContain("## Learning");
    expect(inputs[0]?.prompt).toContain("exam failure q2");
    expect(inputs[0]?.prompt).toContain("extraction theory");
    // The engine's own phase-1 prompt is still the base.
    expect(inputs[0]?.prompt).toContain("Phase-1 counts");
  });

  test("study.on_dream: false leaves the dream prompt untouched", async () => {
    writeFileSync(join(tmp, "curriculum.md"), "- [ ] extraction theory\n");
    const { phase, inputs } = capturingPhase();
    const fragment: MemoryWiringFragment = {
      ...DREAM_LEARNING_FRAGMENT,
      learning: {
        domain: "coffee",
        curriculum: "curriculum.md",
        study: { onHeartbeat: true, onDream: false },
      },
    };
    const dream = wireDream(fragment, { cwd: tmp, modelPhase: phase });
    await dream?.engine.run({ trigger: "cli" });
    expect(inputs.length).toBe(1);
    expect(inputs[0]?.prompt).not.toContain("## Learning");
  });

  test("no gaps and no curriculum file → no seed appended", async () => {
    const { phase, inputs } = capturingPhase();
    const dream = wireDream(DREAM_LEARNING_FRAGMENT, { cwd: tmp, modelPhase: phase });
    await dream?.engine.run({ trigger: "cli" });
    expect(inputs[0]?.prompt).not.toContain("## Learning");
  });
});

// ---------------------------------------------------------------------------
// unattended study — heartbeat preamble (§3.3 study.on_heartbeat)
// ---------------------------------------------------------------------------

describe("PR 17 — heartbeat study-rotation preamble", () => {
  test("carries the domain, the gaps-first rule, the 3:1 rotation, and the bound", () => {
    const preamble = renderStudyRotationPreamble({
      domain: "coffee",
      curriculum: "curriculum.md",
    });
    expect(preamble).toContain("coffee");
    expect(preamble).toContain("GAPS FIRST");
    expect(preamble).toContain("`curriculum.md`");
    expect(preamble).toContain("3 STUDY ticks");
    expect(preamble).toContain("1 REFLECT tick");
    expect(preamble).toContain("Stay bounded");
    // Both gap-listing surfaces are named (local goals / thredz tasks).
    expect(preamble).toContain("GoalList");
    expect(preamble).toContain("task_list");
  });
});

// ---------------------------------------------------------------------------
// regression — no learning block changes nothing
// ---------------------------------------------------------------------------

describe("PR 17 — regression: no learning block → surface unchanged", () => {
  test("skills, commands, and tools match the pre-PR-17 continuity surface", async () => {
    const { deps: d } = deps();
    const wired = await wireMemory(
      { specName: "plain", memory: { wiki: { enabled: true } }, continuity: {} },
      d,
    );
    expect(wired.options.skills?.map((s) => s.name)).toEqual(["continuity"]);
    const commands = [...(wired.options.slashCommands?.keys() ?? [])].sort();
    expect(commands).toEqual([
      "clear-focus",
      "clear-plan",
      "focus",
      "forget",
      "handoff",
      "next",
      "plan",
    ]);
    expect(wired.tools.some((t) => t.name === "run_exam")).toBe(false);
  });

  test("memoryFragmentFromIr round-trips the learning slice (and omits it when absent)", () => {
    const withLearning = {
      name: "expert",
      memory: { wiki: { enabled: true, requireSources: true } },
      learning: {
        domain: "coffee",
        curriculum: "curriculum.md",
        sources: ["sca.coffee"],
        exam: { dataset: "eval/dataset.jsonl", graders: "eval/graders.yaml" },
        study: { onHeartbeat: false, onDream: true },
      },
    };
    const fragment = memoryFragmentFromIr(withLearning);
    expect(fragment.learning).toEqual(withLearning.learning);
    const bare = memoryFragmentFromIr({ name: "plain", memory: {} });
    expect("learning" in bare).toBe(false);
  });
});
