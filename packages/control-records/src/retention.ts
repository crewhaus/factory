/**
 * Dropping old segments, a writer step: the watermark first, then the files, so a crash
 * between the two leaves segments every reader already treats as evicted.
 */
import { unlinkSync } from "node:fs";
import { type SafeFsFailure, resolveContained, writeFileSafe } from "@crewhaus/tool-safety/fs";
import { ioFailure } from "./io";
import { stamp, withLedgerLock } from "./ledger";
import type { Ledger } from "./paths";
import {
  isSingleFile,
  listSegments,
  noSegments,
  readWatermark,
  segmentRel,
  watermarkRel,
} from "./segments";

type RetentionSeams = { readonly afterWatermark?: () => void };

let seams: RetentionSeams = {};

/** Test seam: run code between the watermark's write and the first unlink. Pass `undefined` to restore. */
export function _setRetentionSeamsForTest(next: RetentionSeams | undefined): void {
  seams = next ?? {};
}

export type DropAnswer =
  | {
      readonly ok: true;
      /** The watermark after this call. */
      readonly watermark: number;
      /** Segment numbers this call removed. */
      readonly dropped: readonly number[];
    }
  | SafeFsFailure;

/**
 * Evict every segment below `seg`, under the lock. The watermark only ever rises and
 * the newest segment is never dropped: a `seg` above the newest is clamped to it, and a
 * `seg` at or below the current watermark changes nothing.
 *
 * First consumer: the scheduler's retention.
 */
export async function dropSegmentsBefore(ledger: Ledger, seg: number): Promise<DropAnswer> {
  const { records, root } = ledger;
  if (isSingleFile(records)) return noSegments(records);
  if (!Number.isSafeInteger(seg) || seg < 0) {
    throw new RangeError(`control-records: seg must be a segment number, got ${String(seg)}`);
  }
  return withLedgerLock<DropAnswer>(ledger, () => {
    const mark = readWatermark(ledger);
    if (!mark.ok) return mark;
    const listed = listSegments(ledger);
    if (!listed.ok) return listed;
    const newest = listed.segs[listed.segs.length - 1];
    const target = newest === undefined ? 0 : Math.min(seg, newest);
    if (target <= mark.seg) return { ok: true, watermark: mark.seg, dropped: [] };
    const written = writeFileSafe(
      root,
      watermarkRel(records),
      `${JSON.stringify({ v: 1, seg: target, at: stamp() })}\n`,
      { overwrite: true, mode: 0o600 },
    );
    if (!written.ok) return written;
    seams.afterWatermark?.();
    const dropped: number[] = [];
    for (const old of listed.segs) {
      if (old >= target) break;
      const rel = segmentRel(records, old);
      const at = resolveContained(root, rel, { followLeaf: false });
      if (!at.ok) return at;
      try {
        unlinkSync(at.real);
        dropped.push(old);
      } catch (err) {
        if ((err as { code?: unknown }).code !== "ENOENT") return ioFailure(rel, err, "removed");
      }
    }
    return { ok: true, watermark: target, dropped };
  });
}
