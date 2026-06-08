import { X509Certificate, createPrivateKey, createPublicKey } from "node:crypto";
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
