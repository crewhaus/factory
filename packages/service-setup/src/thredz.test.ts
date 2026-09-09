/**
 * Thredz wiki-space client coverage.
 *
 * Credential-free and network-free: every test drives a hand-rolled
 * `fetchImpl` through `ThredzDeps`, and every test points `apiBase` at a host
 * that does not exist, so a regression that bypasses the injected fetch fails
 * loudly instead of quietly reaching the real API with a fake key.
 *
 * The route table is keyed on `"METHOD /path"` and each entry may be a single
 * reply or a queue of them — the queue is what makes the interesting paths
 * testable, since `ensureSpace` deliberately calls `GET /wiki/spaces` twice
 * with a different answer expected the second time.
 */
import { describe, expect, test } from "bun:test";
import {
  THREDZ_API_BASE,
  createSpace,
  ensureSpace,
  listSpaces,
  slugifySpaceName,
  verifyKey,
} from "./thredz";
import { ServiceSetupError } from "./types";

/** The combining-mark range the Thredz server strips after NFKD. */
// biome-ignore lint/suspicious/noMisleadingCharacterClass: this mirrors the server's own class byte for byte — stripping accents is exactly the intent, and "fixing" it here would stop the differential test from testing anything
const SERVER_COMBINING_MARKS = /[\u0300-\u036f]/g;

const API_BASE = "https://thredz.invalid/api";
// Key shape only (`thredz_` + 48 hex), assembled at runtime so no secret-shaped
// literal ever lands in the repo. It is never sent anywhere real.
const AUTH = { apiKey: `thredz_${"a1b2c3d4".repeat(6)}` } as const;

type FakeReply = { readonly status: number; readonly body?: unknown };
type FakeRoute = FakeReply | readonly FakeReply[];

type Recorded = {
  readonly method: string;
  readonly url: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
};

/**
 * Build a fake Thredz. Replies are consumed in order; the last one in a queue
 * sticks, so a route that should answer the same way forever is written once.
 */
function fakeThredz(routes: Readonly<Record<string, FakeRoute>>) {
  const requests: Recorded[] = [];
  const queues = new Map<string, FakeReply[]>();
  for (const [key, route] of Object.entries(routes)) {
    queues.set(key, "status" in route ? [route] : [...route]);
  }

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const raw = typeof init?.body === "string" ? init.body : undefined;
    requests.push({
      method,
      url,
      path,
      authorization: headers["authorization"],
      body: raw === undefined ? undefined : JSON.parse(raw),
    });

    const key = `${method} ${path}`;
    const queue = queues.get(key);
    const next = queue === undefined ? undefined : queue.length > 1 ? queue.shift() : queue[0];
    if (next === undefined) {
      return new Response(JSON.stringify({ message: `no fake route for ${key}` }), { status: 599 });
    }
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status });
  }) as unknown as typeof fetch;

  return { fetchImpl, requests };
}

/** A wire-shaped space, with the fields this package ignores present anyway. */
function wireSpace(over: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "sp_1",
    accountId: "acct_1",
    slug: "crew-notes",
    name: "Crew Notes",
    description: "",
    type: "shared",
    ownerKeyId: null,
    createdByKeyId: "key_1",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    articleCount: 3,
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

describe("slugifySpaceName", () => {
  test("mirrors the server's normalisation across the awkward inputs", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["Crew Notes", "crew-notes"],
      ["ALREADY-slugged", "already-slugged"],
      ["  Hello,   World!!  ", "hello-world"],
      ["Café Ops", "cafe-ops"],
      ["Ünïcödé Spåce", "unicode-space"],
      ["2026 Q3 — Plan", "2026-q3-plan"],
      ["docs/runbooks", "docs-runbooks"],
      ["___", ""],
      ["日本語", ""],
      ["", ""],
    ];
    for (const [input, expected] of cases) {
      expect(slugifySpaceName(input)).toBe(expected);
    }
  });

  test("keeps the two ordering quirks: trim runs before slashes are mapped", () => {
    // `/` survives the run-collapse, so the trim finds nothing to strip and the
    // slashes only become dashes afterwards.
    expect(slugifySpaceName("/ops/")).toBe("-ops-");
    // Repeated slashes collapse to one before the mapping, so `a//b` is `a-b`.
    expect(slugifySpaceName("a//b")).toBe("a-b");
  });

  test("matches the Thredz server's normaliseSpaceSlug exactly", () => {
    // The server re-slugifies whatever slug it is POSTed and stores the
    // normalised form. Any divergence here makes the list lookup miss on
    // every subsequent run: the create 409s, the re-list misses again, and
    // setup reports "taken by a space this key cannot see" — a false
    // diagnosis of a slug it computed wrong itself. Mirror of
    // `slugify` + `normalizeSpaceSlug` in the Thredz wiki service.
    const server = (value: string): string =>
      value
        .normalize("NFKD")
        .replace(SERVER_COMBINING_MARKS, "")
        .toLowerCase()
        .replace(/[^a-z0-9/]+/g, "-")
        .replace(/\/+/g, "/")
        .replace(/^-+|-+$/g, "")
        .replace(/\/-+|-+\//g, "/")
        .replace(/--+/g, "-")
        .replace(/\//g, "-");

    for (const name of [
      "Crew Ops",
      "Ops / Notes",
      "a//b",
      "/ops/",
      "crew-secretary",
      "Café Notes",
      "  spaced  out  ",
      "A---B",
      "MiXeD CaSe",
      "ops//",
      "日本語",
      "x_y.z",
      "--lead",
      "trail--",
      "a / b",
    ]) {
      expect(slugifySpaceName(name)).toBe(server(name));
    }
  });

  test("is deterministic, and re-slugging a slug with slashes is NOT a no-op", () => {
    const once = slugifySpaceName("Café / Ops!!");
    expect(once).toBe("cafe--ops");
    expect(slugifySpaceName("Café / Ops!!")).toBe(once);
    // Slashes become dashes only AFTER runs are collapsed, so feeding the
    // result back in collapses them a second time. Callers must slugify the
    // NAME once and carry that slug — never re-slugify a slug.
    expect(slugifySpaceName(once)).toBe("cafe-ops");
  });
});

describe("listSpaces", () => {
  test("bearer-authenticates, hits /wiki/spaces, and parses the payload", async () => {
    const { fetchImpl, requests } = fakeThredz({
      "GET /api/wiki/spaces": {
        status: 200,
        body: {
          spaces: [
            wireSpace(),
            wireSpace({ id: "sp_2", slug: "max-notes", type: "individual", ownerKeyId: "key_9" }),
          ],
          usage: { shared: 1, individual: 1 },
          limits: { shared: 5, individual: 10, individualPerKey: 1 },
        },
      },
    });

    const inventory = await listSpaces(AUTH, { fetchImpl, apiBase: API_BASE });

    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.path).toBe("/api/wiki/spaces");
    expect(requests[0]?.authorization).toBe(`Bearer ${AUTH.apiKey}`);
    expect(inventory.spaces).toEqual([
      {
        id: "sp_1",
        slug: "crew-notes",
        name: "Crew Notes",
        type: "shared",
        ownerKeyId: null,
        articleCount: 3,
      },
      {
        id: "sp_2",
        slug: "max-notes",
        name: "Crew Notes",
        type: "individual",
        ownerKeyId: "key_9",
        articleCount: 3,
      },
    ]);
    expect(inventory.usage).toEqual({ shared: 1, individual: 1 });
    expect(inventory.limits).toEqual({ shared: 5, individual: 10, individualPerKey: 1 });
  });

  test("reports absent limits as null, not zero", async () => {
    const { fetchImpl } = fakeThredz({
      "GET /api/wiki/spaces": {
        status: 200,
        body: { spaces: [], usage: {}, limits: { shared: 5 } },
      },
    });

    const inventory = await listSpaces(AUTH, { fetchImpl, apiBase: API_BASE });

    expect(inventory.limits).toEqual({ shared: 5, individual: null, individualPerKey: null });
    expect(inventory.usage).toEqual({ shared: 0, individual: 0 });
    expect(inventory.spaces).toEqual([]);
  });

  test("drops entries with an unknown type rather than widening it", async () => {
    const { fetchImpl } = fakeThredz({
      "GET /api/wiki/spaces": {
        status: 200,
        body: { spaces: [wireSpace({ type: "team" }), wireSpace({ id: "sp_ok" })] },
      },
    });

    const inventory = await listSpaces(AUTH, { fetchImpl, apiBase: API_BASE });

    expect(inventory.spaces.map((s) => s.id)).toEqual(["sp_ok"]);
  });

  test("defaults to the published API base when none is injected", async () => {
    const { fetchImpl, requests } = fakeThredz({
      "GET /api/wiki/spaces": { status: 200, body: { spaces: [] } },
    });

    await listSpaces(AUTH, { fetchImpl });

    expect(requests[0]?.url).toBe(`${THREDZ_API_BASE}/wiki/spaces`);
  });

  test("tolerates a trailing slash on an injected base", async () => {
    const { fetchImpl, requests } = fakeThredz({
      "GET /api/wiki/spaces": { status: 200, body: { spaces: [] } },
    });

    await listSpaces(AUTH, { fetchImpl, apiBase: `${API_BASE}/` });

    expect(requests[0]?.url).toBe(`${API_BASE}/wiki/spaces`);
  });

  test("refuses an empty key before spending a request", async () => {
    const { fetchImpl, requests } = fakeThredz({});

    const err = await failure(() =>
      listSpaces({ apiKey: "   " }, { fetchImpl, apiBase: API_BASE }),
    );

    expect(requests).toHaveLength(0);
    expect(err.options.code).toBe("missing_credential");
    expect(err.options.fix).toContain("THREDZ_API_KEY");
  });
});

describe("verifyKey", () => {
  test("is the same cheap read, and returns the inventory", async () => {
    const { fetchImpl, requests } = fakeThredz({
      "GET /api/wiki/spaces": {
        status: 200,
        body: { spaces: [wireSpace()], usage: { shared: 1, individual: 0 }, limits: {} },
      },
    });

    const inventory = await verifyKey(AUTH, { fetchImpl, apiBase: API_BASE });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    expect(inventory.spaces[0]?.slug).toBe("crew-notes");
  });
});

describe("createSpace", () => {
  test("posts only the fields it was given", async () => {
    const { fetchImpl, requests } = fakeThredz({
      "POST /api/wiki/spaces": { status: 201, body: wireSpace() },
    });

    await createSpace(AUTH, { name: "Crew Notes" }, { fetchImpl, apiBase: API_BASE });

    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.path).toBe("/api/wiki/spaces");
    expect(requests[0]?.body).toEqual({ name: "Crew Notes" });
  });

  test("forwards slug, type and description when supplied", async () => {
    const { fetchImpl, requests } = fakeThredz({
      "POST /api/wiki/spaces": {
        status: 201,
        body: wireSpace({ id: "sp_7", slug: "max-notes", type: "individual", ownerKeyId: "key_1" }),
      },
    });

    const space = await createSpace(
      AUTH,
      { name: "Max Notes", slug: "max-notes", type: "individual", description: "scratch" },
      { fetchImpl, apiBase: API_BASE },
    );

    expect(requests[0]?.body).toEqual({
      name: "Max Notes",
      slug: "max-notes",
      type: "individual",
      description: "scratch",
    });
    expect(space).toEqual({
      id: "sp_7",
      slug: "max-notes",
      name: "Crew Notes",
      type: "individual",
      ownerKeyId: "key_1",
      articleCount: 3,
    });
  });

  test("accepts a { space } envelope as well as a bare space", async () => {
    const { fetchImpl } = fakeThredz({
      "POST /api/wiki/spaces": { status: 201, body: { space: wireSpace({ id: "sp_env" }) } },
    });

    const space = await createSpace(AUTH, { name: "Crew Notes" }, { fetchImpl, apiBase: API_BASE });

    expect(space.id).toBe("sp_env");
  });

  test("names the one-individual-space-per-key rule on individual_space_exists", async () => {
    const { fetchImpl } = fakeThredz({
      "POST /api/wiki/spaces": {
        status: 409,
        body: {
          message: "This API key already has its individual wiki space.",
          code: "individual_space_exists",
        },
      },
    });

    const err = await failure(() =>
      createSpace(
        AUTH,
        { name: "Max Notes", type: "individual" },
        { fetchImpl, apiBase: API_BASE },
      ),
    );

    expect(err.options.code).toBe("individual_space_exists");
    expect(err.options.status).toBe(409);
    expect(err.message).toContain("exactly one");
    // Both remedies, because neither is available to every operator.
    expect(err.options.fix).toContain("separate Thredz key");
    expect(err.options.fix).toContain("thredz.space");
    expect(err.failureClass).toBe("config");
  });

  test("keeps the slug conflict distinct from the per-key rule", async () => {
    const { fetchImpl } = fakeThredz({
      "POST /api/wiki/spaces": {
        status: 409,
        body: {
          message: "Wiki space slug already exists in this account",
          code: "space_slug_conflict",
        },
      },
    });

    const err = await failure(() =>
      createSpace(AUTH, { name: "Crew Notes" }, { fetchImpl, apiBase: API_BASE }),
    );

    expect(err.options.code).toBe("space_slug_conflict");
    expect(err.message).toContain('"crew-notes"');
    expect(err.options.fix).toContain("ensureSpace");
  });
});

describe("failure classification", () => {
  test("402 upgrade_required is billing and names the plans", async () => {
    const { fetchImpl } = fakeThredz({
      "GET /api/wiki/spaces": {
        status: 402,
        body: { message: "Your plan does not include wiki spaces.", code: "upgrade_required" },
      },
    });

    const err = await failure(() => listSpaces(AUTH, { fetchImpl, apiBase: API_BASE }));

    expect(err.failureClass).toBe("billing");
    expect(err.options.status).toBe(402);
    expect(err.options.fix).toContain("Pro");
    expect(err.options.fix).toContain("Scale");
  });

  test("402 space_quota_exceeded is billing and points at the cap", async () => {
    const { fetchImpl } = fakeThredz({
      "POST /api/wiki/spaces": {
        status: 402,
        body: {
          message: "Shared wiki space limit reached for your plan.",
          code: "space_quota_exceeded",
        },
      },
    });

    const err = await failure(() =>
      createSpace(AUTH, { name: "Crew Notes" }, { fetchImpl, apiBase: API_BASE }),
    );

    expect(err.failureClass).toBe("billing");
    expect(err.message).toContain("Shared wiki space limit reached");
    expect(err.options.fix).toContain("cap");
  });

  test("401 is auth and points at the key", async () => {
    const { fetchImpl } = fakeThredz({
      "GET /api/wiki/spaces": { status: 401, body: { message: "Invalid API key" } },
    });

    const err = await failure(() => listSpaces(AUTH, { fetchImpl, apiBase: API_BASE }));

    expect(err.failureClass).toBe("auth");
    expect(err.options.fix).toContain("THREDZ_API_KEY");
  });

  test("403 is auth and points at the missing wiki grant", async () => {
    const { fetchImpl } = fakeThredz({
      "GET /api/wiki/spaces": { status: 403, body: { message: "Key lacks wiki access" } },
    });

    const err = await failure(() => verifyKey(AUTH, { fetchImpl, apiBase: API_BASE }));

    expect(err.failureClass).toBe("auth");
    expect(err.options.fix).toContain("wiki read-write");
  });

  test("a 5xx classifies as network and says nothing was written", async () => {
    const { fetchImpl } = fakeThredz({ "GET /api/wiki/spaces": { status: 503 } });

    const err = await failure(() => listSpaces(AUTH, { fetchImpl, apiBase: API_BASE }));

    expect(err.failureClass).toBe("network");
    expect(err.options.fix).toContain("nothing was written");
  });
});

describe("ensureSpace", () => {
  test("adopts a visible space without writing", async () => {
    const { fetchImpl, requests } = fakeThredz({
      "GET /api/wiki/spaces": { status: 200, body: { spaces: [wireSpace()] } },
    });

    const result = await ensureSpace(
      AUTH,
      { name: "Crew Notes" },
      { fetchImpl, apiBase: API_BASE },
    );

    expect(result.created).toBe(false);
    expect(result.space.id).toBe("sp_1");
    expect(requests.map((r) => r.method)).toEqual(["GET"]);
  });

  test("creates when the slug is absent, sending the resolved slug and type", async () => {
    const { fetchImpl, requests } = fakeThredz({
      "GET /api/wiki/spaces": { status: 200, body: { spaces: [] } },
      "POST /api/wiki/spaces": { status: 201, body: wireSpace() },
    });

    const result = await ensureSpace(
      AUTH,
      { name: "Crew Notes", description: "shared scratchpad" },
      { fetchImpl, apiBase: API_BASE },
    );

    expect(result.created).toBe(true);
    expect(requests[1]?.body).toEqual({
      name: "Crew Notes",
      slug: "crew-notes",
      type: "shared",
      description: "shared scratchpad",
    });
  });

  test("refuses to adopt a shared space when an individual one was asked for", async () => {
    const { fetchImpl, requests } = fakeThredz({
      "GET /api/wiki/spaces": { status: 200, body: { spaces: [wireSpace()] } },
    });

    const err = await failure(() =>
      ensureSpace(
        AUTH,
        { name: "Crew Notes", type: "individual" },
        { fetchImpl, apiBase: API_BASE },
      ),
    );

    expect(err.options.code).toBe("space_type_mismatch");
    expect(err.message).toContain("already exists as shared");
    expect(err.options.fix).toContain("every wiki-enabled key");
    // The point of the throw: no write happened, so nothing was downgraded.
    expect(requests.map((r) => r.method)).toEqual(["GET"]);
  });

  test("refuses to adopt an individual space when a shared one was asked for", async () => {
    const { fetchImpl } = fakeThredz({
      "GET /api/wiki/spaces": {
        status: 200,
        body: { spaces: [wireSpace({ type: "individual", ownerKeyId: "key_1" })] },
      },
    });

    const err = await failure(() =>
      ensureSpace(AUTH, { name: "Crew Notes" }, { fetchImpl, apiBase: API_BASE }),
    );

    expect(err.options.code).toBe("space_type_mismatch");
    expect(err.message).toContain("already exists as individual");
  });

  test("re-lists and adopts after a slug conflict the first list could not see", async () => {
    const { fetchImpl, requests } = fakeThredz({
      "GET /api/wiki/spaces": [
        { status: 200, body: { spaces: [] } },
        { status: 200, body: { spaces: [wireSpace({ id: "sp_race" })] } },
      ],
      "POST /api/wiki/spaces": {
        status: 409,
        body: {
          message: "Wiki space slug already exists in this account",
          code: "space_slug_conflict",
        },
      },
    });

    const result = await ensureSpace(
      AUTH,
      { name: "Crew Notes" },
      { fetchImpl, apiBase: API_BASE },
    );

    expect(result).toEqual({
      space: {
        id: "sp_race",
        slug: "crew-notes",
        name: "Crew Notes",
        type: "shared",
        ownerKeyId: null,
        articleCount: 3,
      },
      created: false,
    });
    expect(requests.map((r) => r.method)).toEqual(["GET", "POST", "GET"]);
  });

  test("rethrows when the re-list still cannot see the conflicting slug", async () => {
    const { fetchImpl, requests } = fakeThredz({
      "GET /api/wiki/spaces": { status: 200, body: { spaces: [] } },
      "POST /api/wiki/spaces": {
        status: 409,
        body: {
          message: "Wiki space slug already exists in this account",
          code: "space_slug_conflict",
        },
      },
    });

    const err = await failure(() =>
      ensureSpace(AUTH, { name: "Crew Notes" }, { fetchImpl, apiBase: API_BASE }),
    );

    expect(requests.map((r) => r.method)).toEqual(["GET", "POST", "GET"]);
    expect(err.options.code).toBe("space_slug_conflict");
    expect(err.message).toContain("cannot see");
    expect(err.options.fix).toContain("invisible to other keys");
  });

  test("does not retry individual_space_exists — it is a hard limit, not a race", async () => {
    const { fetchImpl, requests } = fakeThredz({
      "GET /api/wiki/spaces": { status: 200, body: { spaces: [] } },
      "POST /api/wiki/spaces": {
        status: 409,
        body: {
          message: "This API key already has its individual wiki space.",
          code: "individual_space_exists",
        },
      },
    });

    const err = await failure(() =>
      ensureSpace(
        AUTH,
        { name: "Max Notes", type: "individual" },
        { fetchImpl, apiBase: API_BASE },
      ),
    );

    expect(err.options.code).toBe("individual_space_exists");
    expect(err.options.fix).toContain("individual space per key");
    expect(requests.map((r) => r.method)).toEqual(["GET", "POST"]);
  });

  test("honours an explicit slug over the derived one", async () => {
    const { fetchImpl } = fakeThredz({
      "GET /api/wiki/spaces": { status: 200, body: { spaces: [wireSpace({ slug: "notes" })] } },
    });

    const result = await ensureSpace(
      AUTH,
      { name: "Crew Notes", slug: "notes" },
      { fetchImpl, apiBase: API_BASE },
    );

    expect(result.created).toBe(false);
    expect(result.space.slug).toBe("notes");
  });

  test("refuses a name that normalises to nothing, before any request", async () => {
    const { fetchImpl, requests } = fakeThredz({});

    const err = await failure(() =>
      ensureSpace(AUTH, { name: "日本語" }, { fetchImpl, apiBase: API_BASE }),
    );

    expect(requests).toHaveLength(0);
    expect(err.options.code).toBe("invalid_slug");
    expect(err.options.fix).toContain("explicit `slug`");
  });

  test("propagates a non-conflict failure untouched", async () => {
    const { fetchImpl } = fakeThredz({
      "GET /api/wiki/spaces": { status: 200, body: { spaces: [] } },
      "POST /api/wiki/spaces": { status: 500, body: { message: "boom" } },
    });

    const err = await failure(() =>
      ensureSpace(AUTH, { name: "Crew Notes" }, { fetchImpl, apiBase: API_BASE }),
    );

    expect(err.options.status).toBe(500);
    expect(err.failureClass).toBe("network");
  });
});
