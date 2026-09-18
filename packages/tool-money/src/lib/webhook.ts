/**
 * Verify a signed webhook before believing a word of it.
 *
 * A payment webhook says money moved. Anyone who can reach the endpoint can
 * post that claim, so the signature is the only thing separating an event
 * from an assertion by a stranger — and a harness that acts on an unverified
 * "payment succeeded" ships goods for free.
 *
 * The scheme implemented is Stripe's, which several providers copy: a header
 * carrying a timestamp and one or more signatures, over `timestamp.body`,
 * HMAC-SHA256, hex. The comparison is constant-time and the timestamp is
 * checked, because a signature that never expires is a replay waiting to
 * happen.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type VerifyOptions = {
  /** How old a signature may be, in seconds. Default 300, as Stripe's does. */
  readonly toleranceSeconds?: number;
  /** Epoch milliseconds. Supplied rather than read, so a replay is reproducible. */
  readonly nowMs: number;
  /** The signature scheme in the header. Default `v1`. */
  readonly scheme?: string;
};

export type VerifyResult = {
  readonly valid: boolean;
  /** Empty when valid; otherwise exactly what failed. */
  readonly reason: string;
  readonly timestamp: number | null;
  readonly ageSeconds: number | null;
  /** How many candidate signatures the header carried. */
  readonly signaturesTried: number;
};

/** Parse `t=1614556800,v1=abc,v1=def` into its parts. */
export function parseSignatureHeader(header: string): {
  timestamp: number | null;
  signatures: Map<string, string[]>;
} {
  const signatures = new Map<string, string[]>();
  let timestamp: number | null = null;
  for (const piece of header.split(",")) {
    const eq = piece.indexOf("=");
    if (eq === -1) continue;
    const key = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).trim();
    if (key === "t") {
      const parsed = Number.parseInt(value, 10);
      timestamp = Number.isNaN(parsed) ? null : parsed;
      continue;
    }
    const list = signatures.get(key);
    if (list) list.push(value);
    else signatures.set(key, [value]);
  }
  return { timestamp, signatures };
}

/** Compare two hex digests without leaking where they first differ. */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let left: Buffer;
  let right: Buffer;
  try {
    left = Buffer.from(a, "hex");
    right = Buffer.from(b, "hex");
  } catch {
    return false;
  }
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verify a webhook signature.
 *
 * `body` must be the RAW bytes as received. Re-serializing parsed JSON
 * changes key order and whitespace, and the signature is over the bytes —
 * which is why this takes a string or a Buffer and never an object.
 */
export function verifyWebhookSignature(
  body: string | Uint8Array,
  header: string,
  secret: string,
  options: VerifyOptions,
): VerifyResult {
  const { timestamp, signatures } = parseSignatureHeader(header);
  const scheme = options.scheme ?? "v1";
  const candidates = signatures.get(scheme) ?? [];

  if (timestamp === null) {
    return {
      valid: false,
      reason: "the header carries no timestamp",
      timestamp: null,
      ageSeconds: null,
      signaturesTried: 0,
    };
  }
  if (candidates.length === 0) {
    return {
      valid: false,
      reason: `the header carries no "${scheme}" signature`,
      timestamp,
      ageSeconds: null,
      signaturesTried: 0,
    };
  }

  const ageSeconds = Math.floor(options.nowMs / 1000) - timestamp;
  const tolerance = options.toleranceSeconds ?? 300;

  const payload = Buffer.concat([
    Buffer.from(`${timestamp}.`, "utf8"),
    typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body),
  ]);
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const matched = candidates.some((candidate) => constantTimeEqualHex(candidate, expected));

  // The signature is checked first and the age second, so a forged request
  // cannot learn anything from which complaint it gets back.
  if (!matched) {
    return {
      valid: false,
      reason: "no signature in the header matches the body",
      timestamp,
      ageSeconds,
      signaturesTried: candidates.length,
    };
  }
  if (Math.abs(ageSeconds) > tolerance) {
    return {
      valid: false,
      reason:
        ageSeconds > 0
          ? `the signature is ${ageSeconds}s old, past the ${tolerance}s tolerance — it may be a replay`
          : `the signature is timestamped ${-ageSeconds}s in the future, past the ${tolerance}s tolerance`,
      timestamp,
      ageSeconds,
      signaturesTried: candidates.length,
    };
  }
  return { valid: true, reason: "", timestamp, ageSeconds, signaturesTried: candidates.length };
}
