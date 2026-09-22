/**
 * `@crewhaus/tool-notify` — putting a message in front of a person, on
 * purpose.
 *
 * `@crewhaus/tool-message-channel`'s `SendMessage` replies on the harness's
 * OWN bound channel: the room it was spoken to in. That is the right
 * primitive for a conversation, and it is not the one a scheduled job needs
 * when the thing it has to say belongs in #ops, or in an email to the person
 * who owns the broken service, or in an SMS at 03:00 because the disk is
 * full. These tools address a destination an operator allow-listed, which is
 * a different and more dangerous act, and they are built accordingly.
 *
 * Four commitments hold across the package.
 *
 *   1. **Every send is gated and justified.** Each sending tool is
 *      `destructive` AND `requireJustification`: putting text in front of a
 *      person is a side effect that cannot be undone by deleting the
 *      message, because it has already been read. The intent gate exists for
 *      exactly this, and no tool here opts out of it.
 *   2. **The gate is tool-http's gate.** Allow-list, SSRF refusal, IP
 *      pinning, credential stripping and byte caps all live in `./net` and
 *      every outbound byte passes through them. Recipients and SMTP hosts
 *      have their own allow-lists, equally fail-closed. See that file's
 *      header.
 *   3. **Credentials are environment variable NAMES.** A Slack or Discord
 *      incoming-webhook URL is itself a credential, so it is named rather
 *      than passed, and no refusal ever prints a webhook path.
 *   4. **Determinism, and no clock.** Listings sort, comparisons are
 *      locale-free, nothing is random — MIME boundaries are derived from the
 *      message's own content — and anything that needs "now" takes it as an
 *      argument. `QuietHours` deciding that 03:00 is quiet must not depend
 *      on when the test runs.
 *
 * The one deliberate exception to "same input, same output" is the
 * idempotency ledger in `./net`: a second call carrying an
 * `idempotencyKey` that already succeeded returns the first result and posts
 * nothing. That is the point of an idempotency key, and it is the only
 * hidden state in the package.
 */
import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
import { z } from "zod";
import type { Block, Platform } from "./lib/blocks";
import {
  EDITABLE_PLATFORMS,
  THREADED_PLATFORMS,
  buildChatPayload,
  clampToPlatform,
  renderBlocks,
} from "./lib/blocks";
import { buildDigest, digestToBlocks, digestToText } from "./lib/digest";
import type { DigestEvent } from "./lib/digest";
import type { DkimAnswer, DmarcAnswer, SpfAnswer } from "./lib/dns-records";
import {
  normalizeDomain,
  normalizeSelector,
  parseDkim,
  parseDmarc,
  parseSpf,
} from "./lib/dns-records";
import type { Attachment, Mailbox } from "./lib/mime";
import { composeMessage, isValidAddress } from "./lib/mime";
import type { Check, CheckStatus } from "./lib/preflight";
import { draftChecks, verdictFrom } from "./lib/preflight";
import { quietDecision } from "./lib/quiet";
import type { QuietSchedule, Weekday } from "./lib/quiet";
import { rateLimitGate as evaluateRateLimit } from "./lib/ratelimit";
import type { RateState } from "./lib/ratelimit";
import { formatSignatureHeader, hmacHex, signedPayload } from "./lib/sign";
import { renderTemplate as renderTemplateValues } from "./lib/template";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_MAX_BYTES,
  MAX_TIMEOUT_MS,
  NotifyPermissionError,
  applyAuth,
  assertNotSsrf,
  assertOriginAllowed,
  assertSenderDomainAllowed,
  assertSmtpHostAllowed,
  byString,
  describeFailure,
  json,
  ledgerLookup,
  ledgerRecord,
  lookupTxt,
  openRequest,
  parseUrl,
  readCapped,
  readPath,
  recipientAllowed,
  redactorFor,
  rejectInlineCredentials,
  resolveNotifyConfig,
  resolveSecret,
  safeUrlLabel,
  sleep,
  startDeadline,
} from "./net";
import type { AuthProfile, Deadline, NotifyConfig, ProviderProfile, TxtAnswer } from "./net";
import { resolveSafe } from "./paths";
import { sendMail } from "./smtp";

export {
  NotifyPermissionError,
  _resetIdempotencyLedger,
  _resetNotifyConfig,
  _setDnsLookup,
  _setDnsTxtResolver,
  _setRawFetch,
  __setPrivateHostsAllowedForTest,
  buildNotifyConfig,
  canonicalizeOrigin,
  getNotifyConfig,
  registerNotifyConfig,
} from "./net";
export { ToolPermissionError } from "./paths";

// ---------------------------------------------------------------------------
// shared schema pieces
// ---------------------------------------------------------------------------

const platformSchema = z
  .enum(["slack", "discord", "teams", "webhook"])
  .describe(
    "which service the message is going to; it decides the payload shape, the escaping and whether threads, edits and reactions exist at all",
  );

const blockSchema = z
  .array(
    z.union([
      z.object({ kind: z.literal("heading"), text: z.string().min(1) }),
      z.object({ kind: z.literal("paragraph"), text: z.string() }),
      z.object({
        kind: z.literal("fields"),
        fields: z
          .array(z.object({ name: z.string(), value: z.string() }))
          .min(1)
          .max(25),
      }),
      z.object({ kind: z.literal("divider") }),
      z.object({ kind: z.literal("link"), url: z.string().min(1), text: z.string().optional() }),
    ]),
  )
  .max(50)
  .optional()
  .describe(
    "a small structured body rendered per platform; every value is escaped so it cannot become markup, and a link whose URL is not http(s) is dropped rather than rendered",
  );

const envVarSchema = (what: string) =>
  z
    .string()
    .min(1)
    .max(64)
    .describe(`NAME of the environment variable holding ${what} — never the value itself`);

const timeoutSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_TIMEOUT_MS)
  .optional()
  .describe(`milliseconds before the send is abandoned (default ${DEFAULT_TIMEOUT_MS})`);

const maxBytesSchema = z
  .number()
  .int()
  .min(256)
  .max(MAX_MAX_BYTES)
  .optional()
  .describe(
    `cap in bytes on the response read back (default ${DEFAULT_MAX_BYTES}); the read is cut at the cap, never buffered past it`,
  );

const idempotencySchema = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe(
    "a key that makes a retry safe: the first call under this key is sent and recorded for the life of the process, and a later call with the same key returns that result without sending again. It is also passed to the provider where the provider honours one",
  );

const authSchema = z
  .object({
    type: z
      .enum(["bearer", "basic", "header"])
      .describe(
        "bearer ⇒ Authorization: Bearer, basic ⇒ Authorization: Basic, header ⇒ headerName",
      ),
    envVar: envVarSchema("the secret"),
    headerName: z.string().min(1).optional().describe('header to set when type is "header"'),
    username: z
      .string()
      .optional()
      .describe('username when type is "basic"; envVar is the password'),
    prefix: z.string().optional().describe('literal prefix before the secret for type "header"'),
  })
  .optional()
  .describe("credential resolved from the process environment at call time");

const mailboxSchema = z.object({
  address: z.string().min(3).describe("an addr-spec, e.g. ops@example.com"),
  name: z
    .string()
    .max(200)
    .optional()
    .describe("display name; encoded, never able to add a header"),
});

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

type Prepared = {
  readonly cfg: NotifyConfig;
  readonly deadline: Deadline;
  readonly redact: (text: string) => string;
};

/** Everything that echoes out of this package passes through the redactor. */
function withRedaction(
  secrets: readonly (string | undefined)[],
  timeoutMs: number | undefined,
  ctx: ToolExecuteContext | undefined,
): Prepared {
  return {
    cfg: resolveNotifyConfig(ctx?.toolConfig),
    deadline: startDeadline(timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx?.signal),
    redact: redactorFor(secrets),
  };
}

type PreparedRequest =
  | {
      readonly ok: true;
      readonly headers: Record<string, string>;
      readonly secretHeaders: ReadonlySet<string>;
      readonly secrets: string[];
    }
  | { readonly ok: false; readonly message: string };

/** Reject inline credentials, then attach the auth profile's secret. */
function prepareHeaders(
  raw: Record<string, string> | undefined,
  auth: AuthProfile | undefined,
): PreparedRequest {
  const headers: Record<string, string> = { ...(raw ?? {}) };
  const inline = rejectInlineCredentials(headers);
  if (inline !== null) return { ok: false, message: inline };
  const applied = applyAuth(headers, auth);
  if (!applied.ok) return { ok: false, message: applied.message };
  return {
    ok: true,
    headers,
    secretHeaders: applied.secretHeaders,
    secrets: [...applied.secrets],
  };
}

type SendOutcome = {
  readonly status: number;
  readonly ok: boolean;
  readonly body: string;
  readonly truncated: boolean;
  readonly parsed: unknown;
};

/** POST (or whatever verb) to an allow-listed URL and read a capped reply. */
async function send(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  prepared: Prepared,
  maxBytes: number,
  secretHeaders: ReadonlySet<string>,
): Promise<SendOutcome> {
  const opened = await openRequest({
    url,
    method,
    headers,
    body,
    signal: prepared.deadline.signal,
    cfg: prepared.cfg,
    redirect: "refuse",
    credentialHeaders: secretHeaders,
  });
  const capped = await readCapped(opened.res, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(capped.text);
  } catch {
    parsed = undefined;
  }
  return {
    status: opened.res.status,
    ok: opened.res.status >= 200 && opened.res.status < 300,
    body: capped.text,
    truncated: capped.truncated,
    parsed,
  };
}

/**
 * Slack answers `200 OK` with `{"ok":false,"error":"channel_not_found"}`.
 * Treating HTTP status as the answer would report a lost message as sent, so
 * the body is consulted for the one platform that works this way.
 */
function platformFailure(platform: Platform, outcome: SendOutcome): string | null {
  if (!outcome.ok) {
    return `the service answered ${outcome.status}: ${outcome.body.slice(0, 500)}`;
  }
  if (platform === "slack" && typeof outcome.parsed === "object" && outcome.parsed !== null) {
    const record = outcome.parsed as Record<string, unknown>;
    if (record["ok"] === false) {
      return `Slack accepted the request and refused the message: ${String(record["error"] ?? "unknown error")}`;
    }
  }
  return null;
}

/** Where a platform keeps the id of the message just posted. */
function postedMessageId(platform: Platform, outcome: SendOutcome): string | undefined {
  if (typeof outcome.parsed !== "object" || outcome.parsed === null) return undefined;
  const record = outcome.parsed as Record<string, unknown>;
  const raw = platform === "slack" ? record["ts"] : record["id"];
  return typeof raw === "string" ? raw : undefined;
}

/** Resolve a webhook URL held in an environment variable. */
function webhookUrlFrom(envVar: string): { url: URL; secret: string } | string {
  const resolved = resolveSecret(envVar, "the webhook URL");
  if (!resolved.ok) return resolved.message;
  const parsed = parseUrl(resolved.value);
  if (typeof parsed === "string") {
    return `environment variable "${envVar}" does not hold an absolute URL (its value has not been echoed back, because a webhook URL is itself a credential)`;
  }
  return { url: parsed, secret: resolved.value };
}

/**
 * The incoming-webhook URL shapes that ARE the credential.
 *
 * A Slack `/services/T…/B…/xxxx` or Discord `/api/webhooks/<id>/<token>`
 * path grants posting rights to whoever holds it. Passed inline it lands in
 * the transcript, the trace and usually an eval report — the same reason
 * every other secret here is named rather than passed — so it is refused
 * with the variable form pointed at instead.
 */
const WEBHOOK_CREDENTIAL_PATHS: readonly RegExp[] = [
  /^\/services\/T[^/]+\/B[^/]+\/.+/i,
  /^\/api\/webhooks\/\d+\/.+/i,
  /^\/webhookb2\/[^/]+@[^/]+\/IncomingWebhook\/.+/i,
];

/** A refusal when `url` carries a credential in its path, else `null`. */
function inlineWebhookCredential(url: URL): string | null {
  if (!WEBHOOK_CREDENTIAL_PATHS.some((shape) => shape.test(url.pathname))) return null;
  return "that URL is an incoming-webhook URL, whose path is itself the credential — name the environment variable holding it in urlEnv instead of passing it here, where it would be recorded verbatim. (The value has not been echoed back.)";
}

const notSentBecause = (reason: string): string => `nothing was sent: ${reason}`;

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------

const chatTargetShape = {
  platform: platformSchema,
  webhookUrlEnv: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "NAME of the environment variable holding the incoming-webhook URL. The URL is the credential — a Slack /services/… or Discord /api/webhooks/… path grants posting rights to anyone holding it — so it is named, never passed, and never printed in an error",
    ),
  apiBaseUrl: z
    .string()
    .min(1)
    .optional()
    .describe(
      'API root for token mode, e.g. "https://slack.com/api" or "https://discord.com/api/v10". Its origin must be allow-listed. Required for anything other than a plain post',
    ),
  tokenEnv: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("NAME of the environment variable holding the bot token, for API mode"),
  channel: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "channel or conversation id; required in API mode, ignored by an incoming webhook that is already bound to one",
    ),
};

type ChatTarget = {
  platform: Platform;
  webhookUrlEnv?: string | undefined;
  apiBaseUrl?: string | undefined;
  tokenEnv?: string | undefined;
  channel?: string | undefined;
};

type ChatRoute =
  | {
      readonly ok: true;
      readonly url: URL;
      readonly headers: Record<string, string>;
      readonly secrets: string[];
      readonly secretHeaders: ReadonlySet<string>;
      readonly mode: "webhook" | "api";
    }
  | { readonly ok: false; readonly message: string };

/**
 * Work out which of the two ways to reach a platform this call is using, and
 * build the request that goes with it.
 *
 * `webhook` mode posts to an incoming-webhook URL held in an environment
 * variable: simple, but it can only create messages. `api` mode carries a
 * bot token and can edit, delete and react. Asking for both is a
 * configuration mistake rather than a preference, so it is refused instead
 * of resolved by precedence.
 */
function routeChat(target: ChatTarget, apiPath: string, allowWebhook: boolean): ChatRoute {
  const hasWebhook = target.webhookUrlEnv !== undefined;
  const hasApi = target.apiBaseUrl !== undefined || target.tokenEnv !== undefined;
  if (hasWebhook && hasApi) {
    return {
      ok: false,
      message:
        "give either webhookUrlEnv or apiBaseUrl+tokenEnv, not both — which credential to use is not something this tool should guess",
    };
  }
  if (hasWebhook) {
    if (!allowWebhook) {
      return {
        ok: false,
        message:
          "an incoming webhook can only create messages; editing, deleting and reacting need apiBaseUrl and tokenEnv",
      };
    }
    const resolved = webhookUrlFrom(target.webhookUrlEnv as string);
    if (typeof resolved === "string") return { ok: false, message: resolved };
    return {
      ok: true,
      url: resolved.url,
      headers: { "content-type": "application/json" },
      secrets: [resolved.secret, resolved.url.pathname],
      secretHeaders: new Set(),
      mode: "webhook",
    };
  }
  if (target.apiBaseUrl === undefined || target.tokenEnv === undefined) {
    return {
      ok: false,
      message: "no destination: set webhookUrlEnv, or set both apiBaseUrl and tokenEnv",
    };
  }
  const base = parseUrl(target.apiBaseUrl);
  if (typeof base === "string") return { ok: false, message: base };
  const token = resolveSecret(target.tokenEnv, "the bot token");
  if (!token.ok) return { ok: false, message: token.message };
  const url = new URL(`${base.pathname.replace(/\/+$/, "")}/${apiPath.replace(/^\/+/, "")}`, base);
  return {
    ok: true,
    url,
    headers: {
      "content-type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token.value}`,
    },
    secrets: [token.value],
    secretHeaders: new Set(["authorization"]),
    mode: "api",
  };
}

/** The API path for an operation on a platform, or a refusal. */
function apiPathFor(
  platform: Platform,
  operation: "post" | "update" | "delete" | "react",
  channel: string | undefined,
  messageId: string | undefined,
  emoji: string | undefined,
): { path: string; method: string } | string {
  if (platform === "teams" || platform === "webhook") {
    if (operation === "post") return { path: "", method: "POST" };
    return `${platform === "teams" ? "Microsoft Teams" : "a generic webhook"} has no API for editing, deleting or reacting to a message that was posted this way — the message stands as sent`;
  }
  if (platform === "slack") {
    if (operation === "post") return { path: "chat.postMessage", method: "POST" };
    if (operation === "update") return { path: "chat.update", method: "POST" };
    if (operation === "delete") return { path: "chat.delete", method: "POST" };
    return { path: "reactions.add", method: "POST" };
  }
  if (channel === undefined) return "discord addresses messages by channel id — set channel";
  const base = `channels/${encodeURIComponent(channel)}/messages`;
  if (operation === "post") return { path: base, method: "POST" };
  if (messageId === undefined) return "set messageId — discord identifies a message by its id";
  if (operation === "update")
    return { path: `${base}/${encodeURIComponent(messageId)}`, method: "PATCH" };
  if (operation === "delete")
    return { path: `${base}/${encodeURIComponent(messageId)}`, method: "DELETE" };
  if (emoji === undefined) return "set emoji";
  return {
    path: `${base}/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}/@me`,
    method: "PUT",
  };
}

/** Render text + blocks for a platform, refusing an empty message. */
function renderMessage(
  platform: Platform,
  text: string | undefined,
  blocks: readonly Block[] | undefined,
): { text: string; dropped: readonly string[]; truncated: boolean } | string {
  const { rendered, dropped } = renderBlocks(platform, text, blocks ?? []);
  if (rendered.trim() === "") {
    return "the message is empty — give text, blocks, or both. A message nobody can read is still a notification somebody has to triage";
  }
  const clamped = clampToPlatform(platform, rendered);
  return { text: clamped.text, dropped, truncated: clamped.truncated };
}

export const chatPost: RegisteredTool = buildTool({
  name: "ChatPost",
  description:
    "Post a message to Slack, Discord, Microsoft Teams or a generic incoming webhook, with optional heading/paragraph/fields/divider/link blocks and a thread id where the platform threads. Use it when a harness needs to tell a room something rather than reply where it was spoken to — a nightly result, an alert, a hand-off. Every value is escaped for the platform before it is sent, so text carrying <!channel>, @everyone or a code fence can change what the message SAYS but never what it DOES; mentions are additionally suppressed at the API level. One tool covers four platforms because the payload differs and the intent does not. It takes an idempotency key so a retried call returns the first result instead of posting twice, and it will not follow a redirect — a webhook URL that moved is a configuration change, not something to chase at send time.",
  inputSchema: z.object({
    ...chatTargetShape,
    text: z.string().max(40_000).optional().describe("the message body; escaped for the platform"),
    blocks: blockSchema,
    threadId: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "reply inside a thread: a Slack thread_ts. Ignored with a warning on a platform without threads",
      ),
    username: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe("override the posting name, where the platform allows it"),
    idempotencyKey: idempotencySchema,
    timeoutMs: timeoutSchema,
    maxBytes: maxBytesSchema,
  }),
  scope: "external",
  ioCapability: "network",
  destructive: true,
  requireJustification: true,
  execute: async (input, ctx) => {
    const args = input as ChatTarget & {
      text?: string;
      blocks?: Block[];
      threadId?: string;
      username?: string;
      idempotencyKey?: string;
      timeoutMs?: number;
      maxBytes?: number;
    };
    const cached = ledgerLookup("ChatPost", args.idempotencyKey);
    if (cached !== undefined) return cached.result;

    const rendered = renderMessage(args.platform, args.text, args.blocks);
    if (typeof rendered === "string") return notSentBecause(rendered);

    // The API path is only worked out when the call is actually using API
    // mode. An incoming webhook URL already names the channel it posts to, so
    // asking for a channel id there would refuse a call that is complete.
    const wantsApi = args.apiBaseUrl !== undefined || args.tokenEnv !== undefined;
    let apiPath = "";
    let method = "POST";
    if (wantsApi) {
      const pathSpec = apiPathFor(args.platform, "post", args.channel, undefined, undefined);
      if (typeof pathSpec === "string") return notSentBecause(pathSpec);
      apiPath = pathSpec.path;
      method = pathSpec.method;
    }
    const route = routeChat(args, apiPath, true);
    if (!route.ok) return notSentBecause(route.message);
    if (route.mode === "api" && args.channel === undefined) {
      return notSentBecause("API mode addresses a channel — set channel");
    }

    const warnings: string[] = [...rendered.dropped];
    if (args.threadId !== undefined && !THREADED_PLATFORMS.has(args.platform)) {
      warnings.push(`${args.platform} has no threads; threadId was ignored`);
    }
    if (rendered.truncated)
      warnings.push("the message was longer than the platform accepts and was cut");

    const payload = buildChatPayload({
      platform: args.platform,
      text: rendered.text,
      threadId: THREADED_PLATFORMS.has(args.platform) ? args.threadId : undefined,
      channel: route.mode === "api" ? args.channel : undefined,
      username: args.username,
    });
    // Discord's bot API keeps the thread reference outside the message body.
    const url = new URL(route.url.toString());
    if (args.platform === "discord" && route.mode === "api" && args.threadId !== undefined) {
      url.searchParams.set("thread_id", args.threadId);
    }

    const prepared = withRedaction([...route.secrets], args.timeoutMs, ctx);
    const headers = { ...route.headers };
    if (args.idempotencyKey !== undefined) headers["Idempotency-Key"] = args.idempotencyKey;
    try {
      const outcome = await send(
        url,
        method,
        headers,
        payload.body,
        prepared,
        args.maxBytes ?? DEFAULT_MAX_BYTES,
        route.secretHeaders,
      );
      const failure = platformFailure(args.platform, outcome);
      if (failure !== null) return prepared.redact(notSentBecause(failure));
      const result = prepared.redact(
        json({
          sent: true,
          platform: args.platform,
          mode: route.mode,
          status: outcome.status,
          characters: rendered.text.length,
          ...(postedMessageId(args.platform, outcome) !== undefined
            ? { messageId: postedMessageId(args.platform, outcome) }
            : {}),
          ...(warnings.length > 0 ? { warnings: warnings.sort(byString) } : {}),
        }),
      );
      ledgerRecord("ChatPost", args.idempotencyKey, result);
      return result;
    } catch (err) {
      return prepared.redact(notSentBecause(describeFailure(err, prepared.deadline)));
    } finally {
      prepared.deadline.cancel();
    }
  },
});

export const chatUpdate: RegisteredTool = buildTool({
  name: "ChatUpdate",
  description:
    "Edit a message this harness already posted, by its id, on a platform that allows it. Use it to keep one status message current instead of adding a new one every cycle — a deploy that goes queued → running → done reads better as one edited line than as three. It needs a bot token: an incoming webhook cannot edit, and Teams and generic webhooks cannot edit at all, so both are refused rather than silently reposted. An edit still notifies nobody, but the message is in front of people, so it carries the same gate as posting. The previous text is not returned, because the platform does not give it back.",
  inputSchema: z.object({
    ...chatTargetShape,
    messageId: z
      .string()
      .min(1)
      .max(200)
      .describe("the id the original post returned — a Slack ts, a Discord message id"),
    text: z.string().max(40_000).optional(),
    blocks: blockSchema,
    timeoutMs: timeoutSchema,
    maxBytes: maxBytesSchema,
  }),
  scope: "external",
  ioCapability: "network",
  destructive: true,
  requireJustification: true,
  execute: async (input, ctx) => {
    const args = input as ChatTarget & {
      messageId: string;
      text?: string;
      blocks?: Block[];
      timeoutMs?: number;
      maxBytes?: number;
    };
    if (!EDITABLE_PLATFORMS.has(args.platform)) {
      return notSentBecause(
        `${args.platform} does not let a posted message be edited — the message stands as sent`,
      );
    }
    const rendered = renderMessage(args.platform, args.text, args.blocks);
    if (typeof rendered === "string") return notSentBecause(rendered);

    const pathSpec = apiPathFor(args.platform, "update", args.channel, args.messageId, undefined);
    if (typeof pathSpec === "string") return notSentBecause(pathSpec);
    const route = routeChat(args, pathSpec.path, false);
    if (!route.ok) return notSentBecause(route.message);
    if (args.platform === "slack" && args.channel === undefined) {
      return notSentBecause("Slack identifies a message by channel plus ts — set channel");
    }

    const body =
      args.platform === "slack"
        ? JSON.stringify({
            channel: args.channel,
            ts: args.messageId,
            text: rendered.text,
            link_names: false,
          })
        : JSON.stringify({ content: rendered.text, allowed_mentions: { parse: [] } });

    const prepared = withRedaction([...route.secrets], args.timeoutMs, ctx);
    try {
      const outcome = await send(
        route.url,
        pathSpec.method,
        route.headers,
        body,
        prepared,
        args.maxBytes ?? DEFAULT_MAX_BYTES,
        route.secretHeaders,
      );
      const failure = platformFailure(args.platform, outcome);
      if (failure !== null) return prepared.redact(notSentBecause(failure));
      return prepared.redact(
        json({
          updated: true,
          platform: args.platform,
          messageId: args.messageId,
          status: outcome.status,
          characters: rendered.text.length,
          ...(rendered.truncated
            ? { warnings: ["the message was cut to the platform limit"] }
            : {}),
        }),
      );
    } catch (err) {
      return prepared.redact(notSentBecause(describeFailure(err, prepared.deadline)));
    } finally {
      prepared.deadline.cancel();
    }
  },
});

export const chatDelete: RegisteredTool = buildTool({
  name: "ChatDelete",
  description:
    "Remove a message this harness posted, by its id. Use it to retract something that was wrong, or to tidy a transient status line once the run is over. Deleting does not unsend: anyone watching the channel has already seen it, and on most platforms a tombstone or an audit entry remains, so this is a cleanup tool and not a way to take something back. It needs a bot token, works only where the platform supports deletion, and cannot delete a message this harness did not post unless the token's own permissions allow it.",
  inputSchema: z.object({
    ...chatTargetShape,
    messageId: z.string().min(1).max(200).describe("the id the original post returned"),
    timeoutMs: timeoutSchema,
    maxBytes: maxBytesSchema,
  }),
  scope: "external",
  ioCapability: "network",
  destructive: true,
  requireJustification: true,
  execute: async (input, ctx) => {
    const args = input as ChatTarget & { messageId: string; timeoutMs?: number; maxBytes?: number };
    if (!EDITABLE_PLATFORMS.has(args.platform)) {
      return notSentBecause(`${args.platform} does not let a posted message be deleted`);
    }
    const pathSpec = apiPathFor(args.platform, "delete", args.channel, args.messageId, undefined);
    if (typeof pathSpec === "string") return notSentBecause(pathSpec);
    const route = routeChat(args, pathSpec.path, false);
    if (!route.ok) return notSentBecause(route.message);
    if (args.platform === "slack" && args.channel === undefined) {
      return notSentBecause("Slack identifies a message by channel plus ts — set channel");
    }
    const body =
      args.platform === "slack"
        ? JSON.stringify({ channel: args.channel, ts: args.messageId })
        : undefined;

    const prepared = withRedaction([...route.secrets], args.timeoutMs, ctx);
    try {
      const outcome = await send(
        route.url,
        pathSpec.method,
        route.headers,
        body,
        prepared,
        args.maxBytes ?? DEFAULT_MAX_BYTES,
        route.secretHeaders,
      );
      const failure = platformFailure(args.platform, outcome);
      if (failure !== null) return prepared.redact(`the message was not deleted: ${failure}`);
      return prepared.redact(
        json({
          deleted: true,
          platform: args.platform,
          messageId: args.messageId,
          status: outcome.status,
        }),
      );
    } catch (err) {
      return prepared.redact(
        `the message was not deleted: ${describeFailure(err, prepared.deadline)}`,
      );
    } finally {
      prepared.deadline.cancel();
    }
  },
});

export const chatReact: RegisteredTool = buildTool({
  name: "ChatReact",
  description:
    "Add an emoji reaction to a message, as the token's own user. Use it to acknowledge something cheaply — a ✅ on the alert that has been handled says as much as a reply and adds no noise. A reaction is visible to the room and shows who left it, so it counts as putting something in front of people and takes the same gate as a post. Give the emoji by name without colons on Slack, and as the literal character or name:id on Discord; an emoji the workspace does not have is refused by the platform, not invented here.",
  inputSchema: z.object({
    ...chatTargetShape,
    messageId: z.string().min(1).max(200),
    emoji: z
      .string()
      .min(1)
      .max(100)
      .describe(
        'Slack: the short name without colons, e.g. "white_check_mark". Discord: the character, or name:id for a custom one',
      ),
    timeoutMs: timeoutSchema,
    maxBytes: maxBytesSchema,
  }),
  scope: "external",
  ioCapability: "network",
  destructive: true,
  requireJustification: true,
  execute: async (input, ctx) => {
    const args = input as ChatTarget & {
      messageId: string;
      emoji: string;
      timeoutMs?: number;
      maxBytes?: number;
    };
    if (!EDITABLE_PLATFORMS.has(args.platform)) {
      return notSentBecause(`${args.platform} has no reactions`);
    }
    const pathSpec = apiPathFor(args.platform, "react", args.channel, args.messageId, args.emoji);
    if (typeof pathSpec === "string") return notSentBecause(pathSpec);
    const route = routeChat(args, pathSpec.path, false);
    if (!route.ok) return notSentBecause(route.message);
    if (args.platform === "slack" && args.channel === undefined) {
      return notSentBecause("Slack identifies a message by channel plus ts — set channel");
    }
    const body =
      args.platform === "slack"
        ? JSON.stringify({
            channel: args.channel,
            timestamp: args.messageId,
            name: args.emoji.replace(/^:|:$/g, ""),
          })
        : undefined;

    const prepared = withRedaction([...route.secrets], args.timeoutMs, ctx);
    try {
      const outcome = await send(
        route.url,
        pathSpec.method,
        route.headers,
        body,
        prepared,
        args.maxBytes ?? DEFAULT_MAX_BYTES,
        route.secretHeaders,
      );
      const failure = platformFailure(args.platform, outcome);
      if (failure !== null) return prepared.redact(`the reaction was not added: ${failure}`);
      return prepared.redact(
        json({
          reacted: true,
          platform: args.platform,
          messageId: args.messageId,
          emoji: args.emoji,
          status: outcome.status,
        }),
      );
    } catch (err) {
      return prepared.redact(
        `the reaction was not added: ${describeFailure(err, prepared.deadline)}`,
      );
    } finally {
      prepared.deadline.cancel();
    }
  },
});

// ---------------------------------------------------------------------------
// email
// ---------------------------------------------------------------------------

/** Per-attachment and whole-message caps, so memory is bounded before a read. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

const attachmentSchema = z
  .array(
    z.object({
      path: z
        .string()
        .min(1)
        .describe("workspace-relative path; a path resolving outside the workspace is refused"),
      filename: z
        .string()
        .min(1)
        .max(255)
        .optional()
        .describe("name the recipient sees; defaults to the file's own"),
      contentType: z
        .string()
        .min(3)
        .max(100)
        .optional()
        .describe('media type, e.g. "application/pdf" (default application/octet-stream)'),
      contentId: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          'cid: reference, for an image the HTML part embeds, e.g. "logo@crewhaus" — a plain token, since this tool adds the angle brackets and a whitespace or line break inside one would open a header of its own',
        ),
    }),
  )
  .max(20)
  .optional()
  .describe(
    `files attached from the workspace; each is capped at ${MAX_ATTACHMENT_BYTES} bytes and the assembled message at ${MAX_MESSAGE_BYTES}, checked from the file's size before it is read so an oversized attachment never reaches memory`,
  );

const composeShape = {
  from: mailboxSchema.describe("the sender; its domain also supplies the Message-ID domain"),
  to: z.array(mailboxSchema).max(100).optional(),
  cc: z.array(mailboxSchema).max(100).optional(),
  bcc: z
    .array(mailboxSchema)
    .max(100)
    .optional()
    .describe(
      "blind recipients: they reach the envelope and never a header, which is what keeps them blind",
    ),
  replyTo: z.array(mailboxSchema).max(10).optional(),
  subject: z
    .string()
    .max(1000)
    .describe("encoded when it is not plain ASCII, which also neutralises a newline"),
  text: z
    .string()
    .max(1_000_000)
    .describe(
      "the plain-text body; always present, because a text/plain part is what makes a message readable everywhere",
    ),
  html: z
    .string()
    .max(1_000_000)
    .optional()
    .describe("optional HTML alternative; sent alongside the text part, never instead of it"),
  attachments: attachmentSchema,
  date: z
    .string()
    .min(1)
    .describe(
      "REQUIRED instant for the Date header, ISO-8601 with an offset (e.g. 2026-09-17T09:30:00Z). This tool never reads the clock, so the caller decides what time the message claims",
    ),
  inReplyTo: z
    .string()
    .max(400)
    .optional()
    .describe(
      "Message-ID being replied to, angle brackets included, e.g. <abc@example.com>. Exactly one id: a value carrying whitespace or a line break is refused, because a message id is emitted verbatim and would otherwise become a header of its own",
    ),
  references: z
    .array(z.string().max(400))
    .max(50)
    .optional()
    .describe(
      "the thread's earlier Message-IDs, each in angle brackets; the same one-id-per-entry rule as inReplyTo",
    ),
  headers: z
    .record(z.string())
    .optional()
    .describe("extra headers; names this tool builds itself are refused rather than duplicated"),
};

type ComposeArgs = {
  from: Mailbox;
  to?: Mailbox[];
  cc?: Mailbox[];
  bcc?: Mailbox[];
  replyTo?: Mailbox[];
  subject: string;
  text: string;
  html?: string;
  attachments?: Array<{
    path: string;
    filename?: string;
    contentType?: string;
    contentId?: string;
  }>;
  date: string;
  inReplyTo?: string;
  references?: string[];
  headers?: Record<string, string>;
};

type LoadedAttachments =
  | { readonly ok: true; readonly attachments: Attachment[]; readonly bytes: number }
  | { readonly ok: false; readonly message: string };

/**
 * Read attachments through the path gate, checking each file's size BEFORE
 * reading it. Checking after would mean a 2 GB file is in memory by the time
 * the cap says no.
 */
function loadAttachments(toolName: string, specs: ComposeArgs["attachments"]): LoadedAttachments {
  const attachments: Attachment[] = [];
  let total = 0;
  let encoded = 0;
  for (const spec of specs ?? []) {
    let safe: ReturnType<typeof resolveSafe>;
    try {
      safe = resolveSafe(toolName, spec.path);
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
    let size: number;
    try {
      const stat = statSync(safe.real);
      if (!stat.isFile()) return { ok: false, message: `"${spec.path}" is not a regular file` };
      size = stat.size;
    } catch {
      return { ok: false, message: `"${spec.path}" could not be read` };
    }
    if (size > MAX_ATTACHMENT_BYTES) {
      return {
        ok: false,
        message: `"${spec.path}" is ${size} bytes, over the ${MAX_ATTACHMENT_BYTES}-byte per-attachment cap — refused before it was read`,
      };
    }
    total += size;
    // The cap is on the message that gets BUILT, and base64 is what the
    // attachment costs there: four characters per three bytes, plus a CRLF
    // every 57 source bytes. Counting the raw size would let 25 MB of files
    // assemble a 34 MB string first and refuse it afterwards, which is the
    // allocation the cap exists to prevent.
    encoded += Math.ceil(size / 3) * 4 + Math.ceil(size / 57) * 2;
    if (encoded > MAX_MESSAGE_BYTES) {
      return {
        ok: false,
        message: `the attachments encode to more than the ${MAX_MESSAGE_BYTES}-byte message cap (base64 costs about a third more than the files themselves) — refused before they were read`,
      };
    }
    let content: Uint8Array;
    try {
      content = new Uint8Array(readFileSync(safe.real));
    } catch {
      return { ok: false, message: `"${spec.path}" could not be read` };
    }
    attachments.push({
      filename: spec.filename ?? path.basename(safe.abs),
      contentType: spec.contentType ?? "application/octet-stream",
      content,
      disposition: spec.contentId === undefined ? "attachment" : "inline",
      ...(spec.contentId !== undefined ? { contentId: spec.contentId } : {}),
    });
  }
  return { ok: true, attachments, bytes: total };
}

/** Build the message, or the readable reason it could not be built. */
function buildMessage(
  toolName: string,
  args: ComposeArgs,
):
  | { ok: true; message: string; messageId: string; bytes: number; envelopeTo: readonly string[] }
  | { ok: false; message: string } {
  const when = new Date(args.date);
  if (Number.isNaN(when.getTime())) {
    return {
      ok: false,
      message: `"${args.date}" is not an instant this tool can read — use ISO-8601 with an offset, e.g. 2026-09-17T09:30:00Z`,
    };
  }
  const loaded = loadAttachments(toolName, args.attachments);
  if (!loaded.ok) return { ok: false, message: loaded.message };

  const composed = composeMessage({
    from: args.from,
    to: args.to ?? [],
    cc: args.cc ?? [],
    bcc: args.bcc ?? [],
    replyTo: args.replyTo ?? [],
    subject: args.subject,
    text: args.text,
    ...(args.html !== undefined ? { html: args.html } : {}),
    attachments: loaded.attachments,
    date: when,
    ...(args.inReplyTo !== undefined ? { inReplyTo: args.inReplyTo } : {}),
    ...(args.references !== undefined ? { references: args.references } : {}),
    ...(args.headers !== undefined ? { headers: args.headers } : {}),
  });
  if (!composed.ok) return { ok: false, message: composed.error };
  if (composed.bytes > MAX_MESSAGE_BYTES) {
    return {
      ok: false,
      message: `the assembled message is ${composed.bytes} bytes, over the ${MAX_MESSAGE_BYTES}-byte cap`,
    };
  }
  return {
    ok: true,
    message: composed.message,
    messageId: composed.messageId,
    bytes: composed.bytes,
    envelopeTo: composed.envelopeTo,
  };
}

export const emailCompose: RegisteredTool = buildTool({
  name: "EmailCompose",
  description:
    "Build a complete RFC 5322 message — headers, MIME structure, encodings, attachments — and return the bytes without sending anything. Use it to inspect exactly what would go out, to hand a message to a transport this package does not speak, or to test the assembly without a mail server in the loop. Non-ASCII subjects and display names become encoded words, which also means a newline in either can never split the header block and add a Bcc. Bodies are quoted-printable UTF-8, attachments base64, and the MIME boundary is derived from the message's own content rather than from a random number, so composing the same message twice gives byte-identical output. It reads attachments from the workspace and nothing else: no network, no clock — the Date header is an argument.",
  inputSchema: z.object(composeShape),
  scope: "internal",
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const args = input as ComposeArgs;
    const built = buildMessage("EmailCompose", args);
    if (!built.ok) return `the message was not composed: ${built.message}`;
    return json({
      messageId: built.messageId,
      bytes: built.bytes,
      envelopeTo: built.envelopeTo,
      message: built.message,
    });
  },
});

export const emailSend: RegisteredTool = buildTool({
  name: "EmailSend",
  description:
    "Send a message over SMTP: EHLO, STARTTLS, AUTH, MAIL FROM, RCPT TO, DATA, written out rather than delegated. Use it when the thing to report belongs in somebody's inbox rather than in a chat room. STARTTLS is required by default and the session ends before the password is written if the server does not offer it; the credential is an environment variable NAME and the transcript records the AUTH line as redacted. Every recipient must match the operator's allow-list and the SMTP host must be one an operator named, both of which deny everything when unset. The whole session is deadline-bounded and the server's replies are byte-capped. It does not queue, retry, or track bounces — a refused recipient comes back named, and re-sending is the caller's decision.",
  inputSchema: z.object({
    ...composeShape,
    host: z.string().min(1).max(255).describe("SMTP host; must appear in allowed_smtp_hosts"),
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .optional()
      .describe("default 587 (submission); 465 means implicit TLS"),
    requireTls: z
      .boolean()
      .optional()
      .describe(
        "default true. When true and the server offers no STARTTLS, the session ends before anything — credential, envelope or body — is sent",
      ),
    usernameEnv: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("NAME of the environment variable holding the SMTP username"),
    passwordEnv: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("NAME of the environment variable holding the SMTP password"),
    authMethod: z
      .enum(["plain", "login", "auto"])
      .optional()
      .describe("default auto, which prefers PLAIN over LOGIN among what the server offers"),
    ehloName: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe(
        "the name announced in EHLO (default crewhaus.invalid): a domain or a bracketed address literal, since anything carrying a space or a line break would be read by SMTP as a second command",
      ),
    idempotencyKey: idempotencySchema,
    timeoutMs: timeoutSchema,
  }),
  scope: "external",
  ioCapability: "network",
  destructive: true,
  requireJustification: true,
  execute: async (input, ctx) => {
    const args = input as ComposeArgs & {
      host: string;
      port?: number;
      requireTls?: boolean;
      usernameEnv?: string;
      passwordEnv?: string;
      authMethod?: "plain" | "login" | "auto";
      ehloName?: string;
      idempotencyKey?: string;
      timeoutMs?: number;
    };
    const cached = ledgerLookup("EmailSend", args.idempotencyKey);
    if (cached !== undefined) return cached.result;

    const cfg = resolveNotifyConfig(ctx?.toolConfig);
    const everyone = [...(args.to ?? []), ...(args.cc ?? []), ...(args.bcc ?? [])];
    if (everyone.length === 0) return notSentBecause("no recipients");
    const refused = everyone
      .map((m) => m.address)
      .filter((address) => !recipientAllowed(address, cfg))
      .sort(byString);
    if (refused.length > 0) {
      return notSentBecause(
        `${refused.join(", ")} ${refused.length === 1 ? "is" : "are"} not in allowed_recipients (an empty allow-list refuses everyone). An operator adds a full address, or *@domain`,
      );
    }
    if (!isValidAddress(args.from.address)) {
      return notSentBecause(`"${args.from.address}" is not a deliverable sender address`);
    }

    let username: string | undefined;
    let password: string | undefined;
    if (args.usernameEnv !== undefined || args.passwordEnv !== undefined) {
      if (args.usernameEnv === undefined || args.passwordEnv === undefined) {
        return notSentBecause("set both usernameEnv and passwordEnv, or neither");
      }
      const user = resolveSecret(args.usernameEnv, "the SMTP username");
      if (!user.ok) return notSentBecause(user.message);
      const pass = resolveSecret(args.passwordEnv, "the SMTP password");
      if (!pass.ok) return notSentBecause(pass.message);
      username = user.value;
      password = pass.value;
    }

    const built = buildMessage("EmailSend", args);
    if (!built.ok) return notSentBecause(built.message);

    const redact = redactorFor([username, password]);
    const deadline = startDeadline(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx?.signal);
    try {
      assertSmtpHostAllowed(args.host, cfg);
      const pinnedIp = await assertNotSsrf(args.host);
      const port = args.port ?? 587;
      const outcome = await sendMail({
        host: args.host,
        port,
        pinnedIp,
        implicitTls: port === 465,
        requireTls: args.requireTls ?? true,
        rejectUnauthorized: true,
        username,
        password,
        authMethod: args.authMethod ?? "auto",
        ehloName: args.ehloName ?? "crewhaus.invalid",
        envelopeFrom: args.from.address,
        envelopeTo: built.envelopeTo,
        message: built.message,
        signal: deadline.signal,
        maxReplyBytes: 64 * 1024,
      });
      if (!outcome.ok) {
        return redact(
          `${notSentBecause(outcome.error)}\n${json({ transcript: outcome.transcript })}`,
        );
      }
      const result = redact(
        json({
          sent: true,
          messageId: built.messageId,
          bytes: built.bytes,
          secured: outcome.secured,
          authenticated: outcome.authenticated,
          accepted: outcome.accepted,
          ...(outcome.rejected.length > 0 ? { rejected: outcome.rejected } : {}),
          queued: outcome.queued,
        }),
      );
      ledgerRecord("EmailSend", args.idempotencyKey, result);
      return result;
    } catch (err) {
      return redact(notSentBecause(describeFailure(err, deadline)));
    } finally {
      deadline.cancel();
    }
  },
});

// ---------------------------------------------------------------------------
// preflight — the email tool that sends nothing
// ---------------------------------------------------------------------------

type AttachmentRow = {
  readonly path: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly bytes?: number;
};

type AttachmentSurvey = {
  readonly rows: readonly AttachmentRow[];
  readonly bytes: number;
  /** False when at least one file could not be read AS GIVEN. */
  readonly allReadable: boolean;
};

/**
 * Stat every attachment through the path gate, and keep going after the
 * first problem.
 *
 * `loadAttachments` stops at the first fault because it is on the way to a
 * send; this is the report, so each file gets its own row. Both resolve the
 * path with `resolveSafe` and both stat `safe.real` — the location the read
 * would actually land on, symlinks already followed. Statting the path the
 * caller wrote and reading the one the resolver returns is how a file
 * outside the workspace gets measured as one inside it.
 */
function surveyAttachments(
  specs: ComposeArgs["attachments"],
  perAttachmentBytes: number,
): AttachmentSurvey {
  const rows: AttachmentRow[] = [];
  let bytes = 0;
  let allReadable = true;
  for (const spec of specs ?? []) {
    let safe: ReturnType<typeof resolveSafe>;
    try {
      safe = resolveSafe("EmailSendPreflight", spec.path);
    } catch (err) {
      allReadable = false;
      rows.push({ path: spec.path, status: "fail", detail: (err as Error).message });
      continue;
    }
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(safe.real);
    } catch (err) {
      // Missing, unreadable and "a directory component is not a directory"
      // are different answers, and none of them is "the attachment is fine".
      // The errno is carried through rather than flattened, because it is
      // what tells the caller whether to fix a path or a permission.
      allReadable = false;
      const code = (err as NodeJS.ErrnoException).code ?? "unknown";
      rows.push({
        path: spec.path,
        status: "unknown",
        detail: `could not be read (${code}), so whether this message can be sent is not known`,
      });
      continue;
    }
    if (!stat.isFile()) {
      allReadable = false;
      rows.push({ path: spec.path, status: "fail", detail: "is not a regular file" });
      continue;
    }
    bytes += stat.size;
    rows.push({
      path: spec.path,
      status: stat.size > perAttachmentBytes ? "fail" : "pass",
      detail:
        stat.size > perAttachmentBytes
          ? `${stat.size} bytes, over the ${perAttachmentBytes}-byte per-attachment budget`
          : `${stat.size} bytes`,
      bytes: stat.size,
    });
  }
  return { rows, bytes, allReadable };
}

export const emailSendPreflight: RegisteredTool = buildTool({
  name: "EmailSendPreflight",
  description:
    "Check a message the way EmailSend would build it, and send nothing. Use it before a send to find out in one call what would otherwise come back one refusal at a time: whether the From parses, whether there is an envelope at all, whether a recipient is outside the operator's allow-list, whether a header would be refused, whether the body is accidentally empty, whether a {{placeholder}} never got filled, and whether the attachments are readable and inside the size budget you state. It takes the SAME arguments as EmailSend and runs the SAME composer, so a message this reports as ready is a message that assembles; the Message-ID and byte count it returns are the real ones. It never opens a socket — not to a mail server, not to DNS — and a check that could not run comes back as unknown with its reason rather than as a pass.",
  inputSchema: z.object({
    ...composeShape,
    host: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe(
        "the SMTP host the send would use, checked against allowed_smtp_hosts only — no connection is made and no name is resolved",
      ),
    maxMessageBytes: z
      .number()
      .int()
      .min(1)
      .max(MAX_MESSAGE_BYTES)
      .optional()
      .describe(
        `the budget the assembled message must fit, e.g. the receiving provider's limit (default ${MAX_MESSAGE_BYTES}, which is this package's own cap)`,
      ),
    maxAttachmentBytes: z
      .number()
      .int()
      .min(1)
      .max(MAX_ATTACHMENT_BYTES)
      .optional()
      .describe(`the budget any single attachment must fit (default ${MAX_ATTACHMENT_BYTES})`),
  }),
  scope: "internal",
  readOnly: true,
  concurrencySafe: true,
  execute: async (input, ctx) => {
    const args = input as ComposeArgs & {
      host?: string;
      maxMessageBytes?: number;
      maxAttachmentBytes?: number;
    };
    const cfg = resolveNotifyConfig(ctx?.toolConfig);
    const messageBudget = args.maxMessageBytes ?? MAX_MESSAGE_BYTES;
    const attachmentBudget = args.maxAttachmentBytes ?? MAX_ATTACHMENT_BYTES;

    const checks: Check[] = draftChecks({
      from: args.from,
      to: args.to ?? [],
      cc: args.cc ?? [],
      bcc: args.bcc ?? [],
      replyTo: args.replyTo ?? [],
      subject: args.subject,
      text: args.text,
      html: args.html,
      date: args.date,
      inReplyTo: args.inReplyTo,
      references: args.references,
      headers: args.headers,
    });

    // The same predicate EmailSend gates on, asked ahead of time. An empty
    // allow-list refuses everyone, and saying so here is the point.
    const everyone = [...(args.to ?? []), ...(args.cc ?? []), ...(args.bcc ?? [])];
    const refused = everyone
      .map((m) => m.address)
      .filter((address) => !recipientAllowed(address, cfg))
      .sort(byString);
    checks.push(
      everyone.length === 0
        ? {
            check: "recipients-allowed",
            status: "unknown",
            detail: "there are no recipients to check against allowed_recipients",
          }
        : refused.length === 0
          ? {
              check: "recipients-allowed",
              status: "pass",
              detail: `all ${everyone.length} recipients are in allowed_recipients`,
            }
          : {
              check: "recipients-allowed",
              status: "fail",
              detail: `${refused.join(", ")} ${refused.length === 1 ? "is" : "are"} not in allowed_recipients${cfg.allowedRecipients.length === 0 ? " (the allow-list is empty, which refuses everyone)" : ""}`,
            },
    );

    if (args.host !== undefined) {
      try {
        assertSmtpHostAllowed(args.host, cfg);
        checks.push({
          check: "smtp-host",
          status: "pass",
          detail: `"${args.host}" is in allowed_smtp_hosts. Whether it resolves, and to what, is not checked here — that needs DNS`,
        });
      } catch (err) {
        checks.push({
          check: "smtp-host",
          status: "fail",
          detail: describeFailure(err),
        });
      }
    }

    const survey = surveyAttachments(args.attachments, attachmentBudget);
    // A "fail" row is either a path the gate refused or a file over the
    // stated budget; both are reported with their own reason rather than
    // summarised into one, because they are fixed differently.
    const refusedFiles = survey.rows.filter((row) => row.status === "fail");
    const unreadable = survey.rows.filter((row) => row.status === "unknown");
    // A refusal OUTRANKS an unknown, and this order is the whole point: one
    // refused path already decides the answer, and reporting "somebody has
    // to look" for a message that is settled is the same defect as reporting
    // an unanswered question as a pass, pointed the other way. The unknown
    // rows are still named, because they are a second thing to fix.
    const unreadableNames = unreadable.map((row) => `"${row.path}"`).join(", ");
    checks.push(
      survey.rows.length === 0
        ? { check: "attachments", status: "pass", detail: "no attachments" }
        : refusedFiles.length > 0
          ? {
              check: "attachments",
              status: "fail",
              detail: `${refusedFiles.map((row) => `"${row.path}": ${row.detail}`).join("; ")}${
                unreadable.length > 0 ? `; and ${unreadableNames} could not be read` : ""
              }`,
            }
          : unreadable.length > 0
            ? {
                check: "attachments",
                status: "unknown",
                detail: `${unreadableNames} could not be read, so the message cannot be judged`,
              }
            : {
                check: "attachments",
                status: "pass",
                detail: `${survey.rows.length} file${survey.rows.length === 1 ? "" : "s"}, ${survey.bytes} bytes before encoding`,
              },
    );

    // Assembly is attempted only when every attachment could be read as
    // given: building the message without one would validate a DIFFERENT
    // message than the one that would be sent, and reporting it as ready
    // would be a lie about bytes nobody has seen.
    const built = survey.allReadable ? buildMessage("EmailSendPreflight", args) : null;
    if (built === null) {
      // Same precedence as the row above: a refused path is a settled "no",
      // and it stays a "no" however many other attachments were merely
      // unreadable. Only an unknown with NO refusal beside it is an unknown.
      const refusedAny = refusedFiles.length > 0;
      const reason = refusedAny ? "was refused" : "could not be read";
      checks.push({
        check: "assembly",
        status: refusedAny ? "fail" : "unknown",
        detail: `not attempted: an attachment ${reason}, so the bytes that would be sent cannot be built`,
      });
      checks.push({
        check: "size",
        status: "unknown",
        detail: "the message was not assembled, so its size is not known",
      });
      checks.push({
        check: "message-id",
        status: "unknown",
        detail: "the message was not assembled, so no Message-ID was derived",
      });
    } else if (!built.ok) {
      checks.push({
        check: "assembly",
        status: "fail",
        detail: `the composer refused this message: ${built.message}`,
      });
      checks.push({
        check: "size",
        status: "unknown",
        detail: "the message was not assembled, so its size is not known",
      });
      checks.push({
        check: "message-id",
        status: "unknown",
        detail: "the message was not assembled, so no Message-ID was derived",
      });
    } else {
      checks.push({
        check: "assembly",
        status: "pass",
        detail: `the message assembles, to ${built.envelopeTo.length} envelope recipient${built.envelopeTo.length === 1 ? "" : "s"}`,
      });
      checks.push(
        built.bytes > messageBudget
          ? {
              check: "size",
              status: "fail",
              detail: `${built.bytes} bytes, over the ${messageBudget}-byte budget`,
            }
          : {
              check: "size",
              status: "pass",
              detail: `${built.bytes} bytes, inside the ${messageBudget}-byte budget`,
            },
      );
      checks.push({
        check: "message-id",
        status: "pass",
        detail: `${built.messageId}, derived from the message's own content and the sender's domain`,
      });
    }

    return json({
      verdict: verdictFrom(checks),
      checks,
      ...(survey.rows.length > 0 ? { attachments: survey.rows } : {}),
      ...(built?.ok === true
        ? { messageId: built.messageId, bytes: built.bytes, envelopeTo: built.envelopeTo }
        : {}),
      budget: { message: messageBudget, perAttachment: attachmentBudget },
    });
  },
});

// ---------------------------------------------------------------------------
// webhook
// ---------------------------------------------------------------------------

export const webhookPost: RegisteredTool = buildTool({
  name: "WebhookPost",
  description:
    "POST a JSON payload to an allow-listed URL, optionally HMAC-signed, retrying only on 5xx and only on a backoff the call declares. Use it to hand an event to something that is not a chat platform — a pager, an internal receiver, a partner endpoint. Signing runs over the exact bytes transmitted, in either the timestamped (Stripe-style) or body-only (GitHub-style) scheme, and the timestamp is an argument rather than a clock reading so the same call signs the same way twice. The backoff is exponential with no jitter, because unseeded randomness makes a run unreproducible, and it never sleeps past the deadline. An idempotency key makes a retry safe end to end: the key travels to the receiver and a repeat call returns the first result instead of delivering again.",
  inputSchema: z.object({
    url: z
      .string()
      .min(1)
      .optional()
      .describe(
        "the endpoint; its origin must be allow-listed. An incoming-webhook URL whose path is itself the credential (Slack /services/…, Discord /api/webhooks/…, Teams /webhookb2/…) is refused here — name it in urlEnv instead",
      ),
    urlEnv: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "NAME of an environment variable holding the URL, for an endpoint whose path is itself a secret",
      ),
    payload: z
      .union([z.record(z.unknown()), z.array(z.unknown()), z.string()])
      .describe(
        "an object or array, sent as JSON, or a string sent verbatim — a signature covers exactly these bytes",
      ),
    headers: z
      .record(z.string())
      .optional()
      .describe(
        "extra headers; Authorization, Proxy-Authorization and Cookie are refused here — use auth",
      ),
    auth: authSchema,
    signing: z
      .object({
        secretEnv: envVarSchema("the signing secret"),
        scheme: z
          .enum(["timestamped", "body"])
          .describe(
            "timestamped covers <seconds>.<body> and enables a replay window; body covers the body alone and has no replay protection",
          ),
        algorithm: z.enum(["sha256", "sha1"]).optional().describe("default sha256"),
        header: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe("header to carry the signature (default X-Signature)"),
        timestampSeconds: z
          .number()
          .int()
          .optional()
          .describe("REQUIRED for the timestamped scheme — this tool does not read the clock"),
      })
      .optional(),
    idempotencyKey: idempotencySchema,
    idempotencyHeader: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("header carrying the key (default Idempotency-Key)"),
    retries: z
      .number()
      .int()
      .min(0)
      .max(5)
      .optional()
      .describe("extra attempts after a 5xx or a transport failure (default 0)"),
    backoffMs: z
      .number()
      .int()
      .min(1)
      .max(60_000)
      .optional()
      .describe("first backoff; each retry doubles it (default 500)"),
    timeoutMs: timeoutSchema,
    maxBytes: maxBytesSchema,
  }),
  scope: "external",
  ioCapability: "network",
  destructive: true,
  requireJustification: true,
  execute: async (input, ctx) => {
    const args = input as {
      url?: string;
      urlEnv?: string;
      payload: unknown;
      headers?: Record<string, string>;
      auth?: AuthProfile;
      signing?: {
        secretEnv: string;
        scheme: "timestamped" | "body";
        algorithm?: "sha256" | "sha1";
        header?: string;
        timestampSeconds?: number;
      };
      idempotencyKey?: string;
      idempotencyHeader?: string;
      retries?: number;
      backoffMs?: number;
      timeoutMs?: number;
      maxBytes?: number;
    };
    const cached = ledgerLookup("WebhookPost", args.idempotencyKey);
    if (cached !== undefined) return cached.result;

    if ((args.url === undefined) === (args.urlEnv === undefined)) {
      return notSentBecause("give exactly one of url or urlEnv");
    }
    const urlSecrets: string[] = [];
    let url: URL;
    if (args.urlEnv !== undefined) {
      const resolved = webhookUrlFrom(args.urlEnv);
      if (typeof resolved === "string") return notSentBecause(resolved);
      url = resolved.url;
      urlSecrets.push(resolved.secret, resolved.url.pathname);
    } else {
      const parsed = parseUrl(args.url as string);
      if (typeof parsed === "string") return notSentBecause(parsed);
      const credential = inlineWebhookCredential(parsed);
      if (credential !== null) return notSentBecause(credential);
      url = parsed;
    }

    const body = typeof args.payload === "string" ? args.payload : JSON.stringify(args.payload);
    const headerPrep = prepareHeaders(
      { "content-type": "application/json", ...(args.headers ?? {}) },
      args.auth,
    );
    if (!headerPrep.ok) return notSentBecause(headerPrep.message);
    const headers = headerPrep.headers;
    const secrets = [...urlSecrets, ...headerPrep.secrets];

    if (args.signing !== undefined) {
      const secret = resolveSecret(args.signing.secretEnv, "the signing secret");
      if (!secret.ok) return notSentBecause(secret.message);
      secrets.push(secret.value);
      if (args.signing.scheme === "timestamped" && args.signing.timestampSeconds === undefined) {
        return notSentBecause(
          'the timestamped scheme signs "<seconds>.<body>", so it needs timestampSeconds — this tool does not read the clock, because a signature that changes on every call cannot be tested or replayed deliberately',
        );
      }
      const algorithm = args.signing.algorithm ?? "sha256";
      const payloadToSign = signedPayload(args.signing.scheme, body, args.signing.timestampSeconds);
      headers[args.signing.header ?? "X-Signature"] = formatSignatureHeader(
        args.signing.scheme,
        hmacHex(secret.value, payloadToSign, algorithm),
        algorithm,
        args.signing.timestampSeconds,
      );
    }
    if (args.idempotencyKey !== undefined) {
      headers[args.idempotencyHeader ?? "Idempotency-Key"] = args.idempotencyKey;
    }

    const prepared = withRedaction(secrets, args.timeoutMs, ctx);
    const retries = args.retries ?? 0;
    const backoffMs = args.backoffMs ?? 500;
    const attempts: Array<{ attempt: number; status?: number; error?: string }> = [];
    try {
      for (let attempt = 0; ; attempt++) {
        let outcome: SendOutcome | null = null;
        let transportError: string | null = null;
        try {
          outcome = await send(
            url,
            "POST",
            headers,
            body,
            prepared,
            args.maxBytes ?? DEFAULT_MAX_BYTES,
            headerPrep.secretHeaders,
          );
        } catch (err) {
          if (err instanceof NotifyPermissionError) throw err;
          transportError = describeFailure(err, prepared.deadline);
        }

        if (outcome?.ok === true) {
          const result = prepared.redact(
            json({
              sent: true,
              status: outcome.status,
              attempts: attempt + 1,
              bytes: body.length,
              signed: args.signing !== undefined,
              ...(attempts.length > 0 ? { earlierAttempts: attempts } : {}),
              ...(outcome.body !== "" ? { response: outcome.body } : {}),
            }),
          );
          ledgerRecord("WebhookPost", args.idempotencyKey, result);
          return result;
        }

        const retryable = outcome === null || outcome.status >= 500;
        attempts.push({
          attempt: attempt + 1,
          ...(outcome !== null ? { status: outcome.status } : {}),
          ...(transportError !== null ? { error: transportError } : {}),
        });
        if (!retryable) {
          return prepared.redact(
            notSentBecause(
              `${safeUrlLabel(url)} answered ${(outcome as SendOutcome).status}, which is not a retryable status: ${(outcome as SendOutcome).body.slice(0, 500)}`,
            ),
          );
        }
        if (attempt >= retries) {
          return prepared.redact(
            `${notSentBecause(`all ${attempt + 1} attempt(s) failed`)}\n${json({ attempts })}`,
          );
        }
        const delay = backoffMs * 2 ** attempt;
        if (delay >= prepared.deadline.remaining()) {
          return prepared.redact(
            `${notSentBecause(`the next backoff of ${delay}ms would outlast the deadline`)}\n${json({ attempts })}`,
          );
        }
        await sleep(delay, prepared.deadline.signal);
      }
    } catch (err) {
      return prepared.redact(notSentBecause(describeFailure(err, prepared.deadline)));
    } finally {
      prepared.deadline.cancel();
    }
  },
});

// ---------------------------------------------------------------------------
// provider-shaped sends
// ---------------------------------------------------------------------------

type ProviderCall =
  | {
      readonly ok: true;
      readonly url: URL;
      readonly method: string;
      readonly headers: Record<string, string>;
      readonly body: string;
      readonly secrets: string[];
      readonly secretHeaders: ReadonlySet<string>;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Turn a canonical field map into the request a named provider expects.
 *
 * Hard-coding a vendor here would mean a release every time somebody changes
 * gateway. The operator names the endpoint, the auth variable and the field
 * mapping in `tool_config.notify.providers`, and a canonical field with no
 * mapping is simply not sent — so a provider that has no `from` concept does
 * not receive an empty one.
 */
function buildProviderCall(
  cfg: NotifyConfig,
  providerName: string,
  values: Readonly<Record<string, string>>,
  idempotencyKey: string | undefined,
): ProviderCall {
  const profile = cfg.providers.get(providerName);
  if (profile === undefined) {
    const known = [...cfg.providers.keys()].sort(byString);
    return {
      ok: false,
      message:
        known.length === 0
          ? `no provider "${providerName}": tool_config.notify.providers is empty, so there is nothing to send through`
          : `no provider "${providerName}"; configured providers are ${known.join(", ")}`,
    };
  }
  const parsed = parseUrl(profile.endpoint);
  if (typeof parsed === "string")
    return { ok: false, message: `provider "${providerName}" has an unusable endpoint` };

  const headers: Record<string, string> = {};
  const applied = applyAuth(headers, profile.auth);
  if (!applied.ok) return { ok: false, message: applied.message };
  if (idempotencyKey !== undefined && profile.idempotencyHeader !== undefined) {
    headers[profile.idempotencyHeader] = idempotencyKey;
  }

  const mapped: Record<string, string> = { ...(profile.staticFields ?? {}) };
  for (const [canonical, value] of Object.entries(values)) {
    const name = profile.fields?.[canonical];
    if (name === undefined || value === "") continue;
    mapped[name] = value;
  }

  let body: string;
  if ((profile.encoding ?? "json") === "form") {
    headers["content-type"] = "application/x-www-form-urlencoded";
    const form = new URLSearchParams();
    for (const key of Object.keys(mapped).sort(byString)) form.set(key, mapped[key] as string);
    body = form.toString();
  } else {
    headers["content-type"] = "application/json";
    const ordered: Record<string, string> = {};
    for (const key of Object.keys(mapped).sort(byString)) ordered[key] = mapped[key] as string;
    body = JSON.stringify(ordered);
  }

  return {
    ok: true,
    url: parsed,
    method: profile.method ?? "POST",
    headers,
    body,
    secrets: [...applied.secrets],
    secretHeaders: applied.secretHeaders,
  };
}

/** The shared execute body for SmsSend and PushNotify. */
async function runProviderSend(
  toolName: string,
  providerName: string,
  values: Readonly<Record<string, string>>,
  args: { idempotencyKey?: string; timeoutMs?: number; maxBytes?: number },
  ctx: ToolExecuteContext | undefined,
): Promise<string> {
  const cached = ledgerLookup(toolName, args.idempotencyKey);
  if (cached !== undefined) return cached.result;

  const cfg = resolveNotifyConfig(ctx?.toolConfig);
  const call = buildProviderCall(cfg, providerName, values, args.idempotencyKey);
  if (!call.ok) return notSentBecause(call.message);

  const prepared: Prepared = {
    cfg,
    deadline: startDeadline(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx?.signal),
    redact: redactorFor(call.secrets),
  };
  try {
    const outcome = await send(
      call.url,
      call.method,
      call.headers,
      call.body,
      prepared,
      args.maxBytes ?? DEFAULT_MAX_BYTES,
      call.secretHeaders,
    );
    if (!outcome.ok) {
      return prepared.redact(
        notSentBecause(
          `${safeUrlLabel(call.url)} answered ${outcome.status}: ${outcome.body.slice(0, 500)}`,
        ),
      );
    }
    const profile = cfg.providers.get(providerName) as ProviderProfile;
    const id = profile.idPath === undefined ? undefined : readPath(outcome.parsed, profile.idPath);
    const status =
      profile.statusPath === undefined ? undefined : readPath(outcome.parsed, profile.statusPath);
    const result = prepared.redact(
      json({
        sent: true,
        provider: providerName,
        status: outcome.status,
        ...(typeof id === "string" || typeof id === "number" ? { messageId: String(id) } : {}),
        ...(typeof status === "string" ? { deliveryStatus: status } : {}),
      }),
    );
    ledgerRecord(toolName, args.idempotencyKey, result);
    return result;
  } catch (err) {
    return prepared.redact(notSentBecause(describeFailure(err, prepared.deadline)));
  } finally {
    prepared.deadline.cancel();
  }
}

export const smsSend: RegisteredTool = buildTool({
  name: "SmsSend",
  description:
    "Send an SMS through a REST gateway the operator described in tool_config, rather than through a vendor this tool picked. Use it for the small number of notifications that must reach somebody who is not looking at a screen. The provider block names the endpoint, the auth environment variable and how the canonical fields to, body and from map onto that vendor's own names, so changing gateway is a config diff and not a release. An SMS costs money, arrives on a phone and cannot be recalled, so it is destructive, takes a justification, and takes an idempotency key that makes a retried call return the first result instead of sending a second message. It does not split a long message into parts or tell you what the carrier charged.",
  inputSchema: z.object({
    provider: z.string().min(1).max(100).describe("a name from tool_config.notify.providers"),
    to: z
      .string()
      .min(1)
      .max(100)
      .describe("the destination number, in the format the provider expects (E.164 for most)"),
    body: z
      .string()
      .min(1)
      .max(2000)
      .describe("the message text; sent as-is, since SMS has no markup to escape"),
    from: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("sender id, where the provider takes one per message"),
    idempotencyKey: idempotencySchema,
    timeoutMs: timeoutSchema,
    maxBytes: maxBytesSchema,
  }),
  scope: "external",
  ioCapability: "network",
  destructive: true,
  requireJustification: true,
  execute: async (input, ctx) => {
    const args = input as {
      provider: string;
      to: string;
      body: string;
      from?: string;
      idempotencyKey?: string;
      timeoutMs?: number;
      maxBytes?: number;
    };
    return runProviderSend(
      "SmsSend",
      args.provider,
      { to: args.to, body: args.body, from: args.from ?? "" },
      args,
      ctx,
    );
  },
});

export const pushNotify: RegisteredTool = buildTool({
  name: "PushNotify",
  description:
    "Send a push notification through a REST provider the operator described in tool_config. Use it to reach an app or a device when a chat message would not be seen in time. It works exactly as SmsSend does — the provider block maps the canonical fields to, title, body and data onto the vendor's names — so one configuration style covers both, and a provider with no title concept simply never receives one. A push lands on a lock screen, so it is destructive and takes a justification; the idempotency key makes a retry safe. It does not manage device tokens, topics or subscriptions, and it reports what the provider answered rather than whether anyone read it.",
  inputSchema: z.object({
    provider: z.string().min(1).max(100).describe("a name from tool_config.notify.providers"),
    to: z
      .string()
      .min(1)
      .max(500)
      .describe("device token, topic or whatever the provider addresses"),
    title: z.string().max(200).optional(),
    body: z.string().min(1).max(4000),
    data: z
      .record(z.string())
      .optional()
      .describe("extra key/value data, sent as one JSON string in the provider's data field"),
    idempotencyKey: idempotencySchema,
    timeoutMs: timeoutSchema,
    maxBytes: maxBytesSchema,
  }),
  scope: "external",
  ioCapability: "network",
  destructive: true,
  requireJustification: true,
  execute: async (input, ctx) => {
    const args = input as {
      provider: string;
      to: string;
      title?: string;
      body: string;
      data?: Record<string, string>;
      idempotencyKey?: string;
      timeoutMs?: number;
      maxBytes?: number;
    };
    const ordered: Record<string, string> = {};
    for (const key of Object.keys(args.data ?? {}).sort(byString)) {
      ordered[key] = (args.data as Record<string, string>)[key] as string;
    }
    return runProviderSend(
      "PushNotify",
      args.provider,
      {
        to: args.to,
        title: args.title ?? "",
        body: args.body,
        data: args.data === undefined ? "" : JSON.stringify(ordered),
      },
      args,
      ctx,
    );
  },
});

export const deliveryCheck: RegisteredTool = buildTool({
  name: "DeliveryCheck",
  description:
    "Ask a provider what became of a message it accepted earlier, where its API answers that question. Use it after SmsSend or PushNotify to tell 'the gateway took it' apart from 'the handset got it', which are not the same thing and are reported hours apart. It reads the statusEndpoint and statusPath the operator configured for that provider, substituting the message id into the URL, and it only reads — this is the one outbound tool here that is readOnly and needs no justification. A provider with no status endpoint configured is reported as such rather than guessed at, and an unknown id is whatever the provider says it is.",
  inputSchema: z.object({
    provider: z.string().min(1).max(100).describe("a name from tool_config.notify.providers"),
    messageId: z
      .string()
      .min(1)
      .max(200)
      .describe("the id a send returned; substituted for {id} in statusEndpoint"),
    timeoutMs: timeoutSchema,
    maxBytes: maxBytesSchema,
  }),
  scope: "external",
  ioCapability: "network",
  readOnly: true,
  execute: async (input, ctx) => {
    const args = input as {
      provider: string;
      messageId: string;
      timeoutMs?: number;
      maxBytes?: number;
    };
    const cfg = resolveNotifyConfig(ctx?.toolConfig);
    const profile = cfg.providers.get(args.provider);
    if (profile === undefined) {
      const known = [...cfg.providers.keys()].sort(byString);
      return known.length === 0
        ? "tool_config.notify.providers is empty, so there is no provider to ask"
        : `no provider "${args.provider}"; configured providers are ${known.join(", ")}`;
    }
    if (profile.statusEndpoint === undefined) {
      return `provider "${args.provider}" has no statusEndpoint configured — this provider's API may not report delivery state at all, and this tool will not invent one`;
    }
    if (!/^[A-Za-z0-9_.:-]+$/.test(args.messageId)) {
      return "messageId must be a plain identifier (letters, digits, dot, underscore, colon or hyphen) — anything else could rewrite the URL it is substituted into";
    }
    const parsed = parseUrl(
      profile.statusEndpoint.split("{id}").join(encodeURIComponent(args.messageId)),
    );
    if (typeof parsed === "string")
      return `provider "${args.provider}" has an unusable statusEndpoint`;

    const headers: Record<string, string> = {};
    const applied = applyAuth(headers, profile.auth);
    if (!applied.ok) return applied.message;

    const cfgForCall: NotifyConfig = cfg;
    const deadline = startDeadline(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx?.signal);
    const redact = redactorFor([...applied.secrets]);
    try {
      assertOriginAllowed(parsed, cfgForCall);
      const opened = await openRequest({
        url: parsed,
        method: "GET",
        headers,
        signal: deadline.signal,
        cfg: cfgForCall,
        redirect: "follow",
        credentialHeaders: applied.secretHeaders,
      });
      const capped = await readCapped(opened.res, args.maxBytes ?? DEFAULT_MAX_BYTES);
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(capped.text);
      } catch {
        parsedBody = undefined;
      }
      const state =
        profile.statusPath === undefined ? undefined : readPath(parsedBody, profile.statusPath);
      return redact(
        json({
          provider: args.provider,
          messageId: args.messageId,
          status: opened.res.status,
          ...(typeof state === "string" || typeof state === "number"
            ? { deliveryStatus: String(state) }
            : {}),
          ...(opened.credentialsDropped ? { credentialsDroppedAtRedirect: true } : {}),
          body: capped.text,
          ...(capped.truncated ? { truncated: true } : {}),
        }),
      );
    } catch (err) {
      return redact(describeFailure(err, deadline));
    } finally {
      deadline.cancel();
    }
  },
});

// ---------------------------------------------------------------------------
// what a sending domain publishes about itself
// ---------------------------------------------------------------------------

/** The four TXT outcomes, folded into the shape a record answer has. */
function absentOrUnknown(
  answer: TxtAnswer,
  what: string,
): { status: "absent"; detail: string } | { status: "unknown"; detail: string } {
  if (answer.outcome === "unknown") {
    return {
      status: "unknown",
      detail: `${answer.reason} — this is not the same as "${what}", and nothing here should be read as one`,
    };
  }
  return {
    status: "absent",
    detail:
      answer.outcome === "nxdomain"
        ? "the name does not exist, so nothing is published there"
        : "the name exists and publishes no TXT record",
  };
}

/**
 * The SPF record as a result object.
 *
 * `absent` here means something narrower than the outer one: the domain DOES
 * publish TXT records and none of them is an SPF record. Keeping the two
 * apart matters when a domain's TXT set was replaced by something that
 * dropped the SPF line.
 */
function describeSpf(answer: SpfAnswer): Record<string, unknown> {
  if (answer.status === "absent") {
    return {
      status: "absent",
      detail: "the domain publishes TXT records and none of them is an SPF record",
    };
  }
  if (answer.status === "multiple") {
    return {
      status: "multiple",
      records: answer.records,
      detail:
        "more than one SPF record: RFC 7208 4.5 makes a receiver return permerror, which fails every sender rather than the wrong ones",
    };
  }
  if (answer.status === "unreadable") {
    return { status: "unreadable", record: answer.record, detail: answer.reason };
  }
  const parsed = answer.parsed;
  const notes = [...parsed.notes];
  if (parsed.dnsTermsHere > 0) {
    // Said plainly rather than left for the reader to assume: each include:
    // pulls in a record whose own terms count toward the same limit of ten,
    // and this tool does not follow them — it queries only the domain it was
    // given. A walked total that got the void-lookup and sub-limit rules
    // wrong would be a worse answer than an honest floor.
    notes.push(
      "dnsTermsInThisRecord counts only the terms in this record; each include: or redirect= pulls in another record whose terms count toward the same limit of ten, and those are not followed",
    );
  }
  return {
    status: "found",
    record: parsed.record,
    all: parsed.all,
    mechanisms: parsed.mechanisms,
    modifiers: parsed.modifiers,
    dnsTermsInThisRecord: parsed.dnsTermsHere,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

function describeDmarc(answer: DmarcAnswer): Record<string, unknown> {
  if (answer.status === "absent") {
    return {
      status: "absent",
      // Stops at the name that was asked. "…so the domain has no DMARC
      // policy" was the conclusion here before, and it is one query short of
      // true: RFC 7489 6.6.3 has a receiver fall back to the ORGANIZATIONAL
      // domain's record, so a subdomain with nothing of its own can still be
      // governed by a p=reject two labels up. The note on the result says so
      // whenever that fallback could apply.
      detail:
        "there are TXT records at _dmarc and none of them begins with v=DMARC1, which RFC 7489 6.6.3 requires — so no DMARC record is published at this name",
    };
  }
  if (answer.status === "multiple") {
    return {
      status: "multiple",
      records: answer.records,
      detail:
        "more than one v=DMARC1 record: RFC 7489 6.6.3 says the domain is then treated as publishing none at all",
    };
  }
  if (answer.status === "unreadable") {
    return { status: "unreadable", record: answer.record, detail: answer.reason };
  }
  const parsed = answer.parsed;
  return {
    status: "found",
    record: parsed.record,
    policy: parsed.policy,
    subdomainPolicy: parsed.subdomainPolicy,
    percent: parsed.percent,
    tags: parsed.tags,
    ...(parsed.notes.length > 0 ? { notes: parsed.notes } : {}),
  };
}

/**
 * The DKIM KEY record as a result object.
 *
 * Note what is not in it: any claim about a signature. This describes the
 * key a selector publishes — its type, its size, whether it has been revoked
 * — which is what a caller can act on without a verifier. `mailauth` is what
 * would be needed to answer the other question, and half of that answer is
 * worse than none.
 */
function describeDkim(answer: DkimAnswer): Record<string, unknown> {
  if (answer.status === "absent") {
    return { status: "absent", detail: "no TXT record at this selector's _domainkey name" };
  }
  if (answer.status === "multiple") {
    return {
      status: "multiple",
      records: answer.records,
      detail:
        "more than one TXT record at this selector, so which key a receiver uses is not decided here",
    };
  }
  if (answer.status === "unreadable") {
    return { status: "unreadable", record: answer.record, detail: answer.reason };
  }
  const parsed = answer.parsed;
  // The verbatim record is NOT repeated here the way it is for SPF and
  // DMARC: a key record is exactly its tags, and `p` alone is a few hundred
  // characters, so printing both spends a caller's context twice on the same
  // base64. A record that could not be parsed is the case where the verbatim
  // text is the only thing worth having, and that branch above prints it.
  return {
    status: "found",
    keyType: parsed.keyType,
    revoked: parsed.revoked,
    ...(parsed.key === null ? {} : { key: parsed.key }),
    tags: parsed.tags,
    ...(parsed.notes.length > 0 ? { notes: parsed.notes } : {}),
  };
}

export const deliverabilityCheck: RegisteredTool = buildTool({
  name: "DeliverabilityCheck",
  description:
    "Read what a sending domain publishes about itself in public DNS — its SPF record, its DMARC policy, and the DKIM key record at each selector you name — and report what each one says. Use it to answer why mail from a domain is being refused or filtered, or to check a domain before a campaign leans on it. It reports facts rather than a score, because the facts differ in what you do next: no DMARC record at all and a DMARC record with p=none are the same score and completely different situations, and a lookup that failed is a third thing again — reported as unknown with its reason, never as 'nothing published'. It does NOT verify a message's DKIM signature: that needs canonicalisation this package does not implement, and a partial check that can answer 'pass' is worse than no check. Only domains an operator put in allowed_sender_domains are looked up.",
  inputSchema: z.object({
    domain: z
      .string()
      .min(1)
      .max(253)
      .describe(
        "the sending domain, e.g. example.com — the domain in the From address, not a recipient's. It must appear in tool_config.notify.allowed_sender_domains",
      ),
    dkimSelectors: z
      .array(z.string().min(1).max(100))
      .max(10)
      .optional()
      .describe(
        'selectors to look for, e.g. ["s1", "google"]. A DKIM key lives at <selector>._domainkey.<domain> and there is no way to enumerate selectors, so this tool checks the ones you name and guesses none',
      ),
    timeoutMs: timeoutSchema,
  }),
  scope: "external",
  ioCapability: "network",
  readOnly: true,
  execute: async (input, ctx) => {
    const args = input as { domain: string; dkimSelectors?: string[]; timeoutMs?: number };
    const cfg = resolveNotifyConfig(ctx?.toolConfig);

    // Parse first, then use the PARSED value everywhere: the allow-list is
    // checked against it, the `_dmarc.` and `._domainkey.` names are built
    // from it, and it is what comes back in the result. A gate that reads
    // one spelling while the resolver is handed another guards nothing.
    const domain = normalizeDomain(args.domain);
    if (!domain.ok) return `nothing was looked up: ${domain.reason}`;

    const selectors: string[] = [];
    for (const raw of args.dkimSelectors ?? []) {
      const selector = normalizeSelector(raw);
      if (!selector.ok) return `nothing was looked up: ${selector.reason}`;
      const name = `${selector.name}._domainkey.${domain.name}`;
      if (name.length > 253) {
        return `nothing was looked up: "${name}" is longer than the 253 octets a DNS name may carry`;
      }
      selectors.push(selector.name);
    }
    // Sorted and de-duplicated, so the same call asks the same questions in
    // the same order and a repeated selector is one lookup rather than two.
    const unique = [...new Set(selectors)].sort(byString);

    const deadline = startDeadline(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx?.signal);
    try {
      assertSenderDomainAllowed(domain.name, cfg);
      const names = [
        domain.name,
        `_dmarc.${domain.name}`,
        ...unique.map((selector) => `${selector}._domainkey.${domain.name}`),
      ];
      // In parallel, assembled by index: the answers are read back in the
      // order the names were built, so which lookup finished first cannot
      // change a byte of the result.
      const answers = await Promise.all(names.map((name) => lookupTxt(name, deadline)));
      const apex = answers[0] as TxtAnswer;
      const dmarcAnswer = answers[1] as TxtAnswer;

      const spf =
        apex.outcome === "records"
          ? describeSpf(parseSpf(apex.records))
          : absentOrUnknown(apex, "the domain publishes no SPF record");
      const dmarcParsed =
        dmarcAnswer.outcome === "records" ? parseDmarc(dmarcAnswer.records) : null;
      const dmarc =
        dmarcParsed === null
          ? absentOrUnknown(dmarcAnswer, "the domain publishes no DMARC record")
          : describeDmarc(dmarcParsed);
      // True when the lookup ANSWERED and the answer was "no policy here" —
      // never when the lookup itself failed, which is its own report.
      const noDmarcHere =
        dmarcParsed === null
          ? dmarcAnswer.outcome === "none" || dmarcAnswer.outcome === "nxdomain"
          : dmarcParsed.status === "absent" || dmarcParsed.status === "multiple";

      const dkim = unique.map((selector, index) => {
        const answer = answers[index + 2] as TxtAnswer;
        return {
          selector,
          ...(answer.outcome === "records"
            ? describeDkim(parseDkim(answer.records))
            : absentOrUnknown(answer, "this selector publishes no key")),
        };
      });

      const notes: string[] = [];
      // "No DMARC record here" is not "no DMARC policy applies here". RFC
      // 7489 6.6.3 says a receiver that finds nothing at _dmarc.<name> asks
      // _dmarc.<organizational domain> next, so mail from a subdomain can be
      // covered by a policy this tool never queried. Naming the organizational
      // domain needs the Public Suffix List — `example.co.uk` is one and
      // `mail.example.com` is not, and nothing in a name says which — which
      // is a dependency this package does not take. So the gap is stated
      // rather than guessed at.
      if (noDmarcHere && domain.name.split(".").length > 2) {
        notes.push(
          `"${domain.name}" has more than two labels, so it may be a subdomain: RFC 7489 6.6.3 has a receiver fall back to the organizational domain's _dmarc record, which was not looked up here. Identifying that domain needs the Public Suffix List, which this package does not carry — ask for it by name to see its policy`,
        );
      }
      if (apex.outcome === "nxdomain") {
        // Said as the fact it is, not as a conclusion about the other names:
        // each of those was asked separately and reports its own answer.
        notes.push(
          "the domain itself returned NXDOMAIN, so there is no name for an SPF record to be published at",
        );
      }
      if (unique.length === 0) {
        notes.push(
          "no DKIM selector was named, so none was checked — a selector cannot be discovered from DNS, only asked for by name",
        );
      }

      return json({
        domain: domain.name,
        spf,
        dmarc,
        dkim,
        lookups: names.map((name, index) => ({
          name,
          outcome: (answers[index] as TxtAnswer).outcome,
        })),
        ...(notes.length > 0 ? { notes } : {}),
      });
    } catch (err) {
      return describeFailure(err, deadline);
    } finally {
      deadline.cancel();
    }
  },
});

// ---------------------------------------------------------------------------
// pure tools
// ---------------------------------------------------------------------------

export const notifyDigest: RegisteredTool = buildTool({
  name: "NotifyDigest",
  description:
    "Fold many events into one message: group them by key, count the repeats, keep the loudest groups and render the result as text or as blocks. Use it before any of the sending tools when a loop could produce more than one notification — this is what stops a watcher sending forty messages about the same broken host when one line saying '38× connection refused' carries more information. Totals always describe every event handed in, and a group that did not fit is reported as a count rather than dropped in silence, because a digest that quietly loses events is one nobody trusts. Pure: no network, no clock, and the same events always fold to the same bytes.",
  inputSchema: z.object({
    events: z
      .array(
        z.object({
          key: z
            .string()
            .min(1)
            .max(500)
            .describe("what makes two events the same; events sharing it are counted together"),
          summary: z
            .string()
            .max(1000)
            .optional()
            .describe("one line about this occurrence; the first seen becomes the group's line"),
          labels: z
            .record(z.string())
            .optional()
            .describe("distinct values are listed under the group, up to eight per label"),
          severity: z.enum(["info", "warning", "error", "critical"]).optional(),
        }),
      )
      .max(5000),
    maxGroups: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("how many groups to render (default 10)"),
    sort: z
      .enum(["count", "severity", "key"])
      .optional()
      .describe("default count, ties broken by key"),
    title: z.string().max(200).optional(),
    format: z
      .enum(["text", "blocks"])
      .optional()
      .describe("default text; blocks feed straight into ChatPost"),
  }),
  scope: "internal",
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const args = input as {
      events: DigestEvent[];
      maxGroups?: number;
      sort?: "count" | "severity" | "key";
      title?: string;
      format?: "text" | "blocks";
    };
    const digest = buildDigest(args.events, {
      ...(args.maxGroups !== undefined ? { maxGroups: args.maxGroups } : {}),
      ...(args.sort !== undefined ? { sort: args.sort } : {}),
    });
    return json({
      total: digest.total,
      distinct: digest.distinct,
      omittedGroups: digest.omittedGroups,
      omittedEvents: digest.omittedEvents,
      groups: digest.groups,
      ...(args.format === "blocks"
        ? { blocks: digestToBlocks(digest, args.title) }
        : { text: digestToText(digest, args.title) }),
    });
  },
});

export const quietHours: RegisteredTool = buildTool({
  name: "QuietHours",
  description:
    "Decide whether a notification may go out at a given instant under a schedule, and if not, when it next may. Use it before a send so a harness holds an overnight alert until the morning instead of waking somebody for something that will read the same at 09:00. Windows are weekday-and-time in a named IANA timezone and may wrap past midnight, blackout dates cover a whole local day, and DST is real rather than approximated — 22:00–07:00 is nine hours in November and eight on the spring-forward night. It never reads the clock: now is an argument, so the same question always gets the same answer and a Sunday in Tokyo is testable from anywhere.",
  inputSchema: z.object({
    schedule: z.object({
      timezone: z.string().min(1).max(100).describe("IANA name, e.g. Europe/Berlin"),
      quietWindows: z
        .array(
          z.object({
            days: z
              .array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]))
              .max(7)
              .optional()
              .describe("days the window STARTS on; omitted means every day"),
            start: z.string().min(4).max(5).describe("HH:MM local"),
            end: z
              .string()
              .min(4)
              .max(5)
              .describe("HH:MM local; earlier than start means the window wraps past midnight"),
          }),
        )
        .max(50),
      blackoutDates: z
        .array(z.string().min(10).max(10))
        .max(200)
        .optional()
        .describe("YYYY-MM-DD local dates that are quiet all day"),
    }),
    now: z
      .string()
      .min(1)
      .describe(
        "REQUIRED instant, ISO-8601 with an offset (e.g. 2026-09-17T03:14:00Z) — this tool does not read the clock",
      ),
  }),
  scope: "internal",
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const args = input as {
      schedule: {
        timezone: string;
        quietWindows: Array<{ days?: Weekday[]; start: string; end: string }>;
        blackoutDates?: string[];
      };
      now: string;
    };
    const now = new Date(args.now);
    if (Number.isNaN(now.getTime())) {
      return `"${args.now}" is not an instant this tool can read — use ISO-8601 with an offset, e.g. 2026-09-17T03:14:00Z`;
    }
    const decision = quietDecision(args.schedule as QuietSchedule, now.getTime());
    if ("error" in decision) return decision.error;
    return json(decision);
  },
});

export const rateLimitGate: RegisteredTool = buildTool({
  name: "RateLimitGate",
  description:
    "Ask whether a key has already been notified inside a window, and get back both the decision and the state to persist. Use it to keep a loop from re-reporting the same thing every cycle: the harness keeps the returned state wherever its own state lives, hands it back next time, and the gate answers from it. The window is fixed rather than sliding, because a sliding window needs every timestamp retained and grows without bound in exactly the flood this exists to stop. Nothing is remembered inside the tool — a memory that dies with the process would let the flood return on the first restart — and nothing reads the clock: now is an argument. Expired keys are pruned out of the state it hands back, so the record cannot grow forever.",
  inputSchema: z.object({
    key: z
      .string()
      .min(1)
      .max(500)
      .describe("what is being rate-limited: an alert name, a host, a customer id"),
    now: z
      .string()
      .min(1)
      .describe("REQUIRED instant, ISO-8601 with an offset — this tool does not read the clock"),
    windowMs: z
      .number()
      .int()
      .min(1)
      .max(30 * 24 * 3_600_000)
      .describe("how long the window lasts"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("sends allowed per window (default 1 — tell me once)"),
    mode: z
      .enum(["consume", "peek"])
      .optional()
      .describe(
        'default consume, which records the send. "peek" answers without changing the state',
      ),
    state: z
      .record(z.object({ windowStart: z.number(), count: z.number(), last: z.number() }))
      .optional()
      .describe("the record returned by the previous call; omitted means a fresh one"),
  }),
  scope: "internal",
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const args = input as {
      key: string;
      now: string;
      windowMs: number;
      limit?: number;
      mode?: "consume" | "peek";
      state?: RateState;
    };
    const now = new Date(args.now);
    if (Number.isNaN(now.getTime())) {
      return `"${args.now}" is not an instant this tool can read — use ISO-8601 with an offset, e.g. 2026-09-17T03:14:00Z`;
    }
    return json(
      evaluateRateLimit({
        key: args.key,
        nowMs: now.getTime(),
        windowMs: args.windowMs,
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.mode !== undefined ? { mode: args.mode } : {}),
        ...(args.state !== undefined ? { state: args.state } : {}),
      }),
    );
  },
});

export const messageTemplate: RegisteredTool = buildTool({
  name: "MessageTemplate",
  description:
    "Render a message from a named template and a data object, escaping every substituted value for the destination platform. Use it so the operator owns the message's structure and the run only supplies values: the template's own formatting is honoured, and a value containing <!channel>, @everyone or a code fence can change what the message says but never what it does. A missing key is an error rather than an empty string, because a notification reading 'deploy of  failed at ' is worse than one that did not go out — somebody acts on it. Pure, with no clock and no network; it returns the text, which is what you hand to ChatPost.",
  inputSchema: z.object({
    templates: z
      .record(z.string().max(20_000))
      .describe("the operator's templates by name; structure lives here, never in the data"),
    name: z.string().min(1).max(200).describe("which template to render"),
    data: z
      .record(z.unknown())
      .describe("values for the {{placeholders}}; dotted paths read nested objects"),
    platform: platformSchema,
    maxLength: z
      .number()
      .int()
      .min(1)
      .max(100_000)
      .optional()
      .describe("cut the result to this many characters"),
  }),
  scope: "internal",
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const args = input as {
      templates: Record<string, string>;
      name: string;
      data: Record<string, unknown>;
      platform: Platform;
      maxLength?: number;
    };
    const template = args.templates[args.name];
    if (template === undefined) {
      const known = Object.keys(args.templates).sort(byString);
      return known.length === 0
        ? "no templates were given, so there is nothing to render"
        : `no template named "${args.name}"; the templates given are ${known.join(", ")}`;
    }
    const rendered = renderTemplateValues(template, args.data, args.platform);
    if (!rendered.ok) {
      return `the template was not rendered: it refers to ${rendered.missing.map((m) => `{{${m}}}`).join(", ")}, which the data does not supply. A missing value is an error here rather than an empty string, because a message with a hole in it still gets acted on`;
    }
    let text = rendered.text;
    let truncated = false;
    if (args.maxLength !== undefined && text.length > args.maxLength) {
      text = text.slice(0, args.maxLength);
      truncated = true;
    }
    return json({
      text,
      platform: args.platform,
      placeholders: rendered.used,
      ...(rendered.unused.length > 0 ? { unusedData: rendered.unused } : {}),
      ...(truncated ? { truncated: true } : {}),
    });
  },
});

/** Every tool this package registers, in the order a catalog should list them. */
export const NOTIFY_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  chatDelete,
  chatPost,
  chatReact,
  chatUpdate,
  deliverabilityCheck,
  deliveryCheck,
  emailCompose,
  emailSend,
  emailSendPreflight,
  messageTemplate,
  notifyDigest,
  pushNotify,
  quietHours,
  rateLimitGate,
  smsSend,
  webhookPost,
]);
