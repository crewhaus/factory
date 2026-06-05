import { afterEach, describe, expect, mock, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
/**
 * Coverage-completion suite for `streaming-tool-executor`.
 *
 * The sibling `index.test.ts` / `load.test.ts` exercise the happy paths.
 * This file targets the remaining branches: thinking blocks, usage
 * merging, external-abort wiring, the concurrency scheduler's safe/unsafe
 * gate, malformed-JSON recovery, the `error` stream event, the wrapping
 * `catch`, the `runTool`/`executeTool` rejection path, and the
 * multi-pass in-flight drain.
 *
 * Everything is driven off in-memory `AsyncIterable<StreamEvent>`s and
 * hand-rolled deferred promises — no real timers, sockets, or filesystem
 * — so the runner exits cleanly with no leaked handles or unsettled
 * streams.
 */
import type { StreamEvent, TokenUsage } from "@crewhaus/adapter-anthropic";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { type StreamingToolEvent, executeStreaming } from "./index";

// ---------- helpers ---------- //

/** Yield a fixed list of events as an async iterable (one microtask apart). */
function streamOf(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  return (async function* () {
    for (const e of events) {
      yield e;
    }
  })();
}

/** A deferred promise whose resolve/reject are exposed for the test. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Deterministically drain the microtask queue until `pred()` is true or a
 * fixed budget of turns is spent. No real timers — each turn is a single
 * resolved-promise await, so the `for await` stream loop and any settled
 * tool promises get a chance to advance. The bounded budget means a wrong
 * expectation fails fast instead of hanging the runner.
 */
async function flushUntil(pred: () => boolean, maxTurns = 200): Promise<void> {
  for (let i = 0; i < maxTurns && !pred(); i++) {
    await Promise.resolve();
  }
}

function toolUseEvents(id: string, name: string, input: unknown, index: number): StreamEvent[] {
  return [
    {
      kind: "content_block_start",
      index,
      block: { type: "tool_use", id, name, input: {} },
    },
    {
      kind: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    },
    { kind: "content_block_stop", index },
  ];
}

function safeReadTool(name = "Read"): RegisteredTool {
  return buildTool({
    name,
    description: "safe read",
    inputSchema: z.object({}).passthrough(),
    readOnly: true,
    concurrencySafe: true,
    execute: async () => `ok:${name}`,
  });
}

afterEach(() => {
  // Restore any module mocks installed by individual tests so later
  // tests (and other files) see the real implementations.
  mock.restore();
});

// ---------- thinking blocks (296-316, 410-414) ---------- //

describe("thinking blocks", () => {
  test("accumulates thinking + signature deltas into finalContent", async () => {
    const stream = streamOf([
      { kind: "message_start" },
      {
        kind: "content_block_start",
        index: 0,
        block: { type: "thinking", thinking: "seed " },
      },
      {
        kind: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "more" },
      },
      {
        kind: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig-123" },
      },
      { kind: "content_block_stop", index: 0 },
      { kind: "message_stop" },
    ]);
    const result = await executeStreaming(stream, { toolByName: new Map() });
    expect(result.finalContent).toEqual([
      { type: "thinking", thinking: "seed more", signature: "sig-123" },
    ]);
  });

  test("thinking block carries an initial signature from content_block_start", async () => {
    const stream = streamOf([
      { kind: "message_start" },
      {
        kind: "content_block_start",
        index: 0,
        block: { type: "thinking", thinking: "redacted", signature: "pre-sig" },
      },
      { kind: "content_block_stop", index: 0 },
      { kind: "message_stop" },
    ]);
    const result = await executeStreaming(stream, { toolByName: new Map() });
    expect(result.finalContent[0]).toEqual({
      type: "thinking",
      thinking: "redacted",
      signature: "pre-sig",
    });
  });

  test("thinking block without a signature omits the field in finalContent", async () => {
    const stream = streamOf([
      { kind: "message_start" },
      {
        kind: "content_block_start",
        index: 0,
        block: { type: "thinking", thinking: "no sig" },
      },
      { kind: "content_block_stop", index: 0 },
      { kind: "message_stop" },
    ]);
    const result = await executeStreaming(stream, { toolByName: new Map() });
    expect(result.finalContent[0]).toEqual({ type: "thinking", thinking: "no sig" });
    expect(result.finalContent[0]).not.toHaveProperty("signature");
  });
});

// ---------- usage merging (message_start + message_delta, 352-365) ---------- //

describe("usage accounting", () => {
  test("message_start usage seeds, message_delta merges all four fields", async () => {
    const stream = streamOf([
      {
        kind: "message_start",
        usage: { input: 10, output: 0, cacheRead: 3, cacheCreate: 4 },
      },
      {
        kind: "message_delta",
        stopReason: "end_turn",
        usage: { input: 0, output: 25, cacheRead: 7, cacheCreate: 8 },
      },
      { kind: "message_stop" },
    ]);
    const result = await executeStreaming(stream, { toolByName: new Map() });
    // input falls back to seeded 10 (delta.input == 0), output takes delta 25,
    // cacheRead/cacheCreate take the delta values.
    expect(result.usage).toEqual({
      input: 10,
      output: 25,
      cacheRead: 7,
      cacheCreate: 8,
    });
    expect(result.stopReason).toBe("end_turn");
  });

  test("message_delta keeps prior cache fields when delta omits them", async () => {
    const stream = streamOf([
      {
        kind: "message_start",
        usage: { input: 5, output: 1, cacheRead: 99, cacheCreate: 88 },
      },
      {
        // delta has positive input/output but NO cache fields → carry prior.
        kind: "message_delta",
        usage: { input: 50, output: 60 },
      },
      { kind: "message_stop" },
    ]);
    const result = await executeStreaming(stream, { toolByName: new Map() });
    expect(result.usage).toEqual({
      input: 50,
      output: 60,
      cacheRead: 99,
      cacheCreate: 88,
    });
  });

  test("message_delta with neither delta nor prior cache fields stays uncached", async () => {
    const stream = streamOf([
      { kind: "message_start", usage: { input: 2, output: 2 } },
      { kind: "message_delta", usage: { input: 0, output: 0 } },
      { kind: "message_stop" },
    ]);
    const result = await executeStreaming(stream, { toolByName: new Map() });
    expect(result.usage).toEqual({ input: 2, output: 2 });
    expect(result.usage).not.toHaveProperty("cacheRead");
    expect(result.usage).not.toHaveProperty("cacheCreate");
  });

  test("message_delta without a usage field leaves usage untouched", async () => {
    const stream = streamOf([
      { kind: "message_start", usage: { input: 11, output: 22 } },
      { kind: "message_delta", stopReason: "max_tokens" },
      { kind: "message_stop" },
    ]);
    const result = await executeStreaming(stream, { toolByName: new Map() });
    expect(result.usage).toEqual({ input: 11, output: 22 });
    expect(result.stopReason).toBe("max_tokens");
  });

  test("message_start without usage keeps the zero default", async () => {
    const stream = streamOf([{ kind: "message_start" }, { kind: "message_stop" }]);
    const result = await executeStreaming(stream, { toolByName: new Map() });
    expect(result.usage).toEqual({ input: 0, output: 0 } satisfies TokenUsage);
  });
});

// ---------- malformed JSON recovery (328, 406) ---------- //

describe("malformed tool_use JSON", () => {
  test("invalid jsonBuffer surfaces __parse_error in dispatch input and finalContent", async () => {
    const seen: unknown[] = [];
    const stream = streamOf([
      { kind: "message_start" },
      {
        kind: "content_block_start",
        index: 0,
        block: { type: "tool_use", id: "tu1", name: "Read", input: {} },
      },
      {
        kind: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{not valid json" },
      },
      { kind: "content_block_stop", index: 0 },
      { kind: "message_stop" },
    ]);
    const result = await executeStreaming(stream, {
      toolByName: new Map(),
      runTool: async (block) => {
        seen.push(block.input);
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: "handled",
          is_error: false,
        };
      },
    });
    expect(seen[0]).toEqual({ __parse_error: true, raw: "{not valid json" });
    // finalContent re-parses the persisted (now valid) JSON of the parse-error
    // object, so it round-trips the same shape.
    expect(result.finalContent[0]).toEqual({
      type: "tool_use",
      id: "tu1",
      name: "Read",
      input: { __parse_error: true, raw: "{not valid json" },
    });
  });

  test("empty jsonBuffer defaults the tool input to {}", async () => {
    const seen: unknown[] = [];
    const stream = streamOf([
      { kind: "message_start" },
      {
        kind: "content_block_start",
        index: 0,
        block: { type: "tool_use", id: "tu1", name: "Read", input: {} },
      },
      // No input_json_delta at all → jsonBuffer stays "".
      { kind: "content_block_stop", index: 0 },
      { kind: "message_stop" },
    ]);
    await executeStreaming(stream, {
      toolByName: new Map(),
      runTool: async (block) => {
        seen.push(block.input);
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: "ok",
          is_error: false,
        };
      },
    });
    expect(seen[0]).toEqual({});
  });

  test("a tool_use opened but never closed surfaces __parse_error in finalContent", async () => {
    // The block is opened (content_block_start) but the stream ends with NO
    // content_block_stop, so its jsonBuffer is never re-serialized and stays
    // "". The finalContent pass then does JSON.parse("") which throws and is
    // caught into a __parse_error marker. The block is never enqueued (no
    // stop event), so there is no tool result for it.
    const stream = streamOf([
      { kind: "message_start" },
      {
        kind: "content_block_start",
        index: 0,
        block: { type: "tool_use", id: "tu_open", name: "Read", input: {} },
      },
      {
        kind: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"id":"partial' },
      },
      // No content_block_stop for index 0 — stream just ends.
      { kind: "message_stop" },
    ]);
    const result = await executeStreaming(stream, { toolByName: new Map() });
    expect(result.toolResults).toHaveLength(0);
    expect(result.finalContent).toEqual([
      {
        type: "tool_use",
        id: "tu_open",
        name: "Read",
        input: { __parse_error: true, raw: '{"id":"partial' },
      },
    ]);
  });
});

// ---------- concurrency scheduler (106, 262-269) ---------- //

describe("concurrency gate", () => {
  test("two concurrency-safe tools run in parallel via isConcurrencySafe path", async () => {
    // Both reads are safe; when the second arrives while the first is still
    // in flight, processQueue's runningAllSafe + isConcurrencySafe gate lets
    // it dispatch concurrently rather than waiting.
    const d1 = deferred<Anthropic.ToolResultBlockParam>();
    const d2 = deferred<Anthropic.ToolResultBlockParam>();
    let started = 0;
    const events: StreamingToolEvent[] = [];
    const promise = executeStreaming(
      streamOf([
        { kind: "message_start" },
        ...toolUseEvents("tu1", "Read", { a: 1 }, 0),
        ...toolUseEvents("tu2", "Read", { a: 2 }, 1),
        { kind: "message_stop" },
      ]),
      {
        toolByName: new Map([["Read", safeReadTool()]]),
        onEvent: (e) => {
          events.push(e);
          if (e.kind === "tool-started") started++;
        },
        runTool: (block) => {
          return block.id === "tu1" ? d1.promise : d2.promise;
        },
      },
    );
    // Let the stream drain and both safe tools dispatch concurrently.
    await flushUntil(() => started >= 2);
    expect(started).toBe(2);
    d1.resolve({
      type: "tool_result",
      tool_use_id: "tu1",
      content: "r1",
      is_error: false,
    });
    d2.resolve({
      type: "tool_result",
      tool_use_id: "tu2",
      content: "r2",
      is_error: false,
    });
    const result = await promise;
    expect(result.toolResults.map((r) => r.tool_use_id)).toEqual(["tu1", "tu2"]);
  });

  test("an unsafe in-flight tool blocks a following safe tool until it drains", async () => {
    // tu1 is NOT concurrency-safe (a plain write-ish tool). While it runs,
    // tu2 (safe) must WAIT — exercising the `runningAllSafe === false → return`
    // branch — then dispatch only after tu1 settles.
    const unsafe = buildTool({
      name: "Write",
      description: "unsafe",
      inputSchema: z.object({}).passthrough(),
      // readOnly omitted → not concurrency-safe even if we set the flag.
      concurrencySafe: false,
      execute: async () => "wrote",
    });
    const order: string[] = [];
    const d1 = deferred<void>();
    const stream = streamOf([
      { kind: "message_start" },
      ...toolUseEvents("tu1", "Write", { a: 1 }, 0),
      ...toolUseEvents("tu2", "Read", { a: 2 }, 1),
      { kind: "message_stop" },
    ]);
    const promise = executeStreaming(stream, {
      toolByName: new Map<string, RegisteredTool>([
        ["Write", unsafe],
        ["Read", safeReadTool()],
      ]),
      onEvent: (e) => {
        if (e.kind === "tool-started") order.push(`start:${e.toolName}`);
        if (e.kind === "tool-finished") order.push(`finish:${e.toolName}`);
      },
      runTool: async (block) => {
        if (block.id === "tu1") {
          await d1.promise;
        }
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: block.id,
          is_error: false,
        };
      },
    });
    await flushUntil(() => order.includes("start:Write"));
    // Only the unsafe tool has started; the safe read is gated behind it.
    expect(order).toEqual(["start:Write"]);
    d1.resolve();
    const result = await promise;
    // Write finishes before Read even starts.
    expect(order).toEqual(["start:Write", "finish:Write", "start:Read", "finish:Read"]);
    expect(result.toolResults.map((r) => r.tool_use_id)).toEqual(["tu1", "tu2"]);
  });

  test("a safe tool already running blocks an unsafe follower (isConcurrencySafe(entry)=false)", async () => {
    // tu1 safe + in-flight; tu2 unsafe. runningAllSafe is true (only safe
    // running) but isConcurrencySafe(entry=tu2) is false → tu2 waits.
    const unsafe = buildTool({
      name: "Bash",
      description: "unsafe",
      inputSchema: z.object({}).passthrough(),
      destructive: true,
      execute: async () => "ran",
    });
    const order: string[] = [];
    const d1 = deferred<void>();
    const stream = streamOf([
      { kind: "message_start" },
      ...toolUseEvents("tu1", "Read", { a: 1 }, 0),
      ...toolUseEvents("tu2", "Bash", { a: 2 }, 1),
      { kind: "message_stop" },
    ]);
    const promise = executeStreaming(stream, {
      toolByName: new Map<string, RegisteredTool>([
        ["Read", safeReadTool()],
        ["Bash", unsafe],
      ]),
      // Bash here returns success so no sibling-abort fires.
      shouldAbortOnError: () => false,
      onEvent: (e) => {
        if (e.kind === "tool-started") order.push(`start:${e.toolName}`);
      },
      runTool: async (block) => {
        if (block.id === "tu1") await d1.promise;
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: block.id,
          is_error: false,
        };
      },
    });
    await flushUntil(() => order.includes("start:Read"));
    expect(order).toEqual(["start:Read"]);
    d1.resolve();
    const result = await promise;
    expect(order).toEqual(["start:Read", "start:Bash"]);
    expect(result.toolResults).toHaveLength(2);
  });
});

// ---------- external abort wiring (135-144) ---------- //

describe("external abortSignal", () => {
  test("pre-aborted signal aborts queued tools synthetically (135-136)", async () => {
    const ac = new AbortController();
    ac.abort();
    const stream = streamOf([
      { kind: "message_start" },
      ...toolUseEvents("tu1", "Read", { a: 1 }, 0),
      { kind: "message_stop" },
    ]);
    let ran = false;
    const result = await executeStreaming(stream, {
      toolByName: new Map([["Read", safeReadTool()]]),
      abortSignal: ac.signal,
      runTool: async (block) => {
        ran = true;
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: "nope",
          is_error: false,
        };
      },
    });
    expect(ran).toBe(false);
    expect(result.toolResults[0]?.is_error).toBe(true);
    expect(result.toolResults[0]?.content).toContain("aborted: sibling tool failed");
  });

  test("signal that fires mid-stream aborts not-yet-dispatched tools (138-144)", async () => {
    const ac = new AbortController();
    const gate = deferred<void>();
    // tu1 runs (held by gate), abort fires while it is in flight, then the
    // drain re-runs processQueue and tu2 is aborted.
    const stream = (async function* (): AsyncIterable<StreamEvent> {
      yield { kind: "message_start" };
      yield* toolUseEvents("tu1", "Read", { a: 1 }, 0);
      yield* toolUseEvents("tu2", "Read", { a: 2 }, 1);
      yield { kind: "message_stop" };
    })();
    const started: string[] = [];
    const promise = executeStreaming(stream, {
      toolByName: new Map([["Read", safeReadTool()]]),
      abortSignal: ac.signal,
      onEvent: (e) => {
        if (e.kind === "tool-started") started.push(e.toolUseId);
      },
      runTool: async (block) => {
        if (block.id === "tu1") {
          // Trigger the external abort from inside the first tool, then block.
          ac.abort();
          await gate.promise;
        }
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: block.id,
          is_error: false,
        };
      },
    });
    // Wait until tu1 has started (so the in-tool ac.abort() has fired),
    // then release it; tu2 must be aborted during the drain.
    await flushUntil(() => started.includes("tu1") && ac.signal.aborted);
    gate.resolve();
    const result = await promise;
    expect(started).toEqual(["tu1"]);
    const r2 = result.toolResults.find((r) => r.tool_use_id === "tu2");
    expect(r2?.is_error).toBe(true);
    expect(r2?.content).toContain("aborted: sibling tool failed");
  });
});

// ---------- rejection path (229-236) ---------- //

describe("rejection handling", () => {
  test("runTool rejection becomes a synthetic is_error result (Error message)", async () => {
    const stream = streamOf([
      { kind: "message_start" },
      ...toolUseEvents("tu1", "Read", { a: 1 }, 0),
      { kind: "message_stop" },
    ]);
    const result = await executeStreaming(stream, {
      toolByName: new Map([["Read", safeReadTool()]]),
      runTool: async () => {
        throw new Error("kaboom");
      },
    });
    expect(result.toolResults[0]).toMatchObject({
      tool_use_id: "tu1",
      content: "kaboom",
      is_error: true,
    });
  });

  test("non-Error rejection is stringified", async () => {
    const stream = streamOf([
      { kind: "message_start" },
      ...toolUseEvents("tu1", "Read", { a: 1 }, 0),
      { kind: "message_stop" },
    ]);
    const result = await executeStreaming(stream, {
      toolByName: new Map([["Read", safeReadTool()]]),
      // Reject with a plain string to hit the `String(err)` branch.
      runTool: () => Promise.reject("string failure"),
    });
    expect(result.toolResults[0]?.content).toBe("string failure");
    expect(result.toolResults[0]?.is_error).toBe(true);
  });
});

// ---------- executeTool fallback branch (runOne / no runTool) ---------- //

describe("executeTool fallback (no runTool)", () => {
  test("dispatches through executeTool and maps a string result", async () => {
    const tool = buildTool({
      name: "Read",
      description: "read",
      inputSchema: z.object({ id: z.string() }),
      readOnly: true,
      concurrencySafe: true,
      execute: async (input) => `content:${input.id}`,
    });
    const stream = streamOf([
      { kind: "message_start" },
      ...toolUseEvents("tu1", "Read", { id: "x" }, 0),
      { kind: "message_stop" },
    ]);
    const result = await executeStreaming(stream, {
      toolByName: new Map([["Read", tool]]),
    });
    expect(result.toolResults[0]).toMatchObject({
      tool_use_id: "tu1",
      content: "content:x",
      is_error: false,
    });
  });

  test("executeTool array (image/text block) content passes through untouched", async () => {
    const tool = buildTool({
      name: "ReadImage",
      description: "image read",
      inputSchema: z.object({}).passthrough(),
      readOnly: true,
      concurrencySafe: true,
      execute: async () => [
        { type: "text" as const, text: "caption" },
        {
          type: "image" as const,
          source: { type: "base64" as const, media_type: "image/png", data: "AAAA" },
        },
      ],
    });
    const stream = streamOf([
      { kind: "message_start" },
      ...toolUseEvents("tu1", "ReadImage", {}, 0),
      { kind: "message_stop" },
    ]);
    const result = await executeStreaming(stream, {
      toolByName: new Map([["ReadImage", tool]]),
    });
    const content = result.toolResults[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toEqual([
      { type: "text", text: "caption" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ]);
  });

  test("executeTool error result is mapped with is_error true and can abort siblings", async () => {
    // A destructive tool whose execute throws → executeTool returns isError.
    // Default shouldAbortOnError fires because the tool is destructive.
    const boom = buildTool({
      name: "Bash",
      description: "bash",
      inputSchema: z.object({}).passthrough(),
      destructive: true,
      execute: async () => {
        throw new Error("exec failed");
      },
    });
    const events: StreamingToolEvent[] = [];
    const stream = streamOf([
      { kind: "message_start" },
      ...toolUseEvents("tu1", "Bash", {}, 0),
      ...toolUseEvents("tu2", "Bash", {}, 1),
      { kind: "message_stop" },
    ]);
    const result = await executeStreaming(stream, {
      toolByName: new Map([["Bash", boom]]),
      onEvent: (e) => events.push(e),
    });
    const r1 = result.toolResults.find((r) => r.tool_use_id === "tu1");
    expect(r1?.is_error).toBe(true);
    expect(r1?.content).toBe("exec failed");
    expect(events.find((e) => e.kind === "sibling-aborted")).toBeDefined();
    const r2 = result.toolResults.find((r) => r.tool_use_id === "tu2");
    expect(r2?.content).toContain("aborted: sibling tool failed");
  });
});

// ---------- stream `error` event + wrapping catch (370-377) ---------- //

describe("stream error handling", () => {
  test("an `error` stream event throws a wrapped RuntimeError", async () => {
    const stream = streamOf([
      { kind: "message_start" },
      { kind: "error", error: { type: "overloaded", message: "upstream 529" } },
    ]);
    await expect(executeStreaming(stream, { toolByName: new Map() })).rejects.toThrow(
      /stream failed:.*stream error:.*upstream 529/,
    );
  });

  test("an iterator that throws a non-Error value is wrapped via String(err)", async () => {
    const stream: AsyncIterable<StreamEvent> = {
      [Symbol.asyncIterator]() {
        let yielded = false;
        return {
          next(): Promise<IteratorResult<StreamEvent>> {
            if (!yielded) {
              yielded = true;
              return Promise.resolve({
                value: { kind: "message_start" } satisfies StreamEvent,
                done: false,
              });
            }
            // Reject with a non-Error so the catch uses String(err).
            return Promise.reject("raw-stream-explosion");
          },
        };
      },
    };
    await expect(executeStreaming(stream, { toolByName: new Map() })).rejects.toThrow(
      /stream failed: raw-stream-explosion/,
    );
  });
});

// ---------- multi-pass drain (382-388) ---------- //

describe("in-flight drain", () => {
  test("a tool that resolves after message_stop is still awaited and ordered", async () => {
    // The stream finishes (message_stop) while tu1 is still pending; the
    // drain loop must await it before returning. tu2 is enqueued but only
    // dispatched after tu1 drains (kept simple/serial via an unsafe tool).
    const d1 = deferred<void>();
    let started = false;
    const stream = streamOf([
      { kind: "message_start" },
      ...toolUseEvents("tu1", "Read", { a: 1 }, 0),
      { kind: "message_stop" },
    ]);
    const promise = executeStreaming(stream, {
      toolByName: new Map([["Read", safeReadTool()]]),
      onEvent: (e) => {
        if (e.kind === "tool-started") started = true;
      },
      runTool: async (block) => {
        await d1.promise;
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: "late",
          is_error: false,
        };
      },
    });
    // Stream is exhausted; tu1 is still in flight when the first drain loop
    // runs. Resolve it only once it has actually started.
    await flushUntil(() => started);
    d1.resolve();
    const result = await promise;
    expect(result.toolResults[0]?.content).toBe("late");
  });

  test("a tool dispatched only by the post-stream processQueue still settles", async () => {
    // Two unsafe tools: tu1 holds the in-flight slot through message_stop;
    // tu2 stays queued (unsafe blocks it) until tu1's finally re-runs
    // processQueue, dispatching tu2 in the SECOND drain pass.
    const unsafe = buildTool({
      name: "Bash",
      description: "unsafe",
      inputSchema: z.object({}).passthrough(),
      destructive: true,
      execute: async () => "x",
    });
    const d1 = deferred<void>();
    const d2 = deferred<void>();
    const order: string[] = [];
    const stream = streamOf([
      { kind: "message_start" },
      ...toolUseEvents("tu1", "Bash", { a: 1 }, 0),
      ...toolUseEvents("tu2", "Bash", { a: 2 }, 1),
      { kind: "message_stop" },
    ]);
    const promise = executeStreaming(stream, {
      toolByName: new Map([["Bash", unsafe]]),
      shouldAbortOnError: () => false,
      onEvent: (e) => {
        if (e.kind === "tool-started") order.push(e.toolUseId);
      },
      runTool: async (block) => {
        if (block.id === "tu1") await d1.promise;
        else await d2.promise;
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: block.id,
          is_error: false,
        };
      },
    });
    await flushUntil(() => order.includes("tu1"));
    expect(order).toEqual(["tu1"]);
    d1.resolve();
    // After tu1 drains, processQueue dispatches tu2 in the second pass.
    await flushUntil(() => order.includes("tu2"));
    expect(order).toEqual(["tu1", "tu2"]);
    d2.resolve();
    const result = await promise;
    expect(result.toolResults.map((r) => r.tool_use_id)).toEqual(["tu1", "tu2"]);
  });
});

// ---------- content_block edge cases (307, 322, 399) ---------- //

describe("unknown / mismatched content blocks", () => {
  test("deltas and stops for an unopened block index are ignored", async () => {
    const stream = streamOf([
      { kind: "message_start" },
      // Delta + stop for index 5 that was never opened.
      {
        kind: "content_block_delta",
        index: 5,
        delta: { type: "text_delta", text: "ghost" },
      },
      { kind: "content_block_stop", index: 5 },
      // A real text block at index 0.
      { kind: "content_block_start", index: 0, block: { type: "text", text: "real" } },
      { kind: "content_block_stop", index: 0 },
      { kind: "message_stop" },
    ]);
    const result = await executeStreaming(stream, { toolByName: new Map() });
    expect(result.finalContent).toEqual([{ type: "text", text: "real" }]);
  });

  test("a delta whose type mismatches the block kind is a no-op", async () => {
    // text block receives an input_json_delta → none of the branches match,
    // the text stays as opened.
    const stream = streamOf([
      { kind: "message_start" },
      { kind: "content_block_start", index: 0, block: { type: "text", text: "keep" } },
      {
        kind: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{}" },
      },
      { kind: "content_block_stop", index: 0 },
      { kind: "message_stop" },
    ]);
    const result = await executeStreaming(stream, { toolByName: new Map() });
    expect(result.finalContent).toEqual([{ type: "text", text: "keep" }]);
  });

  test("content_block_stop for a non-tool_use block does not enqueue work", async () => {
    let dispatched = false;
    const stream = streamOf([
      { kind: "message_start" },
      { kind: "content_block_start", index: 0, block: { type: "text", text: "t" } },
      { kind: "content_block_stop", index: 0 },
      { kind: "message_stop" },
    ]);
    const result = await executeStreaming(stream, {
      toolByName: new Map(),
      runTool: async (block) => {
        dispatched = true;
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: "x",
          is_error: false,
        };
      },
    });
    expect(dispatched).toBe(false);
    expect(result.toolResults).toHaveLength(0);
  });

  test("duplicate open indices are de-duplicated in finalContent (seen guard)", async () => {
    // Same index opened twice; openOrder records it twice but `seen` keeps
    // finalContent to a single entry.
    const stream = streamOf([
      { kind: "message_start" },
      { kind: "content_block_start", index: 0, block: { type: "text", text: "first" } },
      { kind: "content_block_stop", index: 0 },
      // Re-open the same index with a fresh block.
      { kind: "content_block_start", index: 0, block: { type: "text", text: "second" } },
      { kind: "content_block_stop", index: 0 },
      { kind: "message_stop" },
    ]);
    const result = await executeStreaming(stream, { toolByName: new Map() });
    expect(result.finalContent).toEqual([{ type: "text", text: "second" }]);
  });
});
