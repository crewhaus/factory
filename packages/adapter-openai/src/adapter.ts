/**
 * `OpenAIAdapter` — OpenAI Chat Completions implementation of
 * `ProviderAdapter`. Emits canonical `StreamEvent`s by translating the
 * SSE chunk stream from the OpenAI SDK.
 *
 * Auth: `OPENAI_API_KEY`. Optional `baseURL` (forwarded by the router
 * for the `local/<model>@<url>` path so Ollama / vLLM / llama.cpp
 * server's OpenAI-compatible endpoint works through this adapter
 * unchanged).
 *
 * Caching: OpenAI auto-caches at the API layer; cache_control markers
 * on the canonical request are dropped silently. Surfaced via
 * `features.caching = "automatic"`.
 *
 * Known surface gaps vs. Anthropic:
 *   - `features.thinking = false` (handled differently for o-series).
 *   - `features.web_search = false` (hosted server-side search not
 *     exposed through this adapter; tool-web is the fallback).
 */

import type {
  CanonicalMessage,
  EffectiveParams,
  ProviderAdapter,
  ProviderFeatures,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import { AdapterError, ProviderAuthError } from "@crewhaus/errors";
import { estimateTokens as tokenBudgetEstimate } from "@crewhaus/token-budget";
import OpenAI, { AzureOpenAI } from "openai";
import { translateOpenAIStream } from "./stream.js";
import { openAIEffectiveParams, toOpenAIChatParams } from "./translate.js";

// Local alias so we don't pull `@anthropic-ai/sdk` as a dep just for the
// shape token-budget happens to accept (canonical message ≅ Anthropic).
type AnthropicMessageParamLike = Parameters<typeof tokenBudgetEstimate>[0][number];

const OPENAI_FEATURES: ProviderFeatures = {
  caching: "automatic",
  tool_use: true,
  vision: true,
  thinking: false,
  web_search: false,
};

export type OpenAIAdapterOptions = {
  readonly client: OpenAI;
};

export class OpenAIAdapter implements ProviderAdapter {
  readonly providerId = "openai" as const;
  readonly features: ProviderFeatures = OPENAI_FEATURES;

  private readonly client: OpenAI;

  constructor(opts: OpenAIAdapterOptions) {
    this.client = opts.client;
  }

  async *stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
    const params = toOpenAIChatParams(req);
    const requestOpts = {
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
    };
    let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    try {
      stream = (await this.client.chat.completions.create(
        params,
        requestOpts,
      )) as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    } catch (err) {
      // Some OpenAI-compatible servers/proxies 400 on `stream_options`
      // (it's an OpenAI extension). Retry ONCE without it — the stream
      // translator already tolerates absent usage.
      if (!isStreamOptionsRejection(err)) throw normaliseOpenAIError(err);
      const { stream_options: _streamOptions, ...stripped } = params;
      try {
        stream = (await this.client.chat.completions.create(
          stripped,
          requestOpts,
        )) as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
      } catch (retryErr) {
        throw normaliseOpenAIError(retryErr);
      }
    }
    try {
      yield* translateOpenAIStream(stream);
    } catch (err) {
      throw normaliseOpenAIError(err);
    }
  }

  estimateTokens(messages: ReadonlyArray<CanonicalMessage>): number {
    // Heuristic only; canonical shape mirrors Anthropic's so the same
    // estimator applies.
    return tokenBudgetEstimate(messages as readonly AnthropicMessageParamLike[]);
  }

  /** 0.6.0 §8.1 — see `openAIEffectiveParams`; pure, no network. */
  effectiveParams(req: ProviderRequest): EffectiveParams {
    return openAIEffectiveParams(req);
  }
}

export type CreateOpenAIAdapterEnv = {
  readonly apiKey?: string;
  readonly baseURL?: string;
};

/**
 * Build an OpenAIAdapter from env. The router calls this with `baseURL`
 * pre-resolved when a `local/<model>@<url>` model string is in play.
 */
export function createOpenAIAdapter(
  env: NodeJS.ProcessEnv = process.env,
  override: CreateOpenAIAdapterEnv = {},
): OpenAIAdapter {
  const apiKey = override.apiKey ?? env["OPENAI_API_KEY"] ?? "";
  const baseURL = override.baseURL ?? env["OPENAI_BASE_URL"];
  if (apiKey.length === 0 && baseURL === undefined) {
    throw new ProviderAuthError(
      "openai",
      "no OpenAI credentials found: set OPENAI_API_KEY (or OPENAI_BASE_URL for an OpenAI-compatible local endpoint)",
    );
  }
  // Local OpenAI-compatible servers (Ollama/vLLM/llama.cpp) often
  // accept any non-empty key. Pass `"local"` as a placeholder when no
  // real key is set but a baseURL is.
  const client = new OpenAI({
    apiKey: apiKey.length > 0 ? apiKey : "local",
    ...(baseURL !== undefined ? { baseURL } : {}),
  });
  return new OpenAIAdapter({ client });
}

export type CreateAzureOpenAIAdapterOptions = {
  /** Azure OpenAI deployment name (the `azure/<deployment>` segment). */
  readonly deployment: string;
};

/**
 * Build an OpenAIAdapter against Azure OpenAI's classic surface
 * (deployment-scoped path + `api-key` header + `api-version` query) via
 * the SDK's `AzureOpenAI` client. Env:
 *   - AZURE_OPENAI_ENDPOINT     https://<resource>.openai.azure.com
 *   - AZURE_OPENAI_API_KEY      the resource key
 *   - AZURE_OPENAI_API_VERSION  optional, defaults to a stable GA version
 *
 * The stream/translate path is identical to plain OpenAI — Azure speaks
 * Chat Completions once the client handles routing and auth.
 */
export function createAzureOpenAIAdapter(
  opts: CreateAzureOpenAIAdapterOptions,
  env: NodeJS.ProcessEnv = process.env,
): OpenAIAdapter {
  const endpoint = env["AZURE_OPENAI_ENDPOINT"] ?? "";
  const apiKey = env["AZURE_OPENAI_API_KEY"] ?? "";
  if (endpoint.length === 0 || apiKey.length === 0) {
    throw new ProviderAuthError(
      "openai",
      "azure/<deployment> model strings require AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY (api version via AZURE_OPENAI_API_VERSION, default 2024-10-21)",
    );
  }
  const apiVersion = env["AZURE_OPENAI_API_VERSION"] ?? "2024-10-21";
  const client = new AzureOpenAI({
    endpoint,
    apiKey,
    apiVersion,
    deployment: opts.deployment,
  });
  return new OpenAIAdapter({ client });
}

/**
 * True for a 400 whose message points at `stream_options` — the marker
 * for an OpenAI-compatible server that doesn't understand the field.
 * Abort errors and every other status fall through to normalisation.
 */
function isStreamOptionsRejection(err: unknown): boolean {
  const e = err as { status?: unknown; message?: unknown };
  if (e?.status !== 400) return false;
  const message = err instanceof Error ? err.message : String(err);
  return /stream_options/i.test(message);
}

/**
 * Normalise OpenAI errors into the shape `recovery-engine.classify()`
 * already understands. OpenAI's status codes overlap directly:
 *   - 429 → billing (code "insufficient_quota") or rate_limit (any other)
 *   - 5xx → overloaded_or_5xx
 *   - 400 with "context length" → prompt_too_long
 *   - other 400 → invalid_request
 *   - 401/402/403 → status passthrough (classify() → auth / billing)
 * 5xx and 400s translate by setting `error.type` to the matching Anthropic
 * vocabulary so classify() catches them.
 *
 * v0.3.0 Goal 6 (PR 2) — the discriminating fields ride the wrapper so an
 * out-of-funds account is no longer conflated with a transient overload:
 *   - `error.code` (on the copied API body envelope, where classify() reads
 *     it): OpenAI encodes "insufficient_quota" (out of funds — terminal) vs
 *     "rate_limit_exceeded" (transient) on otherwise-identical 429s; the
 *     pre-0.3.0 blanket `overloaded_error` stamp erased that distinction
 *     and burned five futile backoff retries against an empty account.
 *     The SDK's top-level `code` is grafted into the envelope when the body
 *     didn't carry one — it must NOT land on the wrapper's own `code`,
 *     which is CrewhausError's closed ErrorCode union ("adapter").
 *   - `error.message` feeds FailureReport `detail` ("OpenAI said: …").
 *   - `headers`: the SDK exposes no parsed retry-after field, only the raw
 *     response headers — copying them through is the Retry-After
 *     passthrough (recovery-engine's `retryAfterMs()` reads
 *     `headers["retry-after"]` when delaying a rate_limit retry).
 */
function normaliseOpenAIError(err: unknown): unknown {
  const name = (err as { name?: unknown })?.name;
  if (name === "APIUserAbortError" || name === "AbortError") return err;

  const message = err instanceof Error ? err.message : String(err);
  const wrapped = new AdapterError("openai", message, err);
  const e = err as {
    status?: unknown;
    message?: unknown;
    code?: unknown;
    error?: unknown;
    headers?: unknown;
  };
  const status = typeof e.status === "number" ? e.status : undefined;
  // The wrapper is duck-typed by recovery-engine.classify(); these are plain
  // runtime properties, so cast once and assign.
  const w = wrapped as unknown as {
    status?: number;
    error?: unknown;
    headers?: unknown;
  };

  if (status !== undefined) w.status = status;
  const body = e.error !== null && typeof e.error === "object" ? e.error : undefined;
  const sdkCode = typeof e.code === "string" ? e.code : undefined;
  if (body !== undefined) {
    const bodyCode = (body as { code?: unknown }).code;
    w.error =
      typeof bodyCode === "string" || sdkCode === undefined ? body : { ...body, code: sdkCode };
  } else if (sdkCode !== undefined) {
    w.error = { code: sdkCode };
  }
  if (e.headers !== null && typeof e.headers === "object") w.headers = e.headers;

  // Shape-stamping is now needed only where OpenAI's own vocabulary doesn't
  // discriminate. 429s are deliberately NOT stamped: status + code already
  // route them (classify() → billing for insufficient_quota, rate_limit
  // otherwise), and 401/402/403 pass through on status alone.
  if (status !== undefined && status >= 500 && status < 600) {
    w.error = { type: "overloaded_error" };
  } else if (
    status === 400 &&
    /context length|maximum context|too long|exceeds the model/i.test(message)
  ) {
    w.error = { type: "invalid_request_error", message: "Prompt is too long" };
  } else if (status === 400) {
    w.error = { type: "invalid_request_error" };
  }

  return wrapped;
}
