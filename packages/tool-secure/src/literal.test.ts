/**
 * ContentPolicyCheck's phrase rules find what 0.7.0's escaped regex found,
 * in time that does not grow with the phrase (C073's residual, bounds
 * review).
 *
 * 0.7.0 ran each phrase as `new RegExp(escaped, "gi")` on the caller's thread.
 * Case-insensitive, JavaScriptCore tries the whole phrase at every position:
 * four rules of `a`×50 000 then `b` over 2 000 000 `a`s took 16.6 s with no
 * event-loop turn, and a check may hold 200 rules. That regex is kept here
 * as the ORACLE, run on small inputs only.
 */
import { describe, expect, test } from "bun:test";
import { contentPolicyCheck } from "./index";
import { LiteralSearch, canonicalUnit } from "./lib/literal";
import { evaluatePolicy } from "./lib/policy";

/** Every match of a global regex: index and text. */
function allMatches(re: RegExp, text: string): { index: number; match: string }[] {
  const out: { index: number; match: string }[] = [];
  for (const m of text.matchAll(re)) out.push({ index: m.index, match: m[0] });
  return out;
}

/** 0.7.0's phrase search: the phrase escaped into a global regex. */
function oracle(text: string, phrase: string, caseSensitive: boolean) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return allMatches(new RegExp(escaped, caseSensitive ? "g" : "gi"), text);
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Letters whose case pairs are irregular: dotted and dotless i, sharp s, the
// three sigmas, the Kelvin and long-s signs that upper-case into ASCII, the
// micro sign, pairs newer than some engines' tables, and surrogate halves.
const ALPHABET = [
  ..."abcABC aAbB-.*+?$^()[]{}|\\",
  "i",
  "I",
  "İ",
  "ı",
  "ß",
  "ẞ",
  "σ",
  "ς",
  "Σ",
  "K",
  "k",
  "K",
  "ſ",
  "s",
  "S",
  "µ",
  "Μ",
  "μ",
  "ƛ",
  "Ƛ",
  "Ᲊ",
  "ᲊ",
  "ɤ",
  "Ɤ",
  "\ud83d",
  "\ude00",
  "é",
  "É",
];

/** A few letters, so texts repeat themselves and phrases overlap their own matches. */
const SMALL = ["a", "A", "b", "\u03c3", "\u03a3", "\u03c2"];

function flipCase(s: string, next: () => number): string {
  let out = "";
  for (const ch of s) {
    const r = next();
    out += r < 0.33 ? ch.toUpperCase() : r < 0.66 ? ch.toLowerCase() : ch;
  }
  return out;
}

describe("a phrase rule's search", () => {
  test("finds exactly what the regex found, case-sensitive or not", () => {
    const next = rng(0xc073);
    let compared = 0;
    for (let n = 0; n < 4_000; n++) {
      const len = 1 + Math.floor(next() * 60);
      const letters = n % 2 === 0 ? ALPHABET : SMALL;
      let text = "";
      for (let i = 0; i < len; i++) text += letters[Math.floor(next() * letters.length)];
      let phrase: string;
      if (next() < 0.7) {
        const from = Math.floor(next() * text.length);
        const to = Math.min(text.length, from + 1 + Math.floor(next() * 6));
        phrase = flipCase(text.slice(from, to), next);
      } else {
        phrase = "";
        const plen = 1 + Math.floor(next() * 4);
        for (let i = 0; i < plen; i++) phrase += letters[Math.floor(next() * letters.length)];
      }
      if (phrase === "") continue;
      for (const caseSensitive of [false, true]) {
        const want = oracle(text, phrase, caseSensitive);
        const got = new LiteralSearch(text).find(phrase, caseSensitive, 1_000);
        expect({ text, phrase, caseSensitive, got: got.matches, count: got.count }).toEqual({
          text,
          phrase,
          caseSensitive,
          got: want,
          count: want.length,
        });
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(7_000);
  });

  test("an empty phrase matches at every position, as an empty regex does", () => {
    expect(new LiteralSearch("abc").find("", false, 2)).toEqual({
      count: 4,
      matches: [
        { index: 0, match: "" },
        { index: 1, match: "" },
      ],
    });
  });

  test("folds every cased code unit as the regex `i` flag does, on this engine", () => {
    // Every code unit with a case mapping, and every one sharing a class
    // with one, against the whole code-unit range: the regex's matches are
    // exactly the units this search treats as equal.
    const units = new Uint16Array(0x10000);
    for (let c = 0; c < 0x10000; c++) units[c] = c;
    const hay = Buffer.from(units.buffer).toString("utf16le");
    const classes = new Map<number, number[]>();
    for (let c = 0; c < 0x10000; c++) {
      const k = canonicalUnit(c);
      const members = classes.get(k);
      if (members === undefined) classes.set(k, [c]);
      else members.push(c);
    }
    let checked = 0;
    for (let c = 0; c < 0x10000; c++) {
      const ch = String.fromCharCode(c);
      const members = classes.get(canonicalUnit(c)) as number[];
      if (ch.toUpperCase() === ch && ch.toLowerCase() === ch && members.length === 1) continue;
      const re = new RegExp(`\\u${c.toString(16).padStart(4, "0")}`, "gi");
      const matched = allMatches(re, hay).map((m) => m.index);
      expect({ c, matched }).toEqual({ c, matched: members });
      checked += 1;
    }
    // Over two thousand cased units on any engine this runs on.
    expect(checked).toBeGreaterThan(2_000);
  });
});

describe("ContentPolicyCheck's phrase rules are linear in the text (C073 residual)", () => {
  test("long phrases that almost match everywhere take no longer than short ones", async () => {
    const text = "a".repeat(2_000_000);
    const long = `${"a".repeat(50_000)}b`;
    const rules = [
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `ci${i}`,
        kind: "forbidden_phrase" as const,
        value: long,
      })),
      { id: "cs", kind: "forbidden_phrase" as const, value: long, caseSensitive: true },
      { id: "required", kind: "required_phrase" as const, value: `${"A".repeat(49_999)}Ab` },
      { id: "present", kind: "forbidden_phrase" as const, value: "A".repeat(50_000) },
    ];
    // 0.7.0 took 16.6 s for the first four alone, holding the event loop.
    const started = performance.now();
    const out = JSON.parse(String(await contentPolicyCheck.execute({ text, rules }, {} as never)));
    expect(performance.now() - started).toBeLessThan(5_000);
    const byId = Object.fromEntries(
      (out.outcomes as { id: string; status: string; matchCount: number }[]).map((o) => [o.id, o]),
    );
    for (const id of ["ci0", "ci1", "ci2", "ci3", "cs"]) {
      expect(byId[id]).toMatchObject({ status: "pass", matchCount: 0 });
    }
    expect(byId.required).toMatchObject({ status: "fail", matchCount: 0 });
    // Case-insensitive, and not overlapping: 2 000 000 / 50 000.
    expect(byId.present).toMatchObject({ status: "fail", matchCount: 40 });
  });

  test("the first matches are located on their lines, spelled as the text spells them", async () => {
    const out = await evaluatePolicy("Guaranteed.\nnot GUARANTEED, guaranteed", [
      { id: "g", kind: "forbidden_phrase", value: "guaranteed" },
    ]);
    expect(out.outcomes[0]).toMatchObject({
      status: "fail",
      matchCount: 3,
      matches: [
        { line: 1, column: 1, excerpt: "Guaranteed" },
        { line: 2, column: 5, excerpt: "GUARANTEED" },
        { line: 2, column: 17, excerpt: "guaranteed" },
      ],
    });
  });
});

describe("an invalid pattern's error keeps the engine's reason (bounds review)", () => {
  test("the message says what is wrong with it", async () => {
    const out = JSON.parse(
      String(
        await contentPolicyCheck.execute(
          { text: "x", rules: [{ id: "bad", kind: "review_pattern", value: "(unclosed" }] },
          {} as never,
        ),
      ),
    );
    expect(out.outcomes[0].status).toBe("error");
    expect(out.outcomes[0].message).toContain("invalid-syntax");
    expect(out.outcomes[0].message).toContain("missing )");
  });
});
