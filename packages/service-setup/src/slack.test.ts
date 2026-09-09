/**
 * Slack client coverage.
 *
 * Credential-free and network-free: every test drives the module through an
 * injected `fetchImpl` keyed on the Slack method name (the last URL segment),
 * so the assertions are about the exact bytes we put on the wire — the
 * manifest as a JSON *string*, the OAuth exchange as a *form* — and about how
 * Slack's `{ ok: false }`-at-HTTP-200 convention is mapped onto
 * `ServiceSetupError`. No real token ever appears here, and no test touches
 * the network or a global.
 */
import { describe, expect, test } from "bun:test";
import {
  type ManifestInput,
  type SlackAuth,
  authTest,
  buildAuthorizeUrl,
  buildManifest,
  createApp,
  exchangeOauthCode,
  exportManifest,
  missingScopes,
  rotateConfigToken,
  updateApp,
  validateManifest,
} from "./slack";
import { ServiceSetupError } from "./types";

const AUTH: SlackAuth = { configToken: "xoxe.xoxp-test-token" };
const API = "https://slack.example/api";

/** One observed request, already split into the shapes assertions want. */
type SlackCall = {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: string;
  readonly json: Readonly<Record<string, unknown>>;
  readonly form: Readonly<Record<string, string>>;
};

type Reply = {
  readonly body: unknown;
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
};

type Route = unknown | ((call: SlackCall) => Reply);

/**
 * A fake Slack keyed on method name. Routes may be a bare body (returned at
 * HTTP 200, which is how Slack reports *both* success and failure) or a
 * function for tests that need to see the request first.
 */
function fakeSlack(routes: Readonly<Record<string, Route>>): {
  fetchImpl: typeof fetch;
  calls: SlackCall[];
  callTo: (method: string) => SlackCall;
} {
  const calls: SlackCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = url.split("/").pop() ?? "";
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const headers = normalizeHeaders(init?.headers);
    calls.push({
      url,
      method,
      headers,
      rawBody,
      json: parseJsonBody(headers["content-type"], rawBody),
      form: parseFormBody(headers["content-type"], rawBody),
    });

    const route = routes[method];
    if (route === undefined) throw new Error(`unexpected Slack method: ${method}`);
    const reply: Reply =
      typeof route === "function"
        ? (route as (call: SlackCall) => Reply)(calls[calls.length - 1] as SlackCall)
        : { body: route };
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
    });
  };
  const fetchImpl = impl as unknown as typeof fetch;
  return {
    fetchImpl,
    calls,
    callTo: (method: string) => {
      const call = calls.find((c) => c.method === method);
      if (call === undefined) throw new Error(`no call to ${method}`);
      return call;
    },
  };
}

/** Accept every `RequestInit.headers` shape and lowercase the keys. */
function normalizeHeaders(headers: RequestInit["headers"]): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  if (headers === undefined) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      const key = pair[0];
      const value = pair[1];
      if (key !== undefined && value !== undefined) out[key.toLowerCase()] = value;
    }
    return out;
  }
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

function parseJsonBody(
  contentType: string | undefined,
  raw: string,
): Readonly<Record<string, unknown>> {
  if (contentType === undefined || !contentType.includes("json") || raw === "") return {};
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

function parseFormBody(
  contentType: string | undefined,
  raw: string,
): Readonly<Record<string, string>> {
  if (contentType === undefined || !contentType.includes("urlencoded")) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(raw)) out[key] = value;
  return out;
}

/** The manifest the tests build on: the shape a channel daemon really wants. */
const INPUT: ManifestInput = {
  name: "crewhaus-support",
  description: "Support triage daemon.",
  scopes: ["chat:write", "app_mentions:read"],
  botEvents: ["app_mention", "message.channels"],
  eventsUrl: "https://support.example.com/slack/events",
};

/** Read the `manifest` argument back off a recorded request. */
function sentManifest(call: SlackCall): Record<string, unknown> {
  const raw = call.json["manifest"];
  expect(typeof raw).toBe("string");
  const parsed: unknown = JSON.parse(raw as string);
  return parsed as Record<string, unknown>;
}

describe("buildManifest", () => {
  test("truncates the name at 35 and the description at 140 characters", () => {
    const manifest = buildManifest({
      ...INPUT,
      name: "x".repeat(60),
      description: "d".repeat(300),
    });
    expect(manifest.display_information.name).toHaveLength(35);
    expect(manifest.display_information.description).toHaveLength(140);
    // A plain cut, no ellipsis — the value stays comparable byte-for-byte.
    expect(manifest.display_information.name).toBe("x".repeat(35));
    expect(manifest.features.bot_user.display_name).toHaveLength(35);
  });

  test("leaves short display strings untouched", () => {
    const manifest = buildManifest(INPUT);
    expect(manifest.display_information.name).toBe("crewhaus-support");
    expect(manifest.display_information.description).toBe("Support triage daemon.");
  });

  test("sets interactivity only when actionsUrl is given", () => {
    expect(buildManifest(INPUT).settings.interactivity).toBeUndefined();

    const withActions = buildManifest({ ...INPUT, actionsUrl: "https://x.example/slack/actions" });
    expect(withActions.settings.interactivity).toEqual({
      is_enabled: true,
      request_url: "https://x.example/slack/actions",
    });
  });

  test("carries the events URL and bot events through", () => {
    const manifest = buildManifest(INPUT);
    expect(manifest.settings.event_subscriptions).toEqual({
      request_url: "https://support.example.com/slack/events",
      bot_events: ["app_mention", "message.channels"],
    });
    expect(manifest.settings.socket_mode_enabled).toBe(false);
    expect(manifest.oauth_config.scopes.bot).toEqual(["chat:write", "app_mentions:read"]);
  });

  test("socket mode replaces the events URL rather than joining it", () => {
    const manifest = buildManifest({
      ...INPUT,
      eventsUrl: undefined,
      socketMode: true,
    });
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    // Socket Mode replaces the request URL, NOT the subscription. `request_url`
    // is optional in Slack's schema, and dropping the whole block would leave
    // the app subscribed to nothing — the socket connects and no event arrives.
    expect(manifest.settings.event_subscriptions?.request_url).toBeUndefined();
    expect(manifest.settings.event_subscriptions?.bot_events).toEqual([
      "app_mention",
      "message.channels",
    ]);
  });

  test("throws when neither eventsUrl nor socketMode is supplied", () => {
    expect(() => buildManifest({ ...INPUT, eventsUrl: undefined })).toThrow(ServiceSetupError);
    try {
      buildManifest({ ...INPUT, eventsUrl: undefined });
      throw new Error("expected a throw");
    } catch (err) {
      const error = err as ServiceSetupError;
      expect(error.options.code).toBe("missing_event_transport");
      expect(error.options.fix).toContain("socketMode");
      expect(error.options.fix).toContain("eventsUrl");
    }
  });

  test("emits redirect_urls only when some are given", () => {
    expect(buildManifest(INPUT).oauth_config.redirect_urls).toBeUndefined();
    expect(
      buildManifest({ ...INPUT, redirectUrls: [] }).oauth_config.redirect_urls,
    ).toBeUndefined();
    const withRedirects = buildManifest({ ...INPUT, redirectUrls: ["https://x.example/cb"] });
    expect(withRedirects.oauth_config.redirect_urls).toEqual(["https://x.example/cb"]);
  });
});

describe("validateManifest", () => {
  test("sends the manifest as a JSON string, bearing the config token", async () => {
    const slack = fakeSlack({ "apps.manifest.validate": { ok: true } });
    await validateManifest(AUTH, buildManifest(INPUT), {
      fetchImpl: slack.fetchImpl,
      apiBase: API,
    });

    const call = slack.callTo("apps.manifest.validate");
    expect(call.url).toBe(`${API}/apps.manifest.validate`);
    expect(call.headers["authorization"]).toBe("Bearer xoxe.xoxp-test-token");
    // The manifest is a STRING argument — Slack rejects the nested object form.
    expect(typeof call.json["manifest"]).toBe("string");
    expect(sentManifest(call)["display_information"]).toEqual({
      name: "crewhaus-support",
      description: "Support triage daemon.",
    });
    expect(call.json["app_id"]).toBeUndefined();
  });

  test("passes app_id through when validating against an existing app", async () => {
    const slack = fakeSlack({ "apps.manifest.validate": { ok: true } });
    await validateManifest(
      AUTH,
      buildManifest(INPUT),
      { fetchImpl: slack.fetchImpl, apiBase: API },
      "A123",
    );
    expect(slack.callTo("apps.manifest.validate").json["app_id"]).toBe("A123");
  });

  test("renders every errors[].pointer from an invalid_manifest reply", async () => {
    const slack = fakeSlack({
      "apps.manifest.validate": {
        ok: false,
        error: "invalid_manifest",
        errors: [
          {
            message: "must provide either request_url or socket_mode",
            pointer: "/settings/event_subscriptions",
          },
          { message: "too long", pointer: "/display_information/name" },
        ],
      },
    });

    const err = await validateManifest(AUTH, buildManifest(INPUT), {
      fetchImpl: slack.fetchImpl,
      apiBase: API,
    }).catch((e: unknown) => e as ServiceSetupError);

    expect(err).toBeInstanceOf(ServiceSetupError);
    const error = err as ServiceSetupError;
    expect(error.options.code).toBe("invalid_manifest");
    expect(error.message).toContain("/settings/event_subscriptions");
    expect(error.message).toContain("must provide either request_url or socket_mode");
    expect(error.message).toContain("/display_information/name");
    expect(error.failureClass).toBe("config");
    expect(error.options.fix).toContain("JSON Pointers");
  });

  test("maps invalid_auth onto the auth failure class even at HTTP 200", async () => {
    const slack = fakeSlack({ "apps.manifest.validate": { ok: false, error: "invalid_auth" } });

    const err = await validateManifest(AUTH, buildManifest(INPUT), {
      fetchImpl: slack.fetchImpl,
      apiBase: API,
    }).catch((e: unknown) => e as ServiceSetupError);

    const error = err as ServiceSetupError;
    expect(error.options.status).toBe(200);
    expect(error.options.code).toBe("invalid_auth");
    expect(error.failureClass).toBe("auth");
    expect(error.options.fix).toContain("Your App Configuration Tokens");
  });
});

describe("createApp", () => {
  test("maps the credentials block and echoes team_id", async () => {
    const slack = fakeSlack({
      "apps.manifest.create": {
        ok: true,
        app_id: "A0001",
        credentials: {
          client_id: "111.222",
          client_secret: "cs-abc",
          verification_token: "vt-abc",
          signing_secret: "ss-abc",
        },
        oauth_authorize_url: "https://slack.com/oauth/v2/authorize?client_id=111.222",
      },
    });

    const created = await createApp(
      AUTH,
      buildManifest(INPUT),
      { fetchImpl: slack.fetchImpl, apiBase: API },
      "T999",
    );

    expect(created).toEqual({
      appId: "A0001",
      clientId: "111.222",
      clientSecret: "cs-abc",
      signingSecret: "ss-abc",
      verificationToken: "vt-abc",
      oauthAuthorizeUrl: "https://slack.com/oauth/v2/authorize?client_id=111.222",
    });
    const call = slack.callTo("apps.manifest.create");
    expect(call.json["team_id"]).toBe("T999");
    expect(typeof call.json["manifest"]).toBe("string");
    expect(sentManifest(call)["settings"]).toMatchObject({ socket_mode_enabled: false });
  });

  test("refuses a create whose response carried no signing secret", async () => {
    // The signing secret is returned here and nowhere else, so a missing one is
    // a hard failure that must name the page a human can read it from.
    const slack = fakeSlack({
      "apps.manifest.create": {
        ok: true,
        app_id: "A0002",
        credentials: { client_id: "1.2", client_secret: "cs" },
      },
    });

    const err = await createApp(AUTH, buildManifest(INPUT), {
      fetchImpl: slack.fetchImpl,
      apiBase: API,
    }).catch((e: unknown) => e as ServiceSetupError);

    const error = err as ServiceSetupError;
    expect(error.options.code).toBe("missing_signing_secret");
    expect(error.options.fix).toContain("A0002");
  });

  test("surfaces a Tier-1 rate limit with a pacing fix", async () => {
    const slack = fakeSlack({ "apps.manifest.create": { ok: false, error: "ratelimited" } });

    const err = await createApp(AUTH, buildManifest(INPUT), {
      fetchImpl: slack.fetchImpl,
      apiBase: API,
    }).catch((e: unknown) => e as ServiceSetupError);

    const error = err as ServiceSetupError;
    expect(error.failureClass).toBe("rate_limit");
    expect(error.options.fix).toContain("Tier 1");
  });
});

describe("updateApp", () => {
  test("surfaces permissions_updated so the caller can demand a reinstall", async () => {
    const slack = fakeSlack({
      "apps.manifest.update": { ok: true, app_id: "A1", permissions_updated: true },
    });

    const result = await updateApp(AUTH, "A1", buildManifest(INPUT), {
      fetchImpl: slack.fetchImpl,
      apiBase: API,
    });

    expect(result.permissionsUpdated).toBe(true);
    const call = slack.callTo("apps.manifest.update");
    expect(call.json["app_id"]).toBe("A1");
    expect(typeof call.json["manifest"]).toBe("string");
  });

  test("reports false when the scope set did not change", async () => {
    const slack = fakeSlack({
      "apps.manifest.update": { ok: true, app_id: "A1", permissions_updated: false },
    });
    const result = await updateApp(AUTH, "A1", buildManifest(INPUT), {
      fetchImpl: slack.fetchImpl,
      apiBase: API,
    });
    expect(result.permissionsUpdated).toBe(false);
  });
});

describe("exportManifest", () => {
  test("returns the manifest object", async () => {
    const manifest = buildManifest(INPUT);
    const slack = fakeSlack({ "apps.manifest.export": { ok: true, manifest } });

    const exported = await exportManifest(AUTH, "A1", {
      fetchImpl: slack.fetchImpl,
      apiBase: API,
    });

    expect(exported.display_information.name).toBe("crewhaus-support");
    expect(slack.callTo("apps.manifest.export").json["app_id"]).toBe("A1");
  });

  test("rejects a reply with no usable manifest", async () => {
    const slack = fakeSlack({ "apps.manifest.export": { ok: true, manifest: {} } });
    const err = await exportManifest(AUTH, "A1", {
      fetchImpl: slack.fetchImpl,
      apiBase: API,
    }).catch((e: unknown) => e as ServiceSetupError);
    expect((err as ServiceSetupError).options.code).toBe("malformed_response");
  });
});

describe("rotateConfigToken", () => {
  test("sends the refresh token as an argument, not a bearer header", async () => {
    const slack = fakeSlack({
      "tooling.tokens.rotate": {
        ok: true,
        token: "xoxe.xoxp-new",
        refresh_token: "xoxe-1-new",
        exp: 1_800_000_000,
      },
    });

    const rotated = await rotateConfigToken("xoxe-1-old", {
      fetchImpl: slack.fetchImpl,
      apiBase: API,
    });

    const call = slack.callTo("tooling.tokens.rotate");
    expect(call.headers["authorization"]).toBeUndefined();
    expect(call.form["refresh_token"]).toBe("xoxe-1-old");
    // BOTH halves are replaced on every rotation — storing only `token` bricks
    // the next rotation.
    expect(rotated.token).toBe("xoxe.xoxp-new");
    expect(rotated.refreshToken).toBe("xoxe-1-new");
    // `exp` is seconds on the wire; milliseconds here so it compares to Date.now().
    expect(rotated.expiresAt).toBe(1_800_000_000_000);
  });

  test("does not invent an expiry when Slack omits exp", async () => {
    const slack = fakeSlack({
      "tooling.tokens.rotate": { ok: true, token: "t", refresh_token: "r" },
    });
    const rotated = await rotateConfigToken("old", { fetchImpl: slack.fetchImpl, apiBase: API });
    expect(rotated.expiresAt).toBe(0);
  });
});

describe("buildAuthorizeUrl", () => {
  test("joins scopes with commas and round-trips the state", () => {
    const url = buildAuthorizeUrl({
      clientId: "111.222",
      scopes: ["chat:write", "app_mentions:read"],
      redirectUri: "https://tunnel.example.com/slack/oauth",
      state: "st-42",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(parsed.searchParams.get("client_id")).toBe("111.222");
    expect(parsed.searchParams.get("scope")).toBe("chat:write,app_mentions:read");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://tunnel.example.com/slack/oauth");
    expect(parsed.searchParams.get("state")).toBe("st-42");
  });
});

describe("exchangeOauthCode", () => {
  test("posts form-encoded credentials and maps the bot install", async () => {
    const slack = fakeSlack({
      "oauth.v2.access": {
        ok: true,
        access_token: "xoxb-inst",
        bot_user_id: "U0BOT",
        scope: "chat:write,app_mentions:read",
        team: { id: "T1", name: "Acme" },
      },
    });

    const installed = await exchangeOauthCode(
      {
        clientId: "111.222",
        clientSecret: "cs-abc",
        code: "code-abc",
        redirectUri: "https://tunnel.example.com/slack/oauth",
      },
      { fetchImpl: slack.fetchImpl, apiBase: API },
    );

    const call = slack.callTo("oauth.v2.access");
    // Form-encoded, not JSON — Slack's OAuth endpoint rejects a JSON body.
    expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(call.form).toEqual({
      client_id: "111.222",
      client_secret: "cs-abc",
      code: "code-abc",
      redirect_uri: "https://tunnel.example.com/slack/oauth",
    });
    expect(installed).toEqual({
      botToken: "xoxb-inst",
      botUserId: "U0BOT",
      teamId: "T1",
      teamName: "Acme",
      scopes: ["chat:write", "app_mentions:read"],
    });
  });

  test("explains that an expired code needs another trip through the browser", async () => {
    const slack = fakeSlack({ "oauth.v2.access": { ok: false, error: "invalid_code" } });

    const err = await exchangeOauthCode(
      { clientId: "c", clientSecret: "s", code: "stale", redirectUri: "https://x.example/cb" },
      { fetchImpl: slack.fetchImpl, apiBase: API },
    ).catch((e: unknown) => e as ServiceSetupError);

    expect((err as ServiceSetupError).options.fix).toContain("authorize URL");
  });
});

describe("authTest", () => {
  test("reads the granted scopes out of the x-oauth-scopes response header", async () => {
    const slack = fakeSlack({
      "auth.test": () => ({
        body: {
          ok: true,
          team: "Acme",
          team_id: "T1",
          user_id: "U0BOT",
          url: "https://acme.slack.com/",
        },
        // The scopes live ONLY in the header — the JSON body never carries them.
        headers: { "x-oauth-scopes": "chat:write, app_mentions:read ,channels:history" },
      }),
    });

    const result = await authTest("xoxb-inst", { fetchImpl: slack.fetchImpl, apiBase: API });

    expect(slack.callTo("auth.test").headers["authorization"]).toBe("Bearer xoxb-inst");
    expect(result).toEqual({
      teamId: "T1",
      team: "Acme",
      userId: "U0BOT",
      scopes: ["chat:write", "app_mentions:read", "channels:history"],
    });
  });

  test("reports no scopes rather than throwing when the header is absent", async () => {
    const slack = fakeSlack({ "auth.test": { ok: true, team: "Acme", team_id: "T1" } });
    const result = await authTest("xoxb-inst", { fetchImpl: slack.fetchImpl, apiBase: API });
    expect(result.scopes).toEqual([]);
  });

  test("classifies a revoked token as an auth failure", async () => {
    const slack = fakeSlack({ "auth.test": { ok: false, error: "token_revoked" } });
    const err = await authTest("xoxb-dead", { fetchImpl: slack.fetchImpl, apiBase: API }).catch(
      (e: unknown) => e as ServiceSetupError,
    );
    expect(err).toBeInstanceOf(ServiceSetupError);
    expect((err as ServiceSetupError).options.code).toBe("token_revoked");
  });
});

describe("missingScopes", () => {
  test("returns required scopes that were never granted, in required order", () => {
    expect(
      missingScopes(
        ["chat:write", "channels:history", "reactions:write"],
        ["chat:write", "app_mentions:read"],
      ),
    ).toEqual(["channels:history", "reactions:write"]);
  });

  test("is empty when the grant covers everything", () => {
    expect(missingScopes(["chat:write"], ["chat:write", "channels:history"])).toEqual([]);
    expect(missingScopes([], ["chat:write"])).toEqual([]);
  });

  test("tolerates the whitespace a comma-separated header leaves behind", () => {
    expect(missingScopes([" chat:write ", "im:write"], ["chat:write "])).toEqual(["im:write"]);
  });

  test("does not repeat a scope required twice", () => {
    expect(missingScopes(["im:write", "im:write"], [])).toEqual(["im:write"]);
  });
});
