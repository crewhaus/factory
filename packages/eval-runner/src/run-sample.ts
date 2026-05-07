import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Sample } from "@crewhaus/eval-dataset";
import {
  type CompiledGrader,
  combineCompiledGraders,
  type Grader,
  type GradeResult,
  type RunResult,
  type ToolCall,
} from "@crewhaus/eval-grader";
import { openEventLog, type Event as TranscriptEvent } from "@crewhaus/event-log";
import { createRunContext } from "@crewhaus/run-context";
import type { ModelResponseEvent, TraceEvent } from "@crewhaus/trace-event-bus";
import { RunnerError } from "./errors";
import type { AgentInvoker, GraderEntry, SampleResult } from "./types";

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
}): Promise<SampleResult> {
  const { sample, invoker, graders, outDir, model } = args;
  const sampleDir = join(outDir, sanitize(sample.id));
  mkdirSync(sampleDir, { recursive: true });

  const runContext = createRunContext();
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

  // Apply graders.
  const runResult: RunResult = {
    agentOutput,
    events: finalEvents,
    transcript,
    toolCalls,
    turns,
    latencyMs,
  };

  const perGrader: Array<{ name: string } & GradeResult> = [];
  for (const g of graders) {
    let result: GradeResult;
    try {
      result = await g.grader(sample, runResult);
    } catch (err) {
      result = {
        passed: false,
        score: 0,
        rationale: `grader threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    perGrader.push({ name: g.name, ...result });
  }

  // Overall = AND of all graders, score = mean.
  const overall: GradeResult = {
    passed: error === undefined && perGrader.every((g) => g.passed),
    score: perGrader.length === 0 ? 0 : perGrader.reduce((s, g) => s + g.score, 0) / perGrader.length,
    rationale:
      error !== undefined
        ? `agent invocation error: ${error}`
        : perGrader.map((g) => `[${g.name}: ${g.passed ? "✓" : "✗"}] ${g.rationale}`).join(" & "),
  };

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
    ...(error !== undefined ? { error } : {}),
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
        ...(error !== undefined ? { error } : {}),
        ...(args.seed !== undefined ? { seed: args.seed } : {}),
      },
      null,
      2,
    ),
  );

  return sampleResult;
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
