/**
 * Position rules shared by the page reader and the cursor functions. A position comes
 * from a client, so it is checked here, never trusted. The wire string is
 * control-contract's codec, called by the HTTP layer.
 */
import { closeSync } from "node:fs";
import { type CursorPosition, encodeCursor } from "@crewhaus/control-contract";
import { openRecordFd } from "./io";
import { endOfLastCompleteLine, tailAt } from "./lines";
import type { RecordSource } from "./paths";
import { isSingleFile, retainedSegments, segmentRel } from "./segments";

/**
 * One or two positions, ascending, in the codec's shape: what a vector holds for one
 * source. The codec's own check decides, so its rules are never copied. A single-file
 * source has only segment 0.
 */
export function isPositionList(value: unknown, singleFile: boolean): value is CursorPosition[] {
  if (!Array.isArray(value)) return false;
  if (singleFile && value.some((p) => (p as { seg?: unknown } | null)?.seg !== 0)) return false;
  try {
    encodeCursor({ v: 1, kind: "vector", sources: { rows: value } });
    return true;
  } catch {
    return false;
  }
}

/** One position, by the same check. */
export function isPosition(value: unknown, singleFile: boolean): value is CursorPosition {
  return isPositionList([value], singleFile);
}

/** Where a source with no retained file begins. */
export function firstPosition(source: RecordSource, watermark = 0): CursorPosition {
  return { seg: isSingleFile(source.records) ? 0 : Math.max(1, watermark), off: 0, tail: "" };
}

/**
 * The end of a source: up to its newest two segments, each at the end of its own last
 * complete line. An absent or refused source answers its first position, so the result
 * always passes `encodeCursor`.
 */
export function endPositions(source: RecordSource): readonly CursorPosition[] {
  const retained = retainedSegments(source);
  if (!retained.ok) return [firstPosition(source)];
  const newest = retained.segs.slice(-2);
  if (newest.length === 0) return [firstPosition(source, retained.watermark)];
  return newest.map((seg) => {
    const opened = openRecordFd(source.root, segmentRel(source.records, seg));
    if (!opened.ok) return { seg, off: 0, tail: "" };
    try {
      const off = endOfLastCompleteLine(opened.fd, opened.stats.size);
      return { seg, off, tail: tailAt(opened.fd, off) };
    } catch {
      return { seg, off: 0, tail: "" };
    } finally {
      closeSync(opened.fd);
    }
  });
}
