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
