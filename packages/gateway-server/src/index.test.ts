import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorCode } from "@crewhaus/gateway-protocol";
import { type Tenant, buildTenant } from "@crewhaus/tenancy";
import {
  GatewayServerError,
  PROTOCOL_VERSION,
  createGatewayServer,
  signJwt,
  statusFor,
  verifyJwt,
} from "./index";

/**
 * Forge a token with an arbitrary header + claims (signed with `secret`) so
 * we can exercise rejection paths `signJwt` would never produce — e.g. an
 * `alg: none` header or a body with no `exp`.
 */
function forgeToken(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  secret: string,
): string {
  const b64url = (s: string): string =>
    Buffer.from(s, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = createHmac("sha256", secret)
    .update(data)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${data}.${sig}`;
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gateway-server-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const SECRET = "test-secret-do-not-use-in-prod";

function makeServer(
  handler: Parameters<typeof createGatewayServer>[0]["handler"] = async () => ({ ok: true }),
): {
  server: ReturnType<typeof createGatewayServer>;
  tenantA: Tenant;
  tenantB: Tenant;
} {
  const tenantA = buildTenant("tenant-a", { tenantsRoot: tmp });
  const tenantB = buildTenant("tenant-b", { tenantsRoot: tmp });
  const server = createGatewayServer({
    jwtSecret: SECRET,
    tenantsRoot: tmp,
    handler,
    tenantOverrides: { "tenant-a": tenantA, "tenant-b": tenantB },
  });
  return { server, tenantA, tenantB };
}

describe("JWT round-trip", () => {
  test("sign + verify with the same secret", () => {
    const token = signJwt({ tenant_id: "tenant-a" }, SECRET);
    const claims = verifyJwt(token, SECRET);
    expect(claims.tenant_id).toBe("tenant-a");
  });

  test("rejects wrong secret", () => {
    const token = signJwt({ tenant_id: "tenant-a" }, SECRET);
    expect(() => verifyJwt(token, "wrong-secret")).toThrow(/signature mismatch/);
  });

  test("rejects malformed token", () => {
    expect(() => verifyJwt("not.a.jwt.too.many.parts", SECRET)).toThrow(/3 segments/);
  });

  test("rejects expired token", () => {
    const exp = Math.floor((Date.now() - 60_000) / 1000);
    const token = signJwt({ tenant_id: "tenant-a", exp }, SECRET);
    expect(() => verifyJwt(token, SECRET)).toThrow(/expired/);
  });

  test("rejects invalid tenant_id (path traversal)", () => {
    const token = signJwt({ tenant_id: "../etc" }, SECRET);
    expect(() => verifyJwt(token, SECRET)).toThrow(/invalid tenantId/);
  });

  test("valid short-lived HS256 token verifies", () => {
    const iat = Math.floor(Date.now() / 1000);
    const token = signJwt({ tenant_id: "tenant-a", iat, exp: iat + 300 }, SECRET);
    const claims = verifyJwt(token, SECRET);
    expect(claims.tenant_id).toBe("tenant-a");
    expect(claims.exp).toBe(iat + 300);
  });

  test("rejects token with no exp claim (CWE-613)", () => {
    // Forge directly — `signJwt` always injects an exp.
    const token = forgeToken({ alg: "HS256", typ: "JWT" }, { tenant_id: "tenant-a" }, SECRET);
    expect(() => verifyJwt(token, SECRET)).toThrow(/missing exp/);
  });

  test("rejects token whose header alg is not HS256", () => {
    const iat = Math.floor(Date.now() / 1000);
    const token = forgeToken(
      { alg: "none", typ: "JWT" },
      { tenant_id: "tenant-a", iat, exp: iat + 300 },
      SECRET,
    );
    expect(() => verifyJwt(token, SECRET)).toThrow(/unsupported alg/);
  });

  test("rejects token whose header typ is not JWT", () => {
    const iat = Math.floor(Date.now() / 1000);
    const token = forgeToken(
      { alg: "HS256", typ: "JWE" },
      { tenant_id: "tenant-a", iat, exp: iat + 300 },
      SECRET,
    );
    expect(() => verifyJwt(token, SECRET)).toThrow(/unsupported typ/);
  });

  test("rejects a token whose lifetime exceeds the 24h ceiling", () => {
    const iat = Math.floor(Date.now() / 1000);
    const token = signJwt({ tenant_id: "tenant-a", iat, exp: iat + 25 * 60 * 60 }, SECRET);
    expect(() => verifyJwt(token, SECRET)).toThrow(/lifetime exceeds maximum/);
  });
});

describe("server.handle (T2/T3 contract)", () => {
  test("authenticated runs.create dispatches to handler", async () => {
    let received: unknown;
    const { server } = makeServer(async ({ method, params, tenant }) => {
      received = { method, params, tenantId: tenant.id };
      return { runId: "run_x", sessionId: "sess_x", tenantId: tenant.id };
    });
    const token = signJwt({ tenant_id: "tenant-a" }, SECRET);
    const res = await server.handle({
      bearer: token,
      body: {
        protocol: "crewhaus.v1",
        id: "1",
        method: "runs.create",
        params: { spec: "s", input: "hi" },
      },
    });
    expect(res).toEqual({
      protocol: "crewhaus.v1",
      id: "1",
      result: { runId: "run_x", sessionId: "sess_x", tenantId: "tenant-a" },
    });
    expect(received).toEqual({
      method: "runs.create",
      params: { spec: "s", input: "hi" },
      tenantId: "tenant-a",
    });
  });

  test("missing bearer → 401 unauthorized", async () => {
    const { server } = makeServer();
    const res = await server.handle({
      body: {
        protocol: "crewhaus.v1",
        id: "1",
        method: "runs.create",
        params: { spec: "s", input: "" },
      },
    });
    expect(res).toMatchObject({ error: { code: "unauthorized" } });
  });

  test("expired JWT → 401 unauthorized", async () => {
    const { server } = makeServer();
    const exp = Math.floor((Date.now() - 60_000) / 1000);
    const token = signJwt({ tenant_id: "tenant-a", exp }, SECRET);
    const res = await server.handle({
      bearer: token,
      body: {
        protocol: "crewhaus.v1",
        id: "1",
        method: "runs.create",
        params: { spec: "s", input: "" },
      },
    });
    expect(res).toMatchObject({
      error: { code: "unauthorized", message: expect.stringMatching(/expired/) },
    });
  });

  test("malformed envelope → 400 bad_request", async () => {
    const { server } = makeServer();
    const token = signJwt({ tenant_id: "tenant-a" }, SECRET);
    const res = await server.handle({
      bearer: token,
      body: { protocol: "crewhaus.v0", id: "1", method: "x", params: {} },
    });
    expect(res).toMatchObject({ error: { code: "bad_request" } });
  });
});

describe("budget enforcement", () => {
  test("recordUsage increments cumulative usage", async () => {
    const { server } = makeServer();
    server.recordUsage("tenant-a", { input: 1000, output: 200 });
    server.recordUsage("tenant-a", { input: 500, output: 100 });
    expect(server.usage("tenant-a")).toEqual({ input: 1500, output: 300 });
  });

  test("exhausted input budget → 429 budget_exceeded", async () => {
    const tenantA = buildTenant("tenant-a", { tenantsRoot: tmp });
    const tinyA: Tenant = { ...tenantA, budget: { maxInputTokens: 100, maxOutputTokens: 100 } };
    const server = createGatewayServer({
      jwtSecret: SECRET,
      tenantsRoot: tmp,
      handler: async () => ({ ok: true }),
      tenantOverrides: { "tenant-a": tinyA },
    });
    server.recordUsage("tenant-a", { input: 999, output: 0 });
    const token = signJwt({ tenant_id: "tenant-a" }, SECRET);
    const res = await server.handle({
      bearer: token,
      body: {
        protocol: "crewhaus.v1",
        id: "1",
        method: "runs.create",
        params: { spec: "s", input: "" },
      },
    });
    expect(res).toMatchObject({
      error: { code: "budget_exceeded", message: expect.stringMatching(/input tokens/) },
    });
  });

  // SECURITY: without an in-flight reservation, concurrent requests all pass
  // checkBudget (which only sees recorded usage = 0) before any records, so a
  // burst blows past the cap. The reservation counts each in-flight request.
  test("in-flight reservation bounds a concurrent burst (TOCTOU)", async () => {
    const tenantA = buildTenant("tenant-a", { tenantsRoot: tmp });
    const tinyA: Tenant = { ...tenantA, budget: { maxInputTokens: 100, maxOutputTokens: 100 } };
    const server = createGatewayServer({
      jwtSecret: SECRET,
      tenantsRoot: tmp,
      handler: async () => ({ ok: true }),
      tenantOverrides: { "tenant-a": tinyA },
      estimateUsage: () => ({ input: 60, output: 0 }),
    });
    const token = signJwt({ tenant_id: "tenant-a" }, SECRET);
    const req = (id: string) =>
      server.handle({
        bearer: token,
        body: {
          protocol: "crewhaus.v1",
          id,
          method: "runs.create",
          params: { spec: "s", input: "" },
        },
      });
    // Three concurrent requests @ 60 est. tokens vs a 100-token budget: with
    // recorded usage 0, all three would pass the old check; the cumulative
    // reservation (60+60+60) blocks the 2nd and 3rd.
    const results = await Promise.all([req("1"), req("2"), req("3")]);
    const rejected = results.filter(
      (r) =>
        typeof r === "object" &&
        r !== null &&
        "error" in r &&
        (r as { error: { code: string } }).error.code === "budget_exceeded",
    );
    expect(rejected.length).toBeGreaterThanOrEqual(2);
  });

  test("reservation is released after each request (sequential requests aren't starved)", async () => {
    const tenantA = buildTenant("tenant-a", { tenantsRoot: tmp });
    const tinyA: Tenant = { ...tenantA, budget: { maxInputTokens: 100, maxOutputTokens: 100 } };
    const server = createGatewayServer({
      jwtSecret: SECRET,
      tenantsRoot: tmp,
      handler: async () => ({ ok: true }),
      tenantOverrides: { "tenant-a": tinyA },
      estimateUsage: () => ({ input: 60, output: 0 }),
    });
    const token = signJwt({ tenant_id: "tenant-a" }, SECRET);
    const req = () =>
      server.handle({
        bearer: token,
        body: {
          protocol: "crewhaus.v1",
          id: "x",
          method: "runs.create",
          params: { spec: "s", input: "" },
        },
      });
    // Run-to-completion releases the 60-token reservation, so the next request
    // (recorded usage still 0 here) reserves freshly and succeeds.
    const a = await req();
    const b = await req();
    expect(a).not.toMatchObject({ error: { code: "budget_exceeded" } });
    expect(b).not.toMatchObject({ error: { code: "budget_exceeded" } });
  });
});

describe("tenancy isolation", () => {
  test("tenant-a's tokens never resolve to tenant-b's context", async () => {
    let seen: string | undefined;
    const { server } = makeServer(async ({ tenant }) => {
      seen = tenant.id;
      return { ok: true };
    });
    const tokenA = signJwt({ tenant_id: "tenant-a" }, SECRET);
    await server.handle({
      bearer: tokenA,
      body: {
        protocol: "crewhaus.v1",
        id: "1",
        method: "runs.create",
        params: { spec: "s", input: "" },
      },
    });
    expect(seen).toBe("tenant-a");
    const tokenB = signJwt({ tenant_id: "tenant-b" }, SECRET);
    await server.handle({
      bearer: tokenB,
      body: {
        protocol: "crewhaus.v1",
        id: "1",
        method: "runs.create",
        params: { spec: "s", input: "" },
      },
    });
    expect(seen).toBe("tenant-b");
  });
});

describe("audit log", () => {
  test("every authenticated request writes a gateway_request audit row", async () => {
    const { server, tenantA } = makeServer();
    const token = signJwt({ tenant_id: "tenant-a" }, SECRET);
    await server.handle({
      bearer: token,
      body: {
        protocol: "crewhaus.v1",
        id: "1",
        method: "runs.create",
        params: { spec: "s", input: "" },
      },
    });
    const log = await server.getAuditLog(tenantA);
    const rows: unknown[] = [];
    for await (const r of log.read()) rows.push(r);
    expect(rows.length).toBe(1);
  });

  test("the audit row carries method, tenantId and the token's sub claim", async () => {
    const { server, tenantA } = makeServer();
    const token = signJwt({ tenant_id: "tenant-a", sub: "user-42" }, SECRET);
    await server.handle({
      bearer: token,
      body: {
        protocol: "crewhaus.v1",
        id: "1",
        method: "runs.create",
        params: { spec: "s", input: "" },
      },
    });
    const log = await server.getAuditLog(tenantA);
    const rows: Array<{ payload: { method: string; tenantId: string; sub?: string } }> = [];
    for await (const r of log.read())
      rows.push(r as { payload: { method: string; tenantId: string; sub?: string } });
    expect(rows[0]?.payload).toEqual({
      method: "runs.create",
      tenantId: "tenant-a",
      sub: "user-42",
    });
  });

  test("getAuditLog memoises — the same log instance is returned per tenant", async () => {
    const { server, tenantA } = makeServer();
    const first = await server.getAuditLog(tenantA);
    const second = await server.getAuditLog(tenantA);
    expect(second).toBe(first);
  });
});

describe("verifyJwt — iat edge cases (forged tokens)", () => {
  test("rejects a token whose iat is in the future", () => {
    const future = Math.floor((Date.now() + 10 * 60_000) / 1000);
    const token = forgeToken(
      { alg: "HS256", typ: "JWT" },
      { tenant_id: "tenant-a", iat: future, exp: future + 60 },
      SECRET,
    );
    expect(() => verifyJwt(token, SECRET)).toThrow(/iat in the future/);
  });

  test("rejects a token whose iat is non-numeric", () => {
    const iat = Math.floor(Date.now() / 1000);
    const token = forgeToken(
      { alg: "HS256", typ: "JWT" },
      { tenant_id: "tenant-a", iat: "soon", exp: iat + 300 },
      SECRET,
    );
    expect(() => verifyJwt(token, SECRET)).toThrow(/malformed iat/);
  });

  test("rejects a body with a missing tenant_id claim", () => {
    const iat = Math.floor(Date.now() / 1000);
    const token = forgeToken({ alg: "HS256", typ: "JWT" }, { iat, exp: iat + 300 }, SECRET);
    expect(() => verifyJwt(token, SECRET)).toThrow(/missing tenant_id/);
  });

  test("rejects a token whose body is not valid JSON", () => {
    // Header is valid; body decodes to non-JSON bytes; signature matches that body.
    const b64url = (s: string): string =>
      Buffer.from(s, "utf8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    const headerB64 = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const bodyB64 = b64url("this-is-not-json{");
    const data = `${headerB64}.${bodyB64}`;
    const sig = createHmac("sha256", SECRET)
      .update(data)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(() => verifyJwt(`${data}.${sig}`, SECRET)).toThrow(/malformed JWT body/);
  });

  test("rejects a token whose header is not valid JSON", () => {
    const b64url = (s: string): string =>
      Buffer.from(s, "utf8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    const headerB64 = b64url("not-json{");
    const iat = Math.floor(Date.now() / 1000);
    const bodyB64 = b64url(JSON.stringify({ tenant_id: "tenant-a", iat, exp: iat + 300 }));
    const data = `${headerB64}.${bodyB64}`;
    const sig = createHmac("sha256", SECRET)
      .update(data)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(() => verifyJwt(`${data}.${sig}`, SECRET)).toThrow(/malformed JWT header/);
  });
});

describe("createGatewayServer — injected clock + default tenant building", () => {
  test("honours an injected now() for expiry checks", async () => {
    // Token expires at T+300s. Pin the clock past expiry; the request must 401.
    const iat = 1_000_000;
    const token = signJwt({ tenant_id: "tenant-a", iat, exp: iat + 300 }, SECRET);
    const tenantA = buildTenant("tenant-a", { tenantsRoot: tmp });
    const server = createGatewayServer({
      jwtSecret: SECRET,
      tenantsRoot: tmp,
      handler: async () => ({ ok: true }),
      tenantOverrides: { "tenant-a": tenantA },
      now: () => (iat + 10_000) * 1000,
    });
    const res = await server.handle({
      bearer: token,
      body: {
        protocol: "crewhaus.v1",
        id: "1",
        method: "runs.create",
        params: { spec: "s", input: "" },
      },
    });
    expect(res).toMatchObject({
      error: { code: "unauthorized", message: expect.stringMatching(/expired/) },
    });
  });

  test("builds a tenant from tenantsRoot when no override is supplied", async () => {
    // No tenantOverrides → tenantFor() falls through to buildTenant(tenantsRoot).
    let seenRoot: string | undefined;
    const server = createGatewayServer({
      jwtSecret: SECRET,
      tenantsRoot: tmp,
      handler: async ({ tenant }) => {
        seenRoot = tenant.auditRoot;
        return { ok: true };
      },
    });
    const token = signJwt({ tenant_id: "tenant-a" }, SECRET);
    const res = await server.handle({
      bearer: token,
      body: {
        protocol: "crewhaus.v1",
        id: "1",
        method: "runs.create",
        params: { spec: "s", input: "" },
      },
    });
    expect(res).toMatchObject({ protocol: "crewhaus.v1", id: "1" });
    expect(seenRoot?.startsWith(tmp)).toBe(true);
  });

  test("builds a tenant with the package default root when tenantsRoot is omitted", async () => {
    // Neither override nor tenantsRoot → buildTenant() uses its own default root.
    // We never write to disk here: budget is exhausted first so the handler/audit
    // never runs, keeping the test free of real filesystem side effects.
    const server = createGatewayServer({
      jwtSecret: SECRET,
      handler: async () => ({ ok: true }),
    });
    server.recordUsage("tenant-a", { input: 10_000_000, output: 0 });
    const token = signJwt({ tenant_id: "tenant-a" }, SECRET);
    const res = await server.handle({
      bearer: token,
      body: {
        protocol: "crewhaus.v1",
        id: "1",
        method: "runs.create",
        params: { spec: "s", input: "" },
      },
    });
    expect(res).toMatchObject({ error: { code: "budget_exceeded" } });
  });
});

describe("budget enforcement — output dimension + internal errors", () => {
  test("exhausted output budget → 429 budget_exceeded", async () => {
    const tenantA = buildTenant("tenant-a", { tenantsRoot: tmp });
    const tinyA: Tenant = { ...tenantA, budget: { maxInputTokens: 1000, maxOutputTokens: 100 } };
    const server = createGatewayServer({
      jwtSecret: SECRET,
      tenantsRoot: tmp,
      handler: async () => ({ ok: true }),
      tenantOverrides: { "tenant-a": tinyA },
    });
    server.recordUsage("tenant-a", { input: 0, output: 100 });
    const token = signJwt({ tenant_id: "tenant-a" }, SECRET);
    const res = await server.handle({
      bearer: token,
      body: {
        protocol: "crewhaus.v1",
        id: "1",
        method: "runs.create",
        params: { spec: "s", input: "" },
      },
    });
    expect(res).toMatchObject({
      error: { code: "budget_exceeded", message: expect.stringMatching(/output tokens/) },
    });
  });

  test("a handler that rejects surfaces as 500 internal_error", async () => {
    const { server } = makeServer(async () => {
      throw new Error("handler boom");
    });
    const token = signJwt({ tenant_id: "tenant-a" }, SECRET);
    const res = await server.handle({
      bearer: token,
      body: {
        protocol: "crewhaus.v1",
        id: "1",
        method: "runs.create",
        params: { spec: "s", input: "" },
      },
    });
    expect(res).toMatchObject({
      error: { code: "internal_error", message: "handler boom" },
    });
  });

  test("a handler that throws a non-Error value is stringified into internal_error", async () => {
    // Reject with a raw (non-Error) string to exercise the server's
    // `String(err)` branch. A plain rejected promise (rather than an `async`
    // body that `throw`s a string literal) keeps the rejection reason exactly
    // "raw string failure" without tripping useAwait / noThrowLiteral.
    const { server } = makeServer(() => Promise.reject("raw string failure"));
    const token = signJwt({ tenant_id: "tenant-a" }, SECRET);
    const res = await server.handle({
      bearer: token,
      body: {
        protocol: "crewhaus.v1",
        id: "1",
        method: "runs.create",
        params: { spec: "s", input: "" },
      },
    });
    expect(res).toMatchObject({
      error: { code: "internal_error", message: "raw string failure" },
    });
  });

  test("a GatewayServerError that is neither budget nor auth maps to 400 bad_request", async () => {
    const { server } = makeServer(async () => {
      throw new GatewayServerError("some other config problem");
    });
    const token = signJwt({ tenant_id: "tenant-a" }, SECRET);
    const res = await server.handle({
      bearer: token,
      body: {
        protocol: "crewhaus.v1",
        id: "1",
        method: "runs.create",
        params: { spec: "s", input: "" },
      },
    });
    expect(res).toMatchObject({
      error: { code: "bad_request", message: "some other config problem" },
    });
  });
});

describe("statusFor — exhaustive wire code → HTTP status map", () => {
  test("maps every standard ErrorCode and falls back to 200", () => {
    expect(statusFor(ErrorCode.Unauthorized)).toBe(401);
    expect(statusFor(ErrorCode.Forbidden)).toBe(403);
    expect(statusFor(ErrorCode.NotFound)).toBe(404);
    expect(statusFor(ErrorCode.BadRequest)).toBe(400);
    expect(statusFor(ErrorCode.BudgetExceeded)).toBe(429);
    expect(statusFor(ErrorCode.InternalError)).toBe(500);
    // Unknown / empty codes fall through to the 200 default.
    expect(statusFor("totally_unknown_code")).toBe(200);
    expect(statusFor("")).toBe(200);
  });
});

describe("listen — real Bun.serve HTTP surface (loopback)", () => {
  /** Start the daemon on an ephemeral loopback port and return a teardown. */
  async function withHttp(
    server: ReturnType<typeof createGatewayServer>,
    fn: (base: string) => Promise<void>,
  ): Promise<void> {
    const { port, close } = await server.listen(0);
    expect(typeof port).toBe("number");
    expect(port).toBeGreaterThan(0);
    try {
      await fn(`http://127.0.0.1:${port}`);
    } finally {
      await close();
    }
  }

  test("authenticated POST returns 200 with the success envelope", async () => {
    const { server } = makeServer(async ({ tenant }) => ({
      runId: "run_h",
      sessionId: "sess_h",
      tenantId: tenant.id,
    }));
    const token = signJwt({ tenant_id: "tenant-a" }, SECRET);
    await withHttp(server, async (base) => {
      const res = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          protocol: PROTOCOL_VERSION,
          id: "1",
          method: "runs.create",
          params: { spec: "s", input: "hi" },
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        protocol: PROTOCOL_VERSION,
        id: "1",
        result: { runId: "run_h", sessionId: "sess_h", tenantId: "tenant-a" },
      });
    });
  });

  test("missing Authorization header returns 401", async () => {
    const { server } = makeServer();
    await withHttp(server, async (base) => {
      const res = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocol: PROTOCOL_VERSION,
          id: "1",
          method: "runs.create",
          params: { spec: "s", input: "" },
        }),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
    });
  });

  test("a non-Bearer Authorization scheme is treated as no token (401)", async () => {
    const { server } = makeServer();
    await withHttp(server, async (base) => {
      const res = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Basic abc123" },
        body: JSON.stringify({
          protocol: PROTOCOL_VERSION,
          id: "1",
          method: "runs.create",
          params: { spec: "s", input: "" },
        }),
      });
      expect(res.status).toBe(401);
    });
  });

  test("a non-JSON body returns 400 before auth is even consulted", async () => {
    const { server } = makeServer();
    await withHttp(server, async (base) => {
      const res = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer whatever" },
        body: "}{ not json",
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: { code: "bad_request", message: expect.stringMatching(/must be JSON/) },
      });
    });
  });

  test("an over-budget request returns HTTP 429", async () => {
    const tenantA = buildTenant("tenant-a", { tenantsRoot: tmp });
    const tinyA: Tenant = { ...tenantA, budget: { maxInputTokens: 50, maxOutputTokens: 50 } };
    const server = createGatewayServer({
      jwtSecret: SECRET,
      tenantsRoot: tmp,
      handler: async () => ({ ok: true }),
      tenantOverrides: { "tenant-a": tinyA },
    });
    server.recordUsage("tenant-a", { input: 50, output: 0 });
    const token = signJwt({ tenant_id: "tenant-a" }, SECRET);
    await withHttp(server, async (base) => {
      const res = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          protocol: PROTOCOL_VERSION,
          id: "1",
          method: "runs.create",
          params: { spec: "s", input: "" },
        }),
      });
      expect(res.status).toBe(429);
    });
  });

  test("binds on an explicit host argument", async () => {
    const { server } = makeServer();
    const { port, close } = await server.listen(0, "127.0.0.1");
    try {
      const token = signJwt({ tenant_id: "tenant-a" }, SECRET);
      const res = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          protocol: PROTOCOL_VERSION,
          id: "1",
          method: "runs.create",
          params: { spec: "s", input: "" },
        }),
      });
      expect(res.status).toBe(200);
    } finally {
      await close();
    }
  });
});
