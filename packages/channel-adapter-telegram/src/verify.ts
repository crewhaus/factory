import { timingSafeEqual } from "node:crypto";

/**
 * Telegram webhook verification.
 *
 * Telegram authenticates webhooks by sending the secret token (configured
 * via `setWebhook(secret_token=...)` on the Bot API) in the
 * `X-Telegram-Bot-Api-Secret-Token` header on every POST. We compare it
 * to the secret we hold using `timingSafeEqual` to avoid nibble-leak
 * side channels.
 *
 * Telegram does not sign the body, so there is no replay-window check
 * (the secret token alone authenticates). The Bot API secret is
 * 1–256 chars, A–Z / a–z / 0–9 / _ / -.
 */
export type TelegramVerifyArgs = {
  readonly headers: Headers;
  readonly secretToken: string;
};

export function verifyTelegramSecret(args: TelegramVerifyArgs): boolean {
  const supplied = args.headers.get("x-telegram-bot-api-secret-token");
  if (!supplied) return false;
  if (supplied.length !== args.secretToken.length) return false;
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(args.secretToken, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
