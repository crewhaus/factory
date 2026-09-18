/**
 * Recorded registry shapes, and a fetch stub that serves them.
 *
 * These are the three registries this package is meant to work against —
 * Docker Hub, ghcr.io and quay.io — reduced to what actually differs between
 * them: the challenge header, the realm host, whether a service and a scope are
 * echoed, and whether anything else shares the `WWW-Authenticate` line. If the
 * generic challenge-driven flow handles these three it handles the fourth one
 * nobody has tried yet, which is the entire argument for not special-casing
 * Docker Hub.
 *
 * The manifest bytes are deliberately UGLY: three-space indentation, keys in
 * the order a builder emitted them rather than sorted, and a `é` escape
 * instead of a literal é. `JSON.stringify(JSON.parse(bytes))` produces
 * different bytes for every one of them, which is the property the digest tests
 * need — a reserializing implementation passes a fixture whose formatting is
 * already canonical and fails in production.
 */
import { createHash } from "node:crypto";
import type { RegistryFetch } from "./lib/http";

const encoder = new TextEncoder();
export const bytesOf = (text: string): Uint8Array => encoder.encode(text);
export const sha256Of = (text: string): string =>
  `sha256:${createHash("sha256").update(encoder.encode(text)).digest("hex")}`;

// ─── documents ──────────────────────────────────────────────────────────────

/**
 * An image config blob. `APP_TOKEN` is here on purpose: it is the shape of the
 * accident this package must not amplify, and the test asserts the value never
 * reaches the output.
 */
export const CONFIG_JSON = `{"architecture":"amd64","os":"linux","created":"2026-04-02T10:11:12.13Z",
   "config":{"User":"app","WorkingDir":"/srv","Entrypoint":["/bin/app"],"Cmd":["--serve"],
      "Env":["PATH=/usr/local/bin:/usr/bin","APP_TOKEN=s3cr3t-do-not-echo"],
      "ExposedPorts":{"8080/tcp":{}},
      "Labels":{"org.opencontainers.image.title":"caf\\u00e9-runner","org.opencontainers.image.version":"1.4.2"}},
   "rootfs":{"type":"layers","diff_ids":["sha256:1111111111111111111111111111111111111111111111111111111111111111","sha256:2222222222222222222222222222222222222222222222222222222222222222"]}}`;

export const CONFIG_DIGEST = sha256Of(CONFIG_JSON);

/** An OCI image manifest, amd64. Note the indentation and the escaped é. */
export const OCI_AMD64_JSON = `{ "schemaVersion": 2,
   "mediaType": "application/vnd.oci.image.manifest.v1+json",
   "config": {
      "mediaType": "application/vnd.oci.image.config.v1+json",
      "size": ${CONFIG_JSON.length},
      "digest": "${CONFIG_DIGEST}"
   },
   "layers": [
      { "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip", "size": 3401687,
        "digest": "sha256:3333333333333333333333333333333333333333333333333333333333333333" },
      { "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip", "size": 128,
        "digest": "sha256:4444444444444444444444444444444444444444444444444444444444444444" }
   ],
   "annotations": { "org.opencontainers.image.title": "caf\\u00e9-runner",
      "org.opencontainers.image.revision": "9f3c1ad" }
}`;

export const OCI_AMD64_DIGEST = sha256Of(OCI_AMD64_JSON);

/** The same image for arm64/v8, with no annotations. */
export const OCI_ARM64_JSON = `{ "schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
   "config": { "mediaType": "application/vnd.oci.image.config.v1+json", "size": ${CONFIG_JSON.length}, "digest": "${CONFIG_DIGEST}" },
   "layers": [ { "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip", "size": 3211987,
        "digest": "sha256:5555555555555555555555555555555555555555555555555555555555555555" } ]
}`;

export const OCI_ARM64_DIGEST = sha256Of(OCI_ARM64_JSON);

/**
 * A multi-arch index with a buildkit attestation entry — the `unknown/unknown`
 * descriptor that a naive "first manifest wins" resolver picks and then reports
 * a provenance document as if it were the image.
 */
export const OCI_INDEX_JSON = `{ "schemaVersion": 2,
   "mediaType": "application/vnd.oci.image.index.v1+json",
   "manifests": [
      { "mediaType": "application/vnd.oci.image.manifest.v1+json", "size": ${OCI_AMD64_JSON.length},
        "digest": "${OCI_AMD64_DIGEST}",
        "platform": { "architecture": "amd64", "os": "linux" } },
      { "mediaType": "application/vnd.oci.image.manifest.v1+json", "size": ${OCI_ARM64_JSON.length},
        "digest": "${OCI_ARM64_DIGEST}",
        "platform": { "architecture": "arm64", "os": "linux", "variant": "v8" } },
      { "mediaType": "application/vnd.oci.image.manifest.v1+json", "size": 566,
        "digest": "sha256:6666666666666666666666666666666666666666666666666666666666666666",
        "platform": { "architecture": "unknown", "os": "unknown" },
        "annotations": { "vnd.docker.reference.type": "attestation-manifest" } }
   ]
}`;

export const OCI_INDEX_DIGEST = sha256Of(OCI_INDEX_JSON);

/** Docker's own manifest list + v2 manifest, which Hub still serves for older images. */
export const DOCKER_AMD64_JSON = `{"schemaVersion":2,"mediaType":"application/vnd.docker.distribution.manifest.v2+json","config":{"mediaType":"application/vnd.docker.container.image.v1+json","size":${CONFIG_JSON.length},"digest":"${CONFIG_DIGEST}"},"layers":[{"mediaType":"application/vnd.docker.image.rootfs.diff.tar.gzip","size":3401687,"digest":"sha256:7777777777777777777777777777777777777777777777777777777777777777"}]}`;

export const DOCKER_AMD64_DIGEST = sha256Of(DOCKER_AMD64_JSON);

export const DOCKER_LIST_JSON = `{"schemaVersion":2,"mediaType":"application/vnd.docker.distribution.manifest.list.v2+json","manifests":[{"mediaType":"application/vnd.docker.distribution.manifest.v2+json","size":${DOCKER_AMD64_JSON.length},"digest":"${DOCKER_AMD64_DIGEST}","platform":{"architecture":"amd64","os":"linux"}}]}`;

export const DOCKER_LIST_DIGEST = sha256Of(DOCKER_LIST_JSON);

/** A schema 1 manifest — digest over a signature envelope, which is why it is refused. */
export const SCHEMA1_JSON = `{"schemaVersion":1,"name":"library/ancient","tag":"1.0","architecture":"amd64","fsLayers":[{"blobSum":"sha256:8888888888888888888888888888888888888888888888888888888888888888"}],"signatures":[{"header":{"alg":"ES256"},"signature":"abc","protected":"def"}]}`;

/** An OCI artifact: image-manifest shaped, but its config is a Helm chart. */
export const HELM_MANIFEST_JSON = `{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"mediaType":"application/vnd.cncf.helm.config.v1+json","size":141,"digest":"sha256:9999999999999999999999999999999999999999999999999999999999999999"},"layers":[{"mediaType":"application/vnd.cncf.helm.chart.content.v1.tar+gzip","size":4096,"digest":"sha256:aaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999"}]}`;

// ─── registries ─────────────────────────────────────────────────────────────

export type RegistryFixture = {
  /** The host the client talks to — Hub's is not `docker.io`. */
  readonly apiHost: string;
  /** Exactly what the registry puts on the 401. */
  readonly challenge: (repository: string) => string;
  readonly tokenUrl: string;
  readonly token: string;
  readonly tokenBody: string;
};

export const DOCKER_HUB: RegistryFixture = {
  apiHost: "registry-1.docker.io",
  // Hub omits the scope on the /v2/ probe and includes it on a manifest 401.
  challenge: (repository) =>
    `Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:${repository}:pull"`,
  tokenUrl: "https://auth.docker.io/token",
  token: "hub-token",
  tokenBody: `{"token":"hub-token","access_token":"hub-token","expires_in":300,"issued_at":"2026-09-18T09:00:00.000000000Z"}`,
};

export const GHCR: RegistryFixture = {
  apiHost: "ghcr.io",
  challenge: (repository) =>
    `Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:${repository}:pull"`,
  tokenUrl: "https://ghcr.io/token",
  token: "ghcr-token",
  tokenBody: `{"token":"ghcr-token"}`,
};

export const QUAY: RegistryFixture = {
  apiHost: "quay.io",
  // quay has shipped two challenges on one line; the Bearer one is second.
  challenge: (repository) =>
    `Basic realm="quay.io", Bearer realm="https://quay.io/v2/auth",service="quay.io",scope="repository:${repository}:pull"`,
  tokenUrl: "https://quay.io/v2/auth",
  token: "quay-token",
  tokenBody: `{"token":"quay-token","expires_in":600,"issued_at":"2026-09-18T09:00:00Z"}`,
};

// ─── the stub ───────────────────────────────────────────────────────────────

export type RecordedCall = {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly accept: string | null;
  readonly pinnedIp: string;
};

export type StubRoute = {
  /** Exact URL, or a predicate over the parsed URL. */
  readonly match: string | ((url: URL) => boolean);
  readonly respond: (req: Request, url: URL) => Response;
};

export type Stub = { readonly fetch: RegistryFetch; readonly calls: RecordedCall[] };

/** Build a fetch from an ordered route table. First match wins; no match is a 404. */
export function stubFetch(routes: readonly StubRoute[]): Stub {
  const calls: RecordedCall[] = [];
  const fetch: RegistryFetch = async (req, pinnedIp) => {
    const url = new URL(req.url);
    calls.push({
      url: req.url,
      method: req.method,
      authorization: req.headers.get("authorization"),
      accept: req.headers.get("accept"),
      pinnedIp,
    });
    for (const route of routes) {
      const hit = typeof route.match === "string" ? req.url === route.match : route.match(url);
      if (hit) return route.respond(req, url);
    }
    return jsonResponse(
      404,
      `{"errors":[{"code":"NOT_FOUND","message":"no stub route for ${url.pathname}"}]}`,
    );
  };
  return { fetch, calls };
}

export function jsonResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(bytesOf(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export type Served = {
  readonly body: string;
  readonly mediaType: string;
  /**
   * What to put in `Docker-Content-Digest`. Omitted ⇒ the true digest of the
   * bytes; `null` ⇒ no header at all, which some proxies do.
   */
  readonly contentDigest?: string | null;
};

export type TagPage = { readonly body: string; readonly nextLast?: string; readonly link?: string };

export type RepoContent = {
  /** Keyed by reference: a tag, or a `sha256:…` digest. */
  readonly manifests?: Record<string, Served>;
  readonly blobs?: Record<string, Served>;
  /** Pages in order; page 0 is the request with no `last` parameter. */
  readonly tagPages?: readonly TagPage[];
};

/**
 * Serve one repository from one registry fixture, including the 401 → token →
 * retry dance. Requests without a bearer token get the registry's own
 * challenge, which is what makes these tests exercise the real flow rather than
 * a happy path with the auth step removed.
 */
export function registryStub(
  fixture: RegistryFixture,
  repository: string,
  content: RepoContent,
  extraRoutes: readonly StubRoute[] = [],
): Stub {
  const base = `https://${fixture.apiHost}/v2/${repository}`;
  const authorized = (req: Request): boolean =>
    req.headers.get("authorization") === `Bearer ${fixture.token}`;
  const unauthorized = (): Response =>
    jsonResponse(401, `{"errors":[{"code":"UNAUTHORIZED","message":"authentication required"}]}`, {
      "www-authenticate": fixture.challenge(repository),
    });
  const serve = (served: Served): Response => {
    const headers: Record<string, string> = { "content-type": served.mediaType };
    const digest =
      served.contentDigest === undefined ? sha256Of(served.body) : served.contentDigest;
    if (digest !== null) headers["docker-content-digest"] = digest;
    return new Response(bytesOf(served.body), { status: 200, headers });
  };

  const routes: StubRoute[] = [
    // Overrides first: a test that wants one path to redirect or fail says so
    // without having to restate the rest of the registry.
    ...extraRoutes,
    {
      match: (url) => `${url.origin}${url.pathname}` === fixture.tokenUrl,
      respond: () => jsonResponse(200, fixture.tokenBody),
    },
    {
      match: (url) => `${url.origin}${url.pathname}`.startsWith(`${base}/manifests/`),
      respond: (req, url) => {
        if (!authorized(req)) return unauthorized();
        const reference = decodeURIComponent(url.pathname.split("/manifests/")[1] ?? "");
        const served = content.manifests?.[reference];
        if (served === undefined) {
          return jsonResponse(
            404,
            `{"errors":[{"code":"MANIFEST_UNKNOWN","message":"manifest unknown: ${reference}"}]}`,
          );
        }
        return serve(served);
      },
    },
    {
      match: (url) => `${url.origin}${url.pathname}`.startsWith(`${base}/blobs/`),
      respond: (req, url) => {
        if (!authorized(req)) return unauthorized();
        const digest = url.pathname.split("/blobs/")[1] ?? "";
        const served = content.blobs?.[digest];
        if (served === undefined) {
          return jsonResponse(404, `{"errors":[{"code":"BLOB_UNKNOWN","message":"blob unknown"}]}`);
        }
        return serve(served);
      },
    },
    {
      match: (url) => `${url.origin}${url.pathname}` === `${base}/tags/list`,
      respond: (req, url) => {
        if (!authorized(req)) return unauthorized();
        const pages = content.tagPages ?? [];
        const last = url.searchParams.get("last");
        const index = last === null ? 0 : pages.findIndex((p) => p.nextLast === last) + 1;
        const page = pages[index];
        if (page === undefined) return jsonResponse(404, `{"errors":[{"code":"NOT_FOUND"}]}`);
        const headers: Record<string, string> = {};
        const n = url.searchParams.get("n") ?? "100";
        // Registries send a RELATIVE next link; resolving it against the page
        // URL is part of what the client has to get right.
        const link =
          page.link ??
          (page.nextLast === undefined
            ? undefined
            : `</v2/${repository}/tags/list?n=${n}&last=${page.nextLast}>; rel="next"`);
        if (link !== undefined) headers["link"] = link;
        return jsonResponse(200, page.body, headers);
      },
    },
  ];
  return stubFetch(routes);
}

/** The standard multi-arch repository, served by whichever registry is passed. */
export function multiArchContent(): RepoContent {
  return {
    manifests: {
      "1.4.2": { body: OCI_INDEX_JSON, mediaType: "application/vnd.oci.image.index.v1+json" },
      latest: { body: OCI_INDEX_JSON, mediaType: "application/vnd.oci.image.index.v1+json" },
      [OCI_INDEX_DIGEST]: {
        body: OCI_INDEX_JSON,
        mediaType: "application/vnd.oci.image.index.v1+json",
      },
      [OCI_AMD64_DIGEST]: {
        body: OCI_AMD64_JSON,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
      },
      [OCI_ARM64_DIGEST]: {
        body: OCI_ARM64_JSON,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
      },
    },
    blobs: {
      [CONFIG_DIGEST]: { body: CONFIG_JSON, mediaType: "application/vnd.oci.image.config.v1+json" },
    },
  };
}
