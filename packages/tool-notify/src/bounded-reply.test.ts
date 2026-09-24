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
          headers: { "content-encoding": "compress" },
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

const rssNow = (): number => {
  Bun.gc(true);
  return process.memoryUsage().rss;
};

describe("a compressed reply costs at most its cap (C086)", () => {
  for (const [branch, host] of [
    ["an IP-literal origin", "127.0.0.1"],
    ["a hostname pinned to its vetted address", "bomb.test"],
  ] as const) {
    test(`DeliveryCheck through ${branch} holds maxBytes of a 256 MiB gzip reply, not the reply`, async () => {
      if (host !== "127.0.0.1") _setDnsLookup(async () => ({ address: "127.0.0.1", family: 4 }));
      const origin = `http://${host}:${port}`;
      const before = rssNow();
      const out = await deliveryCheck.execute({ provider: "p", messageId: "m1", maxBytes: 1024 }, {
        toolConfig: configFor(origin),
      } as never);
      const grew = rssNow() - before;
      const parsed = JSON.parse(String(out)) as { body: string; truncated?: boolean };
      expect(parsed.truncated).toBe(true);
      expect(parsed.body).toBe("\u0000".repeat(1024));
      expect(acceptEncodings).toEqual(["identity"]);
      // Decoding the whole reply costs hundreds of megabytes; the cap plus
      // one decoder step costs a few.
      expect(grew).toBeLessThan(64 * 1024 * 1024);
    }, 20_000);
  }

  test("a send reads its reply under the same bound", async () => {
    const origin = `http://127.0.0.1:${port}`;
    const before = rssNow();
    const out = await webhookPost.execute(
      { url: `${origin}/bomb/hook`, payload: { e: 1 }, maxBytes: 2048 },
      { toolConfig: configFor(origin) } as never,
    );
    expect(rssNow() - before).toBeLessThan(64 * 1024 * 1024);
    expect(JSON.parse(String(out))).toMatchObject({ sent: true, status: 200 });
    expect(acceptEncodings).toEqual(["identity"]);
  }, 20_000);

  test("a provider that compresses anyway is still read, decoded", async () => {
    const out = await deliveryCheck.execute({ provider: "brotli", messageId: "m1" }, {
      toolConfig: configFor(`http://127.0.0.1:${port}`),
    } as never);
    expect(JSON.parse(String(out)).deliveryStatus).toBe("delivered");
  });

  test("a coding the reader cannot bound is refused without quoting the reply", async () => {
    const out = String(
      await deliveryCheck.execute({ provider: "odd", messageId: "m1" }, {
        toolConfig: configFor(`http://127.0.0.1:${port}`),
      } as never),
    );
    expect(out).toContain("content-encoding this tool cannot decode");
    expect(out).not.toContain("not really compressed");
  });
});
