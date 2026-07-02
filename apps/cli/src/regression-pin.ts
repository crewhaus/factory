/**
 * Item 9 — pin every recovered failure into a permanent regression suite.
 *
 * When an optimize run is accepted, the samples that flipped fail→pass
 * between the baseline eval run and the winning candidate's eval run are
 * exactly the behaviors the accepted patch fixed. If the training dataset
 * later churns, those regressions can silently return — so we pin them
 * into a per-spec `<specName>-regressions` dataset in the Section 29
 * registry (single `train` split; each pin unions the previous latest
 * version's samples with the new recoveries, deduped by sample id), and
 * `crewhaus eval` unions that suite into the loaded dataset by default.
 *
 * Kept in a side-effect-free module (the CLI entry file runs an argv
 * switch on import) mirroring `eval-history.ts` / `datasets.ts`: all
 * filesystem access goes through an injected `DatasetRegistry` or through
 * eval-report's `loadRun` on caller-supplied run dirs. NOTE for the
 * upcoming failure-arbiter feature: its `ArbiterAction.promoteRegression`
 * flag (eval-optimizer-orchestrator/src/failure-arbiter.ts) is the other
 * intended consumer of {@link pinRecoveredSamples} — call it with the
 * arbiter's promoted samples instead of re-implementing the union.
 */
import { createHash } from "node:crypto";
import { type DatasetRegistry, latestVersion } from "@crewhaus/dataset-registry";
import type { Sample } from "@crewhaus/eval-dataset";
import { diffReports, loadRun } from "@crewhaus/eval-report";
import { nextVersion, overallDatasetHash } from "./datasets";

/** The per-spec regression suite's registry name. */
export function regressionSuiteName(specName: string): string {
  return `${specName}-regressions`;
}

/**
 * dataset-registry's name grammar (spec `safeName` additionally allows
 * spaces/colons, which the registry rejects). A spec whose name can't form
 * a valid registry dataset name simply has no regression suite — both the
 * pin and the union become no-ops instead of surfacing a registry error.
 */
const REGISTRY_NAME_REGEX = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

export function isRegistrySafeName(name: string): boolean {
  return REGISTRY_NAME_REGEX.test(name);
}

// -------- pinning (optimize post-accept / future failure-arbiter) --------

export type PinRegressionsResult = {
  readonly suiteName: string;
  /** Newly pinned samples (0 → nothing was written). */
  readonly pinned: number;
  /** The new registry version; present only when `pinned > 0`. */
  readonly version?: string;
};

export type PinRecoveredSamplesOptions = {
  readonly registry: DatasetRegistry;
  readonly specName: string;
  /** The recovered (fail→pass) samples to pin. */
  readonly samples: ReadonlyArray<Sample>;
  /** Name of the dataset the samples came from (provenance). */
  readonly sourceDataset: string;
  /** The optimize run that recovered them (provenance). */
  readonly optimizeRunId: string;
  /** Clock override for deterministic tests. */
  readonly now?: () => Date;
};

/**
 * Append recovered samples to the per-spec regression suite as a new
 * auto-bumped version: union of the previous latest version's samples and
 * the new ones, deduped by sample id (existing pins win, so re-pinning the
 * same recovery is idempotent and keeps its original provenance). All
 * samples live in the `train` split — the suite is a single-split dataset.
 * Provenance (optimize runId, pin date, source dataset) is recorded in each
 * newly pinned sample's `metadata.regression_pin` (SampleSchema carries an
 * open `metadata` record). No new samples → no-op: no version is written.
 */
export async function pinRecoveredSamples(
  opts: PinRecoveredSamplesOptions,
): Promise<PinRegressionsResult> {
  const suiteName = regressionSuiteName(opts.specName);
  if (opts.samples.length === 0 || !isRegistrySafeName(suiteName)) {
    return { suiteName, pinned: 0 };
  }

  const prevVersion = await latestVersion(opts.registry, suiteName);
  const prevTrain =
    prevVersion !== undefined
      ? (await opts.registry.getRecord(suiteName, prevVersion)).splits.train
      : [];
  const byId = new Map<string, Sample>(prevTrain.map((s) => [s.id, s]));

  const pinnedAt = (opts.now?.() ?? new Date()).toISOString();
  let pinned = 0;
  for (const s of opts.samples) {
    if (byId.has(s.id)) continue;
    byId.set(s.id, {
      ...s,
      metadata: {
        ...(s.metadata ?? {}),
        regression_pin: {
          optimizeRunId: opts.optimizeRunId,
          pinnedAt,
          sourceDataset: opts.sourceDataset,
        },
      },
    });
    pinned += 1;
  }
  if (pinned === 0) return { suiteName, pinned: 0 };

  const version = nextVersion(await opts.registry.list(suiteName));
  await opts.registry.put({
    name: suiteName,
    version,
    splits: { train: [...byId.values()], dev: [] },
  });
  return { suiteName, pinned, version };
}

export type PinRecoveriesAfterOptimizeOptions = {
  readonly registry: DatasetRegistry;
  readonly specName: string;
  /** `!--no-pin-regressions` — false → skip entirely (returns undefined). */
  readonly pin: boolean;
  /** Baseline (candidate-0) eval-run dir; undefined → nothing to diff. */
  readonly baselineRunDir?: string;
  /** Winning candidate's eval-run dir; undefined → nothing to diff. */
  readonly candidateRunDir?: string;
  /** The dev-set samples by id — recovered sampleIds are looked up here. */
  readonly samplesById: ReadonlyMap<string, Sample>;
  readonly sourceDataset: string;
  readonly optimizeRunId: string;
  readonly now?: () => Date;
};

/**
 * The optimize success path: diff the baseline eval run against the winning
 * candidate's, extract `recoveries` (fail→pass sampleIds), look those up in
 * the dataset that was used, and pin them via {@link pinRecoveredSamples}.
 * Returns undefined when pinning is disabled or either run dir is missing
 * (e.g. a fitness fn that doesn't report `runDir`).
 */
export async function pinRecoveriesAfterOptimize(
  opts: PinRecoveriesAfterOptimizeOptions,
): Promise<PinRegressionsResult | undefined> {
  if (!opts.pin) return undefined;
  if (opts.baselineRunDir === undefined || opts.candidateRunDir === undefined) return undefined;

  const prev = await loadRun(opts.baselineRunDir);
  const next = await loadRun(opts.candidateRunDir);
  const { diff } = diffReports(prev, next);

  const recovered: Sample[] = [];
  for (const r of diff.recoveries) {
    const s = opts.samplesById.get(r.sampleId);
    if (s !== undefined) recovered.push(s);
  }
  return pinRecoveredSamples({
    registry: opts.registry,
    specName: opts.specName,
    samples: recovered,
    sourceDataset: opts.sourceDataset,
    optimizeRunId: opts.optimizeRunId,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
}

// -------- eval-side union --------

export type RegressionUnionResult = {
  /** Primary samples first, then suite additions (dedupe: primary wins). */
  readonly samples: Sample[];
  /** `<primaryName>+regressions@vX` — the honest run-index/baseline key. */
  readonly datasetName: string;
  /** Primary hash with the suite's content hash folded in (see below). */
  readonly datasetHash: string;
  /** Suite samples actually added (collisions with the primary excluded). */
  readonly added: number;
  readonly suiteName: string;
  readonly suiteVersion: string;
};

export type ApplyRegressionUnionOptions = {
  readonly registry: DatasetRegistry;
  readonly specName: string;
  /** `!--no-regressions` — false → no union (returns undefined). */
  readonly includeRegressions: boolean;
  /**
   * Registry name of the primary dataset when it came from a `registry:`
   * ref. Evaling the regression suite itself must not union it into
   * itself (and must not suffix its own name), so that case is skipped.
   */
  readonly primaryRegistryName?: string;
  /** Lazy primary samples — only materialized once a suite is found, so
   *  the streaming file-dataset path stays streaming when there is none. */
  readonly loadPrimarySamples: () => Promise<ReadonlyArray<Sample>>;
  readonly datasetName: string;
  readonly datasetHash: string;
};

/**
 * Union the per-spec regression suite into an eval's dataset (dedupe by
 * sample id; the primary dataset wins on collision). Returns undefined when
 * disabled, when no suite exists, or when the primary IS the suite.
 *
 * Item-3 interaction, by design: the union changes the run's sample keyset,
 * so the returned `datasetName` is suffixed `+regressions@vX` and the
 * returned `datasetHash` folds the suite's content hash into the primary's.
 * Run-index entries and (spec, dataset) baselines then key on the honest
 * union lineage — the first unioned run (and the first run after the suite
 * gains a version) starts a new baseline lineage instead of tripping
 * diffReports' keyset-mismatch guard against the pre-union baseline.
 */
export async function applyRegressionUnion(
  opts: ApplyRegressionUnionOptions,
): Promise<RegressionUnionResult | undefined> {
  if (!opts.includeRegressions) return undefined;
  const suiteName = regressionSuiteName(opts.specName);
  if (!isRegistrySafeName(suiteName)) return undefined;
  if (opts.primaryRegistryName === suiteName) return undefined;

  const suiteVersion = await latestVersion(opts.registry, suiteName);
  if (suiteVersion === undefined) return undefined;
  const record = await opts.registry.getRecord(suiteName, suiteVersion);

  const primary = await opts.loadPrimarySamples();
  const seen = new Set(primary.map((s) => s.id));
  const samples = [...primary];
  let added = 0;
  for (const s of record.splits.train) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    samples.push(s);
    added += 1;
  }
  return {
    samples,
    datasetName: `${opts.datasetName}+regressions@${suiteVersion}`,
    datasetHash: foldDatasetHash(opts.datasetHash, overallDatasetHash(record, ["train"])),
    added,
    suiteName,
    suiteVersion,
  };
}

/**
 * One stable sha256 folding the regression suite's content hash into the
 * primary dataset's, with domain separators (mirrors `overallDatasetHash`'s
 * style). Keeps RunIndexEntry.datasetHash honest for unioned runs: it
 * changes when EITHER the primary bytes or the suite content change.
 */
export function foldDatasetHash(primaryHash: string, suiteHash: string): string {
  return createHash("sha256")
    .update(`primary:${primaryHash}\n`)
    .update(`regressions:${suiteHash}\n`)
    .digest("hex");
}
