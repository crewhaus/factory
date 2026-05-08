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
 *   text part         → text delta on a synthetic text block (index 0)
 *   functionCall part → tool_use block (next index) + single
 *                       input_json_delta carrying JSON-stringified args
 *   thought=true text → ignored from the canonical output for now
 *                       (surfaced via thinking blocks if/when we expose
 *                       Gemini's thinkingConfig in the runtime)
 *   finishReason      → message_delta + message_stop
 *   usageMetadata     → message_delta usage
 */

import type { StreamEvent } from "@crewhaus/adapter-anthropic";
import type { GenerateContentResponse } from "@google/genai";

const TEXT_BLOCK_INDEX = 0;
const TOOL_BLOCK_OFFSET = 1;

export async function* translateGeminiStream(
  iter: AsyncIterable<GenerateContentResponse>,
): AsyncIterable<StreamEvent> {
  let messageStarted = false;
  let textBlockOpened = false;
  let textBlockClosed = false;
  let nextToolIndex = TOOL_BLOCK_OFFSET;
  let stopReason: string | undefined;
  let sawFunctionCall = false;
  let usage: { input: number; output: number } | undefined;

  for await (const chunk of iter) {
    if (!messageStarted) {
      yield { kind: "message_start" };
      messageStarted = true;
    }

    const candidates = chunk.candidates ?? [];
    const candidate = candidates[0];
    const parts = candidate?.content?.parts ?? [];

    for (const part of parts) {
      if (part.thought === true) {
        continue;
      }
      if (typeof part.text === "string" && part.text.length > 0) {
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
          delta: { type: "text_delta", text: part.text },
        };
      }
      if (part.functionCall !== undefined) {
        sawFunctionCall = true;
        // Close the text block so block ordering is preserved.
        if (textBlockOpened && !textBlockClosed) {
          yield { kind: "content_block_stop", index: TEXT_BLOCK_INDEX };
          textBlockClosed = true;
        }
        const idx = nextToolIndex++;
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
      usage = {
        input: chunk.usageMetadata.promptTokenCount ?? 0,
        output: chunk.usageMetadata.candidatesTokenCount ?? 0,
      };
    }
  }

  // Close any open text block.
  if (textBlockOpened && !textBlockClosed) {
    yield { kind: "content_block_stop", index: TEXT_BLOCK_INDEX };
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
