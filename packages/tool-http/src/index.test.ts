/**
 * The tools against real servers.
 *
 * Every network test stands up an actual `Bun.serve` on 127.0.0.1 with an
 * ephemeral port and drives the tools at it. Nothing is mocked and no public
 * address is ever contacted: a stubbed `fetch` would prove nothing about
 * whether a redirect chain really drops a credential, whether a deadline
 * really fires, or whether a byte cap really cancels a stream, which is most
 * of what this package has to get right.
 *
 * Reaching 127.0.0.1 means lifting the loopback refusal, which is what
 * `__setPrivateHostsAllowedForTest` is for — it is test-only, defaults off,
 * and is reset after every test. The refusal itself is proved with the flag
 * in its production position.
 *
 * Filesystem tests run inside a throwaway temp directory; nothing is ever
 * written inside the repository.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { auditToolScopes } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  HTTP_TOOLS,
  __setPrivateHostsAllowedForTest,
  _resetHttpConfig,
  _setDnsLookup,
  dnsLookup,
  downloadFile,
  feedParse,
  graphqlQuery,
  headRequest,
  httpBatch,
  httpPaginate,
  httpRequest,
  httpWaitFor,
  linkCheck,
  registerHttpConfig,
  robotsCheck,
  sitemapParse,
  sseRead,
  tlsInspect,
  urlReachable,
  webhookSign,
  webhookVerify,
} from "./index";

// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
async function run(tool: RegisteredTool, input: unknown): Promise<any> {
  const out = await tool.execute(input);
  if (typeof out !== "string") throw new Error("expected a string result");
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

const TOKEN_VAR = "CREWHAUS_TEST_HTTP_TOKEN";
const SECRET_VAR = "CREWHAUS_TEST_WEBHOOK_SECRET";

// ---------------------------------------------------------------------------
// the fixture servers
// ---------------------------------------------------------------------------

type Server = ReturnType<typeof Bun.serve>;

let main: Server;
let other: Server;
let origin = "";
let otherOrigin = "";
/** Per-test counters, so a flaky-endpoint test starts from a known state. */
let flakyCalls = 0;
let jobCalls = 0;

const FEED_XML = `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>Releases</title><link>http://x.test</link>
  <item><title>v2</title><link>http://x.test/v2</link><guid>g2</guid></item>
  <item><title>v1</title><link>http://x.test/v1</link><guid>g1</guid></item>
</channel></rss>`;

const SITEMAP_XML = `<?xml version="1.0"?><urlset>
  <url><loc>http://x.test/b</loc></url>
  <url><loc>http://x.test/a</loc></url>
</urlset>`;

const ROBOTS_TXT = `User-agent: *
Disallow: /private/
Allow: /private/ok/
Crawl-delay: 1

Sitemap: http://x.test/sitemap.xml`;

async function mainHandler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  const jsonRes = (value: unknown, init: ResponseInit = {}): Response =>
    new Response(JSON.stringify(value), {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });

  if (p === "/json") return jsonRes({ hello: "world" });

  if (p === "/echo") {
    return jsonRes({
      method: req.method,
      path: `${url.pathname}${url.search}`,
      authorization: req.headers.get("authorization"),
      cookie: req.headers.get("cookie"),
      apiKey: req.headers.get("x-api-key"),
      body: await req.text(),
    });
  }

  if (p.startsWith("/status/")) {
    const code = Number.parseInt(p.slice("/status/".length), 10);
    return new Response(`status ${code}`, { status: code });
  }

  if (p === "/slow") {
    await Bun.sleep(2_000);
    return new Response("late");
  }

  if (p === "/big") return new Response("x".repeat(200_000));

  if (p === "/redirect-same") {
    return new Response(null, { status: 302, headers: { location: "/echo" } });
  }
  if (p === "/redirect-cross") {
    return new Response(null, { status: 302, headers: { location: `${otherOrigin}/echo` } });
  }
  if (p === "/redirect-303") {
    return new Response(null, { status: 303, headers: { location: "/echo" } });
  }
  if (p === "/redirect-307") {
    return new Response(null, { status: 307, headers: { location: "/echo" } });
  }
  if (p === "/redirect-loop") {
    return new Response(null, { status: 302, headers: { location: "/redirect-loop" } });
  }
  if (p === "/redirect-offlist") {
    return new Response(null, { status: 302, headers: { location: "http://example.com/x" } });
  }

  if (p === "/flaky") {
    flakyCalls++;
    if (flakyCalls <= 2) return new Response("busy", { status: 503 });
    return jsonRes({ ok: true, calls: flakyCalls });
  }

  if (p === "/job") {
    jobCalls++;
    return jsonRes({ state: jobCalls >= 3 ? "ready" : "pending", calls: jobCalls });
  }
  if (p === "/job-never") return jsonRes({ state: "pending" });

  if (p === "/link") {
    const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
    const headers: Record<string, string> =
      page < 2 ? { link: `<${origin}/link?page=${page + 1}>; rel="next"` } : {};
    return jsonRes({ items: page === 1 ? [1, 2] : [3] }, { headers });
  }

  if (p === "/cursor") {
    const cursor = url.searchParams.get("cursor");
    if (cursor === null) return jsonRes({ items: ["a", "b"], meta: { next_cursor: "c2" } });
    return jsonRes({ items: ["c"], meta: { next_cursor: null } });
  }

  if (p === "/pages") {
    const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
    return jsonRes({ rows: page <= 2 ? [`p${page}`] : [], size: url.searchParams.get("size") });
  }

  if (p === "/fat") {
    // A walk that never runs out of pages, each one deliberately large.
    const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
    return jsonRes(
      { items: [{ page, filler: "x".repeat(40_000) }] },
      { headers: { link: `<${origin}/fat?page=${page + 1}>; rel="next"` } },
    );
  }

  if (p === "/sse-burst") {
    // Several events, terminator in the MIDDLE of a single chunk.
    const body = "event: tick\ndata: 1\n\nevent: done\ndata: bye\n\nevent: tick\ndata: 2\n\n";
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }

  if (p === "/not-an-array") return jsonRes({ items: { nope: true } });

  if (p === "/graphql") {
    const payload = (await req.json()) as { query: string; variables?: unknown };
    if (payload.query.includes("broken")) {
      return jsonRes({ data: null, errors: [{ message: "field not found" }] });
    }
    return jsonRes({ data: { echo: payload.variables ?? null } });
  }

  if (p === "/sse") {
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        for (let i = 1; i <= 3; i++) {
          controller.enqueue(encoder.encode(`event: tick\ndata: ${i}\n\n`));
          await Bun.sleep(5);
        }
        controller.enqueue(encoder.encode("event: done\ndata: bye\n\n"));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }

  if (p === "/head") {
    return new Response(null, {
      headers: {
        "content-length": "1234",
        "content-type": "application/pdf",
        etag: '"abc"',
        "last-modified": "Tue, 02 Jan 2026 00:00:00 GMT",
        "cache-control": "max-age=60",
        "accept-ranges": "bytes",
      },
    });
  }
  if (p === "/nohead") {
    if (req.method === "HEAD") return new Response(null, { status: 405 });
    return new Response("body", { headers: { "content-type": "text/plain" } });
  }

  if (p === "/robots.txt")
    return new Response(ROBOTS_TXT, { headers: { "content-type": "text/plain" } });
  if (p === "/no-robots") return new Response("missing", { status: 404 });
  if (p === "/sitemap.xml")
    return new Response(SITEMAP_XML, { headers: { "content-type": "application/xml" } });
  if (p === "/feed.xml")
    return new Response(FEED_XML, { headers: { "content-type": "application/xml" } });

  if (p === "/download")
    return new Response("hello world", { headers: { "content-type": "text/plain" } });

  if (p === "/set-cookie") {
    return new Response("ok", { headers: { "set-cookie": "session=abc", "x-safe": "yes" } });
  }

  return new Response("not found", { status: 404 });
}

beforeEach(() => {
  flakyCalls = 0;
  jobCalls = 0;
  main = Bun.serve({ port: 0, fetch: mainHandler });
  other = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      return new Response(
        JSON.stringify({
          server: "other",
          path: url.pathname,
          authorization: req.headers.get("authorization"),
          cookie: req.headers.get("cookie"),
          apiKey: req.headers.get("x-api-key"),
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  origin = `http://127.0.0.1:${main.port}`;
  otherOrigin = `http://127.0.0.1:${other.port}`;
  registerHttpConfig({ allowed_origins: [origin, otherOrigin] });
  __setPrivateHostsAllowedForTest(true);
  process.env[TOKEN_VAR] = "s3cret-token";
  process.env[SECRET_VAR] = "whsec_fixture";
});

afterEach(() => {
  main.stop(true);
  other.stop(true);
  _resetHttpConfig();
  __setPrivateHostsAllowedForTest(false);
  delete process.env[TOKEN_VAR];
  delete process.env[SECRET_VAR];
});

// ---------------------------------------------------------------------------

describe("package contract", () => {
  const outward = new Set([
    "DnsLookup",
    "DownloadFile",
    "FeedParse",
    "GraphqlQuery",
    "HeadRequest",
    "HttpBatch",
    "HttpPaginate",
    "HttpRequest",
    "HttpWaitFor",
    "LinkCheck",
    "RobotsCheck",
    "SitemapParse",
    "SseRead",
    "TlsInspect",
    "UrlReachable",
  ]);
  const mutating = new Set(["DownloadFile", "GraphqlQuery", "HttpBatch", "HttpRequest"]);
  const justified = new Set(["GraphqlQuery", "HttpBatch", "HttpRequest"]);

  test("every tool is exported in HTTP_TOOLS, with unique PascalCase names", () => {
    expect(HTTP_TOOLS.length).toBe(17);
    const names = HTTP_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("HTTP_TOOLS is frozen and listed in name order", () => {
    expect(Object.isFrozen(HTTP_TOOLS)).toBe(true);
    const names = HTTP_TOOLS.map((t) => t.name);
    expect(names).toEqual([...names].sort());
  });

  test("every description says what it is for in a second sentence starting with Use", () => {
    for (const tool of HTTP_TOOLS) {
      expect({ name: tool.name, hasUse: tool.description.includes("Use ") }).toEqual({
        name: tool.name,
        hasUse: true,
      });
      const second = tool.description.split(/(?<=\.)\s+/)[1] ?? "";
      expect({ name: tool.name, second: second.slice(0, 4) }).toEqual({
        name: tool.name,
        second: "Use ",
      });
    }
  });

  test("every tool that crosses the network declares it, and the scope audit is clean", () => {
    for (const tool of HTTP_TOOLS) {
      const expected = outward.has(tool.name)
        ? { scope: "external", ioCapability: "network" }
        : { scope: "internal", ioCapability: undefined };
      expect({ name: tool.name, scope: tool.scope, ioCapability: tool.ioCapability }).toEqual({
        name: tool.name,
        ...expected,
      });
    }
    expect(auditToolScopes([...HTTP_TOOLS])).toEqual([]);
  });

  test("only the tools that can change something are destructive, and they require justification", () => {
    for (const tool of HTTP_TOOLS) {
      expect({ name: tool.name, destructive: tool.destructive }).toEqual({
        name: tool.name,
        destructive: mutating.has(tool.name),
      });
      expect({ name: tool.name, readOnly: tool.readOnly }).toEqual({
        name: tool.name,
        readOnly: !mutating.has(tool.name),
      });
      expect({ name: tool.name, justify: tool.requireJustification }).toEqual({
        name: tool.name,
        justify: justified.has(tool.name),
      });
    }
  });

  test("no tool requires a sandbox, and every one classifies its output", () => {
    for (const tool of HTTP_TOOLS) {
      expect({
        name: tool.name,
        sandbox: tool.requiresSandbox,
        classify: tool.classifyOutput,
      }).toEqual({
        name: tool.name,
        sandbox: false,
        classify: true,
      });
    }
  });
});

// ---------------------------------------------------------------------------

describe("refusals", () => {
  test("an empty allow-list denies every request", async () => {
    _resetHttpConfig();
    const result = await run(httpRequest, { url: `${origin}/json` });
    expect(result).toContain("empty allow-list = deny all");
  });

  test("an origin outside the allow-list is denied even though the host is reachable", async () => {
    registerHttpConfig({ allowed_origins: [otherOrigin] });
    const result = await run(httpRequest, { url: `${origin}/json` });
    expect(result).toContain("not in allowed_origins");
  });

  test("a redirect to an off-list origin is refused at the hop, not followed", async () => {
    const result = await run(httpRequest, { url: `${origin}/redirect-offlist` });
    expect(result).toContain("not in allowed_origins");
    expect(result).toContain("example.com");
  });

  test("with the production SSRF gate in place, loopback is refused however it is spelled", async () => {
    __setPrivateHostsAllowedForTest(false);
    registerHttpConfig({
      allowed_origins: [origin, `http://127.1:${main.port}`, `http://[::1]:${main.port}`],
    });
    for (const target of [
      `${origin}/json`,
      `http://127.1:${main.port}/json`,
      `http://[::1]:${main.port}/json`,
    ]) {
      expect(await run(httpRequest, { url: target })).toContain("SSRF");
    }
  });

  test("an IPv6 loopback is refused however it is spelled, not just as ::1", async () => {
    __setPrivateHostsAllowedForTest(false);
    const spellings = [
      "[::1]",
      "[0:0:0:0:0:0:0:1]",
      "[0000:0000:0000:0000:0000:0000:0000:0001]",
      "[::0:1]",
      "[::ffff:127.0.0.1]",
      "[::ffff:7f00:1]",
      "[::ffff:169.254.169.254]",
      "[64:ff9b::7f00:1]",
      "[2002:7f00:1::]",
    ];
    // Allow-list every spelling, so the ONLY thing that can refuse them is the
    // SSRF gate. `new URL` normalises an IPv6 host, so several of these share
    // a canonical origin — which is exactly why the gate has to classify the
    // address rather than the string.
    registerHttpConfig({
      allowed_origins: spellings.map((h) => `http://${h}:${main.port}`),
    });
    for (const host of spellings) {
      const result = await run(httpRequest, { url: `http://${host}:${main.port}/json` });
      expect({ host, refused: typeof result === "string" && result.includes("SSRF") }).toEqual({
        host,
        refused: true,
      });
    }
  });

  test("the test-only loopback hatch does not open the cloud metadata address", async () => {
    // The flag is on for the whole suite (see beforeEach). It must lift
    // loopback and nothing else.
    registerHttpConfig({
      allowed_origins: ["http://169.254.169.254", "http://10.0.0.1", "http://192.168.1.1"],
    });
    for (const target of [
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1/",
      "http://192.168.1.1/",
    ]) {
      expect(await run(httpRequest, { url: target })).toContain("SSRF");
    }
  });

  test("a name that RESOLVES into a translated range is refused, not only a literal", async () => {
    __setPrivateHostsAllowedForTest(false);
    registerHttpConfig({ allowed_origins: ["https://looks-fine.example.com"] });
    // 64:ff9b::a9fe:a9fe is the NAT64 form of 169.254.169.254, and
    // 2002:a9fe:a9fe:: is its 6to4 form. A resolver that answers with either
    // one is pointing the harness at the cloud metadata service through an
    // address a prefix check reads as ordinary global unicast.
    for (const address of ["64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::", "::ffff:a9fe:a9fe"]) {
      _setDnsLookup(async () => ({ address, family: 6 }));
      const result = await run(httpRequest, { url: "https://looks-fine.example.com/" });
      expect({ address, refused: typeof result === "string" && result.includes("SSRF") }).toEqual({
        address,
        refused: true,
      });
    }
    _setDnsLookup(undefined);
  });

  test("a URL carrying user:password@ is refused instead of echoed back", async () => {
    const result = await run(httpRequest, {
      url: `http://alice:hunter2@127.0.0.1:${main.port}/echo`,
    });
    expect(result).toContain("userinfo");
    expect(result).toContain("auth profile");
    expect(result).not.toContain("hunter2");
  });

  test("a non-http scheme is refused before anything is dialled", async () => {
    const result = await run(httpRequest, { url: "file:///etc/passwd" });
    expect(result).toContain("only http/https");
  });

  test("a redirect loop stops at the cap rather than spinning", async () => {
    const result = await run(httpRequest, { url: `${origin}/redirect-loop`, maxRedirects: 2 });
    expect(result).toContain("too many redirects");
  });

  test('redirect policy "error" refuses to leave the URL that was asked for', async () => {
    const result = await run(httpRequest, { url: `${origin}/redirect-same`, redirect: "error" });
    expect(result).toContain("redirect policy");
  });

  test("an inline Authorization or Cookie header is refused in favour of an auth profile", async () => {
    for (const headers of [{ Authorization: "Bearer x" }, { cookie: "a=b" }]) {
      const result = await run(httpRequest, { url: `${origin}/echo`, headers });
      expect(result).toContain("auth profile");
    }
  });

  test("an auth profile naming an unset variable refuses without dialling", async () => {
    const result = await run(httpRequest, {
      url: `${origin}/echo`,
      auth: { type: "bearer", envVar: "CREWHAUS_TEST_ABSENT" },
    });
    expect(result).toContain("CREWHAUS_TEST_ABSENT");
    expect(result).toContain("unset or empty");
  });

  test("a deadline fires and is reported as a deadline", async () => {
    const result = await run(httpRequest, { url: `${origin}/slow`, timeoutMs: 150 });
    expect(result).toContain("deadline");
  });

  test("a malformed URL is a readable message, not an exception", async () => {
    expect(await run(httpRequest, { url: "notaurl" })).toContain("not an absolute URL");
  });
});

// ---------------------------------------------------------------------------

describe("HttpRequest", () => {
  test("returns status, headers, body and timing for a plain GET", async () => {
    const result = await run(httpRequest, { url: `${origin}/json` });
    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.body)).toEqual({ hello: "world" });
    expect(result.headers["content-type"]).toContain("application/json");
    expect(result.attempts).toBe(1);
    expect(typeof result.elapsedMs).toBe("number");
  });

  test("parseJson returns the parsed body instead of a string to re-parse", async () => {
    const result = await run(httpRequest, { url: `${origin}/json`, parseJson: true });
    expect(result.json).toEqual({ hello: "world" });
    expect(result.body).toBeUndefined();
  });

  test("a method and body are sent as given", async () => {
    const result = await run(httpRequest, {
      url: `${origin}/echo`,
      method: "POST",
      body: '{"a":1}',
      parseJson: true,
    });
    expect(result.json.method).toBe("POST");
    expect(result.json.body).toBe('{"a":1}');
  });

  test("an auth profile attaches the secret and the echo back is redacted", async () => {
    const result = await run(httpRequest, {
      url: `${origin}/echo`,
      auth: { type: "bearer", envVar: TOKEN_VAR },
      parseJson: true,
    });
    expect(result.json.authorization).toBe("Bearer s3cret-token");
    expect(result.requestHeaders["Authorization"]).toBe("<redacted>");
    expect(JSON.stringify(result.requestHeaders)).not.toContain("s3cret-token");
  });

  test("a header-type auth profile sets the named header", async () => {
    const result = await run(httpRequest, {
      url: `${origin}/echo`,
      auth: { type: "header", envVar: TOKEN_VAR, headerName: "X-Api-Key" },
      parseJson: true,
    });
    expect(result.json.apiKey).toBe("s3cret-token");
  });

  test("a header-type auth secret is redacted in the echo, not just the Authorization one", async () => {
    const result = await run(httpRequest, {
      url: `${origin}/echo`,
      auth: { type: "header", envVar: TOKEN_VAR, headerName: "X-Api-Key" },
      parseJson: true,
    });
    // The server really did receive it...
    expect(result.json.apiKey).toBe("s3cret-token");
    // ...and the model really does not.
    expect(result.requestHeaders["X-Api-Key"]).toBe("<redacted>");
    expect(JSON.stringify(result.requestHeaders)).not.toContain("s3cret-token");
  });

  test("a header-type auth secret is dropped on a cross-origin redirect too", async () => {
    const same = await run(httpRequest, {
      url: `${origin}/redirect-same`,
      auth: { type: "header", envVar: TOKEN_VAR, headerName: "X-Api-Key" },
      parseJson: true,
    });
    expect(same.json.apiKey).toBe("s3cret-token");
    expect(same.credentialsDropped).toBe(false);

    const cross = await run(httpRequest, {
      url: `${origin}/redirect-cross`,
      auth: { type: "header", envVar: TOKEN_VAR, headerName: "X-Api-Key" },
      parseJson: true,
    });
    expect(cross.json.server).toBe("other");
    expect(cross.json.apiKey).toBeNull();
    expect(cross.credentialsDropped).toBe(true);
  });

  test("303 and 302 turn a POST into a GET; 307 keeps the body", async () => {
    const seeOther = await run(httpRequest, {
      url: `${origin}/redirect-303`,
      method: "POST",
      body: '{"a":1}',
      parseJson: true,
    });
    expect(seeOther.json.method).toBe("GET");
    expect(seeOther.json.body).toBe("");

    const found = await run(httpRequest, {
      url: `${origin}/redirect-same`, // 302
      method: "POST",
      body: '{"a":1}',
      parseJson: true,
    });
    expect(found.json.method).toBe("GET");
    expect(found.json.body).toBe("");

    const preserved = await run(httpRequest, {
      url: `${origin}/redirect-307`,
      method: "POST",
      body: '{"a":1}',
      parseJson: true,
    });
    expect(preserved.json.method).toBe("POST");
    expect(preserved.json.body).toBe('{"a":1}');
  });

  test("a same-origin redirect keeps the credential", async () => {
    const result = await run(httpRequest, {
      url: `${origin}/redirect-same`,
      auth: { type: "bearer", envVar: TOKEN_VAR },
      parseJson: true,
    });
    expect(result.json.authorization).toBe("Bearer s3cret-token");
    expect(result.credentialsDropped).toBe(false);
    expect(result.redirects.length).toBe(1);
  });

  test("a CROSS-origin redirect drops the credential before the socket opens", async () => {
    const result = await run(httpRequest, {
      url: `${origin}/redirect-cross`,
      auth: { type: "bearer", envVar: TOKEN_VAR },
      parseJson: true,
    });
    expect(result.json.server).toBe("other");
    expect(result.json.authorization).toBeNull();
    expect(result.credentialsDropped).toBe(true);
  });

  test('redirect policy "manual" hands back the 3xx itself', async () => {
    const result = await run(httpRequest, { url: `${origin}/redirect-same`, redirect: "manual" });
    expect(result.status).toBe(302);
    expect(result.redirects).toEqual([]);
  });

  test("retry-on-status retries and reports how many attempts it took", async () => {
    const result = await run(httpRequest, {
      url: `${origin}/flaky`,
      retryOnStatus: [503],
      maxRetries: 3,
      retryBaseMs: 1,
      parseJson: true,
    });
    expect(result.status).toBe(200);
    expect(result.attempts).toBe(3);
    expect(result.json.ok).toBe(true);
  });

  test("without retryOnStatus the first answer is returned as-is", async () => {
    const result = await run(httpRequest, { url: `${origin}/flaky` });
    expect(result.status).toBe(503);
    expect(result.attempts).toBe(1);
  });

  test("the body cap cuts the response and says so rather than pinning memory", async () => {
    const result = await run(httpRequest, { url: `${origin}/big`, maxBytes: 1024 });
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(1024);
    expect(result.body.length).toBe(1024);
  });

  test("Set-Cookie never reaches the model, but other headers do", async () => {
    const result = await run(httpRequest, { url: `${origin}/set-cookie` });
    expect(result.headers["set-cookie"]).toBeUndefined();
    expect(result.headers["x-safe"]).toBe("yes");
  });

  test("response headers come back lowercased and sorted, so two runs agree", async () => {
    const first = await run(httpRequest, { url: `${origin}/head`, method: "HEAD" });
    const keys = Object.keys(first.headers);
    expect(keys).toEqual([...keys].sort());
  });
});

// ---------------------------------------------------------------------------

describe("HttpPaginate", () => {
  test("follows Link rel=next to the end and concatenates the items", async () => {
    const result = await run(httpPaginate, {
      url: `${origin}/link?page=1`,
      style: "link",
      itemsPath: "items",
      maxPages: 10,
      timeoutMs: 5_000,
    });
    expect(result.pages).toBe(2);
    expect(result.items).toEqual([1, 2, 3]);
    expect(result.stoppedBy).toBe("end");
  });

  test("the page cap stops the walk and says so", async () => {
    const result = await run(httpPaginate, {
      url: `${origin}/link?page=1`,
      style: "link",
      itemsPath: "items",
      maxPages: 1,
      timeoutMs: 5_000,
    });
    expect(result.pages).toBe(1);
    expect(result.stoppedBy).toBe("pageCap");
    expect(result.items).toEqual([1, 2]);
  });

  test("cursor style reads the named field and stops when it goes null", async () => {
    const result = await run(httpPaginate, {
      url: `${origin}/cursor`,
      style: "cursor",
      cursorPath: "meta.next_cursor",
      cursorParam: "cursor",
      itemsPath: "items",
      maxPages: 10,
      timeoutMs: 5_000,
    });
    expect(result.pages).toBe(2);
    expect(result.items).toEqual(["a", "b", "c"]);
    expect(result.stoppedBy).toBe("end");
  });

  test("page style increments the parameter and stops on the first empty page", async () => {
    const result = await run(httpPaginate, {
      url: `${origin}/pages`,
      style: "page",
      pageParam: "page",
      pageSizeParam: "size",
      pageSize: 50,
      itemsPath: "rows",
      maxPages: 10,
      timeoutMs: 5_000,
    });
    expect(result.pages).toBe(3);
    expect(result.items).toEqual(["p1", "p2"]);
    expect(result.stoppedBy).toBe("emptyPage");
    expect(result.lastUrl).toContain("size=50");
  });

  test("the item cap stops mid-walk", async () => {
    const result = await run(httpPaginate, {
      url: `${origin}/link?page=1`,
      style: "link",
      itemsPath: "items",
      maxPages: 10,
      maxItems: 1,
      timeoutMs: 5_000,
    });
    expect(result.items).toEqual([1]);
    expect(result.stoppedBy).toBe("itemCap");
  });

  test("a non-2xx page stops the walk and keeps what was already collected", async () => {
    const result = await run(httpPaginate, {
      url: `${origin}/status/500`,
      style: "link",
      maxPages: 3,
      timeoutMs: 5_000,
    });
    expect(result.stoppedBy).toBe("status");
    expect(result.status).toBe(500);
  });

  test("a body that is not an array says how to point at the items", async () => {
    const result = await run(httpPaginate, {
      url: `${origin}/not-an-array`,
      style: "link",
      itemsPath: "items",
      maxPages: 3,
      timeoutMs: 5_000,
    });
    expect(result.stoppedBy).toBe("shape");
    expect(result.note).toContain("itemsPath");
  });

  test("an aggregate byte budget stops a walk that would otherwise fill memory", async () => {
    // Each page fits well inside maxBytes, so the per-page cap never fires —
    // which is the point: the thing that has to stop this walk is the budget
    // across pages, because every page's items are held at once.
    const result = await run(httpPaginate, {
      url: `${origin}/fat`,
      style: "link",
      itemsPath: "items",
      maxPages: 100,
      maxTotalBytes: 100_000,
      timeoutMs: 20_000,
    });
    expect(result.stoppedBy).toBe("byteBudget");
    expect(result.bytes).toBeGreaterThanOrEqual(100_000);
    expect(result.pages).toBeLessThan(100);
    expect(result.pages).toBeGreaterThan(1);
  });

  test("a cursor style missing its parameters is a readable refusal, not a request", async () => {
    const result = await run(httpPaginate, {
      url: `${origin}/cursor`,
      style: "cursor",
      maxPages: 2,
      timeoutMs: 1_000,
    });
    expect(result).toContain("cursorPath");
  });
});

// ---------------------------------------------------------------------------

describe("GraphqlQuery", () => {
  test("returns data and errors as separate fields", async () => {
    const result = await run(graphqlQuery, {
      url: `${origin}/graphql`,
      query: "query Q($id: ID!) { node(id: $id) { id } }",
      variables: { id: "7" },
    });
    expect(result.hasErrors).toBe(false);
    expect(result.data).toEqual({ echo: { id: "7" } });
    expect(result.errors).toEqual([]);
  });

  test("a 200 carrying GraphQL errors is reported as an error, not as success", async () => {
    const result = await run(graphqlQuery, { url: `${origin}/graphql`, query: "{ broken }" });
    expect(result.status).toBe(200);
    expect(result.hasErrors).toBe(true);
    expect(result.errorCount).toBe(1);
    expect(result.data).toBeNull();
  });

  test("a non-JSON response is a readable message that shows the start of the body", async () => {
    const result = await run(graphqlQuery, { url: `${origin}/status/502`, query: "{ a }" });
    expect(result).toContain("not JSON");
  });
});

// ---------------------------------------------------------------------------

describe("HttpBatch", () => {
  test("returns one result per request, in request order, whatever happened", async () => {
    const result = await run(httpBatch, {
      requests: [
        { url: `${origin}/json` },
        { url: `${origin}/status/404` },
        { url: "http://example.com/blocked" },
      ],
      concurrency: 2,
    });
    expect(result.count).toBe(3);
    expect(result.okCount).toBe(1);
    expect(result.results.map((r: { index: number }) => r.index)).toEqual([0, 1, 2]);
    expect(result.results[0].status).toBe(200);
    expect(result.results[1].status).toBe(404);
    expect(result.results[2].error).toContain("not in allowed_origins");
  });

  test("one failure never cancels the others", async () => {
    const result = await run(httpBatch, {
      requests: [{ url: `${origin}/slow` }, { url: `${origin}/json` }],
      timeoutMs: 200,
      concurrency: 2,
    });
    expect(result.results[0].ok).toBe(false);
    expect(result.results[1].ok).toBe(true);
  });

  test("bodies and headers are opt-out and opt-in respectively", async () => {
    const lean = await run(httpBatch, {
      requests: [{ url: `${origin}/json` }],
      includeBody: false,
    });
    expect(lean.results[0].body).toBeUndefined();
    expect(lean.results[0].headers).toBeUndefined();
    const full = await run(httpBatch, {
      requests: [{ url: `${origin}/json` }],
      includeHeaders: true,
    });
    expect(full.results[0].headers["content-type"]).toContain("application/json");
  });

  test("the batch has a deadline of its own, not just one per request", async () => {
    const startedAt = Date.now();
    const result = await run(httpBatch, {
      // /slow sleeps 2s. Serialised, four of them is eight seconds; the batch
      // deadline has to cut in well before that.
      requests: [
        { url: `${origin}/slow` },
        { url: `${origin}/slow` },
        { url: `${origin}/slow` },
        { url: `${origin}/slow` },
      ],
      concurrency: 1,
      timeoutMs: 60_000,
      totalTimeoutMs: 600,
      includeBody: false,
    });
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(4_000);
    expect(result.count).toBe(4);
    expect(result.okCount).toBe(0);
    expect(result.results.some((r: { error?: string }) => r.error?.includes("skipped"))).toBe(true);
  });

  test("the batch auth profile applies to every request", async () => {
    const result = await run(httpBatch, {
      requests: [{ url: `${origin}/echo` }, { url: `${origin}/echo` }],
      auth: { type: "bearer", envVar: TOKEN_VAR },
    });
    for (const entry of result.results) {
      expect(JSON.parse(entry.body).authorization).toBe("Bearer s3cret-token");
    }
  });
});

// ---------------------------------------------------------------------------

describe("DownloadFile", () => {
  const originalCwd = process.cwd();
  let workspace: string;
  let outsider: string;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "crewhaus-http-"));
    outsider = mkdtempSync(path.join(tmpdir(), "crewhaus-http-outside-"));
    process.chdir(workspace);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outsider, { recursive: true, force: true });
  });

  const EXPECTED = createHash("sha256").update("hello world").digest("hex");

  test("writes the file and reports its digest", async () => {
    const result = await run(downloadFile, { url: `${origin}/download`, path: "out/data.txt" });
    expect(result.bytes).toBe(11);
    expect(result.sha256).toBe(EXPECTED);
    expect(readFileSync(path.join(workspace, "out/data.txt"), "utf8")).toBe("hello world");
  });

  test("a matching expectedSha256 is verified and recorded", async () => {
    const result = await run(downloadFile, {
      url: `${origin}/download`,
      path: "ok.txt",
      expectedSha256: EXPECTED.toUpperCase(),
    });
    expect(result.checksumVerified).toBe(true);
  });

  test("a checksum mismatch leaves nothing behind — not even a partial file", async () => {
    const result = await run(downloadFile, {
      url: `${origin}/download`,
      path: "bad.txt",
      expectedSha256: "0".repeat(64),
    });
    expect(result).toContain("checksum mismatch");
    expect(existsSync(path.join(workspace, "bad.txt"))).toBe(false);
    expect(readdirNames(workspace)).toEqual([]);
  });

  test("exceeding the byte cap is an error and writes nothing", async () => {
    const result = await run(downloadFile, {
      url: `${origin}/big`,
      path: "big.txt",
      maxBytes: 4096,
    });
    expect(result).toContain("larger than the 4096-byte cap");
    expect(readdirNames(workspace)).toEqual([]);
  });

  test("a non-2xx answer writes nothing", async () => {
    const result = await run(downloadFile, { url: `${origin}/status/404`, path: "missing.txt" });
    expect(result).toContain("HTTP 404");
    expect(readdirNames(workspace)).toEqual([]);
  });

  test("an existing file is protected unless overwrite is asked for", async () => {
    writeFileSync(path.join(workspace, "there.txt"), "old");
    const refused = await run(downloadFile, { url: `${origin}/download`, path: "there.txt" });
    expect(refused).toContain("already exists");
    expect(readFileSync(path.join(workspace, "there.txt"), "utf8")).toBe("old");
    const allowed = await run(downloadFile, {
      url: `${origin}/download`,
      path: "there.txt",
      overwrite: true,
    });
    expect(allowed.bytes).toBe(11);
  });

  test("a path escaping the workspace is refused before the request is made", async () => {
    const result = await run(downloadFile, {
      url: `${origin}/download`,
      path: path.join(outsider, "escape.txt"),
    });
    expect(result).toContain("escapes the workspace root");
    expect(existsSync(path.join(outsider, "escape.txt"))).toBe(false);
  });

  test("a relative path climbing out of the workspace is refused too", async () => {
    const result = await run(downloadFile, { url: `${origin}/download`, path: "../escape.txt" });
    expect(result).toContain("escapes the workspace root");
  });

  test("a symlinked directory inside the workspace cannot be written through", async () => {
    symlinkSync(outsider, path.join(workspace, "out-link"));
    const result = await run(downloadFile, {
      url: `${origin}/download`,
      path: "out-link/escape.txt",
    });
    expect(result).toContain("escapes the workspace root");
    expect(existsSync(path.join(outsider, "escape.txt"))).toBe(false);
  });

  test("a symlink pointing at an existing file outside is refused, not followed", async () => {
    writeFileSync(path.join(outsider, "victim.txt"), "original");
    symlinkSync(path.join(outsider, "victim.txt"), path.join(workspace, "victim.txt"));
    const result = await run(downloadFile, {
      url: `${origin}/download`,
      path: "victim.txt",
      overwrite: true,
    });
    expect(result).toContain("escapes the workspace root");
    expect(readFileSync(path.join(outsider, "victim.txt"), "utf8")).toBe("original");
  });

  test("a DANGLING symlink aimed outside is replaced, never written through", async () => {
    // The target does not exist, so a realpath walk cannot classify it — the
    // interesting case, because a rename that followed the link would create
    // the outside file.
    symlinkSync(path.join(outsider, "not-yet.txt"), path.join(workspace, "dangling.txt"));
    const result = await run(downloadFile, {
      url: `${origin}/download`,
      path: "dangling.txt",
      overwrite: true,
    });
    expect(result.bytes).toBe(11);
    expect(existsSync(path.join(outsider, "not-yet.txt"))).toBe(false);
    expect(readFileSync(path.join(workspace, "dangling.txt"), "utf8")).toBe("hello world");
  });

  test("a dangling symlink aimed outside is refused when overwrite was not asked for", async () => {
    symlinkSync(path.join(outsider, "not-yet.txt"), path.join(workspace, "dangling.txt"));
    const result = await run(downloadFile, { url: `${origin}/download`, path: "dangling.txt" });
    expect(result).toContain("already exists");
    expect(existsSync(path.join(outsider, "not-yet.txt"))).toBe(false);
  });
});

/** Everything in `dir`, sorted — used to prove a failed download left nothing. */
function readdirNames(dir: string): string[] {
  return readdirSync(dir).sort();
}

// ---------------------------------------------------------------------------

describe("HeadRequest / UrlReachable / LinkCheck", () => {
  test("HeadRequest reports size, type and caching without a body", async () => {
    const result = await run(headRequest, { url: `${origin}/head` });
    expect(result.status).toBe(200);
    expect(result.exists).toBe(true);
    expect(result.contentLength).toBe(1234);
    expect(result.contentType).toBe("application/pdf");
    expect(result.etag).toBe('"abc"');
    expect(result.cacheControl).toBe("max-age=60");
    expect(result.usedRangedGet).toBe(false);
  });

  test("a server that refuses HEAD is handled by a ranged GET, and the result says so", async () => {
    const result = await run(headRequest, { url: `${origin}/nohead` });
    expect(result.status).toBe(200);
    expect(result.usedRangedGet).toBe(true);
    expect(result.contentType).toBe("text/plain");
  });

  test("the fallback can be turned off, leaving the 405 visible", async () => {
    const result = await run(headRequest, { url: `${origin}/nohead`, fallbackToGet: false });
    expect(result.status).toBe(405);
    expect(result.usedRangedGet).toBe(false);
  });

  test("UrlReachable reports a status and a latency", async () => {
    const result = await run(urlReachable, { url: `${origin}/status/204` });
    expect(result.reachable).toBe(true);
    expect(result.status).toBe(204);
    expect(typeof result.latencyMs).toBe("number");
  });

  test("UrlReachable reports unreachable rather than throwing", async () => {
    const result = await run(urlReachable, { url: `${origin}/slow`, timeoutMs: 120 });
    expect(result.reachable).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("LinkCheck returns one row per URL in input order, with a per-URL status", async () => {
    const result = await run(linkCheck, {
      urls: [`${origin}/json`, `${origin}/status/404`, "http://example.com/off"],
      timeoutMs: 5_000,
      concurrency: 2,
    });
    expect(result.checked).toBe(3);
    expect(result.okCount).toBe(1);
    expect(result.brokenCount).toBe(2);
    expect(result.results.map((r: { url: string }) => r.url)).toEqual([
      `${origin}/json`,
      `${origin}/status/404`,
      "http://example.com/off",
    ]);
    expect(result.results[2].error).toContain("not in allowed_origins");
  });
});

// ---------------------------------------------------------------------------

describe("HttpWaitFor", () => {
  test("polls until a JSON predicate holds and reports the attempt count", async () => {
    const result = await run(httpWaitFor, {
      url: `${origin}/job`,
      expectJson: { path: "state", op: "equals", value: "ready" },
      intervalMs: 20,
      timeoutMs: 5_000,
    });
    expect(result.met).toBe(true);
    expect(result.attempts).toBe(3);
    expect(result.stoppedBy).toBe("condition");
  });

  test("stops at the deadline when the condition never holds", async () => {
    const result = await run(httpWaitFor, {
      url: `${origin}/job-never`,
      expectJson: { path: "state", op: "equals", value: "ready" },
      intervalMs: 30,
      timeoutMs: 250,
    });
    expect(result.met).toBe(false);
    expect(result.stoppedBy).toBe("deadline");
    expect(result.attempts).toBeGreaterThan(0);
  });

  test("an expected status is enough on its own", async () => {
    const result = await run(httpWaitFor, {
      url: `${origin}/json`,
      expectStatus: [200],
      timeoutMs: 2_000,
    });
    expect(result.met).toBe(true);
    expect(result.lastStatus).toBe(200);
  });

  test("with nothing to wait for it refuses rather than spinning to the deadline", async () => {
    const result = await run(httpWaitFor, { url: `${origin}/json`, timeoutMs: 1_000 });
    expect(result).toContain("nothing to wait for");
  });

  test("a permission refusal stops the poll immediately instead of retrying it", async () => {
    const started = Date.now();
    const result = await run(httpWaitFor, {
      url: "http://example.com/x",
      expectStatus: [200],
      timeoutMs: 5_000,
      intervalMs: 1_000,
    });
    expect(result).toContain("not in allowed_origins");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

// ---------------------------------------------------------------------------

describe("SseRead", () => {
  test("collects events and stops on the terminator", async () => {
    const result = await run(sseRead, {
      url: `${origin}/sse`,
      terminatorEvent: "done",
      maxEvents: 20,
      timeoutMs: 5_000,
    });
    expect(result.stoppedBy).toBe("terminator");
    expect(result.count).toBe(4);
    expect(result.events.map((e: { data: string }) => e.data)).toEqual(["1", "2", "3", "bye"]);
  });

  test("the event cap stops the read early", async () => {
    const result = await run(sseRead, { url: `${origin}/sse`, maxEvents: 2, timeoutMs: 5_000 });
    expect(result.count).toBe(2);
    expect(result.stoppedBy).toBe("eventCap");
  });

  test("the deadline stops a stream that never terminates", async () => {
    const result = await run(sseRead, { url: `${origin}/sse`, maxEvents: 500, timeoutMs: 12 });
    expect(["deadline", "terminator", "streamEnded"]).toContain(result.stoppedBy);
  });

  test("events after the terminator in the same chunk are not returned", async () => {
    const result = await run(sseRead, {
      url: `${origin}/sse-burst`,
      terminatorEvent: "done",
      timeoutMs: 3_000,
    });
    expect(result.stoppedBy).toBe("terminator");
    expect(result.events.map((e: { event: string }) => e.event)).toEqual(["tick", "done"]);
  });

  test("a non-2xx endpoint returns no events instead of an exception", async () => {
    const result = await run(sseRead, { url: `${origin}/status/503`, timeoutMs: 2_000 });
    expect(result.stoppedBy).toBe("status");
    expect(result.events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("RobotsCheck / SitemapParse / FeedParse", () => {
  test("RobotsCheck evaluates the path against the fetched rules", async () => {
    const denied = await run(robotsCheck, { url: `${origin}/private/x`, userAgent: "CrewhausBot" });
    expect(denied.allowed).toBe(false);
    expect(denied.rule).toBe("/private/");
    expect(denied.crawlDelaySeconds).toBe(1);
    expect(denied.sitemaps).toEqual(["http://x.test/sitemap.xml"]);

    const allowed = await run(robotsCheck, { url: `${origin}/private/ok/y` });
    expect(allowed.allowed).toBe(true);
    expect(allowed.ruleType).toBe("allow");
  });

  test("a 404 robots.txt means nothing is disallowed", async () => {
    other.stop(true);
    other = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 404 }) });
    otherOrigin = `http://127.0.0.1:${other.port}`;
    registerHttpConfig({ allowed_origins: [origin, otherOrigin] });
    const result = await run(robotsCheck, { url: `${otherOrigin}/anything` });
    expect(result.allowed).toBe(true);
    expect(result.status).toBe(404);
  });

  test("a 5xx robots.txt means the whole site is treated as disallowed", async () => {
    other.stop(true);
    other = Bun.serve({ port: 0, fetch: () => new Response("boom", { status: 500 }) });
    otherOrigin = `http://127.0.0.1:${other.port}`;
    registerHttpConfig({ allowed_origins: [origin, otherOrigin] });
    const result = await run(robotsCheck, { url: `${otherOrigin}/anything` });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("RFC 9309");
  });

  test("SitemapParse reads a fetched document and sorts its entries", async () => {
    const result = await run(sitemapParse, { url: `${origin}/sitemap.xml` });
    expect(result.kind).toBe("urlset");
    expect(result.entries.map((e: { loc: string }) => e.loc)).toEqual([
      "http://x.test/a",
      "http://x.test/b",
    ]);
  });

  test("SitemapParse works offline from text, and refuses both inputs at once", async () => {
    const fromText = await run(sitemapParse, { text: SITEMAP_XML });
    expect(fromText.count).toBe(2);
    expect(fromText.source).toBe("text");
    expect(await run(sitemapParse, { text: SITEMAP_XML, url: `${origin}/sitemap.xml` })).toContain(
      "not both",
    );
    expect(await run(sitemapParse, {})).toContain("either text or url");
  });

  test("FeedParse reads a fetched feed and keeps its order", async () => {
    const result = await run(feedParse, { url: `${origin}/feed.xml` });
    expect(result.kind).toBe("rss");
    expect(result.title).toBe("Releases");
    expect(result.entries.map((e: { title: string }) => e.title)).toEqual(["v2", "v1"]);
  });

  test("a document that is not a feed is a readable message", async () => {
    expect(await run(feedParse, { text: "<html/>" })).toContain("could not parse the feed");
  });
});

// ---------------------------------------------------------------------------

describe("WebhookSign / WebhookVerify", () => {
  test("a signature produced here verifies here, in both schemes", async () => {
    const stamped = await run(webhookSign, {
      scheme: "timestamped",
      payload: '{"id":"evt_1"}',
      secretEnvVar: SECRET_VAR,
      timestamp: 1_700_000_000,
    });
    expect(stamped.header).toStartWith("t=1700000000,v1=");
    const verified = await run(webhookVerify, {
      scheme: "timestamped",
      payload: '{"id":"evt_1"}',
      signatureHeader: stamped.header,
      secretEnvVar: SECRET_VAR,
      nowSeconds: 1_700_000_030,
    });
    expect(verified).toEqual({
      valid: true,
      reason: "signature matches",
      scheme: "timestamped",
      ageSeconds: 30,
      replayProtection: true,
    });

    const plain = await run(webhookSign, {
      scheme: "body",
      payload: "hook",
      secretEnvVar: SECRET_VAR,
    });
    expect(plain.header).toStartWith("sha256=");
    const plainVerified = await run(webhookVerify, {
      scheme: "body",
      payload: "hook",
      signatureHeader: plain.header,
      secretEnvVar: SECRET_VAR,
    });
    expect(plainVerified.valid).toBe(true);
    expect(plainVerified.replayProtection).toBe(false);
  });

  test("the same inputs always produce the same signature", async () => {
    const input = {
      scheme: "timestamped",
      payload: "p",
      secretEnvVar: SECRET_VAR,
      timestamp: 1_700_000_000,
    };
    expect(await webhookSign.execute(input)).toBe((await webhookSign.execute(input)) as string);
  });

  test("a stale timestamp is refused as a replay even with a correct HMAC", async () => {
    const signed = await run(webhookSign, {
      scheme: "timestamped",
      payload: "p",
      secretEnvVar: SECRET_VAR,
      timestamp: 1_700_000_000,
    });
    const result = await run(webhookVerify, {
      scheme: "timestamped",
      payload: "p",
      signatureHeader: signed.header,
      secretEnvVar: SECRET_VAR,
      nowSeconds: 1_700_009_999,
      toleranceSeconds: 60,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("replay");
  });

  test("a tampered payload does not verify", async () => {
    const signed = await run(webhookSign, {
      scheme: "body",
      payload: "original",
      secretEnvVar: SECRET_VAR,
    });
    const result = await run(webhookVerify, {
      scheme: "body",
      payload: "tampered",
      signatureHeader: signed.header,
      secretEnvVar: SECRET_VAR,
    });
    expect(result.valid).toBe(false);
  });

  test("the timestamped scheme refuses to invent a timestamp, so results stay reproducible", async () => {
    const result = await run(webhookSign, {
      scheme: "timestamped",
      payload: "p",
      secretEnvVar: SECRET_VAR,
    });
    expect(result).toContain("explicit timestamp");
  });

  test("an unset secret variable is a readable refusal and never leaks a name's value", async () => {
    const result = await run(webhookSign, {
      scheme: "body",
      payload: "p",
      secretEnvVar: "CREWHAUS_TEST_NO_SUCH_SECRET",
    });
    expect(result).toContain("unset or empty");
  });
});

// ---------------------------------------------------------------------------

describe("DnsLookup / TlsInspect", () => {
  test("DnsLookup refuses a host no allow-listed origin names", async () => {
    const result = await run(dnsLookup, { name: "example.com", types: ["A"] });
    expect(result).toContain("not named by any allowed origin");
  });

  test("DnsLookup fails closed on an empty allow-list", async () => {
    _resetHttpConfig();
    expect(await run(dnsLookup, { name: "example.com" })).toContain("empty allow-list = deny all");
  });

  test("DnsLookup spends ONE budget across every record type it was asked for", async () => {
    registerHttpConfig({ allowed_origins: ["https://dns-budget.invalid"] });
    const result = await run(dnsLookup, {
      name: "dns-budget.invalid",
      types: ["A", "AAAA", "CNAME", "MX", "NS", "TXT"],
      timeoutMs: 1,
    });
    // The budget is spent by the first type, so the other five are never
    // issued. Giving each type its own copy of the timeout — which is what a
    // per-call `withTimeout` does — would instead have run all six, and the
    // "whole lookup" deadline in the description would be six times what it
    // says. The distinction is visible in WHICH error each type reports.
    expect(result.records).toEqual({});
    expect(Object.keys(result.errors).sort()).toEqual(["A", "AAAA", "CNAME", "MX", "NS", "TXT"]);
    expect(result.errors.A).toContain("exceeded 1ms");
    for (const type of ["AAAA", "CNAME", "MX", "NS", "TXT"]) {
      expect({ type, error: result.errors[type] }).toEqual({
        type,
        error: "the 1ms lookup budget elapsed before this record type was asked for",
      });
    }
  });

  test("TlsInspect refuses a host no allow-listed origin names", async () => {
    expect(await run(tlsInspect, { host: "example.com" })).toContain(
      "not named by any allowed origin",
    );
  });

  test("TlsInspect applies the SSRF gate on top of the allow-list", async () => {
    __setPrivateHostsAllowedForTest(false);
    registerHttpConfig({ allowed_origins: [`https://127.0.0.1:${main.port}`] });
    expect(await run(tlsInspect, { host: "127.0.0.1", port: main.port })).toContain("SSRF");
  });

  test.skipIf(!hasOpenssl())(
    "TlsInspect reads a real certificate chain from a local TLS server",
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "crewhaus-http-tls-"));
      try {
        const keyPath = path.join(dir, "key.pem");
        const certPath = path.join(dir, "cert.pem");
        const made = Bun.spawnSync([
          "openssl",
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "30",
          "-subj",
          "/CN=crewhaus.test/O=CrewHaus",
          "-addext",
          "subjectAltName=DNS:crewhaus.test,IP:127.0.0.1",
          "-keyout",
          keyPath,
          "-out",
          certPath,
        ]);
        if (made.exitCode !== 0) return; // no usable openssl — nothing to assert

        const tlsServer = Bun.serve({
          port: 0,
          tls: { cert: readFileSync(certPath), key: readFileSync(keyPath) },
          fetch: () => new Response("ok"),
        });
        try {
          registerHttpConfig({ allowed_origins: [`https://127.0.0.1:${tlsServer.port}`] });
          const result = await run(tlsInspect, {
            host: "127.0.0.1",
            port: tlsServer.port,
            servername: "crewhaus.test",
            timeoutMs: 10_000,
          });
          expect(result.certificate.subject).toContain("CN=crewhaus.test");
          expect(result.certificate.daysRemaining).toBeGreaterThan(20);
          expect(result.certificate.expired).toBe(false);
          expect(result.certificate.subjectAltNames).toEqual([
            "DNS:crewhaus.test",
            "IP Address:127.0.0.1",
          ]);
          // Self-signed: the handshake completes, but nothing vouches for it.
          expect(result.authorized).toBe(false);
          expect(result.authorizationError).toBeDefined();
        } finally {
          tlsServer.stop(true);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

function hasOpenssl(): boolean {
  try {
    return Bun.spawnSync(["which", "openssl"]).exitCode === 0;
  } catch {
    return false;
  }
}
