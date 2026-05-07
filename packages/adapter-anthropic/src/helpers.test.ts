import { describe, expect, test } from "bun:test";
import { collectFinalMessage, consumeStream, extractFirstText, extractToolUse } from "./helpers.js";
import type { StreamEvent } from "./types.js";

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
});
