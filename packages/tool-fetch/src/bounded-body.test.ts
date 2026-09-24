/**
 * Fetch's 5 MB cap bounds the DECODED body (C093, security-9#4).
 *
 * Unless the final `fetch` call says `decompress: false`, Bun inflates a
 * gzip, deflate, br or zstd body in native code before any reader sees a
 * byte, and keeps `Content-Encoding` on the response. 0.7.0's capped reader
 * therefore fired only after the runtime had inflated the whole body: a
 * 260 KB gzip of 256 MiB of zeros grew RSS by about 970 MiB before the
 * "exceeded" error. The body is now fetched raw and decoded in ./body.ts
 * with the decoder stopped at the cap.
 *
 * The first block drives the PRODUCTION fetcher (both branches of
 * pinnedFetch) against a real local server that ignores Accept-Encoding.
 * The server is on loopback, which the SSRF guard refuses, so the test
 * resolves a public-looking name to a public-looking address and a wrapper
 * around globalThis.fetch dials loopback instead, passing the init through
 * untouched — which is also how it sees what the tool asked for.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  brotliCompressSync,
  createGzip,
  deflateRawSync,
  deflateSync,
  gzipSync,
  zstdCompressSync,
} from "node:zlib";
import {
  _resetFetchConfig,
  _setDnsLookup,
  _setRawFetch,
  fetch,
  registerFetchConfig,
} from "./index";

const PUBLIC_IP = "93.184.216.34";
const CAP = 5 * 1024 * 1024;

/** `mib` MiB of zeros as gzip, built in 1 MiB steps so building it is cheap too. */
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

describe("a compressed reply costs at most the cap, through the production fetcher (C093)", () => {
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
        if (path === "/hello") {
          return new Response(gzipSync("hello world"), {
            headers: { "content-encoding": "gzip", "content-type": "text/plain" },
          });
        }
        // Ignores Accept-Encoding, as a hostile endpoint would.
        return new Response(bomb, {
          headers: { "content-encoding": "gzip", "content-type": "application/json" },
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
    _resetFetchConfig();
    _setRawFetch(undefined);
    _setDnsLookup(async () => ({ address: PUBLIC_IP, family: 4 }));
    // Dial loopback wherever the tool dialled the public address, and pass
    // the tool's init through as it was given.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      inits.push(init as Record<string, unknown> | undefined);
      if (input instanceof Request) {
        const url = input.url.replace(PUBLIC_IP, "127.0.0.1");
        return realFetch(new Request(url, input), init);
      }
      return realFetch(String(input).replace(PUBLIC_IP, "127.0.0.1"), init);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    _resetFetchConfig();
    _setDnsLookup(undefined);
  });

  for (const [branch, host] of [
    ["a hostname pinned to its vetted address", "api.example.test"],
    ["an IP-literal origin", PUBLIC_IP],
  ] as const) {
    test(`through ${branch}, a 256 MiB gzip reply is refused at the cap without being inflated`, async () => {
      const origin = `http://${host}:${server.port}`;
      registerFetchConfig({ allowed_origins: [origin] });
      const before = rssNow();
      await expect(fetch.execute({ url: `${origin}/bomb` }, {} as never)).rejects.toThrow(
        /exceeded 5242880 bytes/,
      );
      const grew = rssNow() - before;
      // Inflating the reply costs about 1 GB; the cap costs a few MB.
      expect(grew).toBeLessThan(64 * 1024 * 1024);
      // Because the body was asked for raw, and as it is.
      expect(inits).toHaveLength(1);
      expect(inits[0]?.["decompress"]).toBe(false);
      expect(acceptEncodings).toEqual(["identity"]);
    }, 20_000);
  }

  test("a server that compresses anyway is read, decoded, and its wire headers are not shown", async () => {
    const origin = `http://api.example.test:${server.port}`;
    registerFetchConfig({ allowed_origins: [origin] });
    const out = String(await fetch.execute({ url: `${origin}/hello` }, {} as never));
    expect(out.endsWith("\nhello world")).toBe(true);
    expect(out.toLowerCase()).not.toContain("content-encoding");
    expect(out.toLowerCase()).not.toContain("content-length");
  });

  test("a caller's own Accept-Encoding is kept, and the reply is still decoded under the cap", async () => {
    const origin = `http://api.example.test:${server.port}`;
    registerFetchConfig({ allowed_origins: [origin] });
    const out = String(
      await fetch.execute(
        { url: `${origin}/hello`, headers: { "Accept-Encoding": "gzip" } },
        {} as never,
      ),
    );
    expect(acceptEncodings).toEqual(["gzip"]);
    expect(inits[0]?.["decompress"]).toBe(false);
    expect(out.endsWith("\nhello world")).toBe(true);
  });
});

describe("the decoder (C093)", () => {
  beforeEach(() => {
    _resetFetchConfig();
    _setDnsLookup(async () => ({ address: PUBLIC_IP, family: 4 }));
    registerFetchConfig({ allowed_origins: ["https://api.example.com"] });
  });

  afterEach(() => {
    _resetFetchConfig();
    _setRawFetch(undefined);
    _setDnsLookup(undefined);
  });

  const serve = (body: Uint8Array | string, encoding: string): void => {
    // A constructed Response is never decoded by the runtime, so it stands
    // for a raw body exactly.
    _setRawFetch(
      async () =>
        new Response(body, {
          headers: { "content-encoding": encoding, "content-type": "text/plain" },
        }),
    );
  };

  for (const [coding, encode] of [
    ["gzip", (s: string) => gzipSync(s)],
    ["x-gzip", (s: string) => gzipSync(s)],
    ["deflate", (s: string) => deflateSync(s)],
    ["br", (s: string) => brotliCompressSync(s)],
    ["zstd", (s: string) => zstdCompressSync(s)],
  ] as const) {
    test(`a ${coding} body comes back decoded`, async () => {
      serve(new Uint8Array(encode(`hello ${coding}`)), coding);
      const out = String(await fetch.execute({ url: "https://api.example.com/x" }, {} as never));
      expect(out.endsWith(`\nhello ${coding}`)).toBe(true);
    });
  }

  test("a raw-deflate body (a common server mistake) is decoded too", async () => {
    serve(new Uint8Array(deflateRawSync("hello raw")), "deflate");
    const out = String(await fetch.execute({ url: "https://api.example.com/x" }, {} as never));
    expect(out.endsWith("\nhello raw")).toBe(true);
  });

  for (const [coding, encode] of [
    ["gzip", (b: Buffer) => gzipSync(b)],
    ["br", (b: Buffer) => brotliCompressSync(b)],
    ["zstd", (b: Buffer) => zstdCompressSync(b)],
  ] as const) {
    test(`a ${coding} body that decodes past the cap is refused, though its wire size is small`, async () => {
      const encoded = new Uint8Array(encode(Buffer.alloc(CAP + 1)));
      expect(encoded.byteLength).toBeLessThan(CAP / 100);
      serve(encoded, coding);
      await expect(
        fetch.execute({ url: "https://api.example.com/x" }, {} as never),
      ).rejects.toThrow(/exceeded 5242880 bytes/);
    });
  }

  test("a body that decodes to exactly the cap is returned", async () => {
    serve(new Uint8Array(gzipSync(Buffer.alloc(CAP, 0x61))), "gzip");
    const out = String(await fetch.execute({ url: "https://api.example.com/x" }, {} as never));
    expect(out.endsWith(`\n${"a".repeat(CAP)}`)).toBe(true);
  });

  for (const coding of ["compress", "gzip, br", "gzip, gzip"]) {
    test(`content-encoding "${coding}" is refused without quoting the body`, async () => {
      serve("SECRET-BODY-TEXT", coding);
      const err = await fetch.execute({ url: "https://api.example.com/x" }, {} as never).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toMatch(/cannot decode/);
      expect(err?.message).not.toContain("SECRET-BODY-TEXT");
    });
  }

  test("a body that is not what its content-encoding says is refused without quoting it", async () => {
    serve("SECRET-BODY-TEXT, not gzip", "gzip");
    const err = await fetch.execute({ url: "https://api.example.com/x" }, {} as never).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/not valid gzip data/);
    expect(err?.message).not.toContain("SECRET-BODY-TEXT");
  });

  test("identity is not decoding: its headers are shown as sent", async () => {
    _setRawFetch(
      async () =>
        new Response("plain", {
          headers: { "content-encoding": "identity", "content-type": "text/plain" },
        }),
    );
    const out = String(await fetch.execute({ url: "https://api.example.com/x" }, {} as never));
    expect(out).toContain("content-encoding: identity");
    expect(out.endsWith("\nplain")).toBe(true);
  });
});
