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
  operativeArgs: [{ field: "url", kind: "url" }],
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
  operativeArgs: [{ field: "query", kind: "text" }],
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
