/**
 * Comparing two SQLite schemas, and the shapes both `SchemaDescribe` and
 * `SchemaDiff` report.
 *
 * The comparison is structural where structure is available — a table's
 * columns come from `PRAGMA table_info`, so they compare field by field —
 * and textual for everything else, because SQLite stores an index's or a
 * trigger's definition only as the DDL text the author wrote. Textual
 * comparison after whitespace collapsing means two definitions that differ
 * only in formatting compare equal, and two that differ only in a comment do
 * not. That limit is reported rather than papered over.
 *
 * Pure: takes two already-read snapshots and returns the difference.
 */
import { normalizeDdl } from "./sql-text";

/** One row of `PRAGMA table_info`, in the shape the tools report. */
export type ColumnInfo = {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly defaultValue: string | null;
  /** 0 when the column is not part of the primary key, else its 1-based position. */
  readonly primaryKey: number;
};

/** A table, view, index or trigger as `sqlite_master` records it. */
export type SchemaObject = {
  readonly type: "table" | "view" | "index" | "trigger";
  readonly name: string;
  readonly tableName: string;
  /** The DDL text, or null for an index SQLite created implicitly. */
  readonly sql: string | null;
};

/** Everything `SchemaDiff` needs from one database. */
export type SchemaSnapshot = {
  readonly objects: readonly SchemaObject[];
  /** Columns per table or view name. */
  readonly columns: Readonly<Record<string, readonly ColumnInfo[]>>;
};

export type ColumnChange = {
  readonly column: string;
  readonly field: "type" | "notNull" | "defaultValue" | "primaryKey" | "position";
  readonly left: string;
  readonly right: string;
};

export type ObjectChange = {
  readonly type: SchemaObject["type"];
  readonly name: string;
  /** Set when the stored DDL differs after whitespace collapsing. */
  readonly sqlChanged: boolean;
  readonly columnsOnlyInLeft: readonly string[];
  readonly columnsOnlyInRight: readonly string[];
  readonly columnChanges: readonly ColumnChange[];
};

export type SchemaDifference = {
  readonly onlyInLeft: readonly SchemaObject[];
  readonly onlyInRight: readonly SchemaObject[];
  readonly changed: readonly ObjectChange[];
  readonly identical: boolean;
};

const objectKey = (o: SchemaObject): string => `${o.type}:${o.name}`;

/** Order objects the way both `SchemaList` and `SchemaDiff` report them. */
export function compareObjects(a: SchemaObject, b: SchemaObject): number {
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return 0;
}

/**
 * Difference `left` from `right`. Every list comes back sorted by plain
 * codepoint comparison — no `localeCompare`, so the answer does not depend
 * on the operator's locale.
 */
export function diffSchemas(left: SchemaSnapshot, right: SchemaSnapshot): SchemaDifference {
  const leftByKey = new Map(left.objects.map((o) => [objectKey(o), o]));
  const rightByKey = new Map(right.objects.map((o) => [objectKey(o), o]));

  const onlyInLeft: SchemaObject[] = [];
  const onlyInRight: SchemaObject[] = [];
  const changed: ObjectChange[] = [];

  for (const [key, object] of leftByKey) {
    if (!rightByKey.has(key)) onlyInLeft.push(object);
  }
  for (const [key, object] of rightByKey) {
    if (!leftByKey.has(key)) onlyInRight.push(object);
  }
  for (const [key, leftObject] of leftByKey) {
    const rightObject = rightByKey.get(key);
    if (rightObject === undefined) continue;
    const sqlChanged = normalizeDdl(leftObject.sql ?? "") !== normalizeDdl(rightObject.sql ?? "");
    const leftColumns = left.columns[leftObject.name] ?? [];
    const rightColumns = right.columns[rightObject.name] ?? [];
    const columnDiff = diffColumns(leftColumns, rightColumns);
    if (
      sqlChanged ||
      columnDiff.onlyInLeft.length > 0 ||
      columnDiff.onlyInRight.length > 0 ||
      columnDiff.changes.length > 0
    ) {
      changed.push({
        type: leftObject.type,
        name: leftObject.name,
        sqlChanged,
        columnsOnlyInLeft: columnDiff.onlyInLeft,
        columnsOnlyInRight: columnDiff.onlyInRight,
        columnChanges: columnDiff.changes,
      });
    }
  }

  onlyInLeft.sort(compareObjects);
  onlyInRight.sort(compareObjects);
  changed.sort((a, b) =>
    a.type !== b.type ? (a.type < b.type ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return {
    onlyInLeft,
    onlyInRight,
    changed,
    identical: onlyInLeft.length === 0 && onlyInRight.length === 0 && changed.length === 0,
  };
}

/** Column-level difference between two tables of the same name. */
export function diffColumns(
  left: readonly ColumnInfo[],
  right: readonly ColumnInfo[],
): { onlyInLeft: string[]; onlyInRight: string[]; changes: ColumnChange[] } {
  const leftByName = new Map(left.map((c, index) => [c.name, { column: c, index }]));
  const rightByName = new Map(right.map((c, index) => [c.name, { column: c, index }]));
  const onlyInLeft: string[] = [];
  const onlyInRight: string[] = [];
  const changes: ColumnChange[] = [];
  for (const [name] of leftByName) if (!rightByName.has(name)) onlyInLeft.push(name);
  for (const [name] of rightByName) if (!leftByName.has(name)) onlyInRight.push(name);
  for (const [name, l] of leftByName) {
    const r = rightByName.get(name);
    if (r === undefined) continue;
    const add = (field: ColumnChange["field"], a: unknown, b: unknown): void => {
      changes.push({ column: name, field, left: String(a), right: String(b) });
    };
    // Type comparison is case-insensitive because `TEXT` and `text` are the
    // same declared type to SQLite, and a migration that only changes the
    // case of a keyword is not a schema change.
    if (l.column.type.toUpperCase() !== r.column.type.toUpperCase()) {
      add("type", l.column.type, r.column.type);
    }
    if (l.column.notNull !== r.column.notNull) add("notNull", l.column.notNull, r.column.notNull);
    if (l.column.defaultValue !== r.column.defaultValue) {
      add("defaultValue", l.column.defaultValue, r.column.defaultValue);
    }
    if (l.column.primaryKey !== r.column.primaryKey) {
      add("primaryKey", l.column.primaryKey, r.column.primaryKey);
    }
    if (l.index !== r.index) add("position", l.index, r.index);
  }
  onlyInLeft.sort();
  onlyInRight.sort();
  changes.sort((a, b) =>
    a.column !== b.column
      ? a.column < b.column
        ? -1
        : 1
      : a.field < b.field
        ? -1
        : a.field > b.field
          ? 1
          : 0,
  );
  return { onlyInLeft, onlyInRight, changes };
}
