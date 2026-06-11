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

  test("tool name that streams in on a later chunk: block_start is deferred until the name", async () => {
    const events = await collect(
      translateOpenAIStream(
        synthChunks([
          // First chunk mentions the tool call but carries no name yet.
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
    // The canonical block_start fires with the late name (downstream
    // consumers capture the name at block_start).
    expect(blockStart?.block).toEqual({
      type: "tool_use",
      id: "call_y",
      name: "DelayedName",
      input: {},
    });
    const argDeltas = events
      .filter(
        (e): e is Extract<StreamEvent, { kind: "content_block_delta" }> =>
          e.kind === "content_block_delta" && e.delta.type === "input_json_delta",
      )
      .map((e) => (e.delta.type === "input_json_delta" ? e.delta.partial_json : ""))
      .join("");
    expect(argDeltas).toBe('{"a":1}');
  });

  test("argument fragments before a late name are buffered and flushed after the deferred start", async () => {
    const events = await collect(
      translateOpenAIStream(
        synthChunks([
          // Args start flowing before the name is known.
          mkChunk({
            tool_calls: [
              { index: 0, id: "call_b", type: "function", function: { arguments: '{"pa' } },
            ],
          }),
          mkChunk({
            tool_calls: [{ index: 0, function: { arguments: 'th":' } }],
          }),
          // Name only arrives now.
          mkChunk({
            tool_calls: [{ index: 0, function: { name: "Read", arguments: '"/x"}' } }],
          }),
          mkChunk({}, "tool_calls", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
        ]),
      ),
    );
    const startIdx = events.findIndex(
      (e) => e.kind === "content_block_start" && e.block.type === "tool_use",
    );
    const firstArgIdx = events.findIndex(
      (e) => e.kind === "content_block_delta" && e.delta.type === "input_json_delta",
    );
    // No input_json_delta before the block_start.
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(firstArgIdx).toBeGreaterThan(startIdx);
    const blockStart = events[startIdx] as Extract<StreamEvent, { kind: "content_block_start" }>;
    expect(blockStart.block).toEqual({ type: "tool_use", id: "call_b", name: "Read", input: {} });
    const argDeltas = events
      .filter(
        (e): e is Extract<StreamEvent, { kind: "content_block_delta" }> =>
          e.kind === "content_block_delta" && e.delta.type === "input_json_delta",
      )
      .map((e) => (e.delta.type === "input_json_delta" ? e.delta.partial_json : ""));
    // Buffered fragments flushed as one delta, then live fragments.
    expect(argDeltas.join("")).toBe('{"path":"/x"}');
  });

  test("tool call whose name never arrives still starts (empty name) with buffered args", async () => {
    const events = await collect(
      translateOpenAIStream(
        synthChunks([
          mkChunk({
            tool_calls: [
              { index: 0, id: "call_n", type: "function", function: { arguments: '{"x":' } },
            ],
          }),
          mkChunk({
            tool_calls: [{ index: 0, function: { arguments: "1}" } }],
          }),
          mkChunk({}, "tool_calls", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
        ]),
      ),
    );
    const startIdx = events.findIndex(
      (e) => e.kind === "content_block_start" && e.block.type === "tool_use",
    );
    const firstArgIdx = events.findIndex(
      (e) => e.kind === "content_block_delta" && e.delta.type === "input_json_delta",
    );
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(firstArgIdx).toBeGreaterThan(startIdx);
    const blockStart = events[startIdx] as Extract<StreamEvent, { kind: "content_block_start" }>;
    expect(blockStart.block).toEqual({ type: "tool_use", id: "call_n", name: "", input: {} });
    const argDeltas = events
      .filter(
        (e): e is Extract<StreamEvent, { kind: "content_block_delta" }> =>
          e.kind === "content_block_delta" && e.delta.type === "input_json_delta",
      )
      .map((e) => (e.delta.type === "input_json_delta" ? e.delta.partial_json : ""));
    expect(argDeltas.join("")).toBe('{"x":1}');
    // The block is stopped exactly once.
    const stops = events.filter((e) => e.kind === "content_block_stop" && e.index === 0);
    expect(stops).toHaveLength(1);
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

  test("distinct complete tool calls reusing index 0 yield two canonical blocks", async () => {
    // Historical Ollama parallel calls: each complete tool call arrives
    // as one chunk, always at index 0 with a fresh id. Without id-based
    // identity the second call's arguments concatenate into the first.
    const events = await collect(
      translateOpenAIStream(
        synthChunks([
          mkChunk({
            tool_calls: [
              {
                index: 0,
                id: "call_a",
                type: "function",
                function: { name: "A", arguments: '{"a":1}' },
              },
            ],
          }),
          mkChunk({
            tool_calls: [
              {
                index: 0,
                id: "call_b",
                type: "function",
                function: { name: "B", arguments: '{"b":2}' },
              },
            ],
          }),
          mkChunk({}, "tool_calls", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
        ]),
      ),
    );
    const starts = events.filter(
      (e): e is Extract<StreamEvent, { kind: "content_block_start" }> =>
        e.kind === "content_block_start" && e.block.type === "tool_use",
    );
    expect(starts).toHaveLength(2);
    expect(starts[0]?.block).toEqual({ type: "tool_use", id: "call_a", name: "A", input: {} });
    expect(starts[1]?.block).toEqual({ type: "tool_use", id: "call_b", name: "B", input: {} });
    // Distinct canonical indices, and the first block stops before the
    // second one starts.
    expect(starts[0]?.index).not.toBe(starts[1]?.index);
    const firstStop = events.findIndex(
      (e) => e.kind === "content_block_stop" && e.index === starts[0]?.index,
    );
    const secondStart = events.findIndex(
      (e) => e.kind === "content_block_start" && e.index === starts[1]?.index,
    );
    expect(firstStop).toBeGreaterThanOrEqual(0);
    expect(secondStart).toBeGreaterThan(firstStop);
    // Each block carries exactly its own arguments — no concatenation.
    const argsByIndex = new Map<number, string>();
    for (const e of events) {
      if (e.kind === "content_block_delta" && e.delta.type === "input_json_delta") {
        argsByIndex.set(e.index, (argsByIndex.get(e.index) ?? "") + e.delta.partial_json);
      }
    }
    expect(argsByIndex.get(starts[0]?.index ?? -1)).toBe('{"a":1}');
    expect(argsByIndex.get(starts[1]?.index ?? -1)).toBe('{"b":2}');
    // Every block stopped exactly once.
    for (const s of starts) {
      expect(
        events.filter((e) => e.kind === "content_block_stop" && e.index === s.index),
      ).toHaveLength(1);
    }
  });

  test("tool calls with omitted index are keyed by id (no silent merge)", async () => {
    // Some compat servers omit `index` entirely. With distinct ids the
    // calls must still produce distinct canonical blocks.
    const noIndex = (tc: object) => tc as Chunk["choices"][number]["delta"]["tool_calls"];
    const events = await collect(
      translateOpenAIStream(
        synthChunks([
          mkChunk({
            tool_calls: noIndex([
              { id: "call_p", type: "function", function: { name: "P", arguments: '{"p":1}' } },
            ]),
          }),
          mkChunk({
            tool_calls: noIndex([
              { id: "call_q", type: "function", function: { name: "Q", arguments: '{"q":2}' } },
            ]),
          }),
          mkChunk({}, "tool_calls", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
        ]),
      ),
    );
    const starts = events.filter(
      (e): e is Extract<StreamEvent, { kind: "content_block_start" }> =>
        e.kind === "content_block_start" && e.block.type === "tool_use",
    );
    expect(starts).toHaveLength(2);
    expect(starts.map((s) => (s.block.type === "tool_use" ? s.block.id : ""))).toEqual([
      "call_p",
      "call_q",
    ]);
  });

  test("same id repeated across chunks at the same index is one tool call", async () => {
    // Some servers re-send the id on every fragment — that's still a
    // single call, not an index-reuse split.
    const events = await collect(
      translateOpenAIStream(
        synthChunks([
          mkChunk({
            tool_calls: [
              {
                index: 0,
                id: "call_s",
                type: "function",
                function: { name: "S", arguments: '{"s":' },
              },
            ],
          }),
          mkChunk({
            tool_calls: [{ index: 0, id: "call_s", function: { arguments: "1}" } }],
          }),
          mkChunk({}, "tool_calls", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
        ]),
      ),
    );
    const starts = events.filter(
      (e) => e.kind === "content_block_start" && e.block.type === "tool_use",
    );
    expect(starts).toHaveLength(1);
    const argDeltas = events
      .filter(
        (e): e is Extract<StreamEvent, { kind: "content_block_delta" }> =>
          e.kind === "content_block_delta" && e.delta.type === "input_json_delta",
      )
      .map((e) => (e.delta.type === "input_json_delta" ? e.delta.partial_json : ""))
      .join("");
    expect(argDeltas).toBe('{"s":1}');
  });

  test("chunk with absent choices key does not throw (compat null-shape guard)", async () => {
    const noChoices = {
      id: "c",
      object: "chat.completion.chunk",
      created: 0,
      model: "local-model",
    } as unknown as Chunk;
    const events = await collect(
      translateOpenAIStream(
        synthChunks([
          noChoices,
          mkChunk({ content: "still works" }),
          mkChunk({}, "stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
        ]),
      ),
    );
    const textDeltas = events
      .filter(
        (e): e is Extract<StreamEvent, { kind: "content_block_delta" }> =>
          e.kind === "content_block_delta" && e.delta.type === "text_delta",
      )
      .map((e) => (e.delta.type === "text_delta" ? e.delta.text : ""));
    expect(textDeltas).toEqual(["still works"]);
    expect(events.map((e) => e.kind).at(-1)).toBe("message_stop");
  });

  test("chunk with delta: null does not throw (compat null-shape guard)", async () => {
    const nullDelta = {
      id: "c",
      object: "chat.completion.chunk",
      created: 0,
      model: "local-model",
      choices: [{ index: 0, delta: null, finish_reason: null, logprobs: null }],
    } as unknown as Chunk;
    const events = await collect(
      translateOpenAIStream(
        synthChunks([
          nullDelta,
          mkChunk({ content: "ok" }),
          mkChunk({}, "stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
        ]),
      ),
    );
    const textDeltas = events
      .filter(
        (e): e is Extract<StreamEvent, { kind: "content_block_delta" }> =>
          e.kind === "content_block_delta" && e.delta.type === "text_delta",
      )
      .map((e) => (e.delta.type === "text_delta" ? e.delta.text : ""));
    expect(textDeltas).toEqual(["ok"]);
  });

  test("continuous usage stats on every chunk do not truncate the stream (vLLM)", async () => {
    // vLLM with continuous_usage_stats attaches running usage to EVERY
    // chunk (with non-empty choices). The stream must not terminate at
    // the first chunk.
    const events = await collect(
      translateOpenAIStream(
        synthChunks([
          mkChunk({ content: "Hel" }, undefined, {
            prompt_tokens: 4,
            completion_tokens: 1,
            total_tokens: 5,
          }),
          mkChunk({ content: "lo" }, undefined, {
            prompt_tokens: 4,
            completion_tokens: 2,
            total_tokens: 6,
          }),
          mkChunk({}, "stop", { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }),
        ]),
      ),
    );
    const textDeltas = events
      .filter(
        (e): e is Extract<StreamEvent, { kind: "content_block_delta" }> =>
          e.kind === "content_block_delta" && e.delta.type === "text_delta",
      )
      .map((e) => (e.delta.type === "text_delta" ? e.delta.text : ""));
    expect(textDeltas).toEqual(["Hel", "lo"]);
    const messageDeltas = events.filter(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    expect(messageDeltas).toHaveLength(1);
    expect(messageDeltas[0]?.stopReason).toBe("end_turn");
    expect(messageDeltas[0]?.usage).toEqual({ input: 4, output: 3 });
    expect(events.map((e) => e.kind).at(-1)).toBe("message_stop");
  });

  test("continuous usage with no terminal chunk: latest usage rides the synthetic terminator", async () => {
    const events = await collect(
      translateOpenAIStream(
        synthChunks([
          mkChunk({ content: "x" }, undefined, {
            prompt_tokens: 2,
            completion_tokens: 5,
            total_tokens: 7,
          }),
        ]),
      ),
    );
    const messageDelta = events.find(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    expect(messageDelta?.usage).toEqual({ input: 2, output: 5 });
    expect(events.map((e) => e.kind).at(-1)).toBe("message_stop");
  });

  test("reasoning_content deltas surface as a canonical thinking block (DeepSeek-R1)", async () => {
    type DeltaWithReasoning = Partial<Chunk["choices"][number]["delta"]> & {
      reasoning_content?: string;
    };
    const reasoning = (s: string): DeltaWithReasoning => ({ reasoning_content: s });
    const events = await collect(
      translateOpenAIStream(
        synthChunks([
          mkChunk(reasoning("Let me think")),
          mkChunk(reasoning(" about this.")),
          mkChunk({ content: "Answer: 42" }),
          mkChunk({}, "stop", { prompt_tokens: 3, completion_tokens: 9, total_tokens: 12 }),
        ]),
      ),
    );
    const thinkingStart = events.find(
      (e): e is Extract<StreamEvent, { kind: "content_block_start" }> =>
        e.kind === "content_block_start" && e.block.type === "thinking",
    );
    expect(thinkingStart?.block).toEqual({ type: "thinking", thinking: "" });
    const thinkingDeltas = events
      .filter(
        (e): e is Extract<StreamEvent, { kind: "content_block_delta" }> =>
          e.kind === "content_block_delta" && e.delta.type === "thinking_delta",
      )
      .map((e) => (e.delta.type === "thinking_delta" ? e.delta.thinking : ""));
    expect(thinkingDeltas).toEqual(["Let me think", " about this."]);
    // The thinking block closes BEFORE the text block opens.
    const thinkingIdx = thinkingStart?.index ?? -1;
    const thinkingStop = events.findIndex(
      (e) => e.kind === "content_block_stop" && e.index === thinkingIdx,
    );
    const textStart = events.findIndex(
      (e) => e.kind === "content_block_start" && e.block.type === "text",
    );
    expect(thinkingStop).toBeGreaterThanOrEqual(0);
    expect(textStart).toBeGreaterThan(thinkingStop);
    // Thinking stopped exactly once (not double-closed at the terminal).
    expect(
      events.filter((e) => e.kind === "content_block_stop" && e.index === thinkingIdx),
    ).toHaveLength(1);
    const textDeltas = events
      .filter(
        (e): e is Extract<StreamEvent, { kind: "content_block_delta" }> =>
          e.kind === "content_block_delta" && e.delta.type === "text_delta",
      )
      .map((e) => (e.delta.type === "text_delta" ? e.delta.text : ""));
    expect(textDeltas).toEqual(["Answer: 42"]);
  });

  test("reasoning-only stream closes the thinking block at the terminal", async () => {
    type DeltaWithReasoning = Partial<Chunk["choices"][number]["delta"]> & {
      reasoning_content?: string;
    };
    const events = await collect(
      translateOpenAIStream(
        synthChunks([
          mkChunk({ reasoning_content: "all thought, no talk" } as DeltaWithReasoning),
          mkChunk({}, "stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
        ]),
      ),
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
    const start = events.find(
      (e): e is Extract<StreamEvent, { kind: "content_block_start" }> =>
        e.kind === "content_block_start",
    );
    expect(start?.block.type).toBe("thinking");
  });
});
