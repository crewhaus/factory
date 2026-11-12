import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WEBHOOK_MAX_BYTES,
  WEBHOOK_MAX_BYTES_CEILING,
  WEBHOOK_MAX_BYTES_ENV,
  WEBHOOK_MAX_BYTES_FLOOR,
  readRequestBodyCapped,
  resolveWebhookBodyLimit,
} from "./body-limit";

function streamOf(chunks: readonly Uint8Array[]) {
  const counter = { pulled: 0, cancelled: false };
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[i++];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      counter.pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      counter.cancelled = true;
    },
  });
  return { stream, counter };
}

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1/hook", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit);
}

describe("resolveWebhookBodyLimit", () => {
  test("unset or empty is 1 MiB, with no warning", () => {
    expect(DEFAULT_WEBHOOK_MAX_BYTES).toBe(1_048_576);
    expect(resolveWebhookBodyLimit({})).toEqual({ maxBytes: DEFAULT_WEBHOOK_MAX_BYTES });
    expect(resolveWebhookBodyLimit({ [WEBHOOK_MAX_BYTES_ENV]: "  " })).toEqual({
      maxBytes: DEFAULT_WEBHOOK_MAX_BYTES,
    });
  });

  test("a number of bytes inside the bounds is used as given, lower or higher", () => {
    expect(resolveWebhookBodyLimit({ CHANNEL_WEBHOOK_MAX_BYTES: "65536" })).toEqual({
      maxBytes: 65_536,
    });
    expect(resolveWebhookBodyLimit({ CHANNEL_WEBHOOK_MAX_BYTES: " 4194304 " })).toEqual({
      maxBytes: 4_194_304,
    });
    expect(resolveWebhookBodyLimit({ CHANNEL_WEBHOOK_MAX_BYTES: "1024" }).maxBytes).toBe(
      WEBHOOK_MAX_BYTES_FLOOR,
    );
  });

  test("outside the bounds it is held to the nearer one, and says so", () => {
    const low = resolveWebhookBodyLimit({ CHANNEL_WEBHOOK_MAX_BYTES: "0" });
    expect(low.maxBytes).toBe(WEBHOOK_MAX_BYTES_FLOOR);
    expect(low.warning).toContain("below");
    const high = resolveWebhookBodyLimit({ CHANNEL_WEBHOOK_MAX_BYTES: "999999999999" });
    expect(high.maxBytes).toBe(WEBHOOK_MAX_BYTES_CEILING);
    expect(high.warning).toContain("above");
  });

  test("anything but a plain number of bytes is ignored for the default, and says so", () => {
    for (const raw of ["1MiB", "-5", "1e6", "2.5", "0x400", "lots"]) {
      const limit = resolveWebhookBodyLimit({ CHANNEL_WEBHOOK_MAX_BYTES: raw });
      expect(limit.maxBytes).toBe(DEFAULT_WEBHOOK_MAX_BYTES);
      expect(limit.warning).toContain("is not a number of bytes");
    }
  });
});

describe("readRequestBodyCapped", () => {
  test("a body within the limit comes back as req.text() would return it", async () => {
    // A BOM, a multi-byte character split across two chunks, and an invalid byte.
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0xc3, 0xa9, 0xff, 0x21]);
    const expected = await post(bytes).text();
    const { stream } = streamOf([bytes.slice(0, 5), bytes.slice(5)]);
    const read = await readRequestBodyCapped(post(stream), 64);
    expect(read).toEqual({ ok: true, text: expected, bytesRead: bytes.byteLength });
  });

  test("no body is the empty string", async () => {
    expect(await readRequestBodyCapped(new Request("http://127.0.0.1/"), 10)).toEqual({
      ok: true,
      text: "",
      bytesRead: 0,
    });
  });

  test("a body exactly at the limit is read", async () => {
    const read = await readRequestBodyCapped(post("x".repeat(100)), 100);
    expect(read.ok).toBe(true);
    expect(read.bytesRead).toBe(100);
  });

  test("a declared length over the limit is 413 before anything is read", async () => {
    const { stream, counter } = streamOf([new Uint8Array(8), new Uint8Array(8), new Uint8Array(8)]);
    const read = await readRequestBodyCapped(post(stream, { "content-length": "24" }), 16);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe("declared_too_large");
    expect(read.bytesRead).toBe(0);
    expect(read.response.status).toBe(413);
    expect(await read.response.text()).toBe("payload too large: the limit is 16 bytes");
    expect(counter.cancelled).toBe(true);
    // Only what the stream queued for itself at construction.
    expect(counter.pulled).toBeLessThanOrEqual(8);
  });

  test("a streamed body is counted, and the read stops at the chunk that passes the limit", async () => {
    const chunks = Array.from({ length: 100 }, () => new Uint8Array(10));
    const { stream, counter } = streamOf(chunks);
    const read = await readRequestBodyCapped(post(stream), 35);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe("too_large");
    expect(read.bytesRead).toBe(40);
    expect(read.response.status).toBe(413);
    expect(counter.cancelled).toBe(true);
    // 40 read, and at most the one chunk the stream queued ahead.
    expect(counter.pulled).toBeLessThanOrEqual(50);
  });

  test("a body longer than its declared length is still stopped by the count", async () => {
    const { stream } = streamOf([new Uint8Array(10), new Uint8Array(10), new Uint8Array(10)]);
    const read = await readRequestBodyCapped(post(stream, { "content-length": "5" }), 15);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe("too_large");
  });

  test("a Content-Length that is not a plain number is 400 before anything is read", async () => {
    for (const length of ["abc", "-1", "1.5", "10, 10", ""]) {
      const read = await readRequestBodyCapped(post("hello", { "content-length": length }), 100);
      expect(read.ok).toBe(false);
      if (read.ok) continue;
      expect(read.reason).toBe("bad_length");
      expect(read.response.status).toBe(400);
      expect(read.bytesRead).toBe(0);
    }
  });

  test("a stream that fails is 400, not a thrown error", async () => {
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new Uint8Array(4));
          return;
        }
        controller.error(new Error("connection reset"));
      },
    });
    const read = await readRequestBodyCapped(post(stream), 100);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe("unreadable");
    expect(read.bytesRead).toBe(4);
    expect(read.response.status).toBe(400);
  });

  test("a limit that is not a non-negative integer throws instead of reading unbounded", async () => {
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(readRequestBodyCapped(post("x"), bad)).rejects.toThrow(RangeError);
    }
  });
});
