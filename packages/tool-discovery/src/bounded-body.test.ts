/**
 * A peer's `.well-known` body is capped at MAX_WELLKNOWN_BYTES DECODED
 * (C093).
 *
 * FederationDiscover dials model-chosen public peers, and the dialler did
 * not pass `decompress: false`, so Bun inflated a gzip or brotli reply in
 * native code before the 256 KB cap saw a byte: a 260 KB gzip bomb grew RSS
 * by about 970 MiB, and a 421-byte brotli one by 843 MiB. The body is now
 * fetched raw and decoded by tool-safety's reader, with the decoder stopped
 * at the cap. These drive the production dialler against a local server
 * (the private-host policy is opened for loopback, as the offline fixture
 * does).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { brotliCompressSync, createGzip, gzipSync } from "node:zlib";
import { _resetPeerPolicy, _setFetch, fetchOnce, setPeerPolicy } from "./lib/net";
import { classifyPeer } from "./lib/peers";

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

describe("a peer's compressed reply costs at most the cap (C093)", () => {
  let gzip: Uint8Array;
  let brotli: Uint8Array;
  let server: ReturnType<typeof Bun.serve>;
  let inits: Array<Record<string, unknown> | undefined> = [];
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    gzip = await gzipBomb(256);
    brotli = new Uint8Array(brotliCompressSync(new Uint8Array(64 * 1024 * 1024)));
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/br") return new Response(brotli, { headers: { "content-encoding": "br" } });
        if (path === "/small") {
          return new Response(gzipSync('{"ok":true}'), { headers: { "content-encoding": "gzip" } });
        }
        if (path === "/corrupt") {
          return new Response(new Uint8Array([0x1f, 0x8b, 8, 0, 9, 9, 9, 9, 9, 9, 9]), {
            headers: { "content-encoding": "gzip" },
          });
        }
        return new Response(gzip, { headers: { "content-encoding": "gzip" } });
      },
    });
  }, 30_000);

  afterAll(() => {
    server.stop(true);
  });

  beforeEach(() => {
    inits = [];
    _setFetch(undefined);
    setPeerPolicy({ allowPrivateHosts: true });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      inits.push(init as Record<string, unknown> | undefined);
      return realFetch(input as Request, init);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    _resetPeerPolicy();
  });

  for (const path of ["/gzip", "/br"]) {
    test(`a ${path.slice(1)} bomb is cut at the cap without being inflated`, async () => {
      const before = rssNow();
      const { attempt, body } = await fetchOnce(`http://127.0.0.1:${server.port}${path}`, {
        timeoutMs: 20_000,
      });
      expect(rssNow() - before).toBeLessThan(96 * 1024 * 1024);
      expect(attempt).toMatchObject({ kind: "answered", status: 200, truncated: true });
      expect(body?.length ?? 0).toBeLessThanOrEqual(256 * 1024);
      expect(inits).toHaveLength(1);
      expect(inits[0]?.["decompress"]).toBe(false);
    }, 30_000);
  }

  test("a small compressed record is decoded", async () => {
    const { attempt, body } = await fetchOnce(`http://127.0.0.1:${server.port}/small`, {
      timeoutMs: 20_000,
    });
    expect(attempt).toMatchObject({ kind: "answered", truncated: false });
    expect(body).toBe('{"ok":true}');
  });

  test("a body that is not the gzip it claims to be is an unhealthy peer, not a parsed one", async () => {
    const { attempt, body } = await fetchOnce(`http://127.0.0.1:${server.port}/corrupt`, {
      timeoutMs: 20_000,
    });
    expect(attempt).toMatchObject({ kind: "answered", status: 200 });
    expect(attempt.kind === "answered" && attempt.unreadable).toContain("could not be decoded");
    expect(body).toBe("");
    const verdict = classifyPeer({
      attempt,
      fromCache: false,
      error: "the .well-known body could not be read",
      expect: {},
    });
    expect(verdict).toMatchObject({ outcome: "unhealthy", code: "unhealthy:unreadable-body" });
  });
});
