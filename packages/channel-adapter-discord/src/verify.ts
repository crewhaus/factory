import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  generateKeyPairSync,
  verify,
} from "node:crypto";

/**
 * Discord interaction signature verification per
 * https://discord.com/developers/docs/interactions/receiving-and-responding#security-and-authorization.
 *
 * Discord signs interaction webhooks with Ed25519. Each request carries
 * `X-Signature-Ed25519` (hex) and `X-Signature-Timestamp` (seconds). The
 * signed payload is `<timestamp><body>`. The bot's `publicKey` (hex,
 * 64 chars) is the verification key.
 *
 * We use Node's built-in `crypto.verify` with `null` algorithm and an
 * Ed25519 KeyObject built from the raw 32-byte public key — no external
 * SDK needed.
 */
export type DiscordVerifyArgs = {
  readonly headers: Headers;
  readonly body: string;
  readonly publicKeyHex: string;
};

export function verifyDiscordSignature(args: DiscordVerifyArgs): boolean {
  const sigHex = args.headers.get("x-signature-ed25519");
  const timestamp = args.headers.get("x-signature-timestamp");
  if (!sigHex || !timestamp) return false;
  if (!/^[0-9a-f]{128}$/i.test(sigHex)) return false;
  if (!/^\d+$/.test(timestamp)) return false;

  let signature: Buffer;
  try {
    signature = Buffer.from(sigHex, "hex");
  } catch {
    return false;
  }
  if (signature.length !== 64) return false;

  let publicKey: ReturnType<typeof ed25519PublicKeyFromHex>;
  try {
    publicKey = ed25519PublicKeyFromHex(args.publicKeyHex);
  } catch {
    return false;
  }

  const message = Buffer.from(`${timestamp}${args.body}`, "utf8");
  try {
    return verify(null, message, publicKey, signature);
  } catch {
    return false;
  }
}

/**
 * Construct an Ed25519 public KeyObject from a 32-byte hex string. Discord's
 * docs publish the bot key as a 64-char hex string. Node's `createPublicKey`
 * accepts a SubjectPublicKeyInfo DER blob — we wrap the raw key with the
 * fixed Ed25519 OID prefix `302a300506032b6570032100`.
 */
function ed25519PublicKeyFromHex(hex: string) {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(`expected 32-byte (64-char hex) ed25519 public key, got ${hex.length} chars`);
  }
  const der = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(hex, "hex"),
  ]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

/**
 * Sign a body with an Ed25519 private key — used by smoke tests and the
 * in-repo integration test to construct fixtures the daemon will accept.
 * Production code should NEVER call this — Discord signs requests, not us.
 */
export function signDiscordBody(args: {
  body: string;
  timestamp: number | string;
  privateKeyPem: string;
}): string {
  const message = Buffer.from(`${args.timestamp}${args.body}`, "utf8");
  const sk = createPrivateKey({ key: args.privateKeyPem });
  const sig = cryptoSign(null, message, sk);
  return sig.toString("hex");
}

/**
 * Generate a fresh Ed25519 keypair (PEM-encoded). Used by the test
 * harness so we can sign + verify our own fixtures end-to-end.
 */
export function generateEd25519Keypair(): {
  publicKeyHex: string;
  privateKeyPem: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // Extract raw 32-byte public key from the DER-encoded SPKI:
  // SPKI = 30 2a 30 05 06 03 2b 65 70 03 21 00 <32-byte-key>
  const spkiDer = publicKey.export({ format: "der", type: "spki" });
  const rawKey = spkiDer.subarray(spkiDer.length - 32);
  const publicKeyHex = Buffer.from(rawKey).toString("hex");
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return { publicKeyHex, privateKeyPem };
}
