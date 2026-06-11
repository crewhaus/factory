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
import { lookup as nodeDnsLookup } from "node:dns/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join as joinPath, resolve as resolvePath, sep } from "node:path";
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
  readonly _httpFetch?: (url: string, init: RequestInit, pinnedIp?: string) => Promise<Response>;
};

export interface Crawler {
  fetch(url: string, opts?: { branchId?: string; signal?: AbortSignal }): Promise<CrawlResult>;
}

type DomainBucket = {
  windowStartMs: number;
  callsInWindow: number;
};

/**
 * SSRF defenses below mirror `@crewhaus/tool-fetch` (`isPrivateIp` /
 * `normalizeIpv4` / `assertNotSsrf`). They are duplicated rather than imported
 * to keep the crawler dependency-free (adding `@crewhaus/tool-fetch` would
 * mutate the lockfile and break `bun install --frozen-lockfile`) — the project
 * deliberately keeps per-package copies of these guards (tool-fetch,
 * tool-navigate). Keep the copies in sync. The IPv4-mapped IPv6 handling is
 * load-bearing: `new URL` normalizes `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`,
 * which a naive loopback check would miss.
 */
function normalizeIpv4(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const parseComponent = (s: string): number | null => {
    if (s === "") return null;
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(s)) {
      value = Number.parseInt(s.slice(2), 16);
    } else if (/^0[0-7]+$/.test(s)) {
      value = Number.parseInt(s, 8);
    } else if (/^[0-9]+$/.test(s)) {
      value = Number.parseInt(s, 10);
    } else {
      return null;
    }
    return Number.isNaN(value) ? null : value;
  };

  const segments = trimmed.split(".");
  if (segments.length > 4) return null;

  const components: number[] = [];
  for (const seg of segments) {
    const value = parseComponent(seg);
    if (value === null || value < 0) return null;
    components.push(value);
  }

  const n = components.length;
  const octets = [0, 0, 0, 0];
  for (let i = 0; i < n - 1; i++) {
    const c = components[i] as number;
    if (c > 255) return null;
    octets[i] = c;
  }
  const last = components[n - 1] as number;
  const maxLast = 2 ** (8 * (4 - (n - 1)));
  if (last >= maxLast) return null;
  let rest = last;
  for (let i = 3; i >= n - 1; i--) {
    octets[i] = rest & 0xff;
    rest = Math.floor(rest / 256);
  }
  return octets.join(".");
}

function isPrivateIp(addr: string): boolean {
  const ip = addr.replace(/^\[/, "").replace(/\]$/, "");
  const lowerIp = ip.toLowerCase();

  if (lowerIp === "::" || lowerIp === "::1") return true;
  if (lowerIp.startsWith("fe80:")) return true;
  if (lowerIp.startsWith("fc") || lowerIp.startsWith("fd")) return true;

  const mapped = lowerIp.match(/^::ffff:(.+)$/);
  if (mapped) {
    const tail = mapped[1] as string;
    if (tail.includes(".")) {
      return isPrivateIp(tail);
    }
    const hexGroups = tail.split(":");
    if (hexGroups.length === 2 && hexGroups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) {
      const hi = Number.parseInt(hexGroups[0] as string, 16);
      const lo = Number.parseInt(hexGroups[1] as string, 16);
      return isPrivateIp([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join("."));
    }
    return false;
  }

  const normalized = normalizeIpv4(ip);
  if (normalized === null) return false;
  const parts = normalized.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((nn) => Number.isNaN(nn) || nn < 0 || nn > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];

  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 RFC1918
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT (RFC6598)
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24 (RFC6890)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (RFC2544)
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

export type DnsLookupFn = (
  hostname: string,
) => Promise<{ readonly address: string; readonly family: number }>;

let dnsLookupFn: DnsLookupFn = nodeDnsLookup;

/** Test hook: override DNS resolution. Pass `undefined` to restore the default. */
export function _setDnsLookup(fn: DnsLookupFn | undefined): void {
  dnsLookupFn = fn ?? nodeDnsLookup;
}

/**
 * Reject a host that is — or resolves to — a private/loopback/link-local
 * address, even when its origin is on the allow-list (defense in depth: an
 * allow-list supplied by an untrusted marketplace/template spec must not be
 * able to point the crawler at `localhost`/`169.254.169.254`/RFC1918).
 *
 * Returns the validated IP so the caller can PIN the connection to that exact
 * address. Resolving here and letting the default `fetch` re-resolve at connect
 * time is a DNS-rebinding TOCTOU (CWE-367): a hostile resolver can answer
 * public for this check and private (127.0.0.1, 169.254.169.254, …) for the
 * socket milliseconds later. `pinnedFetch` dials the returned address directly.
 * For an IP-literal host the pinned value is the (normalized) literal itself.
 */
async function assertNotSsrf(host: string): Promise<string> {
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) {
    throw new CrawlerError(`SSRF: host "${host}" is loopback`);
  }
  if (lower.endsWith(".local")) {
    throw new CrawlerError(`SSRF: mDNS host "${host}" is not allowed`);
  }
  const unbracketed = lower.replace(/^\[/, "").replace(/\]$/, "");
  if (isPrivateIp(unbracketed)) {
    throw new CrawlerError(`SSRF: host "${host}" is a private/loopback IP`);
  }
  // An IP literal is its own pinned target — nothing to resolve or rebind.
  const literal = normalizeIpv4(unbracketed) ?? (unbracketed.includes(":") ? unbracketed : null);
  if (literal !== null) return literal;
  let resolved: { readonly address: string };
  try {
    resolved = await dnsLookupFn(unbracketed);
  } catch (err) {
    throw new CrawlerError(`SSRF: cannot resolve "${host}": ${(err as Error).message}`);
  }
  if (isPrivateIp(resolved.address)) {
    throw new CrawlerError(`SSRF: host "${host}" resolves to private IP ${resolved.address}`);
  }
  return resolved.address;
}

/**
 * Dial `pinnedIp` directly while keeping the request's original host for the
 * `Host` header and TLS SNI, so certificate validation and virtual-host
 * routing still work against the real name. This closes the rebinding TOCTOU:
 * the socket connects to the exact IP `assertNotSsrf` vetted, not whatever the
 * resolver returns at connect time. Mirrors `@crewhaus/tool-fetch`.
 */
function pinnedFetch(
  url: string,
  init: RequestInit,
  pinnedIp: string | undefined,
): Promise<Response> {
  const original = new URL(url);
  const host = original.hostname;
  const hostUnbracketed = host.replace(/^\[/, "").replace(/\]$/, "");
  // No pin, or the host already IS the pinned IP ⇒ nothing to rewrite.
  if (pinnedIp === undefined || pinnedIp === "" || hostUnbracketed === pinnedIp) {
    return globalThis.fetch(url, init);
  }
  const hostForUrl = pinnedIp.includes(":") ? `[${pinnedIp}]` : pinnedIp;
  const pinnedUrl = new URL(original.toString());
  pinnedUrl.hostname = hostForUrl;
  const headers = new Headers(init.headers ?? {});
  headers.set("host", original.port === "" ? host : `${host}:${original.port}`);
  const pinnedInit: RequestInit & { tls?: { serverName: string } } = {
    ...init,
    headers,
    // SNI must stay the real hostname so TLS cert validation passes.
    tls: { serverName: host },
  };
  return globalThis.fetch(pinnedUrl.toString(), pinnedInit);
}

/**
 * Read a response body, aborting as soon as the running total exceeds `cap`,
 * so a hostile/oversized response is never fully materialized in the heap.
 * Decodes to UTF-8 only after the bounded read completes.
 */
async function readBodyCapped(
  r: Response,
  cap: number,
  label: string,
  abort: () => void,
): Promise<string> {
  if (r.body === null) return "";
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > cap) {
        abort();
        await reader.cancel();
        throw new CrawlerError(`response body for ${label} exceeds ${cap} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

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
  const httpFetch = cfg._httpFetch ?? pinnedFetch;

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
    // Resolve+validate once, then PIN the socket to this exact IP so a
    // rebinding resolver can't swap in a private address before connect.
    let pinnedIp = await assertNotSsrf(host);
    await rateLimitGate(host);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const externalAbort = (): void => ac.abort();
    if (signal !== undefined) signal.addEventListener("abort", externalAbort, { once: true });

    let currentUrl = url;
    try {
      for (let hop = 0; hop <= maxRedirects; hop++) {
        const r: Response = await httpFetch(
          currentUrl,
          { redirect: "manual", signal: ac.signal },
          pinnedIp,
        );
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
          // Re-validate AND re-pin for the next hop's host.
          pinnedIp = await assertNotSsrf(next.host);
          if (hop === maxRedirects) {
            throw new CrawlerError(`exceeded ${maxRedirects} redirects starting from ${url}`);
          }
          continue;
        }
        if (!r.ok) {
          throw new CrawlerError(`HTTP ${r.status} on ${currentUrl}`);
        }
        // Enforce the body cap WHILE streaming. `await r.text()` would buffer
        // an arbitrarily large untrusted response fully into the heap BEFORE
        // any size check could fire (OOM DoS via a multi-GB / no-Content-Length
        // body). Cheap first gate: reject a declared Content-Length over the cap.
        const declaredLength = Number(r.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
          ac.abort();
          throw new CrawlerError(`response body for ${currentUrl} exceeds ${maxBodyBytes} bytes`);
        }
        return await readBodyCapped(r, maxBodyBytes, currentUrl, () => ac.abort());
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
    // 1) Lexical containment — rejects `..` and out-of-root absolute paths.
    const rooted = allowedFileRoots.some((root) => abs === root || abs.startsWith(`${root}${sep}`));
    if (!rooted) {
      throw new CrawlerError(
        `file path "${abs}" is outside the configured crawler roots (got ${allowedFileRoots.length} roots)`,
      );
    }
    // 2) Symlink-aware containment (CWE-59). The lexical check is fooled by an
    //    in-root symlink whose real target lies outside a root, so re-check the
    //    REAL path. The leaf may not exist yet (read error comes after, so
    //    escaping paths never leak existence), so resolve the deepest existing
    //    ancestor and re-append the missing tail.
    let probe = abs;
    const tail: string[] = [];
    while (!existsSync(probe)) {
      tail.unshift(basename(probe));
      const parent = dirname(probe);
      if (parent === probe) break; // reached filesystem root
      probe = parent;
    }
    let realAbs: string;
    try {
      const probeReal = realpathSync(probe);
      realAbs = tail.length > 0 ? joinPath(probeReal, ...tail) : probeReal;
    } catch (err) {
      throw new CrawlerError(`failed to resolve real path of ${abs}`, err);
    }
    const realRooted = allowedFileRoots.some((root) => {
      let rootReal: string;
      try {
        rootReal = realpathSync(root);
      } catch {
        return false;
      }
      return realAbs === rootReal || realAbs.startsWith(`${rootReal}${sep}`);
    });
    if (!realRooted) {
      throw new CrawlerError(
        `file path "${abs}" escapes the configured crawler roots via a symlink`,
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
