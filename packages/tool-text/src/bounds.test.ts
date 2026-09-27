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
import { MAX_SIMILARITY_WORK, jaroWinkler, levenshtein, similarityCost } from "./lib/similarity";

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

describe("edit-distance comparisons are refused above the work budget", () => {
  test("TextSimilarity refuses levenshtein and jaro past the budget, before any work", async () => {
    // Levenshtein is charged a cell per pair of characters, Jaro a quarter
    // cell per window step (its measured cost). Past 200 M the call is
    // refused by name; none of it is computed.
    expect(MAX_SIMILARITY_WORK).toBe(200_000_000);
    const lev = { a: "x".repeat(20_000), b: "y".repeat(10_001), method: "levenshtein" };
    expect(await out(textSimilarity, lev)).toMatch(
      /^inputs too large for levenshtein \(20000 x 10001 characters\)/,
    );
    const jaro = { a: "x".repeat(29_000), b: "y".repeat(29_000), method: "jaro" };
    expect(await out(textSimilarity, jaro)).toMatch(
      /^inputs too large for jaro \(29000 x 29000 characters\)/,
    );
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

  test("the sizes 0.7.0 answered in a fraction of a second are still answered", async () => {
    // 0.7.1's first cut reused TextDiff's 25 M-cell memory bound as a time
    // budget and refused these, which 0.7.0 answered in 10-180 ms.
    for (const method of ["levenshtein", "jaro"]) {
      const got = JSON.parse(
        await out(textSimilarity, { a: "x".repeat(6_000), b: "y".repeat(6_000), method }),
      );
      expect(got).toEqual({ score: 0, method });
    }
    const words = ["quick", "brown", "fox", "lazy", "dog", "data", "record", "field", "spec"];
    const rand = prng(7);
    const text = (n: number): string => {
      let s = "";
      while (s.length < n) s += `${words[Math.floor(rand() * words.length)]} `;
      return s.slice(0, n);
    };
    for (const [count, length] of [
      [3_000, 300],
      [300, 1_000],
    ] as const) {
      const candidates = Array.from({ length: count }, () => text(length));
      const got = JSON.parse(
        await out(fuzzyMatch, { query: candidates[count - 1], candidates, limit: 1 }),
      );
      expect({ count, length, top: got.hits[0]?.score }).toEqual({ count, length, top: 1 });
    }
  }, 30_000);

  test("the cost model matches the budget's boundary", () => {
    expect(similarityCost("x".repeat(20_000), "y".repeat(10_000), "levenshtein")).toBe(
      MAX_SIMILARITY_WORK,
    );
    // Jaro: 6,000 window steps per character, at a quarter cell each.
    expect(similarityCost("x".repeat(6_000), "y".repeat(6_000), "jaro")).toBe(
      Math.ceil((6_000 * 5_999) / 4),
    );
    expect(similarityCost("x".repeat(9_000), "y".repeat(9_000), "trigram")).toBe(0);
    expect(similarityCost("same", "same", "levenshtein")).toBe(0);
  });

  test("FuzzyMatch refuses a call whose comparisons add up past the budget, before comparing any", async () => {
    // Two single comparisons' worth: 101 levenshtein comparisons of 2,000 x
    // 2,000 are 404 M cells.
    const many = await out(fuzzyMatch, {
      query: "x".repeat(2_000),
      candidates: Array.from({ length: 101 }, () => "y".repeat(2_000)),
      method: "levenshtein",
    });
    expect(many).toMatch(/^candidates too large for levenshtein: 101 comparisons/);
    const one = await out(fuzzyMatch, {
      query: "x".repeat(29_000),
      candidates: ["short", "y".repeat(29_000)],
      method: "jaro",
    });
    expect(one).toMatch(/^candidates\[1\]: inputs too large for jaro/);
  }, 20_000);

  test("the faster Levenshtein and Jaro give 0.7.0's answers", () => {
    // 0.7.0's implementations, unchanged, as the oracle.
    const oldLevenshtein = (a: string, b: string): number => {
      if (a === b) return 0;
      if (a.length === 0) return b.length;
      if (b.length === 0) return a.length;
      let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
      for (let i = 1; i <= a.length; i++) {
        const cur = new Array<number>(b.length + 1);
        cur[0] = i;
        for (let j = 1; j <= b.length; j++) {
          const cost = a[i - 1] === b[j - 1] ? 0 : 1;
          cur[j] = Math.min(
            (cur[j - 1] as number) + 1,
            (prev[j] as number) + 1,
            (prev[j - 1] as number) + cost,
          );
        }
        prev = cur;
      }
      return prev[b.length] as number;
    };
    const oldJaroWinkler = (a: string, b: string): number => {
      if (a === b) return 1;
      if (a.length === 0 || b.length === 0) return 0;
      const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
      const aFlags = new Array<boolean>(a.length).fill(false);
      const bFlags = new Array<boolean>(b.length).fill(false);
      let matches = 0;
      for (let i = 0; i < a.length; i++) {
        const lo = Math.max(0, i - window);
        const hi = Math.min(b.length - 1, i + window);
        for (let j = lo; j <= hi; j++) {
          if (bFlags[j] === true || a[i] !== b[j]) continue;
          aFlags[i] = true;
          bFlags[j] = true;
          matches++;
          break;
        }
      }
      if (matches === 0) return 0;
      let transpositions = 0;
      let k = 0;
      for (let i = 0; i < a.length; i++) {
        if (aFlags[i] !== true) continue;
        while (bFlags[k] !== true) k++;
        if (a[i] !== b[k]) transpositions++;
        k++;
      }
      const t = transpositions / 2;
      const jaro = (matches / a.length + matches / b.length + (matches - t) / matches) / 3;
      let prefix = 0;
      while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
        prefix++;
      }
      return jaro + prefix * 0.1 * (1 - jaro);
    };
    const alphabet = ["a", "b", "c", "é", "\ud83d\ude00", " ", "A"];
    const rand = prng(11);
    const word = (): string => {
      let s = "";
      const n = Math.floor(rand() * 12);
      for (let i = 0; i < n; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
      return s;
    };
    let compared = 0;
    for (let i = 0; i < 3_000; i++) {
      const a = word();
      const b = rand() < 0.2 ? a : word();
      expect({ a, b, d: levenshtein(a, b) }).toEqual({ a, b, d: oldLevenshtein(a, b) });
      expect({ a, b, j: jaroWinkler(a, b) }).toEqual({ a, b, j: oldJaroWinkler(a, b) });
      compared += 1;
    }
    expect(compared).toBe(3_000);
  });

  test("TextDiff's line table keeps its 0.7.0 memory ceiling, before any of it is built", async () => {
    // TextDiff builds its whole LCS table, so its 25 M-cell ceiling is a
    // memory bound and stays where 0.7.0 had it: one line more than a
    // 5,000 x 5,000 table is refused by name, and a diff inside it runs.
    const lines = (prefix: string, n: number): string =>
      Array.from({ length: n }, (_, i) => `${prefix}${i}`).join("\n");
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
