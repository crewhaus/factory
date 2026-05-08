import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { ProviderAdapter, StreamEvent } from "@crewhaus/adapter-anthropic";
import { RuntimeError } from "@crewhaus/errors";
import { autoCompact } from "./index";

/**
 * Synthesise an `AsyncIterable<StreamEvent>` from a single text block
 * (mirrors what `client.messages.create` used to deliver as
 * `response.content`).
 */
function streamWithText(...texts: string[]): AsyncIterable<StreamEvent> {
  return (async function* () {
    yield { kind: "message_start" };
    let idx = 0;
    for (const text of texts) {
      const i = idx++;
      yield {
        kind: "content_block_start",
        index: i,
        block: { type: "text", text: "" },
      };
      yield {
        kind: "content_block_delta",
        index: i,
        delta: { type: "text_delta", text },
      };
      yield { kind: "content_block_stop", index: i };
    }
    yield { kind: "message_delta", stopReason: "end_turn" };
    yield { kind: "message_stop" };
  })();
}

function streamWithEmptyContent(): AsyncIterable<StreamEvent> {
  return (async function* () {
    yield { kind: "message_start" };
    yield { kind: "message_delta", stopReason: "end_turn" };
    yield { kind: "message_stop" };
  })();
}

type CapturedReq = Parameters<ProviderAdapter["stream"]>[0];

function makeStubAdapter(stream: () => AsyncIterable<StreamEvent>): {
  adapter: ProviderAdapter;
  lastReq: () => CapturedReq | undefined;
  callCount: () => number;
} {
  let count = 0;
  let lastReq: CapturedReq | undefined;
  const adapter: ProviderAdapter = {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    stream(req) {
      count++;
      lastReq = req;
      return stream();
    },
    estimateTokens: () => 0,
  };
  return { adapter, lastReq: () => lastReq, callCount: () => count };
}

describe("autoCompact", () => {
  test("returns [user-marker, assistant-summary] tuple", async () => {
    const { adapter } = makeStubAdapter(() => streamWithText("summary stub"));
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];

    const result = await autoCompact(messages, adapter, "claude-opus-4-7");

    expect(result.length).toBe(2);
    expect(result[0]?.role).toBe("user");
    expect(typeof result[0]?.content).toBe("string");
    expect(result[0]?.content as string).toContain("Previous conversation summary");
    expect(result[1]).toEqual({ role: "assistant", content: "summary stub" });
  });

  test("forwards the model id to the adapter", async () => {
    const { adapter, lastReq } = makeStubAdapter(() => streamWithText("x"));
    await autoCompact([], adapter, "claude-opus-4-7");
    expect(lastReq()?.model).toBe("claude-opus-4-7");
  });

  test("appends the summarization request after the original messages", async () => {
    const { adapter, lastReq } = makeStubAdapter(() => streamWithText("x"));
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ];
    await autoCompact(messages, adapter, "m");
    const req = lastReq();
    expect(req).toBeDefined();
    if (!req) throw new Error("unreachable");
    expect(req.messages.length).toBe(3);
    expect(req.messages[0]).toEqual({ role: "user", content: "first" });
    expect(req.messages[1]).toEqual({ role: "assistant", content: "second" });
    expect(req.messages[2]?.role).toBe("user");
    expect(req.messages[2]?.content as string).toContain("Summarize");
  });

  test("does not mutate the input messages", async () => {
    const { adapter } = makeStubAdapter(() => streamWithText("x"));
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "a" }];
    const before = messages.length;
    await autoCompact(messages, adapter, "m");
    expect(messages.length).toBe(before);
  });

  test("throws RuntimeError when the response has no text block", async () => {
    const { adapter } = makeStubAdapter(() => streamWithEmptyContent());
    await expect(autoCompact([], adapter, "m")).rejects.toBeInstanceOf(RuntimeError);
  });

  test("uses the first text block when multiple are present", async () => {
    const { adapter } = makeStubAdapter(() => streamWithText("first text", "second text"));
    const result = await autoCompact([], adapter, "m");
    expect(result[1]).toEqual({ role: "assistant", content: "first text" });
  });
});
