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

function codingOf(header: string | null): Coding | null | { readonly unsupported: string } {
  if (header === null) return null;
  const codings = header
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c !== "" && c !== "identity");
  if (codings.length === 0) return null;
  // A stack ("gzip, br") would need a bound on every intermediate stage.
  if (codings.length > 1) return { unsupported: codings.join(", ") };
  const only = codings[0] as string;
  if (only === "gzip" || only === "x-gzip") return "gzip";
  if (only === "deflate" || only === "br" || only === "zstd") return only;
  return { unsupported: only };
}

type SyncDecoder = (raw: Uint8Array, options: { maxOutputLength: number }) => Uint8Array;

function decoderFor(coding: Coding, raw: Uint8Array): SyncDecoder | undefined {
  switch (coding) {
    case "gzip":
      return zlib.gunzipSync;
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
