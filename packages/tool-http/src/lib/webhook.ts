/**
 * Webhook signatures in the two shapes providers actually ship.
 *
 *   "timestamped" — Stripe's scheme. The signed string is
 *       `<unix-seconds>.<raw body>`
 *     and the header is `t=<unix-seconds>,v1=<hex>`. The timestamp is inside
 *     the MAC, so it cannot be edited, which is what makes a replay window
 *     enforceable at all.
 *
 *   "body" — GitHub's scheme. The MAC covers the raw body and nothing else,
 *     and the header is `sha256=<hex>`. There is no timestamp, so there is
 *     no replay protection; a verifier that needs one has to track delivery
 *     ids itself. Being blunt about that is the point of naming the schemes
 *     by what they cover rather than by vendor.
 *
 * Everything here is pure given its inputs — no clock is read, no socket is
 * opened. `verifySignature` takes `nowSeconds` as an argument so the stale
 * check is testable and the caller decides which clock it trusts.
 *
 * The MAC must be computed over the EXACT bytes the sender signed. Parsing
 * JSON and re-serialising it changes those bytes and every verification
 * fails; the tools therefore take the payload as a string.
 */
import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

export type SignatureScheme = "timestamped" | "body";
export type SignatureAlgorithm = "sha256" | "sha1";

/** The string a scheme actually runs the MAC over. */
export function signedPayload(
  scheme: SignatureScheme,
  body: string,
  timestampSeconds?: number,
): string {
  if (scheme === "body") return body;
  if (timestampSeconds === undefined) {
    throw new Error('the "timestamped" scheme needs a timestamp');
  }
  return `${timestampSeconds}.${body}`;
}

/** Lowercase hex HMAC. */
export function hmacHex(
  secret: string,
  payload: string,
  algorithm: SignatureAlgorithm = "sha256",
): string {
  return createHmac(algorithm, secret).update(payload, "utf8").digest("hex");
}

/** The header value a sender would transmit for this signature. */
export function formatHeader(
  scheme: SignatureScheme,
  hex: string,
  algorithm: SignatureAlgorithm,
  timestampSeconds?: number,
): string {
  if (scheme === "body") return `${algorithm}=${hex}`;
  return `t=${timestampSeconds},v1=${hex}`;
}

export type ParsedHeader = {
  /** Unix seconds from `t=`; absent for the body scheme. */
  readonly timestamp?: number;
  /** Every candidate signature in the header, lowercased hex. */
  readonly signatures: readonly string[];
  /** The algorithm the header named, when it named one. */
  readonly algorithm?: SignatureAlgorithm;
};

/**
 * Read a signature header of either shape. Providers rotate secrets by
 * sending several signatures in one header, so this always returns a list.
 */
export function parseSignatureHeader(scheme: SignatureScheme, header: string): ParsedHeader {
  if (scheme === "body") {
    const trimmed = header.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) return { signatures: [trimmed.toLowerCase()] };
    const algorithm = trimmed.slice(0, eq).trim().toLowerCase();
    return {
      signatures: [
        trimmed
          .slice(eq + 1)
          .trim()
          .toLowerCase(),
      ],
      ...(algorithm === "sha256" || algorithm === "sha1" ? { algorithm } : {}),
    };
  }
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      const parsed = Number.parseInt(value, 10);
      if (/^-?\d+$/.test(value) && Number.isFinite(parsed)) timestamp = parsed;
    } else if (key.startsWith("v")) {
      signatures.push(value.toLowerCase());
    }
  }
  return { ...(timestamp !== undefined ? { timestamp } : {}), signatures };
}

/**
 * Constant-time hex comparison. Length is compared first — it is not secret,
 * since it is fixed by the algorithm — and the byte comparison that follows
 * does not short-circuit, so a near-miss costs the same as a wild miss and
 * an attacker learns nothing from timing.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]*$/i.test(a) || !/^[0-9a-f]*$/i.test(b)) return false;
  if (a.length !== b.length || a.length === 0) return false;
  const left = Buffer.from(a.toLowerCase(), "hex");
  const right = Buffer.from(b.toLowerCase(), "hex");
  if (left.byteLength !== right.byteLength || left.byteLength === 0) return false;
  return timingSafeEqual(left, right);
}

export type VerifyInput = {
  readonly scheme: SignatureScheme;
  readonly body: string;
  readonly secret: string;
  readonly header: string;
  readonly algorithm?: SignatureAlgorithm;
  /** Seconds a timestamped signature may be old (or in the future). */
  readonly toleranceSeconds?: number;
  /** Unix seconds to measure staleness against. */
  readonly nowSeconds?: number;
};

export type VerifyResult = {
  readonly valid: boolean;
  /** Why it failed, or `"signature matches"` when it did not. */
  readonly reason: string;
  /** Present for the timestamped scheme when the header carried a `t=`. */
  readonly ageSeconds?: number;
};

/**
 * Verify a signature. A stale timestamp is a REJECTION even when the MAC is
 * correct — that is the whole purpose of the timestamped scheme, and a
 * verifier that checks the MAC and shrugs at the clock has reopened the
 * replay window it was built to close.
 */
export function verifySignature(input: VerifyInput): VerifyResult {
  const algorithm = input.algorithm ?? "sha256";
  const parsed = parseSignatureHeader(input.scheme, input.header);
  if (parsed.signatures.length === 0) {
    return { valid: false, reason: "the header carried no signature value" };
  }

  if (input.scheme === "timestamped") {
    if (parsed.timestamp === undefined) {
      return { valid: false, reason: 'the header has no "t=" timestamp' };
    }
    if (input.nowSeconds === undefined) {
      return { valid: false, reason: "a current timestamp is required to check staleness" };
    }
    const age = input.nowSeconds - parsed.timestamp;
    const tolerance = input.toleranceSeconds ?? 300;
    if (Math.abs(age) > tolerance) {
      return {
        valid: false,
        reason: `timestamp is ${age}s from now, outside the ${tolerance}s tolerance — treated as a replay`,
        ageSeconds: age,
      };
    }
    const expected = hmacHex(
      input.secret,
      signedPayload("timestamped", input.body, parsed.timestamp),
      algorithm,
    );
    const matched = parsed.signatures.some((candidate) => timingSafeEqualHex(expected, candidate));
    return {
      valid: matched,
      reason: matched ? "signature matches" : "no signature in the header matches the payload",
      ageSeconds: age,
    };
  }

  const headerAlgorithm = parsed.algorithm;
  if (headerAlgorithm !== undefined && headerAlgorithm !== algorithm) {
    return {
      valid: false,
      reason: `header declares ${headerAlgorithm} but verification was asked for ${algorithm}`,
    };
  }
  const expected = hmacHex(input.secret, input.body, algorithm);
  const matched = parsed.signatures.some((candidate) => timingSafeEqualHex(expected, candidate));
  return {
    valid: matched,
    reason: matched ? "signature matches" : "the signature does not match the payload",
  };
}
