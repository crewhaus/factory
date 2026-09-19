/**
 * Where a set of samples comes from: inline in the call, or a file in the
 * workspace.
 *
 * Both paths end at `SampleSchema` — the SAME schema `crewhaus eval` loads a
 * dataset with — so anything this package writes into the registry is
 * something the runner can read back. Re-declaring the sample shape in zod
 * here would be a second schema: `history` is rejected when present-but-empty
 * and the message says so, `id` must be non-empty, unknown keys are stripped
 * rather than kept, and every one of those rules would have to be discovered
 * twice.
 *
 * THE FILE PATH NEVER GOES THROUGH `loadDataset`. That dispatcher sends
 * anything starting `http://` or `https://` to the HTTP loader, which fetches
 * — a network call out of a tool that declares no network capability, driven
 * by a caller-supplied string. Dispatch here is on the extension of the
 * RESOLVED, contained path, and only ever reaches the three local loaders.
 */
import { statSync } from "node:fs";
import { extname } from "node:path";
import { type Sample, SampleSchema, loadCsv, loadJsonl, loadYaml } from "@crewhaus/eval-dataset";
import { type SafePath, ToolPermissionError, resolveSafe } from "../paths";
import { type Loaded, errorMessage, fail, renderGiven } from "./result";

/** A dataset file is data a human or a run produced; past this, ask for a
 *  narrower source. Applied to the size on disk, before a byte is read. */
export const MAX_DATASET_BYTES = 64 * 1024 * 1024;

/** How many samples one call will materialize. A dataset over this is not
 *  refused quietly — the caller is told the count was capped. */
export const MAX_SAMPLES = 200_000;

/** The local dataset formats `@crewhaus/eval-dataset` can read. `.json` is
 *  deliberately absent: the loader family has no JSON reader, and inventing
 *  one here would be a fourth dataset dialect this package alone understands. */
const LOADERS = {
  ".jsonl": loadJsonl,
  ".ndjson": loadJsonl,
  ".csv": loadCsv,
  ".yaml": loadYaml,
  ".yml": loadYaml,
} as const;

export type LoadedSamples = {
  readonly samples: Sample[];
  /** The loader's name for the dataset (the file's basename). */
  readonly name: string;
  /** True when {@link MAX_SAMPLES} cut the read short — the list is a PREFIX,
   *  not the dataset. */
  readonly truncated: boolean;
};

/**
 * Read a dataset file inside the workspace. The loaders throw on the first
 * malformed line naming its number, which is exactly the right behaviour for
 * a writer: a half-read dataset promoted as a version is a corrupt version.
 */
export async function loadSamplesFromFile(
  toolName: string,
  rel: string,
  maxSamples: number = MAX_SAMPLES,
): Promise<Loaded<LoadedSamples>> {
  const shown = renderGiven(rel);
  let safe: SafePath;
  try {
    safe = resolveSafe(toolName, rel);
  } catch (err) {
    if (err instanceof ToolPermissionError) return fail("refused", err.message);
    throw err;
  }
  let size: number;
  try {
    const stat = statSync(safe.real);
    if (!stat.isFile()) return fail("bad-input", `"${shown}" is not a file`);
    size = stat.size;
  } catch {
    return fail("missing", `"${shown}" does not exist or is unreadable`);
  }
  if (size > MAX_DATASET_BYTES) {
    return fail(
      "too-large",
      `"${shown}" is ${size} bytes, over the ${MAX_DATASET_BYTES} limit for this tool`,
    );
  }
  // The RESOLVED path decides the format. A caller string of
  // "https://host/x.jsonl" never reaches a loader as a URL: it resolved to a
  // file inside the workspace (or was refused) long before this line.
  const ext = extname(safe.real).toLowerCase() as keyof typeof LOADERS;
  const loader = LOADERS[ext];
  if (loader === undefined) {
    return fail(
      "bad-input",
      `"${shown}" has no dataset extension this tool reads — expected one of ${Object.keys(LOADERS).join(", ")}`,
    );
  }
  try {
    const loaded = await loader(safe.real);
    const samples: Sample[] = [];
    let truncated = false;
    for await (const sample of loaded.samples) {
      if (samples.length >= maxSamples) {
        truncated = true;
        break;
      }
      samples.push(sample);
    }
    return { ok: true, value: { samples, name: loaded.name, truncated } };
  } catch (err) {
    return fail("malformed", `"${shown}" could not be loaded: ${errorMessage(err)}`);
  }
}

/**
 * Validate inline samples. The index is reported because the caller built the
 * array and the schema's own message says nothing about WHICH element failed.
 */
export function parseInlineSamples(values: ReadonlyArray<unknown>): Loaded<Sample[]> {
  const samples: Sample[] = [];
  for (const [i, value] of values.entries()) {
    const parsed = SampleSchema.safeParse(value);
    if (!parsed.success) {
      return fail(
        "malformed",
        `samples[${i}] is not a valid sample: ${renderGiven(parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; "))}`,
      );
    }
    samples.push(parsed.data);
  }
  return { ok: true, value: samples };
}

/** How many of a sample set carry a usable gold. Reported rather than
 *  assumed: a dataset of gold-less samples is fine for a judge and useless
 *  for `exact_match`, and only the caller knows which it has. */
export function goldCount(samples: ReadonlyArray<Sample>): number {
  return samples.filter((s) => s.expected_output !== undefined && s.expected_output.trim() !== "")
    .length;
}
