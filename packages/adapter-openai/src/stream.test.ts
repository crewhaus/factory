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
});
