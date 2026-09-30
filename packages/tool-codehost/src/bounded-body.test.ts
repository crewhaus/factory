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
import { brotliCompressSync, createGzip, gzipSync } from "node:zlib";
import { rateLimitStatus } from "./index";
import {
  __setPrivateHostsAllowedForTest,
  _resetCodehostConfig,
  _setDnsLookup,
  buildCodehostConfig,
  openRequest,
  readCapped,
  registerCodehostConfig,
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
/** A gzip body with its middle bytes flipped: the decoder fails partway through. */
const corrupt = (() => {
  const gz = Uint8Array.from(gzipSync(JSON.stringify({ filler: "x ".repeat(20_000) })));
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
      if (path === "/bomb") return new Response(bomb, { headers: { "content-encoding": "gzip" } });
      if (path === "/br") {
        return new Response(brotliCompressSync("hello br"), {
          headers: { "content-encoding": "br" },
        });
      }
      if (path === "/corrupt/rate_limit") {
        // Corrupt in the middle: the runtime's zlib emits `error` there and
        // never calls the write callback, which hung the reader (net review).
        return new Response(corrupt, {
          headers: { "content-encoding": "gzip", "content-type": "application/json" },
        });
      }
      if (path === "/crlf/rate_limit") {
        const gz = gzipSync(
          JSON.stringify({ resources: { core: { limit: 5, remaining: 4, used: 1, reset: 1 } } }),
        );
        return new Response(new Uint8Array(Buffer.concat([gz, Buffer.from("\r\n")])), {
          headers: { "content-encoding": "gzip", "content-type": "application/json" },
        });
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

  test("net-review#critical: a codehost read of a corrupt gzip reply fails at once, well inside its deadline", async () => {
    const origin = `http://127.0.0.1:${port}`;
    process.env["CREWHAUS_TEST_BOUNDED_TOKEN"] = ["tok", "en-for-a-local-server"].join("");
    registerCodehostConfig({
      allowed_origins: [origin],
      base_url: origin,
      token_env: "CREWHAUS_TEST_BOUNDED_TOKEN",
    });
    try {
      // The deadline is the tool's own 30 s default: before the fix this call
      // never returned at all.
      const out = String(
        await rateLimitStatus.execute({ baseUrl: `${origin}/corrupt` }, {} as never),
      );
      expect(out).toBe(
        "the body is labelled as compressed but could not be decoded, so it was not read",
      );
      const padded = JSON.parse(
        String(await rateLimitStatus.execute({ baseUrl: `${origin}/crlf` }, {} as never)),
      );
      expect(padded.resources.core).toMatchObject({ limit: 5, remaining: 4 });
    } finally {
      _resetCodehostConfig();
      Reflect.deleteProperty(process.env, "CREWHAUS_TEST_BOUNDED_TOKEN");
    }
  }, 40_000);

  test("a stack of codings the reader cannot bound is refused without quoting the body", async () => {
    const err = await get(`http://127.0.0.1:${port}`, "/odd", 1024).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toContain("content-encodings this tool cannot decode");
    expect(err?.message).not.toContain("not really compressed");
  });
});
