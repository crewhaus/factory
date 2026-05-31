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
  const raw = input.allowedDomains ?? input.allowed_domains ?? [];
  webFetchConfig = { allowedDomains: raw.map((d) => d.toLowerCase()) };
}

export function getWebFetchConfig(): WebFetchConfig {
  return webFetchConfig;
}

export function _resetWebFetchConfig(): void {
  webFetchConfig = { allowedDomains: [] };
}

function isHostAllowed(host: string): boolean {
  if (webFetchConfig.allowedDomains.length === 0) return true;
  const lower = host.toLowerCase();
  return webFetchConfig.allowedDomains.some(
    (entry) => lower === entry || lower.endsWith(`.${entry}`),
  );
}

// ─── WebFetch ─────────────────────────────────────────────────────────

const webFetchSchema = z.object({
  url: z.string().min(1),
  prompt: z.string().optional(),
});

export type RawFetch = (req: Request) => Promise<Response>;
let rawFetch: RawFetch = (req) => globalThis.fetch(req);
export function _setRawFetch(fn: RawFetch | undefined): void {
  rawFetch = fn ?? ((req) => globalThis.fetch(req));
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

async function performWebFetch(initialUrl: URL, signal: AbortSignal): Promise<Response> {
  let currentUrl = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (currentUrl.protocol !== "http:" && currentUrl.protocol !== "https:") {
      throw new WebFetchPermissionError(
        `WebFetch denied: scheme "${currentUrl.protocol}" — only http/https allowed`,
      );
    }
    if (!isHostAllowed(currentUrl.hostname)) {
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
      res = await performWebFetch(url, ctrl.signal);
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
  const res = await rawFetch(
    new Request(url, {
      headers: { accept: "application/json", "x-subscription-token": apiKey },
      signal,
    }),
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
