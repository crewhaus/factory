import { describe, expect, test } from "bun:test";
/**
 * Every redacted value is replaced in one scan of the text.
 *
 * The redactor replaced its hits one distinct value at a time —
 * `text.split(value).join(marker)`, widest value first — so k distinct values
 * read the text k times. Memory mirrored to Thredz, the CLI's synthesize and
 * knowledge-share redactors and feedback ingestion all run it over
 * model-written text with no cap: a page of ten thousand addresses was a
 * hundred billion characters. `replaceValues` finds where every value ends in
 * one Aho–Corasick scan and replays the passes over those places, and falls
 * back to the passes themselves only when a value could match across or
 * inside a marker (`markersStayPut`), which no shipped detector's value can.
 *
 * The work is counted with tool-code's __test__/js-work.ts, which charges a
 * string `split` the whole string it splits, a slice its characters and a
 * `charCodeAt` one; and the scan's own map reads with `replaceValues`' meter.
 * Detection is handed precomputed matches, so what is counted is the
 * replacement. Never timed.
 */
import { createHmac } from "node:crypto";
import { jsWorkAsync } from "../../tool-code/src/__test__/js-work";
import {
  DEFAULT_PII_DETECTORS,
  type PiiDetector,
  type PiiHit,
  createPiiRedactor,
  detectPii,
} from "./index";
import { markersStayPut, replaceValues } from "./replace";

/** Counted work per character of text and values; about 2 here. */
const WORK_PER_CHARACTER = 6;
/** `replaceValues`' steps per character of text and values; 2.4 apart, under 5 nested. */
const STEPS_PER_CHARACTER = 8;

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

/** The replacement as it was: one replace-all pass per value, widest first. */
function passes(
  text: string,
  hits: ReadonlyArray<PiiHit>,
  marker: (hit: PiiHit) => string,
): string {
  const sorted = [...hits].sort((a, b) => b.value.length - a.value.length);
  let out = text;
  for (const hit of sorted) out = out.split(hit.value).join(marker(hit));
  return out;
}

/** A detector that reports matches found beforehand, so detection costs nothing counted. */
function found(kind: string, text: string, values: ReadonlyArray<string>): PiiDetector {
  const matches: Array<{ index: number; value: string }> = [];
  for (const value of values) matches.push({ index: text.indexOf(value), value });
  return { kind, regex: /(?!)/g, matches: () => matches };
}

/** `k` distinct addresses, one after another. */
function addresses(k: number): { text: string; values: string[] } {
  const values = Array.from({ length: k }, (_, i) => `user${i}@example.com`);
  return { text: values.join(" "), values };
}

/** Addresses nested in one another, each also alone: the most values ending at one place. */
function nested(s: number): { text: string; values: string[] } {
  const values: string[] = [];
  for (let i = 0; i < s; i++)
    for (let j = 2; j < s; j++) values.push(`${"z".repeat(i)}a@b.${"c".repeat(j)}`);
  const widest = `${"z".repeat(s)}a@b.${"c".repeat(s)}`;
  const text = [...values, ...Array.from({ length: (s * s) / 2 }, () => widest)].join(" ");
  return { text, values: [...values, widest] };
}

const charsOf = (text: string, values: ReadonlyArray<string>): number =>
  values.reduce((sum, value) => sum + value.length, text.length);

describe("the redactor reads its text once, however many values it replaces", () => {
  test("thousands of distinct addresses, through PiiRedactor.redact", async () => {
    // One at a time: the meter wraps the prototypes for as long as it runs.
    const measured = [];
    for (const k of [2_000, 4_000]) {
      const { text, values } = addresses(k);
      const redactor = createPiiRedactor({ regexDetectors: [found("email", text, values)] });
      const chars = charsOf(text, values);
      const run = await jsWorkAsync(WORK_PER_CHARACTER * chars, () => redactor.redact(text));
      measured.push({ k, text, chars, run });
    }
    for (const { k, text, chars, run } of measured) {
      expect(run.work).toBeLessThanOrEqual(WORK_PER_CHARACTER * chars);
      expect(run.value?.redactedHits).toHaveLength(k);
      expect(run.value?.text).toBe(Array.from({ length: k }, () => "[REDACTED:email]").join(" "));
      expect(run.value?.text.length).toBeLessThan(text.length);
    }
    const [small, large] = measured as [(typeof measured)[0], (typeof measured)[0]];
    // Twice the values and text, about twice the work.
    expect(large.run.work / small.run.work).toBeLessThan(2.4);
  }, 20_000);

  test("the scan's own steps, for addresses apart and addresses nested", () => {
    for (const [label, make, sizes] of [
      ["apart", addresses, [2_000, 4_000]],
      ["nested", nested, [20, 40]],
    ] as const) {
      const measured = sizes.map((size) => {
        const { text, values } = make(size);
        const hits = values.map((value) => ({ kind: "email", value }));
        const meter = { steps: 0 };
        const out = replaceValues(text, hits, (hit) => `[REDACTED:${hit.kind}]`, meter);
        return { chars: charsOf(text, values), steps: meter.steps, out };
      });
      for (const { chars, steps, out } of measured) {
        expect({ label, within: steps <= STEPS_PER_CHARACTER * chars }).toEqual({
          label,
          within: true,
        });
        expect(out.includes("@")).toBe(false);
      }
      const [small, large] = measured as [(typeof measured)[0], (typeof measured)[0]];
      // Steps grow with the characters, not with the values times the text.
      expect({
        label,
        ratio: large.steps / large.chars < 1.2 * (small.steps / small.chars),
      }).toEqual({ label, ratio: true });
    }
  }, 20_000);

  test("values that are suffixes of one another, turned away just past a wider take: never more than the passes", () => {
    // `b` and K `a`s is taken first, so each shorter run of `a`s that ends
    // in the `a`s after it starts inside that take and is turned away, down
    // the chain until one starts past it. Each place is then listed for
    // every value of the chain still too wide: the documented worst case,
    // the distinct values times the text, which is what the passes read.
    for (const k of [40, 80]) {
      const block = `b${"a".repeat(k + k / 2)}c`;
      const text = block.repeat(200);
      const hits: PiiHit[] = [{ kind: "U", value: `b${"a".repeat(k)}` }];
      for (let j = k; j >= 1; j--) hits.push({ kind: "A", value: "a".repeat(j) });
      const meter = { steps: 0 };
      const out = replaceValues(text, hits, (hit) => `[${hit.kind}]`, meter);
      expect(out).toBe(passes(text, hits, (hit) => `[${hit.kind}]`));
      const chars = charsOf(
        text,
        hits.map((hit) => hit.value),
      );
      expect(meter.steps).toBeLessThanOrEqual(
        hits.length * text.length + STEPS_PER_CHARACTER * chars,
      );
      // Under half of it here: the turned-away runs are a third of the text.
      expect(meter.steps).toBeLessThan((hits.length * text.length) / 2);
    }
  }, 20_000);
});

describe("replaceValues gives what the passes gave", () => {
  test("generated values and markers, including ones that meet inside a marker", () => {
    const next = rng(0x9e1d7001);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
    const alphabet = ["a", "b", "c", "[", "]", ":", "x", "\uD83D", "\uDE00"];
    const word = (max: number): string => {
      let s = "";
      for (let i = Math.floor(next() * max); i > 0; i--) s += pick(alphabet);
      return s;
    };
    const differ: string[] = [];
    let onePass = 0;
    let fallback = 0;
    for (let round = 0; round < 20_000; round++) {
      const text = word(40);
      const hits: PiiHit[] = [];
      for (let i = 1 + Math.floor(next() * 6); i > 0; i--) {
        const from = Math.floor(next() * Math.max(1, text.length));
        const value =
          text.length > 0 && next() < 0.8
            ? text.slice(from, from + 1 + Math.floor(next() * 5))
            : word(4);
        hits.push({ kind: pick(["k", "kind", "x"]), value: value.length > 0 ? value : "a" });
      }
      const style = round % 4;
      const chosen = new Map<PiiHit, string>();
      const marker = (hit: PiiHit): string => {
        let m = chosen.get(hit);
        if (m === undefined) {
          m =
            style === 0
              ? `[R:${hit.kind}]`
              : style === 1
                ? `<${hit.kind}>`
                : style === 2
                  ? pick(["", "a", "ab", "[", "]", "c:x", hit.value, `${hit.value}${hit.value}`])
                  : `#${hit.value.length}#`;
          chosen.set(hit, m);
        }
        return m;
      };
      const sorted = [...hits].sort((a, b) => b.value.length - a.value.length);
      if (
        markersStayPut(
          sorted.map((h) => h.value),
          sorted.map(marker),
        )
      )
        onePass++;
      else fallback++;
      if (replaceValues(text, hits, marker) !== passes(text, hits, marker)) differ.push(text);
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(onePass).toBeGreaterThan(10_000);
    expect(fallback).toBeGreaterThan(4_000);
  }, 20_000);

  test("the shipped detectors, in replace and hash mode, over PII-dense text", async () => {
    const next = rng(0x9e1d7002);
    const pieces = [
      "a@b.co",
      "za@b.co",
      "jane.doe@example.com",
      " ",
      "\n",
      ", ",
      "123-45-6789",
      "123456789",
      "4111 1111 1111 1111",
      "(415) 555-1234",
      "+44 20 7946 0958",
      "DE89370400440532013000",
      "[",
      "]",
      "[REDACTED:email]",
      "@",
      ".",
      "x",
    ];
    const secret = "s3";
    const hash = (value: string): string =>
      createHmac("sha256", secret).update(value).digest("hex").slice(0, 16);
    const differ: string[] = [];
    let redacted = 0;
    for (let round = 0; round < 1_500; round++) {
      let text = "";
      for (let i = Math.floor(next() * 40); i > 0; i--) {
        text += pieces[Math.floor(next() * pieces.length)];
      }
      const seen = new Set<string>();
      const hits = detectPii(text).filter((h) => {
        const key = `${h.kind}${h.value}`;
        if (h.value.length === 0 || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const replaced = (await createPiiRedactor().redact(text)).text;
      const hashed = (await createPiiRedactor({ mode: "hash", secret }).redact(text)).text;
      if (replaced !== passes(text, hits, (h) => `[REDACTED:${h.kind}]`)) differ.push(text);
      if (hashed !== passes(text, hits, (h) => `[HASHED:${h.kind}:${hash(h.value)}]`)) {
        differ.push(text);
      }
      // The one pass is the path these take, every time.
      const sorted = [...hits].sort((a, b) => b.value.length - a.value.length);
      const values = sorted.map((h) => h.value);
      if (
        !markersStayPut(
          values,
          sorted.map((h) => `[REDACTED:${h.kind}]`),
        )
      )
        differ.push(text);
      if (replaced !== text) redacted++;
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(redacted).toBeGreaterThan(1_200);
  }, 20_000);

  test("a value that could meet a marker sends the replacement back to the passes", () => {
    const marker = (hit: PiiHit): string => `[REDACTED:${hit.kind}]`;
    const values = (hits: PiiHit[]) =>
      [...hits].sort((a, b) => b.value.length - a.value.length).map((h) => h.value);
    const markers = (hits: PiiHit[]) =>
      [...hits].sort((a, b) => b.value.length - a.value.length).map(marker);
    const cases: Array<{ hits: PiiHit[]; text: string }> = [
      // A narrower value that sits inside the wider value's marker.
      {
        hits: [
          { kind: "email", value: "x@y.io" },
          { kind: "k", value: "ACT" },
        ],
        text: "x@y.io ACT",
      },
      // A narrower value holding the marker's closing bracket.
      {
        hits: [
          { kind: "email", value: "x@y.io" },
          { kind: "k", value: "l]z" },
        ],
        text: "x@y.iol]z",
      },
      // An empty marker joins its neighbours.
      {
        hits: [
          { kind: "", value: "XY" },
          { kind: "k", value: "ab" },
        ],
        text: "aXYb",
      },
    ];
    for (const { hits, text } of cases.slice(0, 2)) {
      expect(markersStayPut(values(hits), markers(hits))).toBe(false);
      expect(replaceValues(text, hits, marker)).toBe(passes(text, hits, marker));
    }
    const empty = cases[2] as (typeof cases)[2];
    const blank = (hit: PiiHit): string => (hit.kind === "" ? "" : marker(hit));
    expect(markersStayPut(values(empty.hits), [...empty.hits].map(blank))).toBe(false);
    expect(replaceValues(empty.text, empty.hits, blank)).toBe("[REDACTED:k]");
    // The passes cut "ACT" out of "[REDACTED:email]"; so does the replacement.
    expect(replaceValues("x@y.io ACT", cases[0]?.hits ?? [], marker)).toBe(
      "[RED[REDACTED:k]ED:email] [REDACTED:k]",
    );
  });

  test("the shipped detector set holds no value that can meet a marker", () => {
    // Every default kind's marker, and values of each detector's shapes.
    const markers = DEFAULT_PII_DETECTORS.map((d) => `[REDACTED:${d.kind}]`);
    const text =
      "a@b.co 123-45-6789 4111111111111111 (415) 555-1234 +44 20 7946 0958 DE89370400440532013000";
    const hits = detectPii(text);
    expect(hits.length).toBeGreaterThan(4);
    // Each value checked against every marker: wide placeholder values put
    // the markers in first.
    for (const hit of hits) {
      const values = [...markers.map(() => "x".repeat(99)), hit.value];
      expect(markersStayPut(values, [...markers, "m"])).toBe(true);
    }
  });
});
