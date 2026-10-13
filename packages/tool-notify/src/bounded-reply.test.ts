/**
 * A reply is capped by its DECODED size (C086, security-5#7).
 *
 * Bun inflates a gzip, deflate, br or zstd body in native code before any
 * reader sees a byte unless the request says `decompress: false`, and it
 * keeps `Content-Encoding` and the compressed `Content-Length` on the
 * response, so nothing downstream can tell. 0.7.0's capped reader therefore
 * bounded only what it RETURNED: a 300 KB gzip reply cost about 860 MB. The
 * sends and DeliveryCheck now fetch the body raw, ask for identity, and
 * decode it here under the cap.
 *
 * These run the production fetch path against a real local server that
 * compresses whatever it was asked for, both through an IP-literal origin
 * and through a hostname pinned to its vetted address (the two branches of
 * `pinnedFetch`).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { brotliCompressSync, createGzip } from "node:zlib";
import {
  __setPrivateHostsAllowedForTest,
  _resetNotifyConfig,
  _setDnsLookup,
  deliveryCheck,
  webhookPost,
} from "./index";

/** 256 MiB of zeros as gzip, built in 1 MiB steps so building it is cheap too. */
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
    fetch: async (req) => {
      acceptEncodings.push(req.headers.get("accept-encoding"));
      await req.arrayBuffer();
      const path = new URL(req.url).pathname;
      if (path.startsWith("/bomb")) {
        // Ignores Accept-Encoding, as a hostile endpoint would.
        return new Response(bomb, {
          headers: { "content-encoding": "gzip", "content-type": "application/json" },
        });
      }
      if (path.startsWith("/br")) {
        return new Response(brotliCompressSync(JSON.stringify({ status: "delivered" })), {
          headers: { "content-encoding": "br", "content-type": "application/json" },
        });
      }
      if (path.startsWith("/compress")) {
        return new Response("not really compressed", {
          headers: { "content-encoding": "gzip, br" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
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
  _resetNotifyConfig();
});

const configFor = (origin: string) => ({
  allowed_origins: [origin],
  providers: {
    p: { endpoint: `${origin}/sms`, statusEndpoint: `${origin}/bomb/{id}`, statusPath: "status" },
    brotli: {
      endpoint: `${origin}/sms`,
      statusEndpoint: `${origin}/br/{id}`,
      statusPath: "status",
    },
    odd: { endpoint: `${origin}/sms`, statusEndpoint: `${origin}/compress/{id}` },
  },
});

/** One reply a tool fetched, as the runtime handed it over. */
type Metered = { handed: number; pulled: number };

/**
 * Counts what the runtime hands JavaScript for each reply fetched during
 * `run`, instead of reading the process's RSS, which moves with the
 * allocator and with every other test in the process (a loaded CI runner
 * read 61 MB where this package's formatter test allowed 40 MB).
 *
 * The tool's reader gets each reply in 4 KiB pieces, one per read, so
 * `pulled` is how much of it the tool read before it stopped, whatever sizes
 * the socket delivered. After `run` the rest is drained, so `handed` is the
 * whole reply as the runtime gave it: its size on the wire when it was
 * fetched raw, and every decoded byte when the runtime inflated it natively,
 * as 0.7.0's requests let it (256 MiB here).
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

describe("a compressed reply costs at most its cap (C086)", () => {
  for (const [branch, host] of [
    ["an IP-literal origin", "127.0.0.1"],
    ["a hostname pinned to its vetted address", "bomb.test"],
  ] as const) {
    test(`DeliveryCheck through ${branch} holds maxBytes of a 256 MiB gzip reply, not the reply`, async () => {
      if (host !== "127.0.0.1") _setDnsLookup(async () => ({ address: "127.0.0.1", family: 4 }));
      const origin = `http://${host}:${port}`;
      const { result: out, metered } = await meterBodies(() =>
        deliveryCheck.execute({ provider: "p", messageId: "m1", maxBytes: 1024 }, {
          toolConfig: configFor(origin),
        } as never),
      );
      const parsed = JSON.parse(String(out)) as { body: string; truncated?: boolean };
      expect(parsed.truncated).toBe(true);
      expect(parsed.body).toBe("\u0000".repeat(1024));
      expect(acceptEncodings).toEqual(["identity"]);
      // Decoding the whole reply costs hundreds of megabytes; the cap plus
      // one decoder step costs a few. Counted, not measured: the runtime
      // handed the reply over as it is on the wire, so it inflated none of
      // it, and the tool read a decoder step or two of it, not all.
      expect(metered).toHaveLength(1);
      expect(metered[0]?.handed).toBe(bomb.byteLength);
      expect(metered[0]?.pulled).toBeLessThanOrEqual(64 * 1024);
    }, 20_000);
  }

  test("a send reads its reply under the same bound", async () => {
    const origin = `http://127.0.0.1:${port}`;
    const { result: out, metered } = await meterBodies(() =>
      webhookPost.execute({ url: `${origin}/bomb/hook`, payload: { e: 1 }, maxBytes: 2048 }, {
        toolConfig: configFor(origin),
      } as never),
    );
    expect(metered).toHaveLength(1);
    expect(metered[0]?.handed).toBe(bomb.byteLength);
    expect(metered[0]?.pulled).toBeLessThanOrEqual(64 * 1024);
    expect(JSON.parse(String(out))).toMatchObject({ sent: true, status: 200 });
    expect(acceptEncodings).toEqual(["identity"]);
  }, 20_000);

  test("a provider that compresses anyway is still read, decoded", async () => {
    const out = await deliveryCheck.execute({ provider: "brotli", messageId: "m1" }, {
      toolConfig: configFor(`http://127.0.0.1:${port}`),
    } as never);
    expect(JSON.parse(String(out)).deliveryStatus).toBe("delivered");
  });

  test("a stack of codings the reader cannot bound is refused without quoting the reply", async () => {
    const out = String(
      await deliveryCheck.execute({ provider: "odd", messageId: "m1" }, {
        toolConfig: configFor(`http://127.0.0.1:${port}`),
      } as never),
    );
    expect(out).toContain("content-encodings this tool cannot decode");
    expect(out).not.toContain("not really compressed");
  });
});
