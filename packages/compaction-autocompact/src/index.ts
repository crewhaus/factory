/**
 * Catalog R6 `compaction-autocompact` — calls the model to summarize
 * the conversation and replaces history with a two-message tuple
 * (a user-role marker followed by the assistant-role summary). The
 * marker frames the summary so the next user input appends naturally;
 * Anthropic's MessageParam has no `system` role, so the spec's
 * "systemMessage" is a user-role marker by interpretation.
 *
 * Reference: claude-code/services/compact/autoCompact.ts. We
 * deliberately drop the circuit breaker, session-memory promotion,
 * and cacheSafeParams plumbing — out of scope for the slice.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { RuntimeError } from "@crewhaus/errors";

const SUMMARY_REQUEST =
  "Summarize the prior conversation as compactly as possible. Keep all key facts, file paths, decisions, and tool results. Output the summary only — no preamble, no apologies.";

const SUMMARY_MARKER =
  "[Previous conversation summary follows — original history was compacted to stay under the context limit]";

const SUMMARY_MAX_TOKENS = 4096;

/**
 * Replace the full message history with `[marker, summary]`. The
 * summarization request is appended to a copy of `messages` and sent
 * to the model; the first text block of the response becomes the
 * summary. Throws `RuntimeError` if the response has no text content.
 */
export async function autoCompact(
  messages: ReadonlyArray<Anthropic.MessageParam>,
  client: Anthropic,
  model: string,
): Promise<Anthropic.MessageParam[]> {
  const summarizationPrompt: Anthropic.MessageParam = {
    role: "user",
    content: SUMMARY_REQUEST,
  };

  const response = await client.messages.create({
    model,
    max_tokens: SUMMARY_MAX_TOKENS,
    messages: [...messages, summarizationPrompt],
  });

  const summary = extractFirstText(response);
  if (summary === undefined) {
    throw new RuntimeError("autoCompact: model response contained no text block");
  }

  return [
    { role: "user", content: SUMMARY_MARKER },
    { role: "assistant", content: summary },
  ];
}

function extractFirstText(response: Anthropic.Message): string | undefined {
  for (const block of response.content) {
    if (block.type === "text") return block.text;
  }
  return undefined;
}
