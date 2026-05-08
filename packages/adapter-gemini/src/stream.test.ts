import { describe, expect, test } from "bun:test";
import type { StreamEvent } from "@crewhaus/adapter-anthropic";
import { FinishReason, type GenerateContentResponse } from "@google/genai";
import { translateGeminiStream } from "./stream.js";

async function* synthChunks(
  chunks: Array<Partial<GenerateContentResponse>>,
): AsyncIterable<GenerateContentResponse> {
  for (const c of chunks) yield c as GenerateContentResponse;
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe("translateGeminiStream", () => {
  test("text-only stream", async () => {
    const events = await collect(
      translateGeminiStream(
        synthChunks([
          {
            candidates: [
              { content: { role: "model", parts: [{ text: "Hello" }] } },
            ] as GenerateContentResponse["candidates"],
          },
          {
            candidates: [
              { content: { role: "model", parts: [{ text: ", world" }] } },
            ] as GenerateContentResponse["candidates"],
          },
          {
            candidates: [
              {
                finishReason: FinishReason.STOP,
                content: { role: "model", parts: [] },
              },
            ] as GenerateContentResponse["candidates"],
            usageMetadata: {
              promptTokenCount: 5,
              candidatesTokenCount: 3,
              totalTokenCount: 8,
            } as GenerateContentResponse["usageMetadata"],
          },
        ]),
      ),
    );
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("message_start");
    expect(kinds[kinds.length - 1]).toBe("message_stop");
    const textDeltas = events
      .filter(
        (e): e is Extract<StreamEvent, { kind: "content_block_delta" }> =>
          e.kind === "content_block_delta" && e.delta.type === "text_delta",
      )
      .map((e) => (e.delta.type === "text_delta" ? e.delta.text : ""));
    expect(textDeltas).toEqual(["Hello", ", world"]);

    const messageDelta = events.find(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    expect(messageDelta?.stopReason).toBe("end_turn");
    expect(messageDelta?.usage).toEqual({ input: 5, output: 3 });
  });

  test("functionCall part → tool_use block + JSON-stringified args", async () => {
    const events = await collect(
      translateGeminiStream(
        synthChunks([
          {
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [{ functionCall: { name: "Read", args: { path: "/tmp/x" } } }],
                },
              },
            ] as GenerateContentResponse["candidates"],
          },
          {
            candidates: [
              { finishReason: FinishReason.STOP, content: { role: "model", parts: [] } },
            ] as GenerateContentResponse["candidates"],
          },
        ]),
      ),
    );
    const start = events.find(
      (e): e is Extract<StreamEvent, { kind: "content_block_start" }> =>
        e.kind === "content_block_start" && e.block.type === "tool_use",
    );
    expect(start?.block).toMatchObject({ type: "tool_use", name: "Read" });
    const argDelta = events.find(
      (e): e is Extract<StreamEvent, { kind: "content_block_delta" }> =>
        e.kind === "content_block_delta" && e.delta.type === "input_json_delta",
    );
    expect(argDelta?.delta.type === "input_json_delta" && argDelta.delta.partial_json).toBe(
      JSON.stringify({ path: "/tmp/x" }),
    );
    const messageDelta = events.find(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    expect(messageDelta?.stopReason).toBe("tool_use");
  });

  test("MAX_TOKENS finish reason → max_tokens stop reason", async () => {
    const events = await collect(
      translateGeminiStream(
        synthChunks([
          {
            candidates: [
              {
                finishReason: FinishReason.MAX_TOKENS,
                content: { role: "model", parts: [{ text: "abc" }] },
              },
            ] as GenerateContentResponse["candidates"],
          },
        ]),
      ),
    );
    const messageDelta = events.find(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    expect(messageDelta?.stopReason).toBe("max_tokens");
  });
});
