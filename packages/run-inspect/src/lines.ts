/**
 * One reader for one session log inside one session root: contained, bounded and
 * read-only. Every complete line gets the id `s:<byte offset>`; a line that does not
 * parse becomes a `torn` gap and reading goes on; a size limit becomes a `truncated`
 * gap. It takes no lock and creates nothing.
 */
import { existsSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { openRecordFd } from "@crewhaus/control-records";
import type { InspectGap } from "./model";

/** One parsed session-log line, and where it starts. */
export type SessionLine = {
  /** `s:<byte offset>`. */
  readonly id: string;
  readonly off: number;
  /** Epoch ms, as the line records it; `NaN` when it records none. */
  readonly ts: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly run?: string;
  readonly span?: string;
};

/** Called for every read the reader makes: where, and how many bytes. A test seam. */
export type ReadObserver = (position: number, length: number) => void;

/** How far the wake look-behind reads below the run's first byte, at most. */
export const WAKE_LOOK_BEHIND_BYTES = 64 * 1024;
const LOOK_BEHIND_CHUNK = 4096;
const FORWARD_CHUNK = 1024 * 1024;

/** `child` is `parent` or lies inside it. Both real and absolute. */
export function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Where a checked session root sits inside its harness: the harness's real path, and the
 * root's path in it. Reads named this way are proven inside the harness at the moment
 * they open, so a folder swapped for a link out of the harness after the check is never
 * read through. `undefined` when the root does not lie inside the harness.
 */
export type SessionsPlace = { readonly harness: string; readonly rel: string };

export function sessionsPlace(harnessDir: string, root: string): SessionsPlace | undefined {
  let harness: string;
  try {
    harness = realpathSync(harnessDir);
  } catch {
    return undefined;
  }
  // The root's real path; a part not made yet keeps its name.
  let existing = root;
  let rest = "";
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return undefined;
    rest = rest === "" ? relative(parent, existing) : join(relative(parent, existing), rest);
    existing = parent;
  }
  let real: string;
  try {
    real = join(realpathSync(existing), rest);
  } catch {
    return undefined;
  }
  return inside(harness, real) ? { harness, rel: relative(harness, real) } : undefined;
}

export type OpenedLog =
  | { readonly ok: true; readonly fd: number; readonly size: number }
  | { readonly ok: false; readonly missing: boolean; readonly reason: string };

/** Why a session log is not read, by the contained open's refusal. */
const REFUSED: Readonly<Record<string, string>> = Object.freeze({
  "is-symlink": "the session log is a link, which is not read",
  "escapes-root": "the session log leads out of the sessions folder",
  changed: "the session log leads out of the sessions folder",
  "not-regular-file": "the session log is not a file",
});

/**
 * Open the session log `name` of the sessions folder at `place` through the control
 * records' contained open, rooted at the harness: the path must resolve inside the
 * harness, the log must not itself be a link, and must be a regular file; and the
 * descriptor it opened is checked to lie inside the harness, so a folder swapped for a
 * link out of it at any time before the open is refused, never read.
 */
export function openContained(place: SessionsPlace, name: string): OpenedLog {
  const opened = openRecordFd(place.harness, join(place.rel, name));
  if (opened.ok) return { ok: true, fd: opened.fd, size: opened.stats.size };
  if (opened.code === "not-found") {
    return { ok: false, missing: true, reason: "the session log is not there" };
  }
  return {
    ok: false,
    missing: false,
    reason: Object.hasOwn(REFUSED, opened.code)
      ? (REFUSED[opened.code] as string)
      : "the session log can't be opened",
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** One line's bytes parsed, or `undefined` when it is not a session-log line. */
export function parseLine(off: number, text: string): SessionLine | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const record = asRecord(value);
  if (record === undefined || typeof record["kind"] !== "string") return undefined;
  const run = record["run"];
  const span = record["span"];
  return {
    id: `s:${off}`,
    off,
    ts: typeof record["ts"] === "number" ? record["ts"] : Number.NaN,
    kind: record["kind"],
    payload: record["payload"],
    ...(typeof run === "string" ? { run } : {}),
    ...(typeof span === "string" ? { span } : {}),
  };
}

export type ForwardRead = {
  readonly lines: readonly SessionLine[];
  readonly gaps: readonly InspectGap[];
  /** The end of the last complete line read. */
  readonly end: number;
};

/**
 * Read forward from `from` to the end of the file, at most `maxBytes`. A complete line
 * that does not parse is a `torn` gap; an incomplete last line is too; a limit that
 * leaves bytes unread is a `truncated` gap from where reading stopped.
 */
export function readForward(
  fd: number,
  size: number,
  from: number,
  maxBytes: number,
  onRead?: ReadObserver,
): ForwardRead {
  const lines: SessionLine[] = [];
  const gaps: InspectGap[] = [];
  const limit = Math.min(size, from + maxBytes);
  let pos = from;
  let carry: Buffer = Buffer.alloc(0);
  let carryOff = from;
  const handle = (off: number, bytes: Buffer): void => {
    if (bytes.length === 0) return;
    const text = bytes.toString("utf8");
    if (text.trim() === "") return;
    const line = parseLine(off, text);
    if (line === undefined) gaps.push({ reason: "torn", from: `s:${off}`, count: 1 });
    else lines.push(line);
  };
  while (pos < limit) {
    const want = Math.min(FORWARD_CHUNK, limit - pos);
    const buf = Buffer.allocUnsafe(want);
    const got = readSync(fd, buf, 0, want, pos);
    onRead?.(pos, got);
    if (got <= 0) break;
    pos += got;
    const data =
      carry.length > 0 ? Buffer.concat([carry, buf.subarray(0, got)]) : buf.subarray(0, got);
    let start = 0;
    for (;;) {
      const nl = data.indexOf(10, start);
      if (nl === -1) break;
      handle(carryOff + start, data.subarray(start, nl));
      start = nl + 1;
    }
    carryOff += start;
    carry = Buffer.from(data.subarray(start));
  }
  if (carry.length > 0 && pos >= size) {
    gaps.push({ reason: "torn", from: `s:${carryOff}`, count: 1 });
  } else if (carryOff < size && pos < size) {
    gaps.push({ reason: "truncated", from: `s:${carryOff}`, to: `s:${size}` });
  }
  return { lines, gaps, end: carryOff };
}

/**
 * Read backward from `from`, line by line, at most `maxBytes`, stopping at the first
 * `run_stamp` line, and answer only the unscoped `user_message` lines whose
 * `payload.control.synthetic` is true: the candidates for an operator's wake marker,
 * oldest first. Nothing else read there is answered, and a line that does not parse is
 * skipped.
 */
export function scanBackForWakeMarkers(
  fd: number,
  from: number,
  maxBytes: number = WAKE_LOOK_BEHIND_BYTES,
  onRead?: ReadObserver,
): readonly SessionLine[] {
  const floor = Math.max(0, from - maxBytes);
  const found: SessionLine[] = [];
  let lo = from;
  // Bytes [lo, cut) not yet split into lines: the start of the line ending at `cut` is
  // not read yet.
  let tail: Buffer = Buffer.alloc(0);
  while (lo > floor) {
    const start = Math.max(floor, lo - LOOK_BEHIND_CHUNK);
    const buf = Buffer.allocUnsafe(lo - start);
    const got = readSync(fd, buf, 0, lo - start, start);
    onRead?.(start, got);
    if (got !== lo - start) return found.reverse();
    lo = start;
    const data = Buffer.concat([buf, tail]);
    let end = data.length;
    while (end > 0) {
      const body = data[end - 1] === 10 ? end - 1 : end;
      const nl = body > 0 ? data.lastIndexOf(10, body - 1) : -1;
      if (nl === -1 && lo > 0) break;
      const lineStart = nl + 1;
      const line = parseLine(lo + lineStart, data.subarray(lineStart, body).toString("utf8"));
      if (line?.kind === "run_stamp") return found.reverse();
      if (line !== undefined && isWakeMarker(line)) found.push(line);
      end = lineStart;
    }
    tail = Buffer.from(data.subarray(0, end));
  }
  return found.reverse();
}

/** An unscoped `user_message` that an operator's wake wrote. */
export function isWakeMarker(line: SessionLine): boolean {
  if (line.kind !== "user_message" || line.run !== undefined) return false;
  const control = asRecord(asRecord(line.payload)?.["control"]);
  return control?.["synthetic"] === true;
}

/** A whole JSONL text as session-log lines, with ids from offset 0. */
export function linesFromText(text: string): ForwardRead {
  const lines: SessionLine[] = [];
  const gaps: InspectGap[] = [];
  const bytes = Buffer.from(text, "utf8");
  let start = 0;
  for (;;) {
    const nl = bytes.indexOf(10, start);
    const stop = nl === -1 ? bytes.length : nl;
    const chunk = bytes.subarray(start, stop).toString("utf8");
    if (chunk.trim() !== "") {
      const line = parseLine(start, chunk);
      if (line === undefined) gaps.push({ reason: "torn", from: `s:${start}`, count: 1 });
      else lines.push(line);
    }
    if (nl === -1) break;
    start = nl + 1;
  }
  return { lines, gaps, end: bytes.length };
}
