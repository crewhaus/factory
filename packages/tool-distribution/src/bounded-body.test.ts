/**
 * A release asset is capped on its DECODED size (C093).
 *
 * The production dialler did not pass `decompress: false`, so Bun inflated a
 * gzip, deflate, br or zstd reply in native code before the capped reader
 * saw a byte: a 260 KB gzip of zeros cost about 1 GB of RSS before the cap
 * fired. The body is now fetched raw (`fetchRaw`, via tool-safety, and hashed chunk by chunk as it is decoded) and decoded under the cap.
 *
 * These drive the PRODUCTION dialler with `globalThis.fetch` replaced by a
 * recorder that answers in-process: it sees exactly the init the dialler
 * passed, and a constructed Response is never decoded by the runtime, so it
 * stands for a raw body exactly. Nothing touches the network.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { _setDnsLookup } from "@crewhaus/tool-fetch";
import { _setFetch, probeAsset } from "./lib/net";

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
  _setDnsLookup(async () => ({ address: "93.184.216.34", family: 4 }));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  _setFetch(undefined);
  _setDnsLookup(undefined);
});

const gz =
  (body: Uint8Array | string): (() => Response) =>
  () =>
    new Response(body, { headers: { "content-encoding": "gzip" } });
const corrupt = gz(new Uint8Array([0x1f, 0x8b, 8, 0, 9, 9, 9, 9, 9, 9, 9, 9]));

describe("asset downloads are bounded", () => {
  const url = "https://dl.example.test/tool-1.2.3.tar.gz";

  // Slow by construction (inflating a bomb up to the cap; 1.9 s on CI's loaded runner).
  test("a gzip bomb past the cap is 'could not check', and the body was asked for raw", async () => {
    answer = gz(bomb);
    const probe = await probeAsset(url, { maxBytes: 8 * 1024 * 1024, timeoutMs: 20_000 });
    expect(probe).toMatchObject({ kind: "unknown", reason: "cap" });
    expect(inits[0]?.["decompress"]).toBe(false);
  }, 20_000);

  // Slow by construction (inflating and hashing 64 MiB; 2.7 s on CI's loaded runner).
  test("an encoded asset under the cap is hashed as the decoded bytes, never held whole", async () => {
    answer = gz(bomb);
    const probe = await probeAsset(url, { maxBytes: 128 * 1024 * 1024, timeoutMs: 20_000 });
    // sha256 of 64 MiB of zeros.
    expect(probe).toMatchObject({
      kind: "ok",
      bytes: 64 * 1024 * 1024,
      sha256: "3b6a07d0d404fab4e23b6d34bc6696a6a312dd92821332385e5af7c01c421351",
    });
  }, 20_000);

  test("a body that is not the gzip it claims to be is 'unreadable', not a mismatch", async () => {
    answer = corrupt;
    const probe = await probeAsset(url, { maxBytes: 8 * 1024 * 1024, timeoutMs: 20_000 });
    expect(probe).toMatchObject({ kind: "unknown", reason: "unreadable" });
  });
});
