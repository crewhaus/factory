/**
 * `GeminiAdapter` — Google Gemini implementation of `ProviderAdapter`.
 *
 * Auth: `GEMINI_API_KEY` (also accepts `GOOGLE_API_KEY`).
 *
 * Features:
 *   - `caching: "explicit"` — Gemini's cachedContent reference path.
 *     The runtime carries `cache_control` markers through translate and
 *     a future iteration can mint cachedContent references from them.
 *   - `tool_use: true` — function calling.
 *   - `vision: true` — inline base64 + URL parts.
 *   - `thinking: true` — Gemini 2.5 thinking-mode (config.thinkingConfig).
 *   - `web_search: false` — Google Search Grounding is NOT exposed
 *     through this adapter; tool-web is the fallback.
 */

import type {
  CanonicalMessage,
  ProviderAdapter,
  ProviderFeatures,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import { AdapterError, ProviderAuthError } from "@crewhaus/errors";
import { estimateTokens as tokenBudgetEstimate } from "@crewhaus/token-budget";
import { GoogleGenAI } from "@google/genai";
import { translateGeminiStream } from "./stream.js";
import { toGeminiParams } from "./translate.js";

type AnthropicMessageParamLike = Parameters<typeof tokenBudgetEstimate>[0][number];

const GEMINI_FEATURES: ProviderFeatures = {
  caching: "explicit",
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
}

export function createGeminiAdapter(env: NodeJS.ProcessEnv = process.env): GeminiAdapter {
  const apiKey = env["GEMINI_API_KEY"] ?? env["GOOGLE_API_KEY"];
  if (apiKey === undefined || apiKey.length === 0) {
    throw new ProviderAuthError(
      "gemini",
      "no Gemini credentials found: set GEMINI_API_KEY (or GOOGLE_API_KEY)",
    );
  }
  return new GeminiAdapter({ client: new GoogleGenAI({ apiKey }) });
}

/**
 * Normalise Gemini errors into the shape `recovery-engine.classify()`
 * expects. Gemini's `ApiError` carries a numeric `status` plus a
 * message — we map 429 + 5xx into the overloaded bucket and 400 with
 * "exceeds the maximum" into prompt_too_long, mirroring the Anthropic
 * vocabulary so recovery routes correctly.
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
    (wrapped as unknown as { status: number }).status = 429;
    (wrapped as unknown as { error: { type: string } }).error = { type: "overloaded_error" };
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
    (wrapped as unknown as { status: number }).status = status;
  }

  return wrapped;
}
