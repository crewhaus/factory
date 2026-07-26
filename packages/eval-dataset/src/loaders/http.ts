import { parse as parseYaml } from "yaml";
import { DatasetLoadError } from "../errors";
import { DatasetSchema, type LoadedDataset, type Sample, SampleSchema } from "../index";
import { csvRowsToSamples, parseCsv } from "./csv";
import { samplesFromJsonlStream, samplesFromJsonlText } from "./jsonl";

/**
 * HTTP loader — dispatches on the URL extension first, then the response
 * Content-Type as a fallback.
 *
 * B24 — `.jsonl`/`.ndjson` bodies STREAM line-by-line off the fetch body
 * reader through the SAME incremental parser as the local file loader:
 * memory stays bounded by the longest line, not the body, so a multi-GB
 * JSONL URL parses as it downloads. CSV and YAML buffer the entire body via
 * `response.text()` — YAML cannot be parsed incrementally and CSV quoting
 * can span physical lines — matching the (also buffered) local CSV/YAML
 * loaders.
 */
export async function loadHttp(url: string): Promise<LoadedDataset> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new DatasetLoadError(`HTTP ${response.status} fetching ${url}`);
  }
  const ct = (response.headers.get("content-type") ?? "").toLowerCase();
  const lower = url.toLowerCase();

  if (
    lower.endsWith(".jsonl") ||
    lower.endsWith(".ndjson") ||
    ct.includes("application/x-jsonlines") ||
    ct.includes("application/x-ndjson")
  ) {
    return { name: deriveName(url), samples: streamJsonlBody(response, url) };
  }
  if (lower.endsWith(".csv") || ct.includes("text/csv")) {
    // Buffered: CSV quoting can span physical lines. Rows then flow through
    // the SAME row → Sample generator as the file loader (metadata/history
    // JSON columns included).
    const [header, ...dataRows] = parseCsv(await response.text());
    return { name: deriveName(url), samples: csvRowsToSamples(dataRows, header ?? [], url) };
  }
  if (
    lower.endsWith(".yaml") ||
    lower.endsWith(".yml") ||
    ct.includes("application/yaml") ||
    ct.includes("text/yaml")
  ) {
    return parseYamlText(await response.text(), url);
  }
  throw new DatasetLoadError(
    `unrecognized HTTP dataset format for ${url} (content-type: ${ct || "unknown"})`,
  );
}

function deriveName(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "remote-dataset";
    return last.replace(/\.(jsonl|ndjson|csv|yaml|yml)$/i, "");
  } catch {
    return "remote-dataset";
  }
}

/**
 * B24 — HTTP `.jsonl` delegates to the shared incremental JSONL parser (see
 * `loaders/jsonl.ts`) over the fetch body reader. A null body (null-body
 * statuses, minimal Response stubs) falls back to buffering — there is
 * nothing to stream.
 */
async function* streamJsonlBody(response: Response, source: string): AsyncIterable<Sample> {
  const body = response.body;
  if (body === null || body === undefined) {
    yield* samplesFromJsonlText(await response.text(), source);
    return;
  }
  yield* samplesFromJsonlStream(body, source);
}

function parseYamlText(text: string, source: string): LoadedDataset {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    throw new DatasetLoadError(`malformed YAML in ${source}`, err);
  }
  if (Array.isArray(parsed)) {
    return { name: deriveName(source), samples: yieldSamples(parsed, source) };
  }
  const result = DatasetSchema.safeParse(parsed);
  if (!result.success) {
    throw new DatasetLoadError(`invalid dataset in ${source}: ${result.error.message}`);
  }
  return { name: result.data.name, samples: yieldSamples(result.data.samples, source) };
}

async function* yieldSamples(
  samples: ReadonlyArray<unknown>,
  source: string,
): AsyncIterable<Sample> {
  let i = 0;
  for (const raw of samples) {
    const result = SampleSchema.safeParse(raw);
    if (!result.success) {
      throw new DatasetLoadError(
        `invalid sample at index ${i} of ${source}: ${result.error.message}`,
      );
    }
    yield result.data;
    i += 1;
  }
}
