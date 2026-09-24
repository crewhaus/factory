/**
 * A body is capped by its DECODED size (security-5#7, the tool-notify
 * finding, in the copy of its gate this package carries).
 *
 * Bun inflates a gzip, deflate, br or zstd body in native code before any
 * reader sees a byte unless the request says `decompress: false`, so the
 * capped reader bounded only what it RETURNED. The request path now fetches
 * raw, asks for identity, and decodes under the cap. This drives the
 * production fetch path against a local server that compresses whatever it
 * was asked for, through an IP-literal origin and through a hostname pinned
 * to its vetted address.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { brotliCompressSync, createGzip } from "node:zlib";
import {
  __setPrivateHostsAllowedForTest,
  _setDnsLookup,
  buildCodehostConfig,
  openRequest,
  readCapped,
} from "./net";

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
      if (path === "/bomb") return new Response(bomb, { headers: { "content-encoding": "gzip" } });
      if (path === "/br") {
        return new Response(brotliCompressSync("hello br"), {
          headers: { "content-encoding": "br" },
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
});

const rssNow = (): number => {
  Bun.gc(true);
  return process.memoryUsage().rss;
};

async function get(origin: string, path: string, maxBytes: number) {
  const deadline = AbortSignal.timeout(10_000);
  const opened = await openRequest({
    url: new URL(`${origin}${path}`),
    method: "GET",
    headers: {},
    signal: deadline,
    cfg: buildCodehostConfig({ allowed_origins: [origin] }),
  });
  return readCapped(opened.res, maxBytes, deadline);
}

describe("a compressed body costs at most its cap", () => {
  for (const [branch, host] of [
    ["an IP-literal origin", "127.0.0.1"],
    ["a hostname pinned to its vetted address", "bomb.test"],
  ] as const) {
    test(`through ${branch}, 1 KiB of a 256 MiB gzip body is held, not the body`, async () => {
      if (host !== "127.0.0.1") _setDnsLookup(async () => ({ address: "127.0.0.1", family: 4 }));
      const before = rssNow();
      const body = await get(`http://${host}:${port}`, "/bomb", 1024);
      const grew = rssNow() - before;
      expect(body).toEqual({ text: "\u0000".repeat(1024), bytes: 1024, truncated: true });
      expect(acceptEncodings).toEqual(["identity"]);
      expect(grew).toBeLessThan(64 * 1024 * 1024);
    }, 20_000);
  }

  test("a server that compresses anyway is still read, decoded", async () => {
    const body = await get(`http://127.0.0.1:${port}`, "/br", 1024);
    expect(body).toEqual({ text: "hello br", bytes: 8, truncated: false });
  });

  test("a coding the reader cannot bound is refused without quoting the body", async () => {
    const err = await get(`http://127.0.0.1:${port}`, "/odd", 1024).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toContain("content-encoding this tool cannot decode");
    expect(err?.message).not.toContain("not really compressed");
  });
});
