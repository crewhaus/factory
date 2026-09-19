/**
 * Replaying a graders config over human-labelled verdicts, offline.
 *
 * Every step belongs to a package: `@crewhaus/eval-grader` compiles the YAML,
 * `@crewhaus/eval-ops` parses the goldens (strict, line-numbered), resolves the
 * compiled entries into runnable graders, replays one grader over the whole
 * golden file, folds the outcomes into a report, and applies the agreement
 * floor. This module partitions, adds the statistics that make kappa readable,
 * and guards the seam.
 *
 * WHAT THIS TOOL WILL NOT DO. It never makes a model call. An `llm_judge`
 * entry is therefore not "skipped for want of credentials" — it is skipped
 * because a deterministic tool that reached a provider would not be one, and
 * saying so accurately matters: the CLI's own skip message tells the operator
 * to set an API key, which here would change nothing. `type: registry` entries
 * are skipped too, for a different and equally specific reason: resolving one
 * means building the pack-and-plugin grader registry, which loads code this
 * tool has no business loading.
 *
 * WHY THE MARGINALS ARE IN THE RESULT. Cohen's kappa collapses toward zero on
 * a lopsided label set: when 95% of goldens are "pass", chance agreement is
 * nearly the observed agreement and the correction eats the signal. A kappa
 * of 0.1 there says as much about the label set as about the grader, so the
 * counts that produce it — the confusion matrix and both raters' marginals —
 * travel beside it. Reporting the number alone is how "the grader is broken"
 * gets concluded from an unbalanced golden file.
 */
import { parseGradersConfig } from "@crewhaus/eval-grader";
import type { CompiledGrader } from "@crewhaus/eval-grader";
import {
  type GoldenOutcome,
  type GoldenVerdict,
  type GraderTestReport,
  type SkippedGrader,
  replayGraderOnGoldens,
  resolveTestGraders,
  summarizeGraderTest,
} from "@crewhaus/eval-ops";
import { statsKernel } from "@crewhaus/tool-math";
import { type Loaded, fail } from "./read";
import type { Interval } from "./run";

/** The label a boolean verdict wears in the kappa kernel's categorical input. */
const PASS = "pass";
const FAIL = "fail";

export type GraderPartition = {
  /** Entries this tool can replay without leaving the process. */
  readonly deterministic: ReadonlyArray<CompiledGrader>;
  readonly skipped: ReadonlyArray<SkippedGrader>;
};

/**
 * Split a compiled config into what can be replayed offline and what cannot.
 *
 * Done BEFORE `resolveTestGraders` rather than by starving it of credentials:
 * a judge entry that never reaches the resolver cannot be turned into a live
 * grader by an environment variable that happens to be exported.
 */
export function partitionGraders(compiled: ReadonlyArray<CompiledGrader>): GraderPartition {
  const deterministic: CompiledGrader[] = [];
  const skipped: SkippedGrader[] = [];
  for (const g of compiled) {
    if (g.judgeSpec !== undefined) {
      skipped.push({
        name: g.name,
        reason:
          "llm_judge — grading it means a model call, and this tool is offline by construction. Run `crewhaus graders test --graders <file> --golden <file>` to meta-eval the judge entries.",
      });
      continue;
    }
    if (g.registrySpec !== undefined) {
      skipped.push({
        name: g.name,
        reason: `type: registry ("${g.registrySpec.grader}") — resolving it means building the pack and plugin grader registry, which loads third-party code this tool does not load. The CLI resolves these.`,
      });
      continue;
    }
    deterministic.push(g);
  }
  return { deterministic, skipped };
}

export type ConfusionMatrix = {
  /** Grader passed, human passed. */
  readonly truePositives: number;
  /** Grader passed, human FAILED — the ones that let a regression through. */
  readonly falsePositives: number;
  /** Grader failed, human passed. */
  readonly falseNegatives: number;
  readonly trueNegatives: number;
};

export type Marginals = {
  /** How often the HUMAN said pass, over the graded pairs. */
  readonly humanPassRate: number;
  /** How often the GRADER said pass. */
  readonly graderPassRate: number;
  /**
   * True when one rater's labels are lopsided enough that kappa is mostly
   * reporting the label set. 0.9 is a convention, not a threshold anyone
   * should gate on, and it is stated rather than applied silently.
   */
  readonly lopsided: boolean;
};

export type KappaDetail = {
  /** `@crewhaus/tool-math`'s kernel: the shared implementation. */
  readonly kappa: number | null;
  readonly observedAgreement: number | null;
  readonly expectedAgreement: number | null;
  /** True when both raters used one identical label throughout: chance
   *  agreement is already 100%, so kappa is 0/0. */
  readonly degenerate: boolean;
  readonly note: string;
  /**
   * Set when the kernel's kappa and `@crewhaus/eval-ops`'s differ. They use
   * the same formula and differ only on the degenerate case, where the kernel
   * reports 1 (by convention, flagged) and eval-ops reports 0. Both numbers are
   * in the result; this names the disagreement rather than picking a winner.
   */
  readonly disagreesWithEvalOps?: string;
};

export type GraderMetaReport = {
  readonly report: GraderTestReport;
  readonly confusion: ConfusionMatrix;
  readonly marginals: Marginals;
  readonly kappaDetail: KappaDetail;
  /** Wilson interval on the agreement RATE. 3 of 5 agreements is not 60%. */
  readonly agreementInterval?: Interval;
  readonly agreementIntervalUnavailable?: string;
  /** Set when this module's own pair extraction disagrees with the fold in
   *  `@crewhaus/eval-ops`. It never should; if it ever does, the statistics
   *  below describe a different set of pairs than the report does. */
  readonly foldDisagreement?: string;
};

/** The (human, grader) pairs a report's agreement rate is computed over.
 *
 *  Mirrors `summarizeGraderTest`'s denominator rule — errors and abstentions
 *  are excluded, because a verdict nobody produced is not a wrong one — and is
 *  cross-checked against the report it accompanies immediately below, so the
 *  two cannot quietly describe different sets. */
function pairsOf(
  outcomes: ReadonlyArray<GoldenOutcome>,
): Array<{ expected: boolean; actual: boolean }> {
  const pairs: Array<{ expected: boolean; actual: boolean }> = [];
  for (const o of outcomes) {
    if (o.grade === undefined || o.grade.abstained === true) continue;
    pairs.push({ expected: o.golden.expected_passed, actual: o.grade.passed });
  }
  return pairs;
}

function interval(successes: number, trials: number): Interval | undefined {
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

/** Fold one grader's replay into the report plus the statistics around it. */
export function analyze(
  name: string,
  kind: GraderTestReport["kind"],
  outcomes: ReadonlyArray<GoldenOutcome>,
): GraderMetaReport {
  const report = summarizeGraderTest(name, kind, outcomes);
  const pairs = pairsOf(outcomes);
  const confusion = pairs.reduce<ConfusionMatrix>(
    (acc, p) => ({
      truePositives: acc.truePositives + (p.actual && p.expected ? 1 : 0),
      falsePositives: acc.falsePositives + (p.actual && !p.expected ? 1 : 0),
      falseNegatives: acc.falseNegatives + (!p.actual && p.expected ? 1 : 0),
      trueNegatives: acc.trueNegatives + (!p.actual && !p.expected ? 1 : 0),
    }),
    { truePositives: 0, falsePositives: 0, falseNegatives: 0, trueNegatives: 0 },
  );
  const n = pairs.length;
  const humanPasses = confusion.truePositives + confusion.falseNegatives;
  const graderPasses = confusion.truePositives + confusion.falsePositives;
  const humanPassRate = n === 0 ? 0 : humanPasses / n;
  const graderPassRate = n === 0 ? 0 : graderPasses / n;

  const kernel = statsKernel.cohensKappa(
    pairs.map((p) => (p.expected ? PASS : FAIL)),
    pairs.map((p) => (p.actual ? PASS : FAIL)),
  );
  const kernelKappa = kernel.kappa;
  const disagrees =
    kernelKappa !== null && Math.abs(kernelKappa - report.kappa) > 1e-9
      ? `@crewhaus/tool-math's kappa is ${kernelKappa} and @crewhaus/eval-ops's is ${report.kappa}${kernel.degenerate ? " — the degenerate case, where the kernel reports 1 by convention and eval-ops reports 0; neither number measures agreement here" : ""}`
      : undefined;

  const agreementInterval = interval(report.agreements, report.graded);
  const foldMismatch =
    n !== report.graded
      ? `this module counted ${n} graded pair(s) and @crewhaus/eval-ops counted ${report.graded} — the statistics and the report describe different sets`
      : undefined;

  return {
    report,
    confusion,
    marginals: {
      humanPassRate,
      graderPassRate,
      // EITHER rater's marginal drives chance agreement, so a grader that says
      // pass to everything collapses kappa exactly as a lopsided golden file
      // does. Checking only the human's left the commoner of the two unflagged.
      lopsided:
        n > 0 &&
        (humanPassRate >= 0.9 ||
          humanPassRate <= 0.1 ||
          graderPassRate >= 0.9 ||
          graderPassRate <= 0.1),
    },
    kappaDetail: {
      kappa: kernelKappa,
      observedAgreement: kernel.observedAgreement,
      expectedAgreement: kernel.expectedAgreement,
      degenerate: kernel.degenerate,
      note: kernel.note,
      ...(disagrees !== undefined ? { disagreesWithEvalOps: disagrees } : {}),
    },
    ...(agreementInterval !== undefined
      ? { agreementInterval }
      : {
          agreementIntervalUnavailable:
            "no gradeable verdicts — an interval on no observations is fabrication, and the 0 agreement rate beside it is a floor, not a measurement",
        }),
    ...(foldMismatch !== undefined ? { foldDisagreement: foldMismatch } : {}),
  };
}

export type MetaTestRun = {
  readonly tested: ReadonlyArray<GraderMetaReport>;
  readonly skipped: ReadonlyArray<SkippedGrader>;
  readonly goldenCount: number;
};

/**
 * Compile, partition, resolve, replay.
 *
 * The ceilings are checked BEFORE the first replay, not after: every replay is
 * a synchronous call into a grader, so a limit enforced afterwards is not a
 * limit. A config or golden file over them is refused with the numbers.
 */
export async function runMetaTest(
  gradersYaml: string,
  goldens: ReadonlyArray<GoldenVerdict>,
  limits: { readonly maxGraders: number; readonly maxReplays: number },
): Promise<Loaded<MetaTestRun>> {
  const { compiled } = parseGradersConfig(gradersYaml);
  if (compiled.length > limits.maxGraders) {
    return fail(
      "too-large",
      `${compiled.length} graders is over this tool's ${limits.maxGraders} limit — split the config`,
    );
  }
  const partition = partitionGraders(compiled);
  const replays = partition.deterministic.length * goldens.length;
  if (replays > limits.maxReplays) {
    return fail(
      "too-large",
      `${partition.deterministic.length} replayable grader(s) over ${goldens.length} golden verdict(s) is ${replays} replays, past this tool's ${limits.maxReplays} limit — narrow the golden file`,
    );
  }
  // Resolution still goes through `@crewhaus/eval-ops` even though only
  // deterministic entries remain: the rule for turning a compiled entry into a
  // runnable grader lives there, and a shortcut here would be a second copy of
  // it that stops matching the runner's the moment either changes.
  const resolved = resolveTestGraders(partition.deterministic);
  const tested: GraderMetaReport[] = [];
  for (const g of resolved.graders) {
    const outcomes = await replayGraderOnGoldens(g.grader, goldens);
    tested.push(analyze(g.name, g.kind, outcomes));
  }
  return {
    ok: true,
    value: {
      tested,
      skipped: [...partition.skipped, ...resolved.skipped],
      goldenCount: goldens.length,
    },
  };
}

export type GateVerdict = {
  readonly verdict: "pass" | "fail" | "unknown";
  readonly reason: string;
  readonly below: ReadonlyArray<{ readonly name: string; readonly agreementRate: number }>;
  /**
   * Tested graders that produced NO verdict at all — every replay abstained or
   * threw. `summarizeGraderTest` scores them `agreementRate: 0` by design ("a
   * grader that never produced a verdict earned no trust"), and that is kept:
   * they still fail the floor. What is added is the distinction the bare 0
   * destroys — `below: [{ name, agreementRate: 0 }]` reads as "this grader
   * disagreed with the humans every single time", when what happened is that it
   * never answered. Those are different repairs.
   */
  readonly notEvaluated?: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
};

/**
 * Apply the `--min-agreement` floor.
 *
 * A floor over ZERO tested graders is `unknown`, never `pass`. The CLI reaches
 * the same place by refusing to continue when every grader was skipped; a tool
 * that returns a value rather than exiting has to carry the distinction in the
 * value, because "every grader was skipped" and "every grader agreed" are the
 * same green to anything that only reads a verdict.
 */
export function gateAgreement(
  tested: ReadonlyArray<GraderMetaReport>,
  minAgreement: number | undefined,
  belowFloor: (reports: ReadonlyArray<GraderTestReport>, min: number) => GraderTestReport[],
): GateVerdict | undefined {
  if (minAgreement === undefined) return undefined;
  if (tested.length === 0) {
    return {
      verdict: "unknown",
      reason: `no grader was testable offline, so the ${minAgreement} agreement floor was never evaluated — this is not a pass`,
      below: [],
    };
  }
  const below = belowFloor(
    tested.map((t) => t.report),
    minAgreement,
  ).map((r) => ({ name: r.name, agreementRate: r.agreementRate }));
  const notEvaluated = tested
    .filter((t) => t.report.graded === 0)
    .map((t) => ({
      name: t.report.name,
      reason: `produced no verdict on any of its ${t.report.total} golden line(s) (${t.report.abstained.count} abstained, ${t.report.errors.count} errored), so its 0 agreement rate is an absence of evidence, not a measured disagreement`,
    }));
  const withNotEvaluated = notEvaluated.length > 0 ? { notEvaluated } : {};
  return below.length === 0
    ? {
        verdict: "pass",
        reason: `all ${tested.length} tested grader(s) at or above ${minAgreement}`,
        below,
        ...withNotEvaluated,
      }
    : {
        verdict: "fail",
        reason:
          notEvaluated.length === 0
            ? `${below.length} grader(s) below the ${minAgreement} agreement floor`
            : `${below.length} grader(s) below the ${minAgreement} agreement floor, of which ${notEvaluated.length} produced no verdict at all (see notEvaluated — an unanswered grader is not a disagreeing one)`,
        below,
        ...withNotEvaluated,
      };
}
