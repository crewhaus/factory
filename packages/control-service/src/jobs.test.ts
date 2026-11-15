import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { mintId } from "@crewhaus/control-contract";
import { append } from "@crewhaus/control-records";
import {
  type JobQueue,
  type JobRunner,
  type JobStore,
  createFileJobStore,
  createJobQueue,
  createMemoryJobStore,
} from "@crewhaus/harness-supervisor";
import type { Settlement } from "./executor";
import { commandsLedgerOf } from "./ledgers";
import { outcomeOf } from "./refusal";
import { type Rig, removeTempDirs, rig, rowsOf, tempDir } from "./test-helpers";
import type { ControlService } from "./wire";

afterAll(removeTempDirs);

const HRN = "home/harness/hrn_0123456789abcdef";
const MEMBER = mintId("prn");
const CRD = mintId("crd");

/** A runner whose jobs finish when the test says, with the answer it gives. */
function controllable() {
  const finishers = new Map<string, (answer: { exitCode?: number; error?: string }) => void>();
  const terminated: string[] = [];
  const started: string[] = [];
  const run: JobRunner = (job, ctx) =>
    new Promise((resolve) => {
      started.push(job.jobId);
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
    started,
    finish: (jobId: string, answer: { exitCode?: number; error?: string } = { exitCode: 0 }) =>
      finishers.get(jobId)?.(answer),
  };
}

type Setup = {
  readonly rig: Rig;
  readonly service: ControlService;
  readonly harness: string;
  readonly path: string;
  readonly inner: JobStore;
  readonly queue: JobQueue;
  readonly runner: ReturnType<typeof controllable>;
  readonly authority: Authority;
};

/** What the access check answers, and every question it was asked. */
type Authority = {
  answer: boolean | undefined;
  /** Permissions answered `false` whatever `answer` says. */
  readonly refuses: Set<string>;
  readonly calls: (readonly unknown[])[];
};

/** The permission a legacy route's kind needs, as Home's route table answers it. */
const permissionOf = (kind: string): string | undefined =>
  kind === "legacy.submitJob" ? "h.job.run" : undefined;

function setup(
  concurrency = 3,
  over: { readonly hangarRoot?: string; readonly harness?: string; readonly path?: string } = {},
): Setup {
  const authority: Authority = { answer: true, refuses: new Set(), calls: [] };
  const r = rig({
    pid: 1000,
    mode: "server",
    ...(over.hangarRoot !== undefined ? { hangarRoot: over.hangarRoot } : {}),
    ...(over.harness !== undefined ? { harness: over.harness } : {}),
    authorizeActor: (...args) => {
      authority.calls.push(args);
      return authority.refuses.has(args[1]) ? false : authority.answer;
    },
    permissionOf,
  });
  const path = over.path ?? join(tempDir("control-service-jobs-"), "jobs.jsonl");
  const inner = createFileJobStore(path);
  const runner = controllable();
  const queue = createJobQueue({
    store: r.service.jobs.wrapStore(inner),
    run: r.service.jobs.wrapRun(runner.run),
    concurrency,
  });
  return {
    rig: r,
    service: r.service,
    harness: r.harness,
    path,
    inner,
    queue,
    runner,
    authority,
  };
}

/** A command carried out by a job, submitted the way Home's job routes submit it. */
async function submitJob(
  s: Setup,
  queue: JobQueue = s.queue,
  by: { readonly actor?: string; readonly credentialRef?: string } = {},
) {
  const answer = await s.service.commands.submit(
    {
      kind: "legacy.submitJob",
      target: HRN,
      ledger: { harness: s.harness },
      via: "home",
      queued: true,
      ...by,
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

/** Every state a receipt's rows record, in order. */
const statesOf = (s: Setup, id: string) =>
  rowsOf(commandsLedgerOf(s.harness))
    .filter((row) => row["id"] === id)
    .map((row) => row["state"]);

/** A job's rows in the file store, in order. */
const jobRowsOf = (s: Setup, jobId: string) =>
  readFileSync(s.path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row["jobId"] === jobId);

/** Every directory under `root`, deepest last. */
function dirsUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(entry.parentPath, entry.name));
}

/** An accepted `legacy.submitJob` receipt written straight to the ledger, by this actor. */
function plantJobReceipt(s: Setup, actor: string, credentialRef?: string): string {
  const id = mintId("cmd");
  const appended = append(commandsLedgerOf(s.harness), {
    v: 1,
    id,
    kind: "legacy.submitJob",
    target: HRN,
    actor,
    ...(credentialRef !== undefined ? { credentialRef } : {}),
    via: "home",
    fingerprint: "f".repeat(64),
    state: "accepted",
    acceptedAt: new Date().toISOString(),
    executor: { pid: 1000, startedAt: new Date().toISOString(), host: hostname(), head: "server" },
    effects: [{ kind: "job", status: "unknown" }],
    retry: { retryable: false, safety: "unsafe" },
  });
  if (!appended.ok) throw new Error(appended.reason);
  return id;
}

describe("a job that carries a command starts only while its submitter may still do it", () => {
  test("a pending job whose credential does not hold the permission when its turn comes never runs", async () => {
    const s = setup(1);
    const first = await submitJob(s);
    const second = await submitJob(s, s.queue, { actor: MEMBER, credentialRef: CRD });
    expect(s.queue.pending().map((job) => job.jobId)).toEqual([second.job.jobId]);
    s.authority.answer = false;
    s.runner.finish(first.job.jobId);
    await s.queue.idle();
    await settled(s);
    expect(s.runner.started).toEqual([first.job.jobId]);
    expect(jobRowsOf(s, second.job.jobId).at(-1)?.["state"]).toBe("cancelled");
    expect(statesOf(s, second.receipt.id)).toEqual(["accepted", "rejected"]);
    const after = stateOf(s, second.receipt.id);
    expect(after?.outcome?.code).toBe("forbidden");
    expect(after?.effects).toEqual([{ kind: "job", ref: second.job.jobId, status: "skipped" }]);
    expect(s.authority.calls).toEqual([[MEMBER, "h.job.run", HRN, CRD]]);
  });

  test("the same job runs while its credential holds the permission", async () => {
    const s = setup(1);
    const first = await submitJob(s);
    const second = await submitJob(s, s.queue, { actor: MEMBER, credentialRef: CRD });
    s.runner.finish(first.job.jobId);
    await settled(s);
    expect(s.runner.started).toEqual([first.job.jobId, second.job.jobId]);
    expect(stateOf(s, second.receipt.id)?.state).toBe("running");
    s.runner.finish(second.job.jobId);
    await s.queue.idle();
    await settled(s);
    expect(statesOf(s, second.receipt.id)).toEqual(["accepted", "running", "succeeded"]);
    expect(s.authority.calls).toEqual([[MEMBER, "h.job.run", HRN, CRD]]);
  });

  test("a pending job the queue's restore puts back is checked before it starts", async () => {
    const s = setup(1);
    await submitJob(s);
    const second = await submitJob(s, s.queue, { actor: MEMBER, credentialRef: CRD });
    await settled(s);
    // The next manager, over the same Home, harness and job file, after a restart.
    const next = setup(1, { hangarRoot: s.rig.hangarRoot, harness: s.harness, path: s.path });
    next.authority.answer = false;
    const restored = next.queue.restore();
    expect(restored.requeued.map((job) => job.jobId)).toEqual([second.job.jobId]);
    await next.queue.idle();
    await settled(next);
    expect(next.runner.started).toEqual([]);
    expect(jobRowsOf(next, second.job.jobId).at(-1)?.["state"]).toBe("cancelled");
    expect(statesOf(next, second.receipt.id)).toEqual(["accepted", "rejected"]);
    expect(stateOf(next, second.receipt.id)?.outcome?.code).toBe("forbidden");
  });

  test("an answer that could not be determined runs the job, with one warning", async () => {
    const s = setup();
    s.authority.answer = undefined;
    const { receipt, job } = await submitJob(s, s.queue, { actor: MEMBER, credentialRef: CRD });
    await settled(s);
    expect(s.runner.started).toEqual([job.jobId]);
    expect(stateOf(s, receipt.id)?.state).toBe("running");
    const undetermined = s.rig.warnings.filter((w) => w.includes("could not be determined"));
    expect(undetermined).toHaveLength(1);
    s.runner.finish(job.jobId);
    await s.queue.idle();
  });

  test("a receipt that names a credential under a system actor is refused unasked", async () => {
    const s = setup();
    const id = plantJobReceipt(s, "sys:ingress", CRD);
    const job = s.queue.submit({
      harnessDir: s.harness,
      kind: "eval",
      argv: ["eval"],
      commandId: id,
    });
    await s.queue.idle();
    await settled(s);
    expect(s.runner.started).toEqual([]);
    expect(jobRowsOf(s, job.jobId).at(-1)?.["state"]).toBe("cancelled");
    expect(statesOf(s, id)).toEqual(["accepted", "rejected"]);
    expect(stateOf(s, id)?.outcome?.code).toBe("forbidden");
    expect(s.authority.calls).toEqual([]);
  });

  test("a runner wrapped over a store this adapter did not wrap checks the receipt itself", async () => {
    const s = setup();
    const plain = controllable();
    const queue = createJobQueue({
      store: createMemoryJobStore(),
      run: s.service.jobs.wrapRun(plain.run),
    });
    const refused = await submitJob(s, queue, { actor: MEMBER, credentialRef: CRD });
    s.authority.answer = false;
    // The job started inside the submit, before the answer changed: it ran. The next one is refused.
    expect(plain.started).toEqual([refused.job.jobId]);
    plain.finish(refused.job.jobId);
    await queue.idle();
    const second = await (async () => {
      const answer = await s.service.commands.submit(
        {
          kind: "legacy.submitJob",
          target: HRN,
          ledger: { harness: s.harness },
          via: "home",
          queued: true,
          actor: MEMBER,
          credentialRef: CRD,
        },
        async (receipt) => ({
          value: queue.submit({
            harnessDir: s.harness,
            kind: "eval",
            argv: ["eval"],
            commandId: receipt.id,
          }),
        }),
      );
      if (!answer.ok || answer.replayed || answer.value === undefined) throw new Error("refused");
      return { receipt: answer.receipt, job: answer.value };
    })();
    await queue.idle();
    expect(plain.started).toEqual([refused.job.jobId]);
    expect(queue.recent().find((job) => job.jobId === second.job.jobId)?.state).toBe("cancelled");
    expect(statesOf(s, second.receipt.id)).toEqual(["accepted", "rejected"]);
    expect(stateOf(s, second.receipt.id)?.outcome?.code).toBe("forbidden");
  });

  test("a refused job does not run when its receipt's move does not land", async () => {
    const s = setup(1);
    const first = await submitJob(s);
    const second = await submitJob(s, s.queue, { actor: MEMBER, credentialRef: CRD });
    await settled(s);
    s.authority.answer = false;
    // The harness's command ledger takes no write while the job would start.
    const ledgerRoot = commandsLedgerOf(s.harness).root;
    const dirs = [ledgerRoot, ...dirsUnder(ledgerRoot)];
    for (const dir of dirs) chmodSync(dir, 0o500);
    try {
      s.runner.finish(first.job.jobId);
      await s.queue.idle();
      await settled(s);
    } finally {
      for (const dir of dirs) chmodSync(dir, 0o700);
    }
    expect(s.runner.started).toEqual([first.job.jobId]);
    expect(jobRowsOf(s, second.job.jobId).at(-1)?.["state"]).toBe("cancelled");
    expect(statesOf(s, second.receipt.id)).toEqual(["accepted"]);
    expect(
      s.rig.warnings.some((w) => w.includes(second.receipt.id) && w.includes("rejected")),
    ).toBe(true);
  });

  /**
   * A member's job, submitted with the permissions its submit needed, whose submit effect
   * settles the receipt as `settle` says, when given.
   */
  async function submitNeeding(
    s: Setup,
    needs: readonly string[],
    settle?: Settlement,
  ): Promise<{ readonly receiptId: string; readonly jobId: string }> {
    let jobId = "";
    const answer = await s.service.commands.submit(
      {
        kind: "legacy.submitJob",
        target: HRN,
        ledger: { harness: s.harness },
        via: "home",
        queued: true,
        actor: MEMBER,
        credentialRef: CRD,
      },
      async (receipt) => {
        jobId = s.queue.submit({
          harnessDir: s.harness,
          kind: "eval",
          argv: ["eval"],
          commandId: receipt.id,
          by: receipt.actor,
          needs,
        }).jobId;
        return { ...(settle !== undefined ? { settle } : {}), value: undefined };
      },
    );
    if (!answer.ok) throw new Error("refused");
    return { receiptId: answer.receipt.id, jobId };
  }

  test("a pending job whose submitter lost a permission its submit needed never runs", async () => {
    const s = setup(1);
    const first = await submitJob(s);
    const second = await submitNeeding(s, ["h.deploy"]);
    s.authority.refuses.add("h.deploy");
    s.runner.finish(first.job.jobId);
    await s.queue.idle();
    await settled(s);
    expect(s.runner.started).toEqual([first.job.jobId]);
    expect(jobRowsOf(s, second.jobId).at(-1)?.["state"]).toBe("cancelled");
    expect(statesOf(s, second.receiptId)).toEqual(["accepted", "rejected"]);
    expect(stateOf(s, second.receiptId)?.outcome?.code).toBe("forbidden");
    expect(s.authority.calls).toEqual([
      [MEMBER, "h.job.run", HRN, CRD],
      [MEMBER, "h.deploy", HRN, CRD],
    ]);
  });

  test("the same job runs while every permission its submit needed still holds", async () => {
    const s = setup(1);
    const first = await submitJob(s);
    const second = await submitNeeding(s, ["h.deploy"]);
    s.runner.finish(first.job.jobId);
    await settled(s);
    expect(s.runner.started).toEqual([first.job.jobId, second.jobId]);
    expect(s.authority.calls).toEqual([
      [MEMBER, "h.job.run", HRN, CRD],
      [MEMBER, "h.deploy", HRN, CRD],
    ]);
    s.runner.finish(second.jobId);
    await s.queue.idle();
  });

  const settlements: readonly (readonly [string, Settlement])[] = [
    ["unknown", { state: "unknown", outcome: outcomeOf("internal") }],
    ["rejected (invalid)", { state: "rejected", outcome: outcomeOf("invalid") }],
  ];
  for (const [name, settle] of settlements) {
    test(`a pending job whose receipt its submit settled ${name} is still checked before it starts`, async () => {
      const s = setup(1);
      const first = await submitJob(s);
      const second = await submitNeeding(s, [], settle);
      expect(stateOf(s, second.receiptId)?.state).toBe(settle.state);
      s.authority.answer = false;
      s.runner.finish(first.job.jobId);
      await s.queue.idle();
      await settled(s);
      expect(s.runner.started).toEqual([first.job.jobId]);
      expect(jobRowsOf(s, second.jobId).at(-1)?.["state"]).toBe("cancelled");
      // The settled receipt stays as its submit left it.
      expect(stateOf(s, second.receiptId)?.state).toBe(settle.state);
      expect(s.authority.calls).toEqual([[MEMBER, "h.job.run", HRN, CRD]]);
    });
  }

  test("a job no command submitted runs unasked", async () => {
    const s = setup();
    s.authority.answer = false;
    const job = s.queue.submit({ harnessDir: s.harness, kind: "eval", argv: ["eval"] });
    expect(s.runner.started).toEqual([job.jobId]);
    s.runner.finish(job.jobId);
    await s.queue.idle();
    expect(s.authority.calls).toEqual([]);
  });
});
