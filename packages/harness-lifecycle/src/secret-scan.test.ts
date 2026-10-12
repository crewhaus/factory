/**
 * secret-scan.ts answers the three knowledge-secret patterns the engine runs
 * in quadratic time. Each scan must find exactly what its pattern finds, the
 * masker and the strict check must say what they said with the patterns, and
 * a text with a long run must not have those patterns run over it.
 */
import { describe, expect, test } from "bun:test";
import {
  KNOWLEDGE_SECRET_DETECTORS,
  looksLikeSecret,
  maskKnowledgeSecrets,
} from "./knowledge-sync";
import { hasHighEntropyToken, jwtMatches, pemBlockMatches } from "./secret-scan";

const PEM = /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const HIGH_ENTROPY =
  /\b(?=[A-Za-z0-9+/_-]*[A-Za-z])(?=[A-Za-z0-9+/_-]*[0-9])[A-Za-z0-9+/_-]{32,}\b/;
const LONG_BASE64 = /\b[A-Za-z0-9+/]{40,}\b/;

const byPattern = (pattern: RegExp, text: string): { index: number; value: string }[] =>
  [...text.matchAll(new RegExp(pattern.source, "g"))].map((m) => ({ index: m.index, value: m[0] }));

/** The masker and the strict check as they were, every detector by its pattern. */
const before = {
  mask(text: string): string {
    let out = text;
    for (const d of KNOWLEDGE_SECRET_DETECTORS) {
      const re = new RegExp(d.regex.source, d.regex.flags);
      out =
        d.kind === "bearer"
          ? out.replace(re, (_m, scheme: string) => `${scheme} ***`)
          : out.replace(re, "***");
    }
    return out;
  },
  looks(text: string): boolean {
    for (const d of KNOWLEDGE_SECRET_DETECTORS) {
      if (new RegExp(d.regex.source, d.regex.flags).test(text)) return true;
    }
    return HIGH_ENTROPY.test(text) || LONG_BASE64.test(text);
  },
};

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
  let seed = 0x165667b1;
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
 * pattern through it (the control below checks that for `RegExp#test`);
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

describe("each scan answers what its pattern answers", () => {
  test("PEM blocks", () => {
    const pieces = [
      "-----BEGIN X-----",
      "-----END Y-----",
      "-----BEGIN ",
      "-----END ",
      "-----",
      "-",
      "X",
      " ",
      "\n",
      "a",
    ];
    const differ: string[] = [];
    let matched = 0;
    const visit = (t: string): void => {
      const want = byPattern(PEM, t);
      if (want.length > 0) matched++;
      if (JSON.stringify(pemBlockMatches(t)) !== JSON.stringify(want)) differ.push(t);
    };
    everyText(pieces, 4, visit);
    for (const t of randomTexts(pieces, 40_000, 14)) visit(t);
    expect(differ).toEqual([]);
    expect(matched).toBeGreaterThan(1_000);
  }, 30_000);

  test("JWTs", () => {
    const pieces = [
      "eyJ",
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
    const differ: string[] = [];
    let matched = 0;
    const visit = (t: string): void => {
      const want = byPattern(JWT, t);
      if (want.length > 0) matched++;
      if (JSON.stringify(jwtMatches(t)) !== JSON.stringify(want)) differ.push(t);
    };
    everyText(pieces, 4, visit);
    for (const t of randomTexts(pieces, 60_000, 16)) visit(t);
    expect(differ).toEqual([]);
    expect(matched).toBeGreaterThan(1_000);
  }, 30_000);

  test("high-entropy tokens", () => {
    const pieces = [
      "a",
      "1",
      "-",
      "+",
      "/",
      "_",
      " ",
      "aaaaaaaaaaaaaaaa",
      "1111111111111111",
      "a1a1a1a1",
      ".",
      "-a",
    ];
    const differ: string[] = [];
    let found = 0;
    const visit = (t: string): void => {
      const want = HIGH_ENTROPY.test(t);
      if (want) found++;
      if (hasHighEntropyToken(t) !== want) differ.push(t);
    };
    everyText(pieces, 4, visit);
    for (const t of randomTexts(pieces, 60_000, 12)) visit(t);
    expect(differ).toEqual([]);
    expect(found).toBeGreaterThan(1_000);
  }, 30_000);

  test("the masker and the strict check say what they said with the patterns", () => {
    const pieces = [
      "-----BEGIN X-----",
      "-----END Y-----",
      `eyJ${"x".repeat(13)}`,
      ".bbbbbbbbbbbb",
      "aaaaaaaaaaaaaaaa",
      "1111111111111111",
      "a1a1a1a1",
      "-",
      "+",
      " ",
      "\n",
      "bearer ",
      "sk",
    ];
    const differ: string[] = [];
    let masked = 0;
    for (const t of randomTexts(pieces, 10_000, 12)) {
      const want = before.mask(t);
      if (want !== t) masked++;
      if (maskKnowledgeSecrets(t) !== want || looksLikeSecret(t) !== before.looks(t))
        differ.push(t);
    }
    expect(differ).toEqual([]);
    expect(masked).toBeGreaterThan(1_000);
  }, 30_000);
});

// Counted, not timed: the three patterns are refused if they run over the
// run; the other detectors run as usual and read it in linear time.
describe("a memory with a long run", () => {
  test("is masked and checked without those patterns over the run", () => {
    const units = ["a-", "eyJ-", "-----BEGIN X-----\n"];
    // Control: the hook sees the pattern RegExp#test runs.
    expect(
      refusingOver("a-".repeat(1_000), [HIGH_ENTROPY], () => HIGH_ENTROPY.test("a-".repeat(2_000)))
        .ran,
    ).toEqual([`/${HIGH_ENTROPY.source}/`]);
    for (const unit of units) {
      const run = unit.repeat(500);
      const text = unit.repeat(Math.ceil(200_000 / unit.length));
      const masked = refusingOver(run, [PEM, JWT, HIGH_ENTROPY], () => maskKnowledgeSecrets(text));
      expect(masked.ran).toEqual([]);
      expect(masked.outcome).toBe(text);
      const checked = refusingOver(run, [PEM, JWT, HIGH_ENTROPY], () => looksLikeSecret(text));
      expect(checked.ran).toEqual([]);
      expect(checked.outcome).toBe(false);
    }
  }, 20_000);
});
