/**
 * The two tools, driven through their own `execute` against recorded registry
 * shapes. Every test drives the injected fetch (`_setFetch`) and the injected
 * DNS resolver, so nothing here opens a socket — a test that reached a real
 * registry would fail on a CI runner with no egress, or flake on somebody
 * else's anonymous-pull rate limit.
 *
 * The refusal paths get as much room as the happy ones. A registry that lies
 * about a digest, redirects at cloud metadata, pages you onto another host, or
 * needs credentials we do not have are all things this package has to say no
 * to, out loud, with the reason.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { _setDnsLookup } from "@crewhaus/tool-fetch";
import {
  CONFIG_DIGEST,
  CONFIG_JSON,
  DOCKER_AMD64_DIGEST,
  DOCKER_AMD64_JSON,
  DOCKER_HUB,
  DOCKER_LIST_JSON,
  GHCR,
  HELM_MANIFEST_JSON,
  OCI_AMD64_DIGEST,
  OCI_AMD64_JSON,
  OCI_ARM64_DIGEST,
  OCI_ARM64_JSON,
  OCI_INDEX_DIGEST,
  OCI_INDEX_JSON,
  QUAY,
  SCHEMA1_JSON,
  type Stub,
  bytesOf,
  jsonResponse,
  multiArchContent,
  registryStub,
  sha256Of,
  stubFetch,
} from "./fixtures";
import { CONTAINER_TOOLS, _setFetch, containerImageInspect, containerImageTags } from "./index";
import { newClient, registryGet } from "./lib/registry";
import { filterTags, readTagsPage } from "./lib/tags";

/**
 * The digest of the recorded amd64 manifest, pinned as a literal. If a future
 * edit to the fixture changes a single byte this fails — which is the point: a
 * digest that moves when the formatting moves is exactly the property under
 * test everywhere else in this file.
 */
const PINNED_AMD64_DIGEST =
  "sha256:c10fc0b39350b37449a0c69eaab082d953acb46d04f89199d2ed15988de87ea6";

/** Resolve every host to a public address unless a test says otherwise. */
function dns(map: Record<string, string> = {}): void {
  _setDnsLookup(async (host) => ({ address: map[host] ?? "93.184.216.34", family: 4 }));
}

function use(stub: Stub): Stub {
  _setFetch(stub.fetch);
  return stub;
}

async function run(
  tool: (typeof CONTAINER_TOOLS)[number],
  input: unknown,
  ctx?: unknown,
  // biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
): Promise<any> {
  const out = await tool.execute(input, ctx as never);
  if (typeof out !== "string") throw new Error("expected a string result");
  return JSON.parse(out);
}

afterEach(() => {
  _setFetch(undefined);
  _setDnsLookup(undefined);
});

describe("package-wide contract", () => {
  test("both tools are exported, with unique names", () => {
    expect(CONTAINER_TOOLS).toHaveLength(2);
    expect(new Set(CONTAINER_TOOLS.map((t) => t.name)).size).toBe(2);
  });

  test("the safety flags say what these tools are: read-only network reads", () => {
    for (const tool of CONTAINER_TOOLS) {
      expect(tool.readOnly).toBe(true);
      expect(tool.destructive).toBe(false);
      expect(tool.concurrencySafe).toBe(true);
      // Reaching a registry is egress; the classifier keys on both of these.
      expect(tool.scope).toBe("external");
      expect(tool.ioCapability).toBe("network");
    }
  });

  test("the schemas reject input the tools cannot act on", () => {
    expect(containerImageInspect.inputSchema.safeParse({}).success).toBe(false);
    expect(containerImageInspect.inputSchema.safeParse({ image: "" }).success).toBe(false);
    expect(containerImageTags.inputSchema.safeParse({ image: "a", limit: 0 }).success).toBe(false);
    expect(containerImageTags.inputSchema.safeParse({ image: "a", sort: "created" }).success).toBe(
      false,
    );
    expect(containerImageTags.inputSchema.safeParse({ image: "a", maxPages: 99 }).success).toBe(
      false,
    );
    expect(containerImageInspect.inputSchema.safeParse({ image: "a", timeoutMs: 10 }).success).toBe(
      false,
    );
  });
});

describe("ContainerImageInspect against ghcr.io", () => {
  test("resolves a multi-arch tag through the anonymous token dance", async () => {
    dns();
    const stub = use(registryStub(GHCR, "crewhaus/factory", multiArchContent()));
    const result = await run(containerImageInspect, { image: "ghcr.io/crewhaus/factory:1.4.2" });

    expect(result.resolved.digest).toBe(OCI_INDEX_DIGEST);
    expect(result.resolved.kind).toBe("index");
    expect(result.resolved.digestHeaderAgreed).toBe(true);
    expect(result.manifest.digest).toBe(PINNED_AMD64_DIGEST);
    expect(result.manifest.platform).toBe("linux/amd64");
    expect(result.manifest.config.labels["org.opencontainers.image.version"]).toBe("1.4.2");

    // The dance itself: unauthenticated GET, token from the realm the challenge
    // named, then the same GET carrying the token.
    const urls = stub.calls.map((c) => c.url);
    expect(urls[0]).toBe("https://ghcr.io/v2/crewhaus/factory/manifests/1.4.2");
    expect(stub.calls[0]?.authorization).toBeNull();
    expect(urls[1]).toContain("https://ghcr.io/token?service=ghcr.io&scope=repository");
    expect(stub.calls[1]?.authorization).toBeNull();
    expect(stub.calls[2]?.authorization).toBe("Bearer ghcr-token");
  });

  test("offers every manifest media type, or the registry converts the answer", async () => {
    dns();
    const stub = use(registryStub(GHCR, "crewhaus/factory", multiArchContent()));
    await run(containerImageInspect, { image: "ghcr.io/crewhaus/factory:1.4.2" });
    const accept = stub.calls[0]?.accept ?? "";
    for (const type of [
      "application/vnd.oci.image.index.v1+json",
      "application/vnd.oci.image.manifest.v1+json",
      "application/vnd.docker.distribution.manifest.list.v2+json",
      "application/vnd.docker.distribution.manifest.v2+json",
    ]) {
      expect(accept).toContain(type);
    }
  });

  test("the token is fetched once and reused for the whole call", async () => {
    dns();
    const stub = use(registryStub(GHCR, "crewhaus/factory", multiArchContent()));
    await run(containerImageInspect, { image: "ghcr.io/crewhaus/factory:1.4.2" });
    expect(stub.calls.filter((c) => c.url.startsWith("https://ghcr.io/token")).length).toBe(1);
  });

  test("the reported digest is over the bytes on the wire, not a reserialization", async () => {
    dns();
    use(registryStub(GHCR, "crewhaus/factory", multiArchContent()));
    const result = await run(containerImageInspect, { image: "ghcr.io/crewhaus/factory:1.4.2" });

    expect(result.resolved.digest).toBe(sha256Of(OCI_INDEX_JSON));
    const roundTripped = JSON.stringify(JSON.parse(OCI_INDEX_JSON));
    expect(roundTripped).not.toBe(OCI_INDEX_JSON);
    expect(result.resolved.digest).not.toBe(sha256Of(roundTripped));
    expect(result.manifest.digest).not.toBe(sha256Of(JSON.stringify(JSON.parse(OCI_AMD64_JSON))));
  });

  test("a requested platform that exists is resolved, and its digest verified against the index", async () => {
    dns();
    use(registryStub(GHCR, "crewhaus/factory", multiArchContent()));
    const result = await run(containerImageInspect, {
      image: "ghcr.io/crewhaus/factory:1.4.2",
      platform: "linux/arm64/v8",
    });
    expect(result.manifest.digest).toBe(OCI_ARM64_DIGEST);
    expect(result.manifest.platform).toBe("linux/arm64/v8");
  });

  test("indexOnly lists the platforms and fetches nothing else", async () => {
    dns();
    const stub = use(registryStub(GHCR, "crewhaus/factory", multiArchContent()));
    const result = await run(containerImageInspect, {
      image: "ghcr.io/crewhaus/factory:1.4.2",
      indexOnly: true,
    });
    expect(result.platforms.map((p: { platform: string }) => p.platform)).toEqual([
      "linux/amd64",
      "linux/arm64/v8",
    ]);
    // The attestation manifest is counted, never offered as a platform.
    expect(result.attestations).toBe(1);
    expect(result.manifest).toBeUndefined();
    expect(stub.calls.some((c) => c.url.includes("/blobs/"))).toBe(false);
  });

  test("includeConfig:false skips the blob GET", async () => {
    dns();
    const stub = use(registryStub(GHCR, "crewhaus/factory", multiArchContent()));
    const result = await run(containerImageInspect, {
      image: "ghcr.io/crewhaus/factory:1.4.2",
      includeConfig: false,
    });
    expect(result.manifest.config).toBeUndefined();
    expect(result.manifest.configDigest).toBe(CONFIG_DIGEST);
    expect(stub.calls.some((c) => c.url.includes("/blobs/"))).toBe(false);
  });

  test("includeLayers lists layers; without it only the count and total", async () => {
    dns();
    use(registryStub(GHCR, "crewhaus/factory", multiArchContent()));
    const without = await run(containerImageInspect, { image: "ghcr.io/crewhaus/factory:1.4.2" });
    expect(without.manifest.layers).toBeUndefined();
    expect(without.manifest.layerCount).toBe(2);
    expect(without.manifest.totalLayerSize).toBe(3401815);

    const withLayers = await run(containerImageInspect, {
      image: "ghcr.io/crewhaus/factory:1.4.2",
      includeLayers: true,
    });
    expect(withLayers.manifest.layers).toHaveLength(2);
  });

  test("compareTo answers 'has this tag moved' without an extra request", async () => {
    dns();
    const stub = use(registryStub(GHCR, "crewhaus/factory", multiArchContent()));
    const before = await run(containerImageInspect, {
      image: "ghcr.io/crewhaus/factory:1.4.2",
      includeConfig: false,
      compareTo: OCI_INDEX_DIGEST,
    });
    expect(before.comparison).toEqual({
      to: OCI_INDEX_DIGEST,
      digest: OCI_INDEX_DIGEST,
      same: true,
      matched: "resolved",
    });
    const requestsWithout = stub.calls.length;

    const moved = await run(containerImageInspect, {
      image: "ghcr.io/crewhaus/factory:1.4.2",
      includeConfig: false,
      compareTo: `sha256:${"0".repeat(64)}`,
    });
    expect(moved.comparison.same).toBe(false);
    expect(moved.comparison.matched).toBeNull();
    // A digest comparison is arithmetic, not a lookup: the second call cost the
    // same number of requests as the first.
    expect(stub.calls.length - requestsWithout).toBe(requestsWithout);
  });

  test("compareTo recognises a per-platform digest as the same image", async () => {
    dns();
    use(registryStub(GHCR, "crewhaus/factory", multiArchContent()));
    const result = await run(containerImageInspect, {
      image: "ghcr.io/crewhaus/factory:1.4.2",
      includeConfig: false,
      compareTo: OCI_AMD64_DIGEST,
    });
    expect(result.comparison).toMatchObject({ same: true, matched: "platform" });
  });

  test("compareTo against another reference resolves it and compares digests", async () => {
    dns();
    use(registryStub(GHCR, "crewhaus/factory", multiArchContent()));
    const same = await run(containerImageInspect, {
      image: "ghcr.io/crewhaus/factory:1.4.2",
      includeConfig: false,
      compareTo: "ghcr.io/crewhaus/factory:latest",
    });
    expect(same.comparison).toMatchObject({
      to: "ghcr.io/crewhaus/factory:latest",
      same: true,
      matched: "resolved",
    });

    const different = await run(containerImageInspect, {
      image: "ghcr.io/crewhaus/factory:1.4.2",
      includeConfig: false,
      compareTo: `ghcr.io/crewhaus/factory@${OCI_ARM64_DIGEST}`,
    });
    expect(different.comparison.same).toBe(false);
    expect(different.comparison.digest).toBe(OCI_ARM64_DIGEST);
  });

  test("a compareTo that is neither a digest nor a reference is refused", async () => {
    dns();
    use(registryStub(GHCR, "crewhaus/factory", multiArchContent()));
    await expect(
      containerImageInspect.execute({
        image: "ghcr.io/crewhaus/factory:1.4.2",
        includeConfig: false,
        compareTo: "NOT A REFERENCE",
      }),
    ).rejects.toThrow(/not a valid repository path component/);
  });

  test("a reference that is already a digest is verified against the bytes served", async () => {
    dns();
    use(registryStub(GHCR, "crewhaus/factory", multiArchContent()));
    const result = await run(containerImageInspect, {
      image: `ghcr.io/crewhaus/factory@${OCI_AMD64_DIGEST}`,
    });
    expect(result.referenceKind).toBe("digest");
    expect(result.resolved.digest).toBe(OCI_AMD64_DIGEST);
    expect(result.manifest.digest).toBe(OCI_AMD64_DIGEST);
  });
});

describe("ContainerImageInspect against Docker Hub and quay.io", () => {
  test("Docker Hub: library/ is synthesised and the API host is registry-1", async () => {
    dns();
    const stub = use(
      registryStub(DOCKER_HUB, "library/alpine", {
        manifests: {
          "3.19": {
            body: DOCKER_LIST_JSON,
            mediaType: "application/vnd.docker.distribution.manifest.list.v2+json",
          },
          [DOCKER_AMD64_DIGEST]: {
            body: DOCKER_AMD64_JSON,
            mediaType: "application/vnd.docker.distribution.manifest.v2+json",
          },
        },
        blobs: {
          [CONFIG_DIGEST]: {
            body: CONFIG_JSON,
            mediaType: "application/vnd.docker.container.image.v1+json",
          },
        },
      }),
    );
    const result = await run(containerImageInspect, { image: "alpine:3.19" });
    expect(result.image).toBe("docker.io/library/alpine:3.19");
    expect(result.resolved.mediaType).toBe(
      "application/vnd.docker.distribution.manifest.list.v2+json",
    );
    expect(result.manifest.digest).toBe(DOCKER_AMD64_DIGEST);
    expect(stub.calls[0]?.url.startsWith("https://registry-1.docker.io/v2/library/alpine/")).toBe(
      true,
    );
    expect(stub.calls[1]?.url.startsWith("https://auth.docker.io/token")).toBe(true);
  });

  test("quay.io: a Basic offer sharing the challenge line does not break the Bearer flow", async () => {
    dns();
    const stub = use(registryStub(QUAY, "prometheus/node-exporter", multiArchContent()));
    const result = await run(containerImageInspect, {
      image: "quay.io/prometheus/node-exporter:1.4.2",
      includeConfig: false,
    });
    expect(result.registry).toBe("quay.io");
    expect(result.resolved.digest).toBe(OCI_INDEX_DIGEST);
    expect(stub.calls[1]?.url.startsWith("https://quay.io/v2/auth?service=quay.io")).toBe(true);
  });
});

describe("ContainerImageInspect refusals", () => {
  test("a registry that lies in Docker-Content-Digest is refused", async () => {
    dns();
    use(
      registryStub(GHCR, "crewhaus/factory", {
        manifests: {
          "1.4.2": {
            body: OCI_AMD64_JSON,
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            contentDigest: `sha256:${"0".repeat(64)}`,
          },
        },
      }),
    );
    await expect(
      containerImageInspect.execute({ image: "ghcr.io/crewhaus/factory:1.4.2" }),
    ).rejects.toThrow(/the header is not evidence/);
  });

  test("bytes that do not match the requested digest are refused", async () => {
    dns();
    use(
      registryStub(GHCR, "crewhaus/factory", {
        // The registry answers the amd64 digest with the arm64 document.
        manifests: {
          [OCI_AMD64_DIGEST]: {
            body: OCI_ARM64_JSON,
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            contentDigest: null,
          },
        },
      }),
    );
    await expect(
      containerImageInspect.execute({ image: `ghcr.io/crewhaus/factory@${OCI_AMD64_DIGEST}` }),
    ).rejects.toThrow(/was requested/);
  });

  test("an index whose per-platform descriptor does not match its content is refused", async () => {
    dns();
    const content = multiArchContent();
    use(
      registryStub(GHCR, "crewhaus/factory", {
        ...content,
        manifests: {
          ...content.manifests,
          [OCI_AMD64_DIGEST]: {
            body: OCI_ARM64_JSON,
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            contentDigest: null,
          },
        },
      }),
    );
    await expect(
      containerImageInspect.execute({ image: "ghcr.io/crewhaus/factory:1.4.2" }),
    ).rejects.toThrow(/was requested/);
  });

  test("a platform the index does not have is refused WITH the list of platforms it has", async () => {
    dns();
    use(registryStub(GHCR, "crewhaus/factory", multiArchContent()));
    await expect(
      containerImageInspect.execute({
        image: "ghcr.io/crewhaus/factory:1.4.2",
        platform: "linux/s390x",
      }),
    ).rejects.toThrow(/has no linux\/s390x image — the index lists linux\/amd64, linux\/arm64\/v8/);
  });

  test("a schema 1 manifest is refused, since its digest is over a signature", async () => {
    dns();
    use(
      registryStub(GHCR, "crewhaus/ancient", {
        manifests: {
          "1.0": {
            body: SCHEMA1_JSON,
            mediaType: "application/vnd.docker.distribution.manifest.v1+prettyjws",
          },
        },
      }),
    );
    await expect(
      containerImageInspect.execute({ image: "ghcr.io/crewhaus/ancient:1.0" }),
    ).rejects.toThrow(/schema 1/);
  });

  test("an OCI artifact is reported as one rather than parsed as an image", async () => {
    dns();
    const stub = use(
      registryStub(GHCR, "crewhaus/chart", {
        manifests: {
          "0.1.0": {
            body: HELM_MANIFEST_JSON,
            mediaType: "application/vnd.oci.image.manifest.v1+json",
          },
        },
      }),
    );
    const result = await run(containerImageInspect, { image: "ghcr.io/crewhaus/chart:0.1.0" });
    expect(result.manifest.artifact).toBe(true);
    expect(result.manifest.configNote).toContain("vnd.cncf.helm.config.v1+json");
    expect(result.manifest.config).toBeUndefined();
    expect(stub.calls.some((c) => c.url.includes("/blobs/"))).toBe(false);
  });

  test("a private repository is named as private, not reported as missing", async () => {
    dns();
    // The registry keeps answering 401 even once a token is presented.
    use(
      stubFetch([
        {
          match: (url) => url.pathname === "/token",
          respond: () => jsonResponse(200, '{"token":"ghcr-token"}'),
        },
        {
          match: () => true,
          respond: () =>
            jsonResponse(401, '{"errors":[{"code":"UNAUTHORIZED","message":"denied"}]}', {
              "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io"',
            }),
        },
      ]),
    );
    await expect(
      containerImageInspect.execute({ image: "ghcr.io/crewhaus/secret:1.0" }),
    ).rejects.toThrow(/the repository is private, and these tools hold no credentials/);
  });

  test("a registry offering only Basic auth is refused with what it offered", async () => {
    dns();
    use(
      stubFetch([
        {
          match: () => true,
          respond: () =>
            jsonResponse(401, "{}", { "www-authenticate": 'Basic realm="registry.example.com"' }),
        },
      ]),
    );
    await expect(
      containerImageInspect.execute({ image: "registry.example.com/team/app:1" }),
    ).rejects.toThrow(/offers Basic auth, not Bearer/);
  });

  test("a 401 with no challenge is refused rather than retried blindly", async () => {
    dns();
    use(stubFetch([{ match: () => true, respond: () => jsonResponse(401, "{}") }]));
    await expect(
      containerImageInspect.execute({ image: "registry.example.com/team/app:1" }),
    ).rejects.toThrow(/no WWW-Authenticate challenge/);
  });

  test("an unknown tag carries the registry's own error code", async () => {
    dns();
    use(registryStub(GHCR, "crewhaus/factory", multiArchContent()));
    await expect(
      containerImageInspect.execute({ image: "ghcr.io/crewhaus/factory:9.9.9" }),
    ).rejects.toThrow(/MANIFEST_UNKNOWN/);
  });

  test("a rate limit is reported as one, because the fix is different", async () => {
    dns();
    use(
      stubFetch([
        {
          match: (url) => url.pathname === "/token",
          respond: () => jsonResponse(200, '{"token":"hub-token"}'),
        },
        {
          match: () => true,
          respond: (req) =>
            req.headers.get("authorization") === null
              ? jsonResponse(401, "{}", {
                  "www-authenticate":
                    'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"',
                })
              : jsonResponse(
                  429,
                  '{"errors":[{"code":"TOOMANYREQUESTS","message":"You have reached your pull rate limit"}]}',
                ),
        },
      ]),
    );
    await expect(containerImageInspect.execute({ image: "alpine:3.19" })).rejects.toThrow(
      /rate-limited this request \(HTTP 429\)/,
    );
  });

  test("a malformed reference never reaches the network", async () => {
    dns();
    const stub = use(registryStub(GHCR, "crewhaus/factory", multiArchContent()));
    await expect(
      containerImageInspect.execute({ image: "ghcr.io/Crewhaus/Factory:1.0" }),
    ).rejects.toThrow(/lowercase/);
    expect(stub.calls).toHaveLength(0);
  });

  test("the request budget is a refusal with an instruction, not a silent stop", async () => {
    dns();
    use(registryStub(GHCR, "crewhaus/factory", multiArchContent()));
    const client = newClient("ghcr.io");
    client.requests = 140;
    await expect(
      registryGet(client, "/v2/crewhaus/factory/manifests/1.4.2", {
        maxBytes: 1024,
        scope: "repository:crewhaus/factory:pull",
      }),
    ).rejects.toThrow(/refusing to make more than 140 registry requests/);
  });
});

describe("network defences", () => {
  test("a redirect at cloud metadata is refused by the SSRF guard", async () => {
    dns();
    use(
      registryStub(GHCR, "crewhaus/factory", multiArchContent(), [
        {
          match: (url) => url.pathname.endsWith("/manifests/evil"),
          respond: () =>
            new Response(null, {
              status: 302,
              headers: { location: "http://169.254.169.254/latest/meta-data/iam/" },
            }),
        },
      ]),
    );
    // Assert the REASON: an abort or a 404 would also be "did not succeed".
    await expect(
      containerImageInspect.execute({ image: "ghcr.io/crewhaus/factory:evil" }),
    ).rejects.toThrow(/SSRF: host "169\.254\.169\.254" is a private\/loopback IP/);
  });

  test("a realm that resolves to a link-local address is refused before a token is asked for", async () => {
    dns({ "auth.internal.test": "169.254.169.254" });
    use(
      stubFetch([
        {
          match: () => true,
          respond: () =>
            jsonResponse(401, "{}", {
              "www-authenticate": 'Bearer realm="https://auth.internal.test/token",service="x"',
            }),
        },
      ]),
    );
    await expect(
      containerImageInspect.execute({ image: "registry.example.com/team/app:1" }),
    ).rejects.toThrow(/resolves to private IP 169\.254\.169\.254/);
  });

  test("a registry on localhost is refused, however the reference is spelled", async () => {
    dns();
    const stub = use(stubFetch([{ match: () => true, respond: () => jsonResponse(200, "{}") }]));
    // The reference grammar accepts `localhost:5000/...` — the SSRF guard is
    // what refuses it, and it does so before any request is made.
    await expect(
      containerImageInspect.execute({ image: "localhost:5000/team/app:1" }),
    ).rejects.toThrow(/resolves to loopback/);
    expect(stub.calls).toHaveLength(0);
  });

  test("the pull token is dropped when a redirect leaves the registry's origin", async () => {
    dns();
    const stub = use(
      registryStub(GHCR, "crewhaus/factory", multiArchContent(), [
        {
          match: (url) => url.hostname === "cdn.example.test",
          respond: () =>
            new Response(bytesOf(OCI_AMD64_JSON), {
              status: 200,
              headers: {
                "content-type": "application/vnd.oci.image.manifest.v1+json",
                "docker-content-digest": OCI_AMD64_DIGEST,
              },
            }),
        },
        {
          match: (url) => url.pathname.endsWith("/manifests/redirected"),
          respond: (req) =>
            req.headers.get("authorization") === null
              ? jsonResponse(401, "{}", { "www-authenticate": GHCR.challenge("crewhaus/factory") })
              : new Response(null, {
                  status: 307,
                  headers: { location: "https://cdn.example.test/blob/abc" },
                }),
        },
      ]),
    );
    const result = await run(containerImageInspect, {
      image: "ghcr.io/crewhaus/factory:redirected",
      includeConfig: false,
    });
    expect(result.resolved.digest).toBe(OCI_AMD64_DIGEST);
    const cdnCall = stub.calls.find((c) => c.url.startsWith("https://cdn.example.test/"));
    // Forwarding the bearer token to a storage host hands it to whoever runs it.
    expect(cdnCall?.authorization).toBeNull();
  });

  test("the connection is pinned to the IP the guard validated", async () => {
    dns({ "ghcr.io": "140.82.121.33" });
    const stub = use(registryStub(GHCR, "crewhaus/factory", multiArchContent()));
    await run(containerImageInspect, {
      image: "ghcr.io/crewhaus/factory:1.4.2",
      includeConfig: false,
    });
    expect(stub.calls[0]?.pinnedIp).toBe("140.82.121.33");
  });

  test("a caller's cancellation surfaces as that cancellation, not as a timeout", async () => {
    dns();
    const controller = new AbortController();
    controller.abort(new Error("run cancelled by the operator"));
    use(
      stubFetch([
        {
          match: () => true,
          respond: (req) => {
            if (req.signal.aborted) throw req.signal.reason;
            return jsonResponse(200, "{}");
          },
        },
      ]),
    );
    await expect(
      containerImageInspect.execute({ image: "ghcr.io/crewhaus/factory:1.4.2" }, {
        signal: controller.signal,
      } as never),
    ).rejects.toThrow(/run cancelled by the operator/);
  });

  test("a body over the cap is aborted rather than read into memory", async () => {
    dns();
    use(
      stubFetch([
        {
          match: (url) => url.pathname === "/token",
          respond: () => jsonResponse(200, '{"token":"ghcr-token"}'),
        },
        {
          match: () => true,
          respond: (req) =>
            req.headers.get("authorization") === null
              ? jsonResponse(401, "{}", { "www-authenticate": GHCR.challenge("crewhaus/factory") })
              : new Response(new Uint8Array(9 * 1024 * 1024), {
                  status: 200,
                  headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" },
                }),
        },
      ]),
    );
    await expect(
      containerImageInspect.execute({ image: "ghcr.io/crewhaus/factory:1.4.2" }),
    ).rejects.toThrow(/exceeded 8388608 bytes/);
  }, 20_000); // pays for building and streaming a 9 MB body on a loaded runner
});

describe("ContainerImageTags", () => {
  const tagContent = {
    tagPages: [
      { body: '{"name":"owner/app","tags":["latest","1.2.0","1.10.0"]}', nextLast: "1.10.0" },
      { body: '{"name":"owner/app","tags":["1.2.0-rc.1","sha-9f3c1a","2.0.0"]}' },
    ],
  };

  test("follows Link paging and sorts newest-first, keeping non-version tags", async () => {
    dns();
    const stub = use(registryStub(GHCR, "owner/app", tagContent));
    const result = await run(containerImageTags, { image: "ghcr.io/owner/app", pageSize: 3 });
    expect(result.tags).toEqual(["2.0.0", "1.10.0", "1.2.0", "1.2.0-rc.1", "latest", "sha-9f3c1a"]);
    expect(result.pages).toBe(2);
    expect(result.morePages).toBe(false);
    expect(stub.calls.some((c) => c.url.includes("last=1.10.0"))).toBe(true);
  });

  test("maxPages stops paging and says there is more", async () => {
    dns();
    use(registryStub(GHCR, "owner/app", tagContent));
    const result = await run(containerImageTags, {
      image: "ghcr.io/owner/app",
      pageSize: 3,
      maxPages: 1,
    });
    expect(result.pages).toBe(1);
    expect(result.morePages).toBe(true);
    expect(result.fetched).toBe(3);
  });

  test("a glob filters and limit truncates, with both counts reported", async () => {
    dns();
    use(registryStub(GHCR, "owner/app", tagContent));
    const result = await run(containerImageTags, {
      image: "ghcr.io/owner/app",
      match: "1.*",
      limit: 2,
    });
    expect(result.matched).toBe(3);
    expect(result.returned).toBe(2);
    expect(result.tags).toEqual(["1.10.0", "1.2.0"]);
  });

  test("a tag in the reference is reported as ignored rather than silently dropped", async () => {
    dns();
    use(registryStub(GHCR, "owner/app", tagContent));
    const result = await run(containerImageTags, { image: "ghcr.io/owner/app:1.2.0" });
    expect(result.ignoredReference).toBe("1.2.0");
  });

  test("an empty repository is empty, not a crash", async () => {
    dns();
    use(
      registryStub(GHCR, "owner/app", { tagPages: [{ body: '{"name":"owner/app","tags":null}' }] }),
    );
    const result = await run(containerImageTags, { image: "ghcr.io/owner/app" });
    expect(result.tags).toEqual([]);
    expect(result.fetched).toBe(0);
  });

  test("withDigests resolves each tag, verifying each one's bytes", async () => {
    dns();
    use(
      registryStub(GHCR, "owner/app", {
        tagPages: [{ body: '{"name":"owner/app","tags":["1.0.0","2.0.0"]}' }],
        manifests: {
          "1.0.0": {
            body: OCI_AMD64_JSON,
            mediaType: "application/vnd.oci.image.manifest.v1+json",
          },
          "2.0.0": { body: OCI_INDEX_JSON, mediaType: "application/vnd.oci.image.index.v1+json" },
        },
      }),
    );
    const result = await run(containerImageTags, { image: "ghcr.io/owner/app", withDigests: true });
    expect(result.tags).toEqual([
      {
        tag: "2.0.0",
        digest: OCI_INDEX_DIGEST,
        mediaType: "application/vnd.oci.image.index.v1+json",
        kind: "index",
        size: OCI_INDEX_JSON.length,
      },
      {
        tag: "1.0.0",
        digest: PINNED_AMD64_DIGEST,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        kind: "manifest",
        size: OCI_AMD64_JSON.length,
      },
    ]);
  });

  test("a tag that disappears between the listing and the lookup is reported against that tag", async () => {
    dns();
    use(
      registryStub(GHCR, "owner/app", {
        tagPages: [{ body: '{"name":"owner/app","tags":["1.0.0","deleted"]}' }],
        manifests: {
          "1.0.0": {
            body: OCI_AMD64_JSON,
            mediaType: "application/vnd.oci.image.manifest.v1+json",
          },
        },
      }),
    );
    const result = await run(containerImageTags, { image: "ghcr.io/owner/app", withDigests: true });
    expect(result.tags[0]).toMatchObject({ tag: "1.0.0", digest: PINNED_AMD64_DIGEST });
    expect(result.tags[1].tag).toBe("deleted");
    expect(result.tags[1].error).toContain("MANIFEST_UNKNOWN");
  });

  test("a digest that does not match its content aborts the whole listing", async () => {
    dns();
    use(
      registryStub(GHCR, "owner/app", {
        tagPages: [{ body: '{"name":"owner/app","tags":["1.0.0"]}' }],
        manifests: {
          "1.0.0": {
            body: OCI_AMD64_JSON,
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            contentDigest: `sha256:${"0".repeat(64)}`,
          },
        },
      }),
    );
    // An integrity failure is evidence about the registry, not about one tag.
    await expect(
      containerImageTags.execute({ image: "ghcr.io/owner/app", withDigests: true }),
    ).rejects.toThrow(/the header is not evidence/);
  });

  test("withDigests past the fan-out cap is refused with what to do about it", async () => {
    dns();
    const many = Array.from({ length: 60 }, (_, i) => `1.0.${i}`);
    use(
      registryStub(GHCR, "owner/app", {
        tagPages: [{ body: JSON.stringify({ name: "owner/app", tags: many }) }],
      }),
    );
    await expect(
      containerImageTags.execute({ image: "ghcr.io/owner/app", withDigests: true, limit: 60 }),
    ).rejects.toThrow(/over the 50 cap — narrow with match, or lower limit/);
  });

  test("paging that points at another host is refused, not followed", async () => {
    dns();
    use(
      registryStub(GHCR, "owner/app", {
        tagPages: [
          {
            body: '{"name":"owner/app","tags":["1.0.0"]}',
            link: '<https://evil.test/v2/owner/app/tags/list>; rel="next"',
          },
        ],
      }),
    );
    await expect(containerImageTags.execute({ image: "ghcr.io/owner/app" })).rejects.toThrow(
      /refusing to follow paging off the registry/,
    );
  });

  test("an unknown repository is refused with the registry's code", async () => {
    dns();
    use(registryStub(GHCR, "owner/app", tagContent));
    await expect(containerImageTags.execute({ image: "ghcr.io/owner/missing" })).rejects.toThrow(
      /NOT_FOUND/,
    );
  });
});

/**
 * Adversarial pass. Everything here is a registry (or a caller) behaving badly
 * in a way the rest of this file assumed would not happen: a tag list that is
 * not made of tags, an index whose variant-less entry is not first, a
 * `compareTo` that is an ordinary reference, and a manifest missing the sizes
 * the totals are built from.
 */
describe("hostile registries and ambiguous input", () => {
  test("a 'tag' that walks the URL onto another repository is never fetched", async () => {
    dns();
    // A tag list is server-controlled data. `../../victim/manifests/latest`
    // is not a tag under the distribution grammar, but the URL parser happily
    // normalises it away from owner/app — and the digest would then be
    // reported as owner/app's.
    const victim = bytesOf(OCI_AMD64_JSON);
    const stub = use(
      registryStub(
        GHCR,
        "owner/app",
        {
          tagPages: [
            {
              body: JSON.stringify({
                name: "owner/app",
                tags: ["1.0.0", "../../victim/manifests/latest"],
              }),
            },
          ],
          manifests: {
            "1.0.0": {
              body: OCI_AMD64_JSON,
              mediaType: "application/vnd.oci.image.manifest.v1+json",
            },
          },
        },
        [
          {
            match: (url) => url.pathname === "/v2/victim/manifests/latest",
            respond: () =>
              new Response(victim, {
                status: 200,
                headers: {
                  "content-type": "application/vnd.oci.image.manifest.v1+json",
                  "docker-content-digest": PINNED_AMD64_DIGEST,
                },
              }),
          },
        ],
      ),
    );
    const result = await run(containerImageTags, { image: "ghcr.io/owner/app", withDigests: true });
    expect(stub.calls.some((c) => new URL(c.url).pathname.startsWith("/v2/victim/"))).toBe(false);
    expect(result.tags.map((t: { tag: string }) => t.tag)).toEqual(["1.0.0"]);
    // Dropped, but not silently: the count says the registry sent something
    // that was not a tag.
    expect(result.malformed).toBe(1);
  });

  test("a tag long enough to be a denial of service is not a tag", () => {
    dns();
    // A 2000-character "tag" is outside the grammar, and it is also the input
    // a backtracking glob needs to become unusable.
    expect(readTagsPage({ tags: ["1.0.0", "a".repeat(2000)] })).toEqual({
      tags: ["1.0.0"],
      malformed: 1,
    });
  });

  test("a glob with several wildcards stays linear on a full-length tag", () => {
    // Compiled to a regex this is C(128,8) backtracks — hours for one tag, and
    // synchronous, so neither timeoutMs nor ctx.signal can interrupt it.
    const tag = "a".repeat(128);
    expect(filterTags([tag], "*a*a*a*a*a*a*a*a*z")).toEqual([]);
    expect(filterTags([tag], "*a*a*a*a*a*a*a*a*a")).toEqual([tag]);
  });

  test("without a variant the variant-less entry wins, whatever the index order", async () => {
    dns();
    // buildx writes the variant-less entry wherever it likes. A caller asking
    // for linux/arm64 wants the image a plain arm64 host would pull, not
    // whichever arm64 entry the registry happened to list first.
    const index = `{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[
      {"mediaType":"application/vnd.oci.image.manifest.v1+json","size":${OCI_ARM64_JSON.length},"digest":"${OCI_ARM64_DIGEST}","platform":{"architecture":"arm64","os":"linux","variant":"v8"}},
      {"mediaType":"application/vnd.oci.image.manifest.v1+json","size":${OCI_AMD64_JSON.length},"digest":"${OCI_AMD64_DIGEST}","platform":{"architecture":"arm64","os":"linux"}}]}`;
    use(
      registryStub(GHCR, "owner/app", {
        manifests: {
          latest: { body: index, mediaType: "application/vnd.oci.image.index.v1+json" },
          [OCI_ARM64_DIGEST]: {
            body: OCI_ARM64_JSON,
            mediaType: "application/vnd.oci.image.manifest.v1+json",
          },
          [OCI_AMD64_DIGEST]: {
            body: OCI_AMD64_JSON,
            mediaType: "application/vnd.oci.image.manifest.v1+json",
          },
        },
        blobs: {
          [CONFIG_DIGEST]: {
            body: CONFIG_JSON,
            mediaType: "application/vnd.oci.image.config.v1+json",
          },
        },
      }),
    );
    const result = await run(containerImageInspect, {
      image: "ghcr.io/owner/app",
      platform: "linux/arm64",
      includeConfig: false,
    });
    expect(result.manifest.digest).toBe(PINNED_AMD64_DIGEST);
    expect(result.manifest.platform).toBe("linux/arm64");
  });

  test("compareTo accepts a reference whose tag happens to be hex", async () => {
    dns();
    // `alpine:3`, `nginx:1`, `redis:7` — a repository and a hex-shaped tag look
    // exactly like <algorithm>:<hex>. Treating them as digests refuses the
    // documented "or another image reference" for most of Docker Hub.
    use(
      registryStub(DOCKER_HUB, "library/alpine", {
        manifests: {
          "3.19": {
            body: OCI_AMD64_JSON,
            mediaType: "application/vnd.oci.image.manifest.v1+json",
          },
          "3": { body: OCI_AMD64_JSON, mediaType: "application/vnd.oci.image.manifest.v1+json" },
        },
        blobs: {
          [CONFIG_DIGEST]: {
            body: CONFIG_JSON,
            mediaType: "application/vnd.oci.image.config.v1+json",
          },
        },
      }),
    );
    const result = await run(containerImageInspect, {
      image: "alpine:3.19",
      compareTo: "alpine:3",
      includeConfig: false,
    });
    expect(result.comparison.to).toBe("docker.io/library/alpine:3");
    expect(result.comparison.same).toBe(true);
    expect(result.comparison.matched).toBe("resolved");
  });

  test("a short digest in compareTo is refused, not turned into a repository lookup", async () => {
    dns();
    use(registryStub(GHCR, "owner/app", multiArchContent()));
    await expect(
      containerImageInspect.execute({
        image: "ghcr.io/owner/app:1.4.2",
        compareTo: "sha256:deadbeef",
        includeConfig: false,
      }),
    ).rejects.toThrow(/expected 64 hex characters/);
  });

  test("an index descriptor in upper-case hex is the same digest, not a mismatch", async () => {
    dns();
    // Hex case is not identity. Refusing here would be a false alarm about
    // registry tampering, which is the one refusal that must stay believable.
    const shouting = OCI_AMD64_DIGEST.toUpperCase().replace("SHA256", "sha256");
    const index = `{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[
      {"mediaType":"application/vnd.oci.image.manifest.v1+json","size":${OCI_AMD64_JSON.length},"digest":"${shouting}","platform":{"architecture":"amd64","os":"linux"}}]}`;
    use(
      registryStub(GHCR, "owner/app", {
        manifests: {
          latest: { body: index, mediaType: "application/vnd.oci.image.index.v1+json" },
          [OCI_AMD64_DIGEST]: {
            body: OCI_AMD64_JSON,
            mediaType: "application/vnd.oci.image.manifest.v1+json",
          },
        },
      }),
    );
    const result = await run(containerImageInspect, {
      image: "ghcr.io/owner/app",
      includeConfig: false,
    });
    expect(result.manifest.digest).toBe(PINNED_AMD64_DIGEST);
  });

  test("windows/amd64 is several images, and the answer says so", async () => {
    dns();
    // An index carries one entry per Windows build, all of them `windows/amd64`
    // and distinguishable only by os.version. Reporting the first as "the
    // amd64 image" is a digest that will not run on the caller's host.
    const index = `{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[
      {"mediaType":"application/vnd.oci.image.manifest.v1+json","size":${OCI_AMD64_JSON.length},"digest":"${OCI_AMD64_DIGEST}","platform":{"architecture":"amd64","os":"windows","os.version":"10.0.17763.5576"}},
      {"mediaType":"application/vnd.oci.image.manifest.v1+json","size":${OCI_ARM64_JSON.length},"digest":"${OCI_ARM64_DIGEST}","platform":{"architecture":"amd64","os":"windows","os.version":"10.0.20348.2322"}}]}`;
    use(
      registryStub(GHCR, "owner/app", {
        manifests: {
          latest: { body: index, mediaType: "application/vnd.oci.image.index.v1+json" },
          [OCI_AMD64_DIGEST]: {
            body: OCI_AMD64_JSON,
            mediaType: "application/vnd.oci.image.manifest.v1+json",
          },
        },
      }),
    );
    const result = await run(containerImageInspect, {
      image: "ghcr.io/owner/app",
      platform: "windows/amd64",
      includeConfig: false,
    });
    expect(result.manifest.platform).toBe("windows/amd64");
    expect(result.manifest.osVersion).toBe("10.0.17763.5576");
    expect(result.manifest.platformMatches).toBe(2);
    // The single-image case stays quiet about a count of one.
    expect(result.platforms).toHaveLength(2);
  });

  test("an unverifiable digest algorithm in the header aborts the listing too", async () => {
    dns();
    // Not a mismatch and not a 404: the registry is claiming a digest nobody
    // here can check. That is evidence about the registry, so it aborts rather
    // than becoming a footnote against one tag.
    use(
      registryStub(GHCR, "owner/app", {
        tagPages: [{ body: '{"name":"owner/app","tags":["1.0.0","2.0.0"]}' }],
        manifests: {
          "1.0.0": {
            body: OCI_AMD64_JSON,
            mediaType: "application/vnd.oci.image.manifest.v1+json",
          },
          "2.0.0": {
            body: OCI_AMD64_JSON,
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            contentDigest: `md5:${"a".repeat(32)}`,
          },
        },
      }),
    );
    await expect(
      containerImageTags.execute({ image: "ghcr.io/owner/app", withDigests: true }),
    ).rejects.toThrow(/cannot be recomputed here/);
  });

  test("a port that is not a port is refused by name, not by a URL parser", async () => {
    dns();
    const stub = use(stubFetch([]));
    await expect(
      containerImageInspect.execute({ image: "registry.test:99999/owner/app:1.0" }),
    ).rejects.toThrow(/has port 99999, which is not a port/);
    expect(stub.calls).toHaveLength(0);
  });

  test("layers with no size are counted, and the total says it is incomplete", async () => {
    dns();
    // `size` is required by the spec and omitted by real tools anyway. A total
    // that quietly drops the unknown ones is a number somebody sizes a disk on.
    const manifest = `{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"mediaType":"application/vnd.oci.image.config.v1+json","size":${CONFIG_JSON.length},"digest":"${CONFIG_DIGEST}"},"layers":[{"mediaType":"application/vnd.oci.image.layer.v1.tar+gzip","size":100,"digest":"sha256:${"3".repeat(64)}"},{"mediaType":"application/vnd.oci.image.layer.v1.tar+gzip","digest":"sha256:${"4".repeat(64)}"}]}`;
    use(
      registryStub(GHCR, "owner/app", {
        manifests: {
          latest: { body: manifest, mediaType: "application/vnd.oci.image.manifest.v1+json" },
        },
      }),
    );
    const result = await run(containerImageInspect, {
      image: "ghcr.io/owner/app",
      includeConfig: false,
    });
    expect(result.manifest.layerCount).toBe(2);
    expect(result.manifest.totalLayerSize).toBe(100);
    expect(result.manifest.unsizedLayers).toBe(1);
  });
});
