/**
 * Translate an OpenAI Chat Completions SSE stream into canonical
 * `StreamEvent`s.
 *
 * OpenAI deltas batch deltas across a single `choices[0].delta` object:
 *   - `content` (string fragment) → text delta on a synthetic text block.
 *   - `tool_calls[i]` with `index`, `id?`, `function: { name?, arguments? }`
 *     → tool_use block with incremental `arguments` deltas.
 * Tool-call ids and names usually arrive on the first chunk that
 * mentions them; arguments stream incrementally. Identity is id-based
 * when ids are present and index-based otherwise: some compatible
 * servers (historical Ollama parallel calls) reuse index 0 for distinct
 * complete tool calls, so a new non-empty id at an already-open index
 * closes the open block and starts a fresh one. The canonical
 * `content_block_start` is deferred until a non-empty function name is
 * seen (early argument fragments are buffered and flushed right after
 * the deferred start) so downstream consumers never capture an empty
 * tool name.
 *
 * `finish_reason` lands on the final chunk (synchronised with the
 * `finishReason → stopReason` map). When `stream_options.include_usage`
 * is set, OpenAI emits one final usage-only chunk with the running
 * totals — we fold those into a closing `message_delta`. Some compat
 * servers (vLLM with `continuous_usage_stats`) attach running usage to
 * every chunk; a usage-bearing chunk is treated as terminal only when
 * its `choices` are empty/absent or a finish_reason has been seen —
 * otherwise we record the latest usage and keep translating.
 *
 * Non-standard extension: DeepSeek-R1-style `delta.reasoning_content`
 * (also emitted by vLLM `--reasoning-parser` and OpenRouter reasoning
 * routes) is surfaced best-effort as a canonical thinking block
 * (`content_block_start { type: "thinking" }` + `thinking_delta`),
 * closed when regular content begins. The field is absent from the
 * OpenAI SDK types, so it's read through a local structural cast.
 */

import type { StreamEvent } from "@crewhaus/adapter-anthropic";
import type OpenAI from "openai";

type ChatChunk = OpenAI.Chat.Completions.ChatCompletionChunk;

type ToolBlockState = {
  /** Canonical block index — assigned when the block_start is emitted. */
  canonicalIndex: number;
  /** OpenAI-supplied tool call id (or a `call_<index>` fallback). */
  id: string;
  /** True when the server actually supplied an id (vs. the fallback). */
  idProvided: boolean;
  /** Tool name, captured from the first chunk that includes it. */
  name: string;
  /** True once the canonical content_block_start has been emitted. */
  started: boolean;
  /** True once the canonical content_block_stop has been emitted. */
  closed: boolean;
  /** Argument fragments buffered while the block_start is deferred. */
  pendingArgs: string;
};

/**
 * Translate an OpenAI chat-completions stream into canonical
 * `StreamEvent`s.
 */
export async function* translateOpenAIStream(
  iter: AsyncIterable<ChatChunk>,
): AsyncIterable<StreamEvent> {
  let nextIndex = 0;
  let thinkingIndex = -1;
  let thinkingOpen = false;
  let textIndex = -1;
  let textOpened = false;
  let textClosed = false;
  // Map: openai tool_call index → currently-open state at that slot.
  const toolByIndex = new Map<number, ToolBlockState>();
  // Every tool state ever opened, in order, for end-of-stream cleanup.
  const toolStates: ToolBlockState[] = [];
  let messageStarted = false;
  let stopReason: string | undefined;
  let latestUsage: ChatChunk["usage"] | undefined;

  function* closeThinkingBlock(): Generator<StreamEvent> {
    if (thinkingOpen) {
      yield { kind: "content_block_stop", index: thinkingIndex };
      thinkingOpen = false;
    }
  }

  function* closeTextBlock(): Generator<StreamEvent> {
    if (textOpened && !textClosed) {
      yield { kind: "content_block_stop", index: textIndex };
      textClosed = true;
    }
  }

  function* startToolBlock(state: ToolBlockState): Generator<StreamEvent> {
    // Close any narration blocks before the tool block so block-stop
    // ordering is preserved by index.
    yield* closeThinkingBlock();
    yield* closeTextBlock();
    state.canonicalIndex = nextIndex++;
    yield {
      kind: "content_block_start",
      index: state.canonicalIndex,
      block: { type: "tool_use", id: state.id, name: state.name, input: {} },
    };
    state.started = true;
    if (state.pendingArgs.length > 0) {
      yield {
        kind: "content_block_delta",
        index: state.canonicalIndex,
        delta: { type: "input_json_delta", partial_json: state.pendingArgs },
      };
      state.pendingArgs = "";
    }
  }

  function* closeToolBlock(state: ToolBlockState): Generator<StreamEvent> {
    if (state.closed) return;
    // A name never arrived: start at the first (buffered) argument
    // delta with what's known so the block round-trips.
    if (!state.started) yield* startToolBlock(state);
    yield { kind: "content_block_stop", index: state.canonicalIndex };
    state.closed = true;
  }

  function* closeAllBlocks(): Generator<StreamEvent> {
    yield* closeThinkingBlock();
    yield* closeTextBlock();
    for (const state of toolStates) {
      yield* closeToolBlock(state);
    }
  }

  for await (const chunk of iter) {
    if (!messageStarted) {
      yield { kind: "message_start" };
      messageStarted = true;
    }

    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    const usage = chunk.usage;

    if (delta != null) {
      // Reasoning deltas (non-standard extension, see file header).
      const reasoning = (delta as { reasoning_content?: string | null }).reasoning_content;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        if (!thinkingOpen) {
          thinkingIndex = nextIndex++;
          yield {
            kind: "content_block_start",
            index: thinkingIndex,
            block: { type: "thinking", thinking: "" },
          };
          thinkingOpen = true;
        }
        yield {
          kind: "content_block_delta",
          index: thinkingIndex,
          delta: { type: "thinking_delta", thinking: reasoning },
        };
      }

      // Text deltas
      const text = delta.content;
      if (text !== undefined && text !== null && text.length > 0) {
        yield* closeThinkingBlock();
        if (!textOpened) {
          textIndex = nextIndex++;
          yield {
            kind: "content_block_start",
            index: textIndex,
            block: { type: "text", text: "" },
          };
          textOpened = true;
        }
        yield {
          kind: "content_block_delta",
          index: textIndex,
          delta: { type: "text_delta", text },
        };
      }

      // Tool-call deltas
      if (delta.tool_calls != null) {
        for (const tc of delta.tool_calls) {
          // Compat servers can omit `index` entirely (the SDK types it
          // as required) — fall back to slot 0.
          const oaiIndex = (tc as { index?: number | null }).index ?? 0;
          const tcId = tc.id;
          let state = toolByIndex.get(oaiIndex);

          if (state !== undefined && tcId != null && tcId.length > 0) {
            if (state.idProvided && tcId !== state.id) {
              // A new id at an already-open slot is a DISTINCT tool
              // call (index reuse) — close the open block first.
              yield* closeToolBlock(state);
              state = undefined;
            } else if (!state.idProvided && !state.started) {
              // The id arrived late for the same call — adopt it.
              state.id = tcId;
              state.idProvided = true;
            }
          }

          if (state === undefined) {
            const hasId = tcId != null && tcId.length > 0;
            state = {
              canonicalIndex: -1,
              id: hasId ? tcId : `call_${oaiIndex}`,
              idProvided: hasId,
              name: tc.function?.name ?? "",
              started: false,
              closed: false,
              pendingArgs: "",
            };
            toolByIndex.set(oaiIndex, state);
            toolStates.push(state);
            // Defer the canonical block_start until the name is known —
            // downstream consumers capture the name at block_start.
            if (state.name.length > 0) {
              yield* startToolBlock(state);
            }
          } else if (tc.function?.name !== undefined && tc.function.name.length > 0) {
            // Name streamed in on a later chunk.
            state.name = tc.function.name;
            if (!state.started) {
              yield* startToolBlock(state);
            }
          }

          const args = tc.function?.arguments;
          if (args !== undefined && args.length > 0) {
            if (state.started) {
              yield {
                kind: "content_block_delta",
                index: state.canonicalIndex,
                delta: { type: "input_json_delta", partial_json: args },
              };
            } else {
              state.pendingArgs += args;
            }
          }
        }
      }
    }

    if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
      stopReason = openaiStopReasonToCanonical(choice.finish_reason);
    }

    if (usage) {
      // Terminal only for the canonical final-usage shape: an
      // empty/absent `choices` array OR a finish_reason already seen.
      // vLLM's `continuous_usage_stats` attaches running usage to every
      // content chunk — record it and keep translating.
      const choicesEmpty = (chunk.choices?.length ?? 0) === 0;
      if (choicesEmpty || stopReason !== undefined) {
        yield* closeAllBlocks();
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
      latestUsage = usage;
    }
  }

  // Stream ended without a terminal usage chunk. Close blocks and emit
  // a synthetic terminator, folding in the latest running usage if a
  // continuous-usage server supplied one.
  yield* closeAllBlocks();
  yield {
    kind: "message_delta",
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(latestUsage != null
      ? {
          usage: {
            input: latestUsage.prompt_tokens ?? 0,
            output: latestUsage.completion_tokens ?? 0,
          },
        }
      : {}),
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
