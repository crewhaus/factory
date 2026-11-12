/**
 * The vault's sealing, with WebCrypto alone: AES-256-GCM for every sealed record and
 * wrapped key, HKDF-SHA256 to derive a person's keys from their one random key, and
 * HMAC-SHA256 for fingerprints, the key check and the erasure nonce. No scrypt.
 */

const encoder = new TextEncoder();

/** The domain every label and AAD starts with. */
export const DOMAIN = "crewhaus.people.v1";

export const KEY_BYTES = 32;
const IV_BYTES = 12;

export type Sealed = { readonly iv: string; readonly ct: string };

export function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const HEX_RE = /^(?:[0-9a-f]{2})+$/;

/** Bytes of a lowercase hex string, or `undefined` when it is not one. */
export function bytesOf(hex: string): Uint8Array | undefined {
  if (!HEX_RE.test(hex)) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function randomKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

/** A 32-byte key as custody holds it: 64 lowercase hex characters. */
export const KEY_HEX_RE = /^[0-9a-f]{64}$/;

export function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function hmacKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** Derive a key from `raw` with HKDF-SHA256, an empty salt and `info`. */
async function derive(
  raw: Uint8Array,
  info: string,
  algorithm: Parameters<typeof crypto.subtle.deriveKey>[2],
  usages: Parameters<typeof crypto.subtle.deriveKey>[4],
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(info) },
    base,
    algorithm,
    false,
    usages,
  );
}

/** What one person's key opens: their sealed records, and their fingerprints. */
export type PersonKeys = { readonly records: CryptoKey; readonly fp: CryptoKey };

export async function personKeys(raw: Uint8Array): Promise<PersonKeys> {
  const [records, fp] = await Promise.all([
    derive(raw, `${DOMAIN}/records`, { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]),
    derive(raw, `${DOMAIN}/fp`, { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign"]),
  ]);
  return { records, fp };
}

export async function seal(key: CryptoKey, plain: Uint8Array, aad: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    plain,
  );
  return { iv: hexOf(iv), ct: hexOf(new Uint8Array(ct)) };
}

/** The plaintext, or `undefined` when the record does not open under this key and AAD. */
export async function open(
  key: CryptoKey,
  sealed: Sealed,
  aad: string,
): Promise<Uint8Array | undefined> {
  const iv = bytesOf(sealed.iv);
  const ct = bytesOf(sealed.ct);
  if (iv === undefined || ct === undefined || iv.length !== IV_BYTES) return undefined;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
      key,
      ct,
    );
    return new Uint8Array(plain);
  } catch {
    return undefined;
  }
}

export async function sealJson(key: CryptoKey, value: unknown, aad: string): Promise<Sealed> {
  return seal(key, encoder.encode(JSON.stringify(value)), aad);
}

export async function openJson(
  key: CryptoKey,
  sealed: Sealed,
  aad: string,
): Promise<unknown | undefined> {
  const plain = await open(key, sealed, aad);
  if (plain === undefined) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return undefined;
  }
}

export async function hmacHex(key: CryptoKey, data: string): Promise<string> {
  return hexOf(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data))));
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/** The key check: an HMAC of a fixed label under the space key, so a wrong key is told apart. */
export async function keyCheck(kek: Uint8Array, space: string, version: number): Promise<string> {
  return hmacHex(await hmacKey(kek), `${DOMAIN}/kek-check|${space}|${version}`);
}

/** The key the erasure nonce is made under, derived from the space key. */
export function nonceKey(kek: Uint8Array): Promise<CryptoKey> {
  return derive(kek, `${DOMAIN}/erasure-nonce`, { name: "HMAC", hash: "SHA-256", length: 256 }, [
    "sign",
  ]);
}

/** Constant-time comparison of two strings of the same alphabet. */
export function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The AAD a sealed record binds: its kind, its person, its id and its revision. */
export function recordAad(kind: string, person: string, id: string, rev: number): string {
  return `${DOMAIN}|${kind}|${person}|${id}|${rev}`;
}

/** The AAD a wrapped person key binds: its space, its person and the space key's version. */
export function personKeyAad(space: string, person: string, kekVersion: number): string {
  return `${DOMAIN}/person-key|${space}|${person}|${kekVersion}`;
}
