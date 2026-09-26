/**
 * The quadratic paths in this package do bounded work.
 *
 * Three entity patterns rescanned a long run from every position in it, and
 * edit distance and Jaro-Winkler compared inputs of any size, all
 * synchronously on the harness thread. The scans are now linear — proved
 * here by input sizes the 0.7.0 code took seconds on, with a wide margin —
 * and the matches are held to the plain patterns by a differential fuzz.
 * The comparisons are refused above a cell budget, before any work.
 */
import { describe, expect, test } from "bun:test";
import { fuzzyMatch, textDiff, textSimilarity } from "./index";
import { ENTITY_PATTERNS, extractEntities, matchesOf } from "./lib/entities";
import { MAX_SIMILARITY_CELLS, similarityCost } from "./lib/similarity";

// biome-ignore lint/suspicious/noExplicitAny: the executor supplies this context, and none of these tools read it.
const ctx = {} as any;
async function out(tool: typeof fuzzyMatch, input: unknown): Promise<string> {
  return String(await tool.execute(tool.inputSchema.parse(input), ctx));
}

/** A small deterministic PRNG, so a failing seed can be replayed. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every match the plain global pattern finds: the oracle. */
function plainMatches(text: string, kind: string): Array<[number, string]> {
  const source = ENTITY_PATTERNS[kind] as RegExp;
  const re = new RegExp(source.source, source.flags);
  const found: Array<[number, string]> = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    found.push([m.index, m[0]]);
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return found;
}

const scanned = (text: string, kind: string): Array<[number, string]> =>
  [...matchesOf(text, kind, ENTITY_PATTERNS[kind] as RegExp)].map((m) => [m.index, m[0]]);

describe("entity scans are linear", () => {
  test("a 100 K run that never completes a match is scanned once, not once per character", () => {
    // 0.7.0 took ~10 s on the email run alone; each is a few ms now.
    const runs: Array<[string, string]> = [
      ["email", "a".repeat(100_000)],
      ["money", "1,".repeat(50_000)],
      ["jwt", "-eyJ".repeat(25_000)],
      ["email", `${"=".repeat(50_000)}@`],
    ];
    const slow: Array<{ kind: string; ms: number }> = [];
    let checked = 0;
    for (const [kind, text] of runs) {
      const t0 = performance.now();
      expect({ kind, found: extractEntities(text, [kind], true) }).toEqual({ kind, found: {} });
      const ms = performance.now() - t0;
      if (ms >= 1_500) slow.push({ kind, ms });
      checked += 1;
    }
    expect(slow).toEqual([]);
    expect(checked).toBe(4);
  }, 60_000);

  test("the values found are the ones the plain patterns find", () => {
    const text =
      "mail bob.smith+x@example.co.uk; paid $1,200.50 and 3,000 USD; token-eyJhbGciOi.eyJzdWIi.sig_abc";
    expect(extractEntities(text, ["email", "money", "jwt"], true)).toEqual({
      email: [{ value: "bob.smith+x@example.co.uk", index: 5, line: 1 }],
      money: [
        { value: "$1,200.50", index: 37, line: 1 },
        { value: "3,000 USD", index: 51, line: 1 },
      ],
      jwt: [{ value: "eyJhbGciOi.eyJzdWIi.sig_abc", index: 68, line: 1 }],
    });
  });

  test("a match that ends mid-run is followed by the next one, as a global regex does", () => {
    // Where a lookbehind "start of run" rule would have lost the second hit.
    const cases: Array<[string, string]> = [
      ["email", "a@b.c_d@e.f"],
      ["email", "x@a.b!y@c.d"],
      ["money", "$1.5,3 USD"],
      ["money", "a1,5 USD"],
      ["jwt", "token-eyJa.b.c-eyJd.e.f"],
      ["jwt", "eyJa.b.c--x"],
    ];
    for (const [kind, text] of cases) {
      expect({ kind, text, got: scanned(text, kind) }).toEqual({
        kind,
        text,
        got: plainMatches(text, kind),
      });
    }
    expect(scanned("a@b.c_d@e.f", "email").map(([, v]) => v)).toEqual(["a@b.c", "_d@e.f"]);
  });

  test("random text: every match, at every offset, is the plain pattern's", () => {
    const pieces = [
      "a",
      "b",
      "Z",
      "_",
      "-",
      ".",
      "@",
      "1",
      "9",
      ",",
      "$",
      "€",
      " ",
      "\n",
      "!",
      "=",
      "+",
      "USD",
      " EUR",
      "eyJ",
      "e",
      "yJ",
      "x.y",
      "a@b",
      ".co",
      "-eyJ",
      "1,000",
      "0.5",
      "%",
      "eyJhb.x",
      ".z_",
      "-eyJ1.2.3",
    ];
    let compared = 0;
    const withMatches: Record<string, number> = { email: 0, money: 0, jwt: 0 };
    for (let seed = 1; seed <= 6_000; seed++) {
      const rand = prng(seed);
      let text = "";
      const n = 1 + Math.floor(rand() * 14);
      for (let i = 0; i < n; i++) text += pieces[Math.floor(rand() * pieces.length)];
      for (const kind of ["email", "money", "jwt"]) {
        const want = plainMatches(text, kind);
        expect({ seed, kind, text, got: scanned(text, kind) }).toEqual({
          seed,
          kind,
          text,
          got: want,
        });
        compared += 1;
        if (want.length > 0) withMatches[kind] = (withMatches[kind] ?? 0) + 1;
      }
    }
    expect(compared).toBe(18_000);
    // The fuzz has to exercise matches of every kind, not only empty answers.
    for (const kind of ["email", "money", "jwt"]) {
      expect({ kind, enough: (withMatches[kind] ?? 0) > 150 }).toEqual({ kind, enough: true });
    }
  }, 20_000);
});

describe("edit-distance comparisons are refused above the cell budget", () => {
  test("TextSimilarity refuses levenshtein and jaro past the budget, and still scores below it", async () => {
    const big = { a: "x".repeat(6_000), b: "y".repeat(6_000) };
    const fits = { a: "x".repeat(4_000), b: "y".repeat(4_000) };
    let checked = 0;
    for (const method of ["levenshtein", "jaro"]) {
      // 0.7.0 computed both, blocking the thread for the whole table.
      expect(await out(textSimilarity, { ...big, method })).toMatch(
        new RegExp(`^inputs too large for ${method} \\(6000 x 6000 characters\\)`),
      );
      expect(JSON.parse(await out(textSimilarity, { ...fits, method }))).toEqual({
        score: 0,
        method,
      });
      checked += 1;
    }
    expect(checked).toBe(2);
    // Trigram and token overlap are linear, so size alone never refuses them.
    const trigram = JSON.parse(
      await out(textSimilarity, {
        a: "x".repeat(200_000),
        b: "y".repeat(200_000),
        method: "trigram",
      }),
    );
    expect(trigram.method).toBe("trigram");
  }, 20_000);

  test("the cost model matches the budget's boundary", () => {
    expect(similarityCost("x".repeat(5_000), "y".repeat(5_000), "levenshtein")).toBe(
      MAX_SIMILARITY_CELLS,
    );
    expect(similarityCost("x".repeat(6_000), "y".repeat(6_000), "jaro")).toBe(6_000 * 5_999);
    expect(similarityCost("x".repeat(9_000), "y".repeat(9_000), "trigram")).toBe(0);
    expect(similarityCost("same", "same", "levenshtein")).toBe(0);
  });

  test("FuzzyMatch refuses a call whose comparisons add up past the budget, before comparing any", async () => {
    // 0.7.0: {"hits":[]} after about two seconds.
    const many = await out(fuzzyMatch, {
      query: "x".repeat(2_000),
      candidates: Array.from({ length: 100 }, () => "y".repeat(2_000)),
      method: "levenshtein",
    });
    expect(many).toMatch(/^candidates too large for levenshtein: 100 comparisons/);
    const one = await out(fuzzyMatch, {
      query: "x".repeat(6_000),
      candidates: ["short", "y".repeat(6_000)],
      method: "jaro",
    });
    expect(one).toMatch(/^candidates\[1\]: inputs too large for jaro/);
  }, 20_000);

  test("TextDiff's line table is held to the same shared budget, before any of it is built", async () => {
    // The ceiling TextDiff has had since 0.7.0, now the shared constant: one
    // line more than a 5,000 x 5,000 table is refused by name, and a diff
    // well inside it still runs.
    const lines = (prefix: string, n: number): string =>
      Array.from({ length: n }, (_, i) => `${prefix}${i}`).join("\n");
    expect((5_000 + 1) * (5_000 + 1)).toBeGreaterThan(MAX_SIMILARITY_CELLS);
    expect(await out(textDiff, { a: lines("a", 5_000), b: lines("b", 5_000) })).toBe(
      "inputs too large to diff (5000 x 5000 lines) — diff a narrower region",
    );
    const small = JSON.parse(
      await out(textDiff, { a: lines("a", 3), b: lines("a", 4), statsOnly: true }),
    );
    expect(small).toEqual({ added: 1, removed: 0, same: 3, identical: false });
  });

  test("a sanctions-list-sized call fits: ten thousand names against a name", async () => {
    const names = Array.from({ length: 10_000 }, (_, i) => `Company Holdings Number ${i} Limited`);
    const result = JSON.parse(
      await out(fuzzyMatch, { query: "Company Holdings Number 42 Limited", candidates: names }),
    );
    expect(result.hits[0].candidate).toBe("Company Holdings Number 42 Limited");
  }, 20_000);
});
