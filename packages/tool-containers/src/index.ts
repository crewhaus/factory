/**
 * @crewhaus/tool-containers — what is actually behind this image tag.
 *
 * Two questions a harness asks constantly and a model cannot answer by
 * reasoning: which digest does `ghcr.io/owner/app:1.4.2` resolve to right now,
 * and what tags does that repository have. Both are answered over the OCI
 * distribution API — no daemon, no `docker pull`, no layers downloaded, and
 * nothing written to disk. A digest resolution costs one or two small GETs.
 *
 * THE DIGEST IS THE POINT, so it is computed here rather than believed:
 * `sha256` over the exact response bytes, checked against the registry's
 * `Docker-Content-Digest` header rather than copied from it, and checked
 * against the digest the caller asked for (or the one an index promised) when
 * there is one. Nothing on that path is ever parsed and re-serialized —
 * re-serializing JSON changes key order, whitespace and escapes, all of which
 * are inside the hash, so a digest derived from a round-tripped document is a
 * different number that still looks plausible.
 *
 * Auth is the anonymous Bearer dance, driven off the registry's own
 * `WWW-Authenticate` challenge: request, 401, token from the named realm,
 * retry. Docker Hub, ghcr.io and quay.io differ in realm, service and scope
 * echo, and all three work here without being named in the code. Private
 * repositories do not: these tools hold no credentials, and say so.
 *
 * Every request goes through `@crewhaus/tool-fetch`'s SSRF guard with the
 * connection pinned to the IP it validated, re-checked at every redirect hop.
 * A registry that answers with `302 Location: http://169.254.169.254/…` is the
 * attack, and a bare `fetch` would have followed it.
 */
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
import { z } from "zod";
import {
  type ConfigSummary,
  MANIFEST_ACCEPT,
  ManifestError,
  type PlatformDescriptor,
  blobPath,
  classifyDocument,
  manifestPath,
  parseDocument,
  parsePlatform,
  readConfig,
  readIndex,
  readManifest,
  selectPlatform,
  verifyDigest,
} from "./lib/manifest";
import { type ImageRef, parseDigest, parseImageRef, pullScope } from "./lib/ref";
import {
  type RegistryClient,
  newClient,
  registryGet,
  registryGetUrl,
  registryUrl,
} from "./lib/registry";
import { filterTags, nextPageUrl, readTagsPage, sortTags } from "./lib/tags";

export { _setFetch, type RegistryFetch } from "./lib/http";
export { RegistryError } from "./lib/registry";
export { ImageRefError } from "./lib/ref";
export { ManifestError };

const json = (value: unknown): string => JSON.stringify(value);

/**
 * Ceilings. A manifest is kilobytes and a config blob is tens of kilobytes;
 * these are generous by two orders of magnitude and exist so a hostile or
 * broken registry cannot stream until memory runs out.
 */
const LIMITS = {
  manifestBytes: 8 * 1024 * 1024,
  configBytes: 8 * 1024 * 1024,
  tagsBytes: 16 * 1024 * 1024,
  /**
   * `withDigests` costs one manifest GET per tag. Past this many the call stops
   * being a lookup and becomes a crawl of somebody's registry, so it is refused
   * with an instruction rather than quietly truncated.
   */
  digestFanout: 50,
} as const;

/** Config media types that are an IMAGE config, i.e. worth parsing as one. */
const IMAGE_CONFIG_TYPES = new Set([
  "application/vnd.oci.image.config.v1+json",
  "application/vnd.docker.container.image.v1+json",
]);

const DEFAULT_PLATFORM = "linux/amd64";

const timeoutField = z
  .number()
  .int()
  .min(1_000)
  .max(120_000)
  .optional()
  .describe("per-request timeout in milliseconds; default 20000");

function clientFor(
  ref: ImageRef,
  ctx: ToolExecuteContext | undefined,
  timeoutMs?: number,
): RegistryClient {
  return newClient(ref.apiHost, ctx?.signal, timeoutMs ?? 20_000);
}

type FetchedManifest = {
  readonly digest: string;
  readonly headerDigest: string | null;
  readonly headerAgreed: boolean;
  readonly mediaType: string;
  readonly kind: "manifest" | "index";
  readonly size: number;
  readonly document: Record<string, unknown>;
};

/**
 * Fetch one manifest and establish its digest.
 *
 * The order of the three steps below is the contract: read the bytes, hash the
 * bytes, and only then parse them. `expected` is the digest this document was
 * promised to have — the caller's `@sha256:…`, or the descriptor inside an
 * index — and a mismatch aborts rather than being reported as a field, because
 * the bytes in hand are then not the document that was addressed.
 */
async function fetchManifest(
  client: RegistryClient,
  ref: ImageRef,
  reference: string,
  expected: string | null,
  what: string,
): Promise<FetchedManifest> {
  const res = await registryGet(client, manifestPath(ref, reference), {
    accept: MANIFEST_ACCEPT,
    maxBytes: LIMITS.manifestBytes,
    scope: pullScope(ref.repository),
  });
  const verdict = verifyDigest(res.bytes, res.headers.get("docker-content-digest"), expected, what);
  const document = parseDocument(res.bytes, what);
  const { kind, mediaType } = classifyDocument(res.headers.get("content-type"), document);
  return {
    digest: verdict.digest,
    headerDigest: verdict.headerDigest,
    headerAgreed: verdict.headerAgreed,
    mediaType,
    kind,
    size: res.bytes.byteLength,
    document,
  };
}

/**
 * Fetch a config blob and verify it against the descriptor that named it. A
 * blob is content addressed too, so the same rule applies: the digest of the
 * bytes must be the digest the manifest promised, or the labels and entrypoint
 * we are about to report belong to some other image.
 */
async function fetchConfig(
  client: RegistryClient,
  ref: ImageRef,
  digest: string,
  mediaType: string,
): Promise<ConfigSummary> {
  const res = await registryGet(client, blobPath(ref, digest), {
    accept: mediaType === "" ? "application/json" : mediaType,
    maxBytes: LIMITS.configBytes,
    scope: pullScope(ref.repository),
  });
  verifyDigest(
    res.bytes,
    res.headers.get("docker-content-digest"),
    digest,
    `config blob ${digest}`,
  );
  return readConfig(parseDocument(res.bytes, "config blob"));
}

export const containerImageInspect: RegisteredTool = buildTool({
  name: "ContainerImageInspect",
  description:
    "Resolve a container image tag to the digest it points at right now, over the OCI registry API — no daemon, no pull, no Docker. Returns the manifest digest and media type, the per-platform digest when the tag is a multi-arch index, the layer sizes, and the image config's labels, entrypoint and created time. Use it to pin a deployment to a digest, or to read an image's labels without downloading it. Pass compareTo a digest you recorded earlier and the answer says, as a boolean, whether the tag still points at it. The digest is computed from the response bytes and checked against the registry's own header rather than copied from it, so a registry cannot tell this tool that bytes are something they are not. Anonymous pulls only: a private repository is refused, with an explanation, rather than guessed at.",
  inputSchema: z.object({
    image: z
      .string()
      .min(1)
      .describe(
        "image reference, e.g. alpine:3.19, ghcr.io/owner/app:1.4.2, quay.io/org/app@sha256:…",
      ),
    platform: z
      .string()
      .optional()
      .describe(
        `which platform to resolve out of a multi-arch index, as os/arch[/variant]; default ${DEFAULT_PLATFORM}`,
      ),
    indexOnly: z
      .boolean()
      .optional()
      .describe("stop at the index and list its platforms instead of resolving one of them"),
    includeConfig: z
      .boolean()
      .optional()
      .describe(
        "fetch the image config blob for labels, entrypoint and created time; on by default, costs one extra GET",
      ),
    includeLayers: z
      .boolean()
      .optional()
      .describe("list every layer, not just the count and total size"),
    compareTo: z
      .string()
      .optional()
      .describe(
        "a digest (sha256:…) you pinned earlier, or another image reference; the answer says whether it is the same image — use it to find out whether a tag has moved",
      ),
    timeoutMs: timeoutField,
  }),
  readOnly: true,
  concurrencySafe: true,
  // Reaching a registry is a network egress like any other: the payload is a
  // repository name, which is itself worth classifying before it leaves.
  scope: "external",
  ioCapability: "network",
  execute: async (input, ctx) => {
    const ref = parseImageRef(input.image);
    const client = clientFor(ref, ctx, input.timeoutMs);
    const wantConfig = input.includeConfig ?? true;

    const top = await fetchManifest(
      client,
      ref,
      ref.reference,
      ref.referenceKind === "digest" ? ref.reference : null,
      `manifest for ${ref.canonical}`,
    );

    // `image` echoes the reference; `resolved` is what the tag points at today;
    // `manifest` (below) is the single-platform image inside it. Keeping the
    // three apart is what lets a caller pin `resolved.digest` for a multi-arch
    // deployment and `manifest.digest` for a single-arch node.
    const head = {
      image: ref.canonical,
      registry: ref.registry,
      repository: ref.repository,
      reference: ref.reference,
      referenceKind: ref.referenceKind,
      resolved: {
        digest: top.digest,
        mediaType: top.mediaType,
        kind: top.kind,
        size: top.size,
        // "The header agreed with the bytes" and "there was no header" are
        // different facts; a caller auditing a registry wants to tell them apart.
        digestHeader: top.headerDigest,
        digestHeaderAgreed: top.headerAgreed,
      },
    };

    if (top.kind === "manifest") {
      const manifest = await describeImage(
        client,
        ref,
        top,
        undefined,
        wantConfig,
        input.includeLayers ?? false,
      );
      const comparison = await compare(
        input.compareTo,
        top.digest,
        manifest["digest"] as string,
        ctx,
        input.timeoutMs,
      );
      return json({
        ...head,
        manifest,
        ...(comparison !== undefined ? { comparison } : {}),
        requests: client.requests,
      });
    }

    const { platforms, attestations } = readIndex(top.document);
    const platformList = platforms.map((p) => ({
      platform: p.platform,
      digest: p.digest,
      size: p.size,
      mediaType: p.mediaType,
      ...(p.osVersion !== undefined ? { osVersion: p.osVersion } : {}),
    }));

    if (input.indexOnly === true) {
      const comparison = await compare(
        input.compareTo,
        top.digest,
        undefined,
        ctx,
        input.timeoutMs,
      );
      return json({
        ...head,
        platforms: platformList,
        attestations,
        ...(comparison !== undefined ? { comparison } : {}),
        requests: client.requests,
      });
    }

    const wanted = parsePlatform(input.platform ?? DEFAULT_PLATFORM);
    const selected = selectOrExplain(platforms, wanted, input.platform ?? DEFAULT_PLATFORM, ref);
    // `windows/amd64` is not one image: an index carries one entry per Windows
    // build, distinguished only by `os.version`. Picking the first and calling
    // it "the amd64 image" is a digest that will not run on the caller's host,
    // so the count travels with the answer.
    const siblings = platforms.filter((p) => p.platform === selected.platform).length;
    const child = await fetchManifest(
      client,
      ref,
      selected.digest,
      selected.digest,
      `manifest ${selected.digest} for ${selected.platform}`,
    );
    if (child.kind !== "manifest") {
      throw new Error(
        `${ref.canonical} is an index whose ${selected.platform} entry is another index (${child.mediaType}) — nested indexes are not resolved, since there is no single per-platform image to report`,
      );
    }
    const manifest = await describeImage(
      client,
      ref,
      child,
      selected,
      wantConfig,
      input.includeLayers ?? false,
      siblings,
    );
    const comparison = await compare(
      input.compareTo,
      top.digest,
      manifest["digest"] as string,
      ctx,
      input.timeoutMs,
    );
    return json({
      ...head,
      platforms: platformList,
      attestations,
      manifest,
      ...(comparison !== undefined ? { comparison } : {}),
      requests: client.requests,
    });
  },
});

/**
 * Answer "is this still the image I pinned?" with a boolean rather than two long
 * hex strings for somebody else to diff. Comparing DIGESTS is the only version
 * of this question worth asking: two references can carry the same tag and
 * different content, which is the entire failure mode.
 *
 * A digest costs nothing — it is compared against both the digest the tag
 * resolves to and the per-platform digest inside it, since a caller may have
 * pinned either. A reference costs one lookup of its own and may live on a
 * different registry: a digest means the same thing everywhere.
 */
async function compare(
  compareTo: string | undefined,
  resolvedDigest: string,
  platformDigest: string | undefined,
  ctx: ToolExecuteContext | undefined,
  timeoutMs: number | undefined,
): Promise<Record<string, unknown> | undefined> {
  if (compareTo === undefined || compareTo.trim() === "") return undefined;
  const other = compareTo.trim();

  let otherDigest: string;
  let otherLabel = other;
  // The discriminator is the ALGORITHM, not the shape. `<word>:<hex>` describes
  // a digest AND describes `alpine:3`, `nginx:1`, `redis:7` — half of Docker
  // Hub — so a shape test would refuse the "or another image reference" this
  // input documents. Keying on the algorithm also keeps `sha256:deadbeef` a
  // bad digest rather than a lookup of docker.io/library/sha256:deadbeef.
  if (/^(?:sha256|sha512):/.test(other)) {
    const parsed = parseDigest(other);
    otherDigest = `${parsed.algorithm}:${parsed.hex}`;
  } else {
    const otherRef = parseImageRef(other);
    otherLabel = otherRef.canonical;
    const otherClient = clientFor(otherRef, ctx, timeoutMs);
    const fetched = await fetchManifest(
      otherClient,
      otherRef,
      otherRef.reference,
      otherRef.referenceKind === "digest" ? otherRef.reference : null,
      `manifest for ${otherRef.canonical}`,
    );
    otherDigest = fetched.digest;
  }

  const matched =
    otherDigest === resolvedDigest
      ? "resolved"
      : platformDigest !== undefined && otherDigest === platformDigest
        ? "platform"
        : null;
  return { to: otherLabel, digest: otherDigest, same: matched !== null, matched };
}

/**
 * Refuse a platform miss with the list of platforms that DO exist. "no match"
 * alone sends the caller back to the registry to ask a question this call
 * already has the answer to.
 */
function selectOrExplain(
  platforms: readonly PlatformDescriptor[],
  wanted: { os: string; architecture: string; variant?: string },
  asked: string,
  ref: ImageRef,
): PlatformDescriptor {
  // The choice itself is `selectPlatform`, not a second copy of the rule here:
  // a caller asking for `linux/arm64` wants the image a plain arm64 host would
  // pull, which is the variant-LESS entry when the index has one — not
  // whichever arm64 entry buildx happened to write first.
  const selected = selectPlatform(platforms, wanted);
  if (selected !== undefined) return selected;
  const available = platforms.map((p) => p.platform).join(", ") || "none";
  throw new Error(`${ref.canonical} has no ${asked} image — the index lists ${available}`);
}

async function describeImage(
  client: RegistryClient,
  ref: ImageRef,
  manifest: FetchedManifest,
  selected: PlatformDescriptor | undefined,
  wantConfig: boolean,
  wantLayers: boolean,
  /** How many index entries share the selected platform string; 1 unless os.version splits them. */
  platformMatches = 1,
): Promise<Record<string, unknown>> {
  const summary = readManifest(manifest.document);
  const isImageConfig = IMAGE_CONFIG_TYPES.has(summary.config.mediaType);
  let config: ConfigSummary | undefined;
  let configNote: string | undefined;
  if (wantConfig) {
    if (isImageConfig) {
      config = await fetchConfig(client, ref, summary.config.digest, summary.config.mediaType);
    } else {
      // Helm charts, cosign signatures and SBOM artifacts all ride the image
      // manifest shape with a config blob that is not an image config. Fetching
      // and parsing it as one would invent fields nobody set.
      configNote = `config media type is ${summary.config.mediaType || "(unset)"}, not an image config — this is an OCI artifact rather than a runnable image, so no config was read`;
    }
  }

  return {
    digest: manifest.digest,
    mediaType: manifest.mediaType,
    size: manifest.size,
    ...(selected !== undefined ? { platform: selected.platform } : {}),
    ...(selected?.osVersion !== undefined ? { osVersion: selected.osVersion } : {}),
    ...(platformMatches > 1 ? { platformMatches } : {}),
    configDigest: summary.config.digest,
    configMediaType: summary.config.mediaType,
    ...(isImageConfig ? {} : { artifact: true }),
    layerCount: summary.layers.length,
    totalLayerSize: summary.totalLayerSize,
    // A missing `size` makes the total a floor. Saying so beats a plausible
    // number that is quietly short by a layer.
    ...(summary.unsizedLayers > 0 ? { unsizedLayers: summary.unsizedLayers } : {}),
    ...(wantLayers
      ? {
          layers: summary.layers.map((l) => ({
            digest: l.digest,
            size: l.size,
            mediaType: l.mediaType,
          })),
        }
      : {}),
    ...(summary.annotations !== undefined ? { annotations: summary.annotations } : {}),
    ...(summary.subject !== undefined ? { subject: summary.subject } : {}),
    ...(config !== undefined ? { config } : {}),
    ...(configNote !== undefined ? { configNote } : {}),
  };
}

export const containerImageTags: RegisteredTool = buildTool({
  name: "ContainerImageTags",
  description:
    "List a container repository's tags over the OCI registry API, paged, filtered by glob and sorted newest-first by semver precedence — with tags that are not versions (latest, edge, sha-9f3c1a) kept and listed after them rather than dropped or guessed at. Use it to find the newest release of an image, to check whether a version was ever published, or to see what a repository offers before pinning to one. Set withDigests to resolve each listed tag to its digest, which costs one request per tag and is capped. Anonymous pulls only; a private repository is refused rather than reported as empty.",
  inputSchema: z.object({
    image: z
      .string()
      .min(1)
      .describe(
        "repository reference, e.g. alpine, ghcr.io/owner/app; a tag in the reference is reported and ignored",
      ),
    match: z
      .string()
      .optional()
      .describe("glob over tag names, e.g. '1.*' or 'v?.?.?'; * and ? only"),
    sort: z
      .enum(["semver", "name", "registry"])
      .optional()
      .describe("semver (default, newest first), name (lexicographic), or registry (as returned)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("how many tags to return; default 100"),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("tags per registry request; default 100"),
    maxPages: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("how many pages to follow; default 5"),
    withDigests: z
      .boolean()
      .optional()
      .describe(
        `resolve each returned tag to its digest; one request per tag, at most ${LIMITS.digestFanout}`,
      ),
    timeoutMs: timeoutField,
  }),
  readOnly: true,
  concurrencySafe: true,
  scope: "external",
  ioCapability: "network",
  execute: async (input, ctx) => {
    const ref = parseImageRef(input.image, { defaultTag: false });
    const client = clientFor(ref, ctx, input.timeoutMs);
    const limit = input.limit ?? 100;
    const pageSize = input.pageSize ?? 100;
    const maxPages = input.maxPages ?? 5;
    const scope = pullScope(ref.repository);

    let url: URL | null = registryUrl(ref.apiHost, `/v2/${ref.repository}/tags/list?n=${pageSize}`);
    const collected: string[] = [];
    let pages = 0;
    let morePages = false;
    let malformed = 0;

    while (url !== null) {
      if (pages >= maxPages) {
        morePages = true;
        break;
      }
      const res: Awaited<ReturnType<typeof registryGetUrl>> = await registryGetUrl(client, url, {
        accept: "application/json",
        maxBytes: LIMITS.tagsBytes,
        scope,
      });
      pages++;
      // Nothing here is content addressed, so parsing is safe — unlike the
      // manifest path, where the bytes ARE the identity.
      const page = readTagsPage(parseDocument(res.bytes, "tags/list response"));
      collected.push(...page.tags);
      malformed += page.malformed;
      url = nextPageUrl(res.headers.get("link"), url);
    }

    const matched = filterTags(collected, input.match);
    const sorted = sortTags(matched, input.sort ?? "semver");
    const selected = sorted.slice(0, limit);

    const head = {
      registry: ref.registry,
      repository: ref.repository,
      ...(ref.reference !== "" ? { ignoredReference: ref.reference } : {}),
      fetched: collected.length,
      // Entries the registry listed that are not tags under the distribution
      // grammar. They cannot be pulled and are not put in a URL, but a caller
      // auditing a registry should hear that they were sent.
      ...(malformed > 0 ? { malformed } : {}),
      matched: matched.length,
      returned: selected.length,
      pages,
      morePages,
      sort: input.sort ?? "semver",
    };

    if (input.withDigests !== true) {
      return json({ ...head, tags: selected, requests: client.requests });
    }

    if (selected.length > LIMITS.digestFanout) {
      throw new Error(
        `withDigests resolves one manifest per tag and ${selected.length} tags were selected, over the ${LIMITS.digestFanout} cap — narrow with match, or lower limit`,
      );
    }

    const tags: Array<Record<string, unknown>> = [];
    for (const tag of selected) {
      try {
        const manifest = await fetchManifest(
          client,
          ref,
          tag,
          null,
          `manifest for ${ref.registry}/${ref.repository}:${tag}`,
        );
        tags.push({
          tag,
          digest: manifest.digest,
          mediaType: manifest.mediaType,
          kind: manifest.kind,
          size: manifest.size,
        });
      } catch (err) {
        // A tag that 404s (deleted between the listing and now) or that is an
        // unreadable schema 1 manifest is reported against that tag; the rest of
        // the list is still worth having. An INTEGRITY failure is different and
        // is never swallowed — see the rethrow below.
        if (isIntegrityFailure(err)) throw err;
        tags.push({ tag, error: (err as Error).message });
      }
    }
    return json({ ...head, tags, requests: client.requests });
  },
});

/**
 * A digest that does not match its content is evidence about the registry, not
 * about one tag, so it aborts the whole listing. Everything else — 404, 429, a
 * schema 1 manifest — is a fact about that tag alone.
 *
 * The flag is set where the mismatch is detected. Matching on message text
 * here would mean a reworded sentence silently downgrades a tampering signal
 * to a footnote against one tag.
 */
function isIntegrityFailure(err: unknown): boolean {
  return err instanceof ManifestError && err.integrity;
}

/** Every tool this package registers, in the order a catalog should list them. */
export const CONTAINER_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  containerImageInspect,
  containerImageTags,
]);
