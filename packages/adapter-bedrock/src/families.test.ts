import { describe, expect, test } from "bun:test";
import type { ProviderRequest, StreamEvent } from "@crewhaus/adapter-anthropic";
import {
  ANTHROPIC_BEDROCK_VERSION,
  buildAnthropicBedrockBody,
  decodeAnthropicBedrockChunk,
} from "./families/anthropic.js";
import {
  buildLlamaBedrockBody,
  decodeLlamaBedrockChunk,
  newLlamaStreamState,
} from "./families/llama.js";
import {
  buildMistralBedrockBody,
  decodeMistralBedrockChunk,
  newMistralStreamState,
} from "./families/mistral.js";

const baseReq: ProviderRequest = {
  model: "irrelevant",
  system: [{ type: "text", text: "be helpful" }],
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 256,
};

describe("anthropic-on-bedrock body", () => {
  test("includes anthropic_version, max_tokens, system, messages", () => {
    const body = buildAnthropicBedrockBody(baseReq);
    expect(body.anthropic_version).toBe(ANTHROPIC_BEDROCK_VERSION);
    expect(body.max_tokens).toBe(256);
    expect(body.system).toEqual([{ type: "text", text: "be helpful" }]);
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("strips empty system", () => {
    const body = buildAnthropicBedrockBody({ ...baseReq, system: [] });
    expect(body.system).toBeUndefined();
  });

  test("threads tools + tool_choice=tool + thinking", () => {
    const body = buildAnthropicBedrockBody({
      ...baseReq,
      tools: [{ name: "Read", description: "x", input_schema: { type: "object" } }],
      toolChoice: { type: "tool", name: "Read" },
      thinking: { type: "enabled", budgetTokens: 1024 },
    });
    expect(body.tools).toEqual([
      { name: "Read", description: "x", input_schema: { type: "object" } },
    ]);
    expect(body.tool_choice).toEqual({ type: "tool", name: "Read" });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  test("non-tool tool_choice (auto/any) passes only the type through", () => {
    const auto = buildAnthropicBedrockBody({ ...baseReq, toolChoice: { type: "auto" } });
    expect(auto.tool_choice).toEqual({ type: "auto" });
    const any = buildAnthropicBedrockBody({ ...baseReq, toolChoice: { type: "any" } });
    expect(any.tool_choice).toEqual({ type: "any" });
  });

  test("omits tools when the array is empty and tool_choice when absent", () => {
    const body = buildAnthropicBedrockBody({ ...baseReq, tools: [] });
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });

  test("decodeAnthropicBedrockChunk delegates to rawEventToCanonical", () => {
    // A standard Anthropic raw event decodes to its canonical form.
    const ev = decodeAnthropicBedrockChunk({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hi" },
    });
    expect(ev).toEqual({
      kind: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hi" },
    });
    // message_stop is embedded in the raw stream and maps 1:1.
    expect(decodeAnthropicBedrockChunk({ type: "message_stop" })).toEqual({ kind: "message_stop" });
    // Dropped events return null (e.g. ping is not a canonical event).
    expect(decodeAnthropicBedrockChunk({ type: "ping" })).toBeNull();
  });
});

describe("llama-on-bedrock body + stream", () => {
  test("renders Llama-3 chat template with system + user/assistant", () => {
    const body = buildLlamaBedrockBody({
      ...baseReq,
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
        { role: "user", content: "q2" },
      ],
    });
    expect(body.prompt).toContain("<|begin_of_text|>");
    expect(body.prompt).toContain("<|start_header_id|>system<|end_header_id|>");
    expect(body.prompt).toContain("be helpful");
    expect(body.prompt).toContain("<|start_header_id|>user<|end_header_id|>");
    expect(body.prompt).toContain("<|start_header_id|>assistant<|end_header_id|>");
    // Final assistant prefix to bait the model into completing.
    expect(body.prompt.endsWith("<|start_header_id|>assistant<|end_header_id|>\n\n")).toBe(true);
  });

  test("decodeLlamaBedrockChunk emits text + terminator events", () => {
    const state = newLlamaStreamState();
    const events: StreamEvent[] = [];
    for (const ev of decodeLlamaBedrockChunk({ generation: "Hello" }, state)) events.push(ev);
    for (const ev of decodeLlamaBedrockChunk({ generation: ", world" }, state)) events.push(ev);
    for (const ev of decodeLlamaBedrockChunk(
      { generation: "", stop_reason: "stop", generation_token_count: 3, prompt_token_count: 5 },
      state,
    )) {
      events.push(ev);
    }
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const md = events.find(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    expect(md?.stopReason).toBe("end_turn");
    expect(md?.usage).toEqual({ input: 5, output: 3 });
  });

  test("renders block-array content by joining text blocks and dropping non-text", () => {
    const body = buildLlamaBedrockBody({
      ...baseReq,
      system: [],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "line1" },
            { type: "image", source: { type: "url", url: "http://x" } },
            { type: "text", text: "line2" },
          ],
        },
      ],
    });
    // Non-text image block is filtered; the two text blocks are joined with "\n".
    expect(body.prompt).toContain("line1\nline2");
    expect(body.prompt).not.toContain("http://x");
    // Empty system produces no system header.
    expect(body.prompt).not.toContain("system<|end_header_id|>");
  });

  test("stop_reason 'length' maps to max_tokens", () => {
    const state = newLlamaStreamState();
    const events: StreamEvent[] = [];
    for (const ev of decodeLlamaBedrockChunk({ generation: "x", stop_reason: "length" }, state)) {
      events.push(ev);
    }
    const md = events.find(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    expect(md?.stopReason).toBe("max_tokens");
  });

  test("unknown stop_reason passes through verbatim and omits usage when counts absent", () => {
    const state = newLlamaStreamState();
    const events: StreamEvent[] = [];
    // No generation yet, stop_reason only, no token counts → no text block, no usage.
    for (const ev of decodeLlamaBedrockChunk({ stop_reason: "content_filter" }, state)) {
      events.push(ev);
    }
    expect(events.map((e) => e.kind)).toEqual(["message_delta", "message_stop"]);
    const md = events[0] as Extract<StreamEvent, { kind: "message_delta" }>;
    expect(md.stopReason).toBe("content_filter");
    expect(md.usage).toBeUndefined();
  });

  test("emits usage when only one token-count field is present", () => {
    const state = newLlamaStreamState();
    const events: StreamEvent[] = [];
    for (const ev of decodeLlamaBedrockChunk(
      { stop_reason: "stop", generation_token_count: 7 },
      state,
    )) {
      events.push(ev);
    }
    const md = events.find(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    expect(md?.usage).toEqual({ input: 0, output: 7 });
  });

  test("ignores chunks with empty generation and no stop, and short-circuits once closed", () => {
    const state = newLlamaStreamState();
    // Empty generation, no stop_reason → nothing emitted, block stays unopened.
    expect([...decodeLlamaBedrockChunk({ generation: "" }, state)]).toEqual([]);
    expect(state.textBlockOpened).toBe(false);
    // Close the stream.
    const closing = [...decodeLlamaBedrockChunk({ generation: "hi", stop_reason: "stop" }, state)];
    expect(closing[closing.length - 1]?.kind).toBe("message_stop");
    expect(state.closed).toBe(true);
    // After close, further chunks are dropped.
    expect([...decodeLlamaBedrockChunk({ generation: "more" }, state)]).toEqual([]);
  });
});

describe("mistral-on-bedrock body + stream", () => {
  test("body folds system into the first [INST] block", () => {
    const body = buildMistralBedrockBody({
      ...baseReq,
      messages: [{ role: "user", content: "hello" }],
    });
    expect(body.prompt).toContain("<s>[INST]");
    expect(body.prompt).toContain("be helpful");
    expect(body.prompt).toContain("hello");
  });

  test("decodeMistralBedrockChunk handles outputs[].text shape", () => {
    const state = newMistralStreamState();
    const events: StreamEvent[] = [];
    for (const ev of decodeMistralBedrockChunk({ outputs: [{ text: "Bonjour" }] }, state)) {
      events.push(ev);
    }
    for (const ev of decodeMistralBedrockChunk(
      { outputs: [{ text: "", stop_reason: "stop" }] },
      state,
    )) {
      events.push(ev);
    }
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("content_block_start");
    expect(kinds[kinds.length - 1]).toBe("message_stop");
  });

  test("decodeMistralBedrockChunk handles generation/stop_reason shape", () => {
    const state = newMistralStreamState();
    const events: StreamEvent[] = [];
    for (const ev of decodeMistralBedrockChunk(
      { generation: "Hola", stop_reason: "stop" },
      state,
    )) {
      events.push(ev);
    }
    expect(events[0]?.kind).toBe("content_block_start");
    expect(events[events.length - 1]?.kind).toBe("message_stop");
  });

  test("body renders assistant turns and block-array content", () => {
    const body = buildMistralBedrockBody({
      ...baseReq,
      system: [],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "u1" },
            { type: "image", source: { type: "url", url: "http://x" } },
            { type: "text", text: "u2" },
          ],
        },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u3" },
      ],
    });
    // User block-array text joined with "\n", non-text dropped.
    expect(body.prompt).toContain("[INST] u1\nu2 [/INST]");
    expect(body.prompt).not.toContain("http://x");
    // Assistant turn renders between </s><s> boundaries (line 61 / 63).
    expect(body.prompt).toContain(" a1</s><s>");
    // Second user turn does NOT get the system prefix (firstUser already false).
    expect(body.prompt).toContain("[INST] u3 [/INST]");
  });

  test("does not fold system into a leading assistant turn", () => {
    // First message is an assistant turn: firstUser stays true but no
    // system prefix is applied until a user turn appears.
    const body = buildMistralBedrockBody({
      ...baseReq,
      messages: [
        { role: "assistant", content: "greeting" },
        { role: "user", content: "hi" },
      ],
    });
    expect(body.prompt).toContain(" greeting</s><s>");
    expect(body.prompt).toContain("[INST] be helpful\n\nhi [/INST]");
  });

  test("stop_reason 'length' maps to max_tokens and accumulates output tokens", () => {
    const state = newMistralStreamState();
    const events: StreamEvent[] = [];
    for (const ev of decodeMistralBedrockChunk({ outputs: [{ text: "abcd" }] }, state)) {
      events.push(ev);
    }
    for (const ev of decodeMistralBedrockChunk({ outputs: [{ stop_reason: "length" }] }, state)) {
      events.push(ev);
    }
    const md = events.find(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    expect(md?.stopReason).toBe("max_tokens");
    // ceil(4 / 4) = 1 output token.
    expect(md?.usage).toEqual({ input: 0, output: 1 });
  });

  test("unknown stop_reason passes through verbatim", () => {
    const state = newMistralStreamState();
    const events: StreamEvent[] = [];
    for (const ev of decodeMistralBedrockChunk({ stop_reason: "model_length" }, state)) {
      events.push(ev);
    }
    expect(events.map((e) => e.kind)).toEqual(["message_delta", "message_stop"]);
    expect((events[0] as Extract<StreamEvent, { kind: "message_delta" }>).stopReason).toBe(
      "model_length",
    );
  });

  test("ignores empty/textless chunks and short-circuits once closed", () => {
    const state = newMistralStreamState();
    // No text (empty outputs text) and no stop → nothing emitted.
    expect([...decodeMistralBedrockChunk({ outputs: [{ text: "" }] }, state)]).toEqual([]);
    expect(state.textBlockOpened).toBe(false);
    // Payload with neither outputs nor generation → text is undefined, no events.
    expect([...decodeMistralBedrockChunk({}, state)]).toEqual([]);
    // Close it.
    const closing = [...decodeMistralBedrockChunk({ generation: "x", stop_reason: "stop" }, state)];
    expect(closing[closing.length - 1]?.kind).toBe("message_stop");
    expect(state.closed).toBe(true);
    // Subsequent chunks are dropped.
    expect([...decodeMistralBedrockChunk({ generation: "y" }, state)]).toEqual([]);
  });
});
