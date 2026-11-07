/**
 * Vector cursors. A position is, per source, the segment, the offset of the next unread
 * complete line and a short hash of the bytes before it. Resuming re-checks the hash:
 * a copied harness, a restored backup or a replaced file answers a reset, and a position
 * below the watermark answers a gap. Positions come from files, never from clocks.
 */
import { closeSync } from "node:fs";
import type { CursorPosition, CursorSource, CursorSources } from "@crewhaus/control-contract";
import { openRecordFd, requireCap } from "./io";
import { classifyLine, offsetFits, scanForward, tailAt } from "./lines";
import type { RecordSource } from "./paths";
import { endPositions, firstPosition, isPositionList } from "./positions";
import { isSingleFile, retainedSegments, segmentRel } from "./segments";

/** The sources a call reads, keyed by their cursor name. A ledger is a source. */
export type ResumeSources = Readonly<Partial<Record<CursorSource, RecordSource>>>;

/** A place in a source, without the hash a resume needs. */
export type GapEdge = { readonly seg: number; readonly off: number };

export type ResumeItem =
  | {
      readonly kind: "line";
      readonly source: CursorSource;
      readonly seg: number;
      readonly off: number;
      readonly record: Record<string, unknown>;
    }
  | {
      readonly kind: "gap";
      readonly source: CursorSource;
      readonly from: GapEdge;
      readonly to: GapEdge;
      readonly reason: "evicted" | "unreadable";
      /** Why a whole file could not be opened, when that is what the gap is. */
      readonly detail?: string;
    }
  | {
      readonly kind: "reset";
      readonly source: CursorSource;
      readonly reason: "diverged";
      /** Absent when the source was not passed in: there is nothing to resume from. */
      readonly earliest?: CursorPosition;
    };

export type ResumeCaps = { readonly maxLines: number; readonly maxBytes: number };

export type ResumeAnswer = {
  readonly items: readonly ResumeItem[];
  /** Pass it to the next call. It always passes `encodeCursor` when a source was given. */
  readonly next: CursorSources;
  /** A torn final line is still landing, or a source's file does not exist yet. */
  readonly waiting: boolean;
};

/**
 * A vector at the end of each source's last complete line, holding up to its newest two
 * segments: with only the newest, a late line in the previous one would be lost. An
 * absent source gets its first position.
 *
 * First consumer: the resumable streams.
 */
export function snapshotAt(sources: ResumeSources): CursorSources {
  const out: Partial<Record<CursorSource, readonly CursorPosition[]>> = {};
  for (const name of Object.keys(sources) as CursorSource[]) {
    const source = sources[name];
    if (source !== undefined) out[name] = endPositions(source);
  }
  return out;
}

type SourceAnswer = {
  readonly items: readonly ResumeItem[];
  readonly next: readonly CursorPosition[];
  readonly waiting: boolean;
};

type Budget = { lines: number; bytes: number };

type SegmentRead =
  | { readonly outcome: "absent" }
  | { readonly outcome: "refused"; readonly reason: string }
  | { readonly outcome: "diverged" }
  | {
      readonly outcome: "read";
      readonly at: CursorPosition;
      readonly torn: boolean;
      readonly capped: boolean;
    };

/** Complete lines of one segment from `position`, spending the source's shared budget. */
function readSegment(
  name: CursorSource,
  source: RecordSource,
  position: CursorPosition,
  caps: ResumeCaps,
  budget: Budget,
  items: ResumeItem[],
): SegmentRead {
  const { seg, off, tail } = position;
  const opened = openRecordFd(source.root, segmentRel(source.records, seg));
  if (!opened.ok) {
    return opened.code === "not-found"
      ? { outcome: "absent" }
      : { outcome: "refused", reason: opened.reason };
  }
  try {
    const size = opened.stats.size;
    if (!offsetFits(opened.fd, size, off, tail)) return { outcome: "diverged" };
    let capped = false;
    const scan = scanForward(opened.fd, off, size, caps.maxBytes, (line) => {
      const value = classifyLine(line);
      if (value.kind === "blank") return "go";
      if (budget.lines <= 0) {
        capped = true;
        return "stop-before";
      }
      if (
        value.kind === "record" &&
        budget.bytes > 0 &&
        budget.bytes + line.bytes > caps.maxBytes
      ) {
        capped = true;
        return "stop-before";
      }
      budget.lines -= 1;
      budget.bytes += line.bytes;
      if (value.kind === "record") {
        items.push({ kind: "line", source: name, seg, off: line.off, record: value.record });
      } else {
        // A malformed line, or one past the cap: reported and read past, so none can wedge a reader.
        items.push({
          kind: "gap",
          source: name,
          from: { seg, off: line.off },
          to: { seg, off: line.off + line.bytes },
          reason: "unreadable",
        });
      }
      if (budget.lines <= 0 || budget.bytes >= caps.maxBytes) {
        capped = true;
        return "stop-after";
      }
      return "go";
    });
    const at: CursorPosition = {
      seg,
      off: scan.next,
      tail: scan.next === off ? tail : tailAt(opened.fd, scan.next),
    };
    return { outcome: "read", at, torn: scan.torn, capped };
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return {
      outcome: "refused",
      reason: `segment ${seg} could not be read${typeof code === "string" ? `: ${code}` : ""}`,
    };
  } finally {
    closeSync(opened.fd);
  }
}

function resumeSource(
  name: CursorSource,
  source: RecordSource,
  given: unknown,
  caps: ResumeCaps,
): SourceAnswer {
  const retained = retainedSegments(source);
  if (!retained.ok) {
    // A refused directory or watermark: report it, and keep the place for when it clears.
    const single = isSingleFile(source.records);
    const keep = isPositionList(given, single) ? given : [firstPosition(source)];
    const at = keep[0] as CursorPosition;
    return {
      items: [
        {
          kind: "gap",
          source: name,
          from: { seg: at.seg, off: at.off },
          to: { seg: at.seg, off: at.off },
          reason: "unreadable",
          detail: retained.reason,
        },
      ],
      next: keep,
      waiting: false,
    };
  }
  const { segs, watermark } = retained;
  const earliest: CursorPosition =
    segs[0] !== undefined ? { seg: segs[0], off: 0, tail: "" } : firstPosition(source, watermark);
  const reset = (): SourceAnswer => ({
    items: [{ kind: "reset", source: name, reason: "diverged", earliest }],
    next: [earliest],
    waiting: false,
  });

  const items: ResumeItem[] = [];
  let start: readonly CursorPosition[];
  if (given === undefined) {
    start = [earliest];
  } else if (!isPositionList(given, isSingleFile(source.records))) {
    return reset();
  } else {
    const live = given.filter((p) => p.seg >= watermark);
    const first = given[0] as CursorPosition;
    if (live.length === given.length) {
      start = given;
    } else {
      // Reading goes on from a position the vector already holds, so nothing is delivered twice.
      const to: CursorPosition = live[0] ?? { seg: watermark, off: 0, tail: "" };
      items.push({
        kind: "gap",
        source: name,
        from: { seg: first.seg, off: first.off },
        to: { seg: to.seg, off: to.off },
        reason: "evicted",
      });
      start = live.length > 0 ? live : [to];
    }
  }

  const last = (start[start.length - 1] as CursorPosition).seg;
  const plan: readonly CursorPosition[] = [
    ...start,
    ...segs.filter((seg) => seg > last).map((seg) => ({ seg, off: 0, tail: "" })),
  ];

  const budget: Budget = { lines: caps.maxLines, bytes: 0 };
  const reached: CursorPosition[] = [];
  let waiting = false;
  let stopped = false;
  for (const [index, position] of plan.entries()) {
    if (stopped) {
      // A position the vector holds keeps its place until a later call reaches it.
      if (index < start.length) reached.push(position);
      continue;
    }
    const read = readSegment(name, source, position, caps, budget, items);
    switch (read.outcome) {
      case "absent":
        if (position.off > 0) return reset();
        waiting = true;
        reached.push(position);
        break;
      case "diverged":
        return reset();
      case "refused":
        items.push({
          kind: "gap",
          source: name,
          from: { seg: position.seg, off: position.off },
          to: { seg: position.seg, off: position.off },
          reason: "unreadable",
          detail: read.reason,
        });
        reached.push(position);
        stopped = true;
        break;
      case "read":
        reached.push(read.at);
        waiting ||= read.torn;
        stopped = read.capped;
        break;
    }
  }
  return { items, next: reached.slice(-2), waiting };
}

/**
 * Resume every source from where the vector left off. Each source reads from its
 * positions, then its newer segments from 0; a source missing from the vector starts at
 * its earliest position. Caps are per source, and a capped source continues in the next
 * call with nothing lost.
 *
 * A cursor comes from a client, so nothing it holds can throw here: an entry that is
 * malformed, or that no longer fits its file, answers a reset; one naming a source not
 * passed in answers a reset with no `earliest` and is left out of `next`.
 *
 * `next` holds the last two segments read into, ascending, so a line landing in the
 * previous segment just after a roll is still delivered.
 *
 * First consumer: the resumable streams.
 */
export function resume(
  sources: ResumeSources,
  vector: CursorSources | undefined,
  caps: ResumeCaps,
): ResumeAnswer {
  requireCap("maxLines", caps.maxLines);
  requireCap("maxBytes", caps.maxBytes);
  const shaped = typeof vector === "object" && vector !== null && !Array.isArray(vector);
  const given = shaped ? (vector as Readonly<Record<string, unknown>>) : undefined;
  // A vector that is not one at all has no good entry for any source.
  const entryOf = (name: CursorSource): unknown =>
    vector === undefined ? undefined : given === undefined ? null : given[name];
  const items: ResumeItem[] = [];
  const next: Partial<Record<CursorSource, readonly CursorPosition[]>> = {};
  let waiting = false;
  for (const name of Object.keys(sources) as CursorSource[]) {
    const source = sources[name];
    if (source === undefined) continue;
    const answer = resumeSource(name, source, entryOf(name), caps);
    for (const item of answer.items) items.push(item);
    next[name] = answer.next;
    waiting ||= answer.waiting;
  }
  for (const name of Object.keys(given ?? {})) {
    if (sources[name as CursorSource] === undefined) {
      items.push({ kind: "reset", source: name as CursorSource, reason: "diverged" });
    }
  }
  return { items, next, waiting };
}
