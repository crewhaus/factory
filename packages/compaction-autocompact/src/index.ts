/**
 * Catalog R6 `compaction-autocompact` — calls the model to summarize
 * the conversation and replaces history with a three-message tuple: a
 * user-role marker, the assistant-role summary, and a user turn to end on.
 * Anthropic's MessageParam has no `system` role, so the spec's
 * "systemMessage" is a user-role marker by interpretation.
 *
 * The history must END on a user turn. Every current Claude model rejects
 * a trailing assistant message as prefill (`400 "This model does not
 * support assistant message prefill"`), and the runtime compacts AFTER the
 * new inbound message is appended — so returning `[marker, summary]` sent a
 * prefill on every compacted turn. The final turn is therefore the pending
 * user message itself, kept verbatim so the model answers the user's real
 * words rather than a paraphrase, or a continuation notice when there is no
 * pending message that can be kept (see {@link planCompaction}).
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
import { buildRequestParams } from "@crewhaus/model-plan";
import type { ModelThinking } from "@crewhaus/model-plan";
import { estimateTokens } from "@crewhaus/token-budget";
import type { TraceEventBus } from "@crewhaus/trace-event-bus";

const SUMMARY_REQUEST =
  "Summarize the prior conversation as compactly as possible. Keep all key facts, file paths, decisions, and tool results. Output the summary only — no preamble, no apologies.";

/** The user-role turn that opens a compacted history, framing the summary. */
export const SUMMARY_MARKER =
  "[Previous conversation summary follows — original history was compacted to stay under the context limit]";

/**
 * The user-role turn a compacted history ends on when no pending user
 * message can be kept verbatim: the tail was a tool result mid-loop, the
 * pending message was too large to keep, or it was the only message.
 */
export const COMPACTION_CONTINUE =
  "[The conversation above was compacted into a summary. Continue from it, picking up the most recent request where it left off.]";

/**
 * Default ceiling on the pending user message kept verbatim, in estimated
 * tokens. Callers that know their context limit pass a limit-relative
 * bound instead (runtime-core uses a quarter of it); this default only
 * serves callers that pass nothing.
 */
export const DEFAULT_KEEP_PENDING_MAX_TOKENS = 16_000;

const SUMMARY_MAX_TOKENS = 4096;

/**
 * How a history splits for compaction: the messages the summary replaces,
 * and the pending user message kept verbatim after it (or `undefined`).
 */
export type CompactionPlan = {
  /** Replaced by the summary — exactly what a caller must externalize before the drop. */
  readonly toSummarize: ReadonlyArray<Anthropic.MessageParam>;
  /** The trailing user message kept verbatim, by object identity; `undefined` when none qualifies. */
  readonly kept: Anthropic.MessageParam | undefined;
};

export type CompactionPlanOptions = {
  /** Keep the pending message only when its estimated size is at most this. Default {@link DEFAULT_KEEP_PENDING_MAX_TOKENS}. */
  readonly keepPendingMaxTokens?: number;
};

function carriesToolResult(message: Anthropic.MessageParam): boolean {
  return (
    typeof message.content !== "string" &&
    message.content.some((block) => block.type === "tool_result")
  );
}

/**
 * Decide which trailing user message, if any, survives compaction verbatim.
 *
 * Pure and deterministic, so a caller can call it BEFORE {@link autoCompact}
 * to learn what is about to be dropped (runtime-core externalizes exactly
 * `toSummarize` to its requirements ledger) and get the same answer
 * `autoCompact` computes internally, given the same `keepPendingMaxTokens`.
 *
 * The last message is kept only when all of these hold:
 *  - it is `role: "user"` — the new inbound message the turn exists to answer;
 *  - it carries no `tool_result` block — a result kept without the
 *    `tool_use` that produced it (summarized away) is itself a 400;
 *  - something precedes it — summarizing nothing frees nothing;
 *  - it fits `keepPendingMaxTokens` — keeping an oversized message verbatim
 *    would defeat the compaction it is part of.
 */
export function planCompaction(
  messages: ReadonlyArray<Anthropic.MessageParam>,
  opts: CompactionPlanOptions = {},
): CompactionPlan {
  const last = messages[messages.length - 1];
  const maxTokens = opts.keepPendingMaxTokens ?? DEFAULT_KEEP_PENDING_MAX_TOKENS;
  if (
    last !== undefined &&
    messages.length > 1 &&
    last.role === "user" &&
    !carriesToolResult(last) &&
    estimateTokens([last]) <= maxTokens
  ) {
    return { toSummarize: messages.slice(0, -1), kept: last };
  }
  return { toSummarize: messages, kept: undefined };
}

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
  /**
   * 0.6.0 §4.2 — the request params a `models:` profile pins on the
   * COMPACTION slot (`compaction.model: $summariser`), lowered by the
   * compiler as `IrCompaction.params` and threaded here verbatim. The
   * summariser's own {@link SUMMARY_MAX_TOKENS} ceiling is the base; the
   * profile overrides `max_tokens` / `thinking` / `temperature`
   * field-by-field through the one shared `buildRequestParams` every serving
   * slot uses, so `thinking: { effort: low }` means the same thing on a
   * compaction model as on the agent's. Absent → byte-identical to a
   * pre-0.6.0 call.
   */
  readonly params?: {
    readonly thinking?: ModelThinking;
    readonly maxTokens?: number;
    readonly temperature?: number;
  };
  /**
   * Size ceiling for keeping the pending user message verbatim — see
   * {@link planCompaction}. A caller that externalizes the dropped history
   * first must pass the same value to both.
   */
  readonly keepPendingMaxTokens?: number;
};

/**
 * Replace the full message history with `[marker, summary, final]`, where
 * `final` is the pending user message kept verbatim (same object) or a
 * {@link COMPACTION_CONTINUE} turn. The result always ends on a user turn.
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
  const plan = planCompaction(
    messages,
    opts.keepPendingMaxTokens !== undefined
      ? { keepPendingMaxTokens: opts.keepPendingMaxTokens }
      : {},
  );
  const request =
    opts.ledgerText !== undefined && opts.ledgerText.length > 0
      ? `${SUMMARY_REQUEST}\n\nThe following user requirements were stated earlier in this conversation and were preserved verbatim before compaction. Anchor the summary against them — restate any that are still relevant and never contradict or drop them:\n${opts.ledgerText}`
      : SUMMARY_REQUEST;
  const summarizationPrompt: Anthropic.MessageParam = {
    role: "user",
    content: request,
  };

  // 0.6.0 §4.2 — the compaction profile's pinned params, folded over the
  // summariser's own ceiling. `effectiveMaxTokens` is the request ceiling so
  // a declared thinking budget can never crowd the summary out.
  const resolvedParams = buildRequestParams(opts.params ?? {}, { maxTokens: SUMMARY_MAX_TOKENS });
  const providerRequest = {
    model,
    system: [],
    // Only the history being replaced — a kept pending message is not
    // summarized, so the model never sees it twice.
    messages: [...plan.toSummarize, summarizationPrompt] as Parameters<
      ProviderAdapter["stream"]
    >[0]["messages"],
    maxTokens: resolvedParams.effectiveMaxTokens,
    ...(resolvedParams.thinking !== undefined ? { thinking: resolvedParams.thinking } : {}),
    ...(resolvedParams.reasoningEffort !== undefined
      ? { reasoningEffort: resolvedParams.reasoningEffort }
      : {}),
    ...(resolvedParams.temperature !== undefined
      ? { temperature: resolvedParams.temperature }
      : {}),
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
    plan.kept ?? { role: "user", content: COMPACTION_CONTINUE },
  ];
}
