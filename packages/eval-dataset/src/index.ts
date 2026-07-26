/**
 * Catalog R-eval `eval-dataset` — load samples from JSONL, CSV, YAML, or HTTP.
 *
 * Sample shape is the contract every other eval-* module consumes:
 *   { id, input, history?, expected_output?, expected_tools?, metadata? }
 *
 * Loaders return an `AsyncIterable<Sample>` so 100k-row datasets stream rather
 * than load fully into memory. JSONL truly streams — local files via
 * `Bun.file().stream()`, HTTP bodies via the fetch reader (B24) — through one
 * shared incremental line parser, memory bounded by the longest line. CSV and
 * YAML buffer their source whole, locally and over HTTP alike (YAML can't
 * stream, CSV quoting spans physical lines).
 *
 * Reference: build-roadmap.md §16.
 */
import { z } from "zod";
import { DatasetLoadError } from "./errors";
import { loadCsv } from "./loaders/csv";
import { loadHttp } from "./loaders/http";
import { loadJsonl } from "./loaders/jsonl";
import { loadYaml } from "./loaders/yaml";

/**
 * B14 — one prior conversation turn of a multi-turn sample. STRICT item
 * shape: a history message is seeded into the eval session transcript
 * VERBATIM (no model call runs for it), so an unknown key is an authoring
 * mistake to reject loudly, not an extension point.
 */
export const HistoryMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
  })
  .strict();

export type HistoryMessage = z.infer<typeof HistoryMessageSchema>;

export const SampleSchema = z.object({
  id: z.string().min(1),
  input: z.string(),
  /**
   * B14 — optional prior conversation turns (MT-Bench-style multi-turn
   * evaluation). `input` stays the required FINAL user message — every
   * history-less dataset parses byte-identically — and when `history` is
   * present the eval invoker seeds these messages into the session
   * transcript verbatim before running `input`. Non-empty when present:
   * `history: []` says "multi-turn" while carrying no turns, an authoring
   * error worth rejecting at load. One DELIBERATE break rides along: a
   * hand-authored dataset whose samples already carried a free-form
   * `history` key was silently ignored before (Zod strip mode dropped the
   * unknown key) — it now validates, so a shape-mismatched value fails the
   * load loudly, and a shape-matched one starts seeding turns (changing
   * that dataset's sample hashes). Rename the key or fix its shape.
   */
  history: z.array(HistoryMessageSchema).min(1).optional(),
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
