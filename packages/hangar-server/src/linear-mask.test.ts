/**
 * linear-mask.ts replaces masking patterns that rescanned a run from every
 * position in it. Each helper must do exactly what its pattern did, and
 * masking a document with a long run must neither run those patterns over it
 * nor read it more than a few times by hand.
 */
import { describe, expect, test } from "bun:test";
import { scanWork } from "./__test__/scan-work";
import { maskRawText } from "./inspect";
import { hasLineBreak, replacePrivateKeyBlocks, replaceQueryPairs } from "./linear-mask";
import { maskKeyedText, maskText } from "./mask";

const QUERY_PAIR = /([?&;])([^=&;]*)=([^&;]*)/g;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const KEYED_SCALAR_LINE = /^([ \t]*(?:- )?)(["']?)([A-Za-z0-9_.-]+)\2:([ \t]*)(.*)$/;

/** Every concatenation of up to `depth` of `pieces`, `visit`ed; returns how many. */
function everyText(pieces: readonly string[], depth: number, visit: (t: string) => void): number {
  let count = 0;
  const walk = (text: string, d: number): void => {
    visit(text);
    count++;
    if (d === depth) return;
    for (const p of pieces) walk(text + p, d + 1);
  };
  walk("", 0);
  return count;
}

/** `n` seeded pseudo-random concatenations of 1 to `maxPieces` of `pieces`. */
function randomTexts(pieces: readonly string[], n: number, maxPieces: number): string[] {
  let seed = 0x1b873593;
  const next = (bound: number): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % bound;
  };
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let text = "";
    const length = 1 + next(maxPieces);
    for (let k = 0; k < length; k++) text += pieces[next(pieces.length)];
    out.push(text);
  }
  return out;
}

/**
 * Runs `body` with the patterns in `refused` refused on the spot and recorded
 * when they run over a text holding `run`; every other pattern runs. Replacing
 * `RegExp.prototype.exec` routes every String and RegExp method that runs a
 * pattern through it (the controls below check that for `String#replace` and
 * `String#match`); restored after.
 */
function refusingOver<T>(
  run: string,
  refused: readonly RegExp[],
  body: () => T,
): { ran: string[]; outcome: T | Error } {
  const ran: string[] = [];
  const sources = new Set(refused.map((re) => re.source));
  const realExec = RegExp.prototype.exec;
  RegExp.prototype.exec = function (this: RegExp, input: string) {
    if (typeof input === "string" && sources.has(this.source) && input.includes(run)) {
      ran.push(`/${this.source}/`);
      throw new Error(`/${this.source}/ ran over the run`);
    }
    return realExec.call(this, input);
  };
  try {
    return { ran, outcome: body() };
  } catch (err) {
    return { ran, outcome: err as Error };
  } finally {
    RegExp.prototype.exec = realExec;
  }
}

const tag = (whole: string, sep: string, name: string, value: string): string =>
  `<${whole}|${sep}|${name}|${value}>`;

describe("each helper does what its pattern did", () => {
  test("replaceQueryPairs", () => {
    const pieces = ["?", "&", ";", "=", "a", "b"];
    const differ: string[] = [];
    const visit = (t: string): void => {
      if (replaceQueryPairs(t, tag) !== t.replace(QUERY_PAIR, tag)) differ.push(t);
    };
    const checked = everyText(pieces, 6, visit);
    for (const t of randomTexts(pieces, 20_000, 24)) visit(t);
    for (const t of ["?apikey=abc&x=1", "?a=1;b=2#f", "??a=b", "?a&b=c", "?=", "?a=b=c&&d="])
      visit(t);
    expect(differ).toEqual([]);
    expect(checked).toBe((6 ** 7 - 1) / 5);
  }, 20_000);

  test("replacePrivateKeyBlocks", () => {
    const pieces = [
      "-----BEGIN ",
      "-----END ",
      "PRIVATE KEY",
      "-----",
      "RSA ",
      "x",
      "\n",
      "-",
      " ",
    ];
    const differ: string[] = [];
    const visit = (t: string): void => {
      if (replacePrivateKeyBlocks(t, "[R]") !== t.replace(PRIVATE_KEY_BLOCK, "[R]")) differ.push(t);
    };
    const checked = everyText(pieces, 5, visit);
    for (const t of randomTexts(pieces, 20_000, 16)) visit(t);
    const block = (kind: string): string =>
      `-----BEGIN ${kind}PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END ${kind}PRIVATE KEY-----`;
    for (const t of [
      block(""),
      block("RSA "),
      block("EC "),
      `before ${block("RSA ")} between ${block("")} after`,
      "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----",
      `${block("RSA ").slice(0, 40)} unterminated`,
      "-----BEGIN PRIVATE KEY----------END PRIVATE KEY-----",
      "-----BEGIN private key-----x-----END PRIVATE KEY-----",
    ]) {
      visit(t);
    }
    expect(differ).toEqual([]);
    expect(checked).toBe((9 ** 6 - 1) / 8);
  }, 20_000);

  test("a line with a break other than \\n never matches the keyed-line pattern", () => {
    const pieces = ["k", ":", " ", "\t", "- ", '"', "'", "\r", "\u2028", "\u2029", "x", "#"];
    const differ: string[] = [];
    const visit = (t: string): void => {
      const guarded = hasLineBreak(t) ? null : t.match(KEYED_SCALAR_LINE);
      if (JSON.stringify(guarded) !== JSON.stringify(t.match(KEYED_SCALAR_LINE))) differ.push(t);
    };
    const checked = everyText(pieces, 5, visit);
    for (const t of randomTexts(pieces, 20_000, 14)) visit(t);
    expect(differ).toEqual([]);
    expect(checked).toBe((12 ** 6 - 1) / 11);
  }, 20_000);
});

// Counted, not timed: each document below holds a run that one of the three
// patterns rescanned from every position in it. Those patterns are refused on
// the spot if they run over the run; the rest of the masker runs as usual.
// The helpers' own reads are counted further down.
describe("documents with a long run", () => {
  test("a URL whose query is a run of ? with no =", () => {
    const run = "?".repeat(10_000);
    // Control: the hook sees the pattern String#replace runs.
    expect(refusingOver(run, [QUERY_PAIR], () => run.replace(QUERY_PAIR, tag)).ran).toEqual([
      `/${QUERY_PAIR.source}/`,
    ]);
    const url = `https://x.example/p?${"?".repeat(200_000)}`;
    const masked = refusingOver(run, [QUERY_PAIR], () => maskText(`see ${url} now`));
    expect(masked.ran).toEqual([]);
    expect(masked.outcome).toBe(`see ${url} now`);
  }, 20_000);

  test("a document of private-key BEGIN lines with no END line", () => {
    const begin = "-----BEGIN RSA PRIVATE KEY-----\n";
    const run = begin.repeat(100);
    const doc = begin.repeat(3_000);
    const masked = refusingOver(run, [PRIVATE_KEY_BLOCK], () => maskRawText(doc));
    expect(masked.ran).toEqual([]);
    expect(masked.outcome).toBe(doc);
  }, 20_000);

  test("a line whose value follows a long run of spaces and holds a break other than \\n", () => {
    const run = " ".repeat(10_000);
    // Control: the hook sees the pattern String#match runs.
    expect(
      refusingOver(run, [KEYED_SCALAR_LINE], () => `k:${run}x\r`.match(KEYED_SCALAR_LINE)).ran,
    ).toEqual([`/${KEYED_SCALAR_LINE.source}/`]);
    // `.` matches none of CR, U+2028 and U+2029, so the pattern rescanned
    // the run before each of them; the guard has to know all three.
    const spaces = " ".repeat(200_000);
    const doc = [
      "name: demo\r",
      `note:${spaces}x\r`,
      `line:${spaces}x\u2028y`,
      `para:${spaces}x\u2029y`,
      "",
    ].join("\n");
    const masked = refusingOver(run, [KEYED_SCALAR_LINE], () => maskKeyedText(doc));
    expect(masked.ran).toEqual([]);
    expect(masked.outcome).toBe(doc);
  }, 20_000);
});

// Counted, not timed: a scan can rescan a run with no pattern at all (a
// search that resumes one character on, or one that keeps looking for an END
// line after a BEGIN line found none), so each helper's own reads are counted
// (__test__/scan-work.ts) over runs shaped to make it rescan, and held to a
// few per character. A rescan reads the rest of the run from every place in
// it and stops at the bound at once.
describe("each helper reads a long run a bounded number of times", () => {
  const N = 20_000;
  const PER_CHARACTER = 8;
  const fill = (unit: string): string => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  const same = (whole: string): string => whole;
  const cases: ReadonlyArray<readonly [string, (text: string) => unknown, string]> = [
    ["a query that is a run of ?", (t) => replaceQueryPairs(t, same), "?".repeat(N)],
    ["a query of names with no =", (t) => replaceQueryPairs(t, same), fill("?a")],
    ["a query of pairs", (t) => replaceQueryPairs(t, same), fill("?a=b&")],
    [
      "private-key BEGIN lines with no END line",
      (t) => replacePrivateKeyBlocks(t, "[k]"),
      fill("-----BEGIN RSA PRIVATE KEY-----\n"),
    ],
    [
      "BEGIN lines that are not a private key's",
      (t) => replacePrivateKeyBlocks(t, "[k]"),
      fill("-----BEGIN RSA KEY-----\n"),
    ],
    [
      "a BEGIN line and END lines that are not a private key's",
      (t) => replacePrivateKeyBlocks(t, "[k]"),
      `-----BEGIN RSA PRIVATE KEY-----\n${fill("-----END RSA KEY-----\n")}`,
    ],
    [
      "private-key blocks one after another",
      (t) => replacePrivateKeyBlocks(t, "[k]"),
      fill("-----BEGIN RSA PRIVATE KEY-----\nab\n-----END RSA PRIVATE KEY-----\n"),
    ],
    ["a line of spaces", hasLineBreak, " ".repeat(N)],
  ];
  for (const [label, helper, text] of cases) {
    test(label, () => {
      const most = PER_CHARACTER * text.length;
      const { work } = scanWork(most, () => helper(text));
      expect(work).toBeLessThanOrEqual(most);
      // The count sees the run being read; a helper that read it some other
      // way would read as no work here.
      expect(work).toBeGreaterThanOrEqual(text.length);
    });
  }
});
