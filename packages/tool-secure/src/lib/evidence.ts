/**
 * Evidence that a record was not altered: hash chains and HMAC signatures.
 *
 * ## The hash-chain convention, stated exactly
 *
 * A record is `{ data, prevHash, hash }`, all strings, and the link is
 *
 *     hash = hex( H( prevHash + separator + data ) )
 *
 * with `separator` defaulting to `"\n"`, `H` defaulting to SHA-256, and the
 * first record's `prevHash` defaulting to the empty string. Every part is an
 * input because chains in the wild differ on all of them, and a verifier
 * that guesses is a verifier that returns a confidently wrong "valid".
 *
 * `data` must be a string the producer already canonicalized. This module
 * deliberately does not serialize objects for you: two JSON encoders
 * disagree about key order and number formatting, and a chain that verifies
 * under one and not the other is worse than no chain at all.
 *
 * ## What a valid chain proves
 *
 * That these records are internally consistent — nobody edited one without
 * recomputing every hash after it. It does NOT prove who wrote them or when,
 * and an attacker who can rewrite the whole sequence can produce a perfectly
 * valid chain. For that you need a signature over the head, which is what
 * `SignPayload` is for, or an external anchor.
 *
 * ## Signature comparison
 *
 * Verification compares `HMAC(key, expectedSignature)` with
 * `HMAC(key, providedSignature)` rather than the signatures themselves. The
 * two HMACs are always the same length, so `timingSafeEqual` can be used
 * even when the caller supplies a signature of the wrong length, and an
 * attacker cannot learn the expected bytes from how long the comparison
 * took.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Digest algorithms this package will use, and why each is here. */
export const HASH_ALGORITHMS = ["sha256", "sha384", "sha512", "sha1"] as const;
export type HashAlgorithm = (typeof HASH_ALGORITHMS)[number];

export const SIGNATURE_ENCODINGS = ["hex", "base64url"] as const;
export type SignatureEncoding = (typeof SIGNATURE_ENCODINGS)[number];

/** Bounds a chain: verification is linear, but the result is not. */
export const MAX_CHAIN_RECORDS = 50_000;

export class EvidenceError extends Error {
  override readonly name = "EvidenceError";
}

export type ChainRecord = {
  readonly data: string;
  readonly prevHash: string;
  readonly hash: string;
};

export type ChainOptions = {
  readonly algorithm?: HashAlgorithm;
  readonly separator?: string;
  readonly genesisPrevHash?: string;
};

export type ChainBreak = {
  readonly index: number;
  readonly kind: "link.mismatch" | "hash.mismatch";
  readonly expected: string;
  readonly actual: string;
  readonly explanation: string;
};

export type ChainResult = {
  readonly ok: boolean;
  readonly length: number;
  readonly algorithm: HashAlgorithm;
  /** Records checked before stopping. Equals `length` for an intact chain. */
  readonly verified: number;
  readonly headHash?: string;
  readonly firstBreak?: ChainBreak;
};

/** One link, by the convention documented above. */
export function computeLink(
  prevHash: string,
  data: string,
  algorithm: HashAlgorithm = "sha256",
  separator = "\n",
): string {
  return createHash(algorithm).update(`${prevHash}${separator}${data}`, "utf8").digest("hex");
}

/**
 * Walk the chain and stop at the first break.
 *
 * Stopping is the point: after a break every later hash is computed over
 * altered material, so continuing would report a cascade of failures that
 * all have one cause. The index reported is where to look.
 */
export function verifyChain(
  records: ReadonlyArray<ChainRecord>,
  options: ChainOptions = {},
): ChainResult {
  if (records.length > MAX_CHAIN_RECORDS) {
    throw new EvidenceError(
      `${records.length} records, over the ${MAX_CHAIN_RECORDS} limit — verify the chain in segments`,
    );
  }
  const algorithm = options.algorithm ?? "sha256";
  const separator = options.separator ?? "\n";
  const genesis = options.genesisPrevHash ?? "";

  let previousHash = genesis;
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.prevHash !== previousHash) {
      return {
        ok: false,
        length: records.length,
        algorithm,
        verified: i,
        firstBreak: {
          index: i,
          kind: "link.mismatch",
          expected: previousHash,
          actual: record.prevHash,
          explanation:
            i === 0
              ? "the first record's prevHash is not the genesis value — pass genesisPrevHash if this chain starts somewhere else"
              : "this record does not point at the previous record's hash: a record was inserted, removed or reordered",
        },
      };
    }
    const expected = computeLink(record.prevHash, record.data, algorithm, separator);
    if (expected !== record.hash) {
      return {
        ok: false,
        length: records.length,
        algorithm,
        verified: i,
        firstBreak: {
          index: i,
          kind: "hash.mismatch",
          expected,
          actual: record.hash,
          explanation:
            "the stored hash does not match this record's own data: the data was altered, or it was hashed under a different algorithm or separator",
        },
      };
    }
    previousHash = record.hash;
  }
  return {
    ok: true,
    length: records.length,
    algorithm,
    verified: records.length,
    ...(records.length > 0 ? { headHash: previousHash } : {}),
  };
}

/** Encode a digest in the requested form. */
function encode(buffer: Buffer, encoding: SignatureEncoding): string {
  return encoding === "hex" ? buffer.toString("hex") : buffer.toString("base64url");
}

/** HMAC over a payload. The key never appears in the result. */
export function signPayload(
  key: string,
  payload: string,
  algorithm: HashAlgorithm = "sha256",
  encoding: SignatureEncoding = "hex",
): string {
  return encode(createHmac(algorithm, key).update(payload, "utf8").digest(), encoding);
}

/**
 * Constant-time verification via the double-HMAC comparison described above.
 * A malformed signature is a `false`, not a throw.
 */
export function verifyPayload(
  key: string,
  payload: string,
  signature: string,
  algorithm: HashAlgorithm = "sha256",
  encoding: SignatureEncoding = "hex",
): boolean {
  const expected = signPayload(key, payload, algorithm, encoding);
  const blind = (value: string): Buffer =>
    createHmac(algorithm, key).update(value, "utf8").digest();
  const a = blind(expected);
  const b = blind(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** SHA-256 of a string, hex. Used for evidence records about a document. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
