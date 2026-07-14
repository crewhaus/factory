import { describe, expect, test } from "bun:test";
import type { StreamEvent } from "@crewhaus/adapter-anthropic";
import { RunFailedError } from "@crewhaus/errors";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { type StreamingToolEvent, executeStreaming } from "./index";

/**
 * Build an `AsyncIterable<StreamEvent>` from an array, with a manual
 * "controller" so tests can interleave tool-use emissions with the
 * stream lifecycle (e.g. emit a tool_use, await its result, emit
 * another).
 */
class StreamController {
  private events: StreamEvent[] = [];
  private resolve!: () => void;
  private done = new Promise<void>((r) => {
    this.resolve = r;
  });
  push(ev: StreamEvent): void {
    this.events.push(ev);
  }
  finish(): void {
    this.events.push({ kind: "message_stop" });
    this.resolve();
  }
  iter(): AsyncIterable<StreamEvent> {
    const events = this.events;
    const done = this.done;
    return {
      [Symbol.asyncIterator]: async function* () {
        // Yield buffered events first, then await further pushes.
        let i = 0;
        while (i < events.length) {
          yield events[i++] as StreamEvent;
        }
        await done;
        while (i < events.length) {
          yield events[i++] as StreamEvent;
        }
      },
    };
  }
}

function buildSimpleStream(
  toolUses: Array<{ id: string; name: string; input: unknown }>,
): AsyncIterable<StreamEvent> {
  const evs: StreamEvent[] = [{ kind: "message_start" }];
  let idx = 0;
  for (const tu of toolUses) {
    const i = idx++;
    evs.push({
      kind: "content_block_start",
      index: i,
      block: { type: "tool_use", id: tu.id, name: tu.name, input: {} },
    });
    evs.push({
      kind: "content_block_delta",
      index: i,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(tu.input) },
    });
    evs.push({ kind: "content_block_stop", index: i });
  }
  evs.push({ kind: "message_delta", stopReason: "tool_use" });
  evs.push({ kind: "message_stop" });
  return (async function* () {
    for (const e of evs) yield e;
  })();
}

function makeReadTool(spy: (id: unknown) => void): RegisteredTool {
  return buildTool({
    name: "Read",
    description: "read",
    inputSchema: z.object({ id: z.string() }),
    readOnly: true,
    concurrencySafe: true,
    execute: async (input) => {
      spy(input.id);
      return `read:${input.id}`;
    },
  });
}

function makeBashTool(): RegisteredTool {
  return buildTool({
    name: "Bash",
    description: "bash",
    inputSchema: z.object({ cmd: z.string() }),
    destructive: true,
    execute: async () => "bash-out",
  });
}

describe("executeStreaming over AsyncIterable<StreamEvent>", () => {
  test("dispatches a single tool_use and returns its result", async () => {
    const ids: unknown[] = [];
    const tool = makeReadTool((id) => ids.push(id));
    const stream = buildSimpleStream([{ id: "tu1", name: "Read", input: { id: "a" } }]);
    const events: StreamingToolEvent[] = [];
    const result = await executeStreaming(stream, {
      toolByName: new Map([["Read", tool]]),
      onEvent: (e) => events.push(e),
    });
    expect(ids).toEqual(["a"]);
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]?.tool_use_id).toBe("tu1");
    const finalContent = result.finalContent;
    expect(finalContent).toHaveLength(1);
    expect(finalContent[0]).toMatchObject({ type: "tool_use", id: "tu1", name: "Read" });
    expect(events.find((e) => e.kind === "tool-finished")).toBeDefined();
  });

  test("reconstructs tool_use input from incremental input_json_delta", async () => {
    const ids: unknown[] = [];
    const tool = makeReadTool((id) => ids.push(id));
    const stream = (async function* () {
      yield { kind: "message_start" } satisfies StreamEvent;
      yield {
        kind: "content_block_start",
        index: 0,
        block: { type: "tool_use", id: "tu1", name: "Read", input: {} },
      } satisfies StreamEvent;
      yield {
        kind: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"id":' },
      } satisfies StreamEvent;
      yield {
        kind: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"streamed"}' },
      } satisfies StreamEvent;
      yield { kind: "content_block_stop", index: 0 } satisfies StreamEvent;
      yield { kind: "message_delta", stopReason: "tool_use" } satisfies StreamEvent;
      yield { kind: "message_stop" } satisfies StreamEvent;
    })();
    const result = await executeStreaming(stream, {
      toolByName: new Map([["Read", tool]]),
    });
    expect(ids).toEqual(["streamed"]);
    expect(result.finalContent[0]).toMatchObject({
      type: "tool_use",
      input: { id: "streamed" },
    });
  });

  test("preserves text-only blocks and emits onTextDelta callbacks", async () => {
    const chunks: string[] = [];
    const stream = (async function* () {
      yield { kind: "message_start" } satisfies StreamEvent;
      yield {
        kind: "content_block_start",
        index: 0,
        block: { type: "text", text: "" },
      } satisfies StreamEvent;
      yield {
        kind: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hi " },
      } satisfies StreamEvent;
      yield {
        kind: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "there" },
      } satisfies StreamEvent;
      yield { kind: "content_block_stop", index: 0 } satisfies StreamEvent;
      yield { kind: "message_delta", stopReason: "end_turn" } satisfies StreamEvent;
      yield { kind: "message_stop" } satisfies StreamEvent;
    })();
    const result = await executeStreaming(stream, {
      toolByName: new Map(),
      onTextDelta: (c) => chunks.push(c),
    });
    expect(chunks).toEqual(["Hi ", "there"]);
    expect(result.finalContent[0]).toEqual({ type: "text", text: "Hi there" });
  });

  test("uses runTool callback when provided (skips local catalog dispatch)", async () => {
    const seen: string[] = [];
    const stream = buildSimpleStream([{ id: "tu1", name: "Custom", input: { x: 1 } }]);
    const result = await executeStreaming(stream, {
      toolByName: new Map(),
      runTool: async (block) => {
        seen.push(block.name);
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: "from runTool",
          is_error: false,
        };
      },
    });
    expect(seen).toEqual(["Custom"]);
    expect(result.toolResults[0]?.content).toBe("from runTool");
  });

  test("synthetic 'unknown tool' result when no tool and no runTool", async () => {
    const stream = buildSimpleStream([{ id: "tu1", name: "Missing", input: {} }]);
    const result = await executeStreaming(stream, { toolByName: new Map() });
    expect(result.toolResults[0]?.is_error).toBe(true);
    expect(result.toolResults[0]?.content).toContain("unknown tool");
  });

  test("destructive failure aborts pending siblings", async () => {
    const bash = makeBashTool();
    const stream = buildSimpleStream([
      { id: "tu1", name: "Bash", input: { cmd: "ok" } },
      { id: "tu2", name: "Bash", input: { cmd: "later" } },
    ]);
    const events: StreamingToolEvent[] = [];
    const result = await executeStreaming(stream, {
      toolByName: new Map([["Bash", bash]]),
      onEvent: (e) => events.push(e),
      runTool: async (block) => {
        if (block.id === "tu1") {
          return {
            type: "tool_result",
            tool_use_id: block.id,
            content: "boom",
            is_error: true,
          };
        }
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: "should not happen",
          is_error: false,
        };
      },
    });
    const aborted = result.toolResults.find((r) => r.tool_use_id === "tu2");
    expect(aborted?.is_error).toBe(true);
    expect(events.find((e) => e.kind === "sibling-aborted")).toBeDefined();
  });
});

describe("RunFailedError escapes the streaming dispatch (v0.3.0 §7.1)", () => {
  const REPORT = {
    class: "billing" as const,
    title: "provider account out of funding",
    detail: 'Anthropic said: "credit balance too low"',
    remediation: "add credits, then rerun.",
    exitCode: 31,
  };

  test("a runTool rejection carrying RunFailedError rethrows the SAME error after the drain", async () => {
    const stream = buildSimpleStream([{ id: "tu_fatal", name: "Task", input: { prompt: "x" } }]);
    const fatal = new RunFailedError(REPORT);
    let thrown: unknown;
    try {
      await executeStreaming(stream, {
        toolByName: new Map(),
        runTool: async () => {
          throw fatal;
        },
      });
    } catch (err) {
      thrown = err;
    }
    // Identity preserved — the caller's recovery halts with the exact report.
    expect(thrown).toBe(fatal);
  });

  test("queued siblings are short-circuited, and in-flight siblings still settle before the rethrow", async () => {
    const settled: string[] = [];
    const stream = buildSimpleStream([
      { id: "tu_fatal", name: "Task", input: { prompt: "x" } },
      { id: "tu_sibling", name: "Task", input: { prompt: "y" } },
    ]);
    const seen: StreamingToolEvent[] = [];
    let thrown: unknown;
    try {
      await executeStreaming(stream, {
        toolByName: new Map(),
        onEvent: (e) => seen.push(e),
        runTool: async (block) => {
          settled.push(block.id);
          if (block.id === "tu_fatal") throw new RunFailedError(REPORT);
          return { type: "tool_result", tool_use_id: block.id, content: "ok" };
        },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RunFailedError);
    // The fatal dispatch ran; the queue was aborted (sibling-aborted fired).
    expect(settled).toContain("tu_fatal");
    expect(seen.some((e) => e.kind === "sibling-aborted" && e.reason === "fatal_error")).toBe(true);
  });

  test("an ordinary rejection keeps the pre-0.3.0 stringified is_error result", async () => {
    const stream = buildSimpleStream([{ id: "tu_plain", name: "Task", input: {} }]);
    const result = await executeStreaming(stream, {
      toolByName: new Map(),
      runTool: async () => {
        throw new Error("plain failure");
      },
    });
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]?.is_error).toBe(true);
    expect(result.toolResults[0]?.content).toBe("plain failure");
  });
});
