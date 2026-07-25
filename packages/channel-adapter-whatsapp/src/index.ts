/**
 * @crewhaus/channel-adapter-whatsapp — WhatsApp Business Cloud API
 * channel adapter for the channel target (Section 33).
 *
 * WhatsApp's webhook delivery is aggressive — it redelivers on any
 * non-200 response and on its own internal retry schedule. We surface
 * `messages[].id` (Meta's per-message identifier) as the gateway
 * dedup key so retries don't double-process.
 *
 * `handshake` answers Meta's unsigned GET callback-URL verification
 * (`hub.mode=subscribe`) by echoing `hub.challenge` once the presented
 * `hub.verify_token` matches the configured one — without it Meta never
 * activates the subscription and no webhook is ever delivered.
 *
 * `parseInbound` handles text + image + audio + button-reply +
 * list-reply payloads from the v22.0 Cloud API. `sendReply` POSTs to
 * `/v22.0/{phoneNumberId}/messages` with the bot's access token.
 * `setTyping` is a no-op — WhatsApp Business does not expose a typing
 * indicator API for cloud-API-based bots. `react` posts a
 * `type: "reaction"` message targeting the inbound message id.
 *
 * Per-user session keying: WhatsApp has no thread concept; the gateway
 * keys sessions on the contact's phone number (`messages[].from`).
 */
import { CrewhausError } from "@crewhaus/errors";
import { verifyWhatsAppSignature, verifyWhatsAppVerifyToken } from "./verify.js";

export {
  signWhatsAppBody,
  verifyWhatsAppSignature,
  verifyWhatsAppVerifyToken,
} from "./verify.js";

export class WhatsAppAdapterError extends CrewhausError {
  override readonly name = "WhatsAppAdapterError";
  constructor(message: string, cause?: unknown) {
    super("channel", message, cause);
  }
}

export type RawRequest = {
  readonly headers: Headers;
  readonly body: string;
};

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

/**
 * Two result shapes — `parseInbound` only ever sees a signed POST body:
 *   - `{kind:"event", event}` — a real inbound message to route
 *   - `{kind:"skip"}` — known-but-uninteresting payload (status update,
 *     non-text non-interactive media, etc.)
 *
 * Meta's callback-URL verification is NOT a webhook body — it is an unsigned
 * `GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`, handled by
 * `handshake` below, not here.
 */
export type ParsedInbound =
  | { readonly kind: "event"; readonly event: InboundEvent }
  | { readonly kind: "skip" };

/**
 * Meta's unsigned GET subscription handshake (see `handshake` below).
 * Structurally identical to the channel-generic type the emitted gateway
 * uses — the adapter packages deliberately re-declare the shared shapes
 * rather than depend on one another.
 */
export type HandshakeRequest = {
  readonly headers: Headers;
  readonly url: URL;
};

export type HandshakeResult =
  | { readonly kind: "challenge"; readonly challenge: string }
  | { readonly kind: "reject" };

export interface ChannelAdapter {
  readonly id: string;
  verify(req: RawRequest): boolean;
  parseInbound(req: RawRequest): ParsedInbound;
  handshake(req: HandshakeRequest): HandshakeResult;
  sendReply(args: { event: InboundEvent; text: string }): Promise<void>;
  setTyping(args: { event: InboundEvent }): Promise<void>;
  /**
   * Phase 3 §3.2 — add an emoji reaction to an inbound message as a
   * lightweight status acknowledgement (eyes/white_check_mark/warning).
   * WhatsApp accepts any unicode emoji. Optional — the session-router skips
   * the hook when an adapter leaves it undefined.
   */
  react?(args: { event: InboundEvent; emoji: string }): Promise<void>;
}

export type WhatsAppAdapterConfig = {
  /** Meta WhatsApp Cloud API phone number id (numeric, stringified). */
  readonly phoneNumberId: string;
  /** System-user access token authorising sends. */
  readonly accessToken: string;
  /** Meta app secret, used to verify X-Hub-Signature-256. */
  readonly appSecret: string;
  /**
   * The verify token configured on the Meta app's webhook callback. Required
   * to complete the GET subscription handshake — Meta will not deliver any
   * webhook to a callback URL that has never passed it. Absent ⇒ `handshake`
   * rejects every attempt (fail closed), and the daemon can still receive
   * webhooks on a subscription verified elsewhere.
   */
  readonly verifyToken?: string;
};

export type WhatsAppAdapterOptions = {
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly apiVersion?: string;
  /** Clock injection for the signature replay-window check (tests). */
  readonly now?: () => number;
};

const DEFAULT_API_BASE_URL = "https://graph.facebook.com";
const DEFAULT_API_VERSION = "v22.0";

// WhatsApp accepts any unicode emoji for reactions, so the channel-generic
// status names map to their natural glyphs. An unrecognised name passes
// through verbatim.
const WHATSAPP_REACTION_EMOJI: Record<string, string> = {
  eyes: "👀",
  white_check_mark: "✅",
  warning: "⚠️",
};

export function createWhatsAppAdapter(
  config: WhatsAppAdapterConfig,
  opts: WhatsAppAdapterOptions = {},
): ChannelAdapter {
  const apiBaseUrl =
    opts.apiBaseUrl ?? process.env["WHATSAPP_API_BASE_URL"] ?? DEFAULT_API_BASE_URL;
  const apiVersion = opts.apiVersion ?? DEFAULT_API_VERSION;
  const doFetch = opts.fetch ?? fetch;
  const messagesUrl = `${apiBaseUrl}/${apiVersion}/${config.phoneNumberId}/messages`;

  return {
    id: "whatsapp",

    verify(req: RawRequest): boolean {
      return verifyWhatsAppSignature(
        {
          headers: req.headers,
          body: req.body,
          appSecret: config.appSecret,
        },
        opts.now !== undefined ? { now: opts.now } : {},
      );
    },

    /**
     * Meta's callback-URL verification handshake:
     *   `GET /whatsapp/events?hub.mode=subscribe
     *        &hub.verify_token=<shared secret>&hub.challenge=<nonce>`
     * On a token match the caller must echo `hub.challenge` verbatim with 200;
     * anything else marks the callback URL unverified and Meta delivers no
     * webhooks at all. The request is unsigned (no body, no
     * X-Hub-Signature-256), so the verify token IS the authentication — which
     * is why a mismatch, a missing parameter, or an unconfigured
     * `verifyToken` all fail closed.
     */
    handshake(req: HandshakeRequest): HandshakeResult {
      const params = req.url.searchParams;
      if (params.get("hub.mode") !== "subscribe") return { kind: "reject" };
      const challenge = params.get("hub.challenge");
      const supplied = params.get("hub.verify_token");
      if (challenge === null || supplied === null) return { kind: "reject" };
      if (!verifyWhatsAppVerifyToken({ expected: config.verifyToken ?? "", supplied })) {
        return { kind: "reject" };
      }
      return { kind: "challenge", challenge };
    },

    parseInbound(req: RawRequest): ParsedInbound {
      let payload: unknown;
      try {
        payload = JSON.parse(req.body);
      } catch {
        return { kind: "skip" };
      }
      if (typeof payload !== "object" || payload === null) return { kind: "skip" };
      const p = payload as WhatsAppWebhookPayload;
      if (p.object !== "whatsapp_business_account") return { kind: "skip" };

      // entry[0].changes[0].value contains the message envelope.
      const change = p.entry?.[0]?.changes?.[0];
      if (!change || change.field !== "messages") return { kind: "skip" };
      const value = change.value;
      if (!value) return { kind: "skip" };

      const messages = value.messages ?? [];
      // Status updates (delivered/read/failed) come as `value.statuses` —
      // we skip those; the gateway acks 200 and moves on.
      if (messages.length === 0) return { kind: "skip" };

      const msg = messages[0];
      if (!msg || typeof msg.id !== "string" || typeof msg.from !== "string") {
        return { kind: "skip" };
      }
      const phoneNumberId = value.metadata?.phone_number_id ?? "";
      if (!phoneNumberId) return { kind: "skip" };

      const text = renderInboundText(msg);
      if (text === undefined) return { kind: "skip" };

      const event: InboundEvent = {
        idempotencyKey: msg.id,
        workspaceId: phoneNumberId,
        channelId: msg.from,
        userId: msg.from,
        ts: msg.timestamp ?? "",
        text,
        subtype: "message",
      };
      return { kind: "event", event };
    },

    async sendReply(args: { event: InboundEvent; text: string }): Promise<void> {
      const body = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: args.event.userId,
        type: "text",
        text: { body: args.text },
      };
      const res = await doFetch(messagesUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.accessToken}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new WhatsAppAdapterError(`messages POST failed: ${res.status} ${res.statusText}`);
      }
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        const json = (await res.json()) as { error?: { message?: string } };
        if (json.error) {
          throw new WhatsAppAdapterError(`messages POST error: ${json.error.message ?? "unknown"}`);
        }
      }
    },

    async setTyping(_args: { event: InboundEvent }): Promise<void> {
      // No public typing-indicator API for Cloud-API-based WhatsApp bots.
    },

    // Phase 3 §3.2 — emoji reactions via a `type: "reaction"` message. The
    // reaction targets the inbound message id (surfaced as idempotencyKey) and
    // is addressed to the same contact (userId).
    async react(args: { event: InboundEvent; emoji: string }): Promise<void> {
      const emoji = WHATSAPP_REACTION_EMOJI[args.emoji] ?? args.emoji;
      const body = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: args.event.userId,
        type: "reaction",
        reaction: { message_id: args.event.idempotencyKey, emoji },
      };
      const res = await doFetch(messagesUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.accessToken}`,
        },
        body: JSON.stringify(body),
      });
      // Reactions are best-effort — the session-router catches and continues so
      // a flaky reaction never aborts message processing.
      if (!res.ok) {
        throw new WhatsAppAdapterError(`reaction POST failed: ${res.status} ${res.statusText}`);
      }
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        const json = (await res.json()) as { error?: { message?: string } };
        if (json.error) {
          throw new WhatsAppAdapterError(`reaction POST error: ${json.error.message ?? "unknown"}`);
        }
      }
    },
  };
}

/**
 * Reduce a WhatsApp inbound message to a single text body for the agent.
 * Returns undefined for unsupported types (audio without transcription,
 * image without caption, document, sticker, etc.) — the gateway then
 * skips.
 */
function renderInboundText(msg: WhatsAppMessage): string | undefined {
  switch (msg.type) {
    case "text":
      return msg.text?.body ?? "";
    case "interactive": {
      const ir = msg.interactive;
      if (ir?.type === "button_reply") return `[button:${ir.button_reply?.id ?? ""}]`;
      if (ir?.type === "list_reply") return `[list:${ir.list_reply?.id ?? ""}]`;
      return undefined;
    }
    case "image":
      return msg.image?.caption !== undefined ? `[image] ${msg.image.caption}` : undefined;
    case "audio":
      return undefined;
    default:
      return undefined;
  }
}

// ─── Minimal Cloud API types (no SDK) ───────────────────────────────────────

export type WhatsAppWebhookPayload = {
  readonly object: string;
  readonly entry?: ReadonlyArray<WhatsAppEntry>;
};

export type WhatsAppEntry = {
  readonly id?: string;
  readonly changes?: ReadonlyArray<WhatsAppChange>;
};

export type WhatsAppChange = {
  readonly field?: string;
  readonly value?: WhatsAppChangeValue;
};

export type WhatsAppChangeValue = {
  readonly messaging_product?: string;
  readonly metadata?: { readonly display_phone_number?: string; readonly phone_number_id?: string };
  readonly contacts?: ReadonlyArray<{
    readonly profile?: { readonly name?: string };
    readonly wa_id?: string;
  }>;
  readonly messages?: ReadonlyArray<WhatsAppMessage>;
  readonly statuses?: ReadonlyArray<{ readonly id?: string; readonly status?: string }>;
};

export type WhatsAppMessage = {
  readonly id: string;
  readonly from: string;
  readonly timestamp?: string;
  readonly type: "text" | "image" | "audio" | "interactive" | "video" | "document" | "sticker";
  readonly text?: { readonly body?: string };
  readonly image?: { readonly caption?: string; readonly mime_type?: string };
  readonly interactive?: WhatsAppInteractive;
};

export type WhatsAppInteractive = {
  readonly type?: "button_reply" | "list_reply";
  readonly button_reply?: { readonly id?: string; readonly title?: string };
  readonly list_reply?: {
    readonly id?: string;
    readonly title?: string;
    readonly description?: string;
  };
};
