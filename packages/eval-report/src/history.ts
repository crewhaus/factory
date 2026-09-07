/**
 * Eval run-history index + per-(spec, dataset) baseline pins.
 *
 * Two small on-disk artifacts under `.crewhaus/evals/` (or an explicit
 * `evalsDir` for tenant-scoped / test callers):
 *
 * - `index.jsonl` — append-only log, one JSON line per completed eval run.
 *   Readers tolerate torn/corrupt lines (skip, never throw) so a crashed
 *   append can't take down every future `history` listing.
 * - `baselines.json` — map of `<specName>::<datasetName>` → the pinned
 *   baseline run for that key. Written atomically as a whole (small file).
 *
 * These helpers are deliberately dependency-free (node:fs + node:crypto)
 * so other features — auto-baseline diff in the CLI, the future dataset
 * drift sentinel — can reuse them without pulling in the renderer.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalRoutingMode, EvalRunSummary } from "@crewhaus/eval-runner";
import { ReportError } from "./errors";

/** Default location of the run index + baselines, relative to the cwd. */
export const DEFAULT_EVALS_DIR = join(".crewhaus", "evals");
export const INDEX_FILENAME = "index.jsonl";
export const BASELINES_FILENAME = "baselines.json";

/** One line of `index.jsonl` — the durable summary of a completed eval run. */
export type RunIndexEntry = {
  readonly runId: string;
  readonly specName: string;
  readonly specHash: string;
  /**
   * Stable spec *identity* — the resolved source path of the spec this run
   * evaluated. Unlike {@link specHash} (which changes on every instruction
   * edit), the source survives edits, so it distinguishes "the same spec,
   * edited" (baseline lineage should continue — that IS the regression gate)
   * from "a different spec that merely shares a `name:`" (a collision worth
   * warning about). Additive — absent on entries written before the field
   * existed, and on runs whose caller didn't supply a source.
   */
  readonly specSource?: string;
  readonly datasetName: string;
  /** sha256 hex of the dataset file bytes (see {@link hashDatasetFile}). */
  readonly datasetHash: string;
  /**
   * sha256 hex of the parsed graders config the run graded with — the same
   * digest the runner records into `run.json`/`results.json` for the drift
   * sentinel. Together with {@link judgeModel} it identifies the *measurement
   * instrument*: a changed rubric or threshold produces a new hash, and
   * scores from different instruments are not comparable. Additive — absent
   * on entries written before the field existed.
   */
  readonly gradersHash?: string;
  /**
   * Judge model the run's `llm_judge` graders were bound to, when the run
   * pinned one explicitly (`--judge-model`). The other half of the
   * measurement-instrument identity (see {@link gradersHash}). Additive —
   * absent on entries written before the field existed, and on runs that
   * used the default judge binding.
   */
  readonly judgeModel?: string;
  readonly passRate: number;
  readonly meanScore: number;
  readonly sampleCount: number;
  /**
   * C30 — the run's p95 per-sample latency in ms
   * (`aggregates.p95LatencyMs`), recorded so ops metrics are readable from
   * the index without loading every run dir. Additive — absent on entries
   * written before the field existed.
   */
  readonly p95LatencyMs?: number;
  /**
   * C30 × C35 — the run's TOTAL estimated cost in USD: agent-model spend
   * plus judge/grader spend, priced through the same seam as the `--models`
   * matrix `est_$` column. This is the number the run printed as
   * `[eval] cost: … total=$X` and the number `--max-cost-usd` gates on —
   * they are computed once, together (`evalRunCost`), because a gate that
   * saw only the agent half let a judge-heavy run print $4.10 and still pass
   * a $2.00 ceiling. The halves ride along in {@link agentCostUsd} /
   * {@link judgeCostUsd} so trends can still separate them. Additive —
   * absent on entries written before the field existed and on runs where
   * ANY model (agent or judge) has no pricing row, since a partial sum would
   * be an undercount.
   */
  readonly costUsd?: number;
  /**
   * C35 — the agent-model half of {@link costUsd}. Present even when the
   * total is not (an unpriced JUDGE model does not erase the known agent
   * figure). Additive — absent on entries written before the field existed.
   */
  readonly agentCostUsd?: number;
  /**
   * C35 — the judge/grader half of {@link costUsd}, summed over
   * `aggregates.judgeUsage.byModel`. Additive — absent on runs that made no
   * judge calls, on runs whose judge models are all unpriced, and on entries
   * written before the field existed.
   */
  readonly judgeCostUsd?: number;
  /**
   * Samples whose recorded outcome replaced an errored first attempt via
   * the runner's noise auto-retry (`SampleResult.retried`). Additive —
   * absent on entries written before the field existed (read as 0).
   */
  readonly retriedCount?: number;
  /**
   * C34 — samples whose repeat trials DISAGREED in this run
   * (`aggregates.flaky`): the run contains measured instability, so a
   * strict any-flip gate against it will keep firing for reasons the agent
   * did not cause. Recorded on the index so `eval-report history` can mark
   * flake-containing runs without opening every run dir. Additive — absent
   * on single-trial runs, on stable repeat runs, and on entries written
   * before the field existed (read as 0).
   */
  readonly flakyCount?: number;
  /**
   * NEW-HUNT-3 — true when the run was cut short by its run-level budget
   * cap (`EvalRunSummary.partial`): samples still queued at abort were
   * recorded as synthetic errors, so this entry's passRate/meanScore read
   * LOWER than a full run's would. Partial runs are never pinned or
   * promoted as baselines. Additive — absent on full runs and on entries
   * written before the field existed.
   */
  readonly partial?: boolean;
  /**
   * NEW-HUNT-4 — true when every tool call in this run was served from a
   * RECORDED CASSETTE (`--replay-tools`, `config.toolRecording.mode ===
   * "replay"`) rather than from the world. A replayed run is a legitimate
   * measurement of the agent's reasoning, but it is not a measurement of the
   * live system: pinning one as the baseline gates every future LIVE run
   * against frozen tool results. Recorded here so `eval-report history` and
   * the promotion path can SAY so — the run directory's `run.json` used to be
   * the only place that knew. Additive — absent on live runs and on entries
   * written before the field existed.
   */
  readonly replayed?: boolean;
  // ---- 0.6.0 §6.1 — per-arm eval lineage. All additive: absent on entries
  // written before the fields existed and on every `routing: "static"` run,
  // so an unrouted history reads exactly as it did.
  /**
   * The ARM this run measured — a `models:` profile name, else the spec model
   * string (the router's `poolCandidateArmId`). Present only under
   * `routing: "candidate:<…>"`; an `as-declared` run measures the whole
   * roster and keys under the `routed` lineage instead.
   */
  readonly armId?: string;
  /** How the run was routed (`RunEvalOptions.routing`). Absent ⇒ `"static"`. */
  readonly routing?: EvalRoutingMode;
  /**
   * The pool fingerprint (`model_route.policyVersion`) the run's decisions
   * carried, when they agreed on one. Part of the INSTRUMENT guard, not the
   * key: a policy flip must re-baseline the lineage, never orphan it.
   */
  readonly policyVersion?: string;
  /**
   * Digest of the FROZEN arm snapshot the run routed off. The other half of
   * the routed instrument guard — two different arm snapshots are two
   * different instruments and are never gated against each other.
   */
  readonly armsDigest?: string;
  /** ISO-8601 completion timestamp. */
  readonly ts: string;
  /** Absolute path to the run's output directory. */
  readonly outDir: string;
};

/** One pinned baseline in `baselines.json`, keyed by (specName, datasetName). */
export type BaselineEntry = {
  readonly specName: string;
  readonly datasetName: string;
  readonly runId: string;
  /**
   * Resolved source path of the spec that pinned this baseline (see
   * {@link RunIndexEntry.specSource}). Lets a later run detect that it is a
   * *different* spec sharing the same `name:` — a lineage collision — and
   * warn. Additive; absent on baselines pinned before the field existed.
   */
  readonly specSource?: string;
  /** Absolute path to the baseline run's output directory. */
  readonly outDir: string;
  /** Dataset content hash at the time the baseline was pinned. */
  readonly datasetHash: string;
  /**
   * Graders-config hash of the pinned run (see
   * {@link RunIndexEntry.gradersHash}). Lets a later run detect that it
   * graded with a *different* measurement instrument and start a new
   * baseline lineage instead of gating scores from one rubric against
   * another's. Additive; absent on baselines pinned before the field existed.
   */
  readonly gradersHash?: string;
  /**
   * Judge model of the pinned run (see {@link RunIndexEntry.judgeModel}).
   * Additive; absent on baselines pinned before the field existed.
   */
  readonly judgeModel?: string;
  /**
   * C30 — p95 per-sample latency of the pinned run (see
   * {@link RunIndexEntry.p95LatencyMs}). Additive; absent on baselines
   * pinned before the field existed.
   */
  readonly p95LatencyMs?: number;
  /**
   * C30 — estimated cost of the pinned run (see
   * {@link RunIndexEntry.costUsd}). Additive; absent on baselines pinned
   * before the field existed and when the model had no pricing row.
   */
  readonly costUsd?: number;
  // ---- 0.6.0 §6.1 — the per-arm lineage this pin belongs to. `armId` and
  // `routing` are part of the KEY (see {@link baselineKeyV2}); `policyVersion`
  // and `armsDigest` are the routed INSTRUMENT guard.
  readonly armId?: string;
  readonly routing?: EvalRoutingMode;
  readonly policyVersion?: string;
  readonly armsDigest?: string;
  /** ISO-8601 timestamp of when the pin was written. */
  readonly ts: string;
};

/** Shape of `baselines.json`: `<specName>::<datasetName>` → pinned run. */
export type BaselinesFile = Record<string, BaselineEntry>;

/** Composite key for the baselines map (the legacy two-segment lineage). */
export function baselineKey(specName: string, datasetName: string): string {
  return `${specName}::${datasetName}`;
}

/**
 * 0.6.0 §6.1 — the RESERVED prefix of a per-arm (V2) baseline key.
 *
 * Dataset names are not sanitised anywhere (registry refs carry `@`, `#` and
 * arbitrary text), so a dataset literally named `a::b` would make the legacy
 * key `spec::a::b` collide with an UNPREFIXED V2 key. `|` is excluded from
 * the spec's `safeName`, so a spec name can never begin with `arm|` and the
 * two namespaces provably cannot alias onto each other.
 */
export const BASELINE_KEY_V2_PREFIX = "arm|";

/** The lineage segment an `as-declared` (whole-roster) run keys under. */
export const ROUTED_LINEAGE_SEGMENT = "routed";

/**
 * 0.6.0 §6.1 — `baselineKeyV2 = spec::dataset::<armId | routed>`, under the
 * reserved prefix. Per-arm and routed lineages key SEPARATELY from the legacy
 * `spec::dataset` key, so a cheap candidate can never pin over the primary's
 * baseline.
 */
export function baselineKeyV2(specName: string, datasetName: string, armId?: string): string {
  return `${BASELINE_KEY_V2_PREFIX}${specName}::${datasetName}::${armId ?? ROUTED_LINEAGE_SEGMENT}`;
}

/**
 * The (spec, dataset, arm) lineage one run belongs to. `routing` absent or
 * `"static"` is the LEGACY lineage — the two-segment key every baselines.json
 * on disk already uses — so nothing about an unrouted harness changes.
 */
export type BaselineLineage = {
  readonly specName: string;
  readonly datasetName: string;
  readonly armId?: string;
  readonly routing?: EvalRoutingMode;
};

/** True when the lineage keys on the legacy two-segment key. */
export function isLegacyLineage(lineage: BaselineLineage): boolean {
  return lineage.routing === undefined || lineage.routing === "static";
}

/** The baselines-map key a lineage pins under: legacy for `static`, V2 otherwise. */
export function baselineKeyFor(lineage: BaselineLineage): string {
  return isLegacyLineage(lineage)
    ? baselineKey(lineage.specName, lineage.datasetName)
    : baselineKeyV2(lineage.specName, lineage.datasetName, lineage.armId);
}

/** What {@link resolveBaseline} found for a lineage. */
export type BaselineLookup = {
  /** The key the lineage pins under. */
  readonly key: string;
  /** The pinned baseline, when one exists under that key. */
  readonly entry?: BaselineEntry;
  /**
   * 0.6.0 §6.1 — a V2 lineage whose OWN key is absent while the legacy
   * `spec::dataset` key IS pinned. Such a run is neither gated nor promotable:
   * auto-pinning it as a "first run" would let the very run that CREATES a
   * lineage satisfy `route promote --gate`, and gating it against the
   * unrouted baseline would compare two different instruments.
   */
  readonly legacyPresent: boolean;
};

/**
 * Resolve the pinned baseline for a lineage. The ONE reader every consumer
 * shares (the CLI gate, Hangar's eval health, the fleet matcher), so a routed
 * harness is never told "no baseline pinned" because its arm's key was looked
 * up with the legacy spelling.
 */
export function resolveBaseline(
  lineage: BaselineLineage,
  evalsDir: string = DEFAULT_EVALS_DIR,
): BaselineLookup {
  const baselines = readBaselines(evalsDir);
  const key = baselineKeyFor(lineage);
  const entry = baselines[key];
  if (entry !== undefined) return { key, entry, legacyPresent: false };
  const legacyPresent =
    !isLegacyLineage(lineage) &&
    baselines[baselineKey(lineage.specName, lineage.datasetName)] !== undefined;
  return { key, legacyPresent };
}

/** The lineage a recorded run (index entry or baseline pin) belongs to. */
export function lineageOfEntry(entry: {
  readonly specName: string;
  readonly datasetName: string;
  readonly armId?: string;
  readonly routing?: EvalRoutingMode;
}): BaselineLineage {
  return {
    specName: entry.specName,
    datasetName: entry.datasetName,
    ...(entry.armId !== undefined ? { armId: entry.armId } : {}),
    ...(entry.routing !== undefined ? { routing: entry.routing } : {}),
  };
}

/** sha256 hex digest of the dataset file bytes (content identity, not path). */
export function hashDatasetFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Append one run to `index.jsonl`, creating the directory/file on first use. */
export function appendRunIndex(entry: RunIndexEntry, evalsDir: string = DEFAULT_EVALS_DIR): void {
  mkdirSync(evalsDir, { recursive: true });
  appendFileSync(join(evalsDir, INDEX_FILENAME), `${JSON.stringify(entry)}\n`);
}

/** Identity a run summary cannot supply on its own — see {@link recordEvalRun}. */
export type RecordEvalRunOptions = {
  /** The evaluated spec's `name:` (the baseline lineage key). */
  readonly specName: string;
  /** Resolved spec source path — see {@link RunIndexEntry.specSource}. */
  readonly specSource?: string;
  /** sha256 hex of the dataset content the run scored. */
  readonly datasetHash: string;
  /** ABSOLUTE path to the run's output directory. */
  readonly outDir: string;
  /**
   * C30 — the run's estimated cost in USD, when the caller could price it.
   * Caller-supplied because pricing needs the model catalogue, which the
   * summary does not carry; every other ops column is derived here.
   */
  readonly costUsd?: number;
  /** C35 — the agent half of {@link costUsd} (see the RunIndexEntry field). */
  readonly agentCostUsd?: number;
  /** C35 — the judge/grader half of {@link costUsd}. */
  readonly judgeCostUsd?: number;
  /** Override `.crewhaus/evals` (tenant scopes, tests, standalone bundles
   *  whose run dir was rebased). */
  readonly evalsDir?: string;
  /**
   * 0.6.0 §6.1 — the per-arm lineage this run belongs to, when the CALLER
   * knows it and the run's own manifest does not. A `--models` matrix cell is
   * exactly that case: the cell pins a model by patching `agent.model`
   * in-memory, so the runner routes `static` and records no routing block,
   * yet the cell must still key its own `spec::dataset::<armId>` lineage or N
   * cells would fight over one baseline. Supplied fields WIN over the ones
   * derived from `summary.config.routing`.
   */
  readonly armId?: string;
  readonly routing?: EvalRoutingMode;
};

/**
 * 0.6.0 §6.1 — the routing columns of an index entry, derived from the run's
 * OWN manifest (`summary.config.routing`) so every launcher records the same
 * lineage without re-deriving it. Absent block ⇒ `{}` — an unrouted run's
 * index line stays byte-identical.
 */
export function routingColumnsFromSummary(summary: EvalRunSummary): {
  readonly armId?: string;
  readonly routing?: EvalRoutingMode;
  readonly policyVersion?: string;
  readonly armsDigest?: string;
} {
  const routing = summary.config.routing;
  if (routing === undefined || routing.mode === "static") return {};
  return {
    ...(routing.armId !== undefined ? { armId: routing.armId } : {}),
    routing: routing.mode,
    ...(routing.policyVersion !== undefined ? { policyVersion: routing.policyVersion } : {}),
    ...(routing.armsDigest !== undefined ? { armsDigest: routing.armsDigest } : {}),
  };
}

/**
 * Project a completed run onto its index entry. The ONE place the summary →
 * `index.jsonl` wire format is derived, so every launcher records the same
 * shape: `crewhaus eval` (via `finishEvalRun`) and the standalone
 * `target: eval` bundle, which used to write its run directory and nothing
 * else — leaving `eval-report history`, `baseline set` and the gate machinery
 * blind to any run that wasn't launched through the CLI.
 *
 * Refuses a 0-sample run: it carries no signal, and a passRate-0 "clean"
 * entry would poison the index and could pin an empty baseline.
 */
export function runIndexEntryFromSummary(
  summary: EvalRunSummary,
  opts: RecordEvalRunOptions,
): RunIndexEntry {
  const datasetName = summary.config.datasetName;
  if (summary.samples.length === 0) {
    throw new ReportError(
      `refusing to record 0-sample eval run ${summary.runId} — dataset "${datasetName}" produced no samples`,
    );
  }
  const gradersHash = summary.config.gradersHash;
  const judgeModel = summary.config.judgeModel;
  return {
    runId: summary.runId,
    specName: opts.specName,
    specHash: summary.config.specHash,
    ...(opts.specSource !== undefined ? { specSource: opts.specSource } : {}),
    datasetName,
    datasetHash: opts.datasetHash,
    ...(gradersHash !== undefined ? { gradersHash } : {}),
    ...(judgeModel !== undefined ? { judgeModel } : {}),
    passRate: summary.aggregates.passRate,
    meanScore: summary.aggregates.meanScore,
    sampleCount: summary.samples.length,
    // C30 — additive ops columns: p95 latency straight off the aggregates,
    // estimated cost when the caller could price the run.
    p95LatencyMs: summary.aggregates.p95LatencyMs,
    ...(opts.costUsd !== undefined ? { costUsd: opts.costUsd } : {}),
    // C35 — the halves behind the total, so `eval-report trends` can tell
    // agent spend from grading spend without re-pricing every run.
    ...(opts.agentCostUsd !== undefined ? { agentCostUsd: opts.agentCostUsd } : {}),
    ...(opts.judgeCostUsd !== undefined ? { judgeCostUsd: opts.judgeCostUsd } : {}),
    retriedCount: summary.samples.filter((s) => s.retried === true).length,
    // C34 — flake count straight off the aggregates (absent = no flakes, so
    // the field only appears on runs that actually measured instability).
    ...(summary.aggregates.flaky !== undefined ? { flakyCount: summary.aggregates.flaky } : {}),
    // NEW-HUNT-3 — mark budget-aborted runs so history readers can tell this
    // entry's deflated passRate (aborted samples count as errors) from a
    // genuinely measured one.
    ...(summary.partial !== undefined ? { partial: true } : {}),
    // NEW-HUNT-4 — mark cassette-replayed runs: every tool result came from
    // a recording, so this row is not a measurement of the live system.
    // (`mode: "record"` still hit the world — only replay is marked.)
    ...(summary.config.toolRecording?.mode === "replay" ? { replayed: true } : {}),
    // 0.6.0 §6.1 — the per-arm lineage columns, straight off the run's own
    // routing manifest. Absent on `routing: "static"` runs.
    ...routingColumnsFromSummary(summary),
    ...(opts.armId !== undefined ? { armId: opts.armId } : {}),
    ...(opts.routing !== undefined ? { routing: opts.routing } : {}),
    ts: summary.endedAt,
    outDir: opts.outDir,
  };
}

/**
 * Record a completed run in the history index and return the entry that was
 * appended. Build + append in one call so no caller can write a half-shaped
 * line (see {@link runIndexEntryFromSummary}).
 */
export function recordEvalRun(summary: EvalRunSummary, opts: RecordEvalRunOptions): RunIndexEntry {
  const entry = runIndexEntryFromSummary(summary, opts);
  appendRunIndex(entry, opts.evalsDir);
  return entry;
}

/**
 * Read the run index, oldest first — EVERY line, superseding entries
 * included. Missing file → empty list. Corrupt or torn lines are skipped
 * rather than thrown — the index is an append-only log and one bad line must
 * not hide every other run.
 *
 * NOTE: `runId` is NOT unique across the returned entries. `eval --resume`
 * keeps the interrupted run's original id and APPENDS a superseding entry
 * rather than rewriting history in place, so an N-times-resumed run occupies
 * N+1 lines. A reader that tallies runs, sums cost or averages pass rates
 * wants {@link readRunIndexLatest}, which keeps only the newest entry per id;
 * use this raw reader only when the full append log is the point (auditing
 * how a run's figures evolved across attempts).
 */
export function readRunIndex(evalsDir: string = DEFAULT_EVALS_DIR): RunIndexEntry[] {
  const path = join(evalsDir, INDEX_FILENAME);
  if (!existsSync(path)) return [];
  const entries: RunIndexEntry[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      entries.push(JSON.parse(trimmed) as RunIndexEntry);
    } catch {
      // skip corrupt line — see docstring
    }
  }
  return entries;
}

/**
 * NEW-HUNT-6 — the run index with SUPERSEDED entries collapsed: one entry per
 * `runId`, the newest by `ts`, in the underlying log's order.
 *
 * `eval --resume` keeps the interrupted run's original runId, so recording
 * the completed run APPENDS a second line for that id rather than mutating
 * the first (the index is an append-only log — rewriting history in place is
 * exactly what it exists not to do). Every reader that treats the index as
 * "one row per run" — history listings, trend series, cost-over-time sums,
 * run tallies — must therefore collapse first, or an N-times-resumed run is
 * counted N+1 times with its truncated early pass rates dragging the average
 * down. This lives here, in the shared reader, rather than in one consumer,
 * so non-CLI consumers of `@crewhaus/eval-report` are not silently wrong.
 *
 * Absent a resume the operation is the identity (run ids are 8 random bytes —
 * duplicates only ever come from a deliberate supersede), so existing
 * histories read exactly as before.
 */
export function readRunIndexLatest(evalsDir: string = DEFAULT_EVALS_DIR): RunIndexEntry[] {
  const entries = readRunIndex(evalsDir);
  const tsOf = (e: RunIndexEntry): number => {
    const t = Date.parse(e.ts);
    return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
  };
  const winner = new Map<string, number>();
  entries.forEach((e, i) => {
    const at = winner.get(e.runId);
    // `>=` so a later append wins ties — a resume's superseding entry can
    // share the same-second timestamp as the run it supersedes.
    if (at === undefined || tsOf(e) >= tsOf(entries[at] as RunIndexEntry)) winner.set(e.runId, i);
  });
  if (winner.size === entries.length) return entries;
  const keep = new Set(winner.values());
  return entries.filter((_e, i) => keep.has(i));
}

/** Read `baselines.json`. Missing file → `{}`; malformed JSON → ReportError. */
export function readBaselines(evalsDir: string = DEFAULT_EVALS_DIR): BaselinesFile {
  const path = join(evalsDir, BASELINES_FILENAME);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as BaselinesFile;
  } catch (err) {
    throw new ReportError(`failed to parse ${path}: ${(err as Error).message}`);
  }
}

/** The pinned baseline for a (spec, dataset) key, or undefined if none.
 *  The LEGACY lineage only — routed runs resolve through {@link resolveBaseline}. */
export function getBaseline(
  specName: string,
  datasetName: string,
  evalsDir: string = DEFAULT_EVALS_DIR,
): BaselineEntry | undefined {
  return readBaselines(evalsDir)[baselineKey(specName, datasetName)];
}

/**
 * Pin (or re-pin) the baseline for the entry's lineage: the legacy
 * `spec::dataset` key when the entry carries no routing (every pre-0.6.0 pin,
 * byte-identical), the V2 per-arm key otherwise.
 */
export function setBaseline(entry: BaselineEntry, evalsDir: string = DEFAULT_EVALS_DIR): void {
  mkdirSync(evalsDir, { recursive: true });
  const baselines = readBaselines(evalsDir);
  baselines[baselineKeyFor(lineageOfEntry(entry))] = entry;
  writeFileSync(join(evalsDir, BASELINES_FILENAME), `${JSON.stringify(baselines, null, 2)}\n`);
}
