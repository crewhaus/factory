/**
 * `GeminiAdapter` — Google Gemini implementation of `ProviderAdapter`.
 *
 * Auth — `createGeminiAdapter` resolves one of two modes from the env:
 *
 * | Mode       | Env vars                                                     |
 * |------------|--------------------------------------------------------------|
 * | Gemini API | `GEMINI_API_KEY` (also accepts `GOOGLE_API_KEY`). Default.   |
 * | Vertex AI  | `GOOGLE_GENAI_USE_VERTEXAI=true` (or `1`) forces it; it is   |
 * |            | also inferred when no API key is set but both                |
 * |            | `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` are.      |
 * |            | `GOOGLE_CLOUD_PROJECT` is required;                          |
 * |            | `GOOGLE_CLOUD_LOCATION` defaults to `us-central1`. No API    |
 * |            | key is required — auth flows through Application Default     |
 * |            | Credentials / the service account in the environment.        |
 *
 * Features:
 *   - `caching: "automatic"` — Gemini's implicit caching. The API caches
 *     repeated prefixes server-side and reports hits via
 *     `usageMetadata.cachedContentTokenCount` (surfaced as canonical
 *     `usage.cacheRead`). `cache_control` markers are NOT translated, so
 *     declaring `"explicit"` would make the runtime's cache-marker
 *     rotation spin for nothing.
 *   - `tool_use: true` — function calling.
 *   - `vision: true` — inline base64 + URL parts.
 *   - `thinking: true` — Gemini 2.5 thinking-mode (config.thinkingConfig).
 *     Thought parts surface as canonical thinking blocks and
 *     `thoughtSignature`s round-trip through the canonical `signature`
 *     field (newer Gemini models require signatures echoed on
 *     function-calling turns).
 *   - `web_search: false` — Google Search Grounding is NOT exposed
 *     through this adapter; tool-web is the fallback.
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
import { GoogleGenAI } from "@google/genai";
import { translateGeminiStream } from "./stream.js";
import { geminiEffectiveParams, toGeminiParams } from "./translate.js";

type AnthropicMessageParamLike = Parameters<typeof tokenBudgetEstimate>[0][number];

const GEMINI_FEATURES: ProviderFeatures = {
  caching: "automatic",
  tool_use: true,
  vision: true,
  thinking: true,
  web_search: false,
};

export type GeminiAdapterOptions = {
  readonly client: GoogleGenAI;
};

export class GeminiAdapter implements ProviderAdapter {
  readonly providerId = "gemini" as const;
  readonly features: ProviderFeatures = GEMINI_FEATURES;

  private readonly client: GoogleGenAI;

  constructor(opts: GeminiAdapterOptions) {
    this.client = opts.client;
  }

  async *stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
    const params = toGeminiParams(req);
    let iterable: Awaited<ReturnType<GoogleGenAI["models"]["generateContentStream"]>>;
    try {
      iterable = await this.client.models.generateContentStream(params);
    } catch (err) {
      throw normaliseGeminiError(err);
    }
    try {
      yield* translateGeminiStream(iterable);
    } catch (err) {
      throw normaliseGeminiError(err);
    }
  }

  estimateTokens(messages: ReadonlyArray<CanonicalMessage>): number {
    return tokenBudgetEstimate(messages as readonly AnthropicMessageParamLike[]);
  }

  /** 0.6.0 §8.1 — see `geminiEffectiveParams`; pure, no network. */
  effectiveParams(req: ProviderRequest): EffectiveParams {
    return geminiEffectiveParams(req);
  }
}

export type CreateGeminiAdapterOptions = {
  /** Force Vertex AI mode regardless of env flags (the router sets this
   *  for `vertex/gemini-*` model strings). */
  readonly vertexai?: boolean;
};

export function createGeminiAdapter(
  env: NodeJS.ProcessEnv = process.env,
  opts: CreateGeminiAdapterOptions = {},
): GeminiAdapter {
  const apiKey = nonEmpty(env["GEMINI_API_KEY"]) ?? nonEmpty(env["GOOGLE_API_KEY"]);
  const project = nonEmpty(env["GOOGLE_CLOUD_PROJECT"]);
  const location = nonEmpty(env["GOOGLE_CLOUD_LOCATION"]);
  const vertexFlag = (env["GOOGLE_GENAI_USE_VERTEXAI"] ?? "").toLowerCase();
  const vertexForced = opts.vertexai === true || vertexFlag === "true" || vertexFlag === "1";
  // Without the explicit flag, a project + location pair (and no API
  // key) is an unambiguous Vertex AI setup — infer it.
  const vertexInferred = apiKey === undefined && project !== undefined && location !== undefined;

  if (vertexForced || vertexInferred) {
    if (project === undefined) {
      // Only reachable when the flag/option forced Vertex mode —
      // inference requires a project. Without one the SDK throws an
      // opaque "Authentication is not set up" Error at construction.
      throw new ProviderAuthError(
        "gemini",
        "Vertex AI mode is forced (GOOGLE_GENAI_USE_VERTEXAI or a vertex/* model string) but GOOGLE_CLOUD_PROJECT is not set — Vertex AI requires a Google Cloud project id",
      );
    }
    // Vertex AI mode: no API key — auth flows through Application
    // Default Credentials / the ambient service account.
    return new GeminiAdapter({
      client: new GoogleGenAI({
        vertexai: true,
        project,
        location: location ?? "us-central1",
      }),
    });
  }

  if (apiKey === undefined) {
    throw new ProviderAuthError(
      "gemini",
      "no Gemini credentials found: set GEMINI_API_KEY (or GOOGLE_API_KEY) for the Gemini API, " +
        "or use Vertex AI by setting GOOGLE_GENAI_USE_VERTEXAI=true (or GOOGLE_CLOUD_PROJECT + " +
        "GOOGLE_CLOUD_LOCATION) with Application Default Credentials",
    );
  }
  return new GeminiAdapter({ client: new GoogleGenAI({ apiKey }) });
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * The REST error envelope `@google/genai`'s `ApiError` carries in its
 * message: `ApiError.message` is `JSON.stringify(errorBody)` of
 * `{ error: { code, message, status, details } }` — `status` is the gRPC
 * status string ("RESOURCE_EXHAUSTED", "PERMISSION_DENIED", …) and
 * `details` carries google.rpc records (QuotaFailure, RetryInfo, Help).
 */
type GeminiErrorBody = {
  readonly code?: number;
  readonly message?: string;
  readonly status?: string;
  readonly details?: ReadonlyArray<Record<string, unknown>>;
};

/**
 * Parse the REST error envelope back out of an ApiError message. Returns
 * the inner `error` object, or undefined when the message isn't the
 * SDK-stringified envelope (e.g. a plain network failure).
 */
function tryParseGeminiErrorBody(message: string): GeminiErrorBody | undefined {
  const start = message.indexOf("{");
  if (start === -1) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.slice(start));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const inner = (parsed as { error?: unknown }).error;
  if (inner === null || typeof inner !== "object") return undefined;
  return inner as GeminiErrorBody;
}

/**
 * v0.3.0 Goal 6 (PR 2) — true when a RESOURCE_EXHAUSTED body reports a
 * per-day / free-tier quota violation (google.rpc.QuotaFailure). Gemini
 * uses RESOURCE_EXHAUSTED for BOTH transient per-minute throttles and
 * exhausted daily plan quotas; only the latter is billing-class (the
 * account is out of quota until the plan resets or is upgraded — retrying
 * inside this run is futile).
 */
function isDailyQuotaExhaustion(body: GeminiErrorBody | undefined): boolean {
  if (body?.status !== "RESOURCE_EXHAUSTED") return false;
  for (const detail of body.details ?? []) {
    if (detail["@type"] !== "type.googleapis.com/google.rpc.QuotaFailure") continue;
    const violations = (detail as { violations?: unknown }).violations;
    if (!Array.isArray(violations)) continue;
    for (const violation of violations) {
      const v = violation as { quotaId?: unknown; quotaMetric?: unknown };
      const quotaId = typeof v.quotaId === "string" ? v.quotaId : "";
      const quotaMetric = typeof v.quotaMetric === "string" ? v.quotaMetric : "";
      if (/PerDay|Daily|FreeTier|free_tier/i.test(`${quotaId} ${quotaMetric}`)) return true;
    }
  }
  return false;
}

/** google.rpc.RetryInfo `retryDelay` ("26s", "0.8s") → milliseconds. */
function retryDelayMs(body: GeminiErrorBody | undefined): number | undefined {
  for (const detail of body?.details ?? []) {
    if (detail["@type"] !== "type.googleapis.com/google.rpc.RetryInfo") continue;
    const delay = (detail as { retryDelay?: unknown }).retryDelay;
    if (typeof delay !== "string") continue;
    const match = /^(\d+(?:\.\d+)?)s$/.exec(delay.trim());
    if (match?.[1] !== undefined) return Math.round(Number(match[1]) * 1000);
  }
  return undefined;
}

/**
 * Normalise Gemini errors into the shape `recovery-engine.classify()`
 * expects. Gemini's `ApiError` carries a numeric `status` plus a
 * message — we map 5xx into the overloaded bucket and 400 with
 * "exceeds the maximum" into prompt_too_long, mirroring the Anthropic
 * vocabulary so recovery routes correctly.
 *
 * v0.3.0 Goal 6 (PR 2) — 429s are no longer blanket-stamped
 * `overloaded_error`. Gemini signals both throttles and exhausted plan
 * quotas as 429 RESOURCE_EXHAUSTED; the QuotaFailure detail discriminates:
 *   - per-day / free-tier quota exhausted → billing: the wrapper's error
 *     envelope carries `code: "insufficient_quota"` (the canonical
 *     cross-provider billing code classify() reads — borrowed from OpenAI's
 *     vocabulary exactly the way `overloaded_error` is borrowed from
 *     Anthropic's; the wrapper's own top-level `code` stays CrewhausError's
 *     ErrorCode "adapter").
 *   - anything else → rate-limit-shaped: status 429 + `rate_limit_error`,
 *     with the RetryInfo `retryDelay` threaded as `retryAfterMs` so the
 *     recovery engine honors the provider's requested delay.
 * 401/403 pass through on status alone (classify() → auth) with the parsed
 * body message attached so FailureReports show "Gemini said: …" instead of
 * a JSON blob.
 */
function normaliseGeminiError(err: unknown): unknown {
  const name = (err as { name?: unknown })?.name;
  if (name === "AbortError" || name === "APIUserAbortError") return err;

  const message = err instanceof Error ? err.message : String(err);
  const wrapped = new AdapterError("gemini", message, err);
  const e = err as { status?: unknown; code?: unknown };
  let status: number | undefined;
  if (typeof e.status === "number") status = e.status;
  else if (typeof e.code === "number") status = e.code;

  if (status === 429) {
    const body = tryParseGeminiErrorBody(message);
    const innerMessage = typeof body?.message === "string" ? body.message : message;
    (wrapped as unknown as { status: number }).status = 429;
    if (isDailyQuotaExhaustion(body)) {
      (wrapped as unknown as { error: { type: string; code: string; message: string } }).error = {
        type: "insufficient_quota",
        code: "insufficient_quota",
        message: innerMessage,
      };
    } else {
      (wrapped as unknown as { error: { type: string; message: string } }).error = {
        type: "rate_limit_error",
        message: innerMessage,
      };
      const delay = retryDelayMs(body);
      if (delay !== undefined) {
        (wrapped as unknown as { retryAfterMs: number }).retryAfterMs = delay;
      }
    }
  } else if (status !== undefined && status >= 500 && status < 600) {
    (wrapped as unknown as { status: number }).status = status;
    (wrapped as unknown as { error: { type: string } }).error = { type: "overloaded_error" };
  } else if (
    status === 400 &&
    /token|input|context|exceeds/i.test(message) &&
    /(maximum|limit|too long|too large)/i.test(message)
  ) {
    (wrapped as unknown as { status: number }).status = 400;
    (wrapped as unknown as { error: { type: string; message: string } }).error = {
      type: "invalid_request_error",
      message: "Prompt is too long",
    };
  } else if (status === 400) {
    (wrapped as unknown as { status: number }).status = 400;
    (wrapped as unknown as { error: { type: string } }).error = { type: "invalid_request_error" };
  } else if (status !== undefined) {
    // Status passthrough (401/403 → classify() "auth", everything else
    // unknown). No shape stamping — but surface the parsed body message so
    // failure reports carry the provider's own words, not the JSON blob.
    (wrapped as unknown as { status: number }).status = status;
    const body = tryParseGeminiErrorBody(message);
    if (typeof body?.message === "string") {
      (wrapped as unknown as { error: { type: string; message: string } }).error = {
        type: body.status ?? "api_error",
        message: body.message,
      };
    }
  }

  return wrapped;
}
