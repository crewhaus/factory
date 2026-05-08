/**
 * Catalog R-orch `crawler` — Section 23 RES.
 *
 * Citation-tracker-backed source fetcher. Two transports:
 *   - `https?://` — HTTP fetch with origin allow-list, redirect cap, body
 *     cap, per-domain rate limit. Mirrors `tool-fetch`'s safety layering
 *     in a programmatic API rather than a registered tool. Cookie /
 *     Authorization headers are stripped from responses.
 *   - `file://` — local disk read with allow-list rooted on configured
 *     root directories. The citation-tracker hashes the file body so a
 *     resumed run sees the same content even if the file mutates
 *     between runs (we serve from the cache by sha256).
 *
 * URL dedup is the headline feature: every `crawler.fetch(url)` call
 * checks `tracker.hasFetched(url)` first. On hit, the cached body is
 * returned and `fromCache: true`. On miss, the transport runs, the
 * citation-tracker records the fetch, and the body is cached.
 *
 * The package exports BOTH a programmatic `Crawler` interface (used by
 * the daemon) and a `createSourceTool({crawler})` factory that builds
 * a model-facing `Source(uri)` tool. The agent calls `Source(uri)` to
 * load content; the agent's subsequent `CiteFact(uri, snippet)` calls
 * (provided by `citation-tracker`'s tool helpers) anchor specific
 * snippets back to the fetched content.
 */
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { CitationTracker } from "@crewhaus/citation-tracker";
import { CrewhausError } from "@crewhaus/errors";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

export class CrawlerError extends CrewhausError {
  override readonly name = "CrawlerError";
  constructor(message: string, cause?: unknown) {
    super("tool", message, cause);
  }
}

export type CrawlResult = {
  readonly url: string;
  readonly content: string;
  readonly fromCache: boolean;
  readonly sha256: string;
  readonly retrievedAt: string;
};

export type CrawlerConfig = {
  /** Allowed http(s) origins after canonicalisation. Empty = deny all https. */
  readonly allowedOrigins?: ReadonlySet<string>;
  /** Allowed file:// roots (absolute paths). Empty = deny all file://. */
  readonly allowedFileRoots?: ReadonlyArray<string>;
  /** Per-domain rate limit. */
  readonly rateLimit?: { readonly maxPerSecond: number };
  readonly maxRedirects?: number;
  readonly maxBodyBytes?: number;
  readonly timeoutMs?: number;
  /** Test injection: replaces the live `fetch` for HTTP transports. */
  readonly _httpFetch?: (url: string, init: RequestInit) => Promise<Response>;
};

export interface Crawler {
  fetch(url: string, opts?: { branchId?: string; signal?: AbortSignal }): Promise<CrawlResult>;
}

type DomainBucket = {
  windowStartMs: number;
  callsInWindow: number;
};

export function createCrawler(opts: {
  readonly tracker: CitationTracker;
  readonly config?: CrawlerConfig;
}): Crawler {
  const cfg = opts.config ?? {};
  const allowedOrigins = cfg.allowedOrigins ?? new Set<string>();
  const allowedFileRoots = (cfg.allowedFileRoots ?? []).map((p) => resolvePath(p));
  const maxRedirects = cfg.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBodyBytes = cfg.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const rateMax = cfg.rateLimit?.maxPerSecond ?? Number.POSITIVE_INFINITY;
  const httpFetch = cfg._httpFetch ?? globalThis.fetch.bind(globalThis);

  const domainBuckets = new Map<string, DomainBucket>();

  async function rateLimitGate(domain: string): Promise<void> {
    if (!Number.isFinite(rateMax)) return;
    const bucket = domainBuckets.get(domain) ?? { windowStartMs: Date.now(), callsInWindow: 0 };
    const now = Date.now();
    if (now - bucket.windowStartMs >= 1000) {
      bucket.windowStartMs = now;
      bucket.callsInWindow = 0;
    }
    if (bucket.callsInWindow >= rateMax) {
      const waitMs = 1000 - (now - bucket.windowStartMs);
      await new Promise((r) => setTimeout(r, Math.max(50, waitMs)));
      bucket.windowStartMs = Date.now();
      bucket.callsInWindow = 0;
    }
    bucket.callsInWindow += 1;
    domainBuckets.set(domain, bucket);
  }

  function canonicaliseOrigin(rawUrl: string): { origin: string; host: string } {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch (err) {
      throw new CrawlerError(`invalid URL: ${rawUrl}`, err);
    }
    const scheme = parsed.protocol;
    const host = parsed.hostname.toLowerCase();
    let port = parsed.port;
    if (
      (scheme === "http:" && (port === "" || port === "80")) ||
      (scheme === "https:" && (port === "" || port === "443"))
    ) {
      port = "";
    }
    const origin = `${scheme}//${host}${port ? `:${port}` : ""}`;
    return { origin, host };
  }

  async function fetchHttp(url: string, signal: AbortSignal | undefined): Promise<string> {
    const { origin, host } = canonicaliseOrigin(url);
    if (!allowedOrigins.has(origin)) {
      throw new CrawlerError(
        `origin "${origin}" is not on the crawler allow-list (got ${allowedOrigins.size} allowed)`,
      );
    }
    await rateLimitGate(host);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const externalAbort = (): void => ac.abort();
    if (signal !== undefined) signal.addEventListener("abort", externalAbort, { once: true });

    let currentUrl = url;
    try {
      for (let hop = 0; hop <= maxRedirects; hop++) {
        const r: Response = await httpFetch(currentUrl, { redirect: "manual", signal: ac.signal });
        if (r.status >= 300 && r.status < 400) {
          const loc = r.headers.get("location");
          if (loc === null) {
            throw new CrawlerError(`${r.status} redirect without Location header at ${currentUrl}`);
          }
          currentUrl = new URL(loc, currentUrl).toString();
          const next = canonicaliseOrigin(currentUrl);
          if (!allowedOrigins.has(next.origin)) {
            throw new CrawlerError(
              `redirect target "${next.origin}" is not on the crawler allow-list`,
            );
          }
          if (hop === maxRedirects) {
            throw new CrawlerError(`exceeded ${maxRedirects} redirects starting from ${url}`);
          }
          continue;
        }
        if (!r.ok) {
          throw new CrawlerError(`HTTP ${r.status} on ${currentUrl}`);
        }
        const text = await r.text();
        if (Buffer.byteLength(text, "utf8") > maxBodyBytes) {
          throw new CrawlerError(`response body for ${currentUrl} exceeds ${maxBodyBytes} bytes`);
        }
        return text;
      }
      throw new CrawlerError(`exceeded ${maxRedirects} redirects starting from ${url}`);
    } finally {
      clearTimeout(timer);
      if (signal !== undefined) signal.removeEventListener("abort", externalAbort);
    }
  }

  function fetchFile(url: string): string {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname);
    const abs = resolvePath(path);
    const rooted = allowedFileRoots.some((root) => abs === root || abs.startsWith(`${root}/`));
    if (!rooted) {
      throw new CrawlerError(
        `file path "${abs}" is outside the configured crawler roots (got ${allowedFileRoots.length} roots)`,
      );
    }
    let body: string;
    try {
      body = readFileSync(abs, "utf8");
    } catch (err) {
      throw new CrawlerError(`failed to read ${abs}`, err);
    }
    if (Buffer.byteLength(body, "utf8") > maxBodyBytes) {
      throw new CrawlerError(`file ${abs} exceeds ${maxBodyBytes} bytes`);
    }
    return body;
  }

  return {
    async fetch(url, callOpts = {}) {
      // Cache hit on the citation-tracker — short-circuit with no I/O.
      const cached = opts.tracker.getFetchedContent(url);
      if (cached !== undefined) {
        const rec = opts.tracker.getFetchRecord(url);
        if (rec === undefined) {
          throw new CrawlerError(`internal: tracker has content for ${url} but no record metadata`);
        }
        return {
          url,
          content: cached,
          fromCache: true,
          sha256: rec.sha256,
          retrievedAt: rec.retrievedAt,
        };
      }

      let content: string;
      if (url.startsWith("http://") || url.startsWith("https://")) {
        content = await fetchHttp(url, callOpts.signal);
      } else if (url.startsWith("file://")) {
        content = fetchFile(url);
      } else {
        throw new CrawlerError(
          `unsupported URL scheme: ${url} (only http(s):// and file:// are supported)`,
        );
      }
      const rec = opts.tracker.recordFetch({
        url,
        content,
        ...(callOpts.branchId !== undefined ? { branchId: callOpts.branchId } : {}),
      });
      return {
        url,
        content,
        fromCache: false,
        sha256: rec.sha256,
        retrievedAt: rec.retrievedAt,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Agent-facing tools.
// ---------------------------------------------------------------------------

/**
 * Build a `Source(uri)` tool the agent calls to load content. Wraps
 * `crawler.fetch` and returns a plain-text body that the model can
 * reason about. The fetched content is registered on the citation
 * tracker so a subsequent `CiteFact(uri, snippet)` can anchor to the
 * exact bytes (matched by sha256).
 */
export function createSourceTool(opts: {
  readonly crawler: Crawler;
  /** Truncate the returned body so the model context budget is not blown up. */
  readonly maxResultBytes?: number;
  readonly currentBranchId?: () => string | undefined;
}): RegisteredTool {
  const cap = opts.maxResultBytes ?? 32_000;
  return buildTool({
    name: "Source",
    description:
      "Load content from a URL or `file://` path so you can cite it. Repeat calls with the same uri are served from cache (URL-dedup) — second-call latency is near zero. Returns the body, truncated to the head if it exceeds the per-call cap. Pair with `CiteFact(uri, snippet)` to anchor specific facts in your final answer.",
    inputSchema: z
      .object({
        uri: z
          .string()
          .min(1)
          .describe("Either an http(s):// URL or a file:// path. Other schemes are refused."),
      })
      .strict(),
    concurrencySafe: true,
    readOnly: true,
    destructive: false,
    classifyOutput: true,
    execute: async (input, ctx) => {
      const branchId = opts.currentBranchId?.();
      try {
        const r = await opts.crawler.fetch(input.uri, {
          ...(branchId !== undefined ? { branchId } : {}),
          ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
        });
        const body = r.content;
        const truncated = Buffer.byteLength(body, "utf8") > cap;
        const head = truncated
          ? `${body.slice(0, cap)}\n[truncated to ${cap} of ${Buffer.byteLength(body, "utf8")} bytes]`
          : body;
        return `[fromCache=${r.fromCache} sha256=${r.sha256.slice(0, 12)}…]\n${head}`;
      } catch (err) {
        return `[Source error] ${(err as Error).message ?? String(err)}`;
      }
    },
  });
}

/**
 * Build a `CiteFact(uri, snippet, supportingClaim?)` tool the agent
 * calls to record a citation. Each call appends one citation row in
 * the run's tracker; report-writer numbers them by URL on first
 * appearance.
 */
export function createCiteFactTool(opts: {
  readonly tracker: CitationTracker;
  readonly currentBranchId?: () => string | undefined;
}): RegisteredTool {
  return buildTool({
    name: "CiteFact",
    description:
      "Record a fact you want cited in the final report. Pass the source `uri` you fetched via Source, the verbatim `snippet` from that source, and optionally a one-line `supportingClaim` describing what the snippet supports. The orchestrator turns these into numbered citations [1], [2], … in the final report.",
    inputSchema: z
      .object({
        uri: z.string().min(1).describe("Source URL or file:// path you previously loaded."),
        snippet: z
          .string()
          .min(1)
          .describe("Verbatim quote from the source — keep it short, ideally one sentence."),
        supportingClaim: z
          .string()
          .optional()
          .describe("Optional one-line label describing the claim this fact supports."),
      })
      .strict(),
    concurrencySafe: true,
    readOnly: true,
    destructive: false,
    classifyOutput: false,
    execute: async (input) => {
      const branchId = opts.currentBranchId?.();
      const c = opts.tracker.recordCitation({
        url: input.uri,
        snippet: input.snippet,
        ...(branchId !== undefined ? { branchId } : {}),
        ...(input.supportingClaim !== undefined ? { supportingClaim: input.supportingClaim } : {}),
      });
      return `Recorded citation: ${c.url} (sha256=${c.sha256.slice(0, 12)}…)`;
    },
  });
}
