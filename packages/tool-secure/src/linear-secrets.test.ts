/**
 * The JWT rule reads a run once.
 *
 * `jwt.compact`'s first segment, `eyJ[A-Za-z0-9_-]{8,}\.`, reads to the end
 * of a run of base64url characters and needs a `.` there. A run with `eyJ`
 * at many word boundaries (`eyJ-eyJ-…`) has no `.` at its end, so the
 * global search read it to the end again from every `eyJ`: quadratic in the
 * run. `SecretScan` takes up to 2M characters of text, or a workspace file
 * of up to 16 MiB, and `RedactForExport` runs the same rules, so that was
 * minutes. The rule now skips the rest of a run once a try in it has
 * failed, and finds the matches the global search did, checked here start
 * for start on generated texts that reach every part and every bound.
 *
 * The steps are counted with the model in tool-text's
 * __test__/regex-work.ts, which walks every regular expression in
 * ECMAScript's order: a bound of a few steps a character holds, and the old
 * pattern goes past it on the same text. The characters the scan reads are
 * counted too (__test__/scan-work.ts), so a scan that rereads the run fails
 * the same way. A test that walks many generated inputs declares a 20 s
 * budget, as the house does for a test that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import { regexWork } from "../../tool-text/src/__test__/regex-work";
import { scanWork } from "./__test__/scan-work";
import { SECRET_RULES, scanSecrets, secretSpans } from "./lib/secrets";
import { matchAll } from "./lib/text";

// The pattern as it was, run by a plain global search.
const OLD_JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

const jwt = SECRET_RULES.find((r) => r.id === "jwt.compact");
const jwtMatches = (s: string) => jwt?.matches?.(s) ?? [];

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
  let seed = 0x2c1b3c6d;
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

describe("jwt.compact finds the global search's matches", () => {
  test("on every short join and long generated texts", () => {
    expect(jwt?.matches).toBeDefined();
    // Runs of 7, 8 and 9 characters after `eyJ` sit on each side of `{8,}`;
    // `-` and `é` put a word boundary inside a run and after it.
    const pieces = ["eyJ", "aaaa", "a", "-", ".", "_", " ", "é", "eyJaaaaaaaa"];
    const longer = [
      "eyJ",
      "eyJ-",
      "eyJaaaaaaa",
      "eyJaaaaaaaa.",
      "eyJbbbbbbbbb.",
      "aaaaaaa",
      "aaaaaaaa",
      "a",
      "-",
      "_",
      ".",
      " ",
      "é",
      "x.eyJ",
      "eyJaaaaaaaa.eyJbbbbbbbb.",
      "eyJaaaaaaaa.eyJbbbbbbbb.ccccccc",
    ];
    const inputs = [...allJoins(pieces, 5), ...randomTexts(longer, 20_000, 16)];
    const differ: string[] = [];
    let matches = 0;
    for (const s of inputs) {
      const ours = hits(jwtMatches(s));
      const old = hits(matchAll(s, OLD_JWT));
      if (JSON.stringify(ours) !== JSON.stringify(old)) differ.push(JSON.stringify(s));
      matches += old.length;
    }
    expect(differ.slice(0, 5)).toEqual([]);
    expect(matches).toBeGreaterThan(8_000);
  }, 20_000);

  test("a token in a line is still reported, masked", () => {
    // Built from parts so the source holds no token-shaped literal.
    const token = [
      "eyJ",
      "hbGciOiJIUzI1NiJ9",
      ".eyJ",
      "zdWIiOiIxMjM0In0",
      ".",
      "SflKxwRJSMeKKF2QT4",
    ];
    const text = `Authorization: Bearer ${token.join("")}\n`;
    const found = scanSecrets(text, { rules: ["jwt.compact"], highEntropy: false });
    expect(found.map((h) => [h.rule, h.start, h.length])).toEqual([
      ["jwt.compact", 22, token.join("").length],
    ]);
    expect(JSON.stringify(found)).not.toContain(token.join(""));
  });
});

describe("a run of eyJ is read once", () => {
  // The rule's own pattern takes 3 steps a character on these and the scan
  // reads each character a few times; the old pattern took thousands of
  // steps a character. The model walks every step in JavaScript, so each
  // test declares a 20 s budget.
  const STEPS_PER_CHARACTER = 8;
  const READS_PER_CHARACTER = 8;

  test.each([
    ["eyJ-eyJ-…", "eyJ-".repeat(5_000)],
    ["a base64url-like run, eyJhbGci-…", "eyJhbGci-".repeat(2_000)],
    ["a first segment and a dot, then eyJ-…", `eyJaaaaaaaa.${"eyJ-".repeat(5_000)}`],
    ["eyJ-…, then a second segment and too short a third", `${"eyJ-".repeat(5_000)}.eyJaaaaaaaa.-`],
  ] as const)(
    "%s",
    (_, text) => {
      const bound = STEPS_PER_CHARACTER * text.length;
      const counted = regexWork(bound, () =>
        scanWork(READS_PER_CHARACTER * text.length, () => hits(jwtMatches(text))),
      );
      expect(counted.unmodelled).toEqual([]);
      expect(counted.steps).toBeLessThanOrEqual(bound);
      expect(counted.value?.value).toEqual(hits(matchAll(text, OLD_JWT)));
      // Read through, and at most a few times: the count reaches the text's
      // length, so the text was read with the methods it counts.
      expect(counted.value?.work).toBeGreaterThanOrEqual(0.9 * text.length);
      expect(counted.value?.work).toBeLessThanOrEqual(READS_PER_CHARACTER * text.length);
      // Control: the count sees the old global search go past the bound.
      expect(regexWork(bound, () => [...matchAll(text, OLD_JWT)].length).steps).toBe(
        Number.POSITIVE_INFINITY,
      );
    },
    20_000,
  );

  test("through SecretScan and RedactForExport, every rule", () => {
    // Every rule and the entropy heuristic together take about 100 steps a
    // character on these; the old JWT pattern alone took thousands.
    const text = "eyJ-".repeat(5_000);
    const bound = 160 * text.length;
    for (const [name, run] of [
      ["scanSecrets", () => scanSecrets(text)],
      ["secretSpans", () => secretSpans(text)],
    ] as const) {
      const counted = regexWork(bound, run);
      expect({ name, unmodelled: counted.unmodelled, under: counted.steps <= bound }).toEqual({
        name,
        unmodelled: [],
        under: true,
      });
    }
    expect(regexWork(bound, () => [...matchAll(text, OLD_JWT)].length).steps).toBe(
      Number.POSITIVE_INFINITY,
    );
  }, 20_000);
});
