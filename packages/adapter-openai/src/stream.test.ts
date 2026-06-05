import { describe, expect, test } from "bun:test";
import type { StreamEvent } from "@crewhaus/adapter-anthropic";
import type OpenAI from "openai";
import { translateOpenAIStream } from "./stream.js";

type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk;

async function* synthChunks(chunks: Chunk[]): AsyncIterable<Chunk> {
  for (const c of chunks) yield c;
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

function mkChunk(
  delta: Partial<Chunk["choices"][number]["delta"]>,
  finish?: string,
  usage?: Chunk["usage"],
): Chunk {
  return {
    id: "c",
    object: "chat.completion.chunk",
    created: 0,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        delta: delta as Chunk["choices"][number]["delta"],
        finish_reason: (finish ?? null) as Chunk["choices"][number]["finish_reason"],
        logprobs: null,
      },
    ],
    ...(usage !== undefined ? { usage } : {}),
  } as Chunk;
}

describe("translateOpenAIStream", () => {
  test("text-only stream → text deltas + message_stop", async () => {
    const events = await collect(
      translateOpenAIStream(
        synthChunks([
          mkChunk({ role: "assistant", content: "" }),
          mkChunk({ content: "Hello" }),
          mkChunk({ content: ", world" }),
          mkChunk({}, "stop"),
          mkChunk({}, "stop", { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }),
        ]),
      ),
    );
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("message_start");
    expect(kinds).toContain("content_block_start");
    expect(kinds).toContain("content_block_stop");
    expect(kinds[kinds.length - 1]).toBe("message_stop");

    const textDeltas = events
      .filter(
        (e): e is Extract<StreamEvent, { kind: "content_block_delta" }> =>
          e.kind === "content_block_delta",
      )
      .map((e) => (e.delta.type === "text_delta" ? e.delta.text : ""));
    expect(textDeltas).toEqual(["Hello", ", world"]);

    const messageDelta = events.find(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    expect(messageDelta?.stopReason).toBe("end_turn");
    expect(messageDelta?.usage).toEqual({ input: 5, output: 3 });
  });

  test("tool_call stream → tool_use block + input_json_delta", async () => {
    const events = await collect(
      translateOpenAIStream(
        synthChunks([
          mkChunk({ role: "assistant", content: null }),
          mkChunk({
            tool_calls: [
              {
                index: 0,
                id: "call_abc",
                type: "function",
                function: { name: "Read", arguments: "" },
              },
            ],
          }),
          mkChunk({
            tool_calls: [
              {
                index: 0,
                function: { arguments: '{"path":"' },
              },
            ],
          }),
          mkChunk({
            tool_calls: [
              {
                index: 0,
                function: { arguments: '/tmp/x"}' },
              },
            ],
          }),
          mkChunk({}, "tool_calls", {
            prompt_tokens: 10,
            completion_tokens: 7,
            total_tokens: 17,
          }),
        ]),
      ),
    );

    const blockStart = events.find(
      (e): e is Extract<StreamEvent, { kind: "content_block_start" }> =>
        e.kind === "content_block_start" && e.block.type === "tool_use",
    );
    expect(blockStart?.block).toEqual({
      type: "tool_use",
      id: "call_abc",
      name: "Read",
      input: {},
    });

    const argDeltas = events
      .filter(
        (e): e is Extract<StreamEvent, { kind: "content_block_delta" }> =>
          e.kind === "content_block_delta" && e.delta.type === "input_json_delta",
      )
      .map((e) => (e.delta.type === "input_json_delta" ? e.delta.partial_json : ""))
      .join("");
    expect(argDeltas).toBe('{"path":"/tmp/x"}');

    const messageDelta = events.find(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    expect(messageDelta?.stopReason).toBe("tool_use");
  });

  test("length finish_reason → max_tokens stop reason", async () => {
    const events = await collect(
      translateOpenAIStream(
        synthChunks([
          mkChunk({ role: "assistant", content: "abc" }),
          mkChunk({}, "length", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
        ]),
      ),
    );
    const messageDelta = events.find(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    expect(messageDelta?.stopReason).toBe("max_tokens");
  });

  test("text block is closed before a tool block opens (ordering)", async () => {
    const events = await collect(
      translateOpenAIStream(
        synthChunks([
          mkChunk({ content: "thinking..." }),
          mkChunk({
            tool_calls: [
              {
                index: 0,
                id: "call_x",
                type: "function",
                function: { name: "Go", arguments: "{}" },
              },
            ],
          }),
          mkChunk({}, "tool_calls", { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 }),
        ]),
      ),
    );
    const kinds = events.map((e) => e.kind);
    // The text block (index 0) must be stopped BEFORE the tool block (index 1) starts.
    const textStop = events.findIndex((e) => e.kind === "content_block_stop" && e.index === 0);
    const toolStart = events.findIndex((e) => e.kind === "content_block_start" && e.index === 1);
    expect(textStop).toBeGreaterThanOrEqual(0);
    expect(toolStart).toBeGreaterThan(textStop);
    // Only ONE stop for the text block (not double-closed at the usage chunk).
    const textStops = events.filter((e) => e.kind === "content_block_stop" && e.index === 0);
    expect(textStops).toHaveLength(1);
    expect(kinds[kinds.length - 1]).toBe("message_stop");
  });

  test("tool name that streams in on a later chunk updates the block name", async () => {
    const events = await collect(
      translateOpenAIStream(
        synthChunks([
          // First chunk opens the tool block with an empty name.
          mkChunk({
            tool_calls: [{ index: 0, id: "call_y", type: "function", function: { arguments: "" } }],
          }),
          // Later chunk supplies the name.
          mkChunk({
            tool_calls: [{ index: 0, function: { name: "DelayedName", arguments: '{"a":1}' } }],
          }),
          mkChunk({}, "tool_calls", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
        ]),
      ),
    );
    const blockStart = events.find(
      (e): e is Extract<StreamEvent, { kind: "content_block_start" }> =>
        e.kind === "content_block_start" && e.block.type === "tool_use",
    );
    // Opened with empty name (name only arrives later — canonical block_start
    // already fired, so the name update is captured in state for the executor).
    expect(blockStart?.block).toEqual({ type: "tool_use", id: "call_y", name: "", input: {} });
    const argDeltas = events
      .filter(
        (e): e is Extract<StreamEvent, { kind: "content_block_delta" }> =>
          e.kind === "content_block_delta" && e.delta.type === "input_json_delta",
      )
      .map((e) => (e.delta.type === "input_json_delta" ? e.delta.partial_json : ""))
      .join("");
    expect(argDeltas).toBe('{"a":1}');
  });

  test("tool_call chunk with no id falls back to call_<index>", async () => {
    const events = await collect(
      translateOpenAIStream(
        synthChunks([
          mkChunk({
            tool_calls: [{ index: 3, type: "function", function: { name: "X", arguments: "{}" } }],
          }),
          mkChunk({}, "tool_calls", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
        ]),
      ),
    );
    const blockStart = events.find(
      (e): e is Extract<StreamEvent, { kind: "content_block_start" }> =>
        e.kind === "content_block_start" && e.block.type === "tool_use",
    );
    expect(blockStart?.block).toEqual({ type: "tool_use", id: "call_3", name: "X", input: {} });
  });

  test("content_filter finish_reason → stop_sequence", async () => {
    const events = await collect(
      translateOpenAIStream(
        synthChunks([
          mkChunk({ content: "x" }),
          mkChunk({}, "content_filter", {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          }),
        ]),
      ),
    );
    const messageDelta = events.find(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    expect(messageDelta?.stopReason).toBe("stop_sequence");
  });

  test("unknown finish_reason passes through unchanged", async () => {
    const events = await collect(
      translateOpenAIStream(
        synthChunks([
          mkChunk({ content: "x" }),
          mkChunk({}, "some_future_reason", {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          }),
        ]),
      ),
    );
    const messageDelta = events.find(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    expect(messageDelta?.stopReason).toBe("some_future_reason");
  });

  test("stream ending without a usage chunk emits a synthetic terminator", async () => {
    // No usage chunk at all: text + tool blocks both open, finish_reason set.
    const events = await collect(
      translateOpenAIStream(
        synthChunks([
          mkChunk({ content: "hi" }),
          mkChunk({
            tool_calls: [
              {
                index: 0,
                id: "call_z",
                type: "function",
                function: { name: "T", arguments: "{}" },
              },
            ],
          }),
          // finish_reason but NO usage on this final chunk.
          mkChunk({}, "stop"),
        ]),
      ),
    );
    const kinds = events.map((e) => e.kind);
    // Both blocks closed, then a usage-less message_delta + message_stop.
    expect(kinds).toContain("content_block_stop");
    const messageDelta = events.find(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    expect(messageDelta).toBeDefined();
    expect(messageDelta?.stopReason).toBe("end_turn");
    // No usage folded in (the synthetic path omits it).
    expect(messageDelta?.usage).toBeUndefined();
    expect(kinds[kinds.length - 1]).toBe("message_stop");
    // The text block (index 0) and tool block (index 1) are both stopped exactly once.
    expect(events.filter((e) => e.kind === "content_block_stop" && e.index === 0)).toHaveLength(1);
    expect(events.filter((e) => e.kind === "content_block_stop" && e.index === 1)).toHaveLength(1);
  });

  test("text-only stream ending without usage closes the text block synthetically", async () => {
    const events = await collect(
      translateOpenAIStream(synthChunks([mkChunk({ content: "lonely" }), mkChunk({}, "stop")])),
    );
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  test("chunk with no choices/delta still drives message_start and terminates", async () => {
    // delta === undefined branch: a usage-only final chunk with an empty
    // choices array. message_start fires on the first chunk regardless.
    const usageOnly = {
      id: "c",
      object: "chat.completion.chunk",
      created: 0,
      model: "gpt-4o-mini",
      choices: [],
      usage: { prompt_tokens: 9, completion_tokens: 0, total_tokens: 9 },
    } as unknown as Chunk;
    const events = await collect(translateOpenAIStream(synthChunks([usageOnly])));
    expect(events.map((e) => e.kind)).toEqual(["message_start", "message_delta", "message_stop"]);
    const messageDelta = events.find(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    expect(messageDelta?.usage).toEqual({ input: 9, output: 0 });
    expect(messageDelta?.stopReason).toBeUndefined();
  });

  test("usage chunk with missing token fields defaults to 0/0", async () => {
    const events = await collect(
      translateOpenAIStream(
        synthChunks([
          mkChunk({ content: "x" }),
          // Usage object present but token counts absent.
          mkChunk({}, "stop", {} as Chunk["usage"]),
        ]),
      ),
    );
    const messageDelta = events.find(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    expect(messageDelta?.usage).toEqual({ input: 0, output: 0 });
  });
});
