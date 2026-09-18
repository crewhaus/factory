/**
 * CSV, the RFC 4180 subset that real exports actually use.
 *
 * Quoted fields, doubled quotes inside them, embedded newlines, CRLF or LF
 * line endings, and a final newline that is not a trailing empty row. No
 * dialect sniffing, no type guessing, no BOM rewriting beyond stripping a
 * leading UTF-8 BOM — the parser hands back strings and `../lib/infer.ts`
 * decides what they mean.
 *
 * Pure: no I/O, no clock. The import tools stream a file through it.
 */

/** One parsed record, with the 1-based line the record started on. */
export type CsvRecord = {
  readonly line: number;
  readonly values: readonly string[];
  /**
   * True for a line that held nothing at all — no delimiter, no quote, no
   * character. A file ending in two newlines produces one, and a reader
   * that treats it as a record reports a phantom malformed row. Callers
   * skip these; a genuinely empty single-column value has to be written as
   * `""` to be told apart, which is what quoting is for.
   */
  readonly blank: boolean;
};

export type CsvParse = {
  readonly records: readonly CsvRecord[];
  /** True when a quoted field was still open at end of input. */
  readonly unterminatedQuote: boolean;
};

/**
 * Parse `text` into records. Every field comes back as a string; an empty
 * unquoted field and an empty quoted field are both `""`, because CSV cannot
 * distinguish them and pretending otherwise would be a guess — except that a
 * line holding literally nothing is marked `blank`, so a trailing newline
 * does not become a malformed row.
 */
export function parseCsv(text: string, delimiter = ","): CsvParse {
  if (delimiter.length !== 1) throw new Error("delimiter must be a single character");
  if (delimiter === '"' || delimiter === "\r" || delimiter === "\n") {
    throw new Error("delimiter may not be a quote or a line ending");
  }
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: CsvRecord[] = [];
  let values: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let sawAnything = false;
  let sawStructure = false;
  const endField = (): void => {
    values.push(field);
    field = "";
  };
  const endRecord = (): void => {
    endField();
    records.push({
      line: recordLine,
      values,
      blank: !sawStructure && values.length === 1 && values[0] === "",
    });
    values = [];
    sawAnything = false;
    sawStructure = false;
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i] as string;
    if (!sawAnything && !inQuotes) {
      recordLine = line;
      sawAnything = true;
    }
    if (inQuotes) {
      sawStructure = true;
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
          continue;
        }
        inQuotes = false;
        continue;
      }
      if (ch === "\n") line += 1;
      field += ch;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      sawStructure = true;
      continue;
    }
    if (ch === delimiter) {
      sawStructure = true;
      endField();
      continue;
    }
    if (ch === "\r") {
      // Swallow CR only when it is part of a CRLF; a lone CR inside a field
      // is data, and a file that uses lone CRs as line endings is not CSV.
      if (source[i + 1] === "\n") continue;
      field += ch;
      continue;
    }
    if (ch === "\n") {
      endRecord();
      line += 1;
      continue;
    }
    sawStructure = true;
    field += ch;
  }
  // A trailing newline closed the last record already; anything left over is
  // a final record with no line terminator.
  if (sawAnything || field !== "" || values.length > 0 || inQuotes) endRecord();
  return { records, unterminatedQuote: inQuotes };
}

/**
 * Render one CSV row. A field is quoted when it contains the delimiter, a
 * quote, a CR or an LF — and never otherwise, so a rendered file round-trips
 * through `parseCsv` byte for byte.
 */
export function formatCsvRow(values: readonly string[], delimiter = ","): string {
  return values
    .map((value) => {
      const needsQuotes =
        value.includes(delimiter) ||
        value.includes('"') ||
        value.includes("\n") ||
        value.includes("\r");
      return needsQuotes ? `"${value.replace(/"/g, '""')}"` : value;
    })
    .join(delimiter);
}

/**
 * The text a SQLite value takes in a CSV cell.
 *
 * NULL becomes the empty string, which is CSV's only spelling for absent and
 * is therefore indistinguishable from an empty TEXT value on the way back —
 * the export tools say so rather than inventing a sentinel. A BLOB becomes
 * base64, marked so a reader is not left guessing whether it is text.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value instanceof Uint8Array) return `base64:${toBase64(value)}`;
  return String(value);
}

/**
 * Base64 without spreading the array into `fromCharCode`, which overflows the
 * argument stack somewhere around a hundred thousand bytes — a size a BLOB
 * column reaches easily.
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
