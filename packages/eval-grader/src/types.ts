import type { Sample } from "@crewhaus/eval-dataset";
import type { Event as TranscriptEvent } from "@crewhaus/event-log";
import type { TraceEvent } from "@crewhaus/trace-event-bus";

export type GradeResult = {
  readonly passed: boolean;
  /** 0..1 normalized score; map an LLM-judge 1–5 score via (n-1)/4. */
  readonly score: number;
  readonly rationale: string;
  /**
   * A3 — the judge declined to score because the evidence was insufficient.
   * Only judge-backed graders ever set this; when `true`, `passed: false` /
   * `score: 0` are conservative placeholders and the runner should route
   * the sample to human review (needs-human) instead of counting it as a
   * fail. Absent (deterministic graders, pre-abstention records) = a
   * normal verdict.
   */
  readonly abstained?: boolean;
  /** Judge-reported confidence in the verdict, 0..1 (absent when the judge
   *  did not report one — deterministic graders never do). */
  readonly confidence?: number;
  /**
   * A12 — per-criterion score breakdown behind this verdict. Judge-backed
   * graders set it to the rubric's `criterion_scores` (raw 1–5 per
   * criterion, NOT normalized like `score`) so the decomposed signal the
   * judge already paid for survives into grades.json/results.json instead
   * of collapsing to one scalar. Absent on deterministic graders, abstained
   * verdicts (their criterion scores are guesses), and pre-A12 records.
   */
  readonly detail?: Readonly<Record<string, number>>;
  /**
   * A2 — the sample deserves a HUMAN look even though the verdict is real:
   * a judge panel's pass/fail vote split was high-entropy (normalized vote
   * entropy > 0.8 — e.g. 2–1 or 3–2), so the recorded pass/fail is a
   * coin-flip-grade signal. Unlike `abstained`, the verdict still COUNTS
   * (pass-rate denominator unchanged); the runner only lists the sample in
   * a separate needs-review bucket beside the abstained needs-human one.
   * Absent on single-judge grades, unanimous-ish panels, and pre-A2 records.
   */
  readonly needsReview?: boolean;
  /**
   * A2 — the judge panel behind this verdict (`llm_judge` with `judges:`).
   * `panelists` records each panel model's own outcome (raw 1–5 score —
   * fractional when per-panelist `repeats` composed a median — absent when
   * that panelist abstained); `voteEntropy` is the normalized Shannon
   * entropy of the scored panelists' pass/fail votes (0 = unanimous,
   * 1 = an even split). Absent on single-judge grades and pre-A2 records.
   */
  readonly panel?: {
    readonly panelists: ReadonlyArray<{
      readonly model: string;
      readonly score?: number;
      readonly passed: boolean;
      readonly abstained?: boolean;
    }>;
    readonly voteEntropy: number;
  };
};

/** Distilled tool-call shape, derived from trace events. */
export type ToolCall = {
  readonly toolName: string;
  readonly toolUseId: string;
  readonly isError: boolean;
};

/**
 * v0.3.0 §7.3 (PR 19) — where this sample's on-disk artifacts live. The
 * eval-runner isolates every sample into its own directory (session JSONLs
 * at the top level, the memory fabric's ephemeral `.crewhaus/` state root
 * nested inside — §7.2), and artifact-reading graders (e.g.
 * `@crewhaus/grader-continuity`) need a way to FIND those files. This is
 * that seam, and deliberately nothing more: graders read a finished
 * sample's artifacts off disk; they never receive live store handles from
 * the host (no layering violation, no way to mutate what they measure).
 * Optional so hand-built `RunResult`s (tests, transcript-only grading)
 * stay valid — artifact graders degrade to `transcript` when absent.
 */
export type RunArtifacts = {
  /** The per-sample directory (`.crewhaus/evals/<runId>/<sampleId>`). */
  readonly sampleDir: string;
  /** The primary session id — its JSONL is renamed `transcript.jsonl`. */
  readonly sessionId: string;
  /** `<sampleDir>/transcript.jsonl` (the primary session's event log). */
  readonly transcriptPath: string;
  /** The sample's ephemeral fabric root, `<sampleDir>/.crewhaus` — state/
   *  (focus, plans, handoff), memories/, wiki/ live under it. */
  readonly stateRootDir: string;
  /** The spec name (scopes `.crewhaus/state/<specName>/`), when known. */
  readonly specName?: string;
};

export type RunResult = {
  /** Final assistant text returned by `runChatLoop`. */
  readonly agentOutput: string;
  /** Trace events captured from the per-run TraceEventBus. */
  readonly events: ReadonlyArray<TraceEvent>;
  /** Append-only conversation transcript from the event-log JSONL. */
  readonly transcript: ReadonlyArray<TranscriptEvent>;
  /** Distilled tool-call sequence (in fire order). */
  readonly toolCalls: ReadonlyArray<ToolCall>;
  /** Number of turns the agent took. */
  readonly turns: number;
  /** End-to-end wall-clock latency in ms. */
  readonly latencyMs: number;
  /** On-disk artifact locations for this sample (see {@link RunArtifacts}). */
  readonly artifacts?: RunArtifacts;
};

export type Grader = (sample: Sample, runResult: RunResult) => Promise<GradeResult>;
