import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  FetchPermissionError,
  _resetFetchConfig,
  _setDnsLookup,
  _setRawFetch,
  assertNotSsrf,
  canonicalizeOrigin,
  fetch,
  registerFetchConfig,
} from "./index";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

// Default DNS stub: every host resolves to a public-looking IP. SSRF tests
// that need to assert rebinding behaviour install their own stub.
const PUBLIC_DNS_STUB = async () => ({ address: "93.184.216.34", family: 4 });

beforeEach(() => {
  _resetFetchConfig();
  _setRawFetch(undefined);
  _setDnsLookup(PUBLIC_DNS_STUB);
});

afterEach(() => {
  _resetFetchConfig();
  _setRawFetch(undefined);
  _setDnsLookup(undefined);
});

describe("Fetch — registered tool metadata", () => {
  test("name + flags follow R3 fail-closed defaults", () => {
    expect(fetch.name).toBe("Fetch");
    expect(fetch.readOnly).toBe(false);
    expect(fetch.destructive).toBe(false);
    expect(fetch.concurrencySafe).toBe(false);
  });
});

describe("canonicalizeOrigin", () => {
  test("lowercases host and elides default ports", () => {
    expect(canonicalizeOrigin("HTTPS://API.GitHub.com")).toBe("https://api.github.com");
    expect(canonicalizeOrigin("https://api.github.com:443")).toBe("https://api.github.com");
    expect(canonicalizeOrigin("http://example.com:80")).toBe("http://example.com");
  });

  test("preserves non-default ports", () => {
    expect(canonicalizeOrigin("https://api.github.com:8443")).toBe("https://api.github.com:8443");
  });

  test("drops path and query", () => {
    expect(canonicalizeOrigin("https://api.github.com/repos?x=1")).toBe("https://api.github.com");
  });

  test("rejects non-http(s) schemes", () => {
    expect(() => canonicalizeOrigin("file:///etc/passwd")).toThrow(FetchPermissionError);
    expect(() => canonicalizeOrigin("javascript:alert(1)")).toThrow(FetchPermissionError);
  });

  test("rejects malformed URLs at register time", () => {
    expect(() => canonicalizeOrigin("not a url")).toThrow(FetchPermissionError);
  });
});

describe("Fetch — happy path", () => {
  test("issues GET to an allow-listed origin and returns body", async () => {
    registerFetchConfig({ allowed_origins: ["https://api.example.com"] });
    let capturedMethod: string | undefined;
    let capturedUrl: string | undefined;
    _setRawFetch(async (req) => {
      capturedMethod = req.method;
      capturedUrl = req.url;
      return jsonResponse(200, { ok: true });
    });
    const result = await fetch.execute({ url: "https://api.example.com/v1/items" });
    if (typeof result !== "string") throw new Error("expected string result");
    expect(capturedMethod).toBe("GET");
    expect(capturedUrl).toBe("https://api.example.com/v1/items");
    expect(result).toContain("HTTP 200");
    expect(result).toContain('"ok":true');
  });

  test("strips Cookie / Set-Cookie / Authorization headers from the response", async () => {
    registerFetchConfig({ allowed_origins: ["https://api.example.com"] });
    _setRawFetch(
      async () =>
        new Response("hello", {
          status: 200,
          headers: {
            "content-type": "text/plain",
            "set-cookie": "sid=abc",
            authorization: "Bearer leak",
            "x-rate-limit": "100",
          },
        }),
    );
    const result = await fetch.execute({ url: "https://api.example.com/" });
    if (typeof result !== "string") throw new Error("expected string result");
    expect(result).not.toContain("sid=abc");
    expect(result).not.toContain("Bearer leak");
    expect(result).toContain("x-rate-limit: 100");
  });

  test("supports POST with a JSON body", async () => {
    registerFetchConfig({ allowed_origins: ["https://api.example.com"] });
    let capturedMethod: string | undefined;
    let capturedBody: string | undefined;
    _setRawFetch(async (req) => {
      capturedMethod = req.method;
      capturedBody = await req.text();
      return jsonResponse(201, { id: 42 });
    });
    await fetch.execute({
      url: "https://api.example.com/items",
      method: "POST",
      body: JSON.stringify({ name: "x" }),
      headers: { "content-type": "application/json" },
    });
    expect(capturedMethod).toBe("POST");
    expect(capturedBody).toBe('{"name":"x"}');
  });
});

describe("T8 — empty allow-list denies everything (fail-closed)", () => {
  test("rejects every URL when no origins registered", async () => {
    _setRawFetch(async () => {
      throw new Error("fetch should never be called");
    });
    await expect(fetch.execute({ url: "https://example.com/" })).rejects.toBeInstanceOf(
      FetchPermissionError,
    );
    await expect(fetch.execute({ url: "https://api.github.com/" })).rejects.toBeInstanceOf(
      FetchPermissionError,
    );
  });

  test("error message contains 'allowed_origins' so the model can repeat it", async () => {
    try {
      await fetch.execute({ url: "https://example.com/private" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FetchPermissionError);
      expect((err as Error).message).toContain("allowed_origins");
    }
  });
});

describe("T8 — origin spoofs are rejected", () => {
  beforeEach(() => {
    registerFetchConfig({ allowed_origins: ["https://api.github.com"] });
    _setRawFetch(async () => jsonResponse(200, { ok: true }));
  });

  test("scheme mismatch (http vs https) is rejected", async () => {
    await expect(fetch.execute({ url: "http://api.github.com/" })).rejects.toBeInstanceOf(
      FetchPermissionError,
    );
  });

  test("host case mutation matches after canonicalisation", async () => {
    await expect(fetch.execute({ url: "https://API.GITHUB.com/" })).resolves.toBeDefined();
  });

  test("non-default port is rejected when canonical entry has no port", async () => {
    await expect(fetch.execute({ url: "https://api.github.com:8443/" })).rejects.toBeInstanceOf(
      FetchPermissionError,
    );
  });

  test("explicit default port matches the canonical entry", async () => {
    await expect(fetch.execute({ url: "https://api.github.com:443/" })).resolves.toBeDefined();
  });

  test("a different host is rejected", async () => {
    await expect(fetch.execute({ url: "https://evil.com/" })).rejects.toBeInstanceOf(
      FetchPermissionError,
    );
  });
});

describe("T8 — non-http(s) schemes are rejected before any fetch", () => {
  test("file:// is rejected at URL parse / scheme check", async () => {
    registerFetchConfig({ allowed_origins: ["https://api.github.com"] });
    _setRawFetch(async () => {
      throw new Error("must not call");
    });
    await expect(fetch.execute({ url: "file:///etc/passwd" })).rejects.toBeInstanceOf(
      FetchPermissionError,
    );
  });

  test("javascript: is rejected", async () => {
    registerFetchConfig({ allowed_origins: ["https://api.github.com"] });
    _setRawFetch(async () => {
      throw new Error("must not call");
    });
    await expect(fetch.execute({ url: "javascript:alert(1)" })).rejects.toBeInstanceOf(
      FetchPermissionError,
    );
  });
});

describe("T8 — SSRF defenses", () => {
  test("literal 127.0.0.1 is rejected even when allow-listed", async () => {
    registerFetchConfig({ allowed_origins: ["http://127.0.0.1"] });
    _setRawFetch(async () => {
      throw new Error("must not call");
    });
    await expect(fetch.execute({ url: "http://127.0.0.1/private" })).rejects.toBeInstanceOf(
      FetchPermissionError,
    );
  });

  test("localhost is rejected", async () => {
    registerFetchConfig({ allowed_origins: ["http://localhost"] });
    _setRawFetch(async () => {
      throw new Error("must not call");
    });
    await expect(fetch.execute({ url: "http://localhost/" })).rejects.toBeInstanceOf(
      FetchPermissionError,
    );
  });

  test("AWS metadata 169.254.169.254 is rejected", async () => {
    registerFetchConfig({ allowed_origins: ["http://169.254.169.254"] });
    _setRawFetch(async () => {
      throw new Error("must not call");
    });
    await expect(
      fetch.execute({ url: "http://169.254.169.254/latest/meta-data/" }),
    ).rejects.toBeInstanceOf(FetchPermissionError);
  });

  test("RFC1918 10.x is rejected", async () => {
    registerFetchConfig({ allowed_origins: ["http://10.0.0.5"] });
    _setRawFetch(async () => {
      throw new Error("must not call");
    });
    await expect(fetch.execute({ url: "http://10.0.0.5/" })).rejects.toBeInstanceOf(
      FetchPermissionError,
    );
  });

  test("RFC1918 192.168.x is rejected", async () => {
    registerFetchConfig({ allowed_origins: ["http://192.168.1.1"] });
    _setRawFetch(async () => {
      throw new Error("must not call");
    });
    await expect(fetch.execute({ url: "http://192.168.1.1/" })).rejects.toBeInstanceOf(
      FetchPermissionError,
    );
  });

  test("RFC1918 172.16-31.x is rejected", async () => {
    registerFetchConfig({ allowed_origins: ["http://172.20.0.1"] });
    _setRawFetch(async () => {
      throw new Error("must not call");
    });
    await expect(fetch.execute({ url: "http://172.20.0.1/" })).rejects.toBeInstanceOf(
      FetchPermissionError,
    );
  });

  test("mDNS *.local is rejected", async () => {
    registerFetchConfig({ allowed_origins: ["http://printer.local"] });
    _setRawFetch(async () => {
      throw new Error("must not call");
    });
    await expect(fetch.execute({ url: "http://printer.local/" })).rejects.toBeInstanceOf(
      FetchPermissionError,
    );
  });

  test("IPv6 ::1 is rejected", async () => {
    registerFetchConfig({ allowed_origins: ["http://[::1]"] });
    _setRawFetch(async () => {
      throw new Error("must not call");
    });
    await expect(fetch.execute({ url: "http://[::1]/" })).rejects.toBeInstanceOf(
      FetchPermissionError,
    );
  });

  test("DNS rebinding: public-looking host resolving to 127.0.0.1 is rejected", async () => {
    registerFetchConfig({ allowed_origins: ["https://attacker.example.com"] });
    _setDnsLookup(async () => ({ address: "127.0.0.1", family: 4 }));
    _setRawFetch(async () => {
      throw new Error("must not call");
    });
    await expect(fetch.execute({ url: "https://attacker.example.com/" })).rejects.toBeInstanceOf(
      FetchPermissionError,
    );
  });
});

describe("T8 — redirect handling", () => {
  test("follows up to 5 redirects then aborts", async () => {
    registerFetchConfig({ allowed_origins: ["https://api.example.com"] });
    let hops = 0;
    _setRawFetch(async () => {
      hops++;
      return new Response(null, {
        status: 302,
        headers: { location: `https://api.example.com/hop${hops}` },
      });
    });
    await expect(fetch.execute({ url: "https://api.example.com/" })).rejects.toBeInstanceOf(
      FetchPermissionError,
    );
    expect(hops).toBeGreaterThanOrEqual(6);
    expect(hops).toBeLessThanOrEqual(7);
  });

  test("redirect smuggling: allow-listed origin → unlisted origin is rejected on the hop", async () => {
    registerFetchConfig({ allowed_origins: ["https://api.example.com"] });
    let hops = 0;
    _setRawFetch(async () => {
      hops++;
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.com/" },
      });
    });
    await expect(fetch.execute({ url: "https://api.example.com/" })).rejects.toBeInstanceOf(
      FetchPermissionError,
    );
    expect(hops).toBe(1);
  });
});

describe("T8 — body size cap", () => {
  test("aborts when response exceeds 5 MB", async () => {
    registerFetchConfig({ allowed_origins: ["https://api.example.com"] });
    const sixMb = "x".repeat(6 * 1024 * 1024);
    _setRawFetch(async () => new Response(sixMb, { status: 200 }));
    await expect(fetch.execute({ url: "https://api.example.com/big" })).rejects.toBeInstanceOf(
      FetchPermissionError,
    );
  });
});

describe("T8 — credential strip on response", () => {
  test("Cookie + Authorization absent from returned text", async () => {
    registerFetchConfig({ allowed_origins: ["https://api.example.com"] });
    _setRawFetch(async () => {
      const headers = new Headers();
      headers.set("set-cookie", "sid=secret-session");
      headers.set("authorization", "Bearer my-token");
      headers.set("content-type", "text/plain");
      return new Response("ok", { status: 200, headers });
    });
    const result = await fetch.execute({ url: "https://api.example.com/auth" });
    if (typeof result !== "string") throw new Error("expected string result");
    expect(result).not.toContain("sid=secret-session");
    expect(result).not.toContain("Bearer my-token");
    expect(result).toContain("ok");
  });
});

describe("#155 — DNS-rebinding TOCTOU: connection is pinned to the validated IP", () => {
  test("rebinding resolver (public for the check, private at connect) is blocked", async () => {
    // The classic rebinding race: the SSRF check sees a public IP, then the
    // socket would re-resolve to 127.0.0.1. We pin to the IP we vetted, so the
    // attacker-controlled second answer is never connected to. Here the
    // resolver returns private on the *check* call to assert it is rejected
    // before any fetch — but the deeper guarantee is the pinned-IP dial below.
    registerFetchConfig({ allowed_origins: ["https://rebind.example.com"] });
    let lookups = 0;
    _setDnsLookup(async () => {
      lookups++;
      // First answer public; any later answer private. With pinning, only the
      // first answer is ever used and it is what we connect to.
      return lookups === 1
        ? { address: "93.184.216.34", family: 4 }
        : { address: "127.0.0.1", family: 4 };
    });
    let connectedHostname: string | undefined;
    _setRawFetch(async (req, pinnedIp) => {
      // The tool must hand us the IP it validated and dial *that*, never a
      // hostname the runtime could re-resolve at connect time.
      connectedHostname = pinnedIp;
      return jsonResponse(200, { ok: true });
    });
    const result = await fetch.execute({ url: "https://rebind.example.com/" });
    if (typeof result !== "string") throw new Error("expected string result");
    expect(connectedHostname).toBe("93.184.216.34");
    expect(lookups).toBe(1);
  });

  test("a public-looking host that resolves private is rejected, fetch never fires", async () => {
    registerFetchConfig({ allowed_origins: ["https://rebind.example.com"] });
    _setDnsLookup(async () => ({ address: "169.254.169.254", family: 4 }));
    _setRawFetch(async () => {
      throw new Error("must not call — pinned IP is private");
    });
    await expect(fetch.execute({ url: "https://rebind.example.com/" })).rejects.toBeInstanceOf(
      FetchPermissionError,
    );
  });

  test("each redirect hop is re-validated and re-pinned to its own IP", async () => {
    registerFetchConfig({
      allowed_origins: ["https://a.example.com", "https://b.example.com"],
    });
    _setDnsLookup(async (host) => {
      if (host === "a.example.com") return { address: "93.184.216.34", family: 4 };
      if (host === "b.example.com") return { address: "127.0.0.1", family: 4 };
      return { address: "93.184.216.34", family: 4 };
    });
    const pins: string[] = [];
    _setRawFetch(async (req, pinnedIp) => {
      pins.push(pinnedIp);
      const url = new URL(req.url);
      // performFetch keeps the original host on the Request and conveys the
      // vetted IP out-of-band via `pinnedIp`; the first hop (a) redirects to b,
      // which would rebind to loopback.
      if (url.hostname === "a.example.com") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://b.example.com/" },
        });
      }
      throw new Error("must not connect to b — it resolves to loopback");
    });
    await expect(fetch.execute({ url: "https://a.example.com/" })).rejects.toBeInstanceOf(
      FetchPermissionError,
    );
    // a was pinned + connected; b was rejected by assertNotSsrf before any dial.
    expect(pins).toEqual(["93.184.216.34"]);
  });

  test("legit public host still succeeds and is dialled at its resolved IP", async () => {
    registerFetchConfig({ allowed_origins: ["https://api.example.com"] });
    _setDnsLookup(async () => ({ address: "93.184.216.34", family: 4 }));
    let pinnedIp: string | undefined;
    let hostHeaderPreserved = false;
    _setRawFetch(async (req, ip) => {
      pinnedIp = ip;
      // The request URL we build still carries the real host so the caller can
      // set Host/SNI from it.
      hostHeaderPreserved = new URL(req.url).hostname === "api.example.com";
      return jsonResponse(200, { ok: true });
    });
    const result = await fetch.execute({ url: "https://api.example.com/v1/items" });
    if (typeof result !== "string") throw new Error("expected string result");
    expect(pinnedIp).toBe("93.184.216.34");
    expect(hostHeaderPreserved).toBe(true);
    expect(result).toContain("HTTP 200");
  });

  test("an IP-literal host is its own pin and needs no DNS lookup", async () => {
    registerFetchConfig({ allowed_origins: ["https://93.184.216.34"] });
    let lookups = 0;
    _setDnsLookup(async () => {
      lookups++;
      return { address: "93.184.216.34", family: 4 };
    });
    let pinnedIp: string | undefined;
    _setRawFetch(async (_req, ip) => {
      pinnedIp = ip;
      return jsonResponse(200, { ok: true });
    });
    await fetch.execute({ url: "https://93.184.216.34/" });
    expect(pinnedIp).toBe("93.184.216.34");
    expect(lookups).toBe(0);
  });
});

describe("#155 — broadened isPrivateIp ranges (via assertNotSsrf)", () => {
  // assertNotSsrf classifies the literal directly, so we can assert each new
  // range is blocked without routing through DNS.
  const blocked = [
    ["100.64.0.0/10 CGNAT", "100.64.1.1"],
    ["100.64.0.0/10 upper edge", "100.127.255.254"],
    ["192.0.0.0/24 IETF protocol", "192.0.0.8"],
    ["198.18.0.0/15 benchmarking", "198.18.0.1"],
    ["198.18.0.0/15 upper half", "198.19.255.254"],
    ["IPv4-mapped IPv6 loopback", "::ffff:127.0.0.1"],
    ["IPv4-mapped IPv6 metadata", "::ffff:169.254.169.254"],
    ["IPv4-mapped IPv6 hex form", "::ffff:7f00:0001"],
    ["unspecified ::", "::"],
  ] as const;

  for (const [label, ip] of blocked) {
    test(`${label} (${ip}) is rejected`, async () => {
      await expect(assertNotSsrf(ip)).rejects.toBeInstanceOf(FetchPermissionError);
    });
  }

  const allowedPublic = [
    ["100.63.x is public (just below CGNAT)", "100.63.255.255"],
    ["100.128.x is public (just above CGNAT)", "100.128.0.0"],
    ["192.0.1.x is public (just above 192.0.0.0/24)", "192.0.1.1"],
    ["198.17.x is public (just below benchmarking)", "198.17.255.255"],
    ["198.20.x is public (just above benchmarking)", "198.20.0.0"],
  ] as const;

  for (const [label, ip] of allowedPublic) {
    test(`${label} (${ip}) is allowed and pins to itself`, async () => {
      await expect(assertNotSsrf(ip)).resolves.toBe(ip);
    });
  }

  test("public IPv4-mapped IPv6 is not over-blocked", async () => {
    await expect(assertNotSsrf("::ffff:93.184.216.34")).resolves.toBeDefined();
  });
});

describe("#155 — non-decimal IPv4 literals are normalised before classification", () => {
  // The WHATWG URL parser canonicalises these on its own, but assertNotSsrf /
  // isPrivateIp must not depend on that — they receive raw hostnames from
  // canonicalizeOrigin and direct callers too.
  const loopbackForms = [
    ["octal", "0177.0.0.1"],
    ["hex dotted", "0x7f.0.0.1"],
    ["hex packed", "0x7f000001"],
    ["32-bit integer", "2130706433"],
    ["short form 127.1", "127.1"],
  ] as const;

  for (const [label, literal] of loopbackForms) {
    test(`${label} (${literal}) is recognised as 127.0.0.1 and rejected`, async () => {
      await expect(assertNotSsrf(literal)).rejects.toBeInstanceOf(FetchPermissionError);
    });
  }

  test("integer form of AWS metadata (2852039166) is rejected", async () => {
    // 169.254.169.254 = 0xA9FEA9FE = 2852039166
    await expect(assertNotSsrf("2852039166")).rejects.toBeInstanceOf(FetchPermissionError);
  });

  test("hex form of a public IP normalises and is allowed", async () => {
    // 0x5DB8D822 = 93.184.216.34 (public)
    await expect(assertNotSsrf("0x5DB8D822")).resolves.toBe("93.184.216.34");
  });

  test("out-of-range integer is not treated as an IP (falls through to DNS)", async () => {
    // 2 ** 32 is too large to be a valid packed IPv4; it must not be classified
    // as private, and with the default public DNS stub it resolves fine.
    await expect(assertNotSsrf("4294967296")).resolves.toBe("93.184.216.34");
  });
});
