/**
 * A body is capped by its DECODED size (the tool-notify finding,
 * security-5#7, in the package it copied its gate from).
 *
 * Bun inflates a gzip, deflate, br or zstd body in native code before any
 * reader sees a byte unless the request says `decompress: false`, and keeps
 * `Content-Encoding` and the compressed `Content-Length`, so nothing
 * downstream can tell. The capped readers here therefore bounded only what
 * they RETURNED. Every tool now fetches raw, asks for identity, and decodes
 * under the cap. These run the production fetch path against a local server
 * that compresses whatever it was asked for, through an IP-literal origin
 * and through a hostname pinned to its vetted address.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { brotliCompressSync, createGzip, gzipSync } from "node:zlib";
import {
  __setPrivateHostsAllowedForTest,
  _resetHttpConfig,
  _setDnsLookup,
  httpRequest,
  registerHttpConfig,
  sseRead,
} from "./index";

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

let bomb: Uint8Array;
let server: ReturnType<typeof Bun.serve>;
let port = 0;
let acceptEncodings: Array<string | null> = [];

beforeAll(async () => {
  bomb = await gzipBomb(256);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      acceptEncodings.push(req.headers.get("accept-encoding"));
      const path = new URL(req.url).pathname;
      if (path === "/bomb") {
        return new Response(bomb, { headers: { "content-encoding": "gzip" } });
      }
      if (path === "/br") {
        return new Response(brotliCompressSync("hello br"), {
          headers: { "content-encoding": "br", "content-type": "text/plain" },
        });
      }
      if (path === "/sse") {
        return new Response(gzipSync("data: one\n\ndata: two\n\n"), {
          headers: { "content-encoding": "gzip", "content-type": "text/event-stream" },
        });
      }
      return new Response("not really compressed", { headers: { "content-encoding": "compress" } });
    },
  });
  port = server.port ?? 0;
}, 30_000);

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  acceptEncodings = [];
  __setPrivateHostsAllowedForTest(true);
});

afterEach(() => {
  __setPrivateHostsAllowedForTest(false);
  _setDnsLookup(undefined);
  _resetHttpConfig();
});

const rssNow = (): number => {
  Bun.gc(true);
  return process.memoryUsage().rss;
};

describe("a compressed body costs at most its cap", () => {
  for (const [branch, host] of [
    ["an IP-literal origin", "127.0.0.1"],
    ["a hostname pinned to its vetted address", "bomb.test"],
  ] as const) {
    test(`HttpRequest through ${branch} holds maxBytes of a 256 MiB gzip body, not the body`, async () => {
      if (host !== "127.0.0.1") _setDnsLookup(async () => ({ address: "127.0.0.1", family: 4 }));
      const origin = `http://${host}:${port}`;
      registerHttpConfig({ allowed_origins: [origin] });
      const before = rssNow();
      const out = JSON.parse(
        String(await httpRequest.execute({ url: `${origin}/bomb`, maxBytes: 1024 })),
      ) as { body: string; truncated?: boolean; status: number };
      const grew = rssNow() - before;
      expect(out.status).toBe(200);
      expect(out.truncated).toBe(true);
      expect(out.body).toBe("\u0000".repeat(1024));
      expect(acceptEncodings).toEqual(["identity"]);
      expect(grew).toBeLessThan(64 * 1024 * 1024);
    }, 20_000);
  }

  test("a server that compresses anyway is still read, decoded", async () => {
    const origin = `http://127.0.0.1:${port}`;
    registerHttpConfig({ allowed_origins: [origin] });
    const out = JSON.parse(String(await httpRequest.execute({ url: `${origin}/br` })));
    expect(out.body).toBe("hello br");
  });

  test("SseRead decodes a compressed stream under its cap", async () => {
    const origin = `http://127.0.0.1:${port}`;
    registerHttpConfig({ allowed_origins: [origin] });
    const out = JSON.parse(
      String(await sseRead.execute({ url: `${origin}/sse`, timeoutMs: 5_000 })),
    );
    expect(out.events.map((e: { data: string }) => e.data)).toEqual(["one", "two"]);
    expect(out.stoppedBy).toBe("streamEnded");
  });

  test("SseRead stops a compressed bomb at its byte cap", async () => {
    const origin = `http://127.0.0.1:${port}`;
    registerHttpConfig({ allowed_origins: [origin] });
    const before = rssNow();
    const out = JSON.parse(
      String(await sseRead.execute({ url: `${origin}/bomb`, maxBytes: 4096, timeoutMs: 5_000 })),
    );
    expect(rssNow() - before).toBeLessThan(64 * 1024 * 1024);
    expect(out.stoppedBy).toBe("byteCap");
    expect(out.bytes).toBeLessThanOrEqual(4096);
  }, 20_000);

  test("a coding the reader cannot bound is refused without quoting the body", async () => {
    const origin = `http://127.0.0.1:${port}`;
    registerHttpConfig({ allowed_origins: [origin] });
    const out = String(await httpRequest.execute({ url: `${origin}/odd` }));
    expect(out).toContain("content-encoding this tool cannot decode");
    expect(out).not.toContain("not really compressed");
  });
});
