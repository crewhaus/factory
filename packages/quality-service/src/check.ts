/**
 * The check a change goes through before anyone may adopt it, and the promotion check
 * at its heart.
 *
 * `promotionCheck(base, candidate)` is pure. Runs that cannot be compared (the candidate
 * measured nothing or stopped at its budget, or the instrument changed) answer
 * `not_comparable` with the rule. Otherwise it is the strict run-history gate
 * (`gateRuns`, threshold 0), and every case the base measured fails with its id when
 * the candidate did not measure it, abstained on it, or left it out of its samples.
 *
 * `checkChange` runs a change's check, dependency-inverted: the eval and the regrade are
 * injected (`CheckRunners`), so this package imports no CLI. By kind:
 *   - spec: a fresh base run and a candidate run on the same cases, isolated: tool
 *     results replay from the lineage's recorded run when it recorded them; a harness
 *     with a tool that writes outside the process and no recording needs a live check
 *     a maintainer confirmed. Then, when the dataset version has a holdout, the base
 *     and the candidate each run on it (one counted use each, purpose `promotion`); a
 *     base holdout run an earlier change made is reused when the base revision, the
 *     holdout version and the instrument all match, with no new use.
 *   - graders: the lineage's recorded answers regraded with the base graders and with
 *     the candidate graders; no agent call.
 *   - dataset: only the added cases run, on the base spec.
 * Check runs live under the change's own `runs/` directory, are never written to the
 * run history and never pinned.
 */
import { join, relative } from "node:path";
import {
  type ResolvedRegistryRef,
  parseRegistryRef,
  resolveRegistryRef,
} from "@crewhaus/dataset-ops/datasets";
import { createFileBackedRegistry } from "@crewhaus/dataset-registry";
import type { Sample } from "@crewhaus/eval-dataset";
import { gradersConfigHash, parseGradersConfig } from "@crewhaus/eval-grader";
import { gateRuns } from "@crewhaus/eval-ops/eval-history";
import {
  type MeasuredOptions,
  computeDiffSignificance,
  instrumentChanges,
  instrumentOf,
  measuredInBaseline,
  unmeasurableRun,
} from "@crewhaus/eval-report";
import {
  type EvalRunSummary,
  sampleAbstained,
  sampleWithoutVerdict as withoutVerdict,
} from "@crewhaus/eval-runner";
import { openForReadSync } from "@crewhaus/tool-safety/fs";
import {
  type ChangePatch,
  evidenceDigestOf,
  fileRevision,
  readHarnessText,
  textRevision,
  underRuns,
  verifiedEvidence,
  verifyContent,
} from "./content";
import { openAdoptionDecision } from "./decision";
import { BINDING_DIGEST_LABEL } from "./digests";
import {
  type ChangeRow,
  type ChangeVerdict,
  addChangeContent,
  moveChange,
  readChange,
  readChanges,
} from "./store";

export {
  type ChangePatch,
  fileRevision,
  textRevision,
} from "./content";

// ---------------------------------------------------------------------------
// the promotion check (pure)
// ---------------------------------------------------------------------------

export type PromotionCheck = {
  readonly comparison: "pass" | "fail" | "not_comparable";
  /** Why the runs could not be compared, or why the candidate failed. */
  readonly rule?: string;
  readonly reason?: string;
  readonly shared: number;
  readonly added: ReadonlyArray<string>;
  /** Cases both runs hold that the base measured and the candidate did not (not
   *  measured, skipped, only observed, or abstained). */
  readonly lost: ReadonlyArray<string>;
  /** Cases the base measured that the candidate's samples leave out. */
  readonly absent: ReadonlyArray<string>;
  readonly regressions: ReadonlyArray<string>;
  readonly recoveries: ReadonlyArray<string>;
};

export type PromotionCheckOptions = {
  readonly measured?: MeasuredOptions;
  /**
   * A graders change changes the instrument on purpose: its two runs are compared
   * case by case, and only measurement it loses fails it.
   */
  readonly instrumentChange?: "expected";
};

/** A case left without a verdict: not measured, skipped, only observed, or abstained. */
function sampleWithoutVerdict(s: EvalRunSummary["samples"][number]): boolean {
  return withoutVerdict(s) || sampleAbstained(s);
}

/** The promotion check of a candidate run against its base run. Pure. */
export function promotionCheck(
  base: EvalRunSummary,
  candidate: EvalRunSummary,
  opts: PromotionCheckOptions = {},
): PromotionCheck {
  const measured = opts.measured ?? {};
  const candidateIds = new Set(candidate.samples.map((s) => s.sampleId));
  const baseIds = new Set(base.samples.map((s) => s.sampleId));
  const shared = candidate.samples.filter((s) => baseIds.has(s.sampleId)).length;
  const added = candidate.samples.map((s) => s.sampleId).filter((id) => !baseIds.has(id));
  const empty = { shared, added, lost: [], absent: [], regressions: [], recoveries: [] };
  const unmeasurable = unmeasurableRun(candidate);
  if (unmeasurable !== undefined) {
    return {
      comparison: "not_comparable",
      rule: unmeasurable.rule,
      reason: unmeasurable.reason,
      ...empty,
    };
  }
  if (opts.instrumentChange !== "expected") {
    const changed = instrumentChanges(instrumentOf(base), instrumentOf(candidate)).filter(
      (c) => c.unverified !== true,
    );
    if (changed.length > 0) {
      return {
        comparison: "not_comparable",
        rule: "instrument",
        reason: `the measuring instrument changed (${changed.map((c) => c.field).join(", ")})`,
        ...empty,
      };
    }
  }
  // A case the base measured that the candidate left out fails too.
  const absent = base.samples
    .filter((s) => !candidateIds.has(s.sampleId) && measuredInBaseline(s, measured))
    .map((s) => s.sampleId);
  const verdict = gateRuns(base, candidate, {}, measured);
  const regressions = verdict.report.regressions.map((r) => r.sampleId);
  const recoveries = verdict.report.recoveries.map((r) => r.sampleId);
  const baseById = new Map(base.samples.map((s) => [s.sampleId, s]));
  const lost = candidate.samples
    .filter((now) => {
      const before = baseById.get(now.sampleId);
      return (
        before !== undefined && sampleWithoutVerdict(now) && measuredInBaseline(before, measured)
      );
    })
    .map((s) => s.sampleId);
  const reasons: string[] = [];
  // Graded differently on purpose, a graders change's flips are the change; its
  // lost measurement is not. Any other change answers to the strict gate too.
  if (opts.instrumentChange !== "expected" && verdict.verdict === "fail") {
    reasons.push(verdict.reason ?? "the strict gate failed");
  }
  if (lost.length > 0) {
    reasons.push(`cases the base measured were not measured: ${lost.join(", ")}`);
  }
  if (absent.length > 0) {
    reasons.push(`cases the base measured are absent from the candidate: ${absent.join(", ")}`);
  }
  return {
    comparison: reasons.length === 0 ? "pass" : "fail",
    ...(reasons.length > 0 ? { rule: "gate", reason: reasons.join("; ") } : {}),
    shared,
    added,
    lost,
    absent,
    regressions,
    recoveries,
  };
}

// ---------------------------------------------------------------------------
// the check
// ---------------------------------------------------------------------------

/** One eval run a check asks for. */
export type EvalSpecArgs = {
  readonly label: string;
  readonly specYaml: string;
  readonly gradersYaml: string;
  readonly samples: ReadonlyArray<Sample>;
  readonly datasetName: string;
  readonly datasetHash: string;
  readonly outDir: string;
  readonly replayToolsDir?: string;
};

/** One regrade of recorded answers a check asks for. */
export type RegradeArgs = {
  readonly label: string;
  readonly sourceDir: string;
  readonly specYaml: string;
  readonly gradersYaml: string;
  readonly samples: ReadonlyArray<Sample>;
  readonly datasetName: string;
  readonly datasetHash: string;
  readonly outDir: string;
};

/** The recorded run of a lineage: its summary and where it lives. */
export type RecordedRun = { readonly summary: EvalRunSummary; readonly dir: string };

export type CheckRunners = {
  readonly evalSpec: (args: EvalSpecArgs) => Promise<EvalRunSummary>;
  readonly regrade: (args: RegradeArgs) => Promise<EvalRunSummary>;
  /** A file dataset's samples and content hash (a `registry:` ref is resolved here). */
  readonly loadFileDataset: (
    absPath: string,
  ) => Promise<{ name: string; samples: Sample[]; datasetHash: string }>;
  /** The lineage's pinned run for this dataset, when there is one. */
  readonly recordedRun?: (datasetName: string) => RecordedRun | undefined;
  /** Load a run directory an earlier check wrote (a cached base holdout run). */
  readonly loadRun?: (dir: string) => Promise<EvalRunSummary | undefined>;
  /** The provability graders' own names, for what counts as measured. */
  readonly provabilityGraderNames?: ReadonlySet<string>;
  /** Whether the spec's compiled tools include one that writes outside the process. */
  readonly externalWriteTools?: (specYaml: string) => boolean;
  /** The case ids a tool recording holds entries for; `undefined` when it cannot be
   *  read. Default: read `<dir>/tools.jsonl`. */
  readonly recordedSampleIds?: (dir: string) => ReadonlySet<string> | undefined;
  /** Estimated judge cost of a run in USD, or `undefined` when it is unpriced. */
  readonly judgeCostUsd?: (summary: EvalRunSummary) => number | undefined;
  /** Estimated agent cost of a run in USD, or `undefined` when it is unpriced. */
  readonly agentCostUsd?: (summary: EvalRunSummary) => number | undefined;
};

export type CheckOptions = {
  readonly harnessDir: string;
  readonly chg: string;
  readonly runners: CheckRunners;
  /** A live check, confirmed by this stored actor (a maintainer or above). */
  readonly live?: { readonly confirmedBy: string };
  /** Who asks, as a stored actor. */
  readonly actor: string;
  readonly cmd?: string;
  readonly via?: string;
  readonly now: () => number;
  /** The dataset registry root; default `<harness>/.crewhaus/datasets`. */
  readonly datasetsRoot?: string;
};

export type CheckAnswer =
  | {
      readonly ok: true;
      readonly row: ChangeRow;
      readonly verdict: ChangeVerdict;
      readonly evidenceRef: string;
      /** The decision a passing check opened. */
      readonly decision?: string;
    }
  | {
      readonly ok: false;
      readonly code:
        | "not-found"
        | "stale"
        | "needs-live"
        | "base-moved"
        | "binding-changed"
        | "unsupported"
        | "failed"
        | "unavailable";
      readonly reason: string;
      readonly row?: ChangeRow;
    };

/** What a check will spend, said before it runs. */
export type CheckPlan = {
  readonly kind: ChangePatch["kind"];
  /** Agent runs over the cases (each case is one model conversation per run). */
  readonly agentRuns: number;
  readonly cases: number;
  /** Held-out cases read, and how many counted uses that makes. */
  readonly holdoutCases: number;
  readonly holdoutUses: number;
  readonly isolation: "regrade-only" | "recorded-tools" | "live" | "needs-live";
  /** How the holdout runs are isolated, when there is a holdout to run. */
  readonly holdoutIsolation?: "recorded-tools" | "live" | "needs-live";
};

type Inputs = {
  readonly row: ChangeRow;
  readonly patch: ChangePatch;
  readonly baseText: string;
  readonly candidateText: string;
  readonly specYaml: string;
  readonly gradersYaml: string;
};

async function loadInputs(
  harnessDir: string,
  row: ChangeRow,
): Promise<
  { ok: true; inputs: Inputs } | { ok: false; code: "binding-changed" | "failed"; reason: string }
> {
  const verified = await verifyContent(harnessDir, row);
  if (!verified.ok) {
    return {
      ok: false,
      code: verified.code === "missing" ? "failed" : "binding-changed",
      reason: verified.reason,
    };
  }
  const { patch, baseText, candidateText } = verified.content;
  const specYaml = patch.kind === "spec" ? baseText : readHarnessText(harnessDir, patch.spec);
  const gradersYaml =
    patch.kind === "graders" ? baseText : readHarnessText(harnessDir, patch.graders);
  if (specYaml === undefined) {
    return { ok: false, code: "failed", reason: `no spec at ${patch.spec}` };
  }
  if (gradersYaml === undefined) {
    return { ok: false, code: "failed", reason: `no graders file at ${patch.graders}` };
  }
  return { ok: true, inputs: { row, patch, baseText, candidateText, specYaml, gradersYaml } };
}

type ResolvedDataset = {
  readonly name: string;
  readonly samples: Sample[];
  readonly datasetHash: string;
  readonly registry?: {
    readonly name: string;
    readonly version: string;
    readonly holdout: number;
    /** The holdout's case ids, read from the record (inspection: no use is counted). */
    readonly holdoutIds: ReadonlyArray<string>;
  };
};

async function resolveDataset(opts: CheckOptions, dataset: string): Promise<ResolvedDataset> {
  const ref = parseRegistryRef(dataset);
  if (ref === undefined) {
    const loaded = await opts.runners.loadFileDataset(join(opts.harnessDir, dataset));
    return { name: loaded.name, samples: loaded.samples, datasetHash: loaded.datasetHash };
  }
  if (ref.split !== undefined) {
    throw new Error(`a change is checked on a whole dataset version, not on #${ref.split}`);
  }
  const registry = createFileBackedRegistry({
    rootDir: opts.datasetsRoot ?? join(opts.harnessDir, ".crewhaus", "datasets"),
  });
  const resolved: ResolvedRegistryRef = await resolveRegistryRef(registry, ref, {
    warn: () => undefined,
  });
  return {
    name: resolved.datasetName,
    samples: resolved.samples,
    datasetHash: resolved.datasetHash,
    registry: {
      name: ref.name,
      version: resolved.version,
      holdout: resolved.record.splits.holdout?.length ?? 0,
      holdoutIds: (resolved.record.splits.holdout ?? []).map((s) => s.id),
    },
  };
}

type Isolation = {
  readonly isolation: "recorded-tools" | "live" | "needs-live";
  readonly replayToolsDir?: string;
};

function writesOutside(opts: CheckOptions, specTexts: ReadonlyArray<string>): boolean {
  // The base and the candidate both run: a tool either one adds counts.
  return specTexts.some((text) => opts.runners.externalWriteTools?.(text) ?? false);
}

function isolationOf(
  opts: CheckOptions,
  specTexts: ReadonlyArray<string>,
  recorded: RecordedRun | undefined,
): Isolation {
  const recording = recorded?.summary.config.toolRecording;
  if (recording !== undefined)
    return { isolation: "recorded-tools", replayToolsDir: recording.dir };
  if (writesOutside(opts, specTexts) && opts.live === undefined) return { isolation: "needs-live" };
  return { isolation: "live" };
}

/** The largest tool recording read to learn which cases it covers. */
const MAX_RECORDING_BYTES = 64 * 1024 * 1024;

/** The case ids a tool recording (`<dir>/tools.jsonl`) holds entries for. */
export function recordedSampleIdsOf(dir: string): ReadonlySet<string> | undefined {
  const read = openForReadSync(dir, "tools.jsonl", {
    maxBytes: MAX_RECORDING_BYTES,
    followLeafSymlink: false,
  });
  if (!read.ok || read.truncated) return undefined;
  const ids = new Set<string>();
  for (const line of read.text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const id = (JSON.parse(line) as { sampleId?: unknown }).sampleId;
      if (typeof id === "string") ids.add(id);
    } catch {
      // a torn line names no case
    }
  }
  return ids;
}

/**
 * How the holdout runs are isolated. The lineage's recording comes from runs that never
 * read the holdout, so it is replayed for the holdout only when it holds entries for
 * the holdout's cases. Otherwise the holdout runs live: on a harness with a tool that
 * writes outside the process, only when a maintainer confirmed a live check.
 */
function holdoutIsolationOf(
  opts: CheckOptions,
  specTexts: ReadonlyArray<string>,
  main: Isolation,
  holdoutIds: ReadonlyArray<string>,
): Isolation {
  if (main.replayToolsDir !== undefined) {
    const covered = (opts.runners.recordedSampleIds ?? recordedSampleIdsOf)(main.replayToolsDir);
    if (covered !== undefined && holdoutIds.some((id) => covered.has(id))) {
      return { isolation: "recorded-tools", replayToolsDir: main.replayToolsDir };
    }
  }
  if (writesOutside(opts, specTexts) && opts.live === undefined) return { isolation: "needs-live" };
  return { isolation: "live" };
}

const NEEDS_LIVE_REASON =
  "this harness has a tool that writes outside the process and no recorded tool results to replay; a maintainer can check it live (`crewhaus changes check --live`), or record a run first (`crewhaus eval --record-tools`)";

const HOLDOUT_NEEDS_LIVE_REASON =
  "this harness has a tool that writes outside the process, and its recorded tool results hold nothing for the holdout's cases; a maintainer can check it live (`crewhaus changes check --live`)";

/** What a check of this change will spend, without spending it. */
export async function planCheck(opts: CheckOptions): Promise<CheckPlan | CheckAnswer> {
  const row = readChange(opts.harnessDir, opts.chg);
  if (row === undefined) return { ok: false, code: "not-found", reason: `no change ${opts.chg}` };
  const loaded = await loadInputs(opts.harnessDir, row);
  if (!loaded.ok) return { ok: false, code: loaded.code, reason: loaded.reason, row };
  const { patch, candidateText, specYaml } = loaded.inputs;
  if (patch.kind === "dataset") {
    const cases = candidateText.split("\n").filter((l) => l.trim() !== "").length;
    return {
      kind: "dataset",
      agentRuns: 1,
      cases,
      holdoutCases: 0,
      holdoutUses: 0,
      isolation: "live",
    };
  }
  const dataset = await resolveDataset(opts, patch.dataset);
  if (patch.kind === "graders") {
    return {
      kind: "graders",
      agentRuns: 0,
      cases: dataset.samples.length,
      holdoutCases: 0,
      holdoutUses: 0,
      isolation: "regrade-only",
    };
  }
  const recorded = opts.runners.recordedRun?.(dataset.name);
  const texts = [specYaml, candidateText];
  const main = isolationOf(opts, texts, recorded);
  const holdoutCases = dataset.registry?.holdout ?? 0;
  const holdout =
    holdoutCases > 0
      ? holdoutIsolationOf(opts, texts, main, dataset.registry?.holdoutIds ?? [])
      : undefined;
  return {
    kind: "spec",
    agentRuns: holdoutCases > 0 ? 4 : 2,
    cases: dataset.samples.length,
    holdoutCases,
    holdoutUses: holdoutCases > 0 ? 2 : 0,
    isolation: main.isolation,
    ...(holdout !== undefined ? { holdoutIsolation: holdout.isolation } : {}),
  };
}

/** A run's pass rate and its interval, as evidence keeps them. */
function rates(summary: EvalRunSummary): Record<string, unknown> {
  const a = summary.aggregates;
  return {
    runId: summary.runId,
    passRate: a.passRate,
    ...(a.passRateCI95 !== undefined ? { passRateCI95: a.passRateCI95 } : {}),
    samples: summary.samples.length,
    ...(a.measured !== undefined ? { measured: a.measured } : {}),
    ...(a.notMeasured !== undefined ? { notMeasured: a.notMeasured } : {}),
    ...(a.needsHuman !== undefined ? { abstained: a.needsHuman } : {}),
    ...(a.flaky !== undefined ? { flaky: a.flaky } : {}),
  };
}

function costOf(opts: CheckOptions, runs: ReadonlyArray<EvalRunSummary>): Record<string, unknown> {
  const sum = (f: ((s: EvalRunSummary) => number | undefined) | undefined): string | number => {
    if (f === undefined) return "cost unknown";
    let total = 0;
    for (const run of runs) {
      const v = f(run);
      if (v === undefined) return "cost unknown";
      total += v;
    }
    return total;
  };
  return { agentUsd: sum(opts.runners.agentCostUsd), judgeUsd: sum(opts.runners.judgeCostUsd) };
}

function significanceOf(base: EvalRunSummary, candidate: EvalRunSummary): unknown {
  const byId = new Map(base.samples.map((s) => [s.sampleId, s]));
  const deltas: number[] = [];
  for (const now of candidate.samples) {
    const before = byId.get(now.sampleId);
    if (before === undefined || !measuredInBaseline(before) || !measuredInBaseline(now)) continue;
    deltas.push((now.grades.overall.passed ? 1 : 0) - (before.grades.overall.passed ? 1 : 0));
  }
  const significance = computeDiffSignificance(deltas, {});
  return significance === undefined
    ? undefined
    : { ...significance, note: "decision support only; it never decides the check" };
}

type CachedHoldoutBase = { readonly dir: string; readonly runId: string };

/**
 * A base holdout run an earlier change's evidence names, for the same base and holdout.
 * The evidence is read only as that change's check recorded it (its `evidenceDigest`),
 * and the run directory it names must lie under that change's own `runs/`.
 */
async function cachedHoldoutBase(
  harnessDir: string,
  chg: string,
  baseRevision: string,
  holdout: { name: string; version: string },
  gradersHash: string,
): Promise<CachedHoldoutBase | undefined> {
  const read = readChanges(harnessDir);
  if (read.state !== "present") return undefined;
  for (const other of read.rows) {
    if (other.id === chg || other.evidenceRef === undefined) continue;
    const verified = await verifiedEvidence(harnessDir, other);
    if (!verified.ok) continue;
    const h = (
      verified.evidence as {
        holdout?: {
          base?: {
            dir?: unknown;
            runId?: unknown;
            specRevision?: unknown;
            gradersHash?: unknown;
          };
          dataset?: { name?: unknown; version?: unknown };
        };
      }
    ).holdout;
    const dir = h?.base?.dir;
    const runId = h?.base?.runId;
    if (
      typeof dir === "string" &&
      typeof runId === "string" &&
      underRuns(harnessDir, other, dir) &&
      h?.base?.specRevision === baseRevision &&
      h.base.gradersHash === gradersHash &&
      h.dataset?.name === holdout.name &&
      h.dataset.version === holdout.version
    ) {
      return { dir, runId };
    }
  }
  return undefined;
}

/** Checks running in this process, by harness and change: never taken for interrupted. */
const inFlight = new Set<string>();
const flightKey = (harnessDir: string, chg: string): string => `${harnessDir}\u0000${chg}`;

/** Whether this process is checking `chg` right now. */
export function checkInFlight(harnessDir: string, chg: string): boolean {
  return inFlight.has(flightKey(harnessDir, chg));
}

/**
 * Check a change. `proposed` (or `failed`) moves to `checking`, the runs above happen,
 * and the change moves to `checked` with its verdict and a keyed digest of its
 * evidence, or to `failed` when a run could not happen (it can be checked again). A
 * passing check opens the adoption decision and moves the change to
 * `awaiting-decision`.
 */
export async function checkChange(opts: CheckOptions): Promise<CheckAnswer> {
  const key = flightKey(opts.harnessDir, opts.chg);
  if (inFlight.has(key)) {
    return { ok: false, code: "stale", reason: `${opts.chg} is being checked right now` };
  }
  inFlight.add(key);
  try {
    return await runCheck(opts);
  } finally {
    inFlight.delete(key);
  }
}

async function runCheck(opts: CheckOptions): Promise<CheckAnswer> {
  const { harnessDir } = opts;
  const row = readChange(harnessDir, opts.chg);
  if (row === undefined) return { ok: false, code: "not-found", reason: `no change ${opts.chg}` };
  if (row.state !== "proposed" && row.state !== "failed") {
    return {
      ok: false,
      code: "stale",
      reason: `${row.id} is ${row.state}; only a proposed change, or one whose check failed, is checked`,
      row,
    };
  }
  // The content is the content the change recorded, before anything runs on it.
  const loaded = await loadInputs(harnessDir, row);
  if (!loaded.ok) return { ok: false, code: loaded.code, reason: loaded.reason, row };
  const { patch, baseText, candidateText, specYaml, gradersYaml } = loaded.inputs;

  // The file the change edits must still be the one it was proposed against.
  const onDisk = readHarnessText(harnessDir, patch.kind === "spec" ? patch.spec : patch.graders);
  if (
    patch.kind !== "dataset" &&
    (onDisk === undefined || fileRevision(patch.kind, onDisk) !== row.base.revision)
  ) {
    const moved = await moveChange(harnessDir, row.state, {
      ...row,
      state: "superseded",
      at: new Date(opts.now()).toISOString(),
      reason: "base-moved",
      actor: opts.actor,
      ...(opts.cmd !== undefined ? { cmd: opts.cmd } : {}),
    });
    return {
      ok: false,
      code: "base-moved",
      reason: `Out of date: ${patch.kind === "spec" ? patch.spec : patch.graders} changed since ${row.id} was proposed; propose it again against the current file`,
      ...(moved.ok ? { row: moved.row } : { row }),
    };
  }

  const nowIso = (): string => new Date(opts.now()).toISOString();
  const attempt = nowIso().replace(/[:.]/g, "-");
  const runsRel = join(row.contentRef, "runs", attempt);
  const runDir = (label: string): string => join(harnessDir, runsRel, label);

  let dataset: ResolvedDataset;
  try {
    dataset =
      patch.kind === "dataset"
        ? {
            name: `${row.id}-cases`,
            samples: parseCases(candidateText),
            datasetHash: textRevision(candidateText).slice(7),
          }
        : await resolveDataset(opts, patch.dataset);
  } catch (err) {
    return { ok: false, code: "failed", reason: (err as Error).message, row };
  }
  const recorded = patch.kind === "spec" ? opts.runners.recordedRun?.(dataset.name) : undefined;
  const isolation: {
    readonly isolation: "regrade-only" | "recorded-tools" | "live" | "needs-live";
    readonly replayToolsDir?: string;
  } =
    patch.kind === "spec"
      ? isolationOf(opts, [baseText, candidateText], recorded)
      : { isolation: "regrade-only" };
  if (isolation.isolation === "needs-live") {
    return { ok: false, code: "needs-live", reason: NEEDS_LIVE_REASON, row };
  }
  // The holdout gets its own isolation, decided before anything runs or is counted.
  const holdoutIsolation =
    patch.kind === "spec" && dataset.registry !== undefined && dataset.registry.holdout > 0
      ? holdoutIsolationOf(
          opts,
          [baseText, candidateText],
          isolation as Isolation,
          dataset.registry.holdoutIds,
        )
      : undefined;
  if (holdoutIsolation?.isolation === "needs-live") {
    return { ok: false, code: "needs-live", reason: HOLDOUT_NEEDS_LIVE_REASON, row };
  }

  const checking = await moveChange(harnessDir, row.state, {
    ...row,
    state: "checking",
    at: nowIso(),
    actor: opts.actor,
    ...(opts.cmd !== undefined ? { cmd: opts.cmd } : {}),
    ...(opts.via !== undefined ? { via: opts.via } : {}),
  });
  if (!checking.ok) {
    return {
      ok: false,
      code: checking.code === "unavailable" ? "unavailable" : "stale",
      reason: checking.reason,
      row,
    };
  }

  const measured: MeasuredOptions =
    opts.runners.provabilityGraderNames !== undefined
      ? { provabilityGraderNames: opts.runners.provabilityGraderNames }
      : {};
  const fail = async (reason: string): Promise<CheckAnswer> => {
    const failed = await moveChange(harnessDir, "checking", {
      ...checking.row,
      state: "failed",
      at: nowIso(),
    });
    return { ok: false, code: "failed", reason, ...(failed.ok ? { row: failed.row } : {}) };
  };

  let evidence: Record<string, unknown>;
  let verdict: ChangeVerdict;
  try {
    if (patch.kind === "spec") {
      const replay =
        isolation.replayToolsDir !== undefined ? { replayToolsDir: isolation.replayToolsDir } : {};
      const common = {
        gradersYaml,
        samples: dataset.samples,
        datasetName: dataset.name,
        datasetHash: dataset.datasetHash,
        ...replay,
      };
      const base = await opts.runners.evalSpec({
        label: "base",
        specYaml: baseText,
        outDir: runDir("base"),
        ...common,
      });
      const candidate = await opts.runners.evalSpec({
        label: "candidate",
        specYaml: candidateText,
        outDir: runDir("candidate"),
        ...common,
      });
      const check = promotionCheck(base, candidate, { measured });
      let holdout: Record<string, unknown> = { result: "absent" };
      let holdoutVerdict: ChangeVerdict["holdout"] = "absent";
      const runs: EvalRunSummary[] = [base, candidate];
      if (dataset.registry !== undefined && holdoutIsolation !== undefined) {
        const registry = createFileBackedRegistry({
          rootDir: opts.datasetsRoot ?? join(harnessDir, ".crewhaus", "datasets"),
        });
        const holdoutRef = {
          name: dataset.registry.name,
          version: dataset.registry.version,
          split: "holdout" as const,
        };
        const gradersHash = gradersConfigHash(parseGradersConfig(gradersYaml).config);
        const use = {
          purpose: "promotion" as const,
          via: (opts.via === "home" ? "home" : "cli") as "cli" | "home",
          change: row.id,
        };
        const resolveHoldout = () =>
          resolveRegistryRef(registry, holdoutRef, {
            heldOut: { purpose: "promotion" },
            use,
            warn: () => undefined,
          });
        const cached = await cachedHoldoutBase(
          harnessDir,
          row.id,
          row.base.revision,
          { name: dataset.registry.name, version: dataset.registry.version },
          gradersHash,
        );
        let holdoutBase: EvalRunSummary | undefined;
        let holdoutBaseDir = runDir("holdout-base");
        if (cached !== undefined && opts.runners.loadRun !== undefined) {
          const summary = await opts.runners.loadRun(join(harnessDir, cached.dir));
          if (
            summary !== undefined &&
            instrumentChanges(instrumentOf(summary), instrumentOf(base)).filter(
              (c) => c.unverified !== true,
            ).length === 0
          ) {
            holdoutBase = summary;
            holdoutBaseDir = join(harnessDir, cached.dir);
          }
        }
        const holdoutCommon = {
          gradersYaml,
          ...(holdoutIsolation.replayToolsDir !== undefined
            ? { replayToolsDir: holdoutIsolation.replayToolsDir }
            : {}),
        };
        if (holdoutBase === undefined) {
          const resolved = await resolveHoldout();
          holdoutBase = await opts.runners.evalSpec({
            label: "holdout-base",
            specYaml: baseText,
            samples: resolved.samples,
            datasetName: resolved.datasetName,
            datasetHash: resolved.datasetHash,
            outDir: holdoutBaseDir,
            ...holdoutCommon,
          });
          runs.push(holdoutBase);
        }
        const resolvedCandidate = await resolveHoldout();
        const holdoutCandidate = await opts.runners.evalSpec({
          label: "holdout-candidate",
          specYaml: candidateText,
          samples: resolvedCandidate.samples,
          datasetName: resolvedCandidate.datasetName,
          datasetHash: resolvedCandidate.datasetHash,
          outDir: runDir("holdout-candidate"),
          ...holdoutCommon,
        });
        runs.push(holdoutCandidate);
        const holdoutCheck = promotionCheck(holdoutBase, holdoutCandidate, { measured });
        holdoutVerdict = holdoutCheck.comparison === "pass" ? "pass" : "fail";
        holdout = {
          result: holdoutVerdict,
          isolation:
            holdoutIsolation.isolation === "live" && opts.live !== undefined
              ? `live, confirmed by ${opts.live.confirmedBy}`
              : holdoutIsolation.isolation,
          dataset: { name: dataset.registry.name, version: dataset.registry.version },
          base: {
            runId: holdoutBase.runId,
            dir: relOf(harnessDir, holdoutBaseDir),
            specRevision: row.base.revision,
            gradersHash,
            reused: cached !== undefined && holdoutBaseDir !== runDir("holdout-base"),
          },
          candidate: {
            runId: holdoutCandidate.runId,
            dir: relOf(harnessDir, runDir("holdout-candidate")),
          },
          check: holdoutCheck,
          rates: { base: rates(holdoutBase), candidate: rates(holdoutCandidate) },
        };
      }
      verdict = {
        comparison: check.comparison,
        holdout: holdoutVerdict,
        regressions: check.regressions.length,
        recoveries: check.recoveries.length,
      };
      evidence = {
        v: 1,
        chg: row.id,
        kind: "spec",
        lineage: { dataset: dataset.name },
        instrument: instrumentOf(candidate),
        isolation:
          isolation.isolation === "recorded-tools"
            ? "recorded-tools"
            : opts.live !== undefined
              ? `live, confirmed by ${opts.live.confirmedBy}`
              : "live",
        base: { runId: base.runId, dir: relOf(harnessDir, runDir("base")), ...rates(base) },
        candidate: {
          runId: candidate.runId,
          dir: relOf(harnessDir, runDir("candidate")),
          ...rates(candidate),
        },
        check,
        significance: significanceOf(base, candidate),
        cost: costOf(opts, runs),
        holdout,
      };
    } else if (patch.kind === "graders") {
      const recordedRun = opts.runners.recordedRun?.(dataset.name);
      if (recordedRun === undefined) {
        return await fail(
          `no recorded run of ${dataset.name} to regrade — run \`crewhaus eval\` on it first`,
        );
      }
      const common = {
        sourceDir: recordedRun.dir,
        specYaml,
        samples: dataset.samples,
        datasetName: dataset.name,
        datasetHash: dataset.datasetHash,
      };
      const base = await opts.runners.regrade({
        label: "base",
        gradersYaml: baseText,
        outDir: runDir("base"),
        ...common,
      });
      const candidate = await opts.runners.regrade({
        label: "candidate",
        gradersYaml: candidateText,
        outDir: runDir("candidate"),
        ...common,
      });
      const check = promotionCheck(base, candidate, { measured, instrumentChange: "expected" });
      verdict = {
        comparison: check.comparison,
        holdout: "absent",
        regressions: check.regressions.length,
        recoveries: check.recoveries.length,
      };
      evidence = {
        v: 1,
        chg: row.id,
        kind: "graders",
        lineage: { dataset: dataset.name, regradeOf: recordedRun.summary.runId },
        instrument: { base: instrumentOf(base), candidate: instrumentOf(candidate) },
        isolation: "regrade-only",
        base: { runId: base.runId, dir: relOf(harnessDir, runDir("base")), ...rates(base) },
        candidate: {
          runId: candidate.runId,
          dir: relOf(harnessDir, runDir("candidate")),
          ...rates(candidate),
        },
        check,
        cost: costOf(opts, [base, candidate]),
        holdout: { result: "absent" },
      };
    } else {
      const run = await opts.runners.evalSpec({
        label: "cases",
        specYaml,
        gradersYaml,
        samples: dataset.samples,
        datasetName: dataset.name,
        datasetHash: dataset.datasetHash,
        outDir: runDir("cases"),
      });
      const unmeasurable = unmeasurableRun(run);
      verdict = {
        comparison: unmeasurable === undefined ? "pass" : "fail",
        holdout: "absent",
        regressions: 0,
        recoveries: 0,
      };
      evidence = {
        v: 1,
        chg: row.id,
        kind: "dataset",
        lineage: { dataset: patch.dataset },
        instrument: instrumentOf(run),
        isolation: "live",
        cases: { runId: run.runId, dir: relOf(harnessDir, runDir("cases")), ...rates(run) },
        ...(unmeasurable !== undefined ? { unmeasurable } : {}),
        cost: costOf(opts, [run]),
        holdout: { result: "absent" },
      };
    }
  } catch (err) {
    return await fail(
      `the check could not run: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const evidenceRef = join(runsRel, "evidence.json");
  const written = addChangeContent(
    harnessDir,
    row.id,
    join("runs", attempt, "evidence.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  if (!written.ok) return await fail(`the evidence could not be written: ${written.reason}`);
  const evidenceDigest = await evidenceDigestOf(harnessDir, evidence);
  const checked = await moveChange(harnessDir, "checking", {
    ...checking.row,
    state: "checked",
    at: nowIso(),
    verdict,
    evidenceDigest,
    evidenceRef,
    isolation: String(evidence["isolation"]).startsWith("live,")
      ? "live"
      : String(evidence["isolation"]),
    ...(opts.live !== undefined ? { liveBy: opts.live.confirmedBy } : {}),
  });
  if (!checked.ok)
    return { ok: false, code: "unavailable", reason: checked.reason, row: checking.row };
  const passed =
    verdict.comparison === "pass" && (verdict.holdout === "pass" || verdict.holdout === "absent");
  if (!passed) return { ok: true, row: checked.row, verdict, evidenceRef };
  const opened = await openAdoptionDecision({
    harnessDir,
    row: checked.row,
    actor: opts.actor,
    now: opts.now,
    bindingLabel: BINDING_DIGEST_LABEL,
  });
  if (!opened.ok)
    return { ok: false, code: "unavailable", reason: opened.reason, row: checked.row };
  return { ok: true, row: opened.row, verdict, evidenceRef, decision: opened.decision };
}

function relOf(harnessDir: string, abs: string): string {
  return relative(harnessDir, abs).split("\\").join("/");
}

/** The added cases of a dataset change, one JSON sample per line. */
export function parseCases(text: string): Sample[] {
  const out: Sample[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      throw new Error(`cases.jsonl line ${i + 1} is not JSON`);
    }
    const s = v as Partial<Sample>;
    if (typeof s?.id !== "string" || typeof s.input !== "string") {
      throw new Error(`cases.jsonl line ${i + 1} is not a case ({id, input, …})`);
    }
    out.push(v as Sample);
  }
  return out;
}
