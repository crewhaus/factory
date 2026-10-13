/**
 * Server-sent-events framing, per the WHATWG event-stream rules.
 *
 * The wire format is simple and the mistakes are always the same ones, so
 * they are handled here rather than in the tool:
 *
 *   - an event ends at a BLANK line, not at a newline;
 *   - `data:` accumulates across lines, joined with `\n`;
 *   - a single leading space after the colon is stripped, and only one;
 *   - a line with no colon is a field name with an empty value;
 *   - a line starting with `:` is a comment (this is what keep-alives are);
 *   - `\r\n`, `\r` and `\n` are all line terminators.
 *
 * This is a feed, so events keep arrival order.
 */

export type SseEvent = {
  /** The `event:` field, or `"message"` when the stream did not set one. */
  readonly event: string;
  /** Joined `data:` lines. Empty string when the frame carried no data. */
  readonly data: string;
  readonly id?: string;
  /** The `retry:` field in milliseconds, when the frame set a valid one. */
  readonly retry?: number;
};

/**
 * Incremental decoder. Feed it chunks as they arrive; each call returns the
 * events that COMPLETED in that chunk. Anything partial is held back until
 * its blank line shows up.
 *
 * Each chunk is read once. The frame still open is kept in pieces and
 * joined when its blank line arrives; normalising and splitting everything
 * held so far on every chunk was quadratic in a long frame a server sends a
 * little at a time.
 */
export class SseDecoder {
  /**
   * The frame still open, in pieces: terminators already normalised to
   * `\n`, and no blank line in it, though it can end in a line break.
   */
  private readonly open: string[] = [];
  /** A trailing `\r` held back from the last chunk, or "". */
  private carry = "";

  /** Push a chunk and take whatever events it completed. */
  push(chunk: string): readonly SseEvent[] {
    // A chunk can end mid-CRLF. Normalising a trailing lone `\r` to `\n` now
    // and appending the `\n` that arrives next turns ONE line terminator into
    // a blank line, which splits one event into two — so a trailing `\r` is
    // held back until the byte after it is known.
    let text = this.carry + chunk;
    this.carry = "";
    if (text.endsWith("\r")) {
      this.carry = "\r";
      text = text.slice(0, -1);
    }
    // Normalise terminators so one split handles all three forms.
    let normalized = text.replace(/\r\n|\r/g, "\n");
    const frames: string[] = [];
    // The open frame ends in at most one line break, so a blank line can
    // straddle the chunks only as its last `\n` and this chunk's first.
    if (normalized.startsWith("\n") && this.endsInBreak()) {
      frames.push(this.take().slice(0, -1));
      normalized = normalized.slice(1);
    }
    const parts = normalized.split("\n\n");
    // The last element is the incomplete tail — it stays open.
    const tail = parts.pop() ?? "";
    if (parts.length > 0) {
      frames.push(this.take() + parts[0]);
      for (let i = 1; i < parts.length; i++) frames.push(parts[i] as string);
    }
    if (tail !== "") this.open.push(tail);
    const events: SseEvent[] = [];
    for (const frame of frames) {
      const event = decodeFrame(frame);
      if (event !== null) events.push(event);
    }
    return events;
  }

  /**
   * Whatever is still buffered when the stream ends. A server that closes
   * without a trailing blank line has still sent a complete event, and
   * dropping it silently is how a caller loses the last message.
   */
  flush(): readonly SseEvent[] {
    // A held-back `\r` ends the last line after all.
    const tail = this.take() + (this.carry === "" ? "" : "\n");
    this.carry = "";
    const event = decodeFrame(tail);
    return event === null ? [] : [event];
  }

  private endsInBreak(): boolean {
    const last = this.open[this.open.length - 1];
    return last?.endsWith("\n") === true;
  }

  /** The open frame as one string, and nothing held after it. */
  private take(): string {
    const held = this.open.join("");
    this.open.length = 0;
    return held;
  }
}

/** Decode one frame. `null` when it held only comments or whitespace. */
export function decodeFrame(frame: string): SseEvent | null {
  const dataLines: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;
  let sawField = false;

  for (const line of frame.split("\n")) {
    if (line === "") continue;
    if (line.startsWith(":")) continue; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    sawField = true;
    switch (field) {
      case "data":
        dataLines.push(value);
        break;
      case "event":
        event = value;
        break;
      case "id":
        // The spec ignores an id containing NUL; so do we.
        if (!value.includes("\0")) id = value;
        break;
      case "retry": {
        const ms = Number.parseInt(value, 10);
        if (/^\d+$/.test(value) && Number.isFinite(ms)) retry = ms;
        break;
      }
      default:
        // Unknown field — the spec says ignore it.
        break;
    }
  }

  if (!sawField) return null;
  return {
    event: event ?? "message",
    data: dataLines.join("\n"),
    ...(id !== undefined ? { id } : {}),
    ...(retry !== undefined ? { retry } : {}),
  };
}
