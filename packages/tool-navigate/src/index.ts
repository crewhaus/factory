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
 * Reject anything that isn't a public http/https target before the browser
 * sees it. This guard blocks the direct vectors — non-http(s) schemes, IP
 * literals, loopback/mDNS names, and names that resolve to a private range
 * at check time. The rebinding TOCTOU this check alone cannot close (the
 * browser re-resolves DNS at connect time, and sub-resource fetches never
 * pass through here) is closed at the connection layer by the chromium
 * backend's DNS-pinning proxy — see `ssrf-proxy.ts` in computer-use-driver,
 * on by default. The remote (CDP/Browserless) backend launches its browser
 * elsewhere, so for that backend this pre-goto guard is still the only
 * navigate-side control; pin egress at the remote browser's host.
 */
export async function assertSafeNavigationTarget(
  rawUrl: string,
  opts: { readonly allowPrivateTargets?: boolean } = {},
): Promise<void> {
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
  if (opts.allowPrivateTargets === true) return;
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
  /**
   * SECURITY — spec `driver.allowPrivateTargets: true`. Waives ONLY the
   * private/loopback/mDNS host checks, for a harness whose whole job is a
   * private target the operator controls: an intranet app under test, or a
   * locally-served fixture page. The scheme allowlist is never waived, so an
   * opted-in spec still cannot reach `file:`/`data:`/`chrome:`.
   *
   * Default false, and a per-spec compile-time decision — there is
   * deliberately no env var or global switch, so it cannot be turned on by an
   * ambient misconfiguration, and a reviewer sees it in the spec diff. The
   * chromium backend drops its DNS-pinning proxy under the same flag, so the
   * two layers agree instead of one silently 403ing what the other allowed.
   */
  readonly allowPrivateTargets?: boolean;
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
      await assertSafeNavigationTarget(input.url, {
        allowPrivateTargets: opts.allowPrivateTargets === true,
      });
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
