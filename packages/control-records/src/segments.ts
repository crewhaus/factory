/**
 * Segments without renames. A growing ledger is a series of numbered files. A writer
 * appends to the highest number; once that file has passed the threshold, the writer
 * targets the next number and creates it with an exclusive create, and a racing roller
 * appends to the same new file. A rolled segment keeps its name and inode, so an
 * appender that opened it can still land a late line, and a reader still finds it.
 *
 * The watermark says which segments are gone: every segment below it is evicted, even
 * one whose file has not been unlinked yet.
 */
import { lstatSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type SafeFsFailure, ensureDirContained, resolveContained } from "@crewhaus/tool-safety/fs";
import { decodeStrict, ioFailure, parseObject, readRecordFile, refusal } from "./io";
import type { Ledger, RecordSource, RecordsAt } from "./paths";

/** A segment past this many bytes rolls. */
const ROLL_BYTES = 8 * 1024 * 1024;
const SEGMENT_NAME_RE = /^(\d{6})\.jsonl$/;
/** Six digits name at most this many segments; the last one takes every further line. */
const LAST_SEGMENT = 999_999;
const WATERMARK_FILE = "watermark.json";
const WATERMARK_MAX_BYTES = 4096;

let rollBytes = ROLL_BYTES;

/** Test seam: the roll threshold, so no test writes 8 MiB. Pass `undefined` to restore. */
export function _setRollBytesForTest(next: number | undefined): void {
  rollBytes = next ?? ROLL_BYTES;
}

function segmentName(seg: number): string {
  return `${String(seg).padStart(6, "0")}.jsonl`;
}

/** Whether these records are one file that never rolls. */
export function isSingleFile(records: RecordsAt): records is { readonly file: string } {
  return "file" in records;
}

/** A segment's path relative to the root. A single file is always segment 0. */
export function segmentRel(records: RecordsAt, seg: number): string {
  return isSingleFile(records) ? records.file : join(records.dir, segmentName(seg));
}

export type SegmentList = { readonly ok: true; readonly segs: readonly number[] };

/** The segment numbers on disk, ascending. A missing directory has none. */
export function listSegments(source: RecordSource): SegmentList | SafeFsFailure {
  const { records, root } = source;
  if (isSingleFile(records)) return { ok: true, segs: [0] };
  const at = resolveContained(root, records.dir);
  if (!at.ok) return at.code === "not-found" ? { ok: true, segs: [] } : at;
  let names: readonly string[];
  try {
    names = readdirSync(at.real);
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return { ok: true, segs: [] };
    return ioFailure(records.dir, err, "listed");
  }
  const segs: number[] = [];
  for (const name of names) {
    const match = SEGMENT_NAME_RE.exec(name);
    if (match?.[1] !== undefined) segs.push(Number(match[1]));
  }
  return { ok: true, segs: segs.sort((a, b) => a - b) };
}

/**
 * The lowest retained segment: 0 when nothing was ever dropped. An unreadable
 * watermark is refused, because nothing could then say what has been evicted.
 */
export function readWatermark(
  source: RecordSource,
): { readonly ok: true; readonly seg: number } | SafeFsFailure {
  const { records, root } = source;
  if (isSingleFile(records)) return { ok: true, seg: 0 };
  const rel = watermarkRel(records);
  const read = readRecordFile(root, rel, WATERMARK_MAX_BYTES);
  if (!read.ok) return read.code === "not-found" ? { ok: true, seg: 0 } : read;
  const text = read.truncated ? undefined : decodeStrict(read.bytes);
  const body = text === undefined ? undefined : parseObject(text);
  const seg = body?.["seg"];
  if (body?.["v"] !== 1 || !Number.isSafeInteger(seg) || (seg as number) < 0) {
    return refusal("io-error", rel, `${JSON.stringify(rel)} is not a watermark record`);
  }
  return { ok: true, seg: seg as number };
}

export function watermarkRel(records: { readonly dir: string }): string {
  return join(records.dir, WATERMARK_FILE);
}

export type RetainedSegments = {
  readonly ok: true;
  /** Segments at or above the watermark, ascending. */
  readonly segs: readonly number[];
  readonly watermark: number;
};

/** The segments a reader may use. Anything below the watermark is evicted, unlinked or not. */
export function retainedSegments(source: RecordSource): RetainedSegments | SafeFsFailure {
  const mark = readWatermark(source);
  if (!mark.ok) return mark;
  const listed = listSegments(source);
  if (!listed.ok) return listed;
  return {
    ok: true,
    segs: listed.segs.filter((seg) => seg >= mark.seg),
    watermark: mark.seg,
  };
}

export type AppendTarget = { readonly ok: true; readonly seg: number; readonly rel: string };

/** Make the records' directory and pick the file the next line goes to. Reads no record. */
export function appendTarget(ledger: Ledger): AppendTarget | SafeFsFailure {
  const { records, root } = ledger;
  if (isSingleFile(records)) {
    const parent = ensureDirContained(root, dirname(records.file), { mode: 0o700 });
    return parent.ok ? { ok: true, seg: 0, rel: records.file } : parent;
  }
  const dir = ensureDirContained(root, records.dir, { mode: 0o700 });
  if (!dir.ok) return dir;
  const listed = listSegments(ledger);
  if (!listed.ok) return listed;
  const newest = listed.segs[listed.segs.length - 1];
  if (newest === undefined) return { ok: true, seg: 1, rel: segmentRel(records, 1) };
  let size = 0;
  try {
    size = lstatSync(join(dir.real, segmentName(newest))).size;
  } catch {
    // Gone since the listing: the append below decides what is there.
  }
  const seg = size > rollBytes && newest < LAST_SEGMENT ? newest + 1 : newest;
  return { ok: true, seg, rel: segmentRel(records, seg) };
}

/** A failure for an operation a single-file ledger does not have. */
export function noSegments(records: { readonly file: string }): SafeFsFailure {
  return refusal(
    "invalid-path",
    records.file,
    `${JSON.stringify(records.file)} is a single-file ledger; it has no segments to drop`,
  );
}
