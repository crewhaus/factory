/**
 * @crewhaus/channel-adapter-telegram — Telegram channel adapter for the
 * channel target (Section 33).
 *
 * Implements the same `ChannelAdapter` contract used by
 * @crewhaus/channel-adapter-slack — verify(), parseInbound(), sendReply(),
 * setTyping(). The Section 12 daemon registers this adapter alongside
 * Slack and any other channel adapter, with the gateway dispatching
 * inbound webhooks to whichever adapter id matches.
 *
 * Verification: `X-Telegram-Bot-Api-Secret-Token` header (set via
 * `setWebhook(secret_token=...)`) compared timing-safely to the configured
 * secret. Telegram does NOT sign the body — the secret token alone
 * authenticates.
 *
 * Parse: handles `message`, `edited_message`, and `callback_query`
 * (button-press) Update payloads. Group-chat session keying uses
 * `<chatId>:<topicId>` when topics are enabled (chat type "supergroup"
 * with `message_thread_id` present); otherwise just `<chatId>`.
 *
 * sendReply: POST to `https://api.telegram.org/bot<token>/sendMessage`.
 * setTyping: POST `sendChatAction` with `action=typing`.
 * react: POST `setMessageReaction` (Bot API 7.0) — best-effort status emoji.
 */
import { CrewhausError } from "@crewhaus/errors";
import { verifyTelegramSecret } from "./verify.js";

export { verifyTelegramSecret } from "./verify.js";

export class TelegramAdapterError extends CrewhausError {
  override readonly name = "TelegramAdapterError";
  constructor(message: string, cause?: unknown) {
    super("channel", message, cause);
  }
}

export type RawRequest = {
  readonly headers: Headers;
  readonly body: string;
};

/**
 * Channel-generic inbound event. Same shape as the Slack adapter's
 * `InboundEvent` so the gateway and session-router stay channel-agnostic.
 *
 * Mappings:
 *   - workspaceId   → chat.id (Telegram has no "workspace"; we reuse the
 *                     field for chat-level grouping)
 *   - channelId     → chat.id : topicId (group-chat thread scope) or
 *                     chat.id alone for private/group chats
 *   - userId        → from.id (numeric, stringified)
 *   - threadTs      → message_thread_id when present
 *   - ts            → message_id (stringified) — monotonic per chat
 *   - text          → message.text or callback_query.data
 *   - subtype       → "message" | "app_mention"
 *   - idempotencyKey → update_id (stringified)
 */
export type InboundEvent = {
  readonly idempotencyKey: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly userId: string;
  readonly threadTs?: string;
  readonly ts: string;
  readonly text: string;
  readonly subtype: "app_mention" | "message";
};

export type ParsedInbound =
  | { readonly kind: "event"; readonly event: InboundEvent }
  | { readonly kind: "skip" };

export interface ChannelAdapter {
  readonly id: string;
  verify(req: RawRequest): boolean;
  parseInbound(req: RawRequest): ParsedInbound;
  sendReply(args: { event: InboundEvent; text: string }): Promise<void>;
  setTyping(args: { event: InboundEvent }): Promise<void>;
  /**
   * Phase 3 §3.2 — add an emoji reaction to an inbound message as a
   * lightweight status acknowledgement (eyes/white_check_mark/warning).
   * Telegram restricts reactions to a fixed emoji set, so the channel-generic
   * status names are mapped to the nearest allowed reaction. Optional — the
   * session-router skips the hook when an adapter leaves it undefined.
   */
  react?(args: { event: InboundEvent; emoji: string }): Promise<void>;
}

export type TelegramAdapterConfig = {
  readonly botToken: string;
  readonly secretToken: string;
};

export type TelegramAdapterOptions = {
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly selfBotId?: string;
};

const DEFAULT_API_BASE_URL = "https://api.telegram.org";

// Telegram's `setMessageReaction` only accepts emoji from a fixed allowed set
// (✅ and ⚠️ are NOT in it), so map the channel-generic status names to the
// nearest allowed reaction. An unrecognised name is passed through verbatim.
const TELEGRAM_REACTION_EMOJI: Record<string, string> = {
  eyes: "👀",
  white_check_mark: "👍",
  warning: "😱",
};

export function createTelegramAdapter(
  config: TelegramAdapterConfig,
  opts: TelegramAdapterOptions = {},
): ChannelAdapter {
  const apiBaseUrl =
    opts.apiBaseUrl ?? process.env["TELEGRAM_API_BASE_URL"] ?? DEFAULT_API_BASE_URL;
  const doFetch = opts.fetch ?? fetch;
  const botEndpoint = (method: string) => `${apiBaseUrl}/bot${config.botToken}/${method}`;

  function inboundFromMessage(
    update: TelegramUpdate,
    msg: TelegramMessage,
    subtype: "message" | "app_mention",
  ): ParsedInbound {
    const chatId = msg.chat?.id;
    const userId = msg.from?.id;
    const text = msg.text ?? msg.caption ?? "";
    if (chatId === undefined || userId === undefined) return { kind: "skip" };
    if (
      opts.selfBotId !== undefined &&
      msg.from?.is_bot &&
      String(msg.from.id) === opts.selfBotId
    ) {
      return { kind: "skip" };
    }
    const threadId = msg.message_thread_id;
    const channelId = threadId !== undefined ? `${chatId}:${threadId}` : String(chatId);
    const event: InboundEvent = {
      idempotencyKey: String(update.update_id),
      workspaceId: String(chatId),
      channelId,
      userId: String(userId),
      ...(threadId !== undefined ? { threadTs: String(threadId) } : {}),
      ts: String(msg.message_id),
      text,
      subtype,
    };
    return { kind: "event", event };
  }

  return {
    id: "telegram",

    verify(req: RawRequest): boolean {
      return verifyTelegramSecret({ headers: req.headers, secretToken: config.secretToken });
    },

    parseInbound(req: RawRequest): ParsedInbound {
      let payload: unknown;
      try {
        payload = JSON.parse(req.body);
      } catch {
        return { kind: "skip" };
      }
      if (typeof payload !== "object" || payload === null) return { kind: "skip" };
      const update = payload as TelegramUpdate;
      if (typeof update.update_id !== "number") return { kind: "skip" };

      // Determine which slot is populated. Telegram updates are mutually
      // exclusive over message / edited_message / channel_post / callback_query.
      if (update.message) {
        const msg = update.message;
        // Skip empty messages (sticker-only / photo-only / system messages)
        if (!msg.text && !msg.caption) return { kind: "skip" };
        // Detect bot mention via entities (`type: "mention"` or `type: "bot_command"`).
        const isMention =
          msg.entities?.some((e) => e.type === "mention" || e.type === "bot_command") ?? false;
        return inboundFromMessage(update, msg, isMention ? "app_mention" : "message");
      }

      if (update.edited_message) {
        // Treat edits as new inbound events (gateway dedups on update_id).
        const msg = update.edited_message;
        if (!msg.text && !msg.caption) return { kind: "skip" };
        return inboundFromMessage(update, msg, "message");
      }

      if (update.callback_query) {
        const cq = update.callback_query;
        const msg = cq.message;
        const userId = cq.from?.id;
        const data = cq.data ?? "";
        if (!msg || userId === undefined) return { kind: "skip" };
        const chatId = msg.chat?.id;
        if (chatId === undefined) return { kind: "skip" };
        const threadId = msg.message_thread_id;
        const channelId = threadId !== undefined ? `${chatId}:${threadId}` : String(chatId);
        const event: InboundEvent = {
          idempotencyKey: String(update.update_id),
          workspaceId: String(chatId),
          channelId,
          userId: String(userId),
          ...(threadId !== undefined ? { threadTs: String(threadId) } : {}),
          ts: String(msg.message_id),
          text: data,
          subtype: "message",
        };
        return { kind: "event", event };
      }

      return { kind: "skip" };
    },

    async sendReply(args: { event: InboundEvent; text: string }): Promise<void> {
      const url = botEndpoint("sendMessage");
      // Reconstruct chat_id from the workspaceId field (always the raw chat.id).
      const chatId = Number.parseInt(args.event.workspaceId, 10);
      if (!Number.isFinite(chatId)) {
        throw new TelegramAdapterError(`invalid workspaceId in event: ${args.event.workspaceId}`);
      }
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text: args.text,
      };
      const threadId = args.event.threadTs;
      if (threadId) {
        body["message_thread_id"] = Number.parseInt(threadId, 10);
      }
      const res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new TelegramAdapterError(`sendMessage failed: ${res.status} ${res.statusText}`);
      }
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        const json = (await res.json()) as { ok?: boolean; description?: string };
        if (json.ok === false) {
          throw new TelegramAdapterError(`sendMessage error: ${json.description ?? "unknown"}`);
        }
      }
    },

    async setTyping(args: { event: InboundEvent }): Promise<void> {
      const url = botEndpoint("sendChatAction");
      const chatId = Number.parseInt(args.event.workspaceId, 10);
      if (!Number.isFinite(chatId)) {
        throw new TelegramAdapterError(`invalid workspaceId in event: ${args.event.workspaceId}`);
      }
      const body: Record<string, unknown> = { chat_id: chatId, action: "typing" };
      if (args.event.threadTs) {
        body["message_thread_id"] = Number.parseInt(args.event.threadTs, 10);
      }
      await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      // setTyping is best-effort; a non-200 here should not fail the run.
    },

    // Phase 3 §3.2 — emoji reactions via Bot API 7.0 `setMessageReaction`.
    // chat_id comes from the raw chat id (workspaceId); message_id from `ts`.
    async react(args: { event: InboundEvent; emoji: string }): Promise<void> {
      const url = botEndpoint("setMessageReaction");
      const chatId = Number.parseInt(args.event.workspaceId, 10);
      const messageId = Number.parseInt(args.event.ts, 10);
      if (!Number.isFinite(chatId) || !Number.isFinite(messageId)) {
        throw new TelegramAdapterError(
          `invalid chat/message id for reaction: ${args.event.workspaceId}/${args.event.ts}`,
        );
      }
      const emoji = TELEGRAM_REACTION_EMOJI[args.emoji] ?? args.emoji;
      const res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          reaction: [{ type: "emoji", emoji }],
        }),
      });
      // Reactions are best-effort — the session-router catches and continues so
      // a flaky/disallowed reaction never aborts message processing.
      if (!res.ok) {
        throw new TelegramAdapterError(
          `setMessageReaction failed: ${res.status} ${res.statusText}`,
        );
      }
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        const json = (await res.json()) as { ok?: boolean; description?: string };
        if (json.ok === false) {
          throw new TelegramAdapterError(
            `setMessageReaction error: ${json.description ?? "unknown"}`,
          );
        }
      }
    },
  };
}

// ─── Telegram Bot API minimal types (no SDK dep) ─────────────────────────────

export type TelegramUpdate = {
  readonly update_id: number;
  readonly message?: TelegramMessage;
  readonly edited_message?: TelegramMessage;
  readonly callback_query?: TelegramCallbackQuery;
};

export type TelegramMessage = {
  readonly message_id: number;
  readonly from?: TelegramUser;
  readonly chat: TelegramChat;
  readonly text?: string;
  readonly caption?: string;
  readonly message_thread_id?: number;
  readonly entities?: ReadonlyArray<TelegramMessageEntity>;
};

export type TelegramUser = {
  readonly id: number;
  readonly is_bot?: boolean;
  readonly username?: string;
};

export type TelegramChat = {
  readonly id: number;
  readonly type?: "private" | "group" | "supergroup" | "channel";
};

export type TelegramMessageEntity = {
  readonly type: string;
  readonly offset?: number;
  readonly length?: number;
};

export type TelegramCallbackQuery = {
  readonly id: string;
  readonly from: TelegramUser;
  readonly data?: string;
  readonly message?: TelegramMessage;
};
