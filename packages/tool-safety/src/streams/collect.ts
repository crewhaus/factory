import { onAbort } from "../signal";
import { byteBudget, optionalByteBudget } from "./limits";
import { concatBytes, decodeHead, decodeTail } from "./utf8";

/**
 * Reading a stream of unknown length into memory without letting its length
 * decide how much memory that takes.
 *
 * The pattern this replaces is `await new Response(stream).text()` followed
 * by a character cap: the cap bounds what is RETURNED, never what is held,
 * and a child printing `yes` fills gigabytes before the cap is applied.
 * Here the cap is applied as bytes arrive. Past it, the stream is still read
 * to the end — a child process writing into a full pipe blocks, and one that
 * blocks never exits — but the bytes are counted and dropped.
 *
 * Nothing is dropped silently: `truncated`, `totalBytes` and `omittedBytes`
 * say exactly how much was not kept, and `complete` says whether the end of
 * the stream was reached at all.
 */

export type CollectOptions = {
  /**
   * Most bytes kept in memory, head and tail together: a finite number >= 0.
   * NaN, a negative number or a missing value throws a `RangeError`.
   */
  readonly maxBytes: number;
  /**
   * Of `maxBytes`, how many to keep from the END of the stream when it
   * overflows — where a failing command prints its error. Default 0.
   */
  readonly tailBytes?: number;
  /** Seen for every chunk, before any of it is dropped. Must not throw. */
  readonly onChunk?: (chunk: Uint8Array, totalBytes: number) => void;
  /**
   * Stop reading early. The stream is cancelled and the result says
   * `complete: false`. Used to give up on a drain that outlives its process.
   */
  readonly signal?: AbortSignal;
};

export type CollectResult = {
  /** The kept head (everything, when not truncated). */
  readonly bytes: Uint8Array;
  /** `bytes` decoded as UTF-8, an incomplete final character dropped. */
  readonly text: string;
  /** More bytes arrived than were kept. */
  readonly truncated: boolean;
  /** Every byte that arrived, kept or not. Exact when `complete`. */
  readonly totalBytes: number;
  /** `totalBytes` minus what is in `bytes` and `tail`. */
  readonly omittedBytes: number;
  /** The last `tailBytes` bytes, present only when truncated with a tail. */
  readonly tail?: Uint8Array;
  readonly tailText?: string;
  /** The end of the stream was reached. False when stopped, aborted or failed. */
  readonly complete: boolean;
  /** Why the stream stopped early, when it failed rather than was stopped. */
  readonly error?: string;
};

type ChunkReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
};

function readerFor(source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>): ChunkReader {
  if (source instanceof ReadableStream) {
    const reader = source.getReader();
    return {
      read: async () => {
        const r = await reader.read();
        return r.done ? { done: true } : { done: false, value: r.value };
      },
      cancel: async () => {
        await reader.cancel().catch(() => undefined);
      },
    };
  }
  const it = source[Symbol.asyncIterator]();
  return {
    read: async () => {
      const r = await it.next();
      return r.done === true ? { done: true } : { done: false, value: r.value };
    },
    cancel: async () => {
      await it.return?.().catch(() => undefined);
    },
  };
}

export async function collectBounded(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  options: CollectOptions,
): Promise<CollectResult> {
  const maxBytes = byteBudget("maxBytes", options.maxBytes);
  const tailBytes = Math.min(maxBytes, optionalByteBudget("tailBytes", options.tailBytes, 0));
  const headCap = maxBytes - tailBytes;

  const head: Uint8Array[] = [];
  let headLength = 0;
  // The tail is a queue of recent slices, trimmed from the front, so it
  // never holds more than `tailBytes` plus one chunk.
  const tail: Uint8Array[] = [];
  let tailLength = 0;
  let totalBytes = 0;
  let complete = false;
  let error: string | undefined;

  const reader = readerFor(source);
  const signal = options.signal;
  let stopped = signal?.aborted === true;
  const unsubscribe = onAbort(signal, () => {
    stopped = true;
    void reader.cancel();
  });

  try {
    while (!stopped) {
      let next: { done: boolean; value?: Uint8Array };
      try {
        next = await reader.read();
      } catch (err) {
        if (!stopped) error = err instanceof Error ? err.message : String(err);
        break;
      }
      if (next.done) {
        complete = !stopped;
        break;
      }
      const chunk = next.value;
      if (chunk === undefined || chunk.length === 0) continue;
      totalBytes += chunk.length;
      options.onChunk?.(chunk, totalBytes);
      let rest = chunk;
      if (headLength < headCap) {
        const take = Math.min(headCap - headLength, rest.length);
        head.push(rest.slice(0, take));
        headLength += take;
        rest = rest.subarray(take);
      }
      if (rest.length > 0 && tailBytes > 0) {
        const keep = rest.length > tailBytes ? rest.subarray(rest.length - tailBytes) : rest;
        tail.push(keep.slice());
        tailLength += keep.length;
        while (tail.length > 1 && tailLength - (tail[0] as Uint8Array).length >= tailBytes) {
          tailLength -= (tail.shift() as Uint8Array).length;
        }
      }
    }
  } finally {
    unsubscribe();
    if (stopped || error !== undefined) await reader.cancel();
  }

  const tailAll = concatBytes(tail, tailLength);
  const tailKept = tailAll.subarray(Math.max(0, tailAll.length - tailBytes));
  const truncated = totalBytes > maxBytes;
  const base = { totalBytes, complete, ...(error === undefined ? {} : { error }) };
  if (!truncated) {
    // Everything fits: head and tail are contiguous.
    const bytes = concatBytes([...head, tailKept], headLength + tailKept.length);
    return {
      ...base,
      bytes,
      text: decodeHead(bytes, complete),
      truncated: false,
      omittedBytes: 0,
    };
  }
  const bytes = concatBytes(head, headLength);
  const kept = bytes.length + tailKept.length;
  return {
    ...base,
    bytes,
    text: decodeHead(bytes, false),
    truncated: true,
    omittedBytes: totalBytes - kept,
    ...(tailBytes > 0 ? { tail: tailKept, tailText: decodeTail(tailKept) } : {}),
  };
}
