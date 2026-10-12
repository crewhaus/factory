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
 * The work is counted with __test__/js-work.ts, which charges every element
 * an array iterator hands out (the source scans walk the tokens with one),
 * or by a Proxy over the token array that counts every element read. Never
 * timed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsWorkAsync } from "./__test__/js-work";
import { factCrossCheck } from "./index";
import { type SourceIndex, findSequence, indexSource } from "./lib/spans";

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

describe("a claim's words are located once per source", () => {
  test("one sentence citing one source under thousands of markers", async () => {
    for (const m of [1_000, 2_000]) {
      const markers = Array.from({ length: m }, (_, i) => `[m${i}]`).join(" ");
      const defs = Array.from({ length: m }, (_, i) => `[m${i}]: src/a.md`).join("\n");
      const text = `Revenue rose sharply in the second quarter ${markers}.\n\n${defs}\n`;
      const size = text.length + SOURCE_CHARS;
      const run = await jsWorkAsync(WORK_PER_CHARACTER * size, async () => check({ text }));
      expect(run.work).toBeLessThanOrEqual(WORK_PER_CHARACTER * size);
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
      const run = await jsWorkAsync(WORK_PER_CHARACTER * size, async () => check({ text }));
      expect(run.work).toBeLessThanOrEqual(WORK_PER_CHARACTER * size);
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
