/**
 * Translate Google Gemini streaming responses into canonical
 * `StreamEvent`s.
 *
 * Gemini's `generateContentStream` returns an `AsyncGenerator` of
 * `GenerateContentResponse` chunks. Each chunk has
 * `.candidates[0].content.parts[]` with `text` deltas or final
 * `functionCall` parts. Function calls always arrive complete (the
 * model emits the entire `args` object in a single part).
 *
 * Mapping:
 *   text part         → text delta on a text block (indices are
 *                       allocated in arrival order)
 *   functionCall part → tool_use block (next index) + single
 *                       input_json_delta carrying JSON-stringified args
 *   thought=true text → thinking block (thinking_delta per part)
 *   thoughtSignature  → signature_delta on the open thinking block —
 *                       Gemini attaches the opaque signature to a part
 *                       (often the functionCall part that follows the
 *                       thinking); newer models require it echoed back
 *                       on function-calling turns, so translate.ts
 *                       round-trips canonical `signature` as
 *                       `thoughtSignature`.
 *   finishReason      → message_delta + message_stop
 *   usageMetadata     → message_delta usage (cachedContentTokenCount
 *                       surfaces as canonical `cacheRead`)
 */

import type { StreamEvent } from "@crewhaus/adapter-anthropic";
import type { GenerateContentResponse } from "@google/genai";

type OpenBlock = { readonly kind: "text" | "thinking"; readonly index: number };

export async function* translateGeminiStream(
  iter: AsyncIterable<GenerateContentResponse>,
): AsyncIterable<StreamEvent> {
  let messageStarted = false;
  let nextBlockIndex = 0;
  let openBlock: OpenBlock | undefined;
  let stopReason: string | undefined;
  let sawFunctionCall = false;
  let usage: { input: number; output: number; cacheRead?: number } | undefined;

  /**
   * Ensure a block of `kind` is open, closing any other open block.
   * Returns the (possibly pre-existing) open block plus the stop/start
   * events to emit before writing deltas to it.
   */
  function ensureOpen(kind: OpenBlock["kind"]): { block: OpenBlock; events: StreamEvent[] } {
    if (openBlock?.kind === kind) return { block: openBlock, events: [] };
    const events: StreamEvent[] = [];
    if (openBlock !== undefined) {
      events.push({ kind: "content_block_stop", index: openBlock.index });
    }
    openBlock = { kind, index: nextBlockIndex++ };
    events.push({
      kind: "content_block_start",
      index: openBlock.index,
      block: kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" },
    });
    return { block: openBlock, events };
  }

  for await (const chunk of iter) {
    if (!messageStarted) {
      yield { kind: "message_start" };
      messageStarted = true;
    }

    const candidates = chunk.candidates ?? [];
    const candidate = candidates[0];
    const parts = candidate?.content?.parts ?? [];

    for (const part of parts) {
      const signature =
        typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0
          ? part.thoughtSignature
          : undefined;

      if (part.thought === true) {
        const thinkingText = typeof part.text === "string" ? part.text : "";
        if (thinkingText.length === 0 && signature === undefined) continue;
        const { block, events } = ensureOpen("thinking");
        yield* events;
        if (thinkingText.length > 0) {
          yield {
            kind: "content_block_delta",
            index: block.index,
            delta: { type: "thinking_delta", thinking: thinkingText },
          };
        }
        if (signature !== undefined) {
          yield {
            kind: "content_block_delta",
            index: block.index,
            delta: { type: "signature_delta", signature },
          };
        }
        continue;
      }

      if (signature !== undefined) {
        // Signature on a non-thought part (Gemini attaches it to the
        // part that follows the thinking — often the functionCall
        // part). Route it to the open thinking block, or mint an empty
        // one so the signature survives the round-trip.
        const { block, events } = ensureOpen("thinking");
        yield* events;
        yield {
          kind: "content_block_delta",
          index: block.index,
          delta: { type: "signature_delta", signature },
        };
      }

      if (typeof part.text === "string" && part.text.length > 0) {
        const { block, events } = ensureOpen("text");
        yield* events;
        yield {
          kind: "content_block_delta",
          index: block.index,
          delta: { type: "text_delta", text: part.text },
        };
      }

      if (part.functionCall !== undefined) {
        sawFunctionCall = true;
        // Close any open thinking/text block so block ordering is
        // preserved.
        if (openBlock !== undefined) {
          yield { kind: "content_block_stop", index: openBlock.index };
          openBlock = undefined;
        }
        const idx = nextBlockIndex++;
        // Gemini does not provide tool-call ids. Synthesise a stable
        // one from the function name + index so subsequent
        // tool_result messages can correlate.
        const fnName = part.functionCall.name ?? "";
        const id = `gemini_${fnName}_${idx}`;
        yield {
          kind: "content_block_start",
          index: idx,
          block: { type: "tool_use", id, name: fnName, input: {} },
        };
        yield {
          kind: "content_block_delta",
          index: idx,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(part.functionCall.args ?? {}),
          },
        };
        yield { kind: "content_block_stop", index: idx };
      }
    }

    if (candidate?.finishReason !== undefined && candidate.finishReason !== null) {
      stopReason = geminiFinishReasonToCanonical(String(candidate.finishReason));
    }

    if (chunk.usageMetadata !== undefined) {
      const cached = chunk.usageMetadata.cachedContentTokenCount;
      usage = {
        input: chunk.usageMetadata.promptTokenCount ?? 0,
        output: chunk.usageMetadata.candidatesTokenCount ?? 0,
        ...(cached !== undefined ? { cacheRead: cached } : {}),
      };
    }
  }

  // Close any open thinking/text block.
  if (openBlock !== undefined) {
    yield { kind: "content_block_stop", index: openBlock.index };
  }

  // Gemini doesn't expose a "tool_use" FinishReason — when the model
  // wants a tool call it emits STOP with a functionCall in the parts.
  // Promote the stop reason if we saw any function call this turn so
  // the runtime's tool-loop branch fires.
  if (sawFunctionCall) stopReason = "tool_use";

  yield {
    kind: "message_delta",
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
  yield { kind: "message_stop" };
}

function geminiFinishReasonToCanonical(reason: string): string {
  switch (reason) {
    case "STOP":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "stop_sequence";
    case "MALFORMED_FUNCTION_CALL":
    case "UNEXPECTED_TOOL_CALL":
      return "tool_use";
    default:
      return reason.toLowerCase();
  }
}
