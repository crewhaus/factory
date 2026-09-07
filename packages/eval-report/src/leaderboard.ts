/**
 * 0.6.0 §6.1 (PR 12) — `crewhaus eval leaderboard`: WHICH ARM WON, honestly.
 *
 * The matrix already carried Wilson and Student-t intervals on every cell and
 * rendered them; what ignored them was the winner selection — `bestModels`
 * takes a raw argmax, so a 61%-vs-60% split on twelve samples names a
 * "winner" the data cannot support. That is the defect this module fixes, and
 * it fixes it WITHOUT touching `ModelMatrix.best`, which is a consumed
 * artifact field whose `[]` already means "no candidate". The verdict lands
 * as an ADDITIVE `verdict` block, absent on artifacts written by older CLIs.
 *
 * The test is PAIRED, not marginal: every cell runs the identical sample set,
 * so the right question is "did the leader beat the runner-up on the SAME
 * samples", answered by the shipped sign-flip permutation test
 * (`computeDiffSignificance`) over per-sample deltas, with a Holm correction
 * across the N-choose-2 comparisons the leaderboard performs. Three refusals
 * ride on top, and each of them is the point of the verb:
 *
 *   1. `underpowered` — fewer than `minN` comparable pairs. The floor is
 *      `experiment`'s shipped `DEFAULT_MIN_EXPERIMENT_N` (30), the
 *      conventional floor for the normal approximation the intervals lean on.
 *   2. `tie` on a non-significant paired test (Holm-adjusted).
 *   3. `tie` when the top two cells' 95% intervals OVERLAP — the plain-sight
 *      version of the same refusal, and the one an operator reads off the
 *      table. §16 Q7: an honest "underpowered" beats a false leader.
 *
 * Rows compare only when `gradersHash` and `judgeModel` MATCH across cells: a
 * cell graded by another rubric or another judge is a different measurement,
 * so it is excluded from the verdict (and said so) rather than ranked.
 *
 * Pure and offline — no judge calls, no network, no clock beyond the injected
 * one. Every figure is reproducible from (cells, seed) alone.
 */
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import type { MatrixCell, MatrixRow, MatrixVerdict, ModelMatrix } from "./matrix";
import { type DiffSignificance, computeDiffSignificance } from "./significance";

/**
 * Minimum comparable PAIRS before a winner may be named. Mirrors the CLI's
 * `DEFAULT_MIN_EXPERIMENT_N` (`apps/cli/src/experiment.ts`) — the two
 * refusals must not disagree about what "enough evidence" means.
 */
export const DEFAULT_LEADERBOARD_MIN_N = 30;

/** The metrics the leaderboard ranks. Both are "higher is better". */
export const LEADERBOARD_METRICS = ["passRate", "meanScore"] as const;
export type LeaderboardMetric = (typeof LEADERBOARD_METRICS)[number];

/** One head-to-head comparison between two cells on one metric. */
export type LeaderboardComparison = {
  readonly metric: LeaderboardMetric;
  /** The higher-scoring arm of the pair. */
  readonly a: string;
  readonly b: string;
  readonly deltaMean: number;
  readonly pairedN: number;
  readonly pValue: number;
  /** Holm step-down adjusted p across every comparison on this metric. */
  readonly holmP: number;
  readonly deltaCI95: readonly [number, number];
  readonly method: DiffSignificance["method"];
};

/** The verdict for one metric — the block `matrix.json` gains additively.
 *  Defined beside `ModelMatrix` (matrix.ts) so the artifact type owns its own
 *  shape; aliased here because this module is what computes it. */
export type LeaderboardVerdict = MatrixVerdict;

/** `ModelMatrix.verdict`: metric → verdict. Additive; absent on old artifacts. */
export type MatrixVerdicts = Readonly<Record<string, LeaderboardVerdict>>;

export type LeaderboardOptions = {
  /** Comparable-pair floor. Default {@link DEFAULT_LEADERBOARD_MIN_N}. */
  readonly minN?: number;
  /** Seed for the permutation test / bootstrap CI. */
  readonly seed?: number;
  /** Two-sided significance level. Default 0.05. */
  readonly alpha?: number;
};

/** A cell that was excluded from the verdict, and why. */
export type LeaderboardExclusion = {
  readonly model: string;
  readonly armId?: string;
  readonly reason: string;
};

export type Leaderboard = {
  readonly rows: ReadonlyArray<MatrixRow>;
  readonly verdict: MatrixVerdicts;
  /** Every N-choose-2 comparison, for `--pairwise`. */
  readonly comparisons: ReadonlyArray<LeaderboardComparison>;
  readonly excluded: ReadonlyArray<LeaderboardExclusion>;
  readonly minN: number;
};

/** The arm a matrix row names — its `armId` when pinned, else the model. */
export function rowArm(row: { readonly armId?: string; readonly model: string }): string {
  return row.armId ?? row.model;
}

/**
 * A sample's PASS RATE in this run: its trial pass rate under `--repeats`,
 * else the binary verdict. Mirrors `diffReports` exactly so the leaderboard
 * and the diff never disagree about what a sample scored.
 */
function sampleRate(s: SampleResult): number {
  return s.trialPassRate ?? (s.grades.overall.passed ? 1 : 0);
}

function sampleScore(s: SampleResult): number {
  return s.grades.overall.score;
}

/** An abstained sample's verdict is a placeholder, not a measurement. */
function isAbstained(s: SampleResult): boolean {
  return s.error === undefined && s.grades.overall.abstained === true;
}

const metricOf = (metric: LeaderboardMetric): ((s: SampleResult) => number) =>
  metric === "passRate" ? sampleRate : sampleScore;

const rowValue = (row: MatrixRow, metric: LeaderboardMetric): number | undefined =>
  metric === "passRate" ? row.passRate : row.meanScore;

const rowCI = (row: MatrixRow, metric: LeaderboardMetric): readonly [number, number] | undefined =>
  metric === "passRate" ? row.passRateCI95 : row.meanScoreCI95;

/** Do two closed intervals share a point? Absent intervals never overlap. */
export function intervalsOverlap(
  a: readonly [number, number] | undefined,
  b: readonly [number, number] | undefined,
): boolean {
  if (a === undefined || b === undefined) return false;
  return a[0] <= b[1] && b[0] <= a[1];
}

/**
 * Holm step-down adjustment over a family of p-values. Returns the adjusted
 * p for each input, in input order — monotone by construction, so a smaller
 * raw p never adjusts above a larger one.
 */
export function holmAdjust(pValues: ReadonlyArray<number>): number[] {
  const m = pValues.length;
  if (m === 0) return [];
  const order = pValues.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
  const adjusted = new Array<number>(m);
  let running = 0;
  order.forEach((entry, rank) => {
    running = Math.max(running, Math.min(1, (m - rank) * entry.p));
    adjusted[entry.i] = running;
  });
  return adjusted;
}

/** Per-sample paired deltas between two cells on one metric (abstained pairs dropped). */
export function pairedDeltas(
  a: EvalRunSummary,
  b: EvalRunSummary,
  metric: LeaderboardMetric,
): number[] {
  const read = metricOf(metric);
  const byId = new Map(b.samples.map((s) => [s.sampleId, s]));
  const deltas: number[] = [];
  for (const sa of a.samples) {
    const sb = byId.get(sa.sampleId);
    if (sb === undefined) continue;
    if (isAbstained(sa) || isAbstained(sb)) continue;
    deltas.push(read(sa) - read(sb));
  }
  return deltas;
}

/**
 * The measurement instrument of one cell: the graders config and the judge
 * model it graded with. Cells whose instruments differ are not comparable.
 */
function instrumentOf(summary: EvalRunSummary): string {
  return `${summary.config.gradersHash ?? "-"}|${summary.config.judgeModel ?? "-"}`;
}

/**
 * Build the leaderboard over already-rendered matrix rows plus the cells that
 * produced them (the rows carry the aggregates; the cells carry the per-sample
 * results the paired test needs).
 */
export function buildLeaderboard(
  matrix: ModelMatrix,
  cells: ReadonlyArray<MatrixCell>,
  opts: LeaderboardOptions = {},
): Leaderboard {
  const minN = opts.minN ?? DEFAULT_LEADERBOARD_MIN_N;
  const alpha = opts.alpha ?? 0.05;
  const byModel = new Map(cells.map((c) => [c.model, c]));
  const excluded: LeaderboardExclusion[] = [];

  const ok = matrix.rows.filter((r) => r.status === "ok");
  // Instrument grouping: the MAJORITY instrument wins the comparison; every
  // other cell is excluded with the reason, never silently ranked beside it.
  const instruments = new Map<string, MatrixRow[]>();
  for (const row of ok) {
    const summary = byModel.get(row.model)?.summary;
    if (summary === undefined) continue;
    const key = instrumentOf(summary);
    instruments.set(key, [...(instruments.get(key) ?? []), row]);
  }
  let comparable: MatrixRow[] = [];
  for (const rows of instruments.values()) {
    if (rows.length > comparable.length) comparable = rows;
  }
  for (const row of ok) {
    if (comparable.includes(row)) continue;
    excluded.push({
      model: row.model,
      ...(row.armId !== undefined ? { armId: row.armId } : {}),
      reason:
        "graded with a different instrument (gradersHash / judgeModel) than the rest of the board — not comparable",
    });
  }

  const comparisons: LeaderboardComparison[] = [];
  const verdict: Record<string, LeaderboardVerdict> = {};

  for (const metric of LEADERBOARD_METRICS) {
    const ranked = [...comparable]
      .filter((r) => rowValue(r, metric) !== undefined)
      .sort(
        (a, b) =>
          (rowValue(b, metric) as number) - (rowValue(a, metric) as number) ||
          rowArm(a).localeCompare(rowArm(b)),
      );
    const leader = ranked[0];
    if (leader === undefined) continue;
    const runnerUp = ranked[1];
    if (runnerUp === undefined) {
      verdict[metric] = {
        leader: rowArm(leader),
        decision: "underpowered",
        n: 0,
        minN,
        reason: "only one comparable arm on the board — nothing to compare it against",
      };
      continue;
    }

    // Every N-choose-2 comparison on this metric, so the Holm family is the
    // whole board and not just the top pair.
    const family: Array<{ a: MatrixRow; b: MatrixRow; sig: DiffSignificance }> = [];
    for (let i = 0; i < ranked.length; i++) {
      for (let j = i + 1; j < ranked.length; j++) {
        const ra = ranked[i] as MatrixRow;
        const rb = ranked[j] as MatrixRow;
        const sa = byModel.get(ra.model)?.summary;
        const sb = byModel.get(rb.model)?.summary;
        if (sa === undefined || sb === undefined) continue;
        const deltas = pairedDeltas(sa, sb, metric);
        const sig = computeDiffSignificance(
          deltas,
          opts.seed !== undefined ? { seed: opts.seed } : {},
        );
        if (sig === undefined) continue;
        family.push({ a: ra, b: rb, sig });
      }
    }
    const holm = holmAdjust(family.map((f) => f.sig.pValue));
    family.forEach((f, i) => {
      comparisons.push({
        metric,
        a: rowArm(f.a),
        b: rowArm(f.b),
        deltaMean: f.sig.passRateDelta,
        pairedN: f.sig.pairedN,
        pValue: f.sig.pValue,
        holmP: holm[i] as number,
        deltaCI95: f.sig.passRateDeltaCI95,
        method: f.sig.method,
      });
    });

    const topIdx = family.findIndex((f) => f.a === leader && f.b === runnerUp);
    const top = topIdx >= 0 ? family[topIdx] : undefined;
    const n = top?.sig.pairedN ?? 0;
    const holmP = topIdx >= 0 ? (holm[topIdx] as number) : undefined;
    const ciOverlap = intervalsOverlap(rowCI(leader, metric), rowCI(runnerUp, metric));
    const base = {
      leader: rowArm(leader),
      runnerUp: rowArm(runnerUp),
      n,
      minN,
      ...(top !== undefined
        ? { pairedP: top.sig.pValue, deltaCI95: top.sig.passRateDeltaCI95 }
        : {}),
      ...(holmP !== undefined ? { holmP } : {}),
      ...(ciOverlap ? { ciOverlap: true } : {}),
    };
    if (top === undefined || n < minN) {
      verdict[metric] = {
        ...base,
        decision: "underpowered",
        reason: `${n} comparable sample pair(s) — below the ${minN}-pair floor, so no arm can be called a winner (raise the dataset size, or --min-n to override)`,
      };
      continue;
    }
    if (holmP !== undefined && holmP >= alpha) {
      verdict[metric] = {
        ...base,
        decision: "tie",
        reason: `paired sign-flip test not significant at ${alpha} after Holm correction (p=${holmP.toFixed(3)}, n=${n} pairs) — the gap is within sampling noise`,
      };
      continue;
    }
    if (ciOverlap) {
      verdict[metric] = {
        ...base,
        decision: "tie",
        reason: `the top two 95% intervals overlap (${rowArm(leader)} ${fmtCI(rowCI(leader, metric))} vs ${rowArm(runnerUp)} ${fmtCI(rowCI(runnerUp, metric))}) — refusing to name a winner`,
      };
      continue;
    }
    verdict[metric] = {
      ...base,
      decision: "winner",
      reason: `${rowArm(leader)} beats ${rowArm(runnerUp)} on ${n} paired samples (Holm p=${(holmP as number).toFixed(3)}), intervals disjoint`,
    };
  }

  return { rows: matrix.rows, verdict, comparisons, excluded, minN };
}

/** The matrix with its verdict block attached — what `eval leaderboard` writes. */
export function withVerdict(matrix: ModelMatrix, board: Leaderboard): ModelMatrix {
  return { ...matrix, verdict: board.verdict };
}

function fmtCI(ci: readonly [number, number] | undefined): string {
  return ci === undefined ? "[n/a]" : `[${ci[0].toFixed(3)}–${ci[1].toFixed(3)}]`;
}

/** The stdout block: one verdict line per metric, then the exclusions. */
export function formatLeaderboardLines(board: Leaderboard): string[] {
  const lines: string[] = [];
  for (const metric of LEADERBOARD_METRICS) {
    const v = board.verdict[metric];
    if (v === undefined) continue;
    lines.push(`${metric}: ${v.decision.toUpperCase()} — ${v.reason}`);
  }
  for (const e of board.excluded) {
    lines.push(`excluded ${e.armId ?? e.model}: ${e.reason}`);
  }
  return lines;
}

/** The `--pairwise` table: every N-choose-2 comparison, most significant first. */
export function pairwiseTable(board: Leaderboard): { header: string[]; rows: string[][] } {
  const header = ["metric", "a", "b", "delta", "n", "p", "holm_p", "ci95", "method"];
  const rows = [...board.comparisons]
    .sort((x, y) => x.metric.localeCompare(y.metric) || x.holmP - y.holmP)
    .map((c) => [
      c.metric,
      c.a,
      c.b,
      `${c.deltaMean >= 0 ? "+" : ""}${c.deltaMean.toFixed(3)}`,
      String(c.pairedN),
      c.pValue.toFixed(4),
      c.holmP.toFixed(4),
      `[${c.deltaCI95[0].toFixed(3)}, ${c.deltaCI95[1].toFixed(3)}]`,
      c.method,
    ]);
  return { header, rows };
}
