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
 * The IP-validation helpers mirror tool-fetch's `assertNotSsrf` family —
 * duplicated (like tool-navigate and crawler) rather than extracted to a
 * shared package, per the Pillar 3 convention; keep the copies in sync.
 *
 * The proxy binds 127.0.0.1 on an ephemeral port and refuses private targets,
 * so it cannot be leveraged by other local processes to reach internal
 * services.
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

/**
 * Normalise an IPv4 literal to canonical dotted-decimal. Browsers and many
 * HTTP stacks accept octal (`0177.0.0.1`), hex (`0x7f.0.0.1` / `0x7f000001`),
 * and 32-bit integer (`2130706433`) forms — all of which resolve to the same
 * address as `127.0.0.1`. Canonicalising first means `isPrivateIp` classifies
 * them. Returns dotted-decimal, or `null` if `raw` is not an IPv4 literal.
 */
export function normalizeIpv4(raw: string): string | null {
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

  // RFC-3986-style packing: the final component absorbs the remaining bytes
  // (e.g. `127.1` ⇒ 127.0.0.1, `2130706433` ⇒ 127.0.0.1, `0x7f.0.0.1`).
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

export function isPrivateIp(addr: string): boolean {
  // Strip IPv6 brackets if present.
  const ip = addr.replace(/^\[/, "").replace(/\]$/, "");
  const lowerIp = ip.toLowerCase();

  // IPv6 unspecified / loopback / link-local / unique-local
  if (lowerIp === "::" || lowerIp === "::1") return true;
  if (lowerIp.startsWith("fe80:")) return true;
  if (lowerIp.startsWith("fc") || lowerIp.startsWith("fd")) return true;

  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 / ::ffff:7f00:1) — classify by the
  // embedded IPv4 address so a mapped literal can't smuggle past the checks.
  const mapped = lowerIp.match(/^::ffff:(.+)$/);
  if (mapped) {
    const tail = mapped[1] as string;
    if (tail.includes(".")) {
      return isPrivateIp(tail);
    }
    // Hex form ::ffff:7f00:0001 → 127.0.0.1
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
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24 IETF protocol (RFC6890)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking (RFC2544)
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

class BlockedTargetError extends ComputerUseDriverError {}

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
  const unbracketed = lower.replace(/^\[/, "").replace(/\]$/, "");
  const literal = normalizeIpv4(unbracketed) ?? (unbracketed.includes(":") ? unbracketed : null);
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

/** Parse a CONNECT target ("host:port", "[::1]:443") into host + port. */
function parseConnectTarget(target: string): { readonly host: string; readonly port: number } {
  const m = target.match(/^\[(.+)\]:(\d{1,5})$/) ?? target.match(/^([^:]+):(\d{1,5})$/);
  if (m === null) {
    throw new BlockedTargetError(`malformed CONNECT target "${target}"`);
  }
  const port = Number.parseInt(m[2] as string, 10);
  if (port < 1 || port > 65535) {
    throw new BlockedTargetError(`malformed CONNECT target "${target}": bad port`);
  }
  return { host: m[1] as string, port };
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
