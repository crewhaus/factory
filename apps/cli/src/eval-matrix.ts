/**
 * Item 11 — `crewhaus eval --models <m1,m2,...>`: one-command model
 * benchmark matrix. The CLI resolves the dataset (registry ref or file,
 * item-9 regression union included) ONCE, then runs the same samples +
 * graders once per model, each cell writing a full run directory to
 * `<out>/<model-slug>/` so `eval-report diff` works on any pair of cells.
 *
 * 0.6.0 §6.1 (PR 12) — matrix cells BECOME recordable. Until now they never
 * touched `finishEvalRun` (index append / baseline pin / gate / promote)
 * because a shared `spec::dataset` baseline key across N models would corrupt
 * the lineage — a real constraint, and `baselineKeyV2` is what removes it:
 * with `--record`, each cell keys its own `spec::dataset::<armId>` lineage, so
 * `--models pool --record` indexes `…::fast` and `…::strong` separately and a
 * cheap candidate can never pin over the primary's baseline. `--gate` /
 * `--no-promote` are therefore legal UNDER `--record` and rejected without it
 * (see {@link assertMatrixFlagsCompatible}).
 *
 * `--models` also learns two 0.6.0 spellings, both resolved against the
 * lowered IR AFTER the grammar validator (which would otherwise reject `$fast`
 * outright): `$<profile>` names a `models:` registry entry, and the bare word
 * `pool` expands to every routable `model_pool` candidate.
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
import {
  type EvalRoutingMode,
  type EvalRunSummary,
  candidateArmId,
  rosterRefs,
} from "@crewhaus/eval-runner";
import type { IrV0 } from "@crewhaus/ir";
import { PROFILE_NAME_RE } from "@crewhaus/model-plan";
import { parseModelString } from "@crewhaus/model-router";

/** Thrown on a malformed `--models` value or an incompatible flag combo.
 *  The CLI entry file catches it and routes the message through `die()`;
 *  tests assert on `.message` without the process exiting. */
export class MatrixArgError extends Error {
  override readonly name = "MatrixArgError";
}

// -------- flag parsing / validation --------

/** The `--models pool` spelling: expand the spec's own `model_pool` roster. */
export const MATRIX_POOL_TOKEN = "pool";

/**
 * Parse `--models m1,m2,...`: split on commas, trim whitespace, drop empty
 * segments (trailing-comma tolerance), reject duplicates, and validate every
 * entry UP FRONT — a typo must fail before cell 1 burns a single token.
 *
 * Three token shapes are accepted. A plain model string is validated against
 * the model-router grammar exactly as before. `$<profile>` is validated
 * against the profile-name grammar ONLY — it names a `models:` registry entry
 * and is resolved to a model later, against the lowered IR
 * ({@link resolveMatrixArms}), because this parser runs before the spec is
 * compiled and the grammar validator would reject `$fast` outright. The bare
 * word `pool` expands to the whole roster and therefore cannot be mixed with
 * anything else.
 *
 * Documentation must quote `$refs` on a shell command line
 * (`--models '$fast,$strong'`) — an unquoted `$fast` is expanded away by the
 * shell before the CLI ever sees it.
 */
export function parseModelsFlag(value: string): string[] {
  const models = value
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  if (models.length === 0) {
    throw new MatrixArgError(
      "--models: expected a comma-separated list of model strings, $profile refs, or the word `pool` (e.g. claude-sonnet-5,openai/gpt-4o or '$fast,$strong')",
    );
  }
  if (models.includes(MATRIX_POOL_TOKEN)) {
    if (models.length > 1) {
      throw new MatrixArgError(
        "--models pool expands to the spec's whole model_pool roster and cannot be combined with other entries",
      );
    }
    return models;
  }
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model)) {
      throw new MatrixArgError(`--models: duplicate model "${model}"`);
    }
    seen.add(model);
    if (model.startsWith("$")) {
      const name = model.slice(1);
      if (!PROFILE_NAME_RE.test(name)) {
        throw new MatrixArgError(
          `--models: "${model}" is not a valid profile reference — a models: profile name is lowercase [a-z][a-z0-9_-]{0,63}`,
        );
      }
      continue;
    }
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
 * One resolved matrix cell: which model runs, which ARM its history keys on,
 * and how the runner should route it.
 */
export type MatrixArm = {
  /** The `--models` token as typed (`$fast`, `claude-haiku-4-5`). */
  readonly ref: string;
  /** The model the cell's agent runs on. */
  readonly model: string;
  /** The arm the cell's lineage keys on: the profile name, else the model string. */
  readonly armId: string;
  /**
   * The `RunEvalOptions.routing` value the cell runs under. Set only when the
   * ref resolves to a ROSTER member, so the runner honours that candidate's
   * own request params and `instructions` overlay; a bare model string that
   * names nothing in the roster keeps the pre-0.6.0 path (the cell patches
   * `agent.model` and the runner routes `static`), and its lineage is still
   * keyed per-arm by the recorder.
   */
  readonly routing?: EvalRoutingMode;
};

/**
 * Resolve parsed `--models` tokens against the lowered IR. `pool` expands the
 * roster; `$profile` resolves through the pool's candidates first (so a
 * profile used as a candidate keeps that candidate's settings) and then the
 * `models:` registry. A ref that resolves to nothing is a loud error naming
 * what IS declared — never a silent fall-through to "treat it as a model
 * string", which would run the wrong model under the right-looking name.
 */
export function resolveMatrixArms(tokens: ReadonlyArray<string>, ir: IrV0): MatrixArm[] {
  if (tokens.length === 1 && tokens[0] === MATRIX_POOL_TOKEN) {
    const pool = ir.agent.modelPool;
    const candidates = (pool?.candidates ?? []).filter((c) => c.enabled !== false);
    if (candidates.length === 0) {
      throw new MatrixArgError(
        `--models pool: spec "${ir.name}" declares no model_pool candidates — name the models explicitly, or add a model_pool: block`,
      );
    }
    return candidates.map((c) => {
      const armId = candidateArmId(c);
      const ref = c.profile !== undefined ? `$${c.profile}` : c.model;
      return { ref, model: c.model, armId, routing: `candidate:${ref}` as EvalRoutingMode };
    });
  }
  const arms: MatrixArm[] = [];
  for (const token of tokens) {
    if (!token.startsWith("$")) {
      const candidate = (ir.agent.modelPool?.candidates ?? []).find(
        (c) => c.model === token && c.enabled !== false,
      );
      arms.push({
        ref: token,
        model: token,
        armId: candidate !== undefined ? candidateArmId(candidate) : token,
        ...(candidate !== undefined ? { routing: `candidate:${token}` as EvalRoutingMode } : {}),
      });
      continue;
    }
    const name = token.slice(1);
    const profile =
      (ir.agent.modelPool?.candidates ?? []).find(
        (c) => c.profile === name && c.enabled !== false,
      ) ?? ir.models?.[name];
    if (profile === undefined) {
      const known = rosterRefs(ir);
      throw new MatrixArgError(
        `--models: no models: profile or model_pool candidate named "${name}" in spec "${ir.name}"${
          known.length > 0 ? ` (declared: ${known.join(", ")})` : ""
        }`,
      );
    }
    arms.push({
      ref: token,
      model: profile.model,
      armId: name,
      routing: `candidate:${token}` as EvalRoutingMode,
    });
  }
  const seenArms = new Set<string>();
  for (const arm of arms) {
    if (seenArms.has(arm.armId)) {
      throw new MatrixArgError(
        `--models: two entries resolve to the same arm "${arm.armId}" — each cell must key its own lineage`,
      );
    }
    seenArms.add(arm.armId);
  }
  return arms;
}

/**
 * `--gate` / `--no-promote` steer the run-history baseline lineage. Until
 * 0.6.0 matrix cells skipped that lineage entirely, so both flags were
 * rejected outright; `--record` (§6.1) is what makes them meaningful — each
 * cell then keys its OWN `spec::dataset::<armId>` lineage through
 * `finishEvalRun`, so gating and promotion mean exactly what they mean on a
 * single-model run. Without `--record` the old refusal stands, reworded to
 * name the flag that lifts it.
 */
export function assertMatrixFlagsCompatible(flags: {
  readonly gate: boolean;
  readonly noPromote: boolean;
  readonly record?: boolean;
}): void {
  if (flags.record === true) return;
  if (flags.gate) {
    throw new MatrixArgError(
      "--models --gate needs --record — without it matrix cells are one-off model comparisons that never touch a baseline lineage, so there is nothing to gate against. Add --record to key each cell its own per-arm lineage (spec::dataset::<arm>), or gate a single-model eval instead",
    );
  }
  if (flags.noPromote) {
    throw new MatrixArgError(
      "--models --no-promote needs --record — without it matrix cells never touch the run index or baselines, so there is nothing to promote. Add --record to key each cell its own per-arm lineage",
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
  /**
   * One entry per cell, in run order. These are the `--models` TOKENS: a
   * plain model string, or (0.6.0) a `$profile` ref whose model comes from
   * {@link arms}.
   */
  readonly models: ReadonlyArray<string>;
  /** token → cell directory name (see {@link assignCellSlugs}). */
  readonly slugs: ReadonlyMap<string, string>;
  /**
   * 0.6.0 §6.1 — token → the resolved {@link MatrixArm}: the model the cell
   * runs and the ARM its lineage keys on. Absent (a plain `--models a,b`
   * matrix) ⇒ every token IS its model and no cell carries an arm id, exactly
   * as before.
   */
  readonly arms?: ReadonlyMap<string, MatrixArm>;
  /** Matrix root; each cell runs in `<rootDir>/<slug>`. */
  readonly rootDir: string;
  /** Execute one cell's eval and return its summary. Injected so tests can
   *  stub the runner; the CLI passes a `runEval` wrapper that patches the
   *  lowered ir's `agent.model` in-memory (mirroring `run --model`). */
  readonly runCell: (model: string, cellOutDir: string, arm?: MatrixArm) => Promise<EvalRunSummary>;
  /** Line sink; defaults to stdout. */
  readonly write?: (line: string) => void;
};

/** How an all-errored cell's failure looks, from the error text alone:
 *  - `billing` — quota / credit exhaustion (402, insufficient quota, "exceeded
 *    your quota", credit balance, resource exhausted). Re-running WON'T help;
 *    add credits or raise the account quota. Kept distinct from `systemic`
 *    because a 429 quota-exhaustion is NOT a retryable rate limit.
 *  - `systemic` — deterministic auth/config/model errors (401/403/404, invalid
 *    api key, unknown model, bad request). Re-running WON'T help.
 *  - `transient` — provider blips (429 rate limit, 529/5xx, overloaded,
 *    timeout, network reset). Re-running MIGHT help.
 *  - `unknown` — the text matched no bucket. */
export type CellErrorKind = "billing" | "transient" | "systemic" | "unknown";

/**
 * Classify an eval-runner error STRING (`SampleResult.error` is already
 * flattened to `err.message`) into {@link CellErrorKind}. Order matters and
 * mirrors `recovery-engine`'s classify() precedence: BILLING first (a real
 * OpenAI quota-exhaustion arrives as "429 You exceeded your current quota…" —
 * a 429 that is NOT retryable, so it must win over the transient 429 rule),
 * then SYSTEMIC auth/config/model (deterministic even if the message also
 * mentions a retryable word), then TRANSIENT. Works on message text since that
 * is all the cell keeps (the structured status/code recovery-engine reads is
 * gone by the time an invoker error is flattened onto SampleResult.error).
 */
export function classifyCellError(message: string): CellErrorKind {
  const m = message.toLowerCase();
  // Billing / quota exhaustion — includes 429-quota, which is NOT a rate limit.
  // OpenAI: "429 You exceeded your current quota, please check your plan and
  // billing details." · Anthropic: 400 "credit balance is too low" ·
  // Gemini: 429 "Resource has been exhausted" · Bedrock: ServiceQuotaExceeded.
  if (
    /\b402\b|insufficient[\s_-]*quota|exceeded your (?:current )?quota|quota exceeded|billing details|check your plan|credit balance|payment required|resource[\s_-]*(?:has been )?exhausted|resource_exhausted|servicequotaexceeded|service quota exceeded/.test(
      m,
    )
  ) {
    return "billing";
  }
  // Systemic: auth / bad request / missing-or-wrong model.
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
  // Transient: rate limits, overloads, 5xx, network/timeout blips.
  if (
    /\b429\b|\b529\b|\b5\d\d\b|rate[\s_-]*limit|too many requests|overloaded|service unavailable|bad gateway|gateway timeout|timed?[\s_-]*out|timeout|econnreset|etimedout|eai_again|socket hang up|temporarily|try again/.test(
      m,
    )
  ) {
    return "transient";
  }
  return "unknown";
}

/**
 * "The cell never really ran": eval-runner isolates per-sample invoker
 * errors (a summary always comes back), so a bad credential / 404 model
 * surfaces as EVERY sample erroring rather than as a throw. Map that to a
 * cell failure — its 0% pass rate and 0ms latencies are artifacts of never
 * producing output, not a comparison result. Partial sample errors (a 529
 * blip on 1 of 20) leave the cell a normal "ran with failing samples" row.
 *
 * The cell genuinely has no data either way, so this stays a crash — but the
 * reason CLASSIFIES the first error (see {@link classifyCellError}) so a
 * one-sample cell felled by a transient blip reads differently from one felled
 * by a bad credential (the two are otherwise identical: 1 sample, 1 error).
 */
export function cellCrashReason(summary: EvalRunSummary): string | undefined {
  const n = summary.samples.length;
  if (n === 0 || summary.aggregates.errorCount < n) return undefined;
  const first = summary.samples.find((s) => s.error !== undefined)?.error;
  const base = `all ${n} sample(s) errored${first !== undefined ? ` (first: ${first})` : ""}`;
  if (first === undefined) return base;
  switch (classifyCellError(first)) {
    case "billing":
      return `${base} — looks like a quota/billing limit; re-running won't help — add credits or raise the account quota`;
    case "systemic":
      return `${base} — looks systemic (auth/config/model); re-running won't help — check the model id and credentials`;
    case "transient":
      return `${base} — looks like a transient provider error; re-run to confirm`;
    default:
      return base;
  }
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
  for (const token of opts.models) {
    const arm = opts.arms?.get(token);
    // The CELL's model is a real model string (pricing and the report key on
    // it); the token is what the operator typed and what names the directory.
    const model = arm?.model ?? token;
    const armFields = arm !== undefined ? { armId: arm.armId } : {};
    const slug = opts.slugs.get(token) ?? modelSlug(token);
    const outDir = join(opts.rootDir, slug);
    write(
      `[eval] cell ${token}${arm !== undefined && arm.ref !== model ? ` (${model})` : ""} → ${outDir}`,
    );
    try {
      const summary = await opts.runCell(token, outDir, arm);
      const crashed = cellCrashReason(summary);
      if (crashed !== undefined) {
        cells.push({ model, ...armFields, slug, outDir, error: crashed });
        write(`[eval]   cell FAILED (${crashed}) — continuing with remaining models`);
        continue;
      }
      cells.push({ model, ...armFields, slug, outDir, summary });
      write(
        `[eval]   pass_rate=${(summary.aggregates.passRate * 100).toFixed(1)}% ` +
          `mean_score=${summary.aggregates.meanScore.toFixed(3)} ` +
          `errors=${summary.aggregates.errorCount}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cells.push({ model, ...armFields, slug, outDir, error: msg });
      write(`[eval]   cell FAILED (${msg}) — continuing with remaining models`);
    }
  }
  return cells;
}
