/**
 * A run request reserves an estimate of what it may spend against its tenant's token
 * budget (#516): its input and an output ceiling, never zero, unless the bundle injects
 * an estimate of its own.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorCode } from "@crewhaus/gateway-protocol";
import { type Tenant, buildTenant } from "@crewhaus/tenancy";
import { DEFAULT_ESTIMATE_OUTPUT_TOKENS, estimateRunUsage } from "./estimate";
import { PROTOCOL_VERSION, createGatewayServer, signJwt } from "./index";
import { estimateUsage } from "./managed-runs";

const SECRET = ["estimate", "test", "signing", "value"].join("-");
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gateway-estimate-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("estimateRunUsage", () => {
  test("a run request reserves its input at four characters a token plus the output ceiling", () => {
    expect(estimateRunUsage({ method: "runs.create", params: { input: "a".repeat(9) } })).toEqual({
      input: 3,
      output: DEFAULT_ESTIMATE_OUTPUT_TOKENS,
    });
    expect(estimateRunUsage({ method: "runs.continue", params: { input: "" } })).toEqual({
      input: 0,
      output: DEFAULT_ESTIMATE_OUTPUT_TOKENS,
    });
  });

  test("a method that starts no model call reserves nothing", () => {
    for (const method of ["runs.cancel", "sessions.list", "audit.tail"]) {
      expect(estimateRunUsage({ method, params: {} })).toEqual({ input: 0, output: 0 });
    }
  });

  test("managed-runs reserves through the same estimate", () => {
    expect(estimateUsage).toBe(estimateRunUsage);
  });
});

describe("the request path reserves the estimate by default", () => {
  const request = (server: ReturnType<typeof createGatewayServer>) =>
    server.handle({
      bearer: signJwt({ tenant_id: "tenant-a" }, SECRET),
      body: {
        protocol: PROTOCOL_VERSION,
        id: "1",
        method: "runs.create",
        params: { spec: "s", input: "hello" },
      },
    });
  const serverWith = (over: Partial<Parameters<typeof createGatewayServer>[0]> = {}) => {
    const base = buildTenant("tenant-a", { tenantsRoot: tmp });
    // Room for the input, not for the output ceiling.
    const tenant: Tenant = { ...base, budget: { maxInputTokens: 1_000, maxOutputTokens: 100 } };
    return createGatewayServer({
      jwtSecret: SECRET,
      tenantsRoot: tmp,
      handler: async () => ({ runId: "run_x", sessionId: "sess_x", tenantId: "tenant-a" }),
      tenantOverrides: { "tenant-a": tenant },
      ...over,
    });
  };

  test("with no injected estimate, a request past the tenant's remaining tokens is refused 429 budget_exceeded", async () => {
    const res = (await request(serverWith())) as { error?: { code: string; message: string } };
    expect(res.error?.code).toBe(ErrorCode.BudgetExceeded);
    expect(res.error?.message).toContain("output tokens");
  });

  test("an injected estimate still wins: a zero estimate is admitted", async () => {
    const res = (await request(serverWith({ estimateUsage: () => ({ input: 0, output: 0 }) }))) as {
      error?: unknown;
      runId?: string;
    };
    expect(res.error).toBeUndefined();
  });
});
