/**
 * Line-delimited JSON. One value per line, which is what log shippers,
 * dataset files and streaming APIs emit.
 *
 * Reading is tolerant where tolerance is safe — a trailing newline, blank
 * lines, CRLF endings, and a byte-order mark are all fine — and strict where
 * it is not: a line that does not parse is reported with its 1-based line
 * number and the parser's message, never dropped in silence.
 */

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
): { text: string; skipped: number } {
  const lines: string[] = [];
  let skipped = 0;
  for (const value of values) {
    const text = JSON.stringify(value);
    if (text === undefined) {
      skipped += 1;
      continue;
    }
    lines.push(text);
  }
  const body = lines.join("\n");
  return { text: trailingNewline && body !== "" ? `${body}\n` : body, skipped };
}
