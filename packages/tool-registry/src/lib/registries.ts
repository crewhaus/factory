/**
 * One normalized answer from three registries that agree about nothing.
 *
 * npm keeps a packument whose per-version objects carry the metadata and
 * whose publish dates live in a separate `time` map. PyPI keeps the latest
 * version's metadata under `info` and every file of every release under
 * `releases`, where yanking is a per-FILE fact. crates.io keeps the crate and
 * its versions side by side and yanks per version. None of them means the
 * same thing by "latest".
 *
 * So each adapter answers the same questions and says nothing when its
 * registry does not know: an absent field here means "this registry does not
 * publish that", never "there is none". Fabricating a download count or a
 * repository URL would be worse than leaving the column out, because a
 * shortlist is chosen ON those columns.
 */
import { checkName, nameForUrl } from "./names";
import { type Ecosystem, type FetchFailureKind, REGISTRY_ORIGINS, byString, getJson } from "./net";

export type RegistryFailure = {
  readonly ok: false;
  readonly kind: FetchFailureKind | "invalidName" | "unsupported";
  readonly message: string;
};

export type PackageFacts = {
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly latest?: string;
  readonly latestPublishedAt?: string;
  readonly description?: string;
  readonly license?: string;
  readonly homepage?: string;
  readonly repository?: string;
  /** npm's deprecation message for the latest version, when there is one. */
  readonly deprecated?: string;
  /** True when the latest version is yanked (PyPI, crates.io). */
  readonly yanked?: boolean;
  readonly versions: readonly string[];
  readonly yankedVersions: readonly string[];
  /** Set when the registry answered without a version list at all. */
  readonly versionListUnavailable?: boolean;
};

export type PackageResult = ({ readonly ok: true } & PackageFacts) | RegistryFailure;

export type FetchOptions = {
  readonly signal?: AbortSignal;
  readonly maxBytes?: number;
  /**
   * Ask npm for the install-sized packument instead of the full one. It is
   * the document npm's own installer reads: dist-tags, the version list and
   * each version's deprecation, WITHOUT the per-release descriptions,
   * licences, repository links and publish dates. Right for an outdated
   * table over fifty packages; wrong for "tell me about this package".
   */
  readonly abbreviated?: boolean;
};

// ---------------------------------------------------------------------------
// reading unknown JSON without pretending to know its shape
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** npm and Cargo both allow `repository` to be a string or `{ url }`. */
function repositoryUrl(value: unknown): string | undefined {
  const direct = asString(value);
  if (direct !== undefined) return direct;
  const record = asRecord(value);
  return record === undefined ? undefined : asString(record["url"]);
}

/** npm allows `license` to be a string or the legacy `{ type }` object. */
function licenseOf(value: unknown): string | undefined {
  const direct = asString(value);
  if (direct !== undefined) return direct;
  const record = asRecord(value);
  return record === undefined ? undefined : asString(record["type"]);
}

// ---------------------------------------------------------------------------
// package facts
// ---------------------------------------------------------------------------

export async function fetchPackage(
  ecosystem: Ecosystem,
  rawName: string,
  options: FetchOptions = {},
): Promise<PackageResult> {
  const checked = checkName(ecosystem, rawName);
  if (!checked.ok) return { ok: false, kind: "invalidName", message: checked.message };
  const name = checked.name;
  const segment = nameForUrl(ecosystem, name);

  if (ecosystem === "npm") {
    const accept =
      options.abbreviated === true ? "application/vnd.npm.install-v1+json" : "application/json";
    const got = await getJson(`${REGISTRY_ORIGINS.npm}/${segment}`, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      accept,
    });
    if (!got.ok) return got;
    return readNpm(name, got.value);
  }

  if (ecosystem === "pypi") {
    const got = await getJson(`${REGISTRY_ORIGINS.pypi}/pypi/${segment}/json`, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    });
    if (!got.ok) return got;
    return readPypi(name, got.value);
  }

  const got = await getJson(`${REGISTRY_ORIGINS.crates}/api/v1/crates/${segment}`, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });
  if (!got.ok) return got;
  return readCrates(name, got.value);
}

function malformed(ecosystem: Ecosystem, detail: string): RegistryFailure {
  return { ok: false, kind: "malformed", message: `the ${ecosystem} response ${detail}` };
}

export function readNpm(name: string, body: unknown): PackageResult {
  const doc = asRecord(body);
  if (doc === undefined) return malformed("npm", "is not an object");
  const versionsDoc = asRecord(doc["versions"]) ?? {};
  const versions = Object.keys(versionsDoc);
  const distTags = asRecord(doc["dist-tags"]) ?? {};
  const latest = asString(distTags["latest"]);
  const latestDoc = latest === undefined ? undefined : asRecord(versionsDoc[latest]);
  const time = asRecord(doc["time"]) ?? {};

  // Deprecation is per VERSION on npm; a package is deprecated by deprecating
  // its versions. The question a caller asks is about the one they would
  // install, so that is the one reported.
  const deprecated = latestDoc === undefined ? undefined : asString(latestDoc["deprecated"]);
  const facts: PackageFacts = {
    ecosystem: "npm",
    name,
    ...(latest === undefined ? {} : { latest }),
    ...(latest === undefined ? {} : pick("latestPublishedAt", asString(time[latest]))),
    ...pick("description", asString(latestDoc?.["description"]) ?? asString(doc["description"])),
    ...pick("license", licenseOf(latestDoc?.["license"]) ?? licenseOf(doc["license"])),
    ...pick("homepage", asString(latestDoc?.["homepage"]) ?? asString(doc["homepage"])),
    ...pick(
      "repository",
      repositoryUrl(latestDoc?.["repository"]) ?? repositoryUrl(doc["repository"]),
    ),
    ...pick("deprecated", deprecated),
    versions,
    yankedVersions: [],
    ...(versions.length === 0 ? { versionListUnavailable: true } : {}),
  };
  return { ok: true, ...facts };
}

export function readPypi(name: string, body: unknown): PackageResult {
  const doc = asRecord(body);
  if (doc === undefined) return malformed("pypi", "is not an object");
  const info = asRecord(doc["info"]);
  if (info === undefined) return malformed("pypi", "carries no info object");
  const latest = asString(info["version"]);
  const releases = asRecord(doc["releases"]);

  const versions: string[] = [];
  const yankedVersions: string[] = [];
  let latestPublishedAt: string | undefined;
  if (releases !== undefined) {
    for (const [version, filesRaw] of Object.entries(releases)) {
      const files = asArray(filesRaw) ?? [];
      // A release with no files cannot be installed, and pip does not offer
      // it. Counting it as available would make `wanted` name a version no
      // install could produce.
      if (files.length === 0) continue;
      const allYanked = files.every((file) => asRecord(file)?.["yanked"] === true);
      if (allYanked) {
        yankedVersions.push(version);
        continue;
      }
      versions.push(version);
      if (version === latest) {
        const first = asRecord(files[0]);
        latestPublishedAt =
          asString(first?.["upload_time_iso_8601"]) ?? asString(first?.["upload_time"]);
      }
    }
  }

  const projectUrls = asRecord(info["project_urls"]) ?? {};
  const repository =
    asString(projectUrls["Source"]) ??
    asString(projectUrls["Source Code"]) ??
    asString(projectUrls["Repository"]) ??
    asString(projectUrls["Homepage"]);
  const facts: PackageFacts = {
    ecosystem: "pypi",
    name,
    ...(latest === undefined ? {} : { latest }),
    ...pick("latestPublishedAt", latestPublishedAt),
    ...pick("description", asString(info["summary"])),
    ...pick("license", asString(info["license"]) ?? licenseFromClassifiers(info["classifiers"])),
    ...pick("homepage", asString(info["home_page"]) ?? asString(projectUrls["Homepage"])),
    ...pick("repository", repository),
    ...(info["yanked"] === true ? { yanked: true } : {}),
    versions: versions.sort(byString),
    yankedVersions: yankedVersions.sort(byString),
    // PyPI has discussed dropping `releases` from this document more than
    // once. If it ever goes, everything except the version list still works,
    // and saying so beats reporting one version as the whole history.
    ...(releases === undefined ? { versionListUnavailable: true } : {}),
  };
  return { ok: true, ...facts };
}

/** `License :: OSI Approved :: MIT License` is where a licence hides when `license` is empty. */
function licenseFromClassifiers(value: unknown): string | undefined {
  const classifiers = asArray(value);
  if (classifiers === undefined) return undefined;
  for (const raw of classifiers) {
    const text = asString(raw);
    if (text?.startsWith("License :: ") === true) {
      const parts = text.split(" :: ");
      return parts[parts.length - 1];
    }
  }
  return undefined;
}

export function readCrates(name: string, body: unknown): PackageResult {
  const doc = asRecord(body);
  if (doc === undefined) return malformed("crates", "is not an object");
  const crate = asRecord(doc["crate"]);
  if (crate === undefined) return malformed("crates", "carries no crate object");
  const versionDocs = asArray(doc["versions"]) ?? [];
  const versions: string[] = [];
  const yankedVersions: string[] = [];
  let license: string | undefined;
  let latestPublishedAt: string | undefined;

  // crates.io reports three "latest" fields and they differ: max_version
  // includes prereleases, max_stable_version does not, and newest_version is
  // whatever was published last. A caller adding a dependency wants the
  // stable one.
  const latest =
    asString(crate["max_stable_version"]) ??
    asString(crate["max_version"]) ??
    asString(crate["newest_version"]);

  for (const raw of versionDocs) {
    const version = asRecord(raw);
    const num = asString(version?.["num"]);
    if (num === undefined) continue;
    if (version?.["yanked"] === true) {
      yankedVersions.push(num);
      continue;
    }
    versions.push(num);
    if (num === latest) {
      license = asString(version?.["license"]);
      latestPublishedAt = asString(version?.["created_at"]);
    }
  }

  const facts: PackageFacts = {
    ecosystem: "crates",
    name,
    ...(latest === undefined ? {} : { latest }),
    ...pick("latestPublishedAt", latestPublishedAt ?? asString(crate["updated_at"])),
    ...pick("description", asString(crate["description"])),
    ...pick("license", license),
    ...pick("homepage", asString(crate["homepage"]) ?? asString(crate["documentation"])),
    ...pick("repository", asString(crate["repository"])),
    ...(latest !== undefined && yankedVersions.includes(latest) ? { yanked: true } : {}),
    versions,
    yankedVersions,
    ...(versionDocs.length === 0 ? { versionListUnavailable: true } : {}),
  };
  return { ok: true, ...facts };
}

/** Include a key only when there is a value — an absent field is the signal. */
function pick<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

/** The same, for a count. */
function pickNumber<K extends string>(
  key: K,
  value: number | undefined,
): Partial<Record<K, number>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, number>);
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

export type SearchHit = {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly publishedAt?: string;
  readonly downloads?: number;
  readonly repository?: string;
  readonly homepage?: string;
};

export type SearchSort = "relevance" | "downloads" | "recentlyUpdated";

export type SearchOutcome =
  | {
      readonly ok: true;
      readonly hits: SearchHit[];
      readonly total?: number;
      /** False when the registry cannot sort the way the caller asked. */
      readonly sortApplied: boolean;
      readonly sortNote?: string;
    }
  | RegistryFailure;

/**
 * PyPI is the refusal case, and it is a real one: there is no public search
 * API. The XML-RPC `search` method was switched off in 2020 after abuse, the
 * JSON API has never had a search endpoint, and `pypi.org/search` is an HTML
 * page with no contract. Scraping it would put a tool that silently breaks on
 * a page redesign into the middle of dependency choices.
 */
export const PYPI_SEARCH_REFUSAL =
  "PyPI publishes no search API — the XML-RPC search was withdrawn and /search is an HTML page with no contract, so there is nothing to query here. Search elsewhere and come back with a name: RegistryPackageInfo answers for a name, and RegistryOutdated reads a whole manifest.";

export async function searchRegistry(
  ecosystem: Ecosystem,
  query: string,
  limit: number,
  sort: SearchSort,
  options: FetchOptions = {},
): Promise<SearchOutcome> {
  if (ecosystem === "pypi") {
    return { ok: false, kind: "unsupported", message: PYPI_SEARCH_REFUSAL };
  }
  const common = {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  };

  if (ecosystem === "npm") {
    const url = `${REGISTRY_ORIGINS.npm}/-/v1/search?text=${encodeURIComponent(query)}&size=${limit}`;
    const got = await getJson(url, common);
    if (!got.ok) return got;
    const doc = asRecord(got.value);
    const objects = asArray(doc?.["objects"]) ?? [];
    const hits: SearchHit[] = [];
    for (const raw of objects) {
      const pkg = asRecord(asRecord(raw)?.["package"]);
      const name = asString(pkg?.["name"]);
      if (name === undefined) continue;
      const links = asRecord(pkg?.["links"]) ?? {};
      hits.push({
        name,
        ...pick("version", asString(pkg?.["version"])),
        ...pick("description", asString(pkg?.["description"])),
        ...pick("publishedAt", asString(pkg?.["date"])),
        ...pick("repository", asString(links["repository"])),
        ...pick("homepage", asString(links["homepage"]) ?? asString(links["npm"])),
      });
    }
    // npm's search has no download count and no sort parameter — its ranking
    // mixes quality, popularity and maintenance into one score. Re-sorting
    // the page we were handed would produce a ranking of 20 packages and
    // present it as a ranking of the registry.
    return {
      ok: true,
      hits,
      ...pickNumber("total", asNumber(doc?.["total"])),
      sortApplied: sort === "relevance",
      ...(sort === "relevance"
        ? {}
        : {
            sortNote: `npm's search endpoint ranks by its own relevance score and publishes no download counts, so "${sort}" was not applied — these are the top ${limit} by relevance`,
          }),
    };
  }

  const sortParam =
    sort === "downloads"
      ? "downloads"
      : sort === "recentlyUpdated"
        ? "recent-updates"
        : "relevance";
  const url = `${REGISTRY_ORIGINS.crates}/api/v1/crates?q=${encodeURIComponent(query)}&per_page=${limit}&sort=${sortParam}`;
  const got = await getJson(url, common);
  if (!got.ok) return got;
  const doc = asRecord(got.value);
  const crates = asArray(doc?.["crates"]) ?? [];
  const hits: SearchHit[] = [];
  for (const raw of crates) {
    const crate = asRecord(raw);
    const name = asString(crate?.["name"]);
    if (name === undefined) continue;
    hits.push({
      name,
      ...pick(
        "version",
        asString(crate?.["max_stable_version"]) ?? asString(crate?.["max_version"]),
      ),
      ...pick("description", asString(crate?.["description"])),
      ...pick("publishedAt", asString(crate?.["updated_at"])),
      ...pickNumber("downloads", asNumber(crate?.["downloads"])),
      ...pick("repository", asString(crate?.["repository"])),
      ...pick("homepage", asString(crate?.["homepage"]) ?? asString(crate?.["documentation"])),
    });
  }
  const meta = asRecord(doc?.["meta"]);
  return { ok: true, hits, ...pickNumber("total", asNumber(meta?.["total"])), sortApplied: true };
}
