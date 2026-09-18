/**
 * The OCI distribution client: one GET, one 401, one token, one retry.
 *
 * Everything registry-specific is read off the challenge (see `./challenge`),
 * so Docker Hub, ghcr.io, quay.io and a self-hosted Harbor all take the same
 * code path. The only registry-specific thing in this package is the
 * `library/` namespace rewrite in `./ref`, which is a naming rule rather than a
 * protocol difference.
 *
 * The client is per CALL, not per process: the token cache lives in the object
 * the tool creates and dies with it. A module-level cache would make one call's
 * result depend on an earlier call's, which is the opposite of what a
 * deterministic tool is for — and would keep a bearer token alive in memory
 * long after the call that earned it.
 */
import {
  bearerChallenge,
  parseAuthenticateHeader,
  readTokenBody,
  tokenRequestUrl,
} from "./challenge";
import { type RawResponse, RegistryHttpError, deadlineSignal, httpGet } from "./http";

export class RegistryError extends Error {
  override readonly name = "RegistryError";
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

/** A token body is small; anything larger is not a token endpoint. */
const MAX_TOKEN_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * A ceiling on requests per tool call. `withDigests` fans out one GET per tag
 * and each may cost a token exchange, so without this a single call could ask a
 * registry a few hundred questions and earn a rate-limit ban for the caller.
 */
const MAX_REQUESTS = 140;

export type RegistryClient = {
  readonly host: string;
  readonly signal?: AbortSignal;
  readonly tokens: Map<string, string>;
  /** Requests actually issued, reported back so a caller can see what it cost. */
  requests: number;
  readonly timeoutMs: number;
};

export function newClient(
  host: string,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): RegistryClient {
  return {
    host,
    tokens: new Map(),
    requests: 0,
    timeoutMs,
    ...(signal !== undefined ? { signal } : {}),
  };
}

export type RegistryGetOptions = {
  readonly accept?: string;
  readonly maxBytes: number;
  /** The pull scope this path needs, e.g. `repository:library/alpine:pull`. */
  readonly scope: string;
};

/** `https://<host><path>` — the only place a registry URL is constructed. */
export function registryUrl(host: string, path: string): URL {
  return new URL(`https://${host}${path}`);
}

async function send(
  client: RegistryClient,
  url: URL,
  accept: string | undefined,
  authorization: string | undefined,
  maxBytes: number,
): Promise<RawResponse> {
  if (client.requests >= MAX_REQUESTS) {
    throw new RegistryError(
      `refusing to make more than ${MAX_REQUESTS} registry requests in one call — narrow the request (fewer tags, or drop withDigests)`,
    );
  }
  client.requests++;
  const { signal, dispose } = deadlineSignal(client.signal, client.timeoutMs);
  try {
    return await httpGet(url, {
      maxBytes,
      signal,
      ...(accept !== undefined ? { accept } : {}),
      ...(authorization !== undefined ? { authorization } : {}),
    });
  } finally {
    dispose();
  }
}

/**
 * GET a registry path, performing the anonymous token dance if the registry
 * asks for one. Returns the raw bytes; the caller decides whether to hash them,
 * parse them, or both — in that order.
 */
export async function registryGet(
  client: RegistryClient,
  path: string,
  options: RegistryGetOptions,
): Promise<RawResponse> {
  return registryGetUrl(client, registryUrl(client.host, path), options);
}

/**
 * The same dance against an already-built URL — what paging needs, since the
 * next page arrives as a `Link` header rather than a path we compose. The
 * caller has already checked that the URL is on the registry's own origin.
 */
export async function registryGetUrl(
  client: RegistryClient,
  url: URL,
  options: RegistryGetOptions,
): Promise<RawResponse> {
  const cached = client.tokens.get(options.scope);
  let res = await send(
    client,
    url,
    options.accept,
    cached === undefined ? undefined : `Bearer ${cached}`,
    options.maxBytes,
  );

  if (res.status === 401) {
    const token = await obtainToken(client, res, options.scope, cached !== undefined);
    client.tokens.set(options.scope, token);
    res = await send(client, url, options.accept, `Bearer ${token}`, options.maxBytes);
    // A 401 that survives a freshly minted anonymous token is not a transient
    // failure and not a missing image: it is a repository we are not allowed to
    // read. Saying so is more useful than a second round of the same dance.
    if (res.status === 401) throw privateRefusal(client.host, options.scope);
  }

  if (res.status >= 200 && res.status < 300) return res;
  throw describeFailure(res, client.host, `${url.pathname}${url.search}`);
}

/**
 * Turn a 401 into a bearer token, or into a refusal that says which kind of
 * "no" this was. `hadToken` distinguishes "we have not authenticated yet" from
 * "we authenticated and the answer is still no", which is almost always a
 * private repository — and no amount of retrying fixes that.
 */
async function obtainToken(
  client: RegistryClient,
  res: RawResponse,
  scope: string,
  hadToken: boolean,
): Promise<string> {
  const header = res.headers.get("www-authenticate");
  if (header === null) {
    throw new RegistryError(
      `${client.host} refused the request with 401 and no WWW-Authenticate challenge — nothing to authenticate against`,
      401,
    );
  }
  const challenges = parseAuthenticateHeader(header);
  const bearer = bearerChallenge(challenges);
  if (bearer === undefined) {
    const offered = challenges.map((c) => c.scheme).join(", ") || "none";
    throw new RegistryError(
      `${client.host} offers ${offered} auth, not Bearer — these tools do the anonymous Bearer flow only, and hold no credentials`,
      401,
    );
  }
  if (hadToken) throw privateRefusal(client.host, scope);

  const tokenUrl = tokenRequestUrl(bearer, scope);
  // No Authorization header here on purpose: this is the anonymous flow, and
  // the realm is a host the registry named, not one we chose.
  const tokenRes = await send(client, tokenUrl, "application/json", undefined, MAX_TOKEN_BYTES);
  if (tokenRes.status < 200 || tokenRes.status >= 300) {
    throw new RegistryError(
      `token request to ${tokenUrl.origin}${tokenUrl.pathname} failed with HTTP ${tokenRes.status} for scope ${scope}`,
      tokenRes.status,
    );
  }
  return readTokenBody(new TextDecoder("utf-8", { fatal: false }).decode(tokenRes.bytes));
}

/**
 * Registries report errors in a documented envelope
 * (`{"errors":[{"code":…,"message":…}]}`). Surfacing that code is the
 * difference between "MANIFEST_UNKNOWN: no such tag" and "HTTP 404", which a
 * caller cannot act on.
 */
function privateRefusal(host: string, scope: string): RegistryError {
  return new RegistryError(
    `${host} refused the request even with an anonymous token for ${scope} — the repository is private, and these tools hold no credentials`,
    401,
  );
}

export function describeFailure(res: RawResponse, host: string, path: string): RegistryError {
  const detail = registryErrorDetail(res.bytes);
  const suffix = detail === "" ? "" : ` — ${detail}`;
  if (res.status === 404) {
    return new RegistryError(`${host} has no ${path.replace(/^\/v2\//, "")}${suffix}`, 404);
  }
  if (res.status === 429) {
    return new RegistryError(
      `${host} rate-limited this request (HTTP 429)${suffix} — anonymous pulls are throttled per IP`,
      429,
    );
  }
  if (res.status === 403) {
    return new RegistryError(`${host} denied access to ${path} (HTTP 403)${suffix}`, 403);
  }
  return new RegistryError(`${host} answered HTTP ${res.status} for ${path}${suffix}`, res.status);
}

function registryErrorDetail(bytes: Uint8Array): string {
  if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
  } catch {
    return "";
  }
  const errors = (parsed as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return "";
  const first = errors[0] as { code?: unknown; message?: unknown };
  const code = typeof first.code === "string" ? first.code : "";
  const message = typeof first.message === "string" ? first.message : "";
  const joined = [code, message].filter((s) => s !== "").join(": ");
  return joined.length > 300 ? `${joined.slice(0, 300)}…` : joined;
}

export { RegistryHttpError };
