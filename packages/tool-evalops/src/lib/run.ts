/**
 * One eval run's `results.json`, read and re-aggregated.
 *
 * The aggregation itself is `@crewhaus/eval-runner`'s `aggregate()` — the
 * function the runner used to produce the figures in the first place. That is
 * the whole reason this tool can call itself a RECOMPUTATION: a second fold
 * written here would agree with the engine until the first release that
 * changed what a pass rate's denominator excludes (abstentions, canaries), and
 * then it would disagree silently, which is worse than not having it.
 *
 * What is added here is what `aggregate()` is not asked to do:
 *
 *   - a tolerant, accounted read (a `results.json` gains fields every release,
 *     and a recompute that refuses last month's run is useless);
 *   - a subset selection, so a caller can ask what the numbers are over just
 *     the samples they care about — with the ids they asked for that were NOT
 *     there listed back, because a silently smaller selection is a silently
 *     different denominator;
 *   - an interval on pass@k and pass^k. The engine ships a Wilson interval on
 *     the pass rate and point estimates for these two. 3 of 5 is not 60%, and
 *     pass@k over a handful of samples is exactly where that matters.
 */
import { existsSync, statSync } from "node:fs";
import * as path from "node:path";
import type { EvalAggregates, EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import { aggregate } from "@crewhaus/eval-runner";
import { statsKernel } from "@crewhaus/tool-math";
import type { SafePath } from "../paths";
import { type Loaded, contain, fail, readResolved, renderPath } from "./read";

/** The file a run directory is identified by. */
export const RESULTS_FILENAME = "results.json";

export type RunDoc = {
  readonly summary: EvalRunSummary;
  /** Workspace-relative path of the file that was read. */
  readonly rel: string;
  readonly bytes: number;
  readonly dir: SafePath;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Read a run's `results.json`, given either the run directory or the file.
 *
 * Both spellings are accepted because both appear in the wild: the run index
 * records a DIRECTORY, and a human pasting a path has the file. Nothing is
 * inferred beyond that — a `run_<hex>` id is NOT resolved against a
 * conventional directory here, because the index knows where a run actually
 * lives and guessing is how a tool reports on the wrong run.
 */
export function readRunDoc(toolName: string, rel: string, maxBytes: number): Loaded<RunDoc> {
  const safe = contain(toolName, rel);
  if (!safe.ok) return safe;
  let target = safe.value;
  let shown = rel;
  let isDir = false;
  try {
    isDir = statSync(target.real).isDirectory();
  } catch {
    return fail("missing", `"${renderPath(rel)}" does not exist or is unreadable`);
  }
  if (isDir) {
    const file = path.join(target.real, RESULTS_FILENAME);
    if (!existsSync(file)) {
      return fail(
        "missing",
        `"${renderPath(rel)}" is a directory with no ${RESULTS_FILENAME} — it is not an eval run directory`,
      );
    }
    target = { ...target, real: file, abs: path.join(target.abs, RESULTS_FILENAME) };
    shown = `${rel}/${RESULTS_FILENAME}`;
  }
  const read = readResolved(target, shown, maxBytes);
  if (!read.ok) return read;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.value.text);
  } catch (err) {
    return fail(
      "malformed",
      `"${renderPath(shown)}" is not valid JSON (${(err as Error).message})`,
    );
  }
  if (!isRecord(parsed)) {
    return fail("malformed", `"${renderPath(shown)}" is not a JSON object`);
  }
  if (!Array.isArray(parsed["samples"])) {
    return fail(
      "malformed",
      `"${renderPath(shown)}" has no "samples" array — is it an eval results.json?`,
    );
  }
  return {
    ok: true,
    value: {
      summary: parsed as unknown as EvalRunSummary,
      rel: shown,
      bytes: read.value.bytes,
      dir: safe.value,
    },
  };
}

export type UnusableSample = { readonly sampleId: string; readonly reason: string };

/**
 * The fields `aggregate()` reads off every sample without checking.
 *
 * A persisted sample missing `tokens` or `grades.overall` makes the fold throw
 * on a property of `undefined`. Dropping such a sample silently would change
 * the denominator of every rate in the result, so each one is named instead,
 * and the caller is told the recomputation is over fewer samples than the file
 * holds.
 */
export function sampleProblem(raw: unknown): string | undefined {
  if (!isRecord(raw)) return "not a JSON object";
  if (typeof raw["sampleId"] !== "string" || raw["sampleId"] === "") return "no sampleId";
  const grades = raw["grades"];
  if (!isRecord(grades)) return "no grades block";
  const overall = grades["overall"];
  if (!isRecord(overall)) return "no grades.overall";
  if (typeof overall["passed"] !== "boolean") return "grades.overall.passed is not a boolean";
  if (typeof overall["score"] !== "number" || !Number.isFinite(overall["score"])) {
    return "grades.overall.score is not a finite number";
  }
  if (typeof raw["turns"] !== "number" || !Number.isFinite(raw["turns"])) {
    return "turns is not a finite number";
  }
  if (typeof raw["latencyMs"] !== "number" || !Number.isFinite(raw["latencyMs"])) {
    return "latencyMs is not a finite number";
  }
  const tokens = raw["tokens"];
  if (
    !isRecord(tokens) ||
    typeof tokens["input"] !== "number" ||
    typeof tokens["output"] !== "number"
  ) {
    return "tokens.input/tokens.output are not numbers";
  }
  // A12 — `aggregate()` iterates `grades.perGrader` on every non-errored
  // sample (`for (const g of s.grades.perGrader)`). A results.json written
  // without it makes the fold throw "not iterable", which this package used to
  // surface as a whole-tool refusal: ONE unreadable sample took the other
  // ninety-nine with it. It belongs in the per-sample account like the rest.
  if (!Array.isArray(grades["perGrader"])) return "grades.perGrader is not an array";
  // G15 — the trials fold reads `.some`/`.every` and each trial's tokens, but
  // only after `trials.length > 0`, which a STRING also satisfies.
  const trials = raw["trials"];
  if (trials !== undefined) {
    if (!Array.isArray(trials)) return "trials is present but not an array";
    for (const trial of trials) {
      if (!isRecord(trial) || typeof trial["passed"] !== "boolean") {
        return "a trial has no boolean passed";
      }
      const tt = trial["tokens"];
      if (!isRecord(tt) || typeof tt["input"] !== "number" || typeof tt["output"] !== "number") {
        return "a trial's tokens.input/tokens.output are not numbers";
      }
    }
  }
  return undefined;
}

export type Selection = {
  /** Only these sample ids. */
  readonly sampleIds?: ReadonlyArray<string>;
  /** Only samples whose `metadata[key]` stringifies to `value` — the same
   *  slice keys `eval-runner` groups on. */
  readonly metadataKey?: string;
  readonly metadataValue?: string;
};

export type SelectionReport = {
  readonly requested: number;
  readonly selected: number;
  /** Ids the caller asked for that this run does not contain. Returning a
   *  smaller selection without saying which ids were missing is how a subset
   *  becomes a different question with the same name. */
  readonly missingIds: ReadonlyArray<string>;
  readonly filter?: string;
};

export type Interval = {
  readonly successes: number;
  readonly trials: number;
  readonly pointEstimate: number;
  readonly lower: number;
  readonly upper: number;
  readonly width: number;
  readonly note: string;
};

export type Recomputation = {
  readonly sampleCount: number;
  /** Samples `aggregate()` was actually given. */
  readonly aggregatedSamples: number;
  readonly unusableSamples: ReadonlyArray<UnusableSample>;
  /** False when anything was dropped or filtered — the figures then describe
   *  a subset, not the run. */
  readonly complete: boolean;
  readonly aggregates: EvalAggregates;
  readonly intervals: {
    readonly passRate?: Interval;
    readonly passAtK?: Interval;
    readonly passHatK?: Interval;
    /** Named reasons an interval was NOT produced. An absent interval with no
     *  reason would read as "no uncertainty". */
    readonly unavailable: ReadonlyArray<{ readonly metric: string; readonly reason: string }>;
  };
  readonly selection: SelectionReport;
};

function toInterval(successes: number, trials: number): Interval | undefined {
  const wilson = statsKernel.wilsonScoreInterval(successes, trials);
  if (wilson === null) return undefined;
  return {
    successes,
    trials,
    pointEstimate: wilson.pointEstimate,
    lower: wilson.lower,
    upper: wilson.upper,
    width: wilson.width,
    note: wilson.note,
  };
}

/**
 * Recover the integer numerator behind a rate the engine reported.
 *
 * `passAtK` is `count / total` with an integer count, so the count is
 * recoverable exactly; the tolerance is there for the float round trip, not to
 * paper over a rate whose denominator was something else. When the product is
 * not a whole number the denominator was NOT `total`, and inventing a count
 * would produce an interval that is narrower than the truth — an overconfident
 * interval is worse than no interval.
 */
export function countBehindRate(rate: number, total: number): number | undefined {
  const product = rate * total;
  const rounded = Math.round(product);
  if (Math.abs(product - rounded) > 1e-6) return undefined;
  if (rounded < 0 || rounded > total) return undefined;
  return rounded;
}

/** Recompute a run's aggregates, optionally over a subset of its samples. */
export function recompute(summary: EvalRunSummary, selection: Selection = {}): Recomputation {
  const rawSamples: ReadonlyArray<unknown> = Array.isArray(summary.samples) ? summary.samples : [];
  const unusable: UnusableSample[] = [];
  const usable: SampleResult[] = [];
  rawSamples.forEach((raw, i) => {
    const problem = sampleProblem(raw);
    if (problem === undefined) {
      usable.push(raw as SampleResult);
      return;
    }
    const id =
      isRecord(raw) && typeof raw["sampleId"] === "string" && raw["sampleId"] !== ""
        ? raw["sampleId"]
        : `<sample ${i}>`;
    unusable.push({ sampleId: id, reason: problem });
  });

  const wanted = selection.sampleIds;
  const present = new Set(usable.map((s) => s.sampleId));
  const missingIds = wanted === undefined ? [] : wanted.filter((id) => !present.has(id));
  let selected = usable;
  const filters: string[] = [];
  if (wanted !== undefined) {
    const want = new Set(wanted);
    selected = selected.filter((s) => want.has(s.sampleId));
    filters.push(`${wanted.length} sample id(s)`);
  }
  if (selection.metadataKey !== undefined) {
    const key = selection.metadataKey;
    const value = selection.metadataValue;
    selected = selected.filter((s) => {
      const meta = s.metadata;
      if (meta === undefined) return false;
      // OWN properties only. `meta["__proto__"]` is Object.prototype and
      // `meta["toString"]` is a function on every parsed object, so a plain
      // `meta[key] !== undefined` made those two keys select EVERY sample
      // carrying metadata and report it as the slice the caller named — a
      // selector that matches far more than it says it does, with a pass rate
      // attached. The key is a lookup, never a pattern: it matches a metadata
      // field this sample actually has, or nothing.
      if (!Object.hasOwn(meta, key)) return false;
      const held = meta[key];
      if (held === undefined) return false;
      // Compare the PARSED value's string form, not the raw JSON text: a
      // metadata value of 3 and a filter of "3" are the same slice, and a
      // filter compared against the source text would miss it.
      return value === undefined || String(held) === value;
    });
    filters.push(
      value === undefined
        ? `metadata."${key}" present`
        : `metadata."${key}" === ${JSON.stringify(value)}`,
    );
  }

  const aggregates = aggregate(selected);
  const total = selected.length;
  const unavailable: Array<{ metric: string; reason: string }> = [];
  const intervals: {
    passRate?: Interval;
    passAtK?: Interval;
    passHatK?: Interval;
  } = {};

  // The pass rate's denominator excludes abstained and canary samples, and the
  // aggregate reports both counts, so the graded denominator is recoverable
  // exactly rather than assumed to be the sample count.
  const gradedTotal = total - (aggregates.needsHuman ?? 0) - (aggregates.canary ?? 0);
  const passes = countBehindRate(aggregates.passRate, gradedTotal);
  if (gradedTotal <= 0) {
    unavailable.push({
      metric: "passRate",
      reason:
        "no sample in this selection was graded (all abstained, canary or errored out of the denominator)",
    });
  } else if (passes === undefined) {
    unavailable.push({
      metric: "passRate",
      reason: `passRate ${aggregates.passRate} over ${gradedTotal} graded sample(s) is not a whole count of passes — the interval would be a guess`,
    });
  } else {
    intervals.passRate = toInterval(passes, gradedTotal);
  }
  for (const [metric, rate] of [
    ["passAtK", aggregates.passAtK],
    ["passHatK", aggregates.passHatK],
  ] as const) {
    if (rate === undefined) continue;
    const count = countBehindRate(rate, total);
    if (count === undefined) {
      unavailable.push({
        metric,
        reason: `${metric} ${rate} over ${total} sample(s) is not a whole count — the interval would be a guess`,
      });
      continue;
    }
    const interval = toInterval(count, total);
    if (interval === undefined) {
      unavailable.push({
        metric,
        reason: "no samples — an interval on no observations is fabrication",
      });
      continue;
    }
    intervals[metric] = interval;
  }

  return {
    sampleCount: rawSamples.length,
    aggregatedSamples: total,
    unusableSamples: unusable,
    complete: unusable.length === 0 && total === rawSamples.length,
    aggregates,
    intervals: { ...intervals, unavailable },
    selection: {
      requested: wanted?.length ?? rawSamples.length,
      selected: total,
      missingIds,
      ...(filters.length > 0 ? { filter: filters.join(" and ") } : {}),
    },
  };
}

/** How far the recomputation moved from what the file DECLARED. */
export type DeclaredDelta = {
  readonly field: string;
  readonly declared: number;
  readonly recomputed: number;
  readonly delta: number;
};

/** A declared field the comparison could not check, and why. */
export type UncomparableField = { readonly field: string; readonly reason: string };

/**
 * What comparing the file's own aggregate block against the recomputation
 * came to: agreement, disagreement, or NEITHER.
 *
 * The third answer is the one this type exists for. A `results.json` with no
 * `aggregates` block at all, and one whose declared `passRate` is the string
 * `"0.9"`, both used to produce an empty delta list — and an empty delta list
 * was reported as `declaredAgrees: true`. That is the "could not determine
 * reported as a definite answer" failure exactly: a gate asking "do the
 * published figures match the samples?" got a green out of a file that
 * published nothing to match.
 */
export type DeclaredComparison = {
  /** `true` agrees, `false` disagrees, `null` COULD NOT BE DETERMINED. */
  readonly agrees: boolean | null;
  readonly deltas: ReadonlyArray<DeclaredDelta>;
  /** Fields present in the declared block that could not be compared. An
   *  "agrees" that hides one of these is the same lie in miniature. */
  readonly uncomparable: ReadonlyArray<UncomparableField>;
  /** Fields actually checked. `agrees: true` over zero of them is not a check. */
  readonly compared: ReadonlyArray<string>;
  /** Present exactly when `agrees` is null: why no verdict was reached. */
  readonly unavailableReason?: string;
};

/**
 * Compare the file's own aggregate block against the recomputation.
 *
 * Only meaningful over the whole run — a subset is expected to differ, and
 * saying so is not a finding. A disagreement over the whole run IS one: it
 * means the persisted summary and its own samples do not describe the same
 * run, which a gate reading either number would never notice.
 *
 * `complete` is the recomputation's own flag: when a sample was dropped as
 * unreadable, every recomputed denominator shrank, so a delta against the
 * file's figures measures the dropped samples rather than the file. That is a
 * verdict this function must refuse to reach, not one it should report as a
 * disagreement.
 */
export function compareDeclared(
  summary: EvalRunSummary,
  recomputed: EvalAggregates,
  complete = true,
  tolerance = 1e-9,
): DeclaredComparison {
  const declared = summary.aggregates;
  if (declared === undefined || !isRecord(declared)) {
    return {
      agrees: null,
      deltas: [],
      uncomparable: [],
      compared: [],
      unavailableReason:
        'this results.json declares no "aggregates" block, so there is nothing to check its samples against — no figures were published here, which is not the same as published figures that agree',
    };
  }
  const deltas: DeclaredDelta[] = [];
  const uncomparable: UncomparableField[] = [];
  const compared: string[] = [];
  const pairs: Array<[string, unknown, number | undefined]> = [
    ["passRate", declared.passRate, recomputed.passRate],
    ["meanScore", declared.meanScore, recomputed.meanScore],
    ["errorCount", declared.errorCount, recomputed.errorCount],
    ["p50LatencyMs", declared.p50LatencyMs, recomputed.p50LatencyMs],
    ["p95LatencyMs", declared.p95LatencyMs, recomputed.p95LatencyMs],
    ["passAtK", declared.passAtK, recomputed.passAtK],
    ["passHatK", declared.passHatK, recomputed.passHatK],
  ];
  for (const [field, a, b] of pairs) {
    if (a === undefined) continue;
    // A declared field that is not a finite number was silently SKIPPED here,
    // so a file declaring `passRate: "0.9"` compared nothing and agreed.
    if (typeof a !== "number" || !Number.isFinite(a)) {
      uncomparable.push({
        field,
        reason: `the file declares ${field} as ${JSON.stringify(a)}, which is not a number — it could not be checked against the recomputed ${b ?? "(absent)"}`,
      });
      continue;
    }
    if (typeof b !== "number") {
      uncomparable.push({
        field,
        reason: `the file declares ${field} ${a} but the recomputation produced none — this run's samples do not support that figure either way`,
      });
      continue;
    }
    compared.push(field);
    if (Math.abs(a - b) <= tolerance) continue;
    deltas.push({ field, declared: a, recomputed: b, delta: b - a });
  }
  if (!complete) {
    return {
      agrees: null,
      deltas,
      uncomparable,
      compared,
      unavailableReason:
        "the recomputation left samples out (see unusableSamples), so every recomputed denominator is smaller than the file's — a delta here would measure the dropped samples, not the published figures",
    };
  }
  if (compared.length === 0) {
    return {
      agrees: null,
      deltas,
      uncomparable,
      compared,
      unavailableReason:
        "the declared aggregate block holds no field this recomputation could compare against — nothing was checked, which is not agreement",
    };
  }
  // A DEFINITE disagreement stays definite: one field that provably differs is
  // a finding whatever else could not be read. But agreement must not be
  // definite while a declared field went unchecked — a caller asking "do the
  // published figures match the samples?" and reading `true` off a file whose
  // passRate was the string "0.9" has been told the opposite of the truth
  // about the one field it cared about.
  if (deltas.length > 0) return { agrees: false, deltas, uncomparable, compared };
  if (uncomparable.length > 0) {
    return {
      agrees: null,
      deltas,
      uncomparable,
      compared,
      unavailableReason: `${compared.join(", ")} agree with the samples, but ${uncomparable
        .map((u) => u.field)
        .join(
          ", ",
        )} could not be checked at all — a verdict over part of the declared block is not a verdict over the block`,
    };
  }
  return { agrees: true, deltas, uncomparable, compared };
}

/**
 * Cross-check the engine's own Wilson interval against the kernel's.
 *
 * Two implementations of the same published interval live in this repository
 * (`eval-runner`'s `wilsonCI95` and `@crewhaus/tool-math`'s
 * `wilsonScoreInterval`). They agree today. This is the guard that says so on
 * every call rather than assuming it, and it costs two multiplications.
 *
 * THE TOLERANCE IS NOT ARBITRARY, and it is not 1e-9. The two implementations
 * carry the 95% critical value to different precision — eval-runner rounds it
 * to 1.959964, the kernel keeps 1.959963984540054 — so their bounds differ by
 * about 2e-9 on an ordinary run. At 1e-9 this guard fired on EVERY call with a
 * graded sample, reporting "two implementations of one interval have drifted"
 * about two numbers that agree to nine significant figures. A guard that
 * always fires is a guard nobody reads, and it would have hidden the real
 * drift it exists to catch. 1e-6 is three orders of magnitude above what the
 * rounded constant can produce and far below any change to the formula, the
 * confidence level or the counts — the three things worth hearing about.
 */
export const WILSON_CROSS_CHECK_TOLERANCE = 1e-6;

export function wilsonDisagreement(
  engine: readonly [number, number] | undefined,
  kernel: Interval | undefined,
  tolerance = WILSON_CROSS_CHECK_TOLERANCE,
): string | undefined {
  if (engine === undefined || kernel === undefined) return undefined;
  const [lo, hi] = engine;
  if (Math.abs(lo - kernel.lower) <= tolerance && Math.abs(hi - kernel.upper) <= tolerance) {
    return undefined;
  }
  return `the run's recorded Wilson interval [${lo}, ${hi}] and @crewhaus/tool-math's [${kernel.lower}, ${kernel.upper}] disagree by more than ${tolerance} — more than the two z constants' rounding can explain, so two implementations of one interval have drifted`;
}
