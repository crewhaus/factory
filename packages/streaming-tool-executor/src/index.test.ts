import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type Anthropic from "@anthropic-ai/sdk";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { type AnthropicLikeStream, type StreamingToolEvent, executeStreaming } from "./index";

/**
 * Fake stream that mimics the events `executeStreaming` listens for:
 * `contentBlock` for each completed block, plus `finalMessage()` resolution.
 */
class FakeStream extends EventEmitter implements AnthropicLikeStream {
  private final?: { content: Anthropic.ContentBlock[] };
  private resolveFinal!: (msg: { content: Anthropic.ContentBlock[] }) => void;
  readonly finalPromise: Promise<{ content: Anthropic.ContentBlock[] }>;
  constructor() {
    super();
    this.finalPromise = new Promise((res) => {
      this.resolveFinal = res;
    });
  }
  emitToolUse(block: Anthropic.ToolUseBlock): void {
    this.emit("contentBlock", block);
  }
  finish(content: Anthropic.ContentBlock[]): void {
    this.final = { content };
    this.resolveFinal({ content });
  }
  finalMessage(): Promise<{ content: Anthropic.ContentBlock[] }> {
    return this.finalPromise;
  }
}

function tu(id: string, name: string, input: unknown = {}): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input } as Anthropic.ToolUseBlock;
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

function makeBashTool(opts: { failOn?: string } = {}): RegisteredTool {
  return buildTool({
    name: "Bash",
    description: "bash",
    inputSchema: z.object({ command: z.string() }),
    destructive: true,
    execute: async (input) => {
      if (opts.failOn !== undefined && input.command === opts.failOn) {
        throw new Error(`bash failed on ${input.command}`);
      }
      return `ran:${input.command}`;
    },
  });
}

function makeSlowReadTool(ms: number): RegisteredTool {
  return buildTool({
    name: "Read",
    description: "slow read",
    inputSchema: z.object({ id: z.string() }),
    readOnly: true,
    concurrencySafe: true,
    execute: async (input) => {
      await new Promise((r) => setTimeout(r, ms));
      return `read:${input.id}`;
    },
  });
}

describe("executeStreaming — single tool", () => {
  test("dispatches one Read and returns the result", async () => {
    const stream = new FakeStream();
    const calls: unknown[] = [];
    const tool = makeReadTool((id) => calls.push(id));
    const block = tu("tu_1", "Read", { id: "x" });

    const promise = executeStreaming(stream, {
      toolByName: new Map([["Read", tool]]),
    });
    stream.emitToolUse(block);
    stream.finish([block]);
    const out = await promise;

    expect(calls).toEqual(["x"]);
    expect(out.toolResults.length).toBe(1);
    expect(out.toolResults[0]?.tool_use_id).toBe("tu_1");
    expect(out.toolResults[0]?.is_error).toBe(false);
    expect(out.toolResults[0]?.content).toBe("read:x");
  });
});

describe("executeStreaming — multi-tool concurrency", () => {
  test("two concurrency-safe Reads run in parallel", async () => {
    const stream = new FakeStream();
    const tool = makeSlowReadTool(50);
    const a = tu("tu_a", "Read", { id: "a" });
    const b = tu("tu_b", "Read", { id: "b" });

    const events: StreamingToolEvent[] = [];
    const start = Date.now();
    const promise = executeStreaming(stream, {
      toolByName: new Map([["Read", tool]]),
      onEvent: (e) => events.push(e),
    });
    stream.emitToolUse(a);
    stream.emitToolUse(b);
    stream.finish([a, b]);
    await promise;
    const elapsed = Date.now() - start;
    // Two 50ms tools running in parallel should finish well under 100ms.
    expect(elapsed).toBeLessThan(95);

    const starts = events.filter((e) => e.kind === "tool-started");
    expect(starts.length).toBe(2);
    // Both starts should happen before either finish — i.e. interleaved.
    const firstFinish = events.findIndex((e) => e.kind === "tool-finished");
    const lastStart = events
      .map((e, i) => (e.kind === "tool-started" ? i : -1))
      .reduce((a, c) => Math.max(a, c), -1);
    expect(lastStart).toBeLessThan(firstFinish);
  });
});

describe("executeStreaming — mixed concurrent + serial", () => {
  test("Read, Bash, Read order: Read runs alone first, then Bash, then Read", async () => {
    const stream = new FakeStream();
    const read = makeSlowReadTool(20);
    const bash = makeBashTool();

    const blocks = [
      tu("tu_1", "Read", { id: "1" }),
      tu("tu_2", "Bash", { command: "echo" }),
      tu("tu_3", "Read", { id: "3" }),
    ];
    const events: StreamingToolEvent[] = [];

    const promise = executeStreaming(stream, {
      toolByName: new Map([
        ["Read", read],
        ["Bash", bash],
      ]),
      onEvent: (e) => events.push(e),
    });
    for (const b of blocks) stream.emitToolUse(b);
    stream.finish(blocks);
    const out = await promise;

    expect(out.toolResults.map((r) => r.tool_use_id)).toEqual(["tu_1", "tu_2", "tu_3"]);

    // Bash and the second Read must not run while a Read is in flight that
    // is non-concurrent with Bash. Specifically: Bash starts only after
    // tu_1 finishes (because they are not both safe).
    const tu1Start = events.findIndex((e) => e.kind === "tool-started" && e.toolUseId === "tu_1");
    const tu1Finish = events.findIndex((e) => e.kind === "tool-finished" && e.toolUseId === "tu_1");
    const tu2Start = events.findIndex((e) => e.kind === "tool-started" && e.toolUseId === "tu_2");
    expect(tu1Start).toBeGreaterThanOrEqual(0);
    expect(tu1Finish).toBeGreaterThan(tu1Start);
    expect(tu2Start).toBeGreaterThan(tu1Finish);
  });
});

describe("executeStreaming — sibling abort on destructive failure", () => {
  test("a failing Bash aborts the still-queued Read", async () => {
    const stream = new FakeStream();
    const read = makeSlowReadTool(50);
    const bash = makeBashTool({ failOn: "boom" });

    const events: StreamingToolEvent[] = [];
    const blocks = [tu("tu_a", "Bash", { command: "boom" }), tu("tu_b", "Read", { id: "b" })];

    const promise = executeStreaming(stream, {
      toolByName: new Map([
        ["Read", read],
        ["Bash", bash],
      ]),
      onEvent: (e) => events.push(e),
    });
    for (const b of blocks) stream.emitToolUse(b);
    stream.finish(blocks);
    const out = await promise;

    // Bash failed, sibling abort fired, Read got the synthetic abort result.
    const ra = out.toolResults.find((r) => r.tool_use_id === "tu_a");
    const rb = out.toolResults.find((r) => r.tool_use_id === "tu_b");
    expect(ra?.is_error).toBe(true);
    expect(ra?.content).toContain("bash failed");
    expect(rb?.is_error).toBe(true);
    expect(rb?.content).toBe("aborted: sibling tool failed");

    const aborted = events.find((e) => e.kind === "sibling-aborted");
    expect(aborted).toBeDefined();
  });

  test("custom shouldAbortOnError can suppress sibling abort", async () => {
    const stream = new FakeStream();
    const bash = makeBashTool({ failOn: "boom" });
    const read = makeReadTool(() => {});

    const blocks = [tu("tu_a", "Bash", { command: "boom" }), tu("tu_b", "Read", { id: "b" })];
    const promise = executeStreaming(stream, {
      toolByName: new Map([
        ["Read", read],
        ["Bash", bash],
      ]),
      shouldAbortOnError: () => false,
    });
    for (const b of blocks) stream.emitToolUse(b);
    stream.finish(blocks);
    const out = await promise;

    expect(out.toolResults.find((r) => r.tool_use_id === "tu_b")?.is_error).toBe(false);
  });
});

describe("executeStreaming — unknown tool", () => {
  test("missing tool produces an unknown-tool error result", async () => {
    const stream = new FakeStream();
    const blocks = [tu("tu_x", "Mystery", {})];
    const promise = executeStreaming(stream, { toolByName: new Map() });
    stream.emitToolUse(blocks[0] as Anthropic.ToolUseBlock);
    stream.finish(blocks);
    const out = await promise;
    expect(out.toolResults[0]?.is_error).toBe(true);
    expect(out.toolResults[0]?.content).toContain('unknown tool "Mystery"');
  });
});

describe("executeStreaming — late tool_use blocks", () => {
  test("tool_use only present in finalMessage (no contentBlock event) still runs", async () => {
    const stream = new FakeStream();
    const tool = makeReadTool(() => {});
    const block = tu("tu_late", "Read", { id: "late" });
    // Note: never emitToolUse() before finish().
    const promise = executeStreaming(stream, {
      toolByName: new Map([["Read", tool]]),
    });
    stream.finish([block]);
    const out = await promise;
    expect(out.toolResults.length).toBe(1);
    expect(out.toolResults[0]?.content).toBe("read:late");
  });
});

describe("executeStreaming — text-only stream", () => {
  test("no tool_use blocks → empty toolResults", async () => {
    const stream = new FakeStream();
    const text: Anthropic.ContentBlock = {
      type: "text",
      text: "hi",
      citations: null,
    } as Anthropic.ContentBlock;
    const promise = executeStreaming(stream, { toolByName: new Map() });
    stream.finish([text]);
    const out = await promise;
    expect(out.toolResults).toEqual([]);
    expect(out.finalContent).toEqual([text]);
  });
});
