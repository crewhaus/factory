/**
 * A sentence's citation markers are collected in one pass.
 *
 * `citedClaims` groups the markers by sentence, and checked each new marker
 * against every marker its sentence had collected so far: quadratic in the
 * markers of one sentence. FactCrossCheck reads a document of up to 16 MiB,
 * or a workspace file, and nothing stops one sentence holding a hundred
 * thousand markers. A set now answers "collected already?", and the markers
 * come back in the same first-seen order.
 *
 * The work is counted with __test__/js-work.ts, which charges an array's
 * `includes` for the whole array, never timed.
 */
import { describe, expect, test } from "bun:test";
import { jsWork } from "./__test__/js-work";
import { citedClaims, splitSentences } from "./lib/markdown";

/** Characters copied, searched or read, and elements visited, per character; about 3 here. */
const WORK_PER_CHARACTER = 8;

/** One sentence citing `k` distinct markers, each twice. */
function oneSentence(k: number): string {
  const markers = Array.from({ length: k }, (_, i) => ` [${i}]`).join("");
  return `Claim${markers}${markers}.\n`;
}

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

/**
 * The markers of each sentence as the old pass collected them: every
 * marker match, bucketed by the sentence holding it, kept unless the bucket
 * already listed it. Only for text without code, where no match is skipped.
 */
function oldMarkers(text: string): string[][] {
  const sentences = splitSentences(text);
  const buckets = new Map<number, string[]>();
  const order: number[] = [];
  for (const m of text.matchAll(/\[\^?([\w.-]+)\](?!\(|:|\[)/g)) {
    const at = m.index as number;
    const sentence = sentences.find((s) => at >= s.start && at < s.end);
    if (sentence === undefined) continue;
    let bucket = buckets.get(sentence.start);
    if (bucket === undefined) {
      bucket = [];
      buckets.set(sentence.start, bucket);
      order.push(sentence.start);
    }
    if (!bucket.includes(m[1] as string)) bucket.push(m[1] as string);
  }
  return order.map((start) => buckets.get(start) as string[]);
}

describe("citedClaims collects a sentence's markers in one pass", () => {
  test("one sentence holding thousands of markers, each cited twice", () => {
    const rows = [4_000, 8_000].map((k) => {
      const text = oneSentence(k);
      const run = jsWork(WORK_PER_CHARACTER * text.length, () => citedClaims(text));
      return { k, text, run };
    });
    for (const { k, text, run } of rows) {
      expect(run.work).toBeLessThanOrEqual(WORK_PER_CHARACTER * text.length);
      expect(run.value).toHaveLength(1);
      const markers = run.value?.[0]?.markers ?? [];
      expect(markers).toHaveLength(k);
      expect([markers[0], markers[k - 1]]).toEqual(["0", String(k - 1)]);
    }
    const [small, large] = rows as [(typeof rows)[0], (typeof rows)[0]];
    // Twice the markers, about twice the work.
    expect(large.run.work / small.run.work).toBeLessThan(2.4);
  }, 20_000);

  test("the same markers, in the same order, as the old pass on generated text", () => {
    const next = rng(0x5eed0101);
    const pieces = [
      "Revenue rose",
      " ",
      "[1]",
      "[2]",
      "[1]",
      "[^a]",
      "[a.b-c]",
      "[x](y)",
      "[t][1]",
      ". ",
      "! ",
      "? ",
      "\n",
      "\n\n",
      "e.g. ",
      "J. Smith ",
      "[7]",
      "[^7]",
      "\n[1]: ./a.md\n",
    ];
    const differ: string[] = [];
    let markers = 0;
    for (let i = 0; i < 3_000; i++) {
      let text = "";
      for (let n = 1 + Math.floor(next() * 40); n > 0; n--) {
        text += pieces[Math.floor(next() * pieces.length)];
      }
      const ours = citedClaims(text).map((c) => c.markers);
      const old = oldMarkers(text);
      markers += old.flat().length;
      if (JSON.stringify(ours) !== JSON.stringify(old)) differ.push(JSON.stringify(text));
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(markers).toBeGreaterThan(5_000);
  }, 20_000);
});
