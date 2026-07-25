/**
 * E48 — `crewhaus graders test`: meta-eval every grader in a graders.yaml
 * against a purpose-built LABELED set of golden verdicts, closing the gap
 * `judge calibrate` leaves open (calibrate correlates a judge with AMBIENT
 * session ratings; this replays the whole grader suite — deterministic,
 * registry, and judge — over recorded outputs a human already adjudicated).
 *
 * The golden file is JSONL, one verdict per line, STRICT schema:
 *
 *   { "id": "q1", "input": "…", "agent_output": "…",
 *     "expected_passed": true, "expected_score": 0.75 }
 *
 * `expected_score` is optional and NORMALIZED 0..1 (the same scale
 * `GradeResult.score` uses — a judge's 1–5 maps via (n−1)/4). Each line is
 * replayed by constructing a Sample ({id, input}) + a minimal RunResult
 * carrying the recorded `agent_output`; graders that read more than the
 * final output (transcripts, artifacts) grade degraded or error per line —
 * errors are counted and named, never silently dropped.
 *
 * Replay is credential-free for deterministic + registry graders.
 * `llm_judge` graders need visible judge credentials: without them the
 * judge entries are SKIPPED with a clear notice and the deterministic ones
 * still test (`--min-agreement` gates only the TESTED graders).
 * `target: transcript` judges are always skipped — golden verdicts carry
 * only the final output, so a trajectory judge cannot be replayed honestly.
 *
 * Per tested grader the report carries: agreement rate vs expected_passed,
 * Cohen's kappa (chance-corrected agreement), false-positive /
 * false-negative counts with up to {@link MAX_EXEMPLARS} exemplar ids
 * each, abstained/error counts (excluded from the agreement denominator),
 * and — when any golden line declares `expected_score` — the mean absolute
 * score error. Kept side-effect-free (the CLI entry file runs an argv
 * switch on import) mirroring `eval-pairwise.ts`; flag parsing and all
 * filesystem access live in `apps/cli/src/index.ts`.
 */
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import type { Sample } from "@crewhaus/eval-dataset";
import type { CompiledGrader, GradeResult, Grader, RunResult } from "@crewhaus/eval-grader";
import {
  DEFAULT_JUDGE_MODEL,
  createJudgeGrader,
  loadCategoricalRubric,
  loadRubric,
} from "@crewhaus/eval-judge";
import { resolveRegistryGrader } from "@crewhaus/eval-runner";
import type { GraderLookup } from "@crewhaus/eval-runner";
import { z } from "zod";
import { providerCredentialsSatisfied } from "./doctor-checks";

/** Thrown on malformed flags / unusable inputs. The CLI entry file routes it
 *  through `die()`; tests assert on `.message`. */
export class GradersTestError extends Error {
  override readonly name = "GradersTestError";
}

/** How many exemplar ids each FP/FN/abstain/error bucket names. */
export const MAX_EXEMPLARS = 5;

// -------- golden verdicts --------

/**
 * One human-adjudicated verdict over a recorded agent output. STRICT — a
 * stray key (`expected_output:`, `agentOutput:`) is a loud line-numbered
 * error, never silently ignored: a golden set that silently carries dead
 * fields would mis-teach whoever curates it next.
 */
export const GoldenVerdictSchema = z
  .object({
    id: z.string().min(1),
    input: z.string(),
    agent_output: z.string(),
    expected_passed: z.boolean(),
    /** Normalized 0..1 (the `GradeResult.score` scale; judge 1–5 → (n−1)/4). */
    expected_score: z.number().min(0).max(1).optional(),
  })
  .strict();

export type GoldenVerdict = z.infer<typeof GoldenVerdictSchema>;

/**
 * Parse a golden-verdicts JSONL file. Blank/whitespace-only lines are
 * skipped; every error names its 1-based line number. Duplicate ids are
 * refused (ids are the exemplar keys — a duplicate would make every
 * exemplar list ambiguous), as is an empty set.
 */
export function parseGoldenVerdicts(text: string): GoldenVerdict[] {
  const out: GoldenVerdict[] = [];
  const seen = new Map<string, number>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] as string).trim();
    if (line === "") continue;
    const lineNo = i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new GradersTestError(
        `golden line ${lineNo}: malformed JSON (${(err as Error).message})`,
      );
    }
    const result = GoldenVerdictSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((iss) => `${iss.path.join(".") || "(root)"}: ${iss.message}`)
        .join("; ");
      throw new GradersTestError(`golden line ${lineNo}: ${issues}`);
    }
    const firstLine = seen.get(result.data.id);
    if (firstLine !== undefined) {
      throw new GradersTestError(
        `golden line ${lineNo}: duplicate id "${result.data.id}" (first seen on line ${firstLine})`,
      );
    }
    seen.set(result.data.id, lineNo);
    out.push(result.data);
  }
  if (out.length === 0) {
    throw new GradersTestError("golden file has no verdicts — nothing to test against");
  }
  return out;
}

/**
 * Reconstruct the (Sample, RunResult) pair a grader sees for one golden
 * line. Deliberately minimal: only the recorded final output exists —
 * transcript/tool-call/artifact-reading graders grade degraded (or error,
 * which the replay counts per line).
 */
export function goldenRunPair(golden: GoldenVerdict): { sample: Sample; run: RunResult } {
  return {
    sample: { id: golden.id, input: golden.input },
    run: {
      agentOutput: golden.agent_output,
      events: [],
      transcript: [],
      toolCalls: [],
      turns: 1,
      latencyMs: 0,
    },
  };
}

// -------- grader resolution (mirrors runEval's, with a skip gate) --------

export type ResolvedGraderKind = "deterministic" | "llm_judge" | "registry";

export type ResolvedTestGrader = {
  readonly name: string;
  readonly kind: ResolvedGraderKind;
  readonly grader: Grader;
};

/** One judge grader the meta-eval could NOT replay, and why. Skipped
 *  graders are excluded from the `--min-agreement` gate (only TESTED
 *  graders gate). */
export type SkippedGrader = {
  readonly name: string;
  readonly reason: string;
};

export type ResolveTestGradersOptions = {
  /** `--judge-model` — the runner-level judge default (per-grader `model`
   *  / `judges` still win, exactly like `crewhaus eval`). */
  readonly judgeModel?: string;
  /** Credential visibility source (default `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam — injected stub adapter for judge calls. Its presence also
   *  bypasses the credential gate (a stub needs no keys). */
  readonly adapter?: ProviderAdapter;
  /** Registry for `type: registry` entries (G14 default-registry rule —
   *  the caller builds it via `graderRegistryForCompiled`). */
  readonly graderRegistry?: GraderLookup;
};

/**
 * Resolve every compiled grader into a runnable one, mirroring `runEval`'s
 * resolution (categorical vs scalar judge dispatch, panels, temperature /
 * repeats threading, registry substitution with `opts` validation) — with
 * two meta-eval-specific skips for judge entries: `target: transcript`
 * (nothing to replay) and missing judge credentials (never fabricate).
 * Judge rubrics test at their DECLARED gate (`passing_score`, default 3/5);
 * the G47 calibrated-cut overlay deliberately does not apply here — the
 * meta-eval measures the graders file as written.
 */
export function resolveTestGraders(
  compiled: ReadonlyArray<CompiledGrader>,
  opts: ResolveTestGradersOptions = {},
): { graders: ResolvedTestGrader[]; skipped: SkippedGrader[] } {
  const env = opts.env ?? process.env;
  const graders: ResolvedTestGrader[] = [];
  const skipped: SkippedGrader[] = [];
  for (const g of compiled) {
    if (g.judgeSpec !== undefined) {
      const spec = g.judgeSpec;
      if (spec.target === "transcript") {
        skipped.push({
          name: g.name,
          reason:
            "target: transcript — golden verdicts carry only the agent's final output, so a trajectory judge cannot be replayed",
        });
        continue;
      }
      const models = spec.judges ?? [spec.model ?? opts.judgeModel ?? DEFAULT_JUDGE_MODEL];
      if (opts.adapter === undefined) {
        const missing = models.filter((m) => !providerCredentialsSatisfied(m, env));
        if (missing.length > 0) {
          const named = missing.map((m) => `"${m}"`).join(", ");
          skipped.push({
            name: g.name,
            reason: `no credentials visible for judge model${missing.length > 1 ? "s" : ""} ${named} — set the provider key (e.g. ANTHROPIC_API_KEY) or pass --judge-model <model>; deterministic graders still test`,
          });
          continue;
        }
      }
      const model = spec.model ?? opts.judgeModel;
      if (spec.rubric.kind === "categorical") {
        const grader = createJudgeGrader(loadCategoricalRubric(spec.rubric), {
          ...(opts.adapter !== undefined ? { adapter: opts.adapter } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
        });
        graders.push({ name: g.name, kind: "llm_judge", grader });
        continue;
      }
      const grader = createJudgeGrader(loadRubric(spec.rubric), {
        ...(opts.adapter !== undefined ? { adapter: opts.adapter } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(spec.judges !== undefined ? { judges: spec.judges } : {}),
        ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
        ...(spec.repeats !== undefined ? { repeats: spec.repeats } : {}),
      });
      graders.push({ name: g.name, kind: "llm_judge", grader });
      continue;
    }
    if (g.registrySpec !== undefined) {
      if (opts.graderRegistry === undefined) {
        throw new GradersTestError(
          `grader "${g.name}" resolves by registry name "${g.registrySpec.grader}" but no grader registry was available`,
        );
      }
      graders.push({
        name: g.name,
        kind: "registry",
        grader: resolveRegistryGrader(opts.graderRegistry, g.name, g.registrySpec),
      });
      continue;
    }
    graders.push({ name: g.name, kind: "deterministic", grader: g.grader });
  }
  return { graders, skipped };
}

// -------- replay --------

export type GoldenOutcome = {
  readonly golden: GoldenVerdict;
  /** The grade, when the grader returned one. */
  readonly grade?: GradeResult;
  /** The thrown message, when it did not (counted, never a verdict). */
  readonly error?: string;
};

/**
 * Replay ONE grader over every golden line, in file order. A per-line
 * throw is captured as an `error` outcome (the meta-eval's analog of the
 * runner's grader-infra channel) so one flaky call cannot abort the whole
 * test — it is counted and named instead.
 */
export async function replayGraderOnGoldens(
  grader: Grader,
  goldens: ReadonlyArray<GoldenVerdict>,
): Promise<GoldenOutcome[]> {
  const out: GoldenOutcome[] = [];
  for (const golden of goldens) {
    const { sample, run } = goldenRunPair(golden);
    try {
      out.push({ golden, grade: await grader(sample, run) });
    } catch (err) {
      out.push({ golden, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

// -------- statistics --------

/**
 * Cohen's kappa over paired boolean verdicts: (pₒ − pₑ)/(1 − pₑ), the
 * agreement rate corrected for the agreement two independent raters with
 * these marginal rates would reach by chance. Degenerate sets — fewer than
 * one pair, or pₑ = 1 (both raters constant AND identical, where every
 * agreement is fully explainable by chance) — read 0: no agreement beyond
 * chance is demonstrable.
 */
export function cohenKappa(
  pairs: ReadonlyArray<{ readonly expected: boolean; readonly actual: boolean }>,
): number {
  const n = pairs.length;
  if (n === 0) return 0;
  let bothPass = 0;
  let bothFail = 0;
  let actualPass = 0;
  let expectedPass = 0;
  for (const p of pairs) {
    if (p.actual) actualPass += 1;
    if (p.expected) expectedPass += 1;
    if (p.actual && p.expected) bothPass += 1;
    else if (!p.actual && !p.expected) bothFail += 1;
  }
  const po = (bothPass + bothFail) / n;
  const pe =
    (actualPass / n) * (expectedPass / n) + ((n - actualPass) / n) * ((n - expectedPass) / n);
  if (1 - pe === 0) return 0;
  return (po - pe) / (1 - pe);
}

export type ExemplarCount = {
  readonly count: number;
  /** Up to {@link MAX_EXEMPLARS} golden ids, in golden-file order. */
  readonly exemplars: ReadonlyArray<string>;
};

export type GraderTestReport = {
  readonly name: string;
  readonly kind: ResolvedGraderKind;
  /** Golden lines replayed. */
  readonly total: number;
  /** Real verdicts — total minus errors minus abstentions. */
  readonly graded: number;
  readonly agreements: number;
  /** agreements/graded; 0 when nothing graded (fails any positive floor —
   *  a grader that never produced a verdict earned no trust). */
  readonly agreementRate: number;
  /** Cohen's kappa over the graded pairs (see {@link cohenKappa}). */
  readonly kappa: number;
  /** Grader passed, human said fail. */
  readonly falsePositives: ExemplarCount;
  /** Grader failed, human said pass. */
  readonly falseNegatives: ExemplarCount;
  /** A3 — abstained judge verdicts: excluded from the agreement
   *  denominator (a declined verdict is not a wrong one), counted + named. */
  readonly abstained: ExemplarCount;
  /** Per-line grader throws: excluded from the denominator, counted + named. */
  readonly errors: ExemplarCount;
  /** Mean |grade.score − expected_score| over the graded lines that declare
   *  `expected_score` (both normalized 0..1); absent when none do. */
  readonly scoreMae?: { readonly mae: number; readonly count: number };
};

function exemplarCount(ids: ReadonlyArray<string>): ExemplarCount {
  return { count: ids.length, exemplars: ids.slice(0, MAX_EXEMPLARS) };
}

/** Fold one grader's replay outcomes into its report row. */
export function summarizeGraderTest(
  name: string,
  kind: ResolvedGraderKind,
  outcomes: ReadonlyArray<GoldenOutcome>,
): GraderTestReport {
  const fpIds: string[] = [];
  const fnIds: string[] = [];
  const abstainedIds: string[] = [];
  const errorIds: string[] = [];
  const pairs: Array<{ expected: boolean; actual: boolean }> = [];
  let agreements = 0;
  let maeSum = 0;
  let maeCount = 0;
  for (const o of outcomes) {
    if (o.grade === undefined) {
      errorIds.push(o.golden.id);
      continue;
    }
    if (o.grade.abstained === true) {
      abstainedIds.push(o.golden.id);
      continue;
    }
    pairs.push({ expected: o.golden.expected_passed, actual: o.grade.passed });
    if (o.grade.passed === o.golden.expected_passed) agreements += 1;
    else if (o.grade.passed) fpIds.push(o.golden.id);
    else fnIds.push(o.golden.id);
    if (o.golden.expected_score !== undefined) {
      maeSum += Math.abs(o.grade.score - o.golden.expected_score);
      maeCount += 1;
    }
  }
  const graded = pairs.length;
  return {
    name,
    kind,
    total: outcomes.length,
    graded,
    agreements,
    agreementRate: graded === 0 ? 0 : agreements / graded,
    kappa: cohenKappa(pairs),
    falsePositives: exemplarCount(fpIds),
    falseNegatives: exemplarCount(fnIds),
    abstained: exemplarCount(abstainedIds),
    errors: exemplarCount(errorIds),
    ...(maeCount > 0 ? { scoreMae: { mae: maeSum / maeCount, count: maeCount } } : {}),
  };
}

// -------- gate + rendering --------

/** The TESTED graders whose agreement rate falls below the floor —
 *  `--min-agreement`'s exit-non-zero set (skipped graders never gate). */
export function belowFloor(
  reports: ReadonlyArray<GraderTestReport>,
  minAgreement: number,
): GraderTestReport[] {
  return reports.filter((r) => r.agreementRate < minAgreement);
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}

function exemplarSuffix(e: ExemplarCount): string {
  if (e.count === 0) return "";
  const shown = e.exemplars.join(", ");
  const more = e.count > e.exemplars.length ? `, +${e.count - e.exemplars.length} more` : "";
  return ` — ${shown}${more}`;
}

/** Render the meta-eval as a terminal report (skip notices included). */
export function renderGradersTestReport(
  reports: ReadonlyArray<GraderTestReport>,
  skipped: ReadonlyArray<SkippedGrader>,
  goldenCount: number,
): string {
  const lines: string[] = [];
  lines.push(
    `graders test — ${goldenCount} golden verdict(s), ${reports.length} grader(s) tested` +
      `${skipped.length > 0 ? `, ${skipped.length} skipped` : ""}`,
  );
  for (const r of reports) {
    lines.push(
      `  ${r.name} (${r.kind}): agreement ${pct(r.agreementRate)} (${r.agreements}/${r.graded}), ` +
        `kappa ${r.kappa.toFixed(3)}`,
    );
    if (r.graded === 0) {
      lines.push("    no gradeable verdicts — agreement reads 0");
    }
    if (r.falsePositives.count > 0) {
      lines.push(
        `    false positives (grader passed, human failed): ${r.falsePositives.count}${exemplarSuffix(r.falsePositives)}`,
      );
    }
    if (r.falseNegatives.count > 0) {
      lines.push(
        `    false negatives (grader failed, human passed): ${r.falseNegatives.count}${exemplarSuffix(r.falseNegatives)}`,
      );
    }
    if (r.abstained.count > 0) {
      lines.push(
        `    abstained (excluded from agreement): ${r.abstained.count}${exemplarSuffix(r.abstained)}`,
      );
    }
    if (r.errors.count > 0) {
      lines.push(
        `    errors (excluded from agreement): ${r.errors.count}${exemplarSuffix(r.errors)}`,
      );
    }
    if (r.scoreMae !== undefined) {
      lines.push(
        `    score MAE: ${r.scoreMae.mae.toFixed(3)} (over ${r.scoreMae.count} with expected_score)`,
      );
    }
  }
  for (const s of skipped) {
    lines.push(`  [graders test] skipped llm_judge "${s.name}" — ${s.reason}`);
  }
  return `${lines.join("\n")}\n`;
}
