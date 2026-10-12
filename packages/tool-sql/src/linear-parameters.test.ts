/**
 * A statement's named parameters are listed in one pass.
 *
 * `namedParameters` checked each name against every name listed so far:
 * quadratic in the distinct names of one statement, and the statement is
 * whatever SQL the model wrote. A set now answers "listed already?", and the
 * names come back in the same first-appearance order.
 *
 * It also rescanned. A sigil that starts no name — `$a(` with no `)` after
 * it, a run of `:`, or `$$$…(` — was followed by a scan from the very next
 * sigil, over the same characters. Where each scan stops is now worked out
 * once per position, and `bindParams` looks each key up in a set rather
 * than searching the list of names for it.
 *
 * The work is counted with tool-code's __test__/js-work.ts, which charges an
 * array's `includes` for the whole array and a `charCodeAt` for one
 * character, and with the scan's own meter, which counts the characters it
 * reads however it reads them: the old scan indexed the string by hand,
 * which js-work cannot see. Never timed.
 */
import { describe, expect, test } from "bun:test";
import { jsWork } from "../../tool-code/src/__test__/js-work";
import { bindParams } from "./db";
import { type NameScanMeter, namedParameters, scanSql } from "./lib/sql-text";

/** Characters copied, searched or read, and elements visited, per character; about 2 here. */
const WORK_PER_CHARACTER = 3;

/** The same for `bindParams`, which scans the statement twice; about 3.5 here. */
const BIND_WORK_PER_CHARACTER = 6;

/** Characters the name scan reads per character of the statement; 2 here, 3 at most. */
const READS_PER_CHARACTER = 3;

/** Seeded, so a failure names the same input every run. */
function rng(start: number): () => number {
  const state = { seed: start };
  return () => {
    state.seed = (state.seed + 0x6d2b79f5) | 0;
    let t = Math.imul(state.seed ^ (state.seed >>> 15), 1 | state.seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isIdChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) >= 0x80;
}

/** The scan as it was, with the list searched for each name. */
function oldNamedParameters(sql: string): string[] {
  const { stripped } = scanSql(sql);
  const found: string[] = [];
  for (let i = 0; i < stripped.length; i++) {
    const sigil = stripped[i] as string;
    if (sigil !== "$" && sigil !== ":" && sigil !== "@") continue;
    let cursor = i + 1;
    let nameChars = 0;
    let illegal = false;
    while (cursor < stripped.length) {
      const ch = stripped[cursor] as string;
      if (isIdChar(ch)) {
        nameChars += 1;
        cursor += 1;
        continue;
      }
      if (ch === "(" && nameChars > 0) {
        cursor += 1;
        while (cursor < stripped.length && stripped[cursor] !== ")") cursor += 1;
        if (cursor >= stripped.length) illegal = true;
        else cursor += 1;
        break;
      }
      if (ch === ":" && stripped[cursor + 1] === ":") {
        cursor += 2;
        continue;
      }
      break;
    }
    if (nameChars === 0 || illegal) continue;
    const name = stripped.slice(i, cursor);
    if (!found.includes(name)) found.push(name);
    i = cursor - 1;
  }
  return found;
}

describe("namedParameters lists names in one pass", () => {
  test("a statement declaring thousands of names, each twice", () => {
    const measured = [4_000, 8_000].map((k) => {
      const names = Array.from({ length: k }, (_, i) => `${"$:@"[i % 3]}p${i}`);
      const sql = `SELECT ${[...names, ...names].join(", ")}`;
      const meter: NameScanMeter = { reads: 0 };
      const run = jsWork(WORK_PER_CHARACTER * sql.length, () => namedParameters(sql, meter));
      return { names, sql, run, meter };
    });
    for (const { names, sql, run, meter } of measured) {
      expect(run.work).toBeLessThanOrEqual(WORK_PER_CHARACTER * sql.length);
      expect(meter.reads).toBeLessThanOrEqual(READS_PER_CHARACTER * sql.length);
      expect(run.value).toEqual(names);
    }
    const [small, large] = measured as [(typeof measured)[0], (typeof measured)[0]];
    expect(large.run.work / small.run.work).toBeLessThan(2.4);
  }, 20_000);

  test("the same names, in the same order, as the old scan on generated SQL", () => {
    const next = rng(0x5eed0401);
    const pieces = [
      "SELECT ",
      "$a",
      ":b",
      "@c",
      "?",
      "?1",
      "$a::b",
      "$f(x)",
      "$f(",
      ")",
      "'$s'",
      '"$t"',
      "-- $c\n",
      "/* :d */",
      ",",
      " ",
      "$",
      ":",
      "::",
      "$_1",
      "@@x",
      "$ab",
      "é",
    ];
    const differ: string[] = [];
    let names = 0;
    for (let n = 0; n < 20_000; n++) {
      let sql = "";
      for (let i = 1 + Math.floor(next() * 24); i > 0; i--) {
        sql += pieces[Math.floor(next() * pieces.length)];
      }
      const old = oldNamedParameters(sql);
      names += old.length;
      if (JSON.stringify(namedParameters(sql)) !== JSON.stringify(old)) differ.push(sql);
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(names).toBeGreaterThan(20_000);
  }, 20_000);
});

/** The statements whose sigils start no name, each followed by a rescan. */
const RESCANNED: ReadonlyArray<{ label: string; make: (k: number) => string }> = [
  { label: "`$a(` with no `)`", make: (k) => `SELECT ${"$a(".repeat(k)}` },
  { label: "a run of `:`", make: (k) => `SELECT 1 ${":".repeat(k)}` },
  { label: "`$$$…` then an unclosed `(`", make: (k) => `SELECT ${"$".repeat(k)}(` },
];

describe("namedParameters reads each character a bounded number of times", () => {
  test("statements whose sigils start no name", () => {
    for (const { label, make } of RESCANNED) {
      const measured = [6_000, 12_000].map((k) => {
        const sql = make(k);
        const meter: NameScanMeter = { reads: 0 };
        const run = jsWork(WORK_PER_CHARACTER * sql.length, () => namedParameters(sql, meter));
        return { sql, run, meter };
      });
      for (const { sql, run, meter } of measured) {
        // Labelled, so a failure names the shape.
        expect({ label, within: run.work <= WORK_PER_CHARACTER * sql.length }).toEqual({
          label,
          within: true,
        });
        // Every character read a bounded number of times, counted by the
        // scan itself; and read at all, so the meter is live.
        expect({
          label,
          reads: meter.reads <= READS_PER_CHARACTER * sql.length,
          live: meter.reads >= sql.length,
        }).toEqual({ label, reads: true, live: true });
        expect(run.value).toEqual([]);
      }
      const [small, large] = measured as [(typeof measured)[0], (typeof measured)[0]];
      // Twice the characters, about twice the work.
      expect({ label, ratio: large.run.work / small.run.work < 2.4 }).toEqual({
        label,
        ratio: true,
      });
    }
  }, 20_000);

  test("the same names as the old scan around the shapes that were rescanned", () => {
    const differ: string[] = [];
    let names = 0;
    for (const k of [1, 2, 3, 4, 7, 64, 129]) {
      for (const sql of [
        ...RESCANNED.map(({ make }) => make(k)),
        `SELECT ${"$a(".repeat(k)})`,
        `SELECT 1 ${":".repeat(k)}a`,
        `SELECT 1 ${":".repeat(k)}a(`,
        `SELECT 1 ${":".repeat(k)}a()`,
        `SELECT $${"::".repeat(k)}x`,
        `SELECT @${":".repeat(k)}x, $${":".repeat(k)}y`,
        `SELECT ${"$a::".repeat(k)}(`,
        `SELECT ${"$".repeat(k)}`,
        `SELECT ${"@::".repeat(k)}`,
      ]) {
        const old = oldNamedParameters(sql);
        names += old.length;
        if (JSON.stringify(namedParameters(sql)) !== JSON.stringify(old)) differ.push(sql);
      }
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(names).toBeGreaterThan(40);
  });

  // A hang detector, nothing more, for the reads js-work cannot see: the old
  // scan indexed the string by hand, and read 2.2e10 characters for the
  // first statement, 3.6e9 for the second and 7.2e9 for the third, about a
  // hundred seconds on a fast laptop. The one-pass scan reads each about
  // twice, a few milliseconds.
  test("statements of hundreds of thousands of such characters finish", () => {
    for (const { make } of RESCANNED) {
      expect(namedParameters(make(120_000))).toEqual([]);
    }
  }, 20_000);
});

describe("bindParams looks each key up once", () => {
  test("named params given without their sigils, thousands of them", () => {
    const measured = [3_000, 6_000].map((k) => {
      const names = Array.from({ length: k }, (_, i) => `$p${i}`);
      const sql = `SELECT ${names.join(", ")}`;
      const params = Object.fromEntries(names.map((name, i) => [name.slice(1), i]));
      const run = jsWork(BIND_WORK_PER_CHARACTER * sql.length, () =>
        bindParams("SqlQuery", sql, params),
      );
      return { k, sql, run };
    });
    for (const { k, sql, run } of measured) {
      expect(run.work).toBeLessThanOrEqual(BIND_WORK_PER_CHARACTER * sql.length);
      const bound = run.value as { ok: true; value: Record<string, number> };
      expect(bound.ok).toBe(true);
      expect(Object.keys(bound.value)).toHaveLength(k);
      expect(bound.value[`$p${k - 1}`]).toBe(k - 1);
    }
    const [small, large] = measured as [(typeof measured)[0], (typeof measured)[0]];
    expect(large.run.work / small.run.work).toBeLessThan(2.4);
  }, 20_000);
});
