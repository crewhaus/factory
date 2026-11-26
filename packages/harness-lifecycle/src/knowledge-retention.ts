/**
 * Retention of the content-free records that say which knowledge a harness used:
 * the usage log (`.crewhaus/run/knowledge/usage/`) and the backend fallback markers
 * (`.crewhaus/run/knowledge/backends.jsonl`), both kept for
 * `knowledge.usageMaxAgeDays` of `.crewhaus/retention.json`.
 *
 * A usage segment goes whole, oldest first, once its last line is past the window
 * (control-records' watermark, so a reader never meets half a segment and knows what
 * was evicted); the newest segment is never dropped. The markers file is rewritten
 * without the lines past the window, through a temporary file and a rename, keeping a
 * line appended meanwhile. A line whose time cannot be read is kept: when in doubt,
 * nothing is removed.
 */
import { closeSync } from "node:fs";
import {
  controlPaths,
  dropSegmentsBefore,
  harnessLedger,
  openRecordFd,
  readAt,
  readTail,
  retainedSegments,
  segmentRel,
} from "@crewhaus/control-records";
import { writeFileSafe } from "@crewhaus/tool-safety/fs";

/** How far back from a segment's end the newest readable line is looked for. */
const TAIL = { maxLines: 64, maxBytes: 256 * 1024 } as const;
/** The markers file is read up to this; a larger one is left as it is, and reported. */
const MARKERS_MAX_BYTES = 64 * 1024 * 1024;

/** What one pass removed, or would remove, from the knowledge records. */
export type KnowledgeRetention = {
  /** `knowledge.usageMaxAgeDays`. */
  readonly maxAgeDays: number;
  /** Usage segments past the window, by number, ascending. */
  readonly usageSegments: readonly number[];
  /** Fallback markers past the window. */
  readonly backendMarkers: number;
  /** True when an active audit window kept everything. */
  readonly deferred?: true;
  /** Why a part was left as it is. */
  readonly skipped: readonly string[];
};

type Seams = { readonly afterMarkersRead?: () => void };
let seams: Seams = {};

/** Test seam: run code between the markers read and their rewrite. Pass `undefined` to restore. */
export function _setKnowledgeRetentionSeamsForTest(next: Seams | undefined): void {
  seams = next ?? {};
}

function timeOf(line: unknown): number | undefined {
  if (typeof line !== "object" || line === null) return undefined;
  const at = (line as Record<string, unknown>)["at"];
  const ms = typeof at === "string" ? Date.parse(at) : Number.NaN;
  return Number.isNaN(ms) ? undefined : ms;
}

/** When a segment's newest readable line was written, or `undefined` when none says. */
function newestAt(root: string, rel: string): number | undefined {
  const tail = readTail(root, rel, TAIL);
  if (tail.state !== "read") return undefined;
  for (const record of [...tail.records].reverse()) {
    const at = timeOf(record);
    if (at !== undefined) return at;
  }
  return undefined;
}

type MarkersRead = { readonly text: string; readonly size: number; readonly ino: number };

/** The markers file from `position` to its end, or `undefined` when it is not there. */
function readMarkers(root: string, rel: string, position: number): MarkersRead | undefined | "big" {
  const opened = openRecordFd(root, rel);
  if (!opened.ok) return undefined;
  try {
    const { size, ino } = opened.stats;
    if (size > MARKERS_MAX_BYTES) return "big";
    const length = Math.max(0, size - position);
    const bytes = Buffer.alloc(length);
    readAt(opened.fd, bytes, length, position);
    return { text: bytes.toString("utf8"), size, ino };
  } finally {
    closeSync(opened.fd);
  }
}

/**
 * Apply the window to one harness's knowledge records. `undefined` when the harness has
 * neither record, so a report about sessions alone is unchanged. `before`, when given,
 * narrows the window further, as it does for sessions; `deferred` (an active audit window)
 * removes nothing; a dry run reports what would go and writes nothing.
 */
export async function retainKnowledgeRecords(opts: {
  readonly rootDir: string;
  readonly maxAgeDays: number;
  readonly now: number;
  readonly before?: number;
  readonly dryRun: boolean;
  readonly deferred: boolean;
}): Promise<KnowledgeRetention | undefined> {
  const paths = controlPaths(opts.rootDir);
  const usage = harnessLedger(opts.rootDir, { dir: paths.knowledgeUsageDir });
  const retained = retainedSegments(usage);
  const segs = retained.ok ? retained.segs : [];
  const markers = readMarkers(opts.rootDir, paths.knowledgeBackendsFile, 0);
  if (retained.ok && segs.length === 0 && markers === undefined) return undefined;

  const skipped: string[] = [];
  if (!retained.ok) skipped.push(`the usage log could not be read: ${retained.reason}`);
  if (markers === "big") {
    skipped.push(`${paths.knowledgeBackendsFile} is larger than ${MARKERS_MAX_BYTES} bytes`);
  }
  if (opts.deferred) {
    return {
      maxAgeDays: opts.maxAgeDays,
      usageSegments: [],
      backendMarkers: 0,
      deferred: true,
      skipped,
    };
  }
  const cutoff = Math.min(
    opts.now - opts.maxAgeDays * 86_400_000,
    opts.before ?? Number.POSITIVE_INFINITY,
  );

  // The contiguous prefix past the window: a segment inside it stops the walk.
  const stale: number[] = [];
  for (const seg of segs.slice(0, -1)) {
    const at = newestAt(opts.rootDir, segmentRel(usage.records, seg));
    if (at === undefined || at >= cutoff) break;
    stale.push(seg);
  }
  const keepFrom = stale.length > 0 ? segs[stale.length] : undefined;
  let usageSegments: readonly number[] = stale;
  if (!opts.dryRun && keepFrom !== undefined) {
    const answer = await dropSegmentsBefore(usage, keepFrom);
    if (answer.ok) usageSegments = answer.dropped;
    else {
      usageSegments = [];
      skipped.push(`the usage log was left as it is: ${answer.reason}`);
    }
  }

  let backendMarkers = 0;
  if (markers !== undefined && markers !== "big") {
    // Whole lines only: a fragment still landing is copied with the rest of the tail.
    const end = markers.text.lastIndexOf("\n") + 1;
    const kept: string[] = [];
    for (const line of markers.text.slice(0, end).split("\n")) {
      if (line.trim() === "") continue;
      let at: number | undefined;
      try {
        at = timeOf(JSON.parse(line));
      } catch {
        at = undefined;
      }
      if (at !== undefined && at < cutoff) backendMarkers += 1;
      else kept.push(line);
    }
    if (backendMarkers > 0 && !opts.dryRun) {
      seams.afterMarkersRead?.();
      const noted = Buffer.byteLength(markers.text.slice(0, end), "utf8");
      const tail = readMarkers(opts.rootDir, paths.knowledgeBackendsFile, noted);
      if (tail === undefined || tail === "big" || tail.ino !== markers.ino) {
        backendMarkers = 0;
        skipped.push(`${paths.knowledgeBackendsFile} changed while it was read`);
      } else {
        const body = kept.length > 0 ? `${kept.join("\n")}\n` : "";
        const written = writeFileSafe(
          opts.rootDir,
          paths.knowledgeBackendsFile,
          `${body}${tail.text}`,
          { overwrite: true, mode: 0o600 },
        );
        if (!written.ok) {
          backendMarkers = 0;
          skipped.push(`${paths.knowledgeBackendsFile} was left as it is: ${written.reason}`);
        }
      }
    }
  }
  return { maxAgeDays: opts.maxAgeDays, usageSegments, backendMarkers, skipped };
}
