import type { Sample } from "@crewhaus/eval-dataset";
import type { Event as TranscriptEvent } from "@crewhaus/event-log";
import type { TraceEvent } from "@crewhaus/trace-event-bus";

export type GradeResult = {
  readonly passed: boolean;
  /** 0..1 normalized score; map an LLM-judge 1–5 score via (n-1)/4. */
  readonly score: number;
  readonly rationale: string;
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
