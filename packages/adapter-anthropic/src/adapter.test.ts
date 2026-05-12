import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicAdapter } from "./adapter.js";
import { CLAUDE_CODE_SYSTEM_PREFIX } from "./client.js";
import type { ProviderRequest } from "./types.js";

/**
 * Build a fake Anthropic client whose `messages.stream(params, opts)`
 * captures the params and yields the supplied raw events.
 */
function fakeClient(rawEvents: Anthropic.RawMessageStreamEvent[]): {
  client: Anthropic;
  captured: { params?: Anthropic.MessageStreamParams };
} {
  const captured: { params?: Anthropic.MessageStreamParams } = {};
  const client = {
    messages: {
      // The real SDK returns an event-emitter that ALSO implements
      // AsyncIterable. Our adapter only uses `for await`, so a plain
      // async generator is enough for the test surface.
      stream: ((params: Anthropic.MessageStreamParams) => {
        captured.params = params;
        return (async function* () {
          for (const ev of rawEvents) yield ev;
        })();
      }) as unknown as Anthropic["messages"]["stream"],
    },
  } as unknown as Anthropic;
  return { client, captured };
}

const TEXT_RAW_EVENTS: Anthropic.RawMessageStreamEvent[] = [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 4,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  } as unknown as Anthropic.RawMessageStreamEvent,
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  } as Anthropic.RawMessageStreamEvent,
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "ok" },
  } as Anthropic.RawMessageStreamEvent,
  { type: "content_block_stop", index: 0 } as Anthropic.RawMessageStreamEvent,
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { input_tokens: 4, output_tokens: 1 },
  } as unknown as Anthropic.RawMessageStreamEvent,
  { type: "message_stop" } as Anthropic.RawMessageStreamEvent,
];

const REQ: ProviderRequest = {
  model: "claude-sonnet-4-6",
  system: [{ type: "text", text: "be terse" }],
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 64,
};

describe("AnthropicAdapter", () => {
  test("providerId + features", () => {
    const { client } = fakeClient([]);
    const a = new AnthropicAdapter({ client, isOAuth: false });
    expect(a.providerId).toBe("anthropic");
    expect(a.features.caching).toBe("explicit");
    expect(a.features.web_search).toBe(true);
    expect(a.features.thinking).toBe(true);
  });

  test("stream() yields canonical StreamEvents", async () => {
    const { client, captured } = fakeClient(TEXT_RAW_EVENTS);
    const a = new AnthropicAdapter({ client, isOAuth: false });
    const events = [];
    for await (const ev of a.stream(REQ)) events.push(ev);
    expect(events.map((e) => e.kind)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(captured.params?.model).toBe("claude-sonnet-4-6");
    // Non-OAuth: NO Claude Code prefix.
    const sys = captured.params?.system as Anthropic.TextBlockParam[];
    expect(sys[0]?.text).toBe("be terse");
  });

  test("stream() with isOAuth=true prepends Claude Code prefix", async () => {
    const { client, captured } = fakeClient(TEXT_RAW_EVENTS);
    const a = new AnthropicAdapter({ client, isOAuth: true });
    for await (const _ev of a.stream(REQ)) {
      void _ev;
    }
    const sys = captured.params?.system as Anthropic.TextBlockParam[];
    expect(sys[0]?.text).toBe(CLAUDE_CODE_SYSTEM_PREFIX);
    expect(sys[1]?.text).toBe("be terse");
  });

  test("estimateTokens delegates to token-budget", () => {
    const { client } = fakeClient([]);
    const a = new AnthropicAdapter({ client, isOAuth: false });
    const tokens = a.estimateTokens([{ role: "user", content: "0123456789012345" }]);
    // 16 chars / 4 = 4 tokens
    expect(tokens).toBe(4);
  });

  test("mid-stream SSE errors expose `.error.type` for recovery-engine classify()", async () => {
    // The SDK's streaming.mjs calls `APIError.generate(undefined, ...)`
    // for mid-stream errors, which yields an APIConnectionError with
    // .error = undefined, .status = undefined, and .message set to the
    // raw JSON envelope. Without recovery, classify() returns "unknown"
    // and a transient overload becomes a fatal `recovery failed:`.
    const envelope = JSON.stringify({
      type: "error",
      error: { details: null, type: "overloaded_error", message: "Overloaded" },
      request_id: "req_x",
    });
    const sdkLikeError = new Error(envelope);
    // Match the real SDK's APIConnectionError shape: no .status, no .error.
    (sdkLikeError as { name: string }).name = "APIConnectionError";

    const client = {
      messages: {
        stream: ((_params: Anthropic.MessageStreamParams) =>
          (async function* () {
            throw sdkLikeError;
            // biome-ignore lint/correctness/useYield: unreachable yield satisfies the generator contract
            yield {} as Anthropic.RawMessageStreamEvent;
          })()) as unknown as Anthropic["messages"]["stream"],
      },
    } as unknown as Anthropic;

    const a = new AnthropicAdapter({ client, isOAuth: false });
    let caught: unknown;
    try {
      for await (const _ev of a.stream(REQ)) void _ev;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const wrapped = caught as { error?: { type?: string; message?: string } };
    expect(wrapped.error?.type).toBe("overloaded_error");
    expect(wrapped.error?.message).toBe("Overloaded");
  });

  test("non-envelope error messages are left untouched", async () => {
    const sdkLikeError = new Error("Connection error.");
    (sdkLikeError as { name: string }).name = "APIConnectionError";

    const client = {
      messages: {
        stream: ((_params: Anthropic.MessageStreamParams) =>
          (async function* () {
            throw sdkLikeError;
            // biome-ignore lint/correctness/useYield: unreachable yield satisfies the generator contract
            yield {} as Anthropic.RawMessageStreamEvent;
          })()) as unknown as Anthropic["messages"]["stream"],
      },
    } as unknown as Anthropic;

    const a = new AnthropicAdapter({ client, isOAuth: false });
    let caught: unknown;
    try {
      for await (const _ev of a.stream(REQ)) void _ev;
    } catch (err) {
      caught = err;
    }
    const wrapped = caught as { error?: unknown };
    expect(wrapped.error).toBeUndefined();
  });
});
