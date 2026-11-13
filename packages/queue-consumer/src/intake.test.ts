/**
 * The operator record admits jobs: while it closes intake the consumer pulls nothing,
 * and a job whose loop the runtime refused for the same reason waits instead of
 * spending an attempt.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntakeVerdict } from "@crewhaus/control-records";
import { RunFailedError } from "@crewhaus/errors";
import { type QueueAdapter, createInMemoryQueue } from "@crewhaus/queue-protocol";
import { type ConsumerHandlerOutcome, startConsumer } from "./index.js";

const CLOSED: IntakeVerdict = {
  state: "closed",
  reasons: [{ kind: "operator", state: "paused" }],
  notice: "Paused by its operator; this message was not processed.",
  code: "paused",
  exitName: "paused",
};
const OPEN: IntakeVerdict = { state: "open" };

/** A queue whose `pull` is counted, and resolves `pulled` on its first call. */
function countedQueue<T>(inner: QueueAdapter<T>): {
  queue: QueueAdapter<T>;
  pulls: () => number;
  pulled: Promise<void>;
} {
  let pulls = 0;
  let firstPull: () => void = () => undefined;
  const pulled = new Promise<void>((resolve) => {
    firstPull = resolve;
  });
  const queue: QueueAdapter<T> = {
    ...inner,
    enqueue: inner.enqueue.bind(inner),
    ack: inner.ack.bind(inner),
    nack: inner.nack.bind(inner),
    extendVisibility: inner.extendVisibility.bind(inner),
    stats: inner.stats.bind(inner),
    pull: (args) => {
      pulls += 1;
      firstPull();
      return inner.pull(args);
    },
  };
  return { queue, pulls: () => pulls, pulled };
}

describe("startConsumer — the operator record", () => {
  test("while intake is closed nothing is pulled; once it opens, the loop pulls", async () => {
    const counted = countedQueue(createInMemoryQueue<string>());
    let verdict = CLOSED;
    let consulted = 0;
    let thirdConsult: () => void = () => undefined;
    const consultedThrice = new Promise<void>((resolve) => {
      thirdConsult = resolve;
    });
    const consumer = startConsumer<string, string>({
      queue: counted.queue,
      handler: async (input) => input,
      concurrency: 1,
      visibilityTimeoutMs: 5_000,
      emptyQueuePollMs: 1,
      intake: () => {
        consulted += 1;
        if (consulted === 3) thirdConsult();
        return verdict;
      },
    });
    await consultedThrice;
    expect(counted.pulls()).toBe(0);

    verdict = OPEN;
    await counted.pulled;
    expect(counted.pulls()).toBeGreaterThan(0);
    await consumer.drain();
  });

  test("by default the record in harnessDir is read: a disabled harness takes no job", async () => {
    const dir = mkdtempSync(join(tmpdir(), "queue-intake-"));
    const realSetTimeout = globalThis.setTimeout;
    let loopSleeps = 0;
    let thirdSleep: () => void = () => undefined;
    const sleptThrice = new Promise<void>((resolve) => {
      thirdSleep = resolve;
    });
    // The pull loop waits on the global timer between polls: count those waits.
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      if (ms === 1) {
        loopSleeps += 1;
        if (loopSleeps === 3) thirdSleep();
      }
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout);
    try {
      mkdirSync(join(dir, ".crewhaus", "run", "control"), { recursive: true });
      writeFileSync(
        join(dir, ".crewhaus", "run", "control", "operator.json"),
        `${JSON.stringify({ v: 1, rev: 1, desired: "running", deployment: { disabled: true } })}\n`,
      );
      const counted = countedQueue(createInMemoryQueue<string>());
      await counted.queue.enqueue("job");
      const consumer = startConsumer<string, string>({
        queue: counted.queue,
        handler: async (input) => input,
        concurrency: 1,
        visibilityTimeoutMs: 5_000,
        emptyQueuePollMs: 1,
        harnessDir: dir,
      });
      await sleptThrice;
      expect(counted.pulls()).toBe(0);
      await consumer.drain();
      expect((await counted.queue.stats()).pending).toBe(1);
    } finally {
      timer.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a job whose loop was refused as paused is deferred, its attempt not counted, never dead-lettered", async () => {
    const queue = createInMemoryQueue<string>();
    await queue.enqueue("job");
    const extended: number[] = [];
    const extend = queue.extendVisibility.bind(queue);
    queue.extendVisibility = (jobId, ms) => {
      extended.push(ms);
      return extend(jobId, ms);
    };
    const outcomes: Array<ConsumerHandlerOutcome<string>> = [];
    let ended: () => void = () => undefined;
    const twoEnded = new Promise<void>((resolve) => {
      ended = resolve;
    });
    const consumer = startConsumer<string, string>({
      queue,
      handler: async () => {
        throw new RunFailedError({
          class: "paused",
          title: "paused by its operator",
          detail: "Paused by its operator; this message was not processed.",
          exitCode: 39,
        });
      },
      concurrency: 1,
      visibilityTimeoutMs: 40,
      maxRetries: 1,
      deferVisibilityMs: 1,
      emptyQueuePollMs: 1,
      intake: () => OPEN,
      observer: {
        onJobEnd: (_job, outcome) => {
          outcomes.push(outcome);
          if (outcomes.length === 2) ended();
        },
      },
    });
    await twoEnded;
    await consumer.drain();
    expect(outcomes.map((o) => o.kind)).toEqual(["deferred", "deferred"]);
    expect(outcomes[1]?.kind === "deferred" && outcomes[1].defers).toBe(2);
    expect(extended).toContain(1);
    expect((await queue.stats()).deadLetter).toBe(0);
  }, 20_000);
});
