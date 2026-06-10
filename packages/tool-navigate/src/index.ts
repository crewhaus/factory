/**
 * Catalog R4 `tool-navigate` — Section 25 BROW.
 *
 * `Navigate(url)` tool. Drives `driver.goto(url)` so the browser agent
 * can bootstrap to a starting page. Returns a short text confirmation
 * the model can read back; surfaces playwright errors verbatim (e.g.
 * unreachable host, navigation timeout) so the model can recover or
 * report the failure.
 *
 * Flag profile: `destructive: false` (default-allowed). Navigation is
 * the agent's only bootstrap path — gating it behind an `alwaysAllow`
 * rule would silently break every spec that doesn't define one. The
 * §3 permission-engine still applies the user's explicit `alwaysDeny`
 * rules; Click/Type/Key/Scroll stay destructive-by-default in
 * `tool-mouse-keyboard`.
 *
 * Scope is `"external"` because the URL request crosses a network
 * boundary. Before handing the URL to the browser we run an SSRF guard
 * (`assertSafeNavigationTarget`): the model picks this URL and the model
 * is prompt-injectable, so an attacker who controls any untrusted input
 * (a channel message, fetched page, MCP result) could otherwise steer it
 * to `file:///etc/passwd`, `http://169.254.169.254/…` (cloud metadata) or
 * a loopback admin port and read the result back via `Screenshot`. Output
 * classification is off — the response is a deterministic short string,
 * not model-generated content.
 */
import { lookup as nodeDnsLookup } from "node:dns/promises";
import type { Driver } from "@crewhaus/computer-use-driver";
import { CrewhausError } from "@crewhaus/errors";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolResultContent } from "@crewhaus/tool-catalog";
import { z } from "zod";

export class NavigateError extends CrewhausError {
  override readonly name = "NavigateError";
  constructor(message: string, cause?: unknown) {
    super("tool", message, cause);
  }
}

const navigateSchema = z
  .object({
    /** Absolute URL to navigate to (http/https). */
    url: z.string().url(),
  })
  .strict();

/** Only real web schemes — blocks file:, gopher:, chrome:, data:, about:, etc. */
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

export type DnsLookupFn = (
  hostname: string,
) => Promise<{ readonly address: string; readonly family: number }>;

let dnsLookupFn: DnsLookupFn = nodeDnsLookup;

/** Test hook: override DNS resolution. Pass `undefined` to restore the default. */
export function _setDnsLookup(fn: DnsLookupFn | undefined): void {
  dnsLookupFn = fn ?? nodeDnsLookup;
}

/**
 * SSRF defenses below mirror `@crewhaus/tool-fetch` (`isPrivateIp` /
 * `normalizeIpv4`). They are duplicated rather than imported to avoid
 * coupling the browser bundle to tool-fetch's module-level config state —
 * keep the copies in sync. The IPv4-mapped IPv6 handling (`::ffff:…`, both
 * dotted and hex-compressed) is load-bearing: `new URL` normalizes
 * `http://[::ffff:127.0.0.1]/` to `[::ffff:7f00:1]`, which would otherwise
 * slip past a naive loopback check.
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

  // IPv6 unspecified / loopback / link-local / unique-local
  if (lowerIp === "::" || lowerIp === "::1") return true;
  if (lowerIp.startsWith("fe80:")) return true;
  if (lowerIp.startsWith("fc") || lowerIp.startsWith("fd")) return true;

  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 / ::ffff:7f00:1) — classify by
  // the embedded IPv4 address so a mapped literal can't smuggle past.
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

  // IPv4 — normalise octal/hex/integer literals to dotted-decimal first.
  const normalized = normalizeIpv4(ip);
  if (normalized === null) return false;
  const parts = normalized.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((nn) => Number.isNaN(nn) || nn < 0 || nn > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];

  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 RFC1918
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + AWS metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT (RFC6598)
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24 (RFC6890)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (RFC2544)
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

/**
 * Reject anything that isn't a public http/https target before the browser
 * sees it. Note: Playwright re-resolves DNS at connect time, so a hostile
 * resolver could still rebind a public name to a private IP after this check
 * (the classic DNS-rebinding TOCTOU). Fully closing that needs a network
 * policy at the browser layer; this guard blocks the direct vectors —
 * non-http(s) schemes, IP literals, loopback/mDNS names, and names that
 * resolve to a private range at check time.
 */
export async function assertSafeNavigationTarget(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new NavigateError(`navigation to ${rawUrl} blocked: not a valid absolute URL`);
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new NavigateError(
      `navigation to ${rawUrl} blocked: only http/https is allowed (got "${url.protocol}")`,
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new NavigateError(`navigation to ${rawUrl} blocked: loopback host`);
  }
  if (hostname.endsWith(".local")) {
    throw new NavigateError(`navigation to ${rawUrl} blocked: mDNS host "${hostname}"`);
  }
  const unbracketed = hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (isPrivateIp(unbracketed)) {
    throw new NavigateError(`navigation to ${rawUrl} blocked: private/loopback IP`);
  }
  // IP literals are their own target — nothing to resolve/rebind.
  const isIpLiteral = normalizeIpv4(unbracketed) !== null || unbracketed.includes(":");
  if (isIpLiteral) return;
  let resolved: { readonly address: string };
  try {
    resolved = await dnsLookupFn(unbracketed);
  } catch (err) {
    throw new NavigateError(
      `navigation to ${rawUrl} blocked: cannot resolve host: ${(err as Error).message}`,
    );
  }
  if (isPrivateIp(resolved.address)) {
    throw new NavigateError(
      `navigation to ${rawUrl} blocked: host resolves to private IP ${resolved.address}`,
    );
  }
}

export type CreateNavigateToolOptions = {
  readonly driver: Driver;
};

export function createNavigateTool(opts: CreateNavigateToolOptions): RegisteredTool {
  return buildTool({
    name: "Navigate",
    description:
      "Navigate the browser to a URL. Call this first to load a starting page (e.g. a search engine, documentation site, or known landing page) before using Screenshot/FindElement/Click/Type. Returns a short confirmation; pair with Screenshot to see what loaded.",
    inputSchema: navigateSchema,
    readOnly: false,
    destructive: false,
    concurrencySafe: false,
    classifyOutput: false,
    scope: "external",
    execute: async (input): Promise<ToolResultContent> => {
      // SSRF guard runs BEFORE the browser touches the URL. Throws
      // NavigateError directly so the block reason surfaces unwrapped.
      await assertSafeNavigationTarget(input.url);
      try {
        await opts.driver.goto(input.url);
      } catch (err) {
        throw new NavigateError(
          `navigation to ${input.url} failed: ${(err as Error).message}`,
          err,
        );
      }
      return [{ type: "text", text: `navigated to ${input.url}` }];
    },
  });
}
