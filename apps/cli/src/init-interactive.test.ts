import { describe, expect, test } from "bun:test";
import { parseSpec } from "@crewhaus/spec";
import {
  ASK_USER_TOOL,
  EMIT_SPEC_TOOL,
  SHAPE_GUIDANCE,
  buildInterviewSystemPrompt,
  buildScriptedSpec,
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
