/**
 * `AnthropicAdapter` — Anthropic SDK implementation of `ProviderAdapter`.
 *
 * Owns:
 * - Auth resolution (OAuth + API key) via `resolveAuth` / `createAnthropicClient`.
 * - The Claude Code system-prompt prefix for OAuth subscription billing.
 * - Translating canonical → SDK params and SDK events → canonical.
 * - Normalising SDK errors so `recovery-engine.classify()` keeps working.
 *
 * Yields `StreamEvent`s as an `AsyncIterable<StreamEvent>` per the
 * Section-17 contract; runtime-core consumes via `for await`.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { AdapterError } from "@crewhaus/errors";
import { estimateTokens as tokenBudgetEstimate } from "@crewhaus/token-budget";
import { resolveAuth } from "./auth.js";
import { createAnthropicClient } from "./client.js";
import { rawEventToCanonical, toAnthropicParams } from "./translate.js";
import type {
  CanonicalMessage,
  ProviderAdapter,
  ProviderFeatures,
  ProviderRequest,
  StreamEvent,
} from "./types.js";

const ANTHROPIC_FEATURES: ProviderFeatures = {
  caching: "explicit",
  tool_use: true,
  vision: true,
  thinking: true,
  web_search: true,
};

export type AnthropicAdapterOptions = {
  readonly client: Anthropic;
  readonly isOAuth: boolean;
};

export class AnthropicAdapter implements ProviderAdapter {
  readonly providerId = "anthropic" as const;
  readonly features: ProviderFeatures = ANTHROPIC_FEATURES;

  private readonly client: Anthropic;
  private readonly isOAuth: boolean;

  constructor(opts: AnthropicAdapterOptions) {
    this.client = opts.client;
    this.isOAuth = opts.isOAuth;
  }

  async *stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
    const params = toAnthropicParams(req, this.isOAuth);
    let iterator: AsyncIterable<Anthropic.RawMessageStreamEvent>;
    try {
      // Consume the RAW streaming `create({ stream: true })` events, NOT the
      // high-level `messages.stream()` helper. `.stream()` builds a
      // MessageStream that accumulates and `partialParse`s each tool_use's
      // input JSON as events arrive; a truncated or malformed tool call (the
      // model cut off at `max_tokens` mid-args, or emitting slightly invalid
      // JSON) makes that internal parse THROW ("JSON Parse error: Expected
      // '}'") from inside the SDK — which bypasses our own guarded
      // accumulation downstream. Both stream consumers
      // (`@crewhaus/streaming-tool-executor` and the non-streaming
      // `consumeStream`) rebuild the tool input from `input_json_delta`
      // themselves and set `{ __parse_error: true }` on a bad parse, letting
      // the runtime's `max_tokens` recovery strip the orphan `tool_use` and
      // ask the model to continue. Feeding them the raw events keeps that
      // parse in OUR guarded code, so a bad tool call degrades gracefully
      // instead of crashing the turn with an unrecoverable parse error.
      iterator = await this.client.messages.create(
        // `toAnthropicParams` builds the same body `messages.stream()` took;
        // `MessageStreamParams` widens `output_config` to allow `null` (which
        // this code never sets), so cast to the streaming-create param type.
        { ...params, stream: true } as Anthropic.MessageCreateParamsStreaming,
        req.signal !== undefined ? { signal: req.signal } : {},
      );
    } catch (err) {
      throw normaliseAnthropicError(err);
    }

    try {
      for await (const raw of iterator) {
        const ev = rawEventToCanonical(raw);
        if (ev !== null) yield ev;
      }
    } catch (err) {
      throw normaliseAnthropicError(err);
    }
  }

  estimateTokens(messages: ReadonlyArray<CanonicalMessage>): number {
    // Canonical message shape is structurally compatible with Anthropic's;
    // token-budget walks the same fields either way.
    return tokenBudgetEstimate(messages as readonly Anthropic.MessageParam[]);
  }
}

/**
 * Factory that resolves auth from env and builds an `AnthropicAdapter`.
 * Throws `ProviderAuthError` (via `createAnthropicClient`) when no
 * credentials are present.
 */
export function createAnthropicAdapter(env: NodeJS.ProcessEnv = process.env): AnthropicAdapter {
  const auth = resolveAuth(env);
  const { client, isOAuth } = createAnthropicClient(auth, env);
  return new AnthropicAdapter({ client, isOAuth });
}

/**
 * Re-throw Anthropic SDK errors as `AdapterError` while preserving the
 * fields `recovery-engine.classify()` sniffs (`status`, `error.type`,
 * `message`, `name`). `recovery-engine` was written against Anthropic's
 * shape; keeping those fields untouched means non-Anthropic adapters
 * normalise into the same shape and we don't need a new taxonomy.
 *
 * Special case: mid-stream SSE errors come through the SDK as
 * `APIError.generate(undefined, ...)` which yields an `APIConnectionError`
 * with `.error = undefined`, `.status = undefined`, and `.message` set to
 * the raw JSON envelope (`{ "type":"error", "error":{ "type":"overloaded_error", ... } }`).
 * Without recovering the structured fields, `classify()` returns "unknown"
 * and a transient overload becomes a fatal `recovery failed:` — exactly
 * the symptom the recipe walkthrough hit on a busy Anthropic server.
 * Parse the JSON envelope and hoist its `.error` so classification works.
 */
function normaliseAnthropicError(err: unknown): unknown {
  // Aborts pass through verbatim — the runtime distinguishes them by
  // `name === "APIUserAbortError"` / `"AbortError"`.
  const name = (err as { name?: unknown })?.name;
  if (name === "APIUserAbortError" || name === "AbortError") return err;
  // Anthropic.APIError shape already matches what classify() reads.
  // We wrap into AdapterError preserving the cause so the error stack
  // remains debuggable.
  const message = err instanceof Error ? err.message : String(err);
  const wrapped = new AdapterError("anthropic", message, err);
  // Copy the discriminating fields onto the wrapper so `classify(wrapped)`
  // reaches the same verdict it would have for the raw SDK error.
  const e = err as { status?: unknown; error?: unknown; name?: unknown; headers?: unknown };
  if (e.status !== undefined) (wrapped as unknown as { status?: unknown }).status = e.status;
  if (e.error !== undefined) (wrapped as unknown as { error?: unknown }).error = e.error;
  if (typeof e.name === "string") {
    (wrapped as unknown as { name?: string }).name = e.name;
  }
  // v0.3.0 Goal 6 (PR 2) — Anthropic sends `retry-after` on 429s via the
  // response headers (the SDK surfaces them as a fetch Headers instance on
  // `.headers`). Copy them through so recovery-engine's `retryAfterMs()`
  // can honor the provider's requested delay on a rate_limit retry.
  if (e.headers !== null && typeof e.headers === "object") {
    (wrapped as unknown as { headers?: unknown }).headers = e.headers;
  }

  // Recover structured fields from a JSON-envelope error message when the
  // SDK didn't surface them (mid-stream SSE error path).
  if (e.status === undefined && e.error === undefined) {
    const parsed = tryParseSseErrorEnvelope(message);
    if (parsed !== undefined) {
      (wrapped as unknown as { error?: unknown }).error = parsed;
    }
  }
  return wrapped;
}

/**
 * Try to extract Anthropic's error-envelope shape from a string. Handles
 * both the bare JSON form (`{"type":"error","error":{...}}`) and the
 * older SDK form prefixed with `SSE Error: `. Returns the inner `.error`
 * object (`{ type, message, ... }`) when the envelope matches, otherwise
 * undefined.
 */
function tryParseSseErrorEnvelope(message: string): { type: string; message?: string } | undefined {
  const trimmed = message.replace(/^SSE Error:\s*/, "").trim();
  if (!trimmed.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const envelope = parsed as { type?: unknown; error?: unknown };
  if (envelope.type !== "error" || typeof envelope.error !== "object" || envelope.error === null) {
    return undefined;
  }
  const inner = envelope.error as { type?: unknown; message?: unknown };
  if (typeof inner.type !== "string") return undefined;
  return {
    type: inner.type,
    ...(typeof inner.message === "string" ? { message: inner.message } : {}),
  };
}
