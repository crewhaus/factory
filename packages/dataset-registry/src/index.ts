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
};

export type GetOptions = {
  /** Required when split === "test". */
  readonly allowTestSplit?: boolean;
};

export interface DatasetRegistry {
  put(record: Omit<DatasetRecord, "sampleHashes" | "createdAt">): Promise<DatasetRecord>;
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

function hashSample(s: Sample): string {
  return createHash("sha256").update(JSON.stringify(s)).digest("hex").slice(0, 16);
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
    async put(record): Promise<DatasetRecord> {
      ensureSafe(record.name, NAME_REGEX, "dataset name");
      ensureSafe(record.version, VERSION_REGEX, "version");
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
      writeFileSync(recordPath(record.name, record.version), JSON.stringify(full, null, 2), {
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
