/**
 * @crewhaus/federation-router — Section 34
 *
 * Forward-looking: this package is the programmatic client for routing a
 * sub-agent call to a *federated* peer deployment (over mTLS) instead of
 * spawning it locally via `@crewhaus/sub-agent-spawner`. It is not yet
 * wired into the runtime — there is no `federation` field in the spec's
 * sub-agent definition, and `@crewhaus/runtime-core` does not import this
 * package. A caller drives it directly through `createFederationRouter`
 * and the returned `router.call({ fromRole, to: { deployment, role },
 * payload, kind })`.
 *
 * Flow (per `call`):
 *   1. Look up the peer's endpoint + cert fingerprint via
 *      `@crewhaus/federation-discovery`.
 *   2. Build a `FederationEnvelope` carrying the question payload + the
 *      caller's traceparent (W3C trace-context propagation).
 *   3. POST the envelope via `federationCall` (mTLS HTTPS).
 *   4. Decode the response body as `{ reply: string }` and return.
 *
 * Errors map to `@crewhaus/recovery-engine` taxonomy:
 *   - `network` (connection refused, timeout) → `recover` returns
 *     `{ kind: "retry", delayMs: ... }` — the runtime will retry with
 *     exponential backoff.
 *   - `auth` (cert pinning mismatch, wrong CA) → `recover` returns
 *     `{ kind: "tombstone", messageId }` — the federated subagent call
 *     produces a clear failure message in the agent transcript.
 */
import { classifyBoundary } from "@crewhaus/boundary-classifier";
import { CrewhausError } from "@crewhaus/errors";
import { type Discovery, createDiscovery } from "@crewhaus/federation-discovery";
import {
  type A2AMessage,
  FEDERATION_VERSION,
  type FederationEnvelope,
  type FederationTransport,
  type MtlsCredentials,
  federationCall,
  textFromA2AMessage,
} from "@crewhaus/federation-protocol";
import { type RunContext, tagContent } from "@crewhaus/run-context";

export class FederationRouterError extends CrewhausError {
  override readonly name = "FederationRouterError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type FederationRouterConfig = {
  /** This deployment's id — used to populate `federation.from.deployment`. */
  readonly fromDeployment: string;
  /** mTLS credentials this deployment presents on every call. */
  readonly credentials: MtlsCredentials;
  /**
   * Peer-discovery instance. When omitted, a fresh discovery is created
   * — production usually wants a long-lived shared one to benefit from
   * caching.
   */
  readonly discovery?: Discovery;
  /** Optional injected transport (defaults to mTLS HTTPS). */
  readonly transport?: FederationTransport;
  /**
   * Returns the W3C traceparent for the current bus span. When omitted
   * the router emits a placeholder (which OTel will reject — wire the
   * real bus's `currentTraceparent()` in production).
   */
  readonly currentTraceparent?: () => string;
  /**
   * Pillar 3 boundary site — the per-run `RunContext` for the caller.
   * When supplied, a non-blocked peer `reply` is tagged into
   * `runContext.dataLineage` under origin `"federation"` so the sink-side
   * egress classifier sees federation-origin content on a later
   * external-scope tool call. Optional for backward-compat: the security-
   * critical half (redacting a malicious peer reply) runs regardless —
   * `tagContent` is only reachable when a runtime threads a context here.
   */
  readonly runContext?: RunContext;
};

export type RouterTraceEvent =
  | { readonly kind: "federation_call_start"; readonly to: { deployment: string; role: string } }
  | {
      readonly kind: "federation_call_end";
      readonly to: { deployment: string; role: string };
      readonly status: number;
      readonly durationMs: number;
    }
  | {
      readonly kind: "federation_call_error";
      readonly to: { deployment: string; role: string };
      readonly error: string;
    };

export type RouterTraceSubscriber = (event: RouterTraceEvent) => void;

export type FederationRouter = {
  call(args: {
    fromRole: string;
    to: { deployment: string; role: string };
    payload: string;
    kind?: "question" | "answer" | "notify";
  }): Promise<{ reply: string }>;
  /** Subscribe to router-level trace events. Returns an unsubscribe fn. */
  subscribe(listener: RouterTraceSubscriber): () => void;
};

export function createFederationRouter(config: FederationRouterConfig): FederationRouter {
  const discovery = config.discovery ?? createDiscovery();
  const subscribers = new Set<RouterTraceSubscriber>();
  const trace = (event: RouterTraceEvent) => {
    for (const listener of subscribers) {
      try {
        listener(event);
      } catch {
        // Subscribers must not crash the router.
      }
    }
  };

  return {
    async call(args) {
      const start = Date.now();
      trace({ kind: "federation_call_start", to: args.to });
      try {
        const peer = await discovery.discover(args.to.deployment);
        if (peer.version !== FEDERATION_VERSION) {
          throw new FederationRouterError(
            `peer ${args.to.deployment} speaks ${peer.version}, expected ${FEDERATION_VERSION}`,
          );
        }
        if (peer.publicKeyFingerprint !== config.credentials.pinnedFingerprint) {
          throw new FederationRouterError(
            `pinned fingerprint mismatch for ${args.to.deployment}: discovery says ${peer.publicKeyFingerprint}, local pin is ${config.credentials.pinnedFingerprint}`,
          );
        }
        const envelope: FederationEnvelope = {
          version: FEDERATION_VERSION,
          traceparent: config.currentTraceparent?.() ?? PLACEHOLDER_TRACEPARENT,
          federation: {
            from: { deployment: config.fromDeployment, role: args.fromRole },
            to: args.to,
            mtls: { client_cert_subject: subjectFromCert(config.credentials.clientCertPem) },
          },
          kind: args.kind ?? "question",
          payload: args.payload,
        };
        const result = await federationCall({
          url: `${peer.endpoint}/federation`,
          envelope,
          credentials: config.credentials,
          ...(config.transport ? { transport: config.transport } : {}),
        });
        if (result.status < 200 || result.status >= 300) {
          throw new FederationRouterError(
            `peer ${args.to.deployment} returned status ${result.status}`,
          );
        }
        let parsed: { reply?: unknown; message?: unknown };
        try {
          parsed = JSON.parse(result.body) as { reply?: unknown; message?: unknown };
        } catch (cause) {
          throw new FederationRouterError(
            `peer ${args.to.deployment} returned non-JSON body`,
            cause,
          );
        }
        // The peer's inbound handler answers with a `reply` string (the fast
        // path) AND the same text mapped onto an A2A `message` (Item 2). Prefer
        // `reply`; fall back to the A2A message's text parts so a pure-A2A peer
        // (one that answers with only `message`) also decodes. Neither present
        // ⇒ malformed.
        let replyText: string | undefined =
          typeof parsed.reply === "string" ? parsed.reply : undefined;
        if (replyText === undefined && isA2AMessage(parsed.message)) {
          replyText = textFromA2AMessage(parsed.message);
        }
        if (replyText === undefined) {
          throw new FederationRouterError(
            `peer ${args.to.deployment} response missing string 'reply' field`,
          );
        }
        // Pillar 3 boundary site — the peer `reply` is untrusted external
        // content entering local context. mTLS / cert-pin / version checks
        // above authenticated *who* the peer is; they say nothing about
        // *what* the reply contains. A malicious deployment can return a
        // prompt injection inside an authenticated channel — classify it at
        // origin "federation" (strict block default) before it reaches the
        // caller's model. On a non-blocked verdict, tag the reply into the
        // caller's data-lineage (when a RunContext was supplied) so the
        // sink-side egress classifier sees the federation origin on a later
        // external-tool call. See recipe 41 (security fabric) / 27 (federation).
        let reply = replyText;
        const fb = await classifyBoundary(reply, { origin: "federation" });
        if (fb.action === "redact" && fb.redacted !== undefined) {
          reply = fb.redacted;
        } else if (config.runContext) {
          tagContent(config.runContext, reply, "federation");
        }
        trace({
          kind: "federation_call_end",
          to: args.to,
          status: result.status,
          durationMs: Date.now() - start,
        });
        return { reply };
      } catch (err) {
        trace({
          kind: "federation_call_error",
          to: args.to,
          error: (err as Error).message,
        });
        throw err;
      }
    },

    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
  };
}

/** Structural guard for the A2A `message` fallback in a peer's inbound reply. */
function isA2AMessage(v: unknown): v is A2AMessage {
  if (typeof v !== "object" || v === null) return false;
  const m = v as { kind?: unknown; parts?: unknown };
  return m.kind === "message" && Array.isArray(m.parts);
}

const PLACEHOLDER_TRACEPARENT = "00-00000000000000000000000000000000-0000000000000000-00";

function subjectFromCert(certPem: string): string {
  // We avoid pulling X509Certificate at top level so the type is OK in
  // environments without node:crypto X509 (older bun). Lazy parse.
  try {
    const { X509Certificate } = require("node:crypto") as typeof import("node:crypto");
    const cert = new X509Certificate(certPem);
    return cert.subject;
  } catch {
    return "unknown";
  }
}

/**
 * Map a router/protocol error to the recovery-engine taxonomy. Run this
 * inside the runtime's `try/catch` around a `call()` to decide whether
 * to retry, tombstone, or surface verbatim.
 */
export type RecoveryHint =
  | { readonly kind: "retry"; readonly delayMs: number }
  | { readonly kind: "tombstone"; readonly reason: string }
  | { readonly kind: "fail"; readonly reason: string };

export function classifyRouterError(err: Error): RecoveryHint {
  const message = err.message ?? "";
  if (
    /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|federation transport timeout|peer .* unreachable/i.test(
      message,
    )
  ) {
    return { kind: "retry", delayMs: 1_000 };
  }
  if (
    /cert-pin mismatch|cert chain|certificate has expired|wrong CA|status 4[0-9][0-9]|fingerprint mismatch/i.test(
      message,
    )
  ) {
    return { kind: "tombstone", reason: message };
  }
  if (/status 5[0-9][0-9]/i.test(message)) {
    return { kind: "retry", delayMs: 2_000 };
  }
  return { kind: "fail", reason: message };
}
