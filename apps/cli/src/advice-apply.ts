/**
 * Item 15 — `crewhaus optimize --from-advice <suggestions.json>`: the
 * eval-gated apply path for the SpecPatches `crewhaus advise` emits
 * (agent.max_tokens, compaction.curate, …). The optimize search only ever
 * constructs `agent.instructions` patches; this module closes the other
 * half of the telemetry loop by taking the advisor's pre-validated config
 * patches and accepting each one only after a real eval proves it safe.
 *
 * The loop mirrors the flywheel's accept-then-write shape (baseline eval →
 * per-candidate compile gate → candidate eval → acceptance gate), with two
 * deliberate differences:
 *
 *   1. ONE baseline. The unpatched spec is evaluated exactly once; every
 *      candidate (accumulated accepted spec + patch k) is judged against
 *      that same baseline, so N patches cost N+1 evals, not 2N.
 *   2. ACCEPTANCE: gate-pass only — the strict run-history gate must hold
 *      (`gateRuns`: any pass-rate drop or per-sample pass→fail flip
 *      rejects, fail-closed on incomparable rates), but strict improvement
 *      is NOT required. Advisor patches tune config for latency/cost/
 *      robustness, not accuracy — an equal pass rate with zero regressions
 *      is exactly the "didn't break anything" bar they need to clear. The
 *      delta is printed and persisted either way. (Contrast the flywheel,
 *      which additionally demands pass_rate strictly up: a rewritten
 *      prompt that buys nothing is not worth a PR; a max_tokens bump that
 *      holds the pass rate still fixes truncations.)
 *
 * Accepted patches COMPOSE: patch k+1 applies on top of the accumulated
 * accepted YAML, so the final write-back is one coherent spec. Rejected
 * patches are reported with their eval delta and never touch the
 * accumulation. Every patch re-runs `validatePatch` against the CURRENT
 * accumulated spec — the OPTIMIZABLE_PATHS whitelist stays the safety
 * floor even for a hand-edited suggestions file.
 *
 * Kept in a side-effect-free module (the CLI entry file runs an argv
 * switch on import) mirroring `eval-history.ts` / `advise-rules.ts`: the
 * loop takes injected compile/eval hooks so accept/reject/compose
 * semantics are unit-testable with synthetic summaries — no credentials.
 */
import type { EvalRunSummary } from "@crewhaus/eval-runner";
import { parseSpec } from "@crewhaus/spec";
import {
  type SpecPatch,
  applySpecPatch,
  formatWriteBackHeader,
  validatePatch,
} from "@crewhaus/spec-patch";
import { gateRuns } from "./eval-history";

/** Thrown on invalid flag combos and suggestions-file validation failures.
 *  The CLI entry file catches it and routes the message through `die()`;
 *  tests assert on `.message` without the process exiting. */
export class AdviceApplyError extends Error {
  override readonly name = "AdviceApplyError";
}

// -------- flag validation --------

/**
 * `--from-advice` replaces the mutation search entirely — the patches come
 * from the suggestions file, so the mutator/iteration knobs have nothing to
 * steer. Reject the combination loudly instead of silently ignoring flags
 * the user believed were in effect (mirrors eval-matrix's
 * `assertMatrixFlagsCompatible`). --dataset/--graders/--ratings still
 * resolve as usual: the apply path needs an eval.
 */
export function assertFromAdviceFlagsCompatible(flags: {
  readonly mutator: boolean;
  readonly iterations: boolean;
  /** D36/D44 — `--stage` narrows a per-stage SEARCH; the advice path runs none. */
  readonly stage?: boolean;
}): void {
  if (flags.mutator) {
    throw new AdviceApplyError(
      "--from-advice is mutually exclusive with --mutator — the patches come from the suggestions file; no mutation search runs",
    );
  }
  if (flags.iterations) {
    throw new AdviceApplyError(
      "--from-advice is mutually exclusive with --iterations — every patch in the suggestions file is evaluated exactly once",
    );
  }
  if (flags.stage === true) {
    throw new AdviceApplyError(
      "--stage has no meaning with --from-advice — the advice path applies pre-computed patches to the paths the suggestions name and runs no per-stage search",
    );
  }
}

// -------- suggestions.json validation --------

/** One patch lifted out of a validated suggestions.json entry. */
export type ParsedAdvicePatch = {
  readonly findingId?: string;
  readonly summary?: string;
  readonly patch: SpecPatch;
};

const PATCH_OPS: ReadonlySet<string> = new Set(["replace", "add", "remove"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Structural validation of one entry's `patch` — shape only; the
 *  spec-aware checks (target match, OPTIMIZABLE_PATHS) run per-patch in
 *  the loop via `validatePatch`. Returns an error string or undefined. */
function patchShapeError(patch: unknown): string | undefined {
  if (!isPlainObject(patch)) return "patch must be an object";
  if (typeof patch["target"] !== "string" || patch["target"] === "") {
    return "patch.target must be a non-empty string";
  }
  const path = patch["path"];
  if (
    !Array.isArray(path) ||
    path.length === 0 ||
    path.some((p) => typeof p !== "string" || p === "")
  ) {
    return "patch.path must be a non-empty array of non-empty strings";
  }
  const op = patch["op"];
  if (typeof op !== "string" || !PATCH_OPS.has(op)) {
    return `patch.op must be one of replace|add|remove (got ${JSON.stringify(op)})`;
  }
  if (op !== "remove" && patch["value"] === undefined) {
    return `patch.value is required for op "${op}"`;
  }
  if (patch["rationale"] !== undefined && typeof patch["rationale"] !== "string") {
    return "patch.rationale must be a string when present";
  }
  return undefined;
}

/**
 * Parse and schema-validate a suggestions.json produced by `crewhaus
 * advise` (`buildSuggestionsFile` in ./advise-rules). Unknown or invalid
 * patches are REJECTED with a clear per-entry error — an apply path must
 * never guess at a malformed mutation. Advice-only findings never reach
 * the file (they are report-only), so every entry must carry a patch.
 */
export function parseSuggestionsFile(text: string): ParsedAdvicePatch[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new AdviceApplyError(
      `suggestions file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed["suggestions"])) {
    throw new AdviceApplyError(
      'suggestions file must be an object with a "suggestions" array (the `crewhaus advise` suggestions.json format)',
    );
  }
  const out: ParsedAdvicePatch[] = [];
  for (const [i, entry] of parsed["suggestions"].entries()) {
    if (!isPlainObject(entry)) {
      throw new AdviceApplyError(`suggestions[${i}] must be an object`);
    }
    const findingId = typeof entry["findingId"] === "string" ? entry["findingId"] : undefined;
    const label =
      findingId !== undefined ? `suggestions[${i}] (${findingId})` : `suggestions[${i}]`;
    const shapeError = patchShapeError(entry["patch"]);
    if (shapeError !== undefined) {
      throw new AdviceApplyError(`${label}: ${shapeError}`);
    }
    const raw = entry["patch"] as Record<string, unknown>;
    const patch: SpecPatch = {
      target: raw["target"] as SpecPatch["target"],
      path: raw["path"] as ReadonlyArray<string>,
      op: raw["op"] as SpecPatch["op"],
      ...(raw["value"] !== undefined ? { value: raw["value"] } : {}),
      ...(typeof raw["rationale"] === "string" ? { rationale: raw["rationale"] } : {}),
    };
    out.push({
      ...(findingId !== undefined ? { findingId } : {}),
      ...(typeof entry["summary"] === "string" ? { summary: entry["summary"] } : {}),
      patch,
    });
  }
  return out;
}

// -------- acceptance gate --------

export type AdvicePatchVerdict = {
  readonly accepted: boolean;
  readonly reason: string;
  readonly passRateBefore: number;
  readonly passRateAfter: number;
  /** Sample-level pass→fail flips vs. the baseline run. */
  readonly regressions: number;
  /** Sample-level fail→pass flips vs. the baseline run. */
  readonly recoveries: number;
};

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * The from-advice acceptance bar (see the module header for the full
 * rationale): the strict run-history gate must pass (`gateRuns`, the same
 * gate the flywheel and `eval --gate` use: any pass-rate drop or
 * per-sample pass→fail flip fails), but — unlike the flywheel — strict
 * improvement is NOT required. Config patches fix latency/cost/robustness,
 * not accuracy, so equal pass rate with zero regressions ACCEPTS; the
 * delta is reported either way. Fail-closed on incomparable pass rates
 * (a NaN rate satisfies no comparison, so it must reject explicitly).
 */
export function evaluateAdvicePatchAcceptance(
  before: EvalRunSummary,
  after: EvalRunSummary,
): AdvicePatchVerdict {
  const passRateBefore = before.aggregates.passRate;
  const passRateAfter = after.aggregates.passRate;
  const verdict = gateRuns(before, after);
  const base = {
    passRateBefore,
    passRateAfter,
    regressions: verdict.report.regressions.length,
    recoveries: verdict.report.recoveries.length,
  };
  if (!Number.isFinite(passRateBefore) || !Number.isFinite(passRateAfter)) {
    return {
      accepted: false,
      reason:
        `pass_rate not comparable (before=${String(passRateBefore)}, ` +
        `after=${String(passRateAfter)}) — rejecting fail-closed`,
      ...base,
    };
  }
  if (verdict.verdict === "fail") {
    return { accepted: false, reason: verdict.reason ?? "regression gate failed", ...base };
  }
  // Gate passed ⇒ no drop and no flips. Equal-or-better both accept; word
  // the reason so the printed delta documents which case this was.
  if (passRateAfter > passRateBefore) {
    return {
      accepted: true,
      reason: `pass_rate ${pct(passRateBefore)} → ${pct(passRateAfter)} with zero regressions`,
      ...base,
    };
  }
  return {
    accepted: true,
    reason: `pass_rate held at ${pct(passRateBefore)} with zero regressions (config patch: gate-pass accepts; strict improvement not required)`,
    ...base,
  };
}

// -------- the loop (injected hooks → unit-testable accept/reject/compose) --------

export type AdviceApplyHooks = {
  /** Offline parse→lower gate. Throws when the compiler rejects the YAML.
   *  `label` is `"baseline"` or the candidate's `patch-NNN` label. */
  readonly compileCheck: (yaml: string, label: string) => void;
  /** One full eval pass of `yaml` over the dev split. The CLI persists the
   *  run under `<out>/advice/<label>/`. */
  readonly evalRun: (label: string, yaml: string) => Promise<EvalRunSummary>;
};

export type AdvicePatchDecision = {
  /** 1-based position in the suggestions file; matches the `patch-NNN`
   *  eval-dir label. */
  readonly index: number;
  readonly findingId?: string;
  readonly summary?: string;
  readonly patch: SpecPatch;
  readonly status: "accepted" | "rejected";
  readonly reason: string;
  /** Present when the patch reached its eval (absent for patches rejected
   *  by validation / apply / compile — no eval was spent on those). */
  readonly passRateBefore?: number;
  readonly passRateAfter?: number;
  readonly regressions?: number;
  readonly recoveries?: number;
  readonly evalDir?: string;
};

export type ApplyAdvicePatchesResult = {
  readonly baseline: EvalRunSummary;
  readonly decisions: ReadonlyArray<AdvicePatchDecision>;
  readonly accepted: number;
  /** The accumulated accepted YAML (identical to the source when nothing
   *  was accepted). NOT yet written anywhere — accept-then-write. */
  readonly finalYaml: string;
  /** The last ACCEPTED candidate's eval summary — the "after" side for the
   *  write-back header and regression pinning. Absent when 0 accepted. */
  readonly finalSummary?: EvalRunSummary;
};

/** Format a candidate's eval-dir label from its 1-based index. */
export function patchLabel(index: number): string {
  return `patch-${String(index).padStart(3, "0")}`;
}

/**
 * The complete eval-gated apply loop. The source is never written by this
 * function — the caller owns write-back gating (`--write-back`). Baseline
 * runs ONCE; each candidate is the accumulated accepted YAML plus patch k,
 * compared against that one baseline. A baseline compile/eval failure
 * propagates (nothing useful can happen without it); every per-patch
 * failure (whitelist, apply conflict, compile, gate) records a rejection
 * and the loop continues with the remaining patches.
 */
export async function applyAdvicePatches(opts: {
  readonly sourceYaml: string;
  readonly patches: ReadonlyArray<ParsedAdvicePatch>;
  readonly hooks: AdviceApplyHooks;
}): Promise<ApplyAdvicePatchesResult> {
  const { hooks } = opts;
  // 1. Offline sanity gate — a spec that doesn't compile must never reach
  //    the (paid) baseline eval.
  hooks.compileCheck(opts.sourceYaml, "baseline");

  // 2. Baseline eval — once, on the unpatched spec.
  const baseline = await hooks.evalRun("baseline", opts.sourceYaml);

  const decisions: AdvicePatchDecision[] = [];
  let accumulatedYaml = opts.sourceYaml;
  let accepted = 0;
  let finalSummary: EvalRunSummary | undefined;

  for (const [i, entry] of opts.patches.entries()) {
    const index = i + 1;
    const label = patchLabel(index);
    const meta = {
      index,
      ...(entry.findingId !== undefined ? { findingId: entry.findingId } : {}),
      ...(entry.summary !== undefined ? { summary: entry.summary } : {}),
      patch: entry.patch,
    };

    // 3a. Spec-aware validation against the CURRENT accumulated spec: the
    //     OPTIMIZABLE_PATHS whitelist + target match stay the safety floor
    //     even for a hand-edited suggestions file.
    try {
      validatePatch(parseSpec(accumulatedYaml), entry.patch);
    } catch (err) {
      decisions.push({
        ...meta,
        status: "rejected",
        reason: `patch invalid: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    // 3b. Apply in-memory on top of the accumulated accepted YAML.
    let candidateYaml: string;
    try {
      candidateYaml = applySpecPatch(accumulatedYaml, entry.patch).yaml;
    } catch (err) {
      decisions.push({
        ...meta,
        status: "rejected",
        reason: `patch failed to apply: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    // 3c. Compile gate before the paid eval.
    try {
      hooks.compileCheck(candidateYaml, label);
    } catch (err) {
      decisions.push({
        ...meta,
        status: "rejected",
        reason: `patched spec failed to compile: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    // 3d. Candidate eval + acceptance gate vs. the ONE baseline.
    const candidate = await hooks.evalRun(label, candidateYaml);
    const verdict = evaluateAdvicePatchAcceptance(baseline, candidate);
    const evalFields = {
      passRateBefore: verdict.passRateBefore,
      passRateAfter: verdict.passRateAfter,
      regressions: verdict.regressions,
      recoveries: verdict.recoveries,
      evalDir: candidate.outDir,
    };
    if (!verdict.accepted) {
      decisions.push({ ...meta, status: "rejected", reason: verdict.reason, ...evalFields });
      continue;
    }
    accumulatedYaml = candidateYaml;
    finalSummary = candidate;
    accepted += 1;
    decisions.push({ ...meta, status: "accepted", reason: verdict.reason, ...evalFields });
  }

  return {
    baseline,
    decisions,
    accepted,
    finalYaml: accumulatedYaml,
    ...(finalSummary !== undefined ? { finalSummary } : {}),
  };
}

// -------- artifacts + write-back stamping --------

export type AdviceDecisionsFile = {
  readonly runId: string;
  readonly generatedAt: string;
  /** The suggestions file the patches came from. */
  readonly source: string;
  readonly baseline: { readonly passRate: number; readonly evalDir: string };
  readonly evaluated: number;
  readonly accepted: number;
  readonly decisions: ReadonlyArray<AdvicePatchDecision>;
};

/** The `decisions.json` payload persisted under `<out>/advice/`. */
export function buildAdviceDecisionsFile(opts: {
  readonly runId: string;
  readonly generatedAt: string;
  readonly source: string;
  readonly baseline: EvalRunSummary;
  readonly decisions: ReadonlyArray<AdvicePatchDecision>;
}): AdviceDecisionsFile {
  return {
    runId: opts.runId,
    generatedAt: opts.generatedAt,
    source: opts.source,
    baseline: { passRate: opts.baseline.aggregates.passRate, evalDir: opts.baseline.outDir },
    evaluated: opts.decisions.length,
    accepted: opts.decisions.filter((d) => d.status === "accepted").length,
    decisions: opts.decisions,
  };
}

/** One line per decision for the CLI's report. */
export function formatAdviceDecisionLine(d: AdvicePatchDecision): string {
  const id = d.findingId !== undefined ? ` ${d.findingId}` : "";
  const value = d.patch.op === "remove" ? "" : ` → ${JSON.stringify(d.patch.value)}`;
  const head = `${patchLabel(d.index)}${id}: ${d.patch.op} ${d.patch.path.join(".")}${value}`;
  return `${head} — ${d.status.toUpperCase()}: ${d.reason}`;
}

/**
 * Stamp the accumulated accepted YAML with the same provenance header a
 * successful `optimize --write-back` produces (`formatWriteBackHeader`, the
 * stamp `spec log` distills), with `mutator: advisor` naming the patch
 * source and `iterations` carrying the number of patches evaluated.
 */
export function stampAdviceWriteBack(opts: {
  readonly runId: string;
  readonly yaml: string;
  readonly passRateBefore: number;
  readonly passRateAfter: number;
  readonly patchesEvaluated: number;
  readonly timestamp?: string;
}): string {
  const header = formatWriteBackHeader({
    runId: opts.runId,
    mutator: "advisor",
    scoreBefore: opts.passRateBefore,
    scoreAfter: opts.passRateAfter,
    iterations: opts.patchesEvaluated,
    ...(opts.timestamp !== undefined ? { timestamp: opts.timestamp } : {}),
  });
  return `${header}${opts.yaml}`;
}
