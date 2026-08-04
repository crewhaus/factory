/**
 * M3 · EVALS — the quality lab: the typed launcher, matrix runs, CI suites,
 * trends, the sample-size planner, judge calibration, grader tooling,
 * redteam, coverage, the drift sentinel, voice replays, the optimizer, the
 * flywheel, experiments, and the annotation → distill join.
 *
 * The M1/M2 read side (`evals.ts`, `actions.ts`'s baseline pin) stays where
 * it is; this module is everything around it. It also carries the small
 * read helpers `data-ops.ts` and `feedback-ops.ts` share, so the three
 * modules of this area probe the harness tree exactly one way.
 *
 * ---------------------------------------------------------------------------
 * WHAT AN EVAL CONSOLE GETS WRONG IF IT IS NOT CAREFUL
 * ---------------------------------------------------------------------------
 *   - PARTIAL RUNS ARE NOT REGRESSIONS. A run that ended early renders
 *     deflated and must never be charted as a score drop. Replayed runs are
 *     badged not-live. `readRunIndexLatest` collapses resumed runs — read
 *     through it, not the raw index.
 *   - DATASET FILTERS ARE UNION-AWARE. {@link datasetFilterMatches} makes
 *     `smoke` match `smoke+regressions@vX`; a naive equality filter silently
 *     hides every regression-unioned run.
 *   - MATRIX CELLS LIVE OUTSIDE RUN HISTORY. They are `<out>/<slug>/` dirs,
 *     not index rows. {@link classifyCellError} classes are ACTIONABLE
 *     states: billing ("add credits" — a real out-of-funds 429 is NOT
 *     retryable), systemic ("check model + credentials"), transient (offer
 *     Retry).
 *   - JUDGE SPEND OFTEN DOMINATES. Trends must separate `agentCostUsd` from
 *     `judgeCostUsd`; one blended number hides where the money went.
 *   - THE BASELINE'S LINEAGE WARNINGS ARE UI STATES. specSource name
 *     collision, gradersHash/judgeModel instrument change, and dataset
 *     keyset change are first-class banners, not buried stderr.
 *   - THE TEST SPLIT IS LOCKED. `--allow-test-split` is a visibly gated
 *     release-flow gesture with a burn count, never a convenience flag.
 *   - SENTINEL ATTRIBUTION IS CONDITIONAL. A flip is provider drift ONLY
 *     when specHash + datasetHash + gradersHash + judgeModel all match the
 *     frozen baseline. Otherwise say what changed instead.
 *   - THE FLYWHEEL'S DATASET PRECEDENCE IS A TRAP: a conventional
 *     `eval/dataset.jsonl` SHADOWS `registry:<spec>-ratings`. Warn on it.
 *
 * Every run here is WORK, so every run goes through the job queue with argv
 * built from this module's closed vocabulary (`jobArg` per interpolated
 * value). Live progress is the `[eval]` stdout block streamed through the
 * existing run feed — M3 adds no second streaming mechanism.
 *
 * Implementation reuses `@crewhaus/eval-report`; suites/optimizer/redteam/
 * coverage artifacts are read from their out-dirs with the same caps and
 * containment checks as every other reader here.
 */
import { appendFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createFileBackedRegistry } from "@crewhaus/dataset-registry";
import {
  type RunIndexEntry,
  buildTrends,
  readBaselines,
  readRunIndexLatest,
} from "@crewhaus/eval-report";
import { buildFeedbackRecord } from "@crewhaus/feedback-distill";
import { MAX_JSONL_LINES, MAX_TEXT_BYTES, SAFE_SEGMENT_RE } from "./constants";
import { HttpError } from "./http";
import { readJsonlCapped, readTextCapped } from "./jsonl";
import type { M3Context, M3Handler } from "./m3";
import { jobArg, requireString } from "./m3";
import { maskText } from "./mask";

// ---------------------------------------------------------------------------
// The read envelope + the tolerant filesystem probes this area shares
// ---------------------------------------------------------------------------

/**
 * The three fields EVERY M3 read answers. They are the arguments the
 * console's empty state already takes: this whole surface is full of screens
 * whose NORMAL state is empty (a harness with no redteam runs, no optimizer
 * runs, no experiments), and "nothing yet, run `crewhaus …` to create it" is
 * the only honest way to paint that.
 */
export type M3ReadBase = {
  readonly present: boolean;
  readonly note: string | null;
  readonly verb: string | null;
};

/** Nothing on disk (yet) — say why, and name the verb that would create it. */
export function absent(note: string, verb: string | null = null): M3ReadBase {
  return { present: false, note, verb };
}

/** Something IS on disk. `note` stays available for a caveat that survives
 *  presence (a truncated read, a shape the manager only partly understands). */
export function found(note: string | null = null, verb: string | null = null): M3ReadBase {
  return { present: true, note, verb };
}

/**
 * `ctx.contain` without the throw. Probing a path that may not exist is the
 * common case on this surface, and a 400 for "you have no optimizer runs" is
 * a lie. Containment itself is NOT relaxed — an escaping path yields
 * undefined and the caller reads nothing.
 */
export function safeContain(ctx: M3Context, segments: readonly string[]): string | undefined {
  try {
    return ctx.contain(segments);
  } catch {
    return undefined;
  }
}

/** Directory entry names, shape-filtered. The name is all a listing gives —
 *  every subsequent read re-contains it, because a name can be a symlink. */
export function listNames(dir: string | undefined): string[] {
  if (dir === undefined) return [];
  try {
    return readdirSync(dir)
      .filter((name) => SAFE_SEGMENT_RE.test(name))
      .sort();
  } catch {
    return [];
  }
}

/** True when the contained path is a directory (absence is not an error). */
export function isDirAt(path: string | undefined): boolean {
  if (path === undefined) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when the contained path is a regular file. */
export function isFileAt(path: string | undefined): boolean {
  if (path === undefined) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Parse a JSON file under the text cap. Absent/torn/oversized → undefined. */
export function readJsonAt(path: string | undefined): unknown {
  if (path === undefined) return undefined;
  const { text } = readTextCapped(path, MAX_TEXT_BYTES);
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Read one harness-relative JSON file, contained per file. */
export function readJson(ctx: M3Context, segments: readonly string[]): unknown {
  return readJsonAt(safeContain(ctx, segments));
}

/** Narrow an unknown to a plain object (never an array). */
export function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** ISO timestamp for a file's mtime — the only "when" an artifact tree that
 *  records no timestamp of its own can honestly report. */
export function mtimeIso(path: string | undefined): string | null {
  if (path === undefined) return null;
  try {
    return new Date(statSync(path).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

/** A capped, masked prose read (`SKILL.md`, `LESSONS.md`, a patched spec). */
export function readProse(
  ctx: M3Context,
  segments: readonly string[],
): { text: string; truncated: boolean } | undefined {
  const path = safeContain(ctx, segments);
  if (path === undefined || !isFileAt(path)) return undefined;
  const { text, truncated } = readTextCapped(path, MAX_TEXT_BYTES);
  return { text: maskText(text), truncated };
}

/** Wilson 95% interval on a success rate. Pure; `undefined` when n = 0. */
export function wilson95(successes: number, n: number): [number, number] | undefined {
  if (n <= 0) return undefined;
  const z = 1.959_963_984_540_054;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const lo = (centre - spread) / denom;
  const hi = (centre + spread) / denom;
  return [Math.max(0, lo), Math.min(1, hi)];
}

// ---------------------------------------------------------------------------
// Eval-specific pure rules
// ---------------------------------------------------------------------------

/**
 * Does a run's recorded `datasetName` belong to the filter the operator
 * typed? Exact, or continued by `+` — the regression UNION suffix a gated
 * run records (`smoke+regressions@v3`). A naive equality filter hides every
 * regression-unioned run, which is precisely the set an operator filtering
 * for "smoke" most wants to see.
 */
export function datasetFilterMatches(filter: string, datasetName: string): boolean {
  return datasetName === filter || datasetName.startsWith(`${filter}+`);
}

/** How an all-errored matrix cell failed, from its error text alone. */
export type CellErrorKind = "billing" | "systemic" | "transient" | "unknown";

/**
 * Classify a cell's error string. ORDER MATTERS and is the actionable part:
 * BILLING first, because a real out-of-funds arrives as a 429 ("you exceeded
 * your current quota") that is NOT a retryable rate limit — a console that
 * offered Retry there would burn an operator's afternoon. Then SYSTEMIC
 * (auth / config / unknown model — deterministic even when the message also
 * mentions a retryable word), then TRANSIENT.
 */
export function classifyCellError(message: string): CellErrorKind {
  const m = message.toLowerCase();
  if (
    /\b402\b|insufficient[\s_-]*quota|exceeded your (?:current )?quota|quota exceeded|billing details|check your plan|credit balance|payment required|resource[\s_-]*(?:has been )?exhausted|resource_exhausted|servicequotaexceeded|service quota exceeded/.test(
      m,
    )
  ) {
    return "billing";
  }
  if (
    /\b40[13]\b|invalid[\s_-]*(?:x-)?api[\s_-]*key|unauthor|forbidden|authentication|permission denied|\b400\b|invalid[\s_-]*request/.test(
      m,
    ) ||
    /\b404\b|not found|unknown model|no such model|does not exist|unsupported model|invalid model/.test(
      m,
    )
  ) {
    return "systemic";
  }
  if (
    /\b429\b|\b529\b|\b5\d\d\b|rate[\s_-]*limit|too many requests|overloaded|service unavailable|bad gateway|gateway timeout|timed?[\s_-]*out|timeout|econnreset|etimedout|eai_again|socket hang up|temporarily|try again/.test(
      m,
    )
  ) {
    return "transient";
  }
  return "unknown";
}

export type CellCrash = {
  readonly kind: CellErrorKind;
  readonly message: string;
  /** The remedy the console turns into a button. */
  readonly remedy: string;
  /** False for billing AND systemic: re-running cannot change the answer. */
  readonly retryable: boolean;
};

/** The classified crash beside the remedy it implies. */
export function describeCellCrash(message: string): CellCrash {
  const kind = classifyCellError(message);
  switch (kind) {
    case "billing":
      return {
        kind,
        message,
        remedy: "add credits or raise the account quota — re-running will not help",
        retryable: false,
      };
    case "systemic":
      return {
        kind,
        message,
        remedy: "check the model id and the credentials — re-running will not help",
        retryable: false,
      };
    case "transient":
      return {
        kind,
        message,
        remedy: "a provider blip — re-run this cell to confirm",
        retryable: true,
      };
    default:
      return {
        kind,
        message,
        remedy: "unclassified — open the cell's run directory for the raw error",
        retryable: true,
      };
  }
}

const evalsSegments = (...rest: string[]): string[] => [".crewhaus", "evals", ...rest];

/** Run-history rows with resumed runs collapsed. Never the raw index: an
 *  N-times-resumed run occupies N+1 lines, and every figure derived from the
 *  raw log counts it N+1 times with its truncated early pass rates dragging
 *  the average down. */
function runIndex(ctx: M3Context): RunIndexEntry[] {
  const dir = safeContain(ctx, evalsSegments());
  if (dir === undefined) return [];
  try {
    return readRunIndexLatest(dir);
  } catch {
    return [];
  }
}

function pinnedRunIds(ctx: M3Context): Set<string> {
  const dir = safeContain(ctx, evalsSegments());
  if (dir === undefined) return new Set();
  try {
    return new Set(Object.values(readBaselines(dir)).map((b) => b.runId));
  } catch {
    return new Set();
  }
}

const specNameOf = (ctx: M3Context): string => ctx.entry?.specName ?? "spec";

// ---------------------------------------------------------------------------
// The launcher
// ---------------------------------------------------------------------------

/** The eval launcher's closed flag vocabulary. Nothing outside this record
 *  can reach a command line, and every interpolated value is `jobArg`-shaped
 *  before it gets there. */
type LaunchPlan = {
  readonly argv: readonly string[];
  readonly warnings: readonly string[];
};

function positiveInt(body: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new HttpError(400, `"${key}" must be a positive integer`);
  }
  return value;
}

function positiveNumber(body: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new HttpError(400, `"${key}" must be a positive number`);
  }
  return value;
}

/**
 * Detect a run directory that can be RESUMED: `run.json` exists (the run
 * started and snapshotted its config) but at least one sample directory has
 * no `grades.json` (it never finished). Offering resume matters because a
 * resumed run keeps its original id — the alternative is paying for the
 * completed samples twice.
 */
function resumableRuns(ctx: M3Context): Array<{ runId: string; graded: number; samples: number }> {
  const out: Array<{ runId: string; graded: number; samples: number }> = [];
  for (const runId of listNames(safeContain(ctx, evalsSegments()))) {
    const runDir = safeContain(ctx, evalsSegments(runId));
    if (!isDirAt(runDir) || !isFileAt(safeContain(ctx, evalsSegments(runId, "run.json")))) continue;
    let samples = 0;
    let graded = 0;
    for (const sampleId of listNames(runDir)) {
      if (!isDirAt(safeContain(ctx, evalsSegments(runId, sampleId)))) continue;
      samples += 1;
      if (isFileAt(safeContain(ctx, evalsSegments(runId, sampleId, "grades.json")))) graded += 1;
    }
    if (samples > 0 && graded < samples) out.push({ runId, graded, samples });
  }
  return out;
}

/**
 * The dataset-precedence trap, checked wherever a launch or a loop resolves a
 * dataset: a conventional `eval/dataset.jsonl` on disk SILENTLY WINS over
 * `registry:<spec>-ratings`, so a flywheel that looks like it is training on
 * fresh ratings is really replaying a stale file.
 */
function datasetPrecedenceWarning(ctx: M3Context): string | null {
  if (!isFileAt(safeContain(ctx, ["eval", "dataset.jsonl"]))) return null;
  return `eval/dataset.jsonl exists — a conventional dataset file SHADOWS registry:${specNameOf(
    ctx,
  )}-ratings, so ratings-driven loops will silently replay that file instead. Pass an explicit dataset, or move the file.`;
}

function buildLaunchPlan(ctx: M3Context): LaunchPlan {
  const body = ctx.body;
  const argv: string[] = ["eval", "crewhaus.yaml"];
  const warnings: string[] = [];

  const dataset = body["dataset"];
  if (dataset !== undefined) argv.push("--dataset", jobArg("dataset", dataset));
  const graders = body["graders"];
  if (graders !== undefined) argv.push("--graders", jobArg("graders", graders));
  const slice = body["slice"];
  if (slice !== undefined) argv.push("--slice", jobArg("slice", slice));

  const models = body["models"];
  if (models !== undefined) {
    if (!Array.isArray(models) || models.length === 0) {
      throw new HttpError(400, '"models" must be a non-empty array of model ids');
    }
    argv.push("--models", models.map((m, i) => jobArg(`models[${i}]`, m)).join(","));
  }

  const repeats = positiveInt(body, "repeats");
  if (repeats !== undefined) argv.push("--repeats", String(repeats));
  const seed = positiveInt(body, "seed");
  if (seed !== undefined) argv.push("--seed", String(seed));
  const budgetUsd = positiveNumber(body, "budgetUsd");
  if (budgetUsd !== undefined) argv.push("--budget-usd", String(budgetUsd));
  const maxCostUsd = positiveNumber(body, "maxCostUsd");
  if (maxCostUsd !== undefined) argv.push("--max-cost-usd", String(maxCostUsd));

  if (body["gate"] === true) argv.push("--gate");
  if (body["resume"] === true) argv.push("--resume");

  // The locked holdout. `--allow-test-split` is not a convenience flag: it
  // SPENDS a version's held-out split, and every spend is counted in the
  // record's `releases[]`. The server refuses it unless the caller also sent
  // the release-flow confirmation, so a stray checkbox cannot burn a holdout.
  if (body["allowTestSplit"] === true) {
    if (body["releaseConfirm"] !== true) {
      throw new HttpError(
        409,
        'the test split is locked to the release flow — send "releaseConfirm": true alongside "allowTestSplit" to spend the holdout (the spend is recorded as a burn)',
      );
    }
    argv.push("--allow-test-split");
    warnings.push(
      "this run spends the locked test split — the burn is recorded in the dataset record's releases[]",
    );
  }

  const precedence = datasetPrecedenceWarning(ctx);
  if (precedence !== null && dataset === undefined) warnings.push(precedence);
  return { argv, warnings };
}

/**
 * `POST /api/h/:id/evals/run` — the typed eval launcher.
 *
 * Conventional paths default from the harness dir (`crewhaus.yaml`,
 * `eval/dataset.jsonl`, `eval/graders.yaml`), so the common launch carries no
 * flags at all. Live progress is the `[eval]` stdout block on the job's run
 * feed — this route returns the accepted job, never a stream of its own.
 */
export const evalLaunch: M3Handler = (ctx) => {
  const plan = buildLaunchPlan(ctx);
  const job = ctx.submitJob("eval", plan.argv);
  return {
    ...found("eval submitted to the job queue", "crewhaus eval"),
    job,
    argv: plan.argv,
    warnings: plan.warnings,
    resumable: resumableRuns(ctx),
  };
};

// ---------------------------------------------------------------------------
// Matrix runs
// ---------------------------------------------------------------------------

const MATRIX_DIR_RE = /^matrix_[0-9a-f]{4,32}$/;

type MatrixCellView = {
  readonly root: string;
  readonly cell: string;
  readonly model: string;
  readonly status: "ok" | "error";
  readonly passRate: number | null;
  readonly meanScore: number | null;
  readonly sampleCount: number | null;
  readonly p95LatencyMs: number | null;
  readonly costPer1kSamplesUsd: number | null;
  readonly crash: CellCrash | null;
};

function matrixRootNames(ctx: M3Context): string[] {
  return listNames(safeContain(ctx, evalsSegments())).filter(
    (name) => MATRIX_DIR_RE.test(name) && isDirAt(safeContain(ctx, evalsSegments(name))),
  );
}

function cellsFromMatrixJson(root: string, matrix: Record<string, unknown>): MatrixCellView[] {
  const rows = Array.isArray(matrix["rows"]) ? matrix["rows"] : [];
  const out: MatrixCellView[] = [];
  for (const raw of rows) {
    const row = asObject(raw);
    if (row === undefined) continue;
    const error = str(row["error"]);
    const status = row["status"] === "error" || error !== undefined ? "error" : "ok";
    out.push({
      root,
      cell: str(row["slug"]) ?? "(cell)",
      model: str(row["model"]) ?? "(model)",
      status,
      passRate: num(row["passRate"]) ?? null,
      meanScore: num(row["meanScore"]) ?? null,
      sampleCount: num(row["sampleCount"]) ?? null,
      p95LatencyMs: num(row["p95LatencyMs"]) ?? null,
      costPer1kSamplesUsd: num(row["costPer1kSamplesUsd"]) ?? null,
      crash: error !== undefined ? describeCellCrash(maskText(error)) : null,
    });
  }
  return out;
}

/**
 * `GET /api/h/:id/evals/matrix` — matrix runs.
 *
 * Matrix cells live OUTSIDE run history: `crewhaus eval --models` writes
 * `.crewhaus/evals/matrix_<hex>/{matrix.json, <slug>/}` and records nothing
 * in `index.jsonl`, so a reader that only knew the index would report "no
 * runs" for an afternoon of model comparison.
 */
export const evalMatrix: M3Handler = (ctx) => {
  const roots = matrixRootNames(ctx);
  const cells: MatrixCellView[] = [];
  const rootViews: Array<Record<string, unknown>> = [];
  for (const root of roots) {
    const matrix = asObject(readJson(ctx, evalsSegments(root, "matrix.json")));
    const rootCells =
      matrix === undefined
        ? listNames(safeContain(ctx, evalsSegments(root)))
            .filter((name) => isDirAt(safeContain(ctx, evalsSegments(root, name))))
            .map((slug): MatrixCellView => {
              const summary = asObject(readJson(ctx, evalsSegments(root, slug, "results.json")));
              const aggregates = asObject(summary?.["aggregates"]);
              return {
                root,
                cell: slug,
                model: str(asObject(summary?.["config"])?.["model"]) ?? slug,
                status: summary === undefined ? "error" : "ok",
                passRate: num(aggregates?.["passRate"]) ?? null,
                meanScore: num(aggregates?.["meanScore"]) ?? null,
                sampleCount: Array.isArray(summary?.["samples"])
                  ? (summary?.["samples"] as unknown[]).length
                  : null,
                p95LatencyMs: num(aggregates?.["p95LatencyMs"]) ?? null,
                costPer1kSamplesUsd: null,
                crash:
                  summary === undefined ? describeCellCrash("cell produced no results.json") : null,
              };
            })
        : cellsFromMatrixJson(root, matrix);
    cells.push(...rootCells);
    rootViews.push({
      root,
      generatedAt: str(matrix?.["generatedAt"]) ?? mtimeIso(safeContain(ctx, evalsSegments(root))),
      datasetName: str(matrix?.["datasetName"]) ?? null,
      best: asObject(matrix?.["best"]) ?? null,
      cellCount: rootCells.length,
      summarized: matrix !== undefined,
    });
  }
  if (roots.length === 0) {
    return { ...absent("no matrix runs recorded", "crewhaus eval --models"), cells, roots: [] };
  }
  return {
    ...found(null, "crewhaus eval --models"),
    cells,
    roots: rootViews,
    crashed: cells.filter((c) => c.crash !== null).length,
  };
};

/** `GET /api/h/:id/evals/matrix/:cell` — one cell's detail, for the
 *  cell-vs-cell diff the matrix view offers. */
export const evalMatrixCell: M3Handler = (ctx) => {
  const cell = ctx.params["cell"] as string;
  for (const root of matrixRootNames(ctx)) {
    const matrix = asObject(readJson(ctx, evalsSegments(root, "matrix.json")));
    const rawRows = matrix === undefined ? [] : matrix["rows"];
    const row = (Array.isArray(rawRows) ? rawRows : [])
      .map((r) => asObject(r))
      .find((r) => r !== undefined && str(r["slug"]) === cell);
    // A CRASHED cell has a row and no directory — that is the whole reason
    // the row exists. Looking only for the directory would hide exactly the
    // cells an operator opened this view to understand.
    const hasDir = isDirAt(safeContain(ctx, evalsSegments(root, cell)));
    if (!hasDir && row === undefined) continue;
    const summary = hasDir ? readJson(ctx, evalsSegments(root, cell, "results.json")) : undefined;
    const error = str(row?.["error"]);
    return {
      ...found(null, "crewhaus eval --models"),
      cell,
      root,
      model: str(row?.["model"]) ?? cell,
      row: row ?? null,
      summary: summary ?? null,
      crash: error !== undefined ? describeCellCrash(maskText(error)) : null,
    };
  }
  return {
    ...absent(`no matrix cell "${cell}" under any recorded matrix run`, "crewhaus eval --models"),
    cell,
    root: null,
    model: null,
    row: null,
    summary: null,
    crash: null,
  };
};

// ---------------------------------------------------------------------------
// CI suites
// ---------------------------------------------------------------------------

const SUITE_DIR_RE = /^suite_([a-z]+)_([0-9TZ]+)$/;

/**
 * `GET /api/h/:id/evals/suites` — CI suite results.
 *
 * From `.crewhaus/evals/suite_<tier>_<ts>/suite.json`. Two rules the renderer
 * must not soften: an entry's floors (`min_pass_rate` / `min_mean_score`) are
 * part of the verdict, and a PARTIAL entry always FAILS — a budget-aborted
 * entry's deflated pass rate is not evidence that the tier held.
 */
export const evalSuites: M3Handler = (ctx) => {
  const suites: Array<Record<string, unknown>> = [];
  for (const name of listNames(safeContain(ctx, evalsSegments()))) {
    const m = name.match(SUITE_DIR_RE);
    if (m === null) continue;
    const suite = asObject(readJson(ctx, evalsSegments(name, "suite.json")));
    if (suite === undefined) continue;
    const entries = (Array.isArray(suite["entries"]) ? suite["entries"] : [])
      .map((e) => asObject(e))
      .filter((e): e is Record<string, unknown> => e !== undefined)
      .map((entry) => {
        const partial = entry["partial"] === true;
        return {
          name: str(entry["name"]) ?? "(entry)",
          // A partial entry never passes, whatever the file recorded: its
          // aborted samples counted as errors, so its figures are deflated.
          passed: entry["passed"] === true && !partial,
          partial,
          passRate: num(asObject(entry["aggregates"])?.["passRate"]) ?? num(entry["passRate"]),
          meanScore: num(asObject(entry["aggregates"])?.["meanScore"]) ?? num(entry["meanScore"]),
          minPassRate: num(entry["min_pass_rate"]) ?? num(entry["minPassRate"]) ?? null,
          minMeanScore: num(entry["min_mean_score"]) ?? num(entry["minMeanScore"]) ?? null,
          failures: (Array.isArray(entry["failures"]) ? entry["failures"] : []).map((f) =>
            maskText(String(f)),
          ),
        };
      });
    suites.push({
      dir: name,
      tier: m[1] ?? "unknown",
      startedAt: str(suite["startedAt"]) ?? mtimeIso(safeContain(ctx, evalsSegments(name))),
      passed: suite["passed"] === true && entries.every((e) => e.passed),
      entries,
      partialEntries: entries.filter((e) => e.partial).length,
    });
  }
  suites.sort((a, b) => String(b["dir"]).localeCompare(String(a["dir"])));
  if (suites.length === 0) {
    return {
      ...absent("no CI suite runs recorded", "crewhaus eval suite <suite.yaml> --tier fast"),
      suites,
    };
  }
  return { ...found(null, "crewhaus eval suite <suite.yaml> --tier fast"), suites };
};

const SUITE_TIERS = new Set(["fast", "nightly", "release"]);

/** `POST /api/h/:id/evals/suites` — run a suite through the job queue. */
export const evalSuiteRun: M3Handler = (ctx) => {
  const suite = jobArg("suite", requireString(ctx.body, "suite"));
  const tier = requireString(ctx.body, "tier");
  if (!SUITE_TIERS.has(tier)) {
    throw new HttpError(400, '"tier" must be one of fast, nightly, release');
  }
  const argv = ["eval", "suite", suite, "--tier", tier];
  if (ctx.body["gate"] === true) argv.push("--gate");
  return {
    ...found(`suite ${suite} queued at tier ${tier}`, "crewhaus eval suite"),
    job: ctx.submitJob("eval suite", argv),
    argv,
  };
};

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------

/**
 * `GET /api/h/:id/evals/trends` — per-(spec, dataset) trends.
 *
 * Two separations that stop this panel from lying:
 *   1. PARTIAL runs are carried on the series (so the operator sees they
 *      happened) but excluded from the regression signal — a budget-aborted
 *      run's deflated pass rate is not a score drop.
 *   2. AGENT spend and JUDGE spend are reported apart. The judge frequently
 *      costs more than the thing it is judging, and one blended number hides
 *      exactly the line item an operator would cut.
 */
export const evalTrends: M3Handler = (ctx) => {
  const filter = ctx.query.get("dataset");
  const all = runIndex(ctx);
  const entries =
    filter === null || filter === ""
      ? all
      : all.filter((e) => datasetFilterMatches(filter, e.datasetName));
  const pinned = pinnedRunIds(ctx);
  const byRun = new Map(entries.map((e) => [e.runId, e]));
  const series = buildTrends(entries, { pinnedRunIds: pinned }).map((s) => {
    const points = s.points.map((p) => {
      const entry = byRun.get(p.runId);
      return {
        ...p,
        agentCostUsd: entry?.agentCostUsd ?? null,
        judgeCostUsd: entry?.judgeCostUsd ?? null,
        replayed: entry?.replayed === true,
      };
    });
    // The trend line is drawn over MEASURED runs only. A partial run stays in
    // `points` (it is a fact) but never sets the delta.
    const measured = points.filter((p) => p.partial !== true);
    const first = measured[0];
    const last = measured[measured.length - 1];
    return {
      specName: s.specName,
      datasetName: s.datasetName,
      points,
      measuredCount: measured.length,
      partialCount: points.length - measured.length,
      replayedCount: points.filter((p) => p.replayed).length,
      deltaPp:
        first !== undefined && last !== undefined && measured.length >= 2
          ? (last.passRate - first.passRate) * 100
          : null,
    };
  });
  const sum = (pick: (e: RunIndexEntry) => number | undefined): number =>
    entries.reduce((acc, e) => acc + (pick(e) ?? 0), 0);
  const agentUsd = sum((e) => e.agentCostUsd);
  const judgeUsd = sum((e) => e.judgeCostUsd);
  const total = agentUsd + judgeUsd;
  if (series.length === 0) {
    return {
      ...absent(
        filter === null || filter === ""
          ? "no eval runs recorded yet"
          : `no eval runs match dataset filter "${filter}" (the filter also matches regression unions like "${filter}+regressions@v1")`,
        "crewhaus eval",
      ),
      series,
      spend: { agentUsd: 0, judgeUsd: 0, judgeShare: null },
      filter: filter ?? null,
    };
  }
  return {
    ...found(null, "crewhaus eval"),
    series,
    spend: {
      agentUsd,
      judgeUsd,
      judgeShare: total > 0 ? judgeUsd / total : null,
    },
    filter: filter ?? null,
  };
};

// ---------------------------------------------------------------------------
// The sample-size planner
// ---------------------------------------------------------------------------

/**
 * `POST /api/h/:id/evals/plan` — the sample-size planner.
 *
 * Pure offline arithmetic ("how many samples to detect a 5-point delta"):
 * n ≈ z²·p(1−p)/e² for a proportion at the given confidence. No run, no job,
 * no filesystem write — which is why it can answer instantly and why a
 * budget-conscious operator can ask it before spending anything.
 */
export const evalPlan: M3Handler = (ctx) => {
  const targetDelta = ctx.body["targetDelta"];
  if (typeof targetDelta !== "number" || !(targetDelta > 0) || targetDelta >= 1) {
    throw new HttpError(400, '"targetDelta" must be a number in (0, 1) — e.g. 0.05 for 5 points');
  }
  const baseRateRaw = ctx.body["baseRate"];
  if (
    baseRateRaw !== undefined &&
    (typeof baseRateRaw !== "number" || baseRateRaw < 0 || baseRateRaw > 1)
  ) {
    throw new HttpError(400, '"baseRate" must be a number in [0, 1]');
  }
  const confidenceRaw = ctx.body["confidence"];
  if (
    confidenceRaw !== undefined &&
    (typeof confidenceRaw !== "number" || confidenceRaw <= 0.5 || confidenceRaw >= 1)
  ) {
    throw new HttpError(400, '"confidence" must be a number in (0.5, 1) — e.g. 0.95');
  }
  // Worst-case variance at p = 0.5 unless the operator knows their base rate:
  // planning with an optimistic p understates n, which is the failure mode
  // that produces an underpowered suite everyone then trusts.
  const baseRate = baseRateRaw ?? 0.5;
  const confidence = confidenceRaw ?? 0.95;
  const z = confidence >= 0.99 ? 2.575_829 : confidence >= 0.95 ? 1.959_964 : 1.644_854;
  const samples = Math.ceil((z * z * baseRate * (1 - baseRate)) / (targetDelta * targetDelta));
  return {
    ...found("offline arithmetic — nothing was run and nothing was written", "crewhaus eval plan"),
    targetDelta,
    baseRate,
    confidence,
    z,
    samples,
    formula: "n ≈ z²·p(1−p)/e²",
    caveat:
      baseRateRaw === undefined
        ? "planned at the worst-case p = 0.5; supply your measured base rate for a tighter n"
        : null,
  };
};

// ---------------------------------------------------------------------------
// Judge calibration + grader quality
// ---------------------------------------------------------------------------

/** `GET /api/h/:id/evals/judge` — judge calibration state. */
export const judgeCalibration: M3Handler = (ctx) => {
  const file = asObject(readJson(ctx, [".crewhaus", "judge-calibration.json"]));
  if (file === undefined) {
    return {
      ...absent(
        "no judge calibration recorded — llm_judge graders run at their built-in cut",
        "crewhaus judge calibrate --apply",
      ),
      calibration: null,
      specs: [],
    };
  }
  // The file is keyed by spec (a harness may hold several), so the panel
  // renders every cut it carries rather than guessing which one applies.
  const specs = Object.entries(file)
    .map(([key, value]) => ({ key, entry: asObject(value) }))
    .filter(
      (row): row is { key: string; entry: Record<string, unknown> } => row.entry !== undefined,
    )
    .map((row) => ({
      spec: row.key,
      cut: num(row.entry["minScore"]) ?? num(row.entry["cut"]) ?? null,
      judgeModel: str(row.entry["judgeModel"]) ?? null,
      calibratedAt: str(row.entry["calibratedAt"]) ?? str(row.entry["ts"]) ?? null,
      pairs: num(row.entry["pairs"]) ?? null,
      roc: asObject(row.entry["roc"]) ?? null,
    }));
  return {
    ...found(null, "crewhaus judge calibrate --apply"),
    calibration: file,
    specs,
    appliesTo: specNameOf(ctx),
  };
};

/**
 * `POST /api/h/:id/evals/judge` — run `judge calibrate`.
 *
 * Without `apply` this is a PREVIEW: the verb prints the ROC cut it would
 * choose and writes nothing. `apply: true` persists the calibration file and
 * is confirm-gated, because it changes how every LATER run is scored — an
 * eval console that let that happen on a single click would silently move
 * everyone's gate.
 */
export const judgeCalibrate: M3Handler = (ctx) => {
  const apply = ctx.body["apply"] === true;
  if (apply && ctx.body["confirm"] !== true) {
    throw new HttpError(
      409,
      'applying a calibration changes how every later run is scored — send "confirm": true',
    );
  }
  const argv = ["judge", "calibrate"];
  const model = ctx.body["model"];
  if (model !== undefined) argv.push("--model", jobArg("model", model));
  const graders = ctx.body["graders"];
  if (graders !== undefined) argv.push("--graders", jobArg("graders", graders));
  if (apply) argv.push("--apply");
  return {
    ...found(
      apply
        ? "calibration queued — it will WRITE .crewhaus/judge-calibration.json"
        : "preview queued — the verb prints the ROC cut it would choose and writes nothing",
      "crewhaus judge calibrate",
    ),
    mode: apply ? "apply" : "preview",
    job: ctx.submitJob("judge calibrate", argv),
    argv,
  };
};

/**
 * `GET /api/h/:id/evals/graders` — grader quality.
 *
 * Two halves: the grader PLUGINS on disk (`.crewhaus/graders/`), and the
 * measurement INSTRUMENTS the run history recorded — a `(gradersHash,
 * judgeModel)` pair per run. Scores produced under different instruments are
 * not comparable, so seeing the instruments change over time is how an
 * operator explains a "regression" that was really a rubric edit.
 */
export const graderCards: M3Handler = (ctx) => {
  const plugins = listNames(safeContain(ctx, [".crewhaus", "graders"])).map((name) => ({
    name,
    path: `.crewhaus/graders/${name}`,
    modifiedAt: mtimeIso(safeContain(ctx, [".crewhaus", "graders", name])),
  }));
  const byInstrument = new Map<string, { runs: number; lastTs: string; datasets: Set<string> }>();
  for (const entry of runIndex(ctx)) {
    const key = `${entry.gradersHash ?? "(unrecorded)"}::${entry.judgeModel ?? "(default judge)"}`;
    const seen = byInstrument.get(key) ?? { runs: 0, lastTs: "", datasets: new Set<string>() };
    seen.runs += 1;
    if (entry.ts > seen.lastTs) seen.lastTs = entry.ts;
    seen.datasets.add(entry.datasetName);
    byInstrument.set(key, seen);
  }
  const graders = [
    ...plugins.map((p) => ({ kind: "plugin" as const, ...p })),
    ...[...byInstrument.entries()].map(([key, v]) => {
      const [gradersHash = "", judgeModel = ""] = key.split("::");
      return {
        kind: "instrument" as const,
        name: gradersHash,
        gradersHash,
        judgeModel,
        runs: v.runs,
        lastTs: v.lastTs === "" ? null : v.lastTs,
        datasets: [...v.datasets].sort(),
      };
    }),
  ];
  const gradersFile =
    ["eval/graders.yaml", "graders.yaml", ".crewhaus/graders.yaml"].find((rel) =>
      isFileAt(safeContain(ctx, rel.split("/"))),
    ) ?? null;
  if (graders.length === 0 && gradersFile === null) {
    return {
      ...absent(
        "no graders config, grader plugins or graded runs on this harness",
        "crewhaus graders suggest",
      ),
      graders,
      gradersFile,
      instrumentCount: 0,
    };
  }
  return {
    ...found(
      byInstrument.size > 1
        ? "this harness has graded under more than one measurement instrument — scores from different instruments are not comparable"
        : null,
      "crewhaus graders card",
    ),
    graders,
    gradersFile,
    instrumentCount: byInstrument.size,
  };
};

/** `POST /api/h/:id/evals/graders/suggest` — `graders suggest`. ADVISORY:
 *  the proposal is a file the operator reads, never a spec change. */
export const gradersSuggest: M3Handler = (ctx) => {
  const argv = ["graders", "suggest"];
  const out = ctx.body["out"];
  if (out !== undefined) argv.push("-o", jobArg("out", out));
  return {
    ...found(
      "advisory — the verb drafts a graders file; nothing is applied until you accept it",
      "crewhaus graders suggest",
    ),
    advisory: true,
    job: ctx.submitJob("graders suggest", argv),
    argv,
  };
};

/** `POST /api/h/:id/evals/graders/test` — `graders test --golden`: meta-eval
 *  the graders against golden verdicts. The result is a REPORT, not a spec
 *  change — this is how an operator checks that the graders grade correctly. */
export const gradersTest: M3Handler = (ctx) => {
  const argv = ["graders", "test"];
  const graders = ctx.body["graders"];
  argv.push("--graders", jobArg("graders", graders ?? "eval/graders.yaml"));
  const golden = ctx.body["golden"];
  if (golden !== undefined && golden !== true) argv.push("--golden", jobArg("golden", golden));
  const judgeModel = ctx.body["judgeModel"];
  if (judgeModel !== undefined) argv.push("--judge-model", jobArg("judgeModel", judgeModel));
  return {
    ...found(
      "meta-eval queued — the result is a report, not a spec change",
      "crewhaus graders test",
    ),
    job: ctx.submitJob("graders test", argv),
    argv,
  };
};

// ---------------------------------------------------------------------------
// Redteam
// ---------------------------------------------------------------------------

/**
 * `GET /api/h/:id/evals/redteam` — attack-dataset status + the
 * attack-success-rate trend.
 *
 * Attack success is the COMPLEMENT of the refusal graders' pass rate: a
 * refusal grader passes when the agent declined, so `1 − passRate` is the
 * share of attacks that got through. Stating that here keeps the panel from
 * rendering a 95% pass rate as if it were a 95% attack rate.
 */
export const redteam: M3Handler = async (ctx) => {
  const datasetName = `${specNameOf(ctx)}-redteam`;
  const registryRoot = safeContain(ctx, [".crewhaus", "datasets"]);
  let versions: readonly string[] = [];
  if (registryRoot !== undefined && isDirAt(join(registryRoot, datasetName))) {
    try {
      versions = await createFileBackedRegistry({ rootDir: registryRoot }).list(datasetName);
    } catch {
      versions = [];
    }
  }
  const runs = runIndex(ctx)
    .filter((e) => datasetFilterMatches(datasetName, e.datasetName))
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
    .map((e) => ({
      runId: e.runId,
      ts: e.ts,
      datasetName: e.datasetName,
      sampleCount: e.sampleCount,
      refusalRate: e.passRate,
      attackSuccessRate: 1 - e.passRate,
      partial: e.partial === true,
    }));
  if (versions.length === 0 && runs.length === 0) {
    return {
      ...absent(
        `no attack dataset "${datasetName}" and no redteam runs recorded`,
        "crewhaus redteam generate",
      ),
      dataset: null,
      runs,
      latestAttackSuccessRate: null,
    };
  }
  const measured = runs.filter((r) => !r.partial);
  return {
    ...found(
      "attack success rate is 1 − the refusal graders' pass rate; partial runs are excluded from the trend",
      "crewhaus redteam report --runs",
    ),
    dataset: versions.length > 0 ? { name: datasetName, versions } : null,
    runs,
    latestAttackSuccessRate: measured[0]?.attackSuccessRate ?? null,
  };
};

/** `POST /api/h/:id/evals/redteam` — `redteam generate`. The generated
 *  dataset lands in the registry with its provenance, like any other. */
export const redteamGenerate: M3Handler = (ctx) => {
  const argv = ["redteam", "generate"];
  const outDataset = ctx.body["outDataset"];
  if (outDataset !== undefined) argv.push("--out-dataset", jobArg("outDataset", outDataset));
  const outGraders = ctx.body["outGraders"];
  if (outGraders !== undefined) argv.push("--out-graders", jobArg("outGraders", outGraders));
  const budgetUsd = positiveNumber(ctx.body, "budgetUsd");
  if (budgetUsd !== undefined) argv.push("--budget-usd", String(budgetUsd));
  return {
    ...found(
      `generates the ${specNameOf(ctx)}-redteam attack dataset plus refusal graders`,
      "crewhaus redteam generate",
    ),
    job: ctx.submitJob("redteam generate", argv),
    argv,
  };
};

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

const COVERAGE_CANDIDATES: ReadonlyArray<readonly string[]> = [
  [".crewhaus", "coverage", "coverage.json"],
  [".crewhaus", "evals", "coverage.json"],
  ["coverage.json"],
];

/**
 * `GET /api/h/:id/evals/coverage` — `eval coverage` gaps.
 *
 * `crewhaus eval coverage` prints to stdout unless it is given `-o`, so a
 * harness that has never persisted a report has nothing to show here — and
 * that is a different state from "no gaps". Each gap carries the sessions
 * that demonstrate it, which is what makes "draft samples from these
 * sessions" (`dataset mine`) a real hand-off rather than a slogan.
 */
export const evalCoverage: M3Handler = (ctx) => {
  for (const segments of COVERAGE_CANDIDATES) {
    const report = asObject(readJson(ctx, segments));
    if (report === undefined) continue;
    const gaps = (Array.isArray(report["gaps"]) ? report["gaps"] : [])
      .map((g) => asObject(g))
      .filter((g): g is Record<string, unknown> => g !== undefined)
      .map((gap) => ({
        behavior: str(gap["behavior"]) ?? str(gap["name"]) ?? "(behavior)",
        kind: str(gap["kind"]) ?? null,
        frequency: num(gap["frequency"]) ?? num(gap["count"]) ?? null,
        sessions: (Array.isArray(gap["sessions"]) ? gap["sessions"] : []).map((s) => String(s)),
        detail: maskText(str(gap["detail"]) ?? ""),
      }));
    return {
      ...found(null, "crewhaus eval coverage -o .crewhaus/coverage --format json"),
      gaps,
      source: segments.join("/"),
      generatedAt: str(report["generatedAt"]) ?? mtimeIso(safeContain(ctx, segments)),
      sessionsScanned: num(report["sessionsScanned"]) ?? null,
      handoff: "crewhaus dataset mine --sessions all",
    };
  }
  return {
    ...absent(
      "no persisted coverage report — `eval coverage` prints to stdout unless you give it -o",
      "crewhaus eval coverage -o .crewhaus/coverage --format json",
    ),
    gaps: [],
    source: null,
    generatedAt: null,
    sessionsScanned: null,
    handoff: "crewhaus dataset mine --sessions all",
  };
};

// ---------------------------------------------------------------------------
// The drift sentinel
// ---------------------------------------------------------------------------

const SENTINEL_BASELINE: readonly string[] = ["eval", "sentinel-baseline"];

/**
 * `GET /api/h/:id/evals/sentinel` — provider-drift sentinel status.
 *
 * Attribution is CONDITIONAL and this is the whole value of the panel: a
 * score flip is provider drift ONLY when specHash, datasetHash, gradersHash
 * and judgeModel all match the frozen baseline. If any of them moved, the
 * honest answer names what changed — otherwise the console blames the
 * provider for the operator's own rubric edit.
 */
export const sentinel: M3Handler = (ctx) => {
  const baselineDir = safeContain(ctx, SENTINEL_BASELINE);
  const baselineRun = asObject(readJson(ctx, [...SENTINEL_BASELINE, "run.json"]));
  if (!isDirAt(baselineDir)) {
    return {
      ...absent(
        "no frozen sentinel baseline — freeze one, commit it, then run the sentinel against it",
        "crewhaus eval crewhaus.yaml --seed 1 -o eval/sentinel-baseline",
      ),
      baseline: null,
      lastRun: null,
      attribution: null,
    };
  }
  const config = asObject(baselineRun?.["config"]) ?? {};
  const baseline = {
    dir: SENTINEL_BASELINE.join("/"),
    runId: str(baselineRun?.["runId"]) ?? null,
    specHash: str(config["specHash"]) ?? null,
    datasetHash: str(config["datasetHash"]) ?? null,
    gradersHash: str(config["gradersHash"]) ?? null,
    judgeModel: str(config["judgeModel"]) ?? null,
    frozenAt: str(baselineRun?.["startedAt"]) ?? mtimeIso(baselineDir),
  };
  const runs = runIndex(ctx).sort((a, b) => (a.ts < b.ts ? 1 : -1));
  const lastRun = runs[0] ?? null;
  const mismatches: string[] = [];
  if (lastRun !== null) {
    if (baseline.specHash !== null && lastRun.specHash !== baseline.specHash) {
      mismatches.push("specHash — the spec changed since the baseline was frozen");
    }
    if (baseline.datasetHash !== null && lastRun.datasetHash !== baseline.datasetHash) {
      mismatches.push("datasetHash — the dataset content changed");
    }
    if (baseline.gradersHash !== null && (lastRun.gradersHash ?? null) !== baseline.gradersHash) {
      mismatches.push("gradersHash — the graders config changed (a new measurement instrument)");
    }
    if (baseline.judgeModel !== null && (lastRun.judgeModel ?? null) !== baseline.judgeModel) {
      mismatches.push("judgeModel — a different judge model scored this run");
    }
  }
  const comparable = lastRun !== null && mismatches.length === 0;
  return {
    ...found(null, "crewhaus eval crewhaus.yaml --sentinel --baseline eval/sentinel-baseline"),
    baseline,
    lastRun,
    attribution: {
      comparable,
      providerDrift: comparable,
      mismatches,
      reason:
        lastRun === null
          ? "no run to compare against the frozen baseline yet"
          : comparable
            ? "spec, dataset, graders and judge all match the frozen baseline — a score flip here IS provider drift"
            : `not attributable to provider drift: ${mismatches.join("; ")}`,
    },
  };
};

/** `POST /api/h/:id/evals/sentinel` — run the sentinel against the frozen
 *  baseline through the job queue. */
export const sentinelRun: M3Handler = (ctx) => {
  const baseline = ctx.body["baseline"];
  const baselinePath = jobArg("baseline", baseline ?? SENTINEL_BASELINE.join("/"));
  const argv = ["eval", "crewhaus.yaml", "--sentinel", "--baseline", baselinePath];
  return {
    ...found(`sentinel queued against ${baselinePath}`, "crewhaus eval --sentinel"),
    job: ctx.submitJob("eval sentinel", argv),
    argv,
  };
};

// ---------------------------------------------------------------------------
// Voice replays
// ---------------------------------------------------------------------------

/** `GET /api/h/:id/evals/voice` — voice-replay eval results. Shape-gated:
 *  only the voice target replays call sessions through the latency/barge-in
 *  graders, so every other shape gets an explicit "not applicable" rather
 *  than an empty panel it cannot interpret. */
export const voiceEvals: M3Handler = (ctx) => {
  const target = ctx.entry?.target ?? "";
  if (target !== "voice") {
    return {
      ...absent(`voice replays apply to the voice target only (this harness is "${target}")`, null),
      applicable: false,
      target,
      report: null,
      replays: 0,
    };
  }
  const replays = listNames(safeContain(ctx, [".crewhaus", "voice-replays"])).filter((n) =>
    n.endsWith(".jsonl"),
  ).length;
  const report = asObject(readJson(ctx, evalsSegments("voice", "voice-eval.json")));
  if (report === undefined) {
    return {
      ...absent(
        replays === 0
          ? "no recorded call sessions under .crewhaus/voice-replays to replay"
          : `${replays} recorded replay(s) on disk, but no voice eval has been run over them`,
        "crewhaus eval crewhaus.yaml --voice",
      ),
      applicable: true,
      target,
      report: null,
      replays,
    };
  }
  return {
    ...found(null, "crewhaus eval crewhaus.yaml --voice"),
    applicable: true,
    target,
    report,
    replays,
  };
};

// ---------------------------------------------------------------------------
// The optimizer
// ---------------------------------------------------------------------------

const optimizeSegments = (...rest: string[]): string[] => [".crewhaus", "optimize", ...rest];

/**
 * `GET /api/h/:id/evals/optimize` — optimizer runs + their artifacts.
 *
 * The interesting artifacts are `advice/decisions.json` (what was proposed
 * and what the strict acceptance did with it) and `advice/patched.yaml` (the
 * spec it would write). An ACCEPTED patch shows up in the Spec version
 * history with its write-back provenance — this panel links across to that
 * story rather than telling a second, divergent version of it.
 */
export const optimizer: M3Handler = (ctx) => {
  const runs = listNames(safeContain(ctx, optimizeSegments()))
    .filter((runId) => isDirAt(safeContain(ctx, optimizeSegments(runId))))
    .map((runId) => ({
      optRunId: runId,
      at: mtimeIso(safeContain(ctx, optimizeSegments(runId))),
      hasDecisions: isFileAt(safeContain(ctx, optimizeSegments(runId, "advice", "decisions.json"))),
      hasPatchedYaml: isFileAt(safeContain(ctx, optimizeSegments(runId, "advice", "patched.yaml"))),
      hasPatch: isFileAt(safeContain(ctx, optimizeSegments(runId, "patch.json"))),
      files: listNames(safeContain(ctx, optimizeSegments(runId))).length,
    }))
    .sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
  if (runs.length === 0) {
    return {
      ...absent("no optimizer runs recorded", "crewhaus optimize crewhaus.yaml"),
      runs,
      acceptance:
        "strict acceptance: a proposal that does not beat the baseline is REJECTED — that is the feature, not a failure",
    };
  }
  return {
    ...found(null, "crewhaus optimize crewhaus.yaml"),
    runs,
    acceptance:
      "strict acceptance: a proposal that does not beat the baseline is REJECTED — that is the feature, not a failure",
  };
};

const OPTIMIZER_MUTATORS = new Set(["rule-based", "claude", "meta-harness"]);

/** `POST /api/h/:id/evals/optimize` — launch `optimize`. */
export const optimizerRun: M3Handler = (ctx) => {
  const mutator = requireString(ctx.body, "mutator");
  if (!OPTIMIZER_MUTATORS.has(mutator)) {
    throw new HttpError(400, '"mutator" must be one of rule-based, claude, meta-harness');
  }
  const argv = ["optimize", "crewhaus.yaml", "--mutator", mutator];
  const dataset = ctx.body["dataset"];
  if (dataset !== undefined) argv.push("--dataset", jobArg("dataset", dataset));
  const graders = ctx.body["graders"];
  if (graders !== undefined) argv.push("--graders", jobArg("graders", graders));
  const budgetUsd = positiveNumber(ctx.body, "budgetUsd");
  if (budgetUsd !== undefined) argv.push("--budget-usd", String(budgetUsd));
  const concurrency = positiveInt(ctx.body, "concurrency");
  if (concurrency !== undefined) argv.push("--concurrency", String(concurrency));
  const fromAdvice = ctx.body["fromAdvice"];
  if (fromAdvice === true) argv.push("--from-advice");
  else if (fromAdvice !== undefined) argv.push("--from-advice", jobArg("fromAdvice", fromAdvice));
  return {
    ...found(
      "queued — proposals that do not beat the baseline are REJECTED, so a run that changes nothing is a working run",
      "crewhaus optimize",
    ),
    job: ctx.submitJob("optimize", argv),
    argv,
    mutator,
  };
};

/** `GET /api/h/:id/evals/optimize/:optRunId` — one optimizer run's artifact
 *  tree, containment-checked PER FILE and masked. */
export const optimizerArtifacts: M3Handler = (ctx) => {
  const optRunId = ctx.params["optRunId"] as string;
  const runDir = safeContain(ctx, optimizeSegments(optRunId));
  if (!isDirAt(runDir)) {
    return {
      ...absent(
        `no optimizer run "${optRunId}" on this harness`,
        "crewhaus optimize crewhaus.yaml",
      ),
      optRunId,
      files: [],
      decisions: null,
      patchedYaml: null,
      patch: null,
    };
  }
  const files: Array<Record<string, unknown>> = [];
  const walk = (relative: readonly string[], depth: number): void => {
    if (depth > 2) return;
    for (const name of listNames(safeContain(ctx, optimizeSegments(optRunId, ...relative)))) {
      const segments = [...relative, name];
      // Per FILE, not per directory: this listing yields names, and a name
      // inside an artifact tree can be a symlink pointing anywhere.
      const path = safeContain(ctx, optimizeSegments(optRunId, ...segments));
      if (path === undefined) continue;
      if (isDirAt(path)) {
        files.push({ name: segments.join("/"), kind: "dir", size: null });
        walk(segments, depth + 1);
        continue;
      }
      let size: number | null = null;
      try {
        size = statSync(path).size;
      } catch {
        size = null;
      }
      files.push({ name: segments.join("/"), kind: "file", size });
    }
  };
  walk([], 0);
  const patched = readProse(ctx, optimizeSegments(optRunId, "advice", "patched.yaml"));
  return {
    ...found(null, "crewhaus optimize crewhaus.yaml"),
    optRunId,
    files,
    decisions: readJson(ctx, optimizeSegments(optRunId, "advice", "decisions.json")) ?? null,
    patch: readJson(ctx, optimizeSegments(optRunId, "patch.json")) ?? null,
    patchedYaml: patched?.text ?? null,
    patchedYamlTruncated: patched?.truncated ?? false,
  };
};

// ---------------------------------------------------------------------------
// The flywheel
// ---------------------------------------------------------------------------

/**
 * `GET /api/h/:id/evals/flywheel` — flywheel / eval-gate scaffolding status.
 *
 * Carries the dataset-precedence trap prominently: a conventional
 * `eval/dataset.jsonl` SILENTLY shadows `registry:<spec>-ratings`, so a
 * flywheel that reads like it is learning from fresh ratings can be replaying
 * a file nobody has touched in months.
 */
export const flywheel: M3Handler = (ctx) => {
  const stateDir = safeContain(ctx, [".crewhaus", "flywheel"]);
  const scaffolded = isDirAt(stateDir);
  const workflows = listNames(safeContain(ctx, [".github", "workflows"])).filter((name) =>
    /crewhaus-(flywheel|eval-gate|sentinel)/.test(name),
  );
  const precedence = datasetPrecedenceWarning(ctx);
  const shadow = {
    shadowing: precedence !== null,
    conventionalPath: "eval/dataset.jsonl",
    registryRef: `registry:${specNameOf(ctx)}-ratings`,
    note:
      precedence ??
      `no eval/dataset.jsonl on disk — registry:${specNameOf(ctx)}-ratings resolves normally`,
  };
  if (!scaffolded && workflows.length === 0) {
    return {
      ...absent("no flywheel scaffolding on this harness", "crewhaus flywheel init"),
      scaffolded,
      workflows,
      state: null,
      datasetPrecedence: shadow,
    };
  }
  return {
    ...found(precedence, "crewhaus flywheel run"),
    scaffolded,
    workflows,
    state: readJson(ctx, [".crewhaus", "flywheel", "state.json"]) ?? null,
    lastRunAt: mtimeIso(stateDir),
    datasetPrecedence: shadow,
  };
};

/** `POST /api/h/:id/evals/flywheel` — `flywheel run|init`. `init` is
 *  scaffolding (it writes workflow files); `run` is the loop itself. */
export const flywheelRun: M3Handler = (ctx) => {
  const action = ctx.body["action"] ?? "run";
  if (action !== "run" && action !== "init") {
    throw new HttpError(400, '"action" must be "run" or "init"');
  }
  const argv = ["flywheel", action];
  if (action === "run") {
    const budgetUsd = positiveNumber(ctx.body, "budgetUsd");
    if (budgetUsd !== undefined) argv.push("--budget-usd", String(budgetUsd));
    const iterations = positiveInt(ctx.body, "iterations");
    if (iterations !== undefined) argv.push("--iterations", String(iterations));
  }
  const precedence = datasetPrecedenceWarning(ctx);
  return {
    ...found(
      action === "init"
        ? "scaffolding queued — it writes workflow files, it does not run the loop"
        : "the loop is queued: compile gate → baseline eval → optimize → after eval → acceptance",
      `crewhaus flywheel ${action}`,
    ),
    job: ctx.submitJob(`flywheel ${action}`, argv),
    argv,
    warnings: precedence === null ? [] : [precedence],
  };
};

// ---------------------------------------------------------------------------
// Experiments
// ---------------------------------------------------------------------------

const EXPERIMENT_BOUNDARY =
  "these are outcomes REPORTED against each version — CrewHaus's serving path does not split traffic by itself, so this is not a live-traffic experiment unless your own serving boundary made it one. `deploy canary` is an eval gate plus a pin flip, NOT a traffic splitter.";

/** `GET /api/h/:id/evals/experiments` — `experiment status`, folded here. */
export const experiments: M3Handler = (ctx) => {
  const dir = safeContain(ctx, [".crewhaus", "experiments"]);
  const names = [
    ...new Set(
      listNames(dir)
        .filter((n) => n.endsWith(".jsonl"))
        .map((n) => n.slice(0, -".jsonl".length)),
    ),
  ];
  const out = names.map((name) => {
    const path = safeContain(ctx, [".crewhaus", "experiments", `${name}.jsonl`]);
    const lines = path === undefined ? [] : readJsonlCapped(path, MAX_JSONL_LINES).objects;
    const tallies = new Map<string, { n: number; successes: number; sources: Set<string> }>();
    for (const raw of lines) {
      const row = asObject(raw);
      const version = str(row?.["version"]);
      if (version === undefined) continue;
      const tally = tallies.get(version) ?? { n: 0, successes: 0, sources: new Set<string>() };
      tally.n += 1;
      if (row?.["outcome"] === "success" || row?.["outcome"] === "pass") tally.successes += 1;
      const source = str(row?.["source"]);
      if (source !== undefined) tally.sources.add(source);
      tallies.set(version, tally);
    }
    const rows = [...tallies.entries()];
    const control = rows[0];
    const variants = rows.map(([version, t]) => {
      const ci95 = wilson95(t.successes, t.n);
      const controlRate =
        control === undefined
          ? null
          : control[1].n === 0
            ? null
            : control[1].successes / control[1].n;
      const successRate = t.n === 0 ? 0 : t.successes / t.n;
      return {
        version,
        n: t.n,
        successes: t.successes,
        successRate,
        ci95: ci95 ?? null,
        sources: [...t.sources].sort(),
        successRateDelta:
          control === undefined || version === control[0] || controlRate === null
            ? null
            : successRate - controlRate,
      };
    });
    return {
      name,
      control: control?.[0] ?? null,
      variants,
      totalObservations: variants.reduce((acc, v) => acc + v.n, 0),
      assignment: readJson(ctx, [".crewhaus", "experiments", `${name}.assignment.json`]) ?? null,
    };
  });
  if (out.length === 0) {
    return {
      ...absent("no experiments recorded", "crewhaus experiment record --name <n> --version <v>"),
      experiments: out,
      boundary: EXPERIMENT_BOUNDARY,
    };
  }
  return {
    ...found(null, "crewhaus experiment status"),
    experiments: out,
    boundary: EXPERIMENT_BOUNDARY,
  };
};

/**
 * `POST /api/h/:id/evals/experiments` — `experiment record|assign`.
 *
 * An INCOMPLETE record (no version, or no outcome) is not an error: the panel
 * composes one field at a time, and the honest answer is "here is what is
 * still missing" rather than a 400 the form has to translate back into a
 * hint. Nothing is submitted until the ledger line would be complete.
 */
export const experimentRecord: M3Handler = (ctx) => {
  const action = requireString(ctx.body, "action");
  if (action !== "record" && action !== "assign") {
    throw new HttpError(400, '"action" must be "record" or "assign"');
  }
  const name = jobArg("name", requireString(ctx.body, "name"));
  const argv = ["experiment", action, "--name", name];
  const version = ctx.body["version"] ?? ctx.body["variant"];
  if (version !== undefined) argv.push("--version", jobArg("version", version));
  const missing: string[] = [];
  if (version === undefined) missing.push("version");
  if (action === "record") {
    const outcome = ctx.body["outcome"];
    if (outcome === "pass" || outcome === "fail") argv.push("--outcome", outcome);
    else if (outcome === undefined) missing.push("outcome");
    else throw new HttpError(400, '"outcome" must be "pass" or "fail"');
  }
  if (missing.length > 0) {
    return {
      ...found(
        `nothing submitted — a complete ${action} still needs: ${missing.join(", ")}`,
        `crewhaus experiment ${action}`,
      ),
      submitted: false,
      missing,
      argv: null,
      boundary: EXPERIMENT_BOUNDARY,
    };
  }
  return {
    ...found(EXPERIMENT_BOUNDARY, `crewhaus experiment ${action}`),
    submitted: true,
    missing,
    job: ctx.submitJob(`experiment ${action}`, argv),
    argv,
  };
};

// ---------------------------------------------------------------------------
// F-7 — the annotation → distill join
// ---------------------------------------------------------------------------

/**
 * Where an eval-sample annotation is durably recorded. Two sinks, on purpose:
 *
 *   - `<runDir>/<sampleId>/annotations.jsonl` — the RUN-SCOPED record. This
 *     is written unconditionally, so an annotation is never lost, whatever
 *     the join can or cannot do with it.
 *   - `.crewhaus/feedback/hangar-annotations.jsonl` — a real `FeedbackRecord`
 *     through `buildFeedbackRecord` (the `crewhaus rate --adjudicate` path),
 *     written ONLY when the sample's `meta.json` carries a session id of the
 *     shape the record schema requires. Without one there is no valid record
 *     to write, and inventing a session id would corrupt the corpus.
 */
const ANNOTATION_SINK = "hangar-annotations";

const SESSION_ID_SHAPE = /^sess_[0-9a-f]{16}$/;

/**
 * `POST /api/h/:id/evals/:runId/:sampleId/annotate` — annotate one sample.
 *
 * Body: `{ verdict: "pass"|"fail", note?, correction? }`. The response states
 * exactly what happened to the annotation on both sinks, including whether
 * distill can currently reach it — see {@link annotations} for why it often
 * cannot.
 */
export const annotateSample: M3Handler = (ctx) => {
  const runId = ctx.params["runId"] as string;
  const sampleId = ctx.params["sampleId"] as string;
  const verdict = requireString(ctx.body, "verdict");
  if (verdict !== "pass" && verdict !== "fail") {
    throw new HttpError(400, '"verdict" must be "pass" or "fail"');
  }
  const sampleDir = safeContain(ctx, evalsSegments(runId, sampleId));
  if (!isDirAt(sampleDir)) {
    // A typed refusal, not a 404: the console renders it beside the sample it
    // was aiming at, and nothing about the request was malformed.
    return {
      ...absent(`no sample "${sampleId}" under run ${runId} — nothing was recorded`, null),
      recorded: false,
      runId,
      sampleId,
    };
  }
  const note = typeof ctx.body["note"] === "string" ? (ctx.body["note"] as string) : undefined;
  const correction =
    typeof ctx.body["correction"] === "string" ? (ctx.body["correction"] as string) : undefined;
  const nowIso = new Date(ctx.now()).toISOString();
  const meta = asObject(readJson(ctx, evalsSegments(runId, sampleId, "meta.json")));
  const sessionId = str(meta?.["sessionId"]);
  const joinable = sessionId !== undefined && SESSION_ID_SHAPE.test(sessionId);

  // 1) The run-scoped record — always written, so nothing is ever dropped.
  const runScoped = {
    schemaVersion: 1,
    runId,
    sampleId,
    verdict,
    ...(note !== undefined ? { note } : {}),
    ...(correction !== undefined ? { correction } : {}),
    by: ctx.operator,
    ts: nowIso,
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
  const runSinkPath = ctx.contain(evalsSegments(runId, sampleId, "annotations.jsonl"));
  appendJsonl(runSinkPath, runScoped);

  // 2) The FeedbackRecord — only when a schema-valid session id exists.
  let feedbackRecord: unknown = null;
  if (joinable) {
    feedbackRecord = buildFeedbackRecord({
      id: `fb_eval_${runId}_${sampleId}`,
      sessionId: sessionId as string,
      turnNumber: num(meta?.["turnNumber"]) ?? 1,
      ts: nowIso,
      source: "ui",
      runId,
      rater: ctx.operator,
      adjudicate: true,
      thumbs: verdict === "pass" ? "up" : "down",
      ...(note !== undefined ? { comment: note } : {}),
      ...(correction !== undefined ? { correction } : {}),
    });
    appendJsonl(ctx.contain([".crewhaus", "feedback", `${ANNOTATION_SINK}.jsonl`]), feedbackRecord);
  }

  const transcriptInSessionsRoot =
    joinable && isFileAt(safeContain(ctx, [".crewhaus", "sessions", `${sessionId}.jsonl`]));
  return {
    ...found("annotation recorded", "crewhaus rate --adjudicate"),
    runId,
    sampleId,
    verdict,
    runScopedSink: `.crewhaus/evals/${runId}/${sampleId}/annotations.jsonl`,
    feedbackRecord,
    join: joinResolution(joinable, transcriptInSessionsRoot),
  };
};

/** Append one JSONL line with owner-only permissions. The two annotation
 *  sinks are append-only ledgers; nothing here ever rewrites a line. */
function appendJsonl(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

type JoinResolution = {
  readonly state: "resolves" | "recorded-not-joinable" | "no-session-id";
  readonly reason: string;
  readonly upstreamFix: string | null;
};

function joinResolution(joinable: boolean, transcriptPresent: boolean): JoinResolution {
  if (!joinable) {
    return {
      state: "no-session-id",
      reason:
        "this sample's meta.json records no session id of the shape a FeedbackRecord requires, so no rating record could be written — the annotation is kept run-scoped only",
      upstreamFix:
        "F-7: run-dir-scoped annotation resolution for distill (join eval annotations on (runId, sampleId) instead of (sessionId, turnNumber))",
    };
  }
  if (!transcriptPresent) {
    return {
      state: "recorded-not-joinable",
      reason:
        "a FeedbackRecord was written, but the sample's transcript lives under the RUN directory, not .crewhaus/sessions — distill's (sessionId, turnNumber) join sweeps the sessions root and will not find the turn this rating points at",
      upstreamFix:
        "F-7: run-dir-scoped annotation resolution for distill (sweep eval run dirs for the rated turn)",
    };
  }
  return {
    state: "resolves",
    reason:
      "a transcript for this session exists under .crewhaus/sessions, so distill's (sessionId, turnNumber) join resolves and this annotation is training-data eligible",
    upstreamFix: null,
  };
}

/**
 * `GET /api/h/:id/evals/annotations` — the annotation → distill join (F-7).
 *
 * Reported HONESTLY, because the flagship "evals → training data" loop does
 * not currently close: a sample's session log lives under the RUN directory,
 * and `distill` joins ratings to turns on `(sessionId, turnNumber)` by
 * sweeping the SESSIONS root. Annotations are therefore recorded, durable and
 * visible — and mostly unjoinable. This route says how many exist, how many
 * resolve, and what would make the rest resolve. It does not fake the join,
 * and it never drops an annotation to make the number look better.
 */
export const annotations: M3Handler = (ctx) => {
  const rows: Array<Record<string, unknown>> = [];
  for (const runId of listNames(safeContain(ctx, evalsSegments()))) {
    if (!isDirAt(safeContain(ctx, evalsSegments(runId)))) continue;
    for (const sampleId of listNames(safeContain(ctx, evalsSegments(runId)))) {
      const path = safeContain(ctx, evalsSegments(runId, sampleId, "annotations.jsonl"));
      if (path === undefined || !isFileAt(path)) continue;
      for (const raw of readJsonlCapped(path, MAX_JSONL_LINES).objects) {
        const row = asObject(raw);
        if (row === undefined) continue;
        const sessionId = str(row["sessionId"]);
        const joinable = sessionId !== undefined && SESSION_ID_SHAPE.test(sessionId);
        const transcriptPresent =
          joinable && isFileAt(safeContain(ctx, [".crewhaus", "sessions", `${sessionId}.jsonl`]));
        rows.push({
          runId,
          sampleId,
          verdict: str(row["verdict"]) ?? null,
          note: maskText(str(row["note"]) ?? ""),
          correction: maskText(str(row["correction"]) ?? ""),
          by: str(row["by"]) ?? null,
          ts: str(row["ts"]) ?? null,
          sessionId: sessionId ?? null,
          join: joinResolution(joinable, transcriptPresent),
        });
      }
    }
  }
  const resolvable = rows.filter((r) => (r["join"] as JoinResolution).state === "resolves").length;
  const base =
    rows.length === 0
      ? absent(
          "no eval-sample annotations recorded on this harness",
          "annotate a sample from the run drill-down",
        )
      : found(
          resolvable === rows.length
            ? null
            : `${rows.length - resolvable} of ${rows.length} annotation(s) cannot reach distill yet — see join.reason`,
          "crewhaus distill",
        );
  return {
    ...base,
    annotations: rows,
    join: {
      total: rows.length,
      resolvable,
      unresolvable: rows.length - resolvable,
      reason:
        rows.length === 0
          ? "nothing annotated yet"
          : resolvable === rows.length
            ? "every annotation joins to a transcript under the sessions root"
            : "eval samples keep their transcripts under the run directory; distill joins ratings on (sessionId, turnNumber) by sweeping the sessions root, so those annotations never match a turn",
      upstreamFix:
        "F-7: run-dir-scoped annotation resolution for distill — until it lands, eval annotations are durable and visible but not training-data eligible",
      sinks: [
        ".crewhaus/evals/<runId>/<sampleId>/annotations.jsonl (run-scoped, always written)",
        `.crewhaus/feedback/${ANNOTATION_SINK}.jsonl (FeedbackRecord, written when the sample records a session id)`,
      ],
    },
  };
};

/** Append one JSONL line, exported so the feedback growers in this area
 *  write their ledgers exactly the way the annotation sinks do. */
export { appendJsonl };
