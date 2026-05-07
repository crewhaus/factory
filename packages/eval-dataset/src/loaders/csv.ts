import { basename } from "node:path";
import { DatasetLoadError } from "../errors";
import { type LoadedDataset, type Sample, SampleSchema } from "../index";

export async function loadCsv(path: string): Promise<LoadedDataset> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new DatasetLoadError(`file not found: ${path}`);
  }
  const text = await file.text();
  const rows = parseCsv(text);
  if (rows.length === 0) {
    return { name: basename(path).replace(/\.csv$/i, ""), samples: emptyIterable() };
  }
  const header = rows[0];
  if (!header) {
    return { name: basename(path).replace(/\.csv$/i, ""), samples: emptyIterable() };
  }

  return {
    name: basename(path).replace(/\.csv$/i, ""),
    samples: rowsToSamples(rows.slice(1), header, path),
  };
}

async function* emptyIterable(): AsyncIterable<Sample> {
  /* nothing */
}

async function* rowsToSamples(
  rows: ReadonlyArray<ReadonlyArray<string>>,
  header: ReadonlyArray<string>,
  path: string,
): AsyncIterable<Sample> {
  let rowNo = 1; // header was row 0
  for (const row of rows) {
    rowNo += 1;
    if (row.length === 1 && row[0] === "") continue; // trailing newline
    const obj: Record<string, string | string[]> = {};
    for (let i = 0; i < header.length; i++) {
      const key = header[i];
      if (key === undefined) continue;
      const cell = row[i] ?? "";
      // expected_tools is the only array-shaped field — comma-split
      if (key === "expected_tools" && cell !== "") {
        obj[key] = cell
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      } else if (cell !== "") {
        obj[key] = cell;
      }
    }
    const result = SampleSchema.safeParse(obj);
    if (!result.success) {
      throw new DatasetLoadError(
        `invalid sample on row ${rowNo} of ${path}: ${result.error.message}`,
      );
    }
    yield result.data;
  }
}

/**
 * RFC 4180-style CSV parser. Handles:
 * - quoted fields with embedded commas, newlines (CRLF/LF), and escaped `""`
 * - trailing empty line tolerance
 * - any combination of CRLF / LF / mixed line endings
 *
 * Returns one `string[]` per row. Empty input yields `[]`.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  if (text.length === 0) return rows;
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      // swallow CRLF as a single newline
      if (ch === "\r" && text[i + 1] === "\n") i += 2;
      else i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // EOF without trailing newline
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
