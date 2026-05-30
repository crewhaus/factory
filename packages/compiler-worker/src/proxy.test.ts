import { describe, expect, test } from "bun:test";
import { PROVIDER_API_HOSTS, handleProviderProxy, isAllowedUpstream } from "./proxy";

const cors = {
  "Access-Control-Allow-Origin": "https://studio.crewhaus.dev",
  Vary: "Origin",
};

describe("isAllowedUpstream", () => {
  test("accepts each of the four https provider hosts", () => {
    for (const host of PROVIDER_API_HOSTS) {
      const url = isAllowedUpstream(`https://${host}/v1/services`);
      expect(url).not.toBeNull();
      expect(url?.hostname).toBe(host);
    }
  });

  test("accepts the host case-insensitively", () => {
    const url = isAllowedUpstream("https://API.Render.com/v1/services");
    expect(url).not.toBeNull();
  });

  test("rejects http:// (non-https)", () => {
    expect(isAllowedUpstream("http://api.render.com/v1/services")).toBeNull();
  });

  test("rejects an unknown host", () => {
    expect(isAllowedUpstream("https://api.example.com/v1/services")).toBeNull();
  });

  test("rejects a suffix-bypass host (api.heroku.com.evil.com)", () => {
    expect(isAllowedUpstream("https://api.heroku.com.evil.com/apps")).toBeNull();
  });

  test("rejects an allowlisted host smuggled in the query string", () => {
    expect(isAllowedUpstream("https://evil.com/?x=api.render.com")).toBeNull();
  });

  test("rejects null", () => {
    expect(isAllowedUpstream(null)).toBeNull();
  });

  test("rejects empty string", () => {
    expect(isAllowedUpstream("")).toBeNull();
  });

  test("rejects an unparseable URL", () => {
    expect(isAllowedUpstream("not a url")).toBeNull();
  });
});

function proxyRequest(upstream: string, init?: RequestInit): { request: Request; url: URL } {
  const raw = `https://compiler.crewhaus.dev/proxy?upstream=${encodeURIComponent(upstream)}`;
  return { request: new Request(raw, init), url: new URL(raw) };
}

describe("handleProviderProxy", () => {
  test("passes through upstream status and forwards the token, for an allowed host", async () => {
    const orig = globalThis.fetch;
    let captured: { url: string; auth: string | null; accept: string | null } = {
      url: "",
      auth: null,
      accept: null,
    };
    globalThis.fetch = (async (input: RequestInfo | URL, fetchInit?: RequestInit) => {
      captured = {
        url: typeof input === "string" ? input : String(input),
        auth: new Headers(fetchInit?.headers).get("Authorization"),
        accept: new Headers(fetchInit?.headers).get("Accept"),
      };
      return new Response(JSON.stringify({ id: "srv-123" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const { request, url } = proxyRequest("https://api.render.com/v1/services", {
        method: "GET",
        headers: {
          Authorization: "Bearer rnd_tkn",
          Accept: "application/vnd.heroku+json; version=3",
        },
      });
      const res = await handleProviderProxy(request, cors, url);
      expect(res.status).toBe(201);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://studio.crewhaus.dev");
      const body = (await res.json()) as { id: string };
      expect(body.id).toBe("srv-123");
      expect(captured.url).toBe("https://api.render.com/v1/services");
      expect(captured.auth).toBe("Bearer rnd_tkn");
      expect(captured.accept).toBe("application/vnd.heroku+json; version=3");
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("disallowed upstream yields 403 WITHOUT calling fetch", async () => {
    const orig = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async (_input: RequestInfo | URL, _fetchInit?: RequestInit) => {
      called = true;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      const { request, url } = proxyRequest("https://api.heroku.com.evil.com/apps", {
        method: "GET",
        headers: { Authorization: "Bearer leak" },
      });
      const res = await handleProviderProxy(request, cors, url);
      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://studio.crewhaus.dev");
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("UPSTREAM_NOT_ALLOWED");
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("forwards the request body for non-GET methods", async () => {
    const orig = globalThis.fetch;
    const captured: { body: string | null } = { body: null };
    globalThis.fetch = (async (_input: RequestInfo | URL, fetchInit?: RequestInit) => {
      captured.body = fetchInit?.body
        ? new TextDecoder().decode(fetchInit.body as ArrayBuffer)
        : null;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const { request, url } = proxyRequest("https://api.machines.dev/v1/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer fly_tkn" },
        body: JSON.stringify({ app_name: "demo" }),
      });
      const res = await handleProviderProxy(request, cors, url);
      expect(res.status).toBe(200);
      expect(captured.body).toBe(JSON.stringify({ app_name: "demo" }));
    } finally {
      globalThis.fetch = orig;
    }
  });
});
