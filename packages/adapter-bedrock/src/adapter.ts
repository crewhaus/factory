/**
 * `BedrockAdapter` — AWS Bedrock implementation of `ProviderAdapter`.
 *
 * Two wire paths, one adapter:
 *   - anthropic → native InvokeModelWithResponseStream with the
 *     Messages-API-shaped body (families/anthropic.ts) so explicit
 *     cache_control and the thinking budget keep working.
 *   - every other family → the model-agnostic Converse/ConverseStream
 *     API (converse.ts), which gives llama/mistral/nova/cohere/qwen/
 *     gpt-oss genuine tool use and deepseek/gpt-oss reasoning without
 *     per-vendor body marshalling.
 *
 * One adapter instance per family (the model-router caches by
 * `(providerId, family)`). The `features` field carries the family-
 * specific capabilities.
 *
 * Auth: implicit AWS credential chain (`AWS_ACCESS_KEY_ID` /
 * `AWS_SECRET_ACCESS_KEY`, IAM roles, profile-based) or a Bedrock API
 * key via `AWS_BEARER_TOKEN_BEDROCK` (SDK ≥ 3.842 reads it natively —
 * the simplest path for non-AWS-native users). No env reads here for
 * credentials — the SDK handles it. Region comes from
 * `AWS_REGION`/`AWS_DEFAULT_REGION` when set; otherwise the client is
 * built without an explicit region so the SDK's own chain (including
 * `~/.aws/config` profiles) resolves it.
 */

import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import type {
  CanonicalMessage,
  EffectiveParams,
  ProviderAdapter,
  ProviderFeatures,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import { AdapterError } from "@crewhaus/errors";
import { estimateTokens as tokenBudgetEstimate } from "@crewhaus/token-budget";
import {
  buildConverseRequest,
  converseEffectiveParams,
  translateConverseStream,
} from "./converse.js";
import {
  anthropicBedrockEffectiveParams,
  buildAnthropicBedrockBody,
  decodeAnthropicBedrockChunk,
} from "./families/anthropic.js";
import type { BedrockFamily } from "./family.js";
import { featuresForFamily } from "./family.js";

type AnthropicMessageParamLike = Parameters<typeof tokenBudgetEstimate>[0][number];

export type BedrockAdapterOptions = {
  readonly client: BedrockRuntimeClient;
  readonly family: BedrockFamily;
};

export class BedrockAdapter implements ProviderAdapter {
  readonly providerId = "bedrock" as const;
  readonly features: ProviderFeatures;
  readonly family: BedrockFamily;

  private readonly client: BedrockRuntimeClient;

  constructor(opts: BedrockAdapterOptions) {
    this.client = opts.client;
    this.family = opts.family;
    this.features = featuresForFamily(opts.family);
  }

  async *stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
    if (this.family === "anthropic") {
      yield* this.streamInvoke(req);
    } else {
      yield* this.streamConverse(req);
    }
  }

  estimateTokens(messages: ReadonlyArray<CanonicalMessage>): number {
    return tokenBudgetEstimate(messages as readonly AnthropicMessageParamLike[]);
  }

  /**
   * 0.6.0 §8.1 — projects whichever marshaller `stream()` would run for
   * this family (native Anthropic body vs Converse); pure, no network.
   */
  effectiveParams(req: ProviderRequest): EffectiveParams {
    return this.family === "anthropic"
      ? anthropicBedrockEffectiveParams(req)
      : converseEffectiveParams(req);
  }

  /** Anthropic family: native InvokeModelWithResponseStream path. */
  private async *streamInvoke(req: ProviderRequest): AsyncIterable<StreamEvent> {
    const body = buildAnthropicBedrockBody(req);
    const command = new InvokeModelWithResponseStreamCommand({
      modelId: req.model,
      contentType: "application/json",
      accept: "application/json",
      body: new TextEncoder().encode(JSON.stringify(body)),
    });

    let response: { body?: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }> };
    try {
      // The Smithy v3 generic `send()` infers from the command class;
      // we narrow the return type to the slice we consume below.
      response = (await this.client.send(command, {
        ...(req.signal !== undefined ? { abortSignal: req.signal } : {}),
      })) as unknown as { body?: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }> };
    } catch (err) {
      throw normaliseBedrockError(err);
    }

    const stream = response.body;
    if (stream === undefined) {
      throw new AdapterError("bedrock", "Bedrock InvokeModelWithResponseStream returned no body");
    }

    yield* this.translateBedrockStream(stream);
  }

  /** Non-anthropic families: model-agnostic ConverseStream path. */
  private async *streamConverse(req: ProviderRequest): AsyncIterable<StreamEvent> {
    const command = new ConverseStreamCommand(buildConverseRequest(req));

    let response: { stream?: AsyncIterable<ConverseStreamOutput> };
    try {
      response = (await this.client.send(command, {
        ...(req.signal !== undefined ? { abortSignal: req.signal } : {}),
      })) as unknown as { stream?: AsyncIterable<ConverseStreamOutput> };
    } catch (err) {
      throw normaliseBedrockError(err);
    }

    const stream = response.stream;
    if (stream === undefined) {
      throw new AdapterError("bedrock", "Bedrock ConverseStream returned no stream");
    }

    try {
      yield* translateConverseStream(stream);
    } catch (err) {
      if ((err as { name?: unknown })?.name === "AbortError") throw err;
      throw normaliseBedrockError(err);
    }
  }

  private async *translateBedrockStream(
    stream: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }>,
  ): AsyncIterable<StreamEvent> {
    yield { kind: "message_start" };
    const decoder = new TextDecoder();
    try {
      for await (const event of stream) {
        const bytes = event.chunk?.bytes;
        if (bytes === undefined) continue;
        const text = decoder.decode(bytes);
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch (err) {
          throw new AdapterError(
            "bedrock",
            `failed to parse Bedrock chunk JSON: ${(err as Error).message}`,
            err,
          );
        }
        const ev = decodeAnthropicBedrockChunk(payload);
        if (ev !== null) yield ev;
      }
    } catch (err) {
      if ((err as { name?: unknown })?.name === "AbortError") throw err;
      throw normaliseBedrockError(err);
    }
    // Anthropic-on-Bedrock embeds message_delta/message_stop in its raw
    // events, so no synthetic terminator is needed here.
  }
}

export type CreateBedrockAdapterOptions = {
  readonly family: BedrockFamily;
  readonly region?: string;
};

export function createBedrockAdapter(
  opts: CreateBedrockAdapterOptions,
  env: NodeJS.ProcessEnv = process.env,
): BedrockAdapter {
  // Only pass region when explicitly resolved; otherwise let the SDK's
  // default provider chain consult ~/.aws/config (profile region). A
  // hardcoded fallback here silently sent AWS_PROFILE users to the
  // wrong region, where their model may not even be enabled.
  const region = opts.region ?? env["AWS_REGION"] ?? env["AWS_DEFAULT_REGION"];
  const client = new BedrockRuntimeClient(region !== undefined ? { region } : {});
  return new BedrockAdapter({ client, family: opts.family });
}

/**
 * Normalise Bedrock (Smithy) exceptions into the Anthropic-shaped fields
 * recovery-engine reads.
 *
 * v0.3.0 Goal 6 (PR 2) — the quota-vs-throttle distinction AWS encodes in
 * the exception NAME is preserved instead of both being stamped
 * 429/overloaded:
 *   - ThrottlingException / TooManyRequestsException → 429 +
 *     `rate_limit_error` (transient — classify() retries, honoring
 *     Retry-After when one is exposed).
 *   - ServiceQuotaExceededException → surfaced by name (copied onto the
 *     wrapper, which the blanket "AdapterError" name used to erase) so
 *     classify() routes it to billing: a hard account quota fails every
 *     retry identically — the fix is a quota increase, not patience.
 *   - 401/403 ($metadata.httpStatusCode) pass through on status alone
 *     (classify() → auth: UnrecognizedClientException, AccessDeniedException,
 *     ExpiredTokenException and friends).
 */
function normaliseBedrockError(err: unknown): unknown {
  const name = (err as { name?: unknown })?.name;
  if (name === "AbortError" || name === "APIUserAbortError") return err;

  const message = err instanceof Error ? err.message : String(err);
  const wrapped = new AdapterError("bedrock", message, err);
  const e = err as { $metadata?: { httpStatusCode?: number } } | null | undefined;
  const status = e?.$metadata?.httpStatusCode;

  // Keep the original exception name on the wrapper (mirrors the Anthropic
  // adapter): classify() matches ServiceQuotaExceededException by name, and
  // the concrete Smithy name beats a uniform "AdapterError" in traces.
  if (typeof name === "string" && name.length > 0) {
    (wrapped as unknown as { name: string }).name = name;
  }

  // Bedrock taxonomy → Anthropic-shaped fields recovery-engine reads.
  if (typeof name === "string" && /ServiceQuotaExceeded/.test(name)) {
    // Billing-class: no shape stamping (the name is the discriminator);
    // copy the real HTTP status (usually 400) instead of fabricating a 429.
    if (status !== undefined) {
      (wrapped as unknown as { status: number }).status = status;
    }
  } else if (typeof name === "string" && /Throttling|TooManyRequests/.test(name)) {
    (wrapped as unknown as { status: number }).status = 429;
    (wrapped as unknown as { error: { type: string } }).error = { type: "rate_limit_error" };
  } else if (typeof name === "string" && /ModelStreamError|InternalServerException/.test(name)) {
    (wrapped as unknown as { status: number }).status = status ?? 500;
    (wrapped as unknown as { error: { type: string } }).error = { type: "overloaded_error" };
  } else if (
    typeof name === "string" &&
    /ValidationException/.test(name) &&
    /context|input|prompt|too long|exceeds/i.test(message)
  ) {
    (wrapped as unknown as { status: number }).status = 400;
    (wrapped as unknown as { error: { type: string; message: string } }).error = {
      type: "invalid_request_error",
      message: "Prompt is too long",
    };
  } else if (status === 400) {
    (wrapped as unknown as { status: number }).status = 400;
    (wrapped as unknown as { error: { type: string } }).error = { type: "invalid_request_error" };
  } else if (status !== undefined && status >= 500 && status < 600) {
    (wrapped as unknown as { status: number }).status = status;
    (wrapped as unknown as { error: { type: string } }).error = { type: "overloaded_error" };
  } else if (status !== undefined) {
    (wrapped as unknown as { status: number }).status = status;
  }

  return wrapped;
}
