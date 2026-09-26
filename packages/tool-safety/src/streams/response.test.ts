import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as zlib from "node:zlib";
import { crc32, crc32Js } from "./decoders";
import { decodeBody, fetchRaw, readResponseBounded, withRawBody } from "./response";

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

/** Whether `signal` has aborted within `ms`, polled without adding a listener. */
async function firesWithin(signal: AbortSignal, ms: number): Promise<boolean> {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    if (signal.aborted) return true;
    await Bun.sleep(20);
  }
  return signal.aborted;
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

  test("a stack of codings it cannot decode within a bound is refused, and the body is not read", async () => {
    let checked = 0;
    for (const encoding of ["gzip, br", "br, gzip", "deflate, snappy"]) {
      const r = await readResponseBounded(encoded("abc", encoding), { maxBytes: 100 });
      expect({ encoding, r }).toMatchObject({
        encoding,
        r: { ok: false, code: "unsupported-encoding" },
      });
      checked += 1;
    }
    expect(checked).toBe(3);
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

  test("fetchRaw keeps the body raw for a Request too, where a Request's own init does not", async () => {
    const url = `http://127.0.0.1:${server.port}/`;
    const viaRequest = await readResponseBounded(await fetchRaw(new Request(url)), {
      maxBytes: 4_096,
    });
    expect(viaRequest).toMatchObject({ ok: true, truncated: true, contentEncoding: "gzip" });
    // Bun ignores `decompress` inside a Request's init: the reason fetchRaw exists.
    const ignored = await readResponseBounded(
      await fetch(new Request(url, withRawBody({}) as RequestInit)),
      { maxBytes: 4_096 },
    );
    expect(ignored).toMatchObject({ ok: false, code: "auto-decompressed" });
  });
});

describe("a body that stalls", () => {
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      // One chunk, then nothing, and the body never ends.
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first chunk"));
            },
          }),
        ),
    });
  });
  afterAll(() => {
    server.stop(true);
  });
  const stalled = (): Promise<Response> => fetchRaw(`http://127.0.0.1:${server.port}/`);

  test("an abort while a read is pending ends the read", async () => {
    // Aborted only once the first chunk is in: the next read is then
    // certainly pending, since the server never sends another.
    const controller = new AbortController();
    const body = decodeBody(await stalled(), { maxBytes: 1_000, signal: controller.signal });
    let chunks = 0;
    for await (const _ of body) {
      chunks += 1;
      setTimeout(() => controller.abort(), 20);
    }
    expect(chunks).toBe(1);
    expect(body.outcome).toMatchObject({ ok: false, code: "aborted", encodedBytes: 11 });
  }, 20_000);

  test("idleTimeoutMs abandons a body that sends nothing for that long", async () => {
    const r = await readResponseBounded(await stalled(), { maxBytes: 1_000, idleTimeoutMs: 100 });
    expect(r).toMatchObject({ ok: false, code: "stalled" });
    if (!r.ok) expect(r.reason).toContain("100 ms");
  }, 20_000);

  test("a caller's AbortSignal.timeout still fires after a read finished with it", async () => {
    // Bun 1.3.14 cancels an AbortSignal.timeout() for good when its last
    // listener is removed; a finished read must not do that.
    const signal = AbortSignal.timeout(500);
    const first = await readResponseBounded(encoded("done"), { maxBytes: 10, signal });
    expect(first.ok || first.code === "aborted").toBe(true);
    expect(await firesWithin(signal, 15_000)).toBe(true);
  }, 20_000);
});

describe("decodeBody", () => {
  test("hands over decoded chunks as they are produced, never more than maxBytes in all", async () => {
    const body = decodeBody(encoded(bombs["gzip"] as Uint8Array, "gzip"), { maxBytes: CAP });
    let chunks = 0;
    let total = 0;
    for await (const chunk of body) {
      chunks += 1;
      total += chunk.length;
    }
    expect(chunks).toBeGreaterThan(1);
    expect(total).toBe(CAP);
    expect(body.outcome).toMatchObject({ ok: true, truncated: true, contentEncoding: "gzip" });
    if (body.outcome?.ok) expect(body.outcome.decodedBytes).toBeLessThanOrEqual(CAP + SLACK);
  });

  test("a body that fits ends with truncated false, and its bytes are exact", async () => {
    const text = "event: x\ndata: 1\n\n".repeat(200);
    const body = decodeBody(encoded(zlib.brotliCompressSync(text), "br"), { maxBytes: 1_000_000 });
    const parts: Uint8Array[] = [];
    for await (const chunk of body) parts.push(chunk);
    expect(new TextDecoder().decode(Buffer.concat(parts))).toBe(text);
    expect(body.outcome).toMatchObject({ ok: true, truncated: false, decodedBytes: text.length });
  });

  test("a failure ends the iteration and is the outcome, never an empty success", async () => {
    const body = decodeBody(encoded("plain text, not gzip", "gzip"), { maxBytes: 1_000 });
    let chunks = 0;
    for await (const _ of body) chunks += 1;
    expect(chunks).toBe(0);
    expect(body.outcome).toMatchObject({ ok: false, code: "auto-decompressed" });
  });

  test("breaking out early cancels the body and says the read stopped", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1_024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const body = decodeBody(new Response(stream), { maxBytes: 1_000_000 });
    for await (const _ of body) break;
    expect(cancelled).toBe(true);
    expect(body.outcome).toMatchObject({ ok: false, code: "aborted" });
  });
});

describe("budgets", () => {
  test("a NaN, negative or missing maxBytes throws instead of reading an empty body", async () => {
    for (const maxBytes of [Number.NaN, -1, undefined]) {
      await expect(
        readResponseBounded(encoded("hello world"), { maxBytes } as unknown as {
          maxBytes: number;
        }),
      ).rejects.toThrow(RangeError);
    }
    await expect(
      readResponseBounded(encoded("x"), { maxBytes: 10, idleTimeoutMs: Number.NaN }),
    ).rejects.toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// corrupt, padded and oddly labelled bodies (net review, 0.7.1)
// ---------------------------------------------------------------------------

/** A gzip member built by hand, so every header flag can be exercised. */
function gzipMember(
  text: string,
  opts: { extra?: Uint8Array; name?: string; comment?: string; hcrc?: boolean | number } = {},
): Uint8Array {
  const data = new TextEncoder().encode(text);
  let flags = 0;
  if (opts.hcrc !== undefined && opts.hcrc !== false) flags |= 0x02;
  if (opts.extra !== undefined) flags |= 0x04;
  if (opts.name !== undefined) flags |= 0x08;
  if (opts.comment !== undefined) flags |= 0x10;
  const head: number[] = [0x1f, 0x8b, 8, flags, 0, 0, 0, 0, 0, 0xff];
  if (opts.extra !== undefined)
    head.push(opts.extra.length & 0xff, opts.extra.length >> 8, ...opts.extra);
  if (opts.name !== undefined) head.push(...new TextEncoder().encode(opts.name), 0);
  if (opts.comment !== undefined) head.push(...new TextEncoder().encode(opts.comment), 0);
  if (opts.hcrc !== undefined && opts.hcrc !== false) {
    const crc = typeof opts.hcrc === "number" ? opts.hcrc : crc32Js(new Uint8Array(head)) & 0xffff;
    head.push(crc & 0xff, crc >> 8);
  }
  const le = (n: number): number[] => [
    n & 0xff,
    (n >>> 8) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 24) & 0xff,
  ];
  return new Uint8Array([
    ...head,
    ...zlib.deflateRawSync(data),
    ...le(crc32Js(data)),
    ...le(data.length),
  ]);
}

/** A response whose body arrives in `size`-byte chunks, then (optionally) never ends. */
function chunked(bytes: Uint8Array, size: number, encoding: string, endless = false) {
  let at = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at < bytes.length) {
        controller.enqueue(bytes.slice(at, at + size));
        at += size;
      } else if (endless) {
        controller.enqueue(new TextEncoder().encode("junk after the member "));
      } else {
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    res: new Response(stream, { headers: { "content-encoding": encoding } }),
    cancelled: () => cancelled,
  };
}

describe("a corrupt compressed body fails, and never holds the reader", () => {
  const text = "a body long enough to corrupt in the middle, ".repeat(400);
  const corruptMiddle = (body: Uint8Array): Uint8Array => {
    const bad = Uint8Array.from(body);
    const mid = Math.floor(bad.length / 2);
    for (let i = mid; i < mid + 8 && i < bad.length; i++) bad[i] = (bad[i] as number) ^ 0xff;
    return bad;
  };
  const cases: Array<[string, Uint8Array]> = [
    ["gzip", corruptMiddle(zlib.gzipSync(text))],
    ["deflate", corruptMiddle(zlib.deflateSync(text))],
    ["br", corruptMiddle(zlib.brotliCompressSync(text))],
  ];
  if (hasZstd) {
    // A zstd frame without a checksum decodes corrupt literals silently, so
    // the damage goes where the format can see it: the first block.
    const bad = Uint8Array.from(Bun.zstdCompressSync(text));
    bad[9] = (bad[9] as number) ^ 0xff;
    cases.push(["zstd", bad]);
  }

  test("net-review#critical: corrupt mid-stream is a decode-error before the signal fires", async () => {
    // Before the fix the runtime's zlib emitted `error` and never called the
    // write callback, so these stayed pending past any signal. The signal is
    // long: an outcome of `aborted` here means the read hung.
    let checked = 0;
    for (const [encoding, body] of cases) {
      const r = await readResponseBounded(encoded(body, encoding), {
        maxBytes: 1 << 20,
        signal: AbortSignal.timeout(10_000),
      });
      expect({ encoding, code: r.ok ? "ok" : r.code }).toEqual({ encoding, code: "decode-error" });
      checked += 1;
    }
    expect(checked).toBe(cases.length);
    expect(checked).toBeGreaterThanOrEqual(3);
  }, 30_000);

  test("gzip integrity: a missing or short trailer, a bad CRC or size, and a cut header all fail", async () => {
    const good = zlib.gzipSync("hello world");
    const flip = (at: number): Uint8Array => {
      const b = Uint8Array.from(good);
      b[b.length + at] = (b[b.length + at] as number) ^ 1;
      return b;
    };
    const bodies: Record<string, Uint8Array> = {
      "no trailer": good.subarray(0, good.length - 8),
      "half a trailer": good.subarray(0, good.length - 4),
      "bad CRC": flip(-8),
      "bad size": flip(-1),
      "cut header": good.subarray(0, 6),
      "bad header CRC": gzipMember("x", { hcrc: 0x1234 }),
      "reserved flag": Uint8Array.from([0x1f, 0x8b, 8, 0x20, 0, 0, 0, 0, 0, 3, 1, 2, 3, 4]),
    };
    let checked = 0;
    for (const [name, body] of Object.entries(bodies)) {
      const r = await readResponseBounded(encoded(body, "gzip"), {
        maxBytes: 1_000,
        signal: AbortSignal.timeout(10_000),
      });
      expect({ name, code: r.ok ? "ok" : r.code }).toEqual({ name, code: "decode-error" });
      checked += 1;
    }
    expect(checked).toBe(7);
  }, 30_000);
});

describe("what counts as the body", () => {
  const text = '{"hello":"world"}';
  const gz = zlib.gzipSync(text);
  const cat = (...parts: Uint8Array[]): Uint8Array => new Uint8Array(Buffer.concat(parts));

  test("net-review: bytes after a gzip member are not part of the body, as Bun's own decoder reads it", async () => {
    const tails: Record<string, Uint8Array> = {
      CRLF: new Uint8Array([13, 10]),
      LF: new Uint8Array([10]),
      xx: new TextEncoder().encode("xx"),
      "20 junk": new TextEncoder().encode("<!-- trailing html -->"),
      "NUL padding": new Uint8Array(16),
      "a lone 0x1f": new Uint8Array([0x1f]),
      "a second member": zlib.gzipSync("second"),
    };
    let checked = 0;
    for (const [name, tail] of Object.entries(tails)) {
      const r = await readResponseBounded(encoded(cat(gz, tail), "gzip"), {
        maxBytes: 1_000,
        signal: AbortSignal.timeout(10_000),
      });
      expect({ name, r }).toMatchObject({ name, r: { ok: true, text, truncated: false } });
      checked += 1;
    }
    expect(checked).toBe(7);
  }, 30_000);

  test("deflate and br bodies followed by stray bytes read their data", async () => {
    let checked = 0;
    for (const [encoding, body] of [
      ["deflate", zlib.deflateSync(text)],
      ["deflate", zlib.deflateRawSync(text)],
      ["br", zlib.brotliCompressSync(text)],
    ] as const) {
      const r = await readResponseBounded(encoded(cat(body, new Uint8Array([13, 10])), encoding), {
        maxBytes: 1_000,
        signal: AbortSignal.timeout(10_000),
      });
      expect({ encoding, r }).toMatchObject({ encoding, r: { ok: true, text } });
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  test("a member followed by an endless stream is read, and the rest is cancelled, not read", async () => {
    const { res, cancelled } = chunked(gz, 4, "gzip", true);
    const r = await readResponseBounded(res, {
      maxBytes: 1_000,
      signal: AbortSignal.timeout(10_000),
    });
    expect(r).toMatchObject({ ok: true, text, truncated: false });
    expect(cancelled()).toBe(true);
  }, 20_000);

  test("every header flag is read, one byte per chunk as well as whole", async () => {
    const member = gzipMember(text, {
      extra: new Uint8Array([1, 2, 3, 4, 5]),
      name: "a.json",
      comment: "made by hand",
      hcrc: true,
    });
    let checked = 0;
    for (const size of [1, 3, member.length]) {
      const { res } = chunked(cat(member, new Uint8Array([13, 10])), size, "gzip");
      const r = await readResponseBounded(res, {
        maxBytes: 1_000,
        signal: AbortSignal.timeout(10_000),
      });
      expect({ size, r }).toMatchObject({ size, r: { ok: true, text } });
      checked += 1;
    }
    expect(checked).toBe(3);
  }, 20_000);

  test("net-review: a label that names no coding is read as the bytes it is, and reported", async () => {
    let checked = 0;
    for (const label of ["none", "UTF-8", "binary", "compress", "snappy", "none, none"]) {
      const r = await readResponseBounded(encoded("plain body", label), { maxBytes: 100 });
      expect({ label, r }).toMatchObject({
        label,
        r: {
          ok: true,
          text: "plain body",
          contentEncoding: null,
          undecodedEncoding: label.toLowerCase(),
        },
      });
      checked += 1;
    }
    expect(checked).toBe(6);
    // The raw read is capped like any other body.
    const big = await readResponseBounded(encoded("x".repeat(10_000), "none"), { maxBytes: 100 });
    expect(big).toMatchObject({ ok: true, truncated: true, undecodedEncoding: "none" });
    if (big.ok) expect(big.bytes.length).toBe(100);
    // A stack that includes a real compression is still refused.
    for (const label of ["gzip, gzip", "gzip, br", "gzip, none"]) {
      const r = await readResponseBounded(encoded("abc", label), { maxBytes: 100 });
      expect({ label, r }).toMatchObject({ label, r: { ok: false, code: "unsupported-encoding" } });
      checked += 1;
    }
    expect(checked).toBe(9);
    // An identity body is not flagged.
    const plain = await readResponseBounded(encoded("abc", "identity"), { maxBytes: 100 });
    expect(plain).toMatchObject({ ok: true, undecodedEncoding: null, contentEncoding: null });
  });
});

describe("crc32", () => {
  test("the JS table matches the check value and the runtime's own", () => {
    expect(crc32Js(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    const data = new TextEncoder().encode("the quick brown fox ".repeat(100));
    const split = crc32Js(data.subarray(500), crc32Js(data.subarray(0, 500)));
    expect(split).toBe(crc32Js(data));
    expect(crc32(data)).toBe(crc32Js(data));
  });
});
