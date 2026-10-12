/**
 * A feed's items and a server-sent-event stream are read in one pass.
 *
 * FeedParse reads a body of up to 25 MiB from an allow-listed URL, or text
 * the model passes. `parseFeed` took the items under the channel and beside
 * it, and kept the first of each by searching the whole list for every
 * item: quadratic in the items. A set does it now.
 *
 * SseRead decodes a stream as it arrives. `SseDecoder.push` appended each
 * chunk to everything held since the last blank line, then normalised and
 * split all of it again: a long frame sent a little at a time was quadratic
 * in its length. Each chunk is now read once, and the open frame is joined
 * when its blank line arrives.
 *
 * Both are checked against the code they replaced, restated here: the
 * dedupe on generated documents, the decoder on generated streams cut into
 * chunks at every kind of boundary (inside a CRLF, between two line breaks,
 * one character at a time, empty chunks). The work is counted, never timed:
 * the decoder with tool-code's __test__/js-work.ts, and the feed with
 * `searchWork` below, because js-work charges a string search the whole
 * string, and the XML reader searches from where it is.
 *
 * A test that walks many generated inputs declares a budget, as the house
 * does for a test that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import { jsWork } from "../../tool-code/src/__test__/js-work";
import { parseFeed } from "./lib/feed";
import { SseDecoder, type SseEvent, decodeFrame } from "./lib/sse";
import { childrenNamed, firstNamed, parseXml } from "./lib/xml";

/** Characters searched or copied and elements visited, per character of input. */
const WORK_PER_CHARACTER = 8;

/** Seeded, so a failure names the same input every run. */
function rng(start: number): () => number {
  const state = { seed: start };
  return () => {
    state.seed = (state.seed + 0x6d2b79f5) | 0;
    let t = Math.imul(state.seed ^ (state.seed >>> 15), 1 | state.seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Method = (this: unknown, ...args: unknown[]) => unknown;
type Methods = Record<string, Method>;

/**
 * The work `body` does in string and array methods. A string search is
 * charged the characters it walks, from where it starts to the match or the
 * end; a copy its length; a split the string; an array search or callback
 * each element it visits; an iterator each element it hands out.
 */
function searchWork<T>(body: () => T): { value: T; work: number } {
  const tally = { work: 0 };
  const saved: Array<{ target: Methods; name: string; real: Method }> = [];
  const wrap = (target: Methods, name: string, make: (real: Method) => Method): void => {
    const real = target[name] as Method;
    saved.push({ target, name, real });
    target[name] = make(real);
  };
  const strings = String.prototype as unknown as Methods;
  const arrays = Array.prototype as unknown as Methods;
  for (const name of ["slice", "substring", "substr"]) {
    wrap(
      strings,
      name,
      (real) =>
        function (this: unknown, ...args: unknown[]) {
          const out = real.apply(this, args) as string;
          tally.work += out.length;
          return out;
        },
    );
  }
  wrap(
    strings,
    "split",
    (real) =>
      function (this: unknown, ...args: unknown[]) {
        tally.work += String(this).length;
        return real.apply(this, args);
      },
  );
  for (const name of ["indexOf", "includes"]) {
    wrap(
      strings,
      name,
      (real) =>
        function (this: unknown, ...args: unknown[]) {
          const text = String(this);
          const needle = String(args[0]);
          const from = Math.min(text.length, Math.max(0, Math.trunc(Number(args[1] ?? 0)) || 0));
          const out = real.apply(this, args);
          const at = typeof out === "number" ? out : out === true ? text.indexOf(needle, from) : -1;
          tally.work += (at === -1 ? text.length : at + needle.length) - from;
          return out;
        },
    );
  }
  for (const name of ["indexOf", "lastIndexOf", "includes"]) {
    wrap(
      arrays,
      name,
      (real) =>
        function (this: unknown, ...args: unknown[]) {
          tally.work += (this as unknown[]).length;
          return real.apply(this, args);
        },
    );
  }
  for (const name of ["some", "every", "find", "findIndex", "filter", "map", "forEach"]) {
    wrap(
      arrays,
      name,
      (real) =>
        function (this: unknown, fn: unknown, thisArg?: unknown) {
          return real.call(this, (...args: unknown[]) => {
            tally.work += 1;
            return (fn as Method).apply(thisArg, args);
          });
        },
    );
  }
  const iterators = [
    Object.getPrototypeOf([][Symbol.iterator]()),
    Object.getPrototypeOf(""[Symbol.iterator]()),
  ] as Methods[];
  for (let i = 0; i < iterators.length; i++) {
    wrap(
      iterators[i] as Methods,
      "next",
      (real) =>
        function (this: unknown) {
          const out = real.call(this) as IteratorResult<unknown>;
          if (out.done !== true) tally.work += 1;
          return out;
        },
    );
  }
  try {
    return { value: body(), work: tally.work };
  } finally {
    for (let i = saved.length - 1; i >= 0; i--) {
      const { target, name, real } = saved[i] as (typeof saved)[number];
      target[name] = real;
    }
  }
}

// ---------------------------------------------------------------------------
// The code as it was.

class OldSseDecoder {
  private buffer = "";

  push(chunk: string): readonly SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let pending = this.buffer;
    let carry = "";
    if (pending.endsWith("\r")) {
      carry = "\r";
      pending = pending.slice(0, -1);
    }
    const normalized = pending.replace(/\r\n|\r/g, "\n");
    const frames = normalized.split("\n\n");
    this.buffer = `${frames.pop() ?? ""}${carry}`;
    for (const frame of frames) {
      const event = decodeFrame(frame);
      if (event !== null) events.push(event);
    }
    return events;
  }

  flush(): readonly SseEvent[] {
    const tail = this.buffer;
    this.buffer = "";
    const event = decodeFrame(tail.replace(/\r\n|\r/g, "\n"));
    return event === null ? [] : [event];
  }
}

// ---------------------------------------------------------------------------
// Counted.

describe("a feed and a stream are read in one pass", () => {
  for (const shape of ["RSS 2.0, items under the channel", "RDF, items beside no channel"]) {
    test(`parseFeed over thousands of items (${shape})`, () => {
      const measured = [4_000, 8_000].map((count) => {
        const item = "<item><title>a</title><link>https://x/</link></item>";
        const xml = shape.startsWith("RSS")
          ? `<rss version="2.0"><channel><title>t</title>${item.repeat(count)}</channel></rss>`
          : `<rdf:RDF><title>t</title>${item.repeat(count)}</rdf:RDF>`;
        const run = searchWork(() => parseFeed(xml));
        expect(run.work).toBeLessThanOrEqual(WORK_PER_CHARACTER * xml.length);
        expect(run.value.entries).toHaveLength(count);
        expect(run.value.entries[count - 1]).toEqual({
          id: "https://x/",
          title: "a",
          link: "https://x/",
        });
        return run.work;
      });
      expect((measured[1] as number) / (measured[0] as number)).toBeLessThan(2.4);
    }, 20_000);
  }

  test("SseDecoder over one long frame sent sixteen characters at a time", () => {
    const measured = [128_000, 256_000].map((length) => {
      const stream = `event: big\ndata: ${"x".repeat(length)}\n\n`;
      const limit = WORK_PER_CHARACTER * stream.length;
      const run = jsWork(limit, () => {
        const decoder = new SseDecoder();
        const events: SseEvent[] = [];
        for (let at = 0; at < stream.length; at += 16) {
          events.push(...decoder.push(stream.slice(at, at + 16)));
        }
        return events;
      });
      expect(run.work).toBeLessThanOrEqual(limit);
      expect(run.value?.map((e) => [e.event, e.data.length])).toEqual([["big", length]]);
      return run.work;
    });
    expect((measured[1] as number) / (measured[0] as number)).toBeLessThan(2.4);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// The same answers as before.

describe("the one-pass readers answer what the old ones did", () => {
  test("a set keeps the items the indexOf filter kept, in the same order", () => {
    const next = rng(0x5eed3001);
    const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(next() * xs.length)] as T;
    const items = (count: number) =>
      Array.from({ length: count }, () =>
        pick(["<item/>", "<item><title>t</title></item>", "<item><link>l</link></item>"]),
      ).join("");
    const differ: string[] = [];
    const seen = { items: 0, twice: 0 };
    for (let n = 0; n < 2_000; n++) {
      const xml = pick([
        () =>
          `<rss><channel><title>c</title>${items(Math.floor(next() * 6))}</channel>${items(Math.floor(next() * 3))}</rss>`,
        () => `<rdf:RDF><channel/>${items(Math.floor(next() * 6))}</rdf:RDF>`,
        () => `<rdf:RDF>${items(Math.floor(next() * 6))}</rdf:RDF>`,
      ])();
      const root = parseXml(xml);
      const channel = firstNamed(root, "channel");
      const listed = [...childrenNamed(channel ?? root, "item"), ...childrenNamed(root, "item")];
      const old = listed.filter((item, index, all) => all.indexOf(item) === index);
      seen.items += old.length;
      if (listed.length > old.length) seen.twice++;
      const now = [...new Set(listed)];
      if (now.length !== old.length || now.some((item, i) => item !== old[i])) differ.push(xml);
      // No channel and no item is not a feed, and says so.
      const entries = (() => {
        try {
          return parseFeed(xml).entries.length;
        } catch {
          return -1;
        }
      })();
      if (entries !== (channel === undefined && old.length === 0 ? -1 : old.length)) {
        differ.push(`entries ${xml}`);
      }
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(Math.min(seen.items, seen.twice)).toBeGreaterThan(300);
  }, 20_000);

  test("SseDecoder gives the old events, chunk by chunk, however the stream is cut", () => {
    const next = rng(0x5eed3002);
    const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(next() * xs.length)] as T;
    const lines = [
      "data: a",
      "data: b c",
      "data:x",
      "event: e",
      "id: 1",
      `id: ${String.fromCharCode(0)}`,
      "retry: 10",
      "retry: x",
      ": keep-alive",
      "data",
      "",
    ];
    const differ: string[] = [];
    const seen = { events: 0, straddled: 0 };
    for (let n = 0; n < 3_000; n++) {
      const end = () => pick(["\n", "\r\n", "\r"]);
      let stream = "";
      for (let frame = Math.floor(next() * 6); frame > 0; frame--) {
        for (let line = 1 + Math.floor(next() * 3); line > 0; line--) stream += pick(lines) + end();
        stream += pick(["\n", "\r\n", "\r", "", "\n\n"]);
      }
      if (next() < 0.3) stream += pick(lines);
      if (next() < 0.1) stream += "\r";
      for (const longest of [1, 3, 20]) {
        const chunks: string[] = [];
        for (let at = 0; at < stream.length; ) {
          const size = 1 + Math.floor(next() * longest);
          chunks.push(stream.slice(at, at + size));
          if (next() < 0.05) chunks.push("");
          at += size;
        }
        if (chunks.some((c, i) => c.endsWith("\n") && (chunks[i + 1] ?? "").startsWith("\n"))) {
          seen.straddled++;
        }
        const old = new OldSseDecoder();
        const now = new SseDecoder();
        const was = JSON.stringify([...chunks.map((c) => old.push(c)), old.flush(), old.flush()]);
        const is = JSON.stringify([...chunks.map((c) => now.push(c)), now.flush(), now.flush()]);
        seen.events += (JSON.parse(was) as unknown[][]).flat().length;
        if (is !== was) differ.push(JSON.stringify(chunks));
      }
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(seen.events).toBeGreaterThan(10_000);
    expect(seen.straddled).toBeGreaterThan(300);
  }, 20_000);
});
