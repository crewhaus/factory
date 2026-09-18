import { describe, expect, test } from "bun:test";
/**
 * The pure functions, tested where their behaviour lives: reference grammar,
 * the auth challenge, digest arithmetic, media-type classification, platform
 * selection and tag ordering. Nothing here opens a socket or needs a stub —
 * the network-shaped tests are in index.test.ts.
 */
import { createHash } from "node:crypto";
import {
  CONFIG_JSON,
  OCI_AMD64_JSON,
  OCI_INDEX_JSON,
  SCHEMA1_JSON,
  bytesOf,
  sha256Of,
} from "./fixtures";
import {
  bearerChallenge,
  parseAuthenticateHeader,
  readTokenBody,
  tokenRequestUrl,
} from "./lib/challenge";
import { deadlineSignal } from "./lib/http";
import {
  MEDIA_TYPES,
  blobPath,
  classifyDocument,
  digestBytes,
  manifestPath,
  parseDocument,
  parsePlatform,
  readConfig,
  readIndex,
  readManifest,
  selectPlatform,
  verifyDigest,
} from "./lib/manifest";
import { parseDigest, parseImageRef, pullScope } from "./lib/ref";
import {
  compareVersions,
  compileGlob,
  filterTags,
  nextPageUrl,
  parseTagVersion,
  readTagsPage,
  sortTags,
} from "./lib/tags";

describe("parseImageRef", () => {
  test("a bare name is a Docker Hub official image", () => {
    const ref = parseImageRef("alpine");
    expect(ref.registry).toBe("docker.io");
    // The API host is NOT docker.io — a client that talks to docker.io gets a 301
    // to a web page, not a registry.
    expect(ref.apiHost).toBe("registry-1.docker.io");
    expect(ref.repository).toBe("library/alpine");
    expect(ref.reference).toBe("latest");
    expect(ref.canonical).toBe("docker.io/library/alpine:latest");
  });

  test("a two-segment Hub name keeps its namespace", () => {
    expect(parseImageRef("bitnami/nginx:1.25").repository).toBe("bitnami/nginx");
  });

  test("a host-shaped first segment is the registry, a plain one is a namespace", () => {
    expect(parseImageRef("ghcr.io/owner/app:1.0").registry).toBe("ghcr.io");
    expect(parseImageRef("ghcr.io/owner/app:1.0").repository).toBe("owner/app");
    expect(parseImageRef("owner/app:1.0").registry).toBe("docker.io");
    expect(parseImageRef("owner/app:1.0").apiHost).toBe("registry-1.docker.io");
  });

  test("a registry port is not mistaken for a tag separator", () => {
    const ref = parseImageRef("registry.example.com:5000/team/app:2.1");
    expect(ref.registry).toBe("registry.example.com:5000");
    expect(ref.repository).toBe("team/app");
    expect(ref.reference).toBe("2.1");
  });

  test("index.docker.io and registry-1.docker.io are the same registry", () => {
    for (const alias of ["docker.io", "index.docker.io", "registry-1.docker.io"]) {
      expect(parseImageRef(`${alias}/library/redis:7`).apiHost).toBe("registry-1.docker.io");
    }
  });

  test("a digest wins over a tag in the same reference", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const ref = parseImageRef(`ghcr.io/owner/app:1.0@${digest}`);
    expect(ref.referenceKind).toBe("digest");
    expect(ref.reference).toBe(digest);
    expect(ref.canonical).toBe(`ghcr.io/owner/app@${digest}`);
  });

  test("an uppercase digest is normalised, since hex case is not identity", () => {
    const ref = parseImageRef(`ghcr.io/owner/app@sha256:${"AB".repeat(32)}`);
    expect(ref.reference).toBe(`sha256:${"ab".repeat(32)}`);
  });

  test("defaultTag:false leaves the reference empty for a repository", () => {
    const ref = parseImageRef("ghcr.io/owner/app", { defaultTag: false });
    expect(ref.reference).toBe("");
    expect(ref.canonical).toBe("ghcr.io/owner/app");
  });

  describe("refusals", () => {
    test("path traversal cannot escape the repository", () => {
      expect(() => parseImageRef("ghcr.io/owner/../../v2/other/manifests/latest")).toThrow(
        /relative path segments/,
      );
    });

    test("an uppercase repository is refused with the reason", () => {
      expect(() => parseImageRef("ghcr.io/Owner/App:1.0")).toThrow(/lowercase/);
    });

    test("a URL is not an image reference", () => {
      expect(() => parseImageRef("https://ghcr.io/owner/app:1.0")).toThrow(/URL scheme/);
    });

    test("a tag starting with a dot is refused", () => {
      expect(() => parseImageRef("owner/app:.hidden")).toThrow(/not a valid tag/);
    });

    test("an empty path component is refused", () => {
      expect(() => parseImageRef("ghcr.io/owner//app:1.0")).toThrow(/empty path component/);
    });

    test("a truncated digest is refused with the expected length", () => {
      expect(() => parseImageRef("owner/app@sha256:abcd")).toThrow(/64 hex characters, got 4/);
    });

    test("an unverifiable digest algorithm is refused rather than reported", () => {
      expect(() => parseDigest(`md5:${"a".repeat(32)}`)).toThrow(/not supported/);
    });

    test("two digests are refused", () => {
      const d = `sha256:${"a".repeat(64)}`;
      expect(() => parseImageRef(`owner/app@${d}@${d}`)).toThrow(/more than one/);
    });
  });

  test("pullScope names the repository being read", () => {
    expect(pullScope("library/alpine")).toBe("repository:library/alpine:pull");
  });
});

describe("parseAuthenticateHeader", () => {
  test("Docker Hub's challenge", () => {
    const challenges = parseAuthenticateHeader(
      'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/alpine:pull"',
    );
    expect(challenges).toHaveLength(1);
    expect(challenges[0]?.scheme).toBe("Bearer");
    expect(challenges[0]?.params["realm"]).toBe("https://auth.docker.io/token");
    expect(challenges[0]?.params["service"]).toBe("registry.docker.io");
  });

  test("ghcr's challenge", () => {
    const [challenge] = parseAuthenticateHeader(
      'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:crewhaus/factory:pull"',
    );
    expect(challenge?.params["realm"]).toBe("https://ghcr.io/token");
    expect(challenge?.params["service"]).toBe("ghcr.io");
  });

  test("two challenges on one line — the Basic offer does not swallow the Bearer one", () => {
    const challenges = parseAuthenticateHeader(
      'Basic realm="quay.io", Bearer realm="https://quay.io/v2/auth",service="quay.io"',
    );
    expect(challenges.map((c) => c.scheme)).toEqual(["Basic", "Bearer"]);
    expect(bearerChallenge(challenges)?.params["realm"]).toBe("https://quay.io/v2/auth");
  });

  test("a quoted escape inside a realm is not a terminator", () => {
    const [challenge] = parseAuthenticateHeader('Bearer realm="https://x.test/a\\"b",service="s"');
    expect(challenge?.params["realm"]).toBe('https://x.test/a"b');
    expect(challenge?.params["service"]).toBe("s");
  });

  test("unquoted token-shaped values are accepted", () => {
    const [challenge] = parseAuthenticateHeader("Bearer service=ghcr.io,error=invalid_token");
    expect(challenge?.params["service"]).toBe("ghcr.io");
    expect(challenge?.params["error"]).toBe("invalid_token");
  });

  test("an UNQUOTED realm stops at the scheme, and then fails closed", () => {
    // A value containing ":" or "/" is not an RFC 7230 token, so a realm has to
    // be quoted. Parsing the fragment leniently would mean guessing where the
    // value ends; instead the truncated value reaches tokenRequestUrl, which
    // refuses it as not-a-URL rather than fetching a token from somewhere odd.
    const [challenge] = parseAuthenticateHeader("Bearer realm=https://x.test/token,service=x");
    expect(challenge?.params["realm"]).toBe("https");
    expect(() =>
      tokenRequestUrl(challenge as { scheme: string; params: Record<string, string> }, "s"),
    ).toThrow(/absolute URL/);
  });

  test("a scheme with no parameters parses and does not hang", () => {
    expect(parseAuthenticateHeader("Negotiate")).toEqual([{ scheme: "Negotiate", params: {} }]);
  });

  test("garbage does not loop forever", () => {
    expect(() => parseAuthenticateHeader("!!!,,,===")).not.toThrow();
  });

  test("an unterminated quote is an error, not a silently truncated realm", () => {
    expect(() => parseAuthenticateHeader('Bearer realm="https://x.test/token')).toThrow(
      /unterminated/,
    );
  });
});

describe("tokenRequestUrl", () => {
  const challenge = (params: Record<string, string>) => ({ scheme: "Bearer", params });

  test("asks for OUR scope, not the one the registry suggested", () => {
    const url = tokenRequestUrl(
      challenge({
        realm: "https://ghcr.io/token",
        service: "ghcr.io",
        scope: "repository:someone/else:push",
      }),
      "repository:crewhaus/factory:pull",
    );
    expect(url.searchParams.get("scope")).toBe("repository:crewhaus/factory:pull");
    expect(url.searchParams.get("service")).toBe("ghcr.io");
  });

  test("refuses a plaintext realm", () => {
    expect(() => tokenRequestUrl(challenge({ realm: "http://evil.test/token" }), "s")).toThrow(
      /not https/,
    );
  });

  test("refuses a realm with credentials in it", () => {
    expect(() =>
      tokenRequestUrl(challenge({ realm: "https://user:pass@evil.test/token" }), "s"),
    ).toThrow(/credentials/);
  });

  test("refuses a challenge with no realm", () => {
    expect(() => tokenRequestUrl(challenge({ service: "x" }), "s")).toThrow(/no realm/);
  });

  test("refuses a realm that is not a URL", () => {
    expect(() => tokenRequestUrl(challenge({ realm: "/token" }), "s")).toThrow(/absolute URL/);
  });
});

describe("readTokenBody", () => {
  test("accepts token and access_token", () => {
    expect(readTokenBody('{"token":"a"}')).toBe("a");
    expect(readTokenBody('{"access_token":"b"}')).toBe("b");
  });

  test("a token-less body is reported as 'probably private', not as a crash", () => {
    expect(() => readTokenBody('{"expires_in":300}')).toThrow(/private/);
  });

  test("a non-JSON body says so", () => {
    expect(() => readTokenBody("<html>")).toThrow(/did not return JSON/);
  });
});

describe("digests", () => {
  test("the digest is over the exact bytes, and reserializing changes it", () => {
    const bytes = bytesOf(OCI_AMD64_JSON);
    const ours = digestBytes(bytes);
    expect(ours).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);

    // This is the whole bug this package exists to avoid: the round-tripped
    // document is EQUAL as data and DIFFERENT as bytes, so an implementation
    // that parses before hashing reports a digest that matches nothing.
    const reserialized = JSON.stringify(JSON.parse(OCI_AMD64_JSON));
    expect(reserialized).not.toBe(OCI_AMD64_JSON);
    expect(digestBytes(bytesOf(reserialized))).not.toBe(ours);
  });

  test("whitespace, key order and \\u escapes each move the digest on their own", () => {
    const base = '{"a":"caf\\u00e9","b":1}';
    const withLiteral = '{"a":"café","b":1}';
    const reordered = '{"b":1,"a":"caf\\u00e9"}';
    const spaced = '{"a": "caf\\u00e9", "b": 1}';
    const digests = new Set([base, withLiteral, reordered, spaced].map((s) => sha256Of(s)));
    expect(digests.size).toBe(4);
  });

  test("a trailing newline is part of the preimage", () => {
    expect(sha256Of('{"a":1}')).not.toBe(sha256Of('{"a":1}\n'));
  });

  test("verifyDigest accepts an agreeing header and reports that it agreed", () => {
    const bytes = bytesOf(OCI_AMD64_JSON);
    const verdict = verifyDigest(bytes, sha256Of(OCI_AMD64_JSON), null, "manifest");
    expect(verdict.digest).toBe(sha256Of(OCI_AMD64_JSON));
    expect(verdict.headerAgreed).toBe(true);
  });

  test("a missing header is not the same fact as an agreeing one", () => {
    const verdict = verifyDigest(bytesOf(OCI_AMD64_JSON), null, null, "manifest");
    expect(verdict.headerDigest).toBeNull();
    expect(verdict.headerAgreed).toBe(false);
  });

  test("a lying Docker-Content-Digest is refused, not trusted", () => {
    expect(() =>
      verifyDigest(bytesOf(OCI_AMD64_JSON), `sha256:${"0".repeat(64)}`, null, "manifest"),
    ).toThrow(/the header is not evidence/);
  });

  test("bytes that do not match the digest that was requested are refused", () => {
    expect(() =>
      verifyDigest(bytesOf(OCI_AMD64_JSON), null, `sha256:${"1".repeat(64)}`, "manifest"),
    ).toThrow(/was requested/);
  });

  test("a header in an algorithm we cannot recompute is refused rather than ignored", () => {
    expect(() => verifyDigest(bytesOf("{}"), `md5:${"a".repeat(32)}`, null, "manifest")).toThrow(
      /cannot be recomputed/,
    );
  });

  test("a header in sha512 is recomputed in sha512 before being compared", () => {
    const bytes = bytesOf(OCI_AMD64_JSON);
    const sha512 = `sha512:${createHash("sha512").update(bytes).digest("hex")}`;
    const verdict = verifyDigest(bytes, sha512, null, "manifest");
    expect(verdict.headerAgreed).toBe(true);
    expect(verdict.digest.startsWith("sha256:")).toBe(true);
  });
});

describe("parseDocument", () => {
  test("invalid UTF-8 is refused rather than decoded into replacement characters", () => {
    expect(() => parseDocument(new Uint8Array([0x7b, 0xff, 0x7d]), "manifest")).toThrow(
      /not valid UTF-8/,
    );
  });

  test("a JSON array is not a manifest", () => {
    expect(() => parseDocument(bytesOf("[1,2]"), "manifest")).toThrow(/not a JSON object/);
  });
});

describe("classifyDocument", () => {
  const doc = (text: string) => parseDocument(bytesOf(text), "doc");

  test("an OCI index is an index", () => {
    expect(classifyDocument(MEDIA_TYPES.ociIndex, doc(OCI_INDEX_JSON)).kind).toBe("index");
  });

  test("the document's own mediaType beats a wrong Content-Type", () => {
    // Proxies and CDNs rewrite Content-Type; `mediaType` is inside the digest.
    const result = classifyDocument("application/json", doc(OCI_AMD64_JSON));
    expect(result.kind).toBe("manifest");
    expect(result.mediaType).toBe(MEDIA_TYPES.ociManifest);
  });

  test("structure is the fallback when nothing declares a media type", () => {
    expect(classifyDocument(null, doc('{"manifests":[]}')).kind).toBe("index");
    expect(classifyDocument(null, doc('{"config":{},"layers":[]}')).kind).toBe("manifest");
  });

  test("a schema 1 manifest is refused with the reason its digest is meaningless", () => {
    expect(() => classifyDocument(MEDIA_TYPES.dockerSchema1Signed, doc(SCHEMA1_JSON))).toThrow(
      /schema 1/,
    );
    expect(() => classifyDocument(null, doc(SCHEMA1_JSON))).toThrow(/signature envelope/);
  });

  test("an unrecognisable document is named, not guessed at", () => {
    expect(() => classifyDocument("application/json", doc('{"hello":1}'))).toThrow(
      /neither "manifests" nor "layers"/,
    );
  });
});

describe("index entries", () => {
  const index = readIndex(parseDocument(bytesOf(OCI_INDEX_JSON), "index"));

  test("attestation manifests are counted, never selectable", () => {
    expect(index.attestations).toBe(1);
    expect(index.platforms.map((p) => p.platform)).toEqual(["linux/amd64", "linux/arm64/v8"]);
  });

  test("selecting without a variant prefers the variant-less entry", () => {
    const entries = [
      {
        mediaType: "m",
        digest: `sha256:${"a".repeat(64)}`,
        size: 1,
        platform: "linux/arm64/v8",
        os: "linux",
        architecture: "arm64",
        variant: "v8",
      },
      {
        mediaType: "m",
        digest: `sha256:${"b".repeat(64)}`,
        size: 1,
        platform: "linux/arm64",
        os: "linux",
        architecture: "arm64",
      },
    ];
    expect(selectPlatform(entries, { os: "linux", architecture: "arm64" })?.platform).toBe(
      "linux/arm64",
    );
    expect(
      selectPlatform(entries, { os: "linux", architecture: "arm64", variant: "v8" })?.platform,
    ).toBe("linux/arm64/v8");
    expect(
      selectPlatform(entries, { os: "linux", architecture: "arm64", variant: "v7" }),
    ).toBeUndefined();
  });

  test("a descriptor with no digest is refused", () => {
    expect(() => readIndex(parseDocument(bytesOf('{"manifests":[{"size":1}]}'), "i"))).toThrow(
      /has no digest/,
    );
  });

  test("parsePlatform refuses anything that is not os/arch", () => {
    expect(parsePlatform("linux/arm64/v8")).toEqual({
      os: "linux",
      architecture: "arm64",
      variant: "v8",
    });
    expect(() => parsePlatform("amd64")).toThrow(/not a platform/);
  });
});

describe("manifest and config summaries", () => {
  test("layer sizes are totalled from the descriptors", () => {
    const summary = readManifest(parseDocument(bytesOf(OCI_AMD64_JSON), "m"));
    expect(summary.layers).toHaveLength(2);
    expect(summary.totalLayerSize).toBe(3401687 + 128);
    expect(summary.annotations?.["org.opencontainers.image.revision"]).toBe("9f3c1ad");
  });

  test("config env VALUES are dropped and only names kept", () => {
    const config = readConfig(parseDocument(bytesOf(CONFIG_JSON), "c"));
    expect(config.envNames).toEqual(["PATH", "APP_TOKEN"]);
    // A config blob is where a careless build leaves a token; echoing every ENV
    // into a transcript is how it escapes.
    expect(JSON.stringify(config)).not.toContain("s3cr3t");
    expect(config.entrypoint).toEqual(["/bin/app"]);
    expect(config.exposedPorts).toEqual(["8080/tcp"]);
    expect(config.diffIds).toBe(2);
  });

  test("a config with nothing in it yields no invented fields", () => {
    expect(readConfig(parseDocument(bytesOf("{}"), "c"))).toEqual({});
  });
});

describe("tag versions", () => {
  test("parses registry-shaped versions and returns null for the rest", () => {
    expect(parseTagVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
    expect(parseTagVersion("0.6")).toEqual({ major: 0, minor: 6, patch: 0, prerelease: null });
    expect(parseTagVersion("3")).toEqual({ major: 3, minor: 0, patch: 0, prerelease: null });
    expect(parseTagVersion("1.0.0-rc.1")?.prerelease).toEqual(["rc", "1"]);
    for (const tag of ["latest", "edge", "sha-9f3c1a", "stable-slim", ""]) {
      expect(parseTagVersion(tag)).toBeNull();
    }
  });

  test("precedence follows semver, including numeric identifiers", () => {
    const v = (s: string) => parseTagVersion(s) as NonNullable<ReturnType<typeof parseTagVersion>>;
    expect(compareVersions(v("1.0.0"), v("1.0.0-rc.1"))).toBeGreaterThan(0);
    // 10 is a number here, not the string "10" — lexicographic would invert this.
    expect(compareVersions(v("1.0.0-alpha.10"), v("1.0.0-alpha.2"))).toBeGreaterThan(0);
    expect(compareVersions(v("1.0.0-alpha"), v("1.0.0-alpha.1"))).toBeLessThan(0);
    expect(compareVersions(v("1.0.0-alpha.1"), v("1.0.0-beta"))).toBeLessThan(0);
    expect(compareVersions(v("1.0.0+build.9"), v("1.0.0"))).toBe(0);
  });

  test("semver sort is newest-first and keeps the unreadable tags, at the end", () => {
    const tags = ["latest", "1.2.0", "edge", "v1.10.0", "1.2.0-rc.1", "sha-9f3c1a"];
    expect(sortTags(tags, "semver")).toEqual([
      "v1.10.0",
      "1.2.0",
      "1.2.0-rc.1",
      "edge",
      "latest",
      "sha-9f3c1a",
    ]);
  });

  test("name and registry sorts do what they say", () => {
    const tags = ["b", "a", "c"];
    expect(sortTags(tags, "name")).toEqual(["a", "b", "c"]);
    expect(sortTags(tags, "registry")).toEqual(["b", "a", "c"]);
  });

  test("the sort is total: equal precedence falls back to the tag string", () => {
    expect(sortTags(["1.0", "1.0.0", "v1.0.0"], "semver")).toEqual(["1.0", "1.0.0", "v1.0.0"]);
  });
});

describe("tag filtering and paging", () => {
  test("a glob matches literally, not as a regex", () => {
    expect(compileGlob("1.2.3")("1a2b3")).toBe(false);
    expect(compileGlob("1.2.3")("1.2.3")).toBe(true);
    expect(filterTags(["1.2.3", "1.2.4", "latest"], "1.2.*")).toEqual(["1.2.3", "1.2.4"]);
    expect(filterTags(["v1", "v2", "w1"], "v?")).toEqual(["v1", "v2"]);
    expect(filterTags(["a", "b"], undefined)).toEqual(["a", "b"]);
  });

  test("a null tags field is an empty repository, not a crash", () => {
    expect(readTagsPage({ name: "x", tags: null })).toEqual({ tags: [], malformed: 0 });
    expect(readTagsPage({ name: "x" })).toEqual({ tags: [], malformed: 0 });
    expect(() => readTagsPage({ tags: "nope" })).toThrow(/non-array/);
  });

  test("a relative next link resolves against the page URL", () => {
    const base = new URL("https://ghcr.io/v2/owner/app/tags/list?n=2");
    const next = nextPageUrl('</v2/owner/app/tags/list?n=2&last=b>; rel="next"', base);
    expect(next?.toString()).toBe("https://ghcr.io/v2/owner/app/tags/list?n=2&last=b");
  });

  test("a next link to another host is refused, not followed", () => {
    const base = new URL("https://ghcr.io/v2/owner/app/tags/list");
    expect(() => nextPageUrl('<https://evil.test/v2/x/tags/list>; rel="next"', base)).toThrow(
      /refusing to follow paging off the registry/,
    );
  });

  test("links other than rel=next are ignored", () => {
    const base = new URL("https://ghcr.io/v2/owner/app/tags/list");
    expect(nextPageUrl('</a>; rel="prev", </b>; rel="next"', base)?.pathname).toBe("/b");
    expect(nextPageUrl('</a>; rel="prev"', base)).toBeNull();
    expect(nextPageUrl(null, base)).toBeNull();
  });
});

describe("deadlineSignal", () => {
  test("an already-aborted caller signal aborts immediately, with the caller's reason", () => {
    const outer = new AbortController();
    outer.abort(new Error("caller went away"));
    const { signal, dispose } = deadlineSignal(outer.signal, 10_000);
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).message).toBe("caller went away");
    dispose();
  });

  test("dispose leaves the signal unaborted when nothing went wrong", () => {
    const { signal, dispose } = deadlineSignal(undefined, 10_000);
    dispose();
    expect(signal.aborted).toBe(false);
  });
});

describe("URL path containment", () => {
  const ref = parseImageRef("ghcr.io/owner/app", { defaultTag: false });

  test("a manifest reference is a tag or a digest, or it never becomes a path", () => {
    expect(manifestPath(ref, "1.4.2")).toBe("/v2/owner/app/manifests/1.4.2");
    expect(manifestPath(ref, `sha256:${"a".repeat(64)}`)).toBe(
      `/v2/owner/app/manifests/sha256:${"a".repeat(64)}`,
    );
    // `new URL(base + this)` normalises to /v2/victim/manifests/latest, which
    // is a DIFFERENT repository whose digest would be reported as owner/app's.
    expect(() => manifestPath(ref, "../../victim/manifests/latest")).toThrow(
      /neither a tag nor a digest/,
    );
    expect(() => manifestPath(ref, "latest/../../../v2/victim/manifests/latest")).toThrow(
      /neither a tag nor a digest/,
    );
    // Digest-shaped but unusable gets the digest parser's reason, not a generic one.
    expect(() => manifestPath(ref, "sha256:deadbeef")).toThrow(/expected 64 hex characters/);
    expect(() => manifestPath(ref, `md5:${"a".repeat(32)}`)).toThrow(/is not supported/);
  });

  test("a blob is only ever addressed by a digest", () => {
    expect(() => blobPath(ref, "../../victim/blobs/x")).toThrow(/is not a digest/);
    expect(blobPath(ref, `sha256:${"b".repeat(64)}`)).toBe(
      `/v2/owner/app/blobs/sha256:${"b".repeat(64)}`,
    );
  });
});

describe("the glob matcher", () => {
  // Hand-written, so it carries its own corpus. Every case here was checked
  // against the regex this replaced; the pair is behaviourally identical.
  test("* and ? are the only metacharacters, and they mean what they say", () => {
    expect(compileGlob("*")("anything")).toBe(true);
    expect(compileGlob("*")("")).toBe(true);
    expect(compileGlob("")("")).toBe(true);
    expect(compileGlob("")("a")).toBe(false);
    expect(compileGlob("1.*")("1.2.3")).toBe(true);
    expect(compileGlob("1.*")("112.3")).toBe(false);
    expect(compileGlob("v?.?.?")("v1.2.3")).toBe(true);
    expect(compileGlob("v?.?.?")("v1.2.34")).toBe(false);
    expect(compileGlob("*alpine")("3.19-alpine")).toBe(true);
    expect(compileGlob("*alpine")("alpine-3.19")).toBe(false);
    expect(compileGlob("a*b*c")("axxbyyc")).toBe(true);
    expect(compileGlob("a*b*c")("axxcyyb")).toBe(false);
    expect(compileGlob("**a")("a")).toBe(true);
    expect(compileGlob("a**")("a")).toBe(true);
  });

  test("a wildcard-heavy pattern is linear, not a binomial", () => {
    // As a regex this is C(128, 8) backtracks against a full-length tag —
    // hours, synchronously, where no timeout or signal can reach it.
    const tag = "a".repeat(128);
    expect(compileGlob("*a*a*a*a*a*a*a*a*z")(tag)).toBe(false);
    expect(compileGlob("*a*a*a*a*a*a*a*a*a")(tag)).toBe(true);
  });
});
