/**
 * What a run measured, read from its summary, and what has moved since.
 *
 * A case counts as measured when it produced a verdict about the spec: it did
 * not error (invoker or grader), the judge did not abstain, it is not a
 * contamination canary, and it is not not-measured, skipped or observing. The
 * index row's `measuredCount`, the console's run rows and {@link runState}
 * all count with {@link sampleMeasured}, so they agree.
 */
import {
  type EvalRunSummary,
  type SampleResult,
  sampleAbstained,
  sampleIsCanary,
  sampleWithoutVerdict,
} from "@crewhaus/eval-runner";

/** Whether a sample produced a verdict about the spec (see the module doc). */
export function sampleMeasured(s: SampleResult): boolean {
  return (
    s.error === undefined &&
    s.graderError === undefined &&
    !sampleAbstained(s) &&
    !sampleIsCanary(s) &&
    !sampleWithoutVerdict(s)
  );
}

export type RunState = {
  /**
   * `partial` when the run stopped at its budget; otherwise `not_measured`
   * when no case was measured (an all-errored run included); otherwise
   * `complete`.
   */
  readonly state: "complete" | "partial" | "not_measured";
  /** Cases measured ({@link sampleMeasured}). */
  readonly measured: number;
  readonly total: number;
  /** The run was resumed into its own directory. */
  readonly resumed?: true;
  /** Every tool result came from a recording. */
  readonly replayed?: true;
  /** The run graded another run's recorded answers (a regrade or a preview). */
  readonly regraded?: true;
};

/** The state of a run, from its summary. */
export function runState(summary: EvalRunSummary): RunState {
  const samples = summary.samples ?? [];
  const measured = samples.filter(sampleMeasured).length;
  const state =
    summary.partial !== undefined ? "partial" : measured === 0 ? "not_measured" : "complete";
  return {
    state,
    measured,
    total: samples.length,
    ...(summary.resumed !== undefined ? { resumed: true as const } : {}),
    ...(summary.config?.toolRecording?.mode === "replay" ? { replayed: true as const } : {}),
    ...(summary.config?.purpose !== undefined ? { regraded: true as const } : {}),
  };
}

/** What has moved since a run: never stored, always computed. */
export type Staleness = "spec_changed" | "not_deployed_revision" | "cases_changed";

/**
 * How a recorded run stands against the present: the spec changed since it
 * ran, the revision it measured is not the deployed one, or the dataset's
 * cases changed. A value the caller does not know is left out, and says
 * nothing.
 */
export function staleness(
  run: { readonly specHash: string; readonly datasetHash?: string },
  current: {
    readonly specHash?: string;
    readonly deployedSpecHash?: string;
    readonly datasetHash?: string;
  },
): Staleness[] {
  const out: Staleness[] = [];
  if (current.specHash !== undefined && current.specHash !== run.specHash) {
    out.push("spec_changed");
  }
  if (current.deployedSpecHash !== undefined && current.deployedSpecHash !== run.specHash) {
    out.push("not_deployed_revision");
  }
  if (
    current.datasetHash !== undefined &&
    run.datasetHash !== undefined &&
    current.datasetHash !== run.datasetHash
  ) {
    out.push("cases_changed");
  }
  return out;
}
