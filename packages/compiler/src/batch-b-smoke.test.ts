/**
 * Loop contract 0.4 — Batch B verifier smoke test. End-to-end checks that the
 * batch's headline surfaces hang together as one pipeline (spec key → IR →
 * emitter → projection), plus a field-level conformance pin of the projection
 * goldens against the STUDIO's `LoopProjection` wire contract:
 *
 *   1. a cli spec with `evaluation:` compiles WARNING-FREE and the bundle
 *      bytes contain the in-loop evaluate wiring (G02 — wired, not
 *      accepted-but-unwired);
 *   2. a workflow with a `kind: "judge"` step round-trips: parse → lower
 *      keeps the resolved judge gate, the emitted bundle carries the
 *      `judge_verdict` gate wiring, `projectLoop` lights the gate node, and
 *      re-lowering the same YAML reproduces the identical IR;
 *   3. every entry in `__fixtures__/loop-projections.golden.json` conforms
 *      field-for-field to the studio's `LoopProjection` type (see the
 *      compatibility table below — asserted structurally at runtime, no
 *      cross-repo import).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { NO_BUDGET_WARNING, SEGMENT_ORDER, projectLoop } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import { compile, lower } from "./index";

// ---------------------------------------------------------------------------
// 1. cli `evaluation:` — warning-free compile, evaluate wiring in the bytes
// ---------------------------------------------------------------------------

const CLI_EVAL_SPEC = `
name: smoke-eval-cli
target: cli
agent:
  model: claude-opus-4-7
  instructions: Answer carefully and cite sources.
limits:
  max_tool_iterations: 25
evaluation:
  grader:
    type: llm_judge
    criteria: helpful and cites a source
  threshold: 0.8
  on_fail: retry
  max_retries: 2
`;

describe("Batch B smoke — cli evaluation: compiles warning-free with wired evaluate", () => {
  const result = compile(CLI_EVAL_SPEC);
  const agent = result.files.find((f) => f.path === "agent.ts")?.content ?? "";

  test("compile() emits zero warnings (evaluation + limits are WIRED keys)", () => {
    expect(result.warnings).toEqual([]);
  });

  test("bundle bytes contain the in-loop evaluate wiring", () => {
    expect(agent).toContain('import type { RunEvaluation } from "@crewhaus/runtime-core";');
    expect(agent).toContain('import { judge } from "@crewhaus/eval-judge";');
    expect(agent).toContain("const __evaluation: RunEvaluation = {");
    expect(agent).toContain('graderType: "llm_judge"');
    expect(agent).toContain("threshold: 0.8");
    expect(agent).toContain("maxRetries: 2");
    expect(agent).toContain("helpful and cites a source");
    // The run-options field that hands the evaluate fn to the runtime loop.
    expect(agent).toContain("evaluation: __evaluation,");
  });
});

// ---------------------------------------------------------------------------
// 2. workflow judge step — full round trip
// ---------------------------------------------------------------------------

const WORKFLOW_JUDGE_SPEC = `
name: smoke-judge-wf
target: workflow
model: claude-opus-4-7
steps:
  - name: draft
    instructions: Write the report.
  - name: gate
    kind: judge
    judge:
      criteria: cites at least two sources
      threshold: 0.9
      on_fail: retry_previous
      max_retries: 2
  - name: publish
    instructions: Format and publish.
`;

describe("Batch B smoke — workflow judge step round-trips", () => {
  const ir = lower(parseSpec(WORKFLOW_JUDGE_SPEC));

  test("lower() keeps the judge gate with its declared knobs resolved", () => {
    if (ir.target !== "workflow") throw new Error("unexpected target");
    const gate = ir.steps.find((s) => s.name === "gate");
    expect(gate?.kind).toBe("judge");
    expect(gate?.judge).toEqual({
      criteria: "cites at least two sources",
      threshold: 0.9,
      onFail: "retry_previous",
      maxRetries: 2,
    });
    // Judge model falls back to the workflow model (aux-model machinery).
    expect(gate?.model).toBe("claude-opus-4-7");
  });

  test("the compiled bundle is warning-free and carries the judge gate wiring", () => {
    const result = compile(WORKFLOW_JUDGE_SPEC);
    expect(result.warnings).toEqual([]);
    const agent = result.files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agent).toContain('kind: "judge_verdict",');
    expect(agent).toContain("cites at least two sources");
  });

  test("projectLoop() lights the gate node's evaluate mini and the pass edge", () => {
    const projection = projectLoop(ir);
    if (projection.kind !== "canvas") throw new Error("expected canvas projection");
    const gate = projection.canvas?.nodes.find((n) => n.id === "gate");
    const evaluate = gate?.mini.find((s) => s.id === "evaluate");
    expect(evaluate?.active).toBe(true);
    expect(evaluate?.keys).toEqual(["judge"]);
    expect(projection.canvas?.edges).toContainEqual({
      from: "gate",
      to: "publish",
      label: "pass",
      conditional: true,
    });
  });

  test("re-lowering the same YAML reproduces the identical IR (deterministic round trip)", () => {
    expect(lower(parseSpec(WORKFLOW_JUDGE_SPEC))).toEqual(ir);
  });
});

// ---------------------------------------------------------------------------
// 3. projection goldens conform to the STUDIO LoopProjection wire contract
// ---------------------------------------------------------------------------
//
// Field-level compatibility table — factory `@crewhaus/ir` loop.ts vs the
// studio's `studio-pwa/src/lib/loop-model.ts` (read 2026-07-17; asserted
// structurally below, NO cross-repo import):
//
// | wire field                  | studio loop-model.ts            | factory ir/loop.ts | match |
// |-----------------------------|---------------------------------|--------------------|-------|
// | LoopProjection.kind         | "ring" \| "canvas"        (L113)| identical          |  yes  |
// | LoopProjection.target       | string                    (L114)| identical          |  yes  |
// | LoopProjection.ring?        | LoopRing                  (L115)| identical          |  yes  |
// | LoopProjection.canvas?      | LoopCanvas                (L116)| identical          |  yes  |
// | LoopProjection.warnings     | readonly string[]         (L117)| identical          |  yes  |
// | LoopRing.segments           | readonly LoopSegment[]     (L72)| identical          |  yes  |
// | LoopSegment.id              | LoopSegmentId (7 ids)      (L64)| identical          |  yes  |
// | LoopSegment.active          | boolean                    (L65)| identical          |  yes  |
// | LoopSegment.keys            | readonly string[]          (L66)| identical          |  yes  |
// | LoopSegment.summary         | string                     (L67)| identical          |  yes  |
// | LoopNode.id / .label        | string                  (L84-85)| identical          |  yes  |
// | LoopNode.kind               | "step"|"node"|"role"|"doc" (L86)| identical          |  yes  |
// | LoopNode.hitl?              | boolean                    (L87)| identical          |  yes  |
// | LoopNode.mini               | readonly LoopSegment[]     (L88)| identical          |  yes  |
// | LoopEdge.from / .to         | string                  (L93-94)| identical          |  yes  |
// | LoopEdge.label?             | string                     (L95)| identical          |  yes  |
// | LoopEdge.conditional?       | boolean                    (L96)| identical          |  yes  |
// | SEGMENT_ORDER               | 7 ids, canonical order  (L46-54)| identical          |  yes  |
// | NO_BUDGET_WARNING           | exact string              (L144)| identical          |  yes  |
//
// (Semantic deltas are allowed by the contract — e.g. the IR projection
// lights `update` for default-on continuity while the raw-spec studio
// projection cannot; the WIRE SHAPE above is what must not drift.)

/** Transcribed from studio loop-model.ts L46-54 — the canonical order. */
const STUDIO_SEGMENT_ORDER = [
  "perceive",
  "reason",
  "act",
  "evaluate",
  "update",
  "stop",
  "safety",
] as const;

/** Transcribed from studio loop-model.ts L76. */
const STUDIO_NODE_KINDS = new Set(["step", "node", "role", "doc"]);

/** Transcribed from studio loop-model.ts L144 — shared verbatim. */
const STUDIO_NO_BUDGET_WARNING = "no budget: — stops only at the 500-iteration default";

type Rec = Record<string, unknown>;

function asRec(v: unknown, what: string): Rec {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`${what} is not an object`);
  }
  return v as Rec;
}

function expectSegments(v: unknown, what: string): void {
  expect(Array.isArray(v)).toBe(true);
  const segments = v as unknown[];
  expect(segments.map((s) => asRec(s, `${what} segment`)["id"])).toEqual([...STUDIO_SEGMENT_ORDER]);
  for (const raw of segments) {
    const seg = asRec(raw, `${what} segment`);
    expect(Object.keys(seg).sort()).toEqual(["active", "id", "keys", "summary"]);
    expect(typeof seg["active"]).toBe("boolean");
    expect(typeof seg["summary"]).toBe("string");
    expect(Array.isArray(seg["keys"])).toBe(true);
    for (const k of seg["keys"] as unknown[]) expect(typeof k).toBe("string");
  }
}

describe("Batch B smoke — projection goldens match the studio LoopProjection wire shape", () => {
  const goldens = JSON.parse(
    readFileSync(new URL("./__fixtures__/loop-projections.golden.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;

  test("factory SEGMENT_ORDER and NO_BUDGET_WARNING pin to the studio's", () => {
    expect([...SEGMENT_ORDER]).toEqual([...STUDIO_SEGMENT_ORDER]);
    expect(NO_BUDGET_WARNING).toBe(STUDIO_NO_BUDGET_WARNING);
  });

  for (const [name, raw] of Object.entries(goldens)) {
    test(`golden "${name}" conforms field-for-field`, () => {
      const projection = asRec(raw, "projection");
      // Top level: kind/target/warnings + exactly one of ring|canvas.
      const kind = projection["kind"];
      expect(kind === "ring" || kind === "canvas").toBe(true);
      expect(typeof projection["target"]).toBe("string");
      expect(Array.isArray(projection["warnings"])).toBe(true);
      for (const w of projection["warnings"] as unknown[]) expect(typeof w).toBe("string");
      const expectedKeys =
        kind === "ring"
          ? ["kind", "ring", "target", "warnings"]
          : ["canvas", "kind", "target", "warnings"];
      expect(Object.keys(projection).sort()).toEqual(expectedKeys);

      if (kind === "ring") {
        const ring = asRec(projection["ring"], "ring");
        expect(Object.keys(ring)).toEqual(["segments"]);
        expectSegments(ring["segments"], "ring");
        return;
      }

      const canvas = asRec(projection["canvas"], "canvas");
      expect(Object.keys(canvas).sort()).toEqual(["edges", "nodes"]);
      for (const rawNode of canvas["nodes"] as unknown[]) {
        const node = asRec(rawNode, "node");
        const keys = Object.keys(node).sort();
        const allowed =
          "hitl" in node
            ? ["hitl", "id", "kind", "label", "mini"]
            : ["id", "kind", "label", "mini"];
        expect(keys).toEqual(allowed);
        expect(typeof node["id"]).toBe("string");
        expect(typeof node["label"]).toBe("string");
        expect(STUDIO_NODE_KINDS.has(node["kind"] as string)).toBe(true);
        if ("hitl" in node) expect(typeof node["hitl"]).toBe("boolean");
        expectSegments(node["mini"], `node ${String(node["id"])}`);
      }
      for (const rawEdge of canvas["edges"] as unknown[]) {
        const edge = asRec(rawEdge, "edge");
        for (const key of Object.keys(edge)) {
          expect(["from", "to", "label", "conditional"]).toContain(key);
        }
        expect(typeof edge["from"]).toBe("string");
        expect(typeof edge["to"]).toBe("string");
        if ("label" in edge) expect(typeof edge["label"]).toBe("string");
        if ("conditional" in edge) expect(typeof edge["conditional"]).toBe("boolean");
      }
    });
  }
});
