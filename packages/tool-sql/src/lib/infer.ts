/**
 * Column-type inference for the import tools, and the value coercion that
 * goes with it.
 *
 * SQLite's affinity rules mean a wrong guess is rarely fatal, but it is
 * still a guess, so the rules here are deliberately timid: a column is
 * INTEGER or REAL only when EVERY non-empty value in the sample parses as
 * one, and anything else is TEXT. Widening beats narrowing — a column of
 * `1, 2, 3.5` is REAL, not INTEGER — and a column with no values at all is
 * TEXT rather than a coin flip.
 *
 * Pure: no I/O, no clock, no sampling of a random subset.
 */

/** The three storage classes the import tools will create a column as. */
export type InferredType = "INTEGER" | "REAL" | "TEXT";

/** The digits of 2^63, the widest a signed 64-bit integer's magnitude gets. */
const INT64_DIGITS = 19;

/** True for a decimal integer SQLite will store as INTEGER without loss. */
export function looksInteger(raw: string): boolean {
  if (!/^[+-]?[0-9]+$/.test(raw)) return false;
  // Past 2^63 SQLite stores the value as REAL, which is not what the column
  // type would promise, so those stay TEXT and keep their exact digits.
  //
  // Only the significant digits go to BigInt, and only when there are few
  // enough of them to be in range at all. A cell is whatever the file holds:
  // the engine reads a decimal BigInt with one multiply-add over the whole
  // number per digit, quadratic in the cell, and past 313,592 digits it
  // throws, which failed the import instead of reading the column as TEXT,
  // or rejecting the row when the column is already INTEGER.
  // Twenty or more significant digits are at least 10^19, past 2^63 either
  // way; leading zeros and the sign change nothing.
  const sign = raw.charCodeAt(0) === 0x2d || raw.charCodeAt(0) === 0x2b ? 1 : 0;
  let first = sign;
  while (first < raw.length - 1 && raw.charCodeAt(first) === 0x30) first++;
  if (raw.length - first > INT64_DIGITS) return false;
  const n = BigInt(`${raw.slice(0, sign)}${raw.slice(first)}`);
  return n >= -(2n ** 63n) && n <= 2n ** 63n - 1n;
}

/**
 * Whether `raw` is written as a decimal number: an optional sign, digits with
 * an optional point and fraction (or a point and a fraction), and an optional
 * exponent. What `/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw)`
 * answered, in one pass. That pattern gave every digit of a run back to its
 * fraction in turn when the text did not end where it should, so a long run
 * of digits before a stray character was quadratic in its length, and a cell
 * is whatever the file holds.
 */
export function isDecimalNumberText(raw: string): boolean {
  const digitsFrom = (start: number): number => {
    let i = start;
    for (; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      if (c < 0x30 || c > 0x39) break;
    }
    return i;
  };
  let i = raw.charCodeAt(0) === 0x2b || raw.charCodeAt(0) === 0x2d ? 1 : 0;
  const whole = digitsFrom(i);
  if (whole > i) {
    i = whole;
    if (raw.charCodeAt(i) === 0x2e) i = digitsFrom(i + 1);
  } else {
    if (raw.charCodeAt(i) !== 0x2e) return false;
    const fraction = digitsFrom(i + 1);
    if (fraction === i + 1) return false;
    i = fraction;
  }
  if (raw.charCodeAt(i) === 0x65 || raw.charCodeAt(i) === 0x45) {
    let at = i + 1;
    if (raw.charCodeAt(at) === 0x2b || raw.charCodeAt(at) === 0x2d) at++;
    const exponent = digitsFrom(at);
    if (exponent === at) return false;
    i = exponent;
  }
  return i === raw.length;
}

/** True for a value SQLite will store as REAL. Excludes Inf and NaN. */
export function looksReal(raw: string): boolean {
  if (!isDecimalNumberText(raw)) return false;
  return Number.isFinite(Number(raw));
}

/**
 * Infer one column's type from the strings a CSV gave for it.
 *
 * `emptyIsNull` mirrors the import tools' own option: when an empty cell
 * means NULL it contributes nothing to the decision, and when it means an
 * empty string it forces TEXT, because `""` is not a number.
 */
export function inferTypeFromStrings(
  values: readonly string[],
  emptyIsNull: boolean,
): InferredType {
  const tally = newTally();
  for (const raw of values) {
    countString(tally, raw, emptyIsNull);
    if (!tally.allNumeric) break;
  }
  return decide(tally);
}

/** Infer one column's type from already-typed JSON values. */
export function inferTypeFromJson(values: readonly unknown[]): InferredType {
  const tally = newTally();
  for (const value of values) {
    countJson(tally, value);
    if (!tally.allNumeric) break;
  }
  return decide(tally);
}

/**
 * What one column has seen so far. Once `allNumeric` is false the column is
 * TEXT whatever comes after, so the readers stop counting it there.
 */
type Tally = { sawValue: boolean; allInteger: boolean; allNumeric: boolean };

function newTally(): Tally {
  return { sawValue: false, allInteger: true, allNumeric: true };
}

function decide(tally: Tally): InferredType {
  if (!tally.sawValue) return "TEXT";
  if (tally.allInteger) return "INTEGER";
  if (tally.allNumeric) return "REAL";
  return "TEXT";
}

function countString(tally: Tally, raw: string, emptyIsNull: boolean): void {
  if (raw === "" && emptyIsNull) return;
  tally.sawValue = true;
  if (!looksInteger(raw)) tally.allInteger = false;
  if (!looksReal(raw)) tally.allNumeric = false;
}

function countJson(tally: Tally, value: unknown): void {
  if (value === null || value === undefined) return;
  tally.sawValue = true;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (!Number.isInteger(value)) tally.allInteger = false;
  } else if (typeof value === "bigint") {
    // still integral
  } else if (typeof value === "boolean") {
    // SQLite has no boolean; true/false land in an INTEGER column as 1/0.
  } else {
    tally.allInteger = false;
    tally.allNumeric = false;
  }
}

/** What the CSV inference needs of a record: its cells, in column order. */
export type CsvCells = { readonly values: readonly string[] };

/**
 * Every column's type from CSV records, in one pass over the cells they hold.
 *
 * What `inferTypeFromStrings(records.map((r) => r.values[column] ?? ""))`
 * answered for each column, but that walked every record once per column:
 * C × R, even when the rows were one cell wide, and C is whatever the
 * header says. The answer for a column does not depend on the order its
 * values come in, so the records are walked once, each as far as the cells
 * it holds and the columns still undecided.
 *
 * A record shorter than the header gives `""` for each column it does not
 * reach. That counts for nothing when an empty cell is NULL, and makes the
 * column TEXT when it is an empty string, so all that needs remembering is
 * the shortest record so far: every column from there on is TEXT.
 */
export function inferCsvColumnTypes(
  columnCount: number,
  records: ReadonlyArray<CsvCells>,
  emptyIsNull: boolean,
): InferredType[] {
  const tallies: Tally[] = [];
  for (let column = 0; column < columnCount; column++) tallies.push(newTally());
  let shortest = columnCount;
  for (const record of records) {
    const reach = Math.min(record.values.length, shortest);
    let column = 0;
    for (const raw of record.values) {
      if (column >= reach) break;
      const tally = tallies[column] as Tally;
      if (tally.allNumeric) countString(tally, raw ?? "", emptyIsNull);
      column++;
    }
    if (!emptyIsNull && record.values.length < shortest) shortest = record.values.length;
  }
  return tallies.map((tally, column) => (column < shortest ? decide(tally) : "TEXT"));
}

/** One column's value in one record, when it is neither null nor undefined. */
export type JsonField = { readonly column: number; readonly value: unknown };

/** A distinct column name, and the columns it fills: a name listed twice fills both. */
export type JsonName = { readonly index: number; readonly columns: readonly number[] };

/** The value a record holds for one distinct name, when it is neither null nor undefined. */
export type JsonCell = { readonly name: JsonName; readonly value: unknown };

/**
 * The cells of a JSON record that are there, found from the record's own
 * names rather than by asking it for every column.
 *
 * `record[column]` for every column of every record is C × R reads, and the
 * columns are the union of every record's keys, so a file of records that
 * each bring one new key makes C as large as R. A column a record does not
 * hold reads as undefined, which every reader here treats as absent, unless
 * the record's prototype answers for the name: a column called `toString`
 * reads `Object.prototype.toString` from a record without one. So a record
 * is asked for the names it owns, and for the columns its prototype answers
 * for, and no other cell can matter.
 *
 * A record is read once per distinct name, however often the name is
 * listed: the columns are the model's to write, and a name repeated k times
 * would otherwise cost k for every record that holds it.
 */
export class JsonColumns {
  /** Each distinct name, in the order it is first listed. */
  readonly names: JsonName[] = [];
  private readonly byName = new Map<string, { index: number; columns: number[] }>();
  /** Per prototype, the names it answers for: `name in prototype`. */
  private readonly inherited = new Map<object, Array<readonly [string, JsonName]>>();

  constructor(readonly columns: readonly string[]) {
    for (let column = 0; column < columns.length; column++) {
      const key = columns[column] as string;
      const known = this.byName.get(key);
      if (known !== undefined) {
        known.columns.push(column);
      } else {
        const name = { index: this.names.length, columns: [column] };
        this.byName.set(key, name);
        this.names.push(name);
      }
    }
  }

  /**
   * The record's non-null values, one for each distinct name, as
   * `record[name]` reads them: the names it owns, then the names its
   * prototype answers for.
   */
  cells(record: object): JsonCell[] {
    const out: JsonCell[] = [];
    const values = record as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(record)) {
      const name = this.byName.get(key);
      if (name !== undefined) keep(out, name, values[key]);
    }
    for (const [key, name] of this.answeredBy(Object.getPrototypeOf(record) as object | null)) {
      if (!Object.hasOwn(record, key)) keep(out, name, values[key]);
    }
    return out;
  }

  /** The record's non-null cells, as `record[columns[column]]` reads them. */
  fields(record: object): JsonField[] {
    const out: JsonField[] = [];
    for (const { name, value } of this.cells(record)) {
      for (const column of name.columns) out.push({ column, value });
    }
    return out;
  }

  private answeredBy(prototype: object | null): ReadonlyArray<readonly [string, JsonName]> {
    if (prototype === null) return [];
    const known = this.inherited.get(prototype);
    if (known !== undefined) return known;
    const names: Array<readonly [string, JsonName]> = [];
    for (const [key, name] of this.byName) if (key in prototype) names.push([key, name]);
    this.inherited.set(prototype, names);
    return names;
  }
}

function keep(out: JsonCell[], name: JsonName, value: unknown): void {
  if (value !== null && value !== undefined) out.push({ name, value });
}

/**
 * Every column's type from JSON records, in one pass over the cells they
 * hold: what `inferTypeFromJson(records.map((r) => r[column]))` answered for
 * each column, without asking each record for every column. A name listed
 * twice reads the same values into both its columns, so it is tallied once
 * and both columns get its type.
 */
export function inferJsonColumnTypes(
  columns: readonly string[],
  records: ReadonlyArray<object>,
): InferredType[] {
  const reader = new JsonColumns(columns);
  const tallies: Tally[] = reader.names.map(() => newTally());
  for (const record of records) {
    for (const { name, value } of reader.cells(record)) {
      const tally = tallies[name.index] as Tally;
      if (tally.allNumeric) countJson(tally, value);
    }
  }
  const types: InferredType[] = columns.map(() => "TEXT");
  for (const name of reader.names) {
    const type = decide(tallies[name.index] as Tally);
    for (const column of name.columns) types[column] = type;
  }
  return types;
}

/**
 * Why `record` cannot be stored, naming the first column that does not fit,
 * or undefined when every column does: what coercing `record[column]` for
 * each column in order, and stopping at the first failure, reported. A
 * column the record does not hold reads as undefined, which every type
 * accepts as NULL, so only the fields that are there can fail.
 *
 * The fields are coerced in column order, not the record's own key order,
 * and nothing past the first failure is touched: coercing can throw (a
 * TEXT value nested too deep for JSON.stringify), and a value the real
 * import never reaches must not fail the dry run.
 */
export function jsonRecordRejection(
  reader: JsonColumns,
  record: object,
  types: readonly InferredType[],
): string | undefined {
  const fields = reader.fields(record).sort((a, b) => a.column - b.column);
  for (const { column, value } of fields) {
    const coerced = coerceJsonValue(value, types[column] ?? "TEXT");
    if (!coerced.ok) return `field "${reader.columns[column]}": ${coerced.reason}`;
  }
  return undefined;
}

/** A value ready to bind, or the reason the cell could not be used. */
export type Coercion = { ok: true; value: string | number | null } | { ok: false; reason: string };

/**
 * Turn one CSV cell into a bindable value for a column of `type`.
 *
 * A cell that does not fit its column is a REJECTED ROW with a reason, not a
 * silent NULL and not a thrown exception: an import of ten thousand rows
 * where four are malformed should report those four, not fail or lie.
 */
export function coerceCsvCell(raw: string, type: InferredType, emptyIsNull: boolean): Coercion {
  if (raw === "" && emptyIsNull) return { ok: true, value: null };
  if (type === "TEXT") return { ok: true, value: raw };
  if (type === "INTEGER") {
    if (!looksInteger(raw)) {
      return { ok: false, reason: `"${clip(raw)}" is not an integer` };
    }
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) {
      // Beyond 2^53 the JS number is no longer the value that was written,
      // so bind the digits and let SQLite's INTEGER affinity convert them.
      return { ok: true, value: raw };
    }
    return { ok: true, value: n };
  }
  if (!looksReal(raw)) return { ok: false, reason: `"${clip(raw)}" is not a number` };
  return { ok: true, value: Number(raw) };
}

/** Keep a rejection reason short enough to repeat a thousand times. */
function clip(raw: string): string {
  return raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;
}

/**
 * The union of keys across JSON records, in first-appearance order across
 * records and key order within one. Deterministic for a given input, and it
 * does not require every record to carry every field.
 */
export function unionKeys(records: ReadonlyArray<Record<string, unknown>>): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return keys;
}

/**
 * SQLite's type-affinity rules, applied to a declared column type.
 *
 * These are the five rules from the SQLite documentation, in order, and the
 * order matters: `VARCHAR(20)` contains "CHAR" so it is TEXT, while
 * `INTEGER` contains "INT" so it is INTEGER, and a column declared with no
 * type at all has BLOB affinity (SQLite stores whatever you give it).
 *
 * The import tools use this to decide what a cell has to look like for a
 * column that already exists — without it they would have to re-guess the
 * type they were told.
 */
export function affinityOf(declaredType: string): "INTEGER" | "REAL" | "NUMERIC" | "TEXT" | "BLOB" {
  const type = declaredType.toUpperCase();
  if (type.includes("INT")) return "INTEGER";
  if (type.includes("CHAR") || type.includes("CLOB") || type.includes("TEXT")) return "TEXT";
  if (type === "" || type.includes("BLOB")) return "BLOB";
  if (type.includes("REAL") || type.includes("FLOA") || type.includes("DOUB")) return "REAL";
  return "NUMERIC";
}

/**
 * What a cell must parse as for a column of this affinity.
 *
 * BLOB affinity accepts anything, so it maps to TEXT (bind the string and
 * let SQLite store it). NUMERIC maps to REAL, whose check accepts integers
 * as well, so an integer into a NUMERIC column is not a rejection.
 */
export function checkTypeFor(affinity: ReturnType<typeof affinityOf>): InferredType {
  if (affinity === "INTEGER") return "INTEGER";
  if (affinity === "REAL" || affinity === "NUMERIC") return "REAL";
  return "TEXT";
}

/**
 * Turn one JSON value into something bindable for a column of `type`.
 *
 * Three conversions are made on purpose and are worth knowing about: a
 * boolean becomes 1 or 0, because SQLite has no boolean type; an object or
 * array becomes its JSON text, because SQLite has no nested types either;
 * and a numeric string is accepted for a numeric column, because JSON
 * exports routinely quote numbers. Everything else that does not fit is a
 * rejection with a reason rather than a silent NULL.
 */
export function coerceJsonValue(value: unknown, type: InferredType): Coercion {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value === "boolean") {
    return type === "TEXT"
      ? { ok: true, value: value ? "1" : "0" }
      : { ok: true, value: value ? 1 : 0 };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return { ok: false, reason: `${String(value)} is not a finite number` };
    }
    if (type === "INTEGER" && !Number.isInteger(value)) {
      return { ok: false, reason: `${value} is not an integer` };
    }
    return type === "TEXT" ? { ok: true, value: String(value) } : { ok: true, value };
  }
  if (typeof value === "bigint") {
    if (type === "TEXT") return { ok: true, value: value.toString() };
    return coerceCsvCell(value.toString(), type, false);
  }
  if (typeof value === "string") {
    if (type === "TEXT") return { ok: true, value };
    return coerceCsvCell(value, type, false);
  }
  if (typeof value === "object") {
    if (type !== "TEXT") {
      return {
        ok: false,
        reason: `a ${Array.isArray(value) ? "array" : "object"} cannot go in a numeric column`,
      };
    }
    return { ok: true, value: JSON.stringify(value) };
  }
  return { ok: false, reason: `values of type ${typeof value} cannot be stored` };
}
