/**
 * Line-delimited JSON. One value per line, which is what log shippers,
 * dataset files and streaming APIs emit.
 *
 * Reading is tolerant where tolerance is safe — a trailing newline, blank
 * lines, CRLF endings, and a byte-order mark are all fine — and strict where
 * it is not: a line that does not parse is reported with its 1-based line
 * number and the parser's message, never dropped in silence.
 */
import { MAX_NESTING_DEPTH, OutputLimitError, jsonTextLength, jsonTextNestsDeeper } from "./json";

export type JsonlRecord = { line: number; value: unknown };
export type JsonlFailure = { line: number; error: string; preview: string };

export type JsonlParseResult = {
  records: JsonlRecord[];
  failures: JsonlFailure[];
  truncated: boolean;
};

/**
 * Parse JSONL. `maxRecords` bounds the result; `stopOnError` makes the first
 * bad line end the parse, which is what a caller wants when the file is a
 * transaction log rather than a best-effort sample.
 */
export function parseJsonl(
  text: string,
  maxRecords: number,
  stopOnError: boolean,
): JsonlParseResult {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = src.split("\n");
  const records: JsonlRecord[] = [];
  const failures: JsonlFailure[] = [];
  let truncated = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] as string).replace(/\r$/, "");
    if (raw.trim() === "") continue;
    if (records.length >= maxRecords) {
      truncated = true;
      break;
    }
    try {
      // Checked before parsing, like every JSON document this package reads.
      if (jsonTextNestsDeeper(raw, MAX_NESTING_DEPTH)) {
        throw new Error(`nests deeper than ${MAX_NESTING_DEPTH} levels`);
      }
      records.push({ line: i + 1, value: JSON.parse(raw) as unknown });
    } catch (err) {
      failures.push({
        line: i + 1,
        error: (err as Error).message,
        preview: raw.length > 120 ? `${raw.slice(0, 120)}…` : raw,
      });
      if (stopOnError) break;
    }
  }
  return { records, failures, truncated };
}

/**
 * Serialize values as JSONL. A value containing a literal newline is still
 * safe, because `JSON.stringify` escapes it — that is the property the
 * format relies on. `undefined` entries are skipped and counted, since
 * `JSON.stringify(undefined)` is not a value at all.
 */
export function writeJsonl(
  values: ReadonlyArray<unknown>,
  trailingNewline: boolean,
  maxChars = Number.POSITIVE_INFINITY,
): { text: string; skipped: number } {
  const lines: string[] = [];
  let skipped = 0;
  let chars = 0;
  for (const value of values) {
    // Measured before it is built: a record converted from CSV repeats every
    // column name, so one line can be far larger than its source row.
    if (maxChars !== Number.POSITIVE_INFINITY) {
      const size = jsonTextLength(value, 0, maxChars - chars);
      if (chars + size + 1 > maxChars) throw new OutputLimitError(maxChars, "the JSONL");
    }
    const text = JSON.stringify(value);
    if (text === undefined) {
      skipped += 1;
      continue;
    }
    chars += text.length + 1;
    lines.push(text);
  }
  const body = lines.join("\n");
  return { text: trailingNewline && body !== "" ? `${body}\n` : body, skipped };
}
