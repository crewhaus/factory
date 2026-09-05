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
  claudeRejectsTemperature,
  rawEventToCanonical,
  toAnthropicMessages,
  toAnthropicSystem,
} from "@crewhaus/adapter-anthropic";
import type {
  CanonicalTextBlockParam,
  DroppedRequestParam,
  EffectiveParams,
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
  readonly temperature?: number;
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
    temperature?: number;
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
  // NEW-HUNT-2 — map the sampling temperature (the judge pin), EXCEPT when
  // extended thinking is (or will be) enabled: the Anthropic API rejects an
  // explicit temperature alongside `thinking` (mirrors
  // adapter-anthropic/translate.ts).
  // #413 — and EXCEPT for Claude models that reject the parameter outright
  // (Opus 4.7+ and the Claude 5 family) — Bedrock forwards the same 400.
  // `req.model` is the Bedrock id (`anthropic.…` / regional prefix); the
  // predicate matches by search, so the prefix doesn't defeat it.
  if (
    req.temperature !== undefined &&
    req.thinking === undefined &&
    req.reasoningEffort === undefined &&
    !claudeRejectsTemperature(req.model)
  ) {
    body.temperature = req.temperature;
  }
  return body as AnthropicBedrockBody;
}

/**
 * 0.6.0 §8.1 — project `buildAnthropicBedrockBody` onto the params a route
 * can differ on. Same drop rules as adapter-anthropic's projection (the body
 * is the Messages API body): `temperature` is dropped alongside extended
 * thinking or on a model that rejects the parameter (#413); an effort preset
 * lowered to `thinking.budget_tokens` is a note, not a drop. `model` is the
 * Bedrock modelId — the body carries `anthropic_version` instead.
 */
export function anthropicBedrockEffectiveParams(req: ProviderRequest): EffectiveParams {
  const body = buildAnthropicBedrockBody(req);
  const dropped: DroppedRequestParam[] = [];
  const notes: string[] = [];
  if (req.temperature !== undefined && body.temperature === undefined) {
    dropped.push("temperature");
    notes.push(
      req.thinking !== undefined || req.reasoningEffort !== undefined
        ? "temperature dropped: the Anthropic API rejects an explicit temperature alongside extended thinking"
        : `temperature dropped: model "${req.model}" rejects the temperature parameter (#413)`,
    );
  }
  if (req.thinking === undefined && req.reasoningEffort !== undefined && body.thinking) {
    notes.push(
      `reasoningEffort "${req.reasoningEffort}" lowered to thinking.budget_tokens=${body.thinking.budget_tokens}`,
    );
  }
  return {
    model: req.model,
    maxTokens: body.max_tokens,
    ...(body.thinking !== undefined
      ? { thinking: { type: "enabled" as const, budgetTokens: body.thinking.budget_tokens } }
      : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    dropped,
    ...(notes.length > 0 ? { notes } : {}),
  };
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
