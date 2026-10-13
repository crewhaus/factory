/**
 * The email detector is matched by a scan (email-scan.ts), not by its
 * pattern, which rescanned a run like `a-a-a-…` from every word boundary in
 * it. The scan must find exactly what `matchAll` finds, and detecting PII in
 * a text with such a run must not run the pattern over it.
 */
import { describe, expect, test } from "bun:test";
import { scanWork } from "./__test__/scan-work";
import { emailMatches } from "./email-scan";
import { DEFAULT_PII_DETECTORS, detectPii, piiMatches } from "./index";

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

const byPattern = (text: string): { index: number; value: string }[] =>
  [...text.matchAll(new RegExp(EMAIL.source, "g"))].map((m) => ({ index: m.index, value: m[0] }));

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
  let seed = 0xc2b2ae35;
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
 * pattern through it (the control below checks that for `String#matchAll`);
 * restored after.
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

describe("emailMatches", () => {
  test("finds what matchAll finds", () => {
    const pieces = ["a", "-", ".", "@", "1", "_", "%", "+", " ", "co", "b.co", "x.io-"];
    const differ: string[] = [];
    let matched = 0;
    const visit = (t: string): void => {
      const want = byPattern(t);
      if (want.length > 0) matched++;
      if (JSON.stringify(emailMatches(t)) !== JSON.stringify(want)) differ.push(t);
    };
    const checked = everyText(pieces, 4, visit);
    for (const t of randomTexts(pieces, 60_000, 16)) visit(t);
    for (const t of [
      "mail jane.doe+tag@example.co.uk now",
      "a@b.co.uk.x@y.com",
      "a@b.co.uk-x@y.com",
      ".abc@x.com",
      "x@y.c0m a@b.cd_e f@g.hi1",
      "first@one.org,second@two.net;third@three.io",
      "é@x.com xé@y.com",
    ]) {
      visit(t);
    }
    expect(differ).toEqual([]);
    expect(checked).toBe((12 ** 5 - 1) / 11);
    expect(matched).toBeGreaterThan(5_000);
  }, 30_000);

  test("detectPii and piiMatches report what the patterns alone report", () => {
    const regexOnly = DEFAULT_PII_DETECTORS.map((d) => ({ kind: d.kind, regex: d.regex }));
    for (const text of [
      "call 415-555-1234 or mail a.b@example.com, SSN 123-45-6789",
      "card 4111 1111 1111 1111, IBAN DE44500105175407324931",
      "no pii here",
      `${"a-".repeat(50)}@x.com`,
    ]) {
      expect(detectPii(text)).toEqual(detectPii(text, regexOnly));
      for (const [i, d] of DEFAULT_PII_DETECTORS.entries()) {
        expect(piiMatches(text, d)).toEqual(
          piiMatches(text, regexOnly[i] as (typeof regexOnly)[number]),
        );
      }
    }
  });
});

// Counted, not timed: the email pattern is refused if it runs over the run;
// the other detectors run as usual. The scan's own reads are counted below.
describe("a text with a long run of local-part characters", () => {
  test("is checked for PII without the email pattern over the run", () => {
    const run = "a-".repeat(5_000);
    // Control: the hook sees the pattern String#matchAll runs.
    expect(refusingOver(run, [EMAIL], () => byPattern(run)).ran).toEqual([`/${EMAIL.source}/`]);
    for (const tail of ["x", "@x", "@x.y", "@example.com"]) {
      const text = `${"a-".repeat(200_000)}${tail}`;
      const found = refusingOver(run, [EMAIL], () => detectPii(text));
      expect(found.ran).toEqual([]);
      expect(found.outcome).toEqual(
        tail === "@example.com" ? [{ kind: "email", value: text }] : [],
      );
    }
  }, 20_000);
});

// Counted, not timed: a scan can rescan a run with no pattern at all (a search
// that resumes one character on instead of after what it read), so the scan's
// own reads are counted (__test__/scan-work.ts) over runs shaped to make it
// rescan, and held to a few per character. A rescan reads the rest of the run
// from every place in it and stops at the bound at once.
describe("the email scan reads a long run a bounded number of times", () => {
  const N = 20_000;
  const PER_CHARACTER = 8;
  const fill = (unit: string): string => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  const cases: ReadonlyArray<readonly [string, (text: string) => unknown, string]> = [
    ["a run of a- with no @", emailMatches, fill("a-")],
    ["a run of a@", emailMatches, fill("a@")],
    ["addresses with no top-level domain", emailMatches, fill("a@a.a ")],
    ["one domain of a.1 with no top-level domain", emailMatches, `x@${fill("a.1")}`],
    ["a run of a- before an @ with no domain", emailMatches, `${fill("a-")}@x`],
    ["addresses one after another", emailMatches, fill("a.b@c.de ")],
  ];
  for (const [label, scan, text] of cases) {
    test(label, () => {
      const most = PER_CHARACTER * text.length;
      const { work } = scanWork(most, () => scan(text));
      expect(work).toBeLessThanOrEqual(most);
      // The count sees the run being read; a scan that read it some other
      // way would read as no work here.
      expect(work).toBeGreaterThanOrEqual(text.length);
    });
  }
});
