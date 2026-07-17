/**
 * Pillar 3 boundary site — the channel ingress chokepoint.
 *
 * Inbound channel messages (Slack / Discord / Telegram / WhatsApp /
 * iMessage) are externally-controlled content: anyone who can message
 * the bot can plant a prompt injection. Gateway-level signature
 * verification (`adapter.verify`) authenticates *who* sent the webhook;
 * it says nothing about *what* the text contains. This module runs the
 * second half — classification of the text *before* it reaches a model
 * call — at `TrustOrigin: "channel"`, the strict-block default already
 * defined in `@crewhaus/boundary-classifier`'s per-origin policy.
 *
 * The channel adapters themselves (`channel-adapter-slack`, etc.) are
 * pure parse objects: their synchronous `parseInbound` carries no
 * `RunContext`, so the classify call cannot live there. Instead the
 * generated channel-bot's `runTurn` — which constructs the per-run
 * `RunContext` and holds the inbound text — calls `classifyInbound`
 * before seeding the user message into the chat loop. That single seam
 * covers all five channels (including the iMessage poller, which funnels
 * through the same generated session-router → agent.runTurn path).
 *
 * Contract — identical to every other source-side boundary site
 * (`tool-mcp`, `sub-agent-spawner`, …):
 *   1. `classifyBoundary(text, { origin: "channel" })`.
 *   2. malicious verdict → return the redaction notice (block).
 *   3. pass / warn verdict → `tagContent(ctx, text, "channel")` so the
 *      sink-side egress classifier sees the channel origin on a later
 *      external-scope tool call, then return the text verbatim.
 *
 * No new policy: the strict channel default lives in the classifier.
 * This is the "bring a new boundary under the same chokepoint" contract.
 *
 * Catalog layer: R8 (channel boundary, extension of §18 safety floor).
 */
import {
  type BoundarySeverity,
  type TrustOrigin,
  classifyBoundary,
} from "@crewhaus/boundary-classifier";
import { type RunContext, tagContent } from "@crewhaus/run-context";

export type ClassifyInboundOptions = {
  /**
   * Trust origin for the inbound text. Constrained to `"channel"` — this
   * helper exists specifically for the channel boundary and must not be
   * repurposed for other origins (use `classifyBoundary` directly for
   * those). Defaults to `"channel"`.
   */
  readonly origin?: Extract<TrustOrigin, "channel">;
  /**
   * Override the channel origin's default severity (`"block"`). Production
   * callers should leave this unset to keep the strict per-origin policy.
   * Forwarded verbatim to `classifyBoundary`.
   */
  readonly severity?: BoundarySeverity;
};

/**
 * Classify inbound channel text at a trust boundary and return the text
 * that should reach the model.
 *
 * On a malicious verdict (block severity) the returned string is the
 * redaction notice — the raw attacker text never reaches the model. On a
 * pass/warn verdict the original text is returned verbatim AND tagged
 * into `ctx.dataLineage` under origin `"channel"` so the sink-side egress
 * classifier can detect channel-origin content leaving via an external
 * tool later in the run.
 *
 * Empty strings short-circuit to `""` (no classification work, no tag).
 */
export async function classifyInbound(
  text: string,
  ctx: RunContext,
  opts: ClassifyInboundOptions = {},
): Promise<string> {
  const origin: Extract<TrustOrigin, "channel"> = opts.origin ?? "channel";
  const boundary = await classifyBoundary(text, {
    origin,
    ...(opts.severity !== undefined ? { severity: opts.severity } : {}),
  });
  if (boundary.action === "redact" && boundary.redacted !== undefined) {
    // Malicious inbound — substitute the redaction notice. Do NOT tag
    // lineage: the original attacker text never enters the model context.
    return boundary.redacted;
  }
  // pass / warn — content reaches the model verbatim; record its origin
  // so the egress fabric sees it on a later external-scope tool call.
  tagContent(ctx, text, origin);
  return text;
}

// Convenience re-exports so channel call sites depend on one package.
export { classifyBoundary, type TrustOrigin, type BoundarySeverity };
export { tagContent, type RunContext };

// Loop contract 0.4 (Batch C, G11) — the channel-generic pending-approval
// surface (store contract + in-memory default + park/resolve orchestration).
export {
  type ApprovalDecision,
  type ApprovalStatus,
  type NewPendingApproval,
  type PendingApproval,
  type ApprovalListFilter,
  type ApprovalStore,
  type ApprovalAuditSink,
  type ApprovalTraceEvent,
  type ApprovalTracePublish,
  type InMemoryApprovalStoreOptions,
  InMemoryApprovalStore,
  previewApprovalInput,
  approvalFallbackText,
  postApprovalPrompt,
  createApprovalPrompter,
  resolveApproval,
} from "./approvals.js";
