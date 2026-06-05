import { describe, expect, test } from "bun:test";
import { ChunkerError, chunk } from "./index";

describe("fixed strategy", () => {
  test("splits a long doc into fixed-size windows", () => {
    const text = "0123456789".repeat(20);
    const out = chunk({ id: "doc1", text }, { strategy: "fixed", size: 50 });
    expect(out.length).toBe(4);
    expect(out[0]?.text.length).toBe(50);
    expect(out[3]?.text.length).toBe(50);
  });

  test("respects overlap when stride < size", () => {
    const text = "0123456789".repeat(10); // 100 chars
    const out = chunk({ id: "doc", text }, { strategy: "fixed", size: 30, overlap: 10 });
    // stride = 20, so chunks start at 0, 20, 40, 60, 80
    expect(out.length).toBe(5);
    expect(out[0]?.startOffset).toBe(0);
    expect(out[1]?.startOffset).toBe(20);
    expect(out[4]?.startOffset).toBe(80);
  });

  test("rejects overlap >= size", () => {
    expect(() =>
      chunk({ id: "x", text: "abc" }, { strategy: "fixed", size: 5, overlap: 5 }),
    ).toThrow(ChunkerError);
  });

  test("preserves source bytes (T9 reconstruction with overlap=0)", () => {
    const text = "abcdefghijklmnopqrstuvwxyz";
    const out = chunk({ id: "x", text }, { strategy: "fixed", size: 5 });
    expect(out.map((c) => c.text).join("")).toBe(text);
  });

  test("ids carry docId + index + startOffset", () => {
    const out = chunk({ id: "doc99", text: "hello" }, { strategy: "fixed", size: 3 });
    expect(out[0]?.id).toBe("doc99:0:0");
    expect(out[1]?.id).toBe("doc99:1:3");
  });

  test("metadata flows through", () => {
    const out = chunk(
      { id: "x", text: "abc", metadata: { kind: "doc" } },
      { strategy: "fixed", size: 2 },
    );
    expect(out[0]?.metadata).toEqual({ kind: "doc" });
  });
});

describe("semantic strategy", () => {
  test("groups sentences into windows of N sentences", () => {
    const text = "Alpha. Bravo. Charlie. Delta. Echo. Foxtrot.";
    const out = chunk({ id: "doc", text }, { strategy: "semantic", size: 2 });
    // 6 sentences, window 2 → 3 chunks
    expect(out.length).toBe(3);
  });

  test("empty text yields no chunks", () => {
    const out = chunk({ id: "doc", text: "" }, { strategy: "semantic", size: 3 });
    expect(out).toEqual([]);
  });

  test("whitespace-only text yields no chunks (segments trimmed away)", () => {
    const out = chunk({ id: "doc", text: "   \n\t  " }, { strategy: "semantic", size: 2 });
    expect(out).toEqual([]);
  });

  test("overlap produces overlapping sentence windows", () => {
    const text = "Alpha. Bravo. Charlie. Delta. Echo. Foxtrot.";
    const out = chunk({ id: "doc", text }, { strategy: "semantic", size: 2, overlap: 1 });
    // stride = max(1, 2 - 1) = 1, so a size-2 window starts at sentences
    // 0,1,2,3,4 (the loop breaks once i + size reaches the 6-sentence end): 5 chunks.
    expect(out.length).toBe(5);
    // Consecutive windows share a sentence (overlap), so each later window
    // starts strictly before the previous window's end.
    expect(out[1]?.startOffset).toBeLessThan(out[0]?.endOffset ?? -1);
  });

  test("overlap >= size still terminates (stride clamped to 1)", () => {
    const text = "Alpha. Bravo. Charlie.";
    const out = chunk({ id: "doc", text }, { strategy: "semantic", size: 2, overlap: 5 });
    // No infinite loop; stride floored at 1 yields one window per sentence
    // until the final window reaches the end.
    expect(out.length).toBe(2);
  });

  test("rejects non-positive size", () => {
    expect(() => chunk({ id: "x", text: "A. B." }, { strategy: "semantic", size: 0 })).toThrow(
      ChunkerError,
    );
  });

  test("metadata flows through semantic chunks", () => {
    const out = chunk(
      { id: "doc", text: "Alpha. Bravo.", metadata: { lang: "en" } },
      { strategy: "semantic", size: 1 },
    );
    expect(out.length).toBe(2);
    expect(out[0]?.metadata).toEqual({ lang: "en" });
    expect(out[1]?.metadata).toEqual({ lang: "en" });
  });

  test("a valid non-default locale is accepted", () => {
    const out = chunk(
      { id: "doc", text: "Hallo. Welt." },
      { strategy: "semantic", size: 1, locale: "de" },
    );
    expect(out.length).toBe(2);
  });

  test("an invalid locale throws ChunkerError (not a raw RangeError)", () => {
    let caught: unknown;
    try {
      chunk(
        { id: "doc", text: "Hello. World." },
        { strategy: "semantic", size: 2, locale: "not a valid tag!!!" },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ChunkerError);
    // The original RangeError is preserved as the cause for debugging.
    expect((caught as Error).cause).toBeInstanceOf(RangeError);
    expect((caught as Error).message).toContain("invalid locale");
  });

  test("preserves source bytes across a single full window", () => {
    const text = "Alpha. Bravo. Charlie.";
    const out = chunk({ id: "doc", text }, { strategy: "semantic", size: 10 });
    expect(out.length).toBe(1);
    const only = out[0];
    expect(only).toBeDefined();
    // The single window spans from the first sentence start to the last end.
    expect(text.slice(only?.startOffset, only?.endOffset)).toBe(only?.text ?? "");
  });
});

describe("markdown strategy", () => {
  test("splits at headers", () => {
    const md = `# A
para
## B
para
### C
para`;
    const out = chunk({ id: "doc", text: md }, { strategy: "markdown", size: 100 });
    expect(out.length).toBe(3);
    expect(out[0]?.text.startsWith("# A")).toBe(true);
    expect(out[1]?.text.startsWith("## B")).toBe(true);
    expect(out[2]?.text.startsWith("### C")).toBe(true);
  });

  test("sub-chunks long sections via the fixed strategy", () => {
    const long = "x".repeat(120);
    const md = `# Big\n${long}\n## Small\nshort`;
    const out = chunk({ id: "doc", text: md }, { strategy: "markdown", size: 50 });
    // Section 1 is ~125 chars → sub-chunked into 3 pieces (50/50/25-ish).
    // Section 2 is short → 1 piece.
    expect(out.length).toBeGreaterThan(2);
  });

  test("sub-chunk ids and offsets are remapped to absolute document positions", () => {
    const long = "y".repeat(120);
    const md = `# Big\n${long}`; // single section, > size → sub-chunked
    const out = chunk({ id: "doc", text: md }, { strategy: "markdown", size: 50 });
    expect(out.length).toBeGreaterThan(1);
    // Indices are contiguous and ids encode absolute startOffset.
    out.forEach((c, i) => {
      expect(c.index).toBe(i);
      expect(c.id).toBe(`doc:${i}:${c.startOffset}`);
      // Each chunk's text is exactly the document slice at its absolute offsets.
      expect(md.slice(c.startOffset, c.endOffset)).toBe(c.text);
    });
    expect(out[0]?.startOffset).toBe(0);
  });

  test("text before the first header becomes its own leading section", () => {
    const md = "preamble line\n# Header\nbody";
    const out = chunk({ id: "doc", text: md }, { strategy: "markdown", size: 100 });
    expect(out.length).toBe(2);
    expect(out[0]?.text.startsWith("preamble")).toBe(true);
    expect(out[1]?.text.startsWith("# Header")).toBe(true);
  });

  test("a document with no headers yields a single chunk", () => {
    const md = "just plain text, no headers here";
    const out = chunk({ id: "doc", text: md }, { strategy: "markdown", size: 100 });
    expect(out.length).toBe(1);
    expect(out[0]?.text).toBe(md);
  });

  test("an empty document yields no chunks", () => {
    const out = chunk({ id: "doc", text: "" }, { strategy: "markdown", size: 100 });
    expect(out).toEqual([]);
  });

  test("metadata flows through markdown chunks (both short and sub-chunked paths)", () => {
    const long = "z".repeat(120);
    const md = `# Big\n${long}\n## Small\nshort`;
    const out = chunk(
      { id: "doc", text: md, metadata: { src: "wiki" } },
      { strategy: "markdown", size: 50 },
    );
    expect(out.length).toBeGreaterThan(2);
    for (const c of out) {
      expect(c.metadata).toEqual({ src: "wiki" });
    }
  });

  test("reconstructs the source bytes by concatenating chunk text (overlap=0)", () => {
    const md = "# A\npara one\n## B\npara two\n### C\npara three";
    const out = chunk({ id: "doc", text: md }, { strategy: "markdown", size: 100 });
    expect(out.map((c) => c.text).join("")).toBe(md);
  });
});

describe("strategy dispatch", () => {
  test("an unknown strategy throws ChunkerError", () => {
    expect(() =>
      // @ts-expect-error — deliberately bypass the typed strategy union
      chunk({ id: "x", text: "abc" }, { strategy: "bogus", size: 5 }),
    ).toThrow(ChunkerError);
  });

  test("the unknown-strategy message names the offending value", () => {
    let caught: unknown;
    try {
      // @ts-expect-error — deliberately bypass the typed strategy union
      chunk({ id: "x", text: "abc" }, { strategy: "nope", size: 5 });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toContain("nope");
  });
});
