/**
 * Reading from the newest end. Lists are newest first and a folded view wants the
 * newest records of a large file, so these start at the end and stop at their caps.
 *
 * A torn final line, a write still landing, waits for the next read. A complete line
 * that does not parse to a JSON object is reported as a gap and reading goes on.
 */
import { closeSync } from "node:fs";
import type { CursorPosition } from "@crewhaus/control-contract";
import type { SafeFsCode } from "@crewhaus/tool-safety/fs";
import { openRecordFd, requireCap } from "./io";
import {
  type RawLine,
  classifyLine,
  endOfLastCompleteLine,
  offsetFits,
  scanBack,
  tailAt,
} from "./lines";
import type { RecordSource } from "./paths";
import { endPositions, isPosition } from "./positions";
import { isSingleFile, retainedSegments, segmentRel } from "./segments";

export type TailOptions = {
  readonly maxLines: number;
  readonly maxBytes: number;
  /** Follow a link at the file's name when it stays inside the root. Default false. */
  readonly followLeafSymlink?: boolean;
};

export type TailGap = {
  readonly off: number;
  /** Bytes the line occupies, its `\n` included. */
  readonly bytes: number;
  readonly reason: "unreadable";
};

export type TailRead =
  | {
      readonly state: "read";
      /** The newest complete lines, in file order, so a last-wins fold works. */
      readonly records: readonly Record<string, unknown>[];
      /** Older data lies past a cap. */
      readonly truncated: boolean;
      readonly gaps: readonly TailGap[];
      /** The file's final bytes have no `\n` yet: they are not returned. */
      readonly torn: boolean;
    }
  | { readonly state: "absent" }
  | { readonly state: "refused"; readonly code: SafeFsCode; readonly reason: string };

/**
 * The newest complete lines of one file, reading backwards in chunks: at most
 * `maxBytes` plus one chunk. A line longer than `maxBytes` ends the read with
 * `truncated`. An absent file and a refused open are distinct answers, never a throw.
 *
 * First consumer: Hangar's approvals inbox.
 */
export function readTail(root: string, given: string, options: TailOptions): TailRead {
  const { maxLines, maxBytes } = options;
  requireCap("maxLines", maxLines);
  requireCap("maxBytes", maxBytes);
  const opened = openRecordFd(root, given, options.followLeafSymlink ?? false);
  if (!opened.ok) {
    if (opened.code === "not-found") return { state: "absent" };
    return { state: "refused", code: opened.code, reason: opened.reason };
  }
  const size = opened.stats.size;
  const records: Record<string, unknown>[] = [];
  const gaps: TailGap[] = [];
  let lines = 0;
  let truncated = false;
  try {
    // One byte past the window, so a chunk that ends exactly on it still finds the `\n` before it.
    const limits = { maxRead: maxBytes + 1, maxLine: maxBytes };
    const scan = scanBack(opened.fd, size, limits, (line) => {
      if (line.data === null || size - line.off > maxBytes) {
        truncated = true;
        return true;
      }
      const value = classifyLine(line);
      if (value.kind === "blank") return false;
      if (lines === maxLines) {
        truncated = true;
        return true;
      }
      lines += 1;
      if (value.kind === "record") records.push(value.record);
      else gaps.push({ off: line.off, bytes: line.bytes, reason: "unreadable" });
      return false;
    });
    if (scan.outcome === "budget" || scan.outcome === "short") truncated = true;
    return {
      state: "read",
      records: records.reverse(),
      truncated,
      gaps: gaps.reverse(),
      torn: scan.torn,
    };
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return {
      state: "refused",
      code: "io-error",
      reason: `${JSON.stringify(given)} could not be read${typeof code === "string" ? `: ${code}` : ""}`,
    };
  } finally {
    closeSync(opened.fd);
  }
}

export type PageItem = {
  readonly record: Record<string, unknown>;
  /** Where the record's line starts: hand it back as `before` to read what is older. */
  readonly at: CursorPosition;
};

export type PageGap =
  | {
      readonly seg: number;
      readonly off: number;
      readonly reason: "unreadable";
      readonly bytes: number;
      /** Why a whole segment could not be opened. */
      readonly detail?: string;
    }
  | { readonly seg: number; readonly off: number; readonly reason: "evicted" | "diverged" };

export type LedgerPage = {
  /** Newest first. */
  readonly items: readonly PageItem[];
  /** Present when older lines remain: pass it as `before`. */
  readonly next?: CursorPosition;
  /** The ledger's end when this page was taken: resuming from it misses and repeats nothing. */
  readonly snapshotAt: readonly CursorPosition[];
  readonly gaps: readonly PageGap[];
};

/** One line kept in memory is at most this; a longer one is a gap. */
const PAGE_LINE_BYTES = 8 * 1024 * 1024;

/**
 * One page, newest first across segments, down to the watermark. `limit` counts lines,
 * gaps included, so a run of garbage ends a page like any other. `snapshotAt` is taken
 * before the page is read and bytes past it are ignored, so "list, then resume from
 * `snapshotAt`" has no gap and no duplicate. A `before` below the watermark answers no
 * items and an `evicted` gap; one that no longer fits its file answers `diverged`.
 *
 * First consumer: the v1 lists.
 */
export function readPage(
  source: RecordSource,
  options: { readonly limit: number; readonly before?: CursorPosition },
): LedgerPage {
  const { limit, before } = options;
  if (typeof limit !== "number" || Number.isNaN(limit) || limit < 1) {
    throw new RangeError(`control-records: limit must be at least 1, got ${String(limit)}`);
  }
  const snapshotAt = endPositions(source);
  const retained = retainedSegments(source);
  if (!retained.ok) {
    return {
      items: [],
      snapshotAt,
      gaps: [{ seg: 0, off: 0, reason: "unreadable", bytes: 0, detail: retained.reason }],
    };
  }
  const single = isSingleFile(source.records);
  const refuseBefore = (reason: "evicted" | "diverged", seg: number, off: number): LedgerPage => ({
    items: [],
    snapshotAt,
    gaps: [{ seg, off, reason }],
  });

  const ends = new Map<number, number>(snapshotAt.map((p) => [p.seg, p.off]));
  let newest = snapshotAt[snapshotAt.length - 1]?.seg ?? 0;
  if (before !== undefined) {
    if (!isPosition(before, single)) return refuseBefore("diverged", 0, 0);
    if (before.seg < retained.watermark) return refuseBefore("evicted", before.seg, before.off);
    if (before.off > 0 && !beforeFits(source, before)) {
      return refuseBefore("diverged", before.seg, before.off);
    }
    // Offset 0 of a segment has nothing before it: the page starts one segment down.
    newest = before.off > 0 ? before.seg : before.seg - 1;
    if (before.off > 0) ends.set(before.seg, before.off);
  }

  const items: PageItem[] = [];
  const gaps: PageGap[] = [];
  let visited = 0;
  let oldest: CursorPosition | undefined;
  let more = false;
  const order = retained.segs.filter((seg) => seg <= newest).reverse();
  for (const seg of order) {
    if (more) break;
    const opened = openRecordFd(source.root, segmentRel(source.records, seg));
    if (!opened.ok) {
      if (opened.code === "not-found") continue;
      gaps.push({ seg, off: 0, reason: "unreadable", bytes: 0, detail: opened.reason });
      continue;
    }
    try {
      const size = opened.stats.size;
      const end = Math.min(ends.get(seg) ?? endOfLastCompleteLine(opened.fd, size), size);
      const visit = (line: RawLine): boolean => {
        const value = classifyLine(line);
        if (value.kind === "blank") return false;
        if (visited === limit) {
          more = true;
          return true;
        }
        visited += 1;
        const at: CursorPosition = { seg, off: line.off, tail: tailAt(opened.fd, line.off) };
        oldest = at;
        if (value.kind === "record") items.push({ record: value.record, at });
        else gaps.push({ seg, off: line.off, reason: "unreadable", bytes: line.bytes });
        return false;
      };
      scanBack(
        opened.fd,
        end,
        { maxRead: Number.POSITIVE_INFINITY, maxLine: PAGE_LINE_BYTES },
        visit,
      );
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      gaps.push({
        seg,
        off: 0,
        reason: "unreadable",
        bytes: 0,
        detail: `segment ${seg} could not be read${typeof code === "string" ? `: ${code}` : ""}`,
      });
    } finally {
      closeSync(opened.fd);
    }
  }
  return {
    items,
    ...(more && oldest !== undefined ? { next: oldest } : {}),
    snapshotAt,
    gaps,
  };
}

/** Whether a page position still fits its file. */
function beforeFits(source: RecordSource, before: CursorPosition): boolean {
  const opened = openRecordFd(source.root, segmentRel(source.records, before.seg));
  if (!opened.ok) return false;
  try {
    return offsetFits(opened.fd, opened.stats.size, before.off, before.tail);
  } catch {
    return false;
  } finally {
    closeSync(opened.fd);
  }
}
