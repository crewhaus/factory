/**
 * CSV reading and writing to RFC 4180, plus the two departures from it that
 * real files require: a configurable delimiter (tab, semicolon, pipe) and
 * tolerance of bare LF line endings as well as CRLF.
 *
 * What is handled: quoted fields, delimiters and newlines inside quotes,
 * doubled quotes as an escaped quote, a final row with no trailing newline,
 * a row that is a single quoted empty field (`""`, which is a row and not a
 * blank line), and ragged rows (reported, not silently padded, unless
 * asked).
 *
 * What is not: a byte-order mark is stripped but other encodings are the
 * caller's problem, and there is no support for backslash escapes, which
 * RFC 4180 does not define.
 */

export type CsvParseOptions = {
  delimiter: string;
  quote: string;
  /** Drop lines that are entirely empty, rather than yielding a one-empty-field row. */
  skipEmptyLines: boolean;
  /** Trim surrounding whitespace from every unquoted field. Quoted fields are never trimmed. */
  trim: boolean;
  /** Stop after this many rows (header included) and report the truncation. */
  maxRows: number;
};

export type CsvParseResult = {
  rows: string[][];
  truncated: boolean;
};

export class CsvError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(message);
    this.line = line;
  }
}

/** Split CSV text into rows of raw string fields. Throws `CsvError` on an unterminated quote. */
export function parseCsv(text: string, options: CsvParseOptions): CsvParseResult {
  const { delimiter, quote } = options;
  if (delimiter.length !== 1) throw new CsvError("delimiter must be a single character", 0);
  if (quote.length !== 1) throw new CsvError("quote must be a single character", 0);
  if (delimiter === quote) throw new CsvError("delimiter and quote must differ", 0);

  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldWasQuoted = false;
  // Whether anything in the current row was written with quotes. A row that
  // is a single *quoted* empty field (`""`) is a real one-field row and must
  // not be mistaken for a blank line.
  let rowHadQuote = false;
  let line = 1;
  // Where the currently-open quote started, so an unterminated one points at
  // the opening quote rather than at the end of the file.
  let quoteStartLine = 1;
  let truncated = false;

  const endField = (): void => {
    row.push(options.trim && !fieldWasQuoted ? field.trim() : field);
    field = "";
    fieldWasQuoted = false;
  };
  const endRow = (): boolean => {
    endField();
    const blank = row.length === 1 && row[0] === "" && !rowHadQuote;
    if (!(options.skipEmptyLines && blank)) rows.push(row);
    row = [];
    rowHadQuote = false;
    if (rows.length >= options.maxRows) {
      truncated = true;
      return false;
    }
    return true;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (quoted) {
      if (c === quote) {
        if (src[i + 1] === quote) {
          field += quote;
          i += 1;
          continue;
        }
        quoted = false;
        continue;
      }
      if (c === "\n") line += 1;
      field += c;
      continue;
    }
    if (c === quote && field === "" && !fieldWasQuoted) {
      quoted = true;
      fieldWasQuoted = true;
      rowHadQuote = true;
      quoteStartLine = line;
      continue;
    }
    if (c === delimiter) {
      endField();
      continue;
    }
    if (c === "\r") {
      if (src[i + 1] === "\n") i += 1;
      line += 1;
      if (!endRow()) return { rows, truncated };
      continue;
    }
    if (c === "\n") {
      line += 1;
      if (!endRow()) return { rows, truncated };
      continue;
    }
    field += c;
  }
  if (quoted) {
    throw new CsvError(
      `unterminated quoted field — the quote opened on line ${quoteStartLine} is never closed`,
      quoteStartLine,
    );
  }
  // A trailing newline should not manufacture an extra empty row — but a
  // final `""` is a row, so the quote flag has to be part of the test.
  if (field !== "" || row.length > 0 || fieldWasQuoted) endRow();
  return { rows, truncated };
}

/**
 * Best-effort scalar typing of a CSV cell: integers and decimals become
 * numbers, `true`/`false` (any case) become booleans, an empty cell and the
 * configured null tokens become null, everything else stays a string.
 *
 * Leading zeros (`007`), leading `+`, and values outside the safe integer
 * range stay strings, because turning a zip code or an account number into a
 * number loses data.
 */
export function inferScalar(raw: string, nullTokens: ReadonlyArray<string>): unknown {
  const s = raw.trim();
  if (s === "") return null;
  if (nullTokens.includes(s)) return null;
  const lower = s.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  if (/^-?(0|[1-9][0-9]*)$/.test(s)) {
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : raw;
  }
  if (/^-?(0|[1-9][0-9]*)\.[0-9]+$/.test(s)) return Number(s);
  return raw;
}

/** Turn rows into records using the first row as the header. */
export function rowsToRecords(
  rows: ReadonlyArray<ReadonlyArray<string>>,
  header: ReadonlyArray<string>,
  infer: boolean,
  nullTokens: ReadonlyArray<string>,
): { records: Record<string, unknown>[]; ragged: number[] } {
  const records: Record<string, unknown>[] = [];
  const ragged: number[] = [];
  rows.forEach((row, i) => {
    if (row.length !== header.length) ragged.push(i);
    const rec: Record<string, unknown> = {};
    header.forEach((name, j) => {
      const cell = row[j];
      if (cell === undefined) {
        rec[name] = null;
        return;
      }
      rec[name] = infer ? inferScalar(cell, nullTokens) : cell;
    });
    records.push(rec);
  });
  return { records, ragged };
}

/**
 * Make header names unique and non-empty, so records never lose a column.
 *
 * The suffix is bumped until the name is genuinely unused, not merely until
 * the base name's counter advances: `a, a, a_2` has to come back as
 * `a, a_2, a_3`, because emitting `a_2` twice would collapse two columns
 * into one when the rows are turned into records.
 */
export function normalizeHeader(raw: ReadonlyArray<string>): string[] {
  const counts = new Map<string, number>();
  const taken = new Set<string>();
  return raw.map((name, i) => {
    const base = name.trim() === "" ? `column${i + 1}` : name.trim();
    let count = counts.get(base) ?? 0;
    let candidate = count === 0 ? base : `${base}_${count + 1}`;
    while (taken.has(candidate)) {
      count += 1;
      candidate = `${base}_${count + 1}`;
    }
    counts.set(base, count + 1);
    taken.add(candidate);
    return candidate;
  });
}

export type CsvWriteOptions = {
  delimiter: string;
  quote: string;
  /** "\n" or "\r\n"; RFC 4180 specifies CRLF, but LF is what most tools now emit. */
  newline: string;
  /** Quote every field, not only the ones that need it. */
  quoteAll: boolean;
  header: string[] | null;
};

/** Quote a single field if it contains the delimiter, a quote, or a line break. */
export function escapeCsvField(value: string, options: CsvWriteOptions): string {
  const needs =
    options.quoteAll ||
    value.includes(options.delimiter) ||
    value.includes(options.quote) ||
    value.includes("\n") ||
    value.includes("\r");
  if (!needs) return value;
  const q = options.quote;
  return q + value.split(q).join(q + q) + q;
}

/**
 * Render a cell value. `null` and `undefined` become the empty field;
 * objects and arrays become their compact JSON, because silently emitting
 * `[object Object]` is how a pipeline loses data without noticing.
 */
export function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** Serialize rows of already-stringified cells. */
export function writeCsvRows(
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  options: CsvWriteOptions,
): string {
  const lines: string[] = [];
  if (options.header !== null) {
    lines.push(options.header.map((h) => escapeCsvField(h, options)).join(options.delimiter));
  }
  for (const row of rows) {
    lines.push(
      row.map((cell) => escapeCsvField(cellToString(cell), options)).join(options.delimiter),
    );
  }
  return lines.join(options.newline);
}

/** Column order for a set of records: keys in first-seen order across every record. */
export function unionKeys(records: ReadonlyArray<Record<string, unknown>>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rec of records) {
    for (const k of Object.keys(rec)) {
      if (!seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    }
  }
  return out;
}
