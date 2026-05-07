/**
 * Catalog R-eval `eval-dataset` — load samples from JSONL, CSV, YAML, or HTTP.
 *
 * Sample shape is the contract every other eval-* module consumes:
 *   { id, input, expected_output?, expected_tools?, metadata? }
 *
 * Loaders return an `AsyncIterable<Sample>` so 100k-row datasets stream rather
 * than load fully into memory. JSONL/CSV truly stream off the file system via
 * `Bun.file().stream()`. YAML and HTTP buffer (YAML can't stream; HTTP buffers
 * before re-dispatching to the format-specific loader).
 *
 * Reference: build-roadmap.md §16.
 */
import { z } from "zod";
import { DatasetLoadError } from "./errors";
import { loadCsv } from "./loaders/csv";
import { loadHttp } from "./loaders/http";
import { loadJsonl } from "./loaders/jsonl";
import { loadYaml } from "./loaders/yaml";

export const SampleSchema = z.object({
  id: z.string().min(1),
  input: z.string(),
  expected_output: z.string().optional(),
  expected_tools: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type Sample = z.infer<typeof SampleSchema>;

export const DatasetSchema = z.object({
  name: z.string(),
  samples: z.array(SampleSchema),
});

export type Dataset = z.infer<typeof DatasetSchema>;

export type LoadedDataset = {
  readonly name: string;
  readonly samples: AsyncIterable<Sample>;
};

export type DatasetSource = string | URL;

/**
 * Dispatch to the right loader based on URL scheme or file extension.
 * `http://` and `https://` go to the HTTP loader. Local paths are dispatched
 * by extension: `.jsonl`, `.csv`, `.yaml`, `.yml`.
 */
export async function loadDataset(source: DatasetSource): Promise<LoadedDataset> {
  const sourceStr = typeof source === "string" ? source : source.toString();

  if (sourceStr.startsWith("http://") || sourceStr.startsWith("https://")) {
    return loadHttp(sourceStr);
  }

  const lower = sourceStr.toLowerCase();
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) return loadJsonl(sourceStr);
  if (lower.endsWith(".csv")) return loadCsv(sourceStr);
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return loadYaml(sourceStr);

  throw new DatasetLoadError(
    `unrecognized dataset source "${sourceStr}" — expected .jsonl, .csv, .yaml, .yml, or http(s):// URL`,
  );
}

export { DatasetLoadError };
export { loadCsv, loadHttp, loadJsonl, loadYaml };
export { parseCsv } from "./loaders/csv";
