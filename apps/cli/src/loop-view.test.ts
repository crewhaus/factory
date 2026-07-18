/**
 * Loop contract 0.4 (Batch B, G42) — unit tests for the human-readable
 * `compile --emit-loop` rendering. Driven through the REAL pipeline
 * (parseSpec → lower → projectLoop) so the rendering is exercised against
 * the wire-contract projection, not hand-built fixtures.
 */
import { describe, expect, test } from "bun:test";
import { lower } from "@crewhaus/compiler";
import { projectLoop } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import { formatLoopProjection } from "./loop-view";

const CLI_SPEC = `
name: support-cli
target: cli
agent:
  model: claude-opus-4-7
  instructions: Help users.
tools:
  - webFetch
  - read
evaluation:
  grader:
    type: llm_judge
    criteria: reply cites a source
  threshold: 0.8
  on_fail: retry
  max_retries: 2
`;

const WORKFLOW_SPEC = `
name: gated-wf
target: workflow
model: claude-opus-4-7
steps:
  - name: draft
    instructions: Draft the reply.
  - name: gate
    kind: judge
    judge:
      criteria: the draft is polite
      on_fail: retry_previous
      max_retries: 2
`;

describe("formatLoopProjection — ring targets", () => {
  const lines = formatLoopProjection(projectLoop(lower(parseSpec(CLI_SPEC))));

  test("header names the target and projection kind", () => {
    expect(lines[0]).toBe("loop projection: cli (ring)");
  });

  test("all seven segments render, active ● / inactive ○, with spec keys", () => {
    const segmentLines = lines.filter((l) => /^ {2}[●○] /.test(l));
    expect(segmentLines).toHaveLength(7);
    // evaluate is lit by the Batch B evaluation: block, keys listed.
    const evaluate = segmentLines.find((l) => l.includes("evaluate"));
    expect(evaluate).toContain("●");
    expect(evaluate).toContain("in-loop evaluation (llm_judge, threshold 0.8, on fail: retry");
    expect(evaluate).toContain("[evaluation]");
    // No budget/limits: stop is inactive.
    const stop = segmentLines.find((l) => l.includes("stop"));
    expect(stop).toContain("○");
  });

  test("the defaults-only Stop warning surfaces verbatim", () => {
    expect(lines).toContain("warnings:");
    expect(
      lines.some((l) => l.includes("no budget: — stops only at the 500-iteration default")),
    ).toBe(true);
  });
});

describe("formatLoopProjection — canvas targets", () => {
  const lines = formatLoopProjection(projectLoop(lower(parseSpec(WORKFLOW_SPEC))));

  test("header, node and edge sections render", () => {
    expect(lines[0]).toBe("loop projection: workflow (canvas)");
    expect(lines).toContain("nodes (2):");
    // Two edges: draft → gate, plus the retry_previous back-edge.
    expect(lines).toContain("edges (2):");
  });

  test("nodes list only their ACTIVE mini segments", () => {
    expect(lines.some((l) => l.includes("1. draft <step>"))).toBe(true);
    expect(lines.some((l) => l.includes("2. gate <step>"))).toBe(true);
    // The judge step's evaluate mini segment is active.
    expect(
      lines.some((l) => l.includes("judge gate (threshold 0.7, on fail: retry_previous)")),
    ).toBe(true);
    // Inactive minis are omitted from node blocks (no ○ inside a node).
    expect(lines.filter((l) => /^ {4}○ /.test(l))).toHaveLength(0);
  });

  test("the retry_previous back-edge renders with its label and condition marker", () => {
    expect(
      lines.some(
        (l) => l.includes("gate → draft") && l.includes("retry ≤ 2") && l.includes("(conditional)"),
      ),
    ).toBe(true);
  });
});
