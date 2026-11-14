/**
 * Opening a secret Home issued sealed: the client half of sealed issuance, the same
 * algorithm the browser module uses. ECDH P-256 between the client's one-off key and
 * Home's (`epk`, a raw uncompressed point), HKDF-SHA256 with an empty salt and the info
 * `crewhaus.hangar.v1/issued`, then AES-256-GCM with the operation id as additional
 * data, so an answer sealed for one operation never opens as another's. WebCrypto only.
 */

const INFO = "crewhaus.hangar.v1/issued";
const ALG = "ECDH-ES+A256GCM";

export type SealedAnswer = {
  readonly alg: string;
  readonly epk: string;
  readonly iv: string;
  readonly ct: string;
};

export type SealPair = {
  /** The public half to send, exactly `{kty, crv, x, y}`. */
  readonly seal: {
    readonly kty: "EC";
    readonly crv: "P-256";
    readonly x: string;
    readonly y: string;
  };
  /** Open Home's answer for operation `op`; throws when it was not sealed to this key for it. */
  open(issued: unknown, op: string): Promise<string>;
};

const utf8 = (text: string): Uint8Array<ArrayBuffer> => {
  const bytes = new TextEncoder().encode(text);
  const out = new Uint8Array(new ArrayBuffer(bytes.length));
  out.set(bytes);
  return out;
};

function fromHex(text: unknown): Uint8Array<ArrayBuffer> {
  if (typeof text !== "string" || !/^(?:[0-9a-f]{2})+$/.test(text)) throw new Error("not hex");
  const out = new Uint8Array(new ArrayBuffer(text.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Open an `issued` answer with the private half of a seal. */
export async function openIssued(
  privateKey: CryptoKey,
  issued: unknown,
  op: string,
): Promise<string> {
  if (typeof issued !== "object" || issued === null || (issued as SealedAnswer).alg !== ALG) {
    throw new Error("not a sealed answer");
  }
  const answer = issued as SealedAnswer;
  const server = await crypto.subtle.importKey(
    "raw",
    fromHex(answer.epk),
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
    { name: "AES-GCM", iv: fromHex(answer.iv), additionalData: utf8(op) },
    key,
    fromHex(answer.ct),
  );
  return new TextDecoder().decode(plain);
}

/** A one-off key for one request that will be answered with a sealed secret. */
export async function makeSeal(): Promise<SealPair> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    seal: { kty: "EC", crv: "P-256", x: String(jwk.x), y: String(jwk.y) },
    open: (issued, op) => openIssued(pair.privateKey, issued, op),
  };
}
