/**
 * The markdown strategy lists a document's header starts in one pass.
 *
 * `chunkMarkdown` checked each header's start against every start listed so
 * far: quadratic in the headers. The documents are knowledge and pipeline
 * sources (files, globs and fetched URLs) with no size cap, so a page of
 * short headers was enough. A set now answers "listed already?".
 *
 * The work is counted with tool-code's __test__/js-work.ts, which charges an
 * array's `includes` for the whole array, never timed.
 */
import { describe, expect, test } from "bun:test";
import { jsWork } from "../../tool-code/src/__test__/js-work";
import { chunk } from "./index";

/** Characters copied, searched or read, and elements visited, per character; about 1.3 here. */
const WORK_PER_CHARACTER = 4;

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

/** Where each section starts: 0, then every line that opens with 1–6 `#` and a space. */
function headerStarts(text: string): number[] {
  const starts = [0];
  for (const m of text.matchAll(/(^|\n)(#{1,6}\s)/g)) {
    const at = m[1] === "\n" ? (m.index as number) + 1 : (m.index as number);
    if (at !== 0) starts.push(at);
  }
  return starts;
}

describe("chunk(markdown) lists header starts in one pass", () => {
  test("a document of thousands of short headers", () => {
    const measured = [4_000, 8_000].map((k) => {
      const doc = { id: "d", text: "# h\n".repeat(k) };
      const run = jsWork(WORK_PER_CHARACTER * doc.text.length, () =>
        chunk(doc, { strategy: "markdown", size: 400 }),
      );
      return { k, doc, run };
    });
    for (const { k, doc, run } of measured) {
      expect(run.work).toBeLessThanOrEqual(WORK_PER_CHARACTER * doc.text.length);
      expect(run.value).toHaveLength(k);
      expect(run.value?.[k - 1]?.startOffset).toBe(4 * (k - 1));
    }
    const [small, large] = measured as [(typeof measured)[0], (typeof measured)[0]];
    expect(large.run.work / small.run.work).toBeLessThan(2.4);
  }, 20_000);

  test("sections start where the headers do, on generated documents", () => {
    const next = rng(0x5eed0301);
    const pieces = [
      "# ",
      "## ",
      "###### ",
      "####### ",
      "#x",
      "\n",
      "\n# ",
      "\n## h\n",
      "text ",
      "#\t",
      "\n#\n",
    ];
    const differ: string[] = [];
    let sections = 0;
    for (let n = 0; n < 4_000; n++) {
      let text = "";
      for (let i = 1 + Math.floor(next() * 30); i > 0; i--) {
        text += pieces[Math.floor(next() * pieces.length)];
      }
      // A size past the text keeps every section whole.
      const got = chunk({ id: "d", text }, { strategy: "markdown", size: text.length + 1 });
      const starts = headerStarts(text);
      const expected = starts
        .map((start, i) => ({ start, end: starts[i + 1] ?? text.length }))
        .filter((r) => r.end > r.start);
      sections += expected.length;
      const ours = got.map((c) => ({ start: c.startOffset, end: c.endOffset }));
      if (JSON.stringify(ours) !== JSON.stringify(expected)) differ.push(JSON.stringify(text));
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(sections).toBeGreaterThan(10_000);
  }, 20_000);
});
