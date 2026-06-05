import { describe, expect, test } from "bun:test";
import { collectFinalMessage, consumeStream, extractFirstText, extractToolUse } from "./helpers.js";
import type { StreamEvent, TokenUsage } from "./types.js";

async function* synthStream(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const ev of events) yield ev;
}

const TEXT_ONLY_STREAM: StreamEvent[] = [
  { kind: "message_start", usage: { input: 5, output: 0 } },
  { kind: "content_block_start", index: 0, block: { type: "text", text: "" } },
  { kind: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
  { kind: "content_block_delta", index: 0, delta: { type: "text_delta", text: ", world" } },
  { kind: "content_block_stop", index: 0 },
  { kind: "message_delta", stopReason: "end_turn", usage: { input: 5, output: 7 } },
  { kind: "message_stop" },
];

const TOOL_USE_STREAM: StreamEvent[] = [
  { kind: "message_start", usage: { input: 10, output: 0 } },
  { kind: "content_block_start", index: 0, block: { type: "text", text: "" } },
  {
    kind: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Reading file..." },
  },
  { kind: "content_block_stop", index: 0 },
  {
    kind: "content_block_start",
    index: 1,
    block: { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
  },
  {
    kind: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"path":' },
  },
  {
    kind: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '"/tmp/x"}' },
  },
  { kind: "content_block_stop", index: 1 },
  { kind: "message_delta", stopReason: "tool_use", usage: { input: 10, output: 12 } },
  { kind: "message_stop" },
];

describe("consumeStream", () => {
  test("text-only stream → single text block + correct stop reason + usage", async () => {
    const msg = await consumeStream(synthStream([...TEXT_ONLY_STREAM]));
    expect(msg.content).toEqual([{ type: "text", text: "Hello, world" }]);
    expect(msg.stopReason).toBe("end_turn");
    expect(msg.usage).toEqual({ input: 5, output: 7 });
  });

  test("tool_use stream parses incremental JSON args", async () => {
    const msg = await consumeStream(synthStream([...TOOL_USE_STREAM]));
    expect(msg.content).toEqual([
      { type: "text", text: "Reading file..." },
      { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "/tmp/x" } },
    ]);
    expect(msg.stopReason).toBe("tool_use");
  });

  test("onTextDelta callback fires for every text chunk", async () => {
    const chunks: string[] = [];
    await consumeStream(synthStream([...TEXT_ONLY_STREAM]), {
      onTextDelta: (c) => chunks.push(c),
    });
    expect(chunks).toEqual(["Hello", ", world"]);
  });

  test("onToolUseComplete fires once per tool_use block with parsed input", async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    await consumeStream(synthStream([...TOOL_USE_STREAM]), {
      onToolUseComplete: (b) => calls.push({ name: b.name, input: b.input }),
    });
    expect(calls).toEqual([{ name: "Read", input: { path: "/tmp/x" } }]);
  });

  test("malformed JSON in tool_use buffer → __parse_error sentinel, no throw", async () => {
    const stream: StreamEvent[] = [
      { kind: "message_start" },
      {
        kind: "content_block_start",
        index: 0,
        block: { type: "tool_use", id: "toolu_x", name: "Bad", input: {} },
      },
      {
        kind: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{not_json" },
      },
      { kind: "content_block_stop", index: 0 },
      { kind: "message_delta", stopReason: "tool_use" },
      { kind: "message_stop" },
    ];
    const msg = await consumeStream(synthStream(stream));
    const tu = msg.content[0];
    if (tu?.type !== "tool_use") throw new Error("expected tool_use block");
    expect((tu.input as { __parse_error?: boolean }).__parse_error).toBe(true);
  });

  test("error event throws AdapterError", async () => {
    const stream: StreamEvent[] = [
      { kind: "message_start" },
      { kind: "error", error: { type: "overloaded_error", message: "rate limited" } },
    ];
    await expect(consumeStream(synthStream(stream))).rejects.toThrow("stream error: rate limited");
  });

  test("onStart fires once with the initial usage shape", async () => {
    const starts: Array<TokenUsage | undefined> = [];
    await consumeStream(synthStream([...TEXT_ONLY_STREAM]), {
      onStart: (u) => starts.push(u),
    });
    expect(starts).toEqual([{ input: 5, output: 0 }]);
  });

  test("onStart only fires on the first message_start", async () => {
    // Two message_start events: the guard (`!started`) must suppress the
    // second callback even though usage is updated again.
    const stream: StreamEvent[] = [
      { kind: "message_start", usage: { input: 1, output: 0 } },
      { kind: "message_start", usage: { input: 2, output: 0 } },
      { kind: "message_stop" },
    ];
    const starts: Array<TokenUsage | undefined> = [];
    await consumeStream(synthStream(stream), { onStart: (u) => starts.push(u) });
    expect(starts).toEqual([{ input: 1, output: 0 }]);
  });

  test("message_start without usage still drives onStart with undefined", async () => {
    const stream: StreamEvent[] = [{ kind: "message_start" }, { kind: "message_stop" }];
    const starts: Array<TokenUsage | undefined> = [];
    await consumeStream(synthStream(stream), { onStart: (u) => starts.push(u) });
    expect(starts).toEqual([undefined]);
  });

  test("thinking block: start + thinking_delta + signature_delta accumulate", async () => {
    const stream: StreamEvent[] = [
      { kind: "message_start", usage: { input: 3, output: 0 } },
      {
        kind: "content_block_start",
        index: 0,
        block: { type: "thinking", thinking: "seed " },
      },
      {
        kind: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "step one " },
      },
      {
        kind: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "step two" },
      },
      {
        kind: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig-final" },
      },
      { kind: "content_block_stop", index: 0 },
      { kind: "message_delta", stopReason: "end_turn" },
      { kind: "message_stop" },
    ];
    const msg = await consumeStream(synthStream(stream));
    expect(msg.content).toEqual([
      { type: "thinking", thinking: "seed step one step two", signature: "sig-final" },
    ]);
  });

  test("thinking block carrying an initial signature is preserved", async () => {
    const stream: StreamEvent[] = [
      { kind: "message_start" },
      {
        kind: "content_block_start",
        index: 0,
        block: { type: "thinking", thinking: "x", signature: "preset" },
      },
      { kind: "content_block_stop", index: 0 },
      { kind: "message_stop" },
    ];
    const msg = await consumeStream(synthStream(stream));
    expect(msg.content).toEqual([{ type: "thinking", thinking: "x", signature: "preset" }]);
  });

  test("thinking block with no signature omits the field in final content", async () => {
    const stream: StreamEvent[] = [
      { kind: "message_start" },
      {
        kind: "content_block_start",
        index: 0,
        block: { type: "thinking", thinking: "unsigned" },
      },
      { kind: "content_block_stop", index: 0 },
      { kind: "message_stop" },
    ];
    const msg = await consumeStream(synthStream(stream));
    expect(msg.content).toEqual([{ type: "thinking", thinking: "unsigned" }]);
  });

  test("delta for an unknown block index is ignored (no block to mutate)", async () => {
    const stream: StreamEvent[] = [
      { kind: "message_start" },
      // No content_block_start for index 0 — the delta must be a no-op.
      {
        kind: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "orphan" },
      },
      { kind: "message_stop" },
    ];
    const msg = await consumeStream(synthStream(stream));
    expect(msg.content).toEqual([]);
  });

  test("content_block_stop for an unknown index is ignored", async () => {
    const stream: StreamEvent[] = [
      { kind: "message_start" },
      { kind: "content_block_stop", index: 9 },
      { kind: "message_stop" },
    ];
    const msg = await consumeStream(synthStream(stream));
    expect(msg.content).toEqual([]);
  });

  test("type-mismatched deltas are ignored (text_delta on a tool_use block, etc.)", async () => {
    // Each delta targets a block whose accumulated type doesn't match the
    // delta type, exercising the `if (block.type === ...)` false arms.
    const stream: StreamEvent[] = [
      { kind: "message_start" },
      {
        kind: "content_block_start",
        index: 0,
        block: { type: "tool_use", id: "t1", name: "X", input: {} },
      },
      // text_delta on a tool_use block — ignored.
      { kind: "content_block_delta", index: 0, delta: { type: "text_delta", text: "nope" } },
      // thinking_delta on a tool_use block — ignored.
      {
        kind: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "nope" },
      },
      // signature_delta on a tool_use block — ignored.
      {
        kind: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "nope" },
      },
      {
        kind: "content_block_start",
        index: 1,
        block: { type: "text", text: "" },
      },
      // input_json_delta on a text block — ignored.
      {
        kind: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "{}" },
      },
      { kind: "content_block_stop", index: 0 },
      { kind: "content_block_stop", index: 1 },
      { kind: "message_stop" },
    ];
    const msg = await consumeStream(synthStream(stream));
    // tool_use got no JSON → empty-object input; text stayed empty.
    expect(msg.content).toEqual([
      { type: "tool_use", id: "t1", name: "X", input: {} },
      { type: "text", text: "" },
    ]);
  });

  test("tool_use with empty json buffer yields empty-object input", async () => {
    const stream: StreamEvent[] = [
      { kind: "message_start" },
      {
        kind: "content_block_start",
        index: 0,
        block: { type: "tool_use", id: "t0", name: "NoArgs", input: {} },
      },
      // No input_json_delta at all → jsonBuffer stays "".
      { kind: "content_block_stop", index: 0 },
      { kind: "message_stop" },
    ];
    const calls: unknown[] = [];
    const msg = await consumeStream(synthStream(stream), {
      onToolUseComplete: (b) => calls.push(b.input),
    });
    expect(calls).toEqual([{}]);
    expect(msg.content).toEqual([{ type: "tool_use", id: "t0", name: "NoArgs", input: {} }]);
  });

  test("truncated tool_use (no content_block_stop) → __parse_error in final flatten", async () => {
    // When the stream is cut off before content_block_stop, jsonBuffer still
    // holds the raw partial JSON. The final flatten re-parses it and falls
    // back to the __parse_error sentinel.
    const stream: StreamEvent[] = [
      { kind: "message_start" },
      {
        kind: "content_block_start",
        index: 0,
        block: { type: "tool_use", id: "trunc", name: "Edit", input: {} },
      },
      {
        kind: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"path":"/x' },
      },
      // NOTE: no content_block_stop, no message_stop — stream just ends.
    ];
    const msg = await consumeStream(synthStream(stream));
    const block = msg.content[0];
    if (block?.type !== "tool_use") throw new Error("expected tool_use block");
    expect((block.input as { __parse_error?: boolean }).__parse_error).toBe(true);
    expect((block.input as { raw?: string }).raw).toBe('{"path":"/x');
  });

  test("message_delta carries over prior cache counts when not re-sent", async () => {
    // cacheRead/cacheCreate seeded at message_start must survive a
    // message_delta that omits them.
    const stream: StreamEvent[] = [
      {
        kind: "message_start",
        usage: { input: 100, output: 0, cacheRead: 20, cacheCreate: 5 },
      },
      { kind: "message_delta", usage: { input: 0, output: 50 } },
      { kind: "message_stop" },
    ];
    const msg = await consumeStream(synthStream(stream));
    expect(msg.usage).toEqual({ input: 100, output: 50, cacheRead: 20, cacheCreate: 5 });
  });

  test("message_delta updates cache counts when freshly provided", async () => {
    const stream: StreamEvent[] = [
      { kind: "message_start", usage: { input: 10, output: 0 } },
      {
        kind: "message_delta",
        usage: { input: 0, output: 9, cacheRead: 3, cacheCreate: 1 },
      },
      { kind: "message_stop" },
    ];
    const msg = await consumeStream(synthStream(stream));
    expect(msg.usage).toEqual({ input: 10, output: 9, cacheRead: 3, cacheCreate: 1 });
  });

  test("message_delta keeps prior input when its own input is 0", async () => {
    const stream: StreamEvent[] = [
      { kind: "message_start", usage: { input: 42, output: 0 } },
      // input:0 means "unchanged"; output:0 also means "unchanged".
      { kind: "message_delta", usage: { input: 0, output: 0 } },
      { kind: "message_stop" },
    ];
    const msg = await consumeStream(synthStream(stream));
    expect(msg.usage).toEqual({ input: 42, output: 0 });
  });

  test("message_delta with positive input overrides the seed input", async () => {
    const stream: StreamEvent[] = [
      { kind: "message_start", usage: { input: 5, output: 0 } },
      { kind: "message_delta", usage: { input: 8, output: 2 } },
      { kind: "message_stop" },
    ];
    const msg = await consumeStream(synthStream(stream));
    expect(msg.usage).toEqual({ input: 8, output: 2 });
  });

  test("message_start without usage leaves the zero usage seed", async () => {
    const stream: StreamEvent[] = [{ kind: "message_start" }, { kind: "message_stop" }];
    const msg = await consumeStream(synthStream(stream));
    expect(msg.usage).toEqual({ input: 0, output: 0 });
  });

  test("message_delta without usage leaves usage untouched", async () => {
    const stream: StreamEvent[] = [
      { kind: "message_start", usage: { input: 11, output: 0 } },
      { kind: "message_delta", stopReason: "end_turn" },
      { kind: "message_stop" },
    ];
    const msg = await consumeStream(synthStream(stream));
    expect(msg.usage).toEqual({ input: 11, output: 0 });
    expect(msg.stopReason).toBe("end_turn");
  });

  test("message_delta without stopReason keeps the default end_turn", async () => {
    const stream: StreamEvent[] = [
      { kind: "message_start" },
      { kind: "message_delta", usage: { input: 0, output: 3 } },
      { kind: "message_stop" },
    ];
    const msg = await consumeStream(synthStream(stream));
    expect(msg.stopReason).toBe("end_turn");
  });
});

describe("collectFinalMessage", () => {
  test("equivalent to consumeStream() with no callbacks", async () => {
    const msg = await collectFinalMessage(synthStream([...TEXT_ONLY_STREAM]));
    expect(msg.content).toEqual([{ type: "text", text: "Hello, world" }]);
  });
});

describe("extractFirstText / extractToolUse", () => {
  test("extractFirstText returns first text block", () => {
    const msg = {
      content: [
        { type: "tool_use" as const, id: "x", name: "y", input: {} },
        { type: "text" as const, text: "answer" },
      ],
      stopReason: "end_turn",
      usage: { input: 0, output: 0 },
    };
    expect(extractFirstText(msg)).toBe("answer");
  });

  test("extractFirstText returns undefined when no text block", () => {
    const msg = {
      content: [{ type: "tool_use" as const, id: "x", name: "y", input: {} }],
      stopReason: "tool_use",
      usage: { input: 0, output: 0 },
    };
    expect(extractFirstText(msg)).toBeUndefined();
  });

  test("extractToolUse finds named tool", () => {
    const msg = {
      content: [
        { type: "text" as const, text: "thinking..." },
        { type: "tool_use" as const, id: "id_a", name: "submit_score", input: { score: 5 } },
      ],
      stopReason: "tool_use",
      usage: { input: 0, output: 0 },
    };
    const found = extractToolUse(msg, "submit_score");
    expect(found?.input).toEqual({ score: 5 });
  });

  test("extractToolUse returns undefined when the named tool is absent", () => {
    const msg = {
      content: [
        { type: "text" as const, text: "no tools here" },
        { type: "tool_use" as const, id: "id_b", name: "other_tool", input: {} },
      ],
      stopReason: "tool_use",
      usage: { input: 0, output: 0 },
    };
    // Walks every block, matches none → undefined (final return path).
    expect(extractToolUse(msg, "submit_score")).toBeUndefined();
  });

  test("extractToolUse returns undefined for an empty content array", () => {
    const msg = {
      content: [],
      stopReason: "end_turn",
      usage: { input: 0, output: 0 },
    };
    expect(extractToolUse(msg, "anything")).toBeUndefined();
  });
});
