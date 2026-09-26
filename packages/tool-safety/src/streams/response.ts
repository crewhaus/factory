import * as zlib from "node:zlib";
import { onAbort } from "../signal";
import { GzipStepDecoder, type StepDecoder, StreamStepDecoder } from "./decoders";
import { byteBudget, graceMs } from "./limits";
import { concatBytes, decodeHead } from "./utf8";

/**
 * Reading an HTTP response body with the DECODED size bounded.
 *
 * WHAT BUN DOES (measured, Bun 1.3.14): unless a request passes
 * `decompress: false`, `fetch` inflates a gzip/deflate/br/zstd body in native
 * code before JavaScript sees the first chunk — a 65 KB gzip of zeros put
 * 273 MB on the heap before `reader.read()` returned. It also leaves the
 * `Content-Encoding` header on the response and keeps `Content-Length` at
 * the COMPRESSED size, so a response gives no sign that it was decoded. A
 * reader that counts bytes as they arrive is counting after the damage.
 *
 * So the bound has to start at the request: fetch with {@link fetchRaw}, or
 * with {@link withRawBody} as the init of the final `fetch` call, and this
 * module decodes the body itself, in small steps, stopping the decoder as
 * soon as `maxBytes` of decoded output exist. A 256 MB gzip, brotli or zstd
 * bomb then costs a few megabytes.
 *
 * `decodeBody` hands the decoded bytes over chunk by chunk, for a reader
 * that parses as it goes (server-sent events) or writes as it goes (a
 * download); `readResponseBounded` collects them.
 *
 * Every read, and every step of the decoder, is raced against the signal
 * and against `idleTimeoutMs`, so neither a server that sends one chunk and
 * then stalls nor a corrupt body can hold the reader.
 *
 * WHAT COUNTS AS THE BODY. A gzip body is its first member: bytes after it
 * (a stray CRLF, padding) are not read, as Bun's own decoder, curl and
 * browsers treat them; a deflate, br or zstd body ends where its encoded
 * data ends, likewise. A `Content-Encoding` label that names no coding
 * (`none`, `utf-8`, `binary`) is read as the bytes it is, under the same
 * cap, and reported in `undecodedEncoding`; only a stack that includes a
 * real compression (`gzip, br`) is refused, since each stage would need a
 * bound of its own.
 *
 * MISUSE IS DETECTED WHERE IT CAN BE. A body that was already decoded by the
 * runtime is recognised when it runs past its own `Content-Length`, or when
 * a `gzip`/`zstd` body lacks that format's magic bytes, and refused with
 * `auto-decompressed`. A brotli or deflate body decoded twice fails as a
 * `decode-error` instead. Either way the memory was already spent — the
 * check exists so a missing `decompress: false` fails a test, loudly, rather
 * than working until the day a server sends a bomb. Every adopting package
 * should keep a gzip-bomb test against a local server.
 */

export type ResponseReadOptions = {
  /**
   * Most DECODED bytes held: a finite number >= 0. NaN, a negative number or
   * a missing value throws a `RangeError` rather than reading nothing.
   */
  readonly maxBytes: number;
  /** Abandon the read when this fires, even while waiting for a chunk: `aborted`. */
  readonly signal?: AbortSignal;
  /**
   * Abandon the read when no chunk arrives for this long: `stalled`.
   * Default: no idle limit (pass `signal: AbortSignal.timeout(ms)` for an
   * overall one).
   */
  readonly idleTimeoutMs?: number;
};

export type ResponseReadFailure = {
  readonly ok: false;
  readonly code:
    | "unsupported-encoding"
    | "auto-decompressed"
    | "decode-error"
    | "read-error"
    | "aborted"
    | "stalled";
  readonly reason: string;
  readonly encodedBytes: number;
};

export type ResponseReadResult =
  | {
      readonly ok: true;
      /** The decoded body, at most `maxBytes`. */
      readonly bytes: Uint8Array;
      /** `bytes` as UTF-8; an incomplete final character is dropped when truncated. */
      readonly text: string;
      /** The decoded body is longer than `maxBytes`. Reading stopped there. */
      readonly truncated: boolean;
      /**
       * Decoded bytes the decoder produced. Exact when not truncated; when
       * truncated, at most one decoder chunk past `maxBytes` — the rest of
       * the body was never decoded, which is the point.
       */
      readonly decodedBytes: number;
      /** Bytes read off the wire, still encoded. */
      readonly encodedBytes: number;
      /** The coding that was undone, or null for an identity body. */
      readonly contentEncoding: string | null;
      /**
       * A `Content-Encoding` label that names no coding this reader knows
       * (`none`, `utf-8`): the body was read as it arrived, not decoded.
       * Null otherwise.
       */
      readonly undecodedEncoding: string | null;
    }
  | ResponseReadFailure;

/** How a {@link decodeBody} iteration ended. */
export type DecodedBodyOutcome =
  | {
      readonly ok: true;
      /** The decoded body was longer than `maxBytes`; the chunks stop there. */
      readonly truncated: boolean;
      /** As {@link ResponseReadResult}'s. */
      readonly decodedBytes: number;
      readonly encodedBytes: number;
      readonly contentEncoding: string | null;
      readonly undecodedEncoding: string | null;
    }
  | ResponseReadFailure;

/**
 * Decoded chunks of a body, at most `maxBytes` of them in all. Iterate it
 * once; `outcome` is set when the iteration ends, and says whether the body
 * ended, was cut at the cap, or failed. Breaking out of the loop early
 * cancels the body.
 */
export type DecodedBody = AsyncIterable<Uint8Array> & {
  readonly outcome: DecodedBodyOutcome | undefined;
};

/**
 * The request options that keep a body raw so {@link readResponseBounded}
 * can bound its decoded size.
 *
 * It must be the init of the FINAL `fetch` call: `fetch(input, withRawBody(init))`,
 * where `input` may be a URL or a `Request`. Bun ignores `decompress` in a
 * `Request`'s own init, so `new Request(url, withRawBody({}))` handed to a
 * plain `fetch(request)` is inflated anyway (measured on Bun 1.3.14). A
 * pinned-fetch seam that passes a `Request` should call {@link fetchRaw}.
 */
export function withRawBody<T extends object>(init: T): T & { readonly decompress: false } {
  return { ...init, decompress: false };
}

/**
 * `fetch` with the body kept raw, whatever `input` is: a URL or a `Request`.
 * For helpers that build a `Request` first and fetch it later.
 */
export function fetchRaw(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  return fetch(input, withRawBody(init) as RequestInit);
}

/** Input fed to the decoder per step. Small, so one step cannot inflate far past the cap. */
const DECODE_STEP = 16 * 1024;

type Coding = "gzip" | "deflate" | "br" | "zstd";

/** The content codings this reader decodes. */
const DECODABLE: Readonly<Record<string, Coding>> = {
  gzip: "gzip",
  "x-gzip": "gzip",
  deflate: "deflate",
  br: "br",
  zstd: "zstd",
};

type CodingPlan =
  | { readonly kind: "identity"; readonly label: string | null }
  | { readonly kind: "decode"; readonly coding: Coding }
  | { readonly kind: "unsupported"; readonly label: string };

/**
 * What to do with a `Content-Encoding` header. A label that names no coding
 * this reader knows is read as identity and reported: the raw read is
 * capped like any other, so it cannot be a bomb, and misconfigured servers
 * that send `none` or `utf-8` are real (Bun's own fetch passes such a body
 * through, as 0.7.0 did). A stack that includes a real compression is
 * refused.
 */
function planFor(header: string | null): CodingPlan {
  if (header === null) return { kind: "identity", label: null };
  const tokens = header
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c !== "" && c !== "identity");
  if (tokens.length === 0) return { kind: "identity", label: null };
  const decodable = tokens.filter((t) => Object.hasOwn(DECODABLE, t));
  if (decodable.length === 0) return { kind: "identity", label: tokens.join(", ") };
  if (tokens.length === 1)
    return { kind: "decode", coding: DECODABLE[tokens[0] as string] as Coding };
  return { kind: "unsupported", label: tokens.join(", ") };
}

function makeDecoder(
  coding: Coding,
  head: Uint8Array,
  onData: (chunk: Uint8Array) => void,
): StepDecoder | undefined {
  switch (coding) {
    case "gzip":
      return new GzipStepDecoder(onData);
    case "deflate": {
      // RFC 9110 "deflate" is zlib-wrapped; some servers send it raw.
      const b0 = head[0] ?? 0;
      const b1 = head[1] ?? 0;
      const zlibWrapped = (b0 & 0x0f) === 8 && ((b0 << 8) | b1) % 31 === 0;
      return new StreamStepDecoder(
        zlibWrapped ? zlib.createInflate() : zlib.createInflateRaw(),
        onData,
      );
    }
    case "br":
      return new StreamStepDecoder(zlib.createBrotliDecompress(), onData);
    case "zstd": {
      const make = (zlib as unknown as { createZstdDecompress?: () => zlib.Inflate })
        .createZstdDecompress;
      return typeof make === "function" ? new StreamStepDecoder(make(), onData) : undefined;
    }
  }
}

function magicMismatch(coding: Coding, head: Uint8Array): boolean {
  if (head.length < 4) return false;
  if (coding === "gzip") return head[0] !== 0x1f || head[1] !== 0x8b;
  if (coding === "zstd") {
    return head[0] !== 0x28 || head[1] !== 0xb5 || head[2] !== 0x2f || head[3] !== 0xfd;
  }
  return false;
}

function declaredLength(res: Response): number | undefined {
  const raw = res.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw.trim())) return undefined;
  return Number(raw.trim());
}

type Raced<T> = { readonly value: T } | { readonly stopped: "aborted" | "stalled" };

/** `promise`, unless the signal fires or `idleMs` passes first. */
function race<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  idleMs: number | undefined,
): Promise<Raced<T>> {
  if (signal === undefined && idleMs === undefined) return promise.then((value) => ({ value }));
  return new Promise<Raced<T>>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (signal?.aborted === true) {
      resolve({ stopped: "aborted" });
      return;
    }
    const unsubscribe = onAbort(signal, () => {
      done();
      resolve({ stopped: "aborted" });
    });
    const done = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
    };
    if (idleMs !== undefined) {
      timer = setTimeout(() => {
        done();
        resolve({ stopped: "stalled" });
      }, idleMs);
    }
    promise.then(
      (value) => {
        done();
        resolve({ value });
      },
      (err: unknown) => {
        done();
        reject(err);
      },
    );
  });
}

/**
 * The body's decoded bytes as they arrive, never more than `maxBytes` of
 * them, with the decoder stopped at the cap. See {@link DecodedBody}.
 */
export function decodeBody(res: Response, options: ResponseReadOptions): DecodedBody {
  const maxBytes = byteBudget("maxBytes", options.maxBytes);
  const idleMs =
    options.idleTimeoutMs === undefined
      ? undefined
      : graceMs("idleTimeoutMs", options.idleTimeoutMs, 0);
  const state: { outcome: DecodedBodyOutcome | undefined } = { outcome: undefined };
  let started = false;
  const body: DecodedBody = {
    get outcome() {
      return state.outcome;
    },
    [Symbol.asyncIterator]() {
      if (started) throw new TypeError("a decoded body can be iterated only once");
      started = true;
      return iterate(res, maxBytes, options.signal, idleMs, state)[Symbol.asyncIterator]();
    },
  };
  return body;
}

async function* iterate(
  res: Response,
  maxBytes: number,
  signal: AbortSignal | undefined,
  idleMs: number | undefined,
  state: { outcome: DecodedBodyOutcome | undefined },
): AsyncGenerator<Uint8Array, void, undefined> {
  const plan = planFor(res.headers.get("content-encoding"));
  if (plan.kind === "unsupported") {
    await res.body?.cancel().catch(() => undefined);
    state.outcome = {
      ok: false,
      code: "unsupported-encoding",
      reason: `the response is encoded as "${plan.label}", which this reader cannot decode within a memory bound`,
      encodedBytes: 0,
    };
    return;
  }
  const contentEncoding = plan.kind === "decode" ? plan.coding : null;
  const undecodedEncoding = plan.kind === "identity" ? plan.label : null;
  const declared = declaredLength(res);
  let encodedBytes = 0;
  let decodedBytes = 0;
  let given = 0;
  let full = false;
  const succeed = (): void => {
    state.outcome = {
      ok: true,
      truncated: full,
      decodedBytes,
      encodedBytes,
      contentEncoding,
      undecodedEncoding,
    };
  };
  if (res.body === null) {
    succeed();
    return;
  }

  const reader = res.body.getReader();
  let readerDone = false;
  let cancelled = false;
  const cancel = async (): Promise<void> => {
    if (cancelled || readerDone) return;
    cancelled = true;
    await reader.cancel().catch(() => undefined);
  };
  const failWith = async (code: ResponseReadFailure["code"], reason: string): Promise<void> => {
    await cancel();
    state.outcome = { ok: false, code, reason, encodedBytes };
  };
  const stoppedReason = (stopped: "aborted" | "stalled"): string =>
    stopped === "aborted"
      ? "the read was aborted"
      : `no data arrived for ${idleMs} ms, so the read was abandoned`;

  /** Decoded output waiting to be handed over, cut to the cap. */
  const pending: Uint8Array[] = [];
  let decoder: StepDecoder | undefined;
  const accept = (chunk: Uint8Array): void => {
    // Counted even past the cap: `decodedBytes` is what the decoder really
    // produced, so a decoder that is not stopped here shows up.
    decodedBytes += chunk.length;
    if (given < maxBytes) {
      const take = Math.min(maxBytes - given, chunk.length);
      pending.push(take === chunk.length ? chunk : chunk.slice(0, take));
      given += take;
    }
    if (decodedBytes > maxBytes) {
      full = true;
      decoder?.destroy();
    }
  };
  const corrupt = (): Promise<void> =>
    failWith("decode-error", `the ${contentEncoding} body is corrupt: ${decoder?.error}`);

  let finished = false;
  try {
    reading: for (;;) {
      let next: Raced<Awaited<ReturnType<typeof reader.read>>>;
      try {
        next = await race(reader.read(), signal, idleMs);
      } catch (err) {
        await failWith("read-error", err instanceof Error ? err.message : String(err));
        return;
      }
      if ("stopped" in next) {
        await failWith(next.stopped, stoppedReason(next.stopped));
        return;
      }
      if (next.value.done) {
        readerDone = true;
        break;
      }
      const chunk = next.value.value;
      if (chunk.length === 0) continue;
      const before = encodedBytes;
      encodedBytes += chunk.length;

      if (contentEncoding === null) {
        accept(chunk);
      } else {
        if (declared !== undefined && encodedBytes > declared) {
          await failWith(
            "auto-decompressed",
            `the ${contentEncoding} body ran past its Content-Length (${declared}), so the runtime had already decoded it: fetch it with fetchRaw() or withRawBody(), or the decoded size is unbounded`,
          );
          return;
        }
        if (before === 0) {
          if (magicMismatch(contentEncoding, chunk)) {
            await failWith(
              "auto-decompressed",
              `the body is labelled ${contentEncoding} but does not start with that format's signature — the runtime already decoded it (fetch with fetchRaw() or withRawBody()), or the server mislabelled it`,
            );
            return;
          }
          decoder = makeDecoder(contentEncoding, chunk, accept);
          if (decoder === undefined) {
            await failWith("decode-error", `this runtime has no ${contentEncoding} decoder`);
            return;
          }
        }
        const d = decoder as StepDecoder;
        for (let off = 0; off < chunk.length; off += DECODE_STEP) {
          // A step settles even when the decoder fails without calling back,
          // and it is raced like a read, so neither can outlast the signal.
          const stepped = await race(
            d.write(chunk.subarray(off, off + DECODE_STEP)),
            signal,
            idleMs,
          );
          if ("stopped" in stepped) {
            await failWith(stepped.stopped, stoppedReason(stepped.stopped));
            return;
          }
          // Hand over what this step produced before feeding the next.
          while (pending.length > 0) yield pending.shift() as Uint8Array;
          if (full) break reading;
          if (d.error !== undefined) {
            await corrupt();
            return;
          }
          // The encoded data is over; what follows is not part of the body.
          if (d.complete) break reading;
        }
      }
      while (pending.length > 0) yield pending.shift() as Uint8Array;
      if (full) break;
    }

    if (decoder !== undefined && !full && !decoder.complete) {
      const flushed = await race(decoder.finish(), signal, idleMs);
      if ("stopped" in flushed) {
        await failWith(flushed.stopped, stoppedReason(flushed.stopped));
        return;
      }
      while (pending.length > 0) yield pending.shift() as Uint8Array;
      if (decoder.error !== undefined && !full) {
        await corrupt();
        return;
      }
    }
    finished = true;
    succeed();
  } finally {
    decoder?.destroy();
    // Cut at the cap, a body whose encoded data ended early, or a consumer
    // that stopped iterating: the rest is unread.
    await cancel();
    if (!finished && state.outcome === undefined) {
      state.outcome = {
        ok: false,
        code: "aborted",
        reason: "the reader stopped before the body ended",
        encodedBytes,
      };
    }
  }
}

/** Read a body into memory with its DECODED size bounded. See the module comment. */
export async function readResponseBounded(
  res: Response,
  options: ResponseReadOptions,
): Promise<ResponseReadResult> {
  const body = decodeBody(res, options);
  const kept: Uint8Array[] = [];
  let keptLength = 0;
  for await (const chunk of body) {
    kept.push(chunk);
    keptLength += chunk.length;
  }
  const outcome = body.outcome as DecodedBodyOutcome;
  if (!outcome.ok) return outcome;
  const bytes = concatBytes(kept, keptLength);
  return {
    ok: true,
    bytes,
    text: decodeHead(bytes, !outcome.truncated),
    truncated: outcome.truncated,
    decodedBytes: outcome.decodedBytes,
    encodedBytes: outcome.encodedBytes,
    contentEncoding: outcome.contentEncoding,
    undecodedEncoding: outcome.undecodedEncoding,
  };
}
