import { parse as parseYaml } from "yaml";
import { DatasetLoadError } from "../errors";
import { DatasetSchema, type LoadedDataset, type Sample, SampleSchema } from "../index";
import { parseCsv } from "./csv";

/**
 * HTTP loader — fetches the URL into memory, then dispatches to the
 * appropriate format parser based on the URL extension first, then
 * the response Content-Type as a fallback.
 *
 * Buffers the entire body in memory; HuggingFace-scale datasets should
 * be downloaded ahead of time and loaded via the local-file loaders.
 */
export async function loadHttp(url: string): Promise<LoadedDataset> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new DatasetLoadError(`HTTP ${response.status} fetching ${url}`);
  }
  const text = await response.text();
  const ct = (response.headers.get("content-type") ?? "").toLowerCase();
  const lower = url.toLowerCase();

  if (
    lower.endsWith(".jsonl") ||
    lower.endsWith(".ndjson") ||
    ct.includes("application/x-jsonlines") ||
    ct.includes("application/x-ndjson")
  ) {
    return { name: deriveName(url), samples: parseJsonlText(text, url) };
  }
  if (lower.endsWith(".csv") || ct.includes("text/csv")) {
    return { name: deriveName(url), samples: parseCsvText(text, url) };
  }
  if (
    lower.endsWith(".yaml") ||
    lower.endsWith(".yml") ||
    ct.includes("application/yaml") ||
    ct.includes("text/yaml")
  ) {
    return parseYamlText(text, url);
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

async function* parseJsonlText(text: string, source: string): AsyncIterable<Sample> {
  let lineNo = 0;
  for (const raw of text.split(/\r?\n/)) {
    lineNo += 1;
    if (raw.trim() === "") continue;
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
    yield result.data;
  }
}

async function* parseCsvText(text: string, source: string): AsyncIterable<Sample> {
  const rows = parseCsv(text);
  if (rows.length === 0) return;
  const header = rows[0];
  if (!header) return;
  let rowNo = 1;
  for (const row of rows.slice(1)) {
    rowNo += 1;
    if (row.length === 1 && row[0] === "") continue;
    const obj: Record<string, string | string[]> = {};
    for (let i = 0; i < header.length; i++) {
      const key = header[i];
      if (key === undefined) continue;
      const cell = row[i] ?? "";
      if (key === "expected_tools" && cell !== "") {
        obj[key] = cell
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      } else if (cell !== "") {
        obj[key] = cell;
      }
    }
    const result = SampleSchema.safeParse(obj);
    if (!result.success) {
      throw new DatasetLoadError(
        `invalid sample on row ${rowNo} of ${source}: ${result.error.message}`,
      );
    }
    yield result.data;
  }
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
