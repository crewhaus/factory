import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  FetchPermissionError,
  _resetFetchConfig,
  _setDnsLookup,
  _setRawFetch,
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
