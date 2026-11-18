/**
 * @crewhaus/worker-runtime — the bearer check in front of a worker's
 * `POST /chat`.
 *
 * A worker answers `/chat` only for a request whose `Authorization` header
 * carries `Bearer <token>` with the token its `CHAT_TOKEN` secret holds
 * (`wrangler secret put CHAT_TOKEN`). The token is read from that header
 * only, never from the URL or the body. While the secret is unset or empty,
 * every request is answered 503 `NO_CHAT_TOKEN`. A missing header, another
 * scheme and a wrong token all get the same 401 `UNAUTHORIZED`, so the
 * answer says nothing about which part was wrong.
 *
 * The comparison runs in constant time: both values are digested with
 * SHA-256 (WebCrypto, which a worker has) on every call, a missing header
 * included, and the two digests are compared with a fixed 32-step XOR fold
 * that never exits early. The scheme is matched without regard to case, and
 * the token and the secret are each trimmed, so a secret saved with a
 * trailing newline still matches.
 */

/** Why `/chat` refuses a request: the status and the `{ error: { code, message } }` it answers. */
export type ChatAuthRefusal = {
  readonly status: 401 | 503;
  readonly code: "UNAUTHORIZED" | "NO_CHAT_TOKEN";
  readonly message: string;
};

const NO_CHAT_TOKEN: ChatAuthRefusal = Object.freeze({
  status: 503,
  code: "NO_CHAT_TOKEN",
  message: "this worker has no CHAT_TOKEN secret: set one with `wrangler secret put CHAT_TOKEN`",
});

const UNAUTHORIZED: ChatAuthRefusal = Object.freeze({
  status: 401,
  code: "UNAUTHORIZED",
  message: "a valid bearer token is required",
});

const BEARER = /^bearer[ \t]+(.+)$/i;

/** The token a header presents, trimmed; `""` for no header or another scheme. */
function presentedToken(authorization: string | null): string {
  if (authorization === null) return "";
  const match = BEARER.exec(authorization.trim());
  return match?.[1]?.trim() ?? "";
}

/** SHA-256 of both values, compared with a fixed-length fold that never exits early. */
async function sameToken(presented: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < 32; i++) difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return difference === 0;
}

/**
 * Why `POST /chat` refuses this request, or `undefined` when it may run.
 * `authorization` is the request's `Authorization` header (`null` when it has
 * none); `chatToken` is the worker's `CHAT_TOKEN` binding, as `env` holds it.
 */
export async function chatAuthRefusal(
  authorization: string | null,
  chatToken: unknown,
): Promise<ChatAuthRefusal | undefined> {
  const expected = typeof chatToken === "string" ? chatToken.trim() : "";
  if (expected === "") return NO_CHAT_TOKEN;
  return (await sameToken(presentedToken(authorization), expected)) ? undefined : UNAUTHORIZED;
}
