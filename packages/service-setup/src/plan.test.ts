/**
 * Orchestration coverage for `plan.ts`.
 *
 * Nothing here touches the network, a port or a credential store: every
 * provider is a route-table `fetchImpl` injected through `ctx.deps`, and the
 * stand-in listener is a hand-written object implementing `Responder`. What
 * IS real is the filesystem — each test writes a genuine `crewhaus.yaml` and
 * `.env` under a temp dir, because the write-back is the half of this module
 * that cannot be faked without testing the fake instead.
 *
 * The single most important test in this file is
 * "persists the app credentials BEFORE the OAuth exchange": Slack returns the
 * signing secret exactly once, in the `apps.manifest.create` response, and no
 * API can read it back. If a later failure is allowed to unwind that write,
 * the operator is left with an app that exists in Slack and can never be
 * verified by the daemon.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnvFile } from "./env-file";
import {
  type SetupContext,
  type SetupIo,
  type SetupOptions,
  applyAgentMail,
  applyCloudflare,
  applySlack,
  applyThredz,
  defaultHostname,
  renderChanges,
  renderPlan,
  resolveCredentials,
  selectedServices,
  slackBotEvents,
  slackEnvNames,
  slackScopes,
} from "./plan";
import type { Responder, ResponderOptions } from "./responder";
import { type SetupTarget, readSetupTarget } from "./target";
import { type AppliedChange, type PlannedChange, ServiceSetupError } from "./types";

// Bases that do not exist, so a regression that bypasses the injected fetch
// fails loudly instead of quietly reaching a real API.
const CF_BASE = "https://cf.invalid/client/v4";
const CF_PREFIX = "/client/v4";
const SLACK_BASE = "https://slack.invalid/api";
const THREDZ_BASE = "https://thredz.invalid/api";

const CF_TOKEN = "cf-provisioning-token";
const SLACK_CONFIG_TOKEN = "xoxe.xoxp-plan-test";
const THREDZ_KEY = `thredz_${"a1b2c3d4".repeat(6)}`;
// Assembled at runtime so no `xoxb`-shaped literal ever lands in the repo.
const BOT_TOKEN = ["xoxb", "installed", "plan", "test"].join("-");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SPEC_FULL = `# a fleet harness, comments and all
name: Secretary Bot
target: channel
gateway:
  port: 8080
channels:
  slack:
    botToken: $SECRETARY_SLACK_BOT_TOKEN
    signingSecret: $SECRETARY_SLACK_SIGNING_SECRET
feedback:
  channelReactions: true
thredz:
  api_key: $THREDZ_API_KEY
  visibility: private
`;

const SPEC_SLACK_ONLY = `name: Secretary Bot
target: channel
channels:
  slack:
    botToken: $SECRETARY_SLACK_BOT_TOKEN
    signingSecret: $SECRETARY_SLACK_SIGNING_SECRET
`;

const SPEC_THREDZ_ONLY = `name: Secretary Bot
target: cli
thredz:
  api_key: $THREDZ_API_KEY
`;

const SPEC_BARE = `name: Secretary Bot
target: cli
`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crewhaus-plan-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a real spec into the temp harness dir and read it back as a target. */
function harness(yamlText: string, eventsPort?: number): SetupTarget {
  const specPath = join(dir, "crewhaus.yaml");
  writeFileSync(specPath, yamlText, "utf8");
  return readSetupTarget(specPath, eventsPort === undefined ? {} : { eventsPort });
}

function envPath(): string {
  return join(dir, ".env");
}

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

type Reply = { readonly status: number; readonly body: unknown };
type Recorded = {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly body: unknown;
  readonly authorization: string | undefined;
};

/**
 * Route-table fake. Keys are `"<METHOD> <path>"`, matched with the query
 * string first and then without it; a value may be a list to script successive
 * answers for the same route, the last of which sticks.
 */
function router(routes: Readonly<Record<string, Reply | readonly Reply[]>>): {
  fetchImpl: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const seen = new Map<string, number>();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      headers[key] = value;
    });
    let body: unknown;
    const raw = init?.body;
    if (typeof raw === "string" && raw !== "") {
      try {
        body = JSON.parse(raw);
      } catch {
        body = Object.fromEntries(new URLSearchParams(raw));
      }
    }
    calls.push({
      method,
      path: parsed.pathname,
      search: parsed.search,
      body,
      authorization: headers["authorization"],
    });

    const bare = `${method} ${parsed.pathname}`;
    const route = routes[`${bare}${parsed.search}`] ?? routes[bare];
    if (route === undefined) throw new Error(`no fake route for ${bare}${parsed.search}`);
    const index = seen.get(bare) ?? 0;
    seen.set(bare, index + 1);
    const picked = Array.isArray(route)
      ? ((route[Math.min(index, route.length - 1)] ?? route[0]) as Reply)
      : (route as Reply);
    return new Response(JSON.stringify(picked.body), {
      status: picked.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** A successful Cloudflare envelope. */
function cfOk(result: unknown): Reply {
  return { status: 200, body: { success: true, errors: [], messages: [], result } };
}

type TestIo = SetupIo & {
  readonly infos: string[];
  readonly warns: string[];
  readonly opened: string[];
  readonly asked: string[];
};

function testIo(
  opts: {
    readonly answers?: Readonly<Record<string, string>>;
    readonly withPrompt?: boolean;
    readonly withOpenUrl?: boolean;
  } = {},
): TestIo {
  const infos: string[] = [];
  const warns: string[] = [];
  const opened: string[] = [];
  const asked: string[] = [];
  const answers = opts.answers ?? {};
  const wantsPrompt = opts.withPrompt === true || opts.answers !== undefined;
  return {
    infos,
    warns,
    opened,
    asked,
    info: (line: string) => {
      infos.push(line);
    },
    warn: (line: string) => {
      warns.push(line);
    },
    ...(wantsPrompt
      ? {
          prompt: (question: string) => {
            asked.push(question);
            return Promise.resolve(answers[question]);
          },
        }
      : {}),
    ...(opts.withOpenUrl === true
      ? {
          openUrl: (url: string) => {
            opened.push(url);
            return Promise.resolve();
          },
        }
      : {}),
  };
}

type ResponderHarness = {
  readonly responder: Responder;
  readonly startCalls: ResponderOptions[];
  readonly timeouts: number[];
  readonly state: { stops: number };
  readonly start: (opts: ResponderOptions) => Promise<Responder>;
};

function fakeResponder(
  opts: {
    readonly code?: string;
    readonly codeError?: Error;
    readonly sawChallenge?: boolean;
  } = {},
): ResponderHarness {
  const state = { stops: 0 };
  const startCalls: ResponderOptions[] = [];
  const timeouts: number[] = [];
  const responder: Responder = {
    events: [],
    waitForCode: (timeoutMs: number) => {
      timeouts.push(timeoutMs);
      return opts.codeError === undefined
        ? Promise.resolve(opts.code ?? "oauth-code-1")
        : Promise.reject(opts.codeError);
    },
    sawChallenge: () => opts.sawChallenge ?? true,
    stop: () => {
      state.stops += 1;
      return Promise.resolve();
    },
  };
  const start = (o: ResponderOptions): Promise<Responder> => {
    startCalls.push(o);
    return Promise.resolve(responder);
  };
  return { responder, startCalls, timeouts, state, start };
}

/** Catch a rejection as a typed error without letting a pass slip through. */
async function caught(run: () => Promise<unknown>): Promise<ServiceSetupError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ServiceSetupError) return err;
    throw err;
  }
  throw new Error("expected a ServiceSetupError, but the call resolved");
}

// ---------------------------------------------------------------------------
// Pure: scopes and events
// ---------------------------------------------------------------------------

describe("slackScopes / slackBotEvents", () => {
  test("without reactions, the list is exactly what the adapter calls", () => {
    expect(slackScopes(false)).toEqual([
      "app_mentions:read",
      "channels:history",
      "groups:history",
      "im:history",
      "mpim:history",
      "chat:write",
      "reactions:write",
    ]);
    expect(slackScopes(false)).not.toContain("reactions:read");
  });

  test("reactions:read is added only when the spec turns ratings on", () => {
    expect(slackScopes(true)).toEqual([
      "app_mentions:read",
      "channels:history",
      "groups:history",
      "im:history",
      "mpim:history",
      "chat:write",
      "reactions:write",
      "reactions:read",
    ]);
  });

  test("bot events match the scopes, reaction_added gated the same way", () => {
    expect(slackBotEvents(false)).toEqual([
      "app_mention",
      "message.channels",
      "message.groups",
      "message.im",
      "message.mpim",
    ]);
    expect(slackBotEvents(false)).not.toContain("reaction_added");
    expect(slackBotEvents(true)).toEqual([
      "app_mention",
      "message.channels",
      "message.groups",
      "message.im",
      "message.mpim",
      "reaction_added",
    ]);
  });

  test("the write scope is always present — ratings only add the read half", () => {
    expect(slackScopes(false)).toContain("reactions:write");
    expect(slackScopes(true)).toContain("reactions:write");
  });
});

// ---------------------------------------------------------------------------
// Pure: env variable names
// ---------------------------------------------------------------------------

describe("slackEnvNames", () => {
  test("a role-prefixed bot token variable carries its prefix across", () => {
    expect(slackEnvNames("SECRETARY_SLACK_BOT_TOKEN")).toEqual({
      appId: "SECRETARY_SLACK_APP_ID",
      clientId: "SECRETARY_SLACK_CLIENT_ID",
      clientSecret: "SECRETARY_SLACK_CLIENT_SECRET",
    });
  });

  test("the bare default keeps the bare names", () => {
    expect(slackEnvNames("SLACK_BOT_TOKEN")).toEqual({
      appId: "SLACK_APP_ID",
      clientId: "SLACK_CLIENT_ID",
      clientSecret: "SLACK_CLIENT_SECRET",
    });
  });

  test("a name with no _BOT_TOKEN suffix is used whole as the prefix", () => {
    expect(slackEnvNames("CREW_TOKEN")).toEqual({
      appId: "CREW_TOKEN_APP_ID",
      clientId: "CREW_TOKEN_CLIENT_ID",
      clientSecret: "CREW_TOKEN_CLIENT_SECRET",
    });
  });

  test("a variable that is nothing but the suffix falls back to SLACK", () => {
    expect(slackEnvNames("_BOT_TOKEN").appId).toBe("SLACK_APP_ID");
  });
});

// ---------------------------------------------------------------------------
// Pure: service selection
// ---------------------------------------------------------------------------

describe("selectedServices", () => {
  test("a slack+thredz spec pulls in cloudflare even without --zone", () => {
    // Slack needs a public Request URL, so the tunnel step is implied.
    expect(selectedServices(harness(SPEC_FULL), {})).toEqual(["cloudflare", "slack", "thredz"]);
  });

  test("a thredz-only spec is thredz alone until a zone is named", () => {
    const target = harness(SPEC_THREDZ_ONLY);
    expect(selectedServices(target, {})).toEqual(["thredz"]);
    expect(selectedServices(target, { zone: "example.com" })).toEqual(["cloudflare", "thredz"]);
  });

  test("a slack-only spec never selects thredz", () => {
    const target = harness(SPEC_SLACK_ONLY);
    expect(selectedServices(target, {})).toEqual(["cloudflare", "slack"]);
    expect(selectedServices(target, { zone: "example.com" })).toEqual(["cloudflare", "slack"]);
  });

  test("a spec with neither block selects nothing until a zone is named", () => {
    const target = harness(SPEC_BARE);
    expect(selectedServices(target, {})).toEqual([]);
    expect(selectedServices(target, { zone: "example.com" })).toEqual(["cloudflare"]);
  });

  test("an explicit --services filter intersects, never adds", () => {
    const target = harness(SPEC_FULL);
    expect(selectedServices(target, { services: ["thredz"] })).toEqual(["thredz"]);
    expect(selectedServices(target, { services: ["slack", "cloudflare"] })).toEqual([
      "cloudflare",
      "slack",
    ]);
    // Asking for a service the spec does not configure yields nothing, rather
    // than a step that would immediately throw.
    expect(selectedServices(harness(SPEC_THREDZ_ONLY), { services: ["slack"] })).toEqual([]);
  });

  test("the selection order is always cloudflare, slack, thredz", () => {
    expect(
      selectedServices(harness(SPEC_FULL), { services: ["thredz", "slack", "cloudflare"] }),
      // The requested order is irrelevant; the step order is load-bearing.
    ).toEqual(["cloudflare", "slack", "thredz"]);
  });
});

// ---------------------------------------------------------------------------
// Pure: hostname
// ---------------------------------------------------------------------------

describe("defaultHostname", () => {
  test("an explicit hostname wins, even with no zone", () => {
    expect(defaultHostname(harness(SPEC_FULL), { hostname: "bot.crew.example" })).toBe(
      "bot.crew.example",
    );
    expect(
      defaultHostname(harness(SPEC_FULL), { hostname: "bot.crew.example", zone: "other.com" }),
    ).toBe("bot.crew.example");
  });

  test("derives a DNS label from the spec name plus the zone", () => {
    expect(defaultHostname(harness(SPEC_FULL), { zone: "example.com" })).toBe(
      "secretary-bot.example.com",
    );
  });

  test("is undefined with no zone and no explicit hostname", () => {
    expect(defaultHostname(harness(SPEC_FULL), {})).toBeUndefined();
  });

  test("is undefined when the name slugifies to nothing", () => {
    const target = harness('name: "***"\ntarget: cli\n');
    expect(defaultHostname(target, { zone: "example.com" })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveCredentials
// ---------------------------------------------------------------------------

describe("resolveCredentials", () => {
  test("explicit beats env beats the .env file", async () => {
    writeFileSync(
      envPath(),
      ["CLOUDFLARE_API_TOKEN=from-file", "SLACK_CONFIG_TOKEN=from-file", "THREDZ_API_KEY=from-file"]
        .join("\n")
        .concat("\n"),
      "utf8",
    );
    const io = testIo();
    const { credentials, missing } = await resolveCredentials(
      ["cloudflare", "slack", "thredz"],
      { CLOUDFLARE_API_TOKEN: "from-env", SLACK_CONFIG_TOKEN: "from-env" },
      envPath(),
      io,
      { cloudflareApiToken: "explicit" },
    );
    expect(credentials.cloudflareApiToken).toBe("explicit");
    expect(credentials.slackConfigToken).toBe("from-env");
    expect(credentials.thredzApiKey).toBe("from-file");
    expect(missing).toEqual([]);
  });

  test("a prompt is the last resort, and is asked as a secret", async () => {
    const asked: Array<{ q: string; secret: boolean }> = [];
    const io: SetupIo = {
      info: () => undefined,
      warn: () => undefined,
      prompt: (question: string, o: { readonly secret: boolean }) => {
        asked.push({ q: question, secret: o.secret });
        return Promise.resolve("typed-by-hand");
      },
    };
    const { credentials, missing } = await resolveCredentials(["thredz"], {}, envPath(), io);
    expect(credentials.thredzApiKey).toBe("typed-by-hand");
    expect(missing).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.secret).toBe(true);
    expect(asked[0]?.q).toContain("Thredz API key");
  });

  test("an empty answer counts as no answer", async () => {
    const io: SetupIo = {
      info: () => undefined,
      warn: () => undefined,
      prompt: () => Promise.resolve(""),
    };
    const { credentials, missing } = await resolveCredentials(["thredz"], {}, envPath(), io);
    expect(credentials.thredzApiKey).toBeUndefined();
    expect(missing).toEqual(["THREDZ_API_KEY"]);
  });

  test("with no prompt seam a missing credential lands in `missing`, all at once", async () => {
    const io = testIo();
    expect(io.prompt).toBeUndefined();
    const { credentials, missing } = await resolveCredentials(
      ["cloudflare", "slack", "thredz"],
      {},
      envPath(),
      io,
    );
    expect(credentials).toEqual({});
    expect(missing).toEqual(["CLOUDFLARE_API_TOKEN", "SLACK_CONFIG_TOKEN", "THREDZ_API_KEY"]);
  });

  test("only the SELECTED services' credentials are required", async () => {
    const io = testIo();
    const { credentials, missing } = await resolveCredentials(
      ["cloudflare"],
      { SLACK_CONFIG_TOKEN: "unused", THREDZ_API_KEY: "unused" },
      envPath(),
      io,
    );
    expect(missing).toEqual(["CLOUDFLARE_API_TOKEN"]);
    expect(credentials.slackConfigToken).toBeUndefined();
    expect(credentials.thredzApiKey).toBeUndefined();
  });

  test("the optional refresh token is never prompted for and never missing", async () => {
    const asked: string[] = [];
    const io: SetupIo = {
      info: () => undefined,
      warn: () => undefined,
      prompt: (question: string) => {
        asked.push(question);
        return Promise.resolve(undefined);
      },
    };
    const { credentials, missing } = await resolveCredentials(
      ["slack"],
      { SLACK_CONFIG_REFRESH_TOKEN: "refresh-value" },
      envPath(),
      io,
    );
    expect(asked).toHaveLength(1);
    expect(asked.join("\n")).not.toContain("REFRESH");
    expect(missing).toEqual(["SLACK_CONFIG_TOKEN"]);
    expect(missing).not.toContain("SLACK_CONFIG_REFRESH_TOKEN");
    expect(
      (credentials as Record<string, string | undefined>)["slackRefreshToken"],
    ).toBeUndefined();
  });

  test("a missing .env file is empty, not an error", async () => {
    const io = testIo();
    const { missing } = await resolveCredentials(["thredz"], {}, join(dir, "nope", ".env"), io);
    expect(missing).toEqual(["THREDZ_API_KEY"]);
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("renderChanges", () => {
  test("marks created/updated with ✓, unchanged with ~, failed with ✗", () => {
    const changes: AppliedChange[] = [
      { service: "cloudflare", summary: 'tunnel "crewhaus"', outcome: "created" },
      { service: "cloudflare", summary: "DNS CNAME bot.example.com", outcome: "updated" },
      { service: "thredz", summary: 'wiki space "crew"', outcome: "unchanged" },
      { service: "slack", summary: "step failed", outcome: "failed", error: "invalid_auth" },
    ];
    expect(renderChanges(changes)).toEqual([
      '✓ tunnel "crewhaus"',
      "✓ DNS CNAME bot.example.com",
      '~ wiki space "crew" (already set)',
      "✗ step failed: invalid_auth",
    ]);
  });

  test("detail lines are indented four spaces under their summary", () => {
    expect(
      renderChanges([
        {
          service: "cloudflare",
          summary: "tunnel",
          outcome: "created",
          detail: ["id tun1", "1 hostname rule(s)"],
        },
      ]),
    ).toEqual(["✓ tunnel", "    id tun1", "    1 hostname rule(s)"]);
  });

  test("a failure with no error string still renders a reason", () => {
    expect(
      renderChanges([{ service: "slack", summary: "step failed", outcome: "failed" }]),
    ).toEqual(["✗ step failed: failed"]);
  });

  test("a skipped change renders as ✓ with no suffix", () => {
    expect(
      renderChanges([{ service: "slack", summary: "slack step", outcome: "skipped" }]),
    ).toEqual(["✓ slack step"]);
  });
});

describe("renderPlan", () => {
  test("satisfied is ~ (already set); everything else is an arrow", () => {
    const planned: PlannedChange[] = [
      { service: "cloudflare", summary: "create tunnel", satisfied: false },
      { service: "thredz", summary: 'wiki space "crew"', satisfied: true, detail: ["id sp_1"] },
    ];
    expect(renderPlan(planned)).toEqual([
      "→ create tunnel",
      '~ wiki space "crew" (already set)',
      "    id sp_1",
    ]);
  });
});

// ---------------------------------------------------------------------------
// applyCloudflare
// ---------------------------------------------------------------------------

const TUNNEL_WIRE = {
  id: "tun1",
  name: "crewhaus",
  config_src: "cloudflare",
  deleted_at: null,
  // A tunnel that is already being served by a connector. That distinction
  // decides whether setup re-offers the `cloudflared service install` command.
  status: "healthy",
};

function cfContext(
  fetchImpl: typeof fetch,
  options: SetupOptions,
  io: TestIo,
  target = harness(SPEC_FULL),
): SetupContext {
  return {
    target,
    options,
    credentials: { cloudflareApiToken: CF_TOKEN },
    io,
    deps: { cloudflare: { fetchImpl, apiBase: CF_BASE } },
  };
}

describe("applyCloudflare", () => {
  test("creates the tunnel, merges ingress, points DNS, and hands back a connector hint", async () => {
    const { fetchImpl, calls } = router({
      [`GET ${CF_PREFIX}/user/tokens/verify`]: cfOk({ id: "tok1", status: "active" }),
      [`GET ${CF_PREFIX}/zones`]: cfOk([{ id: "zone1", account: { id: "acct1" } }]),
      [`GET ${CF_PREFIX}/accounts/acct1/cfd_tunnel`]: cfOk([]),
      // A freshly minted tunnel has no connector attached yet.
      [`POST ${CF_PREFIX}/accounts/acct1/cfd_tunnel`]: cfOk({ ...TUNNEL_WIRE, status: "inactive" }),
      [`GET ${CF_PREFIX}/accounts/acct1/cfd_tunnel/tun1/configurations`]: cfOk({
        version: 7,
        config: {
          ingress: [
            { hostname: "other.example.com", service: "http://localhost:4100" },
            { service: "http_status:404" },
          ],
        },
      }),
      [`PUT ${CF_PREFIX}/accounts/acct1/cfd_tunnel/tun1/configurations`]: cfOk({ version: 8 }),
      [`GET ${CF_PREFIX}/zones/zone1/dns_records`]: cfOk([]),
      [`POST ${CF_PREFIX}/zones/zone1/dns_records`]: cfOk({ id: "rec1" }),
      [`GET ${CF_PREFIX}/accounts/acct1/cfd_tunnel/tun1/token`]: cfOk("connector-token-value"),
    });
    const io = testIo();
    const out = await applyCloudflare(cfContext(fetchImpl, { zone: "example.com" }, io));

    // The order is the contract: verify the token before anything is created,
    // and fetch the connector token only after the tunnel is fully wired.
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET ${CF_PREFIX}/user/tokens/verify`,
      `GET ${CF_PREFIX}/zones`,
      `GET ${CF_PREFIX}/accounts/acct1/cfd_tunnel`,
      `POST ${CF_PREFIX}/accounts/acct1/cfd_tunnel`,
      `GET ${CF_PREFIX}/accounts/acct1/cfd_tunnel/tun1/configurations`,
      `PUT ${CF_PREFIX}/accounts/acct1/cfd_tunnel/tun1/configurations`,
      `GET ${CF_PREFIX}/zones/zone1/dns_records`,
      `POST ${CF_PREFIX}/zones/zone1/dns_records`,
      `GET ${CF_PREFIX}/accounts/acct1/cfd_tunnel/tun1/token`,
    ]);

    // The PUT is a full replace, so the pre-existing hostname must survive it
    // and the catch-all must stay last.
    const put = calls.find((c) => c.method === "PUT");
    expect((put?.body as { config: { ingress: unknown[] } }).config.ingress).toEqual([
      { hostname: "other.example.com", service: "http://localhost:4100" },
      { hostname: "secretary-bot.example.com", service: "http://localhost:3000" },
      { service: "http_status:404" },
    ]);

    expect(out.hostname).toBe("secretary-bot.example.com");
    expect(out.tunnelId).toBe("tun1");
    expect(out.changes.map((c) => c.outcome)).toEqual(["created", "updated", "created"]);
    expect(out.connectorHint?.join("\n")).toContain("connector-token-value");
    expect(io.infos).toContain("Cloudflare token verified");
  });

  test("a second identical run reports unchanged and never PUTs", async () => {
    const settled = {
      version: 8,
      config: {
        ingress: [
          { hostname: "secretary-bot.example.com", service: "http://localhost:3000" },
          { service: "http_status:404" },
        ],
      },
    };
    const { fetchImpl, calls } = router({
      [`GET ${CF_PREFIX}/user/tokens/verify`]: cfOk({ id: "tok1", status: "active" }),
      [`GET ${CF_PREFIX}/zones`]: cfOk([{ id: "zone1", account: { id: "acct1" } }]),
      [`GET ${CF_PREFIX}/accounts/acct1/cfd_tunnel`]: cfOk([TUNNEL_WIRE]),
      [`GET ${CF_PREFIX}/accounts/acct1/cfd_tunnel/tun1/configurations`]: cfOk(settled),
      [`GET ${CF_PREFIX}/zones/zone1/dns_records`]: cfOk([
        {
          id: "rec1",
          name: "secretary-bot.example.com",
          content: "tun1.cfargotunnel.com",
          proxied: true,
        },
      ]),
    });
    const out = await applyCloudflare(cfContext(fetchImpl, { zone: "example.com" }, testIo()));

    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect(calls.some((c) => c.path.endsWith("/token"))).toBe(false);
    expect(out.changes.map((c) => c.outcome)).toEqual(["unchanged", "unchanged", "unchanged"]);
    // The hint is the "you must now run cloudflared" instruction. A reused
    // tunnel already has a connector, so printing it would be noise — and it
    // embeds a live credential.
    expect(out.connectorHint).toBeUndefined();
  });

  test("re-offers the connector command when a reused tunnel has no connector", async () => {
    // The recovery case: run 1 created the tunnel and then failed at DNS, so
    // the hint was never printed. Keying it off "did THIS run create it" lost
    // it forever, leaving a hostname that resolves and then 502s with nothing
    // to explain why. It is keyed off whether a connector is attached instead.
    const { fetchImpl, calls } = router({
      [`GET ${CF_PREFIX}/user/tokens/verify`]: cfOk({ id: "tok1", status: "active" }),
      [`GET ${CF_PREFIX}/zones`]: cfOk([{ id: "zone1", account: { id: "acct1" } }]),
      [`GET ${CF_PREFIX}/accounts/acct1/cfd_tunnel`]: cfOk([
        { ...TUNNEL_WIRE, status: "inactive" },
      ]),
      [`GET ${CF_PREFIX}/accounts/acct1/cfd_tunnel/tun1/configurations`]: cfOk({ version: 1 }),
      [`PUT ${CF_PREFIX}/accounts/acct1/cfd_tunnel/tun1/configurations`]: cfOk({ version: 2 }),
      [`GET ${CF_PREFIX}/accounts/acct1/cfd_tunnel/tun1/token`]: cfOk("connector-token-value"),
      [`GET ${CF_PREFIX}/zones/zone1/dns_records`]: cfOk([]),
      [`POST ${CF_PREFIX}/zones/zone1/dns_records`]: cfOk({ id: "rec1" }),
    });
    const out = await applyCloudflare(cfContext(fetchImpl, { zone: "example.com" }, testIo()));

    expect(out.changes[0]?.outcome).toBe("unchanged");
    expect(calls.some((c) => c.path.endsWith("/token"))).toBe(true);
    expect(out.connectorHint?.join(" ")).toContain("connector-token-value");
  });

  test("honours --tunnel-name, --hostname and --origin-host", async () => {
    const { fetchImpl, calls } = router({
      [`GET ${CF_PREFIX}/user/tokens/verify`]: cfOk({ id: "tok1", status: "active" }),
      [`GET ${CF_PREFIX}/zones`]: cfOk([{ id: "zone1", account: { id: "acct1" } }]),
      [`GET ${CF_PREFIX}/accounts/acct1/cfd_tunnel`]: cfOk([
        { ...TUNNEL_WIRE, name: "fleet-north" },
      ]),
      [`GET ${CF_PREFIX}/accounts/acct1/cfd_tunnel/tun1/configurations`]: cfOk({ version: 1 }),
      [`PUT ${CF_PREFIX}/accounts/acct1/cfd_tunnel/tun1/configurations`]: cfOk({ version: 2 }),
      [`GET ${CF_PREFIX}/zones/zone1/dns_records`]: cfOk([]),
      [`POST ${CF_PREFIX}/zones/zone1/dns_records`]: cfOk({ id: "rec1" }),
    });
    const out = await applyCloudflare(
      cfContext(
        fetchImpl,
        {
          zone: "example.com",
          tunnelName: "fleet-north",
          hostname: "desk.example.com",
          originHost: "127.0.0.1",
        },
        testIo(),
      ),
    );
    expect(out.hostname).toBe("desk.example.com");
    const list = calls.find((c) => c.path === `${CF_PREFIX}/accounts/acct1/cfd_tunnel`);
    expect(list?.search).toContain("name=fleet-north");
    const put = calls.find((c) => c.method === "PUT");
    expect((put?.body as { config: { ingress: unknown[] } }).config.ingress).toEqual([
      { hostname: "desk.example.com", service: "http://127.0.0.1:3000" },
      { service: "http_status:404" },
    ]);
  });

  test("throws with a fix when there is no Cloudflare token", async () => {
    const { fetchImpl, calls } = router({});
    const err = await caught(() =>
      applyCloudflare({
        target: harness(SPEC_FULL),
        options: { zone: "example.com" },
        credentials: {},
        io: testIo(),
        deps: { cloudflare: { fetchImpl, apiBase: CF_BASE } },
      }),
    );
    expect(err.service).toBe("cloudflare");
    expect(err.message).toContain("no Cloudflare API token");
    expect(err.options.fix).toContain("CLOUDFLARE_API_TOKEN");
    // Nothing may go on the wire before the credential check.
    expect(calls).toEqual([]);
  });

  test("throws when there is no zone to put the hostname under", async () => {
    const { fetchImpl, calls } = router({});
    const err = await caught(() => applyCloudflare(cfContext(fetchImpl, {}, testIo())));
    expect(err.message).toContain("no zone");
    expect(err.options.fix).toContain("--zone");
    expect(calls).toEqual([]);
  });

  test("an explicit hostname does not substitute for a zone", async () => {
    const { fetchImpl } = router({});
    const err = await caught(() =>
      applyCloudflare(cfContext(fetchImpl, { hostname: "desk.example.com" }, testIo())),
    );
    expect(err.message).toContain("no zone");
  });
});

// ---------------------------------------------------------------------------
// applyThredz
// ---------------------------------------------------------------------------

function wireSpace(over: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "sp_1",
    slug: "secretary-bot",
    name: "Secretary Bot",
    type: "individual",
    ownerKeyId: "key_1",
    articleCount: 4,
    ...over,
  };
}

function inventory(spaces: readonly unknown[]): Reply {
  return {
    status: 200,
    body: {
      spaces,
      usage: { shared: 0, individual: spaces.length },
      limits: { shared: null, individual: null, individualPerKey: 1 },
    },
  };
}

function thredzContext(
  fetchImpl: typeof fetch,
  options: SetupOptions,
  io: TestIo,
  target: SetupTarget,
  apiKey: string | null = THREDZ_KEY,
): SetupContext {
  return {
    target,
    options,
    credentials: apiKey === null ? {} : { thredzApiKey: apiKey },
    io,
    deps: { thredz: { fetchImpl, apiBase: THREDZ_BASE } },
  };
}

describe("applyThredz", () => {
  test("creates the space and writes the slug into the real spec file", async () => {
    const target = harness(SPEC_FULL);
    const { fetchImpl, calls } = router({
      "GET /api/wiki/spaces": inventory([]),
      "POST /api/wiki/spaces": { status: 201, body: wireSpace() },
    });
    const io = testIo();
    const out = await applyThredz(thredzContext(fetchImpl, {}, io, target));

    // `private` visibility means an individual space: readable only by the key
    // that owns it.
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      name: "Secretary Bot",
      slug: "secretary-bot",
      type: "individual",
    });
    expect(out.slug).toBe("secretary-bot");
    expect(out.changes.map((c) => c.outcome)).toEqual(["created", "updated"]);
    expect(io.infos).toContain("Thredz key verified");

    const yamlText = readFileSync(target.specPath, "utf8");
    expect(yamlText).toContain("space: secretary-bot");
    // The edit is CST-preserving: the operator's comment survives.
    expect(yamlText).toContain("# a fleet harness, comments and all");
    expect(yamlText).toContain("api_key: $THREDZ_API_KEY");
  });

  test("a shared visibility spec asks for a shared space, and --space-type overrides", async () => {
    const shared = `name: Secretary Bot
thredz:
  api_key: $THREDZ_API_KEY
  visibility: shared
`;
    const target = harness(shared);
    const { fetchImpl, calls } = router({
      "GET /api/wiki/spaces": inventory([]),
      "POST /api/wiki/spaces": { status: 201, body: wireSpace({ type: "shared" }) },
    });
    await applyThredz(thredzContext(fetchImpl, {}, testIo(), target));
    expect((calls.find((c) => c.method === "POST")?.body as { type: string }).type).toBe("shared");

    const target2 = harness(shared);
    const second = router({
      "GET /api/wiki/spaces": inventory([]),
      "POST /api/wiki/spaces": { status: 201, body: wireSpace({ type: "individual" }) },
    });
    await applyThredz(
      thredzContext(second.fetchImpl, { spaceType: "individual" }, testIo(), target2),
    );
    expect((second.calls.find((c) => c.method === "POST")?.body as { type: string }).type).toBe(
      "individual",
    );
  });

  test("a pre-existing space is adopted, and an already-correct spec is left alone", async () => {
    const target = harness(`name: Secretary Bot
thredz:
  api_key: $THREDZ_API_KEY
  space: secretary-bot
`);
    const before = readFileSync(target.specPath, "utf8");
    const { fetchImpl, calls } = router({ "GET /api/wiki/spaces": inventory([wireSpace()]) });
    const out = await applyThredz(thredzContext(fetchImpl, {}, testIo(), target));

    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(out.changes.map((c) => c.outcome)).toEqual(["unchanged", "unchanged"]);
    expect(readFileSync(target.specPath, "utf8")).toBe(before);
  });

  test("throws when the spec carries no thredz block", async () => {
    const { fetchImpl, calls } = router({});
    const err = await caught(() =>
      applyThredz(thredzContext(fetchImpl, {}, testIo(), harness(SPEC_SLACK_ONLY))),
    );
    expect(err.service).toBe("thredz");
    expect(err.message).toContain("no thredz: block");
    expect(err.options.fix).toContain("--services");
    expect(calls).toEqual([]);
  });

  test("throws when there is no Thredz key", async () => {
    const { fetchImpl, calls } = router({});
    const err = await caught(() =>
      applyThredz(thredzContext(fetchImpl, {}, testIo(), harness(SPEC_FULL), null)),
    );
    expect(err.message).toContain("no Thredz API key");
    expect(err.options.fix).toContain("THREDZ_API_KEY");
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// applySlack
// ---------------------------------------------------------------------------

const HOSTNAME = "secretary-bot.example.com";
const APP_ID = "A0SETUP1";

function slackOk(body: Readonly<Record<string, unknown>>): Reply {
  return { status: 200, body: { ok: true, ...body } };
}

const CREATED_APP = slackOk({
  app_id: APP_ID,
  credentials: {
    client_id: "111.222",
    client_secret: "client-secret-value",
    signing_secret: "signing-secret-value",
    verification_token: "verification-token-value",
  },
  oauth_authorize_url: `https://slack.com/oauth/v2/authorize?client_id=111.222&app=${APP_ID}`,
});

function slackContext(
  fetchImpl: typeof fetch,
  options: SetupOptions,
  io: TestIo,
  extras: {
    readonly target?: SetupTarget;
    readonly start?: (opts: ResponderOptions) => Promise<Responder>;
    readonly portInUse?: (port: number) => Promise<boolean>;
    readonly configToken?: string | undefined;
  } = {},
): SetupContext {
  const configToken = "configToken" in extras ? extras.configToken : SLACK_CONFIG_TOKEN;
  return {
    target: extras.target ?? harness(SPEC_FULL),
    options,
    credentials: configToken === undefined ? {} : { slackConfigToken: configToken },
    io,
    deps: {
      slack: { fetchImpl, apiBase: SLACK_BASE },
      ...(extras.start === undefined ? {} : { startResponder: extras.start }),
      ...(extras.portInUse === undefined ? {} : { portInUse: extras.portInUse }),
    },
  };
}

describe("applySlack", () => {
  test("persists the app credentials BEFORE the OAuth exchange", async () => {
    // The signing secret is returned exactly once and cannot be read back, so
    // it must survive a failure in EVERY step that follows the create.
    const { fetchImpl } = router({
      "POST /api/apps.manifest.validate": slackOk({}),
      "POST /api/apps.manifest.create": CREATED_APP,
      "POST /api/oauth.v2.access": { status: 200, body: { ok: false, error: "invalid_code" } },
    });
    const responder = fakeResponder();
    const io = testIo({ withOpenUrl: true });
    const ctx = slackContext(fetchImpl, {}, io, { start: responder.start });

    const err = await caught(() => applySlack(ctx, HOSTNAME, envPath()));
    expect(err.message).toContain("invalid_code");

    const values = readEnvFile(envPath()).values;
    expect(values["SECRETARY_SLACK_SIGNING_SECRET"]).toBe("signing-secret-value");
    expect(values["SECRETARY_SLACK_APP_ID"]).toBe(APP_ID);
    expect(values["SECRETARY_SLACK_CLIENT_ID"]).toBe("111.222");
    expect(values["SECRETARY_SLACK_CLIENT_SECRET"]).toBe("client-secret-value");
    // The one value that legitimately did not survive: the install never
    // completed, so there is no bot token yet.
    expect(values["SECRETARY_SLACK_BOT_TOKEN"]).toBeUndefined();
    // And the listener is still closed on the way out.
    expect(responder.state.stops).toBe(1);
  });

  test("the happy path writes the bot token under the variable the SPEC chose", async () => {
    const { fetchImpl, calls } = router({
      "POST /api/apps.manifest.validate": slackOk({}),
      "POST /api/apps.manifest.create": CREATED_APP,
      "POST /api/oauth.v2.access": slackOk({
        access_token: BOT_TOKEN,
        bot_user_id: "U0BOT",
        team: { id: "T0ACME", name: "Acme" },
        scope: "chat:write,app_mentions:read",
      }),
    });
    const responder = fakeResponder({ code: "oauth-code-9" });
    const io = testIo({ withOpenUrl: true });
    const out = await applySlack(
      slackContext(fetchImpl, { installTimeoutMs: 1234 }, io, { start: responder.start }),
      HOSTNAME,
      envPath(),
    );

    const values = readEnvFile(envPath()).values;
    expect(values["SECRETARY_SLACK_BOT_TOKEN"]).toBe(BOT_TOKEN);
    expect(values["SLACK_BOT_TOKEN"]).toBeUndefined();

    expect(out.changes.map((c) => c.outcome)).toEqual(["created", "created"]);
    expect(out.changes[1]?.summary).toContain("Acme");
    expect(out.followUp).toEqual([]);
    expect(responder.timeouts).toEqual([1234]);
    expect(responder.state.stops).toBe(1);

    // The manifest is derived from the spec: reactions on ⇒ the extra scope
    // and event, and both Request URLs live under the tunnel hostname.
    const manifest = JSON.parse((calls[0]?.body as { manifest: string }).manifest) as Record<
      string,
      never
    >;
    const parsed = manifest as unknown as {
      oauth_config: { scopes: { bot: string[] }; redirect_urls?: string[] };
      settings: { event_subscriptions: { request_url: string; bot_events: string[] } };
    };
    expect(parsed.oauth_config.scopes.bot).toContain("reactions:read");
    expect(parsed.settings.event_subscriptions.bot_events).toContain("reaction_added");
    expect(parsed.settings.event_subscriptions.request_url).toBe(
      `https://${HOSTNAME}/slack/events`,
    );
    expect(parsed.oauth_config.redirect_urls).toEqual([
      `https://${HOSTNAME}/crewhaus/oauth/callback`,
    ]);

    // The authorize URL carries the state token the responder checks.
    expect(io.opened).toHaveLength(1);
    expect(io.opened[0]).toContain("state=crewhaus-services-setup");
    expect(io.opened[0]).toContain("client_id=111.222");

    const exchange = calls.find((c) => c.path.endsWith("oauth.v2.access"));
    expect((exchange?.body as Record<string, string>)["code"]).toBe("oauth-code-9");
    expect((exchange?.body as Record<string, string>)["redirect_uri"]).toBe(
      `https://${HOSTNAME}/crewhaus/oauth/callback`,
    );
  });

  test("an app id already in .env takes the UPDATE path and never creates", async () => {
    writeFileSync(envPath(), `SECRETARY_SLACK_APP_ID=${APP_ID}\n`, "utf8");
    const { fetchImpl, calls } = router({
      "POST /api/apps.manifest.validate": slackOk({}),
      "POST /api/apps.manifest.update": slackOk({ permissions_updated: false }),
    });
    const responder = fakeResponder();
    const out = await applySlack(
      slackContext(fetchImpl, {}, testIo({ withOpenUrl: true }), { start: responder.start }),
      HOSTNAME,
      envPath(),
    );

    expect(calls.some((c) => c.path.endsWith("apps.manifest.create"))).toBe(false);
    expect((calls.find((c) => c.path.endsWith("update"))?.body as { app_id: string }).app_id).toBe(
      APP_ID,
    );
    expect(out.changes).toHaveLength(1);
    expect(out.changes[0]?.outcome).toBe("updated");
    expect(out.changes[0]?.summary).toContain(APP_ID);
    // The update path does NOT stop here. An earlier version returned right
    // after updateApp, which meant a run that created the app and then failed
    // during install could never finish: the app id was on file, so every
    // re-run reported success and exited 0 with no bot token. With no token in
    // .env the install is still owed, and setup says so.
    expect(out.followUp).toHaveLength(1);
    expect(out.followUp[0]).toContain(`$${"SECRETARY_SLACK_BOT_TOKEN"}`);
    expect(responder.state.stops).toBe(1);
  });

  test("the update path SKIPS the install when a bot token is already on file", async () => {
    writeFileSync(
      envPath(),
      `SECRETARY_SLACK_APP_ID=${APP_ID}\nSECRETARY_SLACK_BOT_TOKEN=xoxb-live\n`,
      "utf8",
    );
    const { fetchImpl } = router({
      "POST /api/apps.manifest.validate": slackOk({}),
      "POST /api/apps.manifest.update": slackOk({ permissions_updated: false }),
    });
    const out = await applySlack(
      slackContext(fetchImpl, {}, testIo(), { start: fakeResponder().start }),
      HOSTNAME,
      envPath(),
    );
    expect(out.followUp).toEqual([]);
    expect(out.changes.at(-1)?.outcome).toBe("unchanged");
    expect(out.changes.at(-1)?.summary).toContain("already installed");
  });

  test("a re-run after a failed install still completes it", async () => {
    // The recovery the plan header promises: run 1 creates the app and dies
    // during install; run 2 must finish the job, not report success.
    writeFileSync(
      envPath(),
      [
        `SECRETARY_SLACK_APP_ID=${APP_ID}`,
        "SECRETARY_SLACK_CLIENT_ID=cid",
        "SECRETARY_SLACK_CLIENT_SECRET=csec",
        "SECRETARY_SLACK_SIGNING_SECRET=ssec",
        "",
      ].join("\n"),
      "utf8",
    );
    const { fetchImpl, calls } = router({
      "POST /api/apps.manifest.validate": slackOk({}),
      "POST /api/apps.manifest.update": slackOk({ permissions_updated: false }),
      "POST /api/oauth.v2.access": slackOk({
        access_token: "xoxb-recovered",
        bot_user_id: "U1",
        team: { id: "T1", name: "Acme" },
        scope: "chat:write",
      }),
    });
    const out = await applySlack(
      slackContext(fetchImpl, {}, testIo({ withOpenUrl: true }), { start: fakeResponder().start }),
      HOSTNAME,
      envPath(),
    );
    expect(calls.some((c) => c.path.endsWith("oauth.v2.access"))).toBe(true);
    expect(readFileSync(envPath(), "utf8")).toContain("SECRETARY_SLACK_BOT_TOKEN=xoxb-recovered");
    expect(out.changes.some((c) => c.summary.includes("installed to Acme"))).toBe(true);
  });

  test("--app-id takes the update path too, without consulting .env", async () => {
    const { fetchImpl, calls } = router({
      "POST /api/apps.manifest.validate": slackOk({}),
      "POST /api/apps.manifest.update": slackOk({ permissions_updated: false }),
    });
    await applySlack(
      slackContext(fetchImpl, { slackAppId: "A0FLAG" }, testIo(), {
        start: fakeResponder().start,
      }),
      HOSTNAME,
      envPath(),
    );
    // The flag is also handed to validate, so Slack checks the manifest
    // against that app's current state rather than in the abstract.
    expect((calls[0]?.body as { app_id?: string }).app_id).toBe("A0FLAG");
    expect((calls[1]?.body as { app_id: string }).app_id).toBe("A0FLAG");
  });

  test("permissions_updated: true produces a reinstall follow-up", async () => {
    writeFileSync(envPath(), `SECRETARY_SLACK_APP_ID=${APP_ID}\n`, "utf8");
    const { fetchImpl } = router({
      "POST /api/apps.manifest.validate": slackOk({}),
      "POST /api/apps.manifest.update": slackOk({ permissions_updated: true }),
    });
    const out = await applySlack(
      slackContext(fetchImpl, {}, testIo(), { start: fakeResponder().start }),
      HOSTNAME,
      envPath(),
    );
    expect(out.followUp).toHaveLength(1);
    expect(out.followUp[0]).toContain("Scopes changed");
    expect(out.followUp[0]).toContain(`https://api.slack.com/apps/${APP_ID}/install-on-team`);
  });

  test("--manual-install skips the OAuth round trip and emits an install URL", async () => {
    const { fetchImpl, calls } = router({
      "POST /api/apps.manifest.validate": slackOk({}),
      "POST /api/apps.manifest.create": CREATED_APP,
    });
    const responder = fakeResponder();
    const out = await applySlack(
      slackContext(fetchImpl, { manualInstall: true }, testIo({ withOpenUrl: true }), {
        start: responder.start,
      }),
      HOSTNAME,
      envPath(),
    );

    expect(calls.some((c) => c.path.endsWith("oauth.v2.access"))).toBe(false);
    expect(responder.timeouts).toEqual([]);
    expect(out.followUp).toHaveLength(1);
    expect(out.followUp[0]).toContain("$SECRETARY_SLACK_BOT_TOKEN");
    expect(out.followUp[0]).toContain("https://slack.com/oauth/v2/authorize");
    // No redirect URL is registered, because nothing will be listening on one.
    const manifest = JSON.parse((calls[0]?.body as { manifest: string }).manifest) as {
      oauth_config: { redirect_urls?: string[] };
    };
    expect(manifest.oauth_config.redirect_urls).toBeUndefined();
    // The credentials are still on disk — that write never depends on install.
    expect(readEnvFile(envPath()).values["SECRETARY_SLACK_SIGNING_SECRET"]).toBe(
      "signing-secret-value",
    );
    expect(responder.state.stops).toBe(1);
  });

  test("a busy events port means the daemon answers, so no responder is started", async () => {
    const { fetchImpl, calls } = router({
      "POST /api/apps.manifest.validate": slackOk({}),
      "POST /api/apps.manifest.create": CREATED_APP,
    });
    const responder = fakeResponder();
    const io = testIo({ withOpenUrl: true });
    const out = await applySlack(
      slackContext(fetchImpl, {}, io, {
        start: responder.start,
        portInUse: () => Promise.resolve(true),
      }),
      HOSTNAME,
      envPath(),
    );

    expect(responder.startCalls).toEqual([]);
    expect(responder.state.stops).toBe(0);
    expect(io.infos.join("\n")).toContain("already serving");
    // With no listener of our own there is nothing to catch the callback, so
    // the operator finishes the install by hand.
    expect(calls.some((c) => c.path.endsWith("oauth.v2.access"))).toBe(false);
    expect(out.followUp[0]).toContain("$SECRETARY_SLACK_BOT_TOKEN");
  });

  test("a free port starts the responder on the events port and the events path", async () => {
    const { fetchImpl } = router({
      "POST /api/apps.manifest.validate": slackOk({}),
      "POST /api/apps.manifest.create": CREATED_APP,
      "POST /api/oauth.v2.access": slackOk({
        access_token: BOT_TOKEN,
        team: { id: "T0ACME", name: "Acme" },
        scope: "chat:write",
      }),
    });
    const responder = fakeResponder();
    const io = testIo({ withOpenUrl: true });
    await applySlack(
      slackContext(fetchImpl, {}, io, {
        target: harness(SPEC_FULL, 4321),
        start: responder.start,
        portInUse: () => Promise.resolve(false),
      }),
      HOSTNAME,
      envPath(),
    );
    expect(responder.startCalls).toEqual([
      {
        port: 4321,
        eventsPath: "/slack/events",
        callbackPath: "/crewhaus/oauth/callback",
        expectedState: "crewhaus-services-setup",
      },
    ]);
    expect(io.infos.join("\n")).toContain("stand-in listener on :4321");
  });

  test("the responder is stopped in a finally even when a later step throws", async () => {
    const { fetchImpl } = router({
      "POST /api/apps.manifest.validate": slackOk({}),
      "POST /api/apps.manifest.create": CREATED_APP,
    });
    const responder = fakeResponder({ codeError: new Error("install timed out after 300s") });
    const io = testIo({ withOpenUrl: true });
    await expect(
      applySlack(slackContext(fetchImpl, {}, io, { start: responder.start }), HOSTNAME, envPath()),
    ).rejects.toThrow("install timed out");
    expect(responder.state.stops).toBe(1);
  });

  test("an unverified Request URL becomes a follow-up rather than a silent success", async () => {
    const { fetchImpl } = router({
      "POST /api/apps.manifest.validate": slackOk({}),
      "POST /api/apps.manifest.create": CREATED_APP,
      "POST /api/oauth.v2.access": slackOk({
        access_token: BOT_TOKEN,
        team: { id: "T0ACME", name: "Acme" },
        scope: "chat:write",
      }),
    });
    const responder = fakeResponder({ sawChallenge: false });
    const out = await applySlack(
      slackContext(fetchImpl, {}, testIo({ withOpenUrl: true }), { start: responder.start }),
      HOSTNAME,
      envPath(),
    );
    expect(out.followUp).toHaveLength(1);
    expect(out.followUp[0]).toContain("has not yet verified the Request URL");
    expect(out.followUp[0]).toContain(`https://api.slack.com/apps/${APP_ID}/event-subscriptions`);
  });

  test("without an openUrl seam the authorize URL is printed instead", async () => {
    const { fetchImpl } = router({
      "POST /api/apps.manifest.validate": slackOk({}),
      "POST /api/apps.manifest.create": CREATED_APP,
      "POST /api/oauth.v2.access": slackOk({
        access_token: BOT_TOKEN,
        team: { id: "T0ACME", name: "Acme" },
        scope: "chat:write",
      }),
    });
    const io = testIo();
    await applySlack(
      slackContext(fetchImpl, {}, io, { start: fakeResponder().start }),
      HOSTNAME,
      envPath(),
    );
    expect(io.infos.join("\n")).toContain("https://slack.com/oauth/v2/authorize");
  });

  test("throws when the spec configures no Slack channel", async () => {
    const { fetchImpl, calls } = router({});
    const err = await caught(() =>
      applySlack(
        slackContext(fetchImpl, {}, testIo(), { target: harness(SPEC_THREDZ_ONLY) }),
        HOSTNAME,
        envPath(),
      ),
    );
    expect(err.service).toBe("slack");
    expect(err.message).toContain("configures no Slack channel");
    expect(calls).toEqual([]);
  });

  test("throws when there is no app-configuration token", async () => {
    const { fetchImpl, calls } = router({});
    const err = await caught(() =>
      applySlack(
        slackContext(fetchImpl, {}, testIo(), { configToken: undefined }),
        HOSTNAME,
        envPath(),
      ),
    );
    expect(err.message).toContain("no Slack app-configuration token");
    expect(err.options.fix).toContain("App Configuration Tokens");
    expect(calls).toEqual([]);
  });

  test("throws when the spec names no env variables for the Slack credentials", async () => {
    // An inlined literal has nowhere for setup to write the values it learns.
    const inlined = harness(`name: Secretary Bot
channels:
  slack:
    botToken: xoxb-pasted-in-by-hand
    signingSecret: $SECRETARY_SLACK_SIGNING_SECRET
`);
    const { fetchImpl, calls } = router({});
    const err = await caught(() =>
      applySlack(slackContext(fetchImpl, {}, testIo(), { target: inlined }), HOSTNAME, envPath()),
    );
    expect(err.message).toContain("does not name env variables");
    expect(err.options.fix).toContain("$UPPER_SNAKE");
    expect(calls).toEqual([]);
  });

  test("a fleet's own variable prefix drives every name setup writes", async () => {
    const target = harness(`name: Night Desk
channels:
  slack:
    botToken: $NIGHT_SLACK_BOT_TOKEN
    signingSecret: $NIGHT_SLACK_SIGNING
`);
    const { fetchImpl } = router({
      "POST /api/apps.manifest.validate": slackOk({}),
      "POST /api/apps.manifest.create": CREATED_APP,
      "POST /api/oauth.v2.access": slackOk({
        access_token: BOT_TOKEN,
        team: { id: "T0ACME", name: "Acme" },
        scope: "chat:write",
      }),
    });
    await applySlack(
      slackContext(fetchImpl, {}, testIo({ withOpenUrl: true }), {
        target,
        start: fakeResponder().start,
      }),
      HOSTNAME,
      envPath(),
    );
    const values = readEnvFile(envPath()).values;
    expect(values["NIGHT_SLACK_SIGNING"]).toBe("signing-secret-value");
    expect(values["NIGHT_SLACK_APP_ID"]).toBe(APP_ID);
    expect(values["NIGHT_SLACK_CLIENT_ID"]).toBe("111.222");
    expect(values["NIGHT_SLACK_CLIENT_SECRET"]).toBe("client-secret-value");
    expect(values["NIGHT_SLACK_BOT_TOKEN"]).toBe(BOT_TOKEN);
  });
});

describe("regression — applyThredz must not create a space it cannot record", () => {
  test("a shorthand spec is refused BEFORE the space is created", async () => {
    // Creating first and refusing second stranded a space in the operator's
    // account that the harness could never be pointed at — and on an
    // individual key that is unrecoverable, since a key owns at most one
    // individual space, ever.
    const specPath = join(dir, "crewhaus.yaml");
    writeFileSync(specPath, "name: demo\ntarget: channel\nthredz: true\n", "utf8");
    const posts: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if ((init?.method ?? "GET") === "POST") posts.push(u);
      return new Response(JSON.stringify({ spaces: [], usage: {}, limits: {} }), { status: 200 });
    }) as unknown as typeof fetch;

    const target = readSetupTarget(specPath);
    await expect(
      applyThredz({
        target,
        options: {},
        credentials: { thredzApiKey: "thredz_k" },
        io: testIo(),
        deps: { thredz: { fetchImpl } },
      }),
    ).rejects.toThrow(/shorthand/);
    expect(posts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// applyAgentMail
// ---------------------------------------------------------------------------

const AGENTMAIL_BASE = "https://agentmail.invalid/v0";
const AGENTMAIL_PREFIX = "/v0";
// Assembled at runtime so no `am_`-shaped literal ever lands in the repo.
const ORG_KEY = ["am", "orgkeyplantest"].join("_");
const SCOPED_KEY = ["am", "scopedkeyplantest"].join("_");

/** The spec's own variable names — deliberately not any default this tool holds. */
const SPEC_MAIL = `name: Secretary Bot
target: channel
mcp_servers:
  sendmail:
    command: npx
    args:
      - agentmail-mcp
    env:
      AGENTMAIL_API_KEY: $AGENTMAIL_API_KEY
      CREW_SECRETARY_INBOX_ID: $CREW_SECRETARY_INBOX_ID
`;

/** The mail tier still in dry-run: the credential is live, the inbox is a comment. */
const SPEC_MAIL_COMMENTED = `name: Secretary Bot
target: channel
mcp_servers:
  sendmail:
    command: npx
    env:
      AGENTMAIL_API_KEY: $AGENTMAIL_API_KEY
      # CREW_SECRETARY_INBOX_ID: $CREW_SECRETARY_INBOX_ID
`;

/** A fleet that prefixes the credential per role, within what the regex allows. */
const SPEC_MAIL_ROLE_KEY = `name: Secretary Bot
target: channel
mcp_servers:
  sendmail:
    env:
      AGENTMAIL_SECRETARY_KEY: $AGENTMAIL_SECRETARY_KEY
      CREW_SECRETARY_INBOX_ID: $CREW_SECRETARY_INBOX_ID
`;

const INBOX_WIRE = {
  inbox_id: "inbox_9f3c1b",
  email: "secretary@agentmail.to",
  display_name: "Secretary Bot",
  client_id: "crewhaus-Secretary-Bot",
  created_at: "2026-09-01T10:00:00Z",
};

const VERIFY_ROUTE = `GET ${AGENTMAIL_PREFIX}/inboxes?limit=1`;
const CREATE_ROUTE = `POST ${AGENTMAIL_PREFIX}/inboxes`;
const SCOPED_KEY_ROUTE = `POST ${AGENTMAIL_PREFIX}/inboxes/${INBOX_WIRE.inbox_id}/api-keys`;

const VERIFY_OK: Reply = { status: 200, body: { count: 0, inboxes: [] } };
const SCOPED_KEY_OK: Reply = {
  status: 201,
  body: { api_key_id: "key_77", api_key: SCOPED_KEY, name: "crewhaus:Secretary Bot" },
};

/** Write a real spec into the temp harness dir, honouring the --inbox-var escape hatch. */
function mailHarness(yamlText: string, inboxVar?: string): SetupTarget {
  const specPath = join(dir, "crewhaus.yaml");
  writeFileSync(specPath, yamlText, "utf8");
  return readSetupTarget(specPath, inboxVar === undefined ? {} : { inboxVar });
}

function mailContext(
  fetchImpl: typeof fetch,
  options: SetupOptions,
  io: TestIo,
  target: SetupTarget,
  apiKey: string | null = ORG_KEY,
): SetupContext {
  return {
    target,
    options,
    credentials: apiKey === null ? {} : { agentMailApiKey: apiKey },
    io,
    deps: { agentmail: { fetchImpl, apiBase: AGENTMAIL_BASE } },
  };
}

describe("applyAgentMail", () => {
  test("verifies, creates, and records the id in the variable the SPEC named", async () => {
    const { fetchImpl, calls } = router({
      [VERIFY_ROUTE]: VERIFY_OK,
      [CREATE_ROUTE]: { status: 201, body: INBOX_WIRE },
    });
    const io = testIo();
    const out = await applyAgentMail(
      mailContext(fetchImpl, {}, io, mailHarness(SPEC_MAIL)),
      envPath(),
    );

    // Verify first: a 401 halfway through provisioning becomes "nothing
    // happened, fix the key".
    expect(calls.map((c) => `${c.method} ${c.path}${c.search}`)).toEqual([
      `GET ${AGENTMAIL_PREFIX}/inboxes?limit=1`,
      `POST ${AGENTMAIL_PREFIX}/inboxes`,
    ]);
    expect(calls[0]?.authorization).toBe(`Bearer ${ORG_KEY}`);
    // `client_id` is the idempotency key, derived from the harness name so the
    // same harness derives the same value on every machine and every run.
    expect(calls[1]?.body).toEqual({
      client_id: "crewhaus-Secretary-Bot",
      display_name: "Secretary Bot",
    });
    expect(io.infos).toContain("AgentMail key verified");

    expect(out.inboxId).toBe("inbox_9f3c1b");
    expect(out.email).toBe("secretary@agentmail.to");
    expect(out.needsUncomment).toBeUndefined();
    expect(out.changes).toEqual([
      {
        service: "agentmail",
        summary: "inbox secretary@agentmail.to",
        outcome: "created",
        // The write kind is surfaced, matching how Slack and Thredz report theirs.
        detail: ["id → $CREW_SECRETARY_INBOX_ID (appended)"],
      },
    ]);

    // The id lands in the spec's own variable — nothing here holds a default.
    const values = readEnvFile(envPath()).values;
    expect(Object.keys(values)).toEqual(["CREW_SECRETARY_INBOX_ID"]);
    expect(values["CREW_SECRETARY_INBOX_ID"]).toBe("inbox_9f3c1b");
    expect(readFileSync(envPath(), "utf8")).toContain("CREW_SECRETARY_INBOX_ID=inbox_9f3c1b");
    // The id is what the send path takes; the address is only for humans.
    expect(readFileSync(envPath(), "utf8")).not.toContain("secretary@agentmail.to");
  });

  test("the org key never reaches the harness", async () => {
    // The whole reason the org key is classed as a PROVISIONING credential:
    // it can read and send from every inbox on the account.
    const { fetchImpl } = router({
      [VERIFY_ROUTE]: VERIFY_OK,
      [CREATE_ROUTE]: { status: 201, body: INBOX_WIRE },
      [SCOPED_KEY_ROUTE]: SCOPED_KEY_OK,
    });
    const io = testIo();
    const out = await applyAgentMail(
      mailContext(
        fetchImpl,
        { scopedKeyVar: "SECRETARY_AGENTMAIL_KEY" },
        io,
        mailHarness(SPEC_MAIL),
      ),
      envPath(),
    );

    const text = readFileSync(envPath(), "utf8");
    expect(text).not.toContain(ORG_KEY);
    expect(readEnvFile(envPath()).values["AGENTMAIL_API_KEY"]).toBeUndefined();
    // Nor into anything the operator sees.
    expect(JSON.stringify(out.changes)).not.toContain(ORG_KEY);
    expect(io.infos.join("\n")).not.toContain(ORG_KEY);
    expect(io.warns.join("\n")).not.toContain(ORG_KEY);
  });

  test("--mail-username and --mail-domain are forwarded, and omitted otherwise", async () => {
    const { fetchImpl, calls } = router({
      [VERIFY_ROUTE]: VERIFY_OK,
      [CREATE_ROUTE]: { status: 201, body: INBOX_WIRE },
    });
    await applyAgentMail(
      mailContext(
        fetchImpl,
        { mailUsername: "secretary", mailDomain: "mail.example.com" },
        testIo(),
        mailHarness(SPEC_MAIL),
      ),
      envPath(),
    );
    expect(calls[1]?.body).toEqual({
      client_id: "crewhaus-Secretary-Bot",
      username: "secretary",
      domain: "mail.example.com",
      display_name: "Secretary Bot",
    });
  });

  test("a 200 replay of the same client_id renders unchanged, not created", async () => {
    // 201 = created now; 200 = the idempotent replay of an earlier create. The
    // status is the only trustworthy signal, so it is not guessed at.
    const { fetchImpl } = router({
      [VERIFY_ROUTE]: VERIFY_OK,
      [CREATE_ROUTE]: { status: 200, body: INBOX_WIRE },
    });
    const out = await applyAgentMail(
      mailContext(fetchImpl, {}, testIo(), mailHarness(SPEC_MAIL)),
      envPath(),
    );
    // Not "created": a 200 cannot prove one (the API answers 200 for both a
    // create and an idempotent replay), so the step never claims it did. The
    // env file DID change on this first run, though, and reporting
    // "unchanged" there would be the wrong half of the truth.
    expect(out.changes[0]?.outcome).not.toBe("created");
    expect(out.changes[0]?.detail?.join(" ")).toContain("appended");
    expect(out.inboxId).toBe("inbox_9f3c1b");
    // The id is still recorded — a replay is a successful run, not a skip.
    expect(readEnvFile(envPath()).values["CREW_SECRETARY_INBOX_ID"]).toBe("inbox_9f3c1b");
  });

  test("a commented-out tier is written, then handed back as an edit to make", async () => {
    const { fetchImpl } = router({
      [VERIFY_ROUTE]: VERIFY_OK,
      [CREATE_ROUTE]: { status: 201, body: INBOX_WIRE },
    });
    const out = await applyAgentMail(
      mailContext(
        fetchImpl,
        {},
        testIo(),
        mailHarness(SPEC_MAIL_COMMENTED, "CREW_SECRETARY_INBOX_ID"),
      ),
      envPath(),
    );

    // Setup writes .env and stops: uncommenting a `$VAR` under
    // mcp_servers.*.env is an edit whose blast radius is "the daemon no longer
    // starts", so the operator makes it knowing the value is now there.
    // The message names the SERVER, not a wildcard — the operator has to find
    // the line, and `mcp_servers.*.env` is not a place.
    expect(out.needsUncomment).toBe(
      "uncomment a ref to CREW_SECRETARY_INBOX_ID under mcp_servers.sendmail.env",
    );
    expect(readEnvFile(envPath()).values["CREW_SECRETARY_INBOX_ID"]).toBe("inbox_9f3c1b");
  });

  test("mints an inbox-scoped key into the named variable", async () => {
    const { fetchImpl, calls } = router({
      [VERIFY_ROUTE]: VERIFY_OK,
      [CREATE_ROUTE]: { status: 201, body: INBOX_WIRE },
      [SCOPED_KEY_ROUTE]: SCOPED_KEY_OK,
    });
    const out = await applyAgentMail(
      mailContext(
        fetchImpl,
        { scopedKeyVar: "SECRETARY_AGENTMAIL_KEY" },
        testIo(),
        mailHarness(SPEC_MAIL),
      ),
      envPath(),
    );

    const mint = calls.find((c) => c.path.endsWith("/api-keys"));
    expect(mint?.body).toEqual({ name: "crewhaus-Secretary-Bot" });
    expect(out.changes[1]).toEqual({
      service: "agentmail",
      summary: "inbox-scoped key → $SECRETARY_AGENTMAIL_KEY",
      outcome: "created",
      detail: ["key id key_77", "scoped to this inbox only"],
    });
    // The secret is returned once and never again, so it is persisted at once.
    expect(readEnvFile(envPath()).values["SECRETARY_AGENTMAIL_KEY"]).toBe(SCOPED_KEY);
  });

  test("an empty assignment counts as unset, so the key is still minted", async () => {
    writeFileSync(envPath(), "SECRETARY_AGENTMAIL_KEY=\n", "utf8");
    const { fetchImpl, calls } = router({
      [VERIFY_ROUTE]: VERIFY_OK,
      [CREATE_ROUTE]: { status: 201, body: INBOX_WIRE },
      [SCOPED_KEY_ROUTE]: SCOPED_KEY_OK,
    });
    await applyAgentMail(
      mailContext(
        fetchImpl,
        { scopedKeyVar: "SECRETARY_AGENTMAIL_KEY" },
        testIo(),
        mailHarness(SPEC_MAIL),
      ),
      envPath(),
    );
    expect(calls.some((c) => c.path.endsWith("/api-keys"))).toBe(true);
    expect(readEnvFile(envPath()).values["SECRETARY_AGENTMAIL_KEY"]).toBe(SCOPED_KEY);
  });

  test("never mints a second key over a variable that already holds one", async () => {
    // Minting is NOT idempotent — there is no client_id on that endpoint — so
    // a re-run that minted again would strand live keys on the account.
    const existing = ["am", "alreadyliveplantest"].join("_");
    writeFileSync(envPath(), `SECRETARY_AGENTMAIL_KEY=${existing}\n`, "utf8");
    const { fetchImpl, calls } = router({
      [VERIFY_ROUTE]: VERIFY_OK,
      [CREATE_ROUTE]: { status: 200, body: INBOX_WIRE },
    });
    const out = await applyAgentMail(
      mailContext(
        fetchImpl,
        { scopedKeyVar: "SECRETARY_AGENTMAIL_KEY" },
        testIo(),
        mailHarness(SPEC_MAIL),
      ),
      envPath(),
    );

    expect(calls.some((c) => c.path.endsWith("/api-keys"))).toBe(false);
    expect(out.changes[1]?.outcome).toBe("unchanged");
    expect(out.changes[1]?.summary).toContain("not minting another");
    expect(out.changes[1]?.detail?.join(" ")).toContain("not idempotent");
    expect(readEnvFile(envPath()).values["SECRETARY_AGENTMAIL_KEY"]).toBe(existing);
  });

  test("falls back to the credential variable the spec itself declares", async () => {
    // A fleet may prefix the key per role; the resolver only looks under the
    // fixed AGENTMAIL_API_KEY, so the spec's own name is the second chance.
    writeFileSync(envPath(), `AGENTMAIL_SECRETARY_KEY=${ORG_KEY}\n`, "utf8");
    const { fetchImpl, calls } = router({
      [VERIFY_ROUTE]: VERIFY_OK,
      [CREATE_ROUTE]: { status: 201, body: INBOX_WIRE },
    });
    const out = await applyAgentMail(
      mailContext(fetchImpl, {}, testIo(), mailHarness(SPEC_MAIL_ROLE_KEY), null),
      envPath(),
    );
    expect(calls[0]?.authorization).toBe(`Bearer ${ORG_KEY}`);
    expect(out.inboxId).toBe("inbox_9f3c1b");
    expect(readEnvFile(envPath()).values["CREW_SECRETARY_INBOX_ID"]).toBe("inbox_9f3c1b");
  });

  test("throws when the spec declares no AgentMail inbox", async () => {
    const { fetchImpl, calls } = router({});
    const err = await caught(() =>
      applyAgentMail(mailContext(fetchImpl, {}, testIo(), harness(SPEC_BARE)), envPath()),
    );
    expect(err.service).toBe("agentmail");
    expect(err.message).toContain("declares no AgentMail inbox");
    expect(err.options.fix).toContain("mcp_servers.<server>.env");
    expect(err.options.fix).toContain("--inbox-var");
    expect(calls).toEqual([]);
  });

  test("throws when there is no AgentMail key, naming the variable the spec declares", async () => {
    const { fetchImpl, calls } = router({});
    const err = await caught(() =>
      applyAgentMail(
        mailContext(fetchImpl, {}, testIo(), mailHarness(SPEC_MAIL_ROLE_KEY), null),
        envPath(),
      ),
    );
    expect(err.service).toBe("agentmail");
    expect(err.message).toContain("no AgentMail API key");
    expect(err.options.fix).toContain("AGENTMAIL_API_KEY");
    expect(err.options.fix).toContain("$AGENTMAIL_SECRETARY_KEY");
    expect(err.options.fix).toContain("which this spec declares");
    expect(calls).toEqual([]);
  });

  test("throws before creating anything when the inbox id has nowhere to go", async () => {
    // An inbox is remote state; one this tool cannot record has no local
    // counterpart, and the check is free.
    const literal = `name: Secretary Bot
mcp_servers:
  sendmail:
    env:
      AGENTMAIL_API_KEY: $AGENTMAIL_API_KEY
      CREW_SECRETARY_INBOX_ID: inbox_pasted_by_hand
`;
    const { fetchImpl, calls } = router({});
    const err = await caught(() =>
      applyAgentMail(mailContext(fetchImpl, {}, testIo(), mailHarness(literal)), envPath()),
    );
    expect(err.service).toBe("agentmail");
    expect(err.message).toContain("is not an env ref");
    expect(err.message).toContain("mcp_servers.sendmail.env.CREW_SECRETARY_INBOX_ID");
    expect(err.options.fix).toContain("--inbox-var");
    expect(calls).toEqual([]);
  });
});
