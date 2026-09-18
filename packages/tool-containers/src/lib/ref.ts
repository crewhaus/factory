/**
 * Image reference parsing — the `[registry/]repository[:tag][@digest]` grammar
 * every container tool in the world accepts and almost nobody writes down.
 *
 * Two things here are load-bearing rather than cosmetic:
 *
 *   1. The repository is interpolated into a URL path (`/v2/<name>/manifests/…`).
 *      Anything outside the OCI grammar is REFUSED rather than escaped, so a
 *      reference like `ghcr.io/a/../../v2/other/manifests/latest` cannot walk
 *      the client onto a different repository — or off `/v2/` entirely.
 *   2. Docker Hub is not `docker.io`. The API host is `registry-1.docker.io`
 *      and a one-segment name means the `library/` namespace, so `alpine` is
 *      `registry-1.docker.io/v2/library/alpine`. Every other registry uses the
 *      name as written.
 */

/** Registries that mean Docker Hub, whatever the caller typed. */
const DOCKER_HUB_ALIASES = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"]);
const DOCKER_HUB_API_HOST = "registry-1.docker.io";

/**
 * One path component of a repository name, per the distribution spec:
 * lowercase alphanumerics with single `.`/`_`, double `__`, or runs of `-` as
 * separators. Uppercase is invalid — refusing `Alpine` is kinder than the 404
 * the registry would answer with.
 */
const COMPONENT_RE = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*$/;

/** A tag: up to 128 characters, no leading `.` or `-`. */
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** A registry host, optionally with a port. No scheme, no path, no userinfo. */
const HOST_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::\d{1,5})?$/;

/** OCI digest grammar: `<algorithm>:<encoded>`. */
const DIGEST_RE = /^([a-z0-9]+(?:[.+_-][a-z0-9]+)*):([a-zA-Z0-9=_-]+)$/;

/** Hex length of the digests we can actually recompute from response bytes. */
const SUPPORTED_DIGESTS: Record<string, number> = { sha256: 64, sha512: 128 };

export class ImageRefError extends Error {
  override readonly name = "ImageRefError";
}

export type ImageRef = {
  /** What the caller means by the registry — `docker.io`, not the API host. */
  readonly registry: string;
  /** The host actually contacted; differs from `registry` only for Docker Hub. */
  readonly apiHost: string;
  /** Fully qualified repository, `library/` synthesised for Hub official images. */
  readonly repository: string;
  /** The tag or digest this reference selects. */
  readonly reference: string;
  readonly referenceKind: "tag" | "digest";
  /** Normalised `registry/repository:tag` (or `@digest`), for echoing back. */
  readonly canonical: string;
};

/**
 * Validate a digest string and return its algorithm. Refuses an algorithm we
 * cannot recompute: reporting a digest we could not check against the bytes
 * would be exactly the lie this package exists to avoid.
 */
export function parseDigest(raw: string): { algorithm: string; hex: string } {
  const m = DIGEST_RE.exec(raw);
  if (!m) {
    throw new ImageRefError(`"${raw}" is not a digest — expected <algorithm>:<hex>, e.g. sha256:…`);
  }
  const algorithm = m[1] as string;
  const hex = (m[2] as string).toLowerCase();
  const expected = SUPPORTED_DIGESTS[algorithm];
  if (expected === undefined) {
    throw new ImageRefError(
      `digest algorithm "${algorithm}" is not supported — this tool verifies sha256 and sha512, and will not report a digest it cannot recompute`,
    );
  }
  if (hex.length !== expected || !/^[0-9a-f]+$/.test(hex)) {
    throw new ImageRefError(
      `"${raw}" is not a valid ${algorithm} digest — expected ${expected} hex characters, got ${hex.length}`,
    );
  }
  return { algorithm, hex };
}

/** True when the first path segment names a registry rather than a namespace. */
function looksLikeHost(segment: string): boolean {
  return segment.includes(".") || segment.includes(":") || segment === "localhost";
}

export type ParseOptions = {
  /**
   * `false` for the tags endpoint, which addresses a repository and not one
   * version of it. A tag is then still parsed and reported, so a caller who
   * pastes a full reference gets an answer instead of a lecture.
   */
  readonly defaultTag?: boolean;
};

/**
 * Parse `[registry/]repository[:tag][@digest]`.
 *
 * When both a tag and a digest are present (`alpine:3.19@sha256:…`, which is
 * what a pinned reference looks like) the DIGEST wins, because that is what the
 * registry will serve — the tag in such a reference is a human label and may
 * have been moved since it was written down.
 */
export function parseImageRef(raw: string, options: ParseOptions = {}): ImageRef {
  const input = raw.trim();
  if (input === "") throw new ImageRefError("image reference is empty");
  if (input.length > 512) {
    throw new ImageRefError(
      `image reference is ${input.length} characters — that is not a reference`,
    );
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input)) {
    throw new ImageRefError(
      `"${input}" has a URL scheme — an image reference has none; write ghcr.io/owner/name:tag`,
    );
  }

  let rest = input;
  let digest: string | null = null;
  const at = rest.indexOf("@");
  if (at !== -1) {
    const tail = rest.slice(at + 1);
    if (tail.includes("@")) {
      throw new ImageRefError(`"${input}" has more than one "@" — expected at most name@digest`);
    }
    const parsed = parseDigest(tail);
    digest = `${parsed.algorithm}:${parsed.hex}`;
    rest = rest.slice(0, at);
  }

  // Split the registry off only when the first segment is host-shaped. `foo/bar`
  // is a Docker Hub namespace, `foo.io/bar` is a registry — that single rule is
  // the whole disambiguation, and it is why `localhost` is special-cased.
  let registryRaw = "";
  let name = rest;
  const slash = rest.indexOf("/");
  if (slash !== -1) {
    const head = rest.slice(0, slash);
    if (looksLikeHost(head)) {
      registryRaw = head;
      name = rest.slice(slash + 1);
    }
  }

  // The tag separator is the last `:` that cannot be a registry port, i.e. one
  // that appears after the final `/`.
  let tag: string | null = null;
  const lastSlash = name.lastIndexOf("/");
  const colon = name.indexOf(":", lastSlash + 1);
  if (colon !== -1) {
    tag = name.slice(colon + 1);
    name = name.slice(0, colon);
    if (!TAG_RE.test(tag)) {
      throw new ImageRefError(
        `"${tag}" is not a valid tag — tags are up to 128 characters of letters, digits, ".", "_" and "-", and cannot start with "." or "-"`,
      );
    }
  }

  if (registryRaw !== "" && !HOST_RE.test(registryRaw)) {
    throw new ImageRefError(`"${registryRaw}" is not a valid registry host`);
  }
  // HOST_RE allows five port digits; 65536..99999 are not ports. Without this
  // the refusal is a raw `TypeError: … cannot be parsed as a URL` thrown from
  // `new URL` three calls later, which names neither the input nor the rule.
  const port = registryRaw.slice(registryRaw.lastIndexOf(":") + 1);
  if (registryRaw.includes(":") && (Number(port) < 1 || Number(port) > 65535)) {
    throw new ImageRefError(`"${registryRaw}" has port ${port}, which is not a port`);
  }

  if (name === "") throw new ImageRefError(`"${input}" has no repository name`);
  const components = name.split("/");
  for (const component of components) {
    if (component === "") {
      throw new ImageRefError(`"${name}" has an empty path component`);
    }
    if (!COMPONENT_RE.test(component)) {
      const hint = /[A-Z]/.test(component)
        ? " — repository names are lowercase"
        : component === "." || component === ".."
          ? " — relative path segments are not part of a repository name"
          : "";
      throw new ImageRefError(`"${component}" is not a valid repository path component${hint}`);
    }
  }
  if (components.length > 8) {
    throw new ImageRefError(
      `"${name}" has ${components.length} path components — expected at most 8`,
    );
  }

  const hubAlias = registryRaw === "" || DOCKER_HUB_ALIASES.has(registryRaw.toLowerCase());
  const registry = hubAlias ? "docker.io" : registryRaw.toLowerCase();
  const apiHost = hubAlias ? DOCKER_HUB_API_HOST : registry;
  // Hub's official images live under `library/`; the short form everyone types
  // is the only place in this grammar where a path segment is synthesised.
  const repository = hubAlias && components.length === 1 ? `library/${name}` : name;

  const defaultTag = options.defaultTag ?? true;
  const reference = digest ?? tag ?? (defaultTag ? "latest" : "");
  const referenceKind = digest !== null ? "digest" : "tag";
  const canonical =
    digest !== null
      ? `${registry}/${repository}@${digest}`
      : reference === ""
        ? `${registry}/${repository}`
        : `${registry}/${repository}:${reference}`;

  return { registry, apiHost, repository, reference, referenceKind, canonical };
}

/** True when `value` is a tag under the distribution grammar. */
export function isValidTag(value: string): boolean {
  return TAG_RE.test(value);
}

/**
 * Refuse a reference that is neither a tag nor a digest BEFORE it reaches
 * `/v2/<name>/manifests/<reference>`.
 *
 * A caller's reference arrives through `parseImageRef` and is already checked.
 * A tag read out of `/tags/list` is NOT: it is a JSON string the registry
 * chose, and `new URL("https://reg/v2/owner/app/manifests/" + "../../victim/manifests/latest")`
 * normalises to `https://reg/v2/victim/manifests/latest` — a different
 * repository, whose digest would then be reported as this one's tag. For a URL
 * path, containment is a grammar check; escaping the string would only turn a
 * silent redirection into a 404.
 */
export function assertPullReference(reference: string): void {
  if (isValidTag(reference)) return;
  // Digest-shaped gets the digest parser's specific reason (bad length,
  // unsupported algorithm) rather than this generic one.
  if (DIGEST_RE.test(reference)) {
    parseDigest(reference);
    return;
  }
  throw new ImageRefError(
    `"${reference.length > 80 ? `${reference.slice(0, 80)}…` : reference}" is neither a tag nor a digest — refusing to put it in a registry URL path`,
  );
}

/** The scope a pull token must ask for, for this repository. */
export function pullScope(repository: string): string {
  return `repository:${repository}:pull`;
}
