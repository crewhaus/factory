/**
 * @crewhaus/channel-adapter-discord — Discord channel adapter for the
 * channel target (Section 33).
 *
 * Discord's interaction model is request/response: the bot is invoked
 * via slash commands (interaction type 2), button clicks (type 3), and
 * modal submits (type 5). Each request is Ed25519-signed via
 * `X-Signature-Ed25519` + `X-Signature-Timestamp`.
 *
 * Discord requires the bot to respond *to the request itself* — the
 * gateway POSTs the interaction-response body back. For backward
 * compatibility with the channel adapter contract, `sendReply` instead
 * uses Discord's "follow-up message" API (`POST /webhooks/{appId}/{token}`)
 * which works at any time after the initial deferred response.
 *
 * Thread session keying uses Discord's native `thread_id` when present
 * (forum / public thread / archived thread); otherwise the channel id.
 */
import { CrewhausError } from "@crewhaus/errors";
import { verifyDiscordSignature } from "./verify.js";

export {
  generateEd25519Keypair,
  signDiscordBody,
  verifyDiscordSignature,
} from "./verify.js";

export class DiscordAdapterError extends CrewhausError {
  override readonly name = "DiscordAdapterError";
  constructor(message: string, cause?: unknown) {
    super("channel", message, cause);
  }
}

export type RawRequest = {
  readonly headers: Headers;
  readonly body: string;
};

/**
 * Channel-generic inbound event. Same shape as Slack/Telegram:
 *
 * Mappings:
 *   - workspaceId   → guild_id (or "dm" when not in a guild)
 *   - channelId     → channel_id
 *   - userId        → user.id (or member.user.id in guild context)
 *   - threadTs      → channel_id when the channel is a thread
 *   - ts            → interaction id (snowflake; monotonic-ish)
 *   - text          → command-name + options for slash commands;
 *                     custom_id for component clicks; modal field values
 *                     joined for modal submits
 *   - subtype       → "message" | "app_mention"
 *   - idempotencyKey → interaction id (Discord doesn't redeliver, but we
 *                      surface the id so the gateway dedups consistently)
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
  /**
   * Discord pings every interactions endpoint with a `type:1` PING that
   * must be answered with `type:1` PONG before any real interactions
   * arrive. The gateway responds with the canned PONG body.
   */
  | { readonly kind: "challenge"; readonly challenge: string }
  | { readonly kind: "skip" };

export interface ChannelAdapter {
  readonly id: string;
  verify(req: RawRequest): boolean;
  parseInbound(req: RawRequest): ParsedInbound;
  sendReply(args: { event: InboundEvent; text: string }): Promise<void>;
  setTyping(args: { event: InboundEvent }): Promise<void>;
}

export type DiscordAdapterConfig = {
  /** Application id (snowflake). Used by the follow-up webhook URL. */
  readonly applicationId: string;
  /** Bot user token — used to authorize follow-up REST calls. */
  readonly botToken: string;
  /** Public key (hex, 64 chars) for Ed25519 verification. */
  readonly publicKeyHex: string;
};

export type DiscordAdapterOptions = {
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof fetch;
  /** Clock injection for the signature replay-window check (tests). */
  readonly now?: () => number;
};

const DEFAULT_API_BASE_URL = "https://discord.com/api/v10";
const PONG_RESPONSE_BODY = JSON.stringify({ type: 1 });

export function createDiscordAdapter(
  config: DiscordAdapterConfig,
  opts: DiscordAdapterOptions = {},
): ChannelAdapter {
  const apiBaseUrl = opts.apiBaseUrl ?? process.env["DISCORD_API_BASE_URL"] ?? DEFAULT_API_BASE_URL;
  const doFetch = opts.fetch ?? fetch;

  return {
    id: "discord",

    verify(req: RawRequest): boolean {
      return verifyDiscordSignature(
        {
          headers: req.headers,
          body: req.body,
          publicKeyHex: config.publicKeyHex,
        },
        opts.now !== undefined ? { now: opts.now } : {},
      );
    },

    parseInbound(req: RawRequest): ParsedInbound {
      let payload: unknown;
      try {
        payload = JSON.parse(req.body);
      } catch {
        return { kind: "skip" };
      }
      if (typeof payload !== "object" || payload === null) return { kind: "skip" };
      const p = payload as DiscordInteraction;

      // PING → PONG handshake (Discord's URL-verification analogue).
      if (p.type === 1) {
        return { kind: "challenge", challenge: PONG_RESPONSE_BODY };
      }

      // We handle types 2 (slash command), 3 (component click), 5 (modal submit).
      if (p.type !== 2 && p.type !== 3 && p.type !== 5) {
        return { kind: "skip" };
      }
      const interactionId = p.id;
      const channelId = p.channel_id;
      const userId = p.member?.user?.id ?? p.user?.id;
      if (!interactionId || !channelId || !userId) return { kind: "skip" };

      const workspaceId = p.guild_id ?? "dm";
      // Threads: in Discord a "thread" is a Channel with `parent_id` set
      // and type 11 (public thread) / 12 (private thread) / 10 (news
      // thread). The interaction.channel object includes `parent_id` when
      // the interaction is in a thread.
      const isThread = typeof p.channel?.parent_id === "string" && p.channel.parent_id.length > 0;
      const threadTs = isThread ? channelId : undefined;

      const text = renderInteractionText(p);

      const event: InboundEvent = {
        idempotencyKey: interactionId,
        workspaceId,
        channelId,
        userId,
        ...(threadTs !== undefined ? { threadTs } : {}),
        ts: interactionId,
        text,
        subtype: "message",
      };
      return { kind: "event", event };
    },

    async sendReply(args: { event: InboundEvent; text: string }): Promise<void> {
      // Use Discord's interaction follow-up endpoint:
      //   POST /webhooks/{application.id}/{interaction.token}
      // The interaction.token isn't part of `InboundEvent`; in practice the
      // gateway should call `interaction.respond({type:5, data: {...}})`
      // synchronously to defer, then we follow up via this REST call. For
      // the v0 channel-bot daemon we use the application's webhook channel
      // POST as a fallback so the message reaches the channel even without
      // the interaction token (slightly different rendering — no
      // ephemeral, no per-user replies).
      const url = `${apiBaseUrl}/channels/${args.event.channelId}/messages`;
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bot ${config.botToken}`,
        },
        body: JSON.stringify({ content: args.text }),
      });
      if (!res.ok) {
        throw new DiscordAdapterError(
          `channels/${args.event.channelId}/messages failed: ${res.status} ${res.statusText}`,
        );
      }
    },

    async setTyping(args: { event: InboundEvent }): Promise<void> {
      const url = `${apiBaseUrl}/channels/${args.event.channelId}/typing`;
      // Best-effort — do not surface failures. A failed typing indicator must
      // never reject and break the caller's reply flow, so we swallow both
      // network rejections (DNS/abort/connection) and non-2xx responses.
      try {
        await doFetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bot ${config.botToken}`,
          },
        });
      } catch {
        // ignore — typing indicator is non-essential.
      }
    },
  };
}

/** Reduce an interaction payload to a single text body for the agent. */
function renderInteractionText(p: DiscordInteraction): string {
  if (p.type === 2) {
    // Slash command: render as `/<name> <option1=value1> <option2=value2>`
    const cmd = p.data?.name ?? "?";
    const opts = (p.data?.options ?? [])
      .map((o) => `${o.name}=${stringifyOption(o.value)}`)
      .join(" ");
    return opts ? `/${cmd} ${opts}` : `/${cmd}`;
  }
  if (p.type === 3) {
    // Component click: `[component:<custom_id>]`
    return `[component:${p.data?.custom_id ?? ""}]`;
  }
  if (p.type === 5) {
    // Modal submit: render as `<custom_id>: field1=value1 field2=value2`
    const id = p.data?.custom_id ?? "";
    const fields = (p.data?.components ?? [])
      .flatMap((row) => row.components ?? [])
      .map((c) => `${c.custom_id ?? "?"}=${c.value ?? ""}`)
      .join(" ");
    return `${id}: ${fields}`;
  }
  return "";
}

function stringifyOption(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

// ─── Minimal Discord interaction shape (no SDK) ──────────────────────────────

export type DiscordInteraction = {
  readonly id: string;
  readonly application_id?: string;
  readonly type: number;
  readonly token?: string;
  readonly channel_id?: string;
  readonly guild_id?: string;
  readonly user?: { readonly id: string; readonly username?: string };
  readonly member?: { readonly user?: { readonly id: string; readonly username?: string } };
  readonly channel?: { readonly id?: string; readonly parent_id?: string };
  readonly data?: {
    readonly name?: string;
    readonly custom_id?: string;
    readonly options?: ReadonlyArray<{ readonly name: string; readonly value?: unknown }>;
    readonly components?: ReadonlyArray<{
      readonly components?: ReadonlyArray<{
        readonly custom_id?: string;
        readonly value?: string;
      }>;
    }>;
  };
};
