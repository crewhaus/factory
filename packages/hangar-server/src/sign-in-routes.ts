/**
 * The sign-in routes, served before the auth gate (and after the Host allowlist):
 *
 *   GET  /api/v1/auth/challenge   public          a single-use nonce for a device to sign
 *   POST /api/v1/auth/session     public          a signed challenge → a sealed session
 *   POST /api/v1/auth/exchange    public          a boot link's code + a new device key → a sealed session
 *   POST /api/v1/auth/accept-invite public        an invite code + a name + a new device key → a member and a sealed session
 *   POST /api/v1/auth/refresh     a session       a new sealed secret for the same session
 *   POST /api/v1/auth/sign-out    a session       end it
 *   POST /api/v1/auth/device      public          start a device sign-in: a code to show, a sealed poll reference
 *   POST /api/v1/auth/device/poll public          collect it, once a member allowed it: a sealed personal token
 *
 * Joining from an invite is on record: once the invite is spent and the new member
 * exists, the `onInviteAccepted` hook writes the workspace receipt as that member.
 *
 * On a page served over plain HTTP there is no WebCrypto to make keys with, so joining
 * from an invite sends a secret the page made instead, and Home keeps only its digest: a
 * tab-only session, accepted only over TCP on the address the LAN door bound, with no
 * forwarding or proxy header, and only on a Home started with that door.
 *
 * Bodies are checked with control-contract's schemas, and a refusal never echoes what was
 * sent (the exchange `code` above all). Every answer passes the dispatch masker and is
 * never cached. A session secret leaves only sealed to the key the request carried, so a
 * proxy that logs bodies logs ciphertext. Nothing here logs a request body.
 */
import {
  type DeviceRequests,
  PROXY_SECRET_HEADER,
  type Peer,
  hasForwardingHeaders,
  hostNameOf,
  sealSecret,
} from "@crewhaus/access-control";
import type { CommandReceipt } from "@crewhaus/control-contract";
import {
  authAcceptInviteRequest,
  authExchangeRequest,
  authRefreshRequest,
  authSessionRequest,
  devicePollRequest,
  deviceStartRequest,
  emptyRequest,
} from "@crewhaus/control-contract/schemas";
import { readRequestBodyCapped } from "@crewhaus/gateway-protocol/body-limit";
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
  { method: "POST", path: "/api/v1/auth/accept-invite", permission: "public" },
  { method: "POST", path: "/api/v1/auth/refresh", permission: "authenticated" },
  { method: "POST", path: "/api/v1/auth/sign-out", permission: "authenticated" },
  { method: "POST", path: "/api/v1/auth/device", permission: "public" },
  { method: "POST", path: "/api/v1/auth/device/poll", permission: "public" },
] as const;

/** What the sign-in routes may be handed beside the access handle. */
export type SignInExtras = {
  /** The device sign-in requests; without them the device routes answer 404. */
  readonly devices?: DeviceRequests;
  /** Home's public address, for the page a device code is typed on. */
  readonly baseUrl?: string;
  /**
   * Called once an invite is spent and its member exists, with that member: it writes the
   * join's workspace receipt, which the answer carries.
   */
  readonly onInviteAccepted?: (accepted: {
    readonly principal: string;
  }) => Promise<CommandReceipt | undefined>;
};

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
  // Counted as it is read: a body past the limit is refused at the chunk that
  // passes it, and one that declares a larger length is refused unread.
  const read = await readRequestBodyCapped(req, MAX_BODY_BYTES);
  if (!read.ok) return { refused: true };
  const text = read.text;
  let parsed: unknown;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    return { refused: true };
  }
  const checked = schema.safeParse(parsed);
  return checked.success ? { value: checked.data } : { refused: true };
}

/** A device refusal on a sign-in route, in the v1 envelope, with when to ask again. */
function deviceRefusal(
  pathname: string,
  refusal: { status: number; code: string; reason: string; message: string; retryAfterMs?: number },
): Response {
  const response = refusalResponse(pathname, refusal);
  if (refusal.retryAfterMs === undefined) return response;
  return new Response(response.body, {
    status: response.status,
    headers: {
      ...Object.fromEntries(response.headers.entries()),
      "retry-after": String(Math.max(1, Math.ceil(refusal.retryAfterMs / 1000))),
    },
  });
}

function issuedAnswer(
  answer: {
    readonly issued: unknown;
    readonly expiresAt: string;
    readonly principal: string;
    readonly device: string;
  },
  receipt?: CommandReceipt,
): Response {
  return json(
    maskDeep({
      issued: answer.issued,
      expiresAt: answer.expiresAt,
      principal: answer.principal,
      device: answer.device,
      ...(receipt !== undefined ? { receipt } : {}),
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
  extras: SignInExtras = {},
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

  if (pathname === "/api/v1/auth/device" || pathname === "/api/v1/auth/device/poll") {
    const devices = extras.devices;
    if (devices === undefined) return refuse(pathname, 404, "not_found", "no_route", "not found");
    if (pathname === "/api/v1/auth/device") {
      const body = await bodyOf(req, deviceStartRequest);
      if ("refused" in body) return badBody();
      const input = body.value as { seal: never; clientName?: string; readOnly?: boolean };
      const started = await devices.start({
        ...(input.clientName !== undefined ? { clientName: input.clientName } : {}),
        ...(input.readOnly === true ? { readOnly: true } : {}),
      });
      if (!started.ok) return deviceRefusal(pathname, started);
      const origin = extras.baseUrl ?? new URL(req.url).origin;
      return json(
        maskDeep({
          issued: await sealSecret(input.seal, started.pollRef, "auth.device.start"),
          userCode: started.userCode,
          verificationUrl: `${origin.replace(/\/+$/, "")}/#/device`,
          intervalMs: started.intervalMs,
          expiresAt: started.expiresAt,
        }),
        200,
        { "cache-control": "no-store" },
      );
    }
    const body = await bodyOf(req, devicePollRequest);
    if ("refused" in body) return badBody();
    const input = body.value as { pollRef: string; seal: never };
    const polled = await devices.poll(input.pollRef);
    if (!polled.ok) return deviceRefusal(pathname, polled);
    if (polled.state !== "allowed") {
      return json(maskDeep({ state: polled.state }), 200, { "cache-control": "no-store" });
    }
    return json(
      maskDeep({
        issued: await sealSecret(input.seal, polled.secret, "auth.device.poll"),
        credentialRef: polled.token.id,
        ...(polled.token.prefixHint !== undefined ? { prefixHint: polled.token.prefixHint } : {}),
        ...(polled.token.expiresAt !== undefined ? { expiresAt: polled.token.expiresAt } : {}),
      }),
      200,
      { "cache-control": "no-store" },
    );
  }

  if (pathname === "/api/v1/auth/exchange") {
    const body = await bodyOf(req, authExchangeRequest);
    if ("refused" in body) return badBody();
    const answer = await signIn.exchange(body.value as Parameters<typeof signIn.exchange>[0]);
    if (!answer.ok)
      return refuse(pathname, answer.status, answer.code, answer.reason, answer.message);
    return issuedAnswer(answer);
  }

  if (pathname === "/api/v1/auth/accept-invite") {
    const body = await bodyOf(req, authAcceptInviteRequest);
    if ("refused" in body) return badBody();
    const input = body.value as Record<string, unknown>;
    if (typeof input["sessionSecret"] === "string") {
      // A tab-only session: only through the LAN door, as the page sees it, unrelayed.
      const lanHost = home.config.lanHost;
      const bare = (host: string): string =>
        host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
      if (
        lanHost === undefined ||
        peer.listener !== "tcp" ||
        hostNameOf(req.headers.get("host")) !== bare(lanHost) ||
        hasForwardingHeaders(req, home.config.trustedProxy?.header) ||
        req.headers.has(PROXY_SECRET_HEADER)
      ) {
        return refuse(
          pathname,
          403,
          "forbidden",
          "tab_only",
          "This page is not encrypted, so it can join only through the address `crewhaus hangar --lan` shows. Open Home on its own computer or over HTTPS.",
        );
      }
      const answer = await signIn.acceptInvite({
        code: String(input["code"]),
        displayName: String(input["displayName"]),
        sessionSecret: input["sessionSecret"],
        bindHost: lanHost,
      });
      if (!answer.ok) {
        return refuse(pathname, answer.status, answer.code, answer.reason, answer.message);
      }
      const receipt = await noteAccepted(extras, answer.principal);
      return json(
        maskDeep({
          ok: true,
          tabOnly: true,
          expiresAt: answer.expiresAt,
          principal: answer.principal,
          ...(receipt !== undefined ? { receipt } : {}),
        }),
      );
    }
    const answer = await signIn.acceptInvite(
      body.value as Parameters<typeof signIn.acceptInvite>[0],
    );
    if (!answer.ok) {
      return refuse(pathname, answer.status, answer.code, answer.reason, answer.message);
    }
    if ("tabOnly" in answer) return badBody();
    return issuedAnswer(answer, await noteAccepted(extras, answer.principal));
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

/** Put a spent invite on record, as its new member; never a reason to refuse the join. */
async function noteAccepted(
  extras: SignInExtras,
  principal: string,
): Promise<CommandReceipt | undefined> {
  if (extras.onInviteAccepted === undefined) return undefined;
  try {
    return await extras.onInviteAccepted({ principal });
  } catch {
    // The member exists and is signed in; the record is the hook's own to report.
    return undefined;
  }
}
