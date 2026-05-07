import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a Slack webhook signature per
 * https://api.slack.com/authentication/verifying-requests-from-slack.
 *
 * Signing-base string is `v0:${timestamp}:${body}`. HMAC-SHA256 with the
 * signing secret, hex-encoded, with `v0=` prefix. Compared via
 * `timingSafeEqual` (constant-time, prevents nibble-leak side channels).
 *
 * The 5-minute timestamp tolerance is the Slack-recommended replay-window
 * cap; without it a captured signed payload could be re-played indefinitely.
 *
 * Returns false on missing headers, malformed timestamp, mismatched
 * signature, or stale/future timestamp.
 */
export type VerifyArgs = {
  readonly headers: Headers;
  readonly body: string;
  readonly signingSecret: string;
};

export type VerifyOptions = {
  readonly now?: () => number;
  readonly toleranceMs?: number;
};

const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;

export function verifySlackSignature(args: VerifyArgs, opts: VerifyOptions = {}): boolean {
  const now = opts.now ?? (() => Date.now());
  const tolerance = opts.toleranceMs ?? DEFAULT_TOLERANCE_MS;

  const timestamp = args.headers.get("x-slack-request-timestamp");
  const signature = args.headers.get("x-slack-signature");
  if (!timestamp || !signature) return false;

  const tsNum = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(now() - tsNum * 1000) > tolerance) return false;

  const base = `v0:${timestamp}:${args.body}`;
  const expected = `v0=${createHmac("sha256", args.signingSecret).update(base).digest("hex")}`;

  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signature, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Compute a valid `X-Slack-Signature` for a body — used by smoke tests and
 * the in-repo integration test to construct fixtures the daemon will accept.
 * Production code should NEVER call this — Slack signs requests, not us.
 */
export function signSlackBody(args: {
  body: string;
  timestamp: number;
  signingSecret: string;
}): string {
  const base = `v0:${args.timestamp}:${args.body}`;
  return `v0=${createHmac("sha256", args.signingSecret).update(base).digest("hex")}`;
}
