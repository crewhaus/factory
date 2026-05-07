import { basename } from "node:path";
import { parse as parseYaml } from "yaml";
import { DatasetLoadError } from "../errors";
import { DatasetSchema, type LoadedDataset, type Sample, SampleSchema } from "../index";

export async function loadYaml(path: string): Promise<LoadedDataset> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new DatasetLoadError(`file not found: ${path}`);
  }
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    throw new DatasetLoadError(`malformed YAML in ${path}`, err);
  }

  // Two accepted shapes:
  //   1. Top-level Dataset: { name, samples: [Sample, …] }
  //   2. Bare Sample[] (assigns a synthetic name from the filename)
  if (Array.isArray(parsed)) {
    const name = basename(path).replace(/\.(yaml|yml)$/i, "");
    return { name, samples: yieldSamples(parsed, path) };
  }

  const result = DatasetSchema.safeParse(parsed);
  if (!result.success) {
    throw new DatasetLoadError(`invalid dataset in ${path}: ${result.error.message}`);
  }
  const dataset = result.data;
  return { name: dataset.name, samples: yieldSamples(dataset.samples, path) };
}

async function* yieldSamples(samples: ReadonlyArray<unknown>, path: string): AsyncIterable<Sample> {
  let i = 0;
  for (const raw of samples) {
    const result = SampleSchema.safeParse(raw);
    if (!result.success) {
      throw new DatasetLoadError(
        `invalid sample at index ${i} of ${path}: ${result.error.message}`,
      );
    }
    yield result.data;
    i += 1;
  }
}
