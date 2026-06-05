/**
 * Isolated test for the defensive `catch` around Node's `crypto.verify` in
 * `verifyDiscordSignature`.
 *
 * With a valid Ed25519 key and a 64-byte signature, OpenSSL's `verify` returns
 * `false` rather than throwing, so the catch is unreachable through ordinary
 * inputs. It is still legitimate defensive code: `crypto.verify(null, …)` can
 * throw `ERR_OSSL_*` for unexpected key/state combinations. We exercise it by
 * stubbing `node:crypto.verify` to throw and asserting the function degrades to
 * `false` instead of propagating.
 *
 * `mock.module` mutates the shared module registry, so this lives in its own
 * file: Bun gives each test file a fresh module graph, which keeps the stub
 * from leaking into `index.test.ts`.
 */
import { expect, mock, test } from "bun:test";

const realCrypto = require("node:crypto") as typeof import("node:crypto");

mock.module("node:crypto", () => ({
  ...realCrypto,
  // Force the verification path to throw the way OpenSSL can under
  // unexpected conditions (e.g. ERR_OSSL_NO_DEFAULT_DIGEST).
  verify: () => {
    throw new Error("ERR_OSSL synthetic failure");
  },
}));

// Import the module under test *after* the stub is registered so its
// `import { verify } from "node:crypto"` binding resolves to the stub.
const { verifyDiscordSignature, generateEd25519Keypair, signDiscordBody } = await import(
  "./verify.js"
);

test("verifyDiscordSignature returns false when crypto.verify throws", () => {
  // Keypair generation + signing still use the real crypto (spread above).
  const { publicKeyHex, privateKeyPem } = generateEd25519Keypair();
  const body = JSON.stringify({ type: 1 });
  const timestamp = "1700000000";
  const sig = signDiscordBody({ body, timestamp, privateKeyPem });

  const headers = new Headers();
  headers.set("X-Signature-Ed25519", sig);
  headers.set("X-Signature-Timestamp", timestamp);

  // Every guard (hex regex, timestamp regex, 64-byte length, public-key
  // construction) passes, so control reaches the `verify(...)` call — which
  // now throws — and the catch must convert it to a clean `false`.
  expect(verifyDiscordSignature({ headers, body, publicKeyHex })).toBe(false);
});
