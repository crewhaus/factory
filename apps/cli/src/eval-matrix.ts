/**
 * Item 11 — `crewhaus eval --models <m1,m2,...>`: one-command model
 * benchmark matrix. The CLI resolves the dataset (registry ref or file,
 * item-9 regression union included) ONCE, then runs the same samples +
 * graders once per model, each cell writing a full run directory to
 * `<out>/<model-slug>/` so `eval-report diff` works on any pair of cells.
 *
 * Deliberate non-interactions with the item-3 run-history features:
 * matrix cells are model comparisons, not lineage runs — they never touch
 * `finishEvalRun` (index append / baseline pin / gate / promote), because a
 * shared (spec, dataset) baseline key across N models would corrupt the
 * lineage. `--gate` / `--no-promote` are rejected up front for the same
 * reason (see {@link assertMatrixFlagsCompatible}).
 *
 * Kept in a side-effect-free module (the CLI entry file runs an argv
 * switch on import) mirroring `eval-history.ts` / `datasets.ts`: the
 * per-cell eval execution is injected as `runCell`, so failure isolation
 * is unit-testable without an LLM.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DEFAULT_PRICING, computeCostMicros, resolvePricing } from "@crewhaus/cost-tracker";
import type { MatrixCell, MatrixPricingFn } from "@crewhaus/eval-report";
import type { EvalRunSummary } from "@crewhaus/eval-runner";
import { parseModelString } from "@crewhaus/model-router";

/** Thrown on a malformed `--models` value or an incompatible flag combo.
 *  The CLI entry file catches it and routes the message through `die()`;
 *  tests assert on `.message` without the process exiting. */
export class MatrixArgError extends Error {
  override readonly name = "MatrixArgError";
}

// -------- flag parsing / validation --------

/**
 * Parse `--models m1,m2,...`: split on commas, trim whitespace, drop empty
 * segments (trailing-comma tolerance), reject duplicates, and validate
 * every entry against the model-router grammar UP FRONT — a typo must fail
 * before cell 1 burns a single token.
 */
export function parseModelsFlag(value: string): string[] {
  const models = value
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  if (models.length === 0) {
    throw new MatrixArgError(
      "--models: expected a comma-separated list of model strings (e.g. claude-sonnet-4-5,openai/gpt-4o)",
    );
  }
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model)) {
      throw new MatrixArgError(`--models: duplicate model "${model}"`);
    }
    seen.add(model);
    try {
      parseModelString(model);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new MatrixArgError(`--models: ${msg}`);
    }
  }
  return models;
}

/**
 * `--gate` / `--no-promote` steer the item-3 baseline lineage, which matrix
 * cells skip entirely — reject the combination instead of silently ignoring
 * the flags.
 */
export function assertMatrixFlagsCompatible(flags: {
  readonly gate: boolean;
  readonly noPromote: boolean;
}): void {
  if (flags.gate) {
    throw new MatrixArgError(
      "--models is incompatible with --gate — matrix cells are model comparisons and skip the (spec, dataset) baseline lineage; gate a single-model eval instead",
    );
  }
  if (flags.noPromote) {
    throw new MatrixArgError(
      "--models is incompatible with --no-promote — matrix cells never touch the run index or baselines, so there is nothing to promote",
    );
  }
}

// -------- slugs --------

/**
 * Filesystem-safe cell directory name for a model string: every character
 * outside `[A-Za-z0-9._-]` collapses to a single `_` (so the slug stays
 * readable/reversible-enough: `openai/gpt-4o` → `openai_gpt-4o`,
 * `local/llama3.2@http://localhost:11434/v1` →
 * `local_llama3.2_http_localhost_11434_v1`). A slug with no alphanumeric
 * left (nothing a path could safely be named after — e.g. all dots) falls
 * back to a stable content-hash name.
 */
export function modelSlug(model: string): string {
  const slug = model.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/[A-Za-z0-9]/.test(slug)) {
    return `model_${createHash("sha256").update(model).digest("hex").slice(0, 8)}`;
  }
  return slug;
}

/**
 * model → cell-directory slug for the whole matrix. Distinct models whose
 * slugs collide (e.g. `openai/gpt.4o` vs `openai/gpt_4o`) get a `_2`, `_3`,
 * … suffix in list order, so every cell keeps its own directory.
 */
export function assignCellSlugs(models: ReadonlyArray<string>): Map<string, string> {
  const taken = new Set<string>();
  const out = new Map<string, string>();
  for (const model of models) {
    const base = modelSlug(model);
    let candidate = base;
    for (let i = 2; taken.has(candidate); i += 1) candidate = `${base}_${i}`;
    taken.add(candidate);
    out.set(model, candidate);
  }
  return out;
}

// -------- pricing seam --------

/**
 * The real `MatrixPricingFn` for eval-report's matrix renderer: model
 * string → provider via the model-router grammar, then cost-tracker's
 * versioned pricing table over the cell's token totals (cached-read tokens
 * are 0 — eval aggregates don't track them). Any miss — unparseable model,
 * unknown provider row (e.g. a groq/ or local/ model billed elsewhere) —
 * returns `undefined`, which renders as "n/a" rather than crashing.
 */
export function defaultMatrixPricing(): MatrixPricingFn {
  return (model, tokens) => {
    try {
      const parsed = parseModelString(model);
      const row = resolvePricing(DEFAULT_PRICING, parsed.providerId, parsed.modelId);
      if (row === undefined) return undefined;
      return computeCostMicros(row, tokens.input, tokens.output, 0);
    } catch {
      return undefined;
    }
  };
}

// -------- cell loop (failure isolation) --------

export type RunMatrixCellsOptions = {
  readonly models: ReadonlyArray<string>;
  /** model → cell directory name (see {@link assignCellSlugs}). */
  readonly slugs: ReadonlyMap<string, string>;
  /** Matrix root; each cell runs in `<rootDir>/<slug>`. */
  readonly rootDir: string;
  /** Execute one cell's eval and return its summary. Injected so tests can
   *  stub the runner; the CLI passes a `runEval` wrapper that patches the
   *  lowered ir's `agent.model` in-memory (mirroring `run --model`). */
  readonly runCell: (model: string, cellOutDir: string) => Promise<EvalRunSummary>;
  /** Line sink; defaults to stdout. */
  readonly write?: (line: string) => void;
};

/**
 * "The cell never really ran": eval-runner isolates per-sample invoker
 * errors (a summary always comes back), so a bad credential / 404 model
 * surfaces as EVERY sample erroring rather than as a throw. Map that to a
 * cell failure — its 0% pass rate and 0ms latencies are artifacts of never
 * producing output, not a comparison result. Partial sample errors (a 529
 * blip on 1 of 20) leave the cell a normal "ran with failing samples" row.
 */
export function cellCrashReason(summary: EvalRunSummary): string | undefined {
  const n = summary.samples.length;
  if (n === 0 || summary.aggregates.errorCount < n) return undefined;
  const first = summary.samples.find((s) => s.error !== undefined)?.error;
  return `all ${n} sample(s) errored${first !== undefined ? ` (first: ${first})` : ""}`;
}

/**
 * Run every cell sequentially, isolating failures: one model erroring (bad
 * credentials, 404 model, …) — whether thrown or absorbed by the runner as
 * all-samples-errored (see {@link cellCrashReason}) — records an error cell
 * and the loop continues. The caller maps "any error cell" to a non-zero
 * exit AFTER rendering the matrix — a crashed cell is distinct from a cell
 * that ran with failing samples, which is a normal result.
 */
export async function runMatrixCells(opts: RunMatrixCellsOptions): Promise<MatrixCell[]> {
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const cells: MatrixCell[] = [];
  for (const model of opts.models) {
    const slug = opts.slugs.get(model) ?? modelSlug(model);
    const outDir = join(opts.rootDir, slug);
    write(`[eval] cell ${model} → ${outDir}`);
    try {
      const summary = await opts.runCell(model, outDir);
      const crashed = cellCrashReason(summary);
      if (crashed !== undefined) {
        cells.push({ model, slug, outDir, error: crashed });
        write(`[eval]   cell FAILED (${crashed}) — continuing with remaining models`);
        continue;
      }
      cells.push({ model, slug, outDir, summary });
      write(
        `[eval]   pass_rate=${(summary.aggregates.passRate * 100).toFixed(1)}% ` +
          `mean_score=${summary.aggregates.meanScore.toFixed(3)} ` +
          `errors=${summary.aggregates.errorCount}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cells.push({ model, slug, outDir, error: msg });
      write(`[eval]   cell FAILED (${msg}) — continuing with remaining models`);
    }
  }
  return cells;
}
