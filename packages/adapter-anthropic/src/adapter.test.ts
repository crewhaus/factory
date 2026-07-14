import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { AdapterError } from "@crewhaus/errors";
import { classify, initialRecoveryState, recover, retryAfterMs } from "@crewhaus/recovery-engine";
import { AnthropicAdapter, createAnthropicAdapter } from "./adapter.js";
import { CLAUDE_CODE_SYSTEM_PREFIX } from "./client.js";
import type { ProviderRequest, StreamEvent } from "./types.js";

/**
 * Build a fake Anthropic client whose `messages.create(params, opts)`
 * captures the params and yields the supplied raw events. The adapter
 * consumes the raw `create({ stream: true })` event stream (NOT the
 * high-level `messages.stream()` helper) so a truncated/malformed tool
 * call parses in our own guarded code, not the SDK's.
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
      create: ((params: Anthropic.MessageStreamParams) => {
        captured.params = params;
        return (async function* () {
          for (const ev of rawEvents) yield ev;
        })();
      }) as unknown as Anthropic["messages"]["create"],
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

    // Iterator that rejects on first .next() — models a mid-stream SSE
    // error where the SDK's iterator throws after the stream is opened.
    // Avoids `async function*` (which biome flags as useYield when there
    // are no yields, even though throw-only generators are valid).
    const client = {
      messages: {
        create: ((_params: Anthropic.MessageStreamParams) => ({
          [Symbol.asyncIterator]() {
            return { next: () => Promise.reject(sdkLikeError) };
          },
        })) as unknown as Anthropic["messages"]["create"],
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

    // Iterator that rejects on first .next() — models a mid-stream SSE
    // error where the SDK's iterator throws after the stream is opened.
    // Avoids `async function*` (which biome flags as useYield when there
    // are no yields, even though throw-only generators are valid).
    const client = {
      messages: {
        create: ((_params: Anthropic.MessageStreamParams) => ({
          [Symbol.asyncIterator]() {
            return { next: () => Promise.reject(sdkLikeError) };
          },
        })) as unknown as Anthropic["messages"]["create"],
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

  test("abort errors pass through verbatim (APIUserAbortError)", async () => {
    const abortErr = new Error("Request was aborted.");
    (abortErr as { name: string }).name = "APIUserAbortError";
    const client = {
      messages: {
        create: ((_p: Anthropic.MessageStreamParams) => ({
          [Symbol.asyncIterator]() {
            return { next: () => Promise.reject(abortErr) };
          },
        })) as unknown as Anthropic["messages"]["create"],
      },
    } as unknown as Anthropic;
    const a = new AnthropicAdapter({ client, isOAuth: false });
    let caught: unknown;
    try {
      for await (const _ev of a.stream(REQ)) void _ev;
    } catch (err) {
      caught = err;
    }
    // Returned verbatim — same identity, not wrapped in AdapterError.
    expect(caught).toBe(abortErr);
  });

  test("abort errors pass through verbatim (AbortError)", async () => {
    const abortErr = new Error("aborted");
    (abortErr as { name: string }).name = "AbortError";
    const client = {
      messages: {
        create: ((_p: Anthropic.MessageStreamParams) => ({
          [Symbol.asyncIterator]() {
            return { next: () => Promise.reject(abortErr) };
          },
        })) as unknown as Anthropic["messages"]["create"],
      },
    } as unknown as Anthropic;
    const a = new AnthropicAdapter({ client, isOAuth: false });
    let caught: unknown;
    try {
      for await (const _ev of a.stream(REQ)) void _ev;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(abortErr);
  });

  test("error thrown synchronously by messages.create() is normalised", () => {
    // The SDK can throw during `messages.create(...)` construction (before
    // iteration). The adapter's outer try/catch (not the for-await one)
    // must normalise it too.
    const boom = new Error("bad request building stream");
    const client = {
      messages: {
        create: (() => {
          throw boom;
        }) as unknown as Anthropic["messages"]["create"],
      },
    } as unknown as Anthropic;
    const a = new AnthropicAdapter({ client, isOAuth: false });
    // The async generator throws on first iteration step.
    const iter = a.stream(REQ)[Symbol.asyncIterator]();
    return iter.next().then(
      () => {
        throw new Error("expected stream construction to reject");
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(AdapterError);
        expect((err as Error).message).toBe("bad request building stream");
        // Cause preserved for debuggability.
        expect((err as { cause?: unknown }).cause).toBe(boom);
      },
    );
  });

  test("a TRUNCATED tool call streams through raw without throwing (no SDK-side parse)", async () => {
    // Regression: the model is cut off at max_tokens mid tool-call args, so
    // the tool_use input JSON is incomplete (`{"slug":"foo`). The high-level
    // `messages.stream()` helper would `partialParse` this internally and
    // THROW ("JSON Parse error: Expected '}'") — crashing the turn. Consuming
    // the raw `create({ stream: true })` events must instead pass the partial
    // JSON straight through (our downstream sets `__parse_error` under a
    // guard). Prove: (a) `.stream()` is never called, (b) no throw, (c) the
    // truncated partial_json survives verbatim on the canonical event.
    const rawEvents: Anthropic.RawMessageStreamEvent[] = [
      {
        type: "message_start",
        message: {
          id: "m",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 3,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      } as unknown as Anthropic.RawMessageStreamEvent,
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "venture_open", input: {} },
      } as unknown as Anthropic.RawMessageStreamEvent,
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"slug":"foo' },
      } as Anthropic.RawMessageStreamEvent,
      { type: "content_block_stop", index: 0 } as Anthropic.RawMessageStreamEvent,
      {
        type: "message_delta",
        delta: { stop_reason: "max_tokens", stop_sequence: null },
        usage: { output_tokens: 9 },
      } as unknown as Anthropic.RawMessageStreamEvent,
      { type: "message_stop" } as Anthropic.RawMessageStreamEvent,
    ];
    let streamHelperCalled = false;
    const client = {
      messages: {
        // The buggy path — must never be touched now.
        stream: (() => {
          streamHelperCalled = true;
          throw new Error(
            "messages.stream() must not be used — it partial-parses tool JSON and throws on truncation",
          );
        }) as unknown as Anthropic["messages"]["stream"],
        create: ((_p: Anthropic.MessageStreamParams) =>
          (async function* () {
            for (const ev of rawEvents) yield ev;
          })()) as unknown as Anthropic["messages"]["create"],
      },
    } as unknown as Anthropic;
    const a = new AnthropicAdapter({ client, isOAuth: false });
    const events: StreamEvent[] = [];
    // Must not throw despite the incomplete tool_use JSON.
    for await (const ev of a.stream(REQ)) events.push(ev);
    expect(streamHelperCalled).toBe(false);
    const delta = events.find(
      (e): e is Extract<StreamEvent, { kind: "content_block_delta" }> =>
        e.kind === "content_block_delta" && e.delta.type === "input_json_delta",
    );
    // The truncated partial_json survives verbatim — the adapter never parsed it.
    expect(delta?.delta).toEqual({ type: "input_json_delta", partial_json: '{"slug":"foo' });
    const stop = events.find(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    expect(stop?.stopReason).toBe("max_tokens");
  });

  test("structured SDK error (status + error) has fields copied onto wrapper", async () => {
    // A typical APIError: has .status and .error already populated — the
    // recovery-engine reads these directly. Verify they survive wrapping.
    const sdkErr = Object.assign(new Error("rate limit hit"), {
      name: "RateLimitError",
      status: 429,
      error: { type: "rate_limit_error", message: "slow down" },
    });
    const client = {
      messages: {
        create: ((_p: Anthropic.MessageStreamParams) => ({
          [Symbol.asyncIterator]() {
            return { next: () => Promise.reject(sdkErr) };
          },
        })) as unknown as Anthropic["messages"]["create"],
      },
    } as unknown as Anthropic;
    const a = new AnthropicAdapter({ client, isOAuth: false });
    let caught: unknown;
    try {
      for await (const _ev of a.stream(REQ)) void _ev;
    } catch (err) {
      caught = err;
    }
    const w = caught as { status?: number; error?: { type?: string }; name?: string };
    expect(caught).toBeInstanceOf(AdapterError);
    expect(w.status).toBe(429);
    expect(w.error?.type).toBe("rate_limit_error");
    expect(w.name).toBe("RateLimitError");
  });

  test("non-Error thrown value (string) is stringified into the message", async () => {
    // err instanceof Error === false path: String(err) is used.
    const client = {
      messages: {
        create: ((_p: Anthropic.MessageStreamParams) => ({
          [Symbol.asyncIterator]() {
            return { next: () => Promise.reject("plain string failure") };
          },
        })) as unknown as Anthropic["messages"]["create"],
      },
    } as unknown as Anthropic;
    const a = new AnthropicAdapter({ client, isOAuth: false });
    let caught: unknown;
    try {
      for await (const _ev of a.stream(REQ)) void _ev;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdapterError);
    expect((caught as Error).message).toBe("plain string failure");
  });

  test("SSE envelope without inner message still classifies by type", async () => {
    // Envelope has error.type but no error.message — exercises the
    // `message` spread's empty-object branch in tryParseSseErrorEnvelope.
    const envelope = JSON.stringify({
      type: "error",
      error: { type: "overloaded_error" },
    });
    const err = Object.assign(new Error(envelope), { name: "APIConnectionError" });
    const client = {
      messages: {
        create: ((_p: Anthropic.MessageStreamParams) => ({
          [Symbol.asyncIterator]() {
            return { next: () => Promise.reject(err) };
          },
        })) as unknown as Anthropic["messages"]["create"],
      },
    } as unknown as Anthropic;
    const a = new AnthropicAdapter({ client, isOAuth: false });
    let caught: unknown;
    try {
      for await (const _ev of a.stream(REQ)) void _ev;
    } catch (e) {
      caught = e;
    }
    const w = caught as { error?: { type?: string; message?: string } };
    expect(w.error?.type).toBe("overloaded_error");
    expect(w.error?.message).toBeUndefined();
  });

  test("SSE-Error-prefixed envelope is parsed (older SDK form)", async () => {
    const envelope = `SSE Error: ${JSON.stringify({
      type: "error",
      error: { type: "api_error", message: "boom" },
    })}`;
    const err = Object.assign(new Error(envelope), { name: "APIConnectionError" });
    const client = {
      messages: {
        create: ((_p: Anthropic.MessageStreamParams) => ({
          [Symbol.asyncIterator]() {
            return { next: () => Promise.reject(err) };
          },
        })) as unknown as Anthropic["messages"]["create"],
      },
    } as unknown as Anthropic;
    const a = new AnthropicAdapter({ client, isOAuth: false });
    let caught: unknown;
    try {
      for await (const _ev of a.stream(REQ)) void _ev;
    } catch (e) {
      caught = e;
    }
    const w = caught as { error?: { type?: string; message?: string } };
    expect(w.error?.type).toBe("api_error");
    expect(w.error?.message).toBe("boom");
  });

  test("malformed JSON envelope (starts with { but invalid) → no error field", async () => {
    const err = Object.assign(new Error("{not valid json"), { name: "APIConnectionError" });
    const client = {
      messages: {
        create: ((_p: Anthropic.MessageStreamParams) => ({
          [Symbol.asyncIterator]() {
            return { next: () => Promise.reject(err) };
          },
        })) as unknown as Anthropic["messages"]["create"],
      },
    } as unknown as Anthropic;
    const a = new AnthropicAdapter({ client, isOAuth: false });
    let caught: unknown;
    try {
      for await (const _ev of a.stream(REQ)) void _ev;
    } catch (e) {
      caught = e;
    }
    expect((caught as { error?: unknown }).error).toBeUndefined();
  });

  test("envelope with wrong top-level type → no error field", async () => {
    // Valid JSON object, but type !== "error": classify() can't use it.
    const err = Object.assign(new Error(JSON.stringify({ type: "ping", error: { type: "x" } })), {
      name: "APIConnectionError",
    });
    const client = {
      messages: {
        create: ((_p: Anthropic.MessageStreamParams) => ({
          [Symbol.asyncIterator]() {
            return { next: () => Promise.reject(err) };
          },
        })) as unknown as Anthropic["messages"]["create"],
      },
    } as unknown as Anthropic;
    const a = new AnthropicAdapter({ client, isOAuth: false });
    let caught: unknown;
    try {
      for await (const _ev of a.stream(REQ)) void _ev;
    } catch (e) {
      caught = e;
    }
    expect((caught as { error?: unknown }).error).toBeUndefined();
  });

  test("envelope with non-string inner type → no error field", async () => {
    const err = Object.assign(new Error(JSON.stringify({ type: "error", error: { type: 123 } })), {
      name: "APIConnectionError",
    });
    const client = {
      messages: {
        create: ((_p: Anthropic.MessageStreamParams) => ({
          [Symbol.asyncIterator]() {
            return { next: () => Promise.reject(err) };
          },
        })) as unknown as Anthropic["messages"]["create"],
      },
    } as unknown as Anthropic;
    const a = new AnthropicAdapter({ client, isOAuth: false });
    let caught: unknown;
    try {
      for await (const _ev of a.stream(REQ)) void _ev;
    } catch (e) {
      caught = e;
    }
    expect((caught as { error?: unknown }).error).toBeUndefined();
  });

  test("envelope whose error field is null → no error field", async () => {
    const err = Object.assign(new Error(JSON.stringify({ type: "error", error: null })), {
      name: "APIConnectionError",
    });
    const client = {
      messages: {
        create: ((_p: Anthropic.MessageStreamParams) => ({
          [Symbol.asyncIterator]() {
            return { next: () => Promise.reject(err) };
          },
        })) as unknown as Anthropic["messages"]["create"],
      },
    } as unknown as Anthropic;
    const a = new AnthropicAdapter({ client, isOAuth: false });
    let caught: unknown;
    try {
      for await (const _ev of a.stream(REQ)) void _ev;
    } catch (e) {
      caught = e;
    }
    expect((caught as { error?: unknown }).error).toBeUndefined();
  });

  test("passes the abort signal through to messages.stream", async () => {
    const controller = new AbortController();
    let receivedOpts: { signal?: AbortSignal } | undefined;
    const client = {
      messages: {
        create: ((_params: Anthropic.MessageStreamParams, opts: { signal?: AbortSignal }) => {
          receivedOpts = opts;
          return (async function* () {
            for (const ev of TEXT_RAW_EVENTS) yield ev;
          })();
        }) as unknown as Anthropic["messages"]["create"],
      },
    } as unknown as Anthropic;
    const a = new AnthropicAdapter({ client, isOAuth: false });
    for await (const _ev of a.stream({ ...REQ, signal: controller.signal })) void _ev;
    expect(receivedOpts?.signal).toBe(controller.signal);
  });

  describe("createAnthropicAdapter", () => {
    test("builds an adapter from API-key env (non-OAuth)", () => {
      const adapter = createAnthropicAdapter({ ANTHROPIC_API_KEY: "sk-ant-api01-test" });
      expect(adapter).toBeInstanceOf(AnthropicAdapter);
      expect(adapter.providerId).toBe("anthropic");
    });

    test("builds an OAuth adapter from sk-ant-oat token", () => {
      const adapter = createAnthropicAdapter({ ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-test" });
      expect(adapter).toBeInstanceOf(AnthropicAdapter);
    });

    test("throws ProviderAuthError when no credentials present", () => {
      expect(() => createAnthropicAdapter({})).toThrow(/no Anthropic credentials/);
    });
  });
});

// ===========================================================================
// v0.3.0 Goal 6 (PR 2) — billing / auth / rate-limit discrimination,
// end-to-end through normaliseAnthropicError → recovery-engine. Fixtures
// pin the REAL Anthropic SDK APIError field layout (status / error envelope
// / name / headers as a fetch Headers instance).
// ===========================================================================
describe("Goal 6 — Anthropic error discrimination (via stream())", () => {
  async function streamError(sdkErr: unknown): Promise<unknown> {
    const client = {
      messages: {
        create: (() => {
          throw sdkErr;
        }) as unknown as Anthropic["messages"]["create"],
      },
    } as unknown as Anthropic;
    const a = new AnthropicAdapter({ client, isOAuth: false });
    try {
      for await (const _ev of a.stream(REQ)) void _ev;
    } catch (err) {
      return err;
    }
    throw new Error("expected stream() to throw");
  }

  /** Real Anthropic out-of-credit 400 (BadRequestError). */
  const CREDIT_BALANCE_400 = () =>
    Object.assign(
      new Error(
        "400 Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      ),
      {
        name: "BadRequestError",
        status: 400,
        error: {
          type: "invalid_request_error",
          message:
            "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
        },
        headers: new Headers({ "request-id": "req_abc" }),
      },
    );

  test("credit-balance 400 survives normalisation intact → classify() billing", async () => {
    const err = await streamError(CREDIT_BALANCE_400());
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).providerId).toBe("anthropic");
    expect((err as { status?: number }).status).toBe(400);
    expect((err as { error?: { type?: string } }).error?.type).toBe("invalid_request_error");
    expect(classify(err)).toBe("billing");
  });

  test("credit-balance 400 → recover() halts with the billing report (exit 31, Anthropic attribution)", async () => {
    const err = await streamError(CREDIT_BALANCE_400());
    const action = recover(err, initialRecoveryState);
    expect(action.kind).toBe("halt");
    if (action.kind !== "halt") return;
    expect(action.report.class).toBe("billing");
    expect(action.report.exitCode).toBe(31);
    expect(action.report.detail).toContain("Anthropic said:");
    expect(action.report.detail).toContain("Your credit balance is too low");
    expect(action.report.remediation).toContain("console.anthropic.com");
  });

  test("401 AuthenticationError → classify() auth → halt (exit 30)", async () => {
    const err = await streamError(
      Object.assign(new Error("401 invalid x-api-key"), {
        name: "AuthenticationError",
        status: 401,
        error: { type: "authentication_error", message: "invalid x-api-key" },
      }),
    );
    expect((err as { status?: number }).status).toBe(401);
    expect(classify(err)).toBe("auth");
    const action = recover(err, initialRecoveryState);
    expect(action.kind).toBe("halt");
    if (action.kind !== "halt") return;
    expect(action.report.exitCode).toBe(30);
  });

  test("403 PermissionDeniedError → classify() auth", async () => {
    const err = await streamError(
      Object.assign(new Error("403 Forbidden"), {
        name: "PermissionDeniedError",
        status: 403,
        error: {
          type: "permission_error",
          message: "Your API key does not have permission to use the specified resource.",
        },
      }),
    );
    expect(classify(err)).toBe("auth");
  });

  test("429 rate_limit_error copies headers → Retry-After honored (Headers instance)", async () => {
    const err = await streamError(
      Object.assign(new Error("429 rate limited"), {
        name: "RateLimitError",
        status: 429,
        error: {
          type: "rate_limit_error",
          message: "Number of request tokens has exceeded your per-minute rate limit.",
        },
        headers: new Headers({ "retry-after": "7" }),
      }),
    );
    expect(classify(err)).toBe("rate_limit");
    expect(retryAfterMs(err)).toBe(7_000);
    const action = recover(err, initialRecoveryState);
    expect(action).toEqual({ kind: "retry", delayMs: 7_000, attempt: 1 });
  });

  test("regression: 529 overloaded keeps its shape and retry semantics", async () => {
    const err = await streamError(
      Object.assign(new Error("529 Overloaded"), {
        name: "APIError",
        status: 529,
        error: { type: "overloaded_error", message: "Overloaded" },
      }),
    );
    expect((err as { error?: { type?: string } }).error?.type).toBe("overloaded_error");
    expect(classify(err)).toBe("overloaded_or_5xx");
    expect(recover(err, initialRecoveryState).kind).toBe("retry");
  });
});
