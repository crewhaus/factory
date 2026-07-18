import { describe, expect, test } from "bun:test";
import type { CanonicalMessage, ProviderAdapter, StreamEvent } from "@crewhaus/adapter-anthropic";
import type { RegisteredTool, ToolExecuteResult } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { runWorkerLoop } from "./loop";
import type { WorkerPlatform } from "./platform";
import type { WorkerTraceEvent } from "./trace";

// --- test doubles ------------------------------------------------------------

function testPlatform(nowFn?: () => number): WorkerPlatform {
  let counter = 0;
  return {
    now: nowFn ?? (() => 1000),
    randomId: () => `id-${++counter}`,
    fetch: (async () => {
      throw new Error("fetch must not be called when an adapter is injected");
    }) as unknown as typeof fetch,
  };
}

/** An adapter that replays one scripted stream per `stream()` call. */
function scriptedAdapter(turns: StreamEvent[][]): {
  adapter: ProviderAdapter;
  callCount: () => number;
} {
  let i = 0;
  const adapter: ProviderAdapter = {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: false,
    },
    estimateTokens: (msgs) => msgs.length * 10,
    async *stream() {
      const turn = turns[i] ?? textTurn("(exhausted)");
      i += 1;
      for (const ev of turn) yield ev;
    },
  };
  return { adapter, callCount: () => i };
}

function textTurn(text: string, output = 5): StreamEvent[] {
  return [
    { kind: "message_start", usage: { input: 10, output: 0 } },
    { kind: "content_block_start", index: 0, block: { type: "text", text: "" } },
    { kind: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { kind: "content_block_stop", index: 0 },
    { kind: "message_delta", stopReason: "end_turn", usage: { input: 0, output } },
    { kind: "message_stop" },
  ];
}

function toolTurn(id: string, name: string, input: Record<string, unknown>): StreamEvent[] {
  return [
    { kind: "message_start", usage: { input: 10, output: 0 } },
    { kind: "content_block_start", index: 0, block: { type: "tool_use", id, name, input: {} } },
    {
      kind: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    },
    { kind: "content_block_stop", index: 0 },
    { kind: "message_delta", stopReason: "tool_use", usage: { input: 0, output: 3 } },
    { kind: "message_stop" },
  ];
}

function fakeTool(
  name: string,
  execute: (input: unknown) => ToolExecuteResult | Promise<ToolExecuteResult>,
): RegisteredTool {
  return {
    name,
    description: `${name} tool`,
    inputSchema: z.object({}).passthrough(),
    execute: async (input) => execute(input),
    concurrencySafe: false,
    readOnly: true,
    destructive: false,
    requiresSandbox: false,
    classifyOutput: false,
    scope: "internal",
    requireJustification: false,
  };
}

const seed: readonly CanonicalMessage[] = [{ role: "user", content: "hi" }];

// --- tests -------------------------------------------------------------------

describe("runWorkerLoop", () => {
  test("a text-only turn resolves done with the terminal text + usage", async () => {
    const { adapter, callCount } = scriptedAdapter([textTurn("hello world")]);
    const events: WorkerTraceEvent[] = [];
    const result = await runWorkerLoop({
      platform: testPlatform(),
      model: "claude-sonnet-4-5",
      instructions: "be helpful",
      messages: seed,
      adapter,
      emitTrace: (e) => events.push(e),
    });
    expect(result.stopReason).toBe("done");
    expect(result.text).toBe("hello world");
    expect(result.failure).toBeUndefined();
    expect(result.usage).toEqual({ input: 10, output: 5, cacheRead: 0, cacheCreate: 0 });
    expect(callCount()).toBe(1);
    // trace vocabulary emitted.
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("turn_start");
    expect(kinds).toContain("model_request");
    expect(kinds).toContain("model_response");
    expect(kinds).toContain("cost_accrual");
    expect(kinds).toContain("turn_end");
  });

  test("a tool turn dispatches, feeds the result back, and finishes", async () => {
    const { adapter } = scriptedAdapter([
      toolTurn("tu_1", "echo", { value: 42 }),
      textTurn("done: 42"),
    ]);
    const seenInputs: unknown[] = [];
    const events: WorkerTraceEvent[] = [];
    const result = await runWorkerLoop({
      platform: testPlatform(),
      model: "claude-sonnet-4-5",
      instructions: "use tools",
      messages: seed,
      tools: [
        fakeTool("echo", (input) => {
          seenInputs.push(input);
          return `echoed ${JSON.stringify(input)}`;
        }),
      ],
      adapter,
      emitTrace: (e) => events.push(e),
    });
    expect(result.stopReason).toBe("done");
    expect(result.text).toBe("done: 42");
    expect(result.iterations).toBe(1);
    // the tool actually ran with the accumulated JSON input.
    expect(seenInputs).toEqual([{ value: 42 }]);
    // a tool_result user message was appended before the final assistant turn.
    const toolResultMsg = result.messages.find(
      (m) => m.role === "user" && Array.isArray(m.content) && m.content[0]?.type === "tool_result",
    );
    expect(toolResultMsg).toBeDefined();
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("tool_call_start");
    expect(kinds).toContain("tool_call_end");
  });

  test("an unknown tool yields an is_error tool_result rather than crashing", async () => {
    const { adapter } = scriptedAdapter([toolTurn("tu_1", "missing", {}), textTurn("recovered")]);
    const result = await runWorkerLoop({
      platform: testPlatform(),
      model: "m",
      instructions: "x",
      messages: seed,
      tools: [],
      adapter,
    });
    expect(result.stopReason).toBe("done");
    expect(result.text).toBe("recovered");
  });

  test("maxToolIterations caps the tool loop (bounded stop, no failure)", async () => {
    // Every turn asks for the tool again — the model never stops.
    let count = 0;
    const loopingAdapter: ProviderAdapter = {
      providerId: "anthropic",
      features: {
        caching: "explicit",
        tool_use: true,
        vision: true,
        thinking: true,
        web_search: false,
      },
      estimateTokens: (m) => m.length,
      async *stream() {
        // vary the input so loop-detection doesn't fire first.
        count += 1;
        for (const ev of toolTurn(`tu_${count}`, "spin", { n: count })) yield ev;
      },
    };
    const result = await runWorkerLoop({
      platform: testPlatform(),
      model: "m",
      instructions: "x",
      messages: seed,
      tools: [fakeTool("spin", () => "again")],
      adapter: loopingAdapter,
      limits: { maxToolIterations: 3, loopDetection: { threshold: 0 } },
    });
    expect(result.stopReason).toBe("max_iterations");
    expect(result.failure).toBeUndefined();
    expect(result.iterations).toBe(4); // 3 allowed cycles, tripped on the 4th
  });

  test("loop-detection escalation: abort ends the run with a tool failure", async () => {
    let n = 0;
    const adapter: ProviderAdapter = {
      providerId: "anthropic",
      features: {
        caching: "explicit",
        tool_use: true,
        vision: true,
        thinking: true,
        web_search: false,
      },
      estimateTokens: (m) => m.length,
      async *stream() {
        n += 1;
        for (const ev of toolTurn("tu", "spin", { same: 1 })) yield ev;
      },
    };
    const result = await runWorkerLoop({
      platform: testPlatform(),
      model: "m",
      instructions: "x",
      messages: seed,
      tools: [fakeTool("spin", () => "again")],
      adapter,
      limits: { loopDetection: { window: 10, threshold: 2, escalation: "abort" } },
    });
    expect(result.stopReason).toBe("error");
    expect(result.failure?.class).toBe("tool");
    expect(n).toBeGreaterThan(0);
  });

  test("context overflow ends the run classified (no compaction on the edge)", async () => {
    const { adapter } = scriptedAdapter([textTurn("never reached")]);
    const result = await runWorkerLoop({
      platform: testPlatform(),
      model: "m",
      instructions: "x",
      messages: seed,
      adapter,
      limits: { contextLimit: 5 }, // estimateTokens(seed) = 10 >= 5
    });
    expect(result.stopReason).toBe("context_overflow");
    expect(result.failure?.class).toBe("context_overflow");
    expect(result.failure?.exitCode).toBe(21);
  });

  test("deadline is enforced from the INJECTED clock", async () => {
    let t = 0;
    const platform = testPlatform(() => {
      t += 10_000; // +10s per read
      return t;
    });
    const { adapter } = scriptedAdapter([textTurn("never")]);
    const result = await runWorkerLoop({
      platform,
      model: "m",
      instructions: "x",
      messages: seed,
      adapter,
      limits: { deadlineMs: 5_000 },
    });
    expect(result.stopReason).toBe("timeout");
    expect(result.failure?.class).toBe("timeout");
    expect(result.failure?.exitCode).toBe(34);
  });

  test("a provider stream error is classified and emits run_failed", async () => {
    const errorAdapter: ProviderAdapter = {
      providerId: "anthropic",
      features: {
        caching: "explicit",
        tool_use: true,
        vision: true,
        thinking: true,
        web_search: false,
      },
      estimateTokens: (m) => m.length,
      async *stream() {
        yield { kind: "error", error: { type: "http_401", message: "bad key" } };
      },
    };
    const events: WorkerTraceEvent[] = [];
    const result = await runWorkerLoop({
      platform: testPlatform(),
      model: "m",
      instructions: "x",
      messages: seed,
      adapter: errorAdapter,
      emitTrace: (e) => events.push(e),
    });
    expect(result.stopReason).toBe("error");
    expect(result.failure?.class).toBe("auth");
    expect(events.some((e) => e.kind === "run_failed")).toBe(true);
  });

  test("a pre-aborted signal ends the run aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { adapter } = scriptedAdapter([textTurn("never")]);
    const result = await runWorkerLoop({
      platform: testPlatform(),
      model: "m",
      instructions: "x",
      messages: seed,
      adapter,
      signal: controller.signal,
    });
    expect(result.stopReason).toBe("aborted");
  });
});
