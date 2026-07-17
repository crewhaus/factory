import { describe, expect, test } from "bun:test";
import type { ConverseStreamOutput, Message } from "@aws-sdk/client-bedrock-runtime";
import type { ProviderRequest, StreamEvent } from "@crewhaus/adapter-anthropic";
import { buildConverseRequest, translateConverseStream } from "./converse.js";

const baseReq: ProviderRequest = {
  model: "meta.llama3-1-70b-instruct-v1:0",
  system: [{ type: "text", text: "be helpful" }],
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 256,
};

async function* fromArray(events: ConverseStreamOutput[]): AsyncIterable<ConverseStreamOutput> {
  for (const ev of events) yield ev;
}

async function collect(events: ConverseStreamOutput[]): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of translateConverseStream(fromArray(events))) out.push(ev);
  return out;
}

describe("buildConverseRequest — request marshalling", () => {
  test("maps modelId, system, messages, and maxTokens", () => {
    const input = buildConverseRequest(baseReq);
    expect(input.modelId).toBe("meta.llama3-1-70b-instruct-v1:0");
    expect(input.system).toEqual([{ text: "be helpful" }]);
    expect(input.messages).toEqual([{ role: "user", content: [{ text: "hi" }] }]);
    expect(input.inferenceConfig).toEqual({ maxTokens: 256 });
  });

  test("omits system when empty or all-blank", () => {
    expect(buildConverseRequest({ ...baseReq, system: [] }).system).toBeUndefined();
    expect(
      buildConverseRequest({ ...baseReq, system: [{ type: "text", text: "" }] }).system,
    ).toBeUndefined();
  });

  test("reasoning controls (thinking / reasoningEffort) are silently ignored", () => {
    // Converse has no cross-vendor thinking-budget or effort field — the
    // request must be byte-identical to one without reasoning controls.
    const input = buildConverseRequest({
      ...baseReq,
      thinking: { type: "enabled", budgetTokens: 8192 },
      reasoningEffort: "high",
    });
    expect(input).toEqual(buildConverseRequest(baseReq));
  });

  test("omits toolConfig entirely when the request is toolless", () => {
    expect(buildConverseRequest(baseReq).toolConfig).toBeUndefined();
    // An empty tools array is toolless too — Converse rejects an empty
    // toolConfig, so it must not be attached.
    expect(buildConverseRequest({ ...baseReq, tools: [] }).toolConfig).toBeUndefined();
    // Even a dangling toolChoice without tools must not create one.
    expect(
      buildConverseRequest({ ...baseReq, tools: [], toolChoice: { type: "auto" } }).toolConfig,
    ).toBeUndefined();
  });

  test("maps tools onto toolConfig.tools[].toolSpec", () => {
    const input = buildConverseRequest({
      ...baseReq,
      tools: [{ name: "Read", description: "read a file", input_schema: { type: "object" } }],
    });
    expect(input.toolConfig).toEqual({
      tools: [
        {
          toolSpec: {
            name: "Read",
            description: "read a file",
            inputSchema: { json: { type: "object" } },
          },
        },
      ],
    });
  });

  test("maps toolChoice auto/any/tool onto the Converse member shapes", () => {
    const tools = [{ name: "Read", description: "x", input_schema: { type: "object" } }];
    expect(
      buildConverseRequest({ ...baseReq, tools, toolChoice: { type: "auto" } }).toolConfig
        ?.toolChoice,
    ).toEqual({ auto: {} });
    expect(
      buildConverseRequest({ ...baseReq, tools, toolChoice: { type: "any" } }).toolConfig
        ?.toolChoice,
    ).toEqual({ any: {} });
    expect(
      buildConverseRequest({ ...baseReq, tools, toolChoice: { type: "tool", name: "Read" } })
        .toolConfig?.toolChoice,
    ).toEqual({ tool: { name: "Read" } });
  });

  test("maps text + base64 image blocks; URL and unknown-format images are dropped", () => {
    const data = Buffer.from("pixels").toString("base64");
    const input = buildConverseRequest({
      ...baseReq,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look:" },
            { type: "image", source: { type: "base64", media_type: "image/png", data } },
            { type: "image", source: { type: "url", url: "http://x/y.png" } },
            { type: "image", source: { type: "base64", media_type: "image/tiff", data } },
          ],
        },
      ],
    });
    const content = (input.messages?.[0] as Message).content ?? [];
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ text: "look:" });
    const image = (content[1] as { image: { format: string; source: { bytes: Uint8Array } } })
      .image;
    expect(image.format).toBe("png");
    expect(new TextDecoder().decode(image.source.bytes)).toBe("pixels");
  });

  test("maps tool_use and tool_result blocks; thinking blocks are dropped", () => {
    const input = buildConverseRequest({
      ...baseReq,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm", signature: "sig" },
            { type: "tool_use", id: "tu_1", name: "Read", input: { path: "/x" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file body" }],
        },
      ],
    });
    expect(input.messages?.[0]).toEqual({
      role: "assistant",
      content: [{ toolUse: { toolUseId: "tu_1", name: "Read", input: { path: "/x" } } }],
    });
    expect(input.messages?.[1]).toEqual({
      role: "user",
      content: [{ toolResult: { toolUseId: "tu_1", content: [{ text: "file body" }] } }],
    });
  });

  test("tool_result block-array content maps per block; is_error sets status", () => {
    const input = buildConverseRequest({
      ...baseReq,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_2",
              content: [{ type: "text", text: "boom" }],
              is_error: true,
            },
            { type: "tool_result", tool_use_id: "tu_3" },
          ],
        },
      ],
    });
    const content = (input.messages?.[0] as Message).content ?? [];
    expect(content[0]).toEqual({
      toolResult: { toolUseId: "tu_2", content: [{ text: "boom" }], status: "error" },
    });
    // Undefined canonical content → empty Converse content array, no status.
    expect(content[1]).toEqual({ toolResult: { toolUseId: "tu_3", content: [] } });
  });
});

describe("translateConverseStream — text streaming", () => {
  test("lazily opens the text block and folds messageStop + metadata into one terminator", async () => {
    const events = await collect([
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hel" } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "lo" } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: "end_turn" } },
      {
        metadata: {
          usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 },
          metrics: { latencyMs: 5 },
        },
      },
    ]);
    expect(events.map((e) => e.kind)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[1]).toEqual({
      kind: "content_block_start",
      index: 0,
      block: { type: "text", text: "" },
    });
    const md = events.find(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    expect(md?.stopReason).toBe("end_turn");
    expect(md?.usage).toEqual({ input: 9, output: 4 });
  });

  test("folds cache token counts into canonical cacheRead/cacheCreate", async () => {
    const events = await collect([
      { messageStop: { stopReason: "end_turn" } },
      {
        metadata: {
          usage: {
            inputTokens: 2,
            outputTokens: 3,
            totalTokens: 5,
            cacheReadInputTokens: 7,
            cacheWriteInputTokens: 11,
          },
          metrics: { latencyMs: 5 },
        },
      },
    ]);
    const md = events.find(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    expect(md?.usage).toEqual({ input: 2, output: 3, cacheRead: 7, cacheCreate: 11 });
  });

  test("synthesizes the terminator (and closes open blocks) when the stream ends early", async () => {
    const events = await collect([
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "partial" } } },
    ]);
    expect(events.map((e) => e.kind)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const md = events.find(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    expect(md?.stopReason).toBe("end_turn");
    expect(md?.usage).toBeUndefined();
  });

  test("an entirely empty stream still terminates canonically", async () => {
    const events = await collect([]);
    expect(events.map((e) => e.kind)).toEqual(["message_start", "message_delta", "message_stop"]);
  });
});

describe("translateConverseStream — tool use", () => {
  test("contentBlockStart(toolUse) + input deltas map to canonical tool_use events", async () => {
    const events = await collect([
      { messageStart: { role: "assistant" } },
      {
        contentBlockStart: {
          contentBlockIndex: 1,
          start: { toolUse: { toolUseId: "tu_9", name: "Read" } },
        },
      },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"pa' } } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: 'th":"/x"}' } } } },
      { contentBlockStop: { contentBlockIndex: 1 } },
      { messageStop: { stopReason: "tool_use" } },
      {
        metadata: {
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          metrics: { latencyMs: 5 },
        },
      },
    ]);
    expect(events[1]).toEqual({
      kind: "content_block_start",
      index: 1,
      block: { type: "tool_use", id: "tu_9", name: "Read", input: {} },
    });
    expect(events[2]).toEqual({
      kind: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"pa' },
    });
    expect(events[4]).toEqual({ kind: "content_block_stop", index: 1 });
    const md = events.find(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    expect(md?.stopReason).toBe("tool_use");
  });

  test("non-toolUse contentBlockStart members are ignored", async () => {
    const events = await collect([
      {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolResult: { toolUseId: "tr_1" } },
        },
      },
      { messageStop: { stopReason: "end_turn" } },
    ]);
    expect(events.map((e) => e.kind)).toEqual(["message_start", "message_delta", "message_stop"]);
  });
});

describe("translateConverseStream — reasoning content", () => {
  test("reasoning text opens a thinking block; signature maps to signature_delta", async () => {
    const events = await collect([
      { messageStart: { role: "assistant" } },
      {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { reasoningContent: { text: "let me think" } },
        },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { reasoningContent: { signature: "sig123" } },
        },
      },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { text: "answer" } } },
      { contentBlockStop: { contentBlockIndex: 1 } },
      { messageStop: { stopReason: "end_turn" } },
    ]);
    expect(events[1]).toEqual({
      kind: "content_block_start",
      index: 0,
      block: { type: "thinking", thinking: "" },
    });
    expect(events[2]).toEqual({
      kind: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "let me think" },
    });
    expect(events[3]).toEqual({
      kind: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig123" },
    });
    expect(events[5]).toEqual({
      kind: "content_block_start",
      index: 1,
      block: { type: "text", text: "" },
    });
  });

  test("redactedContent reasoning deltas are dropped", async () => {
    const events = await collect([
      {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { reasoningContent: { redactedContent: new Uint8Array([1, 2]) } },
        },
      },
      { messageStop: { stopReason: "end_turn" } },
    ]);
    expect(events.map((e) => e.kind)).toEqual(["message_start", "message_delta", "message_stop"]);
  });
});

describe("translateConverseStream — stop reasons and errors", () => {
  test("max_tokens and stop_sequence pass through to the canonical stopReason", async () => {
    for (const stopReason of ["max_tokens", "stop_sequence"] as const) {
      const events = await collect([{ messageStop: { stopReason } }]);
      const md = events.find(
        (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
      );
      expect(md?.stopReason).toBe(stopReason);
    }
  });

  test("in-band exception members are thrown for the adapter to normalise", async () => {
    const inBand = Object.assign(new Error("slow down"), { name: "ThrottlingException" });
    await expect(
      collect([
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "x" } } },
        { throttlingException: inBand } as unknown as ConverseStreamOutput,
      ]),
    ).rejects.toBe(inBand);
  });
});
