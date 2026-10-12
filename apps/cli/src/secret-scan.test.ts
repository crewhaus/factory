/**
 * secret-scan.ts matches the JWT and PEM candidate-secret patterns with
 * scans, and redact-in-turn.ts redacts with each detector's scan where it has
 * one; their patterns rescanned a run from every place they could start. Each
 * must find exactly what its pattern found, and redacting a text with such a
 * run must not run those patterns over it.
 */
import { describe, expect, test } from "bun:test";
import { SYNTHESIZE_PII_DETECTORS } from "@crewhaus/dataset-ops/dataset-mine";
import { scanWork } from "./__test__/scan-work";
import { redactInTurn } from "./redact-in-turn";
import { jwtMatches, pemMatches } from "./secret-scan";
import { redactSnippet } from "./security-corpus";

const JWT = /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const PEM =
  /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

const byPattern = (pattern: RegExp, text: string): { index: number; value: string }[] =>
  [...text.matchAll(new RegExp(pattern.source, "g"))].map((m) => ({ index: m.index, value: m[0] }));

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
  let seed = 0x27d4eb2f;
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

function agreement(
  pattern: RegExp,
  scan: (text: string) => { index: number; value: string }[],
  pieces: readonly string[],
  depth: number,
  random: number,
): { differ: string[]; matched: number } {
  const differ: string[] = [];
  let matched = 0;
  const visit = (t: string): void => {
    const want = byPattern(pattern, t);
    if (want.length > 0) matched++;
    if (JSON.stringify(scan(t)) !== JSON.stringify(want)) differ.push(t);
  };
  everyText(pieces, depth, visit);
  for (const t of randomTexts(pieces, random, 16)) visit(t);
  return { differ, matched };
}

describe("each scan finds what its pattern finds", () => {
  test("JWTs", () => {
    const pieces = [
      "ey",
      `eyJ${"x".repeat(13)}`,
      ".bbbbbbbbbbbb",
      "-",
      "a",
      "_",
      ".",
      " ",
      "cccccccccc",
      "x-",
    ];
    const { differ, matched } = agreement(JWT, jwtMatches, pieces, 4, 60_000);
    expect(differ).toEqual([]);
    expect(matched).toBeGreaterThan(1_000);
  }, 30_000);

  test("PEM blocks", () => {
    const pieces = [
      "-----BEGIN PRIVATE KEY-----",
      "-----END CERTIFICATE-----",
      "-----BEGIN ",
      "-----END ",
      "PRIVATE KEY",
      "CERTIFICATE",
      "-----",
      "RSA ",
      "x",
      "\n",
      "-",
      " ",
      "1",
    ];
    const { differ, matched } = agreement(PEM, pemMatches, pieces, 4, 40_000);
    expect(differ).toEqual([]);
    expect(matched).toBeGreaterThan(1_000);
  }, 30_000);

  test("redactInTurn redacts what replacing with each pattern in turn did", () => {
    const inTurn = (text: string): string => {
      let out = text;
      for (const d of SYNTHESIZE_PII_DETECTORS) {
        out = out.replace(
          new RegExp(d.regex.source, `${d.regex.flags.replace("g", "")}g`),
          `[REDACTED:${d.kind}]`,
        );
      }
      return out;
    };
    const pieces = [
      "a",
      "-",
      ".",
      "@",
      "b.co",
      " ",
      "415-555-1234",
      "123-45-6789",
      "sk-abcdefghij",
      "x",
    ];
    const differ: string[] = [];
    let changed = 0;
    for (const t of [
      "mail jane.doe@example.com or call 415-555-1234",
      "key sk-abcdefghijklmnop and a@b.co.uk.x@y.com",
      ...randomTexts(pieces, 5_000, 12),
    ]) {
      const want = inTurn(t);
      if (want !== t) changed++;
      if (redactInTurn(t, SYNTHESIZE_PII_DETECTORS) !== want) differ.push(t);
    }
    expect(differ).toEqual([]);
    expect(changed).toBeGreaterThan(500);
  }, 30_000);
});

// Counted, not timed: the three patterns are refused if they run over the
// run; the other detectors run as usual. The scans' own reads are counted
// below.
describe("redacting a text with a long run", () => {
  test("a tool result of ey-ey-…, BEGIN lines and a-a-… is redacted without those patterns over it", () => {
    const runs = [
      "ey-".repeat(2_000),
      "-----BEGIN RSA PRIVATE KEY-----\n".repeat(100),
      "a-".repeat(2_000),
    ];
    // Control: the hook sees the pattern String#matchAll runs.
    expect(
      refusingOver(runs[0] as string, [JWT], () => byPattern(JWT, runs[0] as string)).ran,
    ).toEqual([`/${JWT.source}/`]);
    for (const [i, unit] of ["ey-", "-----BEGIN RSA PRIVATE KEY-----\n", "a-"].entries()) {
      const text = unit.repeat(Math.ceil(200_000 / unit.length));
      const snippet = refusingOver(runs[i] as string, [JWT, PEM, EMAIL], () => redactSnippet(text));
      expect(snippet.ran).toEqual([]);
      const redacted = refusingOver(runs[i] as string, [EMAIL], () =>
        redactInTurn(text, SYNTHESIZE_PII_DETECTORS),
      );
      expect(redacted.ran).toEqual([]);
      expect(redacted.outcome).toBe(text);
    }
  }, 20_000);
});

// Counted, not timed: a scan can rescan a run with no pattern at all (a
// search that resumes one character on instead of after the run it read), so
// each scan's own reads are counted (__test__/scan-work.ts) over runs shaped
// to make it rescan, and held to a few per character. A rescan reads the rest
// of the run from every place in it and stops at the bound at once.
describe("each scan reads a long run a bounded number of times", () => {
  const N = 20_000;
  const PER_CHARACTER = 8;
  const fill = (unit: string): string => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  const cases: ReadonlyArray<readonly [string, (text: string) => unknown, string]> = [
    ["a run of ey-", jwtMatches, fill("ey-")],
    ["first segments with no second", jwtMatches, fill("eyaaaaaaaaaaa.")],
    ["two segments with no third", jwtMatches, fill("eyaaaaaaaaaaa.bbbbbbbbbbb.")],
    [
      "private-key BEGIN lines with no END line",
      pemMatches,
      fill("-----BEGIN RSA PRIVATE KEY-----\n"),
    ],
    ["a BEGIN line whose name never ends", pemMatches, `-----BEGIN ${"A".repeat(N)}`],
    [
      "a BEGIN line and END lines that are not a key's",
      pemMatches,
      `-----BEGIN RSA PRIVATE KEY-----\n${fill("-----END RSA KEY-----\n")}`,
    ],
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
