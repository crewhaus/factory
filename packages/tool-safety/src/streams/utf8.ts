/**
 * Decoding bytes that were cut at an arbitrary byte offset.
 *
 * A cap lands wherever it lands, including inside a multi-byte character.
 * Decoding the head with `stream: true` and never flushing drops an
 * incomplete trailing sequence instead of turning it into U+FFFD, and a tail
 * starts at the first byte that can begin a character.
 */

/** Decode a head; an incomplete final character is dropped unless `complete`. */
export function decodeHead(bytes: Uint8Array, complete: boolean): string {
  const decoder = new TextDecoder();
  return complete ? decoder.decode(bytes) : decoder.decode(bytes, { stream: true });
}

/** Decode a tail, skipping up to three leading continuation bytes. */
export function decodeTail(bytes: Uint8Array): string {
  let start = 0;
  while (start < bytes.length && start < 3 && ((bytes[start] as number) & 0xc0) === 0x80) {
    start += 1;
  }
  return new TextDecoder().decode(bytes.subarray(start));
}

export function concatBytes(chunks: ReadonlyArray<Uint8Array>, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk.subarray(0, Math.min(chunk.length, length - offset)), offset);
    offset += chunk.length;
    if (offset >= length) break;
  }
  return out;
}
