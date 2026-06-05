/**
 * Catalog R12 `chunker` — split documents into retrievable chunks.
 *
 * Three strategies:
 *
 *   "fixed"    — split into fixed-character windows with optional overlap
 *   "semantic" — `Intl.Segmenter` sentence boundaries, packed into windows
 *   "markdown" — header-bounded chunks (split at `^#+ ` boundaries)
 *
 * Every strategy preserves the source bytes — `chunk(doc).map(c => c.text).join("")`
 * (mod overlap) reconstructs the doc, modulo any whitespace that
 * sat at chunk boundaries. The `id` field is `<docId>:<index>:<startOffset>`
 * for stable reference back to the source.
 *
 * Layer R12. Pairs with `embedder`, `vector-store`, `pipeline-engine`.
 */

import { CrewhausError } from "@crewhaus/errors";

export type ChunkStrategy = "fixed" | "semantic" | "markdown";

export type ChunkOptions = {
  readonly strategy: ChunkStrategy;
  /** Window size: chars for "fixed", sentences for "semantic", chars for "markdown" sub-chunking. */
  readonly size: number;
  /** Overlap (in the same units as size). Defaults to 0. */
  readonly overlap?: number;
  /** Locale for `Intl.Segmenter` ("semantic" only). Defaults to "en". */
  readonly locale?: string;
};

export type Document = {
  /** Stable identifier (URL, path, hash). Used to derive chunk ids. */
  readonly id: string;
  readonly text: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export type Chunk = {
  readonly id: string;
  readonly docId: string;
  readonly index: number;
  /** Inclusive byte offset in `doc.text` where the chunk begins. */
  readonly startOffset: number;
  /** Exclusive byte offset where the chunk ends. */
  readonly endOffset: number;
  readonly text: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export class ChunkerError extends CrewhausError {
  override readonly name = "ChunkerError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

function makeChunkId(docId: string, index: number, start: number): string {
  return `${docId}:${index}:${start}`;
}

function chunkFixed(doc: Document, opts: ChunkOptions): Chunk[] {
  if (opts.size <= 0) throw new ChunkerError("size must be positive");
  const overlap = opts.overlap ?? 0;
  if (overlap < 0 || overlap >= opts.size) {
    throw new ChunkerError(`overlap (${overlap}) must be in [0, size) (size=${opts.size})`);
  }
  const out: Chunk[] = [];
  const stride = opts.size - overlap;
  let start = 0;
  let index = 0;
  while (start < doc.text.length) {
    const end = Math.min(start + opts.size, doc.text.length);
    out.push({
      id: makeChunkId(doc.id, index, start),
      docId: doc.id,
      index,
      startOffset: start,
      endOffset: end,
      text: doc.text.slice(start, end),
      ...(doc.metadata !== undefined ? { metadata: doc.metadata } : {}),
    });
    if (end >= doc.text.length) break;
    start += stride;
    index += 1;
  }
  return out;
}

function chunkSemantic(doc: Document, opts: ChunkOptions): Chunk[] {
  if (opts.size <= 0) throw new ChunkerError("size must be positive");
  const overlap = opts.overlap ?? 0;
  // Intl.Segmenter is widely available in modern Node + Bun. An invalid
  // `locale` makes the constructor throw a raw `RangeError`; wrap it so callers
  // see the package's typed `ChunkerError` contract (with the original as cause).
  let segmenter: Intl.Segmenter;
  try {
    segmenter = new Intl.Segmenter(opts.locale ?? "en", { granularity: "sentence" });
  } catch (cause) {
    throw new ChunkerError(`invalid locale ${JSON.stringify(opts.locale)}`, cause);
  }
  type Sentence = { readonly text: string; readonly start: number; readonly end: number };
  const sentences: Sentence[] = [];
  for (const seg of segmenter.segment(doc.text)) {
    if (seg.segment.trim().length === 0) continue;
    const start = seg.index;
    const end = start + seg.segment.length;
    sentences.push({ text: seg.segment, start, end });
  }
  if (sentences.length === 0) return [];
  const out: Chunk[] = [];
  let i = 0;
  let index = 0;
  while (i < sentences.length) {
    const window = sentences.slice(i, Math.min(i + opts.size, sentences.length));
    if (window.length === 0) break;
    const startOffset = window[0]?.start ?? 0;
    const endOffset = window[window.length - 1]?.end ?? doc.text.length;
    const text = doc.text.slice(startOffset, endOffset);
    out.push({
      id: makeChunkId(doc.id, index, startOffset),
      docId: doc.id,
      index,
      startOffset,
      endOffset,
      text,
      ...(doc.metadata !== undefined ? { metadata: doc.metadata } : {}),
    });
    index += 1;
    if (i + opts.size >= sentences.length) break;
    i += Math.max(1, opts.size - overlap);
  }
  return out;
}

function chunkMarkdown(doc: Document, opts: ChunkOptions): Chunk[] {
  // Split the document into header-bounded sections, then sub-chunk each
  // section with the "fixed" strategy if it's longer than `opts.size`.
  const headerRe = /(^|\n)(#{1,6}\s)/g;
  const sectionRanges: Array<{ start: number; end: number }> = [];
  const matches: number[] = [0];
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: classical regex iter
  while ((m = headerRe.exec(doc.text)) !== null) {
    const headerStart = m[1] === "\n" ? m.index + 1 : m.index;
    if (headerStart !== 0 && !matches.includes(headerStart)) matches.push(headerStart);
  }
  matches.push(doc.text.length);
  for (let i = 0; i < matches.length - 1; i += 1) {
    const start = matches[i] as number;
    const end = matches[i + 1] as number;
    if (end > start) sectionRanges.push({ start, end });
  }
  const out: Chunk[] = [];
  let chunkIndex = 0;
  for (const range of sectionRanges) {
    const sliceLen = range.end - range.start;
    if (sliceLen <= opts.size) {
      out.push({
        id: makeChunkId(doc.id, chunkIndex, range.start),
        docId: doc.id,
        index: chunkIndex,
        startOffset: range.start,
        endOffset: range.end,
        text: doc.text.slice(range.start, range.end),
        ...(doc.metadata !== undefined ? { metadata: doc.metadata } : {}),
      });
      chunkIndex += 1;
      continue;
    }
    // Sub-chunk via fixed strategy on this section.
    const sub = chunkFixed(
      {
        id: doc.id,
        text: doc.text.slice(range.start, range.end),
        ...(doc.metadata !== undefined ? { metadata: doc.metadata } : {}),
      },
      opts,
    );
    for (const c of sub) {
      out.push({
        ...c,
        id: makeChunkId(doc.id, chunkIndex, range.start + c.startOffset),
        index: chunkIndex,
        startOffset: range.start + c.startOffset,
        endOffset: range.start + c.endOffset,
      });
      chunkIndex += 1;
    }
  }
  return out;
}

export function chunk(doc: Document, opts: ChunkOptions): Chunk[] {
  switch (opts.strategy) {
    case "fixed":
      return chunkFixed(doc, opts);
    case "semantic":
      return chunkSemantic(doc, opts);
    case "markdown":
      return chunkMarkdown(doc, opts);
    default: {
      const exhaustive: never = opts.strategy;
      throw new ChunkerError(`unknown strategy "${exhaustive}"`);
    }
  }
}
