/**
 * GlossaryReplace's mapping costs what the call is allowed to grow to,
 * counted, never timed.
 *
 * Terms apply longest first, each to the text the terms before it produced,
 * so a replacement that holds the next term twenty times multiplied the text
 * by twenty per term: a 382-byte call grew it to 639,999 characters, and a
 * fifth term to 12.8 million. Each term was also a pass over the whole text,
 * however many terms there were. The text may now grow to the tool's limit
 * for text, and the passes together may read a hundred times that; past
 * either the call is refused with a sentence, never cut.
 *
 * The glossary loop 0.7.0 shipped is kept below as the reference.
 */
import { describe, expect, test } from "bun:test";
import { glossaryReplace as glossaryTool } from "./index";
import { escapeFor } from "./lib/format";
import { glossaryReplace } from "./lib/normalize";

// ---------------------------------------------------------------------------
// the reference
// ---------------------------------------------------------------------------

/** The glossary loop as 0.7.0 shipped it, but for its name. */
function referenceGlossary(
  text: string,
  mapping: Readonly<Record<string, string>>,
  wholeWord: boolean,
  caseSensitive: boolean,
): { text: string; replacements: Record<string, number> } {
  const replacements: Record<string, number> = {};
  let out = text;
  for (const term of Object.keys(mapping).sort((a, b) => b.length - a.length)) {
    const escaped = escapeFor(term, "regex");
    const source = wholeWord ? `(?<![\\w-])${escaped}(?![\\w-])` : escaped;
    const re = new RegExp(source, caseSensitive ? "g" : "gi");
    let count = 0;
    out = out.replace(re, () => {
      count++;
      return mapping[term] as string;
    });
    if (count > 0) replacements[term] = count;
  }
  return { text: out, replacements };
}

/** xorshift32: the same cases on every run and every machine. */
function generator(seed: number): () => number {
  const state = { x: seed >>> 0 || 1 };
  return () => {
    state.x ^= state.x << 13;
    state.x >>>= 0;
    state.x ^= state.x >>> 17;
    state.x ^= state.x << 5;
    state.x >>>= 0;
    return state.x / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// the meter
// ---------------------------------------------------------------------------

type Fn = (this: unknown, ...args: unknown[]) => unknown;

const OVER = Symbol("over the work limit");

/**
 * Run `body`, counting what `String.prototype.replace` is handed and what
 * its replacer functions return: every pass's text, and every character a
 * pass puts in. Past `limit` the next charge throws, so an expansion that
 * would run away stops at once. A regular expression's own search is native
 * and not seen; it is charged as the text it runs over.
 */
function replaceWork<T>(
  limit: number,
  body: () => T,
): { readonly outcome: T | Error | undefined; readonly work: number } {
  const counter = { work: 0, over: false };
  const charge = (n: number): void => {
    if (counter.over) throw OVER;
    counter.work += n;
    if (counter.work > limit) {
      counter.over = true;
      throw OVER;
    }
  };
  const strings = String.prototype as unknown as Record<string, Fn>;
  const real = strings["replace"] as Fn;
  strings["replace"] = function (this: unknown, pattern: unknown, replacer: unknown) {
    charge(String(this).length);
    const counted =
      typeof replacer === "function"
        ? (...args: unknown[]) => {
            const out = String((replacer as (...a: unknown[]) => unknown)(...args));
            charge(out.length);
            return out;
          }
        : replacer;
    return real.call(this, pattern, counted);
  };
  let outcome: T | Error | undefined;
  try {
    outcome = body();
  } catch (err) {
    if (err !== OVER) outcome = err as Error;
  } finally {
    strings["replace"] = real;
  }
  return counter.over
    ? { outcome: undefined, work: Number.POSITIVE_INFINITY }
    : { outcome, work: counter.work };
}

/**
 * `k` terms, longest first, each one's replacement holding the next term
 * `copies` times as whole words, and the text the longest term: the shape
 * that multiplied the text by `copies` per term.
 */
function cascade(k: number, copies = 20): { text: string; mapping: Record<string, string> } {
  const terms = Array.from({ length: k }, (_, i) => `t${"q".repeat(k - i)}`);
  const mapping: Record<string, string> = {};
  for (let i = 0; i < k; i++) {
    mapping[terms[i] as string] = Array.from({ length: copies }, () => terms[i + 1] ?? "end").join(
      " ",
    );
  }
  return { text: terms[0] as string, mapping };
}

const GREW = "the glossary would make the text longer than";
const READ = "send fewer terms or a shorter text";

const refusal = (body: () => unknown): string => {
  try {
    body();
  } catch (err) {
    return (err as Error).message;
  }
  return "not refused";
};

// ---------------------------------------------------------------------------
// old against new
// ---------------------------------------------------------------------------

describe("the glossary gives what the 0.7.0 loop gave", () => {
  test("generated texts and mappings: whole words or not, either case, terms inside replacements, the empty term", () => {
    const random = generator(81);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const PIECES = [
      "ai",
      "AI",
      "Ai",
      "chain",
      "CHAIN",
      "a",
      "b",
      "ab",
      "-",
      "_",
      " ",
      "x-y",
      "é",
      "É",
      "ß",
      "SS",
      "ſ",
      "s",
      "K",
      "k",
      ".",
      "*",
      "$&",
      "$1",
      "\\",
      "(",
      "[",
      "\n",
      "1",
      "\u{1F600}",
      "\uD83D",
    ];
    const piece = (max: number): string => {
      let out = "";
      for (let i = 0, n = Math.floor(random() * (max + 1)); i < n; i++) out += pick(PIECES);
      return out;
    };
    let cases = 0;
    let changed = 0;
    let grew = 0;
    let emptyTerm = 0;
    let mismatches = 0;
    for (let i = 0; i < 20_000; i++) {
      const text = piece(10);
      const mapping: Record<string, string> = {};
      for (let j = 0, n = Math.floor(random() * 6); j < n; j++) {
        const roll = random();
        const from = Math.floor(random() * text.length);
        const term =
          roll < 0.05
            ? ""
            : roll < 0.4
              ? text.slice(from, from + 1 + Math.floor(random() * 6))
              : piece(2);
        // Some replacements hold a term already in the mapping.
        const earlier = Object.keys(mapping);
        mapping[term] =
          earlier.length > 0 && random() < 0.3 ? `${pick(earlier)} ${piece(2)}` : piece(3);
      }
      const wholeWord = random() < 0.5;
      const caseSensitive = random() < 0.5;
      const expected = referenceGlossary(text, mapping, wholeWord, caseSensitive);
      const got = glossaryReplace(text, mapping, wholeWord, caseSensitive);
      cases += 1;
      if (expected.text !== text) changed += 1;
      if (expected.text.length > text.length) grew += 1;
      if ("" in mapping) emptyTerm += 1;
      if (JSON.stringify(got) !== JSON.stringify(expected)) mismatches += 1;
    }
    expect(mismatches).toBe(0);
    expect(cases).toBe(20_000);
    expect(changed).toBeGreaterThan(5_000);
    expect(grew).toBeGreaterThan(2_000);
    expect(emptyTerm).toBeGreaterThan(1_000);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// the limits
// ---------------------------------------------------------------------------

describe("the text may grow to the limit, and not one character past it", () => {
  test("one match, two matches, text after the last match, the empty term, any case", () => {
    const limit = 100;
    const cases: Array<[string, Record<string, string>, boolean, number]> = [
      ["a", { a: "x".repeat(100) }, true, 100],
      // Two matches and the dots after them: 2 × 49 + 2.
      ["a.a.", { a: "x".repeat(49) }, true, 100],
      // Text after the last match: 6 characters kept, 94 put in.
      ["xx a xx", { a: "v".repeat(94) }, true, 100],
      // The empty term matches at the one place in "" where no word touches.
      ["", { "": "x".repeat(100) }, true, 100],
      // Not whole words, and matched in any case: "AIai" is two matches.
      ["AIai", { ai: "x".repeat(50) }, false, 100],
    ];
    for (const [text, mapping, wholeWord, length] of cases) {
      const at = glossaryReplace(text, mapping, wholeWord, false, limit);
      expect(at).toEqual(referenceGlossary(text, mapping, wholeWord, false));
      expect(at.text.length).toBe(length);
      const term = Object.keys(mapping)[0] as string;
      const over = { [term]: `${mapping[term]}x` };
      expect(referenceGlossary(text, over, wholeWord, false).text.length).toBeGreaterThan(limit);
      expect(refusal(() => glossaryReplace(text, over, wholeWord, false, limit))).toContain(
        `${GREW} ${limit} characters`,
      );
    }
  });

  test("a replacement that shortens the text is never refused, whatever its length", () => {
    const text = "a ".repeat(200);
    const out = glossaryReplace(text, { a: "" }, true, false, 100);
    expect(out).toEqual(referenceGlossary(text, { a: "" }, true, false));
    expect(out.replacements).toEqual({ a: 200 });
  });

  test("the passes may read a hundred times the limit, and not one pass more", () => {
    const limit = 100;
    const text = "z".repeat(limit);
    const terms = (n: number): Record<string, string> =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, "v"]));
    expect(glossaryReplace(text, terms(100), true, false, limit).text).toBe(text);
    expect(refusal(() => glossaryReplace(text, terms(101), true, false, limit))).toContain(READ);
  });

  test("at the GlossaryReplace tool's own limit for text", () => {
    const limit = 2_000_000;
    expect(glossaryReplace("a", { a: "x".repeat(limit) }, true, false).text.length).toBe(limit);
    expect(
      refusal(() => glossaryReplace("a", { a: "x".repeat(limit + 1) }, true, false)),
    ).toContain(`${GREW} ${limit} characters`);
  });
});

describe("what a call can make the glossary do is counted", () => {
  test("terms whose replacements hold the next term: refused within a few times the limit, however many terms", () => {
    // Twelve terms would multiply the text by 20^12.
    const { text, mapping } = cascade(12);
    const counted = [20_000, 40_000].map((limit) => ({
      limit,
      ...replaceWork(8 * limit, () => glossaryReplace(text, mapping, true, false, limit)),
    }));
    for (const { limit, outcome, work } of counted) {
      expect(work).toBeLessThanOrEqual(4 * limit);
      expect((outcome as Error).message).toContain(`${GREW} ${limit} characters`);
    }
    const [small, large] = counted as [(typeof counted)[0], (typeof counted)[0]];
    expect(large.work / small.work).toBeLessThan(2.25);
  });

  test("thousands of terms over a long text: refused after a hundred passes' reading", () => {
    const limit = 2_000;
    const text = "z".repeat(limit);
    const mapping = Object.fromEntries(Array.from({ length: 3_000 }, (_, i) => [`k${i}`, "v"]));
    const { outcome, work } = replaceWork(128 * limit, () =>
      glossaryReplace(text, mapping, true, false, limit),
    );
    expect((outcome as Error).message).toContain(READ);
    // A hundred passes over the text, and escaping the hundred terms read.
    expect(work).toBeLessThanOrEqual(101 * limit);
  });
});

// ---------------------------------------------------------------------------
// through the tool
// ---------------------------------------------------------------------------

describe("GlossaryReplace with replacements that multiply the text", () => {
  // biome-ignore lint/suspicious/noExplicitAny: the executor supplies this context, and this tool reads none of it.
  const ctx = {} as any;

  test("four terms stay under the limit and give the text they always gave", async () => {
    // The 382-byte call that grew the text to 639,999 characters.
    const { text, mapping } = cascade(4);
    const expected = referenceGlossary(text, mapping, true, false);
    const out = JSON.parse(String(await glossaryTool.execute({ text, mapping }, ctx)));
    expect(out).toEqual(expected);
    expect(out.text.length).toBe(639_999);
  });

  test("a fifth term would pass the limit for text, and the call says so", async () => {
    const { text, mapping } = cascade(5);
    await expect(glossaryTool.execute({ text, mapping }, ctx)).rejects.toThrow(
      `${GREW} 2000000 characters, the limit for text`,
    );
  });
});
