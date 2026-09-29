/**
 * A registry reply is capped on its DECODED size (C093).
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
import { _setDnsLookup } from "@crewhaus/tool-fetch";
import { _setFetch, httpGet } from "./lib/http";

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

describe("registry replies are bounded", () => {
  const url = new URL("https://registry.example.test/v2/library/app/manifests/1.0");

  test("a gzip bomb is refused at the cap, and the body was asked for raw", async () => {
    answer = gz(bomb);
    await expect(httpGet(url, { maxBytes: 4 * 1024 * 1024 })).rejects.toThrow(
      /exceeded 4194304 bytes/,
    );
    expect(inits[0]?.["decompress"]).toBe(false);
  });

  test("a compressed body comes back as exactly the decoded bytes", async () => {
    answer = gz(gzipSync('{"schemaVersion":2}'));
    const out = await httpGet(url, { maxBytes: 4 * 1024 * 1024 });
    expect(new TextDecoder().decode(out.bytes)).toBe('{"schemaVersion":2}');
  });

  test("a body that is not the gzip it claims to be is refused", async () => {
    answer = corrupt;
    await expect(httpGet(url, { maxBytes: 4 * 1024 * 1024 })).rejects.toThrow(
      /could not be decoded/,
    );
  });
});
