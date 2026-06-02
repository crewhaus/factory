import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Tenant, buildTenant } from "@crewhaus/tenancy";
import { createGatewayServer, signJwt, verifyJwt } from "./index";

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
});
