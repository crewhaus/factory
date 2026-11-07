/**
 * Lowercase ULIDs: 26 Crockford base32 characters, a 48-bit millisecond time
 * followed by 80 random bits, so ids sort by mint time and never share a length
 * with an older `run_` id. Read an id as opaque everywhere but here.
 */
import { CROCKFORD } from "./base32.js";

export const ULID_LENGTH = 26;

/** One past the largest time a ULID holds: 2^48 milliseconds. */
const TIME_LIMIT = 2 ** 48;
const TIME_CHARS = 10;
const RANDOM_BYTES = 10;

export type MintUlidOptions = {
  /** Milliseconds since the epoch. Defaults to `Date.now()`. */
  readonly now?: number;
  /** Fills the buffer it is given. Defaults to `crypto.getRandomValues`. */
  readonly random?: (bytes: Uint8Array) => void;
};

function encodeTime(ms: number): string {
  let rest = ms;
  let out = "";
  for (let i = 0; i < TIME_CHARS; i++) {
    const digit = rest % 32;
    out = CROCKFORD.charAt(digit) + out;
    rest = (rest - digit) / 32;
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < RANDOM_BYTES; i++) {
    buffer = (buffer << 8) | (bytes[i] ?? 0);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD.charAt((buffer >> bits) & 31);
    }
    buffer &= (1 << bits) - 1;
  }
  return out;
}

/** Mint one ULID body. A time a ULID cannot hold throws `RangeError`. */
export function mintUlid(opts: MintUlidOptions = {}): string {
  const now = opts.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0 || now >= TIME_LIMIT) {
    throw new RangeError(`control-contract: a ULID cannot hold the time ${String(now)}`);
  }
  const bytes = new Uint8Array(RANDOM_BYTES);
  if (opts.random !== undefined) opts.random(bytes);
  else crypto.getRandomValues(bytes);
  return encodeTime(now) + encodeRandom(bytes);
}
