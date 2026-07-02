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
 * eval-report's `loadRun` on caller-supplied run dirs. The failure-arbiter
 * wiring (item 7, `triage.ts`) is the other consumer of
 * {@link pinRecoveredSamples}: post-eval triage promotes the samples whose
 * `ArbiterAction.promoteRegression` flag is set (bug-class failures,
 * eval-optimizer-orchestrator/src/failure-arbiter.ts) with
 * `source: "failure-arbiter"` provenance.
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
 * pin and the union become no-ops instead of surfacing a registry error
 * (with a one-line warning per invocation, so the no-op is never silent).
 */
const REGISTRY_NAME_REGEX = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

export function isRegistrySafeName(name: string): boolean {
  return REGISTRY_NAME_REGEX.test(name);
}

/** Default warning sink for the registry-unsafe-name no-ops. */
const warnToStderr = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/** The one-line "this degraded to a no-op" warning for a spec whose name
 *  can't map to the registry grammar (see {@link isRegistrySafeName}). */
function unsafeNameWarning(what: string, specName: string, suiteName: string): string {
  return (
    `[eval] ${what} skipped: spec name "${specName}" can't form a registry dataset name ` +
    `("${suiteName}") — rename the spec to match ${REGISTRY_NAME_REGEX} to enable the regression suite`
  );
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
  /** The run that produced the pin (the optimize runId on the post-accept
   *  path; the eval runId on the failure-arbiter path). */
  readonly optimizeRunId: string;
  /** Provenance tag naming WHAT produced the pin (e.g. "failure-arbiter").
   *  Recorded as `metadata.regression_pin.source` when present; absent on
   *  the optimize post-accept path (byte-identical to the pre-item-7 pin). */
  readonly source?: string;
  /** Warning sink for the registry-unsafe-name no-op; defaults to stderr. */
  readonly warn?: (line: string) => void;
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
  if (opts.samples.length === 0) return { suiteName, pinned: 0 };
  if (!isRegistrySafeName(suiteName)) {
    // There WERE samples to pin — surface the degradation instead of
    // silently dropping them (one warning per invocation).
    (opts.warn ?? warnToStderr)(unsafeNameWarning("regression pin", opts.specName, suiteName));
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
          ...(opts.source !== undefined ? { source: opts.source } : {}),
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
  /** `<primaryName>+regressions@vX` when the union ADDED samples; the
   *  untouched primary name when it added none (keyset unchanged → the
   *  run-index/baseline lineage must stay comparable, see below). */
  readonly datasetName: string;
  /** Primary hash with the suite's content hash folded in when the union
   *  added samples; the untouched primary hash otherwise. */
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
  /** Warning sink for the registry-unsafe-name no-op; defaults to stderr. */
  readonly warn?: (line: string) => void;
};

/**
 * Union the per-spec regression suite into an eval's dataset (dedupe by
 * sample id; the primary dataset wins on collision). Returns undefined when
 * disabled, when no suite exists, or when the primary IS the suite (a
 * `registry:` ref to it, or a file whose basename matches it — an exported
 * copy must not union the suite into itself).
 *
 * Item-3 interaction, by design: a union that ADDS samples changes the
 * run's sample keyset, so the returned `datasetName` is suffixed
 * `+regressions@vX` and the returned `datasetHash` folds the suite's
 * content hash into the primary's. Run-index entries and (spec, dataset)
 * baselines then key on the honest union lineage — the first ADDING union
 * starts a new baseline lineage instead of tripping diffReports'
 * keyset-mismatch guard against the pre-union baseline. A union that adds
 * NOTHING (every suite sample already in the primary) keeps the primary
 * identity untouched: the keyset didn't change, so rewriting the key would
 * orphan the existing baseline and silently disarm the gate.
 */
export async function applyRegressionUnion(
  opts: ApplyRegressionUnionOptions,
): Promise<RegressionUnionResult | undefined> {
  if (!opts.includeRegressions) return undefined;
  const suiteName = regressionSuiteName(opts.specName);
  if (!isRegistrySafeName(suiteName)) {
    (opts.warn ?? warnToStderr)(
      unsafeNameWarning("regression suite union", opts.specName, suiteName),
    );
    return undefined;
  }
  if (opts.primaryRegistryName === suiteName) return undefined;
  // File-dataset self-union guard: a file literally named after the suite
  // (`<specName>-regressions.jsonl` — loadDataset names it by basename) is
  // treated as an export of the suite, same as the registry ref above.
  if (opts.datasetName === suiteName || opts.datasetName.replace(/\.[^.]+$/, "") === suiteName) {
    return undefined;
  }

  const suiteVersion = await latestVersion(opts.registry, suiteName);
  if (suiteVersion === undefined) return undefined;
  const record = await opts.registry.getRecord(suiteName, suiteVersion);
  // Validate the record shape BEFORE materializing the primary stream — a
  // corrupt suite record must fail here, while the caller's fallback can
  // still hand the untouched primary stream to the runner.
  if (!Array.isArray(record?.splits?.train)) {
    throw new Error(
      `regression suite ${suiteName}@${suiteVersion} is corrupt (missing splits.train) — re-pin it or delete the record`,
    );
  }

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
  if (added === 0) {
    // Keyset unchanged — keep the primary identity so the lineage stays
    // comparable (see the doc comment above).
    return {
      samples,
      datasetName: opts.datasetName,
      datasetHash: opts.datasetHash,
      added,
      suiteName,
      suiteVersion,
    };
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

// -------- guarded union (stream-loss-proof wrapper) --------

export type GuardedUnionOutcome = {
  /** Dataset identity to record: the union's when one was applied, the
   *  untouched primary's otherwise. */
  readonly datasetName: string;
  readonly datasetHash: string;
  /** Samples to run. Always safe to iterate: when the union attempt threw
   *  AFTER consuming the primary stream, this is the materialized primary
   *  array — never an exhausted iterable. */
  readonly samples: AsyncIterable<Sample>;
  /** Present when a union was applied (its `added` may be 0). */
  readonly union?: RegressionUnionResult;
};

/**
 * `applyRegressionUnion` with the failure semantics `crewhaus eval` needs:
 * best-effort (a broken suite record warns and falls back to the primary
 * dataset) AND stream-loss-proof. The primary samples are captured as they
 * are materialized for the union attempt, so a throw AFTER the one-shot
 * primary stream was consumed (e.g. a suite record that passes the shape
 * check but breaks the hash fold) falls back to the captured array instead
 * of handing the runner an exhausted iterable — which would silently run a
 * 0-sample eval.
 */
export async function applyRegressionUnionGuarded(opts: {
  readonly registry: DatasetRegistry;
  readonly specName: string;
  readonly includeRegressions: boolean;
  readonly primaryRegistryName?: string;
  readonly primary: { readonly name: string; readonly samples: AsyncIterable<Sample> };
  readonly datasetHash: string;
  /** Warning sink; defaults to stderr. */
  readonly warn?: (line: string) => void;
}): Promise<GuardedUnionOutcome> {
  const warn = opts.warn ?? warnToStderr;
  let materialized: Sample[] | undefined;
  try {
    const union = await applyRegressionUnion({
      registry: opts.registry,
      specName: opts.specName,
      includeRegressions: opts.includeRegressions,
      ...(opts.primaryRegistryName !== undefined
        ? { primaryRegistryName: opts.primaryRegistryName }
        : {}),
      loadPrimarySamples: async () => {
        materialized = [];
        for await (const s of opts.primary.samples) materialized.push(s);
        return materialized;
      },
      datasetName: opts.primary.name,
      datasetHash: opts.datasetHash,
      warn,
    });
    if (union !== undefined) {
      return {
        datasetName: union.datasetName,
        datasetHash: union.datasetHash,
        samples: reiterable(union.samples),
        union,
      };
    }
  } catch (err) {
    warn(
      `[eval] regression suite union skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return {
    datasetName: opts.primary.name,
    datasetHash: opts.datasetHash,
    samples: materialized !== undefined ? reiterable(materialized) : opts.primary.samples,
  };
}

/** Re-iterable view over an already-materialized sample array. */
function reiterable(samples: ReadonlyArray<Sample>): AsyncIterable<Sample> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const s of samples) yield s;
    },
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
