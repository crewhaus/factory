/**
 * SECURITY (audit follow-up R1) — DNS-pinning proxy contract tests.
 *
 * Clients are raw `node:net` sockets writing literal HTTP — the most faithful
 * stand-in for a browser talking to a forward proxy, and immune to any HTTP
 * client library rewriting the request target. DNS + the blocked-IP predicate
 * are injected so no test depends on real resolution or real public hosts:
 * the allow-path tests stub the predicate open and point a fake public name
 * at a local target server; the deny-path tests use the REAL predicate.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as http from "node:http";
import * as net from "node:net";
import {
  type SsrfPinningProxy,
  isPrivateIp,
  normalizeIpv4,
  startSsrfPinningProxy,
} from "./ssrf-proxy";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function track(proxy: SsrfPinningProxy): SsrfPinningProxy {
  cleanups.push(() => proxy.close());
  return proxy;
}

/** Write `request` to the proxy and return everything received until close. */
function rawHttp(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => {
      sock.write(request);
    });
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
    });
    sock.on("close", () => resolve(buf));
    sock.on("error", reject);
  });
}

/** Local HTTP target that records the request line + Host header. */
async function startTarget(): Promise<{
  port: number;
  seen: Array<{ url: string; host: string | undefined }>;
}> {
  const seen: Array<{ url: string; host: string | undefined }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? "", host: req.headers.host });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("target-says-hello");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  return { port: addr.port, seen };
}

describe("IP validators (duplicated from tool-fetch — keep in sync)", () => {
  test.each([
    ["127.0.0.1", true],
    ["10.1.2.3", true],
    ["169.254.169.254", true],
    ["192.168.0.1", true],
    ["100.64.0.1", true],
    ["::1", true],
    ["fe80::1", true],
    ["fd00::1", true],
    ["::ffff:127.0.0.1", true],
    ["::ffff:7f00:1", true],
    ["8.8.8.8", false],
    ["93.184.216.34", false],
    ["2606:4700::1111", false],
  ])("isPrivateIp(%p) === %p", (ip, want) => {
    expect(isPrivateIp(ip)).toBe(want);
  });

  test.each([
    ["0x7f000001", "127.0.0.1"],
    ["2130706433", "127.0.0.1"],
    ["0177.0.0.1", "127.0.0.1"],
    ["127.1", "127.0.0.1"],
    ["not-an-ip", null],
  ])("normalizeIpv4(%p) === %p", (raw, want) => {
    expect(normalizeIpv4(raw)).toBe(want);
  });
});

/**
 * SECURITY (audit 2026-09-18) — the spelling matrix.
 *
 * One address has many spellings, and a classifier that compares TEXT only
 * recognises the ones whoever wrote it happened to think of. Fifteen of these
 * were let through by the previous implementation. They are asserted here as a
 * table rather than prose so the property is protected going forward: every
 * spelling of a private destination classifies private, and no real public
 * address gets caught by the widened net.
 *
 * Two families are worth naming because they look public and are not.
 * `64:ff9b::a9fe:a9fe` IS 169.254.169.254 wherever DNS64/NAT64 runs, and the
 * `64:ff9b:1::/48` variant is a separate prefix that a /96-only check misses.
 * `0:0:0:0:0:ffff:a9fe:a9fe` is the same address the WHATWG URL parser prints
 * as `::ffff:a9fe:a9fe` — the CONNECT path never runs that parser, so the
 * uncompressed form is what actually arrives there.
 */
describe("private-address classifier — spelling matrix", () => {
  test.each([
    // The metadata service, in every spelling that reaches it.
    "169.254.169.254",
    "2852039166",
    "0xA9FEA9FE",
    "0251.0376.0251.0376",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "0:0:0:0:0:ffff:a9fe:a9fe",
    "0:0:0:0:0:ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::169.254.169.254",
    "64:ff9b:1::a9fe:a9fe",
    "64:ff9b:1:0:0:0:a9fe:a9fe",
    "::a9fe:a9fe",
    "::ffff:0:a9fe:a9fe",
    "2002:a9fe:a9fe::",
    // Loopback, compressed and not.
    "127.0.0.1",
    "127.1",
    "::1",
    "0:0:0:0:0:0:0:1",
    "64:ff9b::7f00:1",
    // Link-local, unique-local, unspecified.
    "fe80::1",
    "febf::1",
    "fd00::1",
    "::",
    "0:0:0:0:0:0:0:0",
    // The v4 ranges that are never a public endpoint.
    "10.0.0.1",
    "192.168.1.1",
    "172.16.0.1",
    "100.64.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "0.0.0.0",
  ])("isPrivateIp(%p) is private", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  // Over-blocking breaks real usage as surely as under-blocking breaks
  // security, so the matrix asserts both directions.
  test.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ])("isPrivateIp(%p) is public", (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });
});

describe("plain-HTTP forwarding (absolute-form)", () => {
  test("forwards to the PINNED ip, preserving the Host header for vhosts", async () => {
    const target = await startTarget();
    let lookups = 0;
    const proxy = track(
      await startSsrfPinningProxy({
        _lookup: async () => {
          lookups += 1;
          return { address: "127.0.0.1", family: 4 };
        },
        _isIpBlocked: () => false,
      }),
    );
    const res = await rawHttp(
      proxy.port,
      `GET http://fake-public.example:${target.port}/x?q=1 HTTP/1.1\r\nHost: fake-public.example:${target.port}\r\nConnection: close\r\n\r\n`,
    );
    expect(res).toContain("200");
    expect(res).toContain("target-says-hello");
    // The socket went to the pinned 127.0.0.1; the Host header kept the name.
    expect(target.seen).toEqual([{ url: "/x?q=1", host: `fake-public.example:${target.port}` }]);
    // Pinning = exactly one resolution per connection. A second lookup would
    // be the rebinding window this proxy exists to remove.
    expect(lookups).toBe(1);
  });

  test("origin-form request targets are rejected (not an origin server)", async () => {
    const proxy = track(await startSsrfPinningProxy());
    const res = await rawHttp(
      proxy.port,
      "GET /just-a-path HTTP/1.1\r\nHost: whatever\r\nConnection: close\r\n\r\n",
    );
    expect(res).toContain("400");
  });

  test("blocks localhost names without resolving", async () => {
    let lookups = 0;
    const proxy = track(
      await startSsrfPinningProxy({
        _lookup: async () => {
          lookups += 1;
          return { address: "8.8.8.8", family: 4 };
        },
      }),
    );
    const res = await rawHttp(
      proxy.port,
      "GET http://localhost:9999/ HTTP/1.1\r\nHost: localhost:9999\r\nConnection: close\r\n\r\n",
    );
    expect(res).toContain("403");
    expect(lookups).toBe(0);
  });

  test("blocks private IP literals, including obfuscated forms", async () => {
    const proxy = track(await startSsrfPinningProxy());
    for (const host of ["127.0.0.1", "0x7f000001", "169.254.169.254", "[::1]"]) {
      const res = await rawHttp(
        proxy.port,
        `GET http://${host}/ HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
      );
      expect(res).toContain("403");
    }
  });

  test("blocks a public name that RESOLVES to a private IP (rebinding shape)", async () => {
    const proxy = track(
      await startSsrfPinningProxy({
        _lookup: async () => ({ address: "169.254.169.254", family: 4 }),
      }),
    );
    const res = await rawHttp(
      proxy.port,
      "GET http://innocent-looking.example/ HTTP/1.1\r\nHost: innocent-looking.example\r\nConnection: close\r\n\r\n",
    );
    expect(res).toContain("403");
    expect(res).toContain("private IP 169.254.169.254");
  });
});

describe("CONNECT tunneling", () => {
  test("tunnels to the PINNED ip and pipes both directions", async () => {
    // TCP echo target.
    const echo = net.createServer((s) => s.pipe(s));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
    cleanups.push(() => new Promise<void>((r) => echo.close(() => r())));
    const echoAddr = echo.address();
    if (echoAddr === null || typeof echoAddr === "string") throw new Error("no port");

    let lookups = 0;
    const proxy = track(
      await startSsrfPinningProxy({
        _lookup: async () => {
          lookups += 1;
          return { address: "127.0.0.1", family: 4 };
        },
        _isIpBlocked: () => false,
      }),
    );

    const result = await new Promise<string>((resolve, reject) => {
      const sock = net.connect({ host: "127.0.0.1", port: proxy.port }, () => {
        sock.write(
          `CONNECT fake-tls.example:${echoAddr.port} HTTP/1.1\r\nHost: fake-tls.example:${echoAddr.port}\r\n\r\n`,
        );
      });
      let buf = "";
      let established = false;
      sock.on("data", (d) => {
        buf += d.toString();
        if (!established && buf.includes("\r\n\r\n")) {
          if (!buf.startsWith("HTTP/1.1 200")) {
            reject(new Error(`tunnel refused: ${buf.split("\r\n")[0]}`));
            return;
          }
          established = true;
          buf = "";
          sock.write("opaque-tls-bytes");
        } else if (established && buf.includes("opaque-tls-bytes")) {
          sock.end();
          resolve(buf);
        }
      });
      sock.on("error", reject);
    });
    expect(result).toBe("opaque-tls-bytes");
    expect(lookups).toBe(1);
  });

  test("refuses CONNECT to private targets with 403", async () => {
    const proxy = track(await startSsrfPinningProxy());
    const res = await rawHttp(
      proxy.port,
      "CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n",
    );
    expect(res).toContain("403");
  });

  /**
   * SECURITY (audit 2026-09-18) — the CONNECT path has no URL parser.
   *
   * `handleHttp` runs its target through `new URL()`, which rewrites IPv6 into
   * its canonical compressed form before any guard sees it. CONNECT targets are
   * read straight off the request line, so `0:0:0:0:0:0:0:1` arrives exactly as
   * typed. Against the previous text-matching classifier this exact request was
   * answered `200 Connection Established` and the tunnel returned the internal
   * service's body — which is why the module docstring's old claim about local
   * processes was false. The client here is a raw socket writing literal HTTP,
   * so nothing can canonicalise the target on the way in.
   */
  test("refuses CONNECT to an UNCOMPRESSED loopback spelling", async () => {
    const secret = "internal-service-body";
    const internal = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(secret);
    });
    // A machine without IPv6 loopback still exercises the refusal; it just has
    // nothing listening behind it, so the assertions below stay meaningful.
    const boundPort = await new Promise<number | null>((resolve) => {
      internal.once("error", () => resolve(null));
      internal.listen(0, "::1", () => {
        const addr = internal.address();
        resolve(addr === null || typeof addr === "string" ? null : addr.port);
      });
    });
    if (boundPort !== null) {
      cleanups.push(
        () =>
          new Promise<void>((r) => {
            internal.closeAllConnections();
            internal.close(() => r());
          }),
      );
    }
    const port = boundPort ?? 65001;

    // The GET is pipelined behind the CONNECT headers on purpose: had the
    // tunnel opened, the proxy would forward those bytes as the tunnel's `head`
    // and the internal body would come back. Asserting only on the status line
    // would not have caught that.
    const tunnelled = "GET / HTTP/1.1\r\nHost: internal\r\nConnection: close\r\n\r\n";
    const target = `[0:0:0:0:0:0:0:1]:${port}`;
    const proxy = track(await startSsrfPinningProxy());
    const res = await rawHttp(
      proxy.port,
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n${tunnelled}`,
    );
    expect(res).toContain("403");
    expect(res).not.toContain("200 Connection Established");
    expect(res).not.toContain(secret);
  });

  test("refuses malformed CONNECT targets", async () => {
    const proxy = track(await startSsrfPinningProxy());
    const res = await rawHttp(proxy.port, "CONNECT garbage HTTP/1.1\r\nHost: garbage\r\n\r\n");
    expect(res).toContain("403");
  });
});

describe("lifecycle", () => {
  test("close() actually stops accepting connections", async () => {
    const proxy = await startSsrfPinningProxy();
    await proxy.close();
    await expect(
      new Promise((resolve, reject) => {
        const sock = net.connect({ host: "127.0.0.1", port: proxy.port }, () =>
          resolve("connected"),
        );
        sock.on("error", reject);
      }),
    ).rejects.toThrow();
  });
});
