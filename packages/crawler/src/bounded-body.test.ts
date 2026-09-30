/**
 * The crawler's body cap bounds the DECODED body, and a file source is read
 * bounded and only as a regular file (C093, and C074's FIFO class).
 *
 * Unless the final `fetch` call says `decompress: false`, Bun inflates a
 * gzip, deflate, br or zstd body in native code before any reader sees a
 * byte. 0.7.0's capped reader therefore fired only after the runtime had
 * inflated the whole body: a 260 KB gzip of 256 MiB of zeros grew RSS by
 * about 960 MiB before "exceeds 5242880 bytes". The body is now fetched raw
 * and decoded by tool-safety's reader, with the decoder stopped at the cap.
 *
 * These drive the PRODUCTION dialler against a real local server that
 * ignores Accept-Encoding. The server is on loopback, which the SSRF guard
 * refuses, so the test resolves the name to a public-looking address and a
 * wrapper around globalThis.fetch dials loopback instead, passing the init
 * through untouched — which is also how it sees what the crawler asked for.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGzip, gzipSync } from "node:zlib";
import { createCitationTracker } from "@crewhaus/citation-tracker";
import { _setDnsLookup, createCrawler } from "./index";

const PUBLIC_IP = "93.184.216.34";

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

describe("a compressed reply costs at most the cap (C093)", () => {
  let bomb: Uint8Array;
  let server: ReturnType<typeof Bun.serve>;
  let inits: Array<Record<string, unknown> | undefined> = [];
  let root: string;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    bomb = await gzipBomb(256);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/hello") {
          return new Response(gzipSync("hello world"), {
            headers: { "content-encoding": "gzip", "content-type": "text/plain" },
          });
        }
        if (path === "/corrupt") {
          return new Response(new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3, 4, 5, 6, 7, 8]), {
            headers: { "content-encoding": "gzip" },
          });
        }
        return new Response(bomb, { headers: { "content-encoding": "gzip" } });
      },
    });
  }, 30_000);

  afterAll(() => {
    server.stop(true);
  });

  beforeEach(() => {
    inits = [];
    root = realpathSync(mkdtempSync(join(tmpdir(), "crawler-bomb-")));
    _setDnsLookup(async () => ({ address: PUBLIC_IP, family: 4 }));
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      inits.push(init as Record<string, unknown> | undefined);
      const url = (input instanceof Request ? input.url : String(input)).replace(
        PUBLIC_IP,
        "127.0.0.1",
      );
      return realFetch(url, init);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    _setDnsLookup(undefined);
    rmSync(root, { recursive: true, force: true });
  });

  const crawlerFor = (origin: string) =>
    createCrawler({
      tracker: createCitationTracker({ rootDir: root }),
      config: { allowedOrigins: new Set([origin]) },
    });

  for (const [branch, host] of [
    ["a hostname pinned to its vetted address", "api.example.test"],
    ["an IP-literal origin", PUBLIC_IP],
  ] as const) {
    test(`through ${branch}, a 256 MiB gzip reply is refused at the cap without being inflated`, async () => {
      const origin = `http://${host}:${server.port}`;
      const before = rssNow();
      await expect(crawlerFor(origin).fetch(`${origin}/bomb`)).rejects.toThrow(
        /exceeds 5242880 bytes/,
      );
      // Inflating the reply costs about 1 GB; the cap costs a few MB.
      expect(rssNow() - before).toBeLessThan(96 * 1024 * 1024);
      expect(inits).toHaveLength(1);
      expect(inits[0]?.["decompress"]).toBe(false);
    }, 30_000);
  }

  test("a server that compresses anyway is read and decoded", async () => {
    const origin = `http://api.example.test:${server.port}`;
    const r = await crawlerFor(origin).fetch(`${origin}/hello`);
    expect(r.content).toBe("hello world");
    expect(inits[0]?.["decompress"]).toBe(false);
  });

  test("a body that is not the gzip it claims to be is refused, not returned", async () => {
    const origin = `http://api.example.test:${server.port}`;
    await expect(crawlerFor(origin).fetch(`${origin}/corrupt`)).rejects.toThrow(
      /labelled as compressed but could not be decoded/,
    );
  });
});

describe("a file source is read bounded, and only as a regular file", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "crawler-file-")));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test.if(process.platform !== "win32")(
    "a FIFO under a crawler root is refused without being opened",
    async () => {
      // With no writer, opening a FIFO blocks for ever, and the read was
      // synchronous. A writer waits on the pipe so this stays bounded even
      // against that code; it never exits here, because nothing opens it.
      const fifo = join(root, "page.txt");
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
      const writer = Bun.spawn(["sh", "-c", `printf x > '${fifo}'`], {
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        const crawler = createCrawler({
          tracker: createCitationTracker({ rootDir: join(root, ".cite") }),
          config: { allowedFileRoots: [root] },
        });
        await expect(crawler.fetch(`file://${fifo}`)).rejects.toThrow(
          /is a fifo, not a regular file/,
        );
        expect(writer.exitCode).toBeNull();
      } finally {
        writer.kill("SIGKILL");
        await writer.exited;
      }
    },
    10_000,
  );
});
