import { describe, expect, test } from "bun:test";
import type { ProviderRequest, StreamEvent } from "@crewhaus/adapter-anthropic";
import { AdapterError, ProviderAuthError } from "@crewhaus/errors";
import { classify, initialRecoveryState, recover, retryAfterMs } from "@crewhaus/recovery-engine";
import type OpenAI from "openai";
import { OpenAIAdapter, createAzureOpenAIAdapter, createOpenAIAdapter } from "./adapter.js";

type ChatChunk = OpenAI.Chat.Completions.ChatCompletionChunk;

const REQ: ProviderRequest = {
  model: "gpt-4o-mini",
  system: [{ type: "text", text: "be terse" }],
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 64,
};

function mkChunk(
  delta: Partial<ChatChunk["choices"][number]["delta"]>,
  finish?: string,
  usage?: ChatChunk["usage"],
): ChatChunk {
  return {
    id: "c",
    object: "chat.completion.chunk",
    created: 0,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        delta: delta as ChatChunk["choices"][number]["delta"],
        finish_reason: (finish ?? null) as ChatChunk["choices"][number]["finish_reason"],
        logprobs: null,
      },
    ],
    ...(usage !== undefined ? { usage } : {}),
  } as ChatChunk;
}

/**
 * Build a fake OpenAI client whose `chat.completions.create(params, opts)`
 * captures the call and returns a value produced by `behaviour`. The real
 * SDK's streaming `create()` returns a Promise that resolves to an
 * AsyncIterable; the adapter only awaits then `for await`s it, so the
 * test surface is just that.
 */
function fakeClient(behaviour: {
  create: (
    params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
    opts: { signal?: AbortSignal },
  ) => unknown;
  captured?: {
    params?: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
    opts?: { signal?: AbortSignal };
  };
}): OpenAI {
  return {
    chat: {
      completions: {
        create: ((
          params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
          opts: { signal?: AbortSignal },
        ) => {
          if (behaviour.captured !== undefined) {
            behaviour.captured.params = params;
            behaviour.captured.opts = opts;
          }
          return behaviour.create(params, opts);
        }) as unknown as OpenAI["chat"]["completions"]["create"],
      },
    },
  } as unknown as OpenAI;
}

async function* gen(chunks: ChatChunk[]): AsyncIterable<ChatChunk> {
  for (const c of chunks) yield c;
}

async function drain(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe("OpenAIAdapter", () => {
  test("providerId + features", () => {
    const client = fakeClient({ create: () => Promise.resolve(gen([])) });
    const a = new OpenAIAdapter({ client });
    expect(a.providerId).toBe("openai");
    expect(a.features).toEqual({
      caching: "automatic",
      tool_use: true,
      vision: true,
      thinking: false,
      web_search: false,
    });
  });

  test("stream() translates params and yields canonical StreamEvents", async () => {
    const captured: {
      params?: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
      opts?: { signal?: AbortSignal };
    } = {};
    const client = fakeClient({
      captured,
      create: () =>
        Promise.resolve(
          gen([
            mkChunk({ role: "assistant", content: "" }),
            mkChunk({ content: "ok" }),
            mkChunk({}, "stop", { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }),
          ]),
        ),
    });
    const a = new OpenAIAdapter({ client });
    const events = await drain(a.stream(REQ));
    expect(events.map((e) => e.kind)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(captured.params?.model).toBe("gpt-4o-mini");
    expect(captured.params?.stream).toBe(true);
    // No signal on the request → no signal key forwarded to the SDK.
    expect(captured.opts).toEqual({});
  });

  test("stream() forwards req.signal to the SDK when present", async () => {
    const captured: {
      params?: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
      opts?: { signal?: AbortSignal };
    } = {};
    const ctrl = new AbortController();
    const client = fakeClient({
      captured,
      create: () =>
        Promise.resolve(
          gen([mkChunk({}, "stop", { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 })]),
        ),
    });
    const a = new OpenAIAdapter({ client });
    await drain(a.stream({ ...REQ, signal: ctrl.signal }));
    expect(captured.opts?.signal).toBe(ctrl.signal);
  });

  test("stream() wraps a synchronous error from create() as AdapterError", async () => {
    const sdkErr = Object.assign(new Error("boom-sync"), { status: 500 });
    const client = fakeClient({
      create: () => {
        throw sdkErr;
      },
    });
    const a = new OpenAIAdapter({ client });
    let caught: unknown;
    try {
      await drain(a.stream(REQ));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdapterError);
    expect((caught as AdapterError).providerId).toBe("openai");
    expect((caught as { error?: { type?: string } }).error?.type).toBe("overloaded_error");
  });

  test("stream() wraps a rejected create() promise (await raw throws)", async () => {
    const sdkErr = Object.assign(new Error("boom-await"), { status: 429 });
    const client = fakeClient({
      create: () => Promise.reject(sdkErr),
    });
    const a = new OpenAIAdapter({ client });
    let caught: unknown;
    try {
      await drain(a.stream(REQ));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdapterError);
    expect((caught as { status?: number }).status).toBe(429);
    // v0.3.0 Goal 6 — 429s are no longer stamped `overloaded_error`; the
    // bare status is the rate-limit discriminator classify() reads.
    expect((caught as { error?: { type?: string } }).error).toBeUndefined();
  });

  test("stream() wraps a mid-stream iteration error", async () => {
    const sdkErr = Object.assign(new Error("ctx exceeds the model maximum"), { status: 400 });
    const client = fakeClient({
      create: () =>
        Promise.resolve({
          [Symbol.asyncIterator]() {
            let done = false;
            return {
              next: () => {
                if (!done) {
                  done = true;
                  // First yield message_start path, then throw on second pull.
                  return Promise.resolve({
                    value: mkChunk({ content: "partial" }),
                    done: false,
                  });
                }
                return Promise.reject(sdkErr);
              },
            };
          },
        }),
    });
    const a = new OpenAIAdapter({ client });
    let caught: unknown;
    try {
      await drain(a.stream(REQ));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdapterError);
    // 400 + "exceeds the model" → prompt-too-long shape.
    expect((caught as { error?: { type?: string; message?: string } }).error).toEqual({
      type: "invalid_request_error",
      message: "Prompt is too long",
    });
  });

  test("stream() passes abort errors through untouched (APIUserAbortError)", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "APIUserAbortError" });
    const client = fakeClient({
      create: () => Promise.reject(abortErr),
    });
    const a = new OpenAIAdapter({ client });
    let caught: unknown;
    try {
      await drain(a.stream(REQ));
    } catch (err) {
      caught = err;
    }
    // Returned as-is, NOT wrapped.
    expect(caught).toBe(abortErr);
    expect(caught).not.toBeInstanceOf(AdapterError);
  });

  test("stream() passes AbortError through untouched", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    const client = fakeClient({
      create: () => {
        throw abortErr;
      },
    });
    const a = new OpenAIAdapter({ client });
    let caught: unknown;
    try {
      await drain(a.stream(REQ));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(abortErr);
  });

  test("stream() retries ONCE without stream_options on a 400 that rejects it", async () => {
    // Some compat servers/proxies 400 on `stream_options` — the adapter
    // strips it and retries once instead of tombstoning the request.
    const calls: {
      params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
      opts: { signal?: AbortSignal };
    }[] = [];
    const ctrl = new AbortController();
    const client = fakeClient({
      create: (params, opts) => {
        calls.push({ params, opts });
        if (calls.length === 1) {
          return Promise.reject(
            Object.assign(new Error("Unrecognized request argument supplied: stream_options"), {
              status: 400,
            }),
          );
        }
        return Promise.resolve(
          gen([
            mkChunk({ content: "ok" }),
            mkChunk({}, "stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
          ]),
        );
      },
    });
    const a = new OpenAIAdapter({ client });
    const events = await drain(a.stream({ ...REQ, signal: ctrl.signal }));
    expect(calls).toHaveLength(2);
    expect(calls[0]?.params.stream_options).toEqual({ include_usage: true });
    expect(calls[1]?.params.stream_options).toBeUndefined();
    // Everything else survives the strip, and the abort signal is
    // forwarded on the retry too.
    expect(calls[1]?.params.model).toBe(REQ.model);
    expect(calls[1]?.params.stream).toBe(true);
    expect(calls[1]?.opts.signal).toBe(ctrl.signal);
    expect(events.map((e) => e.kind).at(-1)).toBe("message_stop");
  });

  test("stream() does NOT retry a 400 unrelated to stream_options", async () => {
    let callCount = 0;
    const client = fakeClient({
      create: () => {
        callCount += 1;
        return Promise.reject(Object.assign(new Error("bad parameter foo"), { status: 400 }));
      },
    });
    const a = new OpenAIAdapter({ client });
    let caught: unknown;
    try {
      await drain(a.stream(REQ));
    } catch (err) {
      caught = err;
    }
    expect(callCount).toBe(1);
    expect(caught).toBeInstanceOf(AdapterError);
    expect((caught as { error?: { type?: string } }).error?.type).toBe("invalid_request_error");
  });

  test("stream() gives up after one stream_options retry (no infinite loop)", async () => {
    let callCount = 0;
    const client = fakeClient({
      create: () => {
        callCount += 1;
        return Promise.reject(
          Object.assign(new Error("stream_options is not supported"), { status: 400 }),
        );
      },
    });
    const a = new OpenAIAdapter({ client });
    let caught: unknown;
    try {
      await drain(a.stream(REQ));
    } catch (err) {
      caught = err;
    }
    expect(callCount).toBe(2);
    expect(caught).toBeInstanceOf(AdapterError);
    expect((caught as { error?: { type?: string } }).error?.type).toBe("invalid_request_error");
  });

  test("estimateTokens delegates to token-budget heuristic", () => {
    const client = fakeClient({ create: () => Promise.resolve(gen([])) });
    const a = new OpenAIAdapter({ client });
    // 16 chars / 4 = 4 tokens.
    expect(a.estimateTokens([{ role: "user", content: "0123456789012345" }])).toBe(4);
  });
});

describe("normaliseOpenAIError (via stream())", () => {
  async function streamError(sdkErr: unknown): Promise<unknown> {
    const client = fakeClient({ create: () => Promise.reject(sdkErr) });
    const a = new OpenAIAdapter({ client });
    try {
      await drain(a.stream(REQ));
    } catch (err) {
      return err;
    }
    throw new Error("expected stream() to throw");
  }

  test("400 with context-length message → prompt_too_long shape", async () => {
    const err = await streamError(
      Object.assign(new Error("This model's maximum context length is 8192 tokens"), {
        status: 400,
      }),
    );
    expect((err as { status?: number }).status).toBe(400);
    expect((err as { error?: unknown }).error).toEqual({
      type: "invalid_request_error",
      message: "Prompt is too long",
    });
  });

  test("400 without context-length message → generic invalid_request", async () => {
    const err = await streamError(Object.assign(new Error("bad parameter foo"), { status: 400 }));
    expect((err as { status?: number }).status).toBe(400);
    expect((err as { error?: unknown }).error).toEqual({ type: "invalid_request_error" });
  });

  test("503 → overloaded shape", async () => {
    const err = await streamError(Object.assign(new Error("upstream down"), { status: 503 }));
    expect((err as { status?: number }).status).toBe(503);
    expect((err as { error?: unknown }).error).toEqual({ type: "overloaded_error" });
  });

  test("other defined status (404) → status copied, no error.type added", async () => {
    const err = await streamError(Object.assign(new Error("not found"), { status: 404 }));
    expect((err as { status?: number }).status).toBe(404);
    expect((err as { error?: unknown }).error).toBeUndefined();
  });

  test("non-numeric / missing status → no status, no error.type", async () => {
    const err = await streamError(new Error("plain failure, no status"));
    expect((err as { status?: number }).status).toBeUndefined();
    expect((err as { error?: unknown }).error).toBeUndefined();
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).message).toBe("plain failure, no status");
  });

  test("non-Error thrown value → stringified into the wrapped message", async () => {
    const err = await streamError("just a string");
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).message).toBe("just a string");
    expect((err as { status?: number }).status).toBeUndefined();
  });

  // =========================================================================
  // v0.3.0 Goal 6 (PR 2) — error discrimination, end-to-end through
  // recovery-engine. Fixtures pin the REAL OpenAI SDK APIError field layout
  // (status / code / error body / headers as a lowercased plain record).
  // =========================================================================

  /** Real OpenAI out-of-funds 429 — RateLimitError, code insufficient_quota. */
  const INSUFFICIENT_QUOTA_429 = () =>
    Object.assign(
      new Error("429 You exceeded your current quota, please check your plan and billing details."),
      {
        name: "RateLimitError",
        status: 429,
        code: "insufficient_quota",
        param: null,
        type: "insufficient_quota",
        error: {
          message:
            "You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.",
          type: "insufficient_quota",
          param: null,
          code: "insufficient_quota",
        },
        headers: { "x-request-id": "req_123" },
      },
    );

  /** Real OpenAI transient rate limit — same 429, code rate_limit_exceeded. */
  const RATE_LIMIT_EXCEEDED_429 = () =>
    Object.assign(new Error("429 Rate limit reached for gpt-4o-mini"), {
      name: "RateLimitError",
      status: 429,
      code: "rate_limit_exceeded",
      param: null,
      type: "requests",
      error: {
        message:
          "Rate limit reached for gpt-4o-mini in organization org-x on requests per min (RPM): Limit 3, Used 3, Requested 1. Please try again in 20s.",
        type: "requests",
        param: null,
        code: "rate_limit_exceeded",
      },
      headers: { "retry-after": "20", "x-ratelimit-remaining-requests": "0" },
    });

  test("429 insufficient_quota keeps the envelope code, no overloaded stamp → classify() billing", async () => {
    const err = await streamError(INSUFFICIENT_QUOTA_429());
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).providerId).toBe("openai");
    expect((err as { status?: number }).status).toBe(429);
    expect((err as { error?: { code?: string } }).error?.code).toBe("insufficient_quota");
    // The wrapper's own top-level `code` is CrewhausError's ErrorCode slot —
    // provider codes must NOT clobber it.
    expect((err as AdapterError).code).toBe("adapter");
    expect(classify(err)).toBe("billing");
  });

  test("a proxy 429 whose body lacks `code` still grafts the SDK top-level code into the envelope", async () => {
    const err = await streamError(
      Object.assign(new Error("429 quota exceeded"), {
        status: 429,
        code: "insufficient_quota",
        error: { message: "quota exceeded", type: "insufficient_quota" },
      }),
    );
    expect((err as { error?: { code?: string } }).error?.code).toBe("insufficient_quota");
    expect(classify(err)).toBe("billing");
  });

  test("429 insufficient_quota → recover() halts with the billing report (exit 31, OpenAI attribution)", async () => {
    const err = await streamError(INSUFFICIENT_QUOTA_429());
    const action = recover(err, initialRecoveryState);
    expect(action.kind).toBe("halt");
    if (action.kind !== "halt") return;
    expect(action.report.class).toBe("billing");
    expect(action.report.exitCode).toBe(31);
    expect(action.report.detail).toContain("OpenAI said:");
    expect(action.report.detail).toContain("You exceeded your current quota");
    expect(action.report.remediation).toContain("platform.openai.com");
  });

  test("429 rate_limit_exceeded → classify() rate_limit, Retry-After threaded via headers", async () => {
    const err = await streamError(RATE_LIMIT_EXCEEDED_429());
    expect((err as { status?: number }).status).toBe(429);
    expect((err as { error?: { code?: string } }).error?.code).toBe("rate_limit_exceeded");
    expect(classify(err)).toBe("rate_limit");
    // The SDK exposes no parsed retry-after — the copied headers record is
    // the passthrough recovery-engine reads (20s → 20000ms).
    expect(retryAfterMs(err)).toBe(20_000);
    const action = recover(err, initialRecoveryState);
    expect(action).toEqual({ kind: "retry", delayMs: 20_000, attempt: 1 });
  });

  test("401 passes through on status → classify() auth (no overloaded stamp)", async () => {
    const err = await streamError(
      Object.assign(new Error("401 Incorrect API key provided: sk-bad."), {
        name: "AuthenticationError",
        status: 401,
        code: "invalid_api_key",
        error: {
          message:
            "Incorrect API key provided: sk-bad. You can find your API key at https://platform.openai.com/account/api-keys.",
          type: "invalid_request_error",
          param: null,
          code: "invalid_api_key",
        },
      }),
    );
    expect((err as { status?: number }).status).toBe(401);
    expect(classify(err)).toBe("auth");
    const action = recover(err, initialRecoveryState);
    expect(action.kind).toBe("halt");
    if (action.kind !== "halt") return;
    expect(action.report.class).toBe("auth");
    expect(action.report.exitCode).toBe(30);
    expect(action.report.detail).toContain("Incorrect API key provided");
  });

  test("403 passes through on status → classify() auth", async () => {
    const err = await streamError(
      Object.assign(new Error("403 Country not supported"), {
        name: "PermissionDeniedError",
        status: 403,
      }),
    );
    expect((err as { status?: number }).status).toBe(403);
    expect(classify(err)).toBe("auth");
  });

  test("402 passes through on status → classify() billing", async () => {
    const err = await streamError(
      Object.assign(new Error("402 Payment Required"), { status: 402 }),
    );
    expect((err as { status?: number }).status).toBe(402);
    expect(classify(err)).toBe("billing");
  });

  test("regression: 500/503 keep the exact overloaded shape and retry semantics", async () => {
    for (const status of [500, 503]) {
      const err = await streamError(Object.assign(new Error("upstream sad"), { status }));
      expect((err as { status?: number }).status).toBe(status);
      expect((err as { error?: unknown }).error).toEqual({ type: "overloaded_error" });
      expect(classify(err)).toBe("overloaded_or_5xx");
      expect(recover(err, initialRecoveryState).kind).toBe("retry");
    }
  });

  test("regression: plain 400 keeps the exact invalid_request shape (tombstone path)", async () => {
    const err = await streamError(Object.assign(new Error("bad parameter foo"), { status: 400 }));
    expect((err as { error?: unknown }).error).toEqual({ type: "invalid_request_error" });
    expect(classify(err)).toBe("invalid_request");
    expect(recover(err, initialRecoveryState).kind).toBe("tombstone");
  });
});

describe("createOpenAIAdapter", () => {
  test("builds an adapter from OPENAI_API_KEY in env", () => {
    const a = createOpenAIAdapter({ OPENAI_API_KEY: "sk-test" } as NodeJS.ProcessEnv);
    expect(a).toBeInstanceOf(OpenAIAdapter);
    expect(a.providerId).toBe("openai");
  });

  test("override.apiKey takes precedence over env", () => {
    const a = createOpenAIAdapter({ OPENAI_API_KEY: "from-env" } as NodeJS.ProcessEnv, {
      apiKey: "from-override",
    });
    expect(a).toBeInstanceOf(OpenAIAdapter);
  });

  test("baseURL alone (no key) is allowed — uses 'local' placeholder key", () => {
    // Empty key but a baseURL set → must NOT throw (local endpoint path).
    const a = createOpenAIAdapter({} as NodeJS.ProcessEnv, {
      baseURL: "http://127.0.0.1:11434/v1",
    });
    expect(a).toBeInstanceOf(OpenAIAdapter);
  });

  test("baseURL from env (OPENAI_BASE_URL) with no key is allowed", () => {
    const a = createOpenAIAdapter({
      OPENAI_BASE_URL: "http://127.0.0.1:8000/v1",
    } as NodeJS.ProcessEnv);
    expect(a).toBeInstanceOf(OpenAIAdapter);
  });

  test("key + baseURL together both supplied", () => {
    const a = createOpenAIAdapter({} as NodeJS.ProcessEnv, {
      apiKey: "sk-real",
      baseURL: "https://proxy.example/v1",
    });
    expect(a).toBeInstanceOf(OpenAIAdapter);
  });

  test("no key and no baseURL → ProviderAuthError", () => {
    expect(() => createOpenAIAdapter({} as NodeJS.ProcessEnv)).toThrow(ProviderAuthError);
    try {
      createOpenAIAdapter({} as NodeJS.ProcessEnv);
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderAuthError);
      expect((err as ProviderAuthError).providerId).toBe("openai");
      expect((err as Error).message).toContain("OPENAI_API_KEY");
    }
  });

  test("defaults to process.env when no env arg is given", () => {
    // Exercises the `env = process.env` default param. A present API key
    // alone satisfies the credential check, so OPENAI_BASE_URL is left
    // untouched. Restore via Reflect.deleteProperty to avoid leaking a
    // stale value into sibling tests (and biome's noDelete rule).
    const prevKey = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "sk-from-process-env";
    try {
      const a = createOpenAIAdapter();
      expect(a).toBeInstanceOf(OpenAIAdapter);
    } finally {
      if (prevKey === undefined) Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
      else process.env["OPENAI_API_KEY"] = prevKey;
    }
  });
});

describe("createAzureOpenAIAdapter", () => {
  test("builds an adapter from the AZURE_OPENAI_* env triple", () => {
    const a = createAzureOpenAIAdapter({ deployment: "my-gpt4o" }, {
      AZURE_OPENAI_ENDPOINT: "https://fake.openai.azure.com",
      AZURE_OPENAI_API_KEY: "azure-key",
    } as NodeJS.ProcessEnv);
    expect(a).toBeInstanceOf(OpenAIAdapter);
    expect(a.providerId).toBe("openai");
  });

  test("honours an explicit AZURE_OPENAI_API_VERSION", () => {
    const a = createAzureOpenAIAdapter({ deployment: "my-gpt4o" }, {
      AZURE_OPENAI_ENDPOINT: "https://fake.openai.azure.com",
      AZURE_OPENAI_API_KEY: "azure-key",
      AZURE_OPENAI_API_VERSION: "2025-01-01-preview",
    } as NodeJS.ProcessEnv);
    expect(a).toBeInstanceOf(OpenAIAdapter);
  });

  test("missing endpoint or key → ProviderAuthError naming the env vars", () => {
    expect(() =>
      createAzureOpenAIAdapter({ deployment: "d" }, {
        AZURE_OPENAI_API_KEY: "azure-key",
      } as NodeJS.ProcessEnv),
    ).toThrow(ProviderAuthError);
    expect(() =>
      createAzureOpenAIAdapter({ deployment: "d" }, {
        AZURE_OPENAI_ENDPOINT: "https://fake.openai.azure.com",
      } as NodeJS.ProcessEnv),
    ).toThrow(/AZURE_OPENAI_API_KEY/);
  });
});
