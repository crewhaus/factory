/**
 * Digests, media types and the two shapes a tag can resolve to.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: hash first, parse second, and never
 * hash anything but the bytes that arrived. `JSON.parse` followed by
 * `JSON.stringify` changes key order, whitespace and `é`-style escapes —
 * all of which are inside the sha256 preimage. A digest computed from
 * reserialized JSON is not wrong in some subtle academic way; it is a different
 * number, it matches nothing, and it makes "this is the image we tested" false
 * while looking exactly like it is true.
 *
 * So: `digestBytes` takes `Uint8Array`, `parseDocument` is only ever called on
 * a value that has already been hashed, and nothing in this package ever
 * re-serializes a manifest.
 */
import { createHash } from "node:crypto";
import { type ImageRef, assertPullReference, parseDigest } from "./ref";

export class ManifestError extends Error {
  override readonly name = "ManifestError";
  /**
   * True when the bytes in hand are not the bytes that were addressed — a
   * digest that disagrees with its content, from whichever side claimed it.
   * A FLAG rather than a phrase in the message: `withDigests` decides between
   * "note this against one tag" and "abort the whole listing" on this, and a
   * caller that decided by matching message text would fail open the first
   * time somebody reworded a sentence.
   */
  readonly integrity: boolean;
  constructor(message: string, integrity = false) {
    super(message);
    this.integrity = integrity;
  }
}

export const MEDIA_TYPES = {
  dockerManifest: "application/vnd.docker.distribution.manifest.v2+json",
  dockerList: "application/vnd.docker.distribution.manifest.list.v2+json",
  ociManifest: "application/vnd.oci.image.manifest.v1+json",
  ociIndex: "application/vnd.oci.image.index.v1+json",
  dockerSchema1: "application/vnd.docker.distribution.manifest.v1+json",
  dockerSchema1Signed: "application/vnd.docker.distribution.manifest.v1+prettyjws",
} as const;

/**
 * Every manifest type we can read, offered in one Accept header. Send all four
 * or a registry will helpfully convert a manifest list down to a single
 * manifest for you — and then the digest you report is not the digest of the
 * tag you asked about.
 */
export const MANIFEST_ACCEPT = [
  MEDIA_TYPES.ociIndex,
  MEDIA_TYPES.ociManifest,
  MEDIA_TYPES.dockerList,
  MEDIA_TYPES.dockerManifest,
].join(", ");

/** sha256 (or sha512) over the exact bytes, formatted as an OCI digest. */
export function digestBytes(bytes: Uint8Array, algorithm: "sha256" | "sha512" = "sha256"): string {
  return `${algorithm}:${createHash(algorithm).update(bytes).digest("hex")}`;
}

export type DigestVerdict = {
  /** The digest WE computed. Everything downstream uses this one. */
  readonly digest: string;
  /** What `Docker-Content-Digest` claimed, when the registry sent it. */
  readonly headerDigest: string | null;
  /** True when a header was present and agreed with the computed digest. */
  readonly headerAgreed: boolean;
};

/**
 * Compute the digest of a document and check it against everything that claims
 * to know it: the `Docker-Content-Digest` header, and — when the caller asked
 * for a specific digest, or followed a descriptor out of an index — the digest
 * it was promised.
 *
 * A mismatch is a refusal, never a warning. It means the bytes in hand are not
 * the bytes that were addressed, and there is no answer to give that is both
 * true and useful.
 */
export function verifyDigest(
  bytes: Uint8Array,
  header: string | null,
  expected: string | null,
  what: string,
): DigestVerdict {
  const algorithm =
    expected === null ? "sha256" : (parseDigest(expected).algorithm as "sha256" | "sha512");
  const digest = digestBytes(bytes, algorithm);

  if (expected !== null && digest !== expected) {
    throw new ManifestError(
      `${what}: the registry served bytes whose digest is ${digest}, but ${expected} was requested — refusing to report a digest that does not match its content`,
      true,
    );
  }
  let headerAgreed = false;
  if (header !== null && header.trim() !== "") {
    const claimed = header.trim().toLowerCase();
    // Compare only when the header uses an algorithm we computed; a registry
    // claiming sha512 while we hashed sha256 is a mismatch of question, not of
    // answer, so we recompute in the header's algorithm before disagreeing.
    const claimedAlgorithm = claimed.split(":")[0] as string;
    const ours =
      claimedAlgorithm === algorithm
        ? digest
        : claimedAlgorithm === "sha256" || claimedAlgorithm === "sha512"
          ? digestBytes(bytes, claimedAlgorithm)
          : null;
    if (ours === null) {
      throw new ManifestError(
        `${what}: registry claims digest algorithm "${claimedAlgorithm}", which cannot be recomputed here`,
        true,
      );
    }
    if (ours !== claimed) {
      throw new ManifestError(
        `${what}: Docker-Content-Digest says ${claimed} but the bytes hash to ${ours} — the header is not evidence, and it disagrees with the content`,
        true,
      );
    }
    headerAgreed = true;
  }
  return {
    digest,
    headerDigest: header === null ? null : header.trim().toLowerCase(),
    headerAgreed,
  };
}

/**
 * Decode and parse a document AFTER its digest has been taken. `fatal: true`
 * matters: a lenient decode would replace invalid bytes with U+FFFD and parse a
 * document that is not what was served.
 */
export function parseDocument(bytes: Uint8Array, what: string): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ManifestError(`${what} is not valid UTF-8`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ManifestError(`${what} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ManifestError(`${what} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export type DocumentKind = "manifest" | "index";

/**
 * Decide what kind of document this is, preferring what the bytes say about
 * themselves over what the transport said. A registry's Content-Type can be
 * absent, generic (`application/json`), or — behind a proxy — simply wrong,
 * while `mediaType` inside an OCI document is part of the digested content.
 * Structure is the last resort, for old Docker manifests that omit `mediaType`.
 */
export function classifyDocument(
  contentType: string | null,
  document: Record<string, unknown>,
): { kind: DocumentKind; mediaType: string } {
  const declared =
    typeof document["mediaType"] === "string" ? (document["mediaType"] as string) : "";
  const transport = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const mediaType = declared !== "" ? declared : transport;

  if (mediaType === MEDIA_TYPES.dockerSchema1 || mediaType === MEDIA_TYPES.dockerSchema1Signed) {
    throw new ManifestError(
      "this tag is a schema 1 manifest, whose digest covers a JWS signature rather than the image content — pull it with a v2 client or ask the registry for a v2 manifest; a schema 1 digest would not mean what the caller thinks it means",
    );
  }
  if (mediaType === MEDIA_TYPES.ociIndex || mediaType === MEDIA_TYPES.dockerList) {
    return { kind: "index", mediaType };
  }
  if (mediaType === MEDIA_TYPES.ociManifest || mediaType === MEDIA_TYPES.dockerManifest) {
    return { kind: "manifest", mediaType };
  }
  // No usable media type: fall back to shape. `manifests` is an index, a
  // `config` descriptor plus `layers` is an image manifest.
  if (Array.isArray(document["manifests"])) {
    return { kind: "index", mediaType: mediaType === "" ? MEDIA_TYPES.ociIndex : mediaType };
  }
  if (Array.isArray(document["layers"]) && typeof document["config"] === "object") {
    return { kind: "manifest", mediaType: mediaType === "" ? MEDIA_TYPES.ociManifest : mediaType };
  }
  if (document["schemaVersion"] === 1 || Array.isArray(document["fsLayers"])) {
    throw new ManifestError(
      "this tag is a schema 1 manifest (fsLayers/schemaVersion 1) — its digest covers a signature envelope, not the image content",
    );
  }
  throw new ManifestError(
    `cannot tell what kind of document this is — media type "${mediaType || "(none)"}", and it has neither "manifests" nor "layers"`,
  );
}

export type Descriptor = {
  readonly mediaType: string;
  readonly digest: string;
  readonly size: number;
};

export type PlatformDescriptor = Descriptor & {
  readonly platform: string;
  readonly os: string;
  readonly architecture: string;
  readonly variant?: string;
  readonly osVersion?: string;
};

function readDescriptor(raw: unknown, what: string): Descriptor {
  if (typeof raw !== "object" || raw === null)
    throw new ManifestError(`${what} is not a descriptor`);
  const d = raw as Record<string, unknown>;
  const rawDigest = typeof d["digest"] === "string" ? (d["digest"] as string) : "";
  if (rawDigest === "") throw new ManifestError(`${what} has no digest`);
  // Refuse an unverifiable algorithm here, not three calls later — and store
  // the NORMALISED form. Hex case is not identity: a descriptor written
  // `sha256:AB…` addresses the same bytes as `sha256:ab…`, but comparing it
  // against a freshly computed (lower-case) digest would raise the tampering
  // refusal, which has to stay believable.
  const parsed = parseDigest(rawDigest);
  return {
    mediaType: typeof d["mediaType"] === "string" ? (d["mediaType"] as string) : "",
    digest: `${parsed.algorithm}:${parsed.hex}`,
    size: typeof d["size"] === "number" && Number.isFinite(d["size"]) ? (d["size"] as number) : -1,
  };
}

/** Render a platform the way `docker buildx` prints it: os/arch[/variant]. */
export function platformString(os: string, architecture: string, variant?: string): string {
  return variant === undefined || variant === ""
    ? `${os}/${architecture}`
    : `${os}/${architecture}/${variant}`;
}

/** Parse `linux/arm64/v8` into its parts. Rejects anything else. */
export function parsePlatform(raw: string): { os: string; architecture: string; variant?: string } {
  const parts = raw
    .trim()
    .toLowerCase()
    .split("/")
    .filter((p) => p !== "");
  if (parts.length < 2 || parts.length > 3) {
    throw new ManifestError(
      `"${raw}" is not a platform — write os/arch or os/arch/variant, e.g. linux/arm64/v8`,
    );
  }
  const [os, architecture, variant] = parts as [string, string, string | undefined];
  return variant === undefined ? { os, architecture } : { os, architecture, variant };
}

export type IndexEntries = {
  readonly platforms: readonly PlatformDescriptor[];
  /**
   * Entries with no usable platform — buildkit writes provenance and SBOM
   * manifests into the index as `unknown/unknown`, and selecting one of those
   * as "the image" is a classic multi-arch bug.
   */
  readonly attestations: number;
};

export function readIndex(document: Record<string, unknown>): IndexEntries {
  const raw = document["manifests"];
  if (!Array.isArray(raw)) throw new ManifestError("index has no manifests array");
  const platforms: PlatformDescriptor[] = [];
  let attestations = 0;
  for (const [i, entry] of raw.entries()) {
    const descriptor = readDescriptor(entry, `index entry ${i}`);
    const p = (entry as Record<string, unknown>)["platform"];
    const platform = typeof p === "object" && p !== null ? (p as Record<string, unknown>) : {};
    const os = typeof platform["os"] === "string" ? (platform["os"] as string) : "";
    const architecture =
      typeof platform["architecture"] === "string" ? (platform["architecture"] as string) : "";
    const variant =
      typeof platform["variant"] === "string" ? (platform["variant"] as string) : undefined;
    const osVersion =
      typeof platform["os.version"] === "string" ? (platform["os.version"] as string) : undefined;
    if (os === "" || architecture === "" || os === "unknown" || architecture === "unknown") {
      attestations++;
      continue;
    }
    platforms.push({
      ...descriptor,
      platform: platformString(os, architecture, variant),
      os,
      architecture,
      ...(variant !== undefined ? { variant } : {}),
      ...(osVersion !== undefined ? { osVersion } : {}),
    });
  }
  return { platforms, attestations };
}

/**
 * Pick the entry for the wanted platform.
 *
 * A caller who names a variant gets exactly that. A caller who does not gets
 * the variant-less entry when there is one, else the first match in index
 * order — index order, not "best", because the registry's order is the only
 * ranking anyone can reproduce.
 */
export function selectPlatform(
  entries: readonly PlatformDescriptor[],
  wanted: { os: string; architecture: string; variant?: string },
): PlatformDescriptor | undefined {
  const matches = entries.filter(
    (e) => e.os === wanted.os && e.architecture === wanted.architecture,
  );
  if (matches.length === 0) return undefined;
  if (wanted.variant !== undefined) return matches.find((e) => e.variant === wanted.variant);
  return matches.find((e) => e.variant === undefined) ?? matches[0];
}

export type ManifestSummary = {
  readonly config: Descriptor;
  readonly layers: readonly Descriptor[];
  readonly totalLayerSize: number;
  /**
   * Layers whose descriptor carried no usable `size`. `totalLayerSize` is the
   * sum of the ones that did, so a non-zero count here means that total is a
   * floor rather than the answer — and somebody sizes a disk on it.
   */
  readonly unsizedLayers: number;
  readonly annotations?: Record<string, string>;
  readonly subject?: string;
};

export function readManifest(document: Record<string, unknown>): ManifestSummary {
  const config = readDescriptor(document["config"], "manifest config");
  const rawLayers = document["layers"];
  if (!Array.isArray(rawLayers)) throw new ManifestError("manifest has no layers array");
  const layers = rawLayers.map((l, i) => readDescriptor(l, `layer ${i}`));
  const totalLayerSize = layers.reduce((sum, l) => sum + (l.size > 0 ? l.size : 0), 0);
  const unsizedLayers = layers.filter((l) => l.size < 0).length;
  const annotations = readStringMap(document["annotations"]);
  const subject = document["subject"];
  const subjectDigest =
    typeof subject === "object" &&
    subject !== null &&
    typeof (subject as Record<string, unknown>)["digest"] === "string"
      ? ((subject as Record<string, unknown>)["digest"] as string)
      : undefined;
  return {
    config,
    layers,
    totalLayerSize,
    unsizedLayers,
    ...(annotations !== undefined ? { annotations } : {}),
    ...(subjectDigest !== undefined ? { subject: subjectDigest } : {}),
  };
}

export type ConfigSummary = {
  readonly created?: string;
  readonly architecture?: string;
  readonly os?: string;
  readonly variant?: string;
  readonly user?: string;
  readonly workingDir?: string;
  readonly entrypoint?: readonly string[];
  readonly cmd?: readonly string[];
  readonly exposedPorts?: readonly string[];
  readonly volumes?: readonly string[];
  readonly labels?: Record<string, string>;
  readonly envNames?: readonly string[];
  readonly diffIds?: number;
};

/**
 * The interesting half of the image config blob. Env VALUES are deliberately
 * dropped and only the names kept: a config blob is where a careless build
 * leaves a token, and a tool that echoes every `ENV` into a transcript is a
 * tool that leaks it.
 */
export function readConfig(document: Record<string, unknown>): ConfigSummary {
  const cfg =
    typeof document["config"] === "object" && document["config"] !== null
      ? (document["config"] as Record<string, unknown>)
      : {};
  const rootfs =
    typeof document["rootfs"] === "object" && document["rootfs"] !== null
      ? (document["rootfs"] as Record<string, unknown>)
      : {};
  const diffIds = Array.isArray(rootfs["diff_ids"])
    ? (rootfs["diff_ids"] as unknown[]).length
    : undefined;
  const env = Array.isArray(cfg["Env"])
    ? (cfg["Env"] as unknown[])
        .filter((e): e is string => typeof e === "string")
        .map((e) => (e.includes("=") ? (e.split("=")[0] as string) : e))
    : undefined;

  return {
    ...pickString(document, "created"),
    ...pickString(document, "architecture"),
    ...pickString(document, "os"),
    ...pickString(document, "variant"),
    ...pickString(cfg, "User", "user"),
    ...pickString(cfg, "WorkingDir", "workingDir"),
    ...pickStrings(cfg, "Entrypoint", "entrypoint"),
    ...pickStrings(cfg, "Cmd", "cmd"),
    ...(readKeySet(cfg["ExposedPorts"]) !== undefined
      ? { exposedPorts: readKeySet(cfg["ExposedPorts"]) }
      : {}),
    ...(readKeySet(cfg["Volumes"]) !== undefined ? { volumes: readKeySet(cfg["Volumes"]) } : {}),
    ...(readStringMap(cfg["Labels"]) !== undefined ? { labels: readStringMap(cfg["Labels"]) } : {}),
    ...(env !== undefined ? { envNames: env } : {}),
    ...(diffIds !== undefined ? { diffIds } : {}),
  };
}

function pickString(
  source: Record<string, unknown>,
  key: string,
  as = key,
): Record<string, string> | Record<string, never> {
  const value = source[key];
  return typeof value === "string" && value !== "" ? { [as]: value } : {};
}

function pickStrings(
  source: Record<string, unknown>,
  key: string,
  as: string,
): Record<string, string[]> | Record<string, never> {
  const value = source[key];
  if (!Array.isArray(value)) return {};
  const strings = value.filter((v): v is string => typeof v === "string");
  return strings.length === 0 ? {} : { [as]: strings };
}

function readKeySet(value: unknown): string[] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return keys.length === 0 ? undefined : keys;
}

function readStringMap(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * `/v2/<name>/manifests/<reference>` for a parsed reference.
 *
 * The reference is re-checked against the tag/digest grammar HERE, at the one
 * place it becomes a URL path, because not every caller of this function got
 * its reference from `parseImageRef`: `withDigests` passes tags straight out of
 * the registry's own `/tags/list`.
 */
export function manifestPath(ref: ImageRef, reference = ref.reference): string {
  assertPullReference(reference);
  return `/v2/${ref.repository}/manifests/${reference}`;
}

/** `/v2/<name>/blobs/<digest>` — config blobs only; this package never pulls layers. */
export function blobPath(ref: ImageRef, digest: string): string {
  parseDigest(digest); // same containment rule: a blob is only ever addressed by digest
  return `/v2/${ref.repository}/blobs/${digest}`;
}
