/**
 * Mistral-on-Bedrock family marshalling.
 *
 * Mistral on Bedrock uses Mistral Instruct chat templating. The
 * legacy text-completion shape (`prompt: "<s>[INST] ... [/INST]"`)
 * remains the most portable across model variants on Bedrock today.
 *
 * Tool calling on Mistral-on-Bedrock varies by model — we surface
 * `tool_use: false` in features for now and leave a follow-up for
 * Mistral Large's Converse-style API integration.
 */

import type {
  CanonicalMessage,
  CanonicalTextBlockParam,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";

export type MistralBedrockBody = {
  readonly prompt: string;
  readonly max_tokens: number;
  readonly temperature?: number;
  readonly top_p?: number;
};

const TEXT_BLOCK_INDEX = 0;

export function buildMistralBedrockBody(req: ProviderRequest): MistralBedrockBody {
  return {
    prompt: renderMistralPrompt(req.system, req.messages),
    max_tokens: req.maxTokens,
  };
}

function renderMistralPrompt(
  system: ReadonlyArray<CanonicalTextBlockParam>,
  messages: ReadonlyArray<CanonicalMessage>,
): string {
  // Folds system text into the first [INST] block so simpler Mistral
  // variants without explicit system support still see the
  // instructions.
  const sysText = system
    .map((b) => b.text)
    .filter((t) => t.length > 0)
    .join("\n\n");
  let out = "<s>";
  let firstUser = true;
  for (const m of messages) {
    const text =
      typeof m.content === "string"
        ? m.content
        : m.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("\n");
    if (m.role === "user") {
      const prefix = firstUser && sysText.length > 0 ? `${sysText}\n\n` : "";
      out += `[INST] ${prefix}${text} [/INST]`;
      firstUser = false;
    } else {
      out += ` ${text}</s><s>`;
    }
  }
  return out;
}

export type MistralStreamState = {
  textBlockOpened: boolean;
  closed: boolean;
  outputTokens: number;
};

export function newMistralStreamState(): MistralStreamState {
  return { textBlockOpened: false, closed: false, outputTokens: 0 };
}

/**
 * Decode one Mistral chunk. Shape varies but most models emit
 * `outputs: [{ text, stop_reason? }]` or `{ generation, stop_reason? }`.
 * We accept both and degrade gracefully.
 */
export function* decodeMistralBedrockChunk(
  payload: {
    outputs?: Array<{ text?: string; stop_reason?: string }>;
    generation?: string;
    stop_reason?: string;
  },
  state: MistralStreamState,
): Iterable<StreamEvent> {
  if (state.closed) return;

  const text =
    payload.outputs?.[0]?.text ??
    (typeof payload.generation === "string" ? payload.generation : undefined);
  const stopReason = payload.outputs?.[0]?.stop_reason ?? payload.stop_reason;

  if (typeof text === "string" && text.length > 0) {
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
      delta: { type: "text_delta", text },
    };
    state.outputTokens += Math.ceil(text.length / 4);
  }

  if (stopReason !== undefined && stopReason !== null) {
    if (state.textBlockOpened) {
      yield { kind: "content_block_stop", index: TEXT_BLOCK_INDEX };
    }
    yield {
      kind: "message_delta",
      stopReason: mistralStopReasonToCanonical(stopReason),
      usage: { input: 0, output: state.outputTokens },
    };
    yield { kind: "message_stop" };
    state.closed = true;
  }
}

function mistralStopReasonToCanonical(reason: string): string {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    default:
      return reason;
  }
}
