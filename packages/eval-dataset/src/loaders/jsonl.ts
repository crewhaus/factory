import { basename } from "node:path";
import { DatasetLoadError } from "../errors";
import { type LoadedDataset, type Sample, SampleSchema } from "../index";

export async function loadJsonl(path: string): Promise<LoadedDataset> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new DatasetLoadError(`file not found: ${path}`);
  }
  return {
    name: basename(path).replace(/\.(jsonl|ndjson)$/i, ""),
    samples: streamJsonlFile(path),
  };
}

/**
 * B24 — local `.jsonl` files stream through the SAME incremental line parser
 * as HTTP bodies: `Bun.file().stream()` is a `ReadableStream<Uint8Array>`
 * exactly like a fetch body, so memory stays bounded by the longest line, not
 * the file. The generator wrapper keeps the file unopened until the caller
 * actually iterates (loaders hand back lazy iterables, not open handles).
 */
async function* streamJsonlFile(path: string): AsyncIterable<Sample> {
  yield* samplesFromJsonlStream(Bun.file(path).stream(), path);
}

/**
 * One line-numbering + parse + validate closure shared by every JSONL entry
 * point (local file, HTTP body, buffered fallback), so error messages
 * ("malformed JSON on line N of SOURCE") can never drift between loaders.
 * Blank lines count toward numbering, then skip; a trailing `\r` (CRLF input
 * split on `\n`) is tolerated.
 */
function makeLineParser(source: string): (line: string) => Sample | undefined {
  let lineNo = 0;
  return (line) => {
    lineNo += 1;
    const raw = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (raw.trim() === "") return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new DatasetLoadError(`malformed JSON on line ${lineNo} of ${source}`, err);
    }
    const result = SampleSchema.safeParse(parsed);
    if (!result.success) {
      throw new DatasetLoadError(
        `invalid sample on line ${lineNo} of ${source}: ${result.error.message}`,
      );
    }
    return result.data;
  };
}

/**
 * Buffered-text JSONL → Sample generator (the HTTP loader's null-body
 * fallback). Same parser, same line numbering as the streaming path.
 */
export async function* samplesFromJsonlText(text: string, source: string): AsyncIterable<Sample> {
  const parseLine = makeLineParser(source);
  for (const line of text.split("\n")) {
    const sample = parseLine(line);
    if (sample !== undefined) yield sample;
  }
}

/**
 * B24 — incremental JSONL over any byte stream (local file or fetch body):
 * pull chunks off the reader, split on newlines (tolerating CRLF and JSON
 * lines split across chunk boundaries), and validate each line as it
 * arrives. Line numbering matches the buffered parser's exactly (blank lines
 * count, then skip).
 */
export async function* samplesFromJsonlStream(
  stream: ReadableStream<Uint8Array>,
  source: string,
): AsyncIterable<Sample> {
  const parseLine = makeLineParser(source);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      carry += decoder.decode(value, { stream: true });
      let nl = carry.indexOf("\n");
      while (nl !== -1) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        const sample = parseLine(line);
        if (sample !== undefined) yield sample;
        nl = carry.indexOf("\n");
      }
    }
    // Flush any multi-byte tail the decoder held back, then the final
    // (newline-less) line — or the trailing "" a newline-terminated source
    // leaves, which parseLine counts and skips like the buffered parser.
    carry += decoder.decode();
    const last = parseLine(carry);
    if (last !== undefined) yield last;
  } finally {
    // Early exit (consumer break, invalid line mid-stream) must not leave a
    // connection or file handle dangling; on normal completion this is a
    // no-op.
    await reader.cancel().catch(() => {});
  }
}
