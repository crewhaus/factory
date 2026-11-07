/**
 * Splitting a record file into lines, in either direction, in fixed chunks.
 * Internal: `readTail`, `readPage`, `resume` and the folds are built on it.
 *
 * A line is only ever decoded whole: `\n` never occurs inside a UTF-8 sequence, so
 * splitting on the byte cannot cut a character. A long line costs reading it, not
 * holding it: past `maxLine` the bytes are dropped and the line reports `data: null`.
 */
import { createHash } from "node:crypto";
import { decodeStrict, parseObject, readAt } from "./io";

export const CHUNK_BYTES = 64 * 1024;
/** How many bytes before an offset its `tail` covers. */
export const TAIL_WINDOW_BYTES = 64;

const NEWLINE = 0x0a;

export type RawLine = {
  /** Offset of the line's first byte. */
  readonly off: number;
  /** Bytes the line occupies, its `\n` included: `off + bytes` is the next line. */
  readonly bytes: number;
  /** The line without its `\n`, or `null` when it is longer than the scan's `maxLine`. */
  readonly data: Buffer | null;
};

export type LineValue =
  | { readonly kind: "blank" }
  | { readonly kind: "record"; readonly record: Record<string, unknown> }
  | { readonly kind: "malformed" };

/** What a line holds. Anything that does not parse to a JSON object is malformed. */
export function classifyLine(line: RawLine): LineValue {
  if (line.data === null) return { kind: "malformed" };
  const text = decodeStrict(line.data);
  if (text === undefined) return { kind: "malformed" };
  if (text.trim() === "") return { kind: "blank" };
  const record = parseObject(text);
  return record === undefined ? { kind: "malformed" } : { kind: "record", record };
}

/** The first 8 hex of sha256 over `window`: a position's check of the bytes before it. */
export function hashTail(window: Uint8Array): string {
  return createHash("sha256").update(window).digest("hex").slice(0, 8);
}

/** The `tail` of offset `off` in the open file: `""` at offset 0. */
export function tailAt(fd: number, off: number): string {
  if (off === 0) return "";
  const from = Math.max(0, off - TAIL_WINDOW_BYTES);
  const window = Buffer.allocUnsafe(off - from);
  const got = readAt(fd, window, off - from, from);
  return hashTail(window.subarray(0, got));
}

/**
 * Whether offset `off` with this `tail` still fits the open file: inside it, just
 * past a `\n`, and the bytes before it hash the same. Offset 0 has nothing before it.
 */
export function offsetFits(fd: number, size: number, off: number, tail: string): boolean {
  if (off === 0) return tail === "";
  if (size < off) return false;
  const from = Math.max(0, off - TAIL_WINDOW_BYTES);
  const window = Buffer.allocUnsafe(off - from);
  if (readAt(fd, window, off - from, from) !== off - from) return false;
  return window[window.length - 1] === NEWLINE && hashTail(window) === tail;
}

/** Offset just past the last complete line of the first `size` bytes; 0 when there is none. */
export function endOfLastCompleteLine(fd: number, size: number): number {
  let pos = size;
  while (pos > 0) {
    const want = Math.min(CHUNK_BYTES, pos);
    const chunk = Buffer.allocUnsafe(want);
    if (readAt(fd, chunk, want, pos - want) < want) return 0;
    pos -= want;
    const nl = chunk.lastIndexOf(NEWLINE);
    if (nl !== -1) return pos + nl + 1;
  }
  return 0;
}

/** A line being gathered chunk by chunk, dropped once it passes the cap. */
class LineParts {
  private parts: Buffer[] = [];
  private kept = 0;
  private overlong = false;

  constructor(private readonly maxLine: number) {}

  private add(bytes: Buffer): boolean {
    if (this.overlong) return false;
    if (this.kept + bytes.length > this.maxLine) {
      this.overlong = true;
      this.parts = [];
      this.kept = 0;
      return false;
    }
    this.kept += bytes.length;
    return true;
  }

  /** Bytes that go after what is held. */
  append(bytes: Buffer): void {
    if (this.add(bytes)) this.parts.push(bytes);
  }

  /** Bytes that go before what is held. */
  prepend(bytes: Buffer): void {
    if (this.add(bytes)) this.parts.unshift(bytes);
  }

  /** The whole line, or `null` when it was too long, and start over. */
  take(): Buffer | null {
    const line = this.overlong ? null : Buffer.concat(this.parts);
    this.parts = [];
    this.kept = 0;
    this.overlong = false;
    return line;
  }
}

/** `go` reads on; `stop-after` ends past this line; `stop-before` ends at its start. */
export type ForwardStep = "go" | "stop-after" | "stop-before";

/**
 * Visit each complete line of `[start, end)`, oldest first. `next` is the offset of
 * the first line not consumed; `torn` is true when the bytes from `next` to `end`
 * have no `\n` yet.
 */
export function scanForward(
  fd: number,
  start: number,
  end: number,
  maxLine: number,
  visit: (line: RawLine) => ForwardStep,
): { readonly next: number; readonly torn: boolean } {
  const held = new LineParts(maxLine);
  let pos = start;
  let lineStart = start;
  let limit = end;
  while (pos < limit) {
    const want = Math.min(CHUNK_BYTES, limit - pos);
    const chunk = Buffer.allocUnsafe(want);
    const got = readAt(fd, chunk, want, pos);
    // The file shrank under the read: what remains is what there is.
    if (got < want) limit = pos + got;
    const view = chunk.subarray(0, got);
    let from = 0;
    for (;;) {
      const nl = view.indexOf(NEWLINE, from);
      if (nl === -1) break;
      held.append(view.subarray(from, nl));
      const after = pos + nl + 1;
      const step = visit({ off: lineStart, bytes: after - lineStart, data: held.take() });
      if (step === "stop-before") return { next: lineStart, torn: false };
      if (step === "stop-after") return { next: after, torn: false };
      lineStart = after;
      from = nl + 1;
    }
    held.append(view.subarray(from));
    pos += got;
  }
  return { next: lineStart, torn: lineStart < limit };
}

/** Why {@link scanBack} ended: the start of the file, `visit`, its budget, or a shrunk file. */
export type BackOutcome = "start" | "stopped" | "budget" | "short";

/**
 * Visit each complete line of the first `end` bytes, newest first, reading backwards
 * until `visit` answers `true` or `maxRead` is spent (at most `maxRead` plus one chunk
 * is read). Bytes after the last `\n` are a torn line: reported, never visited.
 */
export function scanBack(
  fd: number,
  end: number,
  limits: { readonly maxRead: number; readonly maxLine: number },
  visit: (line: RawLine) => boolean,
): { readonly outcome: BackOutcome; readonly torn: boolean } {
  const held = new LineParts(limits.maxLine);
  let pos = end;
  let bytesRead = 0;
  // Exclusive end of the line being gathered, past its `\n`.
  let lineEnd = end;
  let foundEnd = false;
  let torn = false;
  while (pos > 0) {
    if (bytesRead >= limits.maxRead) return { outcome: "budget", torn };
    const want = Math.min(CHUNK_BYTES, pos);
    const chunk = Buffer.allocUnsafe(want);
    const got = readAt(fd, chunk, want, pos - want);
    bytesRead += got;
    if (got < want) return { outcome: "short", torn };
    pos -= want;
    let hi = want;
    if (!foundEnd) {
      // The last `\n` ends the newest complete line; anything after it is torn.
      const nl = chunk.lastIndexOf(NEWLINE);
      if (nl !== want - 1) torn = true;
      if (nl === -1) continue;
      foundEnd = true;
      lineEnd = pos + nl + 1;
      hi = nl;
    }
    for (;;) {
      const nl = chunk.subarray(0, hi).lastIndexOf(NEWLINE);
      if (nl === -1) break;
      held.prepend(chunk.subarray(nl + 1, hi));
      const off = pos + nl + 1;
      if (visit({ off, bytes: lineEnd - off, data: held.take() })) {
        return { outcome: "stopped", torn };
      }
      lineEnd = off;
      hi = nl;
    }
    held.prepend(chunk.subarray(0, hi));
  }
  if (foundEnd && lineEnd > 0) {
    if (visit({ off: 0, bytes: lineEnd, data: held.take() })) return { outcome: "stopped", torn };
  }
  return { outcome: "start", torn };
}
