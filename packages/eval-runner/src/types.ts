import type { Sample } from "@crewhaus/eval-dataset";
import type { GradeResult, Grader } from "@crewhaus/eval-grader";
import type { Event as TranscriptEvent } from "@crewhaus/event-log";
import type { RunContext } from "@crewhaus/run-context";
import type { TraceEvent } from "@crewhaus/trace-event-bus";

/**
 * The agent-invocation contract. The runner provides a per-sample
 * `RunContext` (fresh `TraceEventBus`, fresh `sessionId`) and the
 * destination directory for the event log. The invoker is responsible
 * for actually running the chat loop and returning the assistant text.
 *
 * In production this is a thin wrapper around `runChatLoop`. In tests it's
 * a deterministic stub that returns a canned answer per sample.
 */
export type AgentInvoker = (req: AgentInvokeRequest) => Promise<AgentInvokeResult>;

export type AgentInvokeRequest = {
  readonly sample: Sample;
  readonly runContext: RunContext;
  /** Where the runtime should write the per-sample event-log JSONL. */
  readonly sessionRootDir: string;
  readonly seed?: number;
};

export type AgentInvokeResult = {
  /** Final assistant text returned by the chat loop. */
  readonly agentOutput: string;
  /**
   * If the invoker has out-of-band knowledge (e.g. a stub), it can supply
   * the captured event-log entries here. The default invoker reads them
   * from disk after `runChatLoop` returns.
   */
  readonly transcript?: ReadonlyArray<TranscriptEvent>;
  /** Same as transcript — invoker can short-circuit the bus subscription. */
  readonly events?: ReadonlyArray<TraceEvent>;
};

export type SampleResult = {
  readonly sampleId: string;
  readonly sessionId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly latencyMs: number;
  readonly turns: number;
  readonly tokens: { input: number; output: number };
  readonly model: string;
  readonly agentOutput: string;
  readonly grades: { overall: GradeResult; perGrader: Array<{ name: string } & GradeResult> };
  readonly error?: string;
};

export type EvalRunSummary = {
  readonly runId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly samples: ReadonlyArray<SampleResult>;
  readonly aggregates: {
    readonly passRate: number;
    readonly meanScore: number;
    readonly p50Turns: number;
    readonly p95Turns: number;
    readonly p50LatencyMs: number;
    readonly p95LatencyMs: number;
    readonly totalTokens: { input: number; output: number };
    readonly errorCount: number;
  };
  readonly config: {
    readonly specHash: string;
    readonly datasetName: string;
    readonly graderNames: ReadonlyArray<string>;
    readonly model: string;
    readonly judgeModel?: string;
    readonly concurrency: number;
    readonly seed?: number;
  };
  readonly outDir: string;
};

export type RunEvalOptions = {
  readonly runId?: string;
  readonly concurrency?: number;
  readonly seed?: number;
  readonly outDir?: string;
  readonly judgeModel?: string;
  readonly invoker?: AgentInvoker;
  readonly cwd?: string;
};

export type GraderEntry = {
  readonly name: string;
  readonly grader: Grader;
};
