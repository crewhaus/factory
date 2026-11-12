/**
 * Sealed issuance: a new secret leaves Home only encrypted to the one client that asked.
 *
 * The client sends `seal`, an ephemeral ECDH P-256 public key it made with WebCrypto. The
 * server makes its own ephemeral key, derives 256 bits with ECDH, runs them through
 * HKDF-SHA256 (empty salt, info `crewhaus.hangar.v1/issued`) into an AES-256-GCM key, and
 * encrypts the secret under a fresh 12-byte IV with the operation id as additional data,
 * so a sealed answer to one operation cannot be replayed as another's. The answer is
 * `{alg: "ECDH-ES+A256GCM", epk, iv, ct}`: `epk` is the server key's raw uncompressed
 * point (65 bytes, `04…`), and every value is lowercase hex, which passes every rule of
 * the dispatch masker unchanged, so no route needs a masker exemption.
 *
 * The browser half (`hangar-ui/assets/js/sealed.js`) mirrors this byte for byte; a test
 * seals here and opens there.
 */
import type { DeviceJwk } from "./sign-in-records";

/** The HKDF info string. A pin: both halves derive with it. */
export const SEALED_INFO = "crewhaus.hangar.v1/issued";

/** The three operations that issue a session. */
export type SealedOperation = "auth.exchange" | "auth.session" | "auth.refresh";

export type Issued = {
  readonly alg: "ECDH-ES+A256GCM";
  readonly epk: string;
  readonly iv: string;
  readonly ct: string;
};

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("hex");
}

/**
 * Encrypt `secret` to the client's `seal` for operation `op`. Throws on a seal that is not
 * a P-256 point; callers validate the request shape first.
 *
 * First consumer: the sign-in handle, for every session it issues.
 */
export async function sealSecret(
  seal: DeviceJwk,
  secret: string,
  op: SealedOperation,
): Promise<Issued> {
  const client = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: seal.x, y: seal.y },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ephemeral = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: client },
    ephemeral.privateKey,
    256,
  );
  const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(SEALED_INFO) },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8(op) },
    key,
    utf8(secret),
  );
  const epk = await crypto.subtle.exportKey("raw", ephemeral.publicKey);
  return { alg: "ECDH-ES+A256GCM", epk: hex(epk), iv: hex(iv), ct: hex(ct) };
}
