/**
 * A redirect does not carry the call's headers to an origin the call did
 * not name, and a POST is not replayed where a server redirected it
 * (C160, security-9#5).
 *
 * 0.7.0 built the same request on every hop: a 302 from an allow-listed
 * origin to another allow-listed origin re-sent the call's Authorization,
 * Cookie and any X-Api-Key there, and re-POSTed the body on every 3xx.
 * tool-http's openRequest and tool-codehost already dropped credentials at
 * an origin change and followed RFC 9110's method rewrite; Fetch was the
 * outlier. Fetch takes arbitrary headers from the call and cannot tell which
 * of them is a credential, so a cross-origin hop keeps only the ones that
 * describe the request: content negotiation, a Range and its conditionals.
 * The method follows the Fetch Standard: only a POST becomes a GET on a
 * 301/302 (net review, 0.7.1).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _resetFetchConfig,
  _setDnsLookup,
  _setRawFetch,
  fetch,
  registerFetchConfig,
} from "./index";

const PUBLIC_IP = "93.184.216.34";

describe("a redirect carries the call's credentials only to the origin the call named (C160)", () => {
  type Seen = {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  };
  let seen: Seen[] = [];

  beforeEach(() => {
    seen = [];
    _resetFetchConfig();
    _setDnsLookup(async () => ({ address: PUBLIC_IP, family: 4 }));
    registerFetchConfig({ allowed_origins: ["https://a.example", "https://b.example"] });
  });

  afterEach(() => {
    _resetFetchConfig();
    _setRawFetch(undefined);
    _setDnsLookup(undefined);
  });

  /** a.example answers `status` pointing at `location`; everything else answers 200. */
  const redirectingFrom = (status: number, location: string): void => {
    _setRawFetch(async (req) => {
      seen.push({
        url: req.url,
        method: req.method,
        headers: Object.fromEntries(req.headers.entries()),
        body: await req.text(),
      });
      if (new URL(req.url).hostname === "a.example" && seen.length === 1) {
        return new Response(null, { status, headers: { location } });
      }
      return new Response("done", { status: 200, headers: { "content-type": "text/plain" } });
    });
  };

  const call = {
    url: "https://a.example/v1",
    method: "POST" as const,
    body: '{"q":1}',
    headers: {
      Authorization: "Bearer T",
      COOKIE: "c=1",
      "proxy-authorization": "Basic p",
      "X-Api-Key": "k-123",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  };

  test("a cross-origin 302 after a POST: the next hop is a GET with no body and no credentials", async () => {
    redirectingFrom(302, "https://b.example/x");
    const out = String(await fetch.execute(call, {} as never));
    expect(out.endsWith("\ndone")).toBe(true);
    expect(seen).toHaveLength(2);
    // The first hop got what the call set.
    expect(seen[0]?.headers["authorization"]).toBe("Bearer T");
    expect(seen[0]?.headers["x-api-key"]).toBe("k-123");
    expect(seen[0]?.body).toBe('{"q":1}');
    // The second went elsewhere, so it carries none of it.
    expect(seen[1]).toEqual({
      url: "https://b.example/x",
      method: "GET",
      headers: { accept: "application/json", "accept-encoding": "identity" },
      body: "",
    });
  });

  test("a cross-origin 307 keeps the method and body but still drops the credentials", async () => {
    redirectingFrom(307, "https://b.example/x");
    await fetch.execute(call, {} as never);
    expect(seen[1]?.method).toBe("POST");
    expect(seen[1]?.body).toBe('{"q":1}');
    expect(seen[1]?.headers["content-type"]).toBe("application/json");
    for (const name of ["authorization", "cookie", "proxy-authorization", "x-api-key"]) {
      expect(seen[1]?.headers[name]).toBeUndefined();
    }
  });

  test("a same-origin 302 after a GET keeps every header", async () => {
    redirectingFrom(302, "https://a.example/v2");
    await fetch.execute({ ...call, method: "GET", body: undefined }, {} as never);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.url).toBe("https://a.example/v2");
    expect(seen[1]?.headers["authorization"]).toBe("Bearer T");
    expect(seen[1]?.headers["x-api-key"]).toBe("k-123");
  });

  test("a same-origin 303 after a PUT is a GET without the body, credentials kept", async () => {
    redirectingFrom(303, "/status");
    await fetch.execute({ ...call, method: "PUT" }, {} as never);
    expect(seen[1]).toMatchObject({ url: "https://a.example/status", method: "GET", body: "" });
    expect(seen[1]?.headers["authorization"]).toBe("Bearer T");
    expect(seen[1]?.headers["content-type"]).toBeUndefined();
  });

  test("the origin comparison is canonical: an explicit default port is the same origin", async () => {
    redirectingFrom(302, "https://A.EXAMPLE:443/v2");
    await fetch.execute({ ...call, method: "GET", body: undefined }, {} as never);
    expect(seen[1]?.headers["authorization"]).toBe("Bearer T");
  });

  test("net-review: a same-origin 301 or 302 after a PUT or DELETE keeps the method and body", async () => {
    let checked = 0;
    for (const [status, method] of [
      [301, "PUT"],
      [302, "PUT"],
      [301, "DELETE"],
      [302, "DELETE"],
    ] as const) {
      seen = [];
      redirectingFrom(status, "/moved");
      const out = String(await fetch.execute({ ...call, method }, {} as never));
      expect(out.endsWith("\ndone")).toBe(true);
      expect({ status, method, hop: seen[1] }).toMatchObject({
        status,
        method,
        hop: { url: "https://a.example/moved", method, body: '{"q":1}' },
      });
      expect(seen[1]?.headers["content-type"]).toBe("application/json");
      checked += 1;
    }
    expect(checked).toBe(4);
  });

  test("a same-origin 301 after a POST is still a GET without the body", async () => {
    redirectingFrom(301, "/moved");
    await fetch.execute(call, {} as never);
    expect(seen[1]).toMatchObject({ url: "https://a.example/moved", method: "GET", body: "" });
  });

  test("net-review: a cross-origin 302 keeps a Range and its conditionals, and still drops credentials", async () => {
    redirectingFrom(302, "https://b.example/asset");
    await fetch.execute(
      {
        url: "https://a.example/release/1",
        headers: {
          Range: "bytes=0-9",
          "If-None-Match": '"abc"',
          "If-Modified-Since": "Wed, 21 Oct 2026 07:28:00 GMT",
          "Cache-Control": "no-cache",
          Authorization: "Bearer T",
          "X-Api-Key": "k-123",
          "X-Session": "s-1",
        },
      },
      {} as never,
    );
    expect(seen[1]?.url).toBe("https://b.example/asset");
    expect(seen[1]?.headers).toEqual({
      range: "bytes=0-9",
      "if-none-match": '"abc"',
      "if-modified-since": "Wed, 21 Oct 2026 07:28:00 GMT",
      "cache-control": "no-cache",
      "accept-encoding": "identity",
    });
  });
});
