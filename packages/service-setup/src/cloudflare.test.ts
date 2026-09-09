/**
 * Cloudflare client tests.
 *
 * Every call goes through an injected `fetchImpl` backed by a route table, so
 * the suite is credential-free and network-free: nothing here needs a token,
 * and nothing here can leak one. The fake records each request so the tests
 * can assert what actually went on the wire — which matters more than usual
 * for this client, because two of the failure modes it guards against
 * (`config_src: "local"`, a hostname-terminated ingress list) are invisible in
 * the response and only detectable in the request.
 */
import { describe, expect, test } from "bun:test";
import {
  CLOUDFLARE_API_BASE,
  type CloudflareDeps,
  type IngressRule,
  connectorInstallHint,
  createTunnel,
  ensureTunnel,
  findTunnelByName,
  findZone,
  getTunnelConfiguration,
  getTunnelToken,
  localOrigin,
  mergeIngress,
  needsConnector,
  putTunnelConfiguration,
  upsertDnsCname,
  verifyToken,
} from "./cloudflare";
import { ServiceSetupError } from "./types";

const AUTH = { apiToken: "cf-test-token" } as const;
const ACCOUNT = "acct1";
const ZONE = "zone1";
const TUNNEL = "tun1";
const PREFIX = new URL(CLOUDFLARE_API_BASE).pathname;

type FakeRoute = { readonly status: number; readonly body: unknown };

type Recorded = {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
};

/**
 * Route table driven fake. Keys are `"<METHOD> <path>"`, matched first with
 * the query string and then without it, so a test only spells out a query when
 * it is the thing under test. A value may be an array to script successive
 * responses for the same route.
 */
function fakeCloudflare(routes: Readonly<Record<string, FakeRoute | FakeRoute[]>>): {
  deps: CloudflareDeps;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const seen = new Map<string, number>();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(url);
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
        body = raw;
      }
    }
    calls.push({ url, method, body, headers });

    const keyed = `${method} ${parsed.pathname}${parsed.search}`;
    const bare = `${method} ${parsed.pathname}`;
    const route = routes[keyed] ?? routes[bare];
    if (route === undefined) throw new Error(`no fake route for ${keyed}`);

    const index = seen.get(bare) ?? 0;
    seen.set(bare, index + 1);
    const picked = Array.isArray(route)
      ? (route[Math.min(index, route.length - 1)] ?? route[0])
      : route;
    if (picked === undefined) throw new Error(`empty fake route list for ${bare}`);

    return new Response(JSON.stringify(picked.body), {
      status: picked.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return { deps: { fetchImpl }, calls };
}

/** A successful Cloudflare envelope. */
function ok(result: unknown): FakeRoute {
  return { status: 200, body: { success: true, errors: [], messages: [], result } };
}

/** A failing Cloudflare envelope. */
function fail(status: number, errors: readonly unknown[]): FakeRoute {
  return { status, body: { success: false, errors, messages: [], result: null } };
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

const remoteTunnel = {
  id: TUNNEL,
  name: "crewhaus-crew",
  config_src: "cloudflare",
  deleted_at: null,
};

describe("localOrigin", () => {
  test("builds a localhost origin for the daemon port", () => {
    expect(localOrigin(8787)).toBe("http://localhost:8787");
  });

  test("accepts an explicit host override", () => {
    expect(localOrigin(8787, "127.0.0.1")).toBe("http://127.0.0.1:8787");
  });

  test("rejects a port outside the valid range", async () => {
    expect(() => localOrigin(0)).toThrow(ServiceSetupError);
    expect(() => localOrigin(70_000)).toThrow(ServiceSetupError);
    expect(() => localOrigin(8787.5)).toThrow(ServiceSetupError);
  });
});

describe("verifyToken", () => {
  test("passes on an active token and sends a bearer header", async () => {
    const { deps, calls } = fakeCloudflare({
      [`GET ${PREFIX}/user/tokens/verify`]: ok({ id: "tok_1", status: "active" }),
    });
    expect(await verifyToken(AUTH, deps)).toEqual({ id: "tok_1", status: "active" });
    expect(calls[0]?.headers["authorization"]).toBe("Bearer cf-test-token");
    expect(calls[0]?.method).toBe("GET");
  });

  test("a 403 classifies as auth and prints the three required permissions", async () => {
    const { deps } = fakeCloudflare({
      [`GET ${PREFIX}/user/tokens/verify`]: fail(403, [
        { code: 9109, message: "Unauthorized to access requested resource" },
      ]),
    });
    const err = await caught(() => verifyToken(AUTH, deps));
    expect(err.failureClass).toBe("auth");
    expect(err.options.status).toBe(403);
    expect(err.message).toContain("9109: Unauthorized to access requested resource");
    expect(err.options.fix).toContain("Cloudflare Tunnel · Edit");
    expect(err.options.fix).toContain("Zone · DNS · Edit");
    expect(err.options.fix).toContain("Zone · Zone · Read");
  });

  test("a token that verifies but is not active is rejected", async () => {
    const { deps } = fakeCloudflare({
      [`GET ${PREFIX}/user/tokens/verify`]: ok({ id: "tok_1", status: "disabled" }),
    });
    const err = await caught(() => verifyToken(AUTH, deps));
    expect(err.message).toContain("disabled");
    expect(err.options.fix).toContain("api-tokens");
  });

  test("renders a nested error_chain into the message", async () => {
    const { deps } = fakeCloudflare({
      [`GET ${PREFIX}/user/tokens/verify`]: fail(400, [
        {
          code: 1000,
          message: "An unknown error occurred",
          error_chain: [{ code: 1001, message: "token is malformed" }],
        },
      ]),
    });
    const err = await caught(() => verifyToken(AUTH, deps));
    expect(err.message).toContain("1000: An unknown error occurred");
    expect(err.message).toContain("→ 1001: token is malformed");
    expect(err.options.code).toBe("1000");
  });
});

describe("findZone", () => {
  test("returns the zone id and the owning account id", async () => {
    const { deps, calls } = fakeCloudflare({
      [`GET ${PREFIX}/zones`]: ok([{ id: ZONE, name: "example.com", account: { id: ACCOUNT } }]),
    });
    expect(await findZone(AUTH, "example.com", deps)).toEqual({
      zoneId: ZONE,
      accountId: ACCOUNT,
    });
    expect(calls[0]?.url).toContain("name=example.com");
  });

  test("an empty result is a clear miss, not an undefined crash later", async () => {
    const { deps } = fakeCloudflare({ [`GET ${PREFIX}/zones`]: ok([]) });
    const err = await caught(() => findZone(AUTH, "nope.example", deps));
    expect(err.message).toContain('no zone named "nope.example"');
    expect(err.options.fix).toContain("Zone · Zone · Read");
  });
});

describe("regressions — the full-replace PUT must not destroy what it does not model", () => {
  test("mergeIngress keeps a path-scoped route beside a bare one on the same hostname", () => {
    // cloudflared matches (hostname, path) top-down, so these are TWO live
    // routes, not a stale duplicate. Keying the merge on hostname alone
    // deleted the path rule and silently re-routed /metrics to the daemon.
    const existing: IngressRule[] = [
      { hostname: "h.example.com", path: "^/metrics", service: "http://localhost:9100" },
      { hostname: "h.example.com", service: "http://localhost:8787" },
      { service: "http_status:404" },
    ];
    const merged = mergeIngress(existing, [
      { hostname: "h.example.com", service: "http://localhost:3000" },
    ]);
    expect(merged).toEqual([
      { hostname: "h.example.com", path: "^/metrics", service: "http://localhost:9100" },
      { hostname: "h.example.com", service: "http://localhost:3000" },
      { service: "http_status:404" },
    ]);
  });

  test("mergeIngress carries an existing rule's originRequest onto the new service", () => {
    const merged = mergeIngress(
      [
        {
          hostname: "h.example.com",
          service: "http://localhost:1",
          extra: { originRequest: { access: { required: true, teamName: "acme" } } },
        },
        { service: "http_status:404" },
      ],
      [{ hostname: "h.example.com", service: "http://localhost:3000" }],
    );
    expect(merged[0]).toEqual({
      hostname: "h.example.com",
      service: "http://localhost:3000",
      extra: { originRequest: { access: { required: true, teamName: "acme" } } },
    });
  });

  test("a round trip preserves another hostname's Access config and the tunnel's warp-routing", async () => {
    // The failure this guards against is invisible: Cloudflare answers
    // success:true and bumps the version while another harness's hostname
    // quietly loses `access.required` and becomes publicly reachable.
    const live = {
      version: 4,
      config: {
        "warp-routing": { enabled: true },
        originRequest: { connectTimeout: 30 },
        ingress: [
          {
            hostname: "billing.example.com",
            service: "https://127.0.0.1:9443",
            originRequest: { access: { required: true, teamName: "acme", audTag: ["a1"] } },
          },
          { service: "http_status:404" },
        ],
      },
    };
    const { deps, calls } = fakeCloudflare({
      [`GET ${PREFIX}/accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/configurations`]: ok(live),
      [`PUT ${PREFIX}/accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/configurations`]: ok({ version: 5 }),
    });
    const read = await getTunnelConfiguration(AUTH, ACCOUNT, TUNNEL, deps);
    const merged = mergeIngress(read.ingress, [
      { hostname: "new.example.com", service: "http://localhost:3000" },
    ]);
    await putTunnelConfiguration(AUTH, ACCOUNT, TUNNEL, merged, deps, read.raw);

    const body = calls.find((c) => c.method === "PUT")?.body as {
      config: { ingress: Array<Record<string, unknown>>; "warp-routing"?: unknown };
    };
    expect(body.config["warp-routing"]).toEqual({ enabled: true });
    expect(body.config["originRequest"]).toEqual({ connectTimeout: 30 });
    expect(body.config.ingress[0]).toEqual({
      originRequest: { access: { required: true, teamName: "acme", audTag: ["a1"] } },
      hostname: "billing.example.com",
      service: "https://127.0.0.1:9443",
    });
    expect(body.config.ingress.at(-1)).toEqual({ service: "http_status:404" });
  });

  test("needsConnector is true until a connector attaches", () => {
    const base = { id: "t", name: "n", configSrc: "cloudflare", deletedAt: null } as const;
    expect(needsConnector({ ...base, status: "inactive" })).toBe(true);
    expect(needsConnector({ ...base, status: "down" })).toBe(true);
    expect(needsConnector({ ...base, status: "unknown" })).toBe(true);
    expect(needsConnector({ ...base, status: "healthy" })).toBe(false);
    expect(needsConnector({ ...base, status: "degraded" })).toBe(false);
  });
});

describe("findTunnelByName", () => {
  test("returns the parsed summary and filters on is_deleted", async () => {
    const { deps, calls } = fakeCloudflare({
      [`GET ${PREFIX}/accounts/${ACCOUNT}/cfd_tunnel`]: ok([remoteTunnel]),
    });
    const found = await findTunnelByName(AUTH, ACCOUNT, "crewhaus-crew", deps);
    expect(found).toEqual({
      id: TUNNEL,
      name: "crewhaus-crew",
      configSrc: "cloudflare",
      deletedAt: null,
      // Carried so the caller can tell whether a connector is attached and
      // still needs `cloudflared service install` — see needsConnector.
      status: "inactive",
    });
    expect(calls[0]?.url).toContain("is_deleted=false");
  });

  test("a tombstoned tunnel is ignored even when the API returns it", async () => {
    const { deps } = fakeCloudflare({
      [`GET ${PREFIX}/accounts/${ACCOUNT}/cfd_tunnel`]: ok([
        { ...remoteTunnel, deleted_at: "2026-01-01T00:00:00Z" },
      ]),
    });
    expect(await findTunnelByName(AUTH, ACCOUNT, "crewhaus-crew", deps)).toBeUndefined();
  });

  test("a missing config_src reads as locally managed, matching the API default", async () => {
    const { deps } = fakeCloudflare({
      [`GET ${PREFIX}/accounts/${ACCOUNT}/cfd_tunnel`]: ok([
        { id: TUNNEL, name: "crewhaus-crew", deleted_at: null },
      ]),
    });
    const found = await findTunnelByName(AUTH, ACCOUNT, "crewhaus-crew", deps);
    expect(found?.configSrc).toBe("local");
  });
});

describe("createTunnel", () => {
  test("always sends config_src: cloudflare", async () => {
    const { deps, calls } = fakeCloudflare({
      [`POST ${PREFIX}/accounts/${ACCOUNT}/cfd_tunnel`]: ok(remoteTunnel),
    });
    const tunnel = await createTunnel(AUTH, ACCOUNT, "crewhaus-crew", deps);
    expect(tunnel.configSrc).toBe("cloudflare");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({ name: "crewhaus-crew", config_src: "cloudflare" });
  });

  test("never sends a tunnel_secret", async () => {
    const { deps, calls } = fakeCloudflare({
      [`POST ${PREFIX}/accounts/${ACCOUNT}/cfd_tunnel`]: ok(remoteTunnel),
    });
    await createTunnel(AUTH, ACCOUNT, "crewhaus-crew", deps);
    expect(Object.keys(Object(calls[0]?.body))).not.toContain("tunnel_secret");
  });

  test("an unrecognisable result is an explicit failure", async () => {
    const { deps } = fakeCloudflare({
      [`POST ${PREFIX}/accounts/${ACCOUNT}/cfd_tunnel`]: ok({ nothing: true }),
    });
    const err = await caught(() => createTunnel(AUTH, ACCOUNT, "crewhaus-crew", deps));
    expect(err.message).toContain("unexpected create-tunnel response");
  });
});

describe("ensureTunnel", () => {
  test("creates when no tunnel exists", async () => {
    const { deps, calls } = fakeCloudflare({
      [`GET ${PREFIX}/accounts/${ACCOUNT}/cfd_tunnel`]: ok([]),
      [`POST ${PREFIX}/accounts/${ACCOUNT}/cfd_tunnel`]: ok(remoteTunnel),
    });
    const result = await ensureTunnel(AUTH, ACCOUNT, "crewhaus-crew", deps);
    expect(result.created).toBe(true);
    expect(result.tunnel.id).toBe(TUNNEL);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });

  test("reuses an existing remotely-managed tunnel without writing anything", async () => {
    const { deps, calls } = fakeCloudflare({
      [`GET ${PREFIX}/accounts/${ACCOUNT}/cfd_tunnel`]: ok([remoteTunnel]),
    });
    const result = await ensureTunnel(AUTH, ACCOUNT, "crewhaus-crew", deps);
    expect(result.created).toBe(false);
    expect(result.tunnel.configSrc).toBe("cloudflare");
    expect(calls).toHaveLength(1);
  });

  test("refuses to reuse a locally-managed tunnel: config_src cannot be migrated", async () => {
    const { deps, calls } = fakeCloudflare({
      [`GET ${PREFIX}/accounts/${ACCOUNT}/cfd_tunnel`]: ok([
        { ...remoteTunnel, config_src: "local" },
      ]),
    });
    const err = await caught(() => ensureTunnel(AUTH, ACCOUNT, "crewhaus-crew", deps));
    expect(err.options.code).toBe("config_src_local");
    expect(err.message).toContain("locally managed");
    expect(err.message).toContain("would be ignored");
    expect(err.options.fix).toContain("re-create the tunnel as remotely managed");
    expect(err.options.fix).toContain("config.yml");
    // Nothing was written: the refusal happens before any PUT.
    expect(calls).toHaveLength(1);
  });

  test("refuses a freshly created tunnel that came back locally managed", async () => {
    const { deps } = fakeCloudflare({
      [`GET ${PREFIX}/accounts/${ACCOUNT}/cfd_tunnel`]: ok([]),
      [`POST ${PREFIX}/accounts/${ACCOUNT}/cfd_tunnel`]: ok({
        ...remoteTunnel,
        config_src: "local",
      }),
    });
    const err = await caught(() => ensureTunnel(AUTH, ACCOUNT, "crewhaus-crew", deps));
    expect(err.options.code).toBe("config_src_local");
  });
});

describe("getTunnelToken", () => {
  test("accepts the bare-string result this endpoint returns", async () => {
    const { deps } = fakeCloudflare({
      [`GET ${PREFIX}/accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/token`]: ok("eyJhIjoiYiJ9"),
    });
    expect(await getTunnelToken(AUTH, ACCOUNT, TUNNEL, deps)).toBe("eyJhIjoiYiJ9");
  });

  test("an object result is rejected rather than stringified into garbage", async () => {
    const { deps } = fakeCloudflare({
      [`GET ${PREFIX}/accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/token`]: ok({ token: "x" }),
    });
    const err = await caught(() => getTunnelToken(AUTH, ACCOUNT, TUNNEL, deps));
    expect(err.message).toContain("empty connector token");
    expect(err.options.fix).toContain("write-level");
  });

  test("a 403 here names the write-level tunnel group", async () => {
    const { deps } = fakeCloudflare({
      [`GET ${PREFIX}/accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/token`]: fail(403, [
        { code: 10000, message: "Authentication error" },
      ]),
    });
    const err = await caught(() => getTunnelToken(AUTH, ACCOUNT, TUNNEL, deps));
    expect(err.failureClass).toBe("auth");
    expect(err.options.fix).toContain("Cloudflare Tunnel · Edit");
  });
});

describe("getTunnelConfiguration", () => {
  test("parses version and ingress out of the nested config", async () => {
    const { deps } = fakeCloudflare({
      [`GET ${PREFIX}/accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/configurations`]: ok({
        tunnel_id: TUNNEL,
        version: 7,
        config: {
          ingress: [
            { hostname: "old.example.com", service: "http://localhost:9000" },
            { service: "http_status:404" },
          ],
        },
      }),
    });
    const config = await getTunnelConfiguration(AUTH, ACCOUNT, TUNNEL, deps);
    expect(config.version).toBe(7);
    expect(config.ingress).toEqual([
      { hostname: "old.example.com", service: "http://localhost:9000" },
      { service: "http_status:404" },
    ]);
  });

  test("a never-configured tunnel reads as an empty rule list, not an error", async () => {
    const { deps } = fakeCloudflare({
      [`GET ${PREFIX}/accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/configurations`]: ok({
        tunnel_id: TUNNEL,
        version: 1,
      }),
    });
    const config = await getTunnelConfiguration(AUTH, ACCOUNT, TUNNEL, deps);
    expect(config.ingress).toEqual([]);
  });
});

describe("mergeIngress", () => {
  const catchAll: IngressRule = { service: "http_status:404" };

  test("replaces an existing hostname's service in place", () => {
    const existing: IngressRule[] = [
      { hostname: "a.example.com", service: "http://localhost:1111" },
      { hostname: "crew.example.com", service: "http://localhost:2222" },
      { hostname: "z.example.com", service: "http://localhost:3333" },
      catchAll,
    ];
    const merged = mergeIngress(existing, [
      { hostname: "crew.example.com", service: "http://localhost:8787" },
    ]);
    expect(merged).toEqual([
      { hostname: "a.example.com", service: "http://localhost:1111" },
      { hostname: "crew.example.com", service: "http://localhost:8787" },
      { hostname: "z.example.com", service: "http://localhost:3333" },
      catchAll,
    ]);
  });

  test("appends a new hostname before the catch-all", () => {
    const merged = mergeIngress(
      [{ hostname: "a.example.com", service: "http://localhost:1111" }, catchAll],
      [{ hostname: "new.example.com", service: "http://localhost:8787" }],
    );
    expect(merged).toEqual([
      { hostname: "a.example.com", service: "http://localhost:1111" },
      { hostname: "new.example.com", service: "http://localhost:8787" },
      catchAll,
    ]);
  });

  test("preserves unrelated rules and their relative order", () => {
    const existing: IngressRule[] = [
      { hostname: "one.example.com", service: "http://localhost:1" },
      { hostname: "two.example.com", service: "http://localhost:2", path: "^/api" },
      { hostname: "three.example.com", service: "http://localhost:3" },
      catchAll,
    ];
    const merged = mergeIngress(existing, [
      { hostname: "four.example.com", service: "http://localhost:4" },
    ]);
    expect(merged.slice(0, 3)).toEqual(existing.slice(0, 3));
    expect(merged[3]).toEqual({ hostname: "four.example.com", service: "http://localhost:4" });
  });

  test("synthesises a catch-all when existing has none", () => {
    const merged = mergeIngress(
      [{ hostname: "a.example.com", service: "http://localhost:1" }],
      [{ hostname: "b.example.com", service: "http://localhost:2" }],
    );
    expect(merged.at(-1)).toEqual(catchAll);
    expect(merged).toHaveLength(3);
  });

  test("an empty merge still produces a valid single-rule config", () => {
    expect(mergeIngress([], [])).toEqual([catchAll]);
  });

  test("collapses multiple catch-alls to one, keeping the last fallback service", () => {
    const merged = mergeIngress(
      [
        { service: "http_status:404" },
        { hostname: "a.example.com", service: "http://localhost:1" },
        { service: "http_status:503" },
      ],
      [],
    );
    expect(merged).toEqual([
      { hostname: "a.example.com", service: "http://localhost:1" },
      { service: "http_status:503" },
    ]);
  });

  test("a desired fallback outranks the existing one and loses its path", () => {
    const merged = mergeIngress(
      [{ service: "http_status:404" }],
      [{ service: "http_status:503", path: "^/anything" }],
    );
    expect(merged).toEqual([{ service: "http_status:503" }]);
  });

  test("never emits a hostname-bearing rule last, whatever the inputs", () => {
    const cases: readonly (readonly [IngressRule[], IngressRule[]])[] = [
      [[], [{ hostname: "a.example.com", service: "http://localhost:1" }]],
      [[{ hostname: "a.example.com", service: "http://localhost:1" }], []],
      [
        [{ hostname: "a.example.com", service: "http://localhost:1" }],
        [{ hostname: "b.example.com", service: "http://localhost:2" }],
      ],
      [[{ service: "http_status:404" }], []],
    ];
    for (const [existing, desired] of cases) {
      const merged = mergeIngress(existing, desired);
      expect(merged.at(-1)?.hostname).toBeUndefined();
      expect(merged.filter((rule) => rule.hostname === undefined)).toHaveLength(1);
    }
  });

  test("drops a stale duplicate entry for a hostname it upserts", () => {
    const merged = mergeIngress(
      [
        { hostname: "crew.example.com", service: "http://localhost:1" },
        { hostname: "crew.example.com", service: "http://localhost:2" },
        { service: "http_status:404" },
      ],
      [{ hostname: "crew.example.com", service: "http://localhost:8787" }],
    );
    expect(merged).toEqual([
      { hostname: "crew.example.com", service: "http://localhost:8787" },
      catchAll,
    ]);
  });

  test("the last desired rule wins when one hostname is listed twice", () => {
    const merged = mergeIngress(
      [],
      [
        { hostname: "crew.example.com", service: "http://localhost:1" },
        { hostname: "crew.example.com", service: "http://localhost:2" },
      ],
    );
    expect(merged).toEqual([
      { hostname: "crew.example.com", service: "http://localhost:2" },
      catchAll,
    ]);
  });

  test("does not mutate its inputs", () => {
    const existing: IngressRule[] = [{ hostname: "a.example.com", service: "http://localhost:1" }];
    const desired: IngressRule[] = [{ hostname: "b.example.com", service: "http://localhost:2" }];
    mergeIngress(existing, desired);
    expect(existing).toHaveLength(1);
    expect(desired).toHaveLength(1);
  });
});

describe("putTunnelConfiguration", () => {
  const configPath = `${PREFIX}/accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/configurations`;

  test("GET → merge → PUT keeps other hostnames and puts the catch-all last", async () => {
    const { deps, calls } = fakeCloudflare({
      [`GET ${configPath}`]: ok({
        tunnel_id: TUNNEL,
        version: 3,
        config: {
          ingress: [
            { hostname: "other.example.com", service: "http://localhost:9000" },
            { service: "http_status:404" },
          ],
        },
      }),
      [`PUT ${configPath}`]: ok({ tunnel_id: TUNNEL, version: 4, config: {} }),
    });

    const current = await getTunnelConfiguration(AUTH, ACCOUNT, TUNNEL, deps);
    const merged = mergeIngress(current.ingress, [
      { hostname: "crew.example.com", service: localOrigin(8787) },
    ]);
    const result = await putTunnelConfiguration(AUTH, ACCOUNT, TUNNEL, merged, deps);

    expect(result.version).toBe(4);
    const put = calls[1];
    expect(put?.method).toBe("PUT");
    expect(put?.body).toEqual({
      config: {
        ingress: [
          { hostname: "other.example.com", service: "http://localhost:9000" },
          { hostname: "crew.example.com", service: "http://localhost:8787" },
          { service: "http_status:404" },
        ],
      },
    });
  });

  test("normalises defensively: a hostname-terminated list never reaches the wire", async () => {
    const { deps, calls } = fakeCloudflare({
      [`PUT ${configPath}`]: ok({ version: 2 }),
    });
    await putTunnelConfiguration(
      AUTH,
      ACCOUNT,
      TUNNEL,
      [{ hostname: "crew.example.com", service: "http://localhost:8787" }],
      deps,
    );
    const ingress = (calls[0]?.body as { config: { ingress: Record<string, string>[] } }).config
      .ingress;
    expect(ingress.at(-1)).toEqual({ service: "http_status:404" });
    expect(ingress.at(-1)?.["hostname"]).toBeUndefined();
  });

  test("emits no originRequest block and no undefined fields", async () => {
    const { deps, calls } = fakeCloudflare({ [`PUT ${configPath}`]: ok({ version: 2 }) });
    await putTunnelConfiguration(
      AUTH,
      ACCOUNT,
      TUNNEL,
      [{ hostname: "crew.example.com", service: "http://localhost:8787", path: "^/api" }],
      deps,
    );
    const raw = JSON.stringify(calls[0]?.body);
    expect(raw).not.toContain("originRequest");
    expect(raw).not.toContain("connectTimeout");
    expect(raw).toContain('"path":"^/api"');
  });

  test("a write failure carries an actionable fix", async () => {
    const { deps } = fakeCloudflare({
      [`PUT ${configPath}`]: fail(400, [{ code: 1002, message: "invalid ingress" }]),
    });
    const err = await caught(() =>
      putTunnelConfiguration(AUTH, ACCOUNT, TUNNEL, [{ service: "http_status:404" }], deps),
    );
    expect(err.message).toContain("1002: invalid ingress");
    expect(err.options.fix).toContain("Cloudflare Tunnel · Edit");
  });
});

describe("upsertDnsCname", () => {
  const listPath = `${PREFIX}/zones/${ZONE}/dns_records`;
  const content = `${TUNNEL}.cfargotunnel.com`;

  test("creates a proxied CNAME when none exists, with no ttl", async () => {
    const { deps, calls } = fakeCloudflare({
      [`GET ${listPath}`]: ok([]),
      [`POST ${listPath}`]: ok({ id: "rec1", name: "crew.example.com", content, proxied: true }),
    });
    const result = await upsertDnsCname(AUTH, ZONE, "crew.example.com", TUNNEL, deps);
    expect(result).toEqual({ action: "created", recordId: "rec1", name: "crew.example.com" });
    expect(calls[0]?.url).toContain("type=CNAME");
    expect(calls[0]?.url).toContain("name=crew.example.com");
    expect(calls[1]?.body).toEqual({
      type: "CNAME",
      name: "crew.example.com",
      content,
      proxied: true,
    });
    expect(Object.keys(Object(calls[1]?.body))).not.toContain("ttl");
  });

  test("patches an existing record that points somewhere else", async () => {
    const { deps, calls } = fakeCloudflare({
      [`GET ${listPath}`]: ok([
        { id: "rec1", name: "crew.example.com", content: "old.cfargotunnel.com", proxied: true },
      ]),
      [`PATCH ${listPath}/rec1`]: ok({ id: "rec1", name: "crew.example.com", content }),
    });
    const result = await upsertDnsCname(AUTH, ZONE, "crew.example.com", TUNNEL, deps);
    expect(result).toEqual({ action: "updated", recordId: "rec1", name: "crew.example.com" });
    expect(calls[1]?.method).toBe("PATCH");
    expect(calls[1]?.body).toMatchObject({ content, proxied: true });
  });

  test("re-proxies a grey-clouded record even when the content already matches", async () => {
    const { deps, calls } = fakeCloudflare({
      [`GET ${listPath}`]: ok([{ id: "rec1", name: "crew.example.com", content, proxied: false }]),
      [`PATCH ${listPath}/rec1`]: ok({ id: "rec1", name: "crew.example.com", content }),
    });
    const result = await upsertDnsCname(AUTH, ZONE, "crew.example.com", TUNNEL, deps);
    expect(result.action).toBe("updated");
    expect(calls[1]?.body).toMatchObject({ proxied: true });
  });

  test("reports unchanged and writes nothing when the record already matches", async () => {
    const { deps, calls } = fakeCloudflare({
      [`GET ${listPath}`]: ok([{ id: "rec1", name: "CREW.example.com", content, proxied: true }]),
    });
    const result = await upsertDnsCname(AUTH, ZONE, "crew.example.com", TUNNEL, deps);
    expect(result).toEqual({ action: "unchanged", recordId: "rec1", name: "crew.example.com" });
    expect(calls).toHaveLength(1);
  });

  test("a DNS permission failure names Zone · DNS · Edit", async () => {
    const { deps } = fakeCloudflare({
      [`GET ${listPath}`]: fail(403, [{ code: 9109, message: "Unauthorized" }]),
    });
    const err = await caught(() => upsertDnsCname(AUTH, ZONE, "crew.example.com", TUNNEL, deps));
    expect(err.failureClass).toBe("auth");
    expect(err.options.fix).toContain("Zone · DNS · Edit");
  });
});

describe("connectorInstallHint", () => {
  test("offers both the service install and the foreground run", () => {
    const lines = connectorInstallHint("tok-abc");
    expect(lines.join("\n")).toContain("sudo cloudflared service install tok-abc");
    expect(lines.join("\n")).toContain("cloudflared tunnel run --token tok-abc");
  });

  test("warns that the command carries a live credential", () => {
    expect(connectorInstallHint("tok-abc").join("\n")).toContain("live credential");
  });
});
