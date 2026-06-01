import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  WebFetchPermissionError,
  _resetWebFetchConfig,
  _setDnsLookup,
  _setRawFetch,
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
});
