import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type JobQueue,
  type JobRunner,
  type JobStore,
  createFileJobStore,
  createJobQueue,
} from "@crewhaus/harness-supervisor";
import { commandsLedgerOf } from "./ledgers";
import { removeTempDirs, rig, rowsOf, tempDir } from "./test-helpers";
import type { ControlService } from "./wire";

afterAll(removeTempDirs);

const HRN = "home/harness/hrn_0123456789abcdef";

/** A runner whose jobs finish when the test says, with the answer it gives. */
function controllable() {
  const finishers = new Map<string, (answer: { exitCode?: number; error?: string }) => void>();
  const terminated: string[] = [];
  const run: JobRunner = (job, ctx) =>
    new Promise((resolve) => {
      finishers.set(job.jobId, resolve);
      ctx.register({
        terminate: () => {
          terminated.push(job.jobId);
          resolve({ exitCode: 143 });
        },
        forceKill: () => undefined,
      });
    });
  return {
    run,
    terminated,
    finish: (jobId: string, answer: { exitCode?: number; error?: string } = { exitCode: 0 }) =>
      finishers.get(jobId)?.(answer),
  };
}

type Setup = {
  readonly service: ControlService;
  readonly harness: string;
  readonly path: string;
  readonly inner: JobStore;
  readonly queue: JobQueue;
  readonly runner: ReturnType<typeof controllable>;
};

function setup(concurrency = 3): Setup {
  const r = rig({ pid: 1000, mode: "server" });
  const path = join(tempDir("control-service-jobs-"), "jobs.jsonl");
  const inner = createFileJobStore(path);
  const runner = controllable();
  const queue = createJobQueue({
    store: r.service.jobs.wrapStore(inner),
    run: runner.run,
    concurrency,
  });
  return { service: r.service, harness: r.harness, path, inner, queue, runner };
}

/** A command carried out by a job, submitted the way Home's job routes submit it. */
async function submitJob(s: Setup, queue: JobQueue = s.queue) {
  const answer = await s.service.commands.submit(
    {
      kind: "legacy.submitJob",
      target: HRN,
      ledger: { harness: s.harness },
      via: "home",
      queued: true,
    },
    async (receipt) => ({
      value: queue.submit({
        harnessDir: s.harness,
        kind: "eval",
        argv: ["eval"],
        commandId: receipt.id,
        by: receipt.actor,
      }),
    }),
  );
  if (!answer.ok || answer.replayed || answer.value === undefined) throw new Error("refused");
  return { receipt: answer.receipt, job: answer.value };
}

const settled = async (s: Setup): Promise<void> => {
  await Bun.sleep(0);
  await s.service.jobs.idle();
};

const stateOf = (s: Setup, id: string) => s.service.commands.get({ harness: s.harness }, id);

describe("a command carried out by a job moves with the job", () => {
  test("accepted on submit; running when it starts; succeeded when it is done", async () => {
    const s = setup();
    const { receipt, job } = await submitJob(s);
    expect(receipt.state).toBe("accepted");
    expect(job.commandId).toBe(receipt.id);
    expect(job.by).toBe(receipt.actor);
    await settled(s);
    const running = stateOf(s, receipt.id);
    expect(running?.state).toBe("running");
    expect(running?.executor?.pid).toBe(1000);
    s.runner.finish(job.jobId);
    await s.queue.idle();
    await settled(s);
    const done = stateOf(s, receipt.id);
    expect(done?.state).toBe("succeeded");
    expect(done?.effects).toEqual([{ kind: "job", ref: job.jobId, status: "done" }]);
    expect(rowsOf(commandsLedgerOf(s.harness)).map((row) => row["state"])).toEqual([
      "accepted",
      "running",
      "succeeded",
    ]);
  });

  test("the receipt moves although only the first job row names the command", async () => {
    const s = setup();
    const { receipt, job } = await submitJob(s);
    s.runner.finish(job.jobId);
    await s.queue.idle();
    await settled(s);
    const lines = readFileSync(s.path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => line["state"])).toEqual(["pending", "running", "done"]);
    expect(lines[0]?.["commandId"]).toBe(receipt.id);
    expect(lines.slice(1).every((line) => line["commandId"] === undefined)).toBe(true);
    expect(stateOf(s, receipt.id)?.state).toBe("succeeded");
  });

  test("a failing job fails its command", async () => {
    const s = setup();
    const { receipt, job } = await submitJob(s);
    s.runner.finish(job.jobId, { exitCode: 2 });
    await s.queue.idle();
    await settled(s);
    expect(stateOf(s, receipt.id)?.state).toBe("failed");
  });

  test("cancelled while pending: the command is cancelled", async () => {
    const s = setup(1);
    const first = await submitJob(s);
    const second = await submitJob(s);
    expect(s.queue.cancel(second.job.jobId)).toBe(true);
    await settled(s);
    const cancelled = stateOf(s, second.receipt.id);
    expect(cancelled?.state).toBe("cancelled");
    expect(cancelled?.outcome?.code).toBe("cancelled");
    s.runner.finish(first.job.jobId);
    await s.queue.idle();
  });

  test("cancelled while running: the command failed, with the outcome cancelled", async () => {
    const s = setup();
    const { receipt, job } = await submitJob(s);
    await settled(s);
    expect(s.queue.cancel(job.jobId)).toBe(true);
    await s.queue.idle();
    await settled(s);
    const after = stateOf(s, receipt.id);
    expect(after?.state).toBe("failed");
    expect(after?.outcome?.code).toBe("cancelled");
  });

  test("a job left running by a manager that died: the restore makes its command unknown", async () => {
    const s = setup();
    const { receipt } = await submitJob(s);
    await settled(s);
    expect(stateOf(s, receipt.id)?.state).toBe("running");
    // The next manager: a new queue over the same file, wrapped again.
    const revived = createJobQueue({
      store: s.service.jobs.wrapStore(createFileJobStore(s.path)),
      run: controllable().run,
    });
    revived.restore();
    await settled(s);
    const after = stateOf(s, receipt.id);
    expect(after?.state).toBe("unknown");
    expect(after?.outcome).toEqual({
      code: "interrupted",
      message: "interrupted, needs a decision",
    });
  });

  test("a read-only job's interrupted command failed, outcome interrupted", async () => {
    const s = setup();
    const answer = await s.service.commands.submit(
      {
        kind: "legacy.doctorRun",
        target: HRN,
        ledger: { harness: s.harness },
        via: "home",
        queued: true,
      },
      async (receipt) => ({
        value: s.queue.submit({
          harnessDir: s.harness,
          kind: "doctor",
          argv: ["doctor"],
          commandId: receipt.id,
        }),
      }),
    );
    if (!answer.ok) throw new Error("refused");
    await settled(s);
    createJobQueue({
      store: s.service.jobs.wrapStore(createFileJobStore(s.path)),
      run: controllable().run,
    }).restore();
    await settled(s);
    const after = stateOf(s, answer.receipt.id);
    expect(after?.state).toBe("failed");
    expect(after?.outcome?.code).toBe("interrupted");
  });

  test("a job no command submitted moves nothing", async () => {
    const s = setup();
    const job = s.queue.submit({ harnessDir: s.harness, kind: "eval", argv: ["eval"] });
    s.runner.finish(job.jobId);
    await s.queue.idle();
    await settled(s);
    expect(rowsOf(commandsLedgerOf(s.harness))).toEqual([]);
  });

  test("Home's recovery knows which commands the job rows carry", async () => {
    const s = setup();
    const { receipt } = await submitJob(s);
    expect(s.service.jobs.commandIds()?.has(receipt.id)).toBe(true);
  });
});
