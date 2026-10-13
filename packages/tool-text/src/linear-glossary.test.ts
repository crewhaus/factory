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
 * Each term was found by a regular expression that tried the whole term from
 * every position, so one pass read the text's length times the term's. It is
 * now found in one read of the text (Knuth–Morris–Pratt), with the same
 * matches.
 *
 * The glossary loop 0.7.0 shipped is kept below as the reference, with a
 * second one that finds the same matches without a lookbehind: JavaScriptCore
 * folds case differently in a pattern that has one (see "the lookbehind's
 * folding", below), and the glossary now folds the same way with and without
 * whole words.
 */
import { describe, expect, test } from "bun:test";
import { regexWork } from "./__test__/regex-work";
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

/**
 * The 0.7.0 loop's matches, found without a lookbehind: from each place the
 * search resumes, the first start where the term matches (a sticky regex,
 * with the `(?![\w-])` lookahead for whole words) and, for whole words, the
 * unit before it is not `[\w-]` — which is what `(?<![\w-])` asked. The
 * same matches, except that JavaScriptCore folds case one way more in a
 * pattern with a lookbehind (see "the lookbehind's folding").
 */
function lookbehindFreeGlossary(
  text: string,
  mapping: Readonly<Record<string, string>>,
  wholeWord: boolean,
  caseSensitive: boolean,
): { text: string; replacements: Record<string, number> } {
  const replacements: Record<string, number> = {};
  let out = text;
  for (const term of Object.keys(mapping).sort((a, b) => b.length - a.length)) {
    const escaped = escapeFor(term, "regex");
    const re = new RegExp(wholeWord ? `${escaped}(?![\\w-])` : escaped, caseSensitive ? "y" : "yi");
    const parts: string[] = [];
    let copied = 0;
    let count = 0;
    for (let at = 0; at <= out.length; at++) {
      if (wholeWord && at > 0 && /[\w-]/.test(out.charAt(at - 1))) continue;
      re.lastIndex = at;
      if (!re.test(out)) continue;
      parts.push(out.slice(copied, at), mapping[term] as string);
      count++;
      copied = at + term.length;
      // An empty match moves on one unit, as a global replace does.
      at = term.length === 0 ? at : copied - 1;
    }
    if (count > 0) {
      replacements[term] = count;
      out = parts.join("") + out.slice(copied);
    }
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
 * Run `body`, counting the search's work: every step a regular expression
 * takes (the step model in __test__/regex-work.ts), and every unit read by
 * `charCodeAt` and every character `slice` and `join` return. Past `limit`
 * either count stops the body, and the work reads as Infinity.
 */
function searchWork<T>(
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
  const arrays = Array.prototype as unknown as Record<string, Fn>;
  const real = {
    charCodeAt: strings["charCodeAt"] as Fn,
    slice: strings["slice"] as Fn,
    join: arrays["join"] as Fn,
  };
  strings["charCodeAt"] = function (this: unknown, ...args: unknown[]) {
    charge(1);
    return real.charCodeAt.apply(this, args);
  };
  strings["slice"] = function (this: unknown, ...args: unknown[]) {
    const out = real.slice.apply(this, args) as string;
    charge(out.length);
    return out;
  };
  arrays["join"] = function (this: unknown, ...args: unknown[]) {
    const out = real.join.apply(this, args) as string;
    charge(out.length);
    return out;
  };
  let outcome: T | Error | undefined;
  let steps = 0;
  try {
    const regex = regexWork(limit, () => {
      try {
        return body();
      } catch (err) {
        if (err === OVER) throw err;
        return err as Error;
      }
    });
    steps = regex.steps;
    outcome = regex.value;
  } catch (err) {
    if (err !== OVER) throw err;
  } finally {
    strings["charCodeAt"] = real.charCodeAt;
    strings["slice"] = real.slice;
    arrays["join"] = real.join;
  }
  const work = counter.work + steps;
  return counter.over || work > limit
    ? { outcome: undefined, work: Number.POSITIVE_INFINITY }
    : { outcome, work };
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
    // Against the 0.7.0 loop itself: only where its lookbehind folded the
    // Kelvin sign or the long s into another letter.
    let lookbehindFolds = 0;
    let unexplained = 0;
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
      const expected = lookbehindFreeGlossary(text, mapping, wholeWord, caseSensitive);
      const shipped = referenceGlossary(text, mapping, wholeWord, caseSensitive);
      const got = glossaryReplace(text, mapping, wholeWord, caseSensitive);
      cases += 1;
      if (expected.text !== text) changed += 1;
      if (expected.text.length > text.length) grew += 1;
      if ("" in mapping) emptyTerm += 1;
      if (JSON.stringify(got) !== JSON.stringify(expected)) mismatches += 1;
      if (JSON.stringify(got) !== JSON.stringify(shipped)) {
        const explained =
          wholeWord &&
          !caseSensitive &&
          Object.keys(mapping).some((t) => t.includes("\u212A") || t.includes("\u017F"));
        if (explained) lookbehindFolds += 1;
        else unexplained += 1;
      }
    }
    expect(mismatches).toBe(0);
    expect(unexplained).toBe(0);
    expect(lookbehindFolds).toBeLessThan(20);
    expect(cases).toBe(20_000);
    expect(changed).toBeGreaterThan(5_000);
    expect(grew).toBeGreaterThan(2_000);
    expect(emptyTerm).toBeGreaterThan(1_000);
  }, 60_000);
});

describe("the matches are where the 0.7.0 regex found them", () => {
  test("every text up to four units and every term up to three, over letters, case, `-` and space", () => {
    // Exhaustive where the search can go wrong: a term that overlaps itself
    // (`aa`, `aAa`, `a-a`), a match whole words reject that a later one
    // inside it may take, the empty term, either case.
    const units = ["a", "A", "-", " ", "b"];
    const strings = (alphabet: readonly string[], max: number): string[] => {
      const out = [""];
      for (let from = 0, length = 1; length <= max; length++) {
        const to = out.length;
        for (let i = from; i < to; i++) for (const u of alphabet) out.push(`${out[i]}${u}`);
        from = to;
      }
      return out;
    };
    const texts = strings(units, 4);
    const terms = strings(["a", "A", "-"], 3);
    let checked = 0;
    const wrong: unknown[] = [];
    for (const text of texts) {
      for (const term of terms) {
        for (const wholeWord of [true, false]) {
          for (const caseSensitive of [true, false]) {
            const mapping = { [term]: "<>" };
            const want = referenceGlossary(text, mapping, wholeWord, caseSensitive);
            const got = glossaryReplace(text, mapping, wholeWord, caseSensitive);
            checked += 1;
            if (JSON.stringify(got) !== JSON.stringify(want) && wrong.length < 5) {
              wrong.push({ text, term, wholeWord, caseSensitive, want, got });
            }
          }
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(checked).toBe(781 * 40 * 4);
  }, 60_000);

  test("long periodic texts and terms that nearly repeat in them", () => {
    const random = generator(4471);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const BLOCKS = ["ab", "aab", "abab", "aBa", "a-b", "ab ", "Ab", "é", "É", "ß", "σ", "Σ", "ς"];
    let checked = 0;
    let matched = 0;
    const wrong: unknown[] = [];
    for (let i = 0; i < 400; i++) {
      const block = pick(BLOCKS);
      const reps = 1 + Math.floor(random() * 300);
      const units = block.repeat(reps).split("");
      // A few units changed, so the term nearly repeats and then does not.
      for (let j = 0, n = Math.floor(random() * 4); j < n && units.length > 0; j++) {
        units[Math.floor(random() * units.length)] = pick(["a", "b", "A", " ", "-", "x"]);
      }
      const text = units.join("");
      const termReps = 1 + Math.floor(random() * 6);
      const term = (random() < 0.5 ? block : pick(BLOCKS)).repeat(termReps);
      const mapping = { [term]: "#" };
      const wholeWord = random() < 0.5;
      const caseSensitive = random() < 0.5;
      const want = referenceGlossary(text, mapping, wholeWord, caseSensitive);
      const got = glossaryReplace(text, mapping, wholeWord, caseSensitive);
      checked += 1;
      if (want.replacements[term] !== undefined) matched += 1;
      if (JSON.stringify(got) !== JSON.stringify(want) && wrong.length < 3) {
        wrong.push({ text, term, wholeWord, caseSensitive });
      }
    }
    expect(wrong).toEqual([]);
    expect(checked).toBe(400);
    expect(matched).toBeGreaterThan(100);
  }, 60_000);

  test("the lookbehind's folding: whole words fold case as the term alone does", () => {
    // JavaScriptCore folds some units further in a pattern that has a
    // lookbehind, several of them one way only: there the Kelvin sign
    // matched "k", the long s "S" and the capital sharp s "ß", none of which
    // the term on its own (whole words off) matched, and "k" never matched
    // the Kelvin sign. The glossary now folds the same way with whole words
    // on or off: as the term on its own does.
    const plainFolds = (term: string, unit: string): boolean =>
      new RegExp(escapeFor(term, "regex"), "i").test(unit);
    const cases: Array<[string, string]> = [
      ["\u212A", "k"],
      ["\u017F", "S"],
      ["\u1E9E", "\u00DF"],
      ["\u0131", "I"],
      ["\u2126", "\u03C9"],
    ];
    for (const [term, unit] of cases) {
      expect({ term, plain: plainFolds(term, unit) }).toEqual({ term, plain: false });
      for (const wholeWord of [true, false]) {
        expect({
          term,
          wholeWord,
          got: glossaryReplace(unit, { [term]: "#" }, wholeWord, false),
        }).toEqual({
          term,
          wholeWord,
          got: { text: unit, replacements: {} },
        });
      }
    }
    // And the units they do fold with, they still match with whole words.
    expect(glossaryReplace("\u03C3 \u03C2 \u03A3", { "\u03C3": "#" }, true, false).text).toBe(
      "# # #",
    );
    expect(glossaryReplace("ÿ Ÿ", { "\u0178": "#" }, true, false).text).toBe("# #");
  });
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
      ...searchWork(8 * limit, () => glossaryReplace(text, mapping, true, false, limit)),
    }));
    for (const { limit, outcome, work } of counted) {
      expect(work).toBeLessThanOrEqual(4 * limit);
      expect((outcome as Error).message).toContain(`${GREW} ${limit} characters`);
    }
    const [small, large] = counted as [(typeof counted)[0], (typeof counted)[0]];
    expect(large.work / small.work).toBeLessThan(2.25);
  });

  test("a term that keeps nearly matching is searched in one read of the text", () => {
    // n spaces against m spaces and an "x": the regex tried the whole term
    // from every start, n × m steps (1.0 M at n = 10 K, m = 100, by the step
    // model). Counted here: every regex step, and every unit the search reads.
    const counted = [
      [10_000, 100],
      [20_000, 100],
      [10_000, 200],
    ].map(([n, m]) => {
      const text = " ".repeat(n as number);
      const term = `${" ".repeat(m as number)}x`;
      return {
        n: n as number,
        m: m as number,
        runs: [true, false].flatMap((wholeWord) =>
          [true, false].map((caseSensitive) =>
            searchWork(8 * ((n as number) + (m as number)), () =>
              glossaryReplace(text, { [term]: "v" }, wholeWord, caseSensitive),
            ),
          ),
        ),
      };
    });
    for (const { n, m, runs } of counted) {
      for (const { outcome, work } of runs) {
        expect({ n, m, outcome }).toEqual({
          n,
          m,
          outcome: { text: " ".repeat(n), replacements: {} },
        });
        expect(work).toBeLessThanOrEqual(8 * (n + m));
        expect(work).toBeGreaterThanOrEqual(n);
      }
    }
    const work = (i: number) => (counted[i] as (typeof counted)[number]).runs.map((r) => r.work);
    // Twice the text, about twice the work; twice the term, about the same.
    work(1).forEach((w, j) => expect(w / (work(0)[j] as number)).toBeLessThan(2.1));
    work(2).forEach((w, j) => expect(w / (work(0)[j] as number)).toBeLessThan(1.1));
  });

  test("a whole-word term found everywhere and turned down nearly everywhere is one read of the text", () => {
    // critic8: m "a"s over n "a"s is an occurrence at every place, and whole
    // words turn each one down, since an "a" touches it on one side or both:
    // all the work is in going on after a refusal. Starting again one unit
    // past the refused start, with nothing of it kept, is the n × m search
    // once more, and gives the same text, so only the count can tell. The
    // second text takes some: runs of exactly m between spaces are whole
    // words; one that meets a "-", or is longer, is not.
    const texts = (n: number, m: number): string[] => {
      const a = (k: number) => "a".repeat(k);
      const block = `${a(m)} ${a(m)}-${a(2 * m)} `;
      return [a(n), block.repeat(Math.ceil(n / block.length)).slice(0, n)];
    };
    const counted = [
      [10_000, 100],
      [20_000, 100],
      [10_000, 200],
    ].map(([n, m]) => {
      const term = "a".repeat(m as number);
      return {
        n: n as number,
        m: m as number,
        runs: texts(n as number, m as number).flatMap((text) =>
          [true, false].map((caseSensitive) => ({
            want: referenceGlossary(text, { [term]: "v" }, true, caseSensitive),
            ...searchWork(8 * ((n as number) + (m as number)), () =>
              glossaryReplace(text, { [term]: "v" }, true, caseSensitive),
            ),
          })),
        ),
      };
    });
    for (const { n, m, runs } of counted) {
      for (const [i, { want, outcome, work }] of runs.entries()) {
        expect({ n, m, i, outcome }).toEqual({ n, m, i, outcome: want });
        expect(work).toBeLessThanOrEqual(8 * (n + m));
        expect(work).toBeGreaterThanOrEqual(n);
      }
      // The second text has whole words to take, the first none.
      expect(runs.map((r) => r.want.replacements["a".repeat(m)] ?? 0).map((c) => c > 0)).toEqual([
        false,
        false,
        true,
        true,
      ]);
    }
    const work = (i: number) => (counted[i] as (typeof counted)[number]).runs.map((r) => r.work);
    // Twice the text, about twice the work.
    work(1).forEach((w, j) => expect(w / (work(0)[j] as number)).toBeLessThan(2.1));
  });

  test("thousands of terms over a long text: refused after a hundred passes' reading", () => {
    const limit = 2_000;
    const text = "z".repeat(limit);
    const mapping = Object.fromEntries(Array.from({ length: 3_000 }, (_, i) => [`k${i}`, "v"]));
    const { outcome, work } = searchWork(256 * limit, () =>
      glossaryReplace(text, mapping, true, false, limit),
    );
    expect((outcome as Error).message).toContain(READ);
    // A hundred passes, each reading every unit of the text once and
    // comparing it with the term's first unit, and the hundred terms read.
    expect(work).toBeLessThanOrEqual(2 * 101 * limit);
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
