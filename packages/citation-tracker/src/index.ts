/**
 * Catalog R-orch `citation-tracker` — Section 23 RES.
 *
 * Persistent per-research-run record of every URL the crawler has
 * touched, plus every fact the agent has cited. The same instance does
 * two jobs that the kickoff treats as one:
 *
 *   1. **Fetch dedup** — `hasFetched(url)` lets the crawler skip a HTTP
 *      round-trip on resume. `recordFetch({url, content})` stores the
 *      sha256 + the content body so a kill-and-resume returns identical
 *      bytes from cache rather than re-pulling the URL.
 *   2. **Citation registry** — `recordCitation({url, snippet, branchId?})`
 *      appends a fact to the run's citation log. `listCitationsOrdered()`
 *      returns citations in first-seen order (deterministic across
 *      re-runs because of the JSONL append-only file).
 *
 * Storage layout:
 *   `<rootDir>/<runId>/fetches.jsonl`   one line per URL ever fetched
 *   `<rootDir>/<runId>/citations.jsonl` one line per `recordCitation` call
 *
 * Both files are append-only, mode 0o600, atomic-per-line on POSIX
 * (mirrors `event-log`). On boot the tracker reads each file once into
 * an in-memory cache; subsequent calls hit memory.
 *
 * The smoke test's "byte-identical citation block across re-runs"
 * invariant is anchored here: citations are ordered by their first
 * append timestamp, NOT by retrievedAt, so even if the model takes
 * different routes on the second pass, the citation list still ends up
 * in stable order keyed off the FIRST-seen URL.
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CrewhausError, RuntimeError } from "@crewhaus/errors";

export const DEFAULT_ROOT_DIR = ".crewhaus/research";
const RUN_ID_RE = /^run_[0-9a-f]{16}$/;
/**
 * A sha256 digest is always exactly 64 lowercase hex chars. We re-validate it
 * before interpolating into the cache file path because the value can originate
 * from a JSONL line read off disk (boot-time replay), and a corrupted or
 * tampered `fetches.jsonl` must not be able to steer a read outside `cache/`
 * (e.g. a `sha256` of "../../../etc/passwd"). Legitimate records always match.
 */
const SHA256_RE = /^[0-9a-f]{64}$/;

export type RunId = string;

export type FetchRecord = {
  readonly version: 1;
  readonly url: string;
  readonly retrievedAt: string;
  readonly sha256: string;
  readonly contentBytes: number;
  /** Branch (sub-question) that initiated this fetch, if known. */
  readonly branchId?: string;
};

export type Citation = {
  readonly version: 1;
  readonly url: string;
  readonly snippet: string;
  readonly retrievedAt: string;
  readonly sha256: string;
  readonly branchId?: string;
  /** Free-form supporting-claim label (e.g., "supports: target shapes list"). */
  readonly supportingClaim?: string;
};

export type RecordFetchInput = {
  readonly url: string;
  readonly content: string;
  readonly branchId?: string;
};

export type RecordCitationInput = {
  readonly url: string;
  readonly snippet: string;
  readonly branchId?: string;
  readonly supportingClaim?: string;
};

export interface CitationTracker {
  readonly runId: RunId;

  /** True iff the tracker already has a content body for this URL. */
  hasFetched(url: string): boolean;
  /** Cached content body for a URL (matched by exact string). */
  getFetchedContent(url: string): string | undefined;
  /** Cached fetch metadata (sha256 + retrievedAt) for a URL. */
  getFetchRecord(url: string): FetchRecord | undefined;
  /** Idempotent: re-recording the same URL is a no-op (preserves first sha256). */
  recordFetch(input: RecordFetchInput): FetchRecord;

  recordCitation(input: RecordCitationInput): Citation;
  /** Citations in append-order (deterministic across re-runs). */
  listCitationsOrdered(): ReadonlyArray<Citation>;
  /** All fetch records in append-order. */
  listFetches(): ReadonlyArray<FetchRecord>;
}

export type CreateCitationTrackerOptions = {
  readonly runId?: RunId;
  readonly rootDir?: string;
  readonly now?: () => Date;
};

function validateRunId(runId: string): void {
  if (!RUN_ID_RE.test(runId)) {
    throw new RuntimeError(`citation-tracker: invalid runId "${runId}" — expected run_<16 hex>`);
  }
}

export function newRunId(): RunId {
  // 16 hex chars. UUID is 32 hex (with dashes); strip dashes and take 16.
  const id = randomUUID().replace(/-/g, "").slice(0, 16);
  return `run_${id}`;
}

export class CitationTrackerError extends CrewhausError {
  override readonly name = "CitationTrackerError";
  constructor(message: string, cause?: unknown) {
    super("runtime", message, cause);
  }
}

export function createCitationTracker(opts: CreateCitationTrackerOptions = {}): CitationTracker {
  const runId = opts.runId ?? newRunId();
  validateRunId(runId);
  const rootDir = opts.rootDir ?? DEFAULT_ROOT_DIR;
  const runDir = join(rootDir, runId);
  const fetchesPath = join(runDir, "fetches.jsonl");
  const citationsPath = join(runDir, "citations.jsonl");
  const now = opts.now ?? (() => new Date());

  mkdirSync(runDir, { recursive: true });

  // Boot-time replay of prior records so a resume sees the same dedup state.
  const fetchByUrl = new Map<string, FetchRecord>();
  const fetchOrder: FetchRecord[] = [];
  const citations: Citation[] = [];

  if (existsSync(fetchesPath)) {
    for (const raw of readFileSync(fetchesPath, "utf8").split("\n")) {
      const line = raw.trim();
      if (line.length === 0) continue;
      try {
        const rec = JSON.parse(line) as FetchRecord;
        if (typeof rec.url === "string" && !fetchByUrl.has(rec.url)) {
          fetchByUrl.set(rec.url, rec);
          fetchOrder.push(rec);
        }
      } catch (err) {
        throw new CitationTrackerError(`malformed JSON in ${fetchesPath}`, err);
      }
    }
  }
  if (existsSync(citationsPath)) {
    for (const raw of readFileSync(citationsPath, "utf8").split("\n")) {
      const line = raw.trim();
      if (line.length === 0) continue;
      try {
        const rec = JSON.parse(line) as Citation;
        citations.push(rec);
      } catch (err) {
        throw new CitationTrackerError(`malformed JSON in ${citationsPath}`, err);
      }
    }
  }

  // Per-fetch content cache — written separately under <runDir>/cache/ so the
  // JSONL stays small (citations only carry sha256 + snippet, not full bodies).
  const cacheDir = join(runDir, "cache");
  mkdirSync(cacheDir, { recursive: true });

  function cachePathFor(sha256: string): string {
    return join(cacheDir, `${sha256}.txt`);
  }

  function tryReadCache(rec: FetchRecord): string | undefined {
    // Defend the cache read against a tampered fetches.jsonl: a sha256 that is
    // not a clean 64-hex digest could otherwise traverse out of cache/.
    if (typeof rec.sha256 !== "string" || !SHA256_RE.test(rec.sha256)) return undefined;
    const p = cachePathFor(rec.sha256);
    if (!existsSync(p)) return undefined;
    return readFileSync(p, "utf8");
  }

  return {
    runId,

    hasFetched(url) {
      return fetchByUrl.has(url);
    },

    getFetchedContent(url) {
      const rec = fetchByUrl.get(url);
      if (rec === undefined) return undefined;
      return tryReadCache(rec);
    },

    getFetchRecord(url) {
      return fetchByUrl.get(url);
    },

    recordFetch(input) {
      const existing = fetchByUrl.get(input.url);
      if (existing !== undefined) {
        // Self-heal a pruned content cache. The crawler only reaches this line
        // for an already-recorded URL when `getFetchedContent` came back empty,
        // i.e. the cache file behind the record is gone — and without the body
        // nothing downstream can verify a citation snippet against it. The
        // record stays the source of truth for the digest, so re-write the body
        // only when it still hashes to the SAME sha256; a source that mutated
        // since the first fetch deliberately stays uncached.
        if (
          typeof existing.sha256 === "string" &&
          SHA256_RE.test(existing.sha256) &&
          !existsSync(cachePathFor(existing.sha256))
        ) {
          const sha = createHash("sha256").update(input.content).digest("hex");
          if (sha === existing.sha256) {
            writeFileSync(cachePathFor(existing.sha256), input.content, { mode: 0o600 });
          }
        }
        return existing;
      }
      const sha256 = createHash("sha256").update(input.content).digest("hex");
      const rec: FetchRecord = {
        version: 1,
        url: input.url,
        retrievedAt: now().toISOString(),
        sha256,
        contentBytes: Buffer.byteLength(input.content, "utf8"),
        ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      };
      fetchByUrl.set(input.url, rec);
      fetchOrder.push(rec);
      appendFileSync(fetchesPath, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
      // Cache content for resume by sha256 — same content across runs ends up
      // as the same file, so a re-fetch into a different tracker still hits
      // the same cache directory if the rootDir is shared.
      writeFileSync(cachePathFor(sha256), input.content, { mode: 0o600 });
      return rec;
    },

    recordCitation(input) {
      // Resolve sha256: prefer the matching fetch record's hash so a citation
      // anchors to a specific content version. If no matching fetch, hash
      // the snippet itself.
      const fetch = fetchByUrl.get(input.url);
      const sha256 =
        fetch !== undefined
          ? fetch.sha256
          : createHash("sha256").update(input.snippet).digest("hex");
      const c: Citation = {
        version: 1,
        url: input.url,
        snippet: input.snippet,
        retrievedAt: fetch !== undefined ? fetch.retrievedAt : now().toISOString(),
        sha256,
        ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
        ...(input.supportingClaim !== undefined ? { supportingClaim: input.supportingClaim } : {}),
      };
      citations.push(c);
      appendFileSync(citationsPath, `${JSON.stringify(c)}\n`, { mode: 0o600 });
      return c;
    },

    listCitationsOrdered() {
      // Stable order: append order. Same-URL citations are kept (the agent
      // may cite multiple snippets from one source); the report-writer's
      // numbering layer dedups by URL.
      return [...citations];
    },

    listFetches() {
      return [...fetchOrder];
    },
  };
}
