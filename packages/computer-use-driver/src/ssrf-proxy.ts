/**
 * SECURITY — DNS-pinning egress proxy for the chromium backend (Section 25
 * BROW, audit follow-up R1).
 *
 * The Navigate tool's pre-goto guard (`assertSafeNavigationTarget` in
 * tool-navigate) resolves a hostname, validates the IP, and only then lets the
 * browser navigate — but the browser RE-RESOLVES DNS at connect time. A
 * hostile resolver can answer with a public IP for the check and a private one
 * (127.0.0.1, 169.254.169.254, …) milliseconds later for the socket: the
 * classic DNS-rebinding TOCTOU. The same gap applies to every sub-resource an
 * attacker-controlled page fetches — those never pass the pre-goto guard at
 * all.
 *
 * This module closes the gap at the connection layer. `startSsrfPinningProxy`
 * runs a loopback-only HTTP forward proxy; the chromium backend launches the
 * browser with `proxy: { server, bypass: "<-loopback>" }` so EVERY request the
 * browser makes — navigations, sub-resources, redirects, websockets — arrives
 * here as either an absolute-form HTTP request or a CONNECT tunnel. For each
 * connection the proxy resolves the hostname ONCE, validates the resolved IP
 * against the private/loopback/link-local/metadata floor, and dials that exact
 * pinned IP. The browser never resolves DNS for proxied traffic, so there is
 * nothing left to rebind. TLS stays end-to-end through the CONNECT tunnel —
 * SNI and certificate validation are untouched.
 *
 * The `bypass: "<-loopback>"` rule matters: Chromium implicitly BYPASSES a
 * configured proxy for localhost/loopback targets, which would let an
 * attacker page fetch http://127.0.0.1:… directly. `<-loopback>` removes that
 * implicit bypass so loopback targets also route here — and get blocked.
 *
 * The IP-validation helpers below are the synchronised private-address
 * classifier, byte-identical to every other copy in the tree. Its own header
 * explains why it parses addresses instead of matching their text; never edit
 * one copy alone.
 *
 * WHAT THE LOOPBACK BIND DOES AND DOES NOT GUARANTEE. The proxy listens on
 * 127.0.0.1 on an ephemeral port, so only processes on this machine can reach
 * it, and both request paths — the absolute-form URL and the CONNECT target —
 * are classified by that same `isPrivateIp`, so no spelling of a private
 * address is tunnelled or forwarded. It is NOT authenticated: any local process
 * that finds the port can use it to reach PUBLIC hosts for as long as the
 * browser session lasts. And an IPv4 address behind an operator-chosen NAT64
 * prefix stays undecidable from the address alone (see the block header). Until
 * 2026-09-18 this paragraph claimed flatly that the proxy "cannot be leveraged
 * by other local processes to reach internal services"; it could, because the
 * CONNECT target was classified by text and `CONNECT [0:0:0:0:0:0:0:1]:<port>`
 * was answered with 200.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as net from "node:net";
import { ComputerUseDriverError } from "./errors";

export type DnsLookupFn = (
  host: string,
) => Promise<{ readonly address: string; readonly family: number }>;

const defaultDnsLookup: DnsLookupFn = (host) => dnsLookup(host, { verbatim: false });

export type SsrfPinningProxy = {
  /** Proxy URL for the browser's launch options, e.g. `http://127.0.0.1:49321`. */
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
};

export type StartSsrfPinningProxyOptions = {
  /** Test seam: replaces the DNS resolver. */
  readonly _lookup?: DnsLookupFn;
  /** Test seam: replaces the blocked-IP predicate. */
  readonly _isIpBlocked?: (ip: string) => boolean;
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

class BlockedTargetError extends ComputerUseDriverError {}

/**
 * A host as the classifier must see it: brackets off, lower-cased.
 *
 * On the plain-HTTP path `new URL()` canonicalises the hostname before we ever
 * look at it. The CONNECT path has no URL — its target is read straight off the
 * request line, so whatever the client typed is what arrives, uncompressed IPv6
 * and all. Both paths go through here and then through the same `isPrivateIp`,
 * which parses rather than matches text; that, not this function, is what makes
 * the spelling stop mattering.
 */
function unbracketHost(host: string): string {
  return host.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

/**
 * Resolve `hostname` once and validate the result. Returns the pinned IP the
 * caller must dial — never let anything re-resolve after this.
 */
async function resolvePinned(
  hostname: string,
  lookupFn: DnsLookupFn,
  isBlocked: (ip: string) => boolean,
): Promise<{ readonly ip: string; readonly family: number }> {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local")) {
    throw new BlockedTargetError(`blocked host "${hostname}": loopback/mDNS name`);
  }

  // An IP literal is its own pinned target — no DNS lookup, nothing to rebind.
  // A colon alone used to be enough to call something an IPv6 literal, which
  // handed the dial an unvalidated string; `parseIpv6` decides now, and it
  // accepts every spelling, so nothing takes this path unclassified.
  const unbracketed = unbracketHost(lower);
  const literal =
    normalizeIpv4(unbracketed) ?? (parseIpv6(unbracketed) === null ? null : unbracketed);
  if (literal !== null) {
    if (isBlocked(literal)) {
      throw new BlockedTargetError(`blocked target IP ${literal}`);
    }
    return { ip: literal, family: literal.includes(":") ? 6 : 4 };
  }

  let resolved: { readonly address: string; readonly family: number };
  try {
    resolved = await lookupFn(lower);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new BlockedTargetError(`cannot resolve "${hostname}": ${msg}`);
  }
  if (isBlocked(resolved.address)) {
    throw new BlockedTargetError(
      `blocked host "${hostname}": resolves to private IP ${resolved.address}`,
    );
  }
  return { ip: resolved.address, family: resolved.family };
}

/**
 * Parse a CONNECT target ("host:port", "[::1]:443") into host + port.
 *
 * SECURITY: this is a regex over the raw request line, because CONNECT has no
 * URL to parse — so the host arrives exactly as the client typed it, including
 * spellings `new URL()` would have rewritten. Returning it unbracketed and
 * lower-cased puts it in the same shape as a hostname taken off a parsed URL,
 * and `resolvePinned` then classifies it with the same `isPrivateIp` the HTTP
 * path uses. Until 2026-09-18 the classifier compared text, so
 * `CONNECT [0:0:0:0:0:0:0:1]:<port>` was answered with 200 and tunnelled to
 * loopback; the fix is that the classifier parses, not that this regex knows
 * more spellings.
 */
function parseConnectTarget(target: string): { readonly host: string; readonly port: number } {
  const m = target.match(/^\[([^\]]+)\]:(\d{1,5})$/) ?? target.match(/^([^:]+):(\d{1,5})$/);
  if (m === null) {
    throw new BlockedTargetError(`malformed CONNECT target "${target}"`);
  }
  const port = Number.parseInt(m[2] as string, 10);
  if (port < 1 || port > 65535) {
    throw new BlockedTargetError(`malformed CONNECT target "${target}": bad port`);
  }
  const host = unbracketHost(m[1] as string);
  if (host === "") {
    throw new BlockedTargetError(`malformed CONNECT target "${target}": empty host`);
  }
  return { host, port };
}

// Hop-by-hop headers must not be forwarded by a proxy (RFC 7230 §6.1).
const HOP_BY_HOP = new Set([
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
]);

export async function startSsrfPinningProxy(
  opts: StartSsrfPinningProxyOptions = {},
): Promise<SsrfPinningProxy> {
  const lookupFn = opts._lookup ?? defaultDnsLookup;
  const isBlocked = opts._isIpBlocked ?? isPrivateIp;

  const server = http.createServer((req, res) => {
    void handleHttp(req, res);
  });

  async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // A forward proxy receives absolute-form request targets. Origin-form
    // ("/path") means someone is talking to the proxy as if it were an origin
    // server — reject.
    const rawUrl = req.url ?? "";
    if (!rawUrl.startsWith("http://")) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("ssrf-pinning-proxy: absolute-form http:// request target required");
      return;
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("ssrf-pinning-proxy: malformed request target");
      return;
    }

    let pinned: { readonly ip: string; readonly family: number };
    try {
      pinned = await resolvePinned(url.hostname, lookupFn, isBlocked);
    } catch (err) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end(`ssrf-pinning-proxy: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue;
      headers[k] = v;
    }
    // The socket dials the pinned IP; the Host header keeps the original
    // name so virtual hosting on the target still works.
    headers["host"] = url.host;

    const upstream = http.request(
      {
        host: pinned.ip,
        family: pinned.family,
        port: url.port === "" ? 80 : Number.parseInt(url.port, 10),
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
      }
      res.end("ssrf-pinning-proxy: upstream connection failed");
    });
    req.pipe(upstream);
  }

  server.on("connect", (req, clientSocket: net.Socket, head: Buffer) => {
    void handleConnect(req, clientSocket, head);
  });

  async function handleConnect(
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer,
  ): Promise<void> {
    // Swallow client-side socket errors (browser may abort tunnels freely).
    clientSocket.on("error", () => {
      clientSocket.destroy();
    });
    let pinned: { readonly ip: string; readonly family: number };
    let port: number;
    try {
      const target = parseConnectTarget(req.url ?? "");
      port = target.port;
      pinned = await resolvePinned(target.host, lookupFn, isBlocked);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      clientSocket.write(
        `HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nssrf-pinning-proxy: ${msg}\r\n`,
      );
      clientSocket.destroy();
      return;
    }

    const upstream = net.connect({ host: pinned.ip, family: pinned.family, port }, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => {
      // Before the tunnel is established a 502 is still expressible; after,
      // tearing the socket down is all a proxy can do.
      if (!clientSocket.destroyed && upstream.connecting) {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      }
      clientSocket.destroy();
      upstream.destroy();
    });
    clientSocket.on("close", () => upstream.destroy());
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  // Don't let a leaked proxy hold the event loop open (e.g. tests that never
  // call disconnect); the chromium backend closes it deterministically.
  server.unref();

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new ComputerUseDriverError("ssrf-pinning-proxy: failed to bind a loopback port");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close(): Promise<void> {
      return new Promise((resolve) => {
        // closeAllConnections drops live CONNECT tunnels; close() alone would
        // wait for them forever.
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
