/**
 * Loop contract 0.4 (Batch B, G56) — per-sample loop-quality metrics
 * (tool-call accuracy, interventions, disjoint safety-violation buckets,
 * per-model-call latencies) extracted from trace events in `runSample`,
 * and the new `aggregate()` fields built on them.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import type { IrNode, IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import type {
  ModelResponseEvent,
  PermissionDecisionEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
  TraceEvent,
} from "@crewhaus/trace-event-bus";
import { aggregate } from "./aggregate";
import { type AgentInvoker, runEval } from "./index";
import type { SampleResult } from "./types";

const SPEC = `name: metrics-test
target: cli
agent:
  model: claude-opus-4-7
  instructions: test
`;

function narrowToAgent(ir: IrNode): IrV0 {
  if (ir.target !== "cli") throw new Error(`expected target:cli, got ${ir.target}`);
  return ir;
}

async function* yieldSamples(samples: Sample[]): AsyncIterable<Sample> {
  for (const s of samples) yield s;
}

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-metrics-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

/** Fully-formed envelope so fabricated events validate as TraceEvents. */
function envelope(ts: string) {
  return {
    runId: "run_test",
    sessionId: "sess_0000000000000000",
    turnNumber: 1,
    traceId: "0".repeat(32),
    spanId: "0".repeat(16),
    timestamp: ts,
  };
}

const T0 = "2026-07-17T00:00:00.000Z";

function toolPair(id: string, toolName: string): [ToolCallStartEvent, ToolCallEndEvent] {
  return [
    { ...envelope(T0), kind: "tool_call_start", toolUseId: id, toolName, inputBytes: 1 },
    {
      ...envelope(T0),
      kind: "tool_call_end",
      toolUseId: id,
      toolName,
      isError: false,
      outputBytes: 1,
      durationMs: 1,
    },
  ];
}

function modelResponse(durationMs: number): ModelResponseEvent {
  return {
    ...envelope(T0),
    kind: "model_response",
    model: "claude-test",
    stopReason: "end_turn",
    usage: { input: 10, output: 5 },
    durationMs,
  };
}

function permission(
  fields: Partial<PermissionDecisionEvent> & { decision: "allow" | "deny" | "ask" },
): PermissionDecisionEvent {
  return {
    ...envelope(T0),
    kind: "permission_decision",
    toolName: "bash",
    mode: "auto",
    ...fields,
  };
}

const GRADERS = "graders:\n  - name: m\n    type: exact_match\n";

describe("runSample metrics (G56)", () => {
  test("tool accuracy, interventions, and DISJOINT safety buckets", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const events: TraceEvent[] = [
      modelResponse(100),
      modelResponse(300),
      ...toolPair("t1", "bash"),
      ...toolPair("t2", "bash"), // duplicate tool — coverage counts unique names
      permission({ decision: "deny" }), // plain permission denial
      permission({ decision: "deny", judgeModel: "rule-based" }), // justification rejection
      permission({ decision: "deny", outcome: "egress-blocked" }), // egress block (also a deny!)
      permission({ decision: "allow", outcome: "egress-passed" }), // clean egress — not a violation
      permission({ decision: "ask" }), // pre-prompt publish — NOT an intervention
      permission({ decision: "ask", askOutcome: "denied" }), // resolved ask — intervention
    ];
    const invoker: AgentInvoker = async ({ sample }) => ({
      agentOutput: sample.expected_output ?? "",
      events,
    });
    const { compiled } = parseGradersConfig(GRADERS);
    const summary = await runEval({
      ir,
      dataset: {
        name: "m1",
        samples: yieldSamples([
          { id: "s1", input: "x", expected_output: "y", expected_tools: ["bash", "read"] },
        ]),
      },
      compiledGraders: compiled,
      opts: { invoker, outDir },
    });

    const m = summary.samples[0]?.metrics;
    expect(m?.toolCallAccuracy).toBeCloseTo(0.5); // bash hit, read missed
    expect(m?.interventions).toBe(1);
    expect(m?.safetyViolations).toEqual({
      permissionDenials: 1,
      egressBlocks: 1,
      justificationRejections: 1,
      total: 3,
    });
    expect(m?.modelCallLatenciesMs).toEqual([100, 300]);

    // Aggregates built on the sample metrics.
    expect(summary.aggregates.toolCallAccuracy).toBeCloseTo(0.5);
    expect(summary.aggregates.interventionRate).toBe(1);
    expect(summary.aggregates.safetyViolations?.total).toBe(3);
    expect(summary.aggregates.p50ModelCallMs).toBeCloseTo(200);
    expect(summary.aggregates.p95ModelCallMs).toBeCloseTo(290);

    // metrics also persist into the per-sample meta.json.
    const meta = JSON.parse(readFileSync(join(outDir, "s1", "meta.json"), "utf-8"));
    expect(meta.metrics.safetyViolations.total).toBe(3);
  });

  test("no expected_tools → no toolCallAccuracy (absent, not 1.0)", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const invoker: AgentInvoker = async ({ sample }) => ({
      agentOutput: sample.expected_output ?? "",
      events: [],
    });
    const { compiled } = parseGradersConfig(GRADERS);
    const summary = await runEval({
      ir,
      dataset: {
        name: "m2",
        samples: yieldSamples([{ id: "s1", input: "x", expected_output: "y" }]),
      },
      compiledGraders: compiled,
      opts: { invoker, outDir },
    });
    expect(summary.samples[0]?.metrics?.toolCallAccuracy).toBeUndefined();
    expect(summary.aggregates.toolCallAccuracy).toBeUndefined();
    expect(summary.samples[0]?.metrics?.interventions).toBe(0);
    expect(summary.aggregates.interventionRate).toBe(0);
    expect(summary.aggregates.safetyViolations?.total).toBe(0);
  });
});

function mockResult(overrides: Partial<SampleResult> & { sampleId: string }): SampleResult {
  return {
    sessionId: "sess",
    startedAt: T0,
    endedAt: T0,
    latencyMs: 10,
    turns: 1,
    tokens: { input: 0, output: 0 },
    model: "m",
    agentOutput: "",
    grades: { overall: { passed: true, score: 1, rationale: "ok" }, perGrader: [] },
    ...overrides,
  };
}

describe("aggregate — G56 fields", () => {
  test("partialScoreMean counts errored samples; meanScore does not", () => {
    const agg = aggregate([
      mockResult({ sampleId: "a" }), // score 1
      mockResult({
        sampleId: "b",
        grades: { overall: { passed: false, score: 0.5, rationale: "half" }, perGrader: [] },
      }),
      mockResult({
        sampleId: "c",
        error: "boom",
        grades: { overall: { passed: false, score: 0, rationale: "err" }, perGrader: [] },
      }),
    ]);
    expect(agg.meanScore).toBeCloseTo(0.75); // ok-only: (1 + 0.5) / 2
    expect(agg.partialScoreMean).toBeCloseTo(0.5); // all: (1 + 0.5 + 0) / 3
  });

  test("tolerates samples without metrics (older results.json shapes)", () => {
    const agg = aggregate([mockResult({ sampleId: "a" })]);
    expect(agg.interventionRate).toBe(0);
    expect(agg.safetyViolations?.total).toBe(0);
    expect(agg.p50ModelCallMs).toBe(0);
    expect(agg.toolCallAccuracy).toBeUndefined();
  });
});
