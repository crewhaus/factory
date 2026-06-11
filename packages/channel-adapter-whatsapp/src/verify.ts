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

export type WhatsAppVerifyOptions = {
  readonly now?: () => number;
  readonly toleranceMs?: number;
};

// WhatsApp signs only the body — there is no signed timestamp header — so the
// replay-window check reads `messages[].timestamp` from the AUTHENTICATED body
// after the HMAC passes. Unlike the Slack/Discord real-time interaction
// windows, WhatsApp redelivers failed webhooks on its own (multi-minute) retry
// schedule, so this default is deliberately more generous: it bounds INDEFINITE
// replay of a captured message rather than enforcing sub-minute freshness.
// Operators can widen/tighten it via `toleranceMs`; the gateway's durable
// cross-process dedup is the complementary, stronger control.
const DEFAULT_TOLERANCE_MS = 10 * 60 * 1000;

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
}

/**
 * Newest `messages[].timestamp` (unix seconds) in a WhatsApp webhook body, or
 * undefined when there is none (e.g. status-only webhooks, which are skipped
 * downstream). An attacker cannot strip the timestamp from a signed message
 * body without invalidating the HMAC, so "no timestamp ⇒ accept" is safe.
 */
function newestMessageTimestamp(body: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const entries = asRecord(parsed)?.["entry"];
  if (!Array.isArray(entries)) return undefined;
  let newest: number | undefined;
  const consider = (raw: unknown): void => {
    const n =
      typeof raw === "number"
        ? raw
        : typeof raw === "string"
          ? Number.parseInt(raw, 10)
          : Number.NaN;
    if (Number.isFinite(n)) newest = newest === undefined ? n : Math.max(newest, n);
  };
  for (const entryRaw of entries) {
    const changes = asRecord(entryRaw)?.["changes"];
    if (!Array.isArray(changes)) continue;
    for (const changeRaw of changes) {
      const messages = asRecord(asRecord(changeRaw)?.["value"])?.["messages"];
      if (!Array.isArray(messages)) continue;
      for (const msgRaw of messages) consider(asRecord(msgRaw)?.["timestamp"]);
    }
  }
  return newest;
}

export function verifyWhatsAppSignature(
  args: WhatsAppVerifyArgs,
  opts: WhatsAppVerifyOptions = {},
): boolean {
  const supplied = args.headers.get("x-hub-signature-256");
  if (!supplied) return false;
  if (!supplied.startsWith("sha256=")) return false;
  const sigHex = supplied.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/i.test(sigHex)) return false;

  const expected = createHmac("sha256", args.appSecret).update(args.body).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(sigHex.toLowerCase(), "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  if (!timingSafeEqual(expectedBuf, actualBuf)) return false;

  // HMAC valid — now bound replay on the authenticated body.
  const now = opts.now ?? (() => Date.now());
  const tolerance = opts.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  const ts = newestMessageTimestamp(args.body);
  if (ts !== undefined && Math.abs(now() - ts * 1000) > tolerance) return false;
  return true;
}

/**
 * Sign a body — used by smoke tests and the in-repo integration test to
 * construct fixtures the daemon will accept. Production code should NEVER
 * call this — Meta signs requests, not us.
 */
export function signWhatsAppBody(args: { body: string; appSecret: string }): string {
  return `sha256=${createHmac("sha256", args.appSecret).update(args.body).digest("hex")}`;
}
