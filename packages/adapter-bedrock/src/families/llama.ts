/**
 * Llama-on-Bedrock family marshalling.
 *
 * Llama models on Bedrock take a `prompt` string + sampling params
 * and emit `generation` deltas with optional `stop_reason`. No tool
 * use, no vision, no thinking. We render the canonical message array
 * into a flat conversation string using the standard Llama-3 chat
 * format.
 */

import type {
  CanonicalMessage,
  CanonicalTextBlockParam,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";

export type LlamaBedrockBody = {
  readonly prompt: string;
  readonly max_gen_len: number;
  readonly temperature?: number;
  readonly top_p?: number;
};

const TEXT_BLOCK_INDEX = 0;

export function buildLlamaBedrockBody(req: ProviderRequest): LlamaBedrockBody {
  return {
    prompt: renderLlamaPrompt(req.system, req.messages),
    max_gen_len: req.maxTokens,
  };
}

function renderLlamaPrompt(
  system: ReadonlyArray<CanonicalTextBlockParam>,
  messages: ReadonlyArray<CanonicalMessage>,
): string {
  // Llama-3-Instruct chat template (matches Bedrock's expectation).
  let out = "<|begin_of_text|>";
  const sysText = system
    .map((b) => b.text)
    .filter((t) => t.length > 0)
    .join("\n\n");
  if (sysText.length > 0) {
    out += `<|start_header_id|>system<|end_header_id|>\n\n${sysText}<|eot_id|>`;
  }
  for (const m of messages) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const text =
      typeof m.content === "string"
        ? m.content
        : m.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("\n");
    out += `<|start_header_id|>${role}<|end_header_id|>\n\n${text}<|eot_id|>`;
  }
  out += "<|start_header_id|>assistant<|end_header_id|>\n\n";
  return out;
}

/** State carried across decoded chunks within a single Llama stream. */
export type LlamaStreamState = {
  textBlockOpened: boolean;
  closed: boolean;
};

export function newLlamaStreamState(): LlamaStreamState {
  return { textBlockOpened: false, closed: false };
}

/**
 * Decode one Llama-on-Bedrock chunk into canonical StreamEvents.
 * Llama chunks have shape `{ generation: string, stop_reason?: string,
 * generation_token_count?: number, prompt_token_count?: number }`.
 * Stateful: opens the text block on first generation chunk; emits
 * message_delta + message_stop on stop_reason.
 */
export function* decodeLlamaBedrockChunk(
  payload: {
    generation?: string;
    stop_reason?: string;
    generation_token_count?: number;
    prompt_token_count?: number;
  },
  state: LlamaStreamState,
): Iterable<StreamEvent> {
  if (state.closed) return;
  if (typeof payload.generation === "string" && payload.generation.length > 0) {
    if (!state.textBlockOpened) {
      yield {
        kind: "content_block_start",
        index: TEXT_BLOCK_INDEX,
        block: { type: "text", text: "" },
      };
      state.textBlockOpened = true;
    }
    yield {
      kind: "content_block_delta",
      index: TEXT_BLOCK_INDEX,
      delta: { type: "text_delta", text: payload.generation },
    };
  }
  if (payload.stop_reason !== undefined && payload.stop_reason !== null) {
    if (state.textBlockOpened) {
      yield { kind: "content_block_stop", index: TEXT_BLOCK_INDEX };
    }
    yield {
      kind: "message_delta",
      stopReason: llamaStopReasonToCanonical(payload.stop_reason),
      ...(payload.generation_token_count !== undefined || payload.prompt_token_count !== undefined
        ? {
            usage: {
              input: payload.prompt_token_count ?? 0,
              output: payload.generation_token_count ?? 0,
            },
          }
        : {}),
    };
    yield { kind: "message_stop" };
    state.closed = true;
  }
}

function llamaStopReasonToCanonical(reason: string): string {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    default:
      return reason;
  }
}
