/**
 * Translate an OpenAI Chat Completions SSE stream into canonical
 * `StreamEvent`s.
 *
 * OpenAI deltas batch deltas across a single `choices[0].delta` object:
 *   - `content` (string fragment) → text delta on a synthetic text block.
 *   - `tool_calls[i]` with `index`, `id?`, `function: { name?, arguments? }`
 *     → tool_use block with incremental `arguments` deltas.
 * Tool-call ids and names arrive only on the first chunk that mentions
 * them; arguments stream incrementally. We keep a per-index map so
 * canonical `content_block_start` fires exactly once per tool call,
 * with subsequent chunks producing `input_json_delta` events.
 *
 * `finish_reason` lands on the final chunk (synchronised with the
 * `finishReason → stopReason` map). When `stream_options.include_usage`
 * is set, OpenAI emits one final usage-only chunk with the running
 * totals — we fold those into a closing `message_delta`.
 */

import type { StreamEvent } from "@crewhaus/adapter-anthropic";
import type OpenAI from "openai";

type ChatChunk = OpenAI.Chat.Completions.ChatCompletionChunk;

const TEXT_BLOCK_INDEX = 0;
const TOOL_BLOCK_OFFSET = 1; // tool blocks indexed starting at 1

type ToolBlockState = {
  /** Canonical block index assigned to this tool call. */
  readonly canonicalIndex: number;
  /** OpenAI-supplied tool call id. */
  readonly id: string;
  /** Tool name, captured from the first chunk that includes it. */
  name: string;
};

/**
 * Translate an OpenAI chat-completions stream into canonical
 * `StreamEvent`s.
 */
export async function* translateOpenAIStream(
  iter: AsyncIterable<ChatChunk>,
): AsyncIterable<StreamEvent> {
  let textBlockOpened = false;
  let textBlockClosed = false;
  // Map: openai tool_call index → state
  const toolByIndex = new Map<number, ToolBlockState>();
  let nextCanonicalIdx = TOOL_BLOCK_OFFSET;
  let messageStarted = false;
  let stopReason: string | undefined;

  for await (const chunk of iter) {
    if (!messageStarted) {
      yield { kind: "message_start" };
      messageStarted = true;
    }

    const choice = chunk.choices[0];
    const delta = choice?.delta;
    const usage = chunk.usage;

    if (delta !== undefined) {
      // Text deltas
      const text = delta.content;
      if (text !== undefined && text !== null && text.length > 0) {
        if (!textBlockOpened) {
          yield {
            kind: "content_block_start",
            index: TEXT_BLOCK_INDEX,
            block: { type: "text", text: "" },
          };
          textBlockOpened = true;
        }
        yield {
          kind: "content_block_delta",
          index: TEXT_BLOCK_INDEX,
          delta: { type: "text_delta", text },
        };
      }

      // Tool-call deltas
      if (delta.tool_calls !== undefined) {
        for (const tc of delta.tool_calls) {
          const oaiIndex = tc.index;
          let state = toolByIndex.get(oaiIndex);
          if (state === undefined) {
            // First chunk for this tool call. The id MUST be present
            // here; the SDK guarantees it.
            const id = tc.id ?? `call_${oaiIndex}`;
            const name = tc.function?.name ?? "";
            state = {
              canonicalIndex: nextCanonicalIdx++,
              id,
              name,
            };
            toolByIndex.set(oaiIndex, state);
            // Close the text block (if any was opened) before
            // emitting the tool block so block-stop ordering is
            // preserved by index.
            if (textBlockOpened && !textBlockClosed) {
              yield { kind: "content_block_stop", index: TEXT_BLOCK_INDEX };
              textBlockClosed = true;
            }
            yield {
              kind: "content_block_start",
              index: state.canonicalIndex,
              block: { type: "tool_use", id: state.id, name: state.name, input: {} },
            };
          } else if (tc.function?.name !== undefined && tc.function.name.length > 0) {
            // Update name if it streamed in later chunks.
            state.name = tc.function.name;
          }

          const args = tc.function?.arguments;
          if (args !== undefined && args.length > 0) {
            yield {
              kind: "content_block_delta",
              index: state.canonicalIndex,
              delta: { type: "input_json_delta", partial_json: args },
            };
          }
        }
      }
    }

    if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
      stopReason = openaiStopReasonToCanonical(choice.finish_reason);
    }

    if (usage) {
      // Stop-reason chunk OR final usage chunk. Close any open blocks
      // and emit message_delta + message_stop. (Closing here is OK
      // because OpenAI never emits more deltas after usage.)
      if (textBlockOpened && !textBlockClosed) {
        yield { kind: "content_block_stop", index: TEXT_BLOCK_INDEX };
        textBlockClosed = true;
      }
      for (const state of toolByIndex.values()) {
        yield { kind: "content_block_stop", index: state.canonicalIndex };
      }
      yield {
        kind: "message_delta",
        ...(stopReason !== undefined ? { stopReason } : {}),
        usage: {
          input: usage.prompt_tokens ?? 0,
          output: usage.completion_tokens ?? 0,
        },
      };
      yield { kind: "message_stop" };
      return;
    }
  }

  // Stream ended without an explicit usage chunk (rare). Close blocks
  // and emit a synthetic terminator.
  if (textBlockOpened && !textBlockClosed) {
    yield { kind: "content_block_stop", index: TEXT_BLOCK_INDEX };
  }
  for (const state of toolByIndex.values()) {
    yield { kind: "content_block_stop", index: state.canonicalIndex };
  }
  yield {
    kind: "message_delta",
    ...(stopReason !== undefined ? { stopReason } : {}),
  };
  yield { kind: "message_stop" };
}

/**
 * Map OpenAI's `finish_reason` into the canonical stop reason vocabulary
 * (which mirrors Anthropic's). `tool_calls` → `tool_use`,
 * `length` → `max_tokens`, `stop` → `end_turn`, others pass through.
 */
function openaiStopReasonToCanonical(reason: string): string {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "stop_sequence";
    default:
      return reason;
  }
}
