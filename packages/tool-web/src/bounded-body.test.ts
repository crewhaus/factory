/**
 * WebFetch's 5 MB cap bounds the DECODED body (C093's WebFetch half).
 *
 * WebFetch had Fetch's reader and Fetch's gap: Bun inflated a gzip body in
 * native code before the capped reader counted a byte, and the same 256 MiB
 * gzip bomb grew RSS by about 1 GB. The body is now fetched raw and decoded
 * under the cap by @crewhaus/tool-fetch/body (this package is bundled into
 * workerd, so it cannot use @crewhaus/tool-safety). WebSearch's provider
 * replies go through the same fetcher, so they are decoded the same way.
 *
 * The production fetcher is driven against a real local server. It is on
 * loopback, which the SSRF guard refuses, so a public-looking name resolves
 * to a public-looking address and a wrapper around globalThis.fetch dials
 * loopback instead, passing the tool's init through untouched.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createGzip, gzipSync } from "node:zlib";
import {
  _resetWebFetchConfig,
  _setDnsLookup,
  _setRawFetch,
  _setTimeoutMsForTest,
  webFetch,
  webSearch,
} from "./index";

const PUBLIC_IP = "93.184.216.34";

async function gzipBomb(mib: number): Promise<Uint8Array> {
  const gz = createGzip({ level: 9 });
  const parts: Buffer[] = [];
  gz.on("data", (b: Buffer) => parts.push(b));
  const done = new Promise<void>((resolve) => gz.on("end", () => resolve()));
  const zeros = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < mib; i++) {
    if (!gz.write(zeros)) await new Promise<void>((resolve) => gz.once("drain", () => resolve()));
  }
  gz.end();
  await done;
  return new Uint8Array(Buffer.concat(parts));
}

const rssNow = (): number => {
  Bun.gc(true);
  return process.memoryUsage().rss;
};

describe("WebFetch through the production fetcher (C093)", () => {
  let bomb: Uint8Array;
  let server: ReturnType<typeof Bun.serve>;
  let acceptEncodings: Array<string | null> = [];
  let inits: Array<Record<string, unknown> | undefined> = [];
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    bomb = await gzipBomb(256);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        acceptEncodings.push(req.headers.get("accept-encoding"));
        const path = new URL(req.url).pathname;
        if (path === "/page") {
          return new Response(gzipSync("<html><body><main><h1>Hi</h1></main></body></html>"), {
            headers: { "content-encoding": "gzip", "content-type": "text/html" },
          });
        }
        if (path === "/page-crlf") {
          // A gzip page followed by a stray CRLF, as output after a PHP `?>` leaves it.
          const gz = gzipSync("<html><body><main><h1>Padded</h1></main></body></html>");
          return new Response(new Uint8Array(Buffer.concat([gz, Buffer.from("\r\n")])), {
            headers: { "content-encoding": "gzip", "content-type": "text/html" },
          });
        }
        if (path === "/none") {
          return new Response("<html><body><main><h1>Labelled</h1></main></body></html>", {
            headers: { "content-encoding": "none", "content-type": "text/html" },
          });
        }
        if (path === "/drip") {
          // The head at once, one chunk of body, then nothing, for ever.
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("first chunk"));
              },
            }),
            { headers: { "content-type": "text/plain" } },
          );
        }
        return new Response(bomb, {
          headers: { "content-encoding": "gzip", "content-type": "text/plain" },
        });
      },
    });
  }, 30_000);

  afterAll(() => {
    server.stop(true);
  });

  beforeEach(() => {
    acceptEncodings = [];
    inits = [];
    _resetWebFetchConfig();
    _setRawFetch(undefined);
    _setDnsLookup(async () => ({ address: PUBLIC_IP, family: 4 }));
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      inits.push(init as Record<string, unknown> | undefined);
      if (input instanceof Request) {
        return realFetch(new Request(input.url.replace(PUBLIC_IP, "127.0.0.1"), input), init);
      }
      return realFetch(String(input).replace(PUBLIC_IP, "127.0.0.1"), init);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    _setDnsLookup(undefined);
    _setTimeoutMsForTest(undefined);
  });

  for (const [branch, host] of [
    ["a hostname pinned to its vetted address", "site.example.test"],
    ["an IP-literal URL", PUBLIC_IP],
  ] as const) {
    test(`through ${branch}, a 256 MiB gzip page is refused at the cap without being inflated`, async () => {
      const before = rssNow();
      await expect(
        webFetch.execute({ url: `http://${host}:${server.port}/bomb` }, {} as never),
      ).rejects.toThrow(/exceeded 5242880 bytes/);
      expect(rssNow() - before).toBeLessThan(64 * 1024 * 1024);
      expect(inits).toHaveLength(1);
      expect(inits[0]?.["decompress"]).toBe(false);
      expect(acceptEncodings).toEqual(["identity"]);
    }, 20_000);
  }

  test("a page served gzip anyway is decoded and converted", async () => {
    const out = String(
      await webFetch.execute({ url: `http://site.example.test:${server.port}/page` }, {} as never),
    );
    expect(out).toContain("# Hi");
  });

  test("net-review: a gzip page followed by stray bytes is read as 0.7.0 read it", async () => {
    const out = String(
      await webFetch.execute(
        { url: `http://site.example.test:${server.port}/page-crlf` },
        {} as never,
      ),
    );
    expect(out).toContain("# Padded");
  });

  test("net-review: a page labelled with a Content-Encoding that names no coding is read as it is", async () => {
    const out = String(
      await webFetch.execute({ url: `http://site.example.test:${server.port}/none` }, {} as never),
    );
    expect(out).toContain("# Labelled");
  });

  test("the deadline covers the body: a server that sends the head and stalls is stopped", async () => {
    // Generous next to a loopback head (milliseconds), and far short of the
    // test's budget; 0.7.0 cleared the deadline once the head arrived, so
    // the read waited for ever.
    _setTimeoutMsForTest(2_000);
    const started = performance.now();
    await expect(
      webFetch.execute({ url: `http://site.example.test:${server.port}/drip` }, {} as never),
    ).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 20_000);
});

describe("WebSearch reads a provider's reply under the same bound (C093)", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ["CREWHAUS_SEARCH_PROVIDER", "CREWHAUS_SEARCH_API_KEY"]) {
      saved[key] = process.env[key];
    }
    process.env["CREWHAUS_SEARCH_PROVIDER"] = "brave";
    process.env["CREWHAUS_SEARCH_API_KEY"] = "test-key";
  });

  afterEach(() => {
    _setRawFetch(undefined);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("a gzip reply is decoded", async () => {
    const reply = {
      web: { results: [{ title: "T", url: "https://x.example/", description: "d" }] },
    };
    _setRawFetch(
      async () =>
        new Response(gzipSync(JSON.stringify(reply)), {
          headers: { "content-encoding": "gzip", "content-type": "application/json" },
        }),
    );
    const out = String(await webSearch.execute({ query: "q" }, {} as never));
    expect(out).toContain("1. T\n   https://x.example/");
  });

  test("a reply that decodes past the cap is refused", async () => {
    _setRawFetch(
      async () =>
        new Response(gzipSync(Buffer.alloc(6 * 1024 * 1024, 0x20)), {
          headers: { "content-encoding": "gzip", "content-type": "application/json" },
        }),
    );
    await expect(webSearch.execute({ query: "q" }, {} as never)).rejects.toThrow(
      /exceeded 5242880 bytes/,
    );
  });
});
