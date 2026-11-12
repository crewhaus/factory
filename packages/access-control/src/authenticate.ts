/**
 * `authenticate`: one request to at most one principal, at the one place Home checks.
 *
 * The order is fixed:
 *
 * 1. **The proxy identity**, only in trusted-proxy mode. The configured header counts
 *    only from a listed peer that also sends `CrewHaus-Proxy-Secret` hashing to the
 *    configured digest, or on `<hangarRoot>/proxy.sock`, whose file mode is the proof.
 *    From anywhere else it is ignored, and the caller strips it before dispatch.
 * 2. **The bearer.** `cha_…` is a session, looked up by its digest; `chs_…` is a service
 *    token, looked up by its digest; any other value is compared as Home's own key, and
 *    is accepted only on `<hangarRoot>/home.sock`, or over TCP from a loopback peer that
 *    sent no forwarding header, when the key is not socket-only and no proxy is trusted.
 *    A reverse proxy on this computer therefore cannot relay it.
 * 3. A bearer and a proxy identity that name different principals are refused.
 * 4. Until route authorization lands, only the home owner is admitted.
 *
 * The package still opens no socket: Home hands in the peer it saw.
 */
import { parseLinkSubject } from "@crewhaus/control-contract";
import { keyedDigest } from "@crewhaus/control-records";
import { LINK_SUBJECT_LABEL, normalizeLinkSubject } from "./access";
import { type Cidr, cidrContains, isLoopbackAddress, parseCidr } from "./addresses";
import { tokenEquals } from "./bootstrap";
import { sha256Hex } from "./secrets";
import type { SignInHandle } from "./sign-in";
import { type AccessSnapshot, isActivePrincipal, isLiveCredential } from "./snapshot";

/**
 * Home's own socket, under the Hangar root: only its OS user can open it, so it takes
 * Home's own key whatever else is configured.
 *
 * First consumers: Home's listeners, and `crewhaus hangar open`, which mints links over it.
 */
export const HOME_SOCKET = "home.sock";

/**
 * The trusted proxy's socket, under the Hangar root, in proxy mode with `socket: true`.
 *
 * First consumer: Home's listeners.
 */
export const PROXY_SOCKET = "proxy.sock";

/** Where a request arrived: Home's TCP listener, its own socket, or the proxy's socket. */
export type Listener = "tcp" | "home.sock" | "proxy.sock";

export type Peer = {
  /** The TCP peer's address; `null` on a socket. */
  readonly address: string | null;
  readonly listener: Listener;
};

/** The owner's trusted-proxy settings, validated. The header name is lower-case. */
export type TrustedProxy = {
  readonly header: string;
  /** CIDR blocks the proxy connects from. */
  readonly peers: readonly string[];
  /** The public names the proxy serves Home under. */
  readonly hosts: readonly string[];
  /** Lowercase hex sha256 of the secret the proxy injects. */
  readonly secretDigest?: string;
  /** The proxy connects over `<hangarRoot>/proxy.sock`. */
  readonly socket?: true;
};

export type AuthenticateConfig = { readonly trustedProxy?: TrustedProxy };

export type AuthenticateState = {
  readonly signIn: SignInHandle;
  /** The token Home read at boot: the bootstrap only while no access record holds one. */
  readonly bootToken: string | undefined;
  readonly now?: () => number;
};

/**
 * The header a trusted proxy proves itself with.
 *
 * First consumers: `authenticate`, and `crewhaus access proxy`, which names it.
 */
export const PROXY_SECRET_HEADER = "crewhaus-proxy-secret";

export type AuthVia = "bootstrap" | "session" | "service" | "proxy";

export type Identified = { readonly principal: string; readonly via: AuthVia };

export type Authenticated = (
  | {
      readonly kind: "principal";
      readonly principal: string;
      readonly via: AuthVia;
      /** The session's reference, for a session. */
      readonly sessionRef?: string;
    }
  | { readonly kind: "anonymous" }
  | {
      readonly kind: "refused";
      readonly code: "unauthenticated" | "forbidden" | "authorization_unavailable" | "unavailable";
      readonly status: 401 | 403 | 503;
      readonly reason: string;
      readonly message: string;
    }
) & {
  /** A proxy identity or proxy secret arrived that does not count: strip both, note it. */
  readonly ignoredProxyHeaders?: true;
};

type Refused = Extract<Authenticated, { kind: "refused" }>;

/**
 * The principal a request names before access records exist: Home's own key, which is
 * the owner.
 *
 * First consumer: `authenticate`.
 */
export const BOOTSTRAP_PRINCIPAL = "bootstrap";

function refused(
  code: Refused["code"],
  status: Refused["status"],
  reason: string,
  message: string,
): Refused {
  return { kind: "refused", code, status, reason, message };
}

/**
 * Admit only the home owner. Every other principal is refused with
 * `authorization_unavailable` until route authorization lands, when this function goes:
 * no route ever serves a principal that nothing has authorized.
 *
 * First consumer: `authenticate`, as its last step.
 */
export function admitUntilAuthorization(
  identity: Identified,
  snapshot: AccessSnapshot | undefined,
): { readonly admit: true } | Refused {
  if (identity.via === "bootstrap") return { admit: true };
  if (snapshot?.owner !== undefined && identity.principal === snapshot.owner) {
    return { admit: true };
  }
  return refused(
    "authorization_unavailable",
    403,
    "owner_only",
    "Only this Home's owner can use it for now.",
  );
}

/** Whether the request carries a header a forwarding proxy adds, or the identity header. */
export function hasForwardingHeaders(request: Request, identityHeader?: string): boolean {
  for (const name of request.headers.keys()) {
    const lower = name.toLowerCase();
    if (lower === "forwarded" || lower === "x-real-ip" || lower.startsWith("x-forwarded-")) {
      return true;
    }
    if (identityHeader !== undefined && lower === identityHeader) return true;
  }
  return false;
}

function bearerOf(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (header === null) return undefined;
  const [scheme, ...rest] = header.split(" ");
  if (scheme === undefined || scheme.toLowerCase() !== "bearer") return undefined;
  const presented = rest.join(" ").trim();
  return presented.length === 0 ? undefined : presented;
}

const cidrCache = new WeakMap<readonly string[], readonly Cidr[]>();

function cidrsOf(peers: readonly string[]): readonly Cidr[] {
  const cached = cidrCache.get(peers);
  if (cached !== undefined) return cached;
  const parsed = peers.map(parseCidr).filter((c): c is Cidr => c !== undefined);
  cidrCache.set(peers, parsed);
  return parsed;
}

/** Whether this request proves it came from the trusted proxy. */
async function proxyProven(request: Request, peer: Peer, proxy: TrustedProxy): Promise<boolean> {
  if (peer.listener === "proxy.sock") return proxy.socket === true;
  if (peer.listener !== "tcp" || proxy.secretDigest === undefined) return false;
  if (!cidrsOf(proxy.peers).some((cidr) => cidrContains(cidr, peer.address))) return false;
  const secret = request.headers.get(PROXY_SECRET_HEADER);
  if (secret === null || secret === "") return false;
  return tokenEquals(await sha256Hex(secret), proxy.secretDigest);
}

async function linkedPrincipal(
  subject: string,
  snapshot: AccessSnapshot | undefined,
  state: AuthenticateState,
): Promise<string | null> {
  if (snapshot === undefined || parseLinkSubject(subject) !== "proxy") return null;
  const key = await state.signIn.subjectKey();
  if (key === undefined) return null;
  const ref = await keyedDigest(key, LINK_SUBJECT_LABEL, [normalizeLinkSubject(subject)]);
  const link = snapshot.links.find(
    (row) => row.provider === "proxy" && row.state === "active" && row.subjectRef === ref,
  );
  return link !== undefined && isActivePrincipal(snapshot, link.principal) ? link.principal : null;
}

const SIGN_IN_AGAIN = "Sign in again.";

/**
 * Authenticate one request. Never throws; a refusal names its reason.
 *
 * First consumer: Home's choke point (`hangar-server`'s `access.ts`).
 */
export async function authenticate(
  request: Request,
  peer: Peer,
  config: AuthenticateConfig,
  state: AuthenticateState,
): Promise<Authenticated> {
  const now = (state.now ?? Date.now)();
  const proxy = config.trustedProxy;
  const read = state.signIn.snapshot();
  if (read.state === "unreadable") {
    return refused(
      "unavailable",
      503,
      "access_unreadable",
      "Home's access records cannot be read. Run `crewhaus access members` on this computer to see why.",
    );
  }
  const snapshot = read.state === "present" ? read.snapshot : undefined;

  // 1. The proxy identity.
  let proxySubject: string | undefined;
  let ignored = false;
  if (proxy !== undefined) {
    const value = request.headers.get(proxy.header);
    if (await proxyProven(request, peer, proxy)) {
      if (value !== null && value !== "") proxySubject = `proxy:${proxy.header}:${value}`;
    } else if (value !== null || request.headers.has(PROXY_SECRET_HEADER)) {
      ignored = true;
    }
  }
  const tag = <T extends Authenticated>(answer: T): T =>
    ignored ? { ...answer, ignoredProxyHeaders: true } : answer;

  // 2. The bearer.
  let fromBearer: (Identified & { readonly sessionRef?: string }) | undefined;
  const bearer = bearerOf(request);
  if (bearer !== undefined) {
    if (bearer.startsWith("cha_")) {
      const check = await state.signIn.verifyBearer(bearer);
      if (!check.ok) {
        return tag(
          refused(
            "unauthenticated",
            401,
            check.reason,
            check.reason === "session_expired"
              ? `This session has ended. ${SIGN_IN_AGAIN}`
              : `This session is not one Home knows. ${SIGN_IN_AGAIN}`,
          ),
        );
      }
      fromBearer = { principal: check.principal, via: "session", sessionRef: check.sessionRef };
    } else if (bearer.startsWith("chs_")) {
      const digest = await sha256Hex(bearer);
      const row = snapshot?.tokens.find((t) => t.kind === "service" && t.sha256 === digest);
      if (snapshot === undefined || row === undefined || !isLiveCredential(snapshot, row, now)) {
        return tag(
          refused("unauthenticated", 401, "credential_unknown", "That token does not work here."),
        );
      }
      fromBearer = { principal: row.principal, via: "service" };
    } else {
      const bootstraps = snapshot?.tokens.filter((t) => t.kind === "bootstrap") ?? [];
      const socketOnly = bootstraps.some((t) => t.state === "active" && t.socketOnly === true);
      const direct =
        peer.listener === "home.sock" ||
        (peer.listener === "tcp" &&
          !socketOnly &&
          proxy === undefined &&
          isLoopbackAddress(peer.address) &&
          !hasForwardingHeaders(request));
      if (!direct) {
        return tag(
          refused(
            "unauthenticated",
            401,
            "bootstrap_not_accepted_here",
            "Home's own key works only on the computer Home runs on. Sign in with a link from `crewhaus hangar open`.",
          ),
        );
      }
      let matches: boolean;
      if (snapshot !== undefined && bootstraps.length > 0) {
        const digest = await sha256Hex(bearer);
        matches = bootstraps.some((t) => t.sha256 === digest && isLiveCredential(snapshot, t, now));
      } else {
        matches = state.bootToken !== undefined && tokenEquals(bearer, state.bootToken);
      }
      if (!matches) {
        return tag(
          refused("unauthenticated", 401, "credential_unknown", "That token does not work here."),
        );
      }
      fromBearer = { principal: snapshot?.owner ?? BOOTSTRAP_PRINCIPAL, via: "bootstrap" };
    }
  }

  // 3. Bearer and proxy identity must agree.
  let fromProxy: string | null | undefined;
  if (proxySubject !== undefined) fromProxy = await linkedPrincipal(proxySubject, snapshot, state);
  if (fromBearer !== undefined && fromProxy !== undefined && fromProxy !== fromBearer.principal) {
    return tag(
      refused(
        "unauthenticated",
        401,
        "identity_mismatch",
        "The sign-in and the proxy's identity name different people.",
      ),
    );
  }
  const identity: (Identified & { readonly sessionRef?: string }) | undefined =
    fromBearer ??
    (fromProxy !== undefined && fromProxy !== null
      ? { principal: fromProxy, via: "proxy" }
      : undefined);
  if (identity === undefined) {
    if (fromProxy === null) {
      return tag(
        refused("forbidden", 403, "not_invited", "Ask the owner of this Home to invite you."),
      );
    }
    return tag({ kind: "anonymous" });
  }

  // 4. The owner only, until route authorization lands.
  const admitted = admitUntilAuthorization(identity, snapshot);
  if ("kind" in admitted) return tag(admitted);
  return tag({
    kind: "principal",
    principal: identity.principal,
    via: identity.via,
    ...(identity.sessionRef !== undefined ? { sessionRef: identity.sessionRef } : {}),
  });
}
