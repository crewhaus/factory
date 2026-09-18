/**
 * Webhook signing, in the two shapes providers actually ship.
 *
 *   "timestamped" — Stripe's scheme. The MAC covers `<unix-seconds>.<body>`
 *     and the header reads `t=<unix-seconds>,v1=<hex>`. The timestamp is
 *     inside the MAC, so a receiver can enforce a replay window.
 *
 *   "body" — GitHub's scheme. The MAC covers the raw body and the header
 *     reads `sha256=<hex>`. There is no timestamp and therefore no replay
 *     protection; naming the schemes by what they cover rather than by
 *     vendor is how that stays visible.
 *
 * The MAC must run over the EXACT bytes that are transmitted. The signer
 * therefore takes the serialised body, and the tool signs the same string it
 * puts on the wire — re-serialising a parsed object between signing and
 * sending changes the bytes and every verification downstream fails.
 *
 * Nothing here reads the clock: `timestampSeconds` is an argument.
 */
import { createHmac } from "node:crypto";

export type SignatureScheme = "timestamped" | "body";
export type SignatureAlgorithm = "sha256" | "sha1";

/** The string a scheme runs the MAC over. */
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

/** The header value a sender transmits for this signature. */
export function formatSignatureHeader(
  scheme: SignatureScheme,
  hex: string,
  algorithm: SignatureAlgorithm,
  timestampSeconds?: number,
): string {
  if (scheme === "body") return `${algorithm}=${hex}`;
  return `t=${timestampSeconds},v1=${hex}`;
}
