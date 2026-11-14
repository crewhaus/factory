/**
 * Server-sent events, read from a byte stream: `id`, `event` and `data` fields, one
 * frame per blank line, a comment line (`:`) skipped, so a heartbeat is never a frame.
 * A frame split across chunks, or a line split across chunks, reads whole.
 */

export type SseFrame = {
  readonly id?: string;
  readonly event?: string;
  /** Every `data:` line of the frame, joined with newlines. */
  readonly data: string;
};

function frameOf(lines: readonly string[]): SseFrame | undefined {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  let fields = 0;
  for (const line of lines) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const name = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (name === "id") {
      id = value;
      fields++;
    } else if (name === "event") {
      event = value;
      fields++;
    } else if (name === "data") {
      data.push(value);
      fields++;
    }
  }
  if (fields === 0) return undefined;
  return {
    ...(id !== undefined ? { id } : {}),
    ...(event !== undefined ? { event } : {}),
    data: data.join("\n"),
  };
}

/** Every frame on the stream, in order, until it ends. */
export async function* readSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lines: string[] = [];
  const take = function* (final: boolean): Generator<SseFrame> {
    for (;;) {
      const match = /\r\n|\r|\n/.exec(buffer);
      // A lone `\r` at the end may be the first half of `\r\n`: wait for the next chunk.
      if (match === null || (!final && match[0] === "\r" && match.index === buffer.length - 1)) {
        break;
      }
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (line === "") {
        const frame = frameOf(lines);
        lines = [];
        if (frame !== undefined) yield frame;
      } else {
        lines.push(line);
      }
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* take(false);
    }
    buffer += decoder.decode();
    yield* take(true);
    // A frame the stream ended in the middle of is not one: it never got its blank line.
  } finally {
    reader.releaseLock();
  }
}
