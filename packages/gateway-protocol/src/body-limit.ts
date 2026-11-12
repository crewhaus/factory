/**
 * Reading an HTTP request body with its size held to a limit, for a server
 * that has to read the body before it can decide anything about the request.
 *
 * A webhook is the case this is for: the platform signs the raw body, so the
 * body has to be read before the signature can be checked. The limit is
 * applied twice:
 *
 * 1. A declared `Content-Length` over the limit is answered 413 before a byte
 *    of the body is read, and a `Content-Length` that is not a plain decimal
 *    number is answered 400.
 * 2. The body is read with a running byte count, and the read stops, with the
 *    stream cancelled, as soon as the count passes the limit: a chunked body,
 *    or one longer than it said, is answered 413 having cost at most the
 *    limit plus the chunk that crossed it.
 *
 * The text a caller gets back is what `req.text()` would have returned (UTF-8,
 * a leading BOM dropped, invalid sequences replaced), so a signature computed
 * over it is unchanged.
 *
 * {@link resolveWebhookBodyLimit} is the one place a channel daemon's limit is
 * read from the environment: `CHANNEL_WEBHOOK_MAX_BYTES`, 1 MiB when unset,
 * held between {@link WEBHOOK_MAX_BYTES_FLOOR} and
 * {@link WEBHOOK_MAX_BYTES_CEILING}. The daemon passes the same number to its
 * gateway and to `Bun.serve`'s `maxRequestBodySize`.
 */

/** The environment variable that sets a channel daemon's webhook body limit, in bytes. */
export const WEBHOOK_MAX_BYTES_ENV = "CHANNEL_WEBHOOK_MAX_BYTES" as const;

/** The webhook body limit when {@link WEBHOOK_MAX_BYTES_ENV} is unset: 1 MiB. */
export const DEFAULT_WEBHOOK_MAX_BYTES = 1024 * 1024;

/** The smallest limit {@link WEBHOOK_MAX_BYTES_ENV} can set: 1 KiB. */
export const WEBHOOK_MAX_BYTES_FLOOR = 1024;

/** The largest limit {@link WEBHOOK_MAX_BYTES_ENV} can set: 32 MiB. */
export const WEBHOOK_MAX_BYTES_CEILING = 32 * 1024 * 1024;

/** A body limit and, when the environment asked for something it could not have, why. */
export type WebhookBodyLimit = {
  readonly maxBytes: number;
  /** One line for the boot log, present when the value was ignored or held to a bound. */
  readonly warning?: string;
};

/**
 * The webhook body limit `env` asks for.
 *
 * Unset or empty: {@link DEFAULT_WEBHOOK_MAX_BYTES}. A plain decimal number of
 * bytes is used as given when it lies between the floor and the ceiling, and
 * held to the nearer bound otherwise. Anything else (a unit suffix, a sign, a
 * fraction) is ignored for the default. Both of the last two come back with a
 * `warning`, so a typo is printed at boot rather than silently applied.
 */
export function resolveWebhookBodyLimit(
  env: Readonly<Record<string, string | undefined>>,
): WebhookBodyLimit {
  const raw = env[WEBHOOK_MAX_BYTES_ENV]?.trim();
  if (raw === undefined || raw === "") return { maxBytes: DEFAULT_WEBHOOK_MAX_BYTES };
  if (!/^\d+$/.test(raw)) {
    return {
      maxBytes: DEFAULT_WEBHOOK_MAX_BYTES,
      warning: `${WEBHOOK_MAX_BYTES_ENV}=${JSON.stringify(raw.slice(0, 40))} is not a number of bytes; using ${DEFAULT_WEBHOOK_MAX_BYTES}`,
    };
  }
  const asked = Number(raw);
  if (asked < WEBHOOK_MAX_BYTES_FLOOR) {
    return {
      maxBytes: WEBHOOK_MAX_BYTES_FLOOR,
      warning: `${WEBHOOK_MAX_BYTES_ENV}=${raw} is below ${WEBHOOK_MAX_BYTES_FLOOR}; using ${WEBHOOK_MAX_BYTES_FLOOR}`,
    };
  }
  if (asked > WEBHOOK_MAX_BYTES_CEILING) {
    return {
      maxBytes: WEBHOOK_MAX_BYTES_CEILING,
      warning: `${WEBHOOK_MAX_BYTES_ENV}=${raw} is above ${WEBHOOK_MAX_BYTES_CEILING}; using ${WEBHOOK_MAX_BYTES_CEILING}`,
    };
  }
  return { maxBytes: asked };
}

/** Why a body was refused. */
export type BodyRefusal =
  /** `Content-Length` declared more than the limit; nothing was read. */
  | "declared_too_large"
  /** The body passed the limit while it was read; the read stopped there. */
  | "too_large"
  /** `Content-Length` was present and not a plain decimal number; nothing was read. */
  | "bad_length"
  /** The body stream failed before it ended. */
  | "unreadable";

export type CappedBody =
  | { readonly ok: true; readonly text: string; readonly bytesRead: number }
  | {
      readonly ok: false;
      readonly reason: BodyRefusal;
      /** Bytes taken from the stream before it was refused (0 when nothing was read). */
      readonly bytesRead: number;
      /** The answer to send: 413 for a body over the limit, 400 otherwise. */
      readonly response: Response;
    };

function refusal(reason: BodyRefusal, bytesRead: number, maxBytes: number): CappedBody {
  const tooLarge = reason === "declared_too_large" || reason === "too_large";
  const message = tooLarge
    ? `payload too large: the limit is ${maxBytes} bytes`
    : reason === "bad_length"
      ? "invalid content-length"
      : "could not read the request body";
  return {
    ok: false,
    reason,
    bytesRead,
    response: new Response(message, {
      status: tooLarge ? 413 : 400,
      headers: { "content-type": "text/plain" },
    }),
  };
}

async function cancelQuietly(stream: ReadableStream<Uint8Array> | null): Promise<void> {
  if (stream === null || stream.locked) return;
  await stream.cancel().catch(() => undefined);
}

/**
 * `req`'s body as text, or a refusal, with at most `maxBytes` (plus the chunk
 * that crossed it) ever held. See the module docblock for what is refused and
 * how. `maxBytes` must be a non-negative integer; anything else throws a
 * `RangeError` rather than reading without a limit.
 */
export async function readRequestBodyCapped(req: Request, maxBytes: number): Promise<CappedBody> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(`maxBytes must be a non-negative integer, got ${String(maxBytes)}`);
  }
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const trimmed = declared.trim();
    if (!/^\d+$/.test(trimmed)) {
      await cancelQuietly(req.body);
      return refusal("bad_length", 0, maxBytes);
    }
    if (Number(trimmed) > maxBytes) {
      await cancelQuietly(req.body);
      return refusal("declared_too_large", 0, maxBytes);
    }
  }
  const stream = req.body;
  if (stream === null) return { ok: true, text: "", bytesRead: 0 };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return refusal("too_large", total, maxBytes);
      }
      chunks.push(chunk);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return refusal("unreadable", total, maxBytes);
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes), bytesRead: total };
}
