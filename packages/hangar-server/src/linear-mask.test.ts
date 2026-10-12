/**
 * linear-mask.ts replaces masking patterns that rescanned a run from every
 * position in it. Each helper must do exactly what its pattern did, and
 * masking a document with a long run must not run those patterns over it.
 */
import { describe, expect, test } from "bun:test";
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
    const pieces = ["k", ":", " ", "\t", "- ", '"', "'", "\r", "\u2028", "x", "#"];
    const differ: string[] = [];
    const visit = (t: string): void => {
      const guarded = hasLineBreak(t) ? null : t.match(KEYED_SCALAR_LINE);
      if (JSON.stringify(guarded) !== JSON.stringify(t.match(KEYED_SCALAR_LINE))) differ.push(t);
    };
    const checked = everyText(pieces, 5, visit);
    for (const t of randomTexts(pieces, 20_000, 14)) visit(t);
    expect(differ).toEqual([]);
    expect(checked).toBe((11 ** 6 - 1) / 10);
  }, 20_000);
});

// Counted, not timed: each document below holds a run that one of the three
// patterns rescanned from every position in it. Those patterns are refused on
// the spot if they run over the run; the rest of the masker runs as usual,
// and reads the run in linear time.
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

  test("a CRLF line whose value follows a long run of spaces", () => {
    const run = " ".repeat(10_000);
    // Control: the hook sees the pattern String#match runs.
    expect(
      refusingOver(run, [KEYED_SCALAR_LINE], () => `k:${run}x\r`.match(KEYED_SCALAR_LINE)).ran,
    ).toEqual([`/${KEYED_SCALAR_LINE.source}/`]);
    const doc = `name: demo\r\nnote:${" ".repeat(200_000)}x\r\n`;
    const masked = refusingOver(run, [KEYED_SCALAR_LINE], () => maskKeyedText(doc));
    expect(masked.ran).toEqual([]);
    expect(masked.outcome).toBe(doc);
  }, 20_000);
});
