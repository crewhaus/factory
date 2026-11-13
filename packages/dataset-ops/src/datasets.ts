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
  type HeldOutSplit,
  type HeldOutUseInput,
  compareVersions,
  latestVersion,
  overallDatasetHash,
} from "@crewhaus/dataset-registry";
import type { Sample } from "@crewhaus/eval-dataset";

// -------- provenance taxonomy (B22) --------

/**
 * B22 — the canonical `metadata.source` provenance vocabulary. Every
 * first-party writer stamps a member: `production_log` (distilled
 * ratings/corrections AND `dataset mine` hard cases — both come from real
 * sessions; the tool identity survives in sibling keys, `feedback_source`
 * for distill and `mined: true` for mine), `synthetic` (dataset synthesize
 * stress variants — never carry golds, an invariant the registry `put`
 * enforces), `synthetic_human_verified` (generated samples whose gold a
 * human verified, e.g. a refresh-goldens promotion onto a synthetic
 * sample), `human_authored` (hand-written datasets), and `canary` (B18
 * contamination tripwires). Values outside the taxonomy WARN at promotion
 * and in `dataset lint` — never fail — so foreign datasets still import.
 */
export const SOURCE_TAXONOMY: ReadonlyArray<string> = [
  "human_authored",
  "production_log",
  "synthetic",
  "synthetic_human_verified",
  "canary",
];

/** The sample's string `metadata.source`, or undefined when absent/non-string
 *  (non-string values are provenance objects, not taxonomy labels). */
export function sampleSource(s: Sample): string | undefined {
  const v = s.metadata?.["source"];
  return typeof v === "string" ? v : undefined;
}

/** Samples whose `metadata.source` is a string OUTSIDE the taxonomy, grouped
 *  value → offending sample ids (insertion order). Sourceless samples are
 *  fine — the taxonomy governs declared provenance, it does not require it. */
export function offTaxonomySources(samples: ReadonlyArray<Sample>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const s of samples) {
    const source = sampleSource(s);
    if (source === undefined || SOURCE_TAXONOMY.includes(source)) continue;
    const ids = out.get(source);
    if (ids !== undefined) ids.push(s.id);
    else out.set(source, [s.id]);
  }
  return out;
}

/**
 * B22 — retag `source: synthetic` samples that (now) carry a gold as
 * `synthetic_human_verified`: the only path that golds a synthetic sample is
 * a human-evidence promotion (refresh-goldens `--apply` reconciling
 * corrections/up-rated turns), so the tag records exactly what happened —
 * and keeps the registry's synthetic-never-gold invariant satisfiable.
 * Everything else passes through untouched.
 */
export function promoteVerifiedSynthetics(samples: ReadonlyArray<Sample>): Sample[] {
  return samples.map((s) =>
    sampleSource(s) === "synthetic" && s.expected_output !== undefined
      ? { ...s, metadata: { ...(s.metadata ?? {}), source: "synthetic_human_verified" } }
      : s,
  );
}

// -------- contamination canaries (B18) --------

/**
 * B18 — the deterministic canary phrase for one dataset version: a hex
 * digest of the (name, version) pair, no wall clock involved, so the same
 * version always carries the same phrase and `dataset lint` can recompute it
 * offline. Unique enough (128 bits) that an appearance ANYWHERE outside the
 * dataset — spec instructions, few-shot pools — is proof of leakage, not
 * coincidence.
 */
export function canaryPhrase(name: string, version: string): string {
  return createHash("sha256")
    .update(`crewhaus-canary:${name}@${version}`)
    .digest("hex")
    .slice(0, 32);
}

/** The canary sample's id for a version (stable, collision-proof against
 *  ordinary sample ids via the reserved prefix). */
export function canarySampleId(name: string, version: string): string {
  return `canary_${name}_${version}`;
}

/**
 * B18 — the one canary sample `datasets put --canary` injects per version:
 * a nonsense hex phrase with NO gold, tagged `metadata.source: "canary"`.
 * The runner excludes it from the pass-rate denominator (like needs_human)
 * and `dataset lint` scans spec instructions + few-shot pools for the
 * phrase — if it ever shows up there, eval content leaked into the prompt.
 */
export function canarySample(name: string, version: string): Sample {
  return {
    id: canarySampleId(name, version),
    input: `CREWHAUS-CANARY ${canaryPhrase(name, version)} — contamination tripwire; if this phrase appears in instructions or few-shot examples, this eval dataset has leaked into the prompt.`,
    metadata: {
      source: "canary",
      note: "contamination canary injected by `crewhaus datasets put --canary` — excluded from pass rates",
    },
  };
}

/** `--dataset` values with this prefix resolve via the registry, not a file. */
export const REGISTRY_PREFIX = "registry:";

const SPLIT_ORDER: ReadonlyArray<DatasetSplit> = ["train", "dev", "test", "holdout"];

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
  /** Omitted → the union of train + dev only (the locked test split and the
   *  holdout never ride along on a bare ref — see {@link resolveRegistryRef}). */
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
        `invalid split "#${s}" in "${value}" — expected #train, #dev, #test, or #holdout`,
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

/**
 * D39 — the deterministic split assignment + `vN` auto-bump MOVED to
 * `@crewhaus/feedback-distill` so a compiled daemon's auto-distill registers
 * the SAME splits this toolchain does. Re-exported under their historical
 * names; behavior is unchanged.
 */
import {
  DEFAULT_SPLIT_SPEC,
  type SplitSpec,
  nextVersion,
  splitSamples,
} from "@crewhaus/feedback-distill";

export { DEFAULT_SPLIT_SPEC, type SplitSpec, nextVersion, splitSamples };

/** A `--split-spec`: train/dev/test percentages, plus an optional holdout
 *  share (`train/dev/test/holdout`). */
export type DatasetSplitSpec = SplitSpec & { readonly holdout?: number };

/** Parse `--split-spec`: `train/dev`, `train/dev/test` or
 *  `train/dev/test/holdout` integer percentages summing to 100 (e.g.
 *  `70/15/15`, `80/20`, `60/15/15/10`). */
export function parseSplitSpec(s: string): DatasetSplitSpec {
  const parts = s.split("/");
  if (parts.length < 2 || parts.length > 4) {
    throw new DatasetRefError(
      `invalid split spec "${s}" — expected train/dev, train/dev/test or train/dev/test/holdout percentages (e.g. 70/15/15)`,
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
  const holdout = nums[3] ?? 0;
  if (train + dev + test + holdout !== 100) {
    throw new DatasetRefError(
      `invalid split spec "${s}" — must sum to 100 (got ${train + dev + test + holdout})`,
    );
  }
  return parts.length === 4 ? { train, dev, test, holdout } : { train, dev, test };
}

/**
 * {@link splitSamples} with a holdout share: the same hash-ordered cut, with
 * the test+holdout tail cut once more at `floor(n·(train+dev+test)/100)`, so
 * train and dev are exactly what `train/dev/(test+holdout)` gives and a
 * three-share spec is untouched.
 */
export function splitSamplesWithHoldout(
  samples: ReadonlyArray<Sample>,
  spec: DatasetSplitSpec,
): { train: Sample[]; dev: Sample[]; test: Sample[]; holdout: Sample[] } {
  const holdoutShare = spec.holdout ?? 0;
  const { train, dev, test } = splitSamples(samples, {
    train: spec.train,
    dev: spec.dev,
    test: spec.test + holdoutShare,
  });
  const n = samples.length;
  const devEnd = Math.floor((n * (spec.train + spec.dev)) / 100);
  const testEnd = Math.floor((n * (spec.train + spec.dev + spec.test)) / 100);
  const cut = Math.max(0, Math.min(test.length, testEnd - devEnd));
  return { train, dev, test: test.slice(0, cut), holdout: test.slice(cut) };
}

// -------- registry resolution (the `registry:` shorthand) --------

/** The splits a record actually carries (train/dev are always present keys;
 *  test and holdout are optional), in canonical train→dev→test→holdout order. */
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
   *  bare ref excludes the locked test split and the holdout). */
  readonly splits: DatasetSplit[];
  /** `<name>@<version>[#split]` — see {@link registryDatasetName}. */
  readonly datasetName: string;
  /** Union of the selected splits' samples (canonical train→dev→test order). */
  readonly samples: Sample[];
  /** Content hash of the selected splits — see {@link overallDatasetHash}. */
  readonly datasetHash: string;
};

/** The two readers allowed to read a `#holdout` ref. */
export type HeldOutRead = { readonly purpose: "promotion" | "release" };

type ResolveRegistryRefBase = {
  /** Warning sink; defaults to stderr. */
  readonly warn?: (line: string) => void;
};

/**
 * Options for {@link resolveRegistryRef}. A caller that may read a held-out
 * split (`allowTestSplit` or `heldOut`) must say what the read is for in
 * `use`: the read is recorded before the samples are returned.
 */
export type ResolveRegistryRefOptions = ResolveRegistryRefBase &
  (
    | {
        readonly allowTestSplit?: false;
        readonly heldOut?: undefined;
        readonly use?: HeldOutUseInput;
      }
    | {
        /** B16 — explicit opt-in for an explicit `#test` ref (mirrors
         *  dataset-registry's `GetOptions.allowTestSplit`). Without it a
         *  `#test` ref throws: the held-out test split is reserved for release
         *  gating (`--allow-test-split` on `crewhaus eval` / `crewhaus deploy
         *  canary`). Never re-includes test in a bare ref — bare refs are
         *  train + dev, full stop. */
        readonly allowTestSplit?: boolean;
        /** The only way to read `#holdout`: a change's promotion check or a
         *  holdout release. `crewhaus eval` and `crewhaus deploy canary`
         *  never pass it. */
        readonly heldOut?: HeldOutRead;
        /** What the use line records. */
        readonly use: HeldOutUseInput;
      }
  );

function isHeldOutSplit(s: DatasetSplit): s is HeldOutSplit {
  return s === "test" || s === "holdout";
}

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
  if ((opts.allowTestSplit === true || opts.heldOut !== undefined) && opts.use === undefined) {
    throw new DatasetRefError(
      `a read that may reach a held-out split of "${ref.name}" must say what it is for (use) — the read is refused`,
    );
  }
  if (ref.split === "test" && opts.allowTestSplit !== true) {
    throw new DatasetRefError(
      `test split locked for "${ref.name}" — the held-out split is reserved for release gating (pass --allow-test-split on \`crewhaus eval\` / \`crewhaus deploy canary\`)`,
    );
  }
  if (
    ref.split === "holdout" &&
    opts.heldOut?.purpose !== "promotion" &&
    opts.heldOut?.purpose !== "release"
  ) {
    throw new DatasetRefError(
      `the holdout of "${ref.name}" is read only by a change's promotion check (\`crewhaus changes check\`) or a holdout release (\`crewhaus datasets release ${ref.name} --split holdout\`)`,
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
    ref.split !== undefined ? [ref.split] : splitsPresent(record).filter((s) => !isHeldOutSplit(s));
  if (
    ref.split === undefined &&
    (record.splits.test !== undefined || record.splits.holdout !== undefined)
  ) {
    const warn = opts.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
    const carried =
      record.splits.test !== undefined && record.splits.holdout !== undefined
        ? "a locked test split and a holdout"
        : record.splits.test !== undefined
          ? "a locked test split"
          : "a holdout";
    warn(
      `[datasets] note: "${ref.name}@${version}" carries ${carried} — excluded (bare refs select train+dev; #test needs --allow-test-split on \`crewhaus eval\` / \`crewhaus deploy canary\`; the holdout is read only by \`crewhaus changes check\` and \`crewhaus datasets release --split holdout\`)`,
    );
  }
  // A case some version of this dataset holds out is never consumed through
  // another version (the one it was cut from, or a later one that dropped the
  // holdout): such a read is refused, naming the version that holds it out.
  const consumed = splits.filter((s) => s !== "holdout");
  if (consumed.length > 0) {
    const heldOut = await heldOutIdsOfDataset(registry, ref.name);
    const reached = samplesForSplits(record, consumed).filter((s) => heldOut.ids.has(s.id)).length;
    if (reached > 0) {
      const newest = heldOut.versions[heldOut.versions.length - 1];
      throw new DatasetRefError(
        `"${ref.name}@${version}" holds ${reached} case(s) the holdout of "${ref.name}@${newest}" keeps out, so it is not read — read a version that carries the holdout (\`registry:${ref.name}@${newest}\`)`,
      );
    }
  }
  // Every held-out read is counted before the samples are handed back; a
  // use that cannot be recorded refuses the read.
  for (const split of splits) {
    if (!isHeldOutSplit(split)) continue;
    const use = opts.use;
    if (use === undefined) {
      throw new DatasetRefError(
        `a read of "${ref.name}@${version}#${split}" must say what it is for (use) — the read is refused`,
      );
    }
    if (registry.recordUse === undefined) {
      throw new DatasetRefError(
        `this dataset registry cannot record a held-out use, so "${ref.name}@${version}#${split}" is not read`,
      );
    }
    try {
      registry.recordUse(ref.name, version, split, use);
    } catch (err) {
      throw new DatasetRefError(
        `could not record the held-out use of "${ref.name}@${version}#${split}", so it is not read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
  if (ref.split === "holdout") {
    throw new DatasetRefError(
      `${command} never runs over the holdout — "registry:${ref.name}#holdout" is read only by a change's promotion check (\`crewhaus changes check\`) or a holdout release (\`crewhaus datasets release --split holdout\`); use a bare ref, #train, or #dev`,
    );
  }
  if (ref.split !== "test") return;
  throw new DatasetRefError(
    `${command} never runs over the test split — "registry:${ref.name}#test" is the held-out release gate (use a bare ref, #train, or #dev; only the release-gating commands \`crewhaus eval\` / \`crewhaus deploy canary\` consume #test, behind --allow-test-split)`,
  );
}

/**
 * The ids every version of a dataset keeps in its holdout, and the versions that
 * have one. A holdout is cut into a NEW version, so the version it was cut from
 * still lists its cases in train or dev: the union is what keeps them held out
 * across versions. A version whose record cannot be read refuses (its holdout
 * cannot be known).
 */
export async function heldOutIdsOfDataset(
  registry: DatasetRegistry,
  name: string,
): Promise<{ readonly ids: ReadonlySet<string>; readonly versions: readonly string[] }> {
  const ids = new Set<string>();
  const versions: string[] = [];
  for (const version of [...(await registry.list(name))].sort(compareVersions)) {
    let record: DatasetRecord;
    try {
      record = await registry.getRecord(name, version);
    } catch (err) {
      throw new DatasetRefError(
        `"${name}@${version}" cannot be read, so which cases "${name}" holds out cannot be known: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const holdout = record.splits.holdout ?? [];
    if (holdout.length === 0) continue;
    versions.push(version);
    for (const s of holdout) ids.add(s.id);
  }
  return { ids, versions };
}

export type InspectedRegistryRef = {
  readonly record: DatasetRecord;
  readonly version: string;
  /** The explicit `#split`, or EVERY split present — test and holdout
   *  included. Inspection records no use. */
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
  /** Percentage split (default {@link DEFAULT_SPLIT_SPEC}); ignored with `split`.
   *  A `holdout` share cuts the promotion-only split off the test tail. */
  readonly splitSpec?: DatasetSplitSpec;
  /** Put every sample into this single named split instead of splitting. */
  readonly split?: DatasetSplit;
  /** B18 — inject the version's one deterministic contamination-canary
   *  sample (see {@link canarySample}) before split assignment. */
  readonly canary?: boolean;
  /** Warning sink (B22 off-taxonomy provenance notes); defaults to stderr. */
  readonly warn?: (line: string) => void;
};

/** How many offending sample ids a provenance warning spells out. */
const TAXONOMY_WARN_MAX_IDS = 5;

/**
 * Import samples as a new auto-bumped version (v1, v2, …) of `name`, either
 * deterministically split per the spec (test key omitted when the spec gives
 * test 0%) or wholesale into one named split. Returns the persisted record.
 *
 * B22 — declared provenance outside {@link SOURCE_TAXONOMY} warns (never
 * fails: foreign datasets still import; the registry `put` separately
 * enforces the hard synthetic-never-gold invariant). B18 — `canary: true`
 * appends the version's deterministic canary sample before splitting, so it
 * rides the normal id-hash split assignment.
 */
export async function registerDataset(opts: RegisterDatasetOptions): Promise<DatasetRecord> {
  const version = nextVersion(await opts.registry.list(opts.name));
  const samples =
    opts.canary === true ? [...opts.samples, canarySample(opts.name, version)] : opts.samples;
  const warn = opts.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  for (const [source, ids] of offTaxonomySources(samples)) {
    const shown = ids.slice(0, TAXONOMY_WARN_MAX_IDS).join(", ");
    const elided =
      ids.length > TAXONOMY_WARN_MAX_IDS ? ` +${ids.length - TAXONOMY_WARN_MAX_IDS} more` : "";
    warn(
      `[datasets] warning: metadata.source "${source}" is outside the provenance taxonomy (${SOURCE_TAXONOMY.join(" | ")}) — ${ids.length} sample(s): ${shown}${elided}`,
    );
  }
  let splits: { train: Sample[]; dev: Sample[]; test?: Sample[]; holdout?: Sample[] };
  if (opts.split !== undefined) {
    splits = {
      train: opts.split === "train" ? [...samples] : [],
      dev: opts.split === "dev" ? [...samples] : [],
      ...(opts.split === "test" ? { test: [...samples] } : {}),
      ...(opts.split === "holdout" ? { holdout: [...samples] } : {}),
    };
  } else {
    const spec: DatasetSplitSpec = opts.splitSpec ?? DEFAULT_SPLIT_SPEC;
    if ((spec.holdout ?? 0) > 0) {
      const { train, dev, test, holdout } = splitSamplesWithHoldout(samples, spec);
      splits = { train, dev, ...(spec.test > 0 ? { test } : {}), holdout };
    } else {
      const { train, dev, test } = splitSamples(samples, spec);
      splits = { train, dev, ...(spec.test > 0 ? { test } : {}) };
    }
  }
  return opts.registry.put({ name: opts.name, version, splits });
}

// -------- holdout creation (datasets holdout) --------

/** The seed {@link selectHoldout} uses when the caller names none. */
export const DEFAULT_HOLDOUT_SEED = "crewhaus-holdout";

/** The largest share of train+dev a holdout may take. */
export const MAX_HOLDOUT_FRACTION = 0.5;

/**
 * The ids a holdout of `fraction` takes from a record's train and dev
 * splits: train+dev ordered by sha256(seed + "\0" + id), ties on the id,
 * and the first `ceil(fraction·n)` taken. Never the test split. The same ids
 * in any order give the same selection.
 */
export function selectHoldout(
  record: DatasetRecord,
  fraction: number,
  seed: string = DEFAULT_HOLDOUT_SEED,
): string[] {
  const pool = [...record.splits.train, ...record.splits.dev].map((s) => s.id);
  const keyed = pool.map((id) => ({
    id,
    key: createHash("sha256").update(`${seed}\0${id}`).digest("hex"),
  }));
  keyed.sort((a, b) =>
    a.key !== b.key ? (a.key < b.key ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return keyed.slice(0, Math.ceil(fraction * pool.length)).map((k) => k.id);
}

export type CreateHoldoutOptions = {
  readonly registry: DatasetRegistry;
  readonly name: string;
  /** The source version; default the latest. */
  readonly version?: string;
  /** The share of train+dev to move, `0 < fraction ≤ 0.5`. */
  readonly fraction: number;
  readonly seed?: string;
};

export type CreatedHoldout = {
  /** The new version's record. */
  readonly record: DatasetRecord;
  /** The version the holdout was cut from (left untouched). */
  readonly source: string;
  readonly moved: number;
  readonly fromTrain: number;
  readonly fromDev: number;
};

/**
 * Write a NEW version of `name` whose holdout is a seeded selection of the
 * source version's train and dev cases ({@link selectHoldout}); the test
 * split is carried as it is and the source version is untouched (the new
 * version is created exclusively, as every `put` is). Refuses a fraction
 * outside `0 < f ≤ 0.5`, a source that already has a holdout, and a cut that
 * would leave train or dev empty.
 */
export async function createHoldoutVersion(opts: CreateHoldoutOptions): Promise<CreatedHoldout> {
  if (
    !Number.isFinite(opts.fraction) ||
    opts.fraction <= 0 ||
    opts.fraction > MAX_HOLDOUT_FRACTION
  ) {
    throw new DatasetRefError(
      `invalid holdout fraction ${String(opts.fraction)} — must be more than 0 and at most ${MAX_HOLDOUT_FRACTION}`,
    );
  }
  const source = opts.version ?? (await latestVersion(opts.registry, opts.name));
  if (source === undefined) {
    throw new DatasetRefError(
      `dataset "${opts.name}" has no versions in the registry — import one with \`crewhaus datasets put\``,
    );
  }
  const record = await opts.registry.getRecord(opts.name, source);
  if (record.splits.holdout !== undefined) {
    throw new DatasetRefError(
      `"${opts.name}@${source}" already has a holdout (${record.splits.holdout.length} case(s)) — a version carries one holdout`,
    );
  }
  const taken = new Set(selectHoldout(record, opts.fraction, opts.seed ?? DEFAULT_HOLDOUT_SEED));
  const train = record.splits.train.filter((s) => !taken.has(s.id));
  const dev = record.splits.dev.filter((s) => !taken.has(s.id));
  if (train.length === 0 || dev.length === 0) {
    throw new DatasetRefError(
      `a holdout of ${opts.fraction} would leave "${opts.name}@${source}" with an empty ${train.length === 0 ? "train" : "dev"} split — use a smaller --fraction or add cases`,
    );
  }
  // Hash order, so the holdout is the same whatever order the source lists.
  const order = selectHoldout(record, opts.fraction, opts.seed ?? DEFAULT_HOLDOUT_SEED);
  const byId = new Map<string, Sample>();
  for (const s of [...record.splits.train, ...record.splits.dev]) byId.set(s.id, s);
  const holdout = order.map((id) => byId.get(id) as Sample);
  const version = nextVersion(await opts.registry.list(opts.name));
  const written = await opts.registry.put({
    name: opts.name,
    version,
    splits: {
      train,
      dev,
      ...(record.splits.test !== undefined ? { test: [...record.splits.test] } : {}),
      holdout,
    },
  });
  return {
    record: written,
    source,
    moved: holdout.length,
    fromTrain: record.splits.train.length - train.length,
    fromDev: record.splits.dev.length - dev.length,
  };
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
