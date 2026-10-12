/**
 * The import tools read a file in one pass, however wide its header.
 *
 * ImportCsv and ImportJson take a workspace file of up to 32 MiB, and the
 * columns are whatever its header, or the union of its records' keys, says.
 * Three loops were quadratic in that:
 *
 *   - the duplicate-column check searched the list for each name;
 *   - type inference mapped every record once per column, C × R even when
 *     the rows were one cell wide, and the records of an NDJSON file that
 *     each bring one new key make C as large as R;
 *   - ImportJson's dry run asked every record for every column, and a table
 *     that will not be created is not held to SQLite's column limit;
 *   - a name the model lists k times in ImportJson's `columns` was read k
 *     times from every record that holds it, before the repeat is refused.
 *
 * A cell of digits also went whole to BigInt, which the engine reads with
 * one multiply-add over the number per digit, and past 313,592 digits
 * throws. And `bindParams` searched the statement's names for each key.
 *
 * Every rewrite is checked against the code it replaced, restated here, on
 * generated inputs: short and long records, empty cells, numbers at and past
 * the 64-bit bounds, duplicate columns, records whose prototype answers for
 * a column (`constructor`, `toString`, `__proto__`), and values that throw
 * when a TEXT column stringifies them, so a record's columns are checked in
 * the order the old loop checked them. The work is
 * counted, never timed: tool-code's __test__/js-work.ts counts the array
 * searches, iterators and string copies, `Array#map` callbacks are counted
 * here because it does not, and BigInt is counted by the characters it is
 * handed. The old loops go past the same bounds, and stop there at once.
 *
 * A test that walks many generated inputs declares a budget, as the house
 * does for a test that is slow by construction.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsWork, jsWorkAsync } from "../../tool-code/src/__test__/js-work";
import { bindParams } from "./db";
import { importCsv, importJson } from "./index";
import {
  type InferredType,
  JsonColumns,
  coerceJsonValue,
  inferCsvColumnTypes,
  inferJsonColumnTypes,
  jsonRecordRejection,
  looksInteger,
  looksReal,
} from "./lib/infer";

/** Array searches, iterators, copies and map callbacks, per character of input. */
const WORK_PER_CHARACTER = 6;

const space = { cwd: "", dir: "" };

beforeEach(() => {
  space.cwd = process.cwd();
  space.dir = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-tool-sql-linear-")));
  process.chdir(space.dir);
});

afterEach(() => {
  process.chdir(space.cwd);
  rmSync(space.dir, { recursive: true, force: true });
});

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

/**
 * js-work's count of `body`, plus the callbacks `Array#map` runs while it
 * does, which js-work does not count and the old inference spent its time
 * in. Past `limit` js-work stops `body` and the work is Infinity.
 */
async function importWork<T>(
  limit: number,
  body: () => Promise<T>,
): Promise<{ value: T | undefined; work: number }> {
  const realMap = Array.prototype.map;
  const mapped = { callbacks: 0 };
  Array.prototype.map = function <U>(
    this: unknown[],
    fn: (value: unknown, index: number, array: unknown[]) => U,
    thisArg?: unknown,
  ): U[] {
    mapped.callbacks += this.length;
    return realMap.call(this, fn, thisArg) as U[];
  };
  try {
    const run = await jsWorkAsync(limit, body);
    return { value: run.value, work: run.work + mapped.callbacks };
  } finally {
    Array.prototype.map = realMap;
  }
}

/** The characters handed to the global BigInt while `body` runs. */
async function bigIntCharacters<T>(body: () => Promise<T>): Promise<{ value: T; chars: number }> {
  const RealBigInt = globalThis.BigInt;
  const tally = { chars: 0 };
  globalThis.BigInt = ((value: string | number | bigint | boolean) => {
    tally.chars += String(value).length;
    return RealBigInt(value);
  }) as BigIntConstructor;
  try {
    const value = await body();
    return { value, chars: tally.chars };
  } finally {
    globalThis.BigInt = RealBigInt;
  }
}

/**
 * How often `JsonColumns#cells` is asked for a record's values while `body`
 * runs, and how many it hands back. A loop that reads `record[column]` for
 * every column is property reads, which no meter sees; the readers that
 * replaced it go through here.
 */
async function cellsAsked<T>(
  body: () => Promise<T>,
): Promise<{ value: T; calls: number; cells: number }> {
  const proto = JsonColumns.prototype;
  const real = proto.cells;
  const tally = { calls: 0, cells: 0 };
  proto.cells = function (this: JsonColumns, record: object) {
    const out = real.call(this, record);
    tally.calls += 1;
    tally.cells += out.length;
    return out;
  };
  try {
    const value = await body();
    return { value, calls: tally.calls, cells: tally.cells };
  } finally {
    proto.cells = real;
  }
}

/** What `body` returned, or the name of what it threw: a tag two runs can be compared by. */
function outcome(body: () => unknown): string {
  try {
    return `returned ${String(body())}`;
  } catch (err) {
    return `threw ${(err as Error).name}`;
  }
}

/** JSON for a failure message, or a note when the value will not stringify. */
function shown(value: unknown): string {
  try {
    return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? `${v}n` : v));
  } catch (err) {
    return `(unprintable: ${(err as Error).name})`;
  }
}

/** Run a tool and parse its JSON, or hand back the refusal sentence. */
// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
function parsed(out: unknown): any {
  try {
    return JSON.parse(String(out));
  } catch {
    return out;
  }
}

// ---------------------------------------------------------------------------
// The code as it was.

function oldLooksInteger(raw: string): boolean {
  if (!/^[+-]?[0-9]+$/.test(raw)) return false;
  const n = BigInt(raw);
  return n >= -(2n ** 63n) && n <= 2n ** 63n - 1n;
}

function oldInferTypeFromStrings(values: readonly string[], emptyIsNull: boolean): InferredType {
  let sawValue = false;
  let allInteger = true;
  let allNumeric = true;
  for (const raw of values) {
    if (raw === "" && emptyIsNull) continue;
    sawValue = true;
    if (!oldLooksInteger(raw)) allInteger = false;
    if (!looksReal(raw)) allNumeric = false;
    if (!allNumeric) break;
  }
  if (!sawValue) return "TEXT";
  if (allInteger) return "INTEGER";
  if (allNumeric) return "REAL";
  return "TEXT";
}

function oldInferTypeFromJson(values: readonly unknown[]): InferredType {
  let sawValue = false;
  let allInteger = true;
  let allNumeric = true;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    sawValue = true;
    if (typeof value === "number" && Number.isFinite(value)) {
      if (!Number.isInteger(value)) allInteger = false;
    } else if (typeof value === "bigint" || typeof value === "boolean") {
      // integral
    } else {
      allInteger = false;
      allNumeric = false;
      break;
    }
  }
  if (!sawValue) return "TEXT";
  if (allInteger) return "INTEGER";
  if (allNumeric) return "REAL";
  return "TEXT";
}

/** The dry run's per-record check as it was: every column, in order, to the first that fails. */
function oldRejection(
  columns: readonly string[],
  record: Record<string, unknown>,
  types: readonly InferredType[],
): string | undefined {
  for (let column = 0; column < columns.length; column++) {
    const key = columns[column] as string;
    const coerced = coerceJsonValue(record[key], types[column] ?? "TEXT");
    if (!coerced.ok) return `field "${key}": ${coerced.reason}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Counted.

describe("the import tools read a wide file in one pass", () => {
  for (const emptyIsNull of [true, false]) {
    test(`ImportCsv's dry run of a C-column header over one-cell rows (emptyIsNull ${emptyIsNull})`, async () => {
      const measured: Array<{ chars: number; work: number }> = [];
      for (const width of [4_000, 8_000]) {
        const header = Array.from({ length: width }, (_, i) => `c${i}`).join(",");
        const csv = `${header}\n${Array.from({ length: width }, () => "1").join("\n")}\n`;
        writeFileSync("wide.csv", csv);
        const limit = WORK_PER_CHARACTER * csv.length;
        const run = await importWork(limit, () =>
          importCsv.execute({
            database: "wide.db",
            create: true,
            file: "wide.csv",
            table: "wide",
            createTable: true,
            dryRun: true,
            emptyIsNull,
          }),
        );
        expect(run.work).toBeLessThanOrEqual(limit);
        const out = parsed(run.value);
        expect(out.columns).toHaveLength(width);
        // Every row has one field where the header has `width`.
        expect(out.rejected).toBe(width);
        // Column 0 holds a "1" in every row; the rest hold nothing, which is
        // TEXT either way: no values at all, or the empty string.
        expect(out.inferredTypes[0]).toBe("INTEGER");
        expect(out.inferredTypes[width - 1]).toBe("TEXT");
        measured.push({ chars: csv.length, work: run.work });
      }
      const [small, large] = measured as [(typeof measured)[0], (typeof measured)[0]];
      expect(large.work / small.work).toBeLessThan(2.4);
    }, 20_000);
  }

  test("ImportJson's dry run of records that each bring a new key", async () => {
    const measured: Array<{ chars: number; work: number }> = [];
    for (const count of [4_000, 8_000]) {
      const ndjson = `${Array.from({ length: count }, (_, i) => `{"k${i}":${i}}`).join("\n")}\n`;
      writeFileSync("keys.ndjson", ndjson);
      const limit = WORK_PER_CHARACTER * ndjson.length;
      const asked = await cellsAsked(() =>
        importWork(limit, () =>
          importJson.execute({
            database: "keys.db",
            create: true,
            file: "keys.ndjson",
            table: "keys",
            createTable: true,
            dryRun: true,
          }),
        ),
      );
      const run = asked.value;
      expect(run.work).toBeLessThanOrEqual(limit);
      // Each record is asked for its values once to infer the types and once
      // to check it, and holds one. Asking it for every column instead is a
      // loop of property reads, which nothing can count, so this is what
      // says it is not done.
      expect(asked).toMatchObject({ calls: 2 * count, cells: 2 * count });
      const out = parsed(run.value);
      expect(out.columns).toHaveLength(count);
      expect(out.inferredTypes.every((t: string) => t === "INTEGER")).toBe(true);
      expect(out.wouldInsert).toBe(count);
      measured.push({ chars: ndjson.length, work: run.work });
    }
    const [small, large] = measured as [(typeof measured)[0], (typeof measured)[0]];
    expect(large.work / small.work).toBeLessThan(2.4);
  }, 20_000);

  test("a duplicate column is still refused, found with a set", async () => {
    const width = 8_000;
    const names = Array.from({ length: width }, (_, i) => `c${i}`);
    const csv = `${[...names, "C17"].join(",")}\n${names.map(() => "1").join(",")},1\n`;
    writeFileSync("dupe.csv", csv);
    const limit = WORK_PER_CHARACTER * csv.length;
    const run = await importWork(limit, () =>
      importCsv.execute({
        database: "dupe.db",
        create: true,
        file: "dupe.csv",
        table: "dupe",
        createTable: true,
        dryRun: true,
      }),
    );
    expect(run.work).toBeLessThanOrEqual(limit);
    expect(run.value).toBe('ImportCsv refused a duplicate column name "c17".');
  }, 20_000);

  test("a column name the model lists thousands of times is read once per record", async () => {
    // `columns` is the model's, with no length limit, and the types are
    // inferred before the repeat is refused. Fanning each record's value out
    // to every column that names it was k × R.
    const measured: number[] = [];
    for (const count of [4_000, 8_000]) {
      const ndjson = `${Array.from({ length: count }, () => '{"a":1}').join("\n")}\n`;
      writeFileSync("same.ndjson", ndjson);
      const columns = Array.from({ length: count }, () => "a");
      const limit = WORK_PER_CHARACTER * (ndjson.length + 4 * columns.length);
      const asked = await cellsAsked(() =>
        importWork(limit, () =>
          importJson.execute({
            database: "same.db",
            create: true,
            file: "same.ndjson",
            table: "same",
            createTable: true,
            dryRun: true,
            columns,
          }),
        ),
      );
      const run = asked.value;
      expect(run.work).toBeLessThanOrEqual(limit);
      expect(run.value).toBe('ImportJson refused a duplicate column name "a".');
      // Once per record, to infer the types, and one value each.
      expect(asked).toMatchObject({ calls: count, cells: count });
      measured.push(run.work);
    }
    expect((measured[1] as number) / (measured[0] as number)).toBeLessThan(2.4);
  }, 20_000);

  test("a name listed twice gets the type its values give, in both its columns", () => {
    const records = [{ a: 1, b: "x" }, { a: 2 }, { b: null }];
    expect(inferJsonColumnTypes(["a", "b", "a", "b", "a"], records)).toEqual([
      "INTEGER",
      "TEXT",
      "INTEGER",
      "TEXT",
      "INTEGER",
    ]);
  });

  test("a cell of digits goes to BigInt only when it could be in range", async () => {
    const digits = "7".repeat(400_000);
    expect(
      (
        await bigIntCharacters(async () =>
          looksInteger(`-${"0".repeat(50_000)}${"7".repeat(200_000)}`),
        )
      ).chars,
    ).toBe(0);
    const near = await bigIntCharacters(async () => [
      looksInteger(`${"0".repeat(200_000)}9223372036854775807`),
      looksInteger("-9223372036854775808"),
      looksInteger("9223372036854775808"),
    ]);
    expect(near.value).toEqual([true, true, false]);
    expect(near.chars).toBeLessThanOrEqual(3 * 20);
    // The whole cell went to BigInt, which threw past 313,592 digits: the
    // import failed instead of reading the column as TEXT.
    writeFileSync("digits.csv", `n\n${digits}\n`);
    const run = await bigIntCharacters(() =>
      importCsv.execute({
        database: "digits.db",
        create: true,
        file: "digits.csv",
        table: "digits",
        createTable: true,
        dryRun: true,
      }),
    );
    expect(run.chars).toBe(0);
    expect(parsed(run.value).inferredTypes).toEqual(["TEXT"]);
  }, 20_000);

  test("bindParams matches thousands of keys to thousands of names", () => {
    const measured = [4_000, 8_000].map((count) => {
      const names = Array.from({ length: count }, (_, i) => `${"$:@"[i % 3]}p${i}`);
      const sql = `SELECT ${names.join(", ")}`;
      // Half the keys are given without their sigil, which is allowed.
      const params = Object.fromEntries(
        names.map((name, i) => [i % 2 === 0 ? name : name.slice(1), i]),
      );
      const limit = WORK_PER_CHARACTER * sql.length;
      const run = jsWork(limit, () => bindParams("SqlQuery", sql, params));
      expect(run.work).toBeLessThanOrEqual(limit);
      expect(run.value).toEqual({
        ok: true,
        value: Object.fromEntries(names.map((name, i) => [name, i])),
      });
      return run.work;
    });
    expect((measured[1] as number) / (measured[0] as number)).toBeLessThan(2.4);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// The same answers as before.

describe("the one-pass readers answer what the loops answered", () => {
  test("looksInteger on generated integers, signs, leading zeros and the 64-bit bounds", () => {
    const next = rng(0x5eed1001);
    const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(next() * xs.length)] as T;
    const bounds = [
      "9223372036854775807",
      "9223372036854775808",
      "9223372036854775806",
      "9223372036854775809",
      "10000000000000000000",
      "999999999999999999",
      "9999999999999999999",
      "1000000000000000000",
    ];
    const differ: string[] = [];
    const answers = { yes: 0, nineteen: 0 };
    for (let n = 0; n < 40_000; n++) {
      const sign = pick(["", "", "-", "+", "--", "-+"]);
      const zeros = "0".repeat(pick([0, 0, 0, 1, 2, 7, 40]));
      const body = pick([
        () => pick(bounds),
        () => Array.from({ length: Math.floor(next() * 24) }, () => pick("0123456789")).join(""),
        () =>
          Array.from({ length: 17 + Math.floor(next() * 5) }, () => pick("0123456789")).join(""),
        () => pick(["", "x", "1.0", "1e5", " 1", "1 ", "٣", "0x10"]),
      ])();
      const raw = `${sign}${zeros}${body}`;
      const old = oldLooksInteger(raw);
      if (old) answers.yes++;
      if (/^[+-]?0*[1-9][0-9]{18}$/.test(raw)) answers.nineteen++;
      if (looksInteger(raw) !== old) differ.push(raw);
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(answers.yes).toBeGreaterThan(8_000);
    expect(answers.nineteen).toBeGreaterThan(2_000);
  }, 20_000);

  test("inferCsvColumnTypes on generated records, short, long and holed", () => {
    const next = rng(0x5eed1002);
    const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(next() * xs.length)] as T;
    const cells = [
      "",
      "",
      "1",
      "-2",
      "+3",
      "007",
      "1.5",
      "-.5",
      "1e3",
      "1e",
      "x",
      " 1",
      "9223372036854775807",
      "9223372036854775808",
      "1".repeat(25),
      "-9223372036854775809",
      "NaN",
      "Infinity",
      "1".repeat(400),
    ];
    const differ: string[] = [];
    const seen = { integer: 0, real: 0, short: 0 };
    for (let n = 0; n < 6_000; n++) {
      const width = Math.floor(next() * 8);
      const records = Array.from({ length: Math.floor(next() * 8) }, () => {
        const length = next() < 0.7 ? width : Math.floor(next() * (width + 3));
        const values = Array.from({ length }, () => pick(cells));
        // A hole reads as undefined, which the old loop read as "".
        if (next() < 0.05 && length > 0) delete values[Math.floor(next() * length)];
        return { values };
      });
      if (records.some((r) => r.values.length < width)) seen.short++;
      for (const emptyIsNull of [true, false]) {
        const old = Array.from({ length: width }, (_, column) =>
          oldInferTypeFromStrings(
            records.map((r) => r.values[column] ?? ""),
            emptyIsNull,
          ),
        );
        if (old.includes("INTEGER")) seen.integer++;
        if (old.includes("REAL")) seen.real++;
        const now = inferCsvColumnTypes(width, records, emptyIsNull);
        if (JSON.stringify(now) !== JSON.stringify(old)) {
          differ.push(
            JSON.stringify({ width, emptyIsNull, records: records.map((r) => r.values) }),
          );
        }
      }
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(seen).toEqual({
      integer: expect.any(Number),
      real: expect.any(Number),
      short: expect.any(Number),
    });
    expect(Math.min(seen.integer, seen.real, seen.short)).toBeGreaterThan(500);
  }, 20_000);

  test("inferJsonColumnTypes and jsonRecordRejection on generated records and prototypes", () => {
    const next = rng(0x5eed1003);
    const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(next() * xs.length)] as T;
    const names = ["a", "b", "constructor", "toString", "__proto__", "valueOf", "1", "x y", ""];
    // Values JSON.stringify throws on, as it does on one nested too deep:
    // coercing them into a TEXT column throws, so the order the columns are
    // checked in decides between a rejection and a throw.
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const throwers: unknown[] = [[1n], cyclic];
    const values: unknown[] = [
      ...throwers,
      null,
      undefined,
      1,
      -3,
      0,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      10n,
      true,
      "1",
      "2.5",
      "x",
      "9223372036854775808",
      {},
      [1],
    ];
    const prototypes: Array<object | null> = [
      Object.prototype,
      Object.prototype,
      null,
      { toString: 5 },
      { a: 7 },
    ];
    const types: ReadonlyArray<InferredType> = ["INTEGER", "REAL", "TEXT"];
    const record = (): Record<string, unknown> => {
      if (next() < 0.3) {
        // As a file arrives: JSON.parse, which makes `__proto__` an own key.
        const members = Array.from(
          { length: Math.floor(next() * 5) },
          () =>
            `${JSON.stringify(pick(names))}:${pick(["1", "2.5", '"x"', "null", "true", "{}", '"7"'])}`,
        );
        return JSON.parse(`{${members.join(",")}}`);
      }
      const out = Object.create(pick(prototypes)) as Record<string, unknown>;
      for (let k = Math.floor(next() * 5); k > 0; k--) {
        Object.defineProperty(out, pick(names), {
          value: pick(values),
          enumerable: next() < 0.9,
          configurable: true,
          writable: true,
        });
      }
      return out;
    };
    const differ: string[] = [];
    const seen = { inherited: 0, rejected: 0, integer: 0, threw: 0, spared: 0 };
    for (let n = 0; n < 6_000; n++) {
      const columns = Array.from({ length: Math.floor(next() * 6) }, () => pick(names));
      if (next() < 0.4) columns.push(...columns.slice(0, 2));
      const records = Array.from({ length: Math.floor(next() * 7) }, record);
      const old = columns.map((c) => oldInferTypeFromJson(records.map((r) => r[c])));
      if (old.includes("INTEGER")) seen.integer++;
      if (JSON.stringify(inferJsonColumnTypes(columns, records)) !== JSON.stringify(old)) {
        differ.push(`types ${shown({ columns, records })}`);
      }
      const typed = columns.map(() => pick(types));
      const reader = new JsonColumns(columns);
      for (const r of records) {
        if (columns.some((c) => !Object.hasOwn(r, c) && r[c] !== undefined)) seen.inherited++;
        const was = outcome(() => oldRejection(columns, r, typed));
        if (was.startsWith("threw")) seen.threw++;
        else if (was !== "returned undefined") {
          seen.rejected++;
          // A rejection from a record that also holds a value that throws:
          // the check stopped before it reached that column.
          if (columns.some((c) => throwers.includes(r[c]))) seen.spared++;
        }
        if (outcome(() => jsonRecordRejection(reader, r, typed)) !== was) {
          differ.push(`rejection ${shown({ columns, typed, r, keys: Object.keys(r) })} ${was}`);
        }
      }
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(Math.min(seen.inherited, seen.rejected, seen.integer)).toBeGreaterThan(500);
    expect(Math.min(seen.threw, seen.spared)).toBeGreaterThan(100);
  }, 20_000);

  test("ImportJson's dry run reports what the real import does", async () => {
    const next = rng(0x5eed1004);
    const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(next() * xs.length)] as T;
    const keys = ["id", "name", "age", "score", "constructor", "toString"];
    const differ: string[] = [];
    const seen = { inserted: 0, rejected: 0, failed: 0 };
    for (let n = 0; n < 150; n++) {
      // Every third run passes its records inline, where a value can be one
      // JSON.stringify throws on, as on one nested too deep: the import then
      // fails, or rejects the record first, by the order it checks columns.
      const inline = n % 3 === 0;
      const records = Array.from({ length: Math.floor(next() * 8) }, () =>
        Object.fromEntries(
          Array.from({ length: Math.floor(next() * 4) }, () => [
            pick(keys),
            pick([1, 2.5, -3, "x", "7", null, true, { a: 1 }, [2], ...(inline ? [[1n]] : [])]),
          ]),
        ),
      );
      const from = inline ? { records } : { file: `in${n}.ndjson` };
      if (!inline) writeFileSync(`in${n}.ndjson`, records.map((r) => JSON.stringify(r)).join("\n"));
      const columns = next() < 0.3 ? { columns: [pick(keys), pick(keys)] } : {};
      const common = { create: true, ...from, table: "t", createTable: true };
      const dry = parsed(
        await importJson.execute({ ...common, ...columns, database: `dry${n}.db`, dryRun: true }),
      );
      const real = parsed(
        await importJson.execute({ ...common, ...columns, database: `real${n}.db` }),
      );
      if (typeof dry === "string" || typeof real === "string") {
        if (String(real).startsWith("ImportJson failed:")) seen.failed++;
        if (dry !== real) differ.push(`${shown(records)} :: ${dry} :: ${real}`);
        continue;
      }
      seen.inserted += real.inserted;
      seen.rejected += real.rejected;
      const same =
        dry.wouldInsert === real.inserted &&
        dry.rejected === real.rejected &&
        JSON.stringify(dry.rejections) === JSON.stringify(real.rejections) &&
        JSON.stringify(dry.columns) === JSON.stringify(real.columns);
      if (!same) differ.push(`${shown(records)} :: ${JSON.stringify({ dry, real })}`);
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(Math.min(seen.inserted, seen.rejected)).toBeGreaterThan(50);
    expect(seen.failed).toBeGreaterThan(5);
  }, 30_000);

  test("a value too deep to stringify, after a column that fails, is never reached", async () => {
    // JSON.parse takes a nesting JSON.stringify cannot write back: coercing
    // it into a TEXT column throws. The real import checks a record's
    // columns in order and stops at the first that fails, so a record whose
    // key order puts the deep value first is still a rejection, and the dry
    // run has to say the same. On a platform whose stack holds this depth
    // nothing throws, and the rejection is the answer all the same.
    const depth = 120_000;
    const deep = `${"[".repeat(depth)}${"]".repeat(depth)}`;
    const cases = [
      {
        // An existing table: column a fails before column b is read.
        lines: ['{"a":1,"b":"y"}', `{"b":${deep},"a":"x"}`],
        setup: "CREATE TABLE t (a INTEGER, b TEXT)",
        columns: undefined,
        reason: 'field "a": "x" is not an integer',
      },
      {
        // A created table whose first column the record's prototype answers
        // for: Object.prototype.toString, which no type can store.
        lines: ['{"toString":"1","deep":"y"}', `{"deep":${deep}}`],
        setup: undefined,
        columns: ["toString", "deep"],
        reason: 'field "toString": values of type function cannot be stored',
      },
    ];
    for (const [index, c] of cases.entries()) {
      writeFileSync(`deep${index}.ndjson`, c.lines.join("\n"));
      const answers = [];
      for (const dryRun of [true, false]) {
        const database = `deep${index}-${dryRun}.db`;
        if (c.setup !== undefined) {
          const db = new Database(database, { create: true });
          db.run(c.setup);
          db.close();
        }
        answers.push(
          parsed(
            await importJson.execute({
              database,
              create: true,
              file: `deep${index}.ndjson`,
              table: "t",
              createTable: true,
              dryRun,
              ...(c.columns === undefined ? {} : { columns: c.columns }),
            }),
          ),
        );
      }
      const [dry, real] = answers;
      expect(dry.rejections).toEqual([{ row: 2, reason: c.reason }]);
      expect(real.rejections).toEqual(dry.rejections);
      expect([dry.wouldInsert, real.inserted]).toEqual([1, 1]);
    }
  }, 20_000);
});
