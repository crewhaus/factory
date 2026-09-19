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
 * anchor specific snippets back to the fetched content. `CiteFact`
 * VERIFIES the snippet against the cached body before recording — an
 * unverifiable quote is refused, never logged (see
 * `snippetOccursInBody`).
 */
import { lookup as nodeDnsLookup } from "node:dns/promises";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// BEGIN SYNCHRONISED BLOCK — private-address classifier
//
// This block is BYTE-IDENTICAL across every package that guards an outbound
// request. Do not edit one copy: `apps/cli/src/tool-registry.test.ts` hashes
// them all and fails if any differs, and it asserts how many it found, because
// a copy-scanning guard that matches nothing reports green.
//
// It exists in copies rather than a shared package because these files are
// otherwise independent per-package networking layers; a guard proving the
// copies are identical is cheaper and safer than the import graph a shared
// package would need across `crawler`, `computer-use-driver` and ten tools.
//
// WHY IT PARSES INSTEAD OF MATCHING TEXT. Six copies were confirmed
// exploitable on 2026-09-18 because they compared address STRINGS. The WHATWG
// URL parser rewrites `[::ffff:169.254.169.254]` to `[::ffff:a9fe:a9fe]`, so a
// text check never sees the spelling it was written for; and `64:ff9b::a9fe:a9fe`
// IS 169.254.169.254 on any network running DNS64/NAT64. Parsing numerically and
// recursing into the embedded IPv4 is the only form that holds.
//
// WHAT IT CANNOT DO. RFC 6052 lets an operator choose any Network-Specific
// Prefix for NAT64, so an embedded IPv4 behind an arbitrary NSP is undecidable
// from the address alone. That case is configuration, and the callers that need
// it resolve the host and re-check the ANSWER before dialling.
// ---------------------------------------------------------------------------
/**
 * Canonicalise an IPv4 literal.
 *
 * `inet_aton` forms are the classic allow-list bypass: `0177.0.0.1`,
 * `0x7f.0.0.1`, `2130706433` and `127.1` are all 127.0.0.1, and a check that
 * only understands dotted-decimal waves every one of them through. Returns
 * `null` when the string is not an IPv4 literal at all.
 */
export function normalizeIpv4(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "" || /[^0-9a-fA-FxX.]/.test(trimmed)) return null;
  const parts = trimmed.split(".");
  if (parts.length === 0 || parts.length > 4) return null;

  const values: number[] = [];
  for (const part of parts) {
    if (part === "") return null;
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) value = Number.parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) value = Number.parseInt(part.slice(1), 8);
    else if (/^\d+$/.test(part)) value = Number.parseInt(part, 10);
    else return null;
    if (!Number.isFinite(value) || value < 0) return null;
    values.push(value);
  }

  // The short forms pack the remaining octets into the last part: `127.1` is
  // 127.0.0.1, not 127.1.0.0. Getting this backwards is how a bypass survives.
  const last = values[values.length - 1] as number;
  const leading = values.slice(0, -1);
  if (leading.some((v) => v > 255)) return null;
  const remaining = 4 - leading.length;
  if (last >= 2 ** (8 * remaining)) return null;

  const octets = [...leading];
  for (let i = remaining - 1; i >= 0; i--) octets.push((last >>> (8 * i)) & 0xff);
  return octets.join(".");
}

/**
 * Expand an IPv6 literal to its eight 16-bit groups, or `null` when the string
 * is not one.
 *
 * Classifying IPv6 by its TEXT is where the bypasses live, because one address
 * has many spellings and the one a check was written against is rarely the one
 * that arrives. `http://[::ffff:169.254.169.254]/` never reaches a guard in
 * that form: the WHATWG URL parser re-serialises the embedded quad as hex
 * pieces, so what the guard sees is `::ffff:a9fe:a9fe`. Normalising to numbers
 * first means the prefix tests below are arithmetic, and spelling stops
 * mattering.
 */
export function parseIpv6(raw: string): ReadonlyArray<number> | null {
  let text = raw.trim().toLowerCase();
  if (text.startsWith("[")) text = text.slice(1);
  if (text.endsWith("]")) text = text.slice(0, -1);
  const zone = text.indexOf("%"); // fe80::1%eth0
  if (zone !== -1) text = text.slice(0, zone);
  if (!text.includes(":")) return null;

  // A trailing dotted quad is the last two groups written in IPv4. Require all
  // three dots: without that, `::1` parses as a one-part inet_aton address and
  // takes a path that has nothing to do with what was written.
  const dotted = /^(.*:)(\d+(?:\.\d+){3})$/.exec(text);
  if (dotted !== null) {
    const quad = normalizeIpv4(dotted[2] as string);
    if (quad === null) return null;
    const o = quad.split(".").map((n) => Number.parseInt(n, 10)) as number[];
    const hi = ((o[0] as number) << 8) | (o[1] as number);
    const lo = ((o[2] as number) << 8) | (o[3] as number);
    text = `${dotted[1]}${hi.toString(16)}:${lo.toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const pieces = (part: string): string[] => (part === "" ? [] : part.split(":"));
  const head = pieces(halves[0] as string);
  const tail = halves.length === 2 ? pieces(halves[1] as string) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (head.length + tail.length > 8) return null;

  const groups: number[] = [];
  for (const piece of head) {
    if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
    groups.push(Number.parseInt(piece, 16));
  }
  for (let i = head.length + tail.length; i < 8; i++) groups.push(0);
  for (const piece of tail) {
    if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
    groups.push(Number.parseInt(piece, 16));
  }
  return groups.length === 8 ? groups : null;
}

/**
 * The IPv4 address an IPv6 address carries, when it carries one.
 *
 * Every transition mechanism embeds a v4 address somewhere, and every one of
 * them is a way to reach a v4 destination while wearing a v6 spelling that no
 * v4 range check looks at. The NAT64 well-known prefix is the sharpest: a
 * DNS64 resolver answers an IPv4-only name with `64:ff9b::<the v4>`, so
 * `64:ff9b::a9fe:a9fe` IS the metadata service on any network that runs one.
 */
function embeddedIpv4(g: ReadonlyArray<number>): string | null {
  const quad = (hi: number, lo: number): string =>
    `${(hi >>> 8) & 0xff}.${hi & 0xff}.${(lo >>> 8) & 0xff}.${lo & 0xff}`;
  const zeros = (from: number, to: number): boolean => g.slice(from, to).every((x) => x === 0);
  const last = quad(g[6] as number, g[7] as number);

  if (zeros(0, 5) && g[5] === 0xffff) return last; // ::ffff:0:0/96, IPv4-mapped
  if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) return last; // ::ffff:0:0:0/96, translated
  if (g[0] === 0x64 && g[1] === 0xff9b) return last; // 64:ff9b::/96 and 64:ff9b:1::/48, NAT64
  if (g[0] === 0x2002) return quad(g[1] as number, g[2] as number); // 2002::/16, 6to4
  // ::a.b.c.d, IPv4-compatible: deprecated, still routed by some stacks, and
  // not to be confused with `::` or `::1`, which are handled before this.
  if (zeros(0, 6)) return last;
  return null;
}

/** Ranges that are never a public RPC endpoint. */
export function isPrivateIp(address: string): boolean {
  const v4 = normalizeIpv4(address);
  if (v4 !== null) {
    const [a = 0, b = 0, c = 0, d = 0] = v4.split(".").map((n) => Number.parseInt(n, 10));
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local, and the metadata service
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0 && c === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast, reserved, broadcast
    return a === 255 && b === 255 && c === 255 && d === 255;
  }

  const groups = parseIpv6(address);
  if (groups === null) return false;
  if (groups.every((g) => g === 0)) return true; // ::, the unspecified address
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1

  const carried = embeddedIpv4(groups);
  if (carried !== null) return isPrivateIp(carried);

  const head = groups[0] as number;
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7, unique-local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10, link-local
  return (head & 0xff00) === 0xff00; // ff00::/8, multicast
}
// END SYNCHRONISED BLOCK

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

/**
 * True when the NAME exists, whether or not it leads anywhere.
 *
 * `existsSync` follows symlinks, so it answers false for a link whose target
 * is missing — and that is exactly the case that matters: a walk probing with
 * it strides past the link, treats it as a plain missing leaf, and re-appends
 * the name to the realpath'd parent, so containment is decided on a path the
 * link does not lead to. `lstat` keeps the name in the part that is RESOLVED.
 */
function nameExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where `target` would actually land, with every symlink already followed —
 * including one whose own target does not exist yet.
 *
 * Mirrors the resolver the tool packages share (see
 * `@crewhaus/tool-fsx/src/paths.ts`); the crawler carries its own copy
 * because it checks against a LIST of allowed roots rather than one
 * workspace root. `realpathSync` gives up with ENOENT on a dangling link, so
 * the deepest ancestor that exists as a name is resolved, a dangling one is
 * followed a hop by hand, and the missing components are appended.
 */
function resolveLocation(target: string, depth = 0): string {
  if (depth > 40) throw new Error(`symlink chain at "${target}" is too long to resolve`);
  let probe = target;
  const tail: string[] = [];
  while (!nameExists(probe)) {
    tail.unshift(basename(probe));
    const parent = dirname(probe);
    if (parent === probe) break; // reached filesystem root
    probe = parent;
  }
  let probeReal: string;
  try {
    probeReal = realpathSync(probe);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // The name is there but `realpath` cannot finish it: a dangling link.
    // Recursing (rather than returning the raw target) is what resolves an
    // absolute target such as /var/... to its real /private/var/... form.
    const link = readlinkSync(probe);
    // A RELATIVE target resolves against the directory that actually CONTAINS
    // the link, not its lexical parent — they differ when that parent is
    // itself a symlink — so the parent is made real first.
    const base = realpathSync(dirname(probe));
    probeReal = resolveLocation(resolvePath(base, link), depth + 1);
  }
  return tail.length > 0 ? joinPath(probeReal, ...tail) : probeReal;
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
    //    escaping paths never leak existence), so `resolveLocation` resolves
    //    the deepest ancestor that EXISTS AS A NAME and re-appends the tail.
    let realAbs: string;
    try {
      realAbs = resolveLocation(abs);
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
 * Projection used to compare a cited snippet against the fetched body.
 *
 * "Verbatim" cannot mean byte-identical. A model quoting a hard-wrapped
 * source re-flows it onto one line, so the newline in the body arrives as a
 * space in the snippet — and the report renderer itself collapses newlines
 * when it prints a snippet (`report-writer`). So both sides are compared
 * after NFC normalization with every run of whitespace (newlines, tabs,
 * NBSP, …) collapsed to a single space.
 *
 * Everything else stays significant: case, punctuation, word order, numbers.
 * Those are exactly what a fabricated quote gets wrong.
 */
export function normalizeForVerbatimMatch(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** True iff `snippet` occurs in `body` up to whitespace/line-wrapping. */
export function snippetOccursInBody(body: string, snippet: string): boolean {
  const needle = normalizeForVerbatimMatch(snippet);
  // A whitespace-only snippet normalizes to "", which `includes` would accept
  // against ANY body — that is the degenerate always-true citation.
  if (needle === "") return false;
  return normalizeForVerbatimMatch(body).includes(needle);
}

/**
 * Build a `CiteFact(uri, snippet, supportingClaim?)` tool the agent
 * calls to record a citation. Each call appends one citation row in
 * the run's tracker; report-writer numbers them by URL on first
 * appearance.
 *
 * The snippet is VERIFIED against the body the tracker cached for `uri`
 * before anything is recorded. A citation is a claim about bytes the run
 * actually holds: recording an unverified snippet would stamp a real URL and
 * a real content sha256 next to text that never appeared at that URL, which
 * is worse than no citation at all. A failed check returns a corrective tool
 * result (same idiom as `Source`'s `[Source error] …`) rather than throwing,
 * so the model can re-quote and try again inside the same turn.
 */
export function createCiteFactTool(opts: {
  readonly tracker: CitationTracker;
  readonly currentBranchId?: () => string | undefined;
}): RegisteredTool {
  return buildTool({
    name: "CiteFact",
    description:
      "Record a fact you want cited in the final report. Pass the source `uri` you fetched via Source, the verbatim `snippet` from that source, and optionally a one-line `supportingClaim` describing what the snippet supports. The snippet is checked against the body Source loaded for that uri — a quote that does not appear there is REFUSED and nothing is recorded. The orchestrator turns accepted citations into numbered citations [1], [2], … in the final report.",
    inputSchema: z
      .object({
        uri: z.string().min(1).describe("Source URL or file:// path you previously loaded."),
        snippet: z
          .string()
          .min(1)
          .describe(
            "Verbatim quote copied from the source body — keep it short, ideally one sentence. Verified against the loaded body; only whitespace/line-wrapping may differ.",
          ),
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
      const body = opts.tracker.getFetchedContent(input.uri);
      if (body === undefined) {
        // Two different failures land here. Usually the agent never loaded the
        // uri at all (it invented one, or typed it differently than it fetched
        // it). Rarely the run HAS a fetch record but the cached body is gone
        // and the source has changed since, so there is nothing left to check
        // the quote against — still a refusal, but say which one it is.
        if (opts.tracker.getFetchRecord(input.uri) !== undefined) {
          return `[CiteFact rejected] the body originally loaded from ${input.uri} is no longer available in this run's cache, so the snippet cannot be verified against the bytes that were recorded. Nothing was recorded.`;
        }
        return `[CiteFact rejected] nothing has been loaded for ${input.uri} in this run, so the snippet cannot be verified. Call Source("${input.uri}") first and cite from the body it returns. Nothing was recorded.`;
      }
      if (!snippetOccursInBody(body, input.snippet)) {
        return `[CiteFact rejected] that snippet does not appear in the body loaded from ${input.uri}. Copy an exact span of text out of that body — only whitespace and line-wrapping may differ. Nothing was recorded.`;
      }
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
