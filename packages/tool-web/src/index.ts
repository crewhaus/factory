import { lookup as dnsLookup } from "node:dns/promises";
import { CrewhausError } from "@crewhaus/errors";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { load as loadHtml } from "cheerio";
import TurndownService from "turndown";
import { z } from "zod";

/**
 * Section 14 — `WebFetch` and `WebSearch`.
 *
 * `WebFetch(url, prompt?)`:
 *   - Validates http/https scheme.
 *   - Optional allow-list via `getWebFetchConfig().allowedDomains`. When
 *     non-empty, host must equal an entry or be a subdomain of one.
 *   - SSRF guard (independent of the allow-list, re-checked on every
 *     redirect hop): rejects loopback, link-local / 169.254.0.0/16,
 *     RFC1918, CGNAT, *.local / *.localhost, and DNS-rebinding targets.
 *   - Manual redirect handling, max 5; allow-list re-checked at every hop.
 *   - 30 s default timeout (`AbortController`, honours `ctx.signal`).
 *   - 5 MB response body cap.
 *   - HTML pages run through cheerio + turndown to produce markdown that
 *     compresses well in the model's context. Plain text and JSON pass
 *     through. Other content types are summarised in one line.
 *   - When `prompt` is supplied, we DO NOT recursively call the model
 *     from inside the tool — that would fight runtime-core's loop. The
 *     prompt is prepended to the markdown ("[user prompt: ...]") so the
 *     parent agent sees both pieces and can reason about them in its
 *     next assistant turn. Documented behaviour, matching the
 *     claude-code/tools/WebFetchTool design.
 *
 * `WebSearch(query, allowed_domains?, blocked_domains?)`:
 *   - Anthropic server-side `web_search` is the preferred path. The
 *     model adapter doesn't yet expose `model.features.web_search`
 *     (Section 17), so for now this tool dispatches to a configurable
 *     third-party provider via env: `CREWHAUS_SEARCH_PROVIDER` ∈
 *     {brave, tavily} plus `CREWHAUS_SEARCH_API_KEY`. When neither is
 *     set, returns a clean refusal so the model can either skip search
 *     or surface the missing-config to the user.
 *
 * Layer R4. Pairs with the `target-cli` codegen contract — `BUILTIN_TOOL_MAP`
 * has `webFetch: { initSymbol: "registerWebFetchConfig" }` and
 * `webSearch: { ... }` (no init — uses env-only config).
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export class WebFetchPermissionError extends CrewhausError {
  override readonly name = "WebFetchPermissionError";
  constructor(message: string) {
    super("tool", message);
  }
}

// ─── WebFetch config registry ──────────────────────────────────────────

export type WebFetchConfig = {
  /**
   * Allowed domains (host suffixes). Empty = allow all. A request to host
   * `<h>` is permitted iff `h` equals an entry exactly, or `h` ends with
   * `.<entry>`. Hosts are compared case-insensitively.
   */
  readonly allowedDomains: readonly string[];
};

let webFetchConfig: WebFetchConfig = { allowedDomains: [] };

export type WebFetchConfigInput = {
  readonly allowed_domains?: readonly string[];
  readonly allowedDomains?: readonly string[];
};

export function registerWebFetchConfig(input: WebFetchConfigInput): void {
  webFetchConfig = buildWebFetchConfig(input);
}

function buildWebFetchConfig(input: WebFetchConfigInput): WebFetchConfig {
  const raw = input.allowedDomains ?? input.allowed_domains ?? [];
  return { allowedDomains: raw.map((d) => d.toLowerCase()) };
}

/**
 * 0.6.0 §4.4 — the config ONE call runs under: the serving candidate's
 * `tool_config.webFetch` block when its profile declares one
 * (`ToolExecuteContext.toolConfig`, REPLACING the registered block for this
 * call exactly as `registerWebFetchConfig` replaces it at boot), else the
 * process-global registration. A non-object override is ignored.
 */
export function resolveWebFetchConfig(override: unknown): WebFetchConfig {
  if (typeof override === "object" && override !== null && !Array.isArray(override)) {
    return buildWebFetchConfig(override as WebFetchConfigInput);
  }
  return webFetchConfig;
}

export function getWebFetchConfig(): WebFetchConfig {
  return webFetchConfig;
}

export function _resetWebFetchConfig(): void {
  webFetchConfig = { allowedDomains: [] };
}

function isHostAllowed(host: string, cfg: WebFetchConfig): boolean {
  if (cfg.allowedDomains.length === 0) return true;
  const lower = host.toLowerCase();
  return cfg.allowedDomains.some((entry) => lower === entry || lower.endsWith(`.${entry}`));
}

// ─── SSRF guard ─────────────────────────────────────────────────────────
// Defence-in-depth, INDEPENDENT of the allow-list. WebFetch is reachable
// with model-/prompt-influenced URLs; without this guard an empty allow-list
// (the documented default) lets an attacker pivot to cloud-metadata
// (169.254.169.254), loopback, or RFC1918 services. Mirrors tool-fetch's
// `assertNotSsrf`, including the DNS-resolution backstop for rebinding.

/**
 * DNS resolver injection point used by tests. Production callers leave it at
 * `dnsLookup` from `node:dns/promises`; tests stub it to assert the rebinding
 * path or to keep the suite offline.
 */
export type DnsLookupFn = (
  host: string,
) => Promise<{ readonly address: string; readonly family: number }>;
// Production default — a single named function shared by both the initial
// binding and the `_setDnsLookup(undefined)` reset path, so there is one
// resolver definition to reason about (and to cover) rather than two
// duplicate closures.
const defaultDnsLookup: DnsLookupFn = (host) => dnsLookup(host, { verbatim: false });
let dnsLookupFn: DnsLookupFn = defaultDnsLookup;
export function _setDnsLookup(fn: DnsLookupFn | undefined): void {
  dnsLookupFn = fn ?? defaultDnsLookup;
}

// Normalise octal/hex/integer IPv4 literals (e.g. 0177.0.0.1, 0x7f000001,
// 2130706433) to dotted-decimal so isPrivateIp can classify them — browsers
// and many HTTP stacks accept these forms, which would otherwise bypass a
// naive dotted-only check. Mirrors @crewhaus/tool-fetch / crawler.
function normalizeIpv4(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parseComponent = (s: string): number | null => {
    if (s === "") return null;
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(s)) value = Number.parseInt(s.slice(2), 16);
    else if (/^0[0-7]+$/.test(s)) value = Number.parseInt(s, 8);
    else if (/^[0-9]+$/.test(s)) value = Number.parseInt(s, 10);
    else return null;
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

  if (lowerIp === "::" || lowerIp === "::1") return true; // IPv6 unspecified / loopback
  if (lowerIp.startsWith("fe80:")) return true; // IPv6 link-local
  if (lowerIp.startsWith("fc") || lowerIp.startsWith("fd")) return true; // IPv6 unique-local

  // IPv4-mapped IPv6 — both dotted (::ffff:127.0.0.1) AND hex-compressed
  // (::ffff:7f00:1, which `new URL` normalizes [::ffff:127.0.0.1] into).
  const mapped = lowerIp.match(/^::ffff:(.+)$/);
  if (mapped) {
    const tail = mapped[1] as string;
    if (tail.includes(".")) return isPrivateIp(tail);
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
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
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

/**
 * Reject any host that is — or resolves to — a private/loopback/link-local
 * address. Applied at the initial URL and at every redirect hop, regardless
 * of the allow-list. Fails closed if the name cannot be resolved.
 *
 * Returns the validated IP so the caller can PIN the connection to that exact
 * address — resolving here and letting the default `fetch` re-resolve at
 * connect time is a DNS-rebinding TOCTOU (CWE-367): a hostile resolver can
 * answer public for this check and private for the socket. For an IP-literal
 * host the pinned value is the (normalized) literal itself.
 */
async function assertNotSsrf(hostname: string): Promise<string> {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) {
    throw new WebFetchPermissionError(`WebFetch denied: host "${hostname}" resolves to loopback`);
  }
  if (lower.endsWith(".local")) {
    throw new WebFetchPermissionError(`WebFetch denied: mDNS host "${hostname}" is not allowed`);
  }
  const unbracketed = lower.replace(/^\[/, "").replace(/\]$/, "");
  if (isPrivateIp(unbracketed)) {
    throw new WebFetchPermissionError(
      `WebFetch denied: host "${hostname}" is a private/loopback IP`,
    );
  }
  // An IP literal is its own pinned target — nothing to resolve or rebind.
  const literal = normalizeIpv4(unbracketed) ?? (unbracketed.includes(":") ? unbracketed : null);
  if (literal !== null) return literal;
  // Resolve so a public-looking name pointing at an internal IP (DNS
  // rebinding) is still caught — and return the address so the caller dials it.
  let resolved: { readonly address: string; readonly family: number };
  try {
    resolved = await dnsLookupFn(lower);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new WebFetchPermissionError(`WebFetch denied: cannot resolve "${hostname}": ${msg}`);
  }
  if (isPrivateIp(resolved.address)) {
    throw new WebFetchPermissionError(
      `WebFetch denied: host "${hostname}" resolves to private IP ${resolved.address}`,
    );
  }
  return resolved.address;
}

// ─── WebFetch ─────────────────────────────────────────────────────────

const webFetchSchema = z.object({
  url: z.string().min(1),
  prompt: z.string().optional(),
});

/**
 * `pinnedIp` is the address `assertNotSsrf` validated for the request's host
 * (empty string ⇒ no pin, e.g. fixed trusted API hosts). The production
 * fetcher dials that exact IP, preserving the Host header and TLS SNI, so the
 * socket can't be rebound to a private address between the SSRF check and
 * connect. Test stubs may ignore the argument.
 */
export type RawFetch = (req: Request, pinnedIp: string) => Promise<Response>;

// Dial `pinnedIp` directly while keeping the real host for the Host header and
// TLS SNI. Mirrors @crewhaus/tool-fetch.
function pinnedFetch(req: Request, pinnedIp: string): Promise<Response> {
  const original = new URL(req.url);
  const host = original.hostname;
  const hostUnbracketed = host.replace(/^\[/, "").replace(/\]$/, "");
  if (pinnedIp === "" || hostUnbracketed === pinnedIp) {
    return globalThis.fetch(req);
  }
  const hostForUrl = pinnedIp.includes(":") ? `[${pinnedIp}]` : pinnedIp;
  const pinnedUrl = new URL(original.toString());
  pinnedUrl.hostname = hostForUrl;
  const headers = new Headers(req.headers);
  headers.set("host", original.port === "" ? host : `${host}:${original.port}`);
  const init: RequestInit & { tls?: { serverName: string } } = {
    method: req.method,
    headers,
    redirect: "manual",
    signal: req.signal,
    tls: { serverName: host },
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    (init as { duplex?: string }).duplex = "half";
  }
  return globalThis.fetch(pinnedUrl.toString(), init);
}

// Production default — one named fetcher shared by the initial binding and the
// `_setRawFetch(undefined)` reset path (see defaultDnsLookup for rationale).
const defaultRawFetch: RawFetch = pinnedFetch;
let rawFetch: RawFetch = defaultRawFetch;
export function _setRawFetch(fn: RawFetch | undefined): void {
  rawFetch = fn ?? defaultRawFetch;
}

async function readBodyCapped(res: Response): Promise<string> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new WebFetchPermissionError(
          `response body exceeded ${MAX_BODY_BYTES} bytes — aborted`,
        );
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

async function performWebFetch(
  initialUrl: URL,
  signal: AbortSignal,
  cfg: WebFetchConfig,
): Promise<Response> {
  let currentUrl = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (currentUrl.protocol !== "http:" && currentUrl.protocol !== "https:") {
      throw new WebFetchPermissionError(
        `WebFetch denied: scheme "${currentUrl.protocol}" — only http/https allowed`,
      );
    }
    // SSRF guard — independent of the allow-list, enforced on every hop.
    // The returned IP pins the socket so a rebinding resolver can't swap in a
    // private address between this check and connect.
    const pinnedIp = await assertNotSsrf(currentUrl.hostname);
    if (!isHostAllowed(currentUrl.hostname, cfg)) {
      throw new WebFetchPermissionError(
        `WebFetch denied: host "${currentUrl.hostname}" is not in allowed_domains`,
      );
    }

    const res = await rawFetch(
      new Request(currentUrl.toString(), {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { "user-agent": "crewhaus-tool-web/0.1" },
      }),
      pinnedIp,
    );
    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      const loc = res.headers.get("location") ?? "";
      let next: URL;
      try {
        next = new URL(loc, currentUrl);
      } catch {
        throw new WebFetchPermissionError(`invalid redirect target "${loc}"`);
      }
      currentUrl = next;
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      continue;
    }
    return res;
  }
  throw new WebFetchPermissionError(`too many redirects (>${MAX_REDIRECTS})`);
}

/**
 * Convert HTML into compact markdown via cheerio + turndown. Strips
 * script/style/noscript before conversion so non-content noise doesn't
 * blow out the result.
 */
export function htmlToMarkdown(html: string): string {
  const $ = loadHtml(html);
  $("script, style, noscript, link, iframe, svg").remove();
  // Prefer <main> / <article> when present so we don't drag headers/footers in.
  let bodyHtml = $("article").first().html();
  if (bodyHtml === null || bodyHtml === undefined) bodyHtml = $("main").first().html();
  if (bodyHtml === null || bodyHtml === undefined) bodyHtml = $("body").html();
  if (bodyHtml === null || bodyHtml === undefined) bodyHtml = html;
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  return turndown.turndown(bodyHtml).trim();
}

export const webFetch: RegisteredTool = buildTool({
  name: "WebFetch",
  description:
    "Fetch an http(s) URL and return its content. HTML is converted to compact markdown; plain text and JSON pass through. ≤5 MB body, ≤5 redirects, 30 s timeout. Optional allow-list via WebFetch.allowed_domains in the spec's tool_config block.",
  inputSchema: webFetchSchema,
  readOnly: true,
  concurrencySafe: true,
  // Pillar 3 sink-side: URL parameters can encode exfiltrated data ("Safe URL"
  // pattern from OpenAI's 2026-05 prompt-injection paper).
  scope: "external",
  // FR-002 — declare the io-capability fact (HTTP fetch) for the audit.
  ioCapability: "network",
  execute: async (input, ctx) => {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new WebFetchPermissionError(`invalid URL "${input.url}"`);
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("fetch timeout")), DEFAULT_TIMEOUT_MS);
    if (ctx?.signal !== undefined) {
      if (ctx.signal.aborted) ctrl.abort(ctx.signal.reason);
      else
        ctx.signal.addEventListener("abort", () => ctrl.abort(ctx.signal?.reason), {
          once: true,
        });
    }
    let res: Response;
    try {
      res = await performWebFetch(url, ctrl.signal, resolveWebFetchConfig(ctx?.toolConfig));
    } finally {
      clearTimeout(timer);
    }
    const body = await readBodyCapped(res);
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    let content: string;
    if (ct.includes("text/html") || ct.includes("application/xhtml")) {
      content = htmlToMarkdown(body);
    } else if (
      ct.includes("text/plain") ||
      ct.includes("application/json") ||
      ct === "" ||
      ct.startsWith("text/")
    ) {
      content = body;
    } else {
      content = `[non-textual content: ${ct}, ${body.length} bytes — not displayed]`;
    }
    const header = `URL: ${url.toString()}\nStatus: ${res.status}\nContent-Type: ${ct}\n\n`;
    if (input.prompt !== undefined && input.prompt !== "") {
      return `${header}[user prompt: ${input.prompt}]\n\n${content}`;
    }
    return `${header}${content}`;
  },
});

// ─── WebSearch ─────────────────────────────────────────────────────────

const webSearchSchema = z.object({
  query: z.string().min(1),
  allowed_domains: z.array(z.string()).optional(),
  blocked_domains: z.array(z.string()).optional(),
});

type SearchHit = {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
};

/**
 * Provider dispatch. Anthropic server-side `web_search` lands when Section
 * 17 (multi-provider model layer) introduces `model.features.web_search`.
 * Until then, dispatch to a third-party provider via env. When neither
 * env var is set, return a clean refusal so the model handles it
 * gracefully.
 */
async function dispatchSearch(
  query: string,
  allowed: readonly string[] | undefined,
  blocked: readonly string[] | undefined,
  signal: AbortSignal,
): Promise<readonly SearchHit[] | string> {
  const provider = (process.env["CREWHAUS_SEARCH_PROVIDER"] ?? "").toLowerCase();
  const apiKey = process.env["CREWHAUS_SEARCH_API_KEY"] ?? "";
  if (provider === "" || apiKey === "") {
    return "WebSearch unavailable: set CREWHAUS_SEARCH_PROVIDER (brave|tavily) and CREWHAUS_SEARCH_API_KEY in the environment.";
  }
  if (provider === "brave") return braveSearch(query, apiKey, allowed, blocked, signal);
  if (provider === "tavily") return tavilySearch(query, apiKey, allowed, blocked, signal);
  return `WebSearch unavailable: unknown provider "${provider}" — supported: brave, tavily.`;
}

async function braveSearch(
  query: string,
  apiKey: string,
  allowed: readonly string[] | undefined,
  blocked: readonly string[] | undefined,
  signal: AbortSignal,
): Promise<readonly SearchHit[]> {
  const params = new URLSearchParams({ q: query, count: "10" });
  // Brave uses a single `result_filter` and per-request goggles; treat
  // allowed/blocked as advisory hints rather than binding constraints
  // (the provider doesn't enforce them server-side).
  const url = `https://api.search.brave.com/res/v1/web/search?${params.toString()}`;
  // Fixed, trusted API host — not model-controlled, so no SSRF pin needed.
  const res = await rawFetch(
    new Request(url, {
      headers: { accept: "application/json", "x-subscription-token": apiKey },
      signal,
    }),
    "",
  );
  if (!res.ok) {
    throw new WebFetchPermissionError(`Brave search failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as { web?: { results?: BraveResult[] } };
  const raw = json.web?.results ?? [];
  return raw
    .map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: r.description ?? "" }))
    .filter((h) => filterByDomains(h.url, allowed, blocked));
}

interface BraveResult {
  readonly title?: string;
  readonly url?: string;
  readonly description?: string;
}

async function tavilySearch(
  query: string,
  apiKey: string,
  allowed: readonly string[] | undefined,
  blocked: readonly string[] | undefined,
  signal: AbortSignal,
): Promise<readonly SearchHit[]> {
  const res = await rawFetch(
    new Request("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: 10,
        ...(allowed !== undefined ? { include_domains: allowed } : {}),
        ...(blocked !== undefined ? { exclude_domains: blocked } : {}),
      }),
      signal,
    }),
    // Fixed, trusted API host — not model-controlled, so no SSRF pin needed.
    "",
  );
  if (!res.ok) {
    throw new WebFetchPermissionError(`Tavily search failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as { results?: TavilyResult[] };
  const raw = json.results ?? [];
  return raw
    .map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: r.content ?? "" }))
    .filter((h) => filterByDomains(h.url, allowed, blocked));
}

interface TavilyResult {
  readonly title?: string;
  readonly url?: string;
  readonly content?: string;
}

function filterByDomains(
  hitUrl: string,
  allowed: readonly string[] | undefined,
  blocked: readonly string[] | undefined,
): boolean {
  let host: string;
  try {
    host = new URL(hitUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (blocked?.some((b) => host === b.toLowerCase() || host.endsWith(`.${b.toLowerCase()}`))) {
    return false;
  }
  if (allowed && allowed.length > 0) {
    return allowed.some((a) => host === a.toLowerCase() || host.endsWith(`.${a.toLowerCase()}`));
  }
  return true;
}

function formatHits(hits: readonly SearchHit[]): string {
  if (hits.length === 0) return "[no results]";
  return hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join("\n\n");
}

export const webSearch: RegisteredTool = buildTool({
  name: "WebSearch",
  description:
    "Search the web for up-to-date information. Provider chosen via the CREWHAUS_SEARCH_PROVIDER env var (brave or tavily); CREWHAUS_SEARCH_API_KEY supplies the credential. Returns a numbered list of {title, url, snippet}. Optional allowed_domains / blocked_domains filter the results.",
  inputSchema: webSearchSchema,
  readOnly: true,
  concurrencySafe: true,
  // Pillar 3 sink-side: search-query parameter is an exfiltration vector.
  scope: "external",
  // FR-002 — declare the io-capability fact (remote search API) for the audit.
  ioCapability: "network",
  execute: async (input, ctx) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("search timeout")), DEFAULT_TIMEOUT_MS);
    if (ctx?.signal !== undefined) {
      if (ctx.signal.aborted) ctrl.abort(ctx.signal.reason);
      else
        ctx.signal.addEventListener("abort", () => ctrl.abort(ctx.signal?.reason), {
          once: true,
        });
    }
    try {
      const result = await dispatchSearch(
        input.query,
        input.allowed_domains,
        input.blocked_domains,
        ctrl.signal,
      );
      if (typeof result === "string") return result;
      return formatHits(result);
    } finally {
      clearTimeout(timer);
    }
  },
});
