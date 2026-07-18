/**
 * Loop contract 0.4 (Batch B, G02) — parse-level tests for the
 * `evaluation:` block (cli/channel/managed) and the `kind: "judge"`
 * workflow-step / graph-node variants. The spec layer carries declared
 * fields VERBATIM (defaults resolve at lower time in the compiler), so
 * these tests assert shape acceptance/rejection, not default values.
 */
import { describe, expect, test } from "bun:test";
import { SpecParseError, parseSpec } from "./index";

const cliWith = (block: string): string =>
  ["name: c", "target: cli", "agent:", "  model: m", "  instructions: i", block].join("\n");

describe("evaluation: block — accepted shapes", () => {
  test("llm_judge grader with every knob parses verbatim", () => {
    const spec = parseSpec(
      cliWith(
        [
          "evaluation:",
          "  grader:",
          "    type: llm_judge",
          "    model: claude-haiku-4-5",
          "    criteria: reply cites a source",
          "  threshold: 0.8",
          "  on_fail: halt",
          "  max_retries: 3",
        ].join("\n"),
      ),
    );
    if (spec.target !== "cli") throw new Error("unexpected target");
    expect(spec.evaluation).toEqual({
      grader: { type: "llm_judge", model: "claude-haiku-4-5", criteria: "reply cites a source" },
      threshold: 0.8,
      on_fail: "halt",
      max_retries: 3,
    });
  });

  test("minimal llm_judge grader parses with no defaults injected at parse time", () => {
    const spec = parseSpec(
      cliWith(
        ["evaluation:", "  grader:", "    type: llm_judge", "    criteria: helpful"].join("\n"),
      ),
    );
    if (spec.target !== "cli") throw new Error("unexpected target");
    expect(spec.evaluation).toEqual({ grader: { type: "llm_judge", criteria: "helpful" } });
  });

  test("contains and regex graders parse", () => {
    const contains = parseSpec(
      cliWith(["evaluation:", "  grader: {type: contains, value: DONE}"].join("\n")),
    );
    if (contains.target !== "cli") throw new Error("unexpected target");
    expect(contains.evaluation?.grader).toEqual({ type: "contains", value: "DONE" });

    const regex = parseSpec(
      cliWith(["evaluation:", '  grader: {type: regex, value: "^ok$"}'].join("\n")),
    );
    if (regex.target !== "cli") throw new Error("unexpected target");
    expect(regex.evaluation?.grader).toEqual({ type: "regex", value: "^ok$" });
  });

  test("channel and managed shapes accept the block", () => {
    const channel = parseSpec(
      [
        "name: ch",
        "target: channel",
        "agent:",
        "  model: m",
        "  instructions: i",
        "channels:",
        "  slack:",
        "    botToken: $SLACK_BOT_TOKEN",
        "    signingSecret: $SLACK_SIGNING_SECRET",
        "routing:",
        "  sessionKey: thread",
        "evaluation:",
        "  grader: {type: contains, value: ok}",
      ].join("\n"),
    );
    if (channel.target !== "channel") throw new Error("unexpected target");
    expect(channel.evaluation?.grader.type).toBe("contains");

    const managed = parseSpec(
      [
        "name: mg",
        "target: managed",
        "agent:",
        "  model: m",
        "  instructions: i",
        "tenants:",
        "  - id: t1",
        "    budget: {maxInputTokens: 1000, maxOutputTokens: 1000}",
        "evaluation:",
        "  grader: {type: llm_judge, criteria: on brand}",
      ].join("\n"),
    );
    if (managed.target !== "managed") throw new Error("unexpected target");
    expect(managed.evaluation?.grader.type).toBe("llm_judge");
  });
});

describe("evaluation: block — rejections", () => {
  test("threshold with a deterministic grader is rejected", () => {
    expect(() =>
      parseSpec(
        cliWith(
          ["evaluation:", "  grader: {type: contains, value: ok}", "  threshold: 0.5"].join("\n"),
        ),
      ),
    ).toThrow(/threshold applies to the llm_judge grader only/);
  });

  test("an invalid regex is rejected at parse time", () => {
    expect(() =>
      parseSpec(cliWith(["evaluation:", '  grader: {type: regex, value: "[unclosed"}'].join("\n"))),
    ).toThrow(/not a valid regular expression/);
  });

  test("unknown sub-keys, bad enums, and out-of-range max_retries fail the build", () => {
    expect(() =>
      parseSpec(
        cliWith(
          ["evaluation:", "  grader: {type: contains, value: ok}", "  on_failure: retry"].join(
            "\n",
          ),
        ),
      ),
    ).toThrow(SpecParseError);
    expect(() =>
      parseSpec(
        cliWith(
          ["evaluation:", "  grader: {type: contains, value: ok}", "  on_fail: explode"].join("\n"),
        ),
      ),
    ).toThrow(SpecParseError);
    for (const bad of [0, 6]) {
      expect(() =>
        parseSpec(
          cliWith(
            [
              "evaluation:",
              "  grader: {type: llm_judge, criteria: x}",
              `  max_retries: ${bad}`,
            ].join("\n"),
          ),
        ),
      ).toThrow(SpecParseError);
    }
  });

  test("shapes without the block reject it loudly (strict unions)", () => {
    expect(() =>
      parseSpec(
        [
          "name: w",
          "target: workflow",
          "model: m",
          "steps:",
          "  - name: a",
          "    instructions: x",
          "evaluation:",
          "  grader: {type: contains, value: ok}",
        ].join("\n"),
      ),
    ).toThrow(/Unrecognized key/);
  });
});

describe("kind: judge workflow steps", () => {
  const judgeWorkflow = (firstSteps: string): string =>
    ["name: w", "target: workflow", "model: claude-opus-4-7", "steps:", firstSteps].join("\n");

  test("a judge step after a regular step parses verbatim", () => {
    const spec = parseSpec(
      judgeWorkflow(
        [
          "  - name: draft",
          "    instructions: write it",
          "  - name: gate",
          "    kind: judge",
          "    judge:",
          "      criteria: mentions the deadline",
          "      model: claude-haiku-4-5",
          "      threshold: 0.9",
          "      on_fail: halt",
          "      max_retries: 2",
        ].join("\n"),
      ),
    );
    if (spec.target !== "workflow") throw new Error("unexpected target");
    expect(spec.steps[1]).toEqual({
      name: "gate",
      kind: "judge",
      judge: {
        criteria: "mentions the deadline",
        model: "claude-haiku-4-5",
        threshold: 0.9,
        on_fail: "halt",
        max_retries: 2,
      },
    });
  });

  test("the FIRST step cannot be a judge (nothing precedes it)", () => {
    expect(() =>
      parseSpec(
        judgeWorkflow(["  - name: gate", "    kind: judge", "    judge: {criteria: x}"].join("\n")),
      ),
    ).toThrow(/steps\[0\] "gate" cannot be a judge step/);
  });

  test("judge steps carry no instructions/tools (strict)", () => {
    expect(() =>
      parseSpec(
        judgeWorkflow(
          [
            "  - name: draft",
            "    instructions: write it",
            "  - name: gate",
            "    kind: judge",
            "    instructions: sneaky",
            "    judge: {criteria: x}",
          ].join("\n"),
        ),
      ),
    ).toThrow(SpecParseError);
  });

  test("kind must be the judge literal", () => {
    expect(() =>
      parseSpec(
        judgeWorkflow(
          [
            "  - name: draft",
            "    instructions: write it",
            "  - name: gate",
            "    kind: reviewer",
            "    judge: {criteria: x}",
          ].join("\n"),
        ),
      ),
    ).toThrow(SpecParseError);
  });
});

describe("kind: judge graph nodes", () => {
  test("a judge node with an upstream edge parses verbatim", () => {
    const spec = parseSpec(
      [
        "name: g",
        "target: graph",
        "model: claude-opus-4-7",
        "entry: draft",
        "nodes:",
        "  draft:",
        "    instructions: write it",
        "  gate:",
        "    kind: judge",
        "    judge:",
        "      criteria: factually grounded",
        "edges:",
        "  - {from: draft, to: gate}",
      ].join("\n"),
    );
    if (spec.target !== "graph") throw new Error("unexpected target");
    expect(spec.nodes["gate"]).toEqual({
      kind: "judge",
      judge: { criteria: "factually grounded" },
    });
  });

  test("the entry cannot be a judge node", () => {
    expect(() =>
      parseSpec(
        [
          "name: g",
          "target: graph",
          "model: m",
          "entry: gate",
          "nodes:",
          "  gate:",
          "    kind: judge",
          "    judge: {criteria: x}",
          "  work:",
          "    instructions: do it",
        ].join("\n"),
      ),
    ).toThrow(/entry "gate" cannot be a judge node/);
  });

  test("judge nodes reject agent-turn keys (strict)", () => {
    expect(() =>
      parseSpec(
        [
          "name: g",
          "target: graph",
          "model: m",
          "entry: a",
          "nodes:",
          "  a:",
          "    instructions: x",
          "  gate:",
          "    kind: judge",
          "    tools: [read]",
          "    judge: {criteria: x}",
        ].join("\n"),
      ),
    ).toThrow(SpecParseError);
  });
});
