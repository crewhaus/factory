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

  test("text then functionCall in the same chunk closes the text block before the tool block", async () => {
    const events = await collect(
      translateGeminiStream(
        synthChunks([
          {
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [
                    { text: "let me look" },
                    { functionCall: { name: "Read", args: { path: "/tmp/x" } } },
                  ],
                },
              },
            ] as GenerateContentResponse["candidates"],
          },
        ]),
      ),
    );
    // Expected ordering: text start, text delta, text stop (index 0),
    // then tool start/delta/stop (index 1).
    const kinds = events.map((e) => ("index" in e ? `${e.kind}#${e.index}` : e.kind));
    const textStop = kinds.indexOf("content_block_stop#0");
    const toolStart = kinds.indexOf("content_block_start#1");
    expect(textStop).toBeGreaterThan(-1);
    expect(toolStart).toBeGreaterThan(-1);
    expect(textStop).toBeLessThan(toolStart);

    // Exactly one stop for the text block (no double-close at the tail).
    const textStops = kinds.filter((k) => k === "content_block_stop#0");
    expect(textStops).toHaveLength(1);

    const messageDelta = events.find(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    expect(messageDelta?.stopReason).toBe("tool_use");
  });

  test("thought parts are skipped entirely", async () => {
    const events = await collect(
      translateGeminiStream(
        synthChunks([
          {
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [{ text: "internal reasoning", thought: true }, { text: "visible" }],
                },
              },
            ] as GenerateContentResponse["candidates"],
          },
        ]),
      ),
    );
    const textDeltas = events
      .filter(
        (e): e is Extract<StreamEvent, { kind: "content_block_delta" }> =>
          e.kind === "content_block_delta" && e.delta.type === "text_delta",
      )
      .map((e) => (e.delta.type === "text_delta" ? e.delta.text : ""));
    // The thought text must not surface; only the visible delta does.
    expect(textDeltas).toEqual(["visible"]);
  });

  test("safety-class finish reasons map to stop_sequence", async () => {
    for (const reason of [
      FinishReason.SAFETY,
      FinishReason.RECITATION,
      FinishReason.BLOCKLIST,
      FinishReason.PROHIBITED_CONTENT,
      FinishReason.SPII,
    ]) {
      const events = await collect(
        translateGeminiStream(
          synthChunks([
            {
              candidates: [
                { finishReason: reason, content: { role: "model", parts: [{ text: "x" }] } },
              ] as GenerateContentResponse["candidates"],
            },
          ]),
        ),
      );
      const messageDelta = events.find(
        (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
      );
      expect(messageDelta?.stopReason).toBe("stop_sequence");
    }
  });

  test("malformed/unexpected tool-call finish reasons map to tool_use", async () => {
    for (const reason of [
      FinishReason.MALFORMED_FUNCTION_CALL,
      FinishReason.UNEXPECTED_TOOL_CALL,
    ]) {
      const events = await collect(
        translateGeminiStream(
          synthChunks([
            {
              candidates: [
                { finishReason: reason, content: { role: "model", parts: [] } },
              ] as GenerateContentResponse["candidates"],
            },
          ]),
        ),
      );
      const messageDelta = events.find(
        (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
      );
      expect(messageDelta?.stopReason).toBe("tool_use");
    }
  });

  test("unknown finish reason is lowercased through the default branch", async () => {
    const events = await collect(
      translateGeminiStream(
        synthChunks([
          {
            candidates: [
              {
                // OTHER is a real enum member with no explicit mapping.
                finishReason: FinishReason.OTHER,
                content: { role: "model", parts: [{ text: "x" }] },
              },
            ] as GenerateContentResponse["candidates"],
          },
        ]),
      ),
    );
    const messageDelta = events.find(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    expect(messageDelta?.stopReason).toBe("other");
  });

  test("an empty stream emits only the message_delta/message_stop tail (message_start is chunk-gated)", async () => {
    // message_start is yielded lazily on the first chunk; with zero
    // chunks the loop body never runs, so the tail fires alone.
    const events = await collect(translateGeminiStream(synthChunks([])));
    expect(events.map((e) => e.kind)).toEqual(["message_delta", "message_stop"]);
    const messageDelta = events.find(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    // No finishReason and no usage → bare message_delta.
    expect(messageDelta?.stopReason).toBeUndefined();
    expect(messageDelta?.usage).toBeUndefined();
  });

  test("usageMetadata with missing counts defaults to zero", async () => {
    const events = await collect(
      translateGeminiStream(
        synthChunks([
          {
            candidates: [
              { finishReason: FinishReason.STOP, content: { role: "model", parts: [] } },
            ] as GenerateContentResponse["candidates"],
            // promptTokenCount / candidatesTokenCount intentionally absent.
            usageMetadata: {} as GenerateContentResponse["usageMetadata"],
          },
        ]),
      ),
    );
    const messageDelta = events.find(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    expect(messageDelta?.usage).toEqual({ input: 0, output: 0 });
  });
});
