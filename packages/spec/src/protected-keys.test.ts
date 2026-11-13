/**
 * `protected:` on the three blocks that set a quality bar: the in-loop
 * `evaluation:`, the object form of `provability:` and a step's or node's
 * `judge:` gate. Each takes a boolean and nothing else.
 */
import { describe, expect, test } from "bun:test";
import { parseSpec } from "./index";

const CLI = (evaluation: string, provability: string) => `name: c
target: cli
agent: { model: m, instructions: hi }
evaluation:
  grader: { type: llm_judge, criteria: be good }
${evaluation}provability:
  level: cited
${provability}`;

const WORKFLOW = (extra: string) => `name: w
target: workflow
model: m
steps:
  - name: draft
    instructions: Draft.
  - name: gate
    kind: judge
    judge:
      criteria: is it right
${extra}`;

const GRAPH = (extra: string) => `name: g
target: graph
model: m
entry: a
nodes:
  a:
    instructions: Do it.
  gate:
    kind: judge
    judge:
      criteria: is it right
${extra}edges: [{ from: a, to: gate }]
`;

describe("protected", () => {
  test("each block accepts it", () => {
    const cli = parseSpec(CLI("  protected: true\n", "  protected: true\n"));
    expect(cli.target === "cli" && cli.evaluation?.protected).toBe(true);
    expect(
      cli.target === "cli" && typeof cli.provability === "object" && cli.provability.protected,
    ).toBe(true);
    const wf = parseSpec(WORKFLOW("      protected: true\n"));
    expect(
      wf.target === "workflow" && wf.steps.some((s) => "judge" in s && s.judge?.protected === true),
    ).toBe(true);
    const graph = parseSpec(GRAPH("      protected: false\n"));
    expect(
      graph.target === "graph" &&
        Object.values(graph.nodes).some((n) => "judge" in n && n.judge?.protected === false),
    ).toBe(true);
  });

  test("each block refuses a value that is not a boolean", () => {
    expect(() => parseSpec(CLI("  protected: yes please\n", ""))).toThrow(/protected/);
    expect(() => parseSpec(CLI("", "  protected: 1\n"))).toThrow(/protected/);
    // A step or node is a union, so its error names the entry, not the key;
    // the same spec with a boolean parses (above).
    expect(() => parseSpec(WORKFLOW('      protected: "true"\n'))).toThrow(/steps\.1/);
    expect(() => parseSpec(GRAPH("      protected: 0\n"))).toThrow(/spec validation failed/);
  });
});
