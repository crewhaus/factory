import { describe, expect, test } from "bun:test";
import type { ProviderRequest, StreamEvent } from "@crewhaus/adapter-anthropic";
import { ANTHROPIC_BEDROCK_VERSION, buildAnthropicBedrockBody } from "./families/anthropic.js";
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

  test("threads tool_choice + thinking", () => {
    const body = buildAnthropicBedrockBody({
      ...baseReq,
      tools: [{ name: "Read", description: "x", input_schema: { type: "object" } }],
      toolChoice: { type: "tool", name: "Read" },
      thinking: { type: "enabled", budgetTokens: 1024 },
    });
    expect(body.tool_choice).toEqual({ type: "tool", name: "Read" });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
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
});
