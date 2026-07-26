/**
 * Section 29 — `dataset-registry`. Wraps §16 `eval-dataset` loaders with
 * versioning + split-aware metadata so prompt-optimizer can train on
 * `train` and evaluate on `dev` without ever leaking into `test`.
 *
 * Layout (file-backed):
 *   <root>/<name>/<version>.json
 *
 * Each dataset file carries:
 *   {
 *     name, version,
 *     splits: { train: Sample[], dev: Sample[], test?: Sample[] },
 *     sampleHashes: { <split>: string[] },
 *     createdAt
 *   }
 *
 * Split-leak guard: `get(name, version, "test")` throws unless the caller
 * passes `{ allowTestSplit: true }`. This is a deliberate friction point —
 * the test split must not be touched until a release tag.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import type { Sample } from "@crewhaus/eval-dataset";

export class DatasetRegistryError extends CrewhausError {
  override readonly name = "DatasetRegistryError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type DatasetSplit = "train" | "dev" | "test";

/**
 * NEW-HUNT-9 — one sanctioned consumption of a version's held-out test split
 * (`crewhaus datasets release`). Appended onto the record AFTER the release
 * eval ran; the entry count is the version's "burn count" — a holdout is only
 * hidden while its peeks are counted.
 */
export type ReleaseEntry = {
  /** The released version (redundant with the record's own — kept so the
   *  entry is self-describing when it travels alone in reports). */
  readonly version: string;
  /** The eval run that consumed `#test` (run-history `runId`). */
  readonly runId: string;
  /** ISO-8601 timestamp of the release eval. */
  readonly ts: string;
  /** The release run's pass rate over the test split. */
  readonly passRate: number;
};

export type DatasetRecord = {
  readonly name: string;
  readonly version: string;
  readonly splits: {
    readonly train: ReadonlyArray<Sample>;
    readonly dev: ReadonlyArray<Sample>;
    readonly test?: ReadonlyArray<Sample>;
  };
  readonly sampleHashes: {
    readonly [K in DatasetSplit]?: ReadonlyArray<string>;
  };
  readonly createdAt: string;
  /**
   * NEW-HUNT-9 — test-split release history (see {@link ReleaseEntry}).
   * Additive: absent on records written before the field existed and on
   * versions whose test split was never released.
   */
  readonly releases?: ReadonlyArray<ReleaseEntry>;
};

export type GetOptions = {
  /** Required when split === "test". */
  readonly allowTestSplit?: boolean;
};

export type PutOptions = {
  /**
   * NEW-registry-1 — versions are immutable by convention: `put` onto an
   * EXISTING version throws unless this is explicitly true. Every CLI
   * promotion path auto-bumps (`nextVersion`), so nothing legitimate
   * overwrites; a library caller that truly means to replace a version says
   * so here.
   */
  readonly allowOverwrite?: boolean;
};

export interface DatasetRegistry {
  put(
    record: Omit<DatasetRecord, "sampleHashes" | "createdAt">,
    opts?: PutOptions,
  ): Promise<DatasetRecord>;
  get(name: string, version: string, split: DatasetSplit, opts?: GetOptions): AsyncIterable<Sample>;
  /** Read the full record (without split-leak guarding — caller already passed an allow flag). */
  getRecord(name: string, version: string): Promise<DatasetRecord>;
  list(name: string): Promise<ReadonlyArray<string>>;
  listDatasets(): Promise<ReadonlyArray<string>>;
}

const NAME_REGEX = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const VERSION_REGEX = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

function ensureSafe(name: string, regex: RegExp, kind: string): void {
  if (!regex.test(name)) {
    throw new DatasetRegistryError(`invalid ${kind} "${name}"`);
  }
}

/**
 * Content hash of a single Sample — the per-sample provenance identity folded
 * into a record's `sampleHashes` (and, via `overallDatasetHash`, the run-index
 * datasetHash). Exported additively so callers that reconcile against stored
 * samples (e.g. the CLI `dataset refresh-goldens`) can line their hashes up
 * with what `put` recorded, instead of re-deriving a divergent sha.
 */
export function hashSample(s: Sample): string {
  return createHash("sha256").update(JSON.stringify(s)).digest("hex").slice(0, 16);
}

/** Canonical split order — every content digest visits splits in this order
 *  so neither caller array order nor record key order can change a hash. */
const SPLIT_ORDER: ReadonlyArray<DatasetSplit> = ["train", "dev", "test"];

/**
 * One stable sha256 over the per-sample content hashes of the selected
 * splits. Split names are folded in as domain separators (train vs dev with
 * identical samples still hash apart) and splits are visited in canonical
 * order, so neither the caller's array order nor record key order can change
 * the digest. Feeds `RunIndexEntry.datasetHash` for registry-backed datasets —
 * the registry analogue of eval-report's `hashDatasetFile`.
 *
 * Lives here (rather than in the CLI, where it was born) because BOTH run
 * launchers need it: `crewhaus eval --dataset registry:<ref>` and the
 * standalone `target: eval` bundle, which resolves its dataset straight out
 * of this registry. One digest function → one dataset identity in the run
 * history, whichever surface launched the run.
 */
export function overallDatasetHash(
  record: DatasetRecord,
  splits: ReadonlyArray<DatasetSplit>,
): string {
  const wanted = new Set(splits);
  const h = createHash("sha256");
  for (const s of SPLIT_ORDER) {
    if (!wanted.has(s) || record.splits[s] === undefined) continue;
    h.update(`${s}:${(record.sampleHashes[s] ?? []).join(",")}\n`);
  }
  return h.digest("hex");
}

/**
 * NEW-registry-1 — one stored-vs-recomputed hash divergence found by
 * {@link verifySplitHashes}. `sampleId`/`actualHash` are absent when the
 * stored hash list is LONGER than the split (a hash with no sample);
 * `storedHash` is absent when the split outgrew the stored list.
 */
export type HashMismatch = {
  readonly split: DatasetSplit;
  /** Position in the split's sample array (or stored hash list). */
  readonly index: number;
  readonly sampleId?: string;
  readonly storedHash?: string;
  readonly actualHash?: string;
};

/**
 * Recompute every present split's per-sample content hashes and compare them
 * against what the record STORED at `put` time. The stored hashes are what
 * `overallDatasetHash` folds into the run-history datasetHash, so a mismatch
 * means the version's eval identity has silently diverged from its content
 * (hand-edited `<version>.json`, corruption) — the strict gate would compare
 * different data under the same lineage. Empty result = the record is intact.
 * Pure and offline; `crewhaus datasets verify` is the CLI face.
 */
export function verifySplitHashes(record: DatasetRecord): HashMismatch[] {
  const mismatches: HashMismatch[] = [];
  for (const split of SPLIT_ORDER) {
    const samples = record.splits[split];
    if (samples === undefined) continue;
    const stored = record.sampleHashes[split] ?? [];
    const n = Math.max(samples.length, stored.length);
    for (let i = 0; i < n; i++) {
      const sample = samples[i];
      const storedHash = stored[i];
      const actualHash = sample === undefined ? undefined : hashSample(sample);
      if (storedHash === actualHash) continue;
      mismatches.push({
        split,
        index: i,
        ...(sample !== undefined ? { sampleId: sample.id } : {}),
        ...(storedHash !== undefined ? { storedHash } : {}),
        ...(actualHash !== undefined ? { actualHash } : {}),
      });
    }
  }
  return mismatches;
}

export type AppendReleaseEntryOptions = {
  /** The file-backed registry root (e.g. `.crewhaus/datasets`). */
  readonly rootDir: string;
  readonly name: string;
  readonly version: string;
  readonly entry: ReleaseEntry;
};

/**
 * NEW-HUNT-9 — append one test-split release entry onto an existing record's
 * `releases` history, in place. Deliberately NOT `put`: the record's samples,
 * hashes, and `createdAt` stay byte-identical (a release consumes the version,
 * it does not re-author it), so the version's content identity — and every
 * run-index entry keyed on it — is untouched. File-backed only, like the
 * layout this package documents; standalone (not an interface method) so the
 * `DatasetRegistry` contract stays additive, mirroring {@link latestVersion}.
 */
export function appendReleaseEntry(opts: AppendReleaseEntryOptions): DatasetRecord {
  ensureSafe(opts.name, NAME_REGEX, "dataset name");
  ensureSafe(opts.version, VERSION_REGEX, "version");
  const path = join(opts.rootDir, opts.name, `${opts.version}.json`);
  if (!existsSync(path)) {
    throw new DatasetRegistryError(`dataset "${opts.name}@${opts.version}" not found at ${path}`);
  }
  const record = JSON.parse(readFileSync(path, "utf8")) as DatasetRecord;
  const updated: DatasetRecord = {
    ...record,
    releases: [...(record.releases ?? []), opts.entry],
  };
  writeFileSync(path, JSON.stringify(updated, null, 2), { mode: 0o600 });
  return updated;
}

export type FileBackedRegistryOptions = {
  /** Default: `.crewhaus/datasets`. */
  readonly rootDir: string;
};

export function createFileBackedRegistry(opts: FileBackedRegistryOptions): DatasetRegistry {
  const rootDir = opts.rootDir;

  function datasetDir(name: string): string {
    ensureSafe(name, NAME_REGEX, "dataset name");
    return join(rootDir, name);
  }
  function recordPath(name: string, version: string): string {
    ensureSafe(version, VERSION_REGEX, "version");
    return join(datasetDir(name), `${version}.json`);
  }

  return {
    async put(record, putOpts: PutOptions = {}): Promise<DatasetRecord> {
      ensureSafe(record.name, NAME_REGEX, "dataset name");
      ensureSafe(record.version, VERSION_REGEX, "version");
      const path = recordPath(record.name, record.version);
      // NEW-registry-1 — versions are immutable by convention. Every CLI
      // promotion path auto-bumps, so an existing file here means a caller
      // is about to silently rewrite history (and orphan every run-index
      // entry keyed on the old content) unless it explicitly opted in.
      if (existsSync(path) && putOpts.allowOverwrite !== true) {
        throw new DatasetRegistryError(
          `version "${record.version}" of dataset "${record.name}" already exists at ${path} — versions are immutable; write a new version (nextVersion) or pass allowOverwrite: true if you truly mean to replace it`,
        );
      }
      // B22 — the synthetic-never-gold invariant, enforced at the registry
      // boundary: a `metadata.source: synthetic` sample carrying an
      // expected_output would let generated data silently become the gold
      // standard. A human-verified gold belongs under
      // `source: synthetic_human_verified`.
      for (const split of SPLIT_ORDER) {
        for (const s of record.splits[split] ?? []) {
          if (s.metadata?.["source"] === "synthetic" && s.expected_output !== undefined) {
            throw new DatasetRegistryError(
              `sample "${s.id}" (${split}) is tagged metadata.source: synthetic but carries expected_output — synthetic samples never define the gold standard; set source to "synthetic_human_verified" if a human verified this gold`,
            );
          }
        }
      }
      const sampleHashes: { [K in DatasetSplit]?: string[] } = {
        train: record.splits.train.map(hashSample),
        dev: record.splits.dev.map(hashSample),
      };
      if (record.splits.test) {
        sampleHashes.test = record.splits.test.map(hashSample);
      }
      const full: DatasetRecord = {
        ...record,
        sampleHashes,
        createdAt: new Date().toISOString(),
      };
      mkdirSync(datasetDir(record.name), { recursive: true });
      writeFileSync(path, JSON.stringify(full, null, 2), {
        mode: 0o600,
      });
      return full;
    },

    async *get(
      name: string,
      version: string,
      split: DatasetSplit,
      getOpts: GetOptions = {},
    ): AsyncIterable<Sample> {
      if (split === "test" && getOpts.allowTestSplit !== true) {
        throw new DatasetRegistryError(
          `test split locked for "${name}@${version}"; pass allowTestSplit: true to override (only do this at release-tag time)`,
        );
      }
      const p = recordPath(name, version);
      if (!existsSync(p)) {
        throw new DatasetRegistryError(`dataset "${name}@${version}" not found at ${p}`);
      }
      const record = JSON.parse(readFileSync(p, "utf8")) as DatasetRecord;
      const samples = record.splits[split];
      if (!samples) {
        throw new DatasetRegistryError(`split "${split}" not present in "${name}@${version}"`);
      }
      for (const s of samples) yield s;
    },

    async getRecord(name, version): Promise<DatasetRecord> {
      const p = recordPath(name, version);
      if (!existsSync(p)) {
        throw new DatasetRegistryError(`dataset "${name}@${version}" not found at ${p}`);
      }
      return JSON.parse(readFileSync(p, "utf8")) as DatasetRecord;
    },

    async list(name): Promise<ReadonlyArray<string>> {
      const dir = datasetDir(name);
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5))
        .sort();
    },

    async listDatasets(): Promise<ReadonlyArray<string>> {
      if (!existsSync(rootDir)) return [];
      return readdirSync(rootDir).filter((d) => !d.startsWith(".") && !d.startsWith("_"));
    },
  };
}

/**
 * Natural-order version comparator: digit runs compare numerically, other
 * runs lexicographically — so `v2 < v10` and `1.0.2 < 1.0.10` (a plain string
 * sort gets both wrong). Digit runs compare by stripped length then digits,
 * never through `Number()`, so arbitrarily long versions can't lose precision.
 */
export function compareVersions(a: string, b: string): number {
  const at = a.match(/\d+|\D+/g) ?? [];
  const bt = b.match(/\d+|\D+/g) ?? [];
  const len = Math.min(at.length, bt.length);
  for (let i = 0; i < len; i++) {
    const x = at[i] as string;
    const y = bt[i] as string;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const xs = x.replace(/^0+(?=\d)/, "");
      const ys = y.replace(/^0+(?=\d)/, "");
      if (xs.length !== ys.length) return xs.length < ys.length ? -1 : 1;
      if (xs !== ys) return xs < ys ? -1 : 1;
    } else if (xNum !== yNum) {
      // A digit run sorts before a non-digit run ("v1" < "vfinal").
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  if (at.length !== bt.length) return at.length < bt.length ? -1 : 1;
  // Equal token streams — fall back to the raw strings (leading zeros).
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The newest version of `name` under {@link compareVersions} ordering, or
 * undefined when the dataset has no versions. Standalone (registry passed in)
 * rather than an interface method so it stays additive — it works with any
 * `DatasetRegistry` implementation, present or future.
 */
export async function latestVersion(
  registry: DatasetRegistry,
  name: string,
): Promise<string | undefined> {
  const versions = await registry.list(name);
  if (versions.length === 0) return undefined;
  return [...versions].sort(compareVersions)[versions.length - 1];
}
