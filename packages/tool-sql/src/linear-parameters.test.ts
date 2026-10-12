/**
 * A statement's named parameters are listed in one pass.
 *
 * `namedParameters` checked each name against every name listed so far:
 * quadratic in the distinct names of one statement, and the statement is
 * whatever SQL the model wrote. A set now answers "listed already?", and the
 * names come back in the same first-appearance order.
 *
 * The work is counted with tool-code's __test__/js-work.ts, which charges an
 * array's `includes` for the whole array, never timed.
 */
import { describe, expect, test } from "bun:test";
import { jsWork } from "../../tool-code/src/__test__/js-work";
import { namedParameters, scanSql } from "./lib/sql-text";

/** Characters copied, searched or read, and elements visited, per character; under 1 here. */
const WORK_PER_CHARACTER = 3;

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
      const run = jsWork(WORK_PER_CHARACTER * sql.length, () => namedParameters(sql));
      return { names, sql, run };
    });
    for (const { names, sql, run } of measured) {
      expect(run.work).toBeLessThanOrEqual(WORK_PER_CHARACTER * sql.length);
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
