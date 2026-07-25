/**
 * Item 61 — unit tests for the `crewhaus channel provision|verify` core:
 * platform-flag resolution, env-ref resolution, adapter-derived Slack
 * manifest generation (scopes + event subscriptions), the Telegram
 * setWebhook plan/call, the Discord interactions-endpoint plan/call + invite
 * URL, the doctor-style verify probes, and the verdict summariser. All specs
 * go through the REAL parseSpec → lower pipeline (env-ref lowering included)
 * and all network goes through an injected fake fetch — no credentials, no
 * sockets.
 */
import { describe, expect, test } from "bun:test";
import { compile, lower } from "@crewhaus/compiler";
import type { IrChannelV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import {
  CHANNEL_ENV_PLATFORMS,
  ChannelApiError,
  ChannelEnvRefError,
  DISCORD_PERMISSION_BITS,
  InvalidBaseUrlError,
  InvalidPlatformFlagError,
  REDACTED_LITERAL,
  TELEGRAM_ALLOWED_UPDATES,
  buildDiscordProvision,
  buildSlackManifest,
  buildTelegramProvision,
  channelEnvChecks,
  channelEventsPath,
  collectProvisionMissingEnv,
  deriveSlackBotEvents,
  deriveSlackScopes,
  describeSecretRef,
  describeVerifyProbes,
  joinBaseUrl,
  modelCredentialChecks,
  modelCredentialGroups,
  performDiscordProvision,
  performTelegramSetWebhook,
  platformSecretRefs,
  renderSlackManifestYaml,
  resolvePlatformsFlag,
  resolveSecretRef,
  summarizeChannelChecks,
  verifyDiscordChannel,
  verifySlackChannel,
  verifyTelegramChannel,
} from "./channel-provision";

const BASE_URL = "https://bot.example.com";

/** Mirrors apps/cli/test-fixtures/minimal-channel/crewhaus.yaml — all three
 *  supported platforms as env-refs, reaction feedback ON. */
const CHANNEL_SPEC = `
name: support-bot
target: channel
agent:
  model: claude-sonnet-4-6
  instructions: Answer support questions briefly.
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
  telegram:
    botToken: $TELEGRAM_BOT_TOKEN
    secretToken: $TELEGRAM_SECRET_TOKEN
  discord:
    applicationId: $DISCORD_APPLICATION_ID
    botToken: $DISCORD_BOT_TOKEN
    publicKeyHex: $DISCORD_PUBLIC_KEY
routing:
  sessionKey: channel
feedback:
  channelReactions: true
`;

const TELEGRAM_ONLY_SPEC = `
name: tg-bot
target: channel
agent:
  model: claude-sonnet-4-6
  instructions: Answer briefly.
channels:
  telegram:
    botToken: $TELEGRAM_BOT_TOKEN
    secretToken: literal-webhook-secret
routing:
  sessionKey: user
`;

const WHATSAPP_ONLY_SPEC = `
name: wa-bot
target: channel
agent:
  model: claude-sonnet-4-6
  instructions: Answer briefly.
channels:
  whatsapp:
    phoneNumberId: $WA_PHONE_ID
    accessToken: $WA_ACCESS_TOKEN
    appSecret: $WA_APP_SECRET
routing:
  sessionKey: channel
`;

/** Every channel the daemon's boot gate covers, all as env refs — the
 *  fixture for the boot-gate parity test below. */
const ALL_CHANNELS_SPEC = `
name: everywhere-bot
target: channel
agent:
  model: claude-sonnet-4-6
  instructions: Answer briefly.
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
  telegram:
    botToken: $TELEGRAM_BOT_TOKEN
    secretToken: $TELEGRAM_SECRET_TOKEN
  discord:
    applicationId: $DISCORD_APPLICATION_ID
    botToken: $DISCORD_BOT_TOKEN
    publicKeyHex: $DISCORD_PUBLIC_KEY
  whatsapp:
    phoneNumberId: $WA_PHONE_ID
    accessToken: $WA_ACCESS_TOKEN
    appSecret: $WA_APP_SECRET
    verifyToken: $WA_VERIFY_TOKEN
  imessage:
    chatDbPath: $IMESSAGE_CHAT_DB
    cursorPath: $IMESSAGE_CURSOR
routing:
  sessionKey: channel
`;

function channelIr(yaml: string = CHANNEL_SPEC): IrChannelV0 {
  const ir = lower(parseSpec(yaml));
  if (ir.target !== "channel") throw new Error("fixture must lower to a channel IR");
  return ir;
}

const PUBLIC_KEY_HEX = "a".repeat(64);

const FULL_ENV: NodeJS.ProcessEnv = {
  SLACK_BOT_TOKEN: "xoxb-real-slack-token",
  SLACK_SIGNING_SECRET: "slack-signing-secret",
  TELEGRAM_BOT_TOKEN: "123456:real-tg-token",
  TELEGRAM_SECRET_TOKEN: "real-webhook-secret",
  DISCORD_APPLICATION_ID: "app-123",
  DISCORD_BOT_TOKEN: "real-discord-token",
  DISCORD_PUBLIC_KEY: PUBLIC_KEY_HEX,
};

type FakeResponse = {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: unknown;
};

/** Injectable fetch capturing every call; the handler picks the response. */
function fakeFetch(handler: (url: string, init: RequestInit | undefined) => FakeResponse): {
  impl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const r = handler(url, init);
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      statusText: r.statusText ?? "",
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
  return { impl, calls };
}

describe("resolvePlatformsFlag", () => {
  test("defaults to every configured supported platform", () => {
    const { platforms, unsupported } = resolvePlatformsFlag(undefined, channelIr().channels);
    expect(platforms).toEqual(["slack", "telegram", "discord"]);
    expect(unsupported).toEqual([]);
  });

  test("explicit platform narrows the selection", () => {
    const { platforms } = resolvePlatformsFlag("telegram", channelIr().channels);
    expect(platforms).toEqual(["telegram"]);
  });

  test("rejects a platform the spec does not configure", () => {
    expect(() => resolvePlatformsFlag("slack", channelIr(TELEGRAM_ONLY_SPEC).channels)).toThrow(
      InvalidPlatformFlagError,
    );
  });

  test("rejects an unknown platform value", () => {
    expect(() => resolvePlatformsFlag("matrix", channelIr().channels)).toThrow(
      /expected one of: slack, telegram, discord, all/,
    );
  });

  test("surfaces configured-but-unsupported channels, and fails 'all' when nothing supported remains", () => {
    expect(() => resolvePlatformsFlag("all", channelIr(WHATSAPP_ONLY_SPEC).channels)).toThrow(
      /whatsapp/,
    );
  });
});

describe("resolveSecretRef / describeSecretRef", () => {
  test("literals pass through; env-refs read the environment", () => {
    const telegram = channelIr(TELEGRAM_ONLY_SPEC).channels.telegram;
    if (telegram === undefined) throw new Error("fixture telegram missing");
    expect(resolveSecretRef("channels.telegram.secretToken", telegram.secretToken, {})).toBe(
      "literal-webhook-secret",
    );
    expect(resolveSecretRef("channels.telegram.botToken", telegram.botToken, FULL_ENV)).toBe(
      "123456:real-tg-token",
    );
  });

  test("an unset env-ref throws with the field label and env name", () => {
    const telegram = channelIr(TELEGRAM_ONLY_SPEC).channels.telegram;
    if (telegram === undefined) throw new Error("fixture telegram missing");
    expect(() => resolveSecretRef("channels.telegram.botToken", telegram.botToken, {})).toThrow(
      ChannelEnvRefError,
    );
    expect(() =>
      resolveSecretRef("channels.telegram.botToken", telegram.botToken, {
        TELEGRAM_BOT_TOKEN: "",
      }),
    ).toThrow(/channels\.telegram\.botToken references \$TELEGRAM_BOT_TOKEN/);
  });

  test("describeSecretRef redacts literals and names env-refs", () => {
    expect(describeSecretRef({ kind: "env", name: "SLACK_BOT_TOKEN" })).toBe("$SLACK_BOT_TOKEN");
    expect(describeSecretRef({ kind: "literal", value: "hunter2" })).toBe(REDACTED_LITERAL);
  });
});

describe("joinBaseUrl", () => {
  test("normalizes trailing slashes and keeps base paths", () => {
    expect(joinBaseUrl("https://bot.example.com", "/slack/events")).toBe(
      "https://bot.example.com/slack/events",
    );
    expect(joinBaseUrl("https://bot.example.com/", "/slack/events")).toBe(
      "https://bot.example.com/slack/events",
    );
    expect(joinBaseUrl("https://example.com/tunnel/", "/telegram/events")).toBe(
      "https://example.com/tunnel/telegram/events",
    );
  });

  test("rejects garbage and non-http(s) protocols", () => {
    expect(() => joinBaseUrl("not a url", "/slack/events")).toThrow(InvalidBaseUrlError);
    expect(() => joinBaseUrl("ftp://example.com", "/slack/events")).toThrow(InvalidBaseUrlError);
  });
});

describe("Slack manifest generation", () => {
  test("derives the adapter's scope set; reactions:read only with channelReactions", () => {
    const withReactions = deriveSlackScopes({ channelReactions: true }).map((s) => s.scope);
    expect(withReactions).toEqual([
      "app_mentions:read",
      "channels:history",
      "groups:history",
      "im:history",
      "mpim:history",
      "chat:write",
      "reactions:write",
      "reactions:read",
    ]);
    const without = deriveSlackScopes({ channelReactions: false }).map((s) => s.scope);
    expect(without).not.toContain("reactions:read");
    // reactions:write stays — the session-router always attempts status acks.
    expect(without).toContain("reactions:write");
  });

  test("derives event subscriptions; reaction_added only with channelReactions", () => {
    expect(deriveSlackBotEvents({ channelReactions: true })).toContain("reaction_added");
    expect(deriveSlackBotEvents({ channelReactions: false })).not.toContain("reaction_added");
    expect(deriveSlackBotEvents({ channelReactions: false })).toEqual([
      "app_mention",
      "message.channels",
      "message.groups",
      "message.im",
      "message.mpim",
    ]);
  });

  test("builds a complete manifest from a real lowered channel spec", () => {
    const ir = channelIr();
    const manifest = buildSlackManifest(
      { name: ir.name, channelReactions: ir.feedback?.channelReactions === true },
      BASE_URL,
    );
    expect(manifest.display_information.name).toBe("support-bot");
    expect(manifest.settings.event_subscriptions.request_url).toBe(
      "https://bot.example.com/slack/events",
    );
    expect(manifest.settings.event_subscriptions.bot_events).toContain("reaction_added");
    expect(manifest.oauth_config.scopes.bot).toContain("reactions:read");
    // The daemon is a webhook server; the spec's appToken is reserved/unused.
    expect(manifest.settings.socket_mode_enabled).toBe(false);
  });

  test("renders manifest YAML with quoted scalars and nested lists", () => {
    const ir = channelIr();
    const yaml = renderSlackManifestYaml(
      buildSlackManifest({ name: ir.name, channelReactions: true }, BASE_URL),
    );
    expect(yaml).toContain('    request_url: "https://bot.example.com/slack/events"');
    expect(yaml).toContain('      - "chat:write"');
    expect(yaml).toContain('      - "reaction_added"');
    expect(yaml).toContain("  socket_mode_enabled: false");
    // Quoting survives a name that would need escaping in YAML.
    expect(yaml).toContain('  name: "support-bot"');
    expect(yaml.endsWith("\n")).toBe(true);
  });
});

describe("Telegram setWebhook provision", () => {
  test("builds the exact call: daemon route, adapter-verified secret, consumed update kinds", () => {
    const telegram = channelIr().channels.telegram;
    if (telegram === undefined) throw new Error("fixture telegram missing");
    const provision = buildTelegramProvision(telegram, BASE_URL, FULL_ENV);
    expect(provision.missingEnv).toEqual([]);
    expect(provision.request?.endpoint).toBe(
      "https://api.telegram.org/bot123456:real-tg-token/setWebhook",
    );
    expect(provision.request?.payload).toEqual({
      url: "https://bot.example.com/telegram/events",
      secret_token: "real-webhook-secret",
      allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
    });
  });

  test("display form redacts the bot token and secret", () => {
    const telegram = channelIr().channels.telegram;
    if (telegram === undefined) throw new Error("fixture telegram missing");
    const provision = buildTelegramProvision(telegram, BASE_URL, FULL_ENV);
    expect(provision.display.endpoint).toBe(
      "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook",
    );
    expect(provision.display.payload.secret_token).toBe("$TELEGRAM_SECRET_TOKEN");
    expect(JSON.stringify(provision.display)).not.toContain("real-tg-token");
    expect(JSON.stringify(provision.display)).not.toContain("real-webhook-secret");
  });

  test("unset env-refs surface in missingEnv instead of a request (dry-run stays credential-free)", () => {
    const telegram = channelIr().channels.telegram;
    if (telegram === undefined) throw new Error("fixture telegram missing");
    const provision = buildTelegramProvision(telegram, BASE_URL, {});
    expect(provision.request).toBeUndefined();
    expect(provision.missingEnv.map((m) => m.envName)).toEqual([
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_SECRET_TOKEN",
    ]);
    // The printable plan still renders — with placeholders.
    expect(provision.display.payload.url).toBe("https://bot.example.com/telegram/events");
  });

  test("performs the POST and returns Telegram's description", async () => {
    const telegram = channelIr().channels.telegram;
    if (telegram === undefined) throw new Error("fixture telegram missing");
    const provision = buildTelegramProvision(telegram, BASE_URL, FULL_ENV);
    const { impl, calls } = fakeFetch(() => ({
      body: { ok: true, description: "Webhook was set" },
    }));
    await expect(performTelegramSetWebhook(provision, impl)).resolves.toBe("Webhook was set");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.telegram.org/bot123456:real-tg-token/setWebhook");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      url: "https://bot.example.com/telegram/events",
      secret_token: "real-webhook-secret",
      allowed_updates: ["message", "edited_message", "callback_query"],
    });
  });

  test("logical and HTTP failures throw ChannelApiError with the REDACTED endpoint", async () => {
    const telegram = channelIr().channels.telegram;
    if (telegram === undefined) throw new Error("fixture telegram missing");
    const provision = buildTelegramProvision(telegram, BASE_URL, FULL_ENV);

    const logical = fakeFetch(() => ({
      body: { ok: false, description: "bad webhook: HTTPS url must be provided" },
    }));
    await expect(performTelegramSetWebhook(provision, logical.impl)).rejects.toThrow(
      /bad webhook: HTTPS url must be provided/,
    );
    const err = await performTelegramSetWebhook(provision, logical.impl).catch((e) => e as Error);
    expect(err).toBeInstanceOf(ChannelApiError);
    expect(err.message).toContain("$TELEGRAM_BOT_TOKEN");
    expect(err.message).not.toContain("real-tg-token");

    const http = fakeFetch(() => ({ status: 404, statusText: "Not Found" }));
    await expect(performTelegramSetWebhook(provision, http.impl)).rejects.toThrow(/404/);
  });

  test("refuses to perform with unresolved env instead of sending empty secrets", async () => {
    const telegram = channelIr().channels.telegram;
    if (telegram === undefined) throw new Error("fixture telegram missing");
    const provision = buildTelegramProvision(telegram, BASE_URL, {});
    const { impl, calls } = fakeFetch(() => ({ body: { ok: true } }));
    await expect(performTelegramSetWebhook(provision, impl)).rejects.toThrow(
      /\$TELEGRAM_BOT_TOKEN/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("Discord interactions-endpoint provision", () => {
  test("builds the PATCH applications/@me call + adapter-derived invite URL", () => {
    const discord = channelIr().channels.discord;
    if (discord === undefined) throw new Error("fixture discord missing");
    const provision = buildDiscordProvision(discord, BASE_URL, FULL_ENV);
    expect(provision.missingEnv).toEqual([]);
    expect(provision.request?.endpoint).toBe("https://discord.com/api/v10/applications/@me");
    expect(provision.request?.payload).toEqual({
      interactions_endpoint_url: "https://bot.example.com/discord/events",
    });
    expect(provision.request?.authorization).toBe("Bot real-discord-token");
    // View Channel (1<<10) + Send Messages (1<<11) + Send Messages in Threads (1<<38)
    expect(DISCORD_PERMISSION_BITS).toBe(1024 + 2048 + 2 ** 38);
    expect(provision.inviteUrl).toBe(
      `https://discord.com/oauth2/authorize?client_id=app-123&scope=bot+applications.commands&permissions=${DISCORD_PERMISSION_BITS}`,
    );
  });

  test("display form redacts the bot token; missing env is surfaced", () => {
    const discord = channelIr().channels.discord;
    if (discord === undefined) throw new Error("fixture discord missing");
    const withEnv = buildDiscordProvision(discord, BASE_URL, FULL_ENV);
    expect(withEnv.display.authorization).toBe("Bot $DISCORD_BOT_TOKEN");
    expect(JSON.stringify(withEnv.display)).not.toContain("real-discord-token");

    const withoutEnv = buildDiscordProvision(discord, BASE_URL, {});
    expect(withoutEnv.request).toBeUndefined();
    expect(withoutEnv.inviteUrl).toBeUndefined();
    expect(withoutEnv.missingEnv.map((m) => m.envName)).toEqual([
      "DISCORD_APPLICATION_ID",
      "DISCORD_BOT_TOKEN",
    ]);
  });

  test("performs the PATCH (after the pre-read); a rejection carries the live-validation hint", async () => {
    const discord = channelIr().channels.discord;
    if (discord === undefined) throw new Error("fixture discord missing");
    const provision = buildDiscordProvision(discord, BASE_URL, FULL_ENV);

    const ok = fakeFetch(() => ({ body: { id: "app-123" } }));
    const result = await performDiscordProvision(provision, ok.impl);
    // Read-before-write: GET applications/@me first, then the PATCH.
    expect(ok.calls).toHaveLength(2);
    expect(ok.calls[0]?.init?.method).toBe("GET");
    expect(ok.calls[1]?.init?.method).toBe("PATCH");
    expect(
      (ok.calls[1]?.init?.headers as Record<string, string> | undefined)?.["Authorization"],
    ).toBe("Bot real-discord-token");
    expect(result.previousEndpoint).toBeUndefined();
    expect(result.replacedPrevious).toBe(false);

    const bad = fakeFetch((_url, init) =>
      init?.method === "GET"
        ? { body: { id: "app-123" } }
        : {
            status: 400,
            statusText: "Bad Request",
            body: { message: "Invalid interactions endpoint url" },
          },
    );
    const err = await performDiscordProvision(provision, bad.impl).catch((e) => e as Error);
    expect(err).toBeInstanceOf(ChannelApiError);
    expect((err as Error).message).toContain("Invalid interactions endpoint url");
    expect((err as Error).message).toContain("daemon must be running");
  });
});

describe("Discord read-before-write overwrite guard (adversarial-review F5)", () => {
  const PREVIOUS = "https://other-service.example.com/interactions";

  function provisionWithExisting(existing: string | null): {
    provision: ReturnType<typeof buildDiscordProvision>;
    impl: typeof fetch;
    calls: Array<{ url: string; init: RequestInit | undefined }>;
  } {
    const discord = channelIr().channels.discord;
    if (discord === undefined) throw new Error("fixture discord missing");
    const provision = buildDiscordProvision(discord, BASE_URL, FULL_ENV);
    const { impl, calls } = fakeFetch((_url, init) =>
      init?.method === "GET"
        ? { body: { id: "app-123", interactions_endpoint_url: existing } }
        : { body: { id: "app-123" } },
    );
    return { provision, impl, calls };
  }

  test("refuses to overwrite a DIFFERENT pre-existing endpoint without --force (no PATCH sent)", async () => {
    const { provision, impl, calls } = provisionWithExisting(PREVIOUS);
    const err = await performDiscordProvision(provision, impl).catch((e) => e as Error);
    expect(err).toBeInstanceOf(ChannelApiError);
    expect((err as Error).message).toContain(PREVIOUS); // says what it was
    expect((err as Error).message).toContain("--force");
    expect(calls).toHaveLength(1); // GET only — the write never happened
    expect(calls[0]?.init?.method).toBe("GET");
  });

  test("--force replaces a differing endpoint and reports what it was", async () => {
    const { provision, impl, calls } = provisionWithExisting(PREVIOUS);
    const result = await performDiscordProvision(provision, impl, { force: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.init?.method).toBe("PATCH");
    expect(result.previousEndpoint).toBe(PREVIOUS);
    expect(result.replacedPrevious).toBe(true);
  });

  test("an unset or already-matching endpoint proceeds without --force", async () => {
    const unset = provisionWithExisting(null);
    const unsetResult = await performDiscordProvision(unset.provision, unset.impl);
    expect(unset.calls[1]?.init?.method).toBe("PATCH");
    expect(unsetResult.replacedPrevious).toBe(false);

    const same = provisionWithExisting("https://bot.example.com/discord/events");
    const sameResult = await performDiscordProvision(same.provision, same.impl);
    expect(same.calls[1]?.init?.method).toBe("PATCH"); // idempotent re-run is fine
    expect(sameResult.previousEndpoint).toBe("https://bot.example.com/discord/events");
    expect(sameResult.replacedPrevious).toBe(false);
  });

  test("a failed pre-read blocks the write (fails closed)", async () => {
    const discord = channelIr().channels.discord;
    if (discord === undefined) throw new Error("fixture discord missing");
    const provision = buildDiscordProvision(discord, BASE_URL, FULL_ENV);
    const { impl, calls } = fakeFetch((_url, init) =>
      init?.method === "GET" ? { status: 401, statusText: "Unauthorized" } : { body: {} },
    );
    const err = await performDiscordProvision(provision, impl).catch((e) => e as Error);
    expect(err).toBeInstanceOf(ChannelApiError);
    expect((err as Error).message).toContain("no overwrite was attempted");
    expect(calls).toHaveLength(1);
  });
});

describe("verifySlackChannel", () => {
  const slackCfg = () => {
    const slack = channelIr().channels.slack;
    if (slack === undefined) throw new Error("fixture slack missing");
    return slack;
  };
  const allScopes = deriveSlackScopes({ channelReactions: true })
    .map((s) => s.scope)
    .join(", ");

  test("passes auth + full granted scopes", async () => {
    const { impl, calls } = fakeFetch(() => ({
      body: { ok: true, team: "acme", user: "support-bot" },
      headers: { "x-oauth-scopes": allScopes },
    }));
    const checks = await verifySlackChannel(
      slackCfg(),
      { channelReactions: true },
      { env: FULL_ENV, fetchImpl: impl },
    );
    expect(calls[0]?.url).toBe("https://slack.com/api/auth.test");
    expect(checks.every((c) => c.pass)).toBe(true);
    expect(checks.map((c) => c.label).join("\n")).toContain("all granted");
  });

  test("fails loudly on a missing scope (the ratings-feature reactions:read)", async () => {
    const granted = allScopes
      .split(", ")
      .filter((s) => s !== "reactions:read")
      .join(",");
    const { impl } = fakeFetch(() => ({
      body: { ok: true, team: "acme", user: "support-bot" },
      headers: { "x-oauth-scopes": granted },
    }));
    const checks = await verifySlackChannel(
      slackCfg(),
      { channelReactions: true },
      { env: FULL_ENV, fetchImpl: impl },
    );
    const scopeCheck = checks.find((c) => c.label === "Slack bot scopes");
    expect(scopeCheck?.pass).toBe(false);
    expect(scopeCheck?.reason).toContain("reactions:read");
  });

  test("fails on a rejected token and on an unreachable API", async () => {
    const rejected = fakeFetch(() => ({ body: { ok: false, error: "invalid_auth" } }));
    const rejectedChecks = await verifySlackChannel(
      slackCfg(),
      { channelReactions: true },
      { env: FULL_ENV, fetchImpl: rejected.impl },
    );
    expect(rejectedChecks.some((c) => !c.pass && c.reason?.includes("invalid_auth"))).toBe(true);

    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const downChecks = await verifySlackChannel(
      slackCfg(),
      { channelReactions: true },
      { env: FULL_ENV, fetchImpl: down },
    );
    expect(downChecks.some((c) => !c.pass && c.reason?.includes("unreachable"))).toBe(true);
  });

  test("an unset bot-token env fails without any network call", async () => {
    const { impl, calls } = fakeFetch(() => ({ body: { ok: true } }));
    const checks = await verifySlackChannel(
      slackCfg(),
      { channelReactions: true },
      { env: { SLACK_SIGNING_SECRET: "set" }, fetchImpl: impl },
    );
    expect(calls).toHaveLength(0);
    const tokenCheck = checks.find((c) => c.label === "Slack bot token");
    expect(tokenCheck?.pass).toBe(false);
    expect(tokenCheck?.reason).toContain("$SLACK_BOT_TOKEN");
  });

  test("a missing x-oauth-scopes header degrades to a warn, not a failure", async () => {
    const { impl } = fakeFetch(() => ({ body: { ok: true, team: "acme", user: "bot" } }));
    const checks = await verifySlackChannel(
      slackCfg(),
      { channelReactions: true },
      { env: FULL_ENV, fetchImpl: impl },
    );
    const scopeCheck = checks.find((c) => c.label === "Slack bot scopes");
    expect(scopeCheck?.pass).toBe(true);
    expect(scopeCheck?.warn).toBe(true);
  });
});

describe("verifyTelegramChannel", () => {
  const tgCfg = () => {
    const telegram = channelIr().channels.telegram;
    if (telegram === undefined) throw new Error("fixture telegram missing");
    return telegram;
  };
  const healthyInfo = {
    ok: true,
    result: {
      url: "https://bot.example.com/telegram/events",
      pending_update_count: 0,
      allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
    },
  };

  test("passes when the registered webhook matches the daemon route", async () => {
    const { impl, calls } = fakeFetch(() => ({ body: healthyInfo }));
    const checks = await verifyTelegramChannel(tgCfg(), {
      env: FULL_ENV,
      fetchImpl: impl,
      baseUrl: BASE_URL,
    });
    expect(calls[0]?.url).toBe("https://api.telegram.org/bot123456:real-tg-token/getWebhookInfo");
    expect(checks.every((c) => c.pass)).toBe(true);
  });

  test("fails on a mismatched or missing webhook url", async () => {
    const mismatch = fakeFetch(() => ({
      body: { ok: true, result: { url: "https://old.example.com/telegram/events" } },
    }));
    const mismatchChecks = await verifyTelegramChannel(tgCfg(), {
      env: FULL_ENV,
      fetchImpl: mismatch.impl,
      baseUrl: BASE_URL,
    });
    const urlCheck = mismatchChecks.find((c) => c.label === "Telegram webhook url");
    expect(urlCheck?.pass).toBe(false);
    expect(urlCheck?.reason).toContain("https://bot.example.com/telegram/events");

    const unset = fakeFetch(() => ({ body: { ok: true, result: { url: "" } } }));
    const unsetChecks = await verifyTelegramChannel(tgCfg(), {
      env: FULL_ENV,
      fetchImpl: unset.impl,
      baseUrl: BASE_URL,
    });
    expect(unsetChecks.some((c) => !c.pass && c.reason?.includes("no webhook registered"))).toBe(
      true,
    );
  });

  test("warns (never fails) on pending updates, delivery errors, and narrowed allowed_updates", async () => {
    const { impl } = fakeFetch(() => ({
      body: {
        ok: true,
        result: {
          url: "https://bot.example.com/telegram/events",
          pending_update_count: 7,
          last_error_date: 1_780_000_000,
          last_error_message: "Wrong response from the webhook: 401 Unauthorized",
          allowed_updates: ["message"],
        },
      },
    }));
    const checks = await verifyTelegramChannel(tgCfg(), {
      env: FULL_ENV,
      fetchImpl: impl,
      baseUrl: BASE_URL,
    });
    expect(checks.every((c) => c.pass)).toBe(true);
    const warns = checks.filter((c) => c.warn === true);
    expect(warns.map((c) => c.label)).toEqual(
      expect.arrayContaining([
        "Telegram allowed_updates",
        "Telegram pending updates",
        "Telegram last delivery error",
      ]),
    );
    expect(warns.find((c) => c.label === "Telegram allowed_updates")?.reason).toContain(
      "callback_query",
    );
  });

  test("an unset bot-token env fails without any network call; without --base-url the url check is informational", async () => {
    const noEnv = fakeFetch(() => ({ body: healthyInfo }));
    const noEnvChecks = await verifyTelegramChannel(tgCfg(), {
      env: { TELEGRAM_SECRET_TOKEN: "set" },
      fetchImpl: noEnv.impl,
    });
    expect(noEnv.calls).toHaveLength(0);
    expect(noEnvChecks.some((c) => !c.pass && c.reason?.includes("$TELEGRAM_BOT_TOKEN"))).toBe(
      true,
    );

    const noBase = fakeFetch(() => ({ body: healthyInfo }));
    const noBaseChecks = await verifyTelegramChannel(tgCfg(), {
      env: FULL_ENV,
      fetchImpl: noBase.impl,
    });
    const urlCheck = noBaseChecks.find((c) => c.label === "Telegram webhook url");
    expect(urlCheck?.pass).toBe(true);
    expect(urlCheck?.warn).toBe(true);
  });
});

describe("verifyDiscordChannel", () => {
  const dcCfg = () => {
    const discord = channelIr().channels.discord;
    if (discord === undefined) throw new Error("fixture discord missing");
    return discord;
  };
  const healthyApp = {
    id: "app-123",
    name: "support-bot",
    verify_key: PUBLIC_KEY_HEX,
    interactions_endpoint_url: "https://bot.example.com/discord/events",
  };

  test("passes when id, verify_key, and interactions endpoint all line up", async () => {
    const { impl, calls } = fakeFetch(() => ({ body: healthyApp }));
    const checks = await verifyDiscordChannel(dcCfg(), {
      env: FULL_ENV,
      fetchImpl: impl,
      baseUrl: BASE_URL,
    });
    expect(calls[0]?.url).toBe("https://discord.com/api/v10/applications/@me");
    expect((calls[0]?.init?.headers as Record<string, string> | undefined)?.["Authorization"]).toBe(
      "Bot real-discord-token",
    );
    expect(checks.every((c) => c.pass)).toBe(true);
  });

  test("fails on a verify_key mismatch (webhooks would 401 forever)", async () => {
    const { impl } = fakeFetch(() => ({
      body: { ...healthyApp, verify_key: "b".repeat(64) },
    }));
    const checks = await verifyDiscordChannel(dcCfg(), {
      env: FULL_ENV,
      fetchImpl: impl,
      baseUrl: BASE_URL,
    });
    // The boot-gate check ("Discord public key") only asserts the value is
    // present; the MATCH check is the one that fails here.
    expect(checks.find((c) => c.label === "Discord public key")?.pass).toBe(true);
    const keyCheck = checks.find((c) => c.label === "Discord public key match");
    expect(keyCheck?.pass).toBe(false);
    expect(keyCheck?.reason).toContain("Ed25519");
  });

  test("fails when the token belongs to a different application", async () => {
    const { impl } = fakeFetch(() => ({ body: { ...healthyApp, id: "other-app" } }));
    const checks = await verifyDiscordChannel(dcCfg(), {
      env: FULL_ENV,
      fetchImpl: impl,
      baseUrl: BASE_URL,
    });
    // Same split: the boot-gate "Discord application id" check passes (the
    // env var IS set); the ownership check is what catches the wrong app.
    expect(checks.find((c) => c.label === "Discord application id")?.pass).toBe(true);
    const idCheck = checks.find((c) => c.label === "Discord application id match");
    expect(idCheck?.pass).toBe(false);
    expect(idCheck?.reason).toContain("other-app");
  });

  test("fails on an unset interactions endpoint and on a rejected token", async () => {
    const noEndpoint = fakeFetch(() => ({
      body: { ...healthyApp, interactions_endpoint_url: null },
    }));
    const noEndpointChecks = await verifyDiscordChannel(dcCfg(), {
      env: FULL_ENV,
      fetchImpl: noEndpoint.impl,
      baseUrl: BASE_URL,
    });
    expect(
      noEndpointChecks.some((c) => !c.pass && c.label === "Discord interactions endpoint"),
    ).toBe(true);

    const unauthorized = fakeFetch(() => ({ status: 401, statusText: "Unauthorized" }));
    const unauthorizedChecks = await verifyDiscordChannel(dcCfg(), {
      env: FULL_ENV,
      fetchImpl: unauthorized.impl,
    });
    expect(unauthorizedChecks.some((c) => !c.pass && c.reason?.includes("token rejected"))).toBe(
      true,
    );
  });
});

describe("summarizeChannelChecks / verdict mapping", () => {
  test("renders ✓/~/✗ and exits 1 only on hard failures", () => {
    const summary = summarizeChannelChecks([
      { label: "Slack auth.test (team acme, bot user bot)", pass: true },
      { label: "Telegram pending updates", pass: true, warn: true, reason: "7 queued" },
      { label: "Slack bot scopes", pass: false, reason: "missing: reactions:read" },
    ]);
    expect(summary.exitCode).toBe(1);
    expect(summary.lines[0]).toBe("✓ Slack auth.test (team acme, bot user bot)");
    expect(summary.lines[1]).toBe("~ Telegram pending updates: 7 queued");
    expect(summary.lines[2]).toBe("✗ Slack bot scopes: missing: reactions:read");
    expect(summary.lines[3]).toContain("3 check(s), 1 failed");
  });

  test("all-pass (warns included) exits 0", () => {
    const summary = summarizeChannelChecks([
      { label: "a", pass: true },
      { label: "b", pass: true, warn: true, reason: "informational" },
    ]);
    expect(summary.exitCode).toBe(0);
    expect(summary.lines.at(-1)).toContain("0 failed");
  });
});

describe("supporting derivations", () => {
  test("channelEventsPath mirrors the generated gateway's route pattern", () => {
    expect(channelEventsPath("slack")).toBe("/slack/events");
    expect(channelEventsPath("telegram")).toBe("/telegram/events");
    expect(channelEventsPath("discord")).toBe("/discord/events");
  });

  test("platformSecretRefs lists exactly the daemon's boot-required secrets", () => {
    const channels = channelIr().channels;
    expect(platformSecretRefs("slack", channels).map((r) => r.label)).toEqual([
      "channels.slack.botToken",
      "channels.slack.signingSecret",
    ]);
    expect(platformSecretRefs("discord", channels).map((r) => r.label)).toEqual([
      "channels.discord.applicationId",
      "channels.discord.botToken",
      "channels.discord.publicKeyHex",
    ]);
  });

  test("describeVerifyProbes prints redacted endpoints only", () => {
    const channels = channelIr().channels;
    const lines = [
      ...describeVerifyProbes("slack", channels, FULL_ENV),
      ...describeVerifyProbes("telegram", channels, FULL_ENV),
      ...describeVerifyProbes("discord", channels, FULL_ENV),
    ];
    expect(lines.join("\n")).toContain("bot$TELEGRAM_BOT_TOKEN/getWebhookInfo");
    expect(lines.join("\n")).not.toContain("real-tg-token");
    expect(lines.join("\n")).not.toContain("xoxb-real-slack-token");
  });
});

// ---------------------------------------------------------------------------
// Boot gate — `verify` must name every env var the compiled daemon refuses to
// start without, and `--offline` must reach that verdict with no network.
// Regression for the demo-driver audit: verify named 5 of the daemon's 8
// required vars (DISCORD_APPLICATION_ID, DISCORD_PUBLIC_KEY and the provider
// credential were never checked), so an operator who fixed exactly what
// verify listed still got a daemon that exited 2 at boot.
// ---------------------------------------------------------------------------

/** A fetch that fails the test if anything calls it. */
const forbiddenFetch = (async (input: RequestInfo | URL) => {
  throw new Error(`network call attempted: ${String(input)}`);
}) as unknown as typeof fetch;

describe("verify boot gate", () => {
  const cfgs = () => {
    const { slack, telegram, discord } = channelIr().channels;
    if (slack === undefined || telegram === undefined || discord === undefined) {
      throw new Error("fixture channels missing");
    }
    return { slack, telegram, discord };
  };

  test("discord names ALL THREE boot-gated env refs when nothing is set (not just the bot token)", async () => {
    const { impl, calls } = fakeFetch(() => ({ body: {} }));
    const checks = await verifyDiscordChannel(cfgs().discord, { env: {}, fetchImpl: impl });
    expect(calls).toHaveLength(0);
    const reasons = checks.map((c) => c.reason ?? "").join("\n");
    expect(reasons).toContain("$DISCORD_APPLICATION_ID");
    expect(reasons).toContain("$DISCORD_BOT_TOKEN");
    expect(reasons).toContain("$DISCORD_PUBLIC_KEY");
    expect(checks.filter((c) => !c.pass)).toHaveLength(3);
  });

  test("a missing non-token ref still blocks the probe (the daemon could not boot anyway)", async () => {
    const { impl, calls } = fakeFetch(() => ({ body: {} }));
    const partial = { ...FULL_ENV, DISCORD_PUBLIC_KEY: "" };
    const checks = await verifyDiscordChannel(cfgs().discord, { env: partial, fetchImpl: impl });
    expect(calls).toHaveLength(0);
    expect(checks.find((c) => c.label === "Discord public key")?.pass).toBe(false);
  });

  test("--offline runs the env checks for every platform and performs no call", async () => {
    const slack = await verifySlackChannel(
      cfgs().slack,
      { channelReactions: true },
      { env: FULL_ENV, fetchImpl: forbiddenFetch, offline: true },
    );
    const telegram = await verifyTelegramChannel(cfgs().telegram, {
      env: FULL_ENV,
      fetchImpl: forbiddenFetch,
      offline: true,
      baseUrl: BASE_URL,
    });
    const discord = await verifyDiscordChannel(cfgs().discord, {
      env: FULL_ENV,
      fetchImpl: forbiddenFetch,
      offline: true,
      baseUrl: BASE_URL,
    });
    const all = [...slack, ...telegram, ...discord];
    // 2 slack + 2 telegram + 3 discord boot-gated refs, all green, no probes.
    expect(all).toHaveLength(7);
    expect(all.every((c) => c.pass)).toBe(true);
    expect(all.map((c) => c.label)).not.toContain("Slack auth.test");
    expect(summarizeChannelChecks(all, { offline: true }).exitCode).toBe(0);
  });

  test("--offline is deterministic: a rejecting platform API cannot change the verdict", async () => {
    const rejecting = fakeFetch(() => ({ body: { ok: false, error: "invalid_auth" } }));
    const online = await verifySlackChannel(
      cfgs().slack,
      { channelReactions: true },
      { env: FULL_ENV, fetchImpl: rejecting.impl },
    );
    const offline = await verifySlackChannel(
      cfgs().slack,
      { channelReactions: true },
      { env: FULL_ENV, fetchImpl: rejecting.impl, offline: true },
    );
    expect(summarizeChannelChecks(online).exitCode).toBe(1);
    expect(summarizeChannelChecks(offline, { offline: true }).exitCode).toBe(0);
    expect(rejecting.calls).toHaveLength(1); // only the online run called out
  });

  test("an all-green offline summary does not claim the wiring is healthy", () => {
    const green = [{ label: "Slack bot token", pass: true }];
    expect(summarizeChannelChecks(green, { offline: true }).lines.at(-1)).toContain(
      "offline: no platform probes ran",
    );
    expect(summarizeChannelChecks(green).lines.at(-1)).toContain("channel wiring looks healthy");
  });

  test("channelEnvChecks covers the no-probe channels too (whatsapp/imessage)", () => {
    const channels = channelIr(ALL_CHANNELS_SPEC).channels;
    const wa = channelEnvChecks("whatsapp", channels, {});
    expect(wa.map((c) => c.label)).toEqual([
      "WhatsApp phone number id",
      "WhatsApp access token",
      "WhatsApp app secret",
      "WhatsApp verify token",
    ]);
    expect(wa.every((c) => !c.pass)).toBe(true);
    const im = channelEnvChecks("imessage", channels, { IMESSAGE_CHAT_DB: "/tmp/chat.db" });
    expect(im.map((c) => c.pass)).toEqual([true, false]);
  });

  test("modelCredentialGroups mirrors the emitter: either-or per provider, none for bedrock/local/garbage", () => {
    expect(modelCredentialGroups("claude-sonnet-4-6")).toEqual([
      ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"],
    ]);
    expect(modelCredentialGroups("openai/gpt-4o")).toEqual([["OPENAI_API_KEY", "OPENAI_BASE_URL"]]);
    expect(modelCredentialGroups("gemini/gemini-2.5-pro")).toEqual([
      ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    ]);
    expect(modelCredentialGroups("bedrock/anthropic.claude-3-5-sonnet")).toEqual([]);
    expect(modelCredentialGroups("local/llama3@http://127.0.0.1:11434/v1")).toEqual([]);
    expect(modelCredentialGroups("not a model string")).toEqual([]);
  });

  test("modelCredentialChecks passes on EITHER name and fails naming both", () => {
    expect(modelCredentialChecks("claude-sonnet-4-6", { ANTHROPIC_AUTH_TOKEN: "t" })[0]?.pass).toBe(
      true,
    );
    const failing = modelCredentialChecks("claude-sonnet-4-6", {})[0];
    expect(failing?.pass).toBe(false);
    expect(failing?.reason).toContain("ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY");
    expect(modelCredentialChecks("bedrock/anthropic.claude-3-5-sonnet", {})).toEqual([]);
  });

  test("boot-gate parity: the CLI's env set equals the emitted daemon's own startup gate", () => {
    const channels = channelIr(ALL_CHANNELS_SPEC).channels;
    const cliNames = [
      ...CHANNEL_ENV_PLATFORMS.flatMap((p) =>
        platformSecretRefs(p, channels).flatMap((r) => (r.ref.kind === "env" ? [r.ref.name] : [])),
      ),
      ...modelCredentialGroups("claude-sonnet-4-6").map((g) => g.join(" or ")),
    ].sort();

    const daemon =
      compile(ALL_CHANNELS_SPEC).files.find((f) => f.path === "daemon.ts")?.content ?? "";
    const required = daemon.match(/const __requiredEnv = (\[[^\]]*\]);/)?.[1] ?? "[]";
    const anyOf = daemon.match(/const __providerEnvAnyOf: string\[\]\[\] = (\[\[[^;]*\]\]);/)?.[1];
    const daemonNames = [
      ...(JSON.parse(required) as string[]),
      ...((anyOf === undefined ? [] : (JSON.parse(anyOf) as string[][])).map((g) =>
        g.join(" or "),
      ) as string[]),
    ].sort();

    // Anchor the comparison to real content (an unmatched regex would
    // otherwise compare two empty lists): the two vars the audit found
    // unchecked, a no-probe channel's optional token, and the model group.
    expect(daemonNames).toEqual(
      expect.arrayContaining([
        "DISCORD_APPLICATION_ID",
        "DISCORD_PUBLIC_KEY",
        "WA_VERIFY_TOKEN",
        "IMESSAGE_CURSOR",
        "ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY",
      ]),
    );
    expect(cliNames).toEqual(daemonNames);
  });
});

// ---------------------------------------------------------------------------
// Provision pre-flight — every selected platform's env is validated BEFORE
// the first side effect. Regression for the demo-driver audit: provision
// wrote slack-app-manifest.yaml into the cwd and only then died on Telegram's
// unset env, leaving a stray file in the operator's repo.
// ---------------------------------------------------------------------------
describe("collectProvisionMissingEnv", () => {
  const channels = () => channelIr().channels;

  test("reports every platform's unset refs in one pass", () => {
    const missing = collectProvisionMissingEnv(
      ["slack", "telegram", "discord"],
      channels(),
      BASE_URL,
      {},
    );
    expect(missing.map((m) => `${m.platform}:${m.envName}`)).toEqual([
      "telegram:TELEGRAM_BOT_TOKEN",
      "telegram:TELEGRAM_SECRET_TOKEN",
      "discord:DISCORD_APPLICATION_ID",
      "discord:DISCORD_BOT_TOKEN",
    ]);
    expect(missing.map((m) => m.label)).toContain("channels.telegram.botToken");
  });

  test("slack contributes nothing — its manifest is how you OBTAIN the tokens", () => {
    expect(collectProvisionMissingEnv(["slack"], channels(), BASE_URL, {})).toEqual([]);
  });

  test("nothing missing once the env is populated", () => {
    expect(
      collectProvisionMissingEnv(["slack", "telegram", "discord"], channels(), BASE_URL, FULL_ENV),
    ).toEqual([]);
  });
});
