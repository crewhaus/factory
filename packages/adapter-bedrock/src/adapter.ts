/**
 * `BedrockAdapter` — AWS Bedrock implementation of `ProviderAdapter`,
 * with per-family request/response marshalling.
 *
 * One adapter instance per family (the model-router caches by
 * `(providerId, family)`). The `features` field carries the family-
 * specific capabilities.
 *
 * Auth: implicit AWS credential chain (`AWS_ACCESS_KEY_ID` /
 * `AWS_SECRET_ACCESS_KEY` / `AWS_REGION`, IAM roles, profile-based).
 * No env reads here — the SDK handles it.
 */

import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type {
  CanonicalMessage,
  ProviderAdapter,
  ProviderFeatures,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import { AdapterError } from "@crewhaus/errors";
import { estimateTokens as tokenBudgetEstimate } from "@crewhaus/token-budget";
import { buildAnthropicBedrockBody, decodeAnthropicBedrockChunk } from "./families/anthropic.js";
import {
  buildLlamaBedrockBody,
  decodeLlamaBedrockChunk,
  newLlamaStreamState,
} from "./families/llama.js";
import {
  buildMistralBedrockBody,
  decodeMistralBedrockChunk,
  newMistralStreamState,
} from "./families/mistral.js";
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
    const body = buildBodyForFamily(req, this.family);
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

  estimateTokens(messages: ReadonlyArray<CanonicalMessage>): number {
    return tokenBudgetEstimate(messages as readonly AnthropicMessageParamLike[]);
  }

  private async *translateBedrockStream(
    stream: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }>,
  ): AsyncIterable<StreamEvent> {
    yield { kind: "message_start" };
    const decoder = new TextDecoder();
    const llamaState = this.family === "llama" ? newLlamaStreamState() : undefined;
    const mistralState = this.family === "mistral" ? newMistralStreamState() : undefined;
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
        switch (this.family) {
          case "anthropic": {
            const ev = decodeAnthropicBedrockChunk(payload);
            if (ev !== null) yield ev;
            break;
          }
          case "llama":
            for (const ev of decodeLlamaBedrockChunk(
              payload as Parameters<typeof decodeLlamaBedrockChunk>[0],
              // biome-ignore lint/style/noNonNullAssertion: family branch guarantees defined.
              llamaState!,
            )) {
              yield ev;
            }
            break;
          case "mistral":
            for (const ev of decodeMistralBedrockChunk(
              payload as Parameters<typeof decodeMistralBedrockChunk>[0],
              // biome-ignore lint/style/noNonNullAssertion: family branch guarantees defined.
              mistralState!,
            )) {
              yield ev;
            }
            break;
        }
      }
    } catch (err) {
      if ((err as { name?: unknown })?.name === "AbortError") throw err;
      throw normaliseBedrockError(err);
    }
    // Ensure terminator events fire even if the family decoder didn't.
    if (this.family === "anthropic") {
      // Anthropic-on-Bedrock embeds message_stop in its raw events,
      // so nothing extra to do here.
    } else if (
      (llamaState !== undefined && !llamaState.closed) ||
      (mistralState !== undefined && !mistralState.closed)
    ) {
      yield { kind: "message_delta", stopReason: "end_turn" };
      yield { kind: "message_stop" };
    }
  }
}

function buildBodyForFamily(req: ProviderRequest, family: BedrockFamily): unknown {
  switch (family) {
    case "anthropic":
      return buildAnthropicBedrockBody(req);
    case "llama":
      return buildLlamaBedrockBody(req);
    case "mistral":
      return buildMistralBedrockBody(req);
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
  const region = opts.region ?? env["AWS_REGION"] ?? env["AWS_DEFAULT_REGION"] ?? "us-east-1";
  const client = new BedrockRuntimeClient({ region });
  return new BedrockAdapter({ client, family: opts.family });
}

function normaliseBedrockError(err: unknown): unknown {
  const name = (err as { name?: unknown })?.name;
  if (name === "AbortError" || name === "APIUserAbortError") return err;

  const message = err instanceof Error ? err.message : String(err);
  const wrapped = new AdapterError("bedrock", message, err);
  const e = err as { $metadata?: { httpStatusCode?: number } } | null | undefined;
  const status = e?.$metadata?.httpStatusCode;

  // Bedrock taxonomy → Anthropic-shaped fields recovery-engine reads.
  // ThrottlingException / ServiceQuotaExceededException / TooManyRequestsException → 429.
  if (typeof name === "string" && /Throttling|TooManyRequests|ServiceQuotaExceeded/.test(name)) {
    (wrapped as unknown as { status: number }).status = 429;
    (wrapped as unknown as { error: { type: string } }).error = { type: "overloaded_error" };
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
