/**
 * Playground server. Bun.serve under the hood. Production deployments
 * mount this behind §20 gateway-server with mTLS + JWT.
 *
 * Endpoints:
 *
 *   GET  /                — playground SPA shell (index.html)
 *   GET  /api/templates    — JSON list of scaffold templates
 *   POST /api/run          — { spec: string } → { scopedRunId, status }
 *                            consumes quota; rejects with 429 + Retry-After
 *                            when over the tier's quota
 *   GET  /api/runs/:id     — { spec, status, traceUrl } scoped to the
 *                            calling session (404 if mismatch)
 *
 * The request → response loop delegates the actual run to the injected
 * `gatewayClient` (production: §20 gateway-server). The playground
 * server itself only handles routing, quota, tenant isolation, and
 * UI shell.
 */
import { CrewhausError } from "@crewhaus/errors";

import { DEFAULT_QUOTA, type QuotaState, type Tier, enforceQuota } from "./quota";
import { playgroundIndexHtml } from "./render-html";
import { templateMenuEntries } from "./templates";
import {
  type IsolatedRunStore,
  type SessionScope,
  isolatedRunStore,
  parseRunIdScope,
} from "./tenant-isolation";

export class PlaygroundServerError extends CrewhausError {
  override readonly name = "PlaygroundServerError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/**
 * The playground delegates real spec execution to the configured
 * gateway. Production wires §20 gateway-server; tests pass a fake.
 */
export type GatewayClient = {
  startRun(args: { spec: string; tier: Tier }): Promise<{
    readonly runId: string;
    readonly status: "queued" | "running";
    readonly traceUrl: string;
  }>;
};

export type RunRecord = {
  readonly spec: string;
  readonly status: "queued" | "running" | "done" | "errored";
  readonly traceUrl: string;
};

export type PlaygroundConfig = {
  readonly studioUrl: string;
  readonly gatewayClient: GatewayClient;
  /** Read the calling session id from the request — defaults to the `sid` cookie. */
  readonly resolveSession?: (req: Request) => SessionScope;
  /** Quota tier resolver — defaults to anonymous. */
  readonly resolveTier?: (scope: SessionScope, req: Request) => Tier;
  readonly oauthClientId?: string;
  /** Test injection: in-memory clock. */
  readonly now?: () => number;
};

export type PlaygroundServerInstance = {
  fetch(req: Request): Promise<Response>;
  /** Inspect the session's current quota state — used by tests + tooling. */
  quotaFor(scope: SessionScope): QuotaState;
  runStore(): IsolatedRunStore<RunRecord>;
};

export type PlaygroundServer = PlaygroundServerInstance;

export function createPlayground(config: PlaygroundConfig): PlaygroundServerInstance {
  const runStore = isolatedRunStore<RunRecord>();
  const quotaPerSession = new Map<string, QuotaState>();
  const now = config.now ?? (() => Date.now());

  const resolveSession =
    config.resolveSession ??
    ((req: Request): SessionScope => {
      const cookie = req.headers.get("cookie") ?? "";
      const m = /(?:^|;\s*)sid=([a-zA-Z0-9_-]{8,128})/.exec(cookie);
      return { sessionId: m?.[1] ?? generateAnonSession() };
    });

  const resolveTier = config.resolveTier ?? (() => "anonymous");

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });

  return {
    quotaFor(scope) {
      return quotaPerSession.get(scope.sessionId) ?? { runs: [] };
    },

    runStore() {
      return runStore;
    },

    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const scope = resolveSession(req);
      const tier = resolveTier(scope, req);

      if (url.pathname === "/" && req.method === "GET") {
        return new Response(
          playgroundIndexHtml({
            studioUrl: config.studioUrl,
            ...(config.oauthClientId ? { oauthClientId: config.oauthClientId } : {}),
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Set-Cookie": `sid=${scope.sessionId}; Path=/; SameSite=Strict; HttpOnly`,
            },
          },
        );
      }

      if (url.pathname === "/api/templates" && req.method === "GET") {
        return json(200, { templates: templateMenuEntries() });
      }

      if (url.pathname === "/api/run" && req.method === "POST") {
        let body: { spec?: string };
        try {
          body = (await req.json()) as { spec?: string };
        } catch {
          return json(400, { error: "invalid JSON body" });
        }
        if (typeof body.spec !== "string" || body.spec.trim().length === 0) {
          return json(400, { error: "spec is required" });
        }

        const state = quotaPerSession.get(scope.sessionId) ?? { runs: [] };
        const decision = enforceQuota({
          state,
          tier,
          now: now(),
          config: DEFAULT_QUOTA[tier],
        });
        quotaPerSession.set(scope.sessionId, decision.state);
        if (!decision.accepted) {
          return json(
            429,
            { error: decision.reason },
            { "Retry-After": String(decision.retryAfterSeconds) },
          );
        }

        const result = await config.gatewayClient.startRun({ spec: body.spec, tier });
        const scopedId = runStore.put(scope, result.runId, {
          spec: body.spec,
          status: result.status,
          traceUrl: result.traceUrl,
        });
        return json(200, {
          scopedRunId: scopedId,
          status: result.status,
          remaining: decision.remaining,
        });
      }

      const runMatch = /^\/api\/runs\/([\w:-]+)$/.exec(url.pathname);
      if (runMatch && req.method === "GET") {
        const scopedId = runMatch[1] ?? "";
        const parsed = parseRunIdScope(scopedId);
        if (!parsed) return json(400, { error: "invalid scoped run id" });
        const record = runStore.get(scope, scopedId);
        if (!record) return json(404, { error: "not found" });
        return json(200, { ...record, scopedRunId: scopedId });
      }

      return json(404, { error: "not found" });
    },
  };
}

function generateAnonSession(): string {
  const r = new Uint8Array(16);
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    crypto.getRandomValues(r);
  } else {
    for (let i = 0; i < r.length; i++) r[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(r, (b) => b.toString(16).padStart(2, "0")).join("");
}
