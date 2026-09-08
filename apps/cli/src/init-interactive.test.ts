import { describe, expect, test } from "bun:test";
import { lower } from "@crewhaus/compiler";
import { parseSpec } from "@crewhaus/spec";
import {
  ASK_USER_TOOL,
  EMIT_SPEC_TOOL,
  HYBRID_INTERVIEW_QUESTION,
  SHAPE_GUIDANCE,
  buildHybridSpec,
  buildInterviewSystemPrompt,
  buildScriptedSpec,
  isHybridYes,
  isScriptedShape,
} from "./init-interactive";

describe("SHAPE_GUIDANCE + buildInterviewSystemPrompt", () => {
  test("covers the fourteen target shapes", () => {
    expect(SHAPE_GUIDANCE).toHaveLength(14);
    const targets = SHAPE_GUIDANCE.map((s) => s.target);
    expect(targets).toContain("cli");
    expect(targets).toContain("onchain-game");
  });

  test("system prompt bundles the shape catalog + hard rules (no demos dep)", () => {
    const prompt = buildInterviewSystemPrompt();
    expect(prompt).toContain("emit_spec");
    expect(prompt).toContain("$UPPER_SNAKE_CASE");
    expect(prompt).toContain("permissions.mode: bypass");
    // Every shape name appears in the prompt.
    for (const { target } of SHAPE_GUIDANCE) expect(prompt).toContain(target);
  });

  test("prompt carries the v0.3.0 §2.9 interview discipline (focused continuity variant)", () => {
    const prompt = buildInterviewSystemPrompt();
    // Two conversation tools, no forced toolChoice — the model is TOLD how
    // ask_user turns work instead of being forced into emit_spec.
    expect(prompt).toContain("ask_user");
    expect(prompt).toContain("end your");
    // Turn-1 extraction + echo of verbatim REQ entries.
    expect(prompt).toContain("REQ-001");
    expect(prompt).toContain("Requirements so far");
    // Never re-ask a confirmed REQ; the ledger is the check.
    expect(prompt).toContain("NEVER re-ask");
    expect(prompt).toContain("<requirements_ledger>");
    // Pre-emit REQ → spec-field mapping, listed in the reply.
    expect(prompt).toContain("→");
    expect(prompt).toContain("maps to a spec");
    // Resumed sessions lead with the resume summary.
    expect(prompt).toContain("Resuming: N");
    // In-context revision on validation errors — no interview restart.
    expect(prompt).toContain("do not restart the interview");
  });

  test("EMIT_SPEC_TOOL keeps the pre-0.3.0 contract: a required yaml string input", () => {
    expect(EMIT_SPEC_TOOL.name).toBe("emit_spec");
    expect(EMIT_SPEC_TOOL.input_schema.required).toEqual(["yaml"]);
  });

  test("ASK_USER_TOOL declares a required question string input", () => {
    expect(ASK_USER_TOOL.name).toBe("ask_user");
    expect(ASK_USER_TOOL.input_schema.required).toEqual(["question"]);
  });
});

describe("isScriptedShape", () => {
  test("accepts the scriptable shapes only", () => {
    expect(isScriptedShape("cli")).toBe(true);
    expect(isScriptedShape("workflow")).toBe(true);
    expect(isScriptedShape("research")).toBe(true);
    expect(isScriptedShape("channel")).toBe(false);
    expect(isScriptedShape("graph")).toBe(false);
  });
});

describe("buildScriptedSpec — every draft is parseSpec-validated", () => {
  test("cli with tools", () => {
    const { yaml, spec } = buildScriptedSpec({
      name: "my-agent",
      shape: "cli",
      model: "claude-opus-4-7",
      instructions: "You are helpful.\nBe concise.",
      tools: ["read", "webSearch"],
    });
    expect(spec.target).toBe("cli");
    // Re-parse the returned YAML independently to prove it round-trips.
    expect(parseSpec(yaml).name).toBe("my-agent");
    if (spec.target === "cli") expect(spec.tools).toEqual(["read", "webSearch"]);
  });

  test("workflow emits a single step", () => {
    const { spec } = buildScriptedSpec({
      name: "flow",
      shape: "workflow",
      model: "claude-opus-4-7",
      instructions: "do the thing",
    });
    expect(spec.target).toBe("workflow");
    if (spec.target === "workflow") {
      expect(spec.steps).toHaveLength(1);
      expect(spec.steps[0]?.name).toBe("flow-step");
    }
  });

  test("research carries the goal", () => {
    const { spec } = buildScriptedSpec({
      name: "res",
      shape: "research",
      model: "claude-opus-4-7",
      instructions: "investigate",
      goal: "find the best framework",
    });
    expect(spec.target).toBe("research");
    if (spec.target === "research") expect(spec.goal).toBe("find the best framework");
  });

  test("multiline instructions survive as a literal block scalar", () => {
    const { spec } = buildScriptedSpec({
      name: "x",
      shape: "cli",
      model: "claude-opus-4-7",
      instructions: "line one\nline two\nline three",
    });
    if (spec.target === "cli") {
      expect(spec.agent.instructions).toBe("line one\nline two\nline three\n");
    }
  });

  test("a value with YAML-significant chars is quoted so it still parses", () => {
    const { spec } = buildScriptedSpec({
      name: "x",
      shape: "cli",
      model: "openai/gpt-4o: latest",
      instructions: "hi",
    });
    if (spec.target === "cli") expect(spec.agent.model).toBe("openai/gpt-4o: latest");
  });

  test("an unsafe name throws SpecParseError (the safeName floor)", () => {
    expect(() =>
      buildScriptedSpec({
        name: "bad/name",
        shape: "cli",
        model: "claude-opus-4-7",
        instructions: "hi",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 0.6.0 §9.2 — `init --hybrid` and the ONE interview question.
// ---------------------------------------------------------------------------

describe("buildHybridSpec", () => {
  const pair = { fast: "claude-haiku-4-5", strong: "claude-opus-5" };
  const built = buildHybridSpec({
    name: "support",
    shape: "cli",
    model: pair.fast,
    instructions: "Answer support questions.",
    pair,
  });

  test("the scaffolded hybrid spec COMPILES — the whole point of a scaffold", () => {
    const ir = lower(built.spec);
    expect(ir.target).toBe("cli");
    // The registry lowered, so `$fast` resolved rather than reaching runtime.
    const models = (ir as { models?: Record<string, { model: string }> }).models;
    expect(models?.["fast"]?.model).toBe("claude-haiku-4-5");
    expect(models?.["strong"]?.model).toBe("claude-opus-5");
    expect((ir as { agent: { model: string } }).agent.model).toBe("claude-haiku-4-5");
  });

  test("writes §1's motivating topology: cheap drafts, a strong checker, escalate on failure", () => {
    const ir = lower(built.spec) as {
      agent: { modelPool?: { candidates: ReadonlyArray<{ model: string }>; strategy?: unknown } };
      evaluation?: { onFail: string };
    };
    expect(ir.agent.modelPool?.candidates.map((c) => c.model)).toEqual([
      "claude-haiku-4-5",
      "claude-opus-5",
    ]);
    expect(ir.agent.modelPool?.strategy).toMatchObject({
      cascade: { draft: "cheap", escalateTo: "strong" },
    });
    expect(ir.evaluation?.onFail).toBe("escalate");
  });

  test("every block it writes carries the comment that explains it", () => {
    expect(built.yaml).toContain("# The model registry");
    expect(built.yaml).toContain("# The roster.");
    expect(built.yaml).toContain("# The cascade:");
    expect(built.yaml).toContain("# The judge that grades each draft.");
    expect(built.yaml).toContain("crewhaus route propose");
  });

  test("the pair stays within ONE provider — a cross-provider default is not the scaffold's call", () => {
    expect(built.yaml).not.toContain("openai/");
    expect(built.yaml).not.toContain("gemini/");
  });

  test("tools ride along when the interview collected any", () => {
    const withTools = buildHybridSpec({
      name: "support",
      shape: "cli",
      model: pair.fast,
      instructions: "Answer support questions.",
      tools: ["read", "grep"],
      pair,
    });
    expect(withTools.yaml).toContain("tools:");
    expect(() => lower(withTools.spec)).not.toThrow();
  });
});

describe("the hybrid interview question", () => {
  test("is exactly one question, and reads as a yes/no", () => {
    expect(HYBRID_INTERVIEW_QUESTION).toContain("[y/N]");
    expect(HYBRID_INTERVIEW_QUESTION.split("?").length).toBe(2);
  });

  test("only an explicit yes counts — the default is the single-model spec", () => {
    for (const yes of ["y", "Y", "yes", " YES "]) expect(isHybridYes(yes)).toBe(true);
    for (const no of ["", "n", "no", "maybe", "yep"]) expect(isHybridYes(no)).toBe(false);
  });
});
