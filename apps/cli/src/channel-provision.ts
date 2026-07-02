import type {
  IrChannels,
  IrDiscordConfig,
  IrSecretRef,
  IrSlackConfig,
  IrTelegramConfig,
} from "@crewhaus/ir";

/**
 * Item 61 — `crewhaus channel provision|verify`: one-command channel app
 * setup + scope doctor, factored out of the entry file `index.ts` (which
 * runs a top-level argv switch and so cannot be imported by a test without
 * executing the CLI). Side-effect-free on import and directly unit-testable,
 * mirroring `audit-verify.ts` / `security-digest.ts` / `scope-audit-drift.ts`.
 *
 * The problem this closes: channel-bot harnesses assume platform-side
 * configuration the user had to hand-build — a Slack app with the right
 * scopes/event subscriptions, a Telegram webhook registered with the secret
 * the adapter verifies (`channel-adapter-telegram` documents the
 * `setWebhook(secret_token=...)` expectation but nothing performed it), a
 * Discord application pointed at the daemon's interactions endpoint.
 *
 * Everything here is DERIVED from the adapters + the compiled daemon, not
 * guessed (per-platform derivations are documented on the builders below).
 * The one shared fact: the generated gateway routes webhooks by path —
 * `/^\/([^/]+)\/events$/` in target-channel-bot's `renderGateway` — so the
 * platform-side URL is always `<base-url>/<adapterId>/events`.
 *
 * Design decisions:
 *   - Slack is EMIT-AND-INSTRUCT only (no `--apply`). Slack's manifest API
 *     (`apps.manifest.create`) authenticates with an app *configuration*
 *     token; the adapter/spec carry only the bot token (`xoxb`, Bearer for
 *     chat.postMessage/reactions.add), the signing secret (HMAC verify), and
 *     the reserved Socket-Mode `appToken` (`xapp`) — none of which can call
 *     the manifest API, and inventing a new env var for a token family the
 *     runtime never uses was ruled out.
 *   - Discord's adapter is interactions-endpoint-based (Ed25519-verified
 *     webhooks; types 1/2/3/5), NOT gateway-websocket-based — so provision
 *     PATCHes `applications/@me` `interactions_endpoint_url` and prints the
 *     invite URL with permission bits derived from the adapter's REST usage.
 *     Application *commands* are not registered: the spec declares no
 *     command list and the adapter accepts ANY command name (it renders
 *     `/<name> <options>` into the agent turn), so command names cannot be
 *     derived without guesswork — provision prints the registration
 *     instruction instead.
 *   - All network calls go through an injectable `fetchImpl` so tests are
 *     credential-free, and every network-performing path has a dry-run
 *     counterpart (`display` plans / `describeVerifyProbes`) that renders
 *     env refs as `$NAME` and literals as `[redacted]` — never the value.
 */

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/** Platforms `channel provision|verify` supports. whatsapp (Meta app config
 *  lives in the Meta developer console) and imessage (host-local chat.db —
 *  there is no platform side to provision) are out of item-61 scope; when a
 *  spec configures them the CLI prints a note instead of failing. */
export const CHANNEL_PLATFORMS = ["slack", "telegram", "discord"] as const;
export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number];

export type FetchLike = typeof fetch;

/** Placeholder for an inline-literal secret in printable output — mirrors
 *  `packages/ir/src/redact.ts`'s `REDACTED_VALUE` convention. */
export const REDACTED_LITERAL = "[redacted]";

/** Thrown on a malformed/unconfigured `--platform` value. The CLI entry file
 *  catches it and routes the message through `die()`. */
export class InvalidPlatformFlagError extends Error {
  override readonly name = "InvalidPlatformFlagError";
}

/** Thrown when a secret env-ref (`$VAR_NAME` in the spec) is unset at the
 *  moment a REAL platform call needs its value. Dry-run paths never throw
 *  this — they print the `$VAR_NAME` placeholder instead. */
export class ChannelEnvRefError extends Error {
  override readonly name = "ChannelEnvRefError";
  constructor(
    readonly label: string,
    readonly envName: string,
  ) {
    super(
      `${label} references $${envName} but it is unset — export ${envName} (or inline a literal in the spec)`,
    );
  }
}

/** Thrown on a failed platform API call (non-2xx or a logical `ok: false`).
 *  Messages are built from REDACTED endpoints — never the token-bearing URL. */
export class ChannelApiError extends Error {
  override readonly name = "ChannelApiError";
}

/** Thrown on a malformed `--base-url`. */
export class InvalidBaseUrlError extends Error {
  override readonly name = "InvalidBaseUrlError";
  constructor(value: string, detail: string) {
    super(
      `invalid --base-url "${value}" — ${detail} (expected the daemon's publicly reachable origin, e.g. https://bot.example.com)`,
    );
  }
}

/**
 * Resolve the `--platform` flag against the spec's configured channels.
 * `all` (or an absent flag) selects every configured platform this command
 * supports; an explicit platform must actually be configured in the spec —
 * provisioning a channel the daemon will never serve is a footgun, not a
 * convenience. `unsupported` lists configured channels outside item-61
 * scope (whatsapp/imessage) so the CLI can print a note.
 */
export function resolvePlatformsFlag(
  flagValue: string | undefined,
  channels: IrChannels,
): {
  readonly platforms: ReadonlyArray<ChannelPlatform>;
  readonly unsupported: ReadonlyArray<string>;
} {
  const configured = CHANNEL_PLATFORMS.filter((p) => channels[p] !== undefined);
  const unsupported = (["whatsapp", "imessage"] as const).filter((p) => channels[p] !== undefined);
  const value = flagValue ?? "all";
  if (value === "all") {
    if (configured.length === 0) {
      throw new InvalidPlatformFlagError(
        `the spec's channels block configures none of: ${CHANNEL_PLATFORMS.join(", ")}${
          unsupported.length > 0
            ? ` (${unsupported.join(", ")} ${unsupported.length === 1 ? "is" : "are"} configured but not supported by this command)`
            : ""
        }`,
      );
    }
    return { platforms: configured, unsupported };
  }
  if (!(CHANNEL_PLATFORMS as ReadonlyArray<string>).includes(value)) {
    throw new InvalidPlatformFlagError(
      `invalid --platform "${value}" — expected one of: ${CHANNEL_PLATFORMS.join(", ")}, all`,
    );
  }
  const platform = value as ChannelPlatform;
  if (channels[platform] === undefined) {
    throw new InvalidPlatformFlagError(
      `--platform ${platform} but the spec configures no channels.${platform} block`,
    );
  }
  return { platforms: [platform], unsupported };
}

/** Resolve a lowered secret ref to its value. Env-refs read `env`; an unset
 *  (or empty) env var throws {@link ChannelEnvRefError} — matching the
 *  compiled daemon's own startup check, which exits non-zero on the same
 *  condition rather than serving webhooks with an empty secret. */
export function resolveSecretRef(label: string, ref: IrSecretRef, env: NodeJS.ProcessEnv): string {
  if (ref.kind === "literal") return ref.value;
  const value = env[ref.name];
  if (value === undefined || value === "") throw new ChannelEnvRefError(label, ref.name);
  return value;
}

/** Printable form of a secret ref: `$NAME` for env-refs (the indirection is
 *  not a secret), {@link REDACTED_LITERAL} for inline literals. */
export function describeSecretRef(ref: IrSecretRef): string {
  return ref.kind === "env" ? `$${ref.name}` : REDACTED_LITERAL;
}

/** The daemon route the platform must deliver webhooks to. Single source:
 *  target-channel-bot's gateway matches `/^\/([^/]+)\/events$/` and looks the
 *  captured segment up in its adapter map keyed by adapter id. */
export function channelEventsPath(platform: ChannelPlatform): string {
  return `/${platform}/events`;
}

/**
 * Join `--base-url` with a daemon route. Validates the base URL parses and
 * is http(s); trailing slashes are normalized so `https://x/` and `https://x`
 * produce the same webhook URL. (Slack, Telegram, and Discord all require a
 * publicly reachable https URL in production — http is tolerated here for
 * local tunnels/tests; the platform rejects it server-side if unsupported.)
 */
export function joinBaseUrl(baseUrl: string, path: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new InvalidBaseUrlError(baseUrl, "not a parseable URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new InvalidBaseUrlError(baseUrl, `unsupported protocol "${parsed.protocol}"`);
  }
  const origin = parsed.origin + parsed.pathname.replace(/\/+$/, "");
  return `${origin}${path}`;
}

/** A missing env-ref surfaced by a provision plan builder: which spec field,
 *  which env var. The CLI dies listing these before a live (non-dry-run) call. */
export type MissingEnvRef = { readonly label: string; readonly envName: string };

function collectMissing(
  refs: ReadonlyArray<{ readonly label: string; readonly ref: IrSecretRef }>,
  env: NodeJS.ProcessEnv,
): MissingEnvRef[] {
  const missing: MissingEnvRef[] = [];
  for (const { label, ref } of refs) {
    if (ref.kind === "env" && (env[ref.name] === undefined || env[ref.name] === "")) {
      missing.push({ label, envName: ref.name });
    }
  }
  return missing;
}

/**
 * The secret fields a platform's daemon REQUIRES at boot, per
 * target-channel-bot's `requiredEnvNames`: slack botToken + signingSecret
 * (appToken is reserved for a future Socket-Mode path — parsed but unused,
 * so not required), telegram botToken + secretToken, discord applicationId +
 * botToken + publicKeyHex. Shared by the doctor channel check and `verify`.
 */
export function platformSecretRefs(
  platform: ChannelPlatform,
  channels: IrChannels,
): ReadonlyArray<{ readonly label: string; readonly ref: IrSecretRef }> {
  if (platform === "slack") {
    const slack = channels.slack;
    if (slack === undefined) return [];
    return [
      { label: "channels.slack.botToken", ref: slack.botToken },
      { label: "channels.slack.signingSecret", ref: slack.signingSecret },
    ];
  }
  if (platform === "telegram") {
    const telegram = channels.telegram;
    if (telegram === undefined) return [];
    return [
      { label: "channels.telegram.botToken", ref: telegram.botToken },
      { label: "channels.telegram.secretToken", ref: telegram.secretToken },
    ];
  }
  const discord = channels.discord;
  if (discord === undefined) return [];
  return [
    { label: "channels.discord.applicationId", ref: discord.applicationId },
    { label: "channels.discord.botToken", ref: discord.botToken },
    { label: "channels.discord.publicKeyHex", ref: discord.publicKeyHex },
  ];
}

// ---------------------------------------------------------------------------
// Slack — app manifest generation (emit-and-instruct; see header for the
// no-`--apply` decision)
// ---------------------------------------------------------------------------

export const SLACK_MANIFEST_FILENAME = "slack-app-manifest.yaml";

const DEFAULT_SLACK_API_BASE_URL = "https://slack.com/api";

export type SlackScope = { readonly scope: string; readonly reason: string };

/**
 * Bot scopes derived from `@crewhaus/channel-adapter-slack`'s ACTUAL API
 * usage and parsed event types — not from a generic bot template:
 *   - `sendReply` POSTs `chat.postMessage`            → chat:write
 *   - `react` POSTs `reactions.add` (the generated session-router always
 *     attempts 👀/✅/⚠️ status acks)                    → reactions:write
 *   - `parseInbound` handles `app_mention`            → app_mentions:read
 *   - `parseInbound` handles `message` in any
 *     conversation type, so each `message.*` event
 *     subscription needs its history scope            → channels/groups/im/mpim:history
 *   - `parseInbound` normalises `reaction_added` into 👍/👎 `user_feedback`
 *     (the v0.1.8 ratings feature), but the generated gateway only
 *     dispatches it when the spec sets `feedback.channelReactions` — so
 *     reactions:read is requested exactly then         → reactions:read
 */
export function deriveSlackScopes(opts: {
  readonly channelReactions: boolean;
}): ReadonlyArray<SlackScope> {
  const scopes: SlackScope[] = [
    { scope: "app_mentions:read", reason: "receive app_mention events (adapter parseInbound)" },
    { scope: "channels:history", reason: "receive message.channels events (public channels)" },
    { scope: "groups:history", reason: "receive message.groups events (private channels)" },
    { scope: "im:history", reason: "receive message.im events (DMs)" },
    { scope: "mpim:history", reason: "receive message.mpim events (group DMs)" },
    { scope: "chat:write", reason: "sendReply → chat.postMessage" },
    { scope: "reactions:write", reason: "react → reactions.add (👀/✅/⚠️ status acks)" },
  ];
  if (opts.channelReactions) {
    scopes.push({
      scope: "reactions:read",
      reason: "receive reaction_added events (feedback.channelReactions 👍/👎 ratings)",
    });
  }
  return scopes;
}

/** Event subscriptions matching {@link deriveSlackScopes} — the event types
 *  the adapter's `parseInbound` consumes (everything else parses to skip). */
export function deriveSlackBotEvents(opts: {
  readonly channelReactions: boolean;
}): ReadonlyArray<string> {
  const events = [
    "app_mention",
    "message.channels",
    "message.groups",
    "message.im",
    "message.mpim",
  ];
  if (opts.channelReactions) events.push("reaction_added");
  return events;
}

/** A Slack app manifest (api.slack.com/reference/manifests), restricted to
 *  the sections the channel daemon needs. */
export type SlackAppManifest = {
  readonly display_information: { readonly name: string; readonly description: string };
  readonly features: {
    readonly bot_user: { readonly display_name: string; readonly always_online: boolean };
  };
  readonly oauth_config: { readonly scopes: { readonly bot: ReadonlyArray<string> } };
  readonly settings: {
    readonly event_subscriptions: {
      readonly request_url: string;
      readonly bot_events: ReadonlyArray<string>;
    };
    readonly org_deploy_enabled: boolean;
    readonly socket_mode_enabled: boolean;
    readonly token_rotation_enabled: boolean;
  };
};

/**
 * Build the complete Slack app manifest for a channel spec. The request URL
 * is the compiled daemon's slack route under `--base-url`; `socket_mode` is
 * off because the daemon is a webhook server (the spec's `appToken` is
 * documented as reserved for a future Socket-Mode path).
 */
export function buildSlackManifest(
  spec: { readonly name: string; readonly channelReactions: boolean },
  baseUrl: string,
): SlackAppManifest {
  const reactions = { channelReactions: spec.channelReactions };
  return {
    display_information: {
      // Slack limits: name ≤ 35 chars, description ≤ 140.
      name: spec.name.slice(0, 35),
      description:
        `CrewHaus channel bot "${spec.name}" (generated by crewhaus channel provision)`.slice(
          0,
          140,
        ),
    },
    features: {
      bot_user: { display_name: spec.name.slice(0, 35), always_online: true },
    },
    oauth_config: {
      scopes: { bot: deriveSlackScopes(reactions).map((s) => s.scope) },
    },
    settings: {
      event_subscriptions: {
        request_url: joinBaseUrl(baseUrl, channelEventsPath("slack")),
        bot_events: deriveSlackBotEvents(reactions),
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

type YamlValue =
  | string
  | boolean
  | number
  | ReadonlyArray<YamlValue>
  | { readonly [k: string]: YamlValue };

/** Minimal YAML renderer for the manifest shape (nested maps, string arrays,
 *  scalars). String scalars are always double-quoted via JSON.stringify —
 *  valid YAML, and immune to `:`/`#`/leading-symbol edge cases in URLs. */
function renderYamlValue(value: YamlValue, indent: number): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    return (value as ReadonlyArray<YamlValue>)
      .map((item) => `${pad}- ${typeof item === "string" ? JSON.stringify(item) : String(item)}`)
      .join("\n");
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value)
      .map(([key, v]) => {
        if (typeof v === "object" && v !== null) {
          return `${pad}${key}:\n${renderYamlValue(v as YamlValue, indent + 1)}`;
        }
        return `${pad}${key}: ${typeof v === "string" ? JSON.stringify(v) : String(v)}`;
      })
      .join("\n");
  }
  return `${pad}${typeof value === "string" ? JSON.stringify(value) : String(value)}`;
}

export function renderSlackManifestYaml(manifest: SlackAppManifest): string {
  return `${renderYamlValue(manifest as unknown as YamlValue, 0)}\n`;
}

/** Post-manifest instructions. Slack app creation from a manifest is a
 *  console flow (no `--apply` — see the module header for why), so the CLI
 *  prints exactly what to do with the file it just wrote. */
export function slackNextSteps(cfg: IrSlackConfig, manifestRef: string): ReadonlyArray<string> {
  return [
    `1. open https://api.slack.com/apps → "Create New App" → "From an app manifest",`,
    `   pick the workspace, and paste ${manifestRef}`,
    `2. "Install to Workspace", then copy the credentials into the spec's env refs:`,
    `     Bot User OAuth Token (xoxb-…)  → ${describeSecretRef(cfg.botToken)}`,
    `     Signing Secret                 → ${describeSecretRef(cfg.signingSecret)}`,
    "3. start the daemon (bun daemon.ts) BEFORE saving the request URL — Slack",
    "   sends a url_verification challenge the gateway must answer",
    "4. re-run `crewhaus channel verify --platform slack` to confirm granted scopes",
    "(no --apply: Slack's manifest API needs an app *configuration* token — the",
    " adapter only uses the xoxb bot token, signing secret, and reserved xapp token)",
  ];
}

// ---------------------------------------------------------------------------
// Telegram — setWebhook (the call the adapter documents but nothing performed)
// ---------------------------------------------------------------------------

const DEFAULT_TELEGRAM_API_BASE_URL = "https://api.telegram.org";

/** Update kinds the adapter's `parseInbound` actually consumes — its three
 *  populated slots are `message`, `edited_message`, and `callback_query`;
 *  everything else returns skip, so the webhook shouldn't receive it. */
export const TELEGRAM_ALLOWED_UPDATES = ["message", "edited_message", "callback_query"] as const;

export type TelegramSetWebhookPayload = {
  readonly url: string;
  readonly secret_token: string;
  readonly allowed_updates: ReadonlyArray<string>;
};

export type TelegramProvision = {
  /** Printable call — token/secret rendered as `$NAME` / `[redacted]`. */
  readonly display: { readonly endpoint: string; readonly payload: TelegramSetWebhookPayload };
  /** The real call. Absent when an env-ref is unset (see `missingEnv`). */
  readonly request?: { readonly endpoint: string; readonly payload: TelegramSetWebhookPayload };
  readonly missingEnv: ReadonlyArray<MissingEnvRef>;
};

/**
 * Build the `setWebhook` call: url = the daemon's `/telegram/events` route
 * under `--base-url`, secret_token = the spec's `secretToken` — the SAME
 * value the adapter compares (timing-safely) against the
 * `X-Telegram-Bot-Api-Secret-Token` header on every inbound POST —
 * allowed_updates = the adapter's three consumed update kinds. The api base
 * honours `TELEGRAM_API_BASE_URL` exactly like the adapter does.
 */
export function buildTelegramProvision(
  cfg: IrTelegramConfig,
  baseUrl: string,
  env: NodeJS.ProcessEnv,
): TelegramProvision {
  const apiBase = env["TELEGRAM_API_BASE_URL"] ?? DEFAULT_TELEGRAM_API_BASE_URL;
  const webhookUrl = joinBaseUrl(baseUrl, channelEventsPath("telegram"));
  const display = {
    endpoint: `${apiBase}/bot${describeSecretRef(cfg.botToken)}/setWebhook`,
    payload: {
      url: webhookUrl,
      secret_token: describeSecretRef(cfg.secretToken),
      allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
    },
  };
  const missingEnv = collectMissing(
    [
      { label: "channels.telegram.botToken", ref: cfg.botToken },
      { label: "channels.telegram.secretToken", ref: cfg.secretToken },
    ],
    env,
  );
  if (missingEnv.length > 0) return { display, missingEnv };
  return {
    display,
    missingEnv,
    request: {
      endpoint: `${apiBase}/bot${resolveSecretRef("channels.telegram.botToken", cfg.botToken, env)}/setWebhook`,
      payload: {
        url: webhookUrl,
        secret_token: resolveSecretRef("channels.telegram.secretToken", cfg.secretToken, env),
        allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
      },
    },
  };
}

/** Perform the setWebhook POST. Errors carry the REDACTED endpoint (the real
 *  one embeds the bot token in its path). Returns Telegram's description. */
export async function performTelegramSetWebhook(
  provision: TelegramProvision,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const request = provision.request;
  if (request === undefined) {
    throw new ChannelApiError(
      `setWebhook not performed — unset env: ${provision.missingEnv.map((m) => `$${m.envName}`).join(", ")}`,
    );
  }
  let res: Response;
  try {
    res = await fetchImpl(request.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request.payload),
    });
  } catch (err) {
    throw new ChannelApiError(
      `POST ${provision.display.endpoint} unreachable: ${(err as Error).message}`,
    );
  }
  if (!res.ok) {
    throw new ChannelApiError(
      `POST ${provision.display.endpoint} failed: ${res.status} ${res.statusText}`,
    );
  }
  const body = (await res.json()) as { ok?: boolean; description?: string };
  if (body.ok !== true) {
    throw new ChannelApiError(
      `setWebhook error: ${body.description ?? "unknown"} (endpoint ${provision.display.endpoint})`,
    );
  }
  return body.description ?? "webhook set";
}

// ---------------------------------------------------------------------------
// Discord — interactions endpoint registration + invite URL
// ---------------------------------------------------------------------------

const DEFAULT_DISCORD_API_BASE_URL = "https://discord.com/api/v10";

/**
 * Invite-URL permission bits derived from the adapter's REST usage — the
 * adapter never opens a gateway websocket, so no presence/guild intents:
 *   - `sendReply` POSTs `channels/<id>/messages`  → View Channel + Send Messages
 *   - threads are first-class (`threadTs` from `channel.parent_id`), and the
 *     same POST into a thread channel                → Send Messages in Threads
 *   - `setTyping` POSTs `channels/<id>/typing`      → covered by Send Messages
 */
export const DISCORD_PERMISSIONS = [
  { name: "View Channel", bit: 1024 }, // 1 << 10
  { name: "Send Messages", bit: 2048 }, // 1 << 11
  { name: "Send Messages in Threads", bit: 274_877_906_944 }, // 1 << 38
] as const;

export const DISCORD_PERMISSION_BITS = DISCORD_PERMISSIONS.reduce((sum, p) => sum + p.bit, 0);

export type DiscordProvision = {
  /** Printable call — token rendered as `Bot $NAME` / `Bot [redacted]`. */
  readonly display: {
    readonly method: "PATCH";
    readonly endpoint: string;
    readonly payload: { readonly interactions_endpoint_url: string };
    readonly authorization: string;
    readonly inviteUrl: string;
  };
  /** The real call. Absent when an env-ref is unset (see `missingEnv`). */
  readonly request?: {
    readonly endpoint: string;
    readonly payload: { readonly interactions_endpoint_url: string };
    readonly authorization: string;
  };
  /** Invite URL with the RESOLVED application id (needs no secret — the id
   *  is public); absent when the id's env-ref is unset. */
  readonly inviteUrl?: string;
  readonly missingEnv: ReadonlyArray<MissingEnvRef>;
};

function discordInviteUrl(applicationId: string): string {
  // bot → the REST sends; applications.commands → slash commands invokable.
  // No percent-encoding: real ids are numeric snowflakes, and the dry-run
  // placeholder ($DISCORD_APPLICATION_ID) must stay readable.
  return `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot+applications.commands&permissions=${DISCORD_PERMISSION_BITS}`;
}

/**
 * Build the interactions-endpoint registration: PATCH `applications/@me`
 * (Bot-token auth — the same token the adapter uses for its REST sends)
 * setting `interactions_endpoint_url` to the daemon's `/discord/events`
 * route. Discord VALIDATES the URL during the PATCH (it sends a PING plus a
 * bad-signature probe), so the daemon must be live at `--base-url` first.
 */
export function buildDiscordProvision(
  cfg: IrDiscordConfig,
  baseUrl: string,
  env: NodeJS.ProcessEnv,
): DiscordProvision {
  const apiBase = env["DISCORD_API_BASE_URL"] ?? DEFAULT_DISCORD_API_BASE_URL;
  const endpoint = `${apiBase}/applications/@me`;
  const payload = { interactions_endpoint_url: joinBaseUrl(baseUrl, channelEventsPath("discord")) };
  const display = {
    method: "PATCH" as const,
    endpoint,
    payload,
    authorization: `Bot ${describeSecretRef(cfg.botToken)}`,
    inviteUrl: discordInviteUrl(describeSecretRef(cfg.applicationId)),
  };
  const missingEnv = collectMissing(
    [
      { label: "channels.discord.applicationId", ref: cfg.applicationId },
      { label: "channels.discord.botToken", ref: cfg.botToken },
    ],
    env,
  );
  if (missingEnv.length > 0) return { display, missingEnv };
  return {
    display,
    missingEnv,
    request: {
      endpoint,
      payload,
      authorization: `Bot ${resolveSecretRef("channels.discord.botToken", cfg.botToken, env)}`,
    },
    inviteUrl: discordInviteUrl(
      resolveSecretRef("channels.discord.applicationId", cfg.applicationId, env),
    ),
  };
}

export type DiscordProvisionResult = {
  /** `interactions_endpoint_url` found on the application BEFORE the PATCH
   *  (undefined when none was set). */
  readonly previousEndpoint?: string;
  /** True when a different pre-existing endpoint was overwritten (--force). */
  readonly replacedPrevious: boolean;
};

/**
 * Perform the registration, read-before-write (adversarial-review F5): GET
 * `applications/@me` first, and if an `interactions_endpoint_url` is already
 * set to something OTHER than the daemon route, refuse to overwrite it
 * unless `force` is set — silently clobbering it would detach whatever
 * service the application currently points at (the same stance as `state
 * restore`, which refuses to overwrite without --force). A 4xx on the PATCH
 * usually means Discord's live endpoint validation failed — surfaced with
 * that hint.
 */
export async function performDiscordProvision(
  provision: DiscordProvision,
  fetchImpl: FetchLike = fetch,
  opts: { readonly force?: boolean } = {},
): Promise<DiscordProvisionResult> {
  const request = provision.request;
  if (request === undefined) {
    throw new ChannelApiError(
      `interactions endpoint not registered — unset env: ${provision.missingEnv.map((m) => `$${m.envName}`).join(", ")}`,
    );
  }

  let getRes: Response;
  try {
    getRes = await fetchImpl(request.endpoint, {
      method: "GET",
      headers: { Authorization: request.authorization },
    });
  } catch (err) {
    throw new ChannelApiError(`GET ${request.endpoint} unreachable: ${(err as Error).message}`);
  }
  if (!getRes.ok) {
    throw new ChannelApiError(
      `GET ${request.endpoint} failed: ${getRes.status} ${getRes.statusText} — cannot read the existing interactions endpoint, so no overwrite was attempted`,
    );
  }
  const app = (await getRes.json().catch(() => ({}))) as {
    interactions_endpoint_url?: string | null;
  };
  const previousEndpoint =
    typeof app.interactions_endpoint_url === "string" && app.interactions_endpoint_url !== ""
      ? app.interactions_endpoint_url
      : undefined;
  const target = request.payload.interactions_endpoint_url;
  const wouldReplace = previousEndpoint !== undefined && previousEndpoint !== target;
  if (wouldReplace && opts.force !== true) {
    throw new ChannelApiError(
      `interactions_endpoint_url is already set to "${previousEndpoint}" — refusing to overwrite it with "${target}" (that would detach whatever currently serves it); re-run with --force to replace`,
    );
  }

  let res: Response;
  try {
    res = await fetchImpl(request.endpoint, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: request.authorization,
      },
      body: JSON.stringify(request.payload),
    });
  } catch (err) {
    throw new ChannelApiError(`PATCH ${request.endpoint} unreachable: ${(err as Error).message}`);
  }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (typeof body.message === "string") detail = `${detail} — ${body.message}`;
    } catch {
      // non-JSON error body — status line is all we have
    }
    throw new ChannelApiError(
      `PATCH ${request.endpoint} failed: ${detail} (Discord validates the interactions endpoint live — the daemon must be running and reachable at the --base-url when you provision)`,
    );
  }
  return {
    ...(previousEndpoint !== undefined ? { previousEndpoint } : {}),
    replacedPrevious: wouldReplace,
  };
}

/** Post-registration instructions: the invite URL plus the command-
 *  registration note (see the module header for why commands aren't
 *  auto-registered: the spec declares none and the adapter accepts any). */
export function discordNextSteps(inviteUrl: string): ReadonlyArray<string> {
  return [
    `1. invite the bot with the derived permission bits (${DISCORD_PERMISSIONS.map((p) => p.name).join(", ")}):`,
    `   ${inviteUrl}`,
    "2. register the slash command(s) your users should invoke — the adapter routes",
    '   ANY command to the agent (rendered as "/<name> <options>"), and the spec',
    "   declares no command list, so names are yours to choose:",
    `   PUT ${DEFAULT_DISCORD_API_BASE_URL}/applications/<application-id>/commands`,
    "3. re-run `crewhaus channel verify --platform discord` to confirm the endpoint",
  ];
}

// ---------------------------------------------------------------------------
// Verify — doctor-style probes
// ---------------------------------------------------------------------------

/** Shape shared with `index.ts`'s DoctorCheck and audit-verify's
 *  AuditIntegrityCheck (label/pass/warn/reason). */
export type ChannelCheck = {
  readonly label: string;
  readonly pass: boolean;
  /** warn+pass renders as "~" — informational, never fails verify. */
  readonly warn?: boolean;
  readonly reason?: string;
};

export type ChannelVerifyOptions = {
  readonly env: NodeJS.ProcessEnv;
  readonly fetchImpl?: FetchLike;
  /** When set, webhook/endpoint URLs are asserted against the daemon route
   *  under this origin; when absent those checks degrade to informational. */
  readonly baseUrl?: string;
};

function envRefCheck(
  label: string,
  fieldLabel: string,
  ref: IrSecretRef,
  env: NodeJS.ProcessEnv,
): ChannelCheck {
  if (ref.kind === "literal") {
    return {
      label,
      pass: true,
      warn: true,
      reason: `${fieldLabel} is an inline literal — prefer a $ENV ref so the value stays out of the spec`,
    };
  }
  const set = env[ref.name] !== undefined && env[ref.name] !== "";
  return set
    ? { label, pass: true }
    : {
        label,
        pass: false,
        reason: `${fieldLabel} references $${ref.name} but it is unset — the daemon exits at boot without it`,
      };
}

/**
 * Slack probes: `auth.test` with the bot token (identity + reachability),
 * then the token's GRANTED scopes — Slack returns them on every Web API
 * response in the `x-oauth-scopes` header — diffed against the needed set
 * from {@link deriveSlackScopes}. The signing secret is only checked for
 * presence: Slack never exposes it back over the API.
 */
export async function verifySlackChannel(
  cfg: IrSlackConfig,
  spec: { readonly channelReactions: boolean },
  opts: ChannelVerifyOptions,
): Promise<ChannelCheck[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = opts.env["SLACK_API_BASE_URL"] ?? DEFAULT_SLACK_API_BASE_URL;
  const checks: ChannelCheck[] = [];

  checks.push(
    envRefCheck(
      "Slack signing secret",
      "channels.slack.signingSecret",
      cfg.signingSecret,
      opts.env,
    ),
  );

  let botToken: string;
  try {
    botToken = resolveSecretRef("channels.slack.botToken", cfg.botToken, opts.env);
  } catch (err) {
    checks.push({ label: "Slack bot token", pass: false, reason: (err as Error).message });
    return checks;
  }

  let res: Response;
  try {
    res = await fetchImpl(`${apiBase}/auth.test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${botToken}` },
    });
  } catch (err) {
    checks.push({
      label: "Slack auth.test",
      pass: false,
      reason: `Slack API unreachable: ${(err as Error).message}`,
    });
    return checks;
  }
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    team?: string;
    user?: string;
  };
  if (body.ok !== true) {
    checks.push({
      label: "Slack auth.test",
      pass: false,
      reason: `token rejected: ${body.error ?? `${res.status} ${res.statusText}`}`,
    });
    return checks;
  }
  checks.push({
    label: `Slack auth.test (team ${body.team ?? "?"}, bot user ${body.user ?? "?"})`,
    pass: true,
  });

  const needed = deriveSlackScopes(spec).map((s) => s.scope);
  const grantedHeader = res.headers.get("x-oauth-scopes");
  if (grantedHeader === null) {
    checks.push({
      label: "Slack bot scopes",
      pass: true,
      warn: true,
      reason: "Slack did not return x-oauth-scopes — granted scopes could not be compared",
    });
    return checks;
  }
  const granted = new Set(
    grantedHeader
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  );
  const missing = needed.filter((s) => !granted.has(s));
  checks.push(
    missing.length === 0
      ? { label: `Slack bot scopes (${needed.length} needed, all granted)`, pass: true }
      : {
          label: "Slack bot scopes",
          pass: false,
          reason: `missing: ${missing.join(", ")} — update the app from the manifest (crewhaus channel provision --platform slack) and re-install`,
        },
  );
  return checks;
}

/**
 * Telegram probes: `getWebhookInfo`, compared against the daemon route.
 * Telegram never returns the configured secret_token (write-only by design),
 * so the secret is checked for presence on the daemon side — the adapter
 * rejects every inbound POST if the two ever diverge, which surfaces as
 * pending updates + a 401 last_error here.
 */
export async function verifyTelegramChannel(
  cfg: IrTelegramConfig,
  opts: ChannelVerifyOptions,
): Promise<ChannelCheck[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = opts.env["TELEGRAM_API_BASE_URL"] ?? DEFAULT_TELEGRAM_API_BASE_URL;
  const checks: ChannelCheck[] = [];

  checks.push(
    envRefCheck(
      "Telegram secret token (daemon side; Telegram never returns it)",
      "channels.telegram.secretToken",
      cfg.secretToken,
      opts.env,
    ),
  );

  let botToken: string;
  try {
    botToken = resolveSecretRef("channels.telegram.botToken", cfg.botToken, opts.env);
  } catch (err) {
    checks.push({ label: "Telegram bot token", pass: false, reason: (err as Error).message });
    return checks;
  }

  const redactedEndpoint = `${apiBase}/bot${describeSecretRef(cfg.botToken)}/getWebhookInfo`;
  let res: Response;
  try {
    res = await fetchImpl(`${apiBase}/bot${botToken}/getWebhookInfo`, { method: "GET" });
  } catch (err) {
    checks.push({
      label: "Telegram getWebhookInfo",
      pass: false,
      reason: `${redactedEndpoint} unreachable: ${(err as Error).message}`,
    });
    return checks;
  }
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    description?: string;
    result?: {
      url?: string;
      pending_update_count?: number;
      last_error_date?: number;
      last_error_message?: string;
      allowed_updates?: ReadonlyArray<string>;
    };
  };
  if (body.ok !== true || body.result === undefined) {
    checks.push({
      label: "Telegram getWebhookInfo",
      pass: false,
      reason: `token rejected: ${body.description ?? `${res.status} ${res.statusText}`}`,
    });
    return checks;
  }
  checks.push({ label: "Telegram getWebhookInfo", pass: true });
  const info = body.result;

  const url = info.url ?? "";
  if (url === "") {
    checks.push({
      label: "Telegram webhook url",
      pass: false,
      reason: "no webhook registered — run `crewhaus channel provision --platform telegram`",
    });
  } else if (opts.baseUrl !== undefined) {
    const expected = joinBaseUrl(opts.baseUrl, channelEventsPath("telegram"));
    checks.push(
      url === expected
        ? { label: `Telegram webhook url (${url})`, pass: true }
        : {
            label: "Telegram webhook url",
            pass: false,
            reason: `registered "${url}" but this daemon expects "${expected}" — re-run provision`,
          },
    );
  } else {
    checks.push({
      label: "Telegram webhook url",
      pass: true,
      warn: true,
      reason: `registered as ${url} — pass --base-url to assert it matches this daemon`,
    });
  }

  const allowedUpdates = info.allowed_updates;
  if (allowedUpdates !== undefined) {
    const missing = TELEGRAM_ALLOWED_UPDATES.filter((u) => !allowedUpdates.includes(u));
    if (missing.length > 0) {
      checks.push({
        label: "Telegram allowed_updates",
        pass: true,
        warn: true,
        reason: `webhook does not deliver: ${missing.join(", ")} — the adapter consumes them; re-run provision to restore`,
      });
    } else {
      checks.push({ label: "Telegram allowed_updates", pass: true });
    }
  }

  const pending = info.pending_update_count ?? 0;
  if (pending > 0) {
    checks.push({
      label: "Telegram pending updates",
      pass: true,
      warn: true,
      reason: `${pending} update(s) queued — the daemon may be unreachable at the webhook url`,
    });
  }
  if (info.last_error_message !== undefined && info.last_error_message !== "") {
    const at =
      info.last_error_date !== undefined
        ? ` at ${new Date(info.last_error_date * 1000).toISOString()}`
        : "";
    checks.push({
      label: "Telegram last delivery error",
      pass: true,
      warn: true,
      reason: `${info.last_error_message}${at}`,
    });
  }
  return checks;
}

/**
 * Discord probes: `GET applications/@me` with the bot token, asserting the
 * three facts the adapter depends on — the token belongs to the declared
 * `applicationId`, the application's `verify_key` equals the spec's
 * `publicKeyHex` (a mismatch means every inbound webhook fails Ed25519
 * verification with a 401), and `interactions_endpoint_url` points at the
 * daemon's `/discord/events` route.
 */
export async function verifyDiscordChannel(
  cfg: IrDiscordConfig,
  opts: ChannelVerifyOptions,
): Promise<ChannelCheck[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = opts.env["DISCORD_API_BASE_URL"] ?? DEFAULT_DISCORD_API_BASE_URL;
  const checks: ChannelCheck[] = [];

  let botToken: string;
  try {
    botToken = resolveSecretRef("channels.discord.botToken", cfg.botToken, opts.env);
  } catch (err) {
    checks.push({ label: "Discord bot token", pass: false, reason: (err as Error).message });
    return checks;
  }

  let res: Response;
  try {
    res = await fetchImpl(`${apiBase}/applications/@me`, {
      method: "GET",
      headers: { Authorization: `Bot ${botToken}` },
    });
  } catch (err) {
    checks.push({
      label: "Discord application fetch",
      pass: false,
      reason: `${apiBase}/applications/@me unreachable: ${(err as Error).message}`,
    });
    return checks;
  }
  if (!res.ok) {
    checks.push({
      label: "Discord application fetch",
      pass: false,
      reason: `token rejected: ${res.status} ${res.statusText}`,
    });
    return checks;
  }
  const app = (await res.json().catch(() => ({}))) as {
    id?: string;
    name?: string;
    verify_key?: string;
    interactions_endpoint_url?: string | null;
  };
  checks.push({ label: `Discord application fetch (${app.name ?? "?"})`, pass: true });

  try {
    const declaredId = resolveSecretRef(
      "channels.discord.applicationId",
      cfg.applicationId,
      opts.env,
    );
    checks.push(
      app.id === declaredId
        ? { label: `Discord application id (${declaredId})`, pass: true }
        : {
            label: "Discord application id",
            pass: false,
            reason: `bot token belongs to application ${app.id ?? "?"} but the spec declares ${declaredId}`,
          },
    );
  } catch (err) {
    checks.push({ label: "Discord application id", pass: false, reason: (err as Error).message });
  }

  try {
    const declaredKey = resolveSecretRef(
      "channels.discord.publicKeyHex",
      cfg.publicKeyHex,
      opts.env,
    );
    checks.push(
      app.verify_key === declaredKey
        ? { label: "Discord public key matches verify_key", pass: true }
        : {
            label: "Discord public key",
            pass: false,
            reason:
              "spec publicKeyHex differs from the application's verify_key — every inbound webhook will fail Ed25519 verification (401)",
          },
    );
  } catch (err) {
    checks.push({ label: "Discord public key", pass: false, reason: (err as Error).message });
  }

  const endpointUrl = app.interactions_endpoint_url ?? "";
  if (endpointUrl === "") {
    checks.push({
      label: "Discord interactions endpoint",
      pass: false,
      reason:
        "not set — the adapter is webhook-based; run `crewhaus channel provision --platform discord`",
    });
  } else if (opts.baseUrl !== undefined) {
    const expected = joinBaseUrl(opts.baseUrl, channelEventsPath("discord"));
    checks.push(
      endpointUrl === expected
        ? { label: `Discord interactions endpoint (${endpointUrl})`, pass: true }
        : {
            label: "Discord interactions endpoint",
            pass: false,
            reason: `set to "${endpointUrl}" but this daemon expects "${expected}" — re-run provision`,
          },
    );
  } else {
    checks.push({
      label: "Discord interactions endpoint",
      pass: true,
      warn: true,
      reason: `set to ${endpointUrl} — pass --base-url to assert it matches this daemon`,
    });
  }
  return checks;
}

/** Redacted one-liners describing what `verify` would call — the dry-run
 *  counterpart for the probes (network never happens under --dry-run). */
export function describeVerifyProbes(
  platform: ChannelPlatform,
  channels: IrChannels,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> {
  if (platform === "slack" && channels.slack !== undefined) {
    const apiBase = env["SLACK_API_BASE_URL"] ?? DEFAULT_SLACK_API_BASE_URL;
    return [
      `would POST ${apiBase}/auth.test (Authorization: Bearer ${describeSecretRef(channels.slack.botToken)})`,
      "would compare the x-oauth-scopes response header against the derived scope set",
    ];
  }
  if (platform === "telegram" && channels.telegram !== undefined) {
    const apiBase = env["TELEGRAM_API_BASE_URL"] ?? DEFAULT_TELEGRAM_API_BASE_URL;
    return [
      `would GET ${apiBase}/bot${describeSecretRef(channels.telegram.botToken)}/getWebhookInfo`,
    ];
  }
  if (platform === "discord" && channels.discord !== undefined) {
    const apiBase = env["DISCORD_API_BASE_URL"] ?? DEFAULT_DISCORD_API_BASE_URL;
    return [
      `would GET ${apiBase}/applications/@me (Authorization: Bot ${describeSecretRef(channels.discord.botToken)})`,
    ];
  }
  return [];
}

export type ChannelVerifySummary = {
  readonly lines: ReadonlyArray<string>;
  readonly exitCode: 0 | 1;
};

/** Render checks as the doctor's ✓/~/✗ lines + the exit code — non-zero on
 *  any hard failure (missing scopes, mismatched webhook, bad credentials);
 *  warns are informational. Mirrors audit-verify's `summarizeVerifyResult`. */
export function summarizeChannelChecks(checks: ReadonlyArray<ChannelCheck>): ChannelVerifySummary {
  const lines = checks.map((c) => {
    if (c.warn === true && c.pass) return `~ ${c.label}: ${c.reason ?? "informational"}`;
    if (c.pass) return `✓ ${c.label}`;
    return `✗ ${c.label}: ${c.reason ?? "failed"}`;
  });
  const failed = checks.filter((c) => !c.pass).length;
  return {
    lines: [
      ...lines,
      `${checks.length} check(s), ${failed} failed${failed > 0 ? "" : " — channel wiring looks healthy"}`,
    ],
    exitCode: failed > 0 ? 1 : 0,
  };
}
