/**
 * An OSV reply is capped on its DECODED size (C093).
 *
 * The production dialler did not pass `decompress: false`, so Bun inflated a
 * gzip, deflate, br or zstd reply in native code before the capped reader
 * saw a byte: a 260 KB gzip of zeros cost about 1 GB of RSS before the cap
 * fired. The body is now fetched raw (`fetchRaw`, via tool-safety) and decoded under the cap.
 *
 * These drive the PRODUCTION dialler with `globalThis.fetch` replaced by a
 * recorder that answers in-process: it sees exactly the init the dialler
 * passed, and a constructed Response is never decoded by the runtime, so it
 * stands for a raw body exactly. Nothing touches the network.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { _setFetch, queryBatches } from "./net";

/** 64 MiB of zeros, gzipped: about 64 KB on the wire. */
let bomb: Uint8Array;
const realFetch = globalThis.fetch;
let inits: Array<Record<string, unknown> | undefined> = [];
let answer: () => Response = () => new Response("");

beforeAll(() => {
  bomb = new Uint8Array(gzipSync(new Uint8Array(64 * 1024 * 1024), { level: 9 }));
});

beforeEach(() => {
  inits = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    inits.push(init as Record<string, unknown> | undefined);
    return answer();
  }) as typeof globalThis.fetch;
  _setFetch(undefined);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  _setFetch(undefined);
});

const gz =
  (body: Uint8Array | string): (() => Response) =>
  () =>
    new Response(body, { headers: { "content-encoding": "gzip" } });
const corrupt = gz(new Uint8Array([0x1f, 0x8b, 8, 0, 9, 9, 9, 9, 9, 9, 9, 9]));

describe("OSV replies are bounded", () => {
  const budget = { base: "https://api.osv.dev", timeoutMs: 20_000 };
  const coords = [
    { ecosystem: "npm" as const, name: "left-pad", version: "1.0.0", source: "bun.lock" },
  ];

  test("a gzip bomb is refused at the cap, and the body was asked for raw", async () => {
    answer = gz(bomb);
    await expect(queryBatches(budget, coords)).rejects.toThrow(/returned more than 16777216 bytes/);
    expect(inits[0]?.["decompress"]).toBe(false);
  });

  test("a compressed reply is decoded", async () => {
    answer = gz(gzipSync('{"results":[{}]}'));
    await expect(queryBatches(budget, coords)).resolves.toMatchObject({ hits: [], batches: 1 });
  });

  test("a body that is not the gzip it claims to be is refused, never audited as clean", async () => {
    answer = corrupt;
    await expect(queryBatches(budget, coords)).rejects.toThrow(
      /could not be decoded; nothing was audited/,
    );
  });
});
