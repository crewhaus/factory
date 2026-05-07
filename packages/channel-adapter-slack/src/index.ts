/**
 * @crewhaus/channel-adapter-slack — Slack channel adapter for the channel
 * target (Section 12).
 *
 * Implements the `ChannelAdapter` contract:
 *   verify(req)        — HMAC-SHA256 of `v0:${ts}:${body}` against
 *                        X-Slack-Signature, with a ±5 min replay window
 *   parseInbound(req)  — normalises Slack `event_callback` envelopes into
 *                        a flat `InboundEvent`. Returns null for
 *                        url_verification, bot self-mentions, and types
 *                        outside `app_mention` / `message`.
 *   sendReply(args)    — POSTs `chat.postMessage` with a Bearer token; the
 *                        api base URL is overridable via constructor opt
 *                        (or `SLACK_API_BASE_URL` env) so tests can mock it.
 *   setTyping(args)    — no-op placeholder (Slack has no public typing API).
 *
 * The adapter is idempotency-key-aware (Section 12 design review): it
 * surfaces the inbound `event_id` so the channel-generic gateway can dedup
 * Slack retries without coupling the gateway to Slack-specific terminology.
 *
 * No `@slack/*` SDK dependency — Slack's HTTP API is plain JSON, and Node's
 * built-in `crypto` covers HMAC. Keeps the bundle slim and the trust
 * surface minimal.
 */
import { CrewhausError } from "@crewhaus/errors";
import { signSlackBody, verifySlackSignature } from "./verify.js";

export { signSlackBody, verifySlackSignature } from "./verify.js";

export class SlackAdapterError extends CrewhausError {
  override readonly name = "SlackAdapterError";
  constructor(message: string, cause?: unknown) {
    super("channel", message, cause);
  }
}

export type RawRequest = {
  readonly headers: Headers;
  readonly body: string;
};

/**
 * Channel-generic inbound event. The adapter normalises every channel's
 * native payload (Slack `event_callback`, future Telegram update, etc.)
 * into this flat shape. The gateway and session-router never see the raw
 * payload — they only see this.
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

/**
 * The result of `parseInbound`. Three shapes:
 *   - { kind: "event", event } — a real inbound message to route
 *   - { kind: "challenge", challenge } — Slack URL-verification handshake;
 *     gateway responds with the challenge string in plaintext
 *   - { kind: "skip" } — known-but-uninteresting payload (bot self-mention,
 *     non-message event types, etc.); gateway responds 200 and moves on
 */
export type ParsedInbound =
  | { readonly kind: "event"; readonly event: InboundEvent }
  | { readonly kind: "challenge"; readonly challenge: string }
  | { readonly kind: "skip" };

export interface ChannelAdapter {
  readonly id: string;
  verify(req: RawRequest): boolean;
  parseInbound(req: RawRequest): ParsedInbound;
  sendReply(args: { event: InboundEvent; text: string }): Promise<void>;
  setTyping(args: { event: InboundEvent }): Promise<void>;
}

export type SlackAdapterConfig = {
  readonly botToken: string;
  readonly signingSecret: string;
  readonly appToken?: string;
};

export type SlackAdapterOptions = {
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly selfBotId?: string;
};

const DEFAULT_API_BASE_URL = "https://slack.com/api";

export function createSlackAdapter(
  config: SlackAdapterConfig,
  opts: SlackAdapterOptions = {},
): ChannelAdapter {
  const apiBaseUrl = opts.apiBaseUrl ?? process.env["SLACK_API_BASE_URL"] ?? DEFAULT_API_BASE_URL;
  const doFetch = opts.fetch ?? fetch;

  return {
    id: "slack",

    verify(req: RawRequest): boolean {
      return verifySlackSignature(
        { headers: req.headers, body: req.body, signingSecret: config.signingSecret },
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
      const p = payload as Record<string, unknown>;

      // URL-verification handshake (Slack sends this once when you point an
      // app's Event Subscription at a new URL).
      if (p["type"] === "url_verification" && typeof p["challenge"] === "string") {
        return { kind: "challenge", challenge: p["challenge"] };
      }

      if (p["type"] !== "event_callback") return { kind: "skip" };

      const ev = p["event"];
      if (typeof ev !== "object" || ev === null) return { kind: "skip" };
      const e = ev as Record<string, unknown>;

      const evType = e["type"];
      if (evType !== "app_mention" && evType !== "message") return { kind: "skip" };

      // Skip self/bot loops. `bot_id` is present on Slack's bot-authored
      // messages; `subtype: bot_message` is the older convention.
      if (typeof e["bot_id"] === "string") {
        if (opts.selfBotId === undefined || e["bot_id"] === opts.selfBotId) {
          return { kind: "skip" };
        }
      }
      if (e["subtype"] === "bot_message") return { kind: "skip" };

      const idempotencyKey = typeof p["event_id"] === "string" ? p["event_id"] : undefined;
      const workspaceId = typeof p["team_id"] === "string" ? p["team_id"] : undefined;
      const channelId = typeof e["channel"] === "string" ? e["channel"] : undefined;
      const userId = typeof e["user"] === "string" ? e["user"] : undefined;
      const ts = typeof e["ts"] === "string" ? e["ts"] : undefined;
      const text = typeof e["text"] === "string" ? e["text"] : "";
      const threadTs = typeof e["thread_ts"] === "string" ? e["thread_ts"] : undefined;

      if (!idempotencyKey || !workspaceId || !channelId || !userId || !ts) {
        return { kind: "skip" };
      }

      const event: InboundEvent = {
        idempotencyKey,
        workspaceId,
        channelId,
        userId,
        ...(threadTs !== undefined ? { threadTs } : {}),
        ts,
        text,
        subtype: evType,
      };
      return { kind: "event", event };
    },

    async sendReply(args: { event: InboundEvent; text: string }): Promise<void> {
      const url = `${apiBaseUrl}/chat.postMessage`;
      const threadKey = args.event.threadTs ?? args.event.ts;
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${config.botToken}`,
        },
        body: JSON.stringify({
          channel: args.event.channelId,
          thread_ts: threadKey,
          text: args.text,
        }),
      });
      if (!res.ok) {
        throw new SlackAdapterError(`chat.postMessage failed: ${res.status} ${res.statusText}`);
      }
      // Slack returns { ok: false } at HTTP 200 on logical errors; surface that.
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        const body = (await res.json()) as { ok?: boolean; error?: string };
        if (body.ok === false) {
          throw new SlackAdapterError(`chat.postMessage error: ${body.error ?? "unknown"}`);
        }
      }
    },

    async setTyping(_args: { event: InboundEvent }): Promise<void> {
      // Slack has no public typing-indicator API for bots. No-op for v0;
      // future versions may use the `assistant.threads.setStatus` API
      // (Slack AI Assistant beta) for an approximation.
    },
  };
}
