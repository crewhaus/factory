/**
 * `redactText` reads its text once, however many values it replaces.
 *
 * It replaced its hits one distinct value at a time, `split` and `join` over
 * the whole text for each, and every rating, mined sample and synthesized
 * example passes through it before it lands in a dataset. It now hands the
 * hits to the redactor's own `replaceValues`, which finds them all in one
 * scan; the text it returns is the one the passes returned.
 *
 * The work is counted with tool-code's __test__/js-work.ts, which charges a
 * string `split` the whole string it splits and a slice its characters.
 * Detection is handed precomputed matches, so what is counted is the
 * replacement. Never timed.
 */
import { describe, expect, test } from "bun:test";
import { type PiiDetector, detectPii } from "@crewhaus/pii-redactor";
import { jsWork } from "../../tool-code/src/__test__/js-work";
import { INGESTION_PII_DETECTORS, dedupePiiHits, redactText } from "./redact";

/** Counted work per character of text and values; about 2 here. */
const WORK_PER_CHARACTER = 6;

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

describe("redactText", () => {
  test("thousands of distinct addresses cost about their length", () => {
    const measured = [2_000, 4_000].map((k) => {
      const values = Array.from({ length: k }, (_, i) => `user${i}@example.com`);
      const text = values.join(" ");
      const matches = values.map((value) => ({ index: text.indexOf(value), value }));
      const detector: PiiDetector = { kind: "email", regex: /(?!)/g, matches: () => matches };
      const chars = values.reduce((sum, value) => sum + value.length, text.length);
      const run = jsWork(WORK_PER_CHARACTER * chars, () => redactText(text, [detector]));
      return { k, chars, run };
    });
    for (const { k, chars, run } of measured) {
      expect(run.work).toBeLessThanOrEqual(WORK_PER_CHARACTER * chars);
      expect(run.value).toBe(Array.from({ length: k }, () => "[REDACTED:email]").join(" "));
    }
    const [small, large] = measured as [(typeof measured)[0], (typeof measured)[0]];
    expect(large.run.work / small.run.work).toBeLessThan(2.4);
  }, 20_000);

  test("the same text as one pass per value, over PII-dense text", () => {
    const next = rng(0xfeed7001);
    const pieces = [
      "a@b.co",
      "za@b.co",
      " ",
      "\n",
      "123-45-6789",
      "4111 1111 1111 1111",
      "(415) 555-1234",
      "DE89370400440532013000",
      "sk-abcdefgh1234",
      "ghp_abcdefghijklmnop1234",
      "bearer abcdefgh123",
      `token: ${"A".repeat(32)}`,
      "[REDACTED:email]",
      "[",
      "]",
      "x",
    ];
    const differ: string[] = [];
    let redacted = 0;
    for (let round = 0; round < 2_000; round++) {
      let text = "";
      for (let i = Math.floor(next() * 40); i > 0; i--) {
        text += pieces[Math.floor(next() * pieces.length)];
      }
      const hits = dedupePiiHits(detectPii(text, INGESTION_PII_DETECTORS)).filter(
        (h) => h.value.length > 0,
      );
      let expected = text;
      for (const hit of [...hits].sort((a, b) => b.value.length - a.value.length)) {
        expected = expected.split(hit.value).join(`[REDACTED:${hit.kind}]`);
      }
      const got = redactText(text);
      if (got !== expected) differ.push(text);
      if (got !== text) redacted++;
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(redacted).toBeGreaterThan(1_500);
  }, 20_000);
});
