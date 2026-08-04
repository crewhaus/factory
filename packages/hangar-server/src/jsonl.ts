/**
 * Capped, torn-line-tolerant JSONL reading — the only way this package
 * touches an append-only log. Absolutely no store-library `list()` calls
 * here: raw reads have no eviction or compaction side-effects, which is the
 * non-eviction guarantee the sessions browser is built on.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { MAX_JSONL_BYTES, MAX_JSONL_LINES } from "./constants";

export type JsonlRead = {
  /** Parsed objects, in file order, unparseable lines skipped. */
  readonly objects: readonly unknown[];
  /** Raw line texts (same cap window as `objects`, including torn lines). */
  readonly rawLines: readonly string[];
  /** True when the byte or line cap cut the read short. */
  readonly truncated: boolean;
  /** Lines seen within the read window (parseable or not). */
  readonly lineCount: number;
  /** Lines inside the window that failed to parse (torn/garbage). */
  readonly tornCount: number;
};

const EMPTY: JsonlRead = {
  objects: [],
  rawLines: [],
  truncated: false,
  lineCount: 0,
  tornCount: 0,
};

/** Read at most `maxBytes` from the head of a file. Missing/unreadable
 *  files read as empty — absence is not an error anywhere in this server. */
export function readTextCapped(
  path: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  let fd: number;
  let size: number;
  try {
    size = statSync(path).size;
    fd = openSync(path, "r");
  } catch {
    return { text: "", truncated: false };
  }
  try {
    const take = Math.min(size, maxBytes);
    const buf = Buffer.alloc(take);
    const read = readSync(fd, buf, 0, take, 0);
    return { text: buf.subarray(0, read).toString("utf8"), truncated: size > maxBytes };
  } catch {
    return { text: "", truncated: false };
  } finally {
    closeSync(fd);
  }
}

/**
 * Parse a JSONL file under both caps ({@link MAX_JSONL_LINES} lines,
 * {@link MAX_JSONL_BYTES} bytes). A byte-cap cut drops the final partial
 * line instead of parsing it torn; genuinely torn lines inside the window
 * are skipped and counted, never fatal.
 */
export function readJsonlCapped(
  path: string,
  maxLines: number = MAX_JSONL_LINES,
  maxBytes: number = MAX_JSONL_BYTES,
): JsonlRead {
  const { text, truncated: byteTruncated } = readTextCapped(path, maxBytes);
  if (text === "") return EMPTY;
  let lines = text.split("\n");
  if (byteTruncated) lines = lines.slice(0, -1); // the cut tore the last line
  const objects: unknown[] = [];
  const rawLines: string[] = [];
  let lineCount = 0;
  let tornCount = 0;
  let lineTruncated = false;
  for (const line of lines) {
    if (line.trim() === "") continue;
    if (lineCount >= maxLines) {
      lineTruncated = true;
      break;
    }
    lineCount += 1;
    rawLines.push(line);
    try {
      objects.push(JSON.parse(line));
    } catch {
      tornCount += 1; // tolerated — one torn line must not hide the rest
    }
  }
  return { objects, rawLines, truncated: byteTruncated || lineTruncated, lineCount, tornCount };
}
