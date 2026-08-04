/**
 * M3 · CHANNELS — the channels panel, provisioning, verification, the two
 * testing tiers, and the gateway panel.
 *
 * ---------------------------------------------------------------------------
 * THE TWO TESTING TIERS (and why tier 2 is not a credential leak)
 * ---------------------------------------------------------------------------
 * tier 1 — LIVENESS. An UNSIGNED POST to the daemon's webhook endpoint,
 *   expecting a 401. Cheap, safe, and honest about what it proves: the
 *   endpoint is up and rejecting unsigned traffic. It is NOT an end-to-end
 *   test and nothing here labels it as one.
 *
 * tier 2 — SIGNED SYNTHETIC INBOUND. Opt-in. The SERVER reads the harness's
 *   own symmetric signing secret (from the merged spawn environment,
 *   server-side, at request time), signs a real synthetic event, posts it,
 *   and reports the turn. The value is never rendered, never returned, never
 *   logged — the whole operation is resolved inside this process, which is
 *   precisely what makes it safe.
 *
 *   Slack / Telegram / WhatsApp only. DISCORD IS TIER-1 ONLY, by design and
 *   not by omission: Discord verification is asymmetric Ed25519 and the
 *   harness holds only `publicKeyHex`, so only Discord's private key can
 *   sign a valid event — a forged inbound is impossible, and the button
 *   renders disabled WITH that reason rather than broken. iMessage is a
 *   poller with no inbound webhook at all, so neither tier applies.
 *
 * THE SIGNING GRAMMARS, mirrored from the adapters that verify them:
 *   slack     `X-Slack-Signature: v0=HMAC_SHA256(signingSecret,
 *             "v0:<ts>:<body>")` + `X-Slack-Request-Timestamp`
 *   telegram  `X-Telegram-Bot-Api-Secret-Token: <secretToken>` — Telegram
 *             does not sign the body; the shared token IS the proof
 *   whatsapp  `X-Hub-Signature-256: sha256=HMAC_SHA256(appSecret, <body>)`
 * They are mirrored rather than imported because the adapter packages are
 * not dependencies of the manager; the mirror is three HMACs over each
 * platform's published grammar, and a drift surfaces immediately as a 401
 * from the daemon — a correct, legible failure rather than a silent one.
 *
 * The routing display carries a trap worth naming on screen: emoji reaction
 * feedback requires a `channel` or `user` `sessionKey`. A `thread`
 * sessionKey routes turns correctly and collects nothing.
 *
 * Channel status has two sources and one honest empty state: the gateway's
 * `/status` `channels[]` when a gateway exists and the daemon is up, and
 * "no status endpoint" otherwise. A green light is NEVER synthesized from
 * spec configuration alone — a configured channel and a serving channel are
 * different claims.
 *
 * Provisioning is PRINT-FIRST: the Slack manifest, the Telegram
 * `setWebhook` call, the Discord endpoint + invite are rendered before
 * anything is executed, and iMessage's macOS / Full-Disk-Access
 * prerequisites are checklist items rather than silent failures.
 */
import { createHmac } from "node:crypto";
import { channelEnvChecks, isEnvSet } from "@crewhaus/preflight";
import {
  type ChannelEnvPlatform,
  type HarnessSpec,
  harnessDirOf,
  loweredChannels,
  m3Base,
  readHarnessSpec,
} from "./creds-ops";
import { HttpError } from "./http";
import type { M3Context, M3Handler } from "./m3";
import { jobArg, requireBoolean } from "./m3";
import { maskText } from "./mask";
import { asNumber, asRecord, asString, at } from "./yaml-scan";

/** Every platform a spec can declare, in display order. */
const PLATFORMS: readonly ChannelEnvPlatform[] = [
  "slack",
  "telegram",
  "discord",
  "whatsapp",
  "imessage",
];

/** A spec value written as an env reference — `$UPPER_SNAKE`, the only form
 *  the compiler lowers. The NAME is an indirection and safe to show. */
const ENV_REF_VALUE_RE = /^\$([A-Z_][A-Z0-9_]*)$/;

/** The three platforms whose inbound verification is SYMMETRIC — the
 *  harness holds the same secret the platform signs with, so the manager
 *  can produce a genuinely valid event. */
const TIER_2_PLATFORMS: ReadonlySet<string> = new Set(["slack", "telegram", "whatsapp"]);

/** Why a platform is tier-1 only. Rendered as the disabled button's reason,
 *  because a button that is simply missing teaches nothing. */
const TIER_2_REFUSALS: Readonly<Record<string, string>> = {
  discord:
    "Discord signs interactions with Ed25519 and the harness holds only the PUBLIC key (publicKeyHex) — only Discord's private key can produce a valid event, so a synthetic inbound is impossible by design, not by omission",
  imessage:
    "iMessage is a poller: the daemon reads chat.db on an interval and serves no inbound webhook, so there is no endpoint to post a synthetic event to",
};

/** The daemon's webhook path for a platform (`/<adapter>/events`). */
function webhookPath(platform: string): string {
  return `/${platform}/events`;
}

function platformOf(ctx: M3Context): ChannelEnvPlatform {
  const raw = ctx.params["channel"] ?? "";
  if (!(PLATFORMS as readonly string[]).includes(raw)) {
    throw new HttpError(400, `"${raw}" is not a channel platform (${PLATFORMS.join(" | ")})`);
  }
  return raw as ChannelEnvPlatform;
}

function channelBlock(spec: HarnessSpec, platform: string): Record<string, unknown> | undefined {
  return asRecord(at(spec.doc, ["channels", platform]));
}

// ---------------------------------------------------------------------------
// Live facts: the run's ports, and whether a daemon is actually up
// ---------------------------------------------------------------------------

type LiveDaemon = {
  /** True when this manager holds a running, adopted process for it. */
  readonly running: boolean;
  /** Sentence for every "we could not ask" answer. */
  readonly reason: string | null;
  /** The public/webhook port, when the run class claimed one. */
  readonly port: number | null;
  /** The spec's `gateway.port`, when the run recorded one. */
  readonly gatewayPort: number | null;
};

async function liveDaemon(ctx: M3Context): Promise<LiveDaemon> {
  try {
    const snapshot = (await ctx.process()).snapshot();
    const running = snapshot.state === "running";
    const ports = snapshot.ports as Record<string, unknown> | undefined;
    return {
      running,
      reason: running ? null : `the daemon is ${snapshot.state} — start it to reach its endpoints`,
      port: asNumber(ports?.["port"]) ?? null,
      gatewayPort: asNumber(ports?.["gatewayPort"]) ?? null,
    };
  } catch {
    return {
      running: false,
      reason: "this harness has no supervised process handle",
      port: null,
      gatewayPort: null,
    };
  }
}

/** One short-timeout loopback GET. Returns the parsed body or a REASON —
 *  never throws, because "the daemon did not answer" is a fact the panel
 *  renders, not a 500 the operator has to decode. */
async function pollJson(
  url: string,
  timeoutMs: number,
): Promise<{ ok: true; body: unknown } | { ok: false; reason: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, reason: `the endpoint answered HTTP ${res.status}` };
    return { ok: true, body: await res.json() };
  } catch (err) {
    return { ok: false, reason: `could not reach it: ${(err as Error).message}` };
  }
}

const POLL_TIMEOUT_MS = 2_000;

/** A synthetic inbound drives a whole agent turn, so it gets a real budget —
 *  unlike the liveness probe above, which only needs a rejection. */
const SYNTHETIC_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// GET /api/h/:id/channels
// ---------------------------------------------------------------------------

/** One channel row: config, presence booleans, and what each test tier can
 *  honestly prove for it. */
function channelRow(
  platform: ChannelEnvPlatform,
  spec: HarnessSpec,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, unknown> | undefined {
  const block = channelBlock(spec, platform);
  if (block === undefined) return undefined;
  const lowered = loweredChannels(spec.doc);
  const checks = channelEnvChecks(platform, lowered.channels, env).map((check) => ({
    label: check.label,
    pass: check.pass,
    informational: check.warn === true,
    reason: check.reason === undefined ? null : maskText(check.reason),
  }));
  // Secret FIELDS as presence booleans keyed by the variable NAME. No value
  // is read here — only `isEnvSet`.
  const fields = Object.entries(block).map(([field, raw]) => {
    const value = typeof raw === "string" ? raw : "";
    const envRef = value.match(ENV_REF_VALUE_RE)?.[1];
    return {
      field,
      envRef: envRef ?? null,
      set: envRef === undefined ? value !== "" : isEnvSet(env, envRef),
      inlineLiteral: envRef === undefined && value !== "",
    };
  });
  const tier2 = TIER_2_PLATFORMS.has(platform);
  return {
    platform,
    configured: true,
    fields,
    checks,
    bootGateOk: checks.every((check) => check.pass),
    webhookPath: platform === "imessage" ? null : webhookPath(platform),
    tier1: {
      available: platform !== "imessage",
      proves: "the webhook endpoint is up and rejecting UNSIGNED traffic — not an end-to-end test",
      reason: platform === "imessage" ? (TIER_2_REFUSALS["imessage"] ?? null) : null,
    },
    tier2: {
      available: tier2,
      proves: tier2
        ? "a real signed inbound event, signed server-side with this harness's own secret, driven through a full turn"
        : null,
      reason: tier2 ? null : (TIER_2_REFUSALS[platform] ?? null),
    },
  };
}

/**
 * The reactions caveat, stated where the routing choice is made.
 *
 * The field is `sessionKeyMode`, not `sessionKey`: `maskDeep` treats any
 * property ending in `Key` as a credential carrier (which is exactly what
 * keeps a `botToken` out of a response), so a field literally called
 * `sessionKey` comes back as `[redacted]` and the panel loses the one value
 * the whole caveat is about. `specPath` keeps the spec's real name visible.
 */
function routingView(spec: HarnessSpec): Record<string, unknown> {
  const sessionKey = asString(at(spec.doc, ["routing", "sessionKey"])) ?? null;
  const collectsReactions = sessionKey === "channel" || sessionKey === "user";
  return {
    sessionKeyMode: sessionKey,
    specPath: "routing.sessionKey",
    collectsReactions,
    reactionsNote:
      sessionKey === null
        ? "no routing.sessionKey is declared — the daemon falls back to its shape default"
        : collectsReactions
          ? "emoji reaction feedback is collected on this sessionKey"
          : 'sessionKey "thread" routes turns correctly but collects NO emoji reaction feedback — reactions need "channel" or "user"',
  };
}

export const channels: M3Handler = async (ctx) => {
  const dir = harnessDirOf(ctx);
  const spec = readHarnessSpec(dir);
  const rows = PLATFORMS.map((platform) => channelRow(platform, spec, ctx.env)).filter(
    (row): row is Record<string, unknown> => row !== undefined,
  );
  const lowered = loweredChannels(spec.doc);
  const live = await liveDaemon(ctx);

  // Live connectivity comes from the gateway's own `/status`, and ONLY from
  // there. With no gateway (or no running daemon) the answer is "no status
  // endpoint" — never a green light inferred from the spec.
  let liveChannels: string[] | null = null;
  let statusSource = "none";
  let statusReason: string | null =
    live.gatewayPort === null
      ? "this run has no gateway port — the daemon serves no /status endpoint"
      : live.reason;
  if (live.running && live.gatewayPort !== null) {
    const polled = await pollJson(`http://127.0.0.1:${live.gatewayPort}/status`, POLL_TIMEOUT_MS);
    if (polled.ok) {
      const names = at(polled.body, ["channels"]);
      liveChannels = Array.isArray(names) ? names.map(String) : [];
      statusSource = "gateway /status";
      statusReason = null;
    } else {
      statusReason = polled.reason;
    }
  }

  return {
    ...m3Base(
      rows.length > 0,
      rows.length === 0
        ? "this spec declares no channels: block — the channels tab belongs to channel daemons"
        : null,
      "crewhaus channel verify --offline",
    ),
    channels: rows,
    routing: routingView(spec),
    heartbeat: {
      declared: asRecord(at(spec.doc, ["heartbeat"])) !== undefined,
      every: asString(at(spec.doc, ["heartbeat", "every"])) ?? null,
    },
    liveChannels,
    statusSource,
    statusReason,
    // A value the compiler would REJECT outright: no daemon can exist, so
    // this outranks every env check beside it.
    compileErrors: lowered.compileErrors.map((error) => ({
      label: error.label,
      message: maskText(error.message),
    })),
    target: spec.target,
  };
};

// ---------------------------------------------------------------------------
// POST /api/h/:id/channels/verify
// ---------------------------------------------------------------------------

/**
 * `channel verify --offline` — the per-variable scope doctor that is also
 * the pre-boot gate.
 *
 * Offline is the default AND is answered inline: the checks are a pure
 * function of configuration plus environment, so running them here is
 * deterministic and instant. Asking for a LIVE verify submits the CLI job
 * instead, because that one makes real platform calls.
 */
export const channelVerify: M3Handler = (ctx) => {
  const dir = harnessDirOf(ctx);
  const spec = readHarnessSpec(dir);
  const lowered = loweredChannels(spec.doc);
  const offline = ctx.body["offline"] !== false;
  const configured = PLATFORMS.filter((platform) => channelBlock(spec, platform) !== undefined);

  if (!offline) {
    // A live verify calls the platform APIs, so it goes through the queue.
    // argv comes from a CLOSED vocabulary: the platform is one of five
    // literals, shape-checked before it can reach a command line.
    const requested = ctx.body["platform"];
    const platform =
      typeof requested === "string" && (PLATFORMS as readonly string[]).includes(requested)
        ? jobArg("platform", requested)
        : undefined;
    const job = ctx.submitJob(
      "channel verify",
      platform === undefined
        ? ["channel", "verify"]
        : ["channel", "verify", "--platform", platform],
    );
    return {
      mode: "live",
      job: { jobId: job.jobId, kind: job.kind, state: job.state, argv: job.argv },
      note: "a live verify makes real platform calls (auth.test, getWebhookInfo) — its result lands in the job's output",
    };
  }

  const platforms = configured.map((platform) => ({
    platform,
    checks: channelEnvChecks(platform, lowered.channels, ctx.env).map((check) => ({
      label: check.label,
      pass: check.pass,
      informational: check.warn === true,
      reason: check.reason === undefined ? null : maskText(check.reason),
    })),
  }));
  const failing = platforms.flatMap((entry) =>
    entry.checks.filter((check) => !check.pass).map((check) => `${entry.platform}: ${check.label}`),
  );
  return {
    mode: "offline",
    platforms,
    ok: failing.length === 0 && lowered.compileErrors.length === 0,
    failing,
    compileErrors: lowered.compileErrors.map((error) => ({
      label: error.label,
      message: maskText(error.message),
    })),
    note: "offline: a pure function of the spec and the merged environment — the same set the compiled daemon exits 2 on",
  };
};

// ---------------------------------------------------------------------------
// Provisioning — printed first, executed second
// ---------------------------------------------------------------------------

/** The externally-reachable origin the platform will call back on. Taken
 *  from the request when the operator supplies one, and left as an obvious
 *  placeholder otherwise — inventing a public URL for a loopback daemon
 *  would print a plan that cannot work. */
function baseUrlOf(ctx: M3Context): { baseUrl: string; supplied: boolean } {
  const raw = ctx.body["baseUrl"] ?? ctx.query.get("baseUrl");
  if (typeof raw === "string" && /^https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=-]+$/.test(raw)) {
    return { baseUrl: raw.replace(/\/+$/, ""), supplied: true };
  }
  return { baseUrl: "https://<your-public-host>", supplied: false };
}

/** The Slack app manifest `channel provision` prints. Secret FIELDS never
 *  appear — a manifest declares scopes and URLs, not credentials. */
function slackManifest(spec: HarnessSpec, callbackUrl: string): string {
  return [
    "display_information:",
    `  name: ${spec.specName}`,
    "features:",
    "  bot_user:",
    `    display_name: ${spec.specName}`,
    "    always_online: true",
    "oauth_config:",
    "  scopes:",
    "    bot:",
    "      - app_mentions:read",
    "      - chat:write",
    "      - channels:history",
    "      - groups:history",
    "      - im:history",
    "      - reactions:read",
    "settings:",
    "  event_subscriptions:",
    `    request_url: ${callbackUrl}`,
    "    bot_events:",
    "      - app_mention",
    "      - message.im",
    "      - reaction_added",
    "  interactivity:",
    "    is_enabled: true",
    `    request_url: ${callbackUrl.replace("/events", "/actions")}`,
    "",
  ].join("\n");
}

/** The provisioning plan for one platform. Print-only: nothing here calls a
 *  platform API, and every credential is NAMED, never shown. */
function provisionPlan(
  platform: ChannelEnvPlatform,
  spec: HarnessSpec,
  baseUrl: string,
): Record<string, unknown> {
  const callbackUrl = `${baseUrl}${webhookPath(platform)}`;
  switch (platform) {
    case "slack":
      return {
        kind: "manifest",
        callbackUrl,
        manifest: slackManifest(spec, callbackUrl),
        steps: [
          "create or open the Slack app at api.slack.com/apps",
          "paste the manifest below (App Manifest → YAML)",
          "install the app to the workspace and copy the bot token + signing secret",
          "set those two variables from the Credentials tab — it writes values in and reads presence back",
        ],
      };
    case "telegram":
      return {
        kind: "api-call",
        callbackUrl,
        request: {
          method: "POST",
          url: "https://api.telegram.org/bot<botToken>/setWebhook",
          // The body's FIELD NAMES, as a list. Written as an object it would
          // carry a `secret_token` key, which the response masker redacts —
          // and a provisioning plan whose parameter reads `[redacted]` is
          // not a plan anyone can follow.
          bodyFields: [`url = ${callbackUrl}`, "secret_token = the spec's secretToken value"],
        },
        steps: [
          "create the bot with BotFather and copy its token",
          "choose a secret token — Telegram echoes it on every delivery and the daemon compares it",
          "run the setWebhook call below (the provision job performs exactly this request)",
        ],
      };
    case "discord":
      return {
        kind: "endpoint+invite",
        callbackUrl,
        interactionsEndpointUrl: callbackUrl,
        inviteUrl:
          "https://discord.com/oauth2/authorize?client_id=<applicationId>&scope=bot%20applications.commands&permissions=274877908992",
        steps: [
          "set the application's Interactions Endpoint URL to the callback below",
          "Discord immediately PINGs it and refuses the URL unless the daemon is already running and verifying",
          "invite the bot with the URL below",
        ],
        note: "Discord verifies with Ed25519 — the harness stores only publicKeyHex, which is exactly why a synthetic inbound test is impossible for this platform",
      };
    case "whatsapp":
      return {
        kind: "callback-config",
        callbackUrl,
        steps: [
          "in the Meta app dashboard, set the WhatsApp webhook callback URL below",
          "set the verify token to the value this spec's verifyToken references — Meta never delivers to a callback that has not passed the handshake",
          "subscribe the app to the `messages` field",
        ],
      };
    case "imessage":
      return {
        kind: "checklist",
        callbackUrl: null,
        steps: [
          "this daemon must run on macOS — iMessage has no webhook and no hosted API",
          "grant the process FULL DISK ACCESS so it can read the Messages chat database",
          "confirm the Messages app is signed in to the account the agent should answer as",
          "set the chat-db / cursor paths only when the defaults do not apply",
        ],
        note: "iMessage is a poller: there is nothing to provision on a platform side, only local permissions to grant",
      };
  }
}

export const channelProvision: M3Handler = (ctx) => {
  const dir = harnessDirOf(ctx);
  const platform = platformOf(ctx);
  const spec = readHarnessSpec(dir);
  const configured = channelBlock(spec, platform) !== undefined;
  const { baseUrl, supplied } = baseUrlOf(ctx);
  return {
    ...m3Base(
      configured,
      configured
        ? null
        : `this spec declares no channels.${platform} block — add one before provisioning`,
      `crewhaus channel provision --platform ${platform}`,
    ),
    platform,
    plan: provisionPlan(platform, spec, baseUrl),
    baseUrl,
    baseUrlSupplied: supplied,
    baseUrlNote: supplied
      ? null
      : "supply the daemon's PUBLIC origin (baseUrl) — a loopback address is not reachable by any platform",
    executes: false,
    executeNote: "this is the plan only; POST the same path to run it",
  };
};

export const channelProvisionRun: M3Handler = (ctx) => {
  const dir = harnessDirOf(ctx);
  const platform = platformOf(ctx);
  const spec = readHarnessSpec(dir);
  requireBoolean(ctx.body, "confirm");
  if (ctx.body["confirm"] !== true) {
    throw new HttpError(409, `provisioning ${platform} needs "confirm": true`);
  }
  if (channelBlock(spec, platform) === undefined) {
    // A typed refusal inside a 200 envelope — the shape the console already
    // renders for control.v1: nothing happened, and here is exactly why.
    return {
      submitted: false,
      platform,
      code: "not_configured",
      reason: `this spec declares no channels.${platform} block — there is nothing to provision`,
      expected: true,
    };
  }
  const { baseUrl, supplied } = baseUrlOf(ctx);
  if (!supplied) {
    return {
      submitted: false,
      platform,
      code: "no_base_url",
      reason:
        "provisioning registers a PUBLIC callback URL with the platform — supply baseUrl (https://…) first",
      expected: true,
    };
  }
  // Closed vocabulary: the platform is one of five literals and the base URL
  // passed a shape check above before it could become an argument.
  const job = ctx.submitJob("channel provision", [
    "channel",
    "provision",
    "--platform",
    jobArg("platform", platform),
    "--base-url",
    baseUrl,
  ]);
  return {
    submitted: true,
    platform,
    job: { jobId: job.jobId, kind: job.kind, state: job.state, argv: job.argv },
  };
};

// ---------------------------------------------------------------------------
// Tier 1 — liveness
// ---------------------------------------------------------------------------

/**
 * `POST /api/h/:id/channels/:channel/probe` — tier-1 liveness.
 *
 * An UNSIGNED POST to the daemon's webhook endpoint. A 401 is the PASS: it
 * proves the endpoint is up and that signature verification is switched on.
 * Anything else is reported verbatim rather than interpreted.
 */
export const channelProbe: M3Handler = async (ctx) => {
  const dir = harnessDirOf(ctx);
  const platform = platformOf(ctx);
  const spec = readHarnessSpec(dir);
  if (platform === "imessage") {
    return {
      ok: false,
      tier: 1,
      platform,
      code: "no_webhook",
      reason: TIER_2_REFUSALS["imessage"] ?? null,
      expected: true,
    };
  }
  if (channelBlock(spec, platform) === undefined) {
    return {
      ok: false,
      tier: 1,
      platform,
      code: "not_configured",
      reason: `this spec declares no channels.${platform} block`,
      expected: true,
    };
  }
  const live = await liveDaemon(ctx);
  if (!live.running || live.port === null) {
    return {
      ok: false,
      tier: 1,
      platform,
      code: "daemon_not_running",
      reason: live.reason ?? "this daemon claimed no webhook port",
      expected: true,
    };
  }
  const probe = await postRaw(
    `http://127.0.0.1:${live.port}${webhookPath(platform)}`,
    { "content-type": "application/json" },
    JSON.stringify({ crewhausLivenessProbe: true }),
    POLL_TIMEOUT_MS,
  );
  return {
    ok: probe.status === 401,
    tier: 1,
    platform,
    status: probe.status,
    error: probe.error,
    proves:
      probe.status === 401
        ? "the endpoint is up and rejecting unsigned traffic — this is NOT an end-to-end test"
        : "an unsigned POST should be rejected with 401; anything else means the endpoint is down, or is not verifying signatures",
    expected: true,
  };
};

/** POST and report the status, or the transport error. Never throws. */
async function postRaw(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<{ status: number | null; error: string | null }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, error: null };
  } catch (err) {
    return { status: null, error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Tier 2 — signed synthetic inbound
// ---------------------------------------------------------------------------

/** HMAC-SHA256, hex. The secret is an argument and a local: it never leaves
 *  this function, and the digest it produces is not reversible. */
function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Resolve a channel field written as `$NAME` against the merged spawn
 *  environment. Returns the VALUE for the signer's use only — no caller
 *  serializes it, and the failure path reports the NAME. */
function resolveChannelSecret(
  spec: HarnessSpec,
  platform: string,
  field: string,
  env: Readonly<Record<string, string | undefined>>,
): { value: string } | { missing: string } {
  const raw = asString(at(spec.doc, ["channels", platform, field]));
  if (raw === undefined) return { missing: `channels.${platform}.${field} is not declared` };
  const envRef = raw.match(ENV_REF_VALUE_RE)?.[1];
  if (envRef === undefined) return { value: raw };
  const value = env[envRef];
  return value === undefined || value === ""
    ? {
        missing: `$${envRef} (channels.${platform}.${field}) is unset in this harness's environment`,
      }
    : { value };
}

/** The synthetic body + headers for one platform, signed server-side. */
function signSynthetic(
  platform: string,
  spec: HarnessSpec,
  text: string,
  nowMs: number,
  env: Readonly<Record<string, string | undefined>>,
): { headers: Record<string, string>; body: string } | { missing: string } {
  const stamp = Math.floor(nowMs / 1000);
  if (platform === "slack") {
    const secret = resolveChannelSecret(spec, "slack", "signingSecret", env);
    if ("missing" in secret) return secret;
    const body = JSON.stringify({
      type: "event_callback",
      event_id: `Ev_hangar_${stamp}`,
      team_id: "T_HANGAR",
      event: {
        type: "app_mention",
        channel: "C_HANGAR",
        user: "U_HANGAR",
        ts: `${stamp}.000100`,
        text,
      },
    });
    return {
      body,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": String(stamp),
        "x-slack-signature": `v0=${hmacHex(secret.value, `v0:${stamp}:${body}`)}`,
      },
    };
  }
  if (platform === "telegram") {
    const secret = resolveChannelSecret(spec, "telegram", "secretToken", env);
    if ("missing" in secret) return secret;
    const body = JSON.stringify({
      update_id: stamp,
      message: {
        message_id: stamp,
        date: stamp,
        chat: { id: 1, type: "private" },
        from: { id: 1, is_bot: false, first_name: "Hangar" },
        text,
      },
    });
    // Telegram does NOT sign the body — the shared secret token IS the proof.
    return {
      body,
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": secret.value,
      },
    };
  }
  if (platform === "whatsapp") {
    const secret = resolveChannelSecret(spec, "whatsapp", "appSecret", env);
    if ("missing" in secret) return secret;
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "HANGAR",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: "HANGAR" },
                messages: [
                  {
                    from: "10000000000",
                    id: `wamid.hangar.${stamp}`,
                    timestamp: String(stamp),
                    type: "text",
                    text: { body: text },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    return {
      body,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${hmacHex(secret.value, body)}`,
      },
    };
  }
  return { missing: `${platform} has no symmetric signing grammar` };
}

export const channelSynthetic: M3Handler = async (ctx) => {
  const dir = harnessDirOf(ctx);
  const platform = platformOf(ctx);
  const spec = readHarnessSpec(dir);
  requireBoolean(ctx.body, "confirm");
  if (ctx.body["confirm"] !== true) {
    throw new HttpError(
      409,
      'a signed synthetic inbound drives a REAL turn — send "confirm": true',
    );
  }
  if (!TIER_2_PLATFORMS.has(platform)) {
    return {
      ok: false,
      tier: 2,
      platform,
      code: "tier_2_impossible",
      reason: TIER_2_REFUSALS[platform] ?? `${platform} has no symmetric signing grammar`,
      expected: true,
    };
  }
  if (channelBlock(spec, platform) === undefined) {
    return {
      ok: false,
      tier: 2,
      platform,
      code: "not_configured",
      reason: `this spec declares no channels.${platform} block`,
      expected: true,
    };
  }
  const live = await liveDaemon(ctx);
  if (!live.running || live.port === null) {
    return {
      ok: false,
      tier: 2,
      platform,
      code: "daemon_not_running",
      reason: live.reason ?? "this daemon claimed no webhook port",
      expected: true,
    };
  }
  const rawText = ctx.body["text"];
  const text =
    typeof rawText === "string" && rawText.trim() !== ""
      ? rawText.slice(0, 512)
      : "synthetic inbound from the Hangar manager";
  // The ONE place this module touches a secret's value — resolved, used to
  // compute one digest, and dropped when this function returns.
  const signed = signSynthetic(platform, spec, text, ctx.now(), ctx.env);
  if ("missing" in signed) {
    return {
      ok: false,
      tier: 2,
      platform,
      code: "secret_unavailable",
      reason: signed.missing,
      expected: true,
    };
  }
  const posted = await postRaw(
    `http://127.0.0.1:${live.port}${webhookPath(platform)}`,
    signed.headers,
    signed.body,
    SYNTHETIC_TIMEOUT_MS,
  );
  return {
    ok: posted.status !== null && posted.status >= 200 && posted.status < 300,
    tier: 2,
    platform,
    status: posted.status,
    error: posted.error,
    // The session the daemon opens is marked, so a synthetic turn is never
    // mistaken for a human one in any later fold.
    synthetic: { synthetic: true, reason: "hangar tier-2 channel test", by: ctx.operator },
    text: maskText(text),
    proves:
      "a real, signature-valid inbound event was accepted and driven through the daemon's full turn",
    secretNote:
      "the signing secret was read server-side, used to compute one HMAC, and never left this process",
  };
};

// ---------------------------------------------------------------------------
// GET /api/h/:id/gateway
// ---------------------------------------------------------------------------

export const gateway: M3Handler = async (ctx) => {
  const dir = harnessDirOf(ctx);
  const spec = readHarnessSpec(dir);
  const block = asRecord(at(spec.doc, ["gateway"]));
  if (block === undefined) {
    // Absence is an AFFORDANCE, not an error: the panel offers the spec edit
    // that would create the block, and says what it buys.
    return {
      ...m3Base(
        false,
        "this spec declares no gateway: block — the daemon serves no /status endpoint and no mini dashboard",
        "crewhaus lint (after adding a gateway: block to the spec)",
      ),
      declared: false,
      addBlock: {
        path: "gateway",
        value: { port: 8787, ui: true },
        note: "adding this goes through the spec write path, which re-validates and diffs before it writes",
      },
      port: null,
      ui: false,
      status: null,
      statusReason: null,
      turnCount: null,
      heartbeatCount: null,
      channels: [],
      dashboardUrl: null,
    };
  }
  const port = asNumber(block["port"]) ?? null;
  const ui = block["ui"] === true;
  const live = await liveDaemon(ctx);
  let status: unknown = null;
  let statusReason: string | null = live.reason;
  if (live.running && port !== null) {
    const polled = await pollJson(`http://127.0.0.1:${port}/status`, POLL_TIMEOUT_MS);
    if (polled.ok) {
      status = polled.body;
      statusReason = null;
    } else {
      statusReason = polled.reason;
    }
  }
  const record = asRecord(status);
  const statusChannels = record?.["channels"];
  return {
    ...m3Base(true, null, "crewhaus daemon start"),
    declared: true,
    port,
    ui,
    status,
    statusReason,
    turnCount: asNumber(record?.["turnCount"]) ?? null,
    heartbeatCount: asNumber(record?.["heartbeatCount"]) ?? null,
    channels: Array.isArray(statusChannels) ? statusChannels.map(String) : [],
    // The daemon's own mini dashboard, when it is actually serving one.
    dashboardUrl: ui && port !== null && live.running ? `http://127.0.0.1:${port}/` : null,
  };
};

/** Exported for the tests: the tier-2 eligibility rule and its reasons are
 *  the part of this module most likely to be "simplified" into a wrong one. */
export { TIER_2_PLATFORMS, TIER_2_REFUSALS, webhookPath, signSynthetic };
