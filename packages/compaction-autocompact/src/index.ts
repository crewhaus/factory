/**
 * Catalog R6 `compaction-autocompact` — calls the model to summarize
 * the conversation and replaces history with a two-message tuple
 * (a user-role marker followed by the assistant-role summary). The
 * marker frames the summary so the next user input appends naturally;
 * Anthropic's MessageParam has no `system` role, so the spec's
 * "systemMessage" is a user-role marker by interpretation.
 *
 * Section 17 refactor: this function used to take an Anthropic SDK
 * client directly. It now takes a `ProviderAdapter` so any provider's
 * adapter (Anthropic, OpenAI, Gemini, Bedrock) can drive compaction.
 * Internally we drain the adapter's `stream()` via `collectFinalMessage`
 * to get the same text-summary shape that `client.messages.create`
 * used to deliver.
 *
 * Reference: claude-code/services/compact/autoCompact.ts. We
 * deliberately drop the circuit breaker, session-memory promotion,
 * and cacheSafeParams plumbing — out of scope for the slice.
 */
import type Anthropic from "@anthropic-ai/sdk";
import {
  type ProviderAdapter,
  collectFinalMessage,
  extractFirstText,
} from "@crewhaus/adapter-anthropic";
import { classifyBoundary } from "@crewhaus/boundary-classifier";
import { RuntimeError } from "@crewhaus/errors";

const SUMMARY_REQUEST =
  "Summarize the prior conversation as compactly as possible. Keep all key facts, file paths, decisions, and tool results. Output the summary only — no preamble, no apologies.";

const SUMMARY_MARKER =
  "[Previous conversation summary follows — original history was compacted to stay under the context limit]";

const SUMMARY_MAX_TOKENS = 4096;

/**
 * Replace the full message history with `[marker, summary]`.
 *
 * `adapter` is any `ProviderAdapter`; the same canonical message shape
 * flows in and out so the JSONL transcript stays wire-compatible.
 */
export async function autoCompact(
  messages: ReadonlyArray<Anthropic.MessageParam>,
  adapter: ProviderAdapter,
  model: string,
): Promise<Anthropic.MessageParam[]> {
  const summarizationPrompt: Anthropic.MessageParam = {
    role: "user",
    content: SUMMARY_REQUEST,
  };

  const final = await collectFinalMessage(
    adapter.stream({
      model,
      system: [],
      messages: [...messages, summarizationPrompt] as Parameters<
        ProviderAdapter["stream"]
      >[0]["messages"],
      maxTokens: SUMMARY_MAX_TOKENS,
    }),
  );

  const summary = extractFirstText(final);
  if (summary === undefined) {
    throw new RuntimeError("autoCompact: model response contained no text block");
  }

  // Pillar 3 boundary site — if the pre-compaction history contained
  // attacker text from any earlier boundary (an MCP response, a
  // sub-agent return, an inbound channel message), the summarising
  // model may have absorbed it. Classify the summary at the compaction
  // boundary before it replaces the active history. On malicious, fall
  // back to the redaction notice so the model's next turn sees the
  // injection has been neutralised — losing the summary is preferable
  // to letting it carry the payload forward.
  const boundary = await classifyBoundary(summary, { origin: "compaction" });
  const safeSummary =
    boundary.action === "redact" && boundary.redacted !== undefined ? boundary.redacted : summary;

  return [
    { role: "user", content: SUMMARY_MARKER },
    { role: "assistant", content: safeSummary },
  ];
}
