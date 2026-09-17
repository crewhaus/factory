/**
 * JSON Web Tokens: reading them, and checking an HMAC-signed one.
 *
 * Supported subset, stated precisely because the gap between "decoded" and
 * "verified" is where JWT bugs live:
 *
 *   - `decodeJwt` parses a compact-serialization JWS (`header.payload.sig`)
 *     and does NOT check the signature. The payload it returns is attacker-
 *     controlled input. Nothing may be trusted from it.
 *   - `verifyJwt` verifies HS256 / HS384 / HS512 only. RS*, PS*, ES* and EdDSA
 *     need a public key and asymmetric verification, which this package does
 *     not do; it refuses them rather than pretending. `alg: none` is refused
 *     unconditionally.
 *   - The expected algorithm is supplied by the caller and matched against the
 *     header. Trusting the header's own `alg` is the classic JWT confusion
 *     attack, so this module will not do it.
 *   - Time-based claims are checked against a `now` the caller passes in.
 *     Nothing here reads a clock.
 *   - Encrypted tokens (JWE, five segments) are not supported.
 */
import { base64ToBytes, bytesToUtf8, timingSafeEqual, utf8ToBytes } from "./bytes";
import { hmac } from "./hash";
import { isoFromMillis } from "./time";

export type JwtClaims = Record<string, unknown>;

export type DecodedJwt = {
  header: JwtClaims;
  payload: JwtClaims;
  /** The base64url signature exactly as it appeared; empty for `alg: none`. */
  signature: string;
  /** `header.payload` — the bytes a signature is computed over. */
  signingInput: string;
};

export const JWT_HMAC_ALGORITHMS: ReadonlyArray<string> = ["HS256", "HS384", "HS512"];

const HMAC_HASH: Record<string, "sha256" | "sha384" | "sha512"> = {
  HS256: "sha256",
  HS384: "sha384",
  HS512: "sha512",
};

function decodeSegment(segment: string, what: string): JwtClaims {
  let text: string;
  try {
    text = bytesToUtf8(base64ToBytes(segment));
  } catch {
    throw new Error(`the ${what} segment is not valid base64url-encoded UTF-8`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`the ${what} segment is not JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`the ${what} segment is not a JSON object`);
  }
  return parsed as JwtClaims;
}

/** Split and decode a compact JWS. Does not verify anything. */
export function decodeJwt(token: string): DecodedJwt {
  const trimmed = token.trim().replace(/^Bearer\s+/i, "");
  const parts = trimmed.split(".");
  if (parts.length === 5) {
    throw new Error("this is a JWE (five segments) — encrypted tokens are not supported");
  }
  if (parts.length !== 3) {
    throw new Error(`expected three dot-separated segments, found ${parts.length}`);
  }
  const [headerPart, payloadPart, signature] = parts as [string, string, string];
  return {
    header: decodeSegment(headerPart, "header"),
    payload: decodeSegment(payloadPart, "payload"),
    signature,
    signingInput: `${headerPart}.${payloadPart}`,
  };
}

/**
 * Seconds-since-epoch claims, rendered as ISO instants for a human reader.
 *
 * A claim that is not a finite number, or that lands outside the range a date
 * can represent, is left out rather than formatted: the claim is attacker-
 * controlled, and `new Date(1e17).toISOString()` throws a bare `RangeError`.
 * The raw value is still in the payload the caller gets back.
 */
export function claimInstants(payload: JwtClaims): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["exp", "nbf", "iat", "auth_time"]) {
    const value = payload[key];
    if (typeof value !== "number") continue;
    const iso = isoFromMillis(value * 1000);
    if (iso !== undefined) out[key] = iso;
  }
  return out;
}

export type VerifyOptions = {
  /** Seconds since the epoch. Required: this module never reads a clock. */
  now: number;
  algorithm: string;
  leewaySeconds?: number;
  issuer?: string;
  audience?: string;
  subject?: string;
};

export type VerifyResult = {
  valid: boolean;
  signatureValid: boolean;
  reasons: string[];
  header: JwtClaims;
  payload: JwtClaims;
  expiresInSeconds: number | null;
};

/**
 * Verify an HMAC-signed JWT: signature first, then the registered claims that
 * the caller asked about, against the `now` the caller supplied.
 */
export async function verifyJwt(
  token: string,
  secret: Uint8Array,
  options: VerifyOptions,
): Promise<VerifyResult> {
  const decoded = decodeJwt(token);
  const reasons: string[] = [];
  const headerAlg = typeof decoded.header["alg"] === "string" ? decoded.header["alg"] : "";
  const expected = options.algorithm;

  if (!JWT_HMAC_ALGORITHMS.includes(expected)) {
    throw new Error(
      `${expected} is not an HMAC algorithm — this tool verifies ${JWT_HMAC_ALGORITHMS.join(", ")} only`,
    );
  }
  let signatureValid = false;
  if (headerAlg !== expected) {
    reasons.push(
      `header alg is "${headerAlg}" but "${expected}" was expected — refusing to verify with the token's own choice of algorithm`,
    );
  } else {
    const hash = HMAC_HASH[expected] as "sha256" | "sha384" | "sha512";
    const computed = await hmac(hash, secret, utf8ToBytes(decoded.signingInput));
    let provided: Uint8Array;
    try {
      provided = base64ToBytes(decoded.signature);
    } catch {
      provided = new Uint8Array(0);
    }
    signatureValid = timingSafeEqual(computed, provided);
    if (!signatureValid) reasons.push("signature does not match");
  }

  const leeway = options.leewaySeconds ?? 0;
  const exp = decoded.payload["exp"];
  const nbf = decoded.payload["nbf"];
  let expiresInSeconds: number | null = null;
  if (typeof exp === "number") {
    expiresInSeconds = Math.round(exp - options.now);
    if (options.now > exp + leeway) reasons.push(`expired ${options.now - exp} seconds ago`);
  } else if (exp !== undefined) {
    // RFC 7519 says exp is a NumericDate. A string or an object here would
    // otherwise fall through every check and make the token look eternal,
    // which is the wrong way to be wrong about an expiry.
    reasons.push(
      `exp is ${JSON.stringify(exp)}, which is not a number — refusing to treat the token as never expiring`,
    );
  }
  if (typeof nbf === "number") {
    if (options.now + leeway < nbf) {
      reasons.push(`not valid for another ${nbf - options.now} seconds`);
    }
  } else if (nbf !== undefined) {
    reasons.push(`nbf is ${JSON.stringify(nbf)}, which is not a number`);
  }
  for (const [claim, want] of [
    ["iss", options.issuer],
    ["aud", options.audience],
    ["sub", options.subject],
  ] as const) {
    if (want === undefined) continue;
    const actual = decoded.payload[claim];
    const matches = Array.isArray(actual) ? actual.includes(want) : actual === want;
    if (!matches)
      reasons.push(`${claim} is ${JSON.stringify(actual)}, expected ${JSON.stringify(want)}`);
  }

  return {
    valid: signatureValid && reasons.length === 0,
    signatureValid,
    reasons,
    header: decoded.header,
    payload: decoded.payload,
    expiresInSeconds,
  };
}
