import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as zlib from "node:zlib";
import { readResponseBounded, withRawBody } from "./response";

/**
 * Compression bombs, built at test time from zeros. 16 MiB decoded against a
 * 64 KiB cap: a reader that inflated the whole body would report ~16 MiB of
 * decoded bytes; a bounded one stops within one decoder chunk of the cap.
 */
const DECODED = 16 * 1024 * 1024;
const CAP = 64 * 1024;
/** One decoder output chunk past the cap is the most a bounded reader may see. */
const SLACK = 64 * 1024;

const zeros = new Uint8Array(DECODED);
const bombs: Record<string, Uint8Array> = {
  gzip: zlib.gzipSync(zeros),
  deflate: zlib.deflateSync(zeros),
  "deflate-raw": zlib.deflateRawSync(zeros),
  br: zlib.brotliCompressSync(zeros),
};
const hasZstd =
  typeof (zlib as unknown as { createZstdDecompress?: unknown }).createZstdDecompress ===
  "function";
if (hasZstd) bombs["zstd"] = Bun.zstdCompressSync(zeros);

function encoded(body: Uint8Array | string, encoding?: string, extra: Record<string, string> = {}) {
  return new Response(body, {
    headers: { ...(encoding === undefined ? {} : { "content-encoding": encoding }), ...extra },
  });
}

describe("readResponseBounded", () => {
  test("an identity body under the cap is returned whole", async () => {
    const r = await readResponseBounded(encoded('{"a":1}'), { maxBytes: 100 });
    expect(r).toMatchObject({
      ok: true,
      text: '{"a":1}',
      truncated: false,
      decodedBytes: 7,
      contentEncoding: null,
    });
  });

  test("an identity body over the cap stops there and says the count is a lower bound", async () => {
    const r = await readResponseBounded(encoded("x".repeat(10_000)), { maxBytes: 100 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bytes.length).toBe(100);
    expect(r.truncated).toBe(true);
    expect(r.decodedBytes).toBeGreaterThan(100);
  });

  test("a compressed body is decoded exactly when it fits", async () => {
    const text = JSON.stringify({ hello: "w\u00f6rld", n: [1, 2, 3] });
    for (const [encoding, body] of [
      ["gzip", zlib.gzipSync(text)],
      ["x-gzip", zlib.gzipSync(text)],
      ["deflate", zlib.deflateSync(text)],
      ["deflate", zlib.deflateRawSync(text)],
      ["br", zlib.brotliCompressSync(text)],
    ] as const) {
      const r = await readResponseBounded(encoded(body, encoding), { maxBytes: 1_000 });
      expect({ encoding, r }).toMatchObject({ encoding, r: { ok: true, text, truncated: false } });
    }
  });

  test("security-5#7 / security-9#4: every bomb is stopped at the cap, not inflated", async () => {
    let checked = 0;
    for (const [name, body] of Object.entries(bombs)) {
      const encoding = name === "deflate-raw" ? "deflate" : name;
      const r = await readResponseBounded(encoded(body, encoding), { maxBytes: CAP });
      expect({ name, ok: r.ok }).toEqual({ name, ok: true });
      if (!r.ok) continue;
      expect({ name, kept: r.bytes.length, truncated: r.truncated }).toEqual({
        name,
        kept: CAP,
        truncated: true,
      });
      // The property that bounds memory: decoding stopped near the cap.
      expect(r.decodedBytes).toBeGreaterThan(CAP);
      expect(r.decodedBytes).toBeLessThanOrEqual(CAP + SLACK);
      expect(r.decodedBytes).toBeLessThan(DECODED);
      checked += 1;
    }
    expect(checked).toBe(Object.keys(bombs).length);
    expect(checked).toBeGreaterThanOrEqual(4);
  }, 30_000);

  test("codings it cannot decode within a bound are refused, and the body is not read", async () => {
    for (const encoding of ["compress", "gzip, br", "snappy"]) {
      const r = await readResponseBounded(encoded("abc", encoding), { maxBytes: 100 });
      expect({ encoding, r }).toMatchObject({
        encoding,
        r: { ok: false, code: "unsupported-encoding" },
      });
    }
  });

  test("a corrupt compressed body is a decode-error, not an empty success", async () => {
    const bad = zlib.gzipSync("hello world, a body long enough to corrupt").slice(0, 20);
    const r = await readResponseBounded(encoded(bad, "gzip"), { maxBytes: 1_000 });
    expect(r).toMatchObject({ ok: false, code: "decode-error" });
  });

  test("a gzip label on a body that is not gzip is refused as auto-decompressed", async () => {
    const r = await readResponseBounded(encoded("plain text, not gzip", "gzip"), {
      maxBytes: 1_000,
    });
    expect(r).toMatchObject({ ok: false, code: "auto-decompressed" });
  });

  test("an abort is reported as such", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await readResponseBounded(encoded("abc"), {
      maxBytes: 10,
      signal: controller.signal,
    });
    expect(r).toMatchObject({ ok: false, code: "aborted" });
  });
});

describe("readResponseBounded against a real fetch", () => {
  // A small bomb, so the misuse case (which Bun inflates natively) stays cheap.
  const small = zlib.gzipSync(new Uint8Array(1024 * 1024));
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(small, { headers: { "content-encoding": "gzip" } }),
    });
  });
  afterAll(() => {
    server.stop(true);
  });

  test("with withRawBody, the decoded size is bounded", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/`, withRawBody({}));
    const r = await readResponseBounded(res, { maxBytes: 4_096 });
    expect(r).toMatchObject({ ok: true, truncated: true, contentEncoding: "gzip" });
    if (r.ok) expect(r.decodedBytes).toBeLessThanOrEqual(4_096 + SLACK);
  });

  test("without it, the runtime has already inflated the body, and that is refused loudly", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    const r = await readResponseBounded(res, { maxBytes: 4_096 });
    expect(r).toMatchObject({ ok: false, code: "auto-decompressed" });
  });
});
