import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * WhatsApp Business Cloud API webhook signature verification per
 * https://developers.facebook.com/docs/graph-api/webhooks/getting-started.
 *
 * Meta signs webhooks with `X-Hub-Signature-256: sha256=<hex>` where the
 * MAC is HMAC-SHA256 of the raw request body using the app secret as key.
 *
 * Returns false on missing header, malformed format, mismatched signature.
 */
export type WhatsAppVerifyArgs = {
  readonly headers: Headers;
  readonly body: string;
  readonly appSecret: string;
};

export function verifyWhatsAppSignature(args: WhatsAppVerifyArgs): boolean {
  const supplied = args.headers.get("x-hub-signature-256");
  if (!supplied) return false;
  if (!supplied.startsWith("sha256=")) return false;
  const sigHex = supplied.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/i.test(sigHex)) return false;

  const expected = createHmac("sha256", args.appSecret).update(args.body).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(sigHex.toLowerCase(), "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Sign a body — used by smoke tests and the in-repo integration test to
 * construct fixtures the daemon will accept. Production code should NEVER
 * call this — Meta signs requests, not us.
 */
export function signWhatsAppBody(args: { body: string; appSecret: string }): string {
  return `sha256=${createHmac("sha256", args.appSecret).update(args.body).digest("hex")}`;
}
