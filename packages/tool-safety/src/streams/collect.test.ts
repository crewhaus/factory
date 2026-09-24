import { describe, expect, test } from "bun:test";
import { collectBounded } from "./collect";

/** A stream of `count` chunks of `size` bytes, recording how many were pulled. */
function producer(count: number, size: number, fill = 0x61) {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= count) {
        controller.close();
        return;
      }
      const chunk = new Uint8Array(size).fill(fill);
      // Mark each chunk so head and tail can be told apart.
      chunk[0] = 0x30 + (pulled % 10);
      pulled += 1;
      controller.enqueue(chunk);
    },
  });
  return { stream, pulled: () => pulled };
}

describe("collectBounded", () => {
  test("keeps at most maxBytes, reads to the end anyway, and says what it dropped", async () => {
    const p = producer(10, 1_000);
    const r = await collectBounded(p.stream, { maxBytes: 2_500 });
    expect(r.bytes.length).toBe(2_500);
    expect(r.truncated).toBe(true);
    expect(r.totalBytes).toBe(10_000);
    expect(r.omittedBytes).toBe(7_500);
    expect(r.complete).toBe(true);
    // Drained, not abandoned: a child writing into a full pipe would block.
    expect(p.pulled()).toBe(10);
  });

  test("security-8#7: 64 MiB through a 1 MiB cap holds 1 MiB", async () => {
    const p = producer(1_024, 64 * 1024);
    const r = await collectBounded(p.stream, { maxBytes: 1024 * 1024 });
    expect(r.bytes.length).toBe(1024 * 1024);
    expect(r.totalBytes).toBe(64 * 1024 * 1024);
    expect(r.truncated).toBe(true);
    expect(p.pulled()).toBe(1_024);
  });

  test("with tailBytes, the end of the stream is kept too, and never overlaps the head", async () => {
    const p = producer(10, 1_000);
    const r = await collectBounded(p.stream, { maxBytes: 2_500, tailBytes: 500 });
    expect(r.bytes.length).toBe(2_000);
    expect(r.tail?.length).toBe(500);
    expect(r.omittedBytes).toBe(10_000 - 2_000 - 500);
    // The tail is the last 500 bytes: inside chunk 9, which starts with "9".
    expect(r.tail?.[0]).toBe(0x61);
    expect(r.bytes[1_000]).toBe(0x31); // chunk 1's marker, in the head
  });

  test("a stream that fits comes back whole, head and tail joined", async () => {
    const p = producer(3, 100);
    const r = await collectBounded(p.stream, { maxBytes: 1_000, tailBytes: 400 });
    expect(r.truncated).toBe(false);
    expect(r.bytes.length).toBe(300);
    expect(r.omittedBytes).toBe(0);
    expect(r.tail).toBeUndefined();
    expect(r.text).toBe(`0${"a".repeat(99)}1${"a".repeat(99)}2${"a".repeat(99)}`);
  });

  test("a cap inside a multi-byte character drops the partial character, not a U+FFFD", async () => {
    const bytes = new TextEncoder().encode("ab\u00e9\u00e9\u00e9");
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });
    const r = await collectBounded(stream, { maxBytes: 5 });
    expect(r.text).toBe("ab\u00e9");
    expect(r.text).not.toContain("\ufffd");
  });

  test("an abort stops reading and reports the stream incomplete, keeping what arrived", async () => {
    const controller = new AbortController();
    let pushed = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (pushed === 3) controller.abort();
        if (pushed >= 3) {
          await new Promise(() => undefined); // never produces again
        }
        pushed += 1;
        c.enqueue(new TextEncoder().encode("x"));
      },
    });
    const r = await collectBounded(stream, { maxBytes: 100, signal: controller.signal });
    expect(r.complete).toBe(false);
    expect(r.text).toBe("xxx");
    expect(r.error).toBeUndefined();
  });

  test("a stream that fails mid-way is reported, with what arrived before it", async () => {
    let n = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        n += 1;
        if (n > 2) {
          c.error(new Error("pipe broke"));
          return;
        }
        c.enqueue(new TextEncoder().encode("ok"));
      },
    });
    const r = await collectBounded(stream, { maxBytes: 100 });
    expect(r.complete).toBe(false);
    expect(r.error).toContain("pipe broke");
    expect(r.text).toBe("okok");
  });

  test("an async iterable works the same, and onChunk sees every byte", async () => {
    async function* gen(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < 5; i++) yield new Uint8Array(10).fill(0x41);
    }
    let seen = 0;
    const r = await collectBounded(gen(), {
      maxBytes: 25,
      onChunk: (chunk) => {
        seen += chunk.length;
      },
    });
    expect(seen).toBe(50);
    expect(r).toMatchObject({ truncated: true, totalBytes: 50, omittedBytes: 25, complete: true });
    expect(r.text).toBe("A".repeat(25));
  });
});
