/**
 * Reading a database's own description of itself.
 *
 * Every read here goes through SQLite's pragma TABLE-VALUED functions
 * (`pragma_table_info(?)` rather than `PRAGMA table_info(name)`), which
 * accept bound parameters. That matters: the classic shape of this code
 * interpolates a table name into a PRAGMA, and a table name is a caller
 * value. Using the table-valued form means schema introspection in this
 * package interpolates nothing at all — the only place any identifier is
 * still written into SQL is the row count in `TableStats`, where the name
 * came out of `sqlite_schema` a moment earlier and is quoted on the way in.
 *
 * Everything is ordered by plain codepoint comparison so two runs against
 * the same file return the same bytes.
 */
import type { Database } from "bun:sqlite";
import { shapeValue } from "./db";
import type { ColumnInfo, SchemaObject, SchemaSnapshot } from "./lib/schema-diff";
import { compareObjects } from "./lib/schema-diff";
import { quoteIdentifier } from "./lib/sql-text";

/** The object kinds `sqlite_schema` records. */
export const OBJECT_TYPES = ["table", "view", "index", "trigger"] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

type MasterRow = { type: string; name: string; tbl_name: string; sql: string | null };

/**
 * Every object in the schema, minus SQLite's own bookkeeping.
 *
 * `sqlite_*` names are reserved for the engine (`sqlite_sequence`,
 * `sqlite_stat1`, the implicit autoindexes) and are internal detail rather
 * than part of anybody's schema, so they are left out by default and can be
 * asked for explicitly.
 */
export function readObjects(db: Database, includeInternal = false): SchemaObject[] {
  const rows = db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE type IN ('table','view','index','trigger')",
    )
    .all() as MasterRow[];
  const objects: SchemaObject[] = [];
  for (const row of rows) {
    if (!includeInternal && row.name.startsWith("sqlite_")) continue;
    objects.push({
      type: row.type as ObjectType,
      name: row.name,
      tableName: row.tbl_name,
      sql: row.sql,
    });
  }
  objects.sort(compareObjects);
  return objects;
}

type TableInfoRow = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

/**
 * One table's or view's columns, in declaration order.
 *
 * Declaration order, not sorted order: for a table it is part of the schema
 * (it decides what `INSERT` without a column list means), so sorting it
 * would destroy information. The order is a property of the database, so the
 * result is still the same for the same file.
 */
export function readColumns(db: Database, table: string): ColumnInfo[] {
  const rows = db.prepare("SELECT * FROM pragma_table_info(?)").all(table) as TableInfoRow[];
  return rows.map((row) => ({
    name: row.name,
    type: row.type,
    notNull: row.notnull !== 0,
    defaultValue: row.dflt_value,
    primaryKey: row.pk,
  }));
}

export type ForeignKey = {
  readonly column: string;
  readonly referencesTable: string;
  readonly referencesColumn: string | null;
  readonly onUpdate: string;
  readonly onDelete: string;
};

/** One table's outgoing foreign keys, ordered by the local column name. */
export function readForeignKeys(db: Database, table: string): ForeignKey[] {
  const rows = db.prepare("SELECT * FROM pragma_foreign_key_list(?)").all(table) as Array<{
    table: string;
    from: string;
    to: string | null;
    on_update: string;
    on_delete: string;
  }>;
  const keys = rows.map((row) => ({
    column: row.from,
    referencesTable: row.table,
    referencesColumn: row.to,
    onUpdate: row.on_update,
    onDelete: row.on_delete,
  }));
  keys.sort((a, b) => (a.column < b.column ? -1 : a.column > b.column ? 1 : 0));
  return keys;
}

export type IndexInfo = {
  readonly name: string;
  readonly unique: boolean;
  /** "c" declared by CREATE INDEX, "u" from UNIQUE, "pk" from PRIMARY KEY. */
  readonly origin: string;
  readonly partial: boolean;
  readonly columns: readonly string[];
};

/** One table's indexes, ordered by name. */
export function readIndexes(db: Database, table: string): IndexInfo[] {
  const rows = db.prepare("SELECT * FROM pragma_index_list(?)").all(table) as Array<{
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }>;
  const indexes = rows.map((row) => {
    const parts = db.prepare("SELECT * FROM pragma_index_xinfo(?)").all(row.name) as Array<{
      name: string | null;
      key: number;
    }>;
    return {
      name: row.name,
      unique: row.unique !== 0,
      origin: row.origin,
      partial: row.partial !== 0,
      // `key: 0` rows are the rowid SQLite appends to every index; they are
      // not part of what the author indexed.
      columns: parts.filter((p) => p.key === 1 && p.name !== null).map((p) => p.name as string),
    };
  });
  indexes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return indexes;
}

/** A whole snapshot, for `SchemaDiff`. */
export function readSnapshot(db: Database, includeInternal = false): SchemaSnapshot {
  const objects = readObjects(db, includeInternal);
  const columns: Record<string, ColumnInfo[]> = {};
  for (const object of objects) {
    if (object.type === "table" || object.type === "view") {
      columns[object.name] = readColumns(db, object.name);
    }
  }
  return { objects, columns };
}

/**
 * The database's own spelling of an object's name, or undefined when it has
 * no such object. Bound, never interpolated.
 *
 * The match is `COLLATE NOCASE` because SQLite's own identifier resolution
 * is: `SELECT * FROM USERS` reads the table declared as `users`, so a tool
 * that answered "no such table" for `USERS` would be refusing a name the
 * engine accepts. NOCASE folds exactly the ASCII range SQLite folds, so the
 * two agree on every name, including the non-ASCII ones neither folds.
 * The stored spelling is what comes back, because that is the one to report
 * and the one to write into an INSERT.
 */
export function findObjectName(
  db: Database,
  name: string,
  types: readonly string[],
): string | undefined {
  const placeholders = types.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT name FROM sqlite_schema WHERE name = ? COLLATE NOCASE AND type IN (${placeholders}) ORDER BY name`,
    )
    .get(name, ...types) as { name: string } | null;
  return row === null || row === undefined ? undefined : row.name;
}

/** True when an object of `type` and `name` exists. Bound, never interpolated. */
export function objectExists(db: Database, name: string, types: readonly string[]): boolean {
  return findObjectName(db, name, types) !== undefined;
}

export type TableSize = {
  readonly name: string;
  readonly rows: number | string;
  /** Bytes on disk, when the `dbstat` module is compiled in. */
  readonly bytes?: number;
  readonly pages?: number;
};

/**
 * Per-table row counts and, when `dbstat` is available, on-disk size.
 *
 * The row count is an exact `count(*)`, which means a full scan of every
 * table — accurate, and O(rows). On a large database that is the expensive
 * part of this tool, which is why `TableStats` says so in its description
 * and why the deadline is checked between tables.
 *
 * `dbstat` is an optional SQLite module. When it is missing the sizes are
 * simply absent rather than estimated from page counts, because an estimate
 * nobody can tell from a measurement is worse than no number.
 */
export function readTableSizes(
  db: Database,
  tables: readonly string[],
  shouldStop: () => boolean,
): { sizes: TableSize[]; stoppedAfter?: number; dbstat: boolean } {
  const bytesByName = new Map<string, { bytes: number; pages: number }>();
  let dbstat = true;
  try {
    const rows = db
      .prepare("SELECT name, SUM(pgsize) AS bytes, COUNT(*) AS pages FROM dbstat GROUP BY name")
      .all() as Array<{ name: string; bytes: number | null; pages: number }>;
    for (const row of rows) {
      bytesByName.set(row.name, { bytes: row.bytes ?? 0, pages: row.pages });
    }
  } catch {
    dbstat = false;
  }
  const sizes: TableSize[] = [];
  let stoppedAfter: number | undefined;
  for (const name of tables) {
    if (shouldStop()) {
      stoppedAfter = sizes.length;
      break;
    }
    // The only identifier interpolation in this package. `name` came from
    // `sqlite_schema` on the line above, and `quoteIdentifier` throws on
    // anything it cannot quote safely.
    const size = bytesByName.get(name);
    let counted: number | string;
    try {
      const countRow = db.prepare(`SELECT count(*) AS n FROM ${quoteIdentifier(name)}`).get() as {
        n: number | bigint;
      } | null;
      counted = (shapeValue(countRow?.n ?? 0) as number | string) ?? 0;
    } catch (err) {
      // One unreadable table — a virtual table whose module is not compiled
      // in, most often — is a fact about that table, not a reason to fail
      // the whole listing.
      counted = `unreadable: ${err instanceof Error ? err.message : String(err)}`;
    }
    sizes.push({
      name,
      rows: counted,
      ...(size === undefined ? {} : { bytes: size.bytes, pages: size.pages }),
    });
  }
  return stoppedAfter === undefined ? { sizes, dbstat } : { sizes, stoppedAfter, dbstat };
}
