/**
 * Getting at the dataset registry without owning any of it.
 *
 * Everything here is plumbing around `@crewhaus/dataset-registry`'s own
 * file-backed implementation: where the root is, which versions exist, and
 * turning the three ways a record read can fail into a `Loaded` the caller
 * has to branch on. The record LAYOUT, the name grammar, the version
 * ordering, the per-sample hashes and the immutability rule all stay where
 * they are — this package would drift the first time one of them changed.
 *
 * Two decisions worth stating:
 *
 *   - THE NAME GRAMMAR IS NOT COPIED HERE. `createFileBackedRegistry` refuses
 *     a name its grammar rejects, so {@link listVersions} asks the registry
 *     (via a `list`, which validates the name before touching the disk)
 *     rather than re-deriving `^[A-Za-z0-9_-][A-Za-z0-9_.-]*$` in a second
 *     place that can fall out of step.
 *   - THE ROOT IS CONTAINED, INCLUDING THE ONE FROM THE ENVIRONMENT.
 *     `defaultDatasetsRoot()` reads `CREWHAUS_DATASETS_DIR`, so an exported
 *     variable can point a tool at a registry outside the workspace. It goes
 *     through the same `resolveSafe` gate as a caller-supplied path, and
 *     every result says which of the three sources the root came from — a
 *     tool that reads a different registry than the operator thinks it does
 *     is a tool that reports the wrong dataset as clean.
 */
import { existsSync, statSync } from "node:fs";
import { defaultDatasetsRoot } from "@crewhaus/dataset-ops";
import {
  type DatasetRecord,
  type DatasetRegistry,
  DatasetRegistryError,
  type DatasetSplit,
  compareVersions,
  createFileBackedRegistry,
} from "@crewhaus/dataset-registry";
import { type SafePath, ToolPermissionError, resolveSafe } from "../paths";
import { type Loaded, errorMessage, fail, renderGiven } from "./result";

/** Where the root came from, so a result can say so. */
export type RootSource = "input" | "env" | "default";

export type RegistryRoot = {
  readonly safe: SafePath;
  /** Workspace-relative, `/`-separated — what a result echoes. */
  readonly rel: string;
  readonly source: RootSource;
  /** False is an ANSWER for a reader ("no registry here yet") and a refusal
   *  for a writer, which is why it is reported rather than thrown. */
  readonly exists: boolean;
};

/** The registry root convention, shared with the emitted eval-bundle harness. */
export const DEFAULT_REGISTRY_REL = ".crewhaus/datasets";

/**
 * Resolve the registry root: the caller's `registryDir`, else
 * `CREWHAUS_DATASETS_DIR`, else `.crewhaus/datasets`. Contained in every
 * case. The environment variable is read through `defaultDatasetsRoot()` so
 * this package and the CLI cannot disagree about what the default is.
 */
export function resolveRegistryRoot(toolName: string, given?: string): Loaded<RegistryRoot> {
  const envRoot = defaultDatasetsRoot();
  const source: RootSource =
    given !== undefined
      ? "input"
      : process.env["CREWHAUS_DATASETS_DIR"] !== undefined
        ? "env"
        : "default";
  const target = given ?? envRoot;
  let safe: SafePath;
  try {
    safe = resolveSafe(toolName, target);
  } catch (err) {
    if (err instanceof ToolPermissionError) {
      return fail(
        "refused",
        source === "env"
          ? `CREWHAUS_DATASETS_DIR points at "${renderGiven(target)}", which resolves outside the workspace — this tool will not read or write a registry there`
          : err.message,
      );
    }
    throw err;
  }
  let exists = false;
  if (existsSync(safe.real)) {
    let isDir: boolean;
    try {
      isDir = statSync(safe.real).isDirectory();
    } catch {
      return fail("unreadable", `"${renderGiven(safe.rel)}" exists but could not be inspected`);
    }
    if (!isDir) {
      return fail("bad-input", `"${renderGiven(safe.rel)}" is not a directory`);
    }
    exists = true;
  }
  return { ok: true, value: { safe, rel: safe.rel === "" ? "." : safe.rel, source, exists } };
}

/** The registry implementation, pointed at a root that already passed the gate. */
export function openRegistry(root: RegistryRoot): DatasetRegistry {
  return createFileBackedRegistry({ rootDir: root.safe.real });
}

/**
 * Every version of `name`, oldest first under the registry's own natural-order
 * comparator (so `v2` sorts before `v10`). An invalid name comes back as a
 * refusal carrying the registry's own complaint, because the registry owns
 * that grammar.
 */
export async function listVersions(
  registry: DatasetRegistry,
  name: string,
): Promise<Loaded<string[]>> {
  try {
    const versions = await registry.list(name);
    return { ok: true, value: [...versions].sort(compareVersions) };
  } catch (err) {
    // `list` does two things that throw: the registry's name grammar, and a
    // readdir. Reporting an EACCES or an ENOTDIR as "your name was rejected"
    // sends an operator to fix a name that is fine — the two failures are
    // told apart by the registry's own error CLASS, never by matching text.
    if (err instanceof DatasetRegistryError) {
      return fail(
        "bad-input",
        `dataset name "${renderGiven(name)}" was rejected: ${errorMessage(err)}`,
      );
    }
    return fail(
      "unreadable",
      `the versions of "${renderGiven(name)}" could not be listed: ${errorMessage(err)}`,
    );
  }
}

/** Every dataset name under the root, sorted. */
export async function listDatasets(registry: DatasetRegistry): Promise<Loaded<string[]>> {
  try {
    const names = await registry.listDatasets();
    return { ok: true, value: [...names].sort() };
  } catch (err) {
    return fail("unreadable", `the registry root could not be listed: ${errorMessage(err)}`);
  }
}

/**
 * One version's record. A record that is absent, unreadable or not JSON are
 * three different answers and stay three different answers: an inspect that
 * reports a torn `v3.json` as "no such version" sends an operator looking for
 * a write that actually happened.
 */
export async function readRecord(
  registry: DatasetRegistry,
  name: string,
  version: string,
): Promise<Loaded<DatasetRecord>> {
  try {
    return { ok: true, value: await registry.getRecord(name, version) };
  } catch (err) {
    const message = errorMessage(err);
    if (/not found/i.test(message)) {
      return fail(
        "missing",
        `dataset "${renderGiven(name)}@${renderGiven(version)}" is not in this registry`,
      );
    }
    // `getRecord` JSON.parses the file, so a torn or hand-edited record
    // arrives here as a SyntaxError — which is not the same thing as absence.
    if (err instanceof SyntaxError) {
      return fail(
        "malformed",
        `record for "${renderGiven(name)}@${renderGiven(version)}" is on disk but is not valid JSON: ${message}`,
      );
    }
    return fail(
      "unreadable",
      `record for "${renderGiven(name)}@${renderGiven(version)}" could not be read: ${message}`,
    );
  }
}

/** The splits a record actually carries, in canonical order, tolerating a
 *  record whose `splits` key is absent entirely (hand-written, pre-registry).
 *  `splitsPresent` from dataset-ops assumes the key is there. */
export function presentSplits(record: DatasetRecord): DatasetSplit[] {
  const splits = record.splits ?? {};
  return (["train", "dev", "test"] as const).filter((s) => splits[s] !== undefined);
}

/** A record's samples for one split, or `[]` when the split is absent. */
export function splitSamplesOf(record: DatasetRecord, split: DatasetSplit) {
  return record.splits?.[split] ?? [];
}

/** Every sample in the record, canonical split order. Used by the readers,
 *  which must see the whole record — a hygiene gate over a partial dataset
 *  misreports (PII in the holdout is still a leak). */
export function allSamplesOf(record: DatasetRecord) {
  return presentSplits(record).flatMap((s) => [...splitSamplesOf(record, s)]);
}

/** id → the split it currently sits in. The ground truth a stable re-put
 *  carries forward: what actually happened last time, not what a hash says
 *  should have happened. */
export function assignmentOf(record: DatasetRecord): Map<string, DatasetSplit> {
  const out = new Map<string, DatasetSplit>();
  for (const split of presentSplits(record)) {
    for (const s of splitSamplesOf(record, split)) out.set(s.id, split);
  }
  return out;
}
