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
import { brotliCompressSync, createGzip, deflateSync, gzipSync } from "node:zlib";
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
      if (path === "/deflate-split") {
        // A zlib-wrapped deflate reply whose first byte is sent on its own.
        const payload = deflateSync('{"ok":true,"items":[1,2,3]}');
        const body = new ReadableStream<Uint8Array>({
          async start(c) {
            c.enqueue(payload.subarray(0, 1));
            await Bun.sleep(30);
            c.enqueue(payload.subarray(1));
            c.close();
          },
        });
        return new Response(body, {
          headers: { "content-encoding": "deflate", "content-type": "application/json" },
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

/** The size of each read the tool is handed in {@link countDelivered}. */
const PULL_CHUNK = 4096;

/**
 * Run `call` with each response read to its end before the tool sees it,
 * and count two things for each, in bytes, rather than read the process's
 * RSS, which moves with the allocator and with every other test in the
 * process.
 *
 * `delivered`: what the runtime delivered. The body as sent when the
 * request said `decompress: false`; the whole inflated body when it did
 * not, however little of it the tool then read.
 *
 * `pulled`: how much of that the tool took. It gets the same bytes in a
 * constructed Response, which the runtime never decodes, through a stream
 * that hands over {@link PULL_CHUNK} bytes per read and never reads ahead.
 * A tool that decodes under its cap stops after a chunk or two; one that
 * inflates the whole body itself and only then cuts it pulls all of it.
 */
async function countDelivered<T>(
  call: () => Promise<T>,
): Promise<{ value: T; delivered: number[]; pulled: number[] }> {
  const realFetch = globalThis.fetch;
  const delivered: number[] = [];
  const pulled: number[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await realFetch(input, init);
    const bytes = new Uint8Array(await res.arrayBuffer());
    delivered.push(bytes.byteLength);
    const at = pulled.push(0) - 1;
    let offset = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (offset >= bytes.byteLength) {
            controller.close();
            return;
          }
          const chunk = bytes.slice(offset, offset + PULL_CHUNK);
          offset += chunk.byteLength;
          pulled[at] = offset;
          controller.enqueue(chunk);
        },
      },
      new CountQueuingStrategy({ highWaterMark: 0 }),
    );
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }) as typeof globalThis.fetch;
  try {
    return { value: await call(), delivered, pulled };
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe("a compressed body costs at most its cap", () => {
  for (const [branch, host] of [
    ["an IP-literal origin", "127.0.0.1"],
    ["a hostname pinned to its vetted address", "bomb.test"],
  ] as const) {
    test(`HttpRequest through ${branch} holds maxBytes of a 256 MiB gzip body, not the body`, async () => {
      if (host !== "127.0.0.1") _setDnsLookup(async () => ({ address: "127.0.0.1", family: 4 }));
      const origin = `http://${host}:${port}`;
      registerHttpConfig({ allowed_origins: [origin] });
      const { value, delivered, pulled } = await countDelivered(() =>
        httpRequest.execute({ url: `${origin}/bomb`, maxBytes: 1024 }),
      );
      const out = JSON.parse(String(value)) as {
        body: string;
        truncated?: boolean;
        status: number;
      };
      expect(out.status).toBe(200);
      expect(out.truncated).toBe(true);
      expect(out.body).toBe("\u0000".repeat(1024));
      expect(acceptEncodings).toEqual(["identity"]);
      // The body as sent, about 260 KB: inflated by the runtime it is 256 MiB.
      expect(delivered).toEqual([bomb.byteLength]);
      // And the tool's own decoder stopped at the cap: one chunk of the
      // 260 KB inflates past 1 KiB. Inflating it all first pulls all of it.
      expect(pulled).toHaveLength(1);
      expect(pulled[0]).toBeLessThan(64 * 1024);
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
    const { value, delivered, pulled } = await countDelivered(() =>
      sseRead.execute({ url: `${origin}/bomb`, maxBytes: 4096, timeoutMs: 5_000 }),
    );
    const out = JSON.parse(String(value));
    expect(delivered).toEqual([bomb.byteLength]);
    // The stream was decoded under the cap, not inflated whole and then cut.
    expect(pulled).toHaveLength(1);
    expect(pulled[0]).toBeLessThan(64 * 1024);
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

  test("net regression review: a deflate reply whose first byte arrives alone is decoded, as 0.7.0 decoded it", async () => {
    const origin = `http://127.0.0.1:${port}`;
    registerHttpConfig({ allowed_origins: [origin] });
    const out = JSON.parse(
      String(await httpRequest.execute({ url: `${origin}/deflate-split`, parseJson: true })),
    );
    expect(out.json).toEqual({ ok: true, items: [1, 2, 3] });
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
