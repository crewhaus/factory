// A namespace import: a named import of an export the runtime lacks (not
// every node:zlib has zstd) would fail the whole module at link time.
import * as zlib from "node:zlib";

/**
 * A response body read with its DECODED size bounded, for the tools a
 * cf-worker bundle carries (Fetch here, WebFetch and WebSearch in
 * @crewhaus/tool-web).
 *
 * WHY THIS EXISTS. Unless a request passes `decompress: false`, Bun inflates
 * a gzip, deflate, br or zstd body in native code before JavaScript reads a
 * byte, and it keeps `Content-Encoding` on the response, so a reader that
 * counts bytes as they arrive counts after the damage: a 260 KB gzip of
 * zeros from an allow-listed origin cost about 1 GB of RSS before 0.7.0's
 * 5 MB cap fired (C093). The bound therefore starts at the request
 * ({@link withRawBody}) and the body is decoded here, where the decoder is
 * told the most it may produce.
 *
 * WHY NOT @crewhaus/tool-safety/streams. That module is Bun-only (Workers,
 * `Bun.spawn`, `node:fs`), and these tools are bundled into workerd, so they
 * must not depend on it (tool-safety's edge-targets test enforces this).
 * The bodies here are small — 5 MB at most — so the decode is one bounded
 * synchronous call rather than tool-safety's streaming decoder: the raw
 * bytes are capped first, then `maxOutputLength` stops the decoder the
 * moment its output would pass the cap (measured on Bun 1.3.14 against
 * 256 MiB bombs in all four codings: the decode throws with RSS up at most
 * a few MB).
 *
 * WHAT COUNTS AS THE BODY (as Bun's own decoder, which 0.7.0 used, reads
 * it). A gzip body is its FIRST member: the header and trailer are parsed
 * here, the CRC-32 and length checked, and bytes after the member (a stray
 * CRLF, padding, a second member) ignored. `gunzipSync` would read them as
 * the start of another member and fail. A `Content-Encoding` label that
 * names no coding (`none`, `utf-8`, `binary`) is read as the bytes it is,
 * under the same raw cap, and `decodedFrom` stays null so the caller shows
 * the label; only a stack that includes a real compression is refused.
 *
 * WORKERD. `decompress` is a Bun option. workerd has no equivalent and
 * applies its own handling to an encoded body, inside the isolate's memory
 * limit, so outside Bun the body is read exactly as 0.7.0 read it: counted
 * as it arrives and never decoded a second time.
 */

/** True where `fetch` honours `decompress: false` (Bun). */
export const RAW_BODIES: boolean = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/**
 * `init` with the body kept raw, where the runtime supports it. It must be
 * the init of the FINAL `fetch` call: Bun ignores `decompress` inside a
 * `Request`'s own init, so a seam that already holds a `Request` passes it
 * as `fetch(request, withRawBody({}))`.
 */
export function withRawBody<T extends object>(init: T): T {
  return RAW_BODIES ? ({ ...init, decompress: false } as T) : init;
}

/**
 * Ask for the body as it is, unless the caller chose an Accept-Encoding.
 * A server that compresses regardless is still decoded, under the cap.
 */
export function preferIdentity(headers: Headers): void {
  if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");
}

export type BoundedBody =
  | {
      readonly ok: true;
      /** The decoded body, at most `maxBytes`. */
      readonly bytes: Uint8Array;
      /** The coding that was undone here, or null when the body was not encoded (or not raw). */
      readonly decodedFrom: string | null;
    }
  | {
      readonly ok: false;
      /**
       * `too-large`: the body, raw or decoded, is longer than `maxBytes`.
       * `unsupported-encoding`: a coding (or a stack of them) this reader
       * cannot bound. `decode-error`: the body is not what its
       * Content-Encoding says. None of the reasons quotes the body.
       */
      readonly code: "too-large" | "unsupported-encoding" | "decode-error";
      readonly reason: string;
    };

type Coding = "gzip" | "deflate" | "br" | "zstd";

/** The content codings this reader decodes. */
const DECODABLE: Readonly<Record<string, Coding>> = {
  gzip: "gzip",
  "x-gzip": "gzip",
  deflate: "deflate",
  br: "br",
  zstd: "zstd",
};

/**
 * The coding to undo, null for a body to read as it is (no label, or a
 * label that names no coding), or the stack this reader refuses.
 */
function codingOf(header: string | null): Coding | null | { readonly unsupported: string } {
  if (header === null) return null;
  const codings = header
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c !== "" && c !== "identity");
  // `none`, `utf-8`, `binary`: misconfigured servers send them, and the raw
  // read is capped, so reading the bytes as they are costs nothing.
  if (!codings.some((c) => Object.hasOwn(DECODABLE, c))) return null;
  // A stack ("gzip, br") would need a bound on every intermediate stage.
  if (codings.length > 1) return { unsupported: codings.join(", ") };
  return DECODABLE[codings[0] as string] as Coding;
}

type SyncDecoder = (raw: Uint8Array, options: { maxOutputLength: number }) => Uint8Array;

function decoderFor(coding: Coding, raw: Uint8Array): SyncDecoder | undefined {
  switch (coding) {
    case "gzip":
      return gunzipFirstMember;
    case "deflate": {
      // RFC 9110 "deflate" is zlib-wrapped; some servers send it raw.
      const b0 = raw[0] ?? 0;
      const b1 = raw[1] ?? 0;
      const zlibWrapped = (b0 & 0x0f) === 8 && ((b0 << 8) | b1) % 31 === 0;
      return zlibWrapped ? zlib.inflateSync : zlib.inflateRawSync;
    }
    case "br":
      return zlib.brotliDecompressSync;
    case "zstd": {
      const zstd = (zlib as unknown as { zstdDecompressSync?: SyncDecoder }).zstdDecompressSync;
      return typeof zstd === "function" ? zstd : undefined;
    }
  }
}

class GzipFormatError extends Error {}

const CRC_TABLE: Int32Array = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** CRC-32 (gzip's). The runtime's `zlib.crc32` is not on every runtime these tools run on. */
function crc32(bytes: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) {
    c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return ~c >>> 0;
}

/**
 * The first gzip member of `raw` (RFC 1952), decoded with its output
 * bounded and its trailer checked; whatever follows the member is ignored.
 */
function gunzipFirstMember(raw: Uint8Array, options: { maxOutputLength: number }): Uint8Array {
  const byte = (at: number): number => {
    if (at >= raw.length) throw new GzipFormatError("the body ends inside its gzip header");
    return raw[at] as number;
  };
  if (byte(0) !== 0x1f || byte(1) !== 0x8b || byte(2) !== 8) {
    throw new GzipFormatError("the body does not start with a gzip deflate header");
  }
  const flags = byte(3);
  if ((flags & 0xe0) !== 0) throw new GzipFormatError("its gzip header sets reserved flags");
  let at = 10;
  if ((flags & 0x04) !== 0) at += 2 + (byte(at) | (byte(at + 1) << 8)); // FEXTRA
  for (const flag of [0x08, 0x10]) {
    // FNAME, FCOMMENT: zero-terminated.
    if ((flags & flag) === 0) continue;
    while (byte(at) !== 0) at += 1;
    at += 1;
  }
  if ((flags & 0x02) !== 0) {
    const stored = byte(at) | (byte(at + 1) << 8);
    if (stored !== (crc32(raw.subarray(0, at)) & 0xffff)) {
      throw new GzipFormatError("its gzip header checksum is wrong");
    }
    at += 2;
  }
  if (at > raw.length) throw new GzipFormatError("the body ends inside its gzip header");
  // `info` reports how much input the deflate data used, which is where the
  // trailer starts; the engine stops at the end of the data by itself.
  const inflated = (
    zlib.inflateRawSync as unknown as (
      buf: Uint8Array,
      opts: { maxOutputLength: number; info: true },
    ) => { buffer: Uint8Array; engine: { bytesWritten: number } }
  )(raw.subarray(at), { maxOutputLength: options.maxOutputLength, info: true });
  const trailerAt = at + inflated.engine.bytesWritten;
  if (trailerAt + 8 > raw.length)
    throw new GzipFormatError("the body ends before its gzip trailer");
  const word = (i: number): number =>
    ((raw[i] as number) |
      ((raw[i + 1] as number) << 8) |
      ((raw[i + 2] as number) << 16) |
      ((raw[i + 3] as number) << 24)) >>>
    0;
  if (word(trailerAt) !== crc32(inflated.buffer)) {
    throw new GzipFormatError("the gzip trailer's CRC-32 does not match the data");
  }
  if (word(trailerAt + 4) !== inflated.buffer.length >>> 0) {
    throw new GzipFormatError("the gzip trailer's size does not match the data");
  }
  return inflated.buffer;
}

/**
 * Read `res`'s body, refusing one whose raw or decoded size passes
 * `maxBytes`. The raw read stops (and cancels the body) at the cap, so a
 * server cannot pin memory with a long body either.
 */
export async function readBodyBounded(res: Response, maxBytes: number): Promise<BoundedBody> {
  const tooLarge = (): BoundedBody => ({
    ok: false,
    code: "too-large",
    reason: `response body exceeded ${maxBytes} bytes — aborted`,
  });
  const coding = RAW_BODIES ? codingOf(res.headers.get("content-encoding")) : null;
  if (coding !== null && typeof coding === "object") {
    await res.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      code: "unsupported-encoding",
      reason: `response uses content-encoding "${coding.unsupported}", which this tool cannot decode within its ${maxBytes}-byte cap`,
    };
  }
  if (res.body === null) return { ok: true, bytes: new Uint8Array(0), decodedFrom: null };

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released by cancel()
    }
  }
  const raw = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (coding === null) return { ok: true, bytes: raw, decodedFrom: null };
  if (raw.byteLength === 0) return { ok: true, bytes: raw, decodedFrom: coding };
  const decoder = decoderFor(coding, raw);
  if (decoder === undefined) {
    return {
      ok: false,
      code: "unsupported-encoding",
      reason: `response uses content-encoding "${coding}", which this runtime cannot decode`,
    };
  }
  try {
    // `maxOutputLength` stops the decoder the moment its output would pass
    // the cap; it throws ERR_BUFFER_TOO_LARGE instead of producing more.
    const bytes = decoder(raw, { maxOutputLength: Math.max(1, maxBytes) });
    return { ok: true, bytes, decodedFrom: coding };
  } catch (err) {
    if ((err as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE") return tooLarge();
    return {
      ok: false,
      code: "decode-error",
      reason: `response body is not valid ${coding} data, though its content-encoding says it is`,
    };
  }
}
