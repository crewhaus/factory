/**
 * The sign-in routes, served before the auth gate (and after the Host allowlist):
 *
 *   GET  /api/v1/auth/challenge   public          a single-use nonce for a device to sign
 *   POST /api/v1/auth/session     public          a signed challenge → a sealed session
 *   POST /api/v1/auth/exchange    public          a boot link's code + a new device key → a sealed session
 *   POST /api/v1/auth/refresh     a session       a new sealed secret for the same session
 *   POST /api/v1/auth/sign-out    a session       end it
 *
 * Bodies are checked with control-contract's schemas, and a refusal never echoes what was
 * sent (the exchange `code` above all). Every answer passes the dispatch masker and is
 * never cached. A session secret leaves only sealed to the key the request carried, so a
 * proxy that logs bodies logs ciphertext. Nothing here logs a request body.
 */
import type { Peer } from "@crewhaus/access-control";
import {
  authExchangeRequest,
  authRefreshRequest,
  authSessionRequest,
  emptyRequest,
} from "@crewhaus/control-contract/schemas";
import { type HomeAccess, checkAccess, refusalOf, refusalResponse } from "./access";
import { json } from "./http";
import { maskDeep } from "./mask";

/**
 * The sign-in routes, for the built-in index and for Home's off-map route list.
 *
 * First consumer: `builtinIndex` in `server.ts`.
 */
export const SIGN_IN_ROUTES = [
  { method: "GET", path: "/api/v1/auth/challenge", permission: "public" },
  { method: "POST", path: "/api/v1/auth/session", permission: "public" },
  { method: "POST", path: "/api/v1/auth/exchange", permission: "public" },
  { method: "POST", path: "/api/v1/auth/refresh", permission: "authenticated" },
  { method: "POST", path: "/api/v1/auth/sign-out", permission: "authenticated" },
] as const;

const PREFIX = "/api/v1/auth/";
/** A sign-in body is a few hundred bytes; anything larger is not one. */
const MAX_BODY_BYTES = 8 * 1024;

/** Whether this path is one of the sign-in routes' (any method). */
export function isSignInPath(pathname: string): boolean {
  return pathname.startsWith(PREFIX);
}

function refuse(
  pathname: string,
  status: number,
  code: string,
  reason: string,
  message: string,
): Response {
  return refusalResponse(pathname, { status, code, reason, message });
}

/** What this module needs of a schema: the one call it makes. */
type Schema = {
  safeParse(
    value: unknown,
  ): { readonly success: true; readonly data: unknown } | { readonly success: false };
};

async function bodyOf(
  req: Request,
  schema: Schema,
): Promise<{ value: unknown } | { refused: true }> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { refused: true };
  }
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return { refused: true };
  let parsed: unknown;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    return { refused: true };
  }
  const checked = schema.safeParse(parsed);
  return checked.success ? { value: checked.data } : { refused: true };
}

function issuedAnswer(answer: {
  readonly issued: unknown;
  readonly expiresAt: string;
  readonly principal: string;
  readonly device: string;
}): Response {
  return json(
    maskDeep({
      issued: answer.issued,
      expiresAt: answer.expiresAt,
      principal: answer.principal,
      device: answer.device,
    }),
  );
}

/**
 * Serve one sign-in request.
 *
 * First consumer: `handle` in `server.ts`.
 */
export async function serveSignIn(
  home: HomeAccess,
  req: Request,
  peer: Peer,
  pathname: string,
): Promise<Response> {
  const route = SIGN_IN_ROUTES.find((r) => r.path === pathname);
  if (route === undefined) return refuse(pathname, 404, "not_found", "no_route", "not found");
  if (req.method !== route.method) {
    return refuse(pathname, 405, "invalid", "method_not_allowed", "method not allowed");
  }
  const badBody = (): Response =>
    refuse(
      pathname,
      400,
      "invalid",
      "body_invalid",
      "The request body is not what this route takes.",
    );
  const signIn = home.signIn;

  if (pathname === "/api/v1/auth/challenge") return json(maskDeep(signIn.challenge()));

  if (pathname === "/api/v1/auth/exchange") {
    const body = await bodyOf(req, authExchangeRequest);
    if ("refused" in body) return badBody();
    const answer = await signIn.exchange(body.value as Parameters<typeof signIn.exchange>[0]);
    if (!answer.ok)
      return refuse(pathname, answer.status, answer.code, answer.reason, answer.message);
    return issuedAnswer(answer);
  }

  if (pathname === "/api/v1/auth/session") {
    const body = await bodyOf(req, authSessionRequest);
    if ("refused" in body) return badBody();
    const answer = await signIn.signInWithDevice(
      body.value as Parameters<typeof signIn.signInWithDevice>[0],
    );
    if (!answer.ok)
      return refuse(pathname, answer.status, answer.code, answer.reason, answer.message);
    return issuedAnswer(answer);
  }

  // Refresh and sign-out act on the session that asks, and on nothing else.
  const { answer: who } = await checkAccess(home, req, peer);
  const refused = refusalOf(who);
  if (refused !== undefined) return refusalResponse(pathname, refused);
  if (who.kind !== "principal" || who.via !== "session" || who.sessionRef === undefined) {
    return refuse(
      pathname,
      403,
      "forbidden",
      "session_required",
      "Only a signed-in browser session can do this.",
    );
  }
  if (pathname === "/api/v1/auth/refresh") {
    const body = await bodyOf(req, authRefreshRequest);
    if ("refused" in body) return badBody();
    const answer = await signIn.refresh(who.sessionRef, (body.value as { seal: never }).seal);
    if (!answer.ok)
      return refuse(pathname, answer.status, answer.code, answer.reason, answer.message);
    return issuedAnswer(answer);
  }
  const body = await bodyOf(req, emptyRequest);
  if ("refused" in body) return badBody();
  const out = await signIn.signOut(who.sessionRef);
  if ("ok" in out) return refuse(pathname, out.status, out.code, out.reason, out.message);
  return json(maskDeep(out));
}
