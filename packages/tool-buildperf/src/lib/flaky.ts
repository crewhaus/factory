/**
 * What repeated test runs can and cannot establish.
 *
 * Three failures in five runs is not a 60% failure rate. It is a point
 * estimate drawn from five observations, and the Wilson interval around it
 * runs from 0.231 to 0.882 — a range that spans "mildly annoying" and "the
 * test is broken" without distinguishing them. Quarantining on the point
 * estimate is quarantining on noise, so every rate here travels with its
 * interval (from `@crewhaus/tool-math`'s kernel) and the quarantine
 * recommendation keys on the interval's LOWER bound, never on the estimate.
 *
 * The other thing five runs cannot do is separate nondeterminism from order
 * dependence. A test that fails only when another test ran first is not
 * flaky; it is deterministic in a coordinate the runner did not vary. If the
 * input carries execution order, this module looks for the predecessor that
 * distinguishes the failing runs from the passing ones. If every run used the
 * SAME order, it says the question is unanswerable rather than answering
 * "nondeterministic" — which is the wrong answer given confidently, and the
 * whole reason a team spends a week chasing the wrong test.
 */
import { statsKernel } from "@crewhaus/tool-math";

export const TEST_STATUSES = ["pass", "fail", "error", "skip"] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];

export class FlakyError extends Error {
  override readonly name = "FlakyError";
}

export type TestObservation = {
  readonly id: string;
  readonly status: TestStatus;
  /** Failure text, used only to group failures — never to classify one. */
  readonly error?: string;
  /** A pre-computed failure signature, e.g. from `ErrorCluster`. Wins over `error`. */
  readonly signature?: string;
};

export type RunInput = {
  readonly id?: string;
  /** The shuffle seed, when the runner exposes one. */
  readonly seed?: string;
  /** Execution order is the order of this array. */
  readonly tests: ReadonlyArray<TestObservation>;
};

export type Mask = { readonly pattern: string; readonly with?: string; readonly flags?: string };

export type FlakyOptions = {
  /** Two-sided z for the Wilson interval; the kernel's 95% value by default. */
  readonly z?: number;
  /**
   * Recommend quarantine only when the interval's lower bound clears this.
   * Default 0.05: one failure in twenty, established rather than observed.
   */
  readonly quarantineLowerBound?: number;
  /** Caller-declared substitutions applied to failure text before grouping. */
  readonly masks?: ReadonlyArray<Mask>;
};

export type FailureGroup = {
  readonly signature: string;
  readonly count: number;
  /** One verbatim example, so the masking stays auditable. */
  readonly example: string;
  readonly runs: ReadonlyArray<string>;
};

export type OrderAnalysis = {
  readonly decidable: boolean;
  /** Tests that ran before this one in EVERY failing run and in NO passing run. */
  readonly suspects: ReadonlyArray<string>;
  readonly medianPositionWhenFailing: number | null;
  readonly medianPositionWhenPassing: number | null;
  readonly note: string;
};

export type TestClassification = "passing" | "flaky" | "failing-every-run" | "not-observed";

export type TestReport = {
  readonly id: string;
  readonly classification: TestClassification;
  readonly runsObserved: number;
  readonly failures: number;
  readonly passes: number;
  readonly skipped: number;
  readonly absent: number;
  readonly failureRate: {
    readonly pointEstimate: number | null;
    readonly lower: number | null;
    readonly upper: number | null;
    readonly width: number | null;
    readonly z: number;
  };
  readonly order: OrderAnalysis;
  readonly failureGroups: ReadonlyArray<FailureGroup>;
  readonly sameFailureEveryTime: boolean | null;
  readonly recommendation: "keep" | "quarantine" | "fix" | "insufficient-evidence";
  readonly why: string;
};

export type FlakyReport = {
  readonly runs: number;
  readonly ordering: {
    readonly varied: boolean;
    readonly seedsDeclared: ReadonlyArray<string>;
    readonly note: string;
  };
  readonly tests: ReadonlyArray<TestReport>;
  readonly summary: Readonly<Record<TestClassification, number>>;
  readonly masksApplied: Readonly<Record<string, number>>;
  /** Consecutive failures needed before the lower bound on the rate clears 0.9. */
  readonly runsForDeterminismClaim: number | null;
  readonly verdict: "clean" | "flaky" | "failing" | "inconclusive";
  readonly note: string;
};

/** A failure is a failure; `error` is one that did not reach an assertion. */
const isFailure = (status: TestStatus): boolean => status === "fail" || status === "error";

/**
 * Apply the caller's substitutions and report how many times each fired.
 *
 * A mask that rewrites text invisibly can merge two genuinely different
 * failures into one group, which reads as "it always fails the same way" when
 * it does not — so the counts come back with the result, the same rule
 * `GoldenCompare` follows for its normalizers.
 *
 * There are deliberately no built-in masks. `ErrorCluster` in
 * `@crewhaus/tool-obs` already owns shape-based masking of error text (URLs,
 * uuids, timestamps, paths, prefixed ids, hex blobs, numbers); a second set
 * here would drift from it, and the two tools would then disagree about
 * whether two failures are the same failure. Pass its fingerprint in as
 * `signature`, or declare the substitutions this suite needs.
 */
export function applyMasks(
  text: string,
  masks: ReadonlyArray<Mask>,
  counts: Record<string, number>,
): string {
  let out = text;
  for (const mask of masks) {
    const flags = mask.flags ?? "";
    let re: RegExp;
    try {
      re = new RegExp(mask.pattern, flags.includes("g") ? flags : `${flags}g`);
    } catch (err) {
      throw new FlakyError(
        `mask /${mask.pattern}/ is not a valid regular expression: ${(err as Error).message}`,
      );
    }
    const fired = out.match(re)?.length ?? 0;
    if (fired > 0) {
      out = out.replace(re, mask.with ?? "<masked>");
      counts[mask.pattern] = (counts[mask.pattern] ?? 0) + fired;
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * The smallest run count whose all-failing Wilson lower bound clears
 * `target`. Answers "how many consecutive failures before I may call this
 * deterministic?" — at 95% confidence against a 0.9 target the answer is in
 * the dozens, which is why three-for-three is evidence and not proof.
 */
export function runsForLowerBound(target: number, z: number = statsKernel.Z_95): number | null {
  for (let n = 1; n <= 1_000; n++) {
    const interval = statsKernel.wilsonScoreInterval(n, n, z);
    if (interval !== null && interval.lower >= target) return n;
  }
  return null;
}

type Occurrence = {
  readonly runIndex: number;
  readonly runId: string;
  readonly position: number;
  readonly status: TestStatus;
  readonly predecessors: ReadonlySet<string>;
  readonly error?: string;
  readonly signature?: string;
};

function orderAnalysis(
  occurrences: ReadonlyArray<Occurrence>,
  orderVaried: boolean,
  suiteSize: number,
): OrderAnalysis {
  const failing = occurrences.filter((o) => isFailure(o.status));
  const passing = occurrences.filter((o) => o.status === "pass");
  const positions = {
    medianPositionWhenFailing: statsKernel.median(failing.map((o) => o.position)),
    medianPositionWhenPassing: statsKernel.median(passing.map((o) => o.position)),
  };
  if (suiteSize < 2) {
    return {
      decidable: false,
      suspects: [],
      ...positions,
      note: "each run contained a single test, so nothing could have run before this one",
    };
  }
  if (!orderVaried) {
    return {
      decidable: false,
      suspects: [],
      ...positions,
      note: "every run executed the tests in the same order, so an order-dependent failure and a nondeterministic one are indistinguishable here — re-run with the suite shuffled (and the seed recorded) before concluding either",
    };
  }
  if (failing.length === 0 || passing.length === 0) {
    return {
      decidable: false,
      suspects: [],
      ...positions,
      note: "this test did not both pass and fail, so there is no contrast between orders to learn from",
    };
  }
  // `orderVaried` is a claim about the SUITE. A suite that merely gained or
  // lost a test, or shuffled only the tail, varies its sequence while this
  // test keeps the identical prefix in every run — and an identical prefix is
  // the suite-wide unvaried case all over again: "fails after this prefix" and
  // "fails at random" are the same observation. Taking the suite's flag for
  // this test's would report "the failures do not line up with a predecessor"
  // about a comparison that was never available.
  const prefixes = new Set(occurrences.map((o) => JSON.stringify([...o.predecessors].sort())));
  if (prefixes.size < 2) {
    return {
      decidable: false,
      suspects: [],
      ...positions,
      note: "the suite's order varied, but this test ran after exactly the same set of tests in every run, so nothing here separates an order-dependent failure from a nondeterministic one",
    };
  }
  // Intersect the predecessors of every failing run, then subtract everything
  // that EVER preceded a passing run. What survives ran before the test each
  // time it failed and never when it passed: a shortlist to bisect, not a
  // cause.
  let shared: Set<string> | null = null;
  for (const occurrence of failing) {
    if (shared === null) {
      shared = new Set(occurrence.predecessors);
      continue;
    }
    for (const id of [...shared]) {
      if (!occurrence.predecessors.has(id)) shared.delete(id);
    }
  }
  const suspects = [...(shared ?? new Set<string>())]
    .filter((id) => !passing.some((o) => o.predecessors.has(id)))
    .sort();
  return {
    decidable: true,
    suspects,
    ...positions,
    note:
      suspects.length === 0
        ? "run order varied and no test ran before this one in every failure and in none of the passes; the failures do not line up with a predecessor"
        : `${suspects.length} test(s) ran before this one in every failing run and in none of the passing runs; re-run this test after each of them alone to confirm`,
  };
}

function groupFailures(
  occurrences: ReadonlyArray<Occurrence>,
  masks: ReadonlyArray<Mask>,
  counts: Record<string, number>,
): FailureGroup[] {
  const groups = new Map<string, { count: number; example: string; runs: string[] }>();
  for (const occurrence of occurrences) {
    if (!isFailure(occurrence.status)) continue;
    const raw = occurrence.error ?? "";
    // No text and no signature means the run recorded a failure without
    // saying anything about it; that is not a group of one, it is an unknown.
    if (occurrence.signature === undefined && raw === "") continue;
    const key = occurrence.signature ?? applyMasks(raw, masks, counts);
    const row = groups.get(key);
    if (row === undefined) {
      groups.set(key, { count: 1, example: raw, runs: [occurrence.runId] });
      continue;
    }
    row.count += 1;
    row.runs.push(occurrence.runId);
  }
  return [...groups.entries()]
    .map(([signature, row]) => ({
      signature,
      count: row.count,
      example: row.example,
      runs: row.runs,
    }))
    .sort((a, b) => b.count - a.count || (a.signature < b.signature ? -1 : 1));
}

export function detectFlaky(
  runs: ReadonlyArray<RunInput>,
  options: FlakyOptions = {},
): FlakyReport {
  if (runs.length === 0) throw new FlakyError("no runs were given; there is nothing to classify");
  const z = options.z ?? statsKernel.Z_95;
  const quarantineLowerBound = options.quarantineLowerBound ?? 0.05;
  if (!(quarantineLowerBound >= 0 && quarantineLowerBound <= 1)) {
    throw new FlakyError(
      `quarantineLowerBound must be a probability between 0 and 1, got ${quarantineLowerBound}`,
    );
  }
  const masks = options.masks ?? [];
  const maskCounts: Record<string, number> = {};

  const occurrences = new Map<string, Occurrence[]>();
  const sequences: string[] = [];
  for (const [runIndex, run] of runs.entries()) {
    const runId = run.id ?? `run-${runIndex + 1}`;
    const seenInRun = new Set<string>();
    const before = new Set<string>();
    for (const [position, test] of run.tests.entries()) {
      if (seenInRun.has(test.id)) {
        throw new FlakyError(
          `test "${test.id}" appears twice in ${runId}; a run reports one outcome per test, and two rows cannot both be it`,
        );
      }
      seenInRun.add(test.id);
      const list = occurrences.get(test.id) ?? [];
      list.push({
        runIndex,
        runId,
        position,
        status: test.status,
        predecessors: new Set(before),
        ...(test.error === undefined ? {} : { error: test.error }),
        ...(test.signature === undefined ? {} : { signature: test.signature }),
      });
      occurrences.set(test.id, list);
      before.add(test.id);
    }
    // JSON, not a delimiter: a test id is caller-supplied and could contain
    // whatever separator character we picked, which would make two different
    // orders compare equal and silently disable the order analysis.
    sequences.push(JSON.stringify(run.tests.map((t) => t.id)));
  }
  const orderVaried = new Set(sequences).size > 1;
  const seedsDeclared = [
    ...new Set(runs.map((r) => r.seed).filter((s): s is string => s !== undefined)),
  ].sort();
  const suiteSize = Math.max(...runs.map((r) => r.tests.length));

  const tests: TestReport[] = [...occurrences.keys()].sort().map((id) => {
    const list = occurrences.get(id) as Occurrence[];
    const failures = list.filter((o) => isFailure(o.status)).length;
    const passes = list.filter((o) => o.status === "pass").length;
    const skipped = list.filter((o) => o.status === "skip").length;
    // A skipped test is not a pass. Counting it as one is how a suite that
    // stopped running a test reports it as stable for a year.
    const runsObserved = failures + passes;
    const absent = runs.length - list.length;
    const interval = statsKernel.wilsonScoreInterval(failures, runsObserved, z);
    const failureRate = {
      pointEstimate: interval?.pointEstimate ?? null,
      lower: interval?.lower ?? null,
      upper: interval?.upper ?? null,
      width: interval?.width ?? null,
      z,
    };
    const order = orderAnalysis(list, orderVaried, suiteSize);
    const failureGroups = groupFailures(list, masks, maskCounts);
    // A failure that recorded no text and no signature is in no group, so one
    // group does not mean one failure mode — it means one failure mode among
    // the failures that said anything. Answering "yes, always the same way"
    // from that subset is the cheap wrong answer: it is what sends someone
    // after a single root cause for two different bugs.
    const ungroupedFailures = list.filter(
      (o) => isFailure(o.status) && o.signature === undefined && (o.error ?? "") === "",
    ).length;
    const sameFailureEveryTime =
      failures === 0 || failureGroups.length === 0 || ungroupedFailures > 0
        ? null
        : failureGroups.length === 1;

    const classification: TestClassification =
      runsObserved === 0
        ? "not-observed"
        : failures === 0
          ? "passing"
          : failures === runsObserved
            ? "failing-every-run"
            : "flaky";

    let recommendation: TestReport["recommendation"] = "keep";
    let why: string;
    if (classification === "not-observed") {
      why = `never ran: skipped in ${skipped} run(s) and absent from ${absent}`;
    } else if (classification === "passing") {
      why = `passed all ${runsObserved} run(s) it was observed in`;
      // Passing every time is not the same as being stable. With two or three
      // observations the interval still reaches past a coin flip, so quote it
      // rather than implying a clean bill of health.
      if (interval !== null && interval.upper > 0.5) {
        why += `; with only ${runsObserved} observation(s) its failure rate could still be as high as ${(interval.upper * 100).toFixed(0)}%`;
      }
    } else if (classification === "failing-every-run") {
      recommendation = "fix";
      why = `failed in all ${runsObserved} run(s)`;
      if (!orderVaried && suiteSize > 1) {
        why +=
          "; every run used the same order, so this is equally consistent with a deterministic failure and with one that only happens after the tests that preceded it";
      }
      if (interval !== null) {
        why += `; ${runsObserved}-for-${runsObserved} puts the failure rate at ${(interval.lower * 100).toFixed(0)}% or above, not at 100%`;
      }
    } else {
      const lower = interval?.lower ?? 0;
      const upper = interval?.upper ?? 1;
      recommendation = lower >= quarantineLowerBound ? "quarantine" : "insufficient-evidence";
      why = `failed ${failures} of ${runsObserved} run(s); the ${(lower * 100).toFixed(1)}%-${(upper * 100).toFixed(1)}% interval ${
        recommendation === "quarantine"
          ? `clears the ${(quarantineLowerBound * 100).toFixed(1)}% quarantine floor`
          : `does not clear the ${(quarantineLowerBound * 100).toFixed(1)}% quarantine floor — run it more before acting on the point estimate`
      }`;
      if (order.suspects.length > 0) {
        why += `; it may be order-dependent rather than nondeterministic (${order.suspects.length} candidate predecessor(s))`;
      }
    }

    return {
      id,
      classification,
      runsObserved,
      failures,
      passes,
      skipped,
      absent,
      failureRate,
      order,
      failureGroups,
      sameFailureEveryTime,
      recommendation,
      why,
    };
  });

  const summary: Record<TestClassification, number> = {
    passing: 0,
    flaky: 0,
    "failing-every-run": 0,
    "not-observed": 0,
  };
  for (const test of tests) summary[test.classification] += 1;

  // One run can show a failure. It cannot show a flake: every classification
  // above needs at least two observations of one test to mean anything.
  const verdict =
    runs.length < 2
      ? "inconclusive"
      : summary.flaky > 0
        ? "flaky"
        : summary["failing-every-run"] > 0
          ? "failing"
          : "clean";

  return {
    runs: runs.length,
    ordering: {
      varied: orderVaried,
      seedsDeclared,
      note: orderVaried
        ? `${new Set(sequences).size} distinct execution order(s) across ${runs.length} run(s)`
        : seedsDeclared.length > 1
          ? "the runs declare different seeds but executed the tests in the same order, so the seed never reached the suite"
          : "every run executed the tests in the same order; order-dependent failures cannot be distinguished from nondeterministic ones in this input",
    },
    tests,
    summary,
    masksApplied: maskCounts,
    runsForDeterminismClaim: runsForLowerBound(0.9, z),
    verdict,
    note:
      runs.length < 2
        ? "a single run cannot distinguish a flaky test from a deterministic one: re-run the suite and pass every run"
        : `${tests.length} test(s) across ${runs.length} run(s); rates are Wilson intervals at z=${z}, not raw fail/run ratios`,
  };
}
