import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  WebFetchPermissionError,
  _resetWebFetchConfig,
  _setDnsLookup,
  _setRawFetch,
  getWebFetchConfig,
  htmlToMarkdown,
  registerWebFetchConfig,
  webFetch,
  webSearch,
} from "./index";

const HTML_PAGE = `<!doctype html>
<html><head><title>Example Domain</title>
<style>p{color:red}</style>
<script>document.write("evil")</script>
</head><body>
<main>
<h1>Example Domain</h1>
<p>This domain is for use in illustrative examples in documents.</p>
<p>You may use this domain in literature without prior coordination or asking for permission.</p>
<a href="https://www.iana.org/domains/example">More information...</a>
</main>
</body></html>`;

const ORIGINAL_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  _resetWebFetchConfig();
  _setRawFetch(undefined);
  // Keep the SSRF DNS backstop offline + deterministic: every host resolves
  // to a public IP by default. Individual tests override to exercise rebinding.
  _setDnsLookup(async () => ({ address: "93.184.216.34", family: 4 }));
  for (const key of ["CREWHAUS_SEARCH_PROVIDER", "CREWHAUS_SEARCH_API_KEY"]) {
    ORIGINAL_ENV[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  _resetWebFetchConfig();
  _setRawFetch(undefined);
  _setDnsLookup(undefined);
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("WebFetch — registered tool metadata", () => {
  test("name + flags", () => {
    expect(webFetch.name).toBe("WebFetch");
    expect(webFetch.readOnly).toBe(true);
    expect(webFetch.concurrencySafe).toBe(true);
    expect(webFetch.destructive).toBe(false);
  });
});

describe("htmlToMarkdown", () => {
  test("strips script + style and renders main content", () => {
    const md = htmlToMarkdown(HTML_PAGE);
    expect(md).toContain("Example Domain");
    expect(md).toContain("illustrative examples");
    expect(md).not.toContain("color:red");
    expect(md).not.toContain("evil");
  });

  test("renders headings as ATX (#)", () => {
    const md = htmlToMarkdown("<h1>Title</h1><p>x</p>");
    expect(md.startsWith("# Title")).toBe(true);
  });

  test("renders links inline", () => {
    const md = htmlToMarkdown('<p><a href="https://x.com">click</a></p>');
    expect(md).toContain("[click](https://x.com)");
  });
});

describe("WebFetch — happy path", () => {
  test("converts HTML to markdown and includes URL/Status header", async () => {
    _setRawFetch(
      async () =>
        new Response(HTML_PAGE, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
    const result = await webFetch.execute({ url: "https://example.com/" });
    if (typeof result !== "string") throw new Error("expected string result");
    expect(result).toContain("URL: https://example.com/");
    expect(result).toContain("Status: 200");
    expect(result).toContain("Example Domain");
  });

  test("plain text passes through unchanged", async () => {
    _setRawFetch(
      async () =>
        new Response("hello world", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const result = await webFetch.execute({ url: "https://example.com/" });
    if (typeof result !== "string") throw new Error("expected string result");
    expect(result).toContain("hello world");
  });

  test("user prompt is prepended to the body, not sent to the model from the tool", async () => {
    _setRawFetch(
      async () =>
        new Response(HTML_PAGE, { status: 200, headers: { "content-type": "text/html" } }),
    );
    const result = await webFetch.execute({
      url: "https://example.com/",
      prompt: "summarise the page",
    });
    if (typeof result !== "string") throw new Error("expected string result");
    expect(result).toContain("[user prompt: summarise the page]");
  });
});

describe("T8 — WebFetch scheme + allow-list", () => {
  test("rejects file:// scheme", async () => {
    _setRawFetch(async () => {
      throw new Error("must not call");
    });
    await expect(webFetch.execute({ url: "file:///etc/passwd" })).rejects.toBeInstanceOf(
      WebFetchPermissionError,
    );
  });

  test("rejects javascript: scheme", async () => {
    _setRawFetch(async () => {
      throw new Error("must not call");
    });
    await expect(webFetch.execute({ url: "javascript:alert(1)" })).rejects.toBeInstanceOf(
      WebFetchPermissionError,
    );
  });

  test("empty allow-list = allow-all (Section 14 says optional)", async () => {
    _setRawFetch(
      async () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    await expect(webFetch.execute({ url: "https://random.example/" })).resolves.toBeDefined();
  });

  test("populated allow-list permits exact host and subdomains", async () => {
    registerWebFetchConfig({ allowed_domains: ["example.com"] });
    _setRawFetch(
      async () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    await expect(webFetch.execute({ url: "https://example.com/" })).resolves.toBeDefined();
    await expect(webFetch.execute({ url: "https://api.example.com/" })).resolves.toBeDefined();
  });

  test("populated allow-list rejects unrelated hosts", async () => {
    registerWebFetchConfig({ allowed_domains: ["example.com"] });
    _setRawFetch(
      async () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    await expect(webFetch.execute({ url: "https://evil.com/" })).rejects.toBeInstanceOf(
      WebFetchPermissionError,
    );
  });

  test("case-mutated host still matches the allow-list (canonicalised)", async () => {
    registerWebFetchConfig({ allowed_domains: ["Example.com"] });
    _setRawFetch(
      async () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    await expect(webFetch.execute({ url: "https://EXAMPLE.com/" })).resolves.toBeDefined();
  });
});

describe("WebFetch — SSRF guard (#141)", () => {
  test("rejects the cloud-metadata IP even with an empty allow-list", async () => {
    _setRawFetch(async () => {
      throw new Error("must not fetch");
    });
    await expect(
      webFetch.execute({
        url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      }),
    ).rejects.toBeInstanceOf(WebFetchPermissionError);
  });

  test("rejects loopback localhost", async () => {
    _setRawFetch(async () => {
      throw new Error("must not fetch");
    });
    await expect(webFetch.execute({ url: "http://localhost:6379/" })).rejects.toBeInstanceOf(
      WebFetchPermissionError,
    );
  });

  test("rejects an RFC1918 IP literal", async () => {
    _setRawFetch(async () => {
      throw new Error("must not fetch");
    });
    await expect(webFetch.execute({ url: "http://10.0.0.5/" })).rejects.toBeInstanceOf(
      WebFetchPermissionError,
    );
  });

  test("rejects the IPv6 loopback [::1]", async () => {
    _setRawFetch(async () => {
      throw new Error("must not fetch");
    });
    await expect(webFetch.execute({ url: "http://[::1]:8080/" })).rejects.toBeInstanceOf(
      WebFetchPermissionError,
    );
  });

  test("rejects DNS rebinding: a public host that resolves to 127.0.0.1", async () => {
    _setDnsLookup(async () => ({ address: "127.0.0.1", family: 4 }));
    _setRawFetch(async () => {
      throw new Error("must not fetch");
    });
    await expect(
      webFetch.execute({ url: "https://totally-legit.example/" }),
    ).rejects.toBeInstanceOf(WebFetchPermissionError);
  });

  test("guard fires even when the internal host is explicitly allow-listed", async () => {
    registerWebFetchConfig({ allowed_domains: ["169.254.169.254"] });
    _setRawFetch(async () => {
      throw new Error("must not fetch");
    });
    await expect(webFetch.execute({ url: "http://169.254.169.254/" })).rejects.toBeInstanceOf(
      WebFetchPermissionError,
    );
  });

  test("blocks a redirect that lands on an internal host (per-hop)", async () => {
    let hops = 0;
    _setRawFetch(async () => {
      hops++;
      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/" },
      });
    });
    await expect(webFetch.execute({ url: "https://example.com/" })).rejects.toBeInstanceOf(
      WebFetchPermissionError,
    );
    expect(hops).toBe(1);
  });

  test("still allows a normal public host (guard is not over-broad)", async () => {
    _setRawFetch(
      async () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    await expect(webFetch.execute({ url: "https://example.com/" })).resolves.toBeDefined();
  });

  // `new URL` compresses [::ffff:127.0.0.1] to [::ffff:7f00:1]; the old
  // dotted-only regex missed the hex form. Now classified via the embedded v4.
  test("rejects the hex IPv4-mapped IPv6 loopback [::ffff:7f00:1]", async () => {
    _setRawFetch(async () => {
      throw new Error("must not fetch");
    });
    await expect(webFetch.execute({ url: "http://[::ffff:127.0.0.1]/" })).rejects.toBeInstanceOf(
      WebFetchPermissionError,
    );
  });

  test("rejects an octal-encoded loopback literal", async () => {
    _setRawFetch(async () => {
      throw new Error("must not fetch");
    });
    await expect(webFetch.execute({ url: "http://0177.0.0.1/" })).rejects.toBeInstanceOf(
      WebFetchPermissionError,
    );
  });

  // The actual rebinding defense: the socket is pinned to the IP we vetted.
  test("pins the connection to the resolved IP (closes the rebinding TOCTOU)", async () => {
    _setDnsLookup(async () => ({ address: "93.184.216.34", family: 4 }));
    let seenPin: string | undefined;
    _setRawFetch(async (_req, pinnedIp) => {
      seenPin = pinnedIp;
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    });
    await webFetch.execute({ url: "https://innocent.example/" });
    expect(seenPin).toBe("93.184.216.34");
  });

  test("pins a public IP-literal host to the literal itself", async () => {
    let seenPin: string | undefined;
    _setRawFetch(async (_req, pinnedIp) => {
      seenPin = pinnedIp;
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    });
    await webFetch.execute({ url: "https://93.184.216.34/" });
    expect(seenPin).toBe("93.184.216.34");
  });
});

describe("T8 — WebFetch redirects", () => {
  test("follows up to 5 redirects then aborts", async () => {
    let hops = 0;
    _setRawFetch(async () => {
      hops++;
      return new Response(null, {
        status: 302,
        headers: { location: `https://example.com/h${hops}` },
      });
    });
    await expect(webFetch.execute({ url: "https://example.com/" })).rejects.toBeInstanceOf(
      WebFetchPermissionError,
    );
    expect(hops).toBeGreaterThanOrEqual(6);
  });

  test("redirect to a non-allowed host is rejected on the hop", async () => {
    registerWebFetchConfig({ allowed_domains: ["example.com"] });
    let hops = 0;
    _setRawFetch(async () => {
      hops++;
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.com/" },
      });
    });
    await expect(webFetch.execute({ url: "https://example.com/" })).rejects.toBeInstanceOf(
      WebFetchPermissionError,
    );
    expect(hops).toBe(1);
  });
});

describe("T8 — WebFetch body cap", () => {
  test("rejects responses over 5 MB", async () => {
    const sixMb = "x".repeat(6 * 1024 * 1024);
    _setRawFetch(
      async () => new Response(sixMb, { status: 200, headers: { "content-type": "text/plain" } }),
    );
    await expect(webFetch.execute({ url: "https://example.com/big" })).rejects.toBeInstanceOf(
      WebFetchPermissionError,
    );
  });
});

describe("WebSearch — registered tool metadata", () => {
  test("name + flags", () => {
    expect(webSearch.name).toBe("WebSearch");
    expect(webSearch.readOnly).toBe(true);
    expect(webSearch.concurrencySafe).toBe(true);
  });
});

describe("WebSearch — env-driven dispatch", () => {
  test("returns a clean refusal when env is unset", async () => {
    _setRawFetch(async () => {
      throw new Error("must not call");
    });
    const result = await webSearch.execute({ query: "anything" });
    if (typeof result !== "string") throw new Error("expected string result");
    expect(result).toContain("WebSearch unavailable");
    expect(result).toContain("CREWHAUS_SEARCH_PROVIDER");
  });

  test("returns a clean refusal for an unknown provider", async () => {
    process.env["CREWHAUS_SEARCH_PROVIDER"] = "duckduckgo";
    process.env["CREWHAUS_SEARCH_API_KEY"] = "x";
    _setRawFetch(async () => {
      throw new Error("must not call");
    });
    const result = await webSearch.execute({ query: "anything" });
    if (typeof result !== "string") throw new Error("expected string result");
    expect(result).toContain("unknown provider");
  });

  test("contracts a Brave response into uniform hit list", async () => {
    process.env["CREWHAUS_SEARCH_PROVIDER"] = "brave";
    process.env["CREWHAUS_SEARCH_API_KEY"] = "test-token";
    _setRawFetch(async (req) => {
      expect(req.url).toContain("api.search.brave.com");
      expect(req.headers.get("x-subscription-token")).toBe("test-token");
      return new Response(
        JSON.stringify({
          web: {
            results: [
              {
                title: "Bun docs",
                url: "https://bun.sh/docs",
                description: "Fast all-in-one runtime",
              },
              { title: "Node docs", url: "https://nodejs.org", description: "JS runtime" },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const result = await webSearch.execute({ query: "bun runtime" });
    if (typeof result !== "string") throw new Error("expected string result");
    expect(result).toContain("Bun docs");
    expect(result).toContain("https://bun.sh/docs");
    expect(result).toContain("Node docs");
  });

  test("contracts a Tavily response into uniform hit list", async () => {
    process.env["CREWHAUS_SEARCH_PROVIDER"] = "tavily";
    process.env["CREWHAUS_SEARCH_API_KEY"] = "tvly-test";
    _setRawFetch(async (req) => {
      expect(req.url).toContain("api.tavily.com");
      const body = (await req.json()) as { api_key: string };
      expect(body.api_key).toBe("tvly-test");
      return new Response(
        JSON.stringify({
          results: [
            { title: "TS Handbook", url: "https://www.typescriptlang.org", content: "Docs" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const result = await webSearch.execute({ query: "typescript" });
    if (typeof result !== "string") throw new Error("expected string result");
    expect(result).toContain("TS Handbook");
  });

  test("blocked_domains filters out matching hits", async () => {
    process.env["CREWHAUS_SEARCH_PROVIDER"] = "brave";
    process.env["CREWHAUS_SEARCH_API_KEY"] = "x";
    _setRawFetch(
      async () =>
        new Response(
          JSON.stringify({
            web: {
              results: [
                { title: "good", url: "https://example.com/page", description: "" },
                { title: "bad", url: "https://evil.com/page", description: "" },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await webSearch.execute({
      query: "x",
      blocked_domains: ["evil.com"],
    });
    if (typeof result !== "string") throw new Error("expected string result");
    expect(result).toContain("good");
    expect(result).not.toContain("evil.com");
  });

  test("allowed_domains keeps only matching hosts (exact + subdomain)", async () => {
    process.env["CREWHAUS_SEARCH_PROVIDER"] = "brave";
    process.env["CREWHAUS_SEARCH_API_KEY"] = "x";
    _setRawFetch(
      async () =>
        new Response(
          JSON.stringify({
            web: {
              results: [
                { title: "keep-exact", url: "https://example.com/a", description: "" },
                { title: "keep-sub", url: "https://docs.example.com/b", description: "" },
                { title: "drop-other", url: "https://other.org/c", description: "" },
                { title: "drop-bad-url", url: "::not a url::", description: "" },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await webSearch.execute({
      query: "x",
      allowed_domains: ["Example.com"],
    });
    if (typeof result !== "string") throw new Error("expected string result");
    expect(result).toContain("keep-exact");
    expect(result).toContain("keep-sub");
    expect(result).not.toContain("drop-other");
    expect(result).not.toContain("drop-bad-url");
  });

  test("when every hit is filtered out, formatHits returns the empty marker", async () => {
    process.env["CREWHAUS_SEARCH_PROVIDER"] = "brave";
    process.env["CREWHAUS_SEARCH_API_KEY"] = "x";
    _setRawFetch(
      async () =>
        new Response(
          JSON.stringify({
            web: { results: [{ title: "gone", url: "https://nope.org/x", description: "" }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await webSearch.execute({ query: "x", allowed_domains: ["example.com"] });
    expect(result).toBe("[no results]");
  });
});

describe("WebFetch — content-type branches", () => {
  test("application/json passes through unchanged", async () => {
    _setRawFetch(
      async () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await webFetch.execute({ url: "https://example.com/data.json" });
    if (typeof result !== "string") throw new Error("expected string result");
    expect(result).toContain('{"ok":true}');
    expect(result).toContain("Content-Type: application/json");
  });

  test("application/xhtml+xml is rendered as markdown", async () => {
    _setRawFetch(
      async () =>
        new Response("<h1>Xhtml Title</h1><p>body</p>", {
          status: 200,
          headers: { "content-type": "application/xhtml+xml" },
        }),
    );
    const result = await webFetch.execute({ url: "https://example.com/page.xhtml" });
    if (typeof result !== "string") throw new Error("expected string result");
    expect(result).toContain("# Xhtml Title");
  });

  test("a missing content-type (empty) is treated as text and passed through", async () => {
    // Construct a Response and strip its content-type so `ct === ""` fires.
    _setRawFetch(async () => {
      const res = new Response("raw bytes here", { status: 200 });
      res.headers.delete("content-type");
      return res;
    });
    const result = await webFetch.execute({ url: "https://example.com/blob" });
    if (typeof result !== "string") throw new Error("expected string result");
    expect(result).toContain("raw bytes here");
  });

  test("an unknown binary content-type yields the non-textual placeholder", async () => {
    _setRawFetch(
      async () =>
        new Response("PKzipbytes", {
          status: 200,
          headers: { "content-type": "application/zip" },
        }),
    );
    const result = await webFetch.execute({ url: "https://example.com/archive.zip" });
    if (typeof result !== "string") throw new Error("expected string result");
    expect(result).toContain("[non-textual content: application/zip");
    expect(result).toContain("not displayed]");
  });

  test("an empty (null-body) response yields an empty body string", async () => {
    // 204 responses have res.body === null — exercises the early return in
    // readBodyCapped.
    _setRawFetch(async () => new Response(null, { status: 204 }));
    const result = await webFetch.execute({ url: "https://example.com/empty" });
    if (typeof result !== "string") throw new Error("expected string result");
    expect(result).toContain("Status: 204");
  });
});

describe("WebFetch — invalid URL + redirect edge cases", () => {
  test("a malformed URL throws WebFetchPermissionError before any fetch", async () => {
    _setRawFetch(async () => {
      throw new Error("must not fetch");
    });
    await expect(webFetch.execute({ url: "not a url" })).rejects.toBeInstanceOf(
      WebFetchPermissionError,
    );
  });

  test("a redirect with an unparseable Location header is rejected", async () => {
    _setRawFetch(
      async () =>
        new Response(null, {
          status: 302,
          // A valid HTTP header value that `new URL(loc, base)` still rejects
          // (incomplete IPv6 literal) drives the redirect-parse catch branch.
          headers: { location: "http://[" },
        }),
    );
    await expect(webFetch.execute({ url: "https://example.com/" })).rejects.toBeInstanceOf(
      WebFetchPermissionError,
    );
  });

  test("a relative redirect Location is resolved against the current URL", async () => {
    let hop = 0;
    _setRawFetch(async (req) => {
      hop++;
      if (hop === 1) {
        return new Response(null, { status: 301, headers: { location: "/landing" } });
      }
      expect(req.url).toBe("https://example.com/landing");
      return new Response("arrived", { status: 200, headers: { "content-type": "text/plain" } });
    });
    const result = await webFetch.execute({ url: "https://example.com/start" });
    if (typeof result !== "string") throw new Error("expected string result");
    expect(result).toContain("arrived");
    expect(hop).toBe(2);
  });

  test("a 3xx without a Location header is treated as a terminal response", async () => {
    _setRawFetch(
      async () =>
        new Response("moved but no location", {
          status: 304,
          headers: { "content-type": "text/plain" },
        }),
    );
    const result = await webFetch.execute({ url: "https://example.com/" });
    if (typeof result !== "string") throw new Error("expected string result");
    expect(result).toContain("Status: 304");
    expect(result).toContain("moved but no location");
  });
});

describe("getWebFetchConfig", () => {
  test("reflects the most recently registered allow-list (lower-cased)", () => {
    expect(getWebFetchConfig().allowedDomains).toEqual([]);
    registerWebFetchConfig({ allowed_domains: ["Example.COM", "Foo.org"] });
    expect(getWebFetchConfig().allowedDomains).toEqual(["example.com", "foo.org"]);
  });

  test("registerWebFetchConfig honours the camelCase alias", () => {
    registerWebFetchConfig({ allowedDomains: ["Bar.NET"] });
    expect(getWebFetchConfig().allowedDomains).toEqual(["bar.net"]);
  });
});

describe("WebFetch — ctx.signal cancellation wiring", () => {
  test("an already-aborted ctx.signal still completes against a mocked fetch", async () => {
    // Drives the `ctx.signal.aborted === true` branch: ctrl.abort(reason) runs,
    // but our stub rawFetch ignores the signal and returns a Response.
    _setRawFetch(
      async () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const result = await webFetch.execute(
      { url: "https://example.com/" },
      { signal: AbortSignal.abort(new Error("pre-aborted")) },
    );
    if (typeof result !== "string") throw new Error("expected string result");
    expect(result).toContain("ok");
  });

  test("a later ctx.signal abort fires the once-listener without affecting the result", async () => {
    _setRawFetch(
      async () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const ctrl = new AbortController();
    const result = await webFetch.execute({ url: "https://example.com/" }, { signal: ctrl.signal });
    // Abort AFTER the fetch resolved — fires the registered "abort" listener
    // (its callback body runs) on the already-settled inner controller.
    ctrl.abort(new Error("late"));
    if (typeof result !== "string") throw new Error("expected string result");
    expect(result).toContain("ok");
  });

  test("the fetch-timeout setTimeout callback aborts the controller when fired", async () => {
    // Capture the timeout callback instead of waiting 30s, then invoke it by
    // hand so its body (ctrl.abort(new Error("fetch timeout"))) is exercised
    // deterministically — no real timer, no leaked handle.
    const captured: Array<() => void> = [];
    const setSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      captured.push(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(
      (() => {}) as typeof clearTimeout,
    );
    try {
      _setRawFetch(
        async () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
      );
      const result = await webFetch.execute({ url: "https://example.com/" });
      if (typeof result !== "string") throw new Error("expected string result");
      expect(result).toContain("ok");
      expect(captured.length).toBeGreaterThanOrEqual(1);
      // Invoke the captured timeout callback — covers the abort closure body.
      for (const fn of captured) fn();
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});

describe("WebSearch — ctx.signal cancellation wiring", () => {
  test("an already-aborted ctx.signal still returns the refusal (env unset)", async () => {
    const result = await webSearch.execute(
      { query: "anything" },
      { signal: AbortSignal.abort(new Error("pre-aborted")) },
    );
    if (typeof result !== "string") throw new Error("expected string result");
    expect(result).toContain("WebSearch unavailable");
  });

  test("a later ctx.signal abort fires the once-listener", async () => {
    const ctrl = new AbortController();
    const result = await webSearch.execute({ query: "anything" }, { signal: ctrl.signal });
    ctrl.abort(new Error("late"));
    if (typeof result !== "string") throw new Error("expected string result");
    expect(result).toContain("WebSearch unavailable");
  });

  test("the search-timeout setTimeout callback aborts the controller when fired", async () => {
    const captured: Array<() => void> = [];
    const setSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      captured.push(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(
      (() => {}) as typeof clearTimeout,
    );
    try {
      const result = await webSearch.execute({ query: "anything" });
      if (typeof result !== "string") throw new Error("expected string result");
      expect(result).toContain("WebSearch unavailable");
      for (const fn of captured) fn();
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});

describe("WebFetch — production default fetch/dns wrappers", () => {
  test("defaultRawFetch delegates to globalThis.fetch when not stubbed", async () => {
    // Reset rawFetch to its production default, then mock the global fetch so
    // the default wrapper's body (globalThis.fetch(req)) runs with no network.
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response("from global fetch", {
          status: 200,
          headers: { "content-type": "text/plain" },
        })) as unknown as typeof globalThis.fetch,
    );
    try {
      _setRawFetch(undefined); // rawFetch === defaultRawFetch now
      const result = await webFetch.execute({ url: "https://example.com/" });
      if (typeof result !== "string") throw new Error("expected string result");
      expect(result).toContain("from global fetch");
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      _setRawFetch(undefined);
    }
  });

  test("defaultDnsLookup delegates to node:dns/promises lookup when not stubbed", async () => {
    // Mock the dns module so the production resolver wrapper body runs offline.
    const lookupMock = mock(async () => ({ address: "203.0.113.7", family: 4 }));
    await mock.module("node:dns/promises", () => ({ lookup: lookupMock }));
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response("ok", {
          status: 200,
          headers: { "content-type": "text/plain" },
        })) as unknown as typeof globalThis.fetch,
    );
    try {
      _setDnsLookup(undefined); // dnsLookupFn === defaultDnsLookup now
      _setRawFetch(undefined);
      const result = await webFetch.execute({ url: "https://public.example/" });
      if (typeof result !== "string") throw new Error("expected string result");
      expect(result).toContain("ok");
      expect(lookupMock).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      // Restore the real module so later suites/files are unaffected.
      mock.restore();
      _setDnsLookup(undefined);
      _setRawFetch(undefined);
    }
  });
});
