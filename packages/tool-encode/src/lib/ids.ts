/**
 * Identifiers, and the seeded randomness that makes most of them reproducible.
 *
 * A harness that generates an id inside a retried step, a replayed run or a
 * test wants the same id back. Everything here except one explicitly-labelled
 * path takes a `seed` and derives its bits from that seed, so the id is a pure
 * function of its inputs.
 *
 * The seeded stream is cyrb128 (string -> 128 bits of state) driving sfc32.
 * It is a small, fast, well-distributed PRNG and is NOT cryptographically
 * secure: a seeded id is unguessable only to the extent the seed is. Never use
 * a seeded id as a bearer token, a password-reset nonce or anything else whose
 * safety rests on being unpredictable.
 */
import { byteAt, bytesToHex, utf8ToBytes } from "./bytes";
import { digest } from "./hash";

// ---------------------------------------------------------------------------
// Seeded randomness

/** Hash a seed string into four 32-bit words of PRNG state (cyrb128). */
export function seedState(seed: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < seed.length; i++) {
    const k = seed.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

/** A seeded uint32 generator (sfc32). Same seed, same sequence, forever. */
export function seededGenerator(seed: string): () => number {
  let [a, b, c, d] = seedState(seed);
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return t >>> 0;
  };
}

/** `count` bytes derived from `seed`, deterministically. */
export function seededBytes(seed: string, count: number): Uint8Array {
  const next = seededGenerator(seed);
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i += 4) {
    const word = next();
    for (let j = 0; j < 4 && i + j < count; j++) out[i + j] = (word >>> (8 * j)) & 0xff;
  }
  return out;
}

/**
 * Uniform integers in [0, bound) from a seeded stream, by rejection sampling
 * rather than `% bound`. The modulo shortcut biases the first `2^32 % bound`
 * symbols upward, which is invisible in one id and visible in a million.
 */
export function seededIndices(seed: string, count: number, bound: number): number[] {
  const next = seededGenerator(seed);
  const limit = Math.floor(0x1_0000_0000 / bound) * bound;
  const out: number[] = [];
  // Bounded so a pathological bound cannot spin forever; the loop exits long
  // before this in practice (rejection probability is under 1 in 2^32/bound).
  let guard = count * 64 + 1024;
  while (out.length < count && guard-- > 0) {
    const value = next();
    if (value < limit) out.push(value % bound);
  }
  return out;
}

// ---------------------------------------------------------------------------
// UUID

/** The four namespaces RFC 4122 defines, by their conventional names. */
export const UUID_NAMESPACES: Readonly<Record<string, string>> = Object.freeze({
  dns: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  url: "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
  oid: "6ba7b812-9dad-11d1-80b4-00c04fd430c8",
  x500: "6ba7b814-9dad-11d1-80b4-00c04fd430c8",
});

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isUuid(text: string): boolean {
  return UUID_PATTERN.test(text);
}

/** 16 bytes -> canonical 8-4-4-4-12 lowercase form. */
export function formatUuid(bytes: Uint8Array): string {
  const hex = bytesToHex(bytes.subarray(0, 16));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Canonical form (with or without braces/urn prefix) -> 16 bytes. */
export function parseUuid(text: string): Uint8Array | undefined {
  const cleaned = text
    .trim()
    .replace(/^urn:uuid:/i, "")
    .replace(/^\{|\}$/g, "");
  if (!UUID_PATTERN.test(cleaned)) return undefined;
  const hex = cleaned.replace(/-/g, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Stamp the RFC 4122 version and variant bits into a 16-byte buffer. */
export function stampUuidBits(bytes: Uint8Array, version: number): Uint8Array {
  const out = bytes.slice(0, 16);
  out[6] = (byteAt(out, 6) & 0x0f) | (version << 4);
  out[8] = (byteAt(out, 8) & 0x3f) | 0x80;
  return out;
}

/** The version digit of a well-formed UUID, or undefined. */
export function uuidVersion(text: string): number | undefined {
  const bytes = parseUuid(text);
  if (!bytes) return undefined;
  return byteAt(bytes, 6) >> 4;
}

// ---------------------------------------------------------------------------
// ULID

/** Crockford base32: no I, L, O or U, so a ULID cannot be misread aloud. */
export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Largest instant a 48-bit ULID timestamp can hold (year 10889). */
export const ULID_MAX_TIME = 0xffff_ffff_ffff;

/** Encode a millisecond instant as the ULID's 10-character time prefix. */
export function encodeUlidTime(milliseconds: number): string {
  if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > ULID_MAX_TIME) {
    throw new Error(`timestamp ${milliseconds} is outside the 48-bit ULID range`);
  }
  let remaining = milliseconds;
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = (CROCKFORD[remaining % 32] as string) + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

/** Encode bytes as Crockford base32, five bits at a time, most significant first. */
export function encodeCrockford(bytes: Uint8Array, characters: number): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length && out.length < characters; i++) {
    buffer = (buffer << 8) | byteAt(bytes, i);
    bits += 8;
    while (bits >= 5 && out.length < characters) {
      bits -= 5;
      out += CROCKFORD[(buffer >> bits) & 0x1f] as string;
    }
  }
  while (out.length < characters) out += CROCKFORD[0] as string;
  return out;
}

/**
 * A ULID for an explicit instant, with its 80 entropy bits derived from the
 * seed. Sorts lexicographically by time, like any ULID; unlike a random one,
 * the same (timestamp, seed) pair always produces the same id — so collisions
 * are a fact of the inputs, not a probability.
 */
export function ulid(milliseconds: number, seed: string): string {
  return encodeUlidTime(milliseconds) + encodeCrockford(seededBytes(seed, 10), 16);
}

// ---------------------------------------------------------------------------
// NanoId

/** nanoid's URL-safe alphabet, in sorted order: 64 characters, `A-Za-z0-9_-`. */
export const NANOID_ALPHABET = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";

/** A nanoid-shaped id drawn from a seeded, unbiased stream. */
export function nanoId(seed: string, size: number, alphabet: string): string {
  // Duplicate characters would weight themselves, so the alphabet is
  // de-duplicated first and the caller is told what was actually used.
  const symbols = [...new Set([...alphabet])];
  if (symbols.length < 2) throw new Error("alphabet needs at least two distinct characters");
  const indices = seededIndices(seed, size, symbols.length);
  // `seededIndices` is bounded so a pathological alphabet cannot spin forever.
  // If that bound ever bit, the id would come back short — which is worse than
  // an error, because a short id still looks like an id.
  if (indices.length !== size) {
    throw new Error(
      `could not draw ${size} unbiased symbols from an alphabet of ${symbols.length}`,
    );
  }
  return indices.map((i) => symbols[i] as string).join("");
}

// ---------------------------------------------------------------------------
// Name-based and random UUIDs

/**
 * A name-based UUID: version 5 (SHA-1) or version 3 (MD5). Fully
 * deterministic — the same namespace and name always give the same id, on
 * any machine, forever. This is the right identifier for "one row per URL"
 * or "one id per (tenant, external key)".
 */
export async function uuidNamed(version: 3 | 5, namespace: string, name: string): Promise<string> {
  const namespaceBytes = parseUuid(UUID_NAMESPACES[namespace] ?? namespace);
  if (!namespaceBytes) {
    throw new Error(
      `namespace "${namespace}" is neither a UUID nor one of ${Object.keys(UUID_NAMESPACES).join(", ")}`,
    );
  }
  const nameBytes = utf8ToBytes(name);
  const input = new Uint8Array(namespaceBytes.length + nameBytes.length);
  input.set(namespaceBytes);
  input.set(nameBytes, namespaceBytes.length);
  const hashed = await digest(version === 5 ? "sha1" : "md5", input);
  return formatUuid(stampUuidBits(hashed, version));
}

/**
 * A version 4 UUID whose 122 random bits come from a seed. Deterministic, and
 * therefore NOT a substitute for a real v4 wherever unpredictability matters.
 */
export function uuidV4Seeded(seed: string): string {
  return formatUuid(stampUuidBits(seededBytes(seed, 16), 4));
}

/**
 * A version 4 UUID from the platform CSPRNG. The one value in this package
 * that differs between two identical calls; every caller that can use
 * `uuidV4Seeded` or `uuidNamed` instead should.
 */
export function uuidV4Random(): string {
  return formatUuid(stampUuidBits(crypto.getRandomValues(new Uint8Array(16)), 4));
}
