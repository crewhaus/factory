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

/** True for a decimal integer SQLite will store as INTEGER without loss. */
export function looksInteger(raw: string): boolean {
  if (!/^[+-]?[0-9]+$/.test(raw)) return false;
  // Past 2^63 SQLite stores the value as REAL, which is not what the column
  // type would promise, so those stay TEXT and keep their exact digits.
  const n = BigInt(raw);
  return n >= -(2n ** 63n) && n <= 2n ** 63n - 1n;
}

/** True for a value SQLite will store as REAL. Excludes Inf and NaN. */
export function looksReal(raw: string): boolean {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw)) return false;
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
  let sawValue = false;
  let allInteger = true;
  let allNumeric = true;
  for (const raw of values) {
    if (raw === "" && emptyIsNull) continue;
    sawValue = true;
    if (!looksInteger(raw)) allInteger = false;
    if (!looksReal(raw)) allNumeric = false;
    if (!allNumeric) break;
  }
  if (!sawValue) return "TEXT";
  if (allInteger) return "INTEGER";
  if (allNumeric) return "REAL";
  return "TEXT";
}

/** Infer one column's type from already-typed JSON values. */
export function inferTypeFromJson(values: readonly unknown[]): InferredType {
  let sawValue = false;
  let allInteger = true;
  let allNumeric = true;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    sawValue = true;
    if (typeof value === "number" && Number.isFinite(value)) {
      if (!Number.isInteger(value)) allInteger = false;
    } else if (typeof value === "bigint") {
      // still integral
    } else if (typeof value === "boolean") {
      // SQLite has no boolean; true/false land in an INTEGER column as 1/0.
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
