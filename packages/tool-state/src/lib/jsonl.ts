/**
 * JSONL: the append-only line format behind the journal and the blackboard.
 *
 * One JSON object per line, written with `O_APPEND` so that two processes
 * appending at once cannot interleave a partial line into the middle of
 * another. The parser is written for the failure that actually happens —
 * a process killed mid-write leaves a truncated last line — so a bad line is
 * REPORTED with its number and the rest of the file is still returned. A
 * journal that refuses to be read because its tail is half-written is a
 * journal that fails exactly when it is needed.
 */
import { isPlainObject } from "./records";

export type JsonlRecord = Record<string, unknown>;

/** A line that could not be used, and why. */
export type CorruptLine = { readonly line: number; readonly reason: string };

export type JsonlParseResult = {
  readonly records: ReadonlyArray<JsonlRecord>;
  readonly corrupt: ReadonlyArray<CorruptLine>;
};

/**
 * Parse JSONL. Blank lines are ignored. A line that is not JSON, or is JSON
 * but not an object, lands in `corrupt` with its 1-based line number; a
 * malformed final line with no trailing newline is additionally called out as
 * truncated, which is the signature of an interrupted write.
 */
export function parseJsonl(text: string): JsonlParseResult {
  const records: JsonlRecord[] = [];
  const corrupt: CorruptLine[] = [];
  const endsWithNewline = text.length === 0 || text.endsWith("\n");
  const lines = text.split("\n");
  // `split` leaves a trailing "" for a newline-terminated file.
  if (endsWithNewline) lines.pop();

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    const isLast = index === lines.length - 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      const truncated = isLast && !endsWithNewline;
      corrupt.push({
        line: index + 1,
        reason: truncated
          ? `truncated final line (${(err as Error).message}) — most likely a write interrupted part-way`
          : `not valid JSON: ${(err as Error).message}`,
      });
      return;
    }
    if (!isPlainObject(parsed)) {
      corrupt.push({ line: index + 1, reason: "line is valid JSON but not an object" });
      return;
    }
    records.push(parsed);
  });

  return { records, corrupt };
}

/** Serialise one record as a line, newline included. Never contains a newline. */
export function toJsonlLine(record: JsonlRecord): string {
  return `${JSON.stringify(record)}\n`;
}

export type RecordFilter = {
  readonly sinceSeq?: number;
  readonly untilSeq?: number;
  readonly kind?: string;
  readonly author?: string;
  /** Case-sensitive substring, tested against the record's JSON. */
  readonly contains?: string;
  readonly limit?: number;
  readonly order?: "asc" | "desc";
};

export type FilterResult = {
  /** Records that matched, before `limit`. */
  readonly matched: number;
  readonly selected: ReadonlyArray<JsonlRecord>;
  /** True when `limit` cut records off the result. */
  readonly truncated: boolean;
};

function seqOf(record: JsonlRecord): number | undefined {
  const seq = record["seq"];
  return typeof seq === "number" ? seq : undefined;
}

/**
 * Filter and window a run of records.
 *
 * `sinceSeq` is exclusive and `untilSeq` inclusive, which is what a resuming
 * reader wants: it remembers the last sequence it handled and asks for what
 * came after. With `order: "desc"` the LAST `limit` matches are returned,
 * newest first — the tail of a log, not its head.
 */
export function filterRecords(
  records: ReadonlyArray<JsonlRecord>,
  filter: RecordFilter,
): FilterResult {
  const matches: JsonlRecord[] = [];
  for (const record of records) {
    const seq = seqOf(record);
    if (filter.sinceSeq !== undefined && (seq === undefined || seq <= filter.sinceSeq)) continue;
    if (filter.untilSeq !== undefined && (seq === undefined || seq > filter.untilSeq)) continue;
    if (filter.kind !== undefined && record["kind"] !== filter.kind) continue;
    if (filter.author !== undefined && record["author"] !== filter.author) continue;
    if (filter.contains !== undefined && !JSON.stringify(record).includes(filter.contains))
      continue;
    matches.push(record);
  }
  const limit = filter.limit ?? matches.length;
  const truncated = matches.length > limit;
  if (filter.order === "desc") {
    return { matched: matches.length, selected: matches.slice(-limit).reverse(), truncated };
  }
  return { matched: matches.length, selected: matches.slice(0, limit), truncated };
}

/** The highest `seq` present, or 0 for an empty run. Used to resume counting. */
export function highestSeq(records: ReadonlyArray<JsonlRecord>): number {
  let highest = 0;
  for (const record of records) {
    const seq = seqOf(record);
    if (seq !== undefined && Number.isFinite(seq) && seq > highest) highest = seq;
  }
  return highest;
}
