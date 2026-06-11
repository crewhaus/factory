/**
 * Catalog R16 `gateway-server` — Bun.serve daemon speaking
 * `@crewhaus/gateway-protocol` over JSON-over-HTTP.
 *
 * Auth: HS256 JWT bearer tokens. Token claims must include
 * `tenant_id`, an `iat` not in the future, and an `exp` in the future.
 * The signing secret is verified against `opts.jwtSecret`. Tokens are
 * NEVER minted by the daemon — they're issued by an external IDP and
 * the daemon only verifies. (For the smoke test we mint with the same
 * helper for convenience; production has a separate IDP.)
 *
 * Per-tenant scoping: every authenticated request runs inside
 * `withTenant(tenant, ...)` so storage adapters rebase under the
 * tenant root and cross-tenant reads throw at the storage layer
 * (defense in depth — `policy-engine` would refuse before that, but
 * the storage guard is the floor).
 *
 * Budget enforcement: each tenant has `budget.maxInputTokens` /
 * `maxOutputTokens`. The daemon tracks cumulative usage in memory
 * (file-backed in production) and refuses with `429
 * budget_exceeded` once the limit is reached. Run handlers report
 * usage via `recordUsage(tenantId, { input, output })`.
 *
 * Layer R16. Pairs with `gateway-protocol`, `tenancy`, `audit-log`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { type AppendInput, type AuditLog, openAuditLog } from "@crewhaus/audit-log";
import { type BudgetStore, InMemoryBudgetStore } from "@crewhaus/durable-state";
import { CrewhausError } from "@crewhaus/errors";
import {
  ErrorCode,
  GatewayProtocolError,
  type MethodT,
  PROTOCOL_VERSION,
  decodeRequest,
  encodeError,
  encodeSuccess,
} from "@crewhaus/gateway-protocol";
import { type Tenant, buildTenant, validateTenantId, withTenant } from "@crewhaus/tenancy";

export class GatewayServerError extends CrewhausError {
  override readonly name = "GatewayServerError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type JwtClaims = {
  readonly tenant_id: string;
  readonly iat?: number;
  readonly exp?: number;
  readonly sub?: string;
};

// ---------------------------------------------------------------------------
// HS256 JWT — minimal verifier and signer (no external deps).
// ---------------------------------------------------------------------------

/** Only HS256 is accepted — guards against `alg` confusion (e.g. `none`). */
const JWT_ALG = "HS256";
/** Only compact JWS bearer tokens are accepted. */
const JWT_TYP = "JWT";
/** Reject tokens whose lifetime (`exp - iat`) exceeds this when `iat` is present. */
const MAX_JWT_LIFETIME_SECONDS = 24 * 60 * 60;
/** Allowed clock skew when checking `iat` is not in the future. */
const IAT_SKEW_MS = 60_000;

type JwtHeader = {
  readonly alg?: string;
  readonly typ?: string;
};

function b64urlEncode(input: Uint8Array | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  return Buffer.from(padded, "base64");
}

export function signJwt(claims: JwtClaims, secret: string): string {
  // Convenience minter (tests + smoke only). Default `iat`/`exp` so emitted
  // tokens satisfy the verifier's mandatory-`exp` + bounded-lifetime contract;
  // production tokens come from an external IDP.
  const iat = claims.iat ?? Math.floor(Date.now() / 1000);
  const exp = claims.exp ?? iat + 60 * 60;
  const header = b64urlEncode(JSON.stringify({ alg: JWT_ALG, typ: JWT_TYP }));
  const body = b64urlEncode(JSON.stringify({ ...claims, iat, exp }));
  const data = `${header}.${body}`;
  const sig = createHmac("sha256", secret).update(data).digest();
  return `${data}.${b64urlEncode(sig)}`;
}

export function verifyJwt(token: string, secret: string, now: () => number = Date.now): JwtClaims {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new GatewayServerError("malformed JWT — expected 3 segments");
  }
  const [headerB64, bodyB64, sigB64] = parts as [string, string, string];
  // Validate the header (alg/typ) BEFORE spending an HMAC — rejects
  // `alg: none` / algorithm-confusion tokens up front.
  let header: JwtHeader;
  try {
    header = JSON.parse(b64urlDecode(headerB64).toString("utf8")) as JwtHeader;
  } catch (err) {
    throw new GatewayServerError("malformed JWT header", err);
  }
  if (header.alg !== JWT_ALG) {
    throw new GatewayServerError(`JWT unsupported alg — expected ${JWT_ALG}`);
  }
  if (header.typ !== JWT_TYP) {
    throw new GatewayServerError(`JWT unsupported typ — expected ${JWT_TYP}`);
  }
  const data = `${headerB64}.${bodyB64}`;
  const expected = createHmac("sha256", secret).update(data).digest();
  let actual: Buffer;
  try {
    actual = b64urlDecode(sigB64);
  } catch (err) {
    throw new GatewayServerError("malformed JWT signature segment", err);
  }
  if (
    expected.length !== actual.length ||
    !timingSafeEqual(new Uint8Array(expected), new Uint8Array(actual))
  ) {
    throw new GatewayServerError("JWT signature mismatch");
  }
  let claims: JwtClaims;
  try {
    claims = JSON.parse(b64urlDecode(bodyB64).toString("utf8")) as JwtClaims;
  } catch (err) {
    throw new GatewayServerError("malformed JWT body", err);
  }
  if (typeof claims.tenant_id !== "string") {
    throw new GatewayServerError("JWT missing tenant_id claim");
  }
  validateTenantId(claims.tenant_id);
  const nowMs = now();
  // `exp` is mandatory — an absent (or non-numeric) `exp` must not mean
  // "never expires" (CWE-613).
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    throw new GatewayServerError("JWT missing exp claim");
  }
  if (claims.exp * 1000 <= nowMs) {
    throw new GatewayServerError("JWT expired");
  }
  if (claims.iat !== undefined) {
    if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat)) {
      throw new GatewayServerError("JWT malformed iat claim");
    }
    if (claims.iat * 1000 > nowMs + IAT_SKEW_MS) {
      throw new GatewayServerError("JWT iat in the future");
    }
    // Bound the maximum lifetime — a token cannot outlive its `iat` by more
    // than the configured ceiling.
    if (claims.exp - claims.iat > MAX_JWT_LIFETIME_SECONDS) {
      throw new GatewayServerError("JWT lifetime exceeds maximum");
    }
  }
  return claims;
}

// ---------------------------------------------------------------------------
// Server contract.
// ---------------------------------------------------------------------------

export type RunHandler = (args: {
  readonly method: MethodT;
  readonly params: unknown;
  readonly tenant: Tenant;
}) => Promise<unknown>;

export type CreateGatewayServerOptions = {
  readonly jwtSecret: string;
  readonly tenantsRoot?: string;
  readonly handler: RunHandler;
  /**
   * Optional: pre-built tenants override the default `buildTenant`
   * (used by tests + the smoke to inject in-memory budgets without
   * reading them from disk).
   */
  readonly tenantOverrides?: Readonly<Record<string, Tenant>>;
  readonly now?: () => number;
  /**
   * Optional per-request cost estimate. It is RESERVED against the tenant's
   * budget before the handler runs and released after — closing the TOCTOU
   * where concurrent requests all pass `checkBudget` (which only sees
   * already-recorded usage) before any of them records its usage, each then
   * running to full cost. A generic gateway can't know token costs, so supply
   * a realistic estimate here to bound in-flight spend; the default reserves
   * nothing (behavior-preserving). Actual usage is still recorded out-of-band
   * via `recordUsage`.
   */
  readonly estimateUsage?: (args: {
    readonly method: MethodT;
    readonly params: unknown;
    readonly tenant: Tenant;
  }) => UsageDelta;
  /**
   * Pluggable budget accounting (audit follow-up R3). Default: in-memory —
   * per-process semantics identical to before the seam existed. Multi-process
   * single-host deployments pass a `SqliteBudgetStore` (or a spec-built store
   * via `createBudgetStore("sqlite:<path>")`) so every replica reserves and
   * records against the SAME counters; multi-host deployments implement
   * `BudgetStore` against a network store. Without this, N replicas multiply
   * every tenant budget by N.
   */
  readonly budgetStore?: BudgetStore;
};

export type UsageDelta = {
  readonly input: number;
  readonly output: number;
};

export interface GatewayServer {
  /**
   * Start listening on `port`. Returns the bound port (useful when
   * caller passed 0 to ask the kernel for a free port).
   */
  listen(port: number, host?: string): Promise<{ port: number; close: () => Promise<void> }>;
  /**
   * Single-request entrypoint — used by tests to drive the daemon
   * without HTTP overhead. Verifies `bearer` exactly the same way the
   * HTTP layer does.
   */
  handle(request: { readonly bearer?: string; readonly body: unknown }): Promise<unknown>;
  /**
   * Record token usage against a tenant's running total. Async since the
   * budget store may be durable (audit R3); await it so usage is committed
   * before the response is considered complete.
   */
  recordUsage(tenantId: string, delta: UsageDelta): Promise<void>;
  /** Read current usage (mostly for tests). */
  usage(tenantId: string): Promise<{ input: number; output: number }>;
  /** Get or build the audit log for a tenant. Memoised. */
  getAuditLog(tenant: Tenant): Promise<AuditLog>;
}

const ZERO_USAGE: UsageDelta = { input: 0, output: 0 };

export function createGatewayServer(opts: CreateGatewayServerOptions): GatewayServer {
  // Budget accounting (recorded usage + in-flight reservations) lives behind
  // the BudgetStore seam; the in-memory default preserves the pre-seam
  // per-process semantics verbatim.
  const budget = opts.budgetStore ?? new InMemoryBudgetStore();
  const auditLogByTenant = new Map<string, AuditLog>();
  const now = opts.now ?? Date.now;

  function tenantFor(claims: JwtClaims): Tenant {
    const override = opts.tenantOverrides?.[claims.tenant_id];
    if (override !== undefined) return override;
    return buildTenant(claims.tenant_id, {
      ...(opts.tenantsRoot !== undefined ? { tenantsRoot: opts.tenantsRoot } : {}),
    });
  }

  async function getAuditLog(tenant: Tenant): Promise<AuditLog> {
    const cached = auditLogByTenant.get(tenant.id);
    if (cached !== undefined) return cached;
    const log = await openAuditLog({ rootDir: tenant.auditRoot });
    auditLogByTenant.set(tenant.id, log);
    return log;
  }

  async function handleEnvelope(envelope: unknown, bearer: string | undefined): Promise<unknown> {
    let id = "?";
    try {
      if (typeof bearer !== "string" || bearer === "") {
        return encodeError("?", ErrorCode.Unauthorized, "missing bearer token");
      }
      const claims = verifyJwt(bearer, opts.jwtSecret, now);
      const tenant = tenantFor(claims);
      const decoded = decodeRequest(envelope);
      id = decoded.id;
      // Atomically reserve the estimated cost against recorded + in-flight
      // usage (the store refuses when the total would exceed the budget on
      // either dimension) — then release once the request finishes (actual
      // usage is recorded out-of-band via recordUsage in the meantime). The
      // check-and-reserve is a single atomic store operation so concurrent
      // requests — including ones in OTHER processes sharing a durable
      // store — can't all slip past the cap.
      const estimate =
        opts.estimateUsage?.({ method: decoded.method, params: decoded.params, tenant }) ??
        ZERO_USAGE;
      const reservation = await budget.tryReserve(tenant.id, estimate, tenant.budget);
      if (!reservation.ok) {
        throw new GatewayServerError(
          `budget exceeded: ${reservation.reason} tokens ${reservation.total}/${reservation.limit}`,
        );
      }
      try {
        // Audit every authenticated gateway request.
        const log = await getAuditLog(tenant);
        const requestPayload: AppendInput["payload"] = {
          method: decoded.method,
          tenantId: tenant.id,
          sub: claims.sub,
        };
        await log.append({ kind: "gateway_request", payload: requestPayload });
        const result = await withTenant(tenant, () =>
          opts.handler({ method: decoded.method, params: decoded.params, tenant }),
        );
        return encodeSuccess(id, result);
      } finally {
        await budget.release(tenant.id, estimate);
      }
    } catch (err) {
      if (err instanceof GatewayProtocolError) {
        return encodeError(id, ErrorCode.BadRequest, err.message);
      }
      if (err instanceof GatewayServerError) {
        if (err.message.startsWith("budget exceeded")) {
          return encodeError(id, ErrorCode.BudgetExceeded, err.message);
        }
        // JWT failures and tenant-id failures both map to 401.
        if (
          err.message.startsWith("JWT ") ||
          err.message.startsWith("malformed JWT") ||
          err.message.startsWith("invalid tenantId")
        ) {
          return encodeError(id, ErrorCode.Unauthorized, err.message);
        }
        return encodeError(id, ErrorCode.BadRequest, err.message);
      }
      // Tenancy validateTenantId throws TenancyError; map to 401.
      if (err instanceof Error && err.name === "TenancyError") {
        return encodeError(id, ErrorCode.Unauthorized, err.message);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return encodeError(id, ErrorCode.InternalError, msg);
    }
  }

  return {
    async listen(port, host = "127.0.0.1"): Promise<{ port: number; close: () => Promise<void> }> {
      const server = Bun.serve({
        port,
        hostname: host,
        fetch: async (req): Promise<Response> => {
          const auth = req.headers.get("authorization") ?? "";
          const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return Response.json(
              encodeError("?", ErrorCode.BadRequest, "request body must be JSON"),
              { status: 400 },
            );
          }
          const out = await handleEnvelope(body, bearer);
          // Map error codes back to HTTP status for ergonomics.
          const status =
            out !== null && typeof out === "object" && "error" in out
              ? statusFor((out as { error: { code: string } }).error.code ?? "")
              : 200;
          return Response.json(out, { status });
        },
      });
      return {
        port: server.port ?? port,
        async close(): Promise<void> {
          server.stop();
        },
      };
    },
    handle(req): Promise<unknown> {
      return handleEnvelope(req.body, req.bearer);
    },
    recordUsage(tenantId, delta): Promise<void> {
      return budget.recordUsage(tenantId, delta);
    },
    usage(tenantId): Promise<{ input: number; output: number }> {
      return budget.usage(tenantId);
    },
    getAuditLog,
  };
}

/**
 * Map a wire `ErrorCode` to its HTTP status. Exported so reference clients
 * and embedders can render the same status the daemon's HTTP layer does.
 * Exhaustive over {@link ErrorCode}; unknown codes fall back to `200`.
 */
export function statusFor(code: string): number {
  switch (code) {
    case ErrorCode.Unauthorized:
      return 401;
    case ErrorCode.Forbidden:
      return 403;
    case ErrorCode.NotFound:
      return 404;
    case ErrorCode.BadRequest:
      return 400;
    case ErrorCode.BudgetExceeded:
      return 429;
    case ErrorCode.InternalError:
      return 500;
    default:
      return 200;
  }
}

export { PROTOCOL_VERSION };
