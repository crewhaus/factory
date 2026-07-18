/**
 * Loop contract 0.4 (Batch C, G11) — Slack's interactive approval surface.
 *
 * When a channel run parks a pending tool approval, the Slack adapter renders
 * an interactive Block Kit message with Approve / Deny buttons in the run's
 * thread. Clicking a button POSTs Slack's interactivity webhook (a
 * `block_actions` payload) back to the daemon's `/<adapter>/actions` route;
 * that request is signed with the SAME `v0:${ts}:${body}` HMAC machinery as
 * an events webhook, so the existing `verify()` authenticates it unchanged.
 * The gateway then resolves the approval in the store and ACKs in-thread.
 *
 * This module is pure parse/build (no network, no `RunContext`): the adapter's
 * `postApproval` / `ackApproval` do the I/O, and the channel-generic store +
 * orchestration live in `@crewhaus/channel-adapter-base`.
 */

/** Block Kit `action_id`s for the two buttons — the interaction parser keys on
 *  these, so they are part of the wire contract. */
export const APPROVE_ACTION_ID = "crewhaus_approve";
export const DENY_ACTION_ID = "crewhaus_deny";
/** `block_id` prefix carrying the approval id (a redundant channel to the
 *  buttons' `value`, so the id survives even if Slack ever elides `value`). */
export const APPROVAL_BLOCK_ID_PREFIX = "crewhaus_approval:";

/** The content a parked approval renders — mirrors channel-adapter-base's
 *  `postApproval` argument (kept local so this package needs no cross-dep). */
export type ApprovalPromptContent = {
  readonly approvalId: string;
  readonly toolName: string;
  readonly inputPreview: string;
  readonly surface: string;
};

/** A built Slack message: `text` is the notification/accessibility fallback,
 *  `blocks` the interactive Block Kit payload. */
export type SlackApprovalMessage = {
  readonly text: string;
  readonly blocks: readonly unknown[];
};

/**
 * Build the Approve/Deny Block Kit message for a parked approval. Each button
 * carries the `approvalId` in its `value`, and the actions block's `block_id`
 * carries it too (`crewhaus_approval:<id>`), so the interaction parser can
 * recover the id from either.
 */
export function buildApprovalMessage(content: ApprovalPromptContent): SlackApprovalMessage {
  const text = `Approval needed: \`${content.toolName}\` wants to run (surface: ${content.surface})`;
  const blocks: unknown[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Approval needed* · surface \`${content.surface}\`\n\`${content.toolName}\` requested with:\n\`\`\`${truncateForBlock(content.inputPreview)}\`\`\``,
      },
    },
    {
      type: "actions",
      block_id: `${APPROVAL_BLOCK_ID_PREFIX}${content.approvalId}`,
      elements: [
        {
          type: "button",
          action_id: APPROVE_ACTION_ID,
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          value: content.approvalId,
        },
        {
          type: "button",
          action_id: DENY_ACTION_ID,
          text: { type: "plain_text", text: "Deny" },
          style: "danger",
          value: content.approvalId,
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `id \`${content.approvalId}\` · or run \`crewhaus approvals grant ${content.approvalId}\``,
        },
      ],
    },
  ];
  return { text, blocks };
}

/**
 * The one-line "decision recorded" message the ACK replaces the buttons with,
 * so a resolved approval can't be clicked twice and the thread shows who
 * decided. Returned as text + a single context block (buttons removed).
 */
export function buildApprovalAckMessage(args: {
  readonly decision: "grant" | "deny";
  readonly by: string;
  readonly toolName?: string;
}): SlackApprovalMessage {
  const verb = args.decision === "grant" ? "Approved" : "Denied";
  const icon = args.decision === "grant" ? "✅" : "🚫";
  const tool = args.toolName !== undefined ? ` \`${args.toolName}\`` : "";
  const text = `${icon} ${verb}${tool} by ${args.by}`;
  return {
    text,
    blocks: [{ type: "context", elements: [{ type: "mrkdwn", text }] }],
  };
}

/** A parsed Slack interactivity webhook. Only Approve/Deny `block_actions` are
 *  surfaced; every other interaction type is `skip`. */
export type ParsedInteraction =
  | {
      readonly kind: "approval_action";
      readonly approvalId: string;
      readonly decision: "grant" | "deny";
      /** The Slack user who clicked (deciding identity). */
      readonly userId: string;
      readonly channelId?: string;
      /** ts of the message the buttons live on (for `chat.update` ACK). */
      readonly messageTs?: string;
      readonly threadTs?: string;
      /** Slack's per-interaction `response_url` (30-min ACK channel). */
      readonly responseUrl?: string;
    }
  | { readonly kind: "skip" };

/**
 * Parse a Slack interactivity webhook body. Slack POSTs
 * `application/x-www-form-urlencoded` with a single `payload` field holding the
 * URL-encoded `block_actions` JSON. Returns the normalised Approve/Deny action,
 * or `{ kind: "skip" }` for any non-approval interaction / malformed body.
 */
export function parseSlackInteraction(body: string): ParsedInteraction {
  let raw: string | null;
  try {
    raw = new URLSearchParams(body).get("payload");
  } catch {
    return { kind: "skip" };
  }
  if (raw === null) return { kind: "skip" };

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { kind: "skip" };
  }
  if (typeof payload !== "object" || payload === null) return { kind: "skip" };
  const p = payload as Record<string, unknown>;
  if (p["type"] !== "block_actions") return { kind: "skip" };

  const actions = p["actions"];
  if (!Array.isArray(actions) || actions.length === 0) return { kind: "skip" };
  const action = actions[0] as Record<string, unknown> | undefined;
  if (action === undefined) return { kind: "skip" };

  const decision =
    action["action_id"] === APPROVE_ACTION_ID
      ? "grant"
      : action["action_id"] === DENY_ACTION_ID
        ? "deny"
        : undefined;
  if (decision === undefined) return { kind: "skip" };

  // Prefer the button's `value`; fall back to the actions block_id suffix.
  const approvalId =
    (typeof action["value"] === "string" && action["value"].length > 0
      ? action["value"]
      : undefined) ?? approvalIdFromBlockId(action["block_id"]);
  if (approvalId === undefined) return { kind: "skip" };

  const user = p["user"];
  const userId =
    typeof user === "object" &&
    user !== null &&
    typeof (user as Record<string, unknown>)["id"] === "string"
      ? ((user as Record<string, unknown>)["id"] as string)
      : undefined;
  if (userId === undefined) return { kind: "skip" };

  const channel = p["channel"];
  const channelId =
    typeof channel === "object" &&
    channel !== null &&
    typeof (channel as Record<string, unknown>)["id"] === "string"
      ? ((channel as Record<string, unknown>)["id"] as string)
      : undefined;

  const message = p["message"];
  const messageRec =
    typeof message === "object" && message !== null
      ? (message as Record<string, unknown>)
      : undefined;
  const messageTs =
    typeof messageRec?.["ts"] === "string" ? (messageRec["ts"] as string) : undefined;

  const container = p["container"];
  const containerRec =
    typeof container === "object" && container !== null
      ? (container as Record<string, unknown>)
      : undefined;
  const threadTs =
    (typeof messageRec?.["thread_ts"] === "string"
      ? (messageRec["thread_ts"] as string)
      : undefined) ??
    (typeof containerRec?.["thread_ts"] === "string"
      ? (containerRec["thread_ts"] as string)
      : undefined);

  const responseUrl =
    typeof p["response_url"] === "string" ? (p["response_url"] as string) : undefined;

  return {
    kind: "approval_action",
    approvalId,
    decision,
    userId,
    ...(channelId !== undefined ? { channelId } : {}),
    ...(messageTs !== undefined ? { messageTs } : {}),
    ...(threadTs !== undefined ? { threadTs } : {}),
    ...(responseUrl !== undefined ? { responseUrl } : {}),
  };
}

function approvalIdFromBlockId(blockId: unknown): string | undefined {
  if (typeof blockId !== "string") return undefined;
  if (!blockId.startsWith(APPROVAL_BLOCK_ID_PREFIX)) return undefined;
  const id = blockId.slice(APPROVAL_BLOCK_ID_PREFIX.length);
  return id.length > 0 ? id : undefined;
}

/** Slack's ```code``` fences break if the preview itself contains a triple
 *  backtick; strip them and cap the length so the block stays well-formed. */
function truncateForBlock(preview: string, max = 500): string {
  const safe = preview.replace(/```/g, "'''");
  return safe.length > max ? `${safe.slice(0, max)}…` : safe;
}
