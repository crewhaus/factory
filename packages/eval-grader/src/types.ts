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
};

export type Grader = (sample: Sample, runResult: RunResult) => Promise<GradeResult>;
