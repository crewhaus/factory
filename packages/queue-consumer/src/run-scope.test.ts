/**
 * A job's handler runs in a run scope: the run it starts was started by the
 * queue and may be resumed as the job. A job id no resume scope can name runs
 * anyway, with no resume scope and one stderr line.
 */
import { describe, expect, test } from "bun:test";
import { createInMemoryQueue } from "@crewhaus/queue-protocol";
import { type RunContext, createRunContext } from "@crewhaus/run-context";
import { type ConsumerHandlerOutcome, startConsumer } from "./index.js";

const CLEAN = "Summarise the attached quarterly report in three bullet points.";

/** Run one job with the given id; resolve with the context its handler made and its outcome. */
async function runJob(
  jobId: string,
): Promise<{ ctx: RunContext | undefined; outcome: ConsumerHandlerOutcome<string> }> {
  const queue = createInMemoryQueue<string>({ initialJobs: [CLEAN], newJobId: () => jobId });
  let ctx: RunContext | undefined;
  let resolveEnd!: (outcome: ConsumerHandlerOutcome<string>) => void;
  const ended = new Promise<ConsumerHandlerOutcome<string>>((resolve) => {
    resolveEnd = resolve;
  });
  const consumer = startConsumer<string, string>({
    queue,
    handler: async () => {
      ctx = createRunContext();
      return "ran";
    },
    concurrency: 1,
    visibilityTimeoutMs: 5_000,
    maxRetries: 0,
    emptyQueuePollMs: 1,
    observer: { onJobEnd: (_job, outcome) => resolveEnd(outcome) },
  });
  const outcome = await ended;
  await consumer.drain();
  return { ctx, outcome };
}

/** Capture what is written to stderr while `fn` runs. */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    const value = await fn();
    return {
      value,
      lines: chunks
        .join("")
        .split("\n")
        .filter((l) => l !== ""),
    };
  } finally {
    process.stderr.write = original;
  }
}

describe("a job's run scope", () => {
  test("the handler's context resumes as the job and was started by the queue; the input is still adopted", async () => {
    const { ctx, outcome } = await runJob("job_00000042");
    expect(outcome.kind).toBe("ok");
    expect(ctx?.resumeScope).toBe("job:job_00000042");
    expect(ctx?.trigger).toEqual({ kind: "queue" });
    expect(ctx?.dataLineage?.get(CLEAN)).toBe("api");
  });

  test("a job id with a space runs with no resume scope, and one stderr line names it", async () => {
    const { value, lines } = await captureStderr(() => runJob("job with space"));
    expect(value.outcome.kind).toBe("ok");
    expect(value.ctx).toBeDefined();
    expect("resumeScope" in (value.ctx ?? {})).toBe(false);
    expect(value.ctx?.trigger).toEqual({ kind: "queue" });
    const named = lines.filter((l) => l.includes("job with space"));
    expect(named).toHaveLength(1);
  });
});
