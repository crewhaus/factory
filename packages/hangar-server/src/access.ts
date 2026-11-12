/**
 * Home's one authentication step, over `@crewhaus/access-control`.
 *
 * `handle()` calls `checkAccess` for every `/api` request, after the Host allowlist and
 * before the read-only gate. It hands in the peer the listener saw (the TCP address, or
 * which socket), gets a principal or a refusal back, and, when a proxy identity header
 * arrived from somewhere that could not prove it is the proxy, strips that header and
 * the proxy secret before anything else reads the request, and notes it, content-free.
 *
 * A refusal answers in the envelope of the route it refused: the v1 envelope
 * (`{error: {code, message, retryable, details}}`) under `/api/v1`, and the legacy
 * `{error: <message>}` elsewhere, with `code` and `reason` beside it so the console and
 * older tests that read `error` keep working.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  type AuthenticateConfig,
  type Authenticated,
  PROXY_SECRET_HEADER,
  type Peer,
  type SignInHandle,
  TOKEN_FILENAME,
  authenticate,
  loadAccessSnapshot,
} from "@crewhaus/access-control";
import { json } from "./http";

export type AccessCheck = {
  readonly answer: Authenticated;
  /** The request to dispatch: the one given, or a copy without ignored proxy headers. */
  readonly request: Request;
};

export type HomeAccess = {
  readonly signIn: SignInHandle;
  readonly config: AuthenticateConfig;
  /** The token Home read at boot. */
  readonly bootToken: string | undefined;
  readonly now: () => number;
};

/** A copy of `req` without the proxy identity header and the proxy secret. */
function stripProxyHeaders(req: Request, identityHeader: string | undefined): Request {
  const headers = new Headers(req.headers);
  headers.delete(PROXY_SECRET_HEADER);
  if (identityHeader !== undefined) headers.delete(identityHeader);
  return new Request(req, { headers });
}

/**
 * Authenticate one request.
 *
 * First consumer: `handle` in `server.ts`, and the sign-in routes that need a session.
 */
export async function checkAccess(
  home: HomeAccess,
  req: Request,
  peer: Peer,
): Promise<AccessCheck> {
  const answer = await authenticate(req, peer, home.config, {
    signIn: home.signIn,
    bootToken: home.bootToken,
    now: home.now,
  });
  if (answer.ignoredProxyHeaders !== true) return { answer, request: req };
  await home.signIn.noteIgnoredIdentity(peer.listener, peer.address).catch(() => {});
  return { answer, request: stripProxyHeaders(req, home.config.trustedProxy?.header) };
}

/** Whether a path is under the v1 API, which answers in the v1 envelope. */
export function isV1Path(pathname: string): boolean {
  return pathname === "/api/v1" || pathname.startsWith("/api/v1/");
}

export type RefusalBody = {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly reason: string;
};

/**
 * The response for a refusal, in the envelope of the path it refused.
 *
 * First consumer: `handle` in `server.ts`.
 */
export function refusalResponse(pathname: string, refusal: RefusalBody): Response {
  const headers: Record<string, string> =
    refusal.status === 401 ? { "www-authenticate": "Bearer" } : {};
  if (isV1Path(pathname)) {
    return json(
      {
        error: {
          code: refusal.code,
          message: refusal.message,
          retryable: refusal.status === 503,
          details: { reason: refusal.reason },
        },
      },
      refusal.status,
      headers,
    );
  }
  return json(
    { error: refusal.message, code: refusal.code, reason: refusal.reason },
    refusal.status,
    headers,
  );
}

/** The refusal for a request that names nobody. */
export const NOBODY: RefusalBody = Object.freeze({
  status: 401,
  code: "unauthenticated",
  message: "missing or invalid bearer token",
  reason: "no_credential",
});

/** A refusal body from a refused or anonymous answer. */
export function refusalOf(answer: Authenticated): RefusalBody | undefined {
  if (answer.kind === "anonymous") return NOBODY;
  if (answer.kind === "refused") {
    return {
      status: answer.status,
      code: answer.code,
      message: answer.message,
      reason: answer.reason,
    };
  }
  return undefined;
}

/**
 * Why Home must not boot with the key in `<hangarRoot>/token`, or `undefined`.
 *
 * Once the access records hold Home's own key (the first sign-in or rotation records it),
 * that record is the key, not the file. When the file no longer matches it (deleted and
 * minted again at this boot, replaced, or restored from an old copy), the file's key
 * would be refused on every request and `crewhaus hangar open` could not mint a link, so
 * Home stops at boot and names the one verb that makes file and record agree again.
 *
 * First consumer: `startHangarServer`.
 */
export function bootstrapKeyMismatch(hangarRoot: string, token: string): string | undefined {
  const read = loadAccessSnapshot(hangarRoot);
  if (read.state !== "present") return undefined;
  const recorded = read.snapshot.tokens.filter((row) => row.kind === "bootstrap");
  if (recorded.length === 0) return undefined;
  const digest = createHash("sha256").update(token, "utf8").digest("hex");
  if (recorded.some((row) => row.state === "active" && row.sha256 === digest)) return undefined;
  return `hangar-server: ${join(hangarRoot, TOKEN_FILENAME)} is not the key Home recorded (it was deleted, replaced or restored from an old copy), so it would be refused — run \`crewhaus hangar rotate-token\` to make a new one, then start Home again`;
}
