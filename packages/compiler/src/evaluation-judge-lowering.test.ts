/**
 * Loop contract 0.4 (Batch B, G02) — lowering tests for the `evaluation:`
 * block (cli/channel/managed) and the `kind: "judge"` workflow-step /
 * graph-node variants: defaults RESOLVE at lower time, judge models ride
 * the aux-model machinery (`cheapest` supported), and declaring either
 * surface never draws an accepted-but-unwired warning (they are wired in
 * this batch).
 */
import { describe, expect, test } from "bun:test";
import { parseSpec } from "@crewhaus/spec";
import { compile, lower } from "./index";

const CLI_HEAD = [
  "name: c",
  "target: cli",
  "agent:",
  "  model: claude-opus-4-7",
  "  instructions: i",
];

describe("evaluation: lowering (cli/channel/managed)", () => {
  test("llm_judge defaults resolve: threshold 0.7, on_fail retry, max_retries 1; model stays absent", () => {
    const ir = lower(
      parseSpec(
        [...CLI_HEAD, "evaluation:", "  grader: {type: llm_judge, criteria: helpful}"].join("\n"),
      ),
    );
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.evaluation).toEqual({
      grader: { type: "llm_judge", criteria: "helpful" },
      threshold: 0.7,
      onFail: "retry",
      maxRetries: 1,
    });
  });

  test("declared knobs carry verbatim; snake_case renames to camelCase", () => {
    const ir = lower(
      parseSpec(
        [
          ...CLI_HEAD,
          "evaluation:",
          "  grader:",
          "    type: llm_judge",
          "    model: claude-haiku-4-5",
          "    criteria: cites a source",
          "  threshold: 0.9",
          "  on_fail: halt",
          "  max_retries: 4",
        ].join("\n"),
      ),
    );
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.evaluation).toEqual({
      grader: { type: "llm_judge", model: "claude-haiku-4-5", criteria: "cites a source" },
      threshold: 0.9,
      onFail: "halt",
      maxRetries: 4,
    });
  });

  test("deterministic graders carry NO threshold (pass/fail)", () => {
    const ir = lower(
      parseSpec(
        [
          ...CLI_HEAD,
          "evaluation:",
          "  grader: {type: contains, value: DONE}",
          "  on_fail: note",
        ].join("\n"),
      ),
    );
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.evaluation).toEqual({
      grader: { type: "contains", value: "DONE" },
      onFail: "note",
      maxRetries: 1,
    });
    expect(ir.evaluation && "threshold" in ir.evaluation).toBe(false);
  });

  test('the judge model "cheapest" resolves at compile time (item-25 aux slot)', () => {
    const ir = lower(
      parseSpec(
        [
          ...CLI_HEAD,
          "evaluation:",
          "  grader: {type: llm_judge, model: cheapest, criteria: helpful}",
        ].join("\n"),
      ),
    );
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.evaluation?.grader).toEqual({
      type: "llm_judge",
      model: "claude-haiku-4-5",
      criteria: "helpful",
    });
  });

  test("the key stays ABSENT when the spec omits the block", () => {
    const ir = lower(parseSpec(CLI_HEAD.join("\n")));
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect("evaluation" in ir).toBe(false);
  });

  test("channel and managed lower the block identically", () => {
    const channel = lower(
      parseSpec(
        [
          "name: ch",
          "target: channel",
          "agent: {model: m, instructions: i}",
          "channels:",
          "  slack: {botToken: $SLACK_BOT_TOKEN, signingSecret: $SLACK_SIGNING_SECRET}",
          "routing: {sessionKey: thread}",
          "evaluation:",
          "  grader: {type: regex, value: '^ok'}",
        ].join("\n"),
      ),
    );
    if (channel.target !== "channel") throw new Error("unexpected target");
    expect(channel.evaluation).toEqual({
      grader: { type: "regex", value: "^ok" },
      onFail: "retry",
      maxRetries: 1,
    });

    const managed = lower(
      parseSpec(
        [
          "name: mg",
          "target: managed",
          "agent: {model: m, instructions: i}",
          "tenants:",
          "  - {id: t1, budget: {maxInputTokens: 10, maxOutputTokens: 10}}",
          "evaluation:",
          "  grader: {type: llm_judge, criteria: on brand}",
          "  threshold: 0.6",
        ].join("\n"),
      ),
    );
    if (managed.target !== "managed") throw new Error("unexpected target");
    expect(managed.evaluation?.threshold).toBe(0.6);
  });
});

describe("kind: judge lowering (workflow steps + graph nodes)", () => {
  const WF = [
    "name: w",
    "target: workflow",
    "model: claude-opus-4-7",
    "steps:",
    "  - name: draft",
    "    instructions: write it",
    "  - name: gate",
    "    kind: judge",
    "    judge:",
    "      criteria: mentions the deadline",
  ];

  test("judge steps resolve gate defaults; instructions carry the criteria; model falls back to workflow.model", () => {
    const ir = lower(parseSpec(WF.join("\n")));
    if (ir.target !== "workflow") throw new Error("unexpected target");
    expect(ir.steps[1]).toEqual({
      name: "gate",
      kind: "judge",
      instructions: "mentions the deadline",
      model: "claude-opus-4-7",
      tools: [],
      toolConfigs: {},
      judge: {
        criteria: "mentions the deadline",
        threshold: 0.7,
        onFail: "retry_previous",
        maxRetries: 1,
      },
    });
    // Regular steps stay byte-identical: no kind/judge keys appear.
    const draft = ir.steps[0];
    expect(draft !== undefined && "kind" in draft).toBe(false);
    expect(draft !== undefined && "judge" in draft).toBe(false);
  });

  test('judge.model overrides the fallback and supports "cheapest"', () => {
    const ir = lower(
      parseSpec(
        [...WF, "      model: cheapest", "      threshold: 0.9", "      on_fail: halt"].join("\n"),
      ),
    );
    if (ir.target !== "workflow") throw new Error("unexpected target");
    const gate = ir.steps[1];
    expect(gate?.model).toBe("claude-haiku-4-5");
    expect(gate?.judge).toEqual({
      criteria: "mentions the deadline",
      threshold: 0.9,
      onFail: "halt",
      maxRetries: 1,
    });
  });

  test("graph judge nodes lower the same way", () => {
    const ir = lower(
      parseSpec(
        [
          "name: g",
          "target: graph",
          "model: claude-opus-4-7",
          "entry: a",
          "nodes:",
          "  a: {instructions: x}",
          "  gate:",
          "    kind: judge",
          "    judge:",
          "      criteria: grounded",
          "      max_retries: 3",
          "edges:",
          "  - {from: a, to: gate}",
        ].join("\n"),
      ),
    );
    if (ir.target !== "graph") throw new Error("unexpected target");
    expect(ir.nodes[1]).toEqual({
      name: "gate",
      kind: "judge",
      instructions: "grounded",
      model: "claude-opus-4-7",
      tools: [],
      toolConfigs: {},
      judge: { criteria: "grounded", threshold: 0.7, onFail: "retry_previous", maxRetries: 3 },
    });
  });
});

describe("Batch B keys are wired — compile() must NOT warn for them", () => {
  test("cli/channel/managed evaluation compiles warning-free", () => {
    const cli = compile(
      [...CLI_HEAD, "evaluation:", "  grader: {type: contains, value: ok}"].join("\n"),
    );
    expect(cli.warnings).toEqual([]);
    const managed = compile(
      [
        "name: mg",
        "target: managed",
        "agent: {model: m, instructions: i}",
        "tenants:",
        "  - {id: t1, budget: {maxInputTokens: 10, maxOutputTokens: 10}}",
        "evaluation:",
        "  grader: {type: llm_judge, criteria: x}",
      ].join("\n"),
    );
    expect(managed.warnings).toEqual([]);
  });

  test("judge steps/nodes compile warning-free (and through the validating passes)", () => {
    const wf = compile(
      [
        "name: w",
        "target: workflow",
        "model: m",
        "steps:",
        "  - {name: draft, instructions: x}",
        "  - name: gate",
        "    kind: judge",
        "    judge: {criteria: y}",
      ].join("\n"),
    );
    expect(wf.warnings).toEqual([]);
    expect(wf.files.length).toBeGreaterThan(0);

    const graph = compile(
      [
        "name: g",
        "target: graph",
        "model: m",
        "entry: a",
        "nodes:",
        "  a: {instructions: x}",
        "  gate:",
        "    kind: judge",
        "    judge: {criteria: y}",
        "edges:",
        "  - {from: a, to: gate}",
      ].join("\n"),
    );
    expect(graph.warnings).toEqual([]);
    expect(graph.files.length).toBeGreaterThan(0);
  });
});
