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
});
