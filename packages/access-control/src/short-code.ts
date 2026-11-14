/**
 * Short codes a person reads off one screen and types into another: eight letters from
 * a consonant alphabet (RFC 8628 §6.1), shown `XXXX-XXXX`. No vowels, so no word is ever
 * spelled, and no letter is easily misread. A code is typed in any case, with or without
 * the hyphen or spaces, and is kept only as a keyed digest.
 *
 * First consumers: device sign-in requests; link codes use the same helper later.
 */
import { keyedDigest } from "@crewhaus/control-records";

/**
 * Twenty consonants: 20^8 codes, about 34.6 bits, for a code that lives ten minutes.
 *
 * First consumer: {@link mintShortCode}.
 */
export const SHORT_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

const LENGTH = 8;
/** The largest multiple of 20 below 256: bytes at or above it are drawn again. */
const UNBIASED = 240;

/**
 * A new code, `XXXX-XXXX`, every letter drawn uniformly.
 *
 * First consumer: a device sign-in's start.
 */
export function mintShortCode(): string {
  let letters = "";
  while (letters.length < LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(LENGTH * 2))) {
      if (byte >= UNBIASED) continue;
      letters += SHORT_CODE_ALPHABET[byte % SHORT_CODE_ALPHABET.length];
      if (letters.length === LENGTH) break;
    }
  }
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

/**
 * A typed code in its one canonical form, `XXXX-XXXX`, or `undefined` when it cannot be
 * one: case is folded, and a hyphen and spaces anywhere are dropped.
 *
 * First consumer: a device sign-in's lookup and decision.
 */
export function normalizeShortCode(input: unknown): string | undefined {
  if (typeof input !== "string" || input.length > 32) return undefined;
  const letters = input.toUpperCase().replace(/[\s-]/g, "");
  if (letters.length !== LENGTH) return undefined;
  for (const letter of letters) if (!SHORT_CODE_ALPHABET.includes(letter)) return undefined;
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

/**
 * The keyed digest a record keeps of a code, under `label`.
 *
 * First consumer: the device sign-in requests.
 */
export function shortCodeDigest(key: CryptoKey, label: string, code: string): Promise<string> {
  return keyedDigest(key, label, [code]);
}
