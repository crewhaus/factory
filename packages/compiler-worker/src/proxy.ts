/**
 * proxy.ts — generic, host-allowlisted reverse proxy for the four daemon-cloud
 * deployment providers (Render, Fly, Railway, Heroku).
 *
 * This mirrors index.ts's `/cf` handler (which relays api.cloudflare.com),
 * but instead of a single hardcoded upstream it accepts an arbitrary upstream
 * URL via the `?upstream=` query param — locked down to a fixed allowlist of
 * provider API hosts. Like the CF proxy, these provider APIs are not
 * browser-CORS-callable, so the studio PWA (running entirely on-device) cannot
 * reach them directly; this Worker, running on the user's own Cloudflare
 * account, relays the call server-side and echoes the studio's CORS headers
 * back to the browser.
 *
 * SECURITY BOUNDARY (M3 requirement, AGENTS.md Pillar 3 — security is a
 * fabric): the upstream is an untrusted, caller-supplied value, so it crosses
 * a trust boundary. We classify it and gate it through `isAllowedUpstream`,
 * which requires https + an EXACT host match against PROVIDER_API_HOSTS. The
 * exact match (not endsWith) is deliberate: it blocks suffix-style bypasses
 * such as `api.heroku.com.evil.com`. This keeps the handler a narrow relay to
 * the four known provider APIs — never an open proxy, and not SSRF-exploitable.
 *
 * The caller's provider token rides in the Authorization header and is
 * forwarded verbatim to the upstream; it is never stored.
 */

/**
 * The four daemon-cloud provider API hosts, matching each factory
 * cloud-adapter's DEFAULT_API_BASE host:
 *   - api.render.com        (cloud-adapter-render)
 *   - api.machines.dev      (cloud-adapter-fly)
 *   - backboard.railway.com (cloud-adapter-railway)
 *   - api.heroku.com        (cloud-adapter-heroku)
 */
export const PROVIDER_API_HOSTS = [
  "api.render.com",
  "api.machines.dev",
  "backboard.railway.com",
  "api.heroku.com",
] as const;

/**
 * Validate a caller-supplied upstream URL against the provider allowlist.
 *
 * Returns the parsed `URL` when the upstream is safe to relay, or `null` when
 * it must be rejected. Rejects when the value is null/empty, unparseable, not
 * https, or whose host is not EXACTLY one of {@link PROVIDER_API_HOSTS}. The
 * exact (case-insensitive) host check prevents suffix bypasses like
 * `api.heroku.com.evil.com` and query-smuggling like
 * `https://evil.com/?x=api.render.com`.
 */
export function isAllowedUpstream(rawUpstream: string | null): URL | null {
  if (rawUpstream === null || rawUpstream === "") return null;

  let url: URL;
  try {
    url = new URL(rawUpstream);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;

  const host = url.hostname.toLowerCase();
  const allowed = (PROVIDER_API_HOSTS as readonly string[]).includes(host);
  if (!allowed) return null;

  return url;
}

/**
 * Reverse-proxy a request to one of the allowlisted provider APIs.
 *
 * Reads the upstream from `url.searchParams.get("upstream")`. If it is not on
 * the allowlist, responds 403 `{ error: { code: "UPSTREAM_NOT_ALLOWED" } }`
 * WITHOUT issuing any outbound fetch (no SSRF). Otherwise it forwards the
 * request: copies Authorization, Content-Type, and Accept (Heroku requires a
 * versioned Accept) from the incoming request, streams the body for
 * non-GET/HEAD methods, fetches the upstream, and returns the upstream body and
 * status with the studio CORS headers merged in.
 *
 * @param request the incoming studio request
 * @param cors the CORS headers to echo back (built by the caller per-origin)
 * @param url the already-parsed request URL (carries the `upstream` param)
 */
export async function handleProviderProxy(
  request: Request,
  cors: HeadersInit,
  url: URL,
): Promise<Response> {
  const allowedUrl = isAllowedUpstream(url.searchParams.get("upstream"));
  if (allowedUrl === null) {
    return new Response(
      JSON.stringify({
        error: { code: "UPSTREAM_NOT_ALLOWED", message: "upstream host not in allowlist" },
      }),
      {
        status: 403,
        headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
      },
    );
  }

  const headers = new Headers();
  const auth = request.headers.get("Authorization");
  if (auth) headers.set("Authorization", auth);
  const contentType = request.headers.get("Content-Type");
  if (contentType) headers.set("Content-Type", contentType);
  const accept = request.headers.get("Accept");
  if (accept) headers.set("Accept", accept);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? await request.arrayBuffer() : undefined;

  const upstream = await fetch(allowedUrl.toString(), { method: request.method, headers, body });
  const respBody = await upstream.arrayBuffer();
  return new Response(respBody, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      ...cors,
    },
  });
}
