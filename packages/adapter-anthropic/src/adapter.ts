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
      iterator = this.client.messages.stream(
        params,
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
  const e = err as { status?: unknown; error?: unknown; name?: unknown };
  if (e.status !== undefined) (wrapped as unknown as { status?: unknown }).status = e.status;
  if (e.error !== undefined) (wrapped as unknown as { error?: unknown }).error = e.error;
  if (typeof e.name === "string") {
    (wrapped as unknown as { name?: string }).name = e.name;
  }
  return wrapped;
}
