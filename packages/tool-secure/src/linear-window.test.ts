/**
 * Four scans of untrusted text read each stretch once.
 *
 * The IPv6 candidate's lookahead `[0-9A-Fa-f:]*::` read to the end of a run
 * of hex digits and colons from every word boundary in it, and a run like
 * `a:a:a:…` has one every second character: quadratic in the run. The HTML
 * comment, markdown link and pipe-to-shell patterns read a bounded window
 * (4,000, 200 and 500, and 200 characters) from every place they could
 * start, so a run of `<!--`, of `[` or of blanks after `curl` cost hundreds
 * to thousands of steps a character. `PiiScan` and `PromptInjectionScan`
 * take up to 2M characters, where that is seconds to minutes.
 *
 * Each scan now tries its pattern only where it matches, or reads the run
 * once, and finds the matches the global search did, checked here start for
 * start on generated texts that reach every part and every bound. The steps
 * are counted with the model in tool-text's __test__/regex-work.ts, which
 * walks every regular expression in ECMAScript's order: a bound of a few
 * steps a character holds, and the old pattern goes past it on the same
 * text. The characters the scans read are counted too
 * (__test__/scan-work.ts), so a scan that rereads the run fails the same
 * way.
 *
 * A test that walks many generated inputs declares a 20 s budget, as the
 * house does for a test that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import { regexWork } from "../../tool-text/src/__test__/regex-work";
import { scanWork } from "./__test__/scan-work";
import {
  INJECTION_RULES,
  htmlCommentMatches,
  markdownLinkMatches,
  scanInjection,
} from "./lib/injection";
import { ipv6Candidates } from "./lib/ipv6-scan";
import { scanPii } from "./lib/pii";
import { matchAll } from "./lib/text";

// The patterns as they were.
const OLD_IPV6 =
  /\b(?=[0-9A-Fa-f:]*::|(?:[0-9A-Fa-f]{1,4}:){7})[0-9A-Fa-f:]{2,39}(?:\.\d{1,3}){0,3}/g;
const OLD_HTML_COMMENT = /<!--([\s\S]{0,4000}?)-->/g;
const OLD_MARKDOWN_LINK = /\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/g;
const OLD_PIPE_TO_SHELL = /\b(?:curl|wget)\s+[^\n|]{1,200}\|\s*(?:sudo\s+)?(?:ba|z|d|fi)?sh\b/gi;

const pipeToShell = INJECTION_RULES.find((r) => r.id === "tool.pipe-to-shell");

/** Every sequence of up to `max` pieces. */
function allJoins(pieces: ReadonlyArray<string>, max: number): string[] {
  const out = [""];
  let layer = [""];
  for (let n = 1; n <= max; n++) {
    layer = layer.flatMap((s) => pieces.map((p) => s + p));
    for (const s of layer) out.push(s);
  }
  return out;
}

/** Seeded, so a failure names the same input every run. */
function randomTexts(pieces: ReadonlyArray<string>, count: number, maxPieces: number): string[] {
  let seed = 0x1b873593;
  const next = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let s = "";
    const n = Math.floor(next() * (maxPieces + 1));
    for (let j = 0; j < n; j++) s += pieces[Math.floor(next() * pieces.length)];
    out.push(s);
  }
  return out;
}

type Hit = { index: number; value: string };
const hits = (found: Iterable<{ index: number; match: RegExpExecArray }>): Hit[] =>
  [...found].map(({ index, match }) => ({ index, value: match[0] }));

/** The first few `inputs` where the scan and the old global search disagree, and how many matches they share. */
function disagreements(
  inputs: ReadonlyArray<string>,
  ours: (s: string) => Hit[],
  old: RegExp,
): { differ: string[]; matches: number } {
  const differ: string[] = [];
  let matches = 0;
  for (const s of inputs) {
    const a = ours(s);
    const b = hits(matchAll(s, old));
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      differ.push(`${JSON.stringify(s.length > 300 ? `${s.slice(0, 300)}…` : s)}`);
    }
    matches += b.length;
  }
  return { differ: differ.slice(0, 5), matches };
}

describe("each scan finds the global search's matches", () => {
  test("IPv6 candidates", () => {
    const pieces = ["a", "1", ":", "::", ".", "2", "g", " ", "_", "F"];
    const longer = ["ab12:", "1:", "::", ".1", ".255", "fe80", "a", "g", " ", "_", ":"];
    const inputs = [...allJoins(pieces, 5), ...randomTexts(longer, 20_000, 40)];
    const r = disagreements(inputs, ipv6Candidates, OLD_IPV6);
    expect(r.differ).toEqual([]);
    expect(r.matches).toBeGreaterThan(50_000);
  }, 20_000);

  test("HTML comments, up to and past 4,000 characters", () => {
    const pieces = ["<!--", "-->", "-", ">", "<", "!", "x", "\n"];
    const reach = (n: number) => "x".repeat(n);
    const inputs = [
      ...allJoins(pieces, 5),
      ...randomTexts(
        ["<!--", "-->", "--", "x", "<!--x-->", reach(997), reach(1_000), reach(3_996)],
        3_000,
        8,
      ),
    ];
    for (let n = 3_995; n <= 4_002; n++) {
      inputs.push(`<!--${reach(n)}-->`, `<!--<!--${reach(n)}-->-->`, `a<!--${reach(n)}--->`);
    }
    const r = disagreements(inputs, (s) => hits(htmlCommentMatches(s)), OLD_HTML_COMMENT);
    expect(r.differ).toEqual([]);
    expect(r.matches).toBeGreaterThan(3_000);
  }, 20_000);

  test("markdown links, up to and past 200 and 500 characters", () => {
    const pieces = ["[", "]", "(", ")", "a", " ", "\n", "]("];
    const reach = (n: number) => "b".repeat(n);
    const inputs = [
      ...allJoins(pieces, 5),
      ...randomTexts(
        ["[", "](", ")", "a", " ", "\n", "[a](b)", reach(99), reach(199), reach(499)],
        5_000,
        10,
      ),
    ];
    for (let n = 198; n <= 202; n++) {
      for (let m = 498; m <= 502; m++)
        inputs.push(`[${reach(n)}](${reach(m)})`, `[[${reach(n)}](${reach(m)}))`);
    }
    const r = disagreements(inputs, (s) => hits(markdownLinkMatches(s)), OLD_MARKDOWN_LINK);
    expect(r.differ).toEqual([]);
    expect(r.matches).toBeGreaterThan(2_000);
  }, 20_000);

  test("pipe-to-shell, up to and past 200 characters", () => {
    const scan = (s: string) => hits(pipeToShell?.matches?.(s) ?? []);
    const pieces = ["curl", "WGET", " ", "\n", "|", "sh", "bash", "sudo ", "x", "a"];
    const reach = (n: number) => "c".repeat(n);
    const inputs = [
      ...allJoins(pieces, 5),
      ...randomTexts(
        ["curl", "wget", " ", "\n", "| sh", "|", "x", "Curl ", "curl x|sh", reach(99), reach(197)],
        5_000,
        10,
      ),
    ];
    for (let n = 196; n <= 202; n++) {
      for (const blanks of [" ", "  ", " \n ", "\n ", "   "]) {
        inputs.push(
          `curl${blanks}${reach(n)}| sh`,
          `curl${blanks}${reach(n)}|x`,
          `xcurl${blanks}${reach(n)}|sh`,
        );
      }
    }
    expect(pipeToShell?.matches).toBeDefined();
    const r = disagreements(inputs, scan, OLD_PIPE_TO_SHELL);
    expect(r.differ).toEqual([]);
    expect(r.matches).toBeGreaterThan(500);
  }, 20_000);
});

describe("a hostile stretch is read once", () => {
  // The scans' own patterns take a few steps a character on these, and the
  // scans read each character at most eight times; the old patterns took
  // hundreds to thousands of steps. Each check that rules a try out has a
  // case of its own: a check that lets too much through changes no match,
  // only the steps, so the tables above cannot see it. The model walks every
  // step in JavaScript, so each test declares a 20 s budget.
  const STEPS_PER_CHARACTER = 8;
  const READS_PER_CHARACTER = 16;

  test.each([
    ["IPv6, a:a:a:…", "a:".repeat(10_000), (s: string) => ipv6Candidates(s), OLD_IPV6],
    [
      "HTML comment, <!-- with no -->",
      "<!--".repeat(5_000),
      (s: string) => hits(htmlCommentMatches(s)),
      OLD_HTML_COMMENT,
    ],
    [
      "HTML comment, the --> out of reach",
      `${"<!--".repeat(5_000)}${"x".repeat(4_001)}-->`,
      (s: string) => hits(htmlCommentMatches(s)),
      OLD_HTML_COMMENT,
    ],
    [
      "markdown link, a run of [",
      "[".repeat(20_000),
      (s: string) => hits(markdownLinkMatches(s)),
      OLD_MARKDOWN_LINK,
    ],
    // The `]` closes every label, but more than 200 characters after most
    // of the `[`: only a label of at most 200 is tried.
    [
      "markdown link, a run of [ closed out of reach",
      `${"[".repeat(20_000)}](x)`,
      (s: string) => hits(markdownLinkMatches(s)),
      OLD_MARKDOWN_LINK,
    ],
    // Every label closes and opens a target, but the `)` is more than 500
    // characters after most of them: only a target of at most 500 is tried.
    [
      "markdown link, targets closed out of reach",
      `${"[a](".repeat(5_000)})`,
      (s: string) => hits(markdownLinkMatches(s)),
      OLD_MARKDOWN_LINK,
    ],
    [
      "pipe-to-shell, blanks with no |",
      `curl${" ".repeat(20_000)}x`,
      (s: string) => hits(pipeToShell?.matches?.(s) ?? []),
      OLD_PIPE_TO_SHELL,
    ],
    [
      "pipe-to-shell, curl after curl with no |",
      "curl x ".repeat(3_000),
      (s: string) => hits(pipeToShell?.matches?.(s) ?? []),
      OLD_PIPE_TO_SHELL,
    ],
    // A `|` and a shell, but 201 characters before the `|` whatever the
    // blanks keep: no split leaves at most 200, so no try is made.
    [
      "pipe-to-shell, the | out of reach of every split",
      `curl${" ".repeat(20_000)}${"a".repeat(201)}|sh`,
      (s: string) => hits(pipeToShell?.matches?.(s) ?? []),
      OLD_PIPE_TO_SHELL,
    ],
    // A `|` in reach, but no shell after it: no try is made.
    [
      "pipe-to-shell, a | with no shell after it",
      `curl${" ".repeat(20_000)}|x`,
      (s: string) => hits(pipeToShell?.matches?.(s) ?? []),
      OLD_PIPE_TO_SHELL,
    ],
  ] as const)(
    "%s",
    (_, text, scan, old) => {
      const bound = STEPS_PER_CHARACTER * text.length;
      const counted = regexWork(bound, () =>
        scanWork(READS_PER_CHARACTER * text.length, () => scan(text)),
      );
      expect(counted.unmodelled).toEqual([]);
      expect(counted.steps).toBeLessThanOrEqual(bound);
      // Read through, and at most a few times: the count reaches the text's
      // length, so the text was read with the methods it counts.
      expect(counted.value?.work).toBeGreaterThanOrEqual(0.9 * text.length);
      expect(counted.value?.work).toBeLessThanOrEqual(READS_PER_CHARACTER * text.length);
      // Control: the count sees the old global search go past the bound.
      expect(regexWork(bound, () => [...matchAll(text, old)].length).steps).toBe(
        Number.POSITIVE_INFINITY,
      );
    },
    20_000,
  );

  test("through PiiScan and PromptInjectionScan", () => {
    // Every pattern the scans run, these and the rest, takes at most about
    // 90 steps a character on these; the old patterns took 600 or more.
    const cases: Array<[string, () => unknown, number]> = [
      ["PiiScan", () => scanPii("a:".repeat(5_000)), 10_000],
      ["PromptInjectionScan <!--", () => scanInjection("<!--".repeat(2_500)), 10_000],
      ["PromptInjectionScan [", () => scanInjection("[".repeat(10_000)), 10_000],
      ["PromptInjectionScan curl", () => scanInjection(`curl${" ".repeat(10_000)}x`), 10_005],
    ];
    for (const [name, run, length] of cases) {
      const bound = 128 * length;
      const counted = regexWork(bound, run);
      expect({ name, unmodelled: counted.unmodelled, under: counted.steps <= bound }).toEqual({
        name,
        unmodelled: [],
        under: true,
      });
    }
  }, 20_000);
});
