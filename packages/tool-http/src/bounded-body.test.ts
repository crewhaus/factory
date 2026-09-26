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
/** A gzip body with its middle bytes flipped: the decoder fails partway through. */
const corrupt = (() => {
  const gz = Uint8Array.from(
    gzipSync("data: a corrupt stream, long enough to corrupt\n\n".repeat(400)),
  );
  const mid = Math.floor(gz.length / 2);
  for (let i = mid; i < mid + 8; i++) gz[i] = (gz[i] as number) ^ 0xff;
  return gz;
})();
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
      if (path === "/corrupt" || path === "/sse-corrupt") {
        // Corrupt in the middle: the runtime's zlib emits `error` there and
        // never calls the write callback, which hung the reader (net review).
        return new Response(corrupt, {
          headers: {
            "content-encoding": "gzip",
            "content-type": path === "/corrupt" ? "application/json" : "text/event-stream",
          },
        });
      }
      if (path === "/gzip-crlf") {
        const gz = gzipSync('{"ok":true}');
        return new Response(new Uint8Array(Buffer.concat([gz, Buffer.from("\r\n")])), {
          headers: { "content-encoding": "gzip", "content-type": "application/json" },
        });
      }
      if (path === "/none") {
        return new Response("labelled, not encoded", { headers: { "content-encoding": "none" } });
      }
      return new Response("not really compressed", { headers: { "content-encoding": "gzip, br" } });
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

  test("net-review#critical: a corrupt gzip body fails at once, well inside the deadline", async () => {
    // The deadline is long on purpose: before the fix these calls never
    // returned at all, and a deadline answer here would mean the read hung.
    const origin = `http://127.0.0.1:${port}`;
    registerHttpConfig({ allowed_origins: [origin] });
    const request = String(
      await httpRequest.execute({ url: `${origin}/corrupt`, timeoutMs: 10_000 }),
    );
    expect(request).toBe(
      "the body is labelled as compressed but could not be decoded, so it was not read",
    );
    const sse = String(
      await sseRead.execute({ url: `${origin}/sse-corrupt`, timeoutMs: 10_000, maxEvents: 1000 }),
    );
    expect(sse).toBe(
      "the body is labelled as compressed but could not be decoded, so it was not read",
    );
  }, 30_000);

  test("net-review: a gzip body followed by a stray CRLF is read, as 0.7.0 read it", async () => {
    const origin = `http://127.0.0.1:${port}`;
    registerHttpConfig({ allowed_origins: [origin] });
    const out = JSON.parse(
      String(await httpRequest.execute({ url: `${origin}/gzip-crlf`, parseJson: true })),
    );
    expect(out.json).toEqual({ ok: true });
  });

  test("net-review: a Content-Encoding that names no coding is read as it is, and reported", async () => {
    const origin = `http://127.0.0.1:${port}`;
    registerHttpConfig({ allowed_origins: [origin] });
    const out = JSON.parse(String(await httpRequest.execute({ url: `${origin}/none` })));
    expect(out).toMatchObject({ body: "labelled, not encoded", undecodedEncoding: "none" });
    // A body with no such label carries no such field, as in 0.7.0.
    const plain = JSON.parse(String(await httpRequest.execute({ url: `${origin}/br` })));
    expect(Object.hasOwn(plain, "undecodedEncoding")).toBe(false);
  });

  test("a stack of codings the reader cannot bound is refused without quoting the body", async () => {
    const origin = `http://127.0.0.1:${port}`;
    registerHttpConfig({ allowed_origins: [origin] });
    const out = String(await httpRequest.execute({ url: `${origin}/odd` }));
    expect(out).toContain("content-encodings this tool cannot decode");
    expect(out).not.toContain("not really compressed");
  });
});
