import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Sample } from "@crewhaus/eval-dataset";
import {
  type CompiledGrader,
  type GradeResult,
  type Grader,
  type RunResult,
  type ToolCall,
  combineCompiledGraders,
} from "@crewhaus/eval-grader";
import { type Event as TranscriptEvent, openEventLog } from "@crewhaus/event-log";
import { type RunContext, createRunContext } from "@crewhaus/run-context";
import type {
  ModelResponseEvent,
  PermissionDecisionEvent,
  TestVerdictEvent,
  TraceEvent,
} from "@crewhaus/trace-event-bus";
import { RunnerError } from "./errors";
import type { AgentInvoker, GraderEntry, SampleMetrics, SampleResult } from "./types";

/**
 * Per-sample logic. Mints a fresh runContext (and therefore a fresh
 * TraceEventBus + sessionId), subscribes to the bus, calls the invoker,
 * and persists `transcript.jsonl`, `events.jsonl`, `grades.json`,
 * `meta.json` to the per-sample directory.
 */
export async function runSample(args: {
  sample: Sample;
  invoker: AgentInvoker;
  graders: ReadonlyArray<GraderEntry>;
  outDir: string; // .crewhaus/evals/<runId>
  model: string;
  seed?: number;
  /** The spec name (`ir.name`) — threaded into `RunResult.artifacts` so
   *  artifact graders can address `.crewhaus/state/<specName>/` directly. */
  specName?: string;
  /**
   * G15 — 1-based trial index under `RunEvalOptions.repeats`. Trial 1 (or
   * absent) keeps the pre-repeats artifact layout (`<outDir>/<sampleId>/`);
   * trials ≥ 2 get their own `<sampleId>.trial<N>` directory so repeated
   * runs never clobber each other's transcripts.
   */
  trial?: number;
  /**
   * Loop contract 0.4 (Batch C, G59) — optional shared `RunContext`. When a
   * caller threads one (e.g. a run loop that attaches an OTel exporter to the
   * whole eval run's bus), the sample runs on it and the per-sample
   * `test_verdict` publish lands on that shared bus; omitted ⇒ a fresh
   * per-sample context as before (behaviour unchanged for existing callers).
   */
  runContext?: RunContext;
}): Promise<SampleResult> {
  const { sample, invoker, graders, outDir, model } = args;
  const trialSuffix = args.trial !== undefined && args.trial > 1 ? `.trial${args.trial}` : "";
  const sampleDir = join(outDir, `${sanitize(sample.id)}${trialSuffix}`);
  mkdirSync(sampleDir, { recursive: true });

  const runContext = args.runContext ?? createRunContext();
  const events: TraceEvent[] = [];
  const unsubscribe = runContext.eventBus.subscribe((e) => {
    events.push(e);
  });

  const startedAt = new Date().toISOString();
  const t0 = performance.now();

  let agentOutput = "";
  let transcript: TranscriptEvent[] = [];
  let invokerEvents: ReadonlyArray<TraceEvent> | undefined;
  let error: string | undefined;
  try {
    const result = await invoker({
      sample,
      runContext,
      sessionRootDir: sampleDir,
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
    });
    agentOutput = result.agentOutput;
    transcript = result.transcript ? [...result.transcript] : [];
    invokerEvents = result.events;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    unsubscribe();
  }

  const endedAt = new Date().toISOString();
  const latencyMs = Math.round(performance.now() - t0);

  // If the invoker didn't supply a transcript, attempt to read it from disk
  // (this is the path the production runChatLoop wrapper takes).
  if (transcript.length === 0 && error === undefined) {
    transcript = await readTranscript(sampleDir, runContext.sessionId);
  }

  const finalEvents = invokerEvents ? [...invokerEvents] : events;

  // Rename auto-named event-log file → transcript.jsonl for stable artifact
  // names. (Skip if the invoker didn't actually write one, e.g. test stubs.)
  const autoPath = join(sampleDir, `${runContext.sessionId}.jsonl`);
  const transcriptPath = join(sampleDir, "transcript.jsonl");
  if (await Bun.file(autoPath).exists()) {
    renameSync(autoPath, transcriptPath);
  } else if (transcript.length > 0) {
    // Stub-supplied transcript — write it ourselves.
    await Bun.write(
      transcriptPath,
      transcript.map((e) => JSON.stringify(e)).join("\n") + (transcript.length > 0 ? "\n" : ""),
    );
  } else {
    await Bun.write(transcriptPath, "");
  }

  // Persist captured trace events.
  await Bun.write(
    join(sampleDir, "events.jsonl"),
    finalEvents.map((e) => JSON.stringify(e)).join("\n") + (finalEvents.length > 0 ? "\n" : ""),
  );

  const turns = transcript.filter((e) => e.kind === "assistant_message").length;
  const toolCalls = extractToolCalls(finalEvents);
  const tokens = sumTokens(finalEvents);
  const metrics = computeMetrics(sample, finalEvents, toolCalls);

  // Apply graders. `artifacts` is the PR-19 seam for artifact-reading
  // graders (grader-continuity): the sample's own directory — the primary
  // session's `transcript.jsonl`, any extra session JSONLs a multi-session
  // invoker wrote, and the isolated `.crewhaus/` fabric root (§7.2) — so
  // graders measure the finished sample's files, never the host's live
  // stores.
  const runResult: RunResult = {
    agentOutput,
    events: finalEvents,
    transcript,
    toolCalls,
    turns,
    latencyMs,
    artifacts: {
      sampleDir,
      sessionId: runContext.sessionId,
      transcriptPath,
      stateRootDir: join(sampleDir, ".crewhaus"),
      ...(args.specName !== undefined ? { specName: args.specName } : {}),
    },
  };

  const perGrader: Array<{ name: string } & GradeResult> = [];
  // A grader throwing is grader INFRA noise (judge 429/timeout), not a graded
  // verdict on the agent's output. It still lands as a failed perGrader entry
  // (so `overall` honestly fails), but the structured `graderError` below
  // lets the run loop retry the sample and triage classify it as noise.
  const graderErrors: string[] = [];
  for (const g of graders) {
    let result: GradeResult;
    try {
      result = await g.grader(sample, runResult);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      graderErrors.push(`${g.name}: ${msg}`);
      result = {
        passed: false,
        score: 0,
        rationale: `grader threw: ${msg}`,
      };
    }
    perGrader.push({ name: g.name, ...result });
  }
  const graderError =
    graderErrors.length > 0 ? `grader threw: ${graderErrors.join("; ")}` : undefined;

  // Overall = AND of all graders, score = mean.
  const overall: GradeResult = {
    passed: error === undefined && perGrader.every((g) => g.passed),
    score:
      perGrader.length === 0 ? 0 : perGrader.reduce((s, g) => s + g.score, 0) / perGrader.length,
    rationale:
      error !== undefined
        ? `agent invocation error: ${error}`
        : perGrader.map((g) => `[${g.name}: ${g.passed ? "✓" : "✗"}] ${g.rationale}`).join(" & "),
  };

  // Loop contract 0.4 (Batch C, G59) — publish the AgentFlow `test_verdict`
  // feedback signal from the grader outcome. A distinct event kind (not a
  // `tool_call_end`) so the optimizer can filter cheaply and OTel exporters
  // can route verdicts to a verdict dashboard. An invoker error is an
  // `"error"` verdict (the run never produced a gradeable output); otherwise
  // the AND-of-graders `overall.passed` maps to `pass`/`fail`. Additive: it
  // does NOT touch the already-persisted events.jsonl / metrics / aggregates
  // — it is a bus emit on the (optionally shared) run context.
  const verdict: TestVerdictEvent = {
    ...runContext.eventBus.envelope(),
    kind: "test_verdict",
    testId: sample.id,
    verdict: error !== undefined ? "error" : overall.passed ? "pass" : "fail",
    reason: overall.rationale,
    durationMs: latencyMs,
  };
  runContext.eventBus.publish(verdict);

  const sampleResult: SampleResult = {
    sampleId: sample.id,
    sessionId: runContext.sessionId,
    startedAt,
    endedAt,
    latencyMs,
    turns,
    tokens,
    model,
    agentOutput,
    grades: { overall, perGrader },
    metrics,
    ...(error !== undefined ? { error } : {}),
    ...(graderError !== undefined ? { graderError } : {}),
  };

  await Bun.write(join(sampleDir, "grades.json"), JSON.stringify(sampleResult.grades, null, 2));
  await Bun.write(
    join(sampleDir, "meta.json"),
    JSON.stringify(
      {
        sampleId: sample.id,
        sessionId: runContext.sessionId,
        startedAt,
        endedAt,
        latencyMs,
        turns,
        tokens,
        model,
        metrics,
        ...(error !== undefined ? { error } : {}),
        ...(graderError !== undefined ? { graderError } : {}),
        ...(args.seed !== undefined ? { seed: args.seed } : {}),
        ...(args.trial !== undefined && args.trial > 1 ? { trial: args.trial } : {}),
      },
      null,
      2,
    ),
  );

  return sampleResult;
}

/**
 * G56 — extract per-sample loop-quality metrics from the captured trace
 * events. The safety buckets are DISJOINT (see `SafetyViolationCounts`):
 * `egress-blocked` outcomes count only as egress blocks even though their
 * `decision` is also `"deny"`; a deny carrying `judgeModel` is the intent
 * gate's justification rejection; every remaining deny is a plain
 * permission denial. Resolved asks (`askOutcome` present — published as a
 * SECOND `decision: "ask"` event, so they never collide with the deny
 * buckets) count as human-intervention points.
 */
function computeMetrics(
  sample: Sample,
  events: ReadonlyArray<TraceEvent>,
  toolCalls: ReadonlyArray<ToolCall>,
): SampleMetrics {
  let interventions = 0;
  let permissionDenials = 0;
  let egressBlocks = 0;
  let justificationRejections = 0;
  const modelCallLatenciesMs: number[] = [];
  for (const ev of events) {
    if (ev.kind === "model_response") {
      modelCallLatenciesMs.push((ev as ModelResponseEvent).durationMs);
    } else if (ev.kind === "permission_decision") {
      const e = ev as PermissionDecisionEvent;
      if (e.askOutcome !== undefined) interventions += 1;
      if (e.outcome === "egress-blocked") egressBlocks += 1;
      else if (e.decision === "deny" && e.judgeModel !== undefined) justificationRejections += 1;
      else if (e.decision === "deny") permissionDenials += 1;
    }
  }

  let toolCallAccuracy: number | undefined;
  const expected = sample.expected_tools;
  if (expected !== undefined && expected.length > 0) {
    const expectedSet = new Set(expected);
    const called = new Set(toolCalls.map((c) => c.toolName));
    let hit = 0;
    for (const name of expectedSet) if (called.has(name)) hit += 1;
    toolCallAccuracy = hit / expectedSet.size;
  }

  return {
    ...(toolCallAccuracy !== undefined ? { toolCallAccuracy } : {}),
    interventions,
    safetyViolations: {
      permissionDenials,
      egressBlocks,
      justificationRejections,
      total: permissionDenials + egressBlocks + justificationRejections,
    },
    modelCallLatenciesMs,
  };
}

/** Helper: produce one combined grader from an array of CompiledGrader. */
export function combineGraderEntries(graders: ReadonlyArray<CompiledGrader>): Grader {
  return combineCompiledGraders(graders);
}

/** Strip path separators from sample IDs to keep the on-disk layout flat. */
function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, "_");
}

async function readTranscript(dir: string, sessionId: string): Promise<TranscriptEvent[]> {
  const out: TranscriptEvent[] = [];
  try {
    const log = await openEventLog(sessionId, { rootDir: dir });
    for await (const e of log.read()) out.push(e);
    await log.close();
  } catch (err) {
    // Tolerate missing log (test stubs may skip persistence).
    if (!(err instanceof Error && /invalid sessionId/.test(err.message))) {
      throw new RunnerError(`failed to read transcript for ${sessionId}`, err);
    }
  }
  return out;
}

function extractToolCalls(events: ReadonlyArray<TraceEvent>): ToolCall[] {
  const calls: Array<ToolCall & { ts: number }> = [];
  const startByUseId = new Map<string, { toolName: string; ts: number }>();
  for (const ev of events) {
    if (ev.kind === "tool_call_start") {
      startByUseId.set(ev.toolUseId, { toolName: ev.toolName, ts: Date.parse(ev.timestamp) });
    } else if (ev.kind === "tool_call_end") {
      const start = startByUseId.get(ev.toolUseId);
      calls.push({
        toolName: ev.toolName,
        toolUseId: ev.toolUseId,
        isError: ev.isError,
        ts: start?.ts ?? Date.parse(ev.timestamp),
      });
    }
  }
  calls.sort((a, b) => a.ts - b.ts);
  return calls.map(({ ts: _ts, ...rest }) => rest);
}

function sumTokens(events: ReadonlyArray<TraceEvent>): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const ev of events) {
    if (ev.kind === "model_response") {
      const e = ev as ModelResponseEvent;
      input += e.usage.input;
      output += e.usage.output;
    }
  }
  return { input, output };
}
