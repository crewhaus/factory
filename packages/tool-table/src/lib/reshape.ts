/**
 * Reshaping and splitting tables.
 *
 * Wide-to-long and long-to-wide are the two transforms SQL cannot express
 * without already knowing the distinct values, and they are exactly what
 * stands between an export and a usable dataset. Sharding is here because a
 * file too large to process in one pass is a practical problem with a
 * mechanical answer.
 */

export type Row = Readonly<Record<string, string>>;

/**
 * Wide to long: one row per (identifier, variable, value).
 *
 * A cell that is empty is dropped by default. A wide export usually has a
 * column per period and most cells empty, and keeping them turns a small
 * table into a huge one whose rows say nothing.
 */
export function toLong(
  rows: ReadonlyArray<Row>,
  idColumns: ReadonlyArray<string>,
  valueColumns: ReadonlyArray<string>,
  options: { variableName?: string; valueName?: string; keepEmpty?: boolean } = {},
): Row[] {
  const variableName = options.variableName ?? "variable";
  const valueName = options.valueName ?? "value";
  if (idColumns.includes(variableName) || idColumns.includes(valueName)) {
    throw new Error(
      `"${variableName}" and "${valueName}" name the output columns, so they cannot also be identifier columns — rename one`,
    );
  }
  const out: Row[] = [];
  for (const row of rows) {
    const identity: Record<string, string> = {};
    for (const column of idColumns) identity[column] = row[column] ?? "";
    for (const column of valueColumns) {
      const value = row[column] ?? "";
      if (value === "" && options.keepEmpty !== true) continue;
      out.push({ ...identity, [variableName]: column, [valueName]: value });
    }
  }
  return out;
}

export type WideResult = {
  readonly rows: ReadonlyArray<Row>;
  readonly columns: ReadonlyArray<string>;
  /** (identifier, variable) pairs that appeared more than once. */
  readonly collisions: ReadonlyArray<{
    readonly key: string;
    readonly variable: string;
    readonly count: number;
  }>;
};

/**
 * Long to wide: one column per distinct variable.
 *
 * A repeated (identifier, variable) pair is a collision — the shape does not
 * say which value wins. The first is kept and every collision is reported,
 * because silently taking the last would make a pivot that looks complete
 * and is wrong in a way nothing downstream can detect.
 */
/**
 * How many distinct values may become columns.
 *
 * Pivoting on a high-cardinality column is almost always a mistake — an id
 * or a timestamp produces a column per row — and the result is a table
 * nobody can read rather than an error anybody notices.
 */
const MAX_PIVOT_COLUMNS = 2_048;

export function toWide(
  rows: ReadonlyArray<Row>,
  idColumns: ReadonlyArray<string>,
  variableColumn: string,
  valueColumn: string,
  options: { fill?: string; maxColumns?: number } = {},
): WideResult {
  const fill = options.fill ?? "";
  const maxColumns = options.maxColumns ?? MAX_PIVOT_COLUMNS;
  const byKey = new Map<
    string,
    { identity: Record<string, string>; values: Map<string, string> }
  >();
  const variables = new Set<string>();
  const collisions: Array<{ key: string; variable: string; count: number }> = [];
  const counts = new Map<string, number>();

  for (const row of rows) {
    const identity: Record<string, string> = {};
    for (const column of idColumns) identity[column] = row[column] ?? "";
    const key = JSON.stringify(idColumns.map((c) => identity[c]));
    const variable = row[variableColumn] ?? "";
    if (variable === "") continue;
    variables.add(variable);

    const pair = `${key}\t${variable}`;
    counts.set(pair, (counts.get(pair) ?? 0) + 1);

    let bucket = byKey.get(key);
    if (bucket === undefined) {
      bucket = { identity, values: new Map() };
      byKey.set(key, bucket);
    }
    if (!bucket.values.has(variable)) bucket.values.set(variable, row[valueColumn] ?? "");
  }

  if (variables.size > maxColumns) {
    throw new Error(
      `"${variableColumn}" has ${variables.size} distinct values, so pivoting on it would make ${variables.size} columns (limit ${maxColumns}) — that is usually an id or a timestamp rather than a category`,
    );
  }

  for (const [pair, count] of counts) {
    if (count <= 1) continue;
    const [key = "", variable = ""] = pair.split("\t");
    collisions.push({ key, variable, count });
  }

  const ordered = [...variables].sort();
  const out: Row[] = [];
  for (const bucket of byKey.values()) {
    const row: Record<string, string> = { ...bucket.identity };
    for (const variable of ordered) row[variable] = bucket.values.get(variable) ?? fill;
    out.push(row);
  }
  return { rows: out, columns: [...idColumns, ...ordered], collisions };
}

export type Shard = {
  readonly index: number;
  readonly rows: number;
  readonly bytes: number;
  readonly firstRow: number;
};

/**
 * Split rows into shards, each carrying the header.
 *
 * Every shard is independently readable. A split that put the header only on
 * the first piece produces one usable file and N-1 that need it grafted back
 * on, which is how a column ends up shifted.
 */
export function shardRows(
  header: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  options: { maxRows?: number; maxBytes?: number },
): { shards: Shard[]; bodies: string[] } {
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  if (maxRows === Number.POSITIVE_INFINITY && maxBytes === Number.POSITIVE_INFINITY) {
    throw new Error("give maxRows or maxBytes, or every row lands in one shard");
  }
  const quote = (cell: string): string =>
    /[",\n\r]/.test(cell) ? `"${cell.split('"').join('""')}"` : cell;
  const line = (cells: ReadonlyArray<string>): string => cells.map(quote).join(",");
  const headerLine = `${line(header)}\n`;

  const shards: Shard[] = [];
  const bodies: string[] = [];
  let current: string[] = [];
  let bytes = Buffer.byteLength(headerLine);
  let firstRow = 1;

  const flush = (): void => {
    if (current.length === 0) return;
    shards.push({ index: shards.length, rows: current.length, bytes, firstRow });
    bodies.push(headerLine + current.join(""));
    current = [];
    bytes = Buffer.byteLength(headerLine);
  };

  for (const [i, row] of rows.entries()) {
    const text = `${line(row)}\n`;
    const size = Buffer.byteLength(text);
    if (current.length > 0 && (current.length + 1 > maxRows || bytes + size > maxBytes)) {
      flush();
      firstRow = i + 1;
    }
    current.push(text);
    bytes += size;
  }
  flush();
  return { shards, bodies };
}

export type FixedField = {
  readonly name: string;
  /** 1-based, inclusive, as a copybook or layout document states them. */
  readonly start: number;
  readonly length: number;
  readonly trim?: boolean;
};

/**
 * Parse a fixed-width extract.
 *
 * Positions are 1-based and inclusive because that is how every layout
 * document, copybook and mainframe spec states them; converting in your head
 * is how a field ends up one character off down the whole file.
 */
export function parseFixedWidth(
  text: string,
  fields: ReadonlyArray<FixedField>,
  options: { skipLines?: number } = {},
): { rows: Row[]; shortLines: Array<{ line: number; length: number }> } {
  if (fields.length === 0) throw new Error("a fixed-width layout needs at least one field");
  for (const field of fields) {
    if (field.start < 1)
      throw new Error(`field "${field.name}" starts at ${field.start}; positions are 1-based`);
    if (field.length < 1) throw new Error(`field "${field.name}" has length ${field.length}`);
  }
  const needed = Math.max(...fields.map((f) => f.start + f.length - 1));

  const rows: Row[] = [];
  const shortLines: Array<{ line: number; length: number }> = [];
  const lines = text.split(/\r?\n/).slice(options.skipLines ?? 0);

  for (const [i, raw] of lines.entries()) {
    if (raw.trim() === "") continue;
    // A short line is reported rather than padded: silently padding turns a
    // truncated record into one with empty trailing fields, which reads as
    // real data.
    if (raw.length < needed)
      shortLines.push({ line: i + 1 + (options.skipLines ?? 0), length: raw.length });
    const row: Record<string, string> = {};
    for (const field of fields) {
      const value = raw.slice(field.start - 1, field.start - 1 + field.length);
      row[field.name] = field.trim === false ? value : value.trim();
    }
    rows.push(row);
  }
  return { rows, shortLines };
}
