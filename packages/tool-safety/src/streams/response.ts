import * as zlib from "node:zlib";
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
 * So the bound has to start at the request: fetch with {@link withRawBody}
 * (`decompress: false`), and this reader decodes the body itself, in small
 * steps, stopping the decoder as soon as `maxBytes` of decoded output exist.
 * A 256 MB gzip, brotli or zstd bomb then costs a few megabytes.
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
  /** Most DECODED bytes held. */
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
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
    }
  | {
      readonly ok: false;
      readonly code:
        | "unsupported-encoding"
        | "auto-decompressed"
        | "decode-error"
        | "read-error"
        | "aborted";
      readonly reason: string;
      readonly encodedBytes: number;
    };

/**
 * The request options that keep a body raw so {@link readResponseBounded}
 * can bound its decoded size. Merge into every `fetch` whose body it reads.
 */
export function withRawBody<T extends object>(init: T): T & { readonly decompress: false } {
  return { ...init, decompress: false };
}

/** Input fed to the decoder per step. Small, so one step cannot inflate far past the cap. */
const DECODE_STEP = 16 * 1024;

type Decoder = zlib.Gunzip | zlib.Inflate | zlib.InflateRaw | zlib.BrotliDecompress;

type Coding = "gzip" | "deflate" | "br" | "zstd";

function codingOf(header: string | null): Coding | null | { readonly unsupported: string } {
  if (header === null) return null;
  const codings = header
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c !== "" && c !== "identity");
  if (codings.length === 0) return null;
  if (codings.length > 1) return { unsupported: header };
  const only = codings[0] as string;
  if (only === "gzip" || only === "x-gzip") return "gzip";
  if (only === "deflate" || only === "br" || only === "zstd") return only;
  return { unsupported: only };
}

function makeDecoder(coding: Coding, head: Uint8Array): Decoder | undefined {
  switch (coding) {
    case "gzip":
      return zlib.createGunzip();
    case "deflate": {
      // RFC 9110 "deflate" is zlib-wrapped; some servers send it raw.
      const b0 = head[0] ?? 0;
      const b1 = head[1] ?? 0;
      const zlibWrapped = (b0 & 0x0f) === 8 && ((b0 << 8) | b1) % 31 === 0;
      return zlibWrapped ? zlib.createInflate() : zlib.createInflateRaw();
    }
    case "br":
      return zlib.createBrotliDecompress();
    case "zstd": {
      const make = (zlib as unknown as { createZstdDecompress?: () => Decoder })
        .createZstdDecompress;
      return typeof make === "function" ? make() : undefined;
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

export async function readResponseBounded(
  res: Response,
  options: ResponseReadOptions,
): Promise<ResponseReadResult> {
  const maxBytes = Math.max(0, Math.floor(options.maxBytes));
  const coding = codingOf(res.headers.get("content-encoding"));
  if (coding !== null && typeof coding === "object") {
    await res.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      code: "unsupported-encoding",
      reason: `the response is encoded as "${coding.unsupported}", which this reader cannot decode within a memory bound`,
      encodedBytes: 0,
    };
  }
  const contentEncoding = coding;
  const declared = declaredLength(res);
  if (res.body === null) {
    return {
      ok: true,
      bytes: new Uint8Array(0),
      text: "",
      truncated: false,
      decodedBytes: 0,
      encodedBytes: 0,
      contentEncoding,
    };
  }

  const reader = res.body.getReader();
  let encodedBytes = 0;
  const kept: Uint8Array[] = [];
  let keptLength = 0;
  let decodedBytes = 0;
  let full = false; // decoded output passed maxBytes

  const keep = (chunk: Uint8Array): void => {
    decodedBytes += chunk.length;
    if (keptLength < maxBytes) {
      const take = Math.min(maxBytes - keptLength, chunk.length);
      kept.push(chunk.slice(0, take));
      keptLength += take;
    }
    if (decodedBytes > maxBytes) full = true;
  };

  const fail = async (
    code: "auto-decompressed" | "decode-error" | "read-error" | "aborted",
    reason: string,
  ): Promise<ResponseReadResult> => {
    await reader.cancel().catch(() => undefined);
    return { ok: false, code, reason, encodedBytes };
  };

  let decoder: Decoder | undefined;
  let decoderError: string | undefined;
  let decoderEnded: Promise<void> | undefined;

  try {
    for (;;) {
      if (options.signal?.aborted === true) return await fail("aborted", "the read was aborted");
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (err) {
        return await fail("read-error", err instanceof Error ? err.message : String(err));
      }
      if (next.done) break;
      const chunk = next.value;
      if (chunk.length === 0) continue;
      const before = encodedBytes;
      encodedBytes += chunk.length;

      if (contentEncoding === null) {
        keep(chunk);
        if (full) break;
        continue;
      }

      if (declared !== undefined && encodedBytes > declared) {
        return await fail(
          "auto-decompressed",
          `the ${contentEncoding} body ran past its Content-Length (${declared}), so the runtime had already decoded it: fetch it with withRawBody()/decompress:false, or the decoded size is unbounded`,
        );
      }
      if (before === 0) {
        if (magicMismatch(contentEncoding, chunk)) {
          return await fail(
            "auto-decompressed",
            `the body is labelled ${contentEncoding} but does not start with that format's signature — the runtime already decoded it (fetch with withRawBody()/decompress:false), or the server mislabelled it`,
          );
        }
        decoder = makeDecoder(contentEncoding, chunk);
        if (decoder === undefined) {
          return await fail("decode-error", `this runtime has no ${contentEncoding} decoder`);
        }
        const d = decoder;
        d.on("data", (out: Uint8Array) => {
          // Counted even past the cap: `decodedBytes` is what the decoder
          // really produced, so a decoder that is not stopped here shows up.
          keep(out);
          if (full && !d.destroyed) d.destroy();
        });
        decoderEnded = new Promise<void>((resolve) => {
          d.once("end", () => resolve());
          d.once("close", () => resolve());
          d.once("error", (err: Error) => {
            decoderError = err.message;
            resolve();
          });
        });
      }
      const d = decoder as Decoder;
      for (
        let off = 0;
        off < chunk.length && !full && decoderError === undefined;
        off += DECODE_STEP
      ) {
        const step = chunk.subarray(off, off + DECODE_STEP);
        await new Promise<void>((resolve) => {
          if (d.destroyed) {
            resolve();
            return;
          }
          d.write(step, () => resolve());
        });
      }
      if (decoderError !== undefined) {
        return await fail(
          "decode-error",
          `the ${contentEncoding} body is corrupt: ${decoderError}`,
        );
      }
      if (full) break;
    }

    if (decoder !== undefined && !full && decoderError === undefined) {
      decoder.end();
      await decoderEnded;
      if (decoderError !== undefined) {
        return await fail(
          "decode-error",
          `the ${contentEncoding} body is corrupt: ${decoderError}`,
        );
      }
    }
  } finally {
    if (decoder !== undefined && !decoder.destroyed) decoder.destroy();
    if (full) await reader.cancel().catch(() => undefined);
  }

  const bytes = concatBytes(kept, keptLength);
  return {
    ok: true,
    bytes,
    text: decodeHead(bytes, !full),
    truncated: full,
    decodedBytes,
    encodedBytes,
    contentEncoding,
  };
}
