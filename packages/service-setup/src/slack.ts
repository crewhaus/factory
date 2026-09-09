/**
 * Slack app management: build a complete app manifest for a CrewHaus channel
 * daemon, apply it over the manifest API, and finish the OAuth v2 install that
 * yields the `xoxb` bot token the daemon actually runs with.
 *
 * WHY A MANIFEST AND NOT A CLICK-THROUGH. A channel daemon needs a precise,
 * reproducible app configuration — the same scopes, the same `bot_events`, an
 * events URL that points at the tunnel we just provisioned. Reproducing that
 * by hand in the Slack UI is where fleet drift comes from, so everything the
 * app *is* lives in `buildManifest`, and `createApp` / `updateApp` push it.
 *
 * THE FOUR FACTS THAT SHAPE THIS FILE:
 *
 * 1. Two token species, and they are not interchangeable. The manifest API is
 *    authenticated with an *app-configuration* token (`xoxe.xoxp-…`) sent as
 *    `Authorization: Bearer`; the daemon runs on a *bot* token (`xoxb-…`)
 *    obtained through OAuth. This module is the only place the first kind is
 *    ever touched, and it never writes one into a spec (see `types.ts`).
 *
 * 2. The signing secret is returned exactly once. `apps.manifest.create`
 *    hands back `credentials.signing_secret`; `apps.manifest.export` returns
 *    only the manifest, and there is no `apps.credentials.*` read method. If
 *    the caller loses the `CreatedApp` it just received, the only recovery is
 *    a human visiting the app's Basic Information page. **Persist the whole
 *    `CreatedApp` before doing anything else that can fail.**
 *
 * 3. Slack signals failure with HTTP 200 and `{ ok: false, error }`. Every
 *    call here therefore checks the envelope, not the status. Schema failures
 *    arrive as `error: "invalid_manifest"` plus `errors: [{ message, pointer
 *    }]`, where the pointer is a JSON Pointer into the manifest — that
 *    pointer is the single most useful thing in the whole response, so it is
 *    rendered into the thrown message verbatim.
 *
 * 4. Installation cannot be fully automated. OAuth v2 requires a human to
 *    approve the scopes in a browser, and Slack rejects non-HTTPS redirect
 *    URLs — which is why the callback runs through the Cloudflare tunnel this
 *    package provisions rather than a plain `http://localhost`. The best this
 *    module can do is build the authorize URL and exchange the resulting code.
 *
 * RATE LIMITS matter more than they look. `apps.manifest.create` and
 * `apps.manifest.update` are Tier 1 (roughly one call per minute, per app
 * configuration token); `apps.manifest.validate` is Tier 3 (~50/min). A loop
 * that provisions a fleet will hit Tier 1 long before it hits anything else,
 * so always spend a cheap `validateManifest` first and let it catch the
 * schema mistakes that would otherwise burn a Tier-1 slot.
 */
import { type JsonResponse, asRecord, readString, requestJson } from "./http";
import { type ServiceDeps, ServiceSetupError } from "./types";

/** Slack's Web API root. Overridable per-call via `SlackDeps.apiBase`. */
export const SLACK_API_BASE = "https://slack.com/api";

/**
 * The browser install endpoint. Not on `SLACK_API_BASE` — OAuth v2 authorize
 * is a human-facing page under `/oauth/v2`, not a Web API method — and not
 * exported, because `buildAuthorizeUrl` is the only thing that should build
 * one (the query-string shape is easy to get subtly wrong).
 */
const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";

/** Slack's display limits. Exceeding either is an `invalid_manifest`. */
const NAME_MAX = 35;
const DESCRIPTION_MAX = 140;

/**
 * The operator's app-configuration token. A one-field object rather than a
 * bare string so a bot token can never be passed here by accident — the two
 * are both `string` and authenticate completely different API families.
 */
export type SlackAuth = { readonly configToken: string };

/** Shared injected seams, plus an API base override for tests and proxies. */
export type SlackDeps = ServiceDeps & { readonly apiBase?: string };

/**
 * The manifest subset CrewHaus actually sets. Slack's schema is much larger
 * (workflow steps, unfurl domains, App Home tabs); everything omitted here is
 * either irrelevant to a channel daemon or better left at Slack's default,
 * and `updateApp` REPLACES the whole configuration — so anything not modelled
 * here is anything a manual edit in the UI would silently lose.
 */
export type SlackManifest = {
  readonly display_information: { readonly name: string; readonly description: string };
  readonly features: {
    readonly bot_user: { readonly display_name: string; readonly always_online: boolean };
  };
  readonly oauth_config: {
    readonly scopes: { readonly bot: readonly string[] };
    readonly redirect_urls?: readonly string[];
  };
  readonly settings: {
    readonly event_subscriptions?: {
      /** Omitted under Socket Mode, where there is no webhook to verify. */
      readonly request_url?: string;
      readonly bot_events: readonly string[];
    };
    readonly interactivity?: { readonly is_enabled: boolean; readonly request_url?: string };
    readonly org_deploy_enabled: boolean;
    readonly socket_mode_enabled: boolean;
    readonly token_rotation_enabled: boolean;
  };
};

/** Harness-shaped input to `buildManifest` — no Slack schema knowledge needed. */
export type ManifestInput = {
  readonly name: string;
  readonly description?: string;
  readonly scopes: readonly string[];
  readonly botEvents: readonly string[];
  /** Omitted when the daemon has no public URL yet — see socketMode. */
  readonly eventsUrl?: string;
  /** Interactivity (Approve/Deny button clicks). Without it cards render but clicks die. */
  readonly actionsUrl?: string;
  readonly redirectUrls?: readonly string[];
  readonly socketMode?: boolean;
};

/**
 * Everything `apps.manifest.create` hands back. `signingSecret` is
 * unrecoverable after this object is dropped — see fact 2 in the file header.
 */
export type CreatedApp = {
  readonly appId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly signingSecret: string;
  readonly verificationToken: string;
  readonly oauthAuthorizeUrl: string;
};

/** The result of a completed install: exactly what the daemon needs to run. */
export type InstalledBot = {
  readonly botToken: string;
  readonly botUserId: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly scopes: readonly string[];
};

/**
 * PURE. Turn harness-shaped input into a complete Slack manifest.
 *
 * Truncates `name` to 35 and `description` to 140 characters — Slack's
 * display limits — because a name assembled from a harness id plus a suffix
 * routinely overshoots, and failing a Tier-1 create over a display string is
 * a poor trade. Truncation is a plain cut with no ellipsis so the result
 * stays byte-comparable against a manifest exported later.
 *
 * Interactivity is set ONLY when `actionsUrl` is given: enabling it without a
 * request URL produces an app whose buttons render and then fail silently on
 * click, which is worse than an app with no buttons at all.
 *
 * @throws ServiceSetupError when neither `eventsUrl` nor `socketMode` is set.
 * Slack requires `settings.event_subscriptions` to carry either a
 * `request_url` or `socket_mode_enabled: true`; a manifest with neither is
 * rejected with pointer `/settings/event_subscriptions`, so we fail here
 * rather than spending a network round trip to learn it.
 */
export function buildManifest(input: ManifestInput): SlackManifest {
  const socketMode = input.socketMode === true;
  if (input.eventsUrl === undefined && !socketMode) {
    throw new ServiceSetupError(
      "slack",
      "a Slack manifest needs an events transport: no eventsUrl and socketMode is not enabled",
      {
        code: "missing_event_transport",
        fix:
          "Either pass eventsUrl (the daemon's public HTTPS endpoint — provision the tunnel " +
          "first) or set socketMode: true to run the daemon over a WebSocket with no inbound URL.",
      },
    );
  }

  const name = truncate(input.name, NAME_MAX);
  const description = truncate(
    input.description ?? `${input.name} — a CrewHaus channel daemon.`,
    DESCRIPTION_MAX,
  );

  // Socket Mode replaces the request URL, not the event subscription.
  // `settings.event_subscriptions.request_url` is OPTIONAL in Slack's schema,
  // and Slack's own Socket Mode manifest example carries `bot_events` with no
  // `request_url` — so dropping the whole block under Socket Mode produced an
  // app subscribed to nothing: the daemon opens its WebSocket, Slack accepts
  // it, and no event ever arrives. Worse on `apps.manifest.update`, which is
  // a full replace and would strip the events off a working app.
  const eventSubscriptions =
    socketMode || input.eventsUrl !== undefined
      ? {
          event_subscriptions: {
            ...(socketMode || input.eventsUrl === undefined
              ? {}
              : { request_url: input.eventsUrl }),
            bot_events: [...input.botEvents],
          },
        }
      : {};

  const settings: SlackManifest["settings"] = {
    ...eventSubscriptions,
    ...(input.actionsUrl === undefined
      ? {}
      : { interactivity: { is_enabled: true, request_url: input.actionsUrl } }),
    org_deploy_enabled: false,
    socket_mode_enabled: socketMode,
    // Bot-token rotation is off deliberately: a rotating `xoxb` requires the
    // daemon to persist and exchange a refresh token on a schedule, which the
    // channel runtime does not implement. Turning it on here would produce a
    // harness that works for 12 hours and then stops.
    token_rotation_enabled: false,
  };

  return {
    display_information: { name, description },
    features: { bot_user: { display_name: name, always_online: true } },
    oauth_config: {
      scopes: { bot: [...input.scopes] },
      ...(input.redirectUrls === undefined || input.redirectUrls.length === 0
        ? {}
        : { redirect_urls: [...input.redirectUrls] }),
    },
    settings,
  };
}

/**
 * Cheap pre-flight (`apps.manifest.validate`, Tier 3 ~50/min) before spending
 * the Tier-1 create/update budget. Resolves silently on success; throws with
 * the JSON Pointers rendered when the schema is wrong.
 *
 * Pass `appId` when validating a manifest destined for an existing app —
 * Slack then checks it against that app's current state (for example whether
 * a scope change is legal), which a bare validate cannot see.
 *
 * NOT a URL reachability check. Slack documents no error code for an
 * unreachable `request_url`, and whether create/update verifies it
 * synchronously is undocumented either way — so this module codes no
 * assumption about it. Getting something to answer the events URL before
 * applying is the caller's job; this package ships a responder for exactly
 * that reason.
 */
export async function validateManifest(
  auth: SlackAuth,
  manifest: SlackManifest,
  deps: SlackDeps = {},
  appId?: string,
): Promise<void> {
  await slackPost(
    "apps.manifest.validate",
    {
      token: auth.configToken,
      json: {
        manifest: JSON.stringify(manifest),
        ...(appId === undefined ? {} : { app_id: appId }),
      },
    },
    deps,
  );
}

/**
 * Create a brand-new Slack app from a manifest (`apps.manifest.create`,
 * **Tier 1, ~1 call per minute** — a fleet loop must pace itself here).
 *
 * `manifest` goes over the wire as a JSON-encoded STRING, not a nested
 * object; Slack rejects the nested form. `teamId` targets a specific
 * workspace when the config token can see more than one.
 *
 * THE CALLER MUST PERSIST THE RETURNED OBJECT IMMEDIATELY. `signing_secret`
 * appears in this response and in no other API response, ever — there is no
 * read-back method. Anything that can fail (writing a spec, minting a tunnel)
 * belongs *after* the credentials are on disk, or a crash strands an app that
 * exists in Slack but can never be verified by the daemon.
 */
export async function createApp(
  auth: SlackAuth,
  manifest: SlackManifest,
  deps: SlackDeps = {},
  teamId?: string,
): Promise<CreatedApp> {
  const res = await slackPost(
    "apps.manifest.create",
    {
      token: auth.configToken,
      json: {
        manifest: JSON.stringify(manifest),
        ...(teamId === undefined ? {} : { team_id: teamId }),
      },
    },
    deps,
  );

  const body = asRecord(res.body);
  const credentials = asRecord(body["credentials"]);
  const appId = readString(body, "app_id");
  const clientId = readString(credentials, "client_id");
  const clientSecret = readString(credentials, "client_secret");
  const signingSecret = readString(credentials, "signing_secret");
  if (appId === undefined || clientId === undefined || clientSecret === undefined) {
    throw new ServiceSetupError("slack", "apps.manifest.create returned no app credentials", {
      code: "malformed_response",
      fix:
        "Check api.slack.com/apps — the app may have been created despite the malformed reply. " +
        "Delete the orphan before retrying, or the next create adds a duplicate.",
    });
  }
  if (signingSecret === undefined) {
    throw new ServiceSetupError(
      "slack",
      `Slack app ${appId} was created but the response carried no signing secret`,
      {
        code: "missing_signing_secret",
        fix: `Read it at api.slack.com/apps/${appId} → Basic Information; no API returns it.`,
      },
    );
  }

  return {
    appId,
    clientId,
    clientSecret,
    signingSecret,
    verificationToken: readString(credentials, "verification_token") ?? "",
    oauthAuthorizeUrl: readString(body, "oauth_authorize_url") ?? "",
  };
}

/**
 * Push a manifest onto an existing app (`apps.manifest.update`, **Tier 1**).
 *
 * The manifest must be COMPLETE: this replaces the entire app configuration
 * rather than patching it, so any setting made by hand in the UI and not
 * modelled in `SlackManifest` is dropped. Round-trip through
 * `exportManifest` first if a manual edit might be in play.
 *
 * `permissionsUpdated` is the payload that matters. When Slack reports
 * `permissions_updated: true` the scope set changed, and **the workspace must
 * reinstall the app** — the existing `xoxb` token keeps the old scopes and
 * every call needing a new one fails with `missing_scope` until a human walks
 * the OAuth flow again. Surface it; never swallow it.
 */
export async function updateApp(
  auth: SlackAuth,
  appId: string,
  manifest: SlackManifest,
  deps: SlackDeps = {},
): Promise<{ permissionsUpdated: boolean }> {
  const res = await slackPost(
    "apps.manifest.update",
    { token: auth.configToken, json: { app_id: appId, manifest: JSON.stringify(manifest) } },
    deps,
  );
  return { permissionsUpdated: asRecord(res.body)["permissions_updated"] === true };
}

/**
 * Read an app's current manifest (`apps.manifest.export`). Returns the
 * manifest and nothing else — no `credentials` block, no signing secret. Use
 * it to diff live state before an update, or to recover the shape of an app
 * someone configured by hand.
 */
export async function exportManifest(
  auth: SlackAuth,
  appId: string,
  deps: SlackDeps = {},
): Promise<SlackManifest> {
  const res = await slackPost(
    "apps.manifest.export",
    { token: auth.configToken, json: { app_id: appId } },
    deps,
  );
  return coerceManifest(asRecord(res.body)["manifest"]);
}

/**
 * Exchange a refresh token for a fresh app-configuration token pair
 * (`tooling.tokens.rotate`).
 *
 * Two traps. First, the refresh token is a REQUEST ARGUMENT, not a bearer
 * header — this is the one method here that sends no `Authorization`, and it
 * requires no scopes. Second, BOTH tokens are replaced on every rotation:
 * the returned `refreshToken` must be stored over the old one or the next
 * rotation fails and the operator is back to minting tokens by hand.
 *
 * `expiresAt` is epoch MILLISECONDS, converted from Slack's seconds-based
 * `exp` so it compares directly against `Date.now()`. Config-token lifetime
 * is commonly cited as 12 hours, but Slack does not document it — so nothing
 * here hard-codes an expiry; the returned `exp` is the only authority.
 */
export async function rotateConfigToken(
  refreshToken: string,
  deps: SlackDeps = {},
): Promise<{ token: string; refreshToken: string; expiresAt: number }> {
  const res = await slackPost(
    "tooling.tokens.rotate",
    { form: { refresh_token: refreshToken } },
    deps,
  );
  const body = asRecord(res.body);
  const token = readString(body, "token");
  const nextRefresh = readString(body, "refresh_token");
  if (token === undefined || nextRefresh === undefined) {
    throw new ServiceSetupError("slack", "tooling.tokens.rotate returned no token pair", {
      code: "malformed_response",
      fix:
        "Mint a new app-configuration token at api.slack.com/apps → Your App Configuration " +
        "Tokens and store both halves of the pair.",
    });
  }
  const exp = readNumber(body, "exp");
  return {
    token,
    refreshToken: nextRefresh,
    expiresAt: exp === undefined ? 0 : exp * 1000,
  };
}

/**
 * PURE. The URL the operator opens in a browser to install the app.
 *
 * There is no way around the browser: OAuth v2 requires a human to approve
 * the scope grant. `redirectUri` must be HTTPS and must already be listed in
 * the manifest's `oauth_config.redirect_urls` — Slack rejects a plain
 * `http://localhost` callback, which is why the install flow routes through
 * the tunnel this package provisions.
 *
 * `state` is echoed back to the callback: generate it per-install and compare
 * it on return, or the callback will accept a code minted for someone else.
 */
export function buildAuthorizeUrl(opts: {
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly redirectUri: string;
  readonly state: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    scope: opts.scopes.join(","),
    redirect_uri: opts.redirectUri,
    state: opts.state,
  });
  return `${SLACK_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Exchange the OAuth callback `code` for the bot token (`oauth.v2.access`).
 *
 * FORM-ENCODED, not JSON, and unauthenticated apart from the client
 * credentials in the body — Slack's OAuth endpoint predates its JSON
 * conventions and rejects an `application/json` payload. The `redirectUri`
 * must byte-match the one used to build the authorize URL.
 *
 * The code is single-use and expires in about ten minutes, so this call
 * belongs immediately after the callback fires; a retry with the same code
 * fails with `invalid_code` and needs a fresh trip through the browser.
 */
export async function exchangeOauthCode(
  opts: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly code: string;
    readonly redirectUri: string;
  },
  deps: SlackDeps = {},
): Promise<InstalledBot> {
  const res = await slackPost(
    "oauth.v2.access",
    {
      form: {
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        code: opts.code,
        redirect_uri: opts.redirectUri,
      },
    },
    deps,
  );

  const body = asRecord(res.body);
  const botToken = readString(body, "access_token");
  if (botToken === undefined) {
    throw new ServiceSetupError("slack", "oauth.v2.access returned no bot token", {
      code: "malformed_response",
      fix: "Re-run the install: open the authorize URL again and exchange the fresh code.",
    });
  }
  const team = asRecord(body["team"]);
  return {
    botToken,
    botUserId: readString(body, "bot_user_id") ?? "",
    teamId: readString(team, "id") ?? "",
    teamName: readString(team, "name") ?? "",
    scopes: parseScopeList(readString(body, "scope") ?? res.headers["x-oauth-scopes"]),
  };
}

/**
 * Verify a bot token and report what it can actually do (`auth.test`).
 *
 * The scopes are NOT in the JSON body — they arrive in the `x-oauth-scopes`
 * response header as a comma-separated list. That header is the only
 * authoritative view of what a live token was granted, which makes this the
 * one call that can answer "is this install missing something?": feed its
 * `scopes` and the manifest's required list to `missingScopes`.
 */
export async function authTest(
  botToken: string,
  deps: SlackDeps = {},
): Promise<{ teamId: string; team: string; userId: string; scopes: readonly string[] }> {
  const res = await slackPost("auth.test", { token: botToken, json: {} }, deps);
  const body = asRecord(res.body);
  return {
    teamId: readString(body, "team_id") ?? "",
    team: readString(body, "team") ?? "",
    userId: readString(body, "user_id") ?? "",
    scopes: parseScopeList(res.headers["x-oauth-scopes"]),
  };
}

/**
 * PURE. Scopes required but not granted, in the order they were required.
 *
 * Exists because the failure it prevents is so indirect: a token missing a
 * scope does not fail at startup, it fails hours later on the first call that
 * needs it, with a `missing_scope` buried in a daemon log. Diffing at install
 * time turns that into one line telling the operator to reinstall.
 */
export function missingScopes(
  required: readonly string[],
  granted: readonly string[],
): readonly string[] {
  const have = new Set(granted.map((scope) => scope.trim()).filter((scope) => scope !== ""));
  const out: string[] = [];
  for (const scope of required) {
    const want = scope.trim();
    if (want !== "" && !have.has(want) && !out.includes(want)) out.push(want);
  }
  return out;
}

/** Method URL, tolerant of a trailing slash on an overridden base. */
function apiUrl(method: string, deps: SlackDeps): string {
  const base = (deps.apiBase ?? SLACK_API_BASE).replace(/\/+$/, "");
  return `${base}/${method}`;
}

/**
 * One authenticated Slack POST, with the `{ ok: false }` envelope already
 * checked. Returns the whole `JsonResponse` rather than just the body because
 * `auth.test` reads its most important field out of a response HEADER.
 */
async function slackPost(
  method: string,
  init: {
    readonly token?: string;
    readonly json?: unknown;
    readonly form?: Readonly<Record<string, string>>;
  },
  deps: SlackDeps,
): Promise<JsonResponse> {
  const headers: Record<string, string> =
    init.token === undefined ? {} : { authorization: `Bearer ${init.token}` };
  const res = await requestJson(
    {
      url: apiUrl(method, deps),
      method: "POST",
      headers,
      ...(init.form === undefined ? { json: init.json ?? {} } : { form: init.form }),
    },
    deps,
  );
  requireOk(method, res);
  return res;
}

/**
 * Slack answers HTTP 200 with `{ ok: false, error }` for API-level failures,
 * so both the envelope and the status have to be checked — and the envelope
 * first, since it carries the only useful detail.
 */
function requireOk(method: string, res: JsonResponse): void {
  const body = asRecord(res.body);
  if (body["ok"] === true) return;

  const code = readString(body, "error") ?? (res.ok ? "unknown_error" : `http_${res.status}`);
  const pointers = manifestPointers(body);
  const detail = pointers.length === 0 ? "" : `\n  ${pointers.join("\n  ")}`;
  throw new ServiceSetupError("slack", `${method} failed: ${code}${detail}`, {
    status: res.status,
    code,
    fix: fixFor(method, code, pointers.length > 0),
  });
}

/**
 * Render `errors: [{ message, pointer }]` from an `invalid_manifest` reply.
 * The pointer is a JSON Pointer into the submitted manifest
 * (`/settings/event_subscriptions`), which names the exact field to fix —
 * dropping it turns a 10-second fix into a guessing game.
 */
function manifestPointers(body: Readonly<Record<string, unknown>>): readonly string[] {
  const errors = body["errors"];
  if (!Array.isArray(errors)) return [];
  const out: string[] = [];
  for (const entry of errors) {
    const pointer = readString(entry, "pointer") ?? "(no pointer)";
    const message = readString(entry, "message") ?? "invalid";
    out.push(`${pointer}: ${message}`);
  }
  return out;
}

/** The `Fix:` line, chosen by error code — every throw here gets one. */
function fixFor(method: string, code: string, hasPointers: boolean): string {
  if (code === "invalid_auth" || code === "not_authed" || code === "token_expired") {
    return (
      "The app-configuration token is expired or wrong. Mint a fresh one at api.slack.com/apps " +
      "→ Your App Configuration Tokens, or call rotateConfigToken() with the refresh half."
    );
  }
  if (code === "invalid_manifest" || hasPointers) {
    return (
      "Fix the manifest fields named by the JSON Pointers above, then re-run. " +
      "validateManifest() re-checks them without spending the Tier-1 create/update budget."
    );
  }
  if (code === "ratelimited" || code === "rate_limited") {
    return (
      "apps.manifest.create and .update are Tier 1 (~1 call per minute per config token). " +
      "Pace the loop and retry after a minute."
    );
  }
  if (code === "invalid_code" || code === "code_already_used") {
    return "OAuth codes are single-use and expire in ~10 minutes. Re-open the authorize URL.";
  }
  if (code === "invalid_redirect_uri" || code === "bad_redirect_uri") {
    return (
      "The redirect URI must be HTTPS and must appear verbatim in the manifest's " +
      "oauth_config.redirect_urls. A plain http://localhost callback is always rejected."
    );
  }
  return `Look up \`${code}\` in the Slack API reference for ${method}.`;
}

/** Cut to a length limit. No ellipsis — see `buildManifest`. */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** Comma-separated scope header or `scope` field → a trimmed list. */
function parseScopeList(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") return [];
  return value
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope !== "");
}

/** Read a numeric field off an unknown body, tolerating a numeric string. */
function readNumber(body: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = body[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

/**
 * Narrow an exported manifest without trusting it. Slack has returned the
 * manifest both as an object and (historically) as a JSON string, so both are
 * accepted; anything without a display name is a shape we do not understand
 * and is better refused than handed onward as a lie.
 */
function coerceManifest(value: unknown): SlackManifest {
  let raw: unknown = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = {};
    }
  }
  if (readString(asRecord(raw)["display_information"], "name") === undefined) {
    throw new ServiceSetupError("slack", "apps.manifest.export returned no usable manifest", {
      code: "malformed_response",
      fix: "Confirm the app_id is right and that the config token can see that workspace.",
    });
  }
  return raw as SlackManifest;
}
