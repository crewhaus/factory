/**
 * Anthropic-on-Bedrock family marshalling.
 *
 * Bedrock takes JSON bodies with shape almost identical to the
 * Anthropic Messages API — the only differences are:
 *   - `anthropic_version: "bedrock-2023-05-31"` instead of `model`
 *     (modelId comes through the InvokeModel command parameter).
 *   - The stream chunks are wrapped in EventStream `chunk.bytes`
 *     payloads but decode to standard Anthropic raw events.
 *
 * We reuse the canonical translation code by treating this family as
 * "Anthropic, with the model field stripped."
 */

import {
  EFFORT_THINKING_BUDGET_TOKENS,
  rawEventToCanonical,
  toAnthropicMessages,
  toAnthropicSystem,
} from "@crewhaus/adapter-anthropic";
import type {
  CanonicalTextBlockParam,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";

export const ANTHROPIC_BEDROCK_VERSION = "bedrock-2023-05-31";

type AnthropicTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

type AnthropicToolChoice = { type: "auto" } | { type: "any" } | { type: "tool"; name: string };

export type AnthropicBedrockBody = {
  readonly anthropic_version: string;
  readonly max_tokens: number;
  readonly system?: ReadonlyArray<CanonicalTextBlockParam>;
  readonly messages: ReadonlyArray<{ role: "user" | "assistant"; content: unknown }>;
  readonly tools?: ReadonlyArray<AnthropicTool>;
  readonly tool_choice?: AnthropicToolChoice;
  readonly thinking?: { type: "enabled"; budget_tokens: number };
};

export function buildAnthropicBedrockBody(req: ProviderRequest): AnthropicBedrockBody {
  // Mutable scratch object — we attach optional fields conditionally.
  const body: {
    anthropic_version: string;
    max_tokens: number;
    messages: ReturnType<typeof toAnthropicMessages>;
    system?: ReturnType<typeof toAnthropicSystem>;
    tools?: AnthropicTool[];
    tool_choice?: AnthropicToolChoice;
    thinking?: { type: "enabled"; budget_tokens: number };
  } = {
    anthropic_version: ANTHROPIC_BEDROCK_VERSION,
    max_tokens: req.maxTokens,
    messages: toAnthropicMessages(req.messages),
  };
  const sys = toAnthropicSystem(req.system);
  if (sys.length > 0) body.system = sys;
  if (req.tools !== undefined && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
  }
  if (req.toolChoice !== undefined) {
    body.tool_choice =
      req.toolChoice.type === "tool"
        ? { type: "tool", name: req.toolChoice.name }
        : { type: req.toolChoice.type };
  }
  if (req.thinking !== undefined) {
    body.thinking = { type: "enabled", budget_tokens: req.thinking.budgetTokens };
  } else if (req.reasoningEffort !== undefined) {
    // Loop contract 0.4 (Batch A) — the portable effort preset converts
    // to the Anthropic-family budget-token control via the shared preset
    // table. Only consulted when `thinking` is not explicitly set: an
    // explicit budget always wins over the preset.
    body.thinking = {
      type: "enabled",
      budget_tokens: EFFORT_THINKING_BUDGET_TOKENS[req.reasoningEffort],
    };
  }
  return body as AnthropicBedrockBody;
}

/**
 * Decode one Anthropic-on-Bedrock chunk payload (parsed JSON object)
 * into a canonical StreamEvent. Returns null for events we drop.
 *
 * Bedrock wraps every event in the same Anthropic raw shape we already
 * translate from in adapter-anthropic.
 */
export function decodeAnthropicBedrockChunk(payload: unknown): StreamEvent | null {
  return rawEventToCanonical(payload as Parameters<typeof rawEventToCanonical>[0]);
}
