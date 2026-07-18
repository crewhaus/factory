import { X509Certificate, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { type Agent as HttpsAgent, type RequestOptions, request as httpsRequest } from "node:https";
/**
 * @crewhaus/federation-protocol — Section 34
 *
 * Cross-deployment A2A wire protocol. Extends the in-crew envelope from
 * `@crewhaus/a2a-protocol` (Section 22) with `federation` fields:
 *
 *   {
 *     ...A2AEnvelope,
 *     version: "crewhaus.federation.v1",  // strict — rejected without exact match
 *     federation: {
 *       from: { deployment, role },
 *       to:   { deployment, role },
 *       mtls: { client_cert_subject }
 *     }
 *   }
 *
 * Transport: HTTPS POST with mutual TLS. Each deployment has a
 * CA-issued certificate identifying its `deployment_id`; peers verify
 * via cert pinning (SHA256 fingerprint check) plus standard TLS chain
 * validation.
 *
 * Errors map to `recovery-engine` taxonomy:
 *   - cert mismatch / expired → tombstone (auth failure)
 *   - connection refused / timeout → retry with exponential backoff
 *   - 5xx → retry; 4xx → tombstone
 */
import { CrewhausError } from "@crewhaus/errors";

export class FederationProtocolError extends CrewhausError {
  override readonly name = "FederationProtocolError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export const FEDERATION_VERSION = "crewhaus.federation.v1" as const;
export type FederationVersion = typeof FEDERATION_VERSION;

export type FederationParty = {
  readonly deployment: string;
  readonly role: string;
};

export type FederationEnvelope = {
  readonly version: FederationVersion;
  readonly traceparent: string;
  readonly federation: {
    readonly from: FederationParty;
    readonly to: FederationParty;
    readonly mtls: { readonly client_cert_subject: string };
  };
  /** A2A envelope kind, mirroring `@crewhaus/a2a-protocol`. */
  readonly kind: "question" | "answer" | "notify";
  /** Free-form message body — typically a question prompt. */
  readonly payload: string;
};

export function encodeFederationEnvelope(envelope: FederationEnvelope): string {
  validateEnvelope(envelope);
  return JSON.stringify(envelope);
}

export function decodeFederationEnvelope(text: string): FederationEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new FederationProtocolError("federation envelope: invalid JSON", cause);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new FederationProtocolError("federation envelope: not an object");
  }
  const env = parsed as Record<string, unknown>;
  if (env["version"] !== FEDERATION_VERSION) {
    throw new FederationProtocolError(
      `federation envelope: unsupported version ${String(env["version"])} (expected ${FEDERATION_VERSION})`,
    );
  }
  validateEnvelope(env as unknown as FederationEnvelope);
  return env as unknown as FederationEnvelope;
}

function validateEnvelope(env: FederationEnvelope): void {
  if (env.version !== FEDERATION_VERSION) {
    throw new FederationProtocolError(`unsupported version ${String(env.version)}`);
  }
  if (!env.federation || typeof env.federation !== "object") {
    throw new FederationProtocolError("federation envelope: missing federation field");
  }
  const f = env.federation;
  if (!isParty(f.from) || !isParty(f.to)) {
    throw new FederationProtocolError("federation envelope: from/to must be {deployment,role}");
  }
  if (!f.mtls || typeof f.mtls.client_cert_subject !== "string") {
    throw new FederationProtocolError("federation envelope: missing mtls.client_cert_subject");
  }
  if (env.kind !== "question" && env.kind !== "answer" && env.kind !== "notify") {
    throw new FederationProtocolError(`federation envelope: invalid kind ${String(env.kind)}`);
  }
  if (typeof env.payload !== "string") {
    throw new FederationProtocolError("federation envelope: payload must be a string");
  }
  if (typeof env.traceparent !== "string" || env.traceparent.length === 0) {
    throw new FederationProtocolError("federation envelope: missing traceparent");
  }
}

function isParty(p: unknown): p is FederationParty {
  return (
    typeof p === "object" &&
    p !== null &&
    typeof (p as FederationParty).deployment === "string" &&
    typeof (p as FederationParty).role === "string" &&
    (p as FederationParty).deployment.length > 0 &&
    (p as FederationParty).role.length > 0
  );
}

// ─── mTLS transport ────────────────────────────────────────────────────────

export type MtlsCredentials = {
  /** PEM-encoded CA bundle the peer's cert chain must validate against. */
  readonly caCertPem: string;
  /** PEM-encoded client certificate this deployment presents. */
  readonly clientCertPem: string;
  /** PEM-encoded private key matching `clientCertPem`. */
  readonly clientKeyPem: string;
  /**
   * SHA256 fingerprint of the peer's expected leaf cert (hex, lowercase,
   * 64 chars; no `:` separators). Strict pin: any other cert is rejected
   * even if it chains to the same CA.
   */
  readonly pinnedFingerprint: string;
};

export type FederationTransport = (
  url: string,
  envelope: FederationEnvelope,
  creds: MtlsCredentials,
) => Promise<{ status: number; body: string }>;

export type FederationCallOptions = {
  readonly url: string;
  readonly envelope: FederationEnvelope;
  readonly credentials: MtlsCredentials;
  /** Test injection point. Defaults to a real `node:https` POST. */
  readonly transport?: FederationTransport;
  /** Timeout in ms. Default 30s. */
  readonly timeoutMs?: number;
};

export async function federationCall(
  opts: FederationCallOptions,
): Promise<{ status: number; body: string }> {
  validateCredentials(opts.credentials);
  const transport = opts.transport ?? defaultTransport(opts.timeoutMs ?? 30_000);
  return transport(opts.url, opts.envelope, opts.credentials);
}

/**
 * Asserts the credentials are well-formed BEFORE we try to build a TLS
 * agent. Surfaces clear, actionable errors instead of openssl-flavoured
 * mystery.
 */
export function validateCredentials(creds: MtlsCredentials): void {
  if (!creds.caCertPem.includes("-----BEGIN CERTIFICATE-----")) {
    throw new FederationProtocolError("credentials: caCertPem is not PEM-encoded");
  }
  if (!creds.clientCertPem.includes("-----BEGIN CERTIFICATE-----")) {
    throw new FederationProtocolError("credentials: clientCertPem is not PEM-encoded");
  }
  if (
    !creds.clientKeyPem.includes("-----BEGIN PRIVATE KEY-----") &&
    !creds.clientKeyPem.includes("-----BEGIN RSA PRIVATE KEY-----") &&
    !creds.clientKeyPem.includes("-----BEGIN EC PRIVATE KEY-----")
  ) {
    throw new FederationProtocolError("credentials: clientKeyPem is not PEM-encoded");
  }
  if (!/^[0-9a-f]{64}$/.test(creds.pinnedFingerprint)) {
    throw new FederationProtocolError(
      `credentials: pinnedFingerprint must be 64-char hex sha256 (got ${creds.pinnedFingerprint.length} chars)`,
    );
  }
  // Sanity: keys parse + cert parses + cert hasn't expired
  try {
    createPublicKey(creds.clientCertPem);
    createPrivateKey(creds.clientKeyPem);
  } catch (cause) {
    throw new FederationProtocolError("credentials: client cert/key did not parse", cause);
  }
  try {
    const cert = new X509Certificate(creds.clientCertPem);
    const now = Date.now();
    if (Date.parse(cert.validTo) < now) {
      throw new FederationProtocolError(`credentials: client cert expired at ${cert.validTo}`);
    }
  } catch (cause) {
    if (cause instanceof FederationProtocolError) throw cause;
    throw new FederationProtocolError("credentials: client cert parse failed", cause);
  }
}

/** Compute the SHA256 fingerprint of a PEM-encoded cert (hex, no separators). */
export function fingerprintCert(certPem: string): string {
  const cert = new X509Certificate(certPem);
  return cert.fingerprint256.replaceAll(":", "").toLowerCase();
}

/** Default transport — real `node:https` POST with mTLS + cert pinning. */
function defaultTransport(timeoutMs: number): FederationTransport {
  return async (url, envelope, creds) => {
    const u = new URL(url);
    if (u.protocol !== "https:") {
      throw new FederationProtocolError(
        `federation transport requires https://, got ${u.protocol}`,
      );
    }
    const body = encodeFederationEnvelope(envelope);
    const opts: RequestOptions = {
      method: "POST",
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || 443,
      path: `${u.pathname}${u.search}`,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body, "utf8").toString(),
        "X-Crewhaus-Federation-Version": FEDERATION_VERSION,
      },
      ca: creds.caCertPem,
      cert: creds.clientCertPem,
      key: creds.clientKeyPem,
      rejectUnauthorized: true,
      timeout: timeoutMs,
      checkServerIdentity: (_host, cert) => {
        // Strict pin: the peer's leaf cert fingerprint must match exactly.
        const fp = cert.fingerprint256?.replaceAll(":", "").toLowerCase() ?? "";
        if (fp !== creds.pinnedFingerprint) {
          return new Error(
            `cert-pin mismatch: peer fingerprint ${fp} != pinned ${creds.pinnedFingerprint}`,
          );
        }
        return undefined;
      },
    };

    return new Promise((resolve, reject) => {
      const req = httpsRequest(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("error", (err) =>
          reject(new FederationProtocolError(`federation transport error: ${err.message}`, err)),
        );
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      });
      req.on("error", (err) =>
        reject(new FederationProtocolError(`federation transport error: ${err.message}`, err)),
      );
      req.on("timeout", () => {
        req.destroy(
          new FederationProtocolError(`federation transport timeout after ${timeoutMs}ms`),
        );
      });
      req.write(body);
      req.end();
    });
  };
}

/** Re-export for callers that need to spawn their own agent (rare). */
export type { HttpsAgent };

// ─── A2A Agent Card (Item 2 / G31) ──────────────────────────────────────────
//
// A CrewHaus deployment that serves federated calls also publishes a REAL
// Agent2Agent (A2A) Agent Card at `<deployment>/.well-known/agent-card.json`,
// so off-the-shelf A2A clients can discover it. The card describes identity,
// transport, and skills; the cert-pinning fingerprint a CrewHaus peer needs
// lives in the namespaced ALIAS at `/.well-known/crewhaus.json` (see
// `FederationWellKnown` below), which `@crewhaus/federation-discovery` parses.

/**
 * A2A protocol version advertised by an Agent Card's `protocolVersion` field.
 * Distinct from {@link FEDERATION_VERSION} (CrewHaus's own wire-envelope
 * version, advertised as the card's `preferredTransport`).
 */
export const A2A_PROTOCOL_VERSION = "0.3.0" as const;

/** One advertised capability ("skill") on an A2A Agent Card. */
export type A2AAgentSkill = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly examples?: readonly string[];
  readonly inputModes?: readonly string[];
  readonly outputModes?: readonly string[];
};

export type A2AAgentCapabilities = {
  readonly streaming: boolean;
  readonly pushNotifications: boolean;
  readonly stateTransitionHistory: boolean;
};

export type A2AAgentProvider = {
  readonly organization: string;
  readonly url?: string;
};

/**
 * A real A2A Agent Card. Field names follow the A2A spec so a generic A2A
 * client can consume a CrewHaus deployment's card verbatim. `url` is the
 * federation inbound endpoint peers POST envelopes to; `preferredTransport`
 * names CrewHaus's own envelope so a CrewHaus peer knows to speak it.
 */
export type A2AAgentCard = {
  readonly protocolVersion: string;
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly preferredTransport: string;
  readonly version: string;
  readonly capabilities: A2AAgentCapabilities;
  readonly defaultInputModes: readonly string[];
  readonly defaultOutputModes: readonly string[];
  readonly skills: readonly A2AAgentSkill[];
  readonly provider?: A2AAgentProvider;
};

export type BuildAgentCardInput = {
  readonly name: string;
  readonly description: string;
  /** The federation inbound endpoint peers call (e.g. `https://dep/federation`). */
  readonly url: string;
  /** The deployment's own version string. Defaults to `0.0.0`. */
  readonly version?: string;
  /** Explicit skills. When empty, a single `chat` skill is synthesised. */
  readonly skills?: readonly A2AAgentSkill[];
  readonly capabilities?: Partial<A2AAgentCapabilities>;
  readonly provider?: A2AAgentProvider;
};

const DEFAULT_AGENT_VERSION = "0.0.0";

/**
 * Build an {@link A2AAgentCard} from a deployment's identity. The card is
 * pure metadata (no cert fingerprint) so it is always safe to serve; the
 * cert-pinning fingerprint a CrewHaus peer needs lives in the crewhaus.json
 * alias ({@link buildWellKnown}).
 */
export function buildAgentCard(input: BuildAgentCardInput): A2AAgentCard {
  const skills =
    input.skills && input.skills.length > 0 ? input.skills : [defaultChatSkill(input.description)];
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: input.name,
    description: input.description,
    url: input.url,
    preferredTransport: FEDERATION_VERSION,
    version: input.version ?? DEFAULT_AGENT_VERSION,
    capabilities: {
      streaming: input.capabilities?.streaming ?? false,
      pushNotifications: input.capabilities?.pushNotifications ?? false,
      stateTransitionHistory: input.capabilities?.stateTransitionHistory ?? false,
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills,
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
  };
}

function defaultChatSkill(description: string): A2AAgentSkill {
  return {
    id: "chat",
    name: "chat",
    description: description.length > 0 ? description : "Converse with this agent.",
    tags: ["chat"],
  };
}

/**
 * The CrewHaus-namespaced discovery record served at
 * `<deployment>/.well-known/crewhaus.json`. `@crewhaus/federation-discovery`
 * parses exactly this shape to resolve a peer's endpoint + pinned cert
 * fingerprint before a federated call — the fingerprint the A2A Agent Card
 * deliberately omits. Kept as a namespaced ALIAS beside the standard card so
 * a deployment is both A2A-discoverable AND CrewHaus-cert-pinnable.
 */
export type FederationWellKnown = {
  readonly endpoint: string;
  readonly version: string;
  readonly supportedShapes: readonly string[];
  readonly publicKeyFingerprint: string;
};

export type BuildWellKnownInput = {
  readonly endpoint: string;
  /** SHA256 fingerprint of this deployment's leaf cert (64-char hex). */
  readonly publicKeyFingerprint: string;
  readonly version?: string;
  readonly supportedShapes?: readonly string[];
};

export function buildWellKnown(input: BuildWellKnownInput): FederationWellKnown {
  if (!/^[0-9a-f]{64}$/i.test(input.publicKeyFingerprint)) {
    throw new FederationProtocolError(
      `well-known: publicKeyFingerprint must be 64-char hex sha256 (got ${input.publicKeyFingerprint.length} chars)`,
    );
  }
  return {
    endpoint: input.endpoint,
    version: input.version ?? FEDERATION_VERSION,
    supportedShapes: input.supportedShapes ?? [],
    publicKeyFingerprint: input.publicKeyFingerprint.toLowerCase(),
  };
}

// ─── Inbound result → A2A message/task mapping ──────────────────────────────
//
// When a deployment accepts an inbound federated call and dispatches it to a
// local run, it maps the run's terminal reply onto A2A message semantics. The
// synchronous, immediately-complete case returns an A2A `Message` (role
// "agent", one text part). The deeper A2A task lifecycle — a pollable `Task`
// transitioning submitted → working → completed for long-running calls — is a
// documented follow-up; today every inbound call resolves synchronously.

/** An A2A message part. CrewHaus federation exchanges text parts only today. */
export type A2ATextPart = { readonly kind: "text"; readonly text: string };

/**
 * An A2A `Message` — the result shape an A2A `message/send` returns when the
 * response is immediate (no long-running task). The inbound federation handler
 * maps a completed local run's reply onto this.
 */
export type A2AMessage = {
  readonly kind: "message";
  readonly role: "agent" | "user";
  readonly parts: readonly A2ATextPart[];
  readonly messageId: string;
  readonly contextId?: string;
  readonly taskId?: string;
};

export function toA2AAgentMessage(
  text: string,
  opts: { readonly messageId?: string; readonly contextId?: string; readonly taskId?: string } = {},
): A2AMessage {
  return {
    kind: "message",
    role: "agent",
    parts: [{ kind: "text", text }],
    messageId: opts.messageId ?? randomUUID(),
    ...(opts.contextId !== undefined ? { contextId: opts.contextId } : {}),
    ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
  };
}

/** Concatenate the text of an A2A message's text parts. */
export function textFromA2AMessage(message: A2AMessage): string {
  return message.parts
    .filter((p): p is A2ATextPart => p.kind === "text")
    .map((p) => p.text)
    .join("");
}

/**
 * The body an inbound `/federation` handler returns. `reply` is the
 * router-compatible plain string `@crewhaus/federation-router` decodes;
 * `message` is the SAME reply mapped onto A2A message semantics for
 * A2A-native clients. Both carry identical text — `reply` is the fast path,
 * `message` the interoperable one.
 */
export type FederationInboundResponse = {
  readonly reply: string;
  readonly message: A2AMessage;
};

export function buildInboundResponse(
  reply: string,
  opts: { readonly contextId?: string } = {},
): FederationInboundResponse {
  return { reply, message: toA2AAgentMessage(reply, opts) };
}
