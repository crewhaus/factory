/**
 * Item 12 — dataset-registry plumbing for the CLI: the `crewhaus datasets`
 * subcommand family, `distill --register` versioned promotion, and the
 * `--dataset registry:<name>[@version][#split]` shorthand shared by `eval`
 * and `optimize`. Factored out of the entry file `index.ts` (which runs a
 * top-level argv switch and so cannot be imported by a test without
 * executing the CLI). Side-effect-free — all filesystem access goes through
 * an injected `DatasetRegistry` — mirroring `eval-history.ts` / `feedback.ts`.
 *
 * Determinism contract (the reason none of this uses an RNG):
 * - Split assignment orders samples by sha256(sample.id) — a stable
 *   pseudo-shuffle independent of file order — then cuts at the cumulative
 *   percentage boundaries. Re-importing the same ids always lands each
 *   sample in the same split.
 * - `overallDatasetHash` folds the registry record's per-sample content
 *   hashes (computed at `put`) into one sha256, so the run-history index and
 *   (spec, dataset) baselines from item 3 key on dataset CONTENT — the
 *   registry analogue of `hashDatasetFile`.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  type DatasetRecord,
  type DatasetRegistry,
  type DatasetSplit,
  latestVersion,
  overallDatasetHash,
} from "@crewhaus/dataset-registry";
import type { Sample } from "@crewhaus/eval-dataset";

/** `--dataset` values with this prefix resolve via the registry, not a file. */
export const REGISTRY_PREFIX = "registry:";

const SPLIT_ORDER: ReadonlyArray<DatasetSplit> = ["train", "dev", "test"];

/** Thrown on a malformed ref / split-spec or an unresolvable registry lookup.
 *  The CLI entry file catches it and routes the message through `die()`;
 *  tests assert on `.message` without the process exiting. */
export class DatasetRefError extends Error {
  override readonly name = "DatasetRefError";
}

export function isDatasetSplit(s: string): s is DatasetSplit {
  return (SPLIT_ORDER as ReadonlyArray<string>).includes(s);
}

/** Registry root shared with the emitted eval-bundle harness (see
 *  target-eval-bundle): `.crewhaus/datasets` under the cwd, or the
 *  CREWHAUS_DATASETS_DIR override. */
export function defaultDatasetsRoot(): string {
  return process.env["CREWHAUS_DATASETS_DIR"] ?? resolve(process.cwd(), ".crewhaus", "datasets");
}

// -------- refs --------

export type RegistryRef = {
  readonly name: string;
  /** Omitted → resolve to the latest version at lookup time. */
  readonly version?: string;
  /** Omitted → the union of train + dev only (the locked test split never
   *  rides along on a bare ref — see {@link resolveRegistryRef}). */
  readonly split?: DatasetSplit;
};

/** Parse `<name>[@version]` (the `datasets get` positional). */
export function parseNameVersion(refStr: string): { name: string; version?: string } {
  const at = refStr.indexOf("@");
  if (at === -1) return { name: refStr };
  const name = refStr.slice(0, at);
  const version = refStr.slice(at + 1);
  if (version === "") throw new DatasetRefError(`empty version in dataset ref "${refStr}"`);
  return { name, version };
}

/**
 * Parse a `--dataset` value. Not `registry:`-prefixed → undefined (the caller
 * falls through to `loadDataset` — bare file paths keep working exactly as
 * before). Prefixed but malformed → DatasetRefError.
 */
export function parseRegistryRef(value: string): RegistryRef | undefined {
  if (!value.startsWith(REGISTRY_PREFIX)) return undefined;
  let rest = value.slice(REGISTRY_PREFIX.length);
  let split: DatasetSplit | undefined;
  const hash = rest.indexOf("#");
  if (hash !== -1) {
    const s = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
    if (!isDatasetSplit(s)) {
      throw new DatasetRefError(
        `invalid split "#${s}" in "${value}" — expected #train, #dev, or #test`,
      );
    }
    split = s;
  }
  const { name, version } = parseNameVersion(rest);
  if (name === "") {
    throw new DatasetRefError(
      `missing dataset name in "${value}" — expected registry:<name>[@version][#split]`,
    );
  }
  return {
    name,
    ...(version !== undefined ? { version } : {}),
    ...(split !== undefined ? { split } : {}),
  };
}

// -------- deterministic splits --------

export type SplitSpec = { readonly train: number; readonly dev: number; readonly test: number };

/** Default promotion split for `datasets put` / `distill --register`. */
export const DEFAULT_SPLIT_SPEC: SplitSpec = { train: 70, dev: 15, test: 15 };

/** Parse `--split-spec`: `train/dev` or `train/dev/test` integer percentages
 *  summing to 100 (e.g. `70/15/15`, `80/20`). */
export function parseSplitSpec(s: string): SplitSpec {
  const parts = s.split("/");
  if (parts.length !== 2 && parts.length !== 3) {
    throw new DatasetRefError(
      `invalid split spec "${s}" — expected train/dev or train/dev/test percentages (e.g. 70/15/15)`,
    );
  }
  const nums = parts.map((p) => {
    if (!/^\d+$/.test(p)) {
      throw new DatasetRefError(`invalid split spec "${s}" — "${p}" is not a whole number`);
    }
    return Number.parseInt(p, 10);
  });
  const train = nums[0] ?? 0;
  const dev = nums[1] ?? 0;
  const test = nums[2] ?? 0;
  if (train + dev + test !== 100) {
    throw new DatasetRefError(
      `invalid split spec "${s}" — must sum to 100 (got ${train + dev + test})`,
    );
  }
  return { train, dev, test };
}

function idHash(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

/**
 * Deterministic split assignment. Samples are ordered by sha256(id) (stable
 * pseudo-shuffle, independent of input order; ties break on the raw id), then
 * cut at the cumulative percentage boundaries: train takes
 * `[0, floor(n·train%))`, dev the next slice, test the remainder — so the
 * three always partition the input exactly. NOT random: the same ids map to
 * the same splits on every run, which is what makes registry versions
 * reproducible. Tiny inputs can leave dev/test empty (floor); consumers fall
 * back accordingly (see the optimize `registry:` path).
 */
export function splitSamples(
  samples: ReadonlyArray<Sample>,
  spec: SplitSpec,
): { train: Sample[]; dev: Sample[]; test: Sample[] } {
  const ordered = [...samples].sort((a, b) => {
    const ha = idHash(a.id);
    const hb = idHash(b.id);
    if (ha !== hb) return ha < hb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const n = ordered.length;
  const trainEnd = Math.floor((n * spec.train) / 100);
  const devEnd = Math.floor((n * (spec.train + spec.dev)) / 100);
  return {
    train: ordered.slice(0, trainEnd),
    dev: ordered.slice(trainEnd, devEnd),
    test: ordered.slice(devEnd),
  };
}

// -------- versioning --------

/**
 * Auto-bump: `v<N+1>` where N is the highest existing `v<digits>` version
 * (0 when there is none → `v1`). Versions outside that grammar (a
 * hand-imported "1.0.0") are ignored rather than guessed at — the CLI's own
 * promotion lineage always lives in the vN namespace, so this can't collide.
 */
export function nextVersion(existing: ReadonlyArray<string>): string {
  let max = 0;
  for (const v of existing) {
    const m = /^v(\d+)$/.exec(v);
    if (m === null) continue;
    const n = Number.parseInt(m[1] as string, 10);
    if (n > max) max = n;
  }
  return `v${max + 1}`;
}

// -------- registry resolution (the `registry:` shorthand) --------

/** The splits a record actually carries (train/dev are always present keys;
 *  test is optional), in canonical train→dev→test order. */
export function splitsPresent(record: DatasetRecord): DatasetSplit[] {
  return SPLIT_ORDER.filter((s) => record.splits[s] !== undefined);
}

/** `<name>@<version>[#split]` — the datasetName recorded in the run-history
 *  index, so runs against different splits key to different baselines. */
export function registryDatasetName(name: string, version: string, split?: DatasetSplit): string {
  return `${name}@${version}${split !== undefined ? `#${split}` : ""}`;
}

/** The selected splits' samples, concatenated in canonical train→dev→test
 *  order (deterministic regardless of the `splits` array order). */
export function samplesForSplits(
  record: DatasetRecord,
  splits: ReadonlyArray<DatasetSplit>,
): Sample[] {
  const wanted = new Set(splits);
  const out: Sample[] = [];
  for (const s of SPLIT_ORDER) {
    if (wanted.has(s)) out.push(...(record.splits[s] ?? []));
  }
  return out;
}

/**
 * The registry-content digest that feeds `RunIndexEntry.datasetHash`. Now
 * owned by `@crewhaus/dataset-registry` (a pure function of a DatasetRecord)
 * so the emitted `target: eval` bundle derives the SAME dataset identity for
 * its run-index entry as `crewhaus eval --dataset registry:<ref>` does —
 * re-exported here because this module is the CLI's dataset vocabulary.
 */
export { overallDatasetHash };

export type ResolvedRegistryRef = {
  readonly record: DatasetRecord;
  readonly version: string;
  /** The splits the ref selects: the explicit `#split`, or train + dev (a
   *  bare ref excludes the locked test split). */
  readonly splits: DatasetSplit[];
  /** `<name>@<version>[#split]` — see {@link registryDatasetName}. */
  readonly datasetName: string;
  /** Union of the selected splits' samples (canonical train→dev→test order). */
  readonly samples: Sample[];
  /** Content hash of the selected splits — see {@link overallDatasetHash}. */
  readonly datasetHash: string;
};

export type ResolveRegistryRefOptions = {
  /** B16 — explicit opt-in for an explicit `#test` ref (mirrors
   *  dataset-registry's `GetOptions.allowTestSplit`). Without it a `#test`
   *  ref throws: the held-out test split is reserved for release gating
   *  (`--allow-test-split` on `crewhaus eval` / `crewhaus deploy canary`).
   *  Never re-includes test in a bare ref — bare refs are train + dev, full
   *  stop. */
  readonly allowTestSplit?: boolean;
  /** Warning sink; defaults to stderr. */
  readonly warn?: (line: string) => void;
};

/**
 * Resolve a parsed `registry:` ref against a registry: pick the latest
 * version when none was pinned, load the record, and derive the run-index
 * keying fields (datasetName + datasetHash). Registry lookups may also throw
 * DatasetRegistryError (a CrewhausError) — callers route both through die().
 *
 * B16 — the test-split lock, honored on the CLI path: a bare ref selects
 * train + dev ONLY (with a one-line stderr notice when a test split existed
 * and was excluded), and an explicit `#test` throws unless the caller passes
 * `allowTestSplit: true` — the same deliberate friction point as the
 * registry's guarded `get()`, so a holdout the optimizer never saw stays
 * spendable at release-gate time.
 */
export async function resolveRegistryRef(
  registry: DatasetRegistry,
  ref: RegistryRef,
  opts: ResolveRegistryRefOptions = {},
): Promise<ResolvedRegistryRef> {
  if (ref.split === "test" && opts.allowTestSplit !== true) {
    throw new DatasetRefError(
      `test split locked for "${ref.name}" — the held-out split is reserved for release gating (pass --allow-test-split on \`crewhaus eval\` / \`crewhaus deploy canary\`)`,
    );
  }
  const version = ref.version ?? (await latestVersion(registry, ref.name));
  if (version === undefined) {
    throw new DatasetRefError(
      `dataset "${ref.name}" has no versions in the registry — import one with \`crewhaus datasets put\``,
    );
  }
  const record = await registry.getRecord(ref.name, version);
  if (ref.split !== undefined && record.splits[ref.split] === undefined) {
    throw new DatasetRefError(`split "${ref.split}" not present in "${ref.name}@${version}"`);
  }
  const splits =
    ref.split !== undefined ? [ref.split] : splitsPresent(record).filter((s) => s !== "test");
  if (ref.split === undefined && record.splits.test !== undefined) {
    const warn = opts.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
    warn(
      `[datasets] note: "${ref.name}@${version}" carries a locked test split — excluded (bare refs select train+dev; #test needs --allow-test-split on \`crewhaus eval\` / \`crewhaus deploy canary\`)`,
    );
  }
  return {
    record,
    version,
    splits,
    datasetName: registryDatasetName(ref.name, version, ref.split),
    samples: samplesForSplits(record, splits),
    datasetHash: overallDatasetHash(record, splits),
  };
}

/**
 * B16 — the optimizing commands never consume the locked test split,
 * regardless of flags: an optimizer that searches — or an acceptance gate
 * that scores — against the held-out split burns it as a release gate.
 * Throws DatasetRefError on an explicit `#test` ref (bare refs already
 * resolve to train + dev only); `optimize`/`flywheel` call this before
 * {@link resolveRegistryRef} so the refusal explains itself instead of
 * pointing at an escape hatch those commands don't have.
 */
export function refuseTestSplitRef(command: "optimize" | "flywheel", ref: RegistryRef): void {
  if (ref.split !== "test") return;
  throw new DatasetRefError(
    `${command} never runs over the test split — "registry:${ref.name}#test" is the held-out release gate (use a bare ref, #train, or #dev; only the release-gating commands \`crewhaus eval\` / \`crewhaus deploy canary\` consume #test, behind --allow-test-split)`,
  );
}

export type InspectedRegistryRef = {
  readonly record: DatasetRecord;
  readonly version: string;
  /** The explicit `#split`, or EVERY split present — test included. */
  readonly splits: DatasetSplit[];
  /** `<name>@<version>[#split]` — see {@link registryDatasetName}. */
  readonly datasetName: string;
  /** The selected splits' samples (canonical train→dev→test order). */
  readonly samples: Sample[];
};

/**
 * Resolve a `registry:` ref for INSPECTION, not consumption: a bare ref
 * selects every split present — the locked test split included — because a
 * read-side report over a partial record misreports (a behavior only a test
 * sample exercises is not a coverage gap; PII in the holdout is still a
 * leak). No B16 lock and no warning fires here — this is the `dataset
 * audit` / `datasets get` posture. Anything that RUNS or DERIVES DATA from
 * the samples must resolve through {@link resolveRegistryRef} instead.
 */
export async function inspectRegistryRef(
  registry: DatasetRegistry,
  ref: RegistryRef,
): Promise<InspectedRegistryRef> {
  const version = ref.version ?? (await latestVersion(registry, ref.name));
  if (version === undefined) {
    throw new DatasetRefError(
      `dataset "${ref.name}" has no versions in the registry — import one with \`crewhaus datasets put\``,
    );
  }
  const record = await registry.getRecord(ref.name, version);
  if (ref.split !== undefined && record.splits[ref.split] === undefined) {
    throw new DatasetRefError(`split "${ref.split}" not present in "${ref.name}@${version}"`);
  }
  const splits = ref.split !== undefined ? [ref.split] : splitsPresent(record);
  return {
    record,
    version,
    splits,
    datasetName: registryDatasetName(ref.name, version, ref.split),
    samples: samplesForSplits(record, splits),
  };
}

// -------- promotion (datasets put / distill --register) --------

export type RegisterDatasetOptions = {
  readonly registry: DatasetRegistry;
  readonly name: string;
  readonly samples: ReadonlyArray<Sample>;
  /** Percentage split (default {@link DEFAULT_SPLIT_SPEC}); ignored with `split`. */
  readonly splitSpec?: SplitSpec;
  /** Put every sample into this single named split instead of splitting. */
  readonly split?: DatasetSplit;
};

/**
 * Import samples as a new auto-bumped version (v1, v2, …) of `name`, either
 * deterministically split per the spec (test key omitted when the spec gives
 * test 0%) or wholesale into one named split. Returns the persisted record.
 */
export async function registerDataset(opts: RegisterDatasetOptions): Promise<DatasetRecord> {
  const version = nextVersion(await opts.registry.list(opts.name));
  let splits: { train: Sample[]; dev: Sample[]; test?: Sample[] };
  if (opts.split !== undefined) {
    splits = {
      train: opts.split === "train" ? [...opts.samples] : [],
      dev: opts.split === "dev" ? [...opts.samples] : [],
      ...(opts.split === "test" ? { test: [...opts.samples] } : {}),
    };
  } else {
    const spec = opts.splitSpec ?? DEFAULT_SPLIT_SPEC;
    const { train, dev, test } = splitSamples(opts.samples, spec);
    splits = { train, dev, ...(spec.test > 0 ? { test } : {}) };
  }
  return opts.registry.put({ name: opts.name, version, splits });
}

// -------- serialization (datasets get) --------

/**
 * Samples as JSONL for stdout piping. With `split` given: that split's
 * samples verbatim (SampleSchema-valid — feed straight back into
 * `--dataset <file>.jsonl`). Without: all splits merged, each line tagged
 * with a top-level `split` column (SampleSchema strips unknown keys on load,
 * so the merged form round-trips too).
 */
export function recordToJsonl(record: DatasetRecord, split?: DatasetSplit): string {
  const lines: string[] = [];
  if (split !== undefined) {
    for (const s of record.splits[split] ?? []) lines.push(JSON.stringify(s));
  } else {
    for (const sp of splitsPresent(record)) {
      for (const s of record.splits[sp] ?? []) lines.push(JSON.stringify({ ...s, split: sp }));
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
