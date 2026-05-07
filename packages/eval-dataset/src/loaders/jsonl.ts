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
    samples: streamJsonl(path),
  };
}

async function* streamJsonl(path: string): AsyncIterable<Sample> {
  const file = Bun.file(path);
  const text = await file.text();
  let lineNo = 0;
  for (const raw of text.split(/\r?\n/)) {
    lineNo += 1;
    if (raw.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new DatasetLoadError(`malformed JSON on line ${lineNo} of ${path}`, err);
    }
    const result = SampleSchema.safeParse(parsed);
    if (!result.success) {
      throw new DatasetLoadError(
        `invalid sample on line ${lineNo} of ${path}: ${result.error.message}`,
      );
    }
    yield result.data;
  }
}
