import { stripAnsi } from "./normalize";

/**
 * Replace the volatile head of a log line — ISO timestamps, bracketed clock
 * times — with a placeholder, so two lines differing only in when they
 * happened collapse into one during dedupe.
 */
export function stripTimestamps(line: string): string {
  return line
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
    .replace(/\[\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\]/g, "[<ts>]")
    .replace(/\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, "<ts>");
}

/** Lines matching this read as failures and are surfaced first. */
const ERROR_PATTERN =
  /\b(error|errors|err|fail|failed|failure|fatal|panic|exception|traceback|refused|denied|timeout|timed out|cannot|unable to|not found|missing|invalid|unexpected)\b/i;

export function looksLikeError(line: string): boolean {
  return ERROR_PATTERN.test(line);
}

export type CompactedLine = {
  readonly line: string;
  readonly count: number;
  readonly isError: boolean;
};

export type CompactLogOptions = {
  readonly dedupe: boolean;
  readonly stripTimestamps: boolean;
  readonly stripAnsiCodes: boolean;
  readonly errorsFirst: boolean;
  readonly maxLines: number;
};

/**
 * Collapse a log to its distinct lines, optionally floating failures to the
 * top. Order within each group is first-seen, so the result still reads
 * chronologically rather than being reshuffled by frequency.
 *
 * This is the tool that turns a 50k-line CI log into something a model can
 * read in one turn — or, better, that a rule can decide on with no model at
 * all.
 */
export function compactLogLines(
  text: string,
  opts: CompactLogOptions,
): { lines: CompactedLine[]; totalLines: number; distinctLines: number; truncated: boolean } {
  const raw = (opts.stripAnsiCodes ? stripAnsi(text) : text).split("\n");
  const totalLines = raw.length;
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const original of raw) {
    const trimmed = original.trimEnd();
    if (trimmed.trim() === "") continue;
    const key = opts.stripTimestamps ? stripTimestamps(trimmed) : trimmed;
    const prior = counts.get(key);
    if (prior === undefined) {
      counts.set(key, 1);
      order.push(key);
    } else if (opts.dedupe) {
      counts.set(key, prior + 1);
    } else {
      order.push(key);
    }
  }
  const entries: CompactedLine[] = order.map((line) => ({
    line,
    count: opts.dedupe ? (counts.get(line) ?? 1) : 1,
    isError: looksLikeError(line),
  }));
  const sorted = opts.errorsFirst
    ? [...entries.filter((e) => e.isError), ...entries.filter((e) => !e.isError)]
    : entries;
  return {
    lines: sorted.slice(0, opts.maxLines),
    totalLines,
    distinctLines: entries.length,
    truncated: sorted.length > opts.maxLines,
  };
}
