import { describe, expect, test } from "bun:test";
import { WizardError, answerWizard, compileWizard, nextQuestion, startWizard } from "./index.js";

function fullCliFlow() {
  let state = startWizard();
  state = answerWizard(state, { question: "target", value: "cli" });
  state = answerWizard(state, { question: "name", value: "my-coder" });
  state = answerWizard(state, { question: "model", value: "claude-sonnet-4-6" });
  state = answerWizard(state, { question: "tools", value: ["read", "bash"] });
  state = answerWizard(state, { question: "permissionMode", value: "default" });
  return state;
}

describe("nextQuestion (T1 — per-question branching)", () => {
  test("first question is target with one choice per shipped target shape", () => {
    const q = nextQuestion(startWizard());
    if (q?.id !== "target") throw new Error("expected target question");
    expect(q.choices.length).toBe(10);
    expect(q.choices.map((c) => c.value).sort()).toEqual([
      "batch",
      "browser",
      "channel",
      "cli",
      "crew",
      "graph",
      "managed",
      "pipeline",
      "research",
      "voice",
    ]);
  });

  test("question sequence: target → name → model → tools → permissionMode → undefined", () => {
    let state = startWizard();
    expect(nextQuestion(state)?.id).toBe("target");
    state = answerWizard(state, { question: "target", value: "cli" });
    expect(nextQuestion(state)?.id).toBe("name");
    state = answerWizard(state, { question: "name", value: "x" });
    expect(nextQuestion(state)?.id).toBe("model");
    state = answerWizard(state, { question: "model", value: "claude-sonnet-4-6" });
    expect(nextQuestion(state)?.id).toBe("tools");
    state = answerWizard(state, { question: "tools", value: [] });
    expect(nextQuestion(state)?.id).toBe("permissionMode");
    state = answerWizard(state, { question: "permissionMode", value: "default" });
    expect(nextQuestion(state)).toBeUndefined();
  });

  test("tools.applicable is true only for cli/research/batch shapes", () => {
    const cases: Array<{ target: "cli" | "channel" | "research" | "batch"; expected: boolean }> = [
      { target: "cli", expected: true },
      { target: "research", expected: true },
      { target: "batch", expected: true },
      { target: "channel", expected: false },
    ];
    for (const c of cases) {
      let state = startWizard();
      state = answerWizard(state, { question: "target", value: c.target });
      state = answerWizard(state, { question: "name", value: "x" });
      state = answerWizard(state, { question: "model", value: "m" });
      const q = nextQuestion(state);
      if (q?.id !== "tools") throw new Error("expected tools question");
      expect(q.applicable).toBe(c.expected);
    }
  });
});

describe("compileWizard (T3 — produces a valid spec for every target shape)", () => {
  test("CLI target → patched name/model/tools/permission-mode", () => {
    const result = compileWizard(fullCliFlow());
    expect(result.target).toBe("cli");
    expect(result.name).toBe("my-coder");
    expect(result.yaml).toContain("name: my-coder");
    expect(result.yaml).toContain("target: cli");
    expect(result.yaml).toContain("- read");
    expect(result.yaml).toContain("- bash");
    expect(result.yaml).toContain("mode: default");
  });

  test("compiles every target shape end-to-end", () => {
    const targets: Array<
      | "cli"
      | "channel"
      | "graph"
      | "managed"
      | "pipeline"
      | "crew"
      | "research"
      | "batch"
      | "voice"
      | "browser"
    > = [
      "cli",
      "channel",
      "graph",
      "managed",
      "pipeline",
      "crew",
      "research",
      "batch",
      "voice",
      "browser",
    ];
    for (const target of targets) {
      let state = startWizard();
      state = answerWizard(state, { question: "target", value: target });
      state = answerWizard(state, { question: "name", value: `my-${target}` });
      state = answerWizard(state, { question: "model", value: "claude-sonnet-4-6" });
      state = answerWizard(state, { question: "tools", value: [] });
      state = answerWizard(state, { question: "permissionMode", value: "default" });
      const result = compileWizard(state);
      expect(result.target).toBe(target);
      expect(result.yaml).toMatch(new RegExp(`^target:\\s+${target}$`, "m"));
      expect(result.yaml).toContain(`name: my-${target}`);
    }
  });

  test("envExample lists every $VAR_NAME referenced in the YAML", () => {
    let state = startWizard();
    state = answerWizard(state, { question: "target", value: "channel" });
    state = answerWizard(state, { question: "name", value: "my-bot" });
    state = answerWizard(state, { question: "model", value: "claude-sonnet-4-6" });
    state = answerWizard(state, { question: "tools", value: [] });
    state = answerWizard(state, { question: "permissionMode", value: "default" });
    const r = compileWizard(state);
    expect(r.envExample).toContain("SLACK_BOT_TOKEN=");
    expect(r.envExample).toContain("SLACK_SIGNING_SECRET=");
  });

  test("incomplete state throws WizardError", () => {
    expect(() => compileWizard(startWizard())).toThrow(WizardError);
  });
});
