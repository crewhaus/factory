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

/** One body a tool fetched, as the runtime handed it over. */
type Metered = { handed: number; pulled: number };

/**
 * Counts what the runtime hands JavaScript for each body fetched during
 * `run`, instead of reading the process's RSS, which moves with the
 * allocator and with every other test in the process (a loaded CI runner
 * read 61 MB where tool-notify's formatter test allowed 40 MB).
 *
 * The tool's reader gets each body in 4 KiB pieces, one per read, so
 * `pulled` is how much of it the tool read before it stopped, whatever sizes
 * the socket delivered. After `run` the rest is drained, so `handed` is the
 * whole body as the runtime gave it: its size on the wire when it was
 * fetched raw, and every decoded byte when the runtime inflated it natively,
 * as 0.7.0's dialler let it (256 MiB or 64 MiB here).
 */
async function meterBodies<T>(run: () => Promise<T>): Promise<{ result: T; metered: Metered[] }> {
  const previous = globalThis.fetch;
  const bodies: Array<{ count: Metered; drain: () => Promise<void> }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await previous(input as Request, init);
    if (res.body === null) return res;
    const source = res.body.getReader();
    const count: Metered = { handed: 0, pulled: 0 };
    bodies.push({
      count,
      drain: async () => {
        for (let next = await source.read(); !next.done; next = await source.read()) {
          count.handed += next.value.byteLength;
        }
      },
    });
    let left: Uint8Array = new Uint8Array(0);
    const pieces = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          while (left.byteLength === 0) {
            const next = await source.read();
            if (next.done) {
              controller.close();
              return;
            }
            count.handed += next.value.byteLength;
            left = next.value;
          }
          const piece = left.subarray(0, 4096);
          left = left.subarray(piece.byteLength);
          count.pulled += piece.byteLength;
          controller.enqueue(piece);
        },
      },
      { highWaterMark: 0 },
    );
    Object.defineProperty(res, "body", { value: pieces });
    return res;
  }) as typeof globalThis.fetch;
  let result: T;
  try {
    result = await run();
  } finally {
    globalThis.fetch = previous;
  }
  for (const { drain } of bodies) await drain();
  return { result, metered: bodies.map(({ count }) => count) };
}

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
      const { result, metered } = await meterBodies(() =>
        fetchOnce(`http://127.0.0.1:${server.port}${path}`, { timeoutMs: 20_000 }),
      );
      const { attempt, body } = result;
      // The runtime handed the body over as it is on the wire, so it inflated
      // none of it, and the reader stopped within a few decoder steps (the
      // whole gzip is 255 KiB on the wire; the brotli is smaller than a step).
      expect(metered).toHaveLength(1);
      expect(metered[0]?.handed).toBe((path === "/br" ? brotli : gzip).byteLength);
      expect(metered[0]?.pulled).toBeLessThanOrEqual(64 * 1024);
      // `bytes` is what the decoder produced: it stopped a chunk past the cap,
      // so the brotli, read whole in one piece, was not inflated here either.
      expect(attempt.kind === "answered" ? attempt.bytes : Number.NaN).toBeLessThanOrEqual(
        320 * 1024,
      );
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
