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
import { classifyBoundary } from "@crewhaus/boundary-classifier";
import { type BudgetStore, InMemoryBudgetStore } from "@crewhaus/durable-state";
import { CrewhausError } from "@crewhaus/errors";
import {
  type A2AAgentCard,
  type A2AAgentProvider,
  type A2AAgentSkill,
  FEDERATION_VERSION,
  type FederationEnvelope,
  type FederationWellKnown,
  buildAgentCard,
  buildInboundResponse,
  buildWellKnown,
  decodeFederationEnvelope,
} from "@crewhaus/federation-protocol";
import {
  ErrorCode,
  GatewayProtocolError,
  type MethodT,
  PROTOCOL_VERSION,
  type ResponseEnvelopeT,
  SSE_CONTENT_TYPE,
  decodeRequest,
  encodeError,
  encodeSseComment,
  encodeSseEvent,
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

/**
 * A resolved run's live trace-event source, handed to the SSE writer for a
 * `runs.subscribe` stream. The single `open` call MUST atomically (a) snapshot
 * the buffered events to replay and (b) register a listener for subsequent live
 * events — with NO yield between the two — so the replay→live handoff neither
 * drops nor duplicates an event across the boundary (the daemon backs this with
 * `bus.recent()` immediately followed by `bus.subscribe()`, which run
 * synchronously on the single JS thread and so cannot interleave a publish).
 * `open` returns the replay snapshot plus a `close` that detaches the listener
 * (invoked when the SSE client disconnects). Events are opaque JSON
 * (`TraceEvent`) to this package.
 */
export type RunEventSource = {
  open(listener: (event: unknown) => void): {
    readonly replay: ReadonlyArray<unknown>;
    close(): void;
  };
};

/**
 * Resolve the {@link RunEventSource} for a `runs.subscribe` request, or
 * `undefined` when the run is unknown to this server OR not owned by `tenant`.
 * The two cases are DELIBERATELY indistinguishable to the caller (both answer
 * `404`), so a run's existence never leaks across tenants. The generated
 * managed daemon backs this with its per-run trace-bus registry, fenced by
 * `tenant.id`. May be async (a future daemon might resolve a persisted run).
 */
export type ResolveRunEvents = (args: {
  readonly runId: string;
  readonly tenant: Tenant;
}) => RunEventSource | undefined | Promise<RunEventSource | undefined>;

/** Default idle-heartbeat cadence for a `runs.subscribe` SSE stream. */
const DEFAULT_SSE_HEARTBEAT_MS = 15_000;

// ---------------------------------------------------------------------------
// Federation surface (Item 2 / G31) — this deployment as an A2A peer.
//
// A federation-enabled server serves three routes OUTSIDE the JWT-authed
// JSON-RPC plane:
//   GET  /.well-known/agent-card.json  — a real A2A Agent Card (metadata).
//   GET  /.well-known/crewhaus.json    — the namespaced discovery alias
//                                        carrying the cert-pin fingerprint.
//   POST /federation                   — the inbound federated-call handler.
//
// Peers authenticate via mTLS at the TLS layer (the transport floor), NOT the
// gateway's tenant JWT. `authorize` is the app-level allowlist; `dispatch`
// runs the local agent and returns its reply.
// ---------------------------------------------------------------------------

/** Context handed to the inbound `dispatch`/`authorize` hooks. */
export type FederationInboundContext = {
  readonly envelope: FederationEnvelope;
  /**
   * The peer's presented TLS client-cert subject, when the TLS terminator
   * exposed it. Undefined under the in-process `handleFederation` path and
   * whenever TLS termination happens ahead of the daemon (reverse proxy).
   */
  readonly peerCertSubject?: string;
};

/** Runs the local agent for an authorized inbound call; returns its reply. */
export type FederationInboundDispatch = (
  ctx: FederationInboundContext,
) => Promise<{ readonly reply: string }>;

export type FederationAuthorizeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * App-level peer gate, consulted AFTER envelope validation and BEFORE the
 * inbound-payload classifier + dispatch. Default (omitted): accept any
 * well-formed envelope — production wires an allowlist by
 * `envelope.federation.from.deployment` and/or a `peerCertSubject` match.
 */
export type FederationAuthorize = (ctx: FederationInboundContext) => FederationAuthorizeResult;

export type GatewayFederationConfig = {
  /** This deployment's advertised identity — the Agent Card + crewhaus.json. */
  readonly identity: {
    readonly name: string;
    readonly description: string;
    /** Public base URL (e.g. `https://dep.example`); the inbound endpoint is `<base>/federation`. */
    readonly endpoint: string;
    readonly version?: string;
    readonly supportedShapes?: readonly string[];
    /** SHA256 fingerprint (64-char hex) of this deployment's leaf cert. */
    readonly publicKeyFingerprint: string;
    readonly skills?: readonly A2AAgentSkill[];
    readonly provider?: A2AAgentProvider;
  };
  readonly dispatch: FederationInboundDispatch;
  readonly authorize?: FederationAuthorize;
};

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
  /**
   * Ops item 37 — the SLO intake gate. Consulted at request admission (BEFORE
   * the budget reservation): when it returns `{ paused: true }`, the request is
   * refused down the SAME `429 budget_exceeded` path used for budget overruns,
   * so an operator (or the SLO monitor's `pause-intake` rung, which flips the
   * durable `.crewhaus/slo/intake.json` file this reader watches) can shed load
   * on a sustained SLO breach. A resumed gate (`paused:false`) admits normally.
   * Default: undefined ⇒ never paused (behaviour-preserving). Synchronous +
   * cheap — the file-backed reader caches with a short TTL so admission stays
   * hot.
   */
  readonly intakeGate?: () => { readonly paused: boolean; readonly reason?: string };
  /**
   * Contract item 3 — resolver for `runs.subscribe` SSE streams. When set, a
   * `runs.subscribe` request (authenticated + tenant-scoped exactly like every
   * other method) resolves the run's per-run trace bus through this seam and
   * the daemon streams its buffered-then-live trace events as
   * `text/event-stream`. Omitted ⇒ `runs.subscribe` answers `404` (the server
   * exposes no run event streams — behaviour-preserving for gateways that only
   * do request/reply).
   */
  readonly resolveRunEvents?: ResolveRunEvents;
  /**
   * Idle-heartbeat cadence (ms) for an open `runs.subscribe` stream; a `:`
   * comment frame is written this often so proxies don't reap an idle
   * connection. Defaults to {@link DEFAULT_SSE_HEARTBEAT_MS}.
   */
  readonly sseHeartbeatMs?: number;
  /**
   * Item 2 (G31) — enable this deployment as an A2A federation peer. When set,
   * the server serves `/.well-known/agent-card.json`, `/.well-known/crewhaus.json`
   * and `POST /federation` (all OUTSIDE the JWT plane — see
   * {@link GatewayFederationConfig}). Omitted ⇒ those routes answer `404`
   * (behaviour-preserving for a non-federated gateway).
   */
  readonly federation?: GatewayFederationConfig;
  /**
   * `crewhaus.control.v1` — the PUBLIC-port gate, consulted before every other
   * route under `listen()`. The control plane's `publicGate` returns a
   * `Response` for the bare unauthenticated `GET /healthz` liveness check (the
   * check deployment scaffolds declare and no daemon served), and — once a
   * `POST /control/v1/drain` has landed — a `503` + `Retry-After` for
   * everything else, so intake stops while in-flight turns finish.
   *
   * Returning `undefined` falls through to the normal routing, so a gateway
   * without a control plane behaves exactly as before this seam existed. The
   * CONTROL routes themselves are never served here: they live on their own
   * loopback-bound port.
   */
  readonly publicGate?: (req: Request) => Response | undefined;
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
   * Contract item 3 — open a `runs.subscribe` SSE stream. Verifies `bearer`
   * and resolves the tenant exactly as {@link handle} does, then returns a
   * `text/event-stream` Response that replays the run's buffered trace events
   * and live-streams new ones — or a JSON error Response (401/404/…) with the
   * mapped status. `signal` (the request's AbortSignal under `listen()`) tears
   * the stream down, unsubscribes, and clears the heartbeat on client
   * disconnect. Used directly by tests; the HTTP layer routes `runs.subscribe`
   * POSTs here automatically.
   */
  subscribe(request: {
    readonly bearer?: string;
    readonly body: unknown;
    readonly signal?: AbortSignal;
  }): Promise<Response>;
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
  /**
   * Item 2 (G31) — the A2A Agent Card served at `/.well-known/agent-card.json`,
   * or `undefined` when federation is not configured. Exposed so tests + the
   * generated daemon can inspect the exact card without an HTTP round-trip.
   */
  federationAgentCard(): A2AAgentCard | undefined;
  /** The `/.well-known/crewhaus.json` discovery alias, or `undefined` when federation is off. */
  federationWellKnown(): FederationWellKnown | undefined;
  /**
   * Item 2 (G31) — drive one inbound federated call exactly as the HTTP
   * `POST /federation` route does (decode → authorize → classify → dispatch →
   * map to A2A message), returning the raw `{status, body}` the peer receives.
   * Used by tests + any embedder that terminates TLS itself. Answers `404`
   * when federation is not configured.
   */
  handleFederation(request: {
    readonly body: unknown;
    readonly peerCertSubject?: string;
  }): Promise<{ status: number; body: string }>;
}

const ZERO_USAGE: UsageDelta = { input: 0, output: 0 };

export function createGatewayServer(opts: CreateGatewayServerOptions): GatewayServer {
  // Budget accounting (recorded usage + in-flight reservations) lives behind
  // the BudgetStore seam; the in-memory default preserves the pre-seam
  // per-process semantics verbatim.
  const budget = opts.budgetStore ?? new InMemoryBudgetStore();
  const auditLogByTenant = new Map<string, AuditLog>();
  const now = opts.now ?? Date.now;

  // Item 2 (G31) — precompute the federation identity documents once. The
  // Agent Card's `url` is the concrete inbound endpoint (`<base>/federation`);
  // the crewhaus.json alias carries the base `endpoint` the router appends
  // `/federation` to (kept in lock-step with `@crewhaus/federation-router`) plus
  // the cert-pin fingerprint the A2A card omits.
  const fed = opts.federation;
  const fedBase = fed !== undefined ? fed.identity.endpoint.replace(/\/+$/, "") : "";
  const fedAgentCard: A2AAgentCard | undefined =
    fed !== undefined
      ? buildAgentCard({
          name: fed.identity.name,
          description: fed.identity.description,
          url: `${fedBase}/federation`,
          ...(fed.identity.version !== undefined ? { version: fed.identity.version } : {}),
          ...(fed.identity.skills !== undefined ? { skills: fed.identity.skills } : {}),
          ...(fed.identity.provider !== undefined ? { provider: fed.identity.provider } : {}),
        })
      : undefined;
  const fedWellKnown: FederationWellKnown | undefined =
    fed !== undefined
      ? buildWellKnown({
          endpoint: fedBase,
          publicKeyFingerprint: fed.identity.publicKeyFingerprint,
          version: FEDERATION_VERSION,
          ...(fed.identity.supportedShapes !== undefined
            ? { supportedShapes: fed.identity.supportedShapes }
            : {}),
        })
      : undefined;

  /**
   * Handle one inbound `POST /federation` call. Pipeline: decode + strict
   * version-check the envelope → app-level `authorize` → Pillar 3 classify the
   * payload at origin "federation" (a malicious verdict REFUSES rather than
   * running the local agent on an injection) → `dispatch` to the local run →
   * map the reply onto A2A message semantics. Returns the raw `{status, body}`
   * so both the HTTP route and the in-process `handleFederation` method share
   * one implementation.
   */
  async function handleFederationInbound(
    body: unknown,
    peerCertSubject: string | undefined,
  ): Promise<{ status: number; body: string }> {
    if (fed === undefined) {
      return { status: 404, body: JSON.stringify({ error: "federation is not enabled" }) };
    }
    let envelope: FederationEnvelope;
    try {
      envelope = decodeFederationEnvelope(typeof body === "string" ? body : JSON.stringify(body));
    } catch (err) {
      return { status: 400, body: JSON.stringify({ error: (err as Error).message }) };
    }
    const ctx: FederationInboundContext = {
      envelope,
      ...(peerCertSubject !== undefined ? { peerCertSubject } : {}),
    };
    // App-level authorization. mTLS at the TLS layer authenticated *who* the
    // peer is; this gate decides *whether* the peer is allowed (allowlist /
    // cert-subject match). Authentication ≠ authorization ≠ classification.
    const auth = fed.authorize ? fed.authorize(ctx) : { ok: true as const };
    if (!auth.ok) {
      return { status: 403, body: JSON.stringify({ error: `federation denied: ${auth.reason}` }) };
    }
    // Pillar 3 boundary site — the inbound payload is untrusted external
    // content (origin "federation"). Classify BEFORE it reaches the local run;
    // a malicious verdict refuses the call outright instead of dispatching an
    // injection into the agent. (Symmetric to the router's client-side reply
    // classification — the source side of the same boundary.)
    const boundary = await classifyBoundary(envelope.payload, { origin: "federation" });
    if (boundary.action === "redact") {
      return {
        status: 200,
        body: JSON.stringify(
          buildInboundResponse(
            "[federation] request refused: inbound payload failed the safety classifier.",
            { contextId: envelope.traceparent },
          ),
        ),
      };
    }
    let reply: string;
    try {
      reply = (await fed.dispatch(ctx)).reply;
    } catch (err) {
      return { status: 500, body: JSON.stringify({ error: (err as Error).message }) };
    }
    // Map the completed local run's reply onto A2A message semantics (role
    // "agent", one text part) beside the router-compatible `reply` string.
    return {
      status: 200,
      body: JSON.stringify(buildInboundResponse(reply, { contextId: envelope.traceparent })),
    };
  }

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
      // Ops item 37 — SLO intake gate. When the durable gate is paused (an
      // operator or the SLO monitor's `pause-intake` rung on a sustained
      // breach), shed the request down the SAME 429 `budget_exceeded` path used
      // for budget overruns. Checked AFTER auth (so a bad token still 401s) and
      // BEFORE the budget reservation (so we don't reserve/release for a request
      // we're about to refuse). The `budget exceeded` prefix routes it to
      // ErrorCode.BudgetExceeded in the catch below.
      const gate = opts.intakeGate?.();
      if (gate?.paused === true) {
        throw new GatewayServerError(
          `budget exceeded: intake paused (SLO)${gate.reason !== undefined ? ` — ${gate.reason}` : ""}`,
        );
      }
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
      return errorEnvelopeFor(err, id);
    }
  }

  /**
   * Open a `runs.subscribe` SSE stream. Runs the SAME admission as
   * `handleEnvelope` (bearer → `verifyJwt` → `tenantFor` → `decodeRequest`) but
   * DEVIATES after admission: no budget reservation (a long-lived read-only
   * stream carries no token cost and must not pin a reservation for its whole
   * lifetime) and no intake-gate shedding (observability must stay reachable
   * during a load-shed). On success it returns the streaming Response; every
   * failure maps through the same {@link errorEnvelopeFor} table as the JSON
   * path, rendered as a JSON error Response with the mapped HTTP status.
   */
  async function handleSubscribe(
    envelope: unknown,
    bearer: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    let id = "?";
    try {
      if (typeof bearer !== "string" || bearer === "") {
        return errorResponse(encodeError("?", ErrorCode.Unauthorized, "missing bearer token"));
      }
      const claims = verifyJwt(bearer, opts.jwtSecret, now);
      const tenant = tenantFor(claims);
      const decoded = decodeRequest(envelope);
      id = decoded.id;
      if (decoded.method !== "runs.subscribe") {
        return errorResponse(
          encodeError(id, ErrorCode.BadRequest, "subscribe() requires runs.subscribe"),
        );
      }
      if (opts.resolveRunEvents === undefined) {
        return errorResponse(
          encodeError(id, ErrorCode.NotFound, "runs.subscribe is not supported by this server"),
        );
      }
      const runId = (decoded.params as { runId: string }).runId;
      // Audit the subscription (who streamed which run) — best-effort so an
      // audit-write failure never denies a read-only stream.
      try {
        const log = await getAuditLog(tenant);
        await log.append({
          kind: "gateway_request",
          payload: { method: "runs.subscribe", tenantId: tenant.id, runId, sub: claims.sub },
        });
      } catch {
        /* best-effort audit — streaming proceeds regardless */
      }
      // Tenant scoping is enforced INSIDE the resolver (the daemon fences its
      // per-run bus registry by tenant); an unknown OR cross-tenant runId
      // returns undefined and is answered 404 — indistinguishable, so a run's
      // existence never leaks across tenants.
      const source = await opts.resolveRunEvents({ runId, tenant });
      if (source === undefined) {
        return errorResponse(encodeError(id, ErrorCode.NotFound, `no such run: ${runId}`));
      }
      return sseResponse(source, signal, opts.sseHeartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS);
    } catch (err) {
      return errorResponse(errorEnvelopeFor(err, id));
    }
  }

  return {
    async listen(port, host = "127.0.0.1"): Promise<{ port: number; close: () => Promise<void> }> {
      const server = Bun.serve({
        port,
        hostname: host,
        fetch: async (req): Promise<Response> => {
          // control.v1 — liveness + drain shed, BEFORE anything reads a body:
          // a draining daemon must refuse new work without first parsing it,
          // and `/healthz` must answer even while draining or a PaaS reaps the
          // process mid-drain.
          const gated = opts.publicGate?.(req);
          if (gated !== undefined) return gated;
          // Item 2 (G31) — the federation surface is served OUTSIDE the JWT
          // plane (peers authenticate via mTLS, not the tenant bearer). Route
          // it first so a federation request never hits the JSON-RPC decoder.
          const pathname = new URL(req.url).pathname;
          if (req.method === "GET" && pathname === "/.well-known/agent-card.json") {
            return fedAgentCard !== undefined
              ? Response.json(fedAgentCard)
              : Response.json({ error: "federation is not enabled" }, { status: 404 });
          }
          if (req.method === "GET" && pathname === "/.well-known/crewhaus.json") {
            return fedWellKnown !== undefined
              ? Response.json(fedWellKnown)
              : Response.json({ error: "federation is not enabled" }, { status: 404 });
          }
          if (req.method === "POST" && pathname === "/federation") {
            let fbody: unknown;
            try {
              fbody = await req.json();
            } catch {
              return Response.json({ error: "request body must be JSON" }, { status: 400 });
            }
            // The presented TLS client-cert subject is not surfaced by Bun's
            // fetch handler; a TLS terminator ahead of the daemon supplies it
            // (follow-up). Undefined here ⇒ `authorize` gates on the envelope.
            const out = await handleFederationInbound(fbody, undefined);
            return new Response(out.body, {
              status: out.status,
              headers: { "content-type": "application/json" },
            });
          }
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
          // `runs.subscribe` upgrades to a `text/event-stream`; divert it
          // BEFORE the JSON handler so it never gets wrapped in an envelope.
          // `req.signal` aborts on client disconnect → the stream tears down.
          if (isSubscribeBody(body)) {
            return handleSubscribe(body, bearer, req.signal);
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
    subscribe(req): Promise<Response> {
      return handleSubscribe(req.body, req.bearer, req.signal);
    },
    recordUsage(tenantId, delta): Promise<void> {
      return budget.recordUsage(tenantId, delta);
    },
    usage(tenantId): Promise<{ input: number; output: number }> {
      return budget.usage(tenantId);
    },
    getAuditLog,
    federationAgentCard(): A2AAgentCard | undefined {
      return fedAgentCard;
    },
    federationWellKnown(): FederationWellKnown | undefined {
      return fedWellKnown;
    },
    handleFederation(req): Promise<{ status: number; body: string }> {
      return handleFederationInbound(req.body, req.peerCertSubject);
    },
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

/**
 * Map a thrown admission/handler error to its wire `ResponseEnvelope`. Shared
 * by the JSON request/reply path ({@link handleEnvelope}) and the
 * `runs.subscribe` SSE path so both classify identically:
 *   - `GatewayProtocolError` (decode failures) → `bad_request`
 *   - `GatewayServerError` starting `budget exceeded` → `budget_exceeded`
 *   - `GatewayServerError`/tenancy auth failures (`JWT …`, `malformed JWT …`,
 *     `invalid tenantId`, `TenancyError`) → `unauthorized`
 *   - any other `GatewayServerError` → `bad_request`
 *   - anything else → `internal_error`
 */
function errorEnvelopeFor(err: unknown, id: string): ResponseEnvelopeT {
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

/** Render an error `ResponseEnvelope` as a JSON Response with the mapped status. */
function errorResponse(envelope: ResponseEnvelopeT): Response {
  const code = "error" in envelope ? envelope.error.code : "";
  return Response.json(envelope, { status: statusFor(code) });
}

/** True when a parsed request body is a `runs.subscribe` call (peeked before
 *  full decode so the HTTP layer can divert it to the SSE writer). */
function isSubscribeBody(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { method?: unknown }).method === "runs.subscribe"
  );
}

/**
 * Build the `runs.subscribe` `text/event-stream` Response from a resolved
 * {@link RunEventSource}. Lifecycle:
 *   1. write a `: open` comment so proxies flush headers immediately;
 *   2. `source.open()` — atomically snapshot the ring buffer AND attach the
 *      live listener (gap-free / dup-free across the replay→live boundary);
 *   3. replay the snapshot as `data:` frames, then live events as they arrive;
 *   4. write a `: heartbeat` comment every `heartbeatMs` so an idle stream is
 *      not reaped by intermediaries;
 *   5. on client disconnect (`signal` abort), stream cancel, or an enqueue
 *      into an already-closed controller, run teardown ONCE (idempotent via
 *      `torn`): clear the heartbeat, unsubscribe the listener, drop the abort
 *      handler, and close the controller.
 */
function sseResponse(
  source: RunEventSource,
  signal: AbortSignal | undefined,
  heartbeatMs: number,
): Response {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let subscription: { readonly replay: ReadonlyArray<unknown>; close(): void } | undefined;
  let onAbort: (() => void) | undefined;
  let torn = false;

  const teardown = (): void => {
    if (torn) return;
    torn = true;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    subscription?.close();
    if (signal !== undefined && onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = (chunk: string): void => {
        if (torn) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Controller already closed (client vanished mid-write): tear down.
          teardown();
        }
      };
      const closeStream = (): void => {
        teardown();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      enqueue(encodeSseComment("open"));

      // Atomic snapshot + live-subscribe (see RunEventSource.open): no event is
      // lost or double-delivered across the replay/live boundary.
      try {
        subscription = source.open((event) => enqueue(encodeSseEvent(event)));
      } catch (err) {
        enqueue(encodeSseComment(`error: ${err instanceof Error ? err.message : String(err)}`));
        closeStream();
        return;
      }
      for (const event of subscription.replay) enqueue(encodeSseEvent(event));

      // Heartbeat comments keep intermediaries from timing the idle stream out.
      // `unref` (when available) keeps the interval from, by itself, holding a
      // daemon's event loop open.
      heartbeat = setInterval(() => enqueue(encodeSseComment("heartbeat")), heartbeatMs);
      (heartbeat as { unref?: () => void }).unref?.();

      // Client disconnect aborts the request signal → tear the stream down.
      if (signal !== undefined) {
        if (signal.aborted) {
          closeStream();
          return;
        }
        onAbort = closeStream;
        signal.addEventListener("abort", onAbort);
      }
    },
    cancel() {
      // The consumer released the stream (e.g. reader.cancel()).
      teardown();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": SSE_CONTENT_TYPE,
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Defeat proxy buffering (nginx) so events flush as they're written.
      "x-accel-buffering": "no",
    },
  });
}

export { PROTOCOL_VERSION };
