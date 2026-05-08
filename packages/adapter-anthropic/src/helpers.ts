/**
 * Stream-consumption helpers shared by every consumer (runtime-core,
 * compaction-autocompact, eval-judge). The same accumulator drives:
 *
 * - **Non-streaming use** (`collectFinalMessage`) — replaces the old
 *   `client.messages.create()` calls. Walks the entire stream and
 *   returns the final accumulated message.
 *
 * - **Streaming use** (`consumeStream` with callbacks) — runtime-core's
 *   `runOneTurn` uses this to render text deltas to stdout AND
 *   reconstruct the final message in a single pass.
 *
 * Both build the same `ProviderMessage` from `StreamEvent`s. Reusing one
 * accumulator avoids drift between the two paths.
 */

import { AdapterError } from "@crewhaus/errors";
import type { CanonicalContentBlock, ProviderMessage, StreamEvent, TokenUsage } from "./types.js";

export type ConsumeStreamCallbacks = {
  /** Called for each text delta. Use for stdout streaming or token telemetry. */
  readonly onTextDelta?: (chunk: string, blockIndex: number) => void;
  /**
   * Called when a tool_use block fully completes (i.e. on
   * `content_block_stop` for that block). The `block` contains the
   * parsed `input` object, ready for permission check + execute.
   */
  readonly onToolUseComplete?: (
    block: Extract<CanonicalContentBlock, { type: "tool_use" }>,
  ) => void;
  /** Called once at message_start with the initial usage shape. */
  readonly onStart?: (usage: TokenUsage | undefined) => void;
};

type AccumulatedBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; jsonBuffer: string }
  | { type: "thinking"; thinking: string; signature?: string };

/**
 * Walk an `AsyncIterable<StreamEvent>` and build the final message in
 * one pass. Optionally emit per-event callbacks (text streaming, tool
 * dispatch hooks). Returns the final `ProviderMessage`.
 *
 * This is the canonical "accumulate the stream" routine. Both
 * `collectFinalMessage` (no callbacks, used by autocompact + judge) and
 * runtime-core's stream consumer go through it.
 */
export async function consumeStream(
  stream: AsyncIterable<StreamEvent>,
  callbacks: ConsumeStreamCallbacks = {},
): Promise<ProviderMessage> {
  const blocks = new Map<number, AccumulatedBlock>();
  let stopReason = "end_turn";
  let usage: TokenUsage = { input: 0, output: 0 };
  let started = false;

  for await (const ev of stream) {
    switch (ev.kind) {
      case "message_start":
        if (ev.usage) usage = ev.usage;
        if (!started && callbacks.onStart) {
          callbacks.onStart(ev.usage);
          started = true;
        }
        break;
      case "content_block_start":
        switch (ev.block.type) {
          case "text":
            blocks.set(ev.index, { type: "text", text: ev.block.text });
            break;
          case "tool_use":
            blocks.set(ev.index, {
              type: "tool_use",
              id: ev.block.id,
              name: ev.block.name,
              jsonBuffer: "",
            });
            break;
          case "thinking":
            blocks.set(ev.index, {
              type: "thinking",
              thinking: ev.block.thinking,
              ...(ev.block.signature !== undefined ? { signature: ev.block.signature } : {}),
            });
            break;
        }
        break;
      case "content_block_delta": {
        const block = blocks.get(ev.index);
        if (block === undefined) break;
        switch (ev.delta.type) {
          case "text_delta":
            if (block.type === "text") {
              block.text += ev.delta.text;
              callbacks.onTextDelta?.(ev.delta.text, ev.index);
            }
            break;
          case "input_json_delta":
            if (block.type === "tool_use") {
              block.jsonBuffer += ev.delta.partial_json;
            }
            break;
          case "thinking_delta":
            if (block.type === "thinking") {
              block.thinking += ev.delta.thinking;
            }
            break;
          case "signature_delta":
            if (block.type === "thinking") {
              block.signature = ev.delta.signature;
            }
            break;
        }
        break;
      }
      case "content_block_stop": {
        const block = blocks.get(ev.index);
        if (block === undefined) break;
        if (block.type === "tool_use") {
          // Parse accumulated JSON args. Empty string means no args.
          let input: unknown = {};
          if (block.jsonBuffer.length > 0) {
            try {
              input = JSON.parse(block.jsonBuffer);
            } catch {
              // Malformed partial JSON — bubble up but do not crash the
              // stream consumer; the model can self-correct on retry.
              input = { __parse_error: true, raw: block.jsonBuffer };
            }
          }
          // Replace the buffered block with the parsed form so the
          // final-content array carries `input` instead of `jsonBuffer`.
          blocks.set(ev.index, {
            type: "tool_use",
            id: block.id,
            name: block.name,
            jsonBuffer: JSON.stringify(input),
          });
          if (callbacks.onToolUseComplete) {
            callbacks.onToolUseComplete({
              type: "tool_use",
              id: block.id,
              name: block.name,
              input,
            });
          }
        }
        break;
      }
      case "message_delta":
        if (ev.stopReason !== undefined) stopReason = ev.stopReason;
        if (ev.usage !== undefined) {
          // message_delta carries running output_tokens; input + cache
          // counts come from message_start. Update only what changed.
          usage = {
            input: ev.usage.input > 0 ? ev.usage.input : usage.input,
            output: ev.usage.output > 0 ? ev.usage.output : usage.output,
            ...(ev.usage.cacheRead !== undefined
              ? { cacheRead: ev.usage.cacheRead }
              : usage.cacheRead !== undefined
                ? { cacheRead: usage.cacheRead }
                : {}),
            ...(ev.usage.cacheCreate !== undefined
              ? { cacheCreate: ev.usage.cacheCreate }
              : usage.cacheCreate !== undefined
                ? { cacheCreate: usage.cacheCreate }
                : {}),
          };
        }
        break;
      case "message_stop":
        // Loop terminates naturally; nothing to do here.
        break;
      case "error":
        throw new AdapterError("anthropic", `stream error: ${ev.error.message}`);
    }
  }

  // Flatten accumulated blocks into the final canonical content array,
  // preserving original index order.
  const sortedIndices = [...blocks.keys()].sort((a, b) => a - b);
  const content: CanonicalContentBlock[] = [];
  for (const idx of sortedIndices) {
    const b = blocks.get(idx);
    if (b === undefined) continue;
    if (b.type === "text") {
      content.push({ type: "text", text: b.text });
    } else if (b.type === "tool_use") {
      // jsonBuffer was rewritten to the parsed form on content_block_stop.
      let input: unknown = {};
      try {
        input = JSON.parse(b.jsonBuffer);
      } catch {
        input = { __parse_error: true, raw: b.jsonBuffer };
      }
      content.push({ type: "tool_use", id: b.id, name: b.name, input });
    } else {
      content.push({
        type: "thinking",
        thinking: b.thinking,
        ...(b.signature !== undefined ? { signature: b.signature } : {}),
      });
    }
  }

  return { content, stopReason, usage };
}

/**
 * Convenience: drain a stream into a final message. Equivalent to
 * `consumeStream(stream)` with no callbacks. Used by
 * `compaction-autocompact` and `eval-judge` where the only thing that
 * matters is the terminal text + tool_use content.
 */
export async function collectFinalMessage(
  stream: AsyncIterable<StreamEvent>,
): Promise<ProviderMessage> {
  return consumeStream(stream);
}

/**
 * Pull the first text block out of a `ProviderMessage`. Returns
 * `undefined` if no text block exists. Used by autocompact.
 */
export function extractFirstText(msg: ProviderMessage): string | undefined {
  for (const block of msg.content) {
    if (block.type === "text") return block.text;
  }
  return undefined;
}

/**
 * Pull the first tool_use block matching `name`. Used by eval-judge to
 * find the `submit_score` tool call.
 */
export function extractToolUse(
  msg: ProviderMessage,
  name: string,
): Extract<CanonicalContentBlock, { type: "tool_use" }> | undefined {
  for (const block of msg.content) {
    if (block.type === "tool_use" && block.name === name) return block;
  }
  return undefined;
}
