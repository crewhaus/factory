/**
 * OSV, shaped — everything about the vulnerability database that is pure.
 *
 * The HTTP lives in `../net.ts`; this file turns coordinates into request
 * bodies and responses into records, so the awkward parts can be tested
 * without a socket.
 *
 * ONE THING TO BE PRECISE ABOUT, because it is the whole honesty of the tool:
 * OSV answers "is this version inside a range some advisory declares
 * affected". It does not answer "is this project exploitable". The vulnerable
 * function may never be called, the vulnerable code path may be behind a flag
 * that is off, the package may be a build-time dependency that never ships.
 * Nothing in this file can tell the difference, so nothing in this file is
 * named as though it could: the field is `versionInAffectedRange`, the count
 * is `advisoriesMatchingLockedVersions`, and `reachabilityAnalyzed` is
 * reported as `false` rather than left out.
 */
import { type LockEcosystem, type SemVer, compareSemver, parseSemver } from "@crewhaus/tool-code";
import { type CvssRating, parseCvss } from "./cvss";

/**
 * The name OSV knows an ecosystem by.
 *
 * `cargo` is `crates.io` there, and getting this wrong does not fail — it
 * returns an empty result set, which reads exactly like "nothing known about
 * these packages". That failure mode is why the mapping is a function with a
 * test rather than a string built at the call site.
 */
export function osvEcosystem(ecosystem: LockEcosystem): string {
  return ecosystem === "cargo" ? "crates.io" : "npm";
}

export type Coordinate = {
  readonly ecosystem: LockEcosystem;
  readonly name: string;
  readonly version: string;
  /** The lockfile the coordinate was read from. */
  readonly source: string;
};

export type BatchQuery = {
  readonly package: { readonly name: string; readonly ecosystem: string };
  readonly version: string;
};

/** The body `POST /v1/querybatch` takes: one query per coordinate, in order. */
export function buildQueryBatch(coordinates: ReadonlyArray<Coordinate>): {
  queries: BatchQuery[];
} {
  return {
    queries: coordinates.map((c) => ({
      package: { name: c.name, ecosystem: osvEcosystem(c.ecosystem) },
      version: c.version,
    })),
  };
}

/** Split a list into fixed-size chunks, so one request cannot be unbounded. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error(`chunk size must be at least 1, got ${size}`);
  const out: T[][] = [];
  for (let n = 0; n < items.length; n += size) out.push(items.slice(n, n + size));
  return out;
}

export type BatchHit = {
  readonly coordinate: Coordinate;
  readonly ids: ReadonlyArray<string>;
  /** OSV paginates a result with more than a thousand vulnerabilities. */
  readonly morePages: boolean;
};

export type BatchParse =
  | { readonly ok: true; readonly hits: ReadonlyArray<BatchHit> }
  | { readonly ok: false; readonly reason: string };

/**
 * Read a `querybatch` response against the coordinates that produced it.
 *
 * The alignment is POSITIONAL — `results[i]` belongs to `queries[i]` and
 * carries no package name of its own — so a response whose length does not
 * match is refused outright. Trusting a short array would silently attribute
 * one package's advisories to another, and a supply-chain report that names
 * the wrong package is worse than one that fails.
 */
export function parseQueryBatchResponse(
  body: unknown,
  coordinates: ReadonlyArray<Coordinate>,
): BatchParse {
  if (typeof body !== "object" || body === null) {
    return { ok: false, reason: "OSV returned something that is not a JSON object" };
  }
  const results = (body as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    return { ok: false, reason: "OSV response has no `results` array" };
  }
  if (results.length !== coordinates.length) {
    return {
      ok: false,
      reason: `OSV returned ${results.length} results for ${coordinates.length} queries; results are matched to queries by position, so a mismatched response cannot be attributed to packages safely`,
    };
  }
  const hits: BatchHit[] = [];
  for (let n = 0; n < results.length; n += 1) {
    const entry = results[n];
    const coordinate = coordinates[n] as Coordinate;
    if (typeof entry !== "object" || entry === null) continue;
    const vulns = (entry as { vulns?: unknown }).vulns;
    if (!Array.isArray(vulns) || vulns.length === 0) continue;
    const ids = vulns
      .map((v) => (typeof v === "object" && v !== null ? (v as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === "string" && id !== "");
    if (ids.length === 0) continue;
    hits.push({
      coordinate,
      ids,
      morePages: typeof (entry as { next_page_token?: unknown }).next_page_token === "string",
    });
  }
  return { ok: true, hits };
}

// ---------------------------------------------------------------------------
// the full record

export type OsvSeverity = {
  /** The label the source database assigned, when it assigned one. */
  readonly label?: string;
  readonly cvssVector?: string;
  readonly cvssVersion?: string;
  readonly baseScore?: number;
  readonly rating?: CvssRating;
  /** Why there is no score, when a vector was present but not computable. */
  readonly scoreNote?: string;
};

export type OsvAdvisory = {
  readonly id: string;
  readonly aliases: ReadonlyArray<string>;
  readonly summary?: string;
  readonly severity: OsvSeverity;
  /** Set when the advisory has been withdrawn — a match on it is stale. */
  readonly withdrawn?: string;
  /** The `affected` array verbatim, for `affectedFor` to read. */
  readonly affected: ReadonlyArray<unknown>;
};

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** Read one `/v1/vulns/{id}` record, keeping only what a report needs. */
export function parseVulnRecord(body: unknown): OsvAdvisory | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const raw = body as Record<string, unknown>;
  const id = str(raw["id"]);
  if (id === undefined) return undefined;
  const aliases = Array.isArray(raw["aliases"])
    ? (raw["aliases"] as unknown[]).filter((a): a is string => typeof a === "string")
    : [];
  const affected = Array.isArray(raw["affected"]) ? (raw["affected"] as unknown[]) : [];
  return {
    id,
    aliases,
    ...(str(raw["summary"]) === undefined ? {} : { summary: str(raw["summary"]) as string }),
    severity: readSeverity(raw, affected),
    ...(str(raw["withdrawn"]) === undefined ? {} : { withdrawn: str(raw["withdrawn"]) as string }),
    affected,
  };
}

/**
 * The severity, from the several places OSV records put it.
 *
 * A vector is preferred over a label because it carries a number, and a
 * number is what an ordering needs. The label is kept alongside rather than
 * instead: GitHub's `MODERATE` and a computed 6.1 are two different claims
 * from two different sources, and collapsing them would invent agreement.
 */
function readSeverity(raw: Record<string, unknown>, affected: ReadonlyArray<unknown>): OsvSeverity {
  const label =
    readDatabaseSeverity(raw["database_specific"]) ??
    affected
      .map((entry) =>
        typeof entry === "object" && entry !== null
          ? readDatabaseSeverity((entry as Record<string, unknown>)["database_specific"])
          : undefined,
      )
      .find((value) => value !== undefined);

  const entries = Array.isArray(raw["severity"]) ? (raw["severity"] as unknown[]) : [];
  const vectors: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const score = str((entry as Record<string, unknown>)["score"]);
    if (score !== undefined) vectors.push(score);
  }
  for (const vector of vectors) {
    const parsed = parseCvss(vector);
    if (parsed.baseScore !== undefined) {
      return {
        ...(label === undefined ? {} : { label }),
        cvssVector: vector,
        cvssVersion: parsed.version,
        baseScore: parsed.baseScore,
        ...(parsed.rating === undefined ? {} : { rating: parsed.rating }),
      };
    }
  }
  const first = vectors[0];
  if (first !== undefined) {
    const parsed = parseCvss(first);
    return {
      ...(label === undefined ? {} : { label }),
      cvssVector: first,
      cvssVersion: parsed.version,
      ...(parsed.note === undefined ? {} : { scoreNote: parsed.note }),
    };
  }
  return label === undefined ? {} : { label };
}

function readDatabaseSeverity(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return str((value as Record<string, unknown>)["severity"]);
}

// ---------------------------------------------------------------------------
// which range matched, and what fixes it

export type AffectedInterval = {
  readonly rangeType: string;
  readonly introduced: string;
  readonly fixed?: string;
  readonly lastAffected?: string;
  /** `undefined` when the versions in this range could not be ordered. */
  readonly containsVersion: boolean | undefined;
};

export type AffectedSummary = {
  /** The advisory listed this exact version in an explicit `versions` array. */
  readonly matchedByVersionList: boolean;
  readonly intervals: ReadonlyArray<AffectedInterval>;
  /** The interval the locked version falls in, rendered for a human. */
  readonly affectedRange?: string;
  /**
   * The fix for THE interval the version falls in. Absent whenever that
   * interval could not be identified — every `fixed` seen is still reported
   * under `fixedVersionsReported`, because "one of these" is a true statement
   * and "upgrade to 1.2.3" would not be.
   */
  readonly fixedVersion?: string;
  readonly fixedVersionsReported: ReadonlyArray<string>;
  /** Range types this file does not order, e.g. GIT (commit SHAs). */
  readonly unevaluatedRangeTypes: ReadonlyArray<string>;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Render an interval the way an advisory page writes one. */
export function describeInterval(interval: AffectedInterval): string {
  const from = interval.introduced === "0" ? "all versions" : `>= ${interval.introduced}`;
  if (interval.fixed !== undefined) return `${from}, < ${interval.fixed}`;
  if (interval.lastAffected !== undefined) return `${from}, <= ${interval.lastAffected}`;
  return `${from} (no fix recorded)`;
}

/**
 * What this advisory says about one (ecosystem, name, version).
 *
 * The version test is done again here even though OSV already matched it
 * server-side, for one reason: the batch endpoint returns ids and nothing
 * else, so the range a version fell into — and therefore which `fixed` is
 * THE fix — is not in the answer and has to be recovered from the record.
 * Where it cannot be recovered the summary says so instead of picking one.
 */
export function affectedFor(
  advisory: OsvAdvisory,
  ecosystem: LockEcosystem,
  name: string,
  version: string,
): AffectedSummary {
  const wanted = osvEcosystem(ecosystem);
  const intervals: AffectedInterval[] = [];
  const fixedSeen: string[] = [];
  const unevaluated = new Set<string>();
  let matchedByVersionList = false;

  for (const entry of advisory.affected) {
    const affected = asRecord(entry);
    if (affected === undefined) continue;
    const pkg = asRecord(affected["package"]);
    if (pkg === undefined) continue;
    if (str(pkg["ecosystem"]) !== wanted) continue;
    if (str(pkg["name"]) !== name) continue;

    const listed = affected["versions"];
    if (Array.isArray(listed) && listed.includes(version)) matchedByVersionList = true;

    const ranges = Array.isArray(affected["ranges"]) ? (affected["ranges"] as unknown[]) : [];
    for (const rangeRaw of ranges) {
      const range = asRecord(rangeRaw);
      if (range === undefined) continue;
      const type = str(range["type"]) ?? "UNSPECIFIED";
      const events = Array.isArray(range["events"]) ? (range["events"] as unknown[]) : [];
      // A GIT range is a pair of commit hashes. Nothing in a version number
      // orders against a commit, so these are reported as unevaluated rather
      // than compared with a semver that would silently always answer false.
      const orderable = type === "SEMVER" || type === "ECOSYSTEM";
      if (!orderable) unevaluated.add(type);
      const built = buildIntervals(type, events, orderable ? version : undefined);
      for (const interval of built) {
        intervals.push(interval);
        // Only a version-ordered range contributes a VERSION to upgrade to. A
        // GIT range's `fixed` is a commit hash, and listing it beside "1.2.0"
        // under a field named `fixedVersionsReported` would read as a release.
        if (orderable && interval.fixed !== undefined && !fixedSeen.includes(interval.fixed)) {
          fixedSeen.push(interval.fixed);
        }
      }
      if (orderable && built.some((i) => i.containsVersion === undefined)) unevaluated.add(type);
    }
  }

  const containing = intervals.find((i) => i.containsVersion === true);
  return {
    matchedByVersionList,
    intervals,
    ...(containing === undefined ? {} : { affectedRange: describeInterval(containing) }),
    ...(containing?.fixed === undefined ? {} : { fixedVersion: containing.fixed }),
    fixedVersionsReported: fixedSeen,
    unevaluatedRangeTypes: [...unevaluated].sort(),
  };
}

type Event = { kind: "introduced" | "fixed" | "last_affected" | "limit"; value: string };

/**
 * Turn an OSV event list into closed intervals.
 *
 * The events are supposed to arrive sorted, and are re-sorted here anyway: a
 * record that arrives out of order would otherwise produce an interval that
 * starts after it ends, which reads as "not affected" — the wrong direction
 * to be wrong in. `introduced` sorts before `fixed` at the same version so a
 * zero-width interval stays zero-width.
 */
function buildIntervals(
  type: string,
  rawEvents: ReadonlyArray<unknown>,
  version: string | undefined,
): AffectedInterval[] {
  const events: Event[] = [];
  for (const raw of rawEvents) {
    const event = asRecord(raw);
    if (event === undefined) continue;
    for (const kind of ["introduced", "fixed", "last_affected", "limit"] as const) {
      const value = str(event[kind]);
      if (value !== undefined) events.push({ kind, value });
    }
  }
  if (events.length === 0) return [];

  const target = version === undefined ? undefined : parseSemver(version);
  const parsed = new Map<string, SemVer | undefined>();
  const semverOf = (value: string): SemVer | undefined => {
    if (!parsed.has(value)) parsed.set(value, value === "0" ? ZERO : parseSemver(value));
    return parsed.get(value);
  };
  const ordered = [...events].sort((a, b) => {
    const av = semverOf(a.value);
    const bv = semverOf(b.value);
    if (av === undefined || bv === undefined) return 0;
    return compareSemver(av, bv) || rank(a.kind) - rank(b.kind);
  });

  const out: AffectedInterval[] = [];
  let open: string | undefined;
  for (const event of ordered) {
    if (event.kind === "introduced") {
      if (open !== undefined) out.push(close(type, open, undefined, undefined, target, semverOf));
      open = event.value;
      continue;
    }
    if (event.kind === "limit") continue;
    const start = open ?? "0";
    out.push(
      close(
        type,
        start,
        event.kind === "fixed" ? event.value : undefined,
        event.kind === "last_affected" ? event.value : undefined,
        target,
        semverOf,
      ),
    );
    open = undefined;
  }
  if (open !== undefined) out.push(close(type, open, undefined, undefined, target, semverOf));
  return out;
}

const ZERO: SemVer = { major: 0, minor: 0, patch: 0, prerelease: "" };

const rank = (kind: Event["kind"]): number =>
  kind === "introduced" ? 0 : kind === "limit" ? 1 : 2;

function close(
  rangeType: string,
  introduced: string,
  fixed: string | undefined,
  lastAffected: string | undefined,
  target: SemVer | undefined,
  semverOf: (value: string) => SemVer | undefined,
): AffectedInterval {
  let contains: boolean | undefined;
  const from = semverOf(introduced);
  if (target !== undefined && from !== undefined) {
    contains = compareSemver(target, from) >= 0;
    if (contains && fixed !== undefined) {
      const to = semverOf(fixed);
      contains = to === undefined ? undefined : compareSemver(target, to) < 0;
    } else if (contains && lastAffected !== undefined) {
      const to = semverOf(lastAffected);
      contains = to === undefined ? undefined : compareSemver(target, to) <= 0;
    }
  }
  return {
    rangeType,
    introduced,
    ...(fixed === undefined ? {} : { fixed }),
    ...(lastAffected === undefined ? {} : { lastAffected }),
    containsVersion: contains,
  };
}
