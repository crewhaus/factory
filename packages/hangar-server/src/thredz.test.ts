/**
 * The Thredz explorer proxy.
 *
 * NOTHING HERE TOUCHES THE NETWORK. Every test drives the real routes against
 * a tiny in-process stub of the Thredz REST API on loopback, pointed at by a
 * fixture harness's `thredz.base_url`. That is what makes the failure cases —
 * a 402 plan cap, a 409 stale version, a card-grammar 400, an unreachable
 * workspace — testable at all, and it is why the stub records every request:
 * the key-custody assertions are about what LEFT the process, not just what
 * came back.
 *
 * The stub's key value is assembled from parts. A realistic-shaped literal in
 * a fixture is blocked by the repo's push protection, and rightly.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFixtureHarness } from "./fixture";
import { type TestServer, bootTestServer } from "./testkit";
import { scanThredzBlock } from "./thredz";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");

/** Not a credential: three words joined, nowhere near a real key's shape. */
const TEST_KEY = ["thredz", "fixture", "key"].join("-");

// ---------------------------------------------------------------------------
// the stub workspace
// ---------------------------------------------------------------------------

type StubCall = {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly authorization: string | null;
  readonly apiKeyHeader: string | null;
  readonly idempotencyKey: string | null;
  readonly body: unknown;
};

type StubReply = { readonly status: number; readonly body: unknown };
type StubRoute = (call: StubCall) => StubReply;

type StubWorkspace = {
  readonly base: string;
  readonly calls: StubCall[];
  /** Register/replace one route, keyed `"<METHOD> <path>"`. */
  route(key: string, reply: StubReply | StubRoute): void;
  stop(): Promise<void>;
};

/** A loopback stand-in for the Thredz REST API: it answers only what a test
 *  registers, and 404s anything else the way the real API does. */
function startStubThredz(initial: Record<string, StubReply | StubRoute> = {}): StubWorkspace {
  const routes = new Map<string, StubReply | StubRoute>(Object.entries(initial));
  const calls: StubCall[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    development: false,
    fetch: async (req) => {
      const url = new URL(req.url);
      const path = url.pathname.replace(/^\/api/, "");
      let body: unknown = null;
      if (req.method !== "GET" && req.method !== "DELETE") {
        body = await req.json().catch(() => null);
      }
      const call: StubCall = {
        method: req.method,
        path,
        search: url.search,
        authorization: req.headers.get("authorization"),
        apiKeyHeader: req.headers.get("x-api-key"),
        idempotencyKey: req.headers.get("idempotency-key"),
        body,
      };
      calls.push(call);
      const handler = routes.get(`${req.method} ${path}`);
      if (handler === undefined) {
        return new Response(JSON.stringify({ message: "Not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      const reply = typeof handler === "function" ? handler(call) : handler;
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}/api`,
    calls,
    route: (key, reply) => {
      routes.set(key, reply);
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}

// ---------------------------------------------------------------------------
// scaffolding
// ---------------------------------------------------------------------------

const servers: TestServer[] = [];
const stubs: StubWorkspace[] = [];
const roots: string[] = [];

afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
  while (stubs.length > 0) await (stubs.pop() as StubWorkspace).stop();
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function stub(initial: Record<string, StubReply | StubRoute> = {}): StubWorkspace {
  const workspace = startStubThredz(initial);
  stubs.push(workspace);
  return workspace;
}

function boot(env: Record<string, string | undefined> = {}): TestServer {
  const t = bootTestServer({ now: () => NOW, env });
  servers.push(t);
  return t;
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hangar-thredz-"));
  roots.push(root);
  return root;
}

/** A harness whose spec wires Thredz at `base` and reads the key from its own
 *  `.env` — the sanctioned custody path. */
function wiredHarness(
  base: string | null,
  opts: { key?: string; visibility?: string } = {},
): string {
  const dir = join(tempRoot(), "wired");
  return makeFixtureHarness(dir, {
    specName: "wired",
    specExtra: [
      "thredz:",
      "  api_key: $THREDZ_API_KEY",
      ...(base !== null ? [`  base_url: ${base}`] : []),
      ...(opts.visibility !== undefined ? [`  visibility: ${opts.visibility}`] : []),
      "  goals: true",
    ].join("\n"),
    envLines: opts.key === undefined ? [] : [`THREDZ_API_KEY=${opts.key}`],
  });
}

/** A harness with no `thredz:` block at all — the local-wiki default. */
function localHarness(): string {
  return makeFixtureHarness(join(tempRoot(), "local"), {
    specName: "local-only",
    specExtra: ["memory:", "  wiki: true"].join("\n"),
  });
}

async function register(t: TestServer, dir: string): Promise<string> {
  const { status, body } = await t.api("/api/harnesses", {
    method: "POST",
    body: JSON.stringify({ dir }),
  });
  expect(status).toBe(201);
  return (body["entry"] as { id: string }).id;
}

type Body = Record<string, unknown>;

async function get(t: TestServer, path: string): Promise<Body> {
  const { status, body } = await t.api(path);
  expect(status).toBe(200);
  return body;
}

async function send(t: TestServer, method: string, path: string, body: unknown): Promise<Body> {
  const res = await t.api(path, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  expect(res.status).toBe(200);
  return res.body;
}

// ---------------------------------------------------------------------------
// the spec scan
// ---------------------------------------------------------------------------

describe("the `thredz:` block scan", () => {
  test("all three spellings resolve, and `false` is the explicit opt-out", () => {
    expect(scanThredzBlock("name: x\nthredz: true\n")).toMatchObject({
      declared: true,
      form: "boolean",
      envName: "THREDZ_API_KEY",
      defaultVisibility: "private",
    });
    expect(scanThredzBlock("thredz: $WORKSPACE_KEY\n")).toMatchObject({
      declared: true,
      form: "string",
      envName: "WORKSPACE_KEY",
      inlineKey: false,
    });
    expect(scanThredzBlock("thredz: false\n")).toMatchObject({ declared: false, form: "disabled" });
    expect(scanThredzBlock("name: x\n")).toMatchObject({ declared: false, form: "absent" });
  });

  test("the object form reads its fields, and a spec a version ahead still scans", () => {
    const config = scanThredzBlock(
      [
        "name: x",
        "thredz:",
        "  api_key: $THREDZ_API_KEY",
        "  base_url: https://thredz.example.invalid/api",
        "  visibility: shared",
        "  goals: true",
        "  agents: research-desk",
        "  messaging: true",
        "  someFutureKey: 3",
        "memory:",
        "  recall: true",
        "",
      ].join("\n"),
    );
    expect(config).toMatchObject({
      declared: true,
      form: "object",
      envName: "THREDZ_API_KEY",
      baseUrl: "https://thredz.example.invalid/api",
      defaultVisibility: "shared",
      goalsMirror: true,
      agentHandle: "research-desk",
      messaging: true,
    });
  });

  test("a LITERAL api_key is flagged rather than resolved", () => {
    const config = scanThredzBlock("thredz:\n  api_key: not-a-var-reference\n");
    expect(config.inlineKey).toBe(true);
    expect(config.envName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// key custody
// ---------------------------------------------------------------------------

describe("key custody", () => {
  test("a harness with no `thredz:` block is an honest empty state, and nothing is proxied", async () => {
    const workspace = stub();
    const t = boot();
    const id = await register(t, localHarness());
    const status = await get(t, `/api/h/${id}/thredz`);
    expect(status["present"]).toBe(false);
    expect(status["keyPresent"]).toBe(false);
    expect(status["backend"]).toBe("local");
    expect(String(status["note"])).toContain("local store");
    const wiki = await get(t, `/api/h/${id}/thredz/wiki`);
    expect(wiki["articles"]).toEqual([]);
    expect(wiki["unconfigured"]).toBe(true);
    expect(workspace.calls).toEqual([]);
  });

  test("an ambient key in the MANAGER's environment never activates a local-wiki harness", async () => {
    // The spec is the gate. Were it not, a manager-level THREDZ_API_KEY would
    // silently point every local harness at someone's hosted workspace.
    const workspace = stub();
    const t = boot({ THREDZ_API_KEY: TEST_KEY, CREWHAUS_THREDZ_BASE: workspace.base });
    const id = await register(t, localHarness());
    const status = await get(t, `/api/h/${id}/thredz`);
    expect(status["keyPresent"]).toBe(false);
    expect(workspace.calls).toEqual([]);
  });

  test("a declared block with an unset variable names the VARIABLE, never a value", async () => {
    const t = boot();
    const id = await register(t, wiredHarness(null));
    const status = await get(t, `/api/h/${id}/thredz`);
    expect(status["keyPresent"]).toBe(false);
    expect(String(status["note"])).toContain("THREDZ_API_KEY");
    expect(status["backend"]).toBe("thredz");
  });

  test("a LITERAL key in a committed spec is refused, not used", async () => {
    const workspace = stub();
    const dir = makeFixtureHarness(join(tempRoot(), "literal"), {
      specName: "literal",
      specExtra: [
        "thredz:",
        "  api_key: literal-value-in-spec",
        `  base_url: ${workspace.base}`,
      ].join("\n"),
    });
    const t = boot();
    const id = await register(t, dir);
    const status = await get(t, `/api/h/${id}/thredz`);
    expect(status["keyPresent"]).toBe(false);
    expect(status["keySource"]).toBe("spec-literal");
    expect(String(status["note"])).toContain("`$VAR` reference");
    expect(workspace.calls).toEqual([]);
  });

  test("the key rides a header, never a URL — and never comes back", async () => {
    const workspace = stub({
      "GET /wiki/articles": { status: 200, body: { articles: [{ slug: "a", title: "A" }] } },
    });
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));
    const wiki = await get(t, `/api/h/${id}/thredz/wiki`);
    expect(wiki["ok"]).toBe(true);
    const call = workspace.calls[0] as StubCall;
    expect(call.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(call.apiKeyHeader).toBe(TEST_KEY);
    expect(call.search).not.toContain(TEST_KEY);
    expect(JSON.stringify(wiki)).not.toContain(TEST_KEY);
    expect(wiki["keyPresent"]).toBe(true);
    expect(wiki["keySource"]).toBe("harness-env");
  });

  test("a base_url carrying userinfo is called as written but never echoed with it", async () => {
    // A self-hosted workspace behind basic auth is exactly the spec that
    // writes a credential into the URL, where key-name redaction cannot see
    // it. The displayed workspace drops the userinfo.
    const workspace = stub({ "GET /wiki/articles": { status: 200, body: { articles: [] } } });
    const secret = ["basic", "auth", "value"].join("-");
    const withUserinfo = workspace.base.replace("http://", `http://admin:${secret}@`);
    const t = boot();
    const id = await register(t, wiredHarness(withUserinfo, { key: TEST_KEY }));
    const wiki = await get(t, `/api/h/${id}/thredz/wiki`);
    expect(wiki["ok"]).toBe(true);
    expect(JSON.stringify(wiki)).not.toContain(secret);
    expect(String(wiki["workspace"])).not.toContain("admin");
  });

  test("browsing every read route repeatedly issues no upstream write", async () => {
    // Reads never mutate — here that means the proxy never turns a GET into
    // a POST/PUT/PATCH/DELETE, however the workspace answers.
    const workspace = stub();
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));
    const reads = [
      "",
      "/wiki",
      "/wiki/how-to-deploy",
      "/wiki/how-to-deploy/versions",
      "/records",
      "/records/rec_1",
      "/schemas",
      "/goals",
      "/tasks",
      "/views",
      "/dashboards",
      "/dashboards/dash_1",
      "/listeners",
      "/webhooks",
      "/connectors",
      "/activity",
      "/keys",
    ];
    for (let pass = 0; pass < 2; pass += 1) {
      for (const path of reads) await get(t, `/api/h/${id}/thredz${path}`);
    }
    // Every route answered 200 with an honest refusal (the stub 404s), and
    // the only method that ever left the process was GET — except the
    // semantic-search POST, which this loop does not ask for.
    expect([...new Set(workspace.calls.map((c) => c.method))]).toEqual(["GET"]);
  });

  test("a client cannot smuggle its own credential into the upstream query", async () => {
    // The upstream API also accepts `?apiKey=`; forwarding query params
    // verbatim would let the browser choose the identity this proxy uses.
    const workspace = stub({ "GET /wiki/articles": { status: 200, body: { articles: [] } } });
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));
    await get(t, `/api/h/${id}/thredz/wiki?apiKey=someone-elses&q=deploy`);
    const call = workspace.calls[0] as StubCall;
    expect(call.search).toContain("q=deploy");
    expect(call.search).not.toContain("apiKey");
    expect(call.authorization).toBe(`Bearer ${TEST_KEY}`);
  });
});

// ---------------------------------------------------------------------------
// degradation
// ---------------------------------------------------------------------------

describe("degradation", () => {
  test("an unreachable workspace is an honest state with the upstream status, not a broken screen", async () => {
    // A base URL on a port nothing is listening on: the connection is refused
    // immediately, so this needs no timeout budget of its own.
    const t = boot();
    const dir = makeFixtureHarness(join(tempRoot(), "down"), {
      specName: "down",
      specExtra: [
        "thredz:",
        "  api_key: $THREDZ_API_KEY",
        "  base_url: http://127.0.0.1:1/api",
      ].join("\n"),
      envLines: [`THREDZ_API_KEY=${TEST_KEY}`],
    });
    const id = await register(t, dir);
    const wiki = await get(t, `/api/h/${id}/thredz/wiki`);
    expect(wiki["ok"]).toBe(false);
    expect(wiki["present"]).toBe(false);
    expect(wiki["articles"]).toEqual([]);
    const upstream = wiki["upstream"] as Record<string, unknown>;
    expect(upstream["status"]).toBe(0);
    expect(upstream["failureClass"]).toBe("unreachable");
    expect(String(upstream["remediation"])).toContain("showing nothing, not zero");
  });

  test("a plan cap is a fact: the quota class carries the upstream message verbatim", async () => {
    const message = "Thredz plan limit reached — the free plan allows 3 goals";
    const workspace = stub({
      "GET /goals": { status: 402, body: { message, code: "quota_exceeded" } },
    });
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));
    const goals = await get(t, `/api/h/${id}/thredz/goals`);
    expect(goals["ok"]).toBe(false);
    expect(goals["goals"]).toEqual([]);
    const upstream = goals["upstream"] as Record<string, unknown>;
    expect(upstream["failureClass"]).toBe("quota");
    expect(upstream["status"]).toBe(402);
    expect(goals["note"]).toBe(message);
  });

  test("a partial outage degrades ONE panel: the article renders when comments fail", async () => {
    const workspace = stub({
      "GET /wiki/articles/how-to-deploy": {
        status: 200,
        body: { slug: "how-to-deploy", title: "Deploy", version: 4, backlinks: [{ slug: "ops" }] },
      },
      "GET /wiki/articles/how-to-deploy/comments": {
        status: 500,
        body: { message: "Server error" },
      },
      "GET /wiki/articles/how-to-deploy/related": { status: 200, body: [] },
    });
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));
    const article = await get(t, `/api/h/${id}/thredz/wiki/how-to-deploy`);
    expect(article["ok"]).toBe(true);
    expect(article["version"]).toBe(4);
    expect(article["comments"]).toEqual([]);
    expect(article["commentsError"]).toBe("Server error");
  });

  test("the status probes report the tier a key actually carries", async () => {
    const workspace = stub({
      "GET /wiki/stats": { status: 200, body: { articles: 12 } },
      "GET /keys": { status: 403, body: { message: "Admin permission required" } },
      "GET /listeners/usage": { status: 200, body: { used: 1, limit: 3, locked: false } },
    });
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));
    const status = await get(t, `/api/h/${id}/thredz`);
    expect(status["reachable"]).toBe(true);
    expect(status["tier"]).toBe("wiki");
    expect(status["listenerQuota"]).toMatchObject({ limit: 3 });
    expect(status["ok"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// the wiki write contract
// ---------------------------------------------------------------------------

describe("wiki writes", () => {
  test("a CREATE always carries an explicit visibility, defaulting to private", async () => {
    const workspace = stub({
      "GET /wiki/articles/new-note": { status: 404, body: { message: "Not found" } },
      "POST /wiki/articles": { status: 201, body: { slug: "new-note", version: 1 } },
    });
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));
    const wrote = await send(t, "PUT", `/api/h/${id}/thredz/wiki/new-note`, {
      body: "# New\n",
      expectedVersion: 1,
    });
    expect(wrote["wrote"]).toBe(true);
    expect(wrote["created"]).toBe(true);
    expect(wrote["visibility"]).toBe("private");
    const post = workspace.calls.find((c) => c.method === "POST") as StubCall;
    expect((post.body as Record<string, unknown>)["visibility"]).toBe("private");
  });

  test("a spec that opts into `shared` gets shared — the default is a default, not a cage", async () => {
    const workspace = stub({
      "GET /wiki/articles/new-note": { status: 404, body: { message: "Not found" } },
      "POST /wiki/articles": { status: 201, body: { slug: "new-note", version: 1 } },
    });
    const t = boot();
    const id = await register(
      t,
      wiredHarness(workspace.base, { key: TEST_KEY, visibility: "shared" }),
    );
    const wrote = await send(t, "PUT", `/api/h/${id}/thredz/wiki/new-note`, { body: "# New\n" });
    expect(wrote["visibility"]).toBe("shared");
  });

  test("an UPDATE carries the expected version and does NOT flip visibility", async () => {
    const workspace = stub({
      "GET /wiki/articles/how-to-deploy": {
        status: 200,
        body: { slug: "how-to-deploy", version: 7 },
      },
      "PATCH /wiki/articles/how-to-deploy": {
        status: 200,
        body: { slug: "how-to-deploy", version: 8 },
      },
    });
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));
    const wrote = await send(t, "PUT", `/api/h/${id}/thredz/wiki/how-to-deploy`, {
      body: "# Deploy\n",
      expectedVersion: 7,
    });
    expect(wrote["wrote"]).toBe(true);
    expect(wrote["created"]).toBe(false);
    const patch = workspace.calls.find((c) => c.method === "PATCH") as StubCall;
    const sent = patch.body as Record<string, unknown>;
    expect(sent["version"]).toBe(7);
    expect(sent["visibility"]).toBeUndefined();
  });

  test("a stale version refuses BEFORE writing and hands back the version that moved", async () => {
    const workspace = stub({
      "GET /wiki/articles/how-to-deploy": {
        status: 200,
        body: { slug: "how-to-deploy", version: 9 },
      },
      "PATCH /wiki/articles/how-to-deploy": { status: 200, body: { version: 10 } },
    });
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));
    const wrote = await send(t, "PUT", `/api/h/${id}/thredz/wiki/how-to-deploy`, {
      body: "# Deploy\n",
      expectedVersion: 7,
    });
    expect(wrote["stale"]).toBe(true);
    expect(wrote["wrote"]).toBe(false);
    expect(wrote["currentVersion"]).toBe(9);
    expect(workspace.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  test("an upstream stale_article_version conflict is surfaced as the same state", async () => {
    const workspace = stub({
      "GET /wiki/articles/how-to-deploy": {
        status: 200,
        body: { slug: "how-to-deploy", version: 7 },
      },
      "PATCH /wiki/articles/how-to-deploy": {
        status: 409,
        body: { error: "Article version is stale", code: "stale_article_version" },
      },
    });
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));
    const wrote = await send(t, "PUT", `/api/h/${id}/thredz/wiki/how-to-deploy`, {
      body: "# Deploy\n",
      expectedVersion: 7,
    });
    expect(wrote["stale"]).toBe(true);
    expect(wrote["note"]).toBe("Article version is stale");
    expect((wrote["upstream"] as Record<string, unknown>)["failureClass"]).toBe("conflict");
  });

  test("a rollback needs a confirmation, then rolls forward to a NEW version", async () => {
    const workspace = stub({
      "POST /wiki/articles/how-to-deploy/rollback": { status: 200, body: { version: 11 } },
    });
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));
    const unconfirmed = await send(t, "POST", `/api/h/${id}/thredz/wiki/how-to-deploy/rollback`, {
      version: 3,
    });
    expect(unconfirmed["needsConfirm"]).toBe(true);
    expect(workspace.calls).toEqual([]);
    const done = await send(t, "POST", `/api/h/${id}/thredz/wiki/how-to-deploy/rollback`, {
      version: 3,
      confirm: true,
    });
    expect(done["rolledBack"]).toBe(true);
    expect((workspace.calls[0] as StubCall).body).toEqual({ toVersion: 3 });
  });

  test("a credential pasted into an article BODY is masked on the way out", async () => {
    // Key-name redaction cannot see into prose; free text is masked too.
    const leaked = `token=${"A1b2C3d4".repeat(5)}`;
    const workspace = stub({
      "GET /wiki/articles/leaky": { status: 200, body: { slug: "leaky", body: `see ${leaked}` } },
      "GET /wiki/articles/leaky/comments": { status: 200, body: [] },
      "GET /wiki/articles/leaky/related": { status: 200, body: [] },
    });
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));
    const article = await get(t, `/api/h/${id}/thredz/wiki/leaky`);
    expect(JSON.stringify(article)).not.toContain(leaked);
    expect(String((article["article"] as Record<string, unknown>)["body"])).toContain("***");
  });
});

// ---------------------------------------------------------------------------
// records: soft delete only
// ---------------------------------------------------------------------------

describe("records", () => {
  test("delete is SOFT: the record is parked, its status stashed, and no DELETE is ever issued", async () => {
    let stored: Record<string, unknown> = {
      _id: "rec_1",
      status: "active",
      customFields: { owner: "ops" },
    };
    const workspace = stub({
      "GET /records/rec_1": () => ({ status: 200, body: stored }),
      "PUT /records/rec_1": (call) => {
        stored = { ...stored, ...(call.body as Record<string, unknown>) };
        return { status: 200, body: stored };
      },
    });
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));

    const deleted = await send(t, "DELETE", `/api/h/${id}/thredz/records/rec_1`, undefined);
    expect(deleted["deleted"]).toBe(true);
    expect(stored["status"]).toBe("deleted");
    expect((stored["customFields"] as Record<string, unknown>)["hangarRestoreStatus"]).toBe(
      "active",
    );
    expect(workspace.calls.some((c) => c.method === "DELETE")).toBe(false);

    const restored = await send(t, "POST", `/api/h/${id}/thredz/records/rec_1/restore`, {});
    expect(restored["restored"]).toBe(true);
    expect(restored["status"]).toBe("active");
    expect(stored["status"]).toBe("active");
    const customFields = stored["customFields"] as Record<string, unknown>;
    expect(customFields["hangarRestoreStatus"]).toBeUndefined();
    expect(customFields["owner"]).toBe("ops");
  });

  test("schema validation is surfaced verbatim, details and all", async () => {
    const workspace = stub({
      "POST /records": {
        status: 400,
        body: { message: "Schema validation failed", errors: ["amount must be a number"] },
      },
    });
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));
    const created = await send(t, "POST", `/api/h/${id}/thredz/records`, {
      schema: "invoice",
      title: "May",
      fields: { amount: "twelve" },
    });
    expect(created["created"]).toBe(false);
    expect(created["note"]).toBe("Schema validation failed");
    const upstream = created["upstream"] as Record<string, unknown>;
    expect(upstream["failureClass"]).toBe("validation");
    expect(upstream["details"]).toEqual(["amount must be a number"]);
    // `schema` is the console's word for it; the API's field is `type`.
    expect(((workspace.calls[0] as StubCall).body as Record<string, unknown>)["type"]).toBe(
      "invoice",
    );
  });

  test("the records list filters on ONE tag and says where multi-tag AND lives", async () => {
    const workspace = stub({ "GET /records": { status: 200, body: { records: [] } } });
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));
    const records = await get(t, `/api/h/${id}/thredz/records?tag=ops&tag=urgent`);
    expect(String(records["tagsNote"])).toContain("card grammar");
    const call = workspace.calls[0] as StubCall;
    expect(call.search).toContain("tag=ops");
    expect(call.search).not.toContain("urgent");
  });
});

// ---------------------------------------------------------------------------
// dashboards + the card grammar
// ---------------------------------------------------------------------------

describe("dashboards", () => {
  test("a card refusal is forwarded VERBATIM, because it names the valid keys", async () => {
    const message =
      "cards[0].dataSource.filters has invalid keys for record: tag. Valid keys: type, status, tags, graphId, customFields";
    const workspace = stub({ "POST /dashboards/dash_1/cards": { status: 400, body: { message } } });
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));
    const added = await send(t, "POST", `/api/h/${id}/thredz/dashboards/dash_1/cards`, {
      title: "Open invoices",
      type: "table",
      dataSource: { entityType: "record", filters: { tag: "ops" } },
    });
    expect(added["added"]).toBe(false);
    expect(added["validation"]).toBe(true);
    expect(added["note"]).toBe(message);
    expect((added["upstream"] as Record<string, unknown>)["message"]).toBe(message);
  });

  test("the KPI grammar travels with the payload so the builder can label its own fields", async () => {
    const workspace = stub({ "GET /dashboards": { status: 200, body: { dashboards: [] } } });
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));
    const dashboards = await get(t, `/api/h/${id}/thredz/dashboards`);
    const grammar = dashboards["cardGrammar"] as Record<string, unknown>;
    expect(grammar["kpiRequires"]).toEqual(["display.aggregation", "display.aggregationField"]);
    expect(grammar["graphTypes"]).toEqual(["line", "bar", "pie", "dot"]);
    const filters = dashboards["filterKeys"] as Record<string, string[]>;
    // Records take an ARRAY (AND); tasks and goals take the singular form.
    expect(filters["record"]).toContain("tags");
    expect(filters["task"]).toContain("tag");
    expect(filters["goal"]).toContain("tag");
  });

  test("a dashboard renders even when its card DATA cannot be resolved", async () => {
    const workspace = stub({
      "GET /dashboards/dash_1": {
        status: 200,
        body: { _id: "dash_1", name: "Ops", cards: [{ id: "c1", title: "Open" }] },
      },
      "GET /dashboards/dash_1/execute": {
        status: 500,
        body: { message: "Error resolving card data" },
      },
    });
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));
    const dashboard = await get(t, `/api/h/${id}/thredz/dashboards/dash_1`);
    expect(dashboard["ok"]).toBe(true);
    expect(dashboard["dataResolved"]).toBe(false);
    expect(dashboard["dataError"]).toBe("Error resolving card data");
    expect((dashboard["cards"] as unknown[]).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// operational surfaces
// ---------------------------------------------------------------------------

describe("operational surfaces", () => {
  test("a listener create preserves the caller's Idempotency-Key", async () => {
    const workspace = stub({ "POST /listeners": { status: 201, body: { _id: "lis_1" } } });
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));
    const created = await send(t, "POST", `/api/h/${id}/thredz/listeners`, {
      event: "record.created",
      name: "triage",
      idempotencyKey: "replay-me-once",
    });
    expect(created["created"]).toBe(true);
    expect((workspace.calls[0] as StubCall).idempotencyKey).toBe("replay-me-once");
  });

  test("a listener create with no key derives a stable one, so a replay cannot duplicate", async () => {
    const workspace = stub({ "POST /listeners": { status: 201, body: { _id: "lis_1" } } });
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));
    const body = { event: "record.created", name: "triage" };
    await send(t, "POST", `/api/h/${id}/thredz/listeners`, body);
    await send(t, "POST", `/api/h/${id}/thredz/listeners`, body);
    const [first, second] = workspace.calls as [StubCall, StubCall];
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    expect(String(first.idempotencyKey)).toContain("record.created");
  });

  test("a locked listener quota reads as a fact, not a failure", async () => {
    const workspace = stub({
      "GET /listeners": { status: 200, body: [] },
      "GET /listeners/usage": { status: 200, body: { used: 3, limit: 3, locked: true } },
      "GET /listeners/events": { status: 200, body: { events: [] } },
    });
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));
    const listeners = await get(t, `/api/h/${id}/thredz/listeners`);
    expect(listeners["ok"]).toBe(true);
    expect(listeners["quotaLocked"]).toBe(true);
    expect(String(listeners["note"])).toContain("quota fact, not a failure");
  });

  test("webhooks count their failed deliveries; activity and traverse normalize their shapes", async () => {
    const workspace = stub({
      "GET /webhooks": {
        status: 200,
        body: [{ _id: "wh_1", url: "https://example.invalid/hook" }],
      },
      "GET /webhooks/deliveries": {
        status: 200,
        body: { deliveries: [{ status: "failed" }, { status: "delivered" }] },
      },
      "GET /activity": { status: 200, body: { activities: [{ action: "created" }] } },
      "GET /wiki/audit": { status: 200, body: { audit: [{ action: "rollback", slug: "ops" }] } },
      "POST /traverse": { status: 200, body: { nodes: [{ id: "rec_1" }], edges: [], depth: 2 } },
    });
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));
    const webhooks = await get(t, `/api/h/${id}/thredz/webhooks`);
    expect(webhooks["failedDeliveries"]).toBe(1);
    const activity = await get(t, `/api/h/${id}/thredz/activity`);
    expect((activity["items"] as unknown[]).length).toBe(1);
    // The wiki's own audit log has no route of its own in the frozen map, so
    // it rides with the activity feed.
    expect((activity["wikiAudit"] as unknown[]).length).toBe(1);
    const traverse = await send(t, "POST", `/api/h/${id}/thredz/traverse`, {
      start: "rec_1",
      depth: 2,
    });
    expect(traverse["ok"]).toBe(true);
    expect(traverse["depth"]).toBe(2);
    const sent = (workspace.calls.at(-1) as StubCall).body as Record<string, unknown>;
    expect(sent["startId"]).toBe("rec_1");
    expect(sent["startType"]).toBe("record");
    expect(sent["direction"]).toBe("both");
  });

  test("the study queue is counted off the knowledge-gap tag", async () => {
    const workspace = stub({
      "GET /tasks": {
        status: 200,
        body: {
          tasks: [
            { _id: "t1", tags: ["knowledge-gap"] },
            { _id: "t2", tags: ["ops"] },
          ],
        },
      },
    });
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));
    const tasks = await get(t, `/api/h/${id}/thredz/tasks`);
    expect(tasks["studyQueue"]).toBe(1);
    expect(tasks["filterParam"]).toBe("tag");
  });

  test("completing a task uses the completion route, not a status patch", async () => {
    const workspace = stub({
      "PUT /tasks/task_1/complete": { status: 200, body: { _id: "task_1" } },
    });
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));
    const updated = await send(t, "POST", `/api/h/${id}/thredz/tasks/task_1`, { status: "done" });
    expect(updated["completed"]).toBe(true);
    expect((workspace.calls[0] as StubCall).path).toBe("/tasks/task_1/complete");
  });
});

// ---------------------------------------------------------------------------
// key administration
// ---------------------------------------------------------------------------

describe("key administration", () => {
  test("listing keys returns METADATA only — the key material never leaves the process", async () => {
    const otherKey = ["another", "workspace", "key"].join("-");
    const workspace = stub({
      "GET /keys": {
        status: 200,
        body: [{ _id: "key_1", key: otherKey, owner: "ops", permissions: "read-write" }],
      },
      "GET /wiki/access": { status: 200, body: [{ keyId: "key_1", permission: "read-write" }] },
    });
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));
    const keys = await get(t, `/api/h/${id}/thredz/keys`);
    expect(keys["tier"]).toBe("admin");
    expect(JSON.stringify(keys)).not.toContain(otherKey);
    const row = (keys["keys"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(row["id"]).toBe("key_1");
    expect(row["owner"]).toBe("ops");
    expect(Object.keys(row)).not.toContain("key");
    expect((keys["grants"] as unknown[]).length).toBe(1);
  });

  test("a non-admin key is a FACT about the key, not an error screen", async () => {
    const workspace = stub({
      "GET /keys": { status: 403, body: { message: "Admin permission required" } },
      "GET /wiki/access": { status: 200, body: [] },
    });
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));
    const keys = await get(t, `/api/h/${id}/thredz/keys`);
    expect(keys["tier"]).toBe("wiki");
    expect(keys["keys"]).toEqual([]);
    expect(String(keys["note"])).toContain("not admin-tier");
  });

  test("creating a key takes the value WRITE-ONLY: forwarded once, never echoed", async () => {
    const minted = ["minted", "by", "the", "operator"].join("-");
    const workspace = stub({
      "POST /keys": { status: 201, body: { _id: "key_2", key: minted, owner: "hangar" } },
      "POST /wiki/access": { status: 200, body: { keyId: "key_2", permission: "read-write" } },
    });
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));

    const without = await send(t, "POST", `/api/h/${id}/thredz/keys`, { label: "hangar" });
    expect(without["needsValue"]).toBe(true);
    expect(workspace.calls).toEqual([]);

    const created = await send(t, "POST", `/api/h/${id}/thredz/keys`, {
      label: "hangar",
      value: minted,
      wikiAccess: "read-write",
    });
    expect(created["created"]).toBe(true);
    expect(JSON.stringify(created)).not.toContain(minted);
    expect(((workspace.calls[0] as StubCall).body as Record<string, unknown>)["key"]).toBe(minted);
  });

  test("rotation is typed-confirm, mints a replacement, and never deletes the old key", async () => {
    const replacement = ["replacement", "value", "here"].join("-");
    const workspace = stub({
      "GET /keys/key_1": {
        status: 200,
        body: { _id: "key_1", owner: "ops", permissions: "admin" },
      },
      "POST /keys": { status: 201, body: { _id: "key_9", owner: "ops", permissions: "admin" } },
      "POST /wiki/access": { status: 200, body: {} },
    });
    const t = boot();
    const id = await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));

    const unconfirmed = await send(t, "POST", `/api/h/${id}/thredz/keys/key_1/rotate`, {
      value: replacement,
    });
    expect(unconfirmed["needsTypedConfirm"]).toBe(true);
    expect(unconfirmed["confirmExpects"]).toBe("ops");
    expect(workspace.calls.some((c) => c.method === "POST")).toBe(false);

    const rotated = await send(t, "POST", `/api/h/${id}/thredz/keys/key_1/rotate`, {
      value: replacement,
      confirmName: "ops",
    });
    expect(rotated["rotated"]).toBe(true);
    expect(rotated["retiredOldKey"]).toBe(false);
    expect(String(rotated["note"])).toContain("no hard-delete affordance");
    expect(JSON.stringify(rotated)).not.toContain(replacement);
    expect(workspace.calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// the global explorer
// ---------------------------------------------------------------------------

describe("the global explorer", () => {
  test("with no manager key it still says which harnesses are wired", async () => {
    const workspace = stub();
    const t = boot();
    await register(t, wiredHarness(workspace.base, { key: TEST_KEY }));
    await register(t, localHarness());
    const global = await get(t, "/api/thredz");
    expect(global["keyPresent"]).toBe(false);
    expect(global["wired"]).toBe(1);
    expect((global["harnesses"] as unknown[]).length).toBe(2);
    expect(String(global["note"])).toContain("CREWHAUS_THREDZ_KEY");
    expect(workspace.calls).toEqual([]);
  });

  test("with CREWHAUS_THREDZ_KEY it explores the manager's own workspace", async () => {
    const workspace = stub({
      "GET /wiki/stats": { status: 200, body: { articles: 4 } },
      "GET /records": { status: 200, body: { records: [], pagination: { total: 12 } } },
      "GET /dashboards": { status: 200, body: { dashboards: [], pagination: { total: 2 } } },
    });
    const t = boot({ CREWHAUS_THREDZ_KEY: TEST_KEY, CREWHAUS_THREDZ_BASE: workspace.base });
    const global = await get(t, "/api/thredz");
    expect(global["keyPresent"]).toBe(true);
    expect(global["keySource"]).toBe("manager-env");
    expect(global["reachable"]).toBe(true);
    expect(global["counts"]).toEqual({ records: 12, dashboards: 2 });
    expect(JSON.stringify(global)).not.toContain(TEST_KEY);
  });
});
