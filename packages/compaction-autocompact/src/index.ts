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
import type { TraceEventBus } from "@crewhaus/trace-event-bus";

const SUMMARY_REQUEST =
  "Summarize the prior conversation as compactly as possible. Keep all key facts, file paths, decisions, and tool results. Output the summary only — no preamble, no apologies.";

const SUMMARY_MARKER =
  "[Previous conversation summary follows — original history was compacted to stay under the context limit]";

const SUMMARY_MAX_TOKENS = 4096;

export type AutoCompactOptions = {
  /**
   * v0.3.0 Goal 1 (§2.3) — verbatim requirements-ledger text (the user
   * messages already externalized as `context_evicted` events) appended to
   * the summarization prompt so the summary is ANCHORED against the stated
   * requirements. This is model discipline only: correctness never depends
   * on the summary honoring it — the ledger is re-injected into every model
   * call independently. Absent (every pre-0.3.0 caller) → the prompt is
   * byte-identical to before this option existed.
   */
  readonly ledgerText?: string;
  /**
   * 0.6.0 (design §6.2, §7.12) — the run bus. When supplied, the
   * summarisation call publishes a `model_request` before the stream opens
   * and a `model_response` (same span) when it finishes, both carrying
   * `role: "compaction"`, so `cost-tracker` prices the side-call and the
   * runtime's budget meter counts it toward `budget.usd` under
   * `budget.judge_share`. Compaction spend was invisible to every meter
   * before this option existed. Observational only: absent (every
   * pre-0.6.0 caller) → no publish, byte-identical behaviour.
   */
  readonly bus?: TraceEventBus;
  /**
   * 0.6.0 — the SPEC model string the compaction model was declared as
   * (`compaction.model` or the agent's own), stamped as `specModel` on the
   * published events when it differs from the wire `model`. Only read when
   * `bus` is supplied.
   */
  readonly specModel?: string;
};

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
  opts: AutoCompactOptions = {},
): Promise<Anthropic.MessageParam[]> {
  const request =
    opts.ledgerText !== undefined && opts.ledgerText.length > 0
      ? `${SUMMARY_REQUEST}\n\nThe following user requirements were stated earlier in this conversation and were preserved verbatim before compaction. Anchor the summary against them — restate any that are still relevant and never contradict or drop them:\n${opts.ledgerText}`
      : SUMMARY_REQUEST;
  const summarizationPrompt: Anthropic.MessageParam = {
    role: "user",
    content: request,
  };

  const providerRequest = {
    model,
    system: [],
    messages: [...messages, summarizationPrompt] as Parameters<
      ProviderAdapter["stream"]
    >[0]["messages"],
    maxTokens: SUMMARY_MAX_TOKENS,
  };
  // 0.6.0 — meter the side-call on the run bus (role "compaction") so the
  // summary's spend is priced and counted toward the budget; the shape
  // mirrors runtime-core's main-turn publish (wire model + specModel when
  // the two differ, provider, shared span across request/response).
  const bus = opts.bus;
  const startEnvelope = bus?.envelope();
  const specModelField: { readonly specModel?: string } =
    opts.specModel !== undefined && opts.specModel !== model ? { specModel: opts.specModel } : {};
  if (bus !== undefined && startEnvelope !== undefined) {
    bus.publish({
      ...startEnvelope,
      kind: "model_request",
      model,
      ...specModelField,
      provider: adapter.providerId,
      messageCount: providerRequest.messages.length,
      toolCount: 0,
      streaming: false,
      role: "compaction",
    });
  }
  const t0 = performance.now();
  const final = await collectFinalMessage(adapter.stream(providerRequest));
  if (bus !== undefined && startEnvelope !== undefined) {
    bus.publish({
      ...bus.envelope(),
      spanId: startEnvelope.spanId,
      kind: "model_response",
      model,
      ...specModelField,
      provider: adapter.providerId,
      stopReason: final.stopReason,
      usage: final.usage,
      durationMs: performance.now() - t0,
      role: "compaction",
    });
  }

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
