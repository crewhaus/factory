/**
 * FactCrossCheck reads a cited source once per claim, not once per cite.
 *
 * A claim's words were located afresh for every cite, so a sentence citing
 * one source under many markers — or under many spellings of its path —
 * read the whole source once per marker, and a sentence repeating one
 * quotation read it once per repetition. The document is up to 16 MiB of
 * whatever the model or the workspace wrote, and a source up to 8 MiB. Now a
 * claim's words are located once per source it cites and reported under
 * every label that cited it; a quotation already checked is not checked
 * again; and once one quotation is not in the source at all the rest are
 * not read, since nothing can outrank that answer.
 *
 * Two more bounds come with it. Finding a quotation restarted at every token
 * matching its first word, so a source of one repeated word was read once
 * per word of the quote (up to three hundred times); it is a
 * Knuth–Morris–Pratt search now. And each different quotation is looked for
 * in every source the claim cites, so a claim may quote at most 16 different
 * spans: one quoting more is reported `unchecked`, with the reason, not
 * checked in part.
 *
 * That bounds a claim, not a call: 200 claims each quoting 16 near misses
 * of one source read it 6 400 times. So what a span, or a claim's words,
 * found in a source is kept for the whole call, and a call reads at most a
 * fixed number of source words: a claim that could pass what is left is
 * reported `unchecked`, with the reason, before any of it is read. An
 * excerpt is read only as far as it is cut, so a source of a few words far
 * apart no longer costs every claim the whole source.
 *
 * The work is counted with __test__/js-work.ts, which charges every element
 * an array iterator hands out (the source scans walk the tokens with one),
 * by a Proxy over the token array that counts every element read, and by
 * lib/spans' own `scanMeter`, one per token a pass over a source reads.
 * Never timed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsWorkAsync } from "./__test__/js-work";
import { _setFactCheckReadBudgetForTest, factCrossCheck } from "./index";
import { type SourceIndex, findSequence, indexSource, scanMeter, spanExcerpt } from "./lib/spans";

const originalCwd = process.cwd();
let workspace: string;

// biome-ignore lint/suspicious/noExplicitAny: the tool reads no context.
const ctx = {} as any;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "crewhaus-verify-crosscheck-"));
  process.chdir(workspace);
  mkdirSync("src");
  // A source of 20 000 tokens holding the claim's words once, at its end.
  const filler = Array.from({ length: 20_000 }, (_, i) => `w${i % 997}`).join(" ");
  writeFileSync("src/a.md", `${filler}\nRevenue rose sharply in the second quarter.\n`);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

type Finding = { source: string; status: string; reason: string };
type Claim = { verdict: string; reason: string; sources: Finding[] };
type Report = { claims: Claim[] };

async function check(input: unknown): Promise<Report> {
  return JSON.parse(
    (await factCrossCheck.execute(factCrossCheck.inputSchema.parse(input), ctx)) as string,
  ) as Report;
}

/** Elements iterated and characters read per character of document and source; about 3 here. */
const WORK_PER_CHARACTER = 8;
const SOURCE_CHARS = 20_000 * 5;
/** The tokens of src/a.md: the filler and the sentence. */
const SOURCE_TOKENS = 20_000 + 7;

describe("a claim's words are located once per source", () => {
  test("one sentence citing one source under thousands of markers", async () => {
    for (const m of [1_000, 2_000]) {
      const markers = Array.from({ length: m }, (_, i) => `[m${i}]`).join(" ");
      const defs = Array.from({ length: m }, (_, i) => `[m${i}]: src/a.md`).join("\n");
      const text = `Revenue rose sharply in the second quarter ${markers}.\n\n${defs}\n`;
      const size = text.length + SOURCE_CHARS;
      const before = scanMeter.tokens;
      const run = await jsWorkAsync(WORK_PER_CHARACTER * size, async () => check({ text }));
      expect(run.work).toBeLessThanOrEqual(WORK_PER_CHARACTER * size);
      // One pass over the source, however many markers name it.
      expect(scanMeter.tokens - before).toBe(SOURCE_TOKENS);
      const claim = run.value?.claims[0] as Claim;
      expect(claim.verdict).toBe("supported");
      expect(claim.sources).toHaveLength(m);
    }
  }, 20_000);

  // The same, through a channel the base code's hand-indexed scan also
  // shows: a span's excerpt is cut from the source before it is clipped, so
  // a claim whose words lie far apart is charged the whole span each time it
  // is located.
  test("thousands of markers to one source whose matching span is wide", async () => {
    const wide = Array.from({ length: 1_900 }, (_, i) => `${"x".repeat(38)}${i % 10}`).join(" ");
    writeFileSync("src/wide.md", `Revenue ${wide} quarter\n`);
    const m = 1_000;
    const markers = Array.from({ length: m }, (_, i) => `[m${i}]`).join(" ");
    const defs = Array.from({ length: m }, (_, i) => `[m${i}]: src/wide.md`).join("\n");
    const text = `Revenue quarter ${markers}.\n\n${defs}\n`;
    const size = text.length + wide.length;
    const run = await jsWorkAsync(WORK_PER_CHARACTER * size, async () =>
      check({ text, windowTokens: 2_000 }),
    );
    expect(run.work).toBeLessThanOrEqual(WORK_PER_CHARACTER * size);
    const claim = run.value?.claims[0] as Claim;
    expect(claim.verdict).toBe("supported");
    expect(claim.sources).toHaveLength(m);
  }, 20_000);

  test("one sentence repeating one quotation thousands of times", async () => {
    for (const q of [1_000, 2_000]) {
      const quote = `"rose sharply in the second"`;
      const text = `Revenue ${Array.from({ length: q }, () => quote).join(" ")} [1].\n\n[1]: src/a.md\n`;
      const size = text.length + SOURCE_CHARS;
      const before = scanMeter.tokens;
      const run = await jsWorkAsync(WORK_PER_CHARACTER * size, async () => check({ text }));
      expect(run.work).toBeLessThanOrEqual(WORK_PER_CHARACTER * size);
      // One search of the source, however often the quotation is repeated.
      expect(scanMeter.tokens - before).toBeLessThanOrEqual(SOURCE_TOKENS);
      expect(scanMeter.tokens - before).toBeGreaterThan(0);
      expect(run.value?.claims[0]?.verdict).toBe("supported");
    }
  }, 20_000);

  test("each cite reports what citing that spelling alone reports", async () => {
    symlinkSync("a.md", "src/link.md");
    const spellings = ["src/a.md", "./src/a.md", "src/../src/a.md", "src/link.md"];
    const claims = [
      "Revenue rose sharply in the second quarter.",
      "Revenue never rose in the second quarter.",
      'The report says "rose sharply in the second" and "fell sharply in the second".',
      'It says "w1 w2 w3 w4" then "w5 w6 zebra w8" and "w1 w2 w3 w4".',
      "Nothing here is in the source at all, quokka.",
    ];
    for (const text of claims) {
      const together = (await check({ claims: [{ text, sources: spellings }] })).claims[0] as Claim;
      const alone = await Promise.all(
        spellings.map(
          async (source) =>
            ((await check({ claims: [{ text, sources: [source] }] })).claims[0] as Claim)
              .sources[0],
        ),
      );
      expect(together.sources).toEqual(alone as Finding[]);
    }
  }, 20_000);

  test("several quotations report what checking each alone and keeping the worst reports", async () => {
    const quotes = [
      "rose sharply in the second", // found
      "w1 w2 w3 zebra", // nearly: a misquote
      "quokka wombat numbat bilby", // absent
      "w5 w6 w7 w8", // found
      "w9 w10 zebra w12", // nearly
    ];
    const rank: Record<string, number> = { supported: 0, misquoted: 1, notFound: 5 };
    for (const order of [
      [0, 1, 2, 3, 4],
      [1, 4, 2, 0, 3],
      [3, 0, 4, 1],
      [2, 1, 2, 4],
      [0, 3, 0],
    ]) {
      const text = `It says ${order.map((i) => `"${quotes[i]}"`).join(" and ")}.`;
      const together = (await check({ claims: [{ text, sources: ["src/a.md"] }] })).claims[0];
      const alone: Finding[] = [];
      for (const i of order) {
        const one = (
          await check({ claims: [{ text: `It says "${quotes[i]}".`, sources: ["src/a.md"] }] })
        ).claims[0] as Claim;
        alone.push(one.sources[0] as Finding);
      }
      // The first quotation of the highest rank decides; all found is the first's span.
      let expected = alone[0] as Finding;
      for (const finding of alone) {
        if ((rank[finding.status] as number) > (rank[expected.status] as number)) {
          expected = finding;
        }
      }
      expect(together?.sources[0]).toEqual(expected);
    }
  }, 20_000);
});

describe("a claim quotes at most 16 different spans", () => {
  const near = (i: number) => `"w${i} w${i + 1} w${i + 2} zebra"`;

  test("sixteen are checked, seventeen are reported unchecked with the reason", async () => {
    const at = (k: number) =>
      `Claim ${Array.from({ length: k }, (_, i) => near(i)).join(" ")} [1].\n\n[1]: src/a.md\n`;
    const sixteen = (await check({ text: at(16) })).claims[0] as Claim;
    expect(sixteen.verdict).toBe("misquoted");
    expect(sixteen.sources).toHaveLength(1);
    const seventeen = (await check({ text: at(17) })).claims[0] as Claim;
    expect(seventeen.verdict).toBe("unchecked");
    expect(seventeen.reason).toBe(
      "the claim quotes 17 different spans; at most 16 are checked in one claim, so split it into claims that quote fewer",
    );
    expect(seventeen.sources).toEqual([]);
  });

  test("a span quoted again does not count twice", async () => {
    const text = `Claim ${Array.from({ length: 40 }, () => near(0)).join(" ")} [1].\n\n[1]: src/a.md\n`;
    expect((await check({ text })).claims[0]?.verdict).toBe("misquoted");
  });

  test("once one quotation is not in the source, the rest are not read", async () => {
    // Looking for the absent one, and for the span nearest it: two passes,
    // where reading on read the source twice more for every span after it.
    const spans = Array.from({ length: 15 }, (_, i) => near(i)).join(" ");
    const text = `Claim "quokka wombat numbat bilby" ${spans} [1].\n\n[1]: src/a.md\n`;
    const before = scanMeter.tokens;
    const claim = (await check({ text })).claims[0] as Claim;
    expect(claim.verdict).toBe("notFound");
    expect(scanMeter.tokens - before).toBe(2 * SOURCE_TOKENS);
  });
});

describe("a call reads at most a fixed number of source words", () => {
  const near = (i: number) => `"w${i} w${i + 1} w${i + 2} zebra"`;
  /** Claims each quoting 16 near misses, none quoted by another claim. */
  const distinctClaims = (count: number) =>
    Array.from({ length: count }, (_, c) => ({
      text: `It says ${Array.from({ length: 16 }, (_, q) => near((c * 16 + q) * 3)).join(" and ")}.`,
      sources: ["src/a.md"],
    }));
  /** What one such claim may read: two passes per span. */
  const perClaim = 32 * SOURCE_TOKENS;

  async function budgeted(
    words: number,
    input: unknown,
  ): Promise<{ report: Report; read: number }> {
    const undo = _setFactCheckReadBudgetForTest(words);
    try {
      const before = scanMeter.tokens;
      const report = await check(input);
      return { report, read: scanMeter.tokens - before };
    } finally {
      undo();
    }
  }

  test("claims past the budget are reported unchecked with the reason, and nothing more is read", async () => {
    const budget = 5 * perClaim + perClaim / 2;
    for (const count of [10, 40]) {
      const { report, read } = await budgeted(budget, { claims: distinctClaims(count) });
      // The same five claims checked, and the same reading, however many follow.
      expect(read).toBe(5 * perClaim);
      expect(report.claims.map((c) => c.verdict)).toEqual([
        ...Array.from({ length: 5 }, () => "misquoted"),
        ...Array.from({ length: count - 5 }, () => "unchecked"),
      ]);
      expect(report.claims[5]?.reason).toBe(
        `checking it could read ${perClaim} more words of its sources, and this call has read ${5 * perClaim} of the ${budget} one call may; check it in a separate call`,
      );
      expect(report.claims[5]?.sources).toEqual([]);
    }
  }, 20_000);

  test("a claim that could read more than a whole call may says so", async () => {
    const { report, read } = await budgeted(perClaim - 1, { claims: distinctClaims(1) });
    expect(read).toBe(0);
    expect(report.claims[0]?.verdict).toBe("unchecked");
    expect(report.claims[0]?.reason).toBe(
      `checking it could read ${perClaim} words of its sources, more than the ${perClaim - 1} one call may read; cite smaller sources, or quote fewer spans`,
    );
  });

  test("a quotation located once is not read again by a later claim", async () => {
    // Every claim quotes the same 16 spans: the source is read for the
    // first and answered from what it found for the other 199, so a budget
    // of one claim's reading checks all 200.
    const same = Array.from({ length: 200 }, () => distinctClaims(1)[0] as { text: string });
    const claims = same.map(({ text }) => ({ text, sources: ["src/a.md"] }));
    const { report, read } = await budgeted(perClaim, { claims });
    expect(read).toBe(perClaim);
    expect(new Set(report.claims.map((c) => c.verdict))).toEqual(new Set(["misquoted"]));
    expect(new Set(report.claims.map((c) => JSON.stringify(c.sources)))).toHaveProperty("size", 1);
    // Paraphrases too: the same words located once.
    const words = Array.from({ length: 200 }, () => ({
      text: "Revenue rose sharply in the second quarter.",
      sources: ["src/a.md", "./src/a.md"],
    }));
    const paraphrased = await budgeted(SOURCE_TOKENS, { claims: words });
    expect(paraphrased.read).toBe(SOURCE_TOKENS);
    expect(new Set(paraphrased.report.claims.map((c) => c.verdict))).toEqual(
      new Set(["supported"]),
    );
  }, 20_000);
});

describe("findSequence reads a source once", () => {
  const reads = { count: 0 };
  /** The index, with every element read from its token array counted. */
  const counted = (index: SourceIndex): SourceIndex => ({
    ...index,
    tokens: new Proxy(index.tokens as SourceIndex["tokens"] & object, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads.count += 1;
        return Reflect.get(target, key, receiver);
      },
    }),
  });

  test("a source of one repeated word, and a quote of that word ending in another", () => {
    for (const t of [10_000, 20_000]) {
      const index = counted(indexSource(Array.from({ length: t }, () => "a").join(" ")));
      reads.count = 0;
      const quote = [...Array.from({ length: 299 }, () => "a"), "b"];
      expect(findSequence(index, quote)).toBe(-1);
      // Each token read once, where restarting at every "a" read each 300 times.
      expect(reads.count).toBeLessThanOrEqual(2 * t);
      reads.count = 0;
      expect(
        findSequence(
          index,
          Array.from({ length: 299 }, () => "a"),
        ),
      ).toBe(0);
    }
  });

  test("the first place a sequence appears, on generated sources", () => {
    const state = { seed: 0x5e9f0001 };
    const next = () => {
      state.seed = (state.seed + 0x6d2b79f5) | 0;
      let t = Math.imul(state.seed ^ (state.seed >>> 15), 1 | state.seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const words = ["a", "b", "ab", "c"];
    const differ: string[] = [];
    let found = 0;
    for (let round = 0; round < 20_000; round++) {
      const source = Array.from(
        { length: Math.floor(next() * 30) },
        () => words[Math.floor(next() * words.length)],
      ).join(" ");
      const index = indexSource(source);
      const sequence = Array.from(
        { length: Math.floor(next() * 6) },
        () => words[Math.floor(next() * words.length)] as string,
      );
      // The first i where every word of the sequence follows, read directly.
      let expected = -1;
      const norms = index.tokens.map((token) => token.norm);
      for (let i = 0; sequence.length > 0 && i + sequence.length <= norms.length; i++) {
        if (sequence.every((word, j) => norms[i + j] === word)) {
          expected = i;
          break;
        }
      }
      if (expected !== -1) found++;
      if (findSequence(index, sequence) !== expected) differ.push(`${source} | ${sequence}`);
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(found).toBeGreaterThan(5_000);
  }, 20_000);
});

describe("an excerpt reads only as far as it is cut", () => {
  /** What the fold reads as one word, and how far a word is widened. */
  const WORD_RUN = /[\p{L}\p{N}\p{M}\p{Default_Ignorable_Code_Point}]+/gu;
  const IGNORABLE = /\p{Default_Ignorable_Code_Point}$/u;
  const REACH = 64;
  /**
   * The excerpt as it was made: the whole range cut out of the text as
   * written, collapsed, then clipped — where the fold changed the text, the
   * range widened to the whole word where it starts or ends inside one the
   * fold rearranged (its ignorables moved to its end), and cut from the
   * folded text when that word is longer than the reach (`writtenSpan`).
   */
  const cutWhole = (index: SourceIndex, from: number, to: number, maxChars: number): string => {
    const tokens = index.tokens;
    if (from < 0 || tokens.length === 0) return "";
    const first = tokens[Math.min(from, tokens.length - 1)] as SourceIndex["tokens"][number];
    const last = tokens[
      Math.min(Math.max(to, from), tokens.length - 1)
    ] as SourceIndex["tokens"][number];
    const words = [...index.text.matchAll(WORD_RUN)].map(
      (m) => [m.index as number, (m.index as number) + m[0].length] as const,
    );
    const inside = (at: number) => words.find(([a, b]) => a < at && at < b);
    const moved = (word: readonly [number, number]): boolean =>
      IGNORABLE.test(index.text.slice(0, word[1]));
    let source = index.written ?? index.text;
    let start = first.at;
    let end = last.at + last.raw.length;
    const head = index.written === undefined ? undefined : inside(start);
    const tail = index.written === undefined ? undefined : inside(end);
    if (
      (head !== undefined &&
        (head[1] - start > REACH || (moved(head) && start - head[0] > REACH))) ||
      (tail !== undefined && tail[1] - end > REACH)
    ) {
      source = index.text;
    } else {
      if (head !== undefined && moved(head)) start = head[0];
      if (tail !== undefined && moved(tail)) end = tail[1];
    }
    const text = source.slice(start, end).replace(/\s+/g, " ").trim();
    return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
  };

  test("the same text as cutting the whole range out, on generated sources", () => {
    const state = { seed: 0x5e9f0002 };
    const next = () => {
      state.seed = (state.seed + 0x6d2b79f5) | 0;
      let t = Math.imul(state.seed ^ (state.seed >>> 15), 1 | state.seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
    // Every code unit \s matches, and some it does not.
    const spaces = [
      ..."\t\n\v\f\r \u00a0\u1680\u2000\u2005\u200a\u2028\u2029\u202f\u205f\u3000\ufeff",
    ];
    const others = ["!", "-", "\u200b", "\u180e", "\u0085", "\ud83d\ude00", "“", "’"];
    const words = ["a", "bb", "w1", "4.5%", "1,200", "don't", "é", "x"];
    const differ: string[] = [];
    let cut = 0;
    for (let round = 0; round < 20_000; round++) {
      let text = "";
      for (let i = Math.floor(next() * 12); i > 0; i--) {
        text += pick(words);
        for (let j = Math.floor(next() * 4); j > 0; j--) {
          text += next() < 0.6 ? pick(spaces).repeat(1 + Math.floor(next() * 3)) : pick(others);
        }
      }
      const index = indexSource(text);
      const n = index.tokens.length;
      const from = Math.floor(next() * (n + 2)) - 1;
      const to = Math.floor(next() * (n + 2)) - 1;
      const maxChars = pick([0, -1, 1, 2, 3, 5, 8, 13, 240]);
      const expected = cutWhole(index, from, to, maxChars);
      if (expected.endsWith("…")) cut++;
      if (spanExcerpt(index, from, to, maxChars) !== expected) {
        differ.push(JSON.stringify({ text, from, to, maxChars }));
      }
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(cut).toBeGreaterThan(3_000);
  }, 20_000);

  test("every code unit between two words, collapsed as \\s collapses it", () => {
    const differ: number[] = [];
    for (let code = 0; code <= 0xffff; code++) {
      const index = indexSource(`ab${String.fromCharCode(code, code)}cd`);
      const last = index.tokens.length - 1;
      if (spanExcerpt(index, 0, last, 240) !== cutWhole(index, 0, last, 240)) differ.push(code);
    }
    expect(differ).toEqual([]);
  }, 20_000);

  test("claims over a source of a few words far apart, at n and 2n of distance", async () => {
    // The 64 words are a long run of punctuation or of spaces apart, and
    // every claim's nearest span covers all of them: cutting it out first
    // read the whole source once per claim.
    const measured = [];
    for (const gap of [16_000, 32_000]) {
      const words = Array.from({ length: 64 }, (_, i) => `w${i}`);
      const source = words
        .map((word, i) => `${word}${(i % 2 === 0 ? "!" : " ").repeat(gap)}`)
        .join("");
      writeFileSync("src/far.md", source);
      const claims = Array.from({ length: 50 }, (_, c) => ({
        text: `w0 w63 x${c}y`,
        sources: ["src/far.md"],
      }));
      const limit = WORK_PER_CHARACTER * (source.length + 50 * 1_000);
      const run = await jsWorkAsync(limit, async () => check({ claims, windowTokens: 2_000 }));
      measured.push({ gap, run, limit });
    }
    for (const { run, limit } of measured) {
      expect(run.work).toBeLessThanOrEqual(limit);
      expect(run.value?.claims.map((c) => c.verdict)).toEqual(
        Array.from({ length: 50 }, () => "notFound"),
      );
    }
    const [near, far] = measured as [(typeof measured)[0], (typeof measured)[0]];
    // Twice the source, about twice the work: reading it, not once a claim.
    expect(far.run.work / near.run.work).toBeLessThan(2.4);
  }, 20_000);
});
