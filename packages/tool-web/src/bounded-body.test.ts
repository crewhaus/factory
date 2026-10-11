/**
 * WebFetch's 5 MB cap bounds the DECODED body (C093's WebFetch half).
 *
 * WebFetch had Fetch's reader and Fetch's gap: Bun inflated a gzip body in
 * native code before the capped reader counted a byte, and the same 256 MiB
 * gzip bomb grew RSS by about 1 GB. The body is now fetched raw and decoded
 * under the cap by @crewhaus/tool-fetch/body (this package is bundled into
 * workerd, so it cannot use @crewhaus/tool-safety). WebSearch's provider
 * replies go through the same fetcher, so they are decoded the same way.
 *
 * The production fetcher is driven against a real local server. It is on
 * loopback, which the SSRF guard refuses, so a public-looking name resolves
 * to a public-looking address and a wrapper around globalThis.fetch dials
 * loopback instead, passing the tool's init through untouched, and counts
 * what the runtime delivered for the bomb.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { createGzip, gzipSync } from "node:zlib";
import {
  _resetWebFetchConfig,
  _setDnsLookup,
  _setRawFetch,
  _setTimeoutMsForTest,
  webFetch,
  webSearch,
} from "./index";

const PUBLIC_IP = "93.184.216.34";

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

describe("WebFetch through the production fetcher (C093)", () => {
  let bomb: Uint8Array;
  let server: ReturnType<typeof Bun.serve>;
  let acceptEncodings: Array<string | null> = [];
  let inits: Array<Record<string, unknown> | undefined> = [];
  /** Bytes the runtime delivered for each /bomb response, read to its end. */
  let delivered: number[] = [];
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    bomb = await gzipBomb(256);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        acceptEncodings.push(req.headers.get("accept-encoding"));
        const path = new URL(req.url).pathname;
        if (path === "/page") {
          return new Response(gzipSync("<html><body><main><h1>Hi</h1></main></body></html>"), {
            headers: { "content-encoding": "gzip", "content-type": "text/html" },
          });
        }
        if (path === "/page-crlf") {
          // A gzip page followed by a stray CRLF, as output after a PHP `?>` leaves it.
          const gz = gzipSync("<html><body><main><h1>Padded</h1></main></body></html>");
          return new Response(new Uint8Array(Buffer.concat([gz, Buffer.from("\r\n")])), {
            headers: { "content-encoding": "gzip", "content-type": "text/html" },
          });
        }
        if (path === "/none") {
          return new Response("<html><body><main><h1>Labelled</h1></main></body></html>", {
            headers: { "content-encoding": "none", "content-type": "text/html" },
          });
        }
        if (path === "/drip") {
          // The head at once, one chunk of body, then nothing, for ever.
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("first chunk"));
              },
            }),
            { headers: { "content-type": "text/plain" } },
          );
        }
        return new Response(bomb, {
          headers: { "content-encoding": "gzip", "content-type": "text/plain" },
        });
      },
    });
  }, 30_000);

  afterAll(() => {
    server.stop(true);
  });

  beforeEach(() => {
    acceptEncodings = [];
    inits = [];
    delivered = [];
    _resetWebFetchConfig();
    _setRawFetch(undefined);
    _setDnsLookup(async () => ({ address: PUBLIC_IP, family: 4 }));
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      inits.push(init as Record<string, unknown> | undefined);
      const url = (input instanceof Request ? input.url : String(input)).replace(
        PUBLIC_IP,
        "127.0.0.1",
      );
      const res = await realFetch(input instanceof Request ? new Request(url, input) : url, init);
      if (new URL(url).pathname !== "/bomb") return res;
      // Read to the end before the tool sees it, and count: the page as sent
      // when the tool asked for it raw, the whole inflated page when it did
      // not. A constructed Response is never decoded, so the tool reads
      // exactly these bytes.
      const bytes = new Uint8Array(await res.arrayBuffer());
      delivered.push(bytes.byteLength);
      return new Response(bytes, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    _setDnsLookup(undefined);
    _setTimeoutMsForTest(undefined);
  });

  for (const [branch, host] of [
    ["a hostname pinned to its vetted address", "site.example.test"],
    ["an IP-literal URL", PUBLIC_IP],
  ] as const) {
    test(`through ${branch}, a 256 MiB gzip page is refused at the cap without being inflated`, async () => {
      await expect(
        webFetch.execute({ url: `http://${host}:${server.port}/bomb` }, {} as never),
      ).rejects.toThrow(/exceeded 5242880 bytes/);
      // The page as sent, about 260 KB; inflated by the runtime, 256 MiB.
      expect(delivered).toEqual([bomb.byteLength]);
      expect(inits).toHaveLength(1);
      expect(inits[0]?.["decompress"]).toBe(false);
      expect(acceptEncodings).toEqual(["identity"]);
    }, 20_000);
  }

  test("a page served gzip anyway is decoded and converted", async () => {
    const out = String(
      await webFetch.execute({ url: `http://site.example.test:${server.port}/page` }, {} as never),
    );
    expect(out).toContain("# Hi");
  });

  test("net-review: a gzip page followed by stray bytes is read as 0.7.0 read it", async () => {
    const out = String(
      await webFetch.execute(
        { url: `http://site.example.test:${server.port}/page-crlf` },
        {} as never,
      ),
    );
    expect(out).toContain("# Padded");
  });

  test("net-review: a page labelled with a Content-Encoding that names no coding is read as it is", async () => {
    const out = String(
      await webFetch.execute({ url: `http://site.example.test:${server.port}/none` }, {} as never),
    );
    expect(out).toContain("# Labelled");
  });

  test("the deadline covers the body: a server that sends the head and stalls is stopped", async () => {
    // The call's deadline timer is held, and fired by hand at the moment the
    // tool, holding the head and the first chunk, asks for more body than
    // the server sends: so it lands in the body however fast or slow the
    // runner, and the test does not wait it out. 0.7.0 cleared the deadline
    // once the head arrived and the read waited for ever; a cleared timer
    // is not fired, the call is ended through its own signal instead, and
    // the test fails on the reason rather than on its budget.
    const DEADLINE_MS = 2_345; // a delay nothing else here schedules
    _setTimeoutMsForTest(DEADLINE_MS);
    const HELD = Symbol("held") as unknown as ReturnType<typeof setTimeout>;
    const timer: { fire?: () => void; cleared: boolean } = { cleared: false };
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const held = spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: (...args: unknown[]) => void,
      delay?: number,
      ...rest: unknown[]
    ) => {
      if (delay !== DEADLINE_MS) return realSetTimeout(fn, delay, ...rest);
      timer.fire = () => fn(...rest);
      return HELD;
    }) as typeof setTimeout);
    const cleared = spyOn(globalThis, "clearTimeout").mockImplementation(((
      id?: ReturnType<typeof setTimeout>,
    ) => {
      if (id === HELD) timer.cleared = true;
      else realClearTimeout(id);
    }) as typeof clearTimeout);
    const runtime = new AbortController();
    let stalls = 0;
    const dial = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await dial(input, init);
      if (res.body === null) return res;
      const source = res.body.getReader();
      let reads = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            reads += 1;
            if (reads > 1 && stalls === 0) {
              // The server sent one chunk and will send nothing more.
              stalls += 1;
              if (timer.fire !== undefined && !timer.cleared) timer.fire();
              else runtime.abort(new Error("the deadline was cleared before the body was read"));
            }
            const next = await source.read();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          },
          cancel: (reason) => source.cancel(reason),
        },
        // Pulled only when the tool reads, so the second pull is the stall.
        new CountQueuingStrategy({ highWaterMark: 0 }),
      );
      return new Response(body, { status: res.status, headers: res.headers });
    }) as typeof globalThis.fetch;
    try {
      await expect(
        webFetch.execute({ url: `http://site.example.test:${server.port}/drip` }, {
          signal: runtime.signal,
        } as never),
      ).rejects.toThrow(`the request timed out after ${DEADLINE_MS}ms`);
      expect(stalls).toBe(1);
    } finally {
      held.mockRestore();
      cleared.mockRestore();
    }
  }, 20_000);
});

describe("WebSearch reads a provider's reply under the same bound (C093)", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ["CREWHAUS_SEARCH_PROVIDER", "CREWHAUS_SEARCH_API_KEY"]) {
      saved[key] = process.env[key];
    }
    process.env["CREWHAUS_SEARCH_PROVIDER"] = "brave";
    process.env["CREWHAUS_SEARCH_API_KEY"] = "test-key";
  });

  afterEach(() => {
    _setRawFetch(undefined);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("a gzip reply is decoded", async () => {
    const reply = {
      web: { results: [{ title: "T", url: "https://x.example/", description: "d" }] },
    };
    _setRawFetch(
      async () =>
        new Response(gzipSync(JSON.stringify(reply)), {
          headers: { "content-encoding": "gzip", "content-type": "application/json" },
        }),
    );
    const out = String(await webSearch.execute({ query: "q" }, {} as never));
    expect(out).toContain("1. T\n   https://x.example/");
  });

  test("a reply that decodes past the cap is refused", async () => {
    _setRawFetch(
      async () =>
        new Response(gzipSync(Buffer.alloc(6 * 1024 * 1024, 0x20)), {
          headers: { "content-encoding": "gzip", "content-type": "application/json" },
        }),
    );
    await expect(webSearch.execute({ query: "q" }, {} as never)).rejects.toThrow(
      /exceeded 5242880 bytes/,
    );
  });
});
