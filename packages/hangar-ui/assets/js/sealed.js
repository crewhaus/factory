/**
 * The browser half of sealed issuance. Home never sends a new secret in the clear: a
 * request that will get one carries `seal`, the public half of a key this page makes for
 * that one request, and Home answers `issued`, the secret encrypted to it.
 *
 * The algorithm mirrors the server half (`@crewhaus/access-control`'s `sealed.ts`) byte
 * for byte: ECDH P-256 between this page's key and Home's one-off key (`epk`, the raw
 * uncompressed point), HKDF-SHA256 over the shared bits with an empty salt and the info
 * `crewhaus.hangar.v1/issued`, then AES-256-GCM with the operation id as additional data.
 * Every value arrives as lowercase hex. A test seals on the server side and opens here.
 *
 * Pure WebCrypto: no DOM, no storage. The private key is never extractable.
 */

const INFO = "crewhaus.hangar.v1/issued";
const ALG = "ECDH-ES+A256GCM";

const utf8 = (text) => new TextEncoder().encode(text);

function fromHex(text) {
  if (typeof text !== "string" || !/^(?:[0-9a-f]{2})+$/.test(text)) {
    throw new Error("not hex");
  }
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Whether this page can make keys at all: WebCrypto exists only in a secure context. */
export function canSeal() {
  return typeof crypto !== "undefined" && crypto.subtle !== undefined && crypto.subtle !== null;
}

/**
 * Open an `issued` answer with the private half of a seal, for operation `op`. Throws when
 * the answer was not sealed to this key, for this operation, or was altered.
 */
export async function openIssued(privateKey, issued, op) {
  if (issued === null || typeof issued !== "object" || issued.alg !== ALG) {
    throw new Error("not a sealed answer");
  }
  const server = await crypto.subtle.importKey(
    "raw",
    fromHex(issued.epk),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: server }, privateKey, 256);
  const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(INFO) },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromHex(issued.iv), additionalData: utf8(op) },
    key,
    fromHex(issued.ct),
  );
  return new TextDecoder().decode(plain);
}

/**
 * A seal for one request: `seal` is the public JWK to send (exactly `{kty, crv, x, y}`),
 * and `open(issued, op)` decrypts Home's answer.
 */
export async function makeSeal() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    seal: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
    open: (issued, op) => openIssued(pair.privateKey, issued, op),
  };
}
