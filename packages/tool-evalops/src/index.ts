import * as path from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import {
  DEFAULT_COVERAGE_SESSIONS,
  EvalCoverageError,
  GradersTestError,
  belowFloor,
  buildEvalCoverage,
  buildProdBehavior,
  computeCoverage,
  datasetFilterMatches,
  parseGoldenVerdicts,
} from "@crewhaus/eval-ops";
/**
 * @crewhaus/tool-evalops — what the eval runs add up to, without running one.
 *
 * Five questions a release gate asks after the evals have already run: what do
 * this run's numbers actually come to, where is this suite heading, which run
 * is the line being held against, what does production do that the dataset
 * never tries, and does the grader agree with the humans who labelled the same
 * outputs. Each has a right answer that is a fold over files on disk, so none
 * of them needs a model turn.
 *
 * Four properties hold across the package.
 *
 *   1. THE REAL LIBRARIES. The eval history is read by
 *      `@crewhaus/eval-report`, the aggregates are recomputed by
 *      `@crewhaus/eval-runner`'s own `aggregate()`, coverage and the grader
 *      meta-eval are `@crewhaus/eval-ops`, the graders YAML is compiled by
 *      `@crewhaus/eval-grader`, and every statistic comes from
 *      `@crewhaus/tool-math`'s kernel. Nothing here re-derives a rule that
 *      lives in one of those, because a second copy agrees right up until the
 *      release that changes the first one.
 *   2. A RATE OVER A SMALL n GETS AN INTERVAL. 3 of 5 is not 60%. Pass@k,
 *      pass^k, grader agreement and a coverage gap's session share all carry a
 *      Wilson interval, and where the exact counts cannot be recovered from
 *      what was recorded, the interval is ABSENT WITH A REASON rather than
 *      estimated from a rate.
 *   3. AN UNREADABLE THING IS NOT AN EMPTY ONE. A torn line in the run index
 *      is counted, a session file that could not be read is named, a coverage
 *      report over zero readable sessions is a refusal rather than the words
 *      "no coverage gaps", and a gate that could not be evaluated is
 *      `unknown`, never `pass`.
 *   4. CONTAINMENT. Every caller-supplied path goes through the same resolver
 *      the other filesystem packages use, and an absolute `outDir` recorded by
 *      whichever machine ran the eval is re-contained before it is opened.
 *
 * Only `EvalBaselinePin` writes anything, and only to `baselines.json`.
 */
import {
  type BaselineLineage,
  DEFAULT_EVALS_DIR,
  type RunIndexEntry,
  resolveBaseline,
} from "@crewhaus/eval-report";
import type { EvalRoutingMode } from "@crewhaus/eval-runner";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { statsKernel } from "@crewhaus/tool-math";
import { z } from "zod";
import { loadDataset, loadRunEvents, loadSessions } from "./lib/coverage";
import { gateAgreement, runMetaTest } from "./lib/graders";
import {
  type IndexRead,
  keyOf,
  newestByTs,
  pinnedRunIds,
  readIndex,
  readPins,
} from "./lib/history";
import { type LineageFold, foldLineages } from "./lib/lineage";
import { commitPin, planPin } from "./lib/pin";
import { type Loaded, compareStrings, fail, readContained, renderPath } from "./lib/read";
import { compareDeclared, readRunDoc, recompute, wilsonDisagreement } from "./lib/run";

/** Compact JSON — the reader is a model, and every byte is context. */
const json = (value: unknown): string => JSON.stringify(value);

/** Where a harness keeps its sessions, by convention. */
const DEFAULT_SESSIONS_DIR = ".crewhaus/sessions";

/**
 * Ceilings that keep one pathological input from becoming a hang.
 *
 * Every byte cap is checked against the size on disk before a read, so a file
 * over the limit costs a stat and nothing else.
 */
const LIMITS = {
  indexBytes: 64 * 1024 * 1024,
  resultsBytes: 64 * 1024 * 1024,
  sessionBytes: 32 * 1024 * 1024,
  eventsPerSession: 200_000,
  sessionFiles: 2_000,
  datasetBytes: 64 * 1024 * 1024,
  datasetRows: 200_000,
  gradersBytes: 4 * 1024 * 1024,
  goldenBytes: 16 * 1024 * 1024,
  goldens: 20_000,
  graders: 200,
  /** goldens x graders — every replay is a synchronous call into a grader. */
  replays: 200_000,
  runSampleDirs: 2_000,
  runEventBytes: 16 * 1024 * 1024,
  sampleIds: 20_000,
  /** How many items any one list in a result names before it says "+N more". */
  listed: 100,
} as const;

/** Cap a list in a result, and say what was left out. */
function capped<T>(
  items: ReadonlyArray<T>,
  limit: number = LIMITS.listed,
): { shown: T[]; omitted: number } {
  return { shown: items.slice(0, limit), omitted: Math.max(0, items.length - limit) };
}

/**
 * A capped list AND its omitted count, as one spreadable field pair.
 *
 * `capped(...).shown` on its own is a truncated listing presented as a
 * complete one — the exact failure this package's accounting fields exist to
 * prevent, committed by the accounting fields themselves: 250 unreadable index
 * rows arrived as a list of 100 with nothing saying the other 150 existed.
 * Every list that can grow with the input goes through here, so the count is
 * never separated from the truncation.
 */
function cappedField<T>(
  name: string,
  items: ReadonlyArray<T>,
  limit: number = LIMITS.listed,
): Record<string, unknown> {
  const { shown, omitted } = capped(items, limit);
  return {
    [name]: shown,
    ...(omitted > 0
      ? {
          [`${name}Omitted`]: omitted,
          [`${name}OmittedNote`]: `${omitted} more not listed — this field is the first ${limit} of ${items.length}, not all of them`,
        }
      : {}),
  };
}

function refusal(loaded: { code: string; message: string }): string {
  return json({ ok: false, code: loaded.code, error: loaded.message });
}

/**
 * Parse a routing mode, then act on the PARSED value.
 *
 * `EvalRoutingMode` is `static | as-declared | candidate:<arm>`, and the
 * lineage key depends on which one it is. A string that merely looks routed
 * would key a pin under a lineage the runner never writes to, so anything
 * outside the grammar is refused rather than passed through.
 */
export function parseRouting(value: string | undefined): Loaded<EvalRoutingMode | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === "static" || value === "as-declared") return { ok: true, value };
  if (value.startsWith("candidate:") && value.length > "candidate:".length) {
    return { ok: true, value: value as EvalRoutingMode };
  }
  return fail(
    "bad-input",
    `routing "${renderPath(value)}" is not a routing mode — expected "static", "as-declared" or "candidate:<arm>"`,
  );
}

/** The (spec, dataset, arm) lineage a call names. */
function lineageOf(input: {
  spec: string;
  dataset: string;
  armId?: string;
  routing?: EvalRoutingMode;
}): BaselineLineage {
  return {
    specName: input.spec,
    datasetName: input.dataset,
    ...(input.armId !== undefined ? { armId: input.armId } : {}),
    ...(input.routing !== undefined ? { routing: input.routing } : {}),
  };
}

/** The index-read accounting every history-backed result carries. */
function indexAccounting(index: IndexRead): Record<string, unknown> {
  return {
    indexPresent: index.present,
    runsRead: index.entries.length,
    // The three numbers that make "runsRead" honest.
    unparsedLines: index.unparsedLines,
    supersededRows: index.supersededRows,
    unusableRowCount: index.unusable.length,
    ...cappedField("unusableRows", index.unusable),
    ...(index.collapseFailed !== undefined ? { collapseFailed: index.collapseFailed } : {}),
    ...(index.unparsedLines > 0
      ? {
          unparsedLinesNote:
            "lines in index.jsonl that did not parse. The shared reader skips them by design; they are counted here because a run that was recorded and cannot be read is not a run that never happened.",
        }
      : {}),
  };
}

/**
 * Re-contain a run's recorded `outDir`.
 *
 * The index records an ABSOLUTE path written by whichever machine ran the
 * eval. A history copied between machines — or into a container — carries
 * paths that now point somewhere else entirely, so the path is made relative
 * to this workspace and refused if it leaves it.
 */
function runDirRelative(runId: string, outDir: string): Loaded<string> {
  if (typeof outDir !== "string" || outDir === "") {
    return fail("missing", `run ${runId} has no outDir recorded`);
  }
  const rel = path.isAbsolute(outDir) ? path.relative(process.cwd(), outDir) : outDir;
  if (rel === "" || rel.startsWith("..")) {
    return fail(
      "refused",
      `run ${runId} recorded its output at "${renderPath(outDir)}", outside this workspace — it was not opened`,
    );
  }
  return { ok: true, value: rel };
}

// ---------------------------------------------------------------------------
// EvalHistory
// ---------------------------------------------------------------------------

const evalHistorySchema = z.object({
  evalsDir: z
    .string()
    .optional()
    .describe(`where the run index lives; defaults to ${DEFAULT_EVALS_DIR}`),
  spec: z.string().optional().describe("only this spec's runs"),
  dataset: z
    .string()
    .optional()
    .describe(
      "only this dataset's runs; also matches a union dataset recorded as <name>+regressions@vN",
    ),
  runId: z
    .string()
    .optional()
    .describe(
      "drill into one run instead: its row, the segment it belongs to, and its failing samples",
    ),
  includePoints: z
    .boolean()
    .optional()
    .describe("list each run inside each segment (default true)"),
  maxBytes: z.number().int().min(1).optional().describe("cap on index.jsonl bytes"),
});

export const evalHistory: RegisteredTool = buildTool({
  name: "EvalHistory",
  description:
    "Read the recorded eval runs and return each lineage's trend, CUT wherever the measuring instrument changed. Use before quoting an eval trend or deciding a suite is improving: runs record the dataset, graders and judge they were measured with, and a first-to-last delta drawn across a graders rewrite compares numbers that were never comparable. Every segment reports its own delta in percentage points, every cut says which hash changed, and a join whose comparability could not be verified is marked instead of assumed. Reads only; runs nothing.",
  inputSchema: evalHistorySchema,
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const dirRel = input.evalsDir ?? DEFAULT_EVALS_DIR;
    const index = readIndex("EvalHistory", dirRel, input.maxBytes ?? LIMITS.indexBytes);
    if (!index.ok) return refusal(index);
    const pins = readPins(index.value.dir, dirRel);
    const pinIds = pins.ok ? pinnedRunIds(pins.value.file) : new Set<string>();

    const all = index.value.entries;
    let rows: ReadonlyArray<RunIndexEntry> = all;
    if (input.spec !== undefined) rows = rows.filter((e) => e.specName === input.spec);
    if (input.dataset !== undefined) {
      const filter = input.dataset;
      rows = rows.filter((e) => datasetFilterMatches(filter, e.datasetName));
    }

    const base = {
      evalsDir: dirRel,
      ...indexAccounting(index.value),
      // A malformed baselines.json does not stop a history listing, but it
      // does mean no run can be marked as the pinned baseline — which would
      // otherwise read as "nothing is pinned".
      ...(pins.ok
        ? { baselinesPresent: pins.value.present }
        : { baselinesUnreadable: pins.message }),
    };

    if (input.runId !== undefined) {
      const row = all.find((e) => e.runId === input.runId);
      if (row === undefined) {
        return json({
          ...base,
          ok: false,
          code: "missing",
          error: `no run "${renderPath(input.runId)}" in this index`,
          ...cappedField(
            "knownRunIds",
            all.map((e) => e.runId),
            20,
          ),
        });
      }
      return json({ ...base, ok: true, run: await drillDown(row, all, pinIds) });
    }

    const folds = foldLineages(rows, pinIds);
    return json({
      ...base,
      ok: true,
      matchedRuns: rows.length,
      ...(rows.length === 0 && all.length > 0
        ? {
            note: "no run matched the filter — the index is not empty",
            ...cappedField(
              "availableSpecs",
              [...new Set(all.map((e) => e.specName))].sort(compareStrings),
              20,
            ),
            ...cappedField(
              "availableDatasets",
              [...new Set(all.map((e) => e.datasetName))].sort(compareStrings),
              20,
            ),
          }
        : {}),
      lineages: folds.map((f) => renderFold(f, input.includePoints !== false)),
    });
  },
});

function renderFold(fold: LineageFold, includePoints: boolean): Record<string, unknown> {
  return {
    key: fold.key,
    label: fold.label,
    specName: fold.specName,
    datasetName: fold.datasetName,
    ...(fold.armId !== undefined ? { armId: fold.armId } : {}),
    ...(fold.routing !== undefined ? { routing: fold.routing } : {}),
    runCount: fold.runCount,
    segmentCount: fold.segments.length,
    segments: fold.segments.map((s) => {
      const points = capped(s.points);
      return {
        index: s.index,
        runCount: s.runCount,
        comparability: s.comparability,
        instrument: s.instrument,
        ...(s.startedBy !== undefined ? { startedBy: s.startedBy } : {}),
        trend: s.trend,
        ...(s.trendUnavailable !== undefined ? { trendUnavailable: s.trendUnavailable } : {}),
        ...(s.excluded.length > 0 ? { excludedFromTrend: s.excluded } : {}),
        ...(s.unverifiedJoins.length > 0 ? cappedField("unverifiedJoins", s.unverifiedJoins) : {}),
        cost: s.cost,
        ...(s.notes.length > 0 ? { notes: s.notes } : {}),
        ...(includePoints
          ? {
              points: points.shown,
              ...(points.omitted > 0 ? { pointsOmitted: points.omitted } : {}),
            }
          : {}),
      };
    }),
    ...cappedField("boundaries", fold.boundaries),
    ...(fold.notes.length > 0 ? { notes: fold.notes } : {}),
  };
}

/** One run's row, where it sits in its lineage, and what failed in it. */
async function drillDown(
  row: RunIndexEntry,
  all: ReadonlyArray<RunIndexEntry>,
  pinIds: ReadonlySet<string>,
): Promise<Record<string, unknown>> {
  const key = keyOf(row);
  const sameLineage = all.filter((e) => keyOf(e) === key);
  const fold = foldLineages(sameLineage, pinIds)[0];
  const segment = fold?.segments.find((s) => s.points.some((p) => p.runId === row.runId));
  const samples = await failingSamples(row);
  return {
    row,
    lineageKey: key,
    ...(fold !== undefined ? { lineageLabel: fold.label, segmentCount: fold.segments.length } : {}),
    ...(segment !== undefined
      ? {
          segment: {
            index: segment.index,
            runCount: segment.runCount,
            comparability: segment.comparability,
            instrument: segment.instrument,
            trend: segment.trend,
          },
        }
      : {}),
    pinnedBaseline: pinIds.has(row.runId),
    ...samples,
  };
}

async function failingSamples(row: RunIndexEntry): Promise<Record<string, unknown>> {
  const rel = runDirRelative(row.runId, row.outDir);
  if (!rel.ok) return { samplesUnavailable: rel.message };
  const doc = readRunDoc("EvalHistory", rel.value, LIMITS.resultsBytes);
  if (!doc.ok) return { samplesUnavailable: doc.message };
  const failing: Array<Record<string, unknown>> = [];
  let abstained = 0;
  let errored = 0;
  for (const sample of doc.value.summary.samples ?? []) {
    const overall = sample?.grades?.overall;
    if (sample?.error !== undefined) errored += 1;
    if (overall?.abstained === true) {
      abstained += 1;
      // A3 — an abstention is not a failure: the judge declined to score, so
      // `passed: false` is a placeholder awaiting a human, and listing it
      // beside real failures is how a triage list grows work nobody caused.
      continue;
    }
    if (overall?.passed === true) continue;
    failing.push({
      sampleId: sample?.sampleId,
      score: overall?.score,
      ...(sample?.error !== undefined ? { error: String(sample.error).slice(0, 200) } : {}),
    });
  }
  const shown = capped(failing);
  return {
    failingSamples: shown.shown,
    ...(shown.omitted > 0 ? { failingSamplesOmitted: shown.omitted } : {}),
    failingCount: failing.length,
    abstainedCount: abstained,
    erroredCount: errored,
  };
}

// ---------------------------------------------------------------------------
// EvalAggregate
// ---------------------------------------------------------------------------

const evalAggregateSchema = z.object({
  run: z.string().optional().describe("path to the run directory, or to its results.json"),
  runId: z
    .string()
    .optional()
    .describe("a recorded run id to look up in the index instead of a path"),
  evalsDir: z
    .string()
    .optional()
    .describe(`index location for runId; defaults to ${DEFAULT_EVALS_DIR}`),
  sampleIds: z
    .array(z.string())
    .max(LIMITS.sampleIds)
    .optional()
    .describe("recompute over only these samples"),
  metadataKey: z
    .string()
    .optional()
    .describe("recompute over only the samples carrying this metadata key (a slice)"),
  metadataValue: z.string().optional().describe("with metadataKey, require this value"),
  maxBytes: z.number().int().min(1).optional().describe("cap on results.json bytes"),
});

export const evalAggregate: RegisteredTool = buildTool({
  name: "EvalAggregate",
  description:
    "Recompute an eval run's aggregates from its own samples — pass rate, mean score, latency percentiles, pass@k and pass^k — and add the interval a small sample deserves. Use to check a run's published numbers against its samples, or to get the figures for one slice of it (by sample id or metadata). The fold is the eval runner's own, so the answer matches what a re-run would report; pass@k and pass^k carry Wilson intervals because 3 of 5 is not 60%. Any sample the fold could not use is named, never dropped.",
  inputSchema: evalAggregateSchema,
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    if ((input.run === undefined) === (input.runId === undefined)) {
      return refusal({
        code: "bad-input",
        message: 'pass either "run" (a path) or "runId" (a recorded id), not both and not neither',
      });
    }
    let rel: string;
    let row: RunIndexEntry | undefined;
    if (input.runId !== undefined) {
      const dirRel = input.evalsDir ?? DEFAULT_EVALS_DIR;
      const index = readIndex("EvalAggregate", dirRel, LIMITS.indexBytes);
      if (!index.ok) return refusal(index);
      row = index.value.entries.find((e) => e.runId === input.runId);
      if (row === undefined) {
        return refusal({
          code: "missing",
          message: `no run "${renderPath(input.runId)}" in ${renderPath(dirRel)} — it may predate the index, or its line may be one of the ${index.value.unparsedLines} that did not parse`,
        });
      }
      const resolved = runDirRelative(row.runId, row.outDir);
      if (!resolved.ok) return refusal(resolved);
      rel = resolved.value;
    } else {
      rel = input.run as string;
    }

    const doc = readRunDoc("EvalAggregate", rel, input.maxBytes ?? LIMITS.resultsBytes);
    if (!doc.ok) return refusal(doc);

    const selection = {
      ...(input.sampleIds !== undefined ? { sampleIds: input.sampleIds } : {}),
      ...(input.metadataKey !== undefined ? { metadataKey: input.metadataKey } : {}),
      ...(input.metadataValue !== undefined ? { metadataValue: input.metadataValue } : {}),
    };
    let result: ReturnType<typeof recompute>;
    try {
      result = recompute(doc.value.summary, selection);
    } catch (err) {
      // `aggregate()` reads fields off every sample. The shape check ahead of
      // it covers the ones it dereferences unconditionally; anything else that
      // throws is reported as a refusal rather than crashing the tool.
      return refusal({
        code: "malformed",
        message: `"${renderPath(doc.value.rel)}" could not be re-aggregated: ${(err as Error).message}`,
      });
    }

    const subset = result.selection.filter !== undefined;
    const declared = subset
      ? undefined
      : compareDeclared(doc.value.summary, result.aggregates, result.complete);
    const drift = wilsonDisagreement(result.aggregates.passRateCI95, result.intervals.passRate);
    return json({
      ok: true,
      run: doc.value.rel,
      runId: doc.value.summary.runId ?? row?.runId,
      bytes: doc.value.bytes,
      sampleCount: result.sampleCount,
      aggregatedSamples: result.aggregatedSamples,
      complete: result.complete,
      selection: result.selection,
      ...(result.unusableSamples.length > 0
        ? {
            ...cappedField("unusableSamples", result.unusableSamples),
            unusableSampleCount: result.unusableSamples.length,
            unusableNote:
              "these samples were left out of the recomputation, so every rate below has a smaller denominator than the file's own",
          }
        : {}),
      aggregates: result.aggregates,
      // An empty selection folds to passRate 0, meanScore 0 — the same block a
      // run where everything failed produces. The two are opposite findings, so
      // the difference is stated rather than left to the reader.
      ...(result.aggregatedSamples === 0
        ? {
            emptySelection:
              "no sample was aggregated, so every figure below is the fold's zero, not a measurement: a 0 pass rate here means nothing was selected, not that everything failed",
          }
        : {}),
      intervals: result.intervals,
      ...(declared === undefined
        ? {
            // A subset is EXPECTED to differ from the whole run's published
            // figures, so no verdict is reached rather than a false one.
            declaredAgrees: null,
            declaredComparison:
              "skipped: this is a subset of the run, and a subset is expected to differ from the run's published aggregates",
          }
        : {
            declaredDeltas: declared.deltas,
            // TRI-STATE. `null` is "could not be determined" — no declared
            // block, or nothing in it this recomputation could check. It used
            // to be reported as `true`, so a results.json that published no
            // figures at all answered "yes, the published figures agree".
            declaredAgrees: declared.agrees,
            declaredFieldsCompared: declared.compared,
            ...(declared.uncomparable.length > 0
              ? { declaredUncomparableFields: declared.uncomparable }
              : {}),
            ...(declared.unavailableReason !== undefined
              ? { declaredComparisonUnavailable: declared.unavailableReason }
              : {}),
            ...(declared.agrees === false
              ? {
                  declaredNote:
                    "the file's own aggregate block disagrees with its samples — the published figures and the data behind them describe different runs",
                }
              : {}),
          }),
      ...(drift !== undefined ? { intervalDrift: drift } : {}),
    });
  },
});

// ---------------------------------------------------------------------------
// EvalBaselinePin
// ---------------------------------------------------------------------------

const evalBaselinePinSchema = z.object({
  action: z.enum(["show", "set", "clear"]).describe("show the pin, move it to a run, or remove it"),
  spec: z.string().min(1).describe("the spec name the lineage is keyed on"),
  dataset: z.string().min(1).describe("the dataset name the lineage is keyed on"),
  armId: z.string().optional().describe("for a per-arm lineage: the arm the runs measured"),
  routing: z
    .string()
    .optional()
    .describe('how the runs routed: "static", "as-declared" or "candidate:<arm>"'),
  runId: z.string().optional().describe("for set: the recorded run to pin"),
  evalsDir: z.string().optional().describe(`defaults to ${DEFAULT_EVALS_DIR}`),
  dryRun: z
    .boolean()
    .optional()
    .describe("resolve and check everything, report what would be written, write nothing"),
});

export const evalBaselinePin: RegisteredTool = buildTool({
  name: "EvalBaselinePin",
  description:
    "Show, move or clear the pinned baseline run a lineage's regression gate compares against. Use when a gate needs re-baselining after a deliberate change, or to check what a lineage is being held to — including the case that matters most, a lineage with NO pin, where the gate passes because there is nothing to fail against. The lineage comes from the run's own recorded columns, so pinning can never drop one arm's run onto another arm's key; a partial, budget-aborted run is refused outright; and dryRun runs the same checks and reports the exact pin it would write.",
  inputSchema: evalBaselinePinSchema,
  readOnly: false,
  destructive: true,
  concurrencySafe: false,
  execute: async (input) => {
    const routing = parseRouting(input.routing);
    if (!routing.ok) return refusal(routing);
    const lineage = lineageOf({
      spec: input.spec,
      dataset: input.dataset,
      ...(input.armId !== undefined ? { armId: input.armId } : {}),
      ...(routing.value !== undefined ? { routing: routing.value } : {}),
    });
    const dirRel = input.evalsDir ?? DEFAULT_EVALS_DIR;
    const index = readIndex("EvalBaselinePin", dirRel, LIMITS.indexBytes);
    if (!index.ok) return refusal(index);
    const pins = readPins(index.value.dir, dirRel);
    if (!pins.ok) {
      // Writing over a baselines.json that cannot be parsed would destroy
      // every pin in it, including the ones for lineages this call never
      // named. Reading it is also how `show` knows what is pinned.
      return refusal(pins);
    }
    const lookup = resolveBaseline(lineage, index.value.dir.real);
    const row =
      input.runId === undefined
        ? undefined
        : index.value.entries.find((e) => e.runId === input.runId);
    if (input.action === "set" && input.runId !== undefined && row === undefined) {
      return refusal({
        code: "missing",
        message: `no run "${renderPath(input.runId)}" in ${renderPath(dirRel)} — a pin copies its outDir and instrument hashes from that row, so an unrecorded run cannot be pinned`,
      });
    }

    const plan = planPin({
      action: input.action,
      lineage,
      lookup,
      baselines: pins.value.file,
      ...(row !== undefined ? { row } : {}),
      evalsDir: index.value.dir,
    });
    if (!plan.ok) return refusal(plan);

    const dryRun = input.dryRun === true;
    const committed = plan.value.changes && !dryRun && input.action !== "show";
    if (committed) commitPin(plan.value, pins.value.file, index.value.dir.real);

    const lineageRuns = index.value.entries.filter((e) => keyOf(e) === plan.value.key);
    // What this lineage is pinned to once the call returns — the state the
    // caller is left in, not the one it walked into.
    const pinnedAfter =
      input.action === "set" && committed
        ? plan.value.next
        : input.action === "clear" && committed
          ? undefined
          : plan.value.previous;
    return json({
      ok: true,
      action: input.action,
      dryRun,
      committed,
      key: plan.value.key,
      lineage: plan.value.label,
      // `pinned` is the pin this call FOUND; `pinnedAfter` is the one it
      // leaves. They differ on every committed set and clear, and reporting
      // only the first let a committed `clear` answer with the pin it had just
      // removed.
      pinned: plan.value.previous ?? null,
      pinnedAfter: pinnedAfter ?? null,
      ...(plan.value.next !== undefined
        ? { [committed ? "wrote" : "wouldWrite"]: plan.value.next }
        : {}),
      changes: plan.value.changes,
      // The siblings a naive single-row write would have clobbered, listed so
      // the caller can see they stayed put.
      ...cappedField("otherPinnedLineages", plan.value.siblingKeys),
      runsInLineage: lineageRuns.length,
      ...(plan.value.previous !== undefined
        ? {
            pinnedRunStillInIndex: lineageRuns.some((e) => e.runId === plan.value.previous?.runId),
          }
        : {}),
      // The state this call LEAVES the lineage in, not the one it found. A
      // dry-run `set` writes nothing, so the risk it reports is still the
      // risk that is actually there.
      vacuousGateRisk: pinnedAfter === undefined,
      warnings: plan.value.warnings,
      ...indexAccounting(index.value),
    });
  },
});

// ---------------------------------------------------------------------------
// EvalCoverage
// ---------------------------------------------------------------------------

const evalCoverageSchema = z.object({
  dataset: z.string().min(1).describe("the eval dataset JSONL to measure coverage against"),
  sessionsDir: z
    .string()
    .optional()
    .describe(`production session logs; defaults to ${DEFAULT_SESSIONS_DIR}`),
  sessions: z
    .union([z.number().int().min(1), z.literal("all")])
    .optional()
    .describe(
      `how many of the most recent sessions to read (default ${DEFAULT_COVERAGE_SESSIONS})`,
    ),
  spec: z.string().optional().describe("label the report with this spec name, and pick its run"),
  includeRunEvents: z
    .boolean()
    .optional()
    .describe("also count the tools the most recent recorded run really called (default true)"),
  evalsDir: z
    .string()
    .optional()
    .describe(`where to find that run; defaults to ${DEFAULT_EVALS_DIR}`),
});

export const evalCoverage: RegisteredTool = buildTool({
  name: "EvalCoverage",
  description:
    "Compare what production actually does against what the eval dataset exercises, and rank what is missing. Use before trusting a green eval: it builds tool-call, tool-sequence and compaction frequencies from the harness's session logs, intersects them with the dataset's expected_tools (plus the tools the last recorded run really called), and returns the gaps ranked by how much of production they cover — each with a confidence interval, because a gap seen in 3 of 5 sessions is not a 60% gap. Reading zero sessions is reported as a refusal, never as 'no gaps'.",
  inputSchema: evalCoverageSchema,
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const sessionsRel = input.sessionsDir ?? DEFAULT_SESSIONS_DIR;
    const want = input.sessions ?? DEFAULT_COVERAGE_SESSIONS;
    const loaded = loadSessions("EvalCoverage", sessionsRel, want, {
      maxFileBytes: LIMITS.sessionBytes,
      maxEventsPerFile: LIMITS.eventsPerSession,
      maxFiles: LIMITS.sessionFiles,
    });
    if (!loaded.ok) return refusal(loaded);
    if (loaded.value.sessions.length === 0) {
      // THE refusal this tool exists to make. With no production distribution
      // there is nothing to intersect, and the report's own words for that
      // would be "no coverage gaps" — the same sentence a fully covered
      // harness gets.
      return refusal({
        code: loaded.value.listingFailed !== undefined ? "unreadable" : "missing",
        message:
          // An unlistable directory produces the same zero names an EMPTY one
          // does. Reporting it as "no session logs" would name the wrong
          // problem and send the reader to write sessions that are already
          // there.
          loaded.value.listingFailed !== undefined
            ? `"${renderPath(sessionsRel)}" could not be listed: ${loaded.value.listingFailed} — this is not "no sessions were recorded", and coverage over zero sessions would read as full coverage`
            : loaded.value.available === 0
              ? `no session logs under "${renderPath(sessionsRel)}" — with no record of what production does there is nothing to compare the dataset against, and an empty comparison would read as full coverage`
              : `all ${loaded.value.available} session file(s) under "${renderPath(sessionsRel)}" failed to read (${loaded.value.skipped[0]?.reason ?? "unknown"}) — coverage over zero sessions would read as full coverage`,
      });
    }

    const dataset = loadDataset("EvalCoverage", input.dataset, {
      maxBytes: LIMITS.datasetBytes,
      maxRows: LIMITS.datasetRows,
    });
    if (!dataset.ok) return refusal(dataset);

    const runEvents =
      input.includeRunEvents === false
        ? undefined
        : mostRecentRunEvents(input.evalsDir ?? DEFAULT_EVALS_DIR, input.spec);

    const prod = buildProdBehavior(
      loaded.value.sessions.map((s) => ({ sessionId: s.sessionId, events: s.events })),
    );
    const evalCov = buildEvalCoverage(dataset.value.samples, runEvents?.texts ?? []);
    let report: ReturnType<typeof computeCoverage>;
    try {
      report = computeCoverage({
        prod,
        evalCov,
        ...(input.spec !== undefined ? { specName: input.spec } : {}),
        datasetName: input.dataset,
      });
    } catch (err) {
      if (err instanceof EvalCoverageError)
        return refusal({ code: "bad-input", message: err.message });
      throw err;
    }

    const sessionCount = prod.sessionCount;
    const gaps = report.gaps.map((gap) => {
      // The gap's share of production is successes/trials with exact integer
      // counts, so it gets a real interval rather than a rounded percentage.
      const interval = statsKernel.wilsonScoreInterval(gap.sessions, sessionCount);
      return {
        kind: gap.kind,
        subject: gap.subject,
        sessions: gap.sessions,
        of: sessionCount,
        fraction: gap.fraction,
        ...(interval !== null
          ? { share: { lower: interval.lower, upper: interval.upper, width: interval.width } }
          : {}),
        detail: gap.detail,
      };
    });
    const shownGaps = capped(gaps);
    return json({
      ok: true,
      sessionsScanned: sessionCount,
      sessionsAvailable: loaded.value.available,
      dataset: input.dataset,
      sampleCount: evalCov.sampleCount,
      samplesWithoutExpectedTools: dataset.value.withoutExpectedTools,
      hasRunEvents: evalCov.hasRunEvents,
      ...(runEvents !== undefined
        ? {
            runEvents:
              runEvents.error !== undefined
                ? { available: false, reason: runEvents.error }
                : {
                    available: true,
                    runId: runEvents.runId,
                    sampleDirs: runEvents.sampleDirs,
                    ...(runEvents.unreadable.length > 0
                      ? cappedField("unreadable", runEvents.unreadable)
                      : {}),
                    ...(runEvents.orderedByPosition !== undefined
                      ? { orderedByPosition: runEvents.orderedByPosition }
                      : {}),
                  },
          }
        : { runEvents: { available: false, reason: "not requested" } }),
      gapCount: gaps.length,
      gaps: shownGaps.shown,
      ...(shownGaps.omitted > 0 ? { gapsOmitted: shownGaps.omitted } : {}),
      ...cappedField("inputThemes", report.inputThemes, 20),
      // Everything below is why the numbers above might be wrong.
      readAccounting: {
        ...cappedField("sessionsSkipped", loaded.value.skipped),
        sessionsSkippedCount: loaded.value.skipped.length,
        malformedSessionLines: loaded.value.malformedLines,
        sessionsTruncated: loaded.value.truncated,
        // The message names the cap that ACTUALLY applied. It used to quote
        // the tool ceiling whichever cap ran, so a caller who asked for 2 of 4
        // sessions was told 2,000 files had been opened.
        ...(loaded.value.capApplied !== undefined
          ? {
              sessionFileCapApplied:
                loaded.value.capApplied.source === "requested"
                  ? `only the ${loaded.value.capApplied.limit} most recent session files were opened, as requested — the fractions below are over those, not over all ${loaded.value.available}`
                  : `only the ${loaded.value.capApplied.limit} most recent session files were opened (this tool's ceiling) — the fractions below are over those, not over all ${loaded.value.available}`,
            }
          : {}),
        ...(loaded.value.unorderable.length > 0
          ? cappedField("sessionsWithUnknownMtime", loaded.value.unorderable)
          : {}),
        ...cappedField("datasetMalformedLines", dataset.value.malformedLines, 20),
        ...cappedField("datasetNonObjectLines", dataset.value.nonObjectLines, 20),
        datasetTruncated: dataset.value.truncated,
      },
      ...(evalCov.hasExpectedTools
        ? {}
        : {
            note: "no dataset sample declares expected_tools, so dataset-side coverage rests entirely on what the last recorded run happened to call",
          }),
    });
  },
});

type RunEventsSummary = {
  readonly runId?: string;
  readonly texts: ReadonlyArray<string>;
  readonly sampleDirs?: number;
  readonly unreadable: ReadonlyArray<string>;
  readonly error?: string;
  /** Set when the chosen run's `ts` could not be parsed, so "most recent" was
   *  decided by position in the log rather than by time. */
  readonly orderedByPosition?: string;
};

/** The newest recorded run's per-sample events, or the reason there are none. */
function mostRecentRunEvents(dirRel: string, spec: string | undefined): RunEventsSummary {
  const index = readIndex("EvalCoverage", dirRel, LIMITS.indexBytes);
  if (!index.ok) return { texts: [], unreadable: [], error: index.message };
  const rows = index.value.entries.filter((e) => spec === undefined || e.specName === spec);
  // NOT `rows[rows.length - 1]`. The index is append-only but not sorted by
  // ts: `--resume` appends a superseding row for an OLDER run, and an index
  // merged across machines interleaves two clocks. Taking the last line and
  // calling it "the most recent recorded run" reads the wrong run's tool calls
  // and labels them with the right run's promise.
  const newest = newestByTs(rows);
  const row = newest.row;
  if (row === undefined) {
    return {
      texts: [],
      unreadable: [],
      error:
        index.value.entries.length === 0
          ? `no recorded runs in ${renderPath(dirRel)}`
          : `no recorded run for spec "${renderPath(spec ?? "")}"`,
    };
  }
  const rel = runDirRelative(row.runId, row.outDir);
  if (!rel.ok) return { texts: [], unreadable: [], error: rel.message };
  const events = loadRunEvents("EvalCoverage", row.runId, rel.value, {
    maxSampleDirs: LIMITS.runSampleDirs,
    maxFileBytes: LIMITS.runEventBytes,
  });
  if (!events.ok) return { texts: [], unreadable: [], error: events.message };
  return {
    runId: events.value.runId,
    texts: events.value.texts,
    sampleDirs: events.value.sampleDirs,
    unreadable: events.value.unreadable,
    ...(newest.tsUnparseable
      ? {
          orderedByPosition: `run ${row.runId} has an unparseable ts ("${renderPath(String(row.ts))}"), so "most recent" here means last in the log, not latest in time`,
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// GraderMetaTest
// ---------------------------------------------------------------------------

const graderMetaTestSchema = z.object({
  graders: z.string().optional().describe("path to the graders YAML"),
  gradersYaml: z.string().optional().describe("the graders YAML inline instead"),
  golden: z.string().optional().describe("path to the human-labelled verdicts JSONL"),
  goldenJsonl: z.string().optional().describe("the golden verdicts inline instead"),
  minAgreement: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("fail the gate when a tested grader agrees with the humans less often than this"),
});

export const graderMetaTest: RegisteredTool = buildTool({
  name: "GraderMetaTest",
  description:
    "Replay a graders config over verdicts a human already labelled and report how far the grader is from them. Use before trusting a grader to gate anything: it returns agreement with a Wilson interval, Cohen's kappa WITH the confusion matrix and both raters' marginals beside it (kappa collapses on a lopsided golden set, and the bare number gets misread as a broken grader), and names the false positives — the ones that let a regression through. Deterministic graders only: judge and registry entries are skipped with the reason, and an agreement floor that could not be evaluated comes back as unknown, never as a pass.",
  inputSchema: graderMetaTestSchema,
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const yaml = oneSource(
      "GraderMetaTest",
      "graders",
      input.graders,
      input.gradersYaml,
      LIMITS.gradersBytes,
    );
    if (!yaml.ok) return refusal(yaml);
    const goldenText = oneSource(
      "GraderMetaTest",
      "golden",
      input.golden,
      input.goldenJsonl,
      LIMITS.goldenBytes,
    );
    if (!goldenText.ok) return refusal(goldenText);

    let goldens: ReturnType<typeof parseGoldenVerdicts>;
    try {
      goldens = parseGoldenVerdicts(goldenText.value);
    } catch (err) {
      if (err instanceof GradersTestError)
        return refusal({ code: "bad-input", message: err.message });
      throw err;
    }
    if (goldens.length > LIMITS.goldens) {
      return refusal({
        code: "too-large",
        message: `${goldens.length} golden verdicts is over this tool's ${LIMITS.goldens} limit — split the file`,
      });
    }

    let ran: Awaited<ReturnType<typeof runMetaTest>>;
    try {
      ran = await runMetaTest(yaml.value, goldens, {
        maxGraders: LIMITS.graders,
        maxReplays: LIMITS.replays,
      });
    } catch (err) {
      // `parseGradersConfig` throws a GraderError (a CrewhausError) on bad
      // YAML or a bad grader entry; `resolveTestGraders` throws its own on an
      // unresolvable one. Both are the caller's input, not a crash.
      if (err instanceof GradersTestError || err instanceof CrewhausError) {
        return refusal({ code: "bad-input", message: err.message });
      }
      throw err;
    }
    if (!ran.ok) return refusal(ran);
    const run = ran.value;
    const replays = run.tested.length * goldens.length;
    const gate = gateAgreement(run.tested, input.minAgreement, belowFloor);

    return json({
      ok: true,
      goldenCount: goldens.length,
      testedCount: run.tested.length,
      skippedCount: run.skipped.length,
      replays,
      graders: run.tested.map((t) => ({
        name: t.report.name,
        kind: t.report.kind,
        total: t.report.total,
        graded: t.report.graded,
        agreements: t.report.agreements,
        agreementRate: t.report.agreementRate,
        ...(t.agreementInterval !== undefined
          ? { agreementInterval: t.agreementInterval }
          : { agreementIntervalUnavailable: t.agreementIntervalUnavailable }),
        kappa: t.report.kappa,
        kappaDetail: t.kappaDetail,
        confusion: t.confusion,
        marginals: t.marginals,
        ...(t.marginals.lopsided
          ? {
              marginalsNote: `${
                t.marginals.humanPassRate >= 0.9 || t.marginals.humanPassRate <= 0.1
                  ? "the human labels are lopsided"
                  : "the grader's own labels are lopsided"
              }, so chance agreement is close to observed agreement and kappa reads low for reasons that are about the label distribution, not necessarily about how well the grader tracks the humans`,
            }
          : {}),
        falsePositives: t.report.falsePositives,
        falseNegatives: t.report.falseNegatives,
        abstained: t.report.abstained,
        errors: t.report.errors,
        ...(t.report.scoreMae !== undefined ? { scoreMae: t.report.scoreMae } : {}),
        ...(t.foldDisagreement !== undefined ? { foldDisagreement: t.foldDisagreement } : {}),
      })),
      skipped: run.skipped,
      ...(gate !== undefined ? { gate } : {}),
      ...(run.tested.length === 0
        ? {
            note: "no grader in this config can be replayed offline — every entry was a judge or a registry grader",
          }
        : {}),
    });
  },
});

/** Exactly one of a path and an inline string, read and size-checked. */
function oneSource(
  toolName: string,
  label: string,
  filePath: string | undefined,
  inline: string | undefined,
  maxBytes: number,
): Loaded<string> {
  if (filePath !== undefined && inline !== undefined) {
    return fail("bad-input", `${label}: pass either the path or the inline text, not both`);
  }
  if (inline !== undefined) {
    const bytes = Buffer.byteLength(inline, "utf8");
    if (bytes > maxBytes) {
      return fail(
        "too-large",
        `${label}: inline text is ${bytes} bytes, over the ${maxBytes} limit`,
      );
    }
    return { ok: true, value: inline };
  }
  if (filePath !== undefined) {
    const read = readContained(toolName, filePath, maxBytes);
    return read.ok ? { ok: true, value: read.value.text } : read;
  }
  return fail("bad-input", `${label}: pass a path or the text inline`);
}

/** Every tool this package registers, in the order a catalog should list them. */
export const EVALOPS_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  evalAggregate,
  evalBaselinePin,
  evalCoverage,
  evalHistory,
  graderMetaTest,
]);
