import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sample } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import type {
  ModelResponseEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
  TraceEvent,
} from "@crewhaus/trace-event-bus";
import { combineGraderEntries, runSample } from "./run-sample";
import type { AgentInvoker, GraderEntry } from "./types";

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-run-sample-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

const SAMPLE: Sample = { id: "s1", input: "hi", expected_output: "ok" };

/** Build a fully-formed envelope so published events validate as TraceEvents. */
function envelope(timestamp: string) {
  return {
    runId: "run_test",
    sessionId: "sess_0000000000000000",
    turnNumber: 1,
    traceId: "0".repeat(32),
    spanId: "0".repeat(16),
    timestamp,
  };
}

function toolStart(toolUseId: string, toolName: string, ts: string): ToolCallStartEvent {
  return { ...envelope(ts), kind: "tool_call_start", toolUseId, toolName, inputBytes: 1 };
}
function toolEnd(
  toolUseId: string,
  toolName: string,
  ts: string,
  isError = false,
): ToolCallEndEvent {
  return {
    ...envelope(ts),
    kind: "tool_call_end",
    toolUseId,
    toolName,
    isError,
    outputBytes: 1,
    durationMs: 1,
  };
}
function modelResponse(input: number, output: number, ts: string): ModelResponseEvent {
  return {
    ...envelope(ts),
    kind: "model_response",
    model: "claude-test",
    stopReason: "end_turn",
    usage: { input, output },
    durationMs: 1,
  };
}

const EXACT: GraderEntry[] = (() => {
  const { compiled } = parseGradersConfig("graders:\n  - name: m\n    type: exact_match\n");
  return compiled.map((g) => ({ name: g.name, grader: g.grader }));
})();

describe("runSample — bus capture, token/tool extraction", () => {
  test("captures bus events, sums tokens, extracts ordered tool calls", async () => {
    const outDir = newTempRoot();
    // Invoker that publishes trace events through the per-sample bus and does
    // NOT supply `events` (so runSample falls back to the captured array,
    // exercising the subscribe callback + extractToolCalls + sumTokens).
    const invoker: AgentInvoker = async ({ runContext }) => {
      const bus = runContext.eventBus;
      // Emit tool calls out of timestamp order to prove the sort in
      // extractToolCalls; the "later" start has an earlier timestamp.
      bus.publish(toolStart("u2", "bash", "2026-01-01T00:00:02.000Z"));
      bus.publish(toolStart("u1", "read", "2026-01-01T00:00:01.000Z"));
      bus.publish(toolEnd("u2", "bash", "2026-01-01T00:00:03.000Z", true));
      bus.publish(toolEnd("u1", "read", "2026-01-01T00:00:04.000Z"));
      // A tool_call_end with no matching start → falls back to its own ts.
      bus.publish(toolEnd("orphan", "glob", "2026-01-01T00:00:00.500Z"));
      bus.publish(modelResponse(10, 5, "2026-01-01T00:00:05.000Z"));
      bus.publish(modelResponse(3, 2, "2026-01-01T00:00:06.000Z"));
      return { agentOutput: "ok" };
    };

    const result = await runSample({
      sample: SAMPLE,
      invoker,
      graders: EXACT,
      outDir,
      model: "claude-test",
    });

    expect(result.tokens).toEqual({ input: 13, output: 7 });
    // events.jsonl persisted with the captured events.
    const eventsRaw = readFileSync(join(outDir, "s1", "events.jsonl"), "utf-8");
    const lines = eventsRaw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as TraceEvent);
    expect(lines).toHaveLength(7);
    // grades.json + meta.json written.
    expect(existsSync(join(outDir, "s1", "grades.json"))).toBe(true);
    const meta = JSON.parse(readFileSync(join(outDir, "s1", "meta.json"), "utf-8"));
    expect(meta.tokens).toEqual({ input: 13, output: 7 });
    expect(result.grades.overall.passed).toBe(true);
  });

  test("stub-supplied transcript is written verbatim and turns counted", async () => {
    const outDir = newTempRoot();
    const transcript = [
      { ts: 1, version: 1 as const, kind: "user_message" as const, payload: { text: "hi" } },
      {
        ts: 2,
        version: 1 as const,
        kind: "assistant_message" as const,
        payload: { text: "ok" },
      },
      {
        ts: 3,
        version: 1 as const,
        kind: "assistant_message" as const,
        payload: { text: "more" },
      },
    ];
    const invoker: AgentInvoker = async () => ({ agentOutput: "ok", transcript, events: [] });
    const result = await runSample({
      sample: SAMPLE,
      invoker,
      graders: EXACT,
      outDir,
      model: "claude-test",
    });
    // transcript.jsonl written by runSample (stub branch).
    const tRaw = readFileSync(join(outDir, "s1", "transcript.jsonl"), "utf-8");
    expect(tRaw.trim().split("\n")).toHaveLength(3);
    expect(result.turns).toBe(2); // two assistant_message events
  });

  test("B14 — seeded history rides the transcript but never the metrics", async () => {
    const outDir = newTempRoot();
    const sample: Sample = {
      id: "mt1",
      input: "and Japan?",
      history: [
        { role: "user", content: "capital of Brazil?" },
        { role: "assistant", content: "Brasília." },
      ],
      expected_output: "ok",
      expected_tools: ["bash"],
    };
    // The invoker mimics the default chat-loop path: seeded history lands in
    // the transcript VERBATIM (as the runtime's seed logging does), while the
    // bus sees only the FINAL turn's work — seeding publishes no trace
    // events, which is exactly what this test pins.
    const transcript = [
      {
        ts: 1,
        version: 1 as const,
        kind: "user_message" as const,
        payload: { text: "capital of Brazil?" },
      },
      {
        ts: 2,
        version: 1 as const,
        kind: "assistant_message" as const,
        payload: { text: "Brasília." },
      },
      {
        ts: 3,
        version: 1 as const,
        kind: "user_message" as const,
        payload: { text: "and Japan?" },
      },
      { ts: 4, version: 1 as const, kind: "assistant_message" as const, payload: { text: "ok" } },
    ];
    const invoker: AgentInvoker = async ({ runContext }) => {
      const bus = runContext.eventBus;
      bus.publish(toolStart("u1", "bash", "2026-01-01T00:00:01.000Z"));
      bus.publish(toolEnd("u1", "bash", "2026-01-01T00:00:02.000Z"));
      bus.publish(modelResponse(20, 8, "2026-01-01T00:00:03.000Z"));
      return { agentOutput: "ok", transcript };
    };
    const result = await runSample({
      sample,
      invoker,
      graders: EXACT,
      outDir,
      model: "claude-test",
    });
    // The full conversation persisted — transcript-target judges see it all.
    const tRaw = readFileSync(join(outDir, "mt1", "transcript.jsonl"), "utf-8");
    expect(tRaw.trim().split("\n")).toHaveLength(4);
    // `turns` counts only the invocation's own assistant turn, not the
    // seeded history assistant message.
    expect(result.turns).toBe(1);
    // Tool metrics come from the bus events — final-turn work only.
    expect(result.metrics?.toolCallAccuracy).toBe(1);
    expect(result.tokens).toEqual({ input: 20, output: 8 });
    expect(result.metrics?.modelCallLatenciesMs).toEqual([1]);
    expect(result.grades.overall.passed).toBe(true);
  });

  test("renames an invoker-written auto-named event-log file to transcript.jsonl", async () => {
    const outDir = newTempRoot();
    // Invoker writes <sessionId>.jsonl into sessionRootDir (mimics runChatLoop).
    const invoker: AgentInvoker = async ({ runContext, sessionRootDir }) => {
      const auto = join(sessionRootDir, `${runContext.sessionId}.jsonl`);
      writeFileSync(
        auto,
        `${JSON.stringify({ ts: 1, version: 1, kind: "assistant_message", payload: {} })}\n`,
      );
      return { agentOutput: "ok" };
    };
    const result = await runSample({
      sample: SAMPLE,
      invoker,
      graders: EXACT,
      outDir,
      model: "claude-test",
    });
    expect(existsSync(join(outDir, "s1", "transcript.jsonl"))).toBe(true);
    expect(existsSync(join(outDir, "s1", `${result.sessionId}.jsonl`))).toBe(false);
    expect(result.turns).toBe(1);
  });

  test("an empty captured run writes an empty transcript.jsonl", async () => {
    const outDir = newTempRoot();
    // No transcript, no events, no on-disk log → final else branch writes "".
    const invoker: AgentInvoker = async () => ({ agentOutput: "ok", events: [] });
    await runSample({
      sample: SAMPLE,
      invoker,
      graders: EXACT,
      outDir,
      model: "claude-test",
    });
    expect(readFileSync(join(outDir, "s1", "transcript.jsonl"), "utf-8")).toBe("");
    expect(readFileSync(join(outDir, "s1", "events.jsonl"), "utf-8")).toBe("");
  });

  test("a grader that throws is captured as a failed perGrader entry", async () => {
    const outDir = newTempRoot();
    const graders: GraderEntry[] = [
      {
        name: "boom",
        grader: async () => {
          throw new Error("grader kaboom");
        },
      },
      {
        name: "nonError",
        grader: async () => {
          // Throw a non-Error to exercise the String(err) branch.
          throw "stringly-typed";
        },
      },
    ];
    const invoker: AgentInvoker = async () => ({ agentOutput: "x", events: [] });
    const result = await runSample({
      sample: SAMPLE,
      invoker,
      graders,
      outDir,
      model: "claude-test",
    });
    const boom = result.grades.perGrader.find((g) => g.name === "boom");
    expect(boom?.passed).toBe(false);
    expect(boom?.rationale).toContain("grader threw: grader kaboom");
    const nonError = result.grades.perGrader.find((g) => g.name === "nonError");
    expect(nonError?.rationale).toContain("stringly-typed");
    expect(result.grades.overall.passed).toBe(false);
  });

  test("sanitizes path-separator-laden sample ids into a flat dir", async () => {
    const outDir = newTempRoot();
    const invoker: AgentInvoker = async () => ({ agentOutput: "ok", events: [] });
    const result = await runSample({
      sample: { id: "a/b:c d", input: "x", expected_output: "y" },
      invoker,
      graders: EXACT,
      outDir,
      model: "claude-test",
    });
    // sampleId is preserved in the result, but the dir name is sanitized.
    expect(result.sampleId).toBe("a/b:c d");
    expect(existsSync(join(outDir, "a_b_c_d", "meta.json"))).toBe(true);
  });

  test("seed is threaded into the request and persisted in meta.json", async () => {
    const outDir = newTempRoot();
    let seenSeed: number | undefined;
    const invoker: AgentInvoker = async ({ seed }) => {
      seenSeed = seed;
      return { agentOutput: "ok", events: [] };
    };
    await runSample({
      sample: SAMPLE,
      invoker,
      graders: EXACT,
      outDir,
      model: "claude-test",
      seed: 1234,
    });
    expect(seenSeed).toBe(1234);
    const meta = JSON.parse(readFileSync(join(outDir, "s1", "meta.json"), "utf-8"));
    expect(meta.seed).toBe(1234);
  });
});

describe("combineGraderEntries", () => {
  test("combines compiled graders into a single Grader", async () => {
    const { compiled } = parseGradersConfig(
      "graders:\n  - name: a\n    type: contains\n    substring: ok\n",
    );
    const combined = combineGraderEntries(compiled);
    const res = await combined(SAMPLE, {
      agentOutput: "this is ok",
      events: [],
      transcript: [],
      toolCalls: [],
      turns: 1,
      latencyMs: 0,
    });
    expect(res.passed).toBe(true);
  });
});
