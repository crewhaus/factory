import { describe, expect, test } from "bun:test";
import type { CanonicalMessage, ProviderRequest, StreamEvent } from "@crewhaus/adapter-anthropic";
import { AdapterError, ProviderAuthError } from "@crewhaus/errors";
import { classify, initialRecoveryState, recover, retryAfterMs } from "@crewhaus/recovery-engine";
import type { GenerateContentResponse, GoogleGenAI } from "@google/genai";
import { GeminiAdapter, createGeminiAdapter } from "./adapter.js";

/**
 * Build a fake `GoogleGenAI` client whose
 * `models.generateContentStream(params)` captures the params and either
 * yields the supplied chunks or throws/rejects with the supplied error.
 *
 * `failOn` controls *where* the failure surfaces:
 *   - "call": `generateContentStream` rejects (request marshalling /
 *     connection path).
 *   - "iterate": the returned async generator throws mid-stream (stream
 *     parsing path).
 */
function fakeClient(opts: {
  chunks?: Array<Partial<GenerateContentResponse>>;
  failOn?: "call" | "iterate";
  error?: unknown;
}): {
  client: GoogleGenAI;
  captured: { params?: unknown };
} {
  const captured: { params?: unknown } = {};
  const chunks = opts.chunks ?? [];
  const client = {
    models: {
      generateContentStream: (params: unknown) => {
        captured.params = params;
        if (opts.failOn === "call") {
          return Promise.reject(opts.error);
        }
        const gen = (async function* () {
          for (const c of chunks) yield c as GenerateContentResponse;
          if (opts.failOn === "iterate") {
            throw opts.error;
          }
        })();
        return Promise.resolve(gen);
      },
    },
  } as unknown as GoogleGenAI;
  return { client, captured };
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

const baseReq: ProviderRequest = {
  model: "gemini-2.5-flash",
  system: [{ type: "text", text: "be helpful" }],
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 256,
};

describe("GeminiAdapter", () => {
  test("exposes providerId and the Gemini feature matrix", () => {
    const { client } = fakeClient({});
    const adapter = new GeminiAdapter({ client });
    expect(adapter.providerId).toBe("gemini");
    expect(adapter.features).toEqual({
      caching: "automatic",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: false,
    });
  });

  test("stream() translates params and forwards translated events", async () => {
    const { client, captured } = fakeClient({
      chunks: [
        {
          candidates: [
            { content: { role: "model", parts: [{ text: "Hello" }] } },
          ] as GenerateContentResponse["candidates"],
        },
        {
          candidates: [
            { finishReason: "STOP", content: { role: "model", parts: [] } },
          ] as unknown as GenerateContentResponse["candidates"],
        },
      ],
    });
    const adapter = new GeminiAdapter({ client });
    const events = await collect(adapter.stream(baseReq));

    // params were marshalled through toGeminiParams.
    expect((captured.params as { model?: string }).model).toBe("gemini-2.5-flash");
    expect(events[0]?.kind).toBe("message_start");
    expect(events.at(-1)?.kind).toBe("message_stop");
    const textDelta = events.find(
      (e): e is Extract<StreamEvent, { kind: "content_block_delta" }> =>
        e.kind === "content_block_delta" && e.delta.type === "text_delta",
    );
    expect(textDelta?.delta.type === "text_delta" && textDelta.delta.text).toBe("Hello");
  });

  test("stream() normalises a 429 from the request call into a rate-limit shape", async () => {
    const apiErr = Object.assign(new Error("rate limited"), { name: "ApiError", status: 429 });
    const { client } = fakeClient({ failOn: "call", error: apiErr });
    const adapter = new GeminiAdapter({ client });

    let thrown: unknown;
    try {
      await collect(adapter.stream(baseReq));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AdapterError);
    expect((thrown as { status?: number }).status).toBe(429);
    // v0.3.0 Goal 6 — a 429 is a rate limit (retried, Retry-After honored),
    // no longer stamped overloaded_error.
    expect((thrown as { error?: { type?: string } }).error?.type).toBe("rate_limit_error");
    // cause chain preserves the original SDK error.
    expect((thrown as AdapterError).cause).toBe(apiErr);
  });

  test("stream() normalises an error thrown mid-iteration", async () => {
    const apiErr = Object.assign(new Error("server blew up"), { name: "ApiError", status: 503 });
    const { client } = fakeClient({
      chunks: [
        {
          candidates: [
            { content: { role: "model", parts: [{ text: "partial" }] } },
          ] as GenerateContentResponse["candidates"],
        },
      ],
      failOn: "iterate",
      error: apiErr,
    });
    const adapter = new GeminiAdapter({ client });

    let thrown: unknown;
    try {
      await collect(adapter.stream(baseReq));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AdapterError);
    expect((thrown as { status?: number }).status).toBe(503);
    expect((thrown as { error?: { type?: string } }).error?.type).toBe("overloaded_error");
  });

  test("stream() re-throws AbortError unwrapped (no AdapterError wrapping)", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    const { client } = fakeClient({ failOn: "call", error: abortErr });
    const adapter = new GeminiAdapter({ client });

    let thrown: unknown;
    try {
      await collect(adapter.stream(baseReq));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(abortErr);
    expect(thrown).not.toBeInstanceOf(AdapterError);
  });

  test("estimateTokens delegates to the token-budget heuristic", () => {
    const { client } = fakeClient({});
    const adapter = new GeminiAdapter({ client });
    const messages: CanonicalMessage[] = [{ role: "user", content: "12345678" }];
    // 8 chars / 4 chars-per-token = 2.
    expect(adapter.estimateTokens(messages)).toBe(2);
  });
});

/**
 * Reach through the adapter's private `client` to assert which
 * `GoogleGenAI` mode the factory selected. `vertexai` is a public
 * readonly on the SDK client; `project`/`location` are assigned in its
 * constructor (untyped in the d.ts, hence the structural cast).
 */
function clientOf(adapter: GeminiAdapter): {
  vertexai: boolean;
  project?: string;
  location?: string;
} {
  return (
    adapter as unknown as {
      client: { vertexai: boolean; project?: string; location?: string };
    }
  ).client;
}

describe("createGeminiAdapter", () => {
  test("builds an adapter from GEMINI_API_KEY", () => {
    const adapter = createGeminiAdapter({ GEMINI_API_KEY: "test-key" });
    expect(adapter).toBeInstanceOf(GeminiAdapter);
    expect(adapter.providerId).toBe("gemini");
    expect(clientOf(adapter).vertexai).toBe(false);
  });

  test("falls back to GOOGLE_API_KEY when GEMINI_API_KEY is unset", () => {
    const adapter = createGeminiAdapter({ GOOGLE_API_KEY: "google-key" });
    expect(adapter).toBeInstanceOf(GeminiAdapter);
  });

  test("throws ProviderAuthError naming both auth paths when no credentials are present", () => {
    expect(() => createGeminiAdapter({})).toThrow(ProviderAuthError);
    expect(() => createGeminiAdapter({})).toThrow(/GEMINI_API_KEY/);
    expect(() => createGeminiAdapter({})).toThrow(/GOOGLE_GENAI_USE_VERTEXAI/);
    expect(() => createGeminiAdapter({})).toThrow(/Application Default Credentials/);
  });

  test("treats an empty-string key as missing credentials", () => {
    expect(() => createGeminiAdapter({ GEMINI_API_KEY: "" })).toThrow(ProviderAuthError);
  });

  test("GOOGLE_GENAI_USE_VERTEXAI=true forces Vertex AI mode without an API key", () => {
    const adapter = createGeminiAdapter({
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_CLOUD_PROJECT: "my-project",
    });
    const client = clientOf(adapter);
    expect(client.vertexai).toBe(true);
    expect(client.project).toBe("my-project");
    // Location was unset — the factory defaults it.
    expect(client.location).toBe("us-central1");
  });

  test("GOOGLE_GENAI_USE_VERTEXAI=1 also forces Vertex AI mode", () => {
    const adapter = createGeminiAdapter({
      GOOGLE_GENAI_USE_VERTEXAI: "1",
      GOOGLE_CLOUD_PROJECT: "my-project",
      GOOGLE_CLOUD_LOCATION: "europe-west1",
    });
    const client = clientOf(adapter);
    expect(client.vertexai).toBe(true);
    expect(client.location).toBe("europe-west1");
  });

  test("Vertex AI mode wins over an API key when the flag is set", () => {
    const adapter = createGeminiAdapter({
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_CLOUD_PROJECT: "my-project",
      GEMINI_API_KEY: "also-set",
    });
    expect(clientOf(adapter).vertexai).toBe(true);
  });

  test("project + location with no API key infers Vertex AI mode", () => {
    const adapter = createGeminiAdapter({
      GOOGLE_CLOUD_PROJECT: "my-project",
      GOOGLE_CLOUD_LOCATION: "us-east5",
    });
    const client = clientOf(adapter);
    expect(client.vertexai).toBe(true);
    expect(client.project).toBe("my-project");
    expect(client.location).toBe("us-east5");
  });

  test("an API key alone stays in Gemini API mode even with project + location set", () => {
    const adapter = createGeminiAdapter({
      GEMINI_API_KEY: "test-key",
      GOOGLE_CLOUD_PROJECT: "my-project",
      GOOGLE_CLOUD_LOCATION: "us-east5",
    });
    expect(clientOf(adapter).vertexai).toBe(false);
  });

  test("project alone (no location, no key) is not enough to infer Vertex AI", () => {
    expect(() => createGeminiAdapter({ GOOGLE_CLOUD_PROJECT: "my-project" })).toThrow(
      ProviderAuthError,
    );
  });

  test("forcing Vertex AI without GOOGLE_CLOUD_PROJECT throws ProviderAuthError", () => {
    expect(() => createGeminiAdapter({ GOOGLE_GENAI_USE_VERTEXAI: "true" })).toThrow(
      ProviderAuthError,
    );
    expect(() => createGeminiAdapter({ GOOGLE_GENAI_USE_VERTEXAI: "true" })).toThrow(
      /GOOGLE_CLOUD_PROJECT/,
    );
  });

  test("a falsy GOOGLE_GENAI_USE_VERTEXAI value leaves API-key mode in charge", () => {
    const adapter = createGeminiAdapter({
      GOOGLE_GENAI_USE_VERTEXAI: "false",
      GEMINI_API_KEY: "test-key",
    });
    expect(clientOf(adapter).vertexai).toBe(false);
  });

  test("defaults to process.env when no env is supplied", () => {
    const saved = process.env["GEMINI_API_KEY"];
    const savedGoogle = process.env["GOOGLE_API_KEY"];
    try {
      process.env["GEMINI_API_KEY"] = "from-process-env";
      Reflect.deleteProperty(process.env, "GOOGLE_API_KEY");
      const adapter = createGeminiAdapter();
      expect(adapter).toBeInstanceOf(GeminiAdapter);
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "GEMINI_API_KEY");
      else process.env["GEMINI_API_KEY"] = saved;
      if (savedGoogle === undefined) Reflect.deleteProperty(process.env, "GOOGLE_API_KEY");
      else process.env["GOOGLE_API_KEY"] = savedGoogle;
    }
  });
});

/**
 * Exhaustively exercise the error-normalisation matrix via the public
 * `stream()` surface, since `normaliseGeminiError` is module-private.
 * Each case rejects the request call with a shaped SDK-like error and
 * asserts the wrapped `AdapterError`'s `status`/`error` annotations.
 */
describe("Gemini error normalisation matrix", () => {
  async function streamError(error: unknown): Promise<unknown> {
    const { client } = fakeClient({ failOn: "call", error });
    const adapter = new GeminiAdapter({ client });
    try {
      await collect(adapter.stream(baseReq));
    } catch (e) {
      return e;
    }
    throw new Error("expected stream() to throw");
  }

  test("APIUserAbortError passes through unwrapped", async () => {
    const err = Object.assign(new Error("user abort"), { name: "APIUserAbortError" });
    expect(await streamError(err)).toBe(err);
  });

  test("non-Error rejection is stringified into the message", async () => {
    const wrapped = (await streamError("plain string failure")) as AdapterError;
    expect(wrapped).toBeInstanceOf(AdapterError);
    expect(wrapped.message).toBe("plain string failure");
  });

  test("status carried on `code` (not `status`) is still honoured", async () => {
    const err = Object.assign(new Error("rate limited via code"), { code: 429 });
    const wrapped = (await streamError(err)) as { status?: number; error?: { type?: string } };
    expect(wrapped.status).toBe(429);
    expect(wrapped.error?.type).toBe("rate_limit_error");
  });

  test("5xx range maps to overloaded_error, preserving the status", async () => {
    const err = Object.assign(new Error("bad gateway"), { status: 502 });
    const wrapped = (await streamError(err)) as { status?: number; error?: { type?: string } };
    expect(wrapped.status).toBe(502);
    expect(wrapped.error?.type).toBe("overloaded_error");
  });

  test("400 with token-limit language maps to invalid_request_error 'Prompt is too long'", async () => {
    const err = Object.assign(new Error("The input token count exceeds the maximum allowed"), {
      status: 400,
    });
    const wrapped = (await streamError(err)) as {
      status?: number;
      error?: { type?: string; message?: string };
    };
    expect(wrapped.status).toBe(400);
    expect(wrapped.error?.type).toBe("invalid_request_error");
    expect(wrapped.error?.message).toBe("Prompt is too long");
  });

  test("400 without token-limit language maps to a plain invalid_request_error", async () => {
    const err = Object.assign(new Error("malformed argument"), { status: 400 });
    const wrapped = (await streamError(err)) as {
      status?: number;
      error?: { type?: string; message?: string };
    };
    expect(wrapped.status).toBe(400);
    expect(wrapped.error?.type).toBe("invalid_request_error");
    expect(wrapped.error?.message).toBeUndefined();
  });

  test("400 with only half the token-limit phrasing falls through to plain invalid_request_error", async () => {
    // Matches the first regex (`exceeds`) but NOT the second
    // (maximum|limit|too long|too large) — exercises the boundary.
    const err = Object.assign(new Error("value exceeds the configured threshold"), {
      status: 400,
    });
    const wrapped = (await streamError(err)) as {
      status?: number;
      error?: { type?: string; message?: string };
    };
    expect(wrapped.status).toBe(400);
    expect(wrapped.error?.type).toBe("invalid_request_error");
    expect(wrapped.error?.message).toBeUndefined();
  });

  test("other 4xx statuses are attached verbatim with no error annotation", async () => {
    const err = Object.assign(new Error("not found"), { status: 404 });
    const wrapped = (await streamError(err)) as {
      status?: number;
      error?: unknown;
    };
    expect(wrapped.status).toBe(404);
    expect(wrapped.error).toBeUndefined();
  });

  test("an error with no numeric status is wrapped without a status annotation", async () => {
    const err = new Error("opaque network failure");
    const wrapped = (await streamError(err)) as { status?: number; error?: unknown };
    expect(wrapped).toBeInstanceOf(AdapterError);
    expect(wrapped.status).toBeUndefined();
    expect(wrapped.error).toBeUndefined();
  });
});

// ===========================================================================
// v0.3.0 Goal 6 (PR 2) — quota-vs-throttle discrimination, end-to-end
// through normaliseGeminiError → recovery-engine. `@google/genai`'s
// ApiError.message is JSON.stringify of the REST error envelope — the
// fixtures below pin the REAL envelope for a free-tier daily quota
// exhaustion vs a per-minute throttle (both HTTP 429 RESOURCE_EXHAUSTED).
// ===========================================================================
describe("Goal 6 — Gemini error discrimination (via stream())", () => {
  async function streamError(error: unknown): Promise<unknown> {
    const { client } = fakeClient({ failOn: "call", error });
    const adapter = new GeminiAdapter({ client });
    try {
      await collect(adapter.stream(baseReq));
    } catch (e) {
      return e;
    }
    throw new Error("expected stream() to throw");
  }

  function apiError(status: number, body: unknown): Error {
    return Object.assign(new Error(JSON.stringify(body)), { name: "ApiError", status });
  }

  /** Real free-tier daily-quota exhaustion envelope (out of quota → billing). */
  const DAILY_QUOTA_BODY = {
    error: {
      code: 429,
      message:
        "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.",
      status: "RESOURCE_EXHAUSTED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [
            {
              quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
              quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
              quotaDimensions: { location: "global", model: "gemini-2.0-flash" },
              quotaValue: "200",
            },
          ],
        },
        {
          "@type": "type.googleapis.com/google.rpc.Help",
          links: [
            {
              description: "Learn more about Gemini API quotas",
              url: "https://ai.google.dev/gemini-api/docs/rate-limits",
            },
          ],
        },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "26s" },
      ],
    },
  };

  /** Same envelope shape, but a per-minute quota — a transient throttle. */
  const PER_MINUTE_QUOTA_BODY = {
    error: {
      code: 429,
      message:
        "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.",
      status: "RESOURCE_EXHAUSTED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [
            {
              quotaMetric: "generativelanguage.googleapis.com/generate_content_paid_tier_requests",
              quotaId: "GenerateRequestsPerMinutePerProjectPerModel",
              quotaDimensions: { location: "global", model: "gemini-2.5-flash" },
              quotaValue: "10",
            },
          ],
        },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "39s" },
      ],
    },
  };

  test("RESOURCE_EXHAUSTED daily/free-tier quota → insufficient_quota envelope → classify() billing", async () => {
    const err = await streamError(apiError(429, DAILY_QUOTA_BODY));
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).providerId).toBe("gemini");
    expect((err as { status?: number }).status).toBe(429);
    expect((err as { error?: { code?: string } }).error?.code).toBe("insufficient_quota");
    // The wrapper's own top-level `code` stays CrewhausError's ErrorCode.
    expect((err as AdapterError).code).toBe("adapter");
    // The human-readable body message is surfaced, not the JSON blob.
    expect((err as { error?: { message?: string } }).error?.message).toContain(
      "You exceeded your current quota",
    );
    expect(classify(err)).toBe("billing");
  });

  test("daily quota exhaustion → recover() halts with the billing report (exit 31, Gemini attribution)", async () => {
    const err = await streamError(apiError(429, DAILY_QUOTA_BODY));
    const action = recover(err, initialRecoveryState);
    expect(action.kind).toBe("halt");
    if (action.kind !== "halt") return;
    expect(action.report.class).toBe("billing");
    expect(action.report.exitCode).toBe(31);
    expect(action.report.detail).toContain("Gemini said:");
    expect(action.report.remediation).toContain("aistudio.google.com");
  });

  test("RESOURCE_EXHAUSTED per-minute quota → classify() rate_limit, RetryInfo threaded", async () => {
    const err = await streamError(apiError(429, PER_MINUTE_QUOTA_BODY));
    expect((err as { error?: { code?: string } }).error?.code).toBeUndefined();
    expect((err as { error?: { type?: string } }).error?.type).toBe("rate_limit_error");
    expect(classify(err)).toBe("rate_limit");
    // google.rpc.RetryInfo retryDelay "39s" → 39000ms on the wrapper.
    expect(retryAfterMs(err)).toBe(39_000);
    const action = recover(err, initialRecoveryState);
    expect(action).toEqual({ kind: "retry", delayMs: 39_000, attempt: 1 });
  });

  test("429 with an unparseable message stays rate-limit-shaped (no billing guess)", async () => {
    const err = await streamError(
      Object.assign(new Error("too many requests"), { name: "ApiError", status: 429 }),
    );
    expect((err as { error?: { code?: string; type?: string } }).error?.code).toBeUndefined();
    expect((err as { error?: { type?: string } }).error?.type).toBe("rate_limit_error");
    expect(classify(err)).toBe("rate_limit");
  });

  test("403 PERMISSION_DENIED passes through on status → classify() auth, body message surfaced", async () => {
    const err = await streamError(
      apiError(403, {
        error: {
          code: 403,
          message: "Permission denied on resource project my-project.",
          status: "PERMISSION_DENIED",
        },
      }),
    );
    expect((err as { status?: number }).status).toBe(403);
    expect((err as { error?: { message?: string } }).error?.message).toBe(
      "Permission denied on resource project my-project.",
    );
    expect(classify(err)).toBe("auth");
    const action = recover(err, initialRecoveryState);
    expect(action.kind).toBe("halt");
    if (action.kind !== "halt") return;
    expect(action.report.exitCode).toBe(30);
    expect(action.report.detail).toContain("Permission denied");
  });

  test("401 UNAUTHENTICATED passes through on status → classify() auth", async () => {
    const err = await streamError(
      apiError(401, {
        error: {
          code: 401,
          message: "Request had invalid authentication credentials.",
          status: "UNAUTHENTICATED",
        },
      }),
    );
    expect((err as { status?: number }).status).toBe(401);
    expect(classify(err)).toBe("auth");
  });

  test("regression: 503 keeps the exact overloaded shape and retry semantics", async () => {
    const err = await streamError(
      Object.assign(new Error("server blew up"), { name: "ApiError", status: 503 }),
    );
    expect((err as { error?: unknown }).error).toEqual({ type: "overloaded_error" });
    expect(classify(err)).toBe("overloaded_or_5xx");
    expect(recover(err, initialRecoveryState).kind).toBe("retry");
  });
});

describe("createGeminiAdapter — opts.vertexai (router vertex/* path)", () => {
  test("opts.vertexai forces Vertex mode even with an API key set", () => {
    const adapter = createGeminiAdapter(
      { GEMINI_API_KEY: "also-set", GOOGLE_CLOUD_PROJECT: "my-project" },
      { vertexai: true },
    );
    const client = (adapter as unknown as { client: { vertexai: boolean; project?: string } })
      .client;
    expect(client.vertexai).toBe(true);
    expect(client.project).toBe("my-project");
  });

  test("opts.vertexai without a project throws ProviderAuthError", () => {
    expect(() => createGeminiAdapter({}, { vertexai: true })).toThrow(ProviderAuthError);
    expect(() => createGeminiAdapter({}, { vertexai: true })).toThrow(/GOOGLE_CLOUD_PROJECT/);
  });
});
