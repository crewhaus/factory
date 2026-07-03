import { describe, expect, test } from "bun:test";
import { parseSpec } from "@crewhaus/spec";
import {
  EMIT_SPEC_TOOL,
  InterviewError,
  SHAPE_GUIDANCE,
  buildInterviewSystemPrompt,
  buildScriptedSpec,
  isScriptedShape,
  runInterview,
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

  test("EMIT_SPEC_TOOL declares a required yaml string input", () => {
    expect(EMIT_SPEC_TOOL.input_schema.required).toEqual(["yaml"]);
  });
});

describe("runInterview — validate-and-retry loop", () => {
  const validCli = "name: t\ntarget: cli\nagent:\n  model: claude-opus-4-7\n  instructions: hi\n";

  test("succeeds on the first valid draft", async () => {
    let calls = 0;
    const result = await runInterview({
      proposeSpec: async () => {
        calls++;
        return validCli;
      },
    });
    expect(calls).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.spec.target).toBe("cli");
  });

  test("retries with the structured error fed back, then succeeds", async () => {
    const drafts = [
      "name: t\ntarget: cli\nagent:\n  model: claude-opus-4-7\n", // missing instructions
      validCli,
    ];
    const feedbackSeen: string[][] = [];
    let i = 0;
    const result = await runInterview({
      proposeSpec: async (feedback) => {
        feedbackSeen.push([...feedback]);
        return drafts[i++];
      },
    });
    expect(result.attempts).toBe(2);
    // First attempt had no feedback; the second attempt received the first
    // draft's validation error.
    expect(feedbackSeen[0]).toEqual([]);
    expect(feedbackSeen[1]?.length).toBe(1);
    expect(feedbackSeen[1]?.[0]).toContain("instructions");
  });

  test("throws InterviewError after maxAttempts of invalid drafts", async () => {
    const badDraft = "name: t\ntarget: cli\n"; // no agent block
    await expect(
      runInterview({ proposeSpec: async () => badDraft, maxAttempts: 2 }),
    ).rejects.toBeInstanceOf(InterviewError);
  });

  test("throws when the model declines to emit (undefined)", async () => {
    await expect(runInterview({ proposeSpec: async () => undefined })).rejects.toBeInstanceOf(
      InterviewError,
    );
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
