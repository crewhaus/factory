/**
 * Bidirectional translation between canonical (provider-agnostic) shapes
 * and the Anthropic SDK's native shapes.
 *
 * Direction A: ProviderRequest → MessageStreamParams (request marshalling).
 * Direction B: RawMessageStreamEvent → StreamEvent (response normalisation).
 *
 * The canonical shapes are isomorphic to Anthropic's so most of this is
 * structural pass-through plus key renaming (`content_block` → `block`).
 * Other adapters (`adapter-openai`, `adapter-gemini`, `adapter-bedrock`)
 * do the more invasive work in their own translate modules.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_CODE_SYSTEM_PREFIX } from "./client.js";
import {
  type CanonicalContentBlock,
  type CanonicalContentDelta,
  type CanonicalMessage,
  type CanonicalTextBlockParam,
  EFFORT_THINKING_BUDGET_TOKENS,
  type ProviderRequest,
  type StreamEvent,
} from "./types.js";

/**
 * Build Anthropic `MessageStreamParams` from a canonical `ProviderRequest`.
 *
 * `isOAuth` controls whether we prepend the Claude Code identity prefix
 * to the system block — required for subscription-billed traffic; the
 * API rejects OAuth requests without it.
 */
export function toAnthropicParams(
  req: ProviderRequest,
  isOAuth: boolean,
): Anthropic.MessageStreamParams {
  const systemBlocks: Anthropic.TextBlockParam[] = req.system.map((b) => ({
    type: "text" as const,
    text: b.text,
    ...(b.cache_control !== undefined ? { cache_control: b.cache_control } : {}),
  }));
  const finalSystem: Anthropic.TextBlockParam[] = isOAuth
    ? [{ type: "text", text: CLAUDE_CODE_SYSTEM_PREFIX }, ...systemBlocks]
    : systemBlocks;

  const params: Anthropic.MessageStreamParams = {
    model: req.model,
    max_tokens: req.maxTokens,
    system: finalSystem,
    messages: req.messages as Anthropic.MessageParam[],
  };

  if (req.tools !== undefined && req.tools.length > 0) {
    params.tools = req.tools.map(
      (t): Anthropic.Tool => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool.InputSchema,
      }),
    );
  }

  if (req.toolChoice !== undefined) {
    params.tool_choice = toolChoiceToAnthropic(req.toolChoice);
  }

  if (req.thinking !== undefined) {
    params.thinking = {
      type: "enabled",
      budget_tokens: req.thinking.budgetTokens,
    };
  } else if (req.reasoningEffort !== undefined) {
    // Loop contract 0.4 (Batch A) — the portable effort preset converts to
    // Anthropic's budget-token control via the shared preset table. Only
    // consulted when `thinking` is not explicitly set: an explicit budget
    // always wins over the preset.
    params.thinking = {
      type: "enabled",
      budget_tokens: EFFORT_THINKING_BUDGET_TOKENS[req.reasoningEffort],
    };
  }

  return params;
}

function toolChoiceToAnthropic(
  choice: NonNullable<ProviderRequest["toolChoice"]>,
): Anthropic.MessageCreateParams["tool_choice"] {
  switch (choice.type) {
    case "auto":
      return { type: "auto" };
    case "any":
      return { type: "any" };
    case "tool":
      return { type: "tool", name: choice.name };
  }
}

/**
 * Translate a single Anthropic `RawMessageStreamEvent` into the canonical
 * `StreamEvent` form. Returns `null` for events we deliberately drop
 * (currently nothing — every Anthropic event has a canonical mapping).
 */
export function rawEventToCanonical(ev: Anthropic.RawMessageStreamEvent): StreamEvent | null {
  switch (ev.type) {
    case "message_start": {
      const u = ev.message.usage;
      return {
        kind: "message_start",
        usage: {
          input: u.input_tokens,
          output: u.output_tokens,
          ...(u.cache_read_input_tokens !== null && u.cache_read_input_tokens !== undefined
            ? { cacheRead: u.cache_read_input_tokens }
            : {}),
          ...(u.cache_creation_input_tokens !== null && u.cache_creation_input_tokens !== undefined
            ? { cacheCreate: u.cache_creation_input_tokens }
            : {}),
        },
      };
    }
    case "content_block_start": {
      const block = canonicalBlockFromRaw(ev.content_block);
      if (block === null) return null;
      return { kind: "content_block_start", index: ev.index, block };
    }
    case "content_block_delta": {
      const delta = canonicalDeltaFromRaw(ev.delta);
      if (delta === null) return null;
      return { kind: "content_block_delta", index: ev.index, delta };
    }
    case "content_block_stop":
      return { kind: "content_block_stop", index: ev.index };
    case "message_delta": {
      // message_delta usage carries only output_tokens (Anthropic
      // streams the running output count here; the input + cache
      // counts come down in message_start). Surface output as the
      // running tally; leave input at 0 and let consumers reconcile
      // with message_start's seed usage.
      const u = ev.usage;
      return {
        kind: "message_delta",
        ...(ev.delta.stop_reason ? { stopReason: ev.delta.stop_reason } : {}),
        ...(u ? { usage: { input: 0, output: u.output_tokens ?? 0 } } : {}),
      };
    }
    case "message_stop":
      return { kind: "message_stop" };
    default:
      return null;
  }
}

function canonicalBlockFromRaw(
  block: Anthropic.RawContentBlockStartEvent["content_block"],
): CanonicalContentBlock | null {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "thinking":
      return {
        type: "thinking",
        thinking: block.thinking,
        ...(block.signature ? { signature: block.signature } : {}),
      };
    default:
      return null;
  }
}

function canonicalDeltaFromRaw(
  delta: Anthropic.RawContentBlockDeltaEvent["delta"],
): CanonicalContentDelta | null {
  switch (delta.type) {
    case "text_delta":
      return { type: "text_delta", text: delta.text };
    case "input_json_delta":
      return { type: "input_json_delta", partial_json: delta.partial_json };
    case "thinking_delta":
      return { type: "thinking_delta", thinking: delta.thinking };
    case "signature_delta":
      return { type: "signature_delta", signature: delta.signature };
    default:
      return null;
  }
}

/**
 * Convert a canonical `CanonicalMessage` array into Anthropic's
 * `MessageParam` array. Currently a structural pass-through (the shapes
 * are identical) but kept as an explicit boundary so a future divergence
 * doesn't leak provider details.
 */
export function toAnthropicMessages(
  messages: ReadonlyArray<CanonicalMessage>,
): Anthropic.MessageParam[] {
  return messages as Anthropic.MessageParam[];
}

export function toAnthropicSystem(
  system: ReadonlyArray<CanonicalTextBlockParam>,
): Anthropic.TextBlockParam[] {
  return system.map((b) => ({
    type: "text" as const,
    text: b.text,
    ...(b.cache_control !== undefined ? { cache_control: b.cache_control } : {}),
  }));
}
