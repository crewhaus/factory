/**
 * v0.3.0 Goal 2 — `wiki-store` (design §3.1, PR 9).
 *
 * The update-in-place SEMANTIC memory tier — what the append-only
 * memory-store deliberately cannot be. Human-readable markdown articles
 * under `.crewhaus/wiki/<specName>/`:
 *
 *   articles/<slug>.md     — YAML frontmatter + markdown body (the live
 *                            version of each article)
 *   versions/<slug>/<n>.md — immutable prior versions: every edit copies
 *                            the outgoing file here FIRST (supersede,
 *                            never delete — Theanine)
 *   index.json             — slug → {title, tags, confidence, verified,
 *                            version, updatedAt, links[], status} — a
 *                            derived cache, always rebuildable from the
 *                            articles (crash-safe by construction)
 *   .lock                  — advisory single-writer lock (see lock.ts;
 *                            wait 2s → steal >30s stale → fail with pid)
 *
 * ## Optimistic concurrency (the Thredz PATCH contract)
 *
 * `write()` is an upsert by slug. When the slug already exists the caller
 * MUST pass `expectedVersion` equal to the article's current version; a
 * mismatch (or an omitted version on an existing article) throws
 * `WikiVersionConflictError` carrying the literal code
 * `stale_article_version` — the same contract as Thredz's PATCH
 * (409 stale_article_version), so skills behave identically on the local
 * and Thredz backends: re-read with `get`, then re-apply the edit.
 *
 * ## Retrieval (design §3.1 — the evidence base's strongest lever)
 *
 * Hybrid BM25 + embedding recall with reciprocal-rank fusion (RRF, k=60 —
 * the same math as memory-store's PR-6 hybrid recall), over CONTEXTUAL
 * chunks: the indexed text of every article is its body prefixed with a
 * `title` + `[tags: …]` header, per the contextual-retrieval evidence.
 * Without an `embedder` the primary ranking is BM25-only (offline
 * default); with one (use `mock/…` from @crewhaus/embedder for tests) the
 * primary ranking fuses BM25 and cosine-similarity ranks.
 *
 * ### One-hop link expansion + the re-rank rule
 *
 * After the primary ranking, `recall()` takes the top-k seeds, pulls every
 * article that shares an `index.json` link edge with a seed (EITHER
 * direction — [[wikilink]] out-links are indexed, so in-links are the
 * reverse lookup), and re-ranks the union. THE RE-RANK RULE:
 *
 *   1. every candidate in the primary ranking keeps its reciprocal-rank
 *      vote — rank i contributes 1/(60+i);
 *   2. every one-hop neighbor of a seed additionally receives a
 *      HALF-WEIGHT link vote, 0.5/(60 + bestSeedRank), where bestSeedRank
 *      is the rank of the best-ranked seed it shares an edge with;
 *   3. votes sum per article; sort descending, ties broken by slug; the
 *      top k win.
 *
 * Half weight is the load-bearing choice: a link is corroboration, not a
 * match, so a linked-but-lexically-unrelated neighbor can never displace
 * the seed that pulled it in (0.5/(60+r) < 1/(60+r)) nor any primary
 * match ranked at or above its seed — but it DOES surface whenever the
 * query yields fewer than k solid matches, which is exactly the failure
 * mode one-hop expansion exists to fix. Deterministic, pinned by test.
 *
 * ## Signals vs content
 *
 * `setSignals()` (verified / confidence) is a metadata-only mutation: it
 * does NOT bump the version and does NOT snapshot (the body is untouched)
 * — mirroring Thredz's separate signals endpoint. A content `write()`, by
 * contrast, RESETS `verified` to false: the new version is a new claim
 * that has not been fact-checked yet (re-verify via `setSignals`).
 *
 * ## Tenant fencing
 *
 * Same fail-closed path rules session-store enforces (CWE-1230): with a
 * tenant context active (ambient `withTenant` or the explicit `tenant`
 * option), any resolved path outside the tenant's root throws before any
 * IO happens. The default root under a tenant is `<tenantRoot>/wiki`.
 */
import { lstatSync, realpathSync, unlinkSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import { type Tenant, assertSamePath, currentTenantContext } from "@crewhaus/tenancy";
import { openForRead, writeFileSafe } from "@crewhaus/tool-safety/fs";
import YAML from "yaml";
import { type AcquireLockOptions, withLock } from "./lock";

export {
  type AcquireLockOptions,
  type LockHandle,
  type LockPolicy,
  DEFAULT_LOCK_POLICY,
  WikiLockError,
  acquireLock,
  withLock,
} from "./lock";

export const DEFAULT_ROOT_DIR = ".crewhaus/wiki";

/** The Thredz-parity conflict code carried by `WikiVersionConflictError`. */
export const STALE_ARTICLE_VERSION = "stale_article_version";

/** Reciprocal-rank-fusion constant (the standard k=60, matching memory-store). */
const RRF_K = 60;

const SPEC_NAME_REGEX = /^[a-zA-Z0-9_\-.]+$/;
/** Slugs are kebab-case AND double as file names — fail-closed on anything
 *  that could traverse (`..`, `/`, uppercase, spaces). */
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,127}$/;

/**
 * Whether `value` is a wiki slug: kebab-case, 1–128 characters. Every slug
 * the store returns is one; a caller that prints a slug outside a classified
 * unit (tool-wiki's redaction notice) checks it again.
 */
export function isWikiSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG_REGEX.test(value);
}

/**
 * What an article's `createdAt` / `updatedAt` reads as when the file holds
 * no timestamp the store can read. It is printed as it stands
 * (`updated: unknown`), sorts after every real timestamp in `list()`, and
 * `Date.parse` gives `NaN` for it, so nothing downstream takes it for a date.
 */
export const UNKNOWN_TIMESTAMP = "unknown";

/** A calendar date: ECMAScript reads a date-only form as UTC midnight. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * A date-time as `Date#toISOString` writes it, or as RFC 3339 and ISO 8601
 * allow it by hand: a `T`, `t` or space between date (group 1) and time
 * (group 2), a `.` or `,` before the fraction, and an offset that is `Z`,
 * `±hh:mm`, `±hhmm` or `±hh` (groups 3–6), or none. Linear: no quantifier is
 * nested or overlapping.
 */
const DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}(?::\d{2}(?:[.,]\d{1,9})?)?)(?:([Zz])|([+-])(\d{2})(?::?(\d{2}))?)?$/;

/**
 * `value` as an ISO-8601 timestamp, or {@link UNKNOWN_TIMESTAMP}. A timestamp
 * is printed in list rows and sorted on, and a file on disk (which any agent
 * with a write tool can edit) could put any text there, so only a timestamp
 * is kept, written the one way `Date.parse` reads the same everywhere: `T`,
 * `.`, and `Z` or `±hh:mm`. A date-time without an offset is read as UTC — a
 * `Z` is appended — never as the host's local time, which is what
 * `Date.parse` would do with it. The result is its own normal form.
 */
function isoTimestampOr(value: unknown): string {
  if (typeof value !== "string") return UNKNOWN_TIMESTAMP;
  let iso: string | undefined;
  if (ISO_DATE.test(value)) iso = value;
  else {
    const m = value.match(DATE_TIME);
    if (m !== null) {
      const [, date, time, z, sign, hh, mm] = m;
      const zone = z !== undefined || sign === undefined ? "Z" : `${sign}${hh}:${mm ?? "00"}`;
      iso = `${date}T${(time ?? "").replace(",", ".")}${zone}`;
    }
  }
  return iso !== undefined && !Number.isNaN(Date.parse(iso)) ? iso : UNKNOWN_TIMESTAMP;
}

/** A timestamp's instant for sorting, or `undefined` when it is not known. */
function instantOf(timestamp: string): number | undefined {
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? undefined : ms;
}

const WIKILINK_REGEX = /\[\[([^\]]+)\]\]/g;
/**
 * The most of one article file the store reads or writes. Reads are capped
 * before anything is buffered; a write past it is refused, so the store
 * never writes an article it would then refuse to read.
 */
export const ARTICLE_MAX_BYTES = 16 * 1024 * 1024;
/** index.json is a derived cache: past this it is rebuilt from the articles instead of read. */
const INDEX_MAX_BYTES = 64 * 1024 * 1024;

export class WikiStoreError extends CrewhausError {
  override readonly name: string = "WikiStoreError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/**
 * Optimistic-concurrency conflict — the local twin of Thredz's HTTP 409
 * `stale_article_version`. `conflictCode` is the machine-checkable code
 * (CrewhausError's own `code` is the coarse family union); the message also
 * carries the literal so string-matching callers behave like Thredz ones.
 */
export class WikiVersionConflictError extends CrewhausError {
  override readonly name = "WikiVersionConflictError";
  readonly conflictCode = STALE_ARTICLE_VERSION;
  readonly slug: string;
  readonly expectedVersion: number | undefined;
  readonly currentVersion: number | undefined;
  constructor(
    slug: string,
    expectedVersion: number | undefined,
    currentVersion: number | undefined,
  ) {
    super(
      "runtime",
      currentVersion === undefined
        ? `${STALE_ARTICLE_VERSION}: no article "${slug}" exists (expected version ${expectedVersion}) — omit expectedVersion (or pass 0) to create it`
        : `${STALE_ARTICLE_VERSION}: article "${slug}" is at version ${currentVersion}, not ${expectedVersion ?? "(none passed)"} — re-read it with get(), then re-apply your edit`,
    );
    this.slug = slug;
    this.expectedVersion = expectedVersion;
    this.currentVersion = currentVersion;
  }
}

export type WikiArticleStatus = "draft" | "published" | "review" | "archived";

const ARTICLE_STATUSES: ReadonlyArray<WikiArticleStatus> = [
  "draft",
  "published",
  "review",
  "archived",
];

/** Who wrote this VERSION of the article (prior writers live in versions/). */
export type WikiCreatedBy = {
  readonly sessionId: string;
  /** `formatAgentIdentity()`-style string, when a sub-agent/role wrote it. */
  readonly agentIdentity?: string;
};

/** The YAML frontmatter of an article file (design §3.1). */
export type WikiFrontmatter = {
  readonly slug: string;
  readonly title: string;
  readonly tags: readonly string[];
  /** 0–1 confidence in the knowledge. */
  readonly confidence: number;
  /** Fact-checked against a primary source (set via `setSignals`; RESET to
   *  false by every content `write` — a new version is a new claim). */
  readonly verified: boolean;
  /** 1-based, bumped on every content write. */
  readonly version: number;
  readonly sources: readonly string[];
  /** The version number this one superseded (absent on version 1). */
  readonly supersedes?: number;
  readonly createdBy?: WikiCreatedBy;
  readonly status: WikiArticleStatus;
  /** ISO-8601, or {@link UNKNOWN_TIMESTAMP} when the file holds none. */
  readonly createdAt: string;
  /** ISO-8601, or {@link UNKNOWN_TIMESTAMP} when the file holds none. */
  readonly updatedAt: string;
};

export type WikiArticle = WikiFrontmatter & { readonly body: string };

/** One `index.json` entry, plus its slug — the list/search/related unit. */
export type WikiRef = {
  readonly slug: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly confidence: number;
  readonly verified: boolean;
  readonly version: number;
  /** ISO-8601, or {@link UNKNOWN_TIMESTAMP} when the article holds none. */
  readonly updatedAt: string;
  /** Out-links extracted from `[[wikilinks]]` in the body (normalized slugs). */
  readonly links: readonly string[];
  readonly status: WikiArticleStatus;
};

export type WikiHit = {
  readonly ref: WikiRef;
  /** The fused re-rank score (RRF vote sum — see the re-rank rule above). */
  readonly score: number;
  readonly body: string;
  /** `"match"` = positive primary (lexical/semantic) score; `"link"` =
   *  surfaced purely by one-hop link expansion. */
  readonly via: "match" | "link";
};

export type WikiWrite = {
  readonly slug: string;
  readonly title: string;
  readonly body: string;
  readonly tags?: readonly string[];
  /** 0–1. Create default 0.5; omitted on update = keep the prior value. */
  readonly confidence?: number;
  readonly sources?: readonly string[];
  /** Create default "published"; omitted on update = keep the prior value. */
  readonly status?: WikiArticleStatus;
  /**
   * Optimistic concurrency (the Thredz PATCH contract): REQUIRED and equal
   * to the current version when the slug exists; omit (or pass 0) to
   * create. Mismatch → `WikiVersionConflictError` (`stale_article_version`).
   */
  readonly expectedVersion?: number;
  readonly createdBy?: WikiCreatedBy;
};

export type WikiListOptions = {
  /** Sort updatedAt ASCENDING (stalest first — the REFLECT pass order).
   *  Default false = updatedAt descending. */
  readonly staleFirst?: boolean;
  /** Keep only articles carrying EVERY listed tag. */
  readonly tags?: readonly string[];
  /** Keep only articles with this status ("all" = no filter, the default). */
  readonly status?: WikiArticleStatus | "all";
};

export type WikiSignals = {
  readonly verified?: boolean;
  readonly confidence?: number;
};

export type WikiStats = {
  readonly articles: number;
  readonly byStatus: Readonly<Record<WikiArticleStatus, number>>;
  /** Immutable snapshots under versions/ (supersede-never-delete depth). */
  readonly priorVersions: number;
  readonly uniqueTags: number;
  readonly verified: number;
  /** Mean confidence across articles (0 when the wiki is empty). */
  readonly averageConfidence: number;
  /** Total out-link edges in the index. */
  readonly links: number;
};

export type WikiRelatedRef = WikiRef & {
  /** tag overlap + link adjacency (+ cosine similarity with an embedder). */
  readonly relatedScore: number;
};

/**
 * Minimal structural interface for the hybrid-recall embedder — the same
 * shape memory-store uses. `@crewhaus/embedder`'s `Embedder` satisfies it
 * (use `createEmbedder({ model: "mock/deterministic" })` offline).
 */
export interface WikiEmbedder {
  embed(texts: ReadonlyArray<string>): Promise<number[][]>;
  /** `@crewhaus/embedder`'s provider id. Only `"mock"` is known to stay in
   *  the process; see {@link embedderLeavesProcess}. */
  readonly provider?: string;
}

/**
 * Whether calling this embedder sends text out of the process — the rule
 * `@crewhaus/memory-store` applies, kept identical here (memory-service's
 * wiring test holds the two stores to the same answer). Only
 * `@crewhaus/embedder`'s `mock` provider is known not to; an embedder that
 * does not say what it is counts as one that does.
 */
export function embedderLeavesProcess(embedder: WikiEmbedder | undefined): boolean {
  return embedder !== undefined && embedder.provider !== "mock";
}

/** The design-§3.1 interface, verbatim (recall/search/get/write/list/related/setSignals/stats). */
export interface WikiStore {
  /** Hybrid-ranked top-k WITH bodies (the recall-before-act bundle), after
   *  one-hop link expansion. Archived articles are excluded. */
  recall(query: string, k?: number): Promise<readonly WikiHit[]>;
  /** Keyword/full-text (BM25) refs, best first. No expansion, no embedder —
   *  exact terms, names, numbers. Archived articles are excluded. */
  search(query: string): Promise<readonly WikiRef[]>;
  get(slug: string): Promise<WikiArticle | null>;
  /** Upsert by slug with the optimistic version check (see `WikiWrite`).
   *  Every edit snapshots the prior file into versions/ FIRST. */
  write(input: WikiWrite): Promise<{ slug: string; version: number }>;
  list(opts?: WikiListOptions): Promise<readonly WikiRef[]>;
  /** Tag overlap + link adjacency (+ embedding similarity when available). */
  related(slug: string): Promise<readonly WikiRelatedRef[]>;
  /** Metadata-only quality signals — no version bump, no snapshot. */
  setSignals(slug: string, signals: WikiSignals): Promise<void>;
  stats(): Promise<WikiStats>;
  /**
   * Cosine-similarity-only ranking (a `minScore` floor, default 0.05) —
   * present ONLY when the store was constructed with an `embedder`. This is
   * the one member beyond the designed eight: the thredz-parity
   * `wiki_semantic_search` tool needs a pure semantic ranking with a
   * similarity floor, which the fused `recall` score cannot express.
   * Without an embedder the tool degrades to keyword search (the same
   * degradation Thredz applies on keyword-only plans).
   */
  semanticSearch?(query: string, k?: number, minScore?: number): Promise<readonly WikiHit[]>;
  /** Diagnostic: where on disk this store lives. */
  path(): string;
  /**
   * True when `recall`, `related` and `semanticSearch` send the query and
   * article text to an embedder outside the process (see
   * {@link embedderLeavesProcess}). `@crewhaus/tool-wiki` reads it to flag
   * those tools as network tools. Optional so another backend still
   * type-checks; tool-wiki then decides from `semanticSearch`'s presence.
   */
  readonly embedderLeavesProcess?: boolean;
}

export type WikiStoreOptions = {
  readonly specName: string;
  /** Default `.crewhaus/wiki` (or `<tenantRoot>/wiki` under a tenant). */
  readonly rootDir?: string;
  readonly now?: () => Date;
  /** Enables the hybrid (BM25 + embedding RRF) primary ranking and
   *  `semanticSearch`. Absent → BM25-only primary ranking. */
  readonly embedder?: WikiEmbedder;
  /** Explicit tenant to fence against (in addition to any ambient
   *  `withTenant` context, which is always honored). */
  readonly tenant?: Tenant;
  /** Lock policy overrides + warning sink (lock steals, §7.6). */
  readonly lock?: AcquireLockOptions;
};

// ---------------------------------------------------------------------------
// frontmatter + wikilinks
// ---------------------------------------------------------------------------

/** Extract `[[wikilink]]` targets from a body, normalized to slugs:
 *  `[[Some Page|label]]` → `some-page`. Invalid targets and duplicates are
 *  dropped; `self` (when given) is excluded. Exported for tests. */
export function extractWikilinks(body: string, self?: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(WIKILINK_REGEX)) {
    const inner = match[1] ?? "";
    const target = (inner.split("|")[0] ?? "").trim().toLowerCase().replace(/\s+/g, "-");
    if (!SLUG_REGEX.test(target)) continue;
    if (target === self) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
}

/** Serialize an article to `---\n<yaml>\n---\n\n<body>\n`. Exported for tests. */
export function serializeArticle(article: WikiArticle): string {
  const { body, ...frontmatter } = article;
  const fm: Record<string, unknown> = {
    slug: frontmatter.slug,
    title: frontmatter.title,
    tags: [...frontmatter.tags],
    confidence: frontmatter.confidence,
    verified: frontmatter.verified,
    version: frontmatter.version,
    sources: [...frontmatter.sources],
    ...(frontmatter.supersedes !== undefined ? { supersedes: frontmatter.supersedes } : {}),
    ...(frontmatter.createdBy !== undefined
      ? {
          createdBy: {
            sessionId: frontmatter.createdBy.sessionId,
            ...(frontmatter.createdBy.agentIdentity !== undefined
              ? { agentIdentity: frontmatter.createdBy.agentIdentity }
              : {}),
          },
        }
      : {}),
    status: frontmatter.status,
    createdAt: frontmatter.createdAt,
    updatedAt: frontmatter.updatedAt,
  };
  const yamlText = YAML.stringify(fm).trimEnd();
  return `---\n${yamlText}\n---\n\n${body.replace(/\s+$/, "")}\n`;
}

/** Parse an article file. Throws `WikiStoreError` on a malformed file. */
export function parseArticle(raw: string): WikiArticle {
  if (!raw.startsWith("---\n")) {
    throw new WikiStoreError("article file is missing its YAML frontmatter block");
  }
  const end = raw.indexOf("\n---", 4);
  if (end === -1) {
    throw new WikiStoreError("article frontmatter block is unterminated (no closing ---)");
  }
  const yamlText = raw.slice(4, end + 1);
  const rest = raw.slice(end + 4);
  const body = rest.replace(/^\r?\n+/, "").replace(/\s+$/, "");
  let fm: unknown;
  try {
    fm = YAML.parse(yamlText);
  } catch (err) {
    throw new WikiStoreError(
      `article frontmatter is not valid YAML: ${(err as Error).message}`,
      err,
    );
  }
  if (typeof fm !== "object" || fm === null) {
    throw new WikiStoreError("article frontmatter must be a YAML mapping");
  }
  const v = fm as Record<string, unknown>;
  const strArr = (x: unknown): string[] =>
    Array.isArray(x) ? x.filter((t): t is string => typeof t === "string") : [];
  if (typeof v["slug"] !== "string" || !SLUG_REGEX.test(v["slug"])) {
    throw new WikiStoreError("article frontmatter has a missing/invalid slug");
  }
  if (typeof v["title"] !== "string" || v["title"] === "") {
    throw new WikiStoreError(`article "${v["slug"]}" frontmatter has a missing title`);
  }
  if (typeof v["version"] !== "number" || !Number.isInteger(v["version"]) || v["version"] < 1) {
    throw new WikiStoreError(`article "${v["slug"]}" frontmatter has a missing/invalid version`);
  }
  const status = ARTICLE_STATUSES.includes(v["status"] as WikiArticleStatus)
    ? (v["status"] as WikiArticleStatus)
    : "published";
  const createdByRaw = v["createdBy"];
  let createdBy: WikiCreatedBy | undefined;
  if (typeof createdByRaw === "object" && createdByRaw !== null) {
    const cb = createdByRaw as Record<string, unknown>;
    if (typeof cb["sessionId"] === "string") {
      createdBy = {
        sessionId: cb["sessionId"],
        ...(typeof cb["agentIdentity"] === "string" ? { agentIdentity: cb["agentIdentity"] } : {}),
      };
    }
  }
  return {
    slug: v["slug"],
    title: v["title"],
    tags: strArr(v["tags"]),
    confidence: clamp01(typeof v["confidence"] === "number" ? v["confidence"] : 0.5),
    verified: v["verified"] === true,
    version: v["version"],
    sources: strArr(v["sources"]),
    ...(typeof v["supersedes"] === "number" ? { supersedes: v["supersedes"] } : {}),
    ...(createdBy !== undefined ? { createdBy } : {}),
    status,
    createdAt: isoTimestampOr(v["createdAt"]),
    updatedAt: isoTimestampOr(v["updatedAt"]),
    body,
  };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

/** The contextual chunk header (design §3.1): title + tags prefixed to the
 *  indexed text so retrieval sees each chunk in context. Exported for tests. */
export function indexedText(article: Pick<WikiArticle, "title" | "tags" | "body">): string {
  const tagLine = article.tags.length > 0 ? `[tags: ${article.tags.join(", ")}]\n` : "";
  return `${article.title}\n${tagLine}\n${article.body}`;
}

// ---------------------------------------------------------------------------
// BM25 (the exact memory-store math, over article docs)
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

type ScoredDoc = { slug: string; score: number };

function bm25Rank(docs: ReadonlyArray<{ slug: string; text: string }>, query: string): ScoredDoc[] {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0 || docs.length === 0) return [];
  const k1 = 1.5;
  const b = 0.75;
  const tokenized = docs.map((d) => ({ slug: d.slug, terms: tokenize(d.text) }));
  const N = tokenized.length;
  const avgdl = tokenized.reduce((sum, d) => sum + d.terms.length, 0) / Math.max(1, N);

  const df = new Map<string, number>();
  for (const t of new Set(queryTerms)) {
    df.set(t, tokenized.filter((d) => d.terms.includes(t)).length);
  }

  const results: ScoredDoc[] = [];
  for (const d of tokenized) {
    let score = 0;
    for (const t of queryTerms) {
      const tf = d.terms.filter((x) => x === t).length;
      if (tf === 0) continue;
      const dfi = df.get(t) ?? 0;
      const idf = Math.log((N - dfi + 0.5) / (dfi + 0.5) + 1);
      const dl = d.terms.length;
      const norm = tf * (k1 + 1);
      const denom = tf + k1 * (1 - b + (b * dl) / Math.max(1, avgdl));
      score += idf * (norm / denom);
    }
    if (score > 0) results.push({ slug: d.slug, score });
  }
  results.sort((a, b2) => b2.score - a.score || a.slug.localeCompare(b2.slug));
  return results;
}

function cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

type IndexEntry = Omit<WikiRef, "slug">;
type WikiIndexFile = { version: 1; articles: Record<string, IndexEntry> };

export function createWikiStore(opts: WikiStoreOptions): WikiStore {
  if (!opts.specName) {
    throw new WikiStoreError("specName is required");
  }
  if (!SPEC_NAME_REGEX.test(opts.specName)) {
    throw new WikiStoreError(`invalid specName "${opts.specName}" — must match [a-zA-Z0-9_\\-.]+`);
  }
  const now = opts.now ?? (() => new Date());
  const embedder = opts.embedder;

  // Tenant fencing (§2.7 / session-store rules): honor BOTH an explicit
  // `tenant` option and the ambient AsyncLocalStorage context. With a tenant
  // present, any resolved path outside the tenant's root fails closed
  // (CWE-1230). The fence root is the tenant's directory (the parent of its
  // sessionRoot), so the default wiki layout `<tenantRoot>/wiki/...` passes.
  function tenantRootOf(tenant: Tenant): string {
    return resolve(tenant.sessionRoot, "..");
  }
  function fence(absPath: string): string {
    if (opts.tenant !== undefined) assertSamePath(absPath, tenantRootOf(opts.tenant));
    const ctx = currentTenantContext();
    if (ctx !== undefined) assertSamePath(absPath, tenantRootOf(ctx.tenant));
    return absPath;
  }
  const constructionTenant = opts.tenant ?? currentTenantContext()?.tenant;
  const rootDir =
    opts.rootDir ??
    (constructionTenant !== undefined
      ? join(tenantRootOf(constructionTenant), "wiki")
      : DEFAULT_ROOT_DIR);
  const storeDir = resolve(rootDir, opts.specName);
  const articlesDir = join(storeDir, "articles");
  const versionsDir = join(storeDir, "versions");
  const indexPath = join(storeDir, "index.json");
  const lockPath = join(storeDir, ".lock");

  // Embedding cache. Keyed by `slug@version` — a version bump re-embeds,
  // an unchanged article never does (within one store instance).
  const embeddingCache = new Map<string, number[]>();

  function locked<T>(fn: () => Promise<T>): Promise<T> {
    return withLock(fence(lockPath), fn, opts.lock ?? {});
  }

  function validateSlug(slug: string): string {
    if (typeof slug !== "string" || !SLUG_REGEX.test(slug)) {
      throw new WikiStoreError(
        `invalid slug "${slug}" — must be kebab-case ([a-z0-9][a-z0-9-]*, max 128 chars)`,
      );
    }
    return slug;
  }

  function articlePath(slug: string): string {
    return fence(join(articlesDir, `${slug}.md`));
  }

  /** A store path as the store names it in messages: `articles/notes.md`. */
  function storeRel(absPath: string): string {
    return relative(storeDir, absPath).split("\\").join("/");
  }

  /**
   * Write `content` at `absPath` without writing THROUGH anything planted in
   * the store (security-2#0). The bytes go to an `O_EXCL|O_NOFOLLOW` temp
   * under a random name in the file's physical directory, which must be
   * inside the store, and the temp is renamed into place. A fixed temp name
   * (`<slug>.md.tmp`, `index.json.tmp`) used to be opened with link
   * following, so a symlink planted there — dangling or not — created or
   * truncated a file anywhere the process could write. A symlinked article,
   * a symlinked `versions/<slug>` directory leading out, or a FIFO at the
   * leaf is refused, naming the store path.
   */
  async function atomicWrite(absPath: string, content: string): Promise<void> {
    fence(absPath);
    await mkdir(storeDir, { recursive: true });
    const rel = storeRel(absPath);
    const written = writeFileSafe(storeDir, rel, content, {
      overwrite: true,
      createParents: true,
      mode: 0o600,
    });
    if (!written.ok) {
      throw new WikiStoreError(
        written.code === "escapes-root"
          ? outsideStoreMessage("write", rel)
          : `refusing to write ${rel} in the wiki store: ${written.reason}`,
      );
    }
  }

  /**
   * The refusal for a store path that resolves outside the store: a
   * symlinked `articles/` or `versions/` directory (or file) leading out.
   * tool-safety's own reason says "the workspace", which is the store here.
   */
  function outsideStoreMessage(op: "read" | "write", rel: string): string {
    return `refusing to ${op} ${rel}: it resolves outside the wiki store, through a symlinked file or a symlinked articles/ or versions/ directory. Keep articles/ and versions/ as directories inside the store; to keep the wiki somewhere else, link the store's own directory instead.`;
  }

  /**
   * Whether an existing store subdirectory resolves outside the store. The
   * store root itself may be a link (it is resolved first); a subdirectory
   * leading out is refused for every operation, so list() does not name
   * articles that get() and search() would refuse to read.
   */
  function subdirLeavesStore(dir: string): boolean {
    let realStore: string;
    let realDir: string;
    try {
      realStore = realpathSync(storeDir);
      realDir = realpathSync(dir);
    } catch {
      return false; // not there (yet): nothing leads anywhere
    }
    const rel = relative(realStore, realDir);
    return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  }

  /**
   * At most `maxBytes` of a regular file inside the store, never through a
   * symlink (a planted `articles/<slug>.md -> ~/.ssh/...` is not read), or
   * `null` when nothing is there.
   */
  async function readStoreFile(absPath: string, maxBytes: number): Promise<string | null> {
    fence(absPath);
    const rel = storeRel(absPath);
    const read = await openForRead(storeDir, rel, { maxBytes, followLeafSymlink: false });
    if (!read.ok) {
      if (read.code === "not-found") return null;
      throw new WikiStoreError(
        read.code === "escapes-root"
          ? outsideStoreMessage("read", rel)
          : `refusing to read ${rel} in the wiki store: ${read.reason}`,
      );
    }
    if (read.truncated) {
      throw new WikiStoreError(
        `${rel} in the wiki store is larger than ${maxBytes} bytes, so it was not read`,
      );
    }
    return read.text;
  }

  async function readArticle(slug: string): Promise<WikiArticle | null> {
    const raw = await readStoreFile(articlePath(slug), ARTICLE_MAX_BYTES);
    return raw === null ? null : parseArticle(raw);
  }

  async function listArticleSlugs(): Promise<string[]> {
    fence(articlesDir);
    let entries: string[];
    try {
      // Regular files only: a symlink or FIFO named like an article is not
      // one of the store's articles, and reading it is refused anyway.
      entries = (await readdir(articlesDir, { withFileTypes: true }))
        .filter((e) => e.isFile())
        .map((e) => e.name);
    } catch {
      return [];
    }
    return entries
      .filter((f) => f.endsWith(".md") && SLUG_REGEX.test(f.slice(0, -3)))
      .map((f) => f.slice(0, -3))
      .sort();
  }

  function toIndexEntry(article: WikiArticle): IndexEntry {
    return {
      title: article.title,
      tags: [...article.tags],
      confidence: article.confidence,
      verified: article.verified,
      version: article.version,
      updatedAt: article.updatedAt,
      links: extractWikilinks(article.body, article.slug),
      status: article.status,
    };
  }

  /** Rebuild the index from the articles on disk — the authoritative source.
   *  index.json is only ever a cache of this scan. */
  async function rebuildIndex(): Promise<WikiIndexFile> {
    const articles: Record<string, IndexEntry> = {};
    for (const slug of await listArticleSlugs()) {
      try {
        const article = await readArticle(slug);
        if (article !== null) articles[slug] = toIndexEntry(article);
      } catch {
        // A malformed article never blocks the rest of the wiki.
      }
    }
    return { version: 1, articles };
  }

  /**
   * Whether `value` is an index this store could have written for the
   * articles in `slugs`. index.json is a file any agent with a write tool
   * can edit, and its entries become the rows every list tool prints, so
   * each one is held to what {@link toIndexEntry} produces from a parsed
   * article: the key is a slug with an article file behind it, the version a
   * positive whole number, the status one of the four, the title, tags and
   * links strings (each link a slug), the confidence a number in [0, 1],
   * `verified` a boolean and `updatedAt` a normalised timestamp. Anything
   * else — a planted key
   * carrying text, a string version, an entry for an article that is not
   * there — sends the load to a rebuild from the articles, which
   * parseArticle validates.
   *
   * An article with no entry is not a reason to rebuild: the rebuild leaves
   * out a malformed article, and whoever can leave one out of index.json can
   * as well delete the article itself.
   */
  function isIndexFile(value: unknown, slugs: ReadonlyArray<string>): value is WikiIndexFile {
    if (typeof value !== "object" || value === null) return false;
    const v = value as Record<string, unknown>;
    if (v["version"] !== 1 || typeof v["articles"] !== "object" || v["articles"] === null) {
      return false;
    }
    const entries = Object.entries(v["articles"] as Record<string, unknown>);
    const onDisk = new Set(slugs);
    const strings = (x: unknown): boolean =>
      Array.isArray(x) && x.every((s) => typeof s === "string");
    return entries.every(([slug, raw]) => {
      if (!onDisk.has(slug) || typeof raw !== "object" || raw === null) return false;
      const e = raw as Record<string, unknown>;
      const { version, confidence, updatedAt } = e;
      return (
        typeof e["title"] === "string" &&
        strings(e["tags"]) &&
        strings(e["links"]) &&
        (e["links"] as unknown[]).every(isWikiSlug) &&
        typeof confidence === "number" &&
        confidence >= 0 &&
        confidence <= 1 &&
        typeof e["verified"] === "boolean" &&
        typeof version === "number" &&
        Number.isSafeInteger(version) &&
        version >= 1 &&
        ARTICLE_STATUSES.includes(e["status"] as WikiArticleStatus) &&
        isoTimestampOr(updatedAt) === updatedAt
      );
    });
  }

  /** Load index.json; on a missing/corrupt file, rebuild from the articles
   *  (the crash-safe guarantee: the index is always derivable). */
  async function loadIndex(): Promise<WikiIndexFile> {
    fence(indexPath);
    if (subdirLeavesStore(articlesDir)) {
      throw new WikiStoreError(outsideStoreMessage("read", "articles/"));
    }
    try {
      const raw = await readStoreFile(indexPath, INDEX_MAX_BYTES);
      if (raw !== null) {
        const parsed = JSON.parse(raw) as unknown;
        if (isIndexFile(parsed, await listArticleSlugs())) return parsed;
      }
    } catch {
      // missing, corrupt, oversized or not a regular file: fall through to rebuild
    }
    return rebuildIndex();
  }

  async function persistIndex(index: WikiIndexFile): Promise<void> {
    // index.json is a derived cache, so a symlink planted in its place is
    // removed (unlink never follows a link) rather than left to fail every
    // write; the rebuilt index then lands as a regular file.
    try {
      if (lstatSync(fence(indexPath)).isSymbolicLink()) unlinkSync(indexPath);
    } catch {
      // nothing there yet
    }
    await atomicWrite(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  }

  function refsOf(index: WikiIndexFile): WikiRef[] {
    return Object.entries(index.articles)
      .map(([slug, entry]) => ({ slug, ...entry }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /** slug@version-cached embeddings of the given docs' indexed text. */
  async function embeddingsFor(
    docs: ReadonlyArray<{ slug: string; version: number; text: string }>,
  ): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    if (embedder === undefined) return out;
    const missing = docs.filter((d) => !embeddingCache.has(`${d.slug}@${d.version}`));
    if (missing.length > 0) {
      const vectors = await embedder.embed(missing.map((d) => d.text));
      missing.forEach((d, i) => {
        const v = vectors[i];
        if (v !== undefined) embeddingCache.set(`${d.slug}@${d.version}`, v);
      });
    }
    for (const d of docs) {
      const v = embeddingCache.get(`${d.slug}@${d.version}`);
      if (v !== undefined) out.set(d.slug, v);
    }
    return out;
  }

  type RecallDoc = { slug: string; version: number; text: string; body: string; ref: WikiRef };

  /** Non-archived articles with their contextual indexed text + bodies. */
  async function recallDocs(index: WikiIndexFile): Promise<RecallDoc[]> {
    const docs: RecallDoc[] = [];
    for (const ref of refsOf(index)) {
      if (ref.status === "archived") continue;
      const article = await readArticle(ref.slug);
      if (article === null) continue;
      docs.push({
        slug: ref.slug,
        version: ref.version,
        text: indexedText(article),
        body: article.body,
        ref,
      });
    }
    return docs;
  }

  /**
   * The primary ranking: BM25 alone, or (with an embedder) the RRF fusion
   * of the BM25 ranking and the cosine-similarity ranking — the exact
   * memory-store PR-6 recipe (k=60, candidates = union of positive matches).
   */
  async function primaryRank(docs: ReadonlyArray<RecallDoc>, query: string): Promise<ScoredDoc[]> {
    const bm = bm25Rank(docs, query);
    if (embedder === undefined) return bm;
    const [queryVec] = await embedder.embed([query]);
    const vecs = await embeddingsFor(docs);
    const simRanked: Array<{ slug: string; sim: number }> = [];
    if (queryVec !== undefined) {
      for (const d of docs) {
        const v = vecs.get(d.slug);
        if (v === undefined) continue;
        const sim = cosineSimilarity(queryVec, v);
        if (sim > 0) simRanked.push({ slug: d.slug, sim });
      }
      simRanked.sort((a, b) => b.sim - a.sim || a.slug.localeCompare(b.slug));
    }
    const fused = new Map<string, number>();
    const vote = (slug: string, rank: number): void => {
      fused.set(slug, (fused.get(slug) ?? 0) + 1 / (RRF_K + rank));
    };
    bm.forEach((r, i) => vote(r.slug, i + 1));
    simRanked.forEach((r, i) => vote(r.slug, i + 1));
    return [...fused.entries()]
      .map(([slug, score]) => ({ slug, score }))
      .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
  }

  return {
    embedderLeavesProcess: embedderLeavesProcess(embedder),

    async recall(query: string, k = 6): Promise<readonly WikiHit[]> {
      if (typeof query !== "string" || query.length === 0) {
        throw new WikiStoreError("recall(): query must be a non-empty string");
      }
      if (k <= 0) return [];
      const index = await loadIndex();
      const docs = await recallDocs(index);
      if (docs.length === 0) return [];
      const primary = await primaryRank(docs, query);
      if (primary.length === 0) return [];
      const bySlug = new Map(docs.map((d) => [d.slug, d]));

      // One-hop link expansion + the documented re-rank rule (see the module
      // header): primary candidates keep their reciprocal-rank vote
      // 1/(60+rank); each one-hop neighbor of a top-k seed (either edge
      // direction) gains a HALF-WEIGHT link vote 0.5/(60 + bestSeedRank) —
      // corroboration, not a match, so a neighbor can never displace its
      // seed or any primary match ranked at or above it.
      const seeds = primary.slice(0, k);
      const seedRank = new Map(seeds.map((s, i) => [s.slug, i + 1]));
      const neighborBestSeedRank = new Map<string, number>();
      for (const doc of docs) {
        for (const [seedSlug, rank] of seedRank) {
          if (doc.slug === seedSlug) continue;
          const seedDoc = bySlug.get(seedSlug);
          if (seedDoc === undefined) continue;
          const linked = seedDoc.ref.links.includes(doc.slug) || doc.ref.links.includes(seedSlug);
          if (!linked) continue;
          const prev = neighborBestSeedRank.get(doc.slug);
          if (prev === undefined || rank < prev) neighborBestSeedRank.set(doc.slug, rank);
        }
      }

      const votes = new Map<string, number>();
      primary.forEach((r, i) => {
        votes.set(r.slug, (votes.get(r.slug) ?? 0) + 1 / (RRF_K + i + 1));
      });
      for (const [slug, bestSeed] of neighborBestSeedRank) {
        votes.set(slug, (votes.get(slug) ?? 0) + 0.5 / (RRF_K + bestSeed));
      }

      const primaryMatched = new Set(primary.map((r) => r.slug));
      return [...votes.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, k)
        .flatMap(([slug, score]) => {
          const doc = bySlug.get(slug);
          if (doc === undefined) return [];
          const hit: WikiHit = {
            ref: doc.ref,
            score,
            body: doc.body,
            via: primaryMatched.has(slug) ? "match" : "link",
          };
          return [hit];
        });
    },

    async search(query: string): Promise<readonly WikiRef[]> {
      if (typeof query !== "string" || query.length === 0) {
        throw new WikiStoreError("search(): query must be a non-empty string");
      }
      const index = await loadIndex();
      const docs = await recallDocs(index);
      const ranked = bm25Rank(docs, query);
      const bySlug = new Map(docs.map((d) => [d.slug, d.ref]));
      return ranked.flatMap((r) => {
        const ref = bySlug.get(r.slug);
        return ref !== undefined ? [ref] : [];
      });
    },

    async get(slug: string): Promise<WikiArticle | null> {
      validateSlug(slug);
      return readArticle(slug);
    },

    async write(input: WikiWrite): Promise<{ slug: string; version: number }> {
      const slug = validateSlug(input.slug);
      if (typeof input.title !== "string" || input.title.trim() === "") {
        throw new WikiStoreError("write(): title must be a non-empty string");
      }
      if (typeof input.body !== "string" || input.body.trim() === "") {
        throw new WikiStoreError("write(): body must be a non-empty string");
      }
      if (
        input.confidence !== undefined &&
        (typeof input.confidence !== "number" || input.confidence < 0 || input.confidence > 1)
      ) {
        throw new WikiStoreError("write(): confidence must be a number in [0, 1]");
      }
      return locked(async () => {
        const existing = await readArticle(slug);
        const at = now().toISOString();
        let next: WikiArticle;
        if (existing === null) {
          if (input.expectedVersion !== undefined && input.expectedVersion !== 0) {
            throw new WikiVersionConflictError(slug, input.expectedVersion, undefined);
          }
          next = {
            slug,
            title: input.title,
            tags: [...(input.tags ?? [])],
            confidence: input.confidence ?? 0.5,
            verified: false,
            version: 1,
            sources: [...(input.sources ?? [])],
            ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
            status: input.status ?? "published",
            createdAt: at,
            updatedAt: at,
            body: input.body,
          };
        } else {
          if (input.expectedVersion !== existing.version) {
            throw new WikiVersionConflictError(slug, input.expectedVersion, existing.version);
          }
          // Supersede, never delete: freeze the outgoing version FIRST, so
          // even a crash between snapshot and write loses nothing.
          await atomicWrite(
            fence(join(versionsDir, slug, `${existing.version}.md`)),
            serializeArticle(existing),
          );
          next = {
            slug,
            title: input.title,
            tags: input.tags !== undefined ? [...input.tags] : existing.tags,
            confidence: input.confidence ?? existing.confidence,
            // A new version is a new, not-yet-fact-checked claim.
            verified: false,
            version: existing.version + 1,
            sources: input.sources !== undefined ? [...input.sources] : existing.sources,
            supersedes: existing.version,
            ...(input.createdBy !== undefined
              ? { createdBy: input.createdBy }
              : existing.createdBy !== undefined
                ? { createdBy: existing.createdBy }
                : {}),
            status: input.status ?? existing.status,
            createdAt: existing.createdAt,
            updatedAt: at,
            body: input.body,
          };
        }
        const serialized = serializeArticle(next);
        if (Buffer.byteLength(serialized, "utf8") > ARTICLE_MAX_BYTES) {
          throw new WikiStoreError(
            `write(): article "${slug}" would be larger than ${ARTICLE_MAX_BYTES} bytes; split it into linked articles`,
          );
        }
        await atomicWrite(articlePath(slug), serialized);
        // The index is a derived cache — rebuild from the authoritative
        // article scan so a previously stale/corrupt index self-heals on
        // the next mutation.
        await persistIndex(await rebuildIndex());
        return { slug, version: next.version };
      });
    },

    async list(listOpts: WikiListOptions = {}): Promise<readonly WikiRef[]> {
      const index = await loadIndex();
      let refs = refsOf(index);
      if (listOpts.status !== undefined && listOpts.status !== "all") {
        refs = refs.filter((r) => r.status === listOpts.status);
      }
      if (listOpts.tags !== undefined && listOpts.tags.length > 0) {
        const wanted = listOpts.tags;
        refs = refs.filter((r) => wanted.every((t) => r.tags.includes(t)));
      }
      const dir = listOpts.staleFirst === true ? 1 : -1;
      // An article whose timestamp is unknown sorts last in either order:
      // it is neither the stalest nor the freshest, it is undated.
      refs.sort((a, b) => {
        const at = instantOf(a.updatedAt);
        const bt = instantOf(b.updatedAt);
        if (at === undefined || bt === undefined) {
          if (at !== bt) return at === undefined ? 1 : -1;
          return a.slug.localeCompare(b.slug);
        }
        return dir * (at - bt) || a.slug.localeCompare(b.slug);
      });
      return refs;
    },

    async related(slug: string): Promise<readonly WikiRelatedRef[]> {
      validateSlug(slug);
      const index = await loadIndex();
      const entry = index.articles[slug];
      if (entry === undefined) {
        throw new WikiStoreError(`related(): no article "${slug}"`);
      }
      const refs = refsOf(index);
      const me: WikiRef = { slug, ...entry };
      // Embedding similarity contributes only when an embedder is present.
      let sims = new Map<string, number>();
      if (embedder !== undefined) {
        const docs = await recallDocs(index);
        const vecs = await embeddingsFor(docs);
        const mine = vecs.get(slug);
        if (mine !== undefined) {
          sims = new Map(
            [...vecs.entries()]
              .filter(([s]) => s !== slug)
              .map(([s, v]) => [s, cosineSimilarity(mine, v)]),
          );
        }
      }
      const out: WikiRelatedRef[] = [];
      for (const other of refs) {
        if (other.slug === slug) continue;
        const sharedTags = other.tags.filter((t) => me.tags.includes(t)).length;
        const linkEdges =
          (me.links.includes(other.slug) ? 1 : 0) + (other.links.includes(slug) ? 1 : 0);
        const sim = Math.max(0, sims.get(other.slug) ?? 0);
        // Documented weighting: each shared tag = 1 vote, each link edge
        // (out + in counted separately) = 2 votes, embedding similarity
        // adds its raw 0–1 cosine on top as a tie-refiner.
        const score = sharedTags + 2 * linkEdges + sim;
        if (score > 0) out.push({ ...other, relatedScore: score });
      }
      out.sort((a, b) => b.relatedScore - a.relatedScore || a.slug.localeCompare(b.slug));
      return out;
    },

    async setSignals(slug: string, signals: WikiSignals): Promise<void> {
      validateSlug(slug);
      if (signals.verified === undefined && signals.confidence === undefined) {
        throw new WikiStoreError("setSignals(): pass at least one of verified / confidence");
      }
      if (
        signals.confidence !== undefined &&
        (typeof signals.confidence !== "number" || signals.confidence < 0 || signals.confidence > 1)
      ) {
        throw new WikiStoreError("setSignals(): confidence must be a number in [0, 1]");
      }
      return locked(async () => {
        const existing = await readArticle(slug);
        if (existing === null) {
          throw new WikiStoreError(`setSignals(): no article "${slug}"`);
        }
        // Metadata-only: no version bump, no snapshot (the body is untouched).
        const next: WikiArticle = {
          ...existing,
          verified: signals.verified ?? existing.verified,
          confidence: signals.confidence ?? existing.confidence,
          updatedAt: now().toISOString(),
        };
        await atomicWrite(articlePath(slug), serializeArticle(next));
        await persistIndex(await rebuildIndex());
      });
    },

    async stats(): Promise<WikiStats> {
      const index = await loadIndex();
      const refs = refsOf(index);
      const byStatus: Record<WikiArticleStatus, number> = {
        draft: 0,
        published: 0,
        review: 0,
        archived: 0,
      };
      const tags = new Set<string>();
      let verified = 0;
      let confidenceSum = 0;
      let links = 0;
      for (const r of refs) {
        byStatus[r.status] += 1;
        for (const t of r.tags) tags.add(t);
        if (r.verified) verified += 1;
        confidenceSum += r.confidence;
        links += r.links.length;
      }
      // Count immutable snapshots (supersede-never-delete chain depth).
      let priorVersions = 0;
      fence(versionsDir);
      try {
        // Real directories and regular files only: a `versions/<slug>` link
        // leading out of the store is not listed through.
        for (const slugDir of await readdir(versionsDir, { withFileTypes: true })) {
          if (!slugDir.isDirectory()) continue;
          try {
            priorVersions += (
              await readdir(join(versionsDir, slugDir.name), { withFileTypes: true })
            ).filter((f) => f.isFile() && f.name.endsWith(".md")).length;
          } catch {
            // raced away — skip
          }
        }
      } catch {
        // no versions dir yet
      }
      return {
        articles: refs.length,
        byStatus,
        priorVersions,
        uniqueTags: tags.size,
        verified,
        averageConfidence: refs.length > 0 ? confidenceSum / refs.length : 0,
        links,
      };
    },

    ...(embedder !== undefined
      ? {
          async semanticSearch(query: string, k = 6, minScore = 0.05): Promise<readonly WikiHit[]> {
            if (typeof query !== "string" || query.length === 0) {
              throw new WikiStoreError("semanticSearch(): query must be a non-empty string");
            }
            if (k <= 0) return [];
            const index = await loadIndex();
            const docs = await recallDocs(index);
            if (docs.length === 0) return [];
            const [queryVec] = await embedder.embed([query]);
            if (queryVec === undefined) return [];
            const vecs = await embeddingsFor(docs);
            const scored = docs
              .flatMap((d) => {
                const v = vecs.get(d.slug);
                if (v === undefined) return [];
                const sim = cosineSimilarity(queryVec, v);
                if (sim < minScore) return [];
                const hit: WikiHit = { ref: d.ref, score: sim, body: d.body, via: "match" };
                return [hit];
              })
              .sort((a, b) => b.score - a.score || a.ref.slug.localeCompare(b.ref.slug));
            return scored.slice(0, k);
          },
        }
      : {}),

    path(): string {
      return storeDir;
    },
  };
}
