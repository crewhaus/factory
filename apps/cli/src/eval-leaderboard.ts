/**
 * 0.6.0 §6.1 (PR 12) — `crewhaus eval leaderboard <matrix-dir>`.
 *
 * Reads a recorded `eval --models` matrix (every cell's run directory under
 * one root), ranks the arms with the intervals the cells already carry, runs
 * the paired sign-flip test between them, and prints a verdict that REFUSES
 * to name a winner the evidence cannot support — the fix for `bestModels`'
 * raw argmax. Fully offline: run directories in, a table and `matrix.json`'s
 * additive `verdict` block out. No judge calls, no network.
 *
 * `--export-priors <file>` is the other half: N2 (§7.11) seeds the learned
 * policy from what the eval measured, so a fresh harness does not spend its
 * first hundred turns rediscovering that the cheap arm is worse. Priors are
 * written in REWARD UNITS — each arm's eval quality folded with its expected
 * cost and latency through `computeReward`, the SAME function the live
 * scoreboard maximises, because a prior in "pass rate" units and a live arm
 * in reward units are not the same quantity and blending them would be
 * nonsense. The pseudo-count is capped at ten (`MAX_PRIOR_PSEUDO_COUNT`), so
 * a prior can never outweigh ten live observations, and the file is
 * fingerprinted with `priorsFingerprint(pool.candidates)` — the ROSTER
 * fingerprint runtime-core passes as `expectFingerprint`, so a priors file
 * written here is accepted there rather than rejected as stale.
 *
 * The module is side-effect-free (the CLI entry file runs an argv switch on
 * import): every seam — the run loader, the pricing lookup, the file writer,
 * the line sink — is injected, so the whole verb is unit-testable without a
 * model call or a real matrix on disk.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import {
  type Leaderboard,
  type LoadedRun,
  type MatrixCell,
  type MatrixPricingFn,
  type ModelMatrix,
  buildLeaderboard,
  buildMatrix,
  formatLeaderboardLines,
  pairwiseTable,
  renderMatrix,
  rowArm,
  withVerdict,
} from "@crewhaus/eval-report";
import type { EvalRunSummary } from "@crewhaus/eval-runner";
import { MAX_PRIOR_PSEUDO_COUNT, type PriorsFile, priorsFingerprint } from "@crewhaus/model-plan";
import { type RewardConfig, computeReward } from "@crewhaus/routing-store";

/**
 * The bands a priors file seeds. The router mints `hard` | `easy` (scoped
 * `<scope>/<band>` from PR 10 on) and reads arms back under exactly those
 * keys — and an offline eval measured OVERALL quality, not per-band quality,
 * so the same measured reward seeds both. Stated rather than hidden: this is
 * a prior, capped at ten pseudo-observations, and the live scoreboard
 * separates the bands within a few dozen turns.
 */
export const PRIOR_ROUTE_KEYS = ["hard", "easy"] as const;

/** One arm's row on the leaderboard, as the table and `--json` render it. */
export type LeaderboardArmRow = {
  readonly arm: string;
  readonly model: string;
  readonly status: "ok" | "error";
  readonly samples?: number;
  readonly passRate?: number;
  readonly passRateCI95?: readonly [number, number];
  readonly meanScore?: number;
  readonly meanScoreCI95?: readonly [number, number];
  readonly p95LatencyMs?: number;
  readonly costPer1kSamplesUsd?: number;
};

export type LeaderboardCellSource = {
  readonly model: string;
  readonly armId?: string;
  readonly slug: string;
  readonly outDir: string;
};

/**
 * Discover the cells of a matrix root. Prefers the root's own `matrix.json`
 * (it names every cell, including the ones that CRASHED, and carries the arm
 * ids a `--models '$fast,$strong'` run pinned); falls back to "every
 * subdirectory holding a results.json" so a matrix produced by an older CLI,
 * or assembled by hand from single-model runs, still ranks.
 */
export function discoverMatrixCells(rootDir: string): LeaderboardCellSource[] {
  const manifest = join(rootDir, "matrix.json");
  if (existsSync(manifest)) {
    try {
      const parsed = JSON.parse(readFileSync(manifest, "utf-8")) as ModelMatrix;
      if (Array.isArray(parsed.rows) && parsed.rows.length > 0) {
        return parsed.rows.map((r) => ({
          model: r.model,
          ...(r.armId !== undefined ? { armId: r.armId } : {}),
          slug: r.slug,
          outDir: r.outDir,
        }));
      }
    } catch {
      // fall through to the directory walk — a torn matrix.json must not
      // hide a directory full of perfectly readable run dirs
    }
  }
  const out: LeaderboardCellSource[] = [];
  let entries: string[];
  try {
    entries = readdirSync(rootDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    throw new CrewhausError(
      "config",
      `eval leaderboard: cannot read ${rootDir} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  for (const name of entries) {
    const dir = join(rootDir, name);
    if (!existsSync(join(dir, "results.json"))) continue;
    out.push({ model: name, slug: name, outDir: dir });
  }
  if (out.length === 0) {
    throw new CrewhausError(
      "config",
      `eval leaderboard: no eval cells found under ${rootDir} — point it at an \`eval --models\` matrix root (the directory holding matrix.json and one sub-directory per cell)`,
    );
  }
  return out;
}

export type LoadLeaderboardOptions = {
  /** Injected run loader (defaults to `@crewhaus/eval-report`'s `loadRun`). */
  readonly loadRun: (dir: string) => Promise<LoadedRun>;
  readonly pricing?: MatrixPricingFn;
  readonly minN?: number;
  readonly seed?: number;
  readonly now?: () => Date;
};

export type LeaderboardResult = {
  readonly matrix: ModelMatrix;
  readonly board: Leaderboard;
  readonly cells: ReadonlyArray<MatrixCell>;
  readonly rows: ReadonlyArray<LeaderboardArmRow>;
};

/**
 * Load every cell and fold it into the matrix + leaderboard. A cell whose
 * run directory does not read becomes an ERROR row (named, with the reason)
 * rather than aborting the board: one unreadable cell must not hide five
 * readable ones.
 */
export async function loadLeaderboard(
  sources: ReadonlyArray<LeaderboardCellSource>,
  opts: LoadLeaderboardOptions,
): Promise<LeaderboardResult> {
  const cells: MatrixCell[] = [];
  for (const src of sources) {
    let summary: EvalRunSummary | undefined;
    let error: string | undefined;
    try {
      summary = (await opts.loadRun(src.outDir)).summary;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    cells.push({
      model: src.model,
      ...(src.armId !== undefined ? { armId: src.armId } : {}),
      slug: src.slug,
      outDir: src.outDir,
      ...(summary !== undefined ? { summary } : {}),
      ...(error !== undefined ? { error } : {}),
    });
  }
  const matrix = buildMatrix(cells, {
    ...(opts.pricing !== undefined ? { pricing: opts.pricing } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  const board = buildLeaderboard(matrix, cells, {
    ...(opts.minN !== undefined ? { minN: opts.minN } : {}),
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
  });
  const rows: LeaderboardArmRow[] = matrix.rows.map((r) => ({
    arm: rowArm(r),
    model: r.model,
    status: r.status,
    ...(r.sampleCount !== undefined ? { samples: r.sampleCount } : {}),
    ...(r.passRate !== undefined ? { passRate: r.passRate } : {}),
    ...(r.passRateCI95 !== undefined ? { passRateCI95: r.passRateCI95 } : {}),
    ...(r.meanScore !== undefined ? { meanScore: r.meanScore } : {}),
    ...(r.meanScoreCI95 !== undefined ? { meanScoreCI95: r.meanScoreCI95 } : {}),
    ...(r.p95LatencyMs !== undefined ? { p95LatencyMs: r.p95LatencyMs } : {}),
    ...(r.costPer1kSamplesUsd !== undefined ? { costPer1kSamplesUsd: r.costPer1kSamplesUsd } : {}),
  }));
  return { matrix, board, cells, rows };
}

/** The human table: one row per arm, ranked by pass rate. */
export function leaderboardTable(result: LeaderboardResult): {
  header: string[];
  rows: string[][];
} {
  const header = ["arm", "model", "samples", "pass_rate", "mean_score", "p95_ms", "est_$/1k"];
  const ci = (v: readonly [number, number] | undefined, pct: boolean): string =>
    v === undefined
      ? ""
      : pct
        ? ` [${(v[0] * 100).toFixed(1)}–${(v[1] * 100).toFixed(1)}]`
        : ` [${v[0].toFixed(3)}–${v[1].toFixed(3)}]`;
  const rows = [...result.rows]
    .sort((a, b) => (b.passRate ?? -1) - (a.passRate ?? -1) || a.arm.localeCompare(b.arm))
    .map((r) => [
      r.arm,
      r.model,
      r.samples !== undefined ? String(r.samples) : "n/a",
      r.status === "error"
        ? "ERROR"
        : r.passRate !== undefined
          ? `${(r.passRate * 100).toFixed(1)}%${ci(r.passRateCI95, true)}`
          : "n/a",
      r.meanScore !== undefined ? `${r.meanScore.toFixed(3)}${ci(r.meanScoreCI95, false)}` : "n/a",
      r.p95LatencyMs !== undefined ? `${Math.round(r.p95LatencyMs)}ms` : "n/a",
      r.costPer1kSamplesUsd !== undefined ? `$${r.costPer1kSamplesUsd.toFixed(4)}` : "n/a",
    ]);
  return { header, rows };
}

// ---------------------------------------------------------------------------
// --export-priors (§7.11 N2)
// ---------------------------------------------------------------------------

export type BuildPriorsOptions = {
  /** The pool roster the priors are pinned to (`model_pool.candidates`). */
  readonly candidates: ReadonlyArray<unknown>;
  /** The pool's reward tuning, so the prior is in the SAME units the live
   *  scoreboard maximises. */
  readonly reward?: RewardConfig;
  /** Route keys to seed. Defaults to {@link PRIOR_ROUTE_KEYS}. */
  readonly routeKeys?: ReadonlyArray<string>;
  readonly source?: string;
  readonly generatedAt?: string;
  /** Pseudo-count cap. Defaults to `MAX_PRIOR_PSEUDO_COUNT` (ten). */
  readonly maxPseudoCount?: number;
};

/**
 * Fold the leaderboard into a `PriorsFile`.
 *
 * Per arm: quality is the cell's mean score clamped to `[0, 1]` (the graded
 * quality the eval actually measured); latency is the cell's per-model-call
 * p50 when it recorded one, else its per-sample p50; cost is the cell's
 * projected spend per SAMPLE. Those three go through `computeReward` with the
 * pool's own objective, so the number the router reads is the number the
 * router would have computed from a live turn on that arm.
 *
 * Errored cells contribute nothing: an arm that never produced output has no
 * measured reward, and seeding it with 0 would permanently bury a model whose
 * only problem was a missing credential on the day of the eval.
 */
export function buildPriorsFile(result: LeaderboardResult, opts: BuildPriorsOptions): PriorsFile {
  const cap = Math.max(1, opts.maxPseudoCount ?? MAX_PRIOR_PSEUDO_COUNT);
  const routeKeys = opts.routeKeys ?? PRIOR_ROUTE_KEYS;
  const arms: Array<{
    routeKey: string;
    arm: string;
    n: number;
    meanReward: number;
  }> = [];
  for (const row of result.matrix.rows) {
    if (row.status !== "ok") continue;
    const sampleCount = row.sampleCount ?? 0;
    if (sampleCount === 0) continue;
    const quality = Math.min(1, Math.max(0, row.meanScore ?? row.passRate ?? 0));
    const latencyMs = row.p95LatencyMs ?? 0;
    const costUsd =
      row.costPer1kSamplesUsd !== undefined ? row.costPer1kSamplesUsd / 1000 : undefined;
    const meanReward = computeReward(
      {
        success: true,
        latencyMs,
        quality,
        ...(costUsd !== undefined ? { costUsd } : {}),
      },
      opts.reward ?? {},
    );
    const n = Math.min(cap, sampleCount);
    for (const routeKey of routeKeys) {
      arms.push({ routeKey, arm: rowArm(row), n, meanReward });
    }
  }
  return {
    version: 1,
    // The ROSTER fingerprint — exactly what runtime-core passes as
    // `expectFingerprint` when it loads the file, so priors written here are
    // accepted there instead of rejected as stale.
    fingerprint: priorsFingerprint(opts.candidates),
    ...(opts.generatedAt !== undefined ? { generatedAt: opts.generatedAt } : {}),
    ...(opts.source !== undefined ? { source: opts.source } : {}),
    arms,
  };
}

/** Write a priors file, creating `<root>/routing/` on first use. */
export function writePriorsFile(path: string, priors: PriorsFile): void {
  const dir = dirname(resolve(path));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(path), `${JSON.stringify(priors, null, 2)}\n`, { mode: 0o600 });
}

/** The stdout block, shared by the command and its tests. */
export function leaderboardLines(result: LeaderboardResult): string[] {
  return formatLeaderboardLines(result.board).map((l) => `[eval] ${l}`);
}

/** The `--pairwise` table. */
export function leaderboardPairwiseTable(result: LeaderboardResult): {
  header: string[];
  rows: string[][];
} {
  return pairwiseTable(result.board);
}

/** Re-render `matrix.json` / `index.html` with the verdict block attached. */
export function writeLeaderboardArtifacts(rootDir: string, result: LeaderboardResult): void {
  const matrix = withVerdict(result.matrix, result.board);
  const rendered = renderMatrix(matrix);
  writeFileSync(join(rootDir, "matrix.json"), rendered.json);
  writeFileSync(join(rootDir, "index.html"), rendered.html);
}
