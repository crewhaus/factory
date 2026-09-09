/**
 * AgentMail client coverage.
 *
 * Credential-free and network-free, like the other service-client suites:
 * every test drives a hand-rolled `fetchImpl` through `AgentMailDeps`, and
 * every test points `apiBase` at a host that does not resolve, so a regression
 * that bypasses the injected fetch fails loudly instead of quietly reaching
 * the real API with a fake key.
 *
 * Two contracts carry most of the weight here, because both are invisible in
 * the return value if you only look at the happy path:
 *
 *   1. The status IS the idempotency signal. `POST /v0/inboxes` answers 201
 *      for a genuine create and 200 for the replay of an earlier create with
 *      the same `client_id`, and `created` is derived from nothing else. Both
 *      halves are asserted; a client that guessed instead would still pass a
 *      201-only suite.
 *   2. The provider's own `fix` wins over ours. AgentMail errors carry
 *      operator-facing remediation plus a per-code docs anchor, so the tests
 *      pin the exact composed string rather than a `toContain` that a silent
 *      fallback would still satisfy.
 */
import { describe, expect, test } from "bun:test";
import {
  AGENTMAIL_API_BASE,
  AGENTMAIL_CONSOLE_URL,
  createInboxApiKey,
  ensureInbox,
  inboxClientId,
  listInboxes,
  verifyKey,
} from "./agentmail";
import { ServiceSetupError } from "./types";

const API_BASE = "https://agentmail.invalid/v0";

// Org-key shape only (`am_` + 32 hex), assembled at runtime so no secret-shaped
// literal ever lands in the repo. It is never sent anywhere real.
const AUTH = { apiKey: `am_${"0f1e2d3c".repeat(4)}` } as const;

const BEARER = `Bearer ${AUTH.apiKey}`;

/** The remediation `verifyKey` falls back to, pinned so a silent edit shows up. */
const CONSOLE_FALLBACK_FIX = `Mint an org key at ${AGENTMAIL_CONSOLE_URL} → API Keys (it starts "am_" and is shown once).`;

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

type Reply = { readonly status: number; readonly body?: unknown };
type Route = Reply | readonly Reply[];

type Recorded = {
  readonly method: string;
  readonly url: string;
  readonly path: string;
  readonly search: string;
  readonly authorization: string | undefined;
  readonly accept: string | undefined;
  readonly contentType: string | undefined;
  readonly body: unknown;
};

/**
 * Route-table fake. Keys are `"<METHOD> <path>"`, matched with the query
 * string first and then without it, so a test can pin `?limit=1` when the
 * query is the point and ignore it when it is not. A value may be a list to
 * script successive answers for one route; the last one sticks.
 */
function fakeAgentMail(routes: Readonly<Record<string, Route>>): {
  fetchImpl: typeof fetch;
  requests: Recorded[];
} {
  const requests: Recorded[] = [];
  const queues = new Map<string, Reply[]>();
  for (const [key, route] of Object.entries(routes)) {
    queues.set(key, "status" in route ? [route] : [...route]);
  }

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const raw = init?.body;
    requests.push({
      method,
      url: href,
      path: parsed.pathname,
      search: parsed.search,
      authorization: headers["authorization"],
      accept: headers["accept"],
      contentType: headers["content-type"],
      body: typeof raw === "string" && raw !== "" ? JSON.parse(raw) : undefined,
    });

    const bare = `${method} ${parsed.pathname}`;
    const queue = queues.get(`${bare}${parsed.search}`) ?? queues.get(bare);
    const next = queue === undefined ? undefined : queue.length > 1 ? queue.shift() : queue[0];
    if (next === undefined) {
      return new Response(
        JSON.stringify({ message: `no fake route for ${bare}${parsed.search}` }),
        {
          status: 599,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return new Response(next.body === undefined ? "" : JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, requests };
}

/** A wire-shaped inbox, with fields this package ignores present anyway. */
function wireInbox(over: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    pod_id: "pod_1",
    inbox_id: "secretary@agentmail.to",
    email: "secretary@agentmail.to",
    display_name: "Secretary Bot",
    client_id: "crewhaus:secretary",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    metadata: {},
    ...over,
  };
}

/** Await a call that must fail, and hand back the typed error. */
async function failure(run: () => Promise<unknown>): Promise<ServiceSetupError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ServiceSetupError) return err;
    throw err;
  }
  throw new Error("expected a ServiceSetupError, but the call resolved");
}

/** The JSON object a recorded request sent, so key-level absence is assertable. */
function sentBody(rec: Recorded | undefined): Readonly<Record<string, unknown>> {
  const body = rec?.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error(`expected a JSON object request body, got ${JSON.stringify(body)}`);
  }
  return body as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// inboxClientId
// ---------------------------------------------------------------------------

describe("inboxClientId", () => {
  test("namespaces the harness name, using only the charset AgentMail allows", () => {
    // `client_id` accepts 1-256 chars from `A-Z a-z 0-9 - . _ ~`. A colon is
    // NOT in that set, so the obvious `crewhaus:<name>` would be rejected on
    // every create — this separator is load-bearing, not cosmetic.
    expect(inboxClientId("secretary")).toBe("crewhaus-secretary");
    expect(inboxClientId("secretary")).toMatch(/^[A-Za-z0-9._~-]+$/);
    // A space is outside the allowed set, so it collapses to the separator.
    expect(inboxClientId("Crew Ops")).toBe("crewhaus-Crew-Ops");
    // An empty or all-punctuation name still has to yield something valid.
    expect(inboxClientId("")).toBe("crewhaus-harness");
  });

  test("is deterministic — the same name yields the same key every call", () => {
    // This is the whole anti-duplicate mechanism: a re-run on another machine
    // must derive the identical value or AgentMail creates a second inbox.
    const once = inboxClientId("secretary");
    expect(inboxClientId("secretary")).toBe(once);
    expect(inboxClientId("secretary")).toBe(once);
  });

  test("keeps distinct harnesses distinct, and never returns a bare name", () => {
    expect(inboxClientId("secretary")).not.toBe(inboxClientId("secretary-2"));
    // The prefix is what stops a collision with an operator's other tooling
    // using "secretary" as its own client id on the same account.
    expect(inboxClientId("secretary")).not.toBe("secretary");
    // Anything outside the allowed set collapses, so a spec name with spaces,
    // slashes or a colon still yields a usable id rather than a 400.
    for (const name of ["Crew Secretary", "crew/ops", "a:b", "  padded  ", "日本語"]) {
      expect(inboxClientId(name)).toMatch(/^[A-Za-z0-9._~-]+$/);
      expect(inboxClientId(name).length).toBeLessThanOrEqual(256);
    }
    expect(inboxClientId("!!!")).toBe("crewhaus-harness");
    expect(inboxClientId("secretary").startsWith("crewhaus-")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifyKey
// ---------------------------------------------------------------------------

describe("verifyKey", () => {
  test("bearer-authenticates a one-page list and returns the count", async () => {
    const { fetchImpl, requests } = fakeAgentMail({
      "GET /v0/inboxes?limit=1": {
        status: 200,
        body: { count: 3, inboxes: [wireInbox()], limit: 1, next_page_token: "tok_2" },
      },
    });

    const result = await verifyKey(AUTH, { fetchImpl, apiBase: API_BASE });

    expect(result).toEqual({ inboxCount: 3 });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.path).toBe("/v0/inboxes");
    // The cheapest authenticated call there is: one page, one row.
    expect(requests[0]?.search).toBe("?limit=1");
    expect(requests[0]?.authorization).toBe(BEARER);
    expect(requests[0]?.accept).toBe("application/json");
    // A GET carries no body, so no content-type is negotiated.
    expect(requests[0]?.contentType).toBeUndefined();
    expect(requests[0]?.body).toBeUndefined();
  });

  test("reports zero when the count is absent or not a number", async () => {
    const { fetchImpl } = fakeAgentMail({
      "GET /v0/inboxes?limit=1": [
        { status: 200, body: { inboxes: [] } },
        { status: 200, body: { count: "7", inboxes: [] } },
      ],
    });

    expect(await verifyKey(AUTH, { fetchImpl, apiBase: API_BASE })).toEqual({ inboxCount: 0 });
    expect(await verifyKey(AUTH, { fetchImpl, apiBase: API_BASE })).toEqual({ inboxCount: 0 });
  });

  test("counts an empty account as zero rather than failing", async () => {
    const { fetchImpl } = fakeAgentMail({
      "GET /v0/inboxes?limit=1": { status: 200, body: { count: 0, inboxes: [], limit: 1 } },
    });

    expect(await verifyKey(AUTH, { fetchImpl, apiBase: API_BASE })).toEqual({ inboxCount: 0 });
  });

  test("a 401 is auth, and the fallback fix says where to mint the key", async () => {
    const { fetchImpl } = fakeAgentMail({
      "GET /v0/inboxes?limit=1": {
        status: 401,
        body: {
          name: "UnauthorizedError",
          code: "unknown_api_key",
          message: "Unknown API key.",
        },
      },
    });

    const err = await failure(() => verifyKey(AUTH, { fetchImpl, apiBase: API_BASE }));

    expect(err).toBeInstanceOf(ServiceSetupError);
    expect(err.service).toBe("agentmail");
    expect(err.failureClass).toBe("auth");
    expect(err.options.status).toBe(401);
    expect(err.options.code).toBe("unknown_api_key");
    expect(err.message).toBe("AgentMail key rejected: Unknown API key. (unknown_api_key)");
    expect(err.options.fix).toBe(CONSOLE_FALLBACK_FIX);
    expect(err.options.fix).toContain(AGENTMAIL_CONSOLE_URL);
    expect(err.options.fix).toContain("am_");
  });

  test("a missing_authorization 401 classifies the same way", async () => {
    const { fetchImpl } = fakeAgentMail({
      "GET /v0/inboxes?limit=1": {
        status: 401,
        body: { name: "UnauthorizedError", code: "missing_authorization", message: "No header." },
      },
    });

    const err = await failure(() => verifyKey({ apiKey: "" }, { fetchImpl, apiBase: API_BASE }));

    expect(err.failureClass).toBe("auth");
    expect(err.options.code).toBe("missing_authorization");
  });

  test("defaults to the documented API base when none is injected", async () => {
    const { fetchImpl, requests } = fakeAgentMail({
      "GET /v0/inboxes?limit=1": { status: 200, body: { count: 0, inboxes: [] } },
    });

    await verifyKey(AUTH, { fetchImpl });

    expect(requests[0]?.url).toBe(`${AGENTMAIL_API_BASE}/inboxes?limit=1`);
    expect(AGENTMAIL_API_BASE).toBe("https://api.agentmail.to/v0");
  });
});

// ---------------------------------------------------------------------------
// ensureInbox — the idempotency contract
// ---------------------------------------------------------------------------

describe("ensureInbox", () => {
  test("201 means the inbox was created now", async () => {
    const { fetchImpl, requests } = fakeAgentMail({
      "POST /v0/inboxes": { status: 201, body: wireInbox() },
    });

    const result = await ensureInbox(
      AUTH,
      { clientId: inboxClientId("secretary") },
      { fetchImpl, apiBase: API_BASE },
    );

    expect(result.created).toBe(true);
    expect(result.inbox).toEqual({
      inboxId: "secretary@agentmail.to",
      email: "secretary@agentmail.to",
      displayName: "Secretary Bot",
      clientId: "crewhaus:secretary",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.path).toBe("/v0/inboxes");
    expect(requests[0]?.authorization).toBe(BEARER);
    expect(requests[0]?.contentType).toBe("application/json");
  });

  test("200 means an idempotent replay — created is false, the inbox is the same", async () => {
    // Same request, same client_id, second run. The body AgentMail returns is
    // the ORIGINAL create's data; only the status distinguishes the two, which
    // is why `created` may never be inferred from the payload.
    const { fetchImpl, requests } = fakeAgentMail({
      "POST /v0/inboxes": { status: 200, body: wireInbox() },
    });

    const result = await ensureInbox(
      AUTH,
      { clientId: inboxClientId("secretary") },
      { fetchImpl, apiBase: API_BASE },
    );

    expect(result.created).toBe(false);
    expect(result.inbox.inboxId).toBe("secretary@agentmail.to");
    expect(result.inbox.clientId).toBe("crewhaus:secretary");
    // One POST, no list-then-create dance: that is what closes the race.
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /v0/inboxes"]);
  });

  test("two runs of the same client_id report created once, then not again", async () => {
    const { fetchImpl, requests } = fakeAgentMail({
      "POST /v0/inboxes": [
        { status: 201, body: wireInbox() },
        { status: 200, body: wireInbox() },
      ],
    });
    const deps = { fetchImpl, apiBase: API_BASE };
    const input = { clientId: inboxClientId("secretary") };

    const first = await ensureInbox(AUTH, input, deps);
    const second = await ensureInbox(AUTH, input, deps);

    expect([first.created, second.created]).toEqual([true, false]);
    expect(first.inbox).toEqual(second.inbox);
    expect(requests.map((r) => sentBody(r)["client_id"])).toEqual([
      "crewhaus-secretary",
      "crewhaus-secretary",
    ]);
  });

  test("any other 2xx is treated as not-created, since only 201 is a create", async () => {
    const { fetchImpl } = fakeAgentMail({
      "POST /v0/inboxes": { status: 202, body: wireInbox() },
    });

    const result = await ensureInbox(
      AUTH,
      { clientId: "crewhaus:secretary" },
      { fetchImpl, apiBase: API_BASE },
    );

    expect(result.created).toBe(false);
  });

  test("sends client_id alone when nothing optional was supplied", async () => {
    const { fetchImpl, requests } = fakeAgentMail({
      "POST /v0/inboxes": { status: 201, body: wireInbox() },
    });

    await ensureInbox(AUTH, { clientId: "crewhaus:secretary" }, { fetchImpl, apiBase: API_BASE });

    const body = sentBody(requests[0]);
    // Absent KEYS, not keys holding undefined: `{"username": undefined}` would
    // serialise the key away here, but an explicit null/undefined value in the
    // object is a different wire payload the moment anything else builds it.
    expect(Object.keys(body)).toEqual(["client_id"]);
    expect("username" in body).toBe(false);
    expect("domain" in body).toBe(false);
    expect("display_name" in body).toBe(false);
    expect(body["client_id"]).toBe("crewhaus:secretary");
  });

  test("forwards username, domain and display_name under their wire names", async () => {
    const { fetchImpl, requests } = fakeAgentMail({
      "POST /v0/inboxes": {
        status: 201,
        body: wireInbox({ inbox_id: "ops@crew.example", email: "ops@crew.example" }),
      },
    });

    await ensureInbox(
      AUTH,
      {
        clientId: "crewhaus:ops",
        username: "ops",
        domain: "crew.example",
        displayName: "Crew Ops",
      },
      { fetchImpl, apiBase: API_BASE },
    );

    expect(sentBody(requests[0])).toEqual({
      client_id: "crewhaus:ops",
      username: "ops",
      domain: "crew.example",
      display_name: "Crew Ops",
    });
  });

  test("omits only the fields that were not given", async () => {
    const { fetchImpl, requests } = fakeAgentMail({
      "POST /v0/inboxes": { status: 201, body: wireInbox() },
    });

    await ensureInbox(
      AUTH,
      { clientId: "crewhaus:ops", domain: "crew.example" },
      { fetchImpl, apiBase: API_BASE },
    );

    expect(Object.keys(sentBody(requests[0])).sort()).toEqual(["client_id", "domain"]);
  });

  test("sends an explicitly empty username rather than dropping it", async () => {
    // `undefined` is the only "not supplied" signal the input type has, so an
    // empty string is a caller's deliberate value and must reach the wire.
    const { fetchImpl, requests } = fakeAgentMail({
      "POST /v0/inboxes": { status: 201, body: wireInbox() },
    });

    await ensureInbox(
      AUTH,
      { clientId: "crewhaus:ops", username: "" },
      { fetchImpl, apiBase: API_BASE },
    );

    expect(sentBody(requests[0])).toEqual({ client_id: "crewhaus:ops", username: "" });
  });

  test("throws rather than returning a target with no id", async () => {
    // A sender identity without `inbox_id` cannot be posted to; failing here
    // beats failing at the first send, long after setup reported success.
    const { fetchImpl } = fakeAgentMail({
      "POST /v0/inboxes": {
        status: 201,
        body: { pod_id: "pod_1", email: "secretary@agentmail.to" },
      },
    });

    const err = await failure(() =>
      ensureInbox(AUTH, { clientId: "crewhaus:secretary" }, { fetchImpl, apiBase: API_BASE }),
    );

    expect(err.service).toBe("agentmail");
    expect(err.message).toBe("AgentMail returned an inbox with no id");
    expect(err.options.status).toBe(201);
    expect(err.options.fix).toContain("Retry");
    expect(err.options.fix).toContain("this client needs updating");
    // A shape change is a config-class failure, not auth or rate limiting.
    expect(err.failureClass).toBe("config");
  });

  test("throws on an empty-string inbox_id, which is no id at all", async () => {
    const { fetchImpl } = fakeAgentMail({
      "POST /v0/inboxes": { status: 201, body: wireInbox({ inbox_id: "" }) },
    });

    const err = await failure(() =>
      ensureInbox(AUTH, { clientId: "crewhaus:secretary" }, { fetchImpl, apiBase: API_BASE }),
    );

    expect(err.message).toBe("AgentMail returned an inbox with no id");
  });

  test("falls back to the id as the address when email is missing or empty", async () => {
    const { fetchImpl } = fakeAgentMail({
      "POST /v0/inboxes": [
        { status: 201, body: { inbox_id: "secretary@agentmail.to" } },
        { status: 200, body: wireInbox({ email: "" }) },
      ],
    });
    const deps = { fetchImpl, apiBase: API_BASE };

    const missing = await ensureInbox(AUTH, { clientId: "crewhaus:secretary" }, deps);
    const empty = await ensureInbox(AUTH, { clientId: "crewhaus:secretary" }, deps);

    expect(missing.inbox.email).toBe("secretary@agentmail.to");
    expect(missing.inbox.inboxId).toBe("secretary@agentmail.to");
    // The optional fields stay undefined rather than becoming "".
    expect(missing.inbox.displayName).toBeUndefined();
    expect(missing.inbox.clientId).toBeUndefined();
    expect(missing.inbox.createdAt).toBeUndefined();
    expect(empty.inbox.email).toBe("secretary@agentmail.to");
  });

  test("keeps the address and the id as separate fields when they differ", async () => {
    const { fetchImpl } = fakeAgentMail({
      "POST /v0/inboxes": {
        status: 201,
        body: wireInbox({ inbox_id: "inbox_abc123", email: "secretary@agentmail.to" }),
      },
    });

    const result = await ensureInbox(
      AUTH,
      { clientId: "crewhaus:secretary" },
      { fetchImpl, apiBase: API_BASE },
    );

    // Writing the address into the id would fail only at the first send.
    expect(result.inbox.inboxId).toBe("inbox_abc123");
    expect(result.inbox.email).toBe("secretary@agentmail.to");
  });

  test("uses the documented base and path when no apiBase is injected", async () => {
    const { fetchImpl, requests } = fakeAgentMail({
      "POST /v0/inboxes": { status: 201, body: wireInbox() },
    });

    await ensureInbox(AUTH, { clientId: "crewhaus:secretary" }, { fetchImpl });

    expect(requests[0]?.url).toBe(`${AGENTMAIL_API_BASE}/inboxes`);
  });
});

// ---------------------------------------------------------------------------
// Error passthrough — the provider writes better remediation than we can
// ---------------------------------------------------------------------------

describe("error passthrough", () => {
  test("prefers the provider's fix and appends the docs anchor", async () => {
    const { fetchImpl } = fakeAgentMail({
      "POST /v0/inboxes": {
        status: 403,
        body: {
          name: "ForbiddenError",
          code: "domain_not_verified",
          message: "Domain crew.example is not verified.",
          docs: "https://docs.agentmail.to/errors#domain_not_verified",
          fix: "Verify crew.example under Domains in the console, then retry.",
        },
      },
    });

    const err = await failure(() =>
      ensureInbox(
        AUTH,
        { clientId: "crewhaus:ops", domain: "crew.example" },
        { fetchImpl, apiBase: API_BASE },
      ),
    );

    // Exact, not `toContain`: a fallback that leaked in would still satisfy a
    // containment check, and the whole point is that ours is NOT used here.
    expect(err.options.fix).toBe(
      "Verify crew.example under Domains in the console, then retry. " +
        "See https://docs.agentmail.to/errors#domain_not_verified",
    );
    expect(err.options.fix).not.toContain("Check the key's permissions");
    expect(err.message).toBe(
      "AgentMail inbox could not be created: Domain crew.example is not verified. " +
        "(domain_not_verified)",
    );
    expect(err.options.code).toBe("domain_not_verified");
    expect(err.options.status).toBe(403);
  });

  test("uses the fallback fix when the provider supplies neither fix nor docs", async () => {
    const { fetchImpl } = fakeAgentMail({
      "POST /v0/inboxes": {
        status: 403,
        body: { name: "ForbiddenError", code: "missing_permission", message: "Not permitted." },
      },
    });

    const err = await failure(() =>
      ensureInbox(AUTH, { clientId: "crewhaus:ops" }, { fetchImpl, apiBase: API_BASE }),
    );

    expect(err.options.fix).toBe(
      "Check the key's permissions, and that any --mail-domain is verified on the account.",
    );
    expect(err.options.fix).not.toContain("See ");
  });

  test("appends docs to the fallback when only docs is supplied", async () => {
    const { fetchImpl } = fakeAgentMail({
      "GET /v0/inboxes?limit=1": {
        status: 401,
        body: {
          name: "UnauthorizedError",
          code: "unknown_api_key",
          message: "Unknown API key.",
          docs: "https://docs.agentmail.to/errors#unknown_api_key",
        },
      },
    });

    const err = await failure(() => verifyKey(AUTH, { fetchImpl, apiBase: API_BASE }));

    expect(err.options.fix).toBe(
      `${CONSOLE_FALLBACK_FIX} See https://docs.agentmail.to/errors#unknown_api_key`,
    );
  });

  test("uses the provider's fix alone when it supplies no docs", async () => {
    const { fetchImpl } = fakeAgentMail({
      "GET /v0/inboxes?limit=1": {
        status: 403,
        body: {
          name: "ForbiddenError",
          code: "missing_permission",
          message: "Key lacks inboxes:read.",
          fix: "Grant the key the inboxes:read permission.",
        },
      },
    });

    const err = await failure(() => verifyKey(AUTH, { fetchImpl, apiBase: API_BASE }));

    expect(err.options.fix).toBe("Grant the key the inboxes:read permission.");
  });

  test("degrades cleanly when the error body carries nothing usable", async () => {
    const { fetchImpl } = fakeAgentMail({ "GET /v0/inboxes?limit=1": { status: 500 } });

    const err = await failure(() => verifyKey(AUTH, { fetchImpl, apiBase: API_BASE }));

    // No message and no code, so the context stands alone with no dangling
    // punctuation, and the fallback fix is all the operator gets.
    expect(err.message).toBe("AgentMail key rejected");
    expect(err.options.code).toBeUndefined();
    expect(err.options.status).toBe(500);
    expect(err.options.fix).toContain(AGENTMAIL_CONSOLE_URL);
  });

  test("survives a non-JSON error body, such as a proxy's HTML page", async () => {
    const htmlish = (async () =>
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;

    const err = await failure(() => verifyKey(AUTH, { fetchImpl: htmlish, apiBase: API_BASE }));

    expect(err.message).toBe("AgentMail key rejected");
    expect(err.options.status).toBe(502);
    expect(err.failureClass).toBe("network");
  });

  test("includes the code with no message, and the message with no code", async () => {
    const { fetchImpl } = fakeAgentMail({
      "GET /v0/inboxes?limit=1": [
        { status: 409, body: { code: "resource_taken" } },
        { status: 409, body: { message: "Already taken." } },
      ],
    });
    const deps = { fetchImpl, apiBase: API_BASE };

    const codeOnly = await failure(() => verifyKey(AUTH, deps));
    const messageOnly = await failure(() => verifyKey(AUTH, deps));

    expect(codeOnly.message).toBe("AgentMail key rejected (resource_taken)");
    expect(messageOnly.message).toBe("AgentMail key rejected: Already taken.");
  });
});

// ---------------------------------------------------------------------------
// failureClass mapping — asserted against what types.ts really does
// ---------------------------------------------------------------------------

describe("failureClass mapping", () => {
  test("401 unknown_api_key is auth", async () => {
    const { fetchImpl } = fakeAgentMail({
      "GET /v0/inboxes?limit=1": { status: 401, body: { code: "unknown_api_key" } },
    });

    expect((await failure(() => verifyKey(AUTH, { fetchImpl, apiBase: API_BASE }))).failureClass) //
      .toBe("auth");
  });

  test("403 is auth, NOT config — the status alone decides in types.ts", async () => {
    // `ServiceSetupError.failureClass` puts 403 in the same branch as 401, so
    // `already_exists` and `domain_not_verified` exit as auth (CLI exit 30)
    // even though they are really configuration problems. Pinned deliberately:
    // if the mapping is ever refined, this test should be the thing that says so.
    const { fetchImpl } = fakeAgentMail({
      "POST /v0/inboxes": [
        { status: 403, body: { code: "already_exists", message: "Inbox already exists." } },
        { status: 403, body: { code: "domain_not_verified", message: "Not verified." } },
        { status: 403, body: { code: "missing_permission", message: "Not permitted." } },
      ],
    });
    const deps = { fetchImpl, apiBase: API_BASE };
    const input = { clientId: "crewhaus:ops" };

    for (const expected of ["already_exists", "domain_not_verified", "missing_permission"]) {
      const err = await failure(() => ensureInbox(AUTH, input, deps));
      expect(err.options.code).toBe(expected);
      expect(err.failureClass).toBe("auth");
    }
  });

  test("409 falls through to config", async () => {
    const { fetchImpl } = fakeAgentMail({
      "POST /v0/inboxes": [
        { status: 409, body: { code: "resource_taken", message: "Username taken." } },
        { status: 409, body: { code: "limit_exceeded", message: "Inbox limit reached." } },
      ],
    });
    const deps = { fetchImpl, apiBase: API_BASE };
    const input = { clientId: "crewhaus:ops" };

    const taken = await failure(() => ensureInbox(AUTH, input, deps));
    const limit = await failure(() => ensureInbox(AUTH, input, deps));

    expect(taken.failureClass).toBe("config");
    // `limit_exceeded` does not end in "_quota_exceeded", so it is config, not
    // billing — the billing branch keys on that exact suffix.
    expect(limit.failureClass).toBe("config");
    expect(limit.options.code).toBe("limit_exceeded");
  });

  test("429 rate_limit_exceeded is rate_limit", async () => {
    const { fetchImpl } = fakeAgentMail({
      "GET /v0/inboxes?limit=1": {
        status: 429,
        body: { code: "rate_limit_exceeded", message: "Too many requests." },
      },
    });

    const err = await failure(() => verifyKey(AUTH, { fetchImpl, apiBase: API_BASE }));

    expect(err.failureClass).toBe("rate_limit");
    expect(err.options.status).toBe(429);
  });

  test("a 5xx is network", async () => {
    const { fetchImpl } = fakeAgentMail({ "GET /v0/inboxes": { status: 503, body: {} } });

    const err = await failure(() => listInboxes(AUTH, { fetchImpl, apiBase: API_BASE }));

    expect(err.failureClass).toBe("network");
  });
});

// ---------------------------------------------------------------------------
// listInboxes
// ---------------------------------------------------------------------------

describe("listInboxes", () => {
  test("GETs /inboxes with no query when no options are given", async () => {
    const { fetchImpl, requests } = fakeAgentMail({
      "GET /v0/inboxes": {
        status: 200,
        body: { count: 1, inboxes: [wireInbox()], limit: 10, next_page_token: null },
      },
    });

    const page = await listInboxes(AUTH, { fetchImpl, apiBase: API_BASE });

    expect(requests[0]?.url).toBe(`${API_BASE}/inboxes`);
    expect(requests[0]?.search).toBe("");
    expect(requests[0]?.authorization).toBe(BEARER);
    expect(page.inboxes).toEqual([
      {
        inboxId: "secretary@agentmail.to",
        email: "secretary@agentmail.to",
        displayName: "Secretary Bot",
        clientId: "crewhaus:secretary",
        createdAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
    expect(page.nextPageToken).toBeUndefined();
  });

  test("passes limit and page_token through as query params", async () => {
    const { fetchImpl, requests } = fakeAgentMail({
      "GET /v0/inboxes": { status: 200, body: { inboxes: [] } },
    });

    await listInboxes(
      AUTH,
      { fetchImpl, apiBase: API_BASE },
      { limit: 25, pageToken: "tok abc/1" },
    );

    expect(requests[0]?.search).toBe("?limit=25&page_token=tok+abc%2F1");
    expect(new URL(requests[0]?.url ?? "").searchParams.get("page_token")).toBe("tok abc/1");
  });

  test("sends each option on its own when only one is supplied", async () => {
    const { fetchImpl, requests } = fakeAgentMail({
      "GET /v0/inboxes": { status: 200, body: { inboxes: [] } },
    });
    const deps = { fetchImpl, apiBase: API_BASE };

    await listInboxes(AUTH, deps, { limit: 1 });
    await listInboxes(AUTH, deps, { pageToken: "tok_2" });
    // A zero limit is a value, not an absence.
    await listInboxes(AUTH, deps, { limit: 0 });

    expect(requests.map((r) => r.search)).toEqual(["?limit=1", "?page_token=tok_2", "?limit=0"]);
  });

  test("surfaces next_page_token and drops entries with no inbox_id", async () => {
    const { fetchImpl } = fakeAgentMail({
      "GET /v0/inboxes": {
        status: 200,
        body: {
          count: 4,
          inboxes: [
            wireInbox(),
            { pod_id: "pod_2", email: "orphan@agentmail.to" },
            wireInbox({ inbox_id: "ops@agentmail.to", email: "ops@agentmail.to" }),
            "not-an-object",
          ],
          limit: 10,
          next_page_token: "tok_2",
        },
      },
    });

    const page = await listInboxes(AUTH, { fetchImpl, apiBase: API_BASE });

    expect(page.inboxes.map((i) => i.inboxId)).toEqual([
      "secretary@agentmail.to",
      "ops@agentmail.to",
    ]);
    expect(page.nextPageToken).toBe("tok_2");
  });

  test("returns an empty page when inboxes is absent or not an array", async () => {
    const { fetchImpl } = fakeAgentMail({
      "GET /v0/inboxes": [
        { status: 200, body: { count: 0 } },
        { status: 200, body: { inboxes: { "0": wireInbox() } } },
      ],
    });
    const deps = { fetchImpl, apiBase: API_BASE };

    expect((await listInboxes(AUTH, deps)).inboxes).toEqual([]);
    expect((await listInboxes(AUTH, deps)).inboxes).toEqual([]);
  });

  test("reports a failure with the list context and its own fallback fix", async () => {
    const { fetchImpl } = fakeAgentMail({
      "GET /v0/inboxes": {
        status: 403,
        body: { code: "missing_permission", message: "Key lacks inboxes:read." },
      },
    });

    const err = await failure(() => listInboxes(AUTH, { fetchImpl, apiBase: API_BASE }));

    expect(err.message).toBe(
      "AgentMail inboxes could not be listed: Key lacks inboxes:read. (missing_permission)",
    );
    expect(err.options.fix).toBe("Check the key's permissions.");
  });

  test("defaults to the documented API base", async () => {
    const { fetchImpl, requests } = fakeAgentMail({
      "GET /v0/inboxes": { status: 200, body: { inboxes: [] } },
    });

    await listInboxes(AUTH, { fetchImpl });

    expect(requests[0]?.url).toBe(`${AGENTMAIL_API_BASE}/inboxes`);
  });
});

// ---------------------------------------------------------------------------
// createInboxApiKey
// ---------------------------------------------------------------------------

describe("createInboxApiKey", () => {
  test("posts the name to the inbox's api-keys path and returns the secret", async () => {
    const secret = `am_${"9c8b7a65".repeat(4)}`;
    const { fetchImpl, requests } = fakeAgentMail({
      "POST /v0/inboxes/secretary%40agentmail.to/api-keys": {
        status: 201,
        body: {
          api_key_id: "key_abc",
          api_key: secret,
          prefix: "am_9c8b",
          name: "crewhaus-secretary",
          created_at: "2026-09-01T00:00:00.000Z",
          permissions: ["messages:send"],
        },
      },
    });

    const key = await createInboxApiKey(AUTH, "secretary@agentmail.to", "crewhaus-secretary", {
      fetchImpl,
      apiBase: API_BASE,
    });

    expect(key).toEqual({
      apiKeyId: "key_abc",
      apiKey: secret,
      name: "crewhaus-secretary",
    });
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.authorization).toBe(BEARER);
    expect(sentBody(requests[0])).toEqual({ name: "crewhaus-secretary" });
  });

  test("URL-encodes the inbox id into the path", async () => {
    const { fetchImpl, requests } = fakeAgentMail({
      "POST /v0/inboxes/crew%2Fops%20inbox/api-keys": {
        status: 201,
        body: { api_key_id: "key_1", api_key: "am_secret" },
      },
    });

    await createInboxApiKey(AUTH, "crew/ops inbox", "scoped", {
      fetchImpl,
      apiBase: API_BASE,
    });

    // An unencoded "/" would address a different resource entirely.
    expect(requests[0]?.path).toBe("/v0/inboxes/crew%2Fops%20inbox/api-keys");
    expect(requests[0]?.url).toBe(`${API_BASE}/inboxes/crew%2Fops%20inbox/api-keys`);
  });

  test("mints a fresh key on every call — there is no idempotency key here", async () => {
    const { fetchImpl, requests } = fakeAgentMail({
      "POST /v0/inboxes/secretary%40agentmail.to/api-keys": [
        { status: 201, body: { api_key_id: "key_1", api_key: "am_one" } },
        { status: 201, body: { api_key_id: "key_2", api_key: "am_two" } },
      ],
    });
    const deps = { fetchImpl, apiBase: API_BASE };

    const first = await createInboxApiKey(AUTH, "secretary@agentmail.to", "scoped", deps);
    const second = await createInboxApiKey(AUTH, "secretary@agentmail.to", "scoped", deps);

    // Callers must guard on the env var being unset; the API will not.
    expect(first.apiKeyId).not.toBe(second.apiKeyId);
    expect(requests).toHaveLength(2);
  });

  test("throws when the response carries no api_key", async () => {
    const { fetchImpl } = fakeAgentMail({
      "POST /v0/inboxes/secretary%40agentmail.to/api-keys": {
        status: 201,
        body: { api_key_id: "key_abc", prefix: "am_9c8b", name: "crewhaus-secretary" },
      },
    });

    const err = await failure(() =>
      createInboxApiKey(AUTH, "secretary@agentmail.to", "crewhaus-secretary", {
        fetchImpl,
        apiBase: API_BASE,
      }),
    );

    expect(err.service).toBe("agentmail");
    expect(err.message).toBe("AgentMail returned no key material");
    expect(err.options.status).toBe(201);
    // The secret is unrecoverable, so the only remedy is a fresh key.
    expect(err.options.fix).toContain("returned only at creation");
    expect(err.failureClass).toBe("config");
  });

  test("throws when the response carries no api_key_id", async () => {
    const { fetchImpl } = fakeAgentMail({
      "POST /v0/inboxes/secretary%40agentmail.to/api-keys": {
        status: 201,
        body: { api_key: "am_secret" },
      },
    });

    const err = await failure(() =>
      createInboxApiKey(AUTH, "secretary@agentmail.to", "scoped", {
        fetchImpl,
        apiBase: API_BASE,
      }),
    );

    expect(err.message).toBe("AgentMail returned no key material");
  });

  test("reports an absent name as undefined rather than inventing one", async () => {
    const { fetchImpl } = fakeAgentMail({
      "POST /v0/inboxes/secretary%40agentmail.to/api-keys": {
        status: 201,
        body: { api_key_id: "key_abc", api_key: "am_secret" },
      },
    });

    const key = await createInboxApiKey(AUTH, "secretary@agentmail.to", "scoped", {
      fetchImpl,
      apiBase: API_BASE,
    });

    expect(key.name).toBeUndefined();
  });

  test("names the org-key requirement when the scoped mint is refused", async () => {
    const { fetchImpl } = fakeAgentMail({
      "POST /v0/inboxes/secretary%40agentmail.to/api-keys": {
        status: 403,
        body: { code: "missing_permission", message: "Scoped keys cannot mint keys." },
      },
    });

    const err = await failure(() =>
      createInboxApiKey(AUTH, "secretary@agentmail.to", "scoped", {
        fetchImpl,
        apiBase: API_BASE,
      }),
    );

    expect(err.message).toBe(
      "AgentMail inbox-scoped key could not be created: Scoped keys cannot mint keys. " +
        "(missing_permission)",
    );
    expect(err.options.fix).toContain("org-level key is required");
    expect(err.failureClass).toBe("auth");
  });

  test("defaults to the documented API base", async () => {
    const { fetchImpl, requests } = fakeAgentMail({
      "POST /v0/inboxes/secretary%40agentmail.to/api-keys": {
        status: 201,
        body: { api_key_id: "key_abc", api_key: "am_secret" },
      },
    });

    await createInboxApiKey(AUTH, "secretary@agentmail.to", "scoped", { fetchImpl });

    expect(requests[0]?.url).toBe(
      `${AGENTMAIL_API_BASE}/inboxes/secretary%40agentmail.to/api-keys`,
    );
  });
});
