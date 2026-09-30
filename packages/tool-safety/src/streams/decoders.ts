import * as zlib from "node:zlib";

/**
 * The step decoders {@link ../response.decodeBody} feeds a compressed body
 * through, a few kilobytes at a time.
 *
 * TWO THINGS THE RUNTIME'S ZLIB STREAMS DO THAT A CALLER MUST NOT WAIT ON
 * (measured, Bun 1.3.14):
 *
 * - On corrupt input the stream emits `error` and `close` and never calls
 *   the write callback. A step that awaits only the callback waits forever,
 *   and so does every deadline raced around the step's caller. So a step
 *   settles on the callback OR on `error`/`close`, whichever comes first.
 * - When the encoded data ends inside a write, the engine stops consuming:
 *   `bytesWritten` stays below what was fed. That is how a decoder here
 *   knows its data is over (`complete`) and which bytes of the last step
 *   were not part of it (`unconsumed`), without guessing from error text.
 *
 * GZIP IS FRAMED HERE, NOT BY `createGunzip`. The runtime's gunzip reads
 * whatever follows a member as the start of another one, so a gzip body
 * followed by a stray CRLF (output after a PHP `?>`, some proxies) fails
 * with "incorrect header check", after throwing away the output of the
 * member it had just decoded. Bun's own fetch decoder, curl and browsers
 * all read the FIRST member and ignore what follows. So the header and the
 * trailer are parsed here, the deflate data between them goes through
 * `createInflateRaw`, the trailer's CRC-32 and length are checked, and
 * anything after the first member is not read at all: exactly what 0.7.0
 * returned for such a body, when Bun decoded it natively.
 */

/** A decoder fed in steps. */
export interface StepDecoder {
  /**
   * Feed one step of encoded bytes. Resolves once they are processed, or
   * once the decoder has stopped (failed, finished or been destroyed); it
   * never waits on a callback that is not coming.
   */
  write(step: Uint8Array): Promise<void>;
  /** The input is over: flush. Resolves once the decoder has ended or failed. */
  finish(): Promise<void>;
  /** Why the encoded data is corrupt, once that is known. */
  readonly error: string | undefined;
  /**
   * The encoded data ended before the input did. Whatever follows is not
   * part of the body; the caller stops reading it.
   */
  readonly complete: boolean;
  destroy(): void;
}

type ZlibStream = zlib.Gunzip | zlib.Inflate | zlib.InflateRaw | zlib.BrotliDecompress;

const EMPTY = new Uint8Array(0);

/** A runtime zlib/brotli/zstd decompression stream behind {@link StepDecoder}. */
export class StreamStepDecoder implements StepDecoder {
  error: string | undefined;
  complete = false;
  /** When `complete`: the tail of the last step that was not part of the data. */
  unconsumed: Uint8Array = EMPTY;
  private fed = 0;
  private ended = false;
  /** Settles on `error` or `close`: the stream will call no more callbacks. */
  private readonly stopped: Promise<void>;
  /** Settles on `end`, `error` or `close`. */
  private readonly settled: Promise<void>;

  constructor(
    private readonly stream: ZlibStream,
    onData: (chunk: Uint8Array) => void,
  ) {
    stream.on("data", onData);
    this.stopped = new Promise<void>((resolve) => {
      stream.once("close", () => resolve());
      stream.once("error", (err: Error) => {
        this.error ??= err.message;
        resolve();
      });
    });
    this.settled = new Promise<void>((resolve) => {
      stream.once("end", () => {
        this.ended = true;
        resolve();
      });
      void this.stopped.then(resolve);
    });
  }

  private get done(): boolean {
    return this.error !== undefined || this.complete || this.stream.destroyed;
  }

  write(step: Uint8Array): Promise<void> {
    if (this.done || step.length === 0) return Promise.resolve();
    this.fed += step.length;
    return new Promise<void>((resolve) => {
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        // A stream destroyed at the caller's cap stopped mid-step: that is
        // not the data ending.
        if (this.error === undefined && !this.stream.destroyed) {
          const left = this.fed - this.stream.bytesWritten;
          if (left > 0 || this.ended) {
            this.complete = true;
            this.unconsumed = step.subarray(Math.max(0, step.length - left));
          }
        }
        resolve();
      };
      this.stream.write(step, () => settle());
      void this.stopped.then(settle);
    });
  }

  finish(): Promise<void> {
    if (this.done) return Promise.resolve();
    this.stream.end();
    return this.settled;
  }

  destroy(): void {
    if (!this.stream.destroyed) this.stream.destroy();
  }
}

// ---------------------------------------------------------------------------
// CRC-32 (the gzip trailer's)
// ---------------------------------------------------------------------------

const CRC_TABLE: Int32Array = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** CRC-32 (ISO-HDLC, gzip's) of `bytes`, continuing from `previous`. */
export function crc32Js(bytes: Uint8Array, previous = 0): number {
  let c = ~previous;
  for (let i = 0; i < bytes.length; i++) {
    c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return ~c >>> 0;
}

const nativeCrc32 = (zlib as unknown as { crc32?: (data: Uint8Array, value?: number) => number })
  .crc32;

/** The runtime's `zlib.crc32` where it has one (fast), else {@link crc32Js}. */
export const crc32: (bytes: Uint8Array, previous?: number) => number =
  typeof nativeCrc32 === "function"
    ? (bytes, previous = 0) => nativeCrc32(bytes, previous) >>> 0
    : crc32Js;

// ---------------------------------------------------------------------------
// gzip (RFC 1952), first member only
// ---------------------------------------------------------------------------

const FHCRC = 0x02;
const FEXTRA = 0x04;
const FNAME = 0x08;
const FCOMMENT = 0x10;
const FRESERVED = 0xe0;
/**
 * The longest header read. A name or comment is unbounded by the format;
 * 64 KiB of either is already absurd, and without a bound a server could
 * keep the reader on a header that never ends.
 */
const MAX_HEADER_BYTES = 256 * 1024;

type HeaderField = "fixed" | "xlen" | "extra" | "name" | "comment" | "hcrc" | "done";

/** RFC 1952's member header, parsed as bytes arrive; nothing is kept but the flags. */
class GzipHeader {
  field: HeaderField = "fixed";
  error: string | undefined;
  private readonly fixed = new Uint8Array(10);
  private have = 0;
  private flags = 0;
  private remaining = 0;
  private total = 0;
  private crc = 0;

  /** Consume header bytes from `input`; returns how many were header. */
  push(input: Uint8Array): number {
    let i = 0;
    const take = (n: number): Uint8Array => {
      const part = input.subarray(i, i + n);
      i += part.length;
      return part;
    };
    while (i < input.length && this.field !== "done" && this.error === undefined) {
      const start = i;
      const field = this.field;
      switch (field) {
        case "fixed": {
          const part = take(10 - this.have);
          this.fixed.set(part, this.have);
          this.have += part.length;
          if (this.have < 10) break;
          const f = this.fixed;
          if (f[0] !== 0x1f || f[1] !== 0x8b) {
            this.error = "it does not start with the gzip signature";
          } else if (f[2] !== 8) {
            this.error = `its gzip header names compression method ${f[2]}, not deflate`;
          } else if (((f[3] as number) & FRESERVED) !== 0) {
            this.error = "its gzip header sets reserved flags";
          } else {
            this.flags = f[3] as number;
            this.advance("fixed");
          }
          break;
        }
        case "xlen": {
          const part = take(2 - this.have);
          this.fixed.set(part, this.have);
          this.have += part.length;
          if (this.have < 2) break;
          this.remaining = (this.fixed[0] as number) | ((this.fixed[1] as number) << 8);
          if (this.remaining === 0) this.advance("extra");
          else {
            this.field = "extra";
            this.have = 0;
          }
          break;
        }
        case "extra": {
          const part = take(this.remaining);
          this.remaining -= part.length;
          if (this.remaining === 0) this.advance("extra");
          break;
        }
        case "name":
        case "comment": {
          const zero = input.indexOf(0, i);
          i = zero < 0 ? input.length : zero + 1;
          if (zero >= 0) this.advance(field);
          break;
        }
        case "hcrc": {
          const part = take(2 - this.have);
          this.fixed.set(part, this.have);
          this.have += part.length;
          if (this.have < 2) break;
          const stored = (this.fixed[0] as number) | ((this.fixed[1] as number) << 8);
          if (stored !== (this.crc & 0xffff)) this.error = "its gzip header checksum is wrong";
          else this.field = "done";
          break;
        }
      }
      // The header CRC covers every header byte before it.
      if (field !== "hcrc") this.crc = crc32(input.subarray(start, i), this.crc);
      this.total += i - start;
      if (this.error === undefined && this.field !== "done" && this.total > MAX_HEADER_BYTES) {
        this.error = `its gzip header runs past ${MAX_HEADER_BYTES} bytes`;
      }
    }
    return i;
  }

  /** Move past `field` to the next one the flags call for. */
  private advance(from: HeaderField): void {
    const order: HeaderField[] = ["fixed", "xlen", "name", "comment", "hcrc", "done"];
    const wanted = (field: HeaderField): boolean => {
      switch (field) {
        case "xlen":
          return (this.flags & FEXTRA) !== 0;
        case "name":
          return (this.flags & FNAME) !== 0;
        case "comment":
          return (this.flags & FCOMMENT) !== 0;
        case "hcrc":
          return (this.flags & FHCRC) !== 0;
        default:
          return true;
      }
    };
    let at = order.indexOf(from === "extra" ? "xlen" : from) + 1;
    while (!wanted(order[at] as HeaderField)) at += 1;
    this.field = order[at] as HeaderField;
    this.have = 0;
  }
}

/**
 * One gzip member: the header and trailer parsed here, the deflate data in
 * between inflated by the runtime, the trailer's CRC-32 and size checked,
 * and everything after the member left unread. See the module comment.
 */
export class GzipStepDecoder implements StepDecoder {
  error: string | undefined;
  private stage: "header" | "body" | "trailer" | "done" = "header";
  private readonly header = new GzipHeader();
  private readonly inner: StreamStepDecoder;
  private readonly trailer = new Uint8Array(8);
  private trailerLength = 0;
  private crc = 0;
  private size = 0;

  constructor(onData: (chunk: Uint8Array) => void) {
    this.inner = new StreamStepDecoder(zlib.createInflateRaw(), (chunk) => {
      this.crc = crc32(chunk, this.crc);
      this.size = (this.size + chunk.length) >>> 0;
      onData(chunk);
    });
  }

  get complete(): boolean {
    return this.stage === "done";
  }

  async write(step: Uint8Array): Promise<void> {
    if (this.error !== undefined || this.stage === "done") return;
    let rest = step;
    if (this.stage === "header") {
      const used = this.header.push(rest);
      if (this.header.error !== undefined) {
        this.error = `the body is not a gzip member: ${this.header.error}`;
        return;
      }
      if (this.header.field !== "done") return;
      this.stage = "body";
      rest = rest.subarray(used);
    }
    if (this.stage === "body") {
      if (rest.length === 0) return;
      await this.inner.write(rest);
      if (this.inner.error !== undefined) {
        this.error = this.inner.error;
        return;
      }
      if (!this.inner.complete) return;
      this.stage = "trailer";
      rest = this.inner.unconsumed;
    }
    // stage === "trailer"
    const part = rest.subarray(0, 8 - this.trailerLength);
    this.trailer.set(part, this.trailerLength);
    this.trailerLength += part.length;
    if (this.trailerLength < 8) return;
    this.checkTrailer();
  }

  private checkTrailer(): void {
    const t = this.trailer;
    const word = (at: number): number =>
      ((t[at] as number) |
        ((t[at + 1] as number) << 8) |
        ((t[at + 2] as number) << 16) |
        ((t[at + 3] as number) << 24)) >>>
      0;
    if (word(0) !== this.crc) {
      this.error = "incorrect data check (the gzip trailer's CRC-32 does not match the data)";
    } else if (word(4) !== this.size) {
      this.error = "incorrect length check (the gzip trailer's size does not match the data)";
    } else {
      this.stage = "done";
    }
  }

  async finish(): Promise<void> {
    if (this.error !== undefined || this.stage === "done") return;
    if (this.stage === "header") {
      this.error = "the body ends inside its gzip header";
      return;
    }
    if (this.stage === "body") {
      await this.inner.finish();
      this.error = this.inner.error ?? "the body ends before its gzip trailer";
      return;
    }
    this.error = "the body ends inside its gzip trailer";
  }

  destroy(): void {
    this.inner.destroy();
  }
}
